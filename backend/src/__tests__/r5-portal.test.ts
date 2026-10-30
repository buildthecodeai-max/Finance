import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Api, addMember, boot, newAgency, shutdown, sql } from './helpers.js';
import { gateway } from '../services/portal.js';

let A: Api, B: Api, agent: Api, viewer: Api; let bank: number;
const rnd = () => Math.random().toString(36).slice(2, 7);
const pub = async (path: string, method = 'GET', body?: unknown) => {
  const { apiBase } = await import('./helpers.js');
  const r = await fetch(`${apiBase().replace(/\/api$/, '')}/api/public/portal${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};
const mkClient = async (a = A, email: string | null = 'c@test.dev') => (await a.post('/clients', { name: `Client ${rnd()}`, ...(email ? { email } : {}), currency: 'USD' })).body.id as number;
async function issued(client: number, a = A) {
  const r = await a.post('/invoices', { client_id: client, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Trip', unit_cost: 1000, markup_pct: 10, tax_rate: 10 }] });
  const id = r.body.inv.id as number; await a.post(`/invoices/${id}/status`, { status: 'reviewed' }); expect((await a.post(`/invoices/${id}/issue`)).status).toBe(200); return id;
}
const link = async (client: number, o: Record<string, unknown> = {}, a = A) => { const r = await a.post('/portal-admin/links', { client_id: client, ...o }); expect(r.status).toBe(201); return { ...r.body, token: String(r.body.url).split('/').pop() as string }; };

beforeAll(async () => {
  await boot(); A = await newAgency('R5A'); B = await newAgency('R5B'); agent = await addMember(A, 'agent'); viewer = await addMember(A, 'viewer');
  bank = ((await A.get('/accounting/lookup?types=110')).body as any[]).find((x) => x.name.includes('Bank')).id;
});
afterAll(shutdown);

describe('portal access', () => {
  it('shows a client only their own issued invoices, with selling prices only; the token is stored hashed', async () => {
    const c = await mkClient(), other = await mkClient();
    const inv = await issued(c), theirs = await issued(other);
    await A.post('/invoices', { client_id: c, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Draft trip', unit_cost: 5, markup_pct: 0, tax_rate: 0 }] });   // draft: hidden
    const l = await link(c);
    expect((await sql('SELECT token_hash FROM portal_links WHERE id = ?', [l.id]))[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await sql('SELECT * FROM portal_links WHERE id = ?', [l.id]))).not.toContain(l.token);
    const v = await pub(`/${l.token}`);
    expect(v.status).toBe(200); expect(v.body.invoices.map((i: any) => i.id)).toEqual([inv]); expect(v.body.invoices[0]).toMatchObject({ total: 1210, outstanding: 1210, payable: true });
    expect(JSON.stringify(v.body)).not.toMatch(/unit_cost|markup|margin|supplier|voucher|snapshot/i);
    expect((await pub(`/${l.token}/invoices/${theirs}/pdf`)).status).toBe(404);                       // another client's invoice
    expect((await pub(`/${l.token}/invoices/${theirs}/pay`, 'POST')).status).toBe(404);
  });
  it('wrong, expired and revoked tokens are indistinguishable', async () => {
    const c = await mkClient(); const l = await link(c);
    const wrong = await pub(`/${'x'.repeat(43)}`); expect(wrong.status).toBe(404);
    await sql("UPDATE portal_links SET expires_at = '2020-01-01 00:00:00' WHERE id = ?", [l.id]);
    const expired = await pub(`/${l.token}`); expect(expired.status).toBe(404); expect(expired.body.error).toEqual(wrong.body.error);
    const l2 = await link(c); expect((await pub(`/${l2.token}`)).status).toBe(200);
    expect((await A.post(`/portal-admin/links/${l2.id}/revoke`)).status).toBe(200);
    expect((await pub(`/${l2.token}`)).body.error).toEqual(wrong.body.error); expect((await pub('/short')).status).toBe(404);
    expect((await B.post(`/portal-admin/links/${l.id}/revoke`)).status).toBe(404);                  // other agency
  });
  it('shows itinerary of confirmed bookings only, receipts, and tracks usage', async () => {
    const c = await mkClient();
    const b1 = (await A.post('/bookings', { client_id: c, destination: 'Bali', status: 'confirmed' })).body.id, b2 = (await A.post('/bookings', { client_id: c, destination: 'Secret', status: 'enquiry' })).body.id;
    await sql("INSERT INTO itinerary_items (agency_id, booking_id, day_no, title, location, confirmed) VALUES (?,?,1,'Airport transfer','Denpasar',1)", [A.agencyId, b1]);
    await sql("INSERT INTO itinerary_items (agency_id, booking_id, day_no, title) VALUES (?,?,1,'Internal hold')", [A.agencyId, b2]);
    const l = await link(c); await pub(`/${l.token}`); const v = await pub(`/${l.token}`);
    expect(v.body.bookings.map((b: any) => b.destination)).toEqual(['Bali']); expect(v.body.bookings[0].itinerary[0].title).toBe('Airport transfer');
    expect(JSON.stringify(v.body)).not.toContain('Secret');
    expect((await sql('SELECT use_count FROM portal_links WHERE id = ?', [l.id]))[0].use_count).toBe(2);
  });
});

describe('payment links', () => {
  it('invoice-scoped links expose one invoice, create a checkout for exactly the balance, and refuse when settled', async () => {
    const c = await mkClient(); const a = await issued(c), b = await issued(c);
    const l = (await A.post('/portal-admin/payment-links', { client_id: c, invoice_id: a })).body, token = String(l.url).split('/').pop()!;
    expect(l.url).toContain('/pay/');
    const v = await pub(`/${token}`); expect(v.body.invoices.map((i: any) => i.id)).toEqual([a]); expect(v.body.bookings).toBeUndefined();
    expect((await pub(`/${token}/invoices/${b}/pay`, 'POST')).status).toBe(404);                      // sibling invoice
    expect((await pub(`/${token}/requests`, 'POST', { subject: 'Hello', message: 'Hi there' })).status).toBe(403);
    expect((await pub(`/${token}/invoices/${a}/pay`, 'POST')).status).toBe(501);                      // Stripe not configured → honest error
    const spy = vi.spyOn(gateway, 'checkout').mockResolvedValue('https://pay.test/session');
    try {
      expect((await pub(`/${token}/invoices/${a}/pay`, 'POST')).body.url).toBe('https://pay.test/session');
      expect(spy.mock.calls[0][0]).toMatchObject({ invoiceId: a, agencyId: A.agencyId, cents: 121000, currency: 'USD' });
      await A.post('/finance/receipts', { client_id: c, cash_account_id: bank, amount: 1000, method: 'bank_transfer', allocations: [{ invoice_id: a, amount: 1000 }] });
      await pub(`/${token}/invoices/${a}/pay`, 'POST'); expect(spy.mock.calls[1][0].cents).toBe(21000);   // partial payment reduces the charge
      await A.post('/finance/receipts', { client_id: c, cash_account_id: bank, amount: 210, method: 'bank_transfer', allocations: [{ invoice_id: a, amount: 210 }] });
      expect((await pub(`/${token}/invoices/${a}/pay`, 'POST')).status).toBe(409); expect(spy).toHaveBeenCalledTimes(2);
      expect((await pub(`/${token}`)).body.invoices[0]).toMatchObject({ status: 'paid', outstanding: 0, payable: false });
    } finally { spy.mockRestore(); }
  });
  it('refuses links for unissued/foreign invoices and for invoices of another client', async () => {
    const c = await mkClient(), o = await mkClient(); const inv = await issued(o);
    expect((await A.post('/portal-admin/payment-links', { client_id: c, invoice_id: inv })).status).toBe(400);
    const draft = (await A.post('/invoices', { client_id: c, currency: 'USD', lines: [{ product_type: 'hotel', description: 'x', unit_cost: 5, markup_pct: 0, tax_rate: 0 }] })).body.inv.id;
    expect((await A.post('/portal-admin/payment-links', { client_id: c, invoice_id: draft })).status).toBe(409);
    expect((await B.post('/portal-admin/payment-links', { client_id: c, invoice_id: inv })).status).toBe(400);   // foreign ids rejected
    expect((await A.post('/portal-admin/payment-links', { client_id: c })).status).toBe(400);
  });
});

describe('support requests and delivery', () => {
  it('client sends a request, staff replies, client sees the reply; foreign bookings and floods are refused', async () => {
    const c = await mkClient(), o = await mkClient(); const mine = (await A.post('/bookings', { client_id: c, destination: 'Fiji', status: 'confirmed' })).body.id, theirs = (await A.post('/bookings', { client_id: o, destination: 'Rome', status: 'confirmed' })).body.id;
    const l = await link(c);
    expect((await pub(`/${l.token}/requests`, 'POST', { subject: 'Hi', message: 'x', booking_id: theirs })).status).toBe(400);
    expect((await pub(`/${l.token}/requests`, 'POST', { subject: 'Change dates', message: 'Can we move the trip by a day?', booking_id: mine })).status).toBe(201);
    const list = (await A.get('/portal-admin/requests?status=open')).body; const req = list.find((r: any) => r.subject === 'Change dates');
    expect(req.client_id).toBe(c); expect((await B.get('/portal-admin/requests')).body).toEqual([]);
    expect((await viewer.post(`/portal-admin/requests/${req.id}/respond`, { response: 'ok' })).status).toBe(403);
    const r = await A.post(`/portal-admin/requests/${req.id}/respond`, { response: 'Yes, we have moved it.', status: 'resolved', notify: true });
    expect(r.status).toBe(200); expect(r.body.delivery).toBe('skipped');                                // mail not configured: recorded honestly
    expect((await pub(`/${l.token}`)).body.requests[0]).toMatchObject({ status: 'resolved', response: 'Yes, we have moved it.' });
    expect((await A.get('/portal-admin/deliveries')).body.some((d: any) => d.kind === 'support_reply' && d.status === 'skipped')).toBe(true);
    expect((await B.post(`/portal-admin/requests/${req.id}/respond`, { response: 'hijack' })).status).toBe(404);
  });
  it('caps open requests per client', async () => {
    const c = await mkClient(); const l = await link(c);
    await sql('INSERT INTO support_requests (agency_id, client_id, subject, message) SELECT ?, ?, CONCAT("s", n), "m" FROM (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10) x', [A.agencyId, c]);
    expect((await pub(`/${l.token}/requests`, 'POST', { subject: 'One more', message: 'please' })).status).toBe(429);
  });
  it('sending a link logs delivery; clients without email are refused; roles enforced', async () => {
    const c = await mkClient(), noMail = await mkClient(A, null);
    expect((await A.post('/portal-admin/links', { client_id: c, send: true })).body.delivery).toBe('skipped');
    expect((await A.post('/portal-admin/links', { client_id: noMail, send: true })).status).toBe(400);
    expect((await agent.post('/portal-admin/links', { client_id: c })).status).toBe(403);
    expect((await viewer.post('/portal-admin/links', { client_id: c })).status).toBe(403);
    expect((await viewer.get('/portal-admin/links')).status).toBe(200);
    expect((await B.post('/portal-admin/links', { client_id: c })).status).toBe(400);                  // A's client: foreign id rejected
    expect((await B.get('/portal-admin/links')).body).toEqual([]);
    const inv = await issued(c); expect((await A.post(`/invoices/${inv}/send`)).body.delivery).toBe('skipped');
    expect((await sql("SELECT COUNT(*) n FROM portal_links WHERE client_id = ? AND scope = 'invoice'", [c]))[0].n).toBe(1);   // send created a real payment link
  });
});
