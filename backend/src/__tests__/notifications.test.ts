import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, today } from '../services/money.js';
import { Api, PASSWORD, addMember, apiBase, boot, newAgency, shutdown, sql } from './helpers.js';

let base: string; const rnd = () => Math.random().toString(36).slice(2, 7);
const ymd = (off: number) => addDays(today(), off);          // the same idea of "today" the app uses
beforeAll(async () => { await boot(); base = apiBase().replace(/\/api$/, ''); });
afterAll(shutdown);

/** An agency with one of everything that should raise a notification. */
async function seed() {
  const A = await newAgency('Notify'); const agent = await addMember(A, 'agent'); const fm = await addMember(A, 'finance_manager'); const viewer = await addMember(A, 'viewer');
  const cid = (await A.post('/clients', { name: 'Notif Client', currency: 'USD', email: 'n@x.dev' })).body.id;
  const mkQuote = async (owner: Api, status: string) => { const q = (await owner.post('/quotes', { title: `Trip ${status}`, client_id: cid, currency: 'USD', components: [{ option_name: 'Option 1', product_type: 'hotel', description: 'Hotel', quantity: 1, unit_cost: 100, markup_pct: 10 }] })).body.id; await sql("UPDATE quotes SET status = ?, accepted_at = IF(? = 'accepted', NOW(), NULL), accepted_by_name = IF(? = 'accepted', 'Notif Client', NULL) WHERE id = ?", [status, status, status, q]); return q; };
  const qA = await mkQuote(agent, 'accepted'); const qB = await mkQuote(A, 'declined');                          // the agent's own, and one the owner made
  await sql("INSERT INTO payments (agency_id, direction, method, client_id, amount, currency, paid_at, voided) VALUES (?, 'inbound', 'bank_transfer', ?, 750.00, 'USD', ?, 0)", [A.agencyId, cid, ymd(0)]);
  const inv = (no: string, due: number) => sql("INSERT INTO invoices (agency_id, created_by, number, client_id, status, currency, issue_date, due_date, subtotal, total, amount_paid) VALUES (?,?,?,?,'sent','USD',?,?,500,500,0)", [A.agencyId, A.userId, no, cid, ymd(-40), ymd(due)]);
  await inv(`INV-O-${rnd()}`, -5); await inv(`INV-S-${rnd()}`, 2);
  await agent.post('/crm/tasks', { title: 'Call the airline', due_at: ymd(-1) }); await A.post('/crm/tasks', { title: 'Owner task', due_at: ymd(0) });
  await agent.post('/leads', { name: 'Hot Lead', next_action: 'Send options', next_action_at: ymd(0) });
  const bk = (await agent.post('/bookings', { client_id: cid, destination: 'Bali', travel_start: ymd(3), travel_end: ymd(9), status: 'confirmed' })).body.id; void bk;
  return { A, agent, fm, viewer, cid, qA, qB };
}

describe('notification centre', () => {
  it('works out what each role should see from live records, and nothing else', async () => {
    const { A, agent, fm, viewer, qA, qB } = await seed();
    const mine = (await agent.get('/notifications')).body; const t = (r: any) => r.items.map((n: any) => n.title);
    expect(t(mine).some((x: string) => /accepted quote/.test(x))).toBe(true); expect(t(mine).some((x: string) => /Task overdue: Call the airline/.test(x))).toBe(true); expect(t(mine).some((x: string) => /Follow up with Hot Lead/.test(x))).toBe(true); expect(t(mine).some((x: string) => /leaves in 3 days/.test(x))).toBe(true);
    expect(t(mine).some((x: string) => /Payment received|Invoice .* overdue|Owner task|declined/.test(x))).toBe(false);          // money and other people's work are not an agent's
    expect(mine.items.every((n: any) => n.key && n.category && n.at && typeof n.read === 'boolean')).toBe(true);
    const owner = (await A.get('/notifications')).body; expect(t(owner).some((x: string) => /Payment received: \$750\.00/.test(x))).toBe(true); expect(t(owner).some((x: string) => /is 5 days overdue/.test(x))).toBe(true); expect(t(owner).some((x: string) => /due in 2 days/.test(x))).toBe(true);
    expect(t(owner).some((x: string) => /declined quote/.test(x))).toBe(true); expect(t(owner).some((x: string) => /accepted quote/.test(x))).toBe(true); expect(t(owner).some((x: string) => /Owner task/.test(x))).toBe(true);
    expect(t(owner).some((x: string) => /Task overdue: Call the airline/.test(x))).toBe(false);                      // tasks belong to the person they are assigned to
    expect(owner.items.find((n: any) => n.key === `quote:${qA}:accepted`).link).toBe(`/quotes/${qA}`); expect(owner.items.some((n: any) => n.key === `quote:${qB}:declined`)).toBe(true);
    const finance = (await fm.get('/notifications')).body; expect(t(finance).some((x: string) => /Payment received/.test(x))).toBe(true);
    expect((await viewer.get('/notifications')).body.items).toHaveLength(0);                                            // read-only people get none
    const other = await newAgency('NotifyOther'); expect((await other.get('/notifications')).body.items).toHaveLength(0);   // nothing leaks between agencies
    expect(owner.unread).toBe(owner.items.length); expect(Object.values(owner.counts).length).toBeGreaterThan(3);
  });
  it('remembers what each person has read, can undo it, and counts only what is unread', async () => {
    const { A, agent } = await seed(); const a = (await agent.get('/notifications')).body; const first = a.items[0]; const total = a.unread;
    expect((await agent.post('/notifications/read', {})).status).toBe(400);
    expect((await agent.post('/notifications/read', { keys: [first.key] })).status).toBe(200);
    const b = (await agent.get('/notifications')).body; expect(b.unread).toBe(total - 1); expect(b.items.find((n: any) => n.key === first.key).read).toBe(true); expect((await agent.get('/notifications/count')).body.unread).toBe(total - 1);
    expect((await A.get('/notifications')).body.items.some((n: any) => n.read)).toBe(false);                            // reading is personal
    await agent.post('/notifications/unread', { keys: [first.key] }); expect((await agent.get('/notifications')).body.unread).toBe(total);
    const all = await agent.post('/notifications/read', { all: true }); expect(all.status).toBe(200); expect(all.body.marked).toBe(total); expect((await agent.get('/notifications/count')).body.unread).toBe(0);
    expect((await agent.get('/notifications')).body.items.length).toBe(total);                                          // read ones stay on the page
  });
  it('a read one stays read, but a new development on the same record is new again', async () => {
    const { agent, qA } = await seed(); const k = (await agent.get('/notifications')).body.items.find((n: any) => n.key === `quote:${qA}:accepted`);
    await agent.post('/notifications/read', { keys: [k.key] });
    await sql("UPDATE quotes SET status = 'changes_requested', accepted_at = NULL WHERE id = ?", [qA]);                  // the client then asks for changes
    const after = (await agent.get('/notifications')).body; expect(after.items.find((n: any) => n.key === `quote:${qA}:changes`)?.read).toBe(false);
  });
  it('tells only the owner about the plan', async () => {
    const A = await newAgency('NotifyPlan'); await sql("UPDATE subscriptions SET status = 'trialing', trial_ends_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 DAY) WHERE agency_id = ?", [A.agencyId]);
    const m = await addMember(A, 'finance_manager'); expect((await A.get('/notifications')).body.items.some((n: any) => /free trial ends/.test(n.title) && n.link === '/billing')).toBe(true);
    expect((await m.get('/notifications')).body.items.some((n: any) => /free trial/.test(n.title))).toBe(false);
  });
});
void PASSWORD;
