import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, addMember, apiBase, boot, newAgency, shutdown, sql } from './helpers.js';
import { policy, processDue, sign } from '../services/webhooks.js';

let A: Api, B: Api, fin: Api, agent: Api; let bank: number, base: string;
const rnd = () => Math.random().toString(36).slice(2, 7);
const today = () => new Date().toISOString().slice(0, 10);

/* a tiny webhook receiver whose response code we can flip */
const received: { headers: http.IncomingHttpHeaders; body: string; url?: string }[] = []; let respond = 200; let rx: http.Server, rxUrl = '';
beforeAll(async () => {
  await boot(); base = apiBase().replace(/\/api$/, '');
  A = await newAgency('R7A'); B = await newAgency('R7B'); fin = await addMember(A, 'finance_manager'); agent = await addMember(A, 'agent');
  bank = ((await A.get('/accounting/lookup?types=110')).body as any[]).find((x) => x.name.includes('Bank')).id;
  rx = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push({ headers: req.headers, body: b, url: req.url }); res.statusCode = respond; res.end('ok'); }); });
  await new Promise<void>((r) => rx.listen(0, '127.0.0.1', r)); rxUrl = `http://127.0.0.1:${(rx.address() as any).port}/hook`;
});
afterAll(async () => { await new Promise((r) => rx.close(r)); await shutdown(); });

const v1 = async (key: string | null, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};
const mkKey = async (scopes: string[], o: Record<string, unknown> = {}, a = A) => { const r = await a.post('/hub/api-keys', { name: `k-${rnd()}`, scopes, ...o }); expect(r.status).toBe(201); return r.body as { id: number; key: string }; };
const mkClient = async (a = A, name = `Client ${rnd()}`, email: string | null = `${rnd()}@c.test`) => (await a.post('/clients', { name, ...(email ? { email } : {}), currency: 'USD' })).body.id as number;
async function issued(client: number, a = A) {
  const r = await a.post('/invoices', { client_id: client, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Trip', unit_cost: 1000, markup_pct: 10, tax_rate: 10 }] });
  const id = r.body.inv.id as number; await a.post(`/invoices/${id}/status`, { status: 'reviewed' }); expect((await a.post(`/invoices/${id}/issue`)).status).toBe(200); return id;
}
const mkHook = async (events: string[] = ['*'], a = A, url = `${rxUrl}/${rnd()}${rnd()}`) => { const r = await a.post('/hub/webhooks', { name: `h-${rnd()}`, url, events }); expect(r.status).toBe(201); return r.body as { id: number; secret: string }; };

describe('API keys and the public API', () => {
  it('keys are shown once, stored hashed, admin-only; scopes enforced; revoke and expiry work', async () => {
    expect((await fin.post('/hub/api-keys', { name: 'nope', scopes: ['leads:write'] })).status).toBe(403);
    expect((await A.post('/hub/api-keys', { name: 'bad', scopes: ['admin:all'] })).status).toBe(400);
    const k = await mkKey(['leads:write']); expect(k.key).toMatch(/^tfk_/);
    const row = (await sql('SELECT key_hash, key_prefix FROM api_keys WHERE id = ?', [k.id]))[0]; expect(row.key_hash).toBe(crypto.createHash('sha256').update(k.key).digest('hex'));
    expect(JSON.stringify((await A.get('/hub/api-keys')).body)).not.toContain(k.key.slice(13));
    expect((await v1(null, '/clients')).status).toBe(401); expect((await v1('tfk_aaaaaaaa_' + 'x'.repeat(30), '/clients')).status).toBe(401);
    expect((await v1(k.key, '/clients')).status).toBe(403);                                           // missing scope
    expect((await v1(k.key, '/leads', 'POST', { name: 'Web lead', email: 'w@x.test' })).status).toBe(201);
    await A.post(`/hub/api-keys/${k.id}/revoke`); expect((await v1(k.key, '/leads', 'POST', { name: 'x', email: 'w@x.test' })).status).toBe(401);
    const e = await mkKey(['leads:write'], { days: 1 }); await sql("UPDATE api_keys SET expires_at = '2020-01-01 00:00:00' WHERE id = ?", [e.id]); expect((await v1(e.key, '/leads', 'POST', { name: 'x', email: 'w@x.test' })).status).toBe(401);
  });
  it('lead capture validates input and is idempotent, even under concurrency', async () => {
    const k = await mkKey(['leads:write']);
    expect((await v1(k.key, '/leads', 'POST', { name: 'No contact' })).status).toBe(400);
    const idem = { 'idempotency-key': `idem-${rnd()}${rnd()}` }, body = { name: 'Once only', email: `${rnd()}@once.test`, destination: 'Fiji' };
    const rs = await Promise.all([1, 2, 3].map(() => v1(k.key, '/leads', 'POST', body, idem)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1); expect(rs.every((r) => [201, 409].includes(r.status))).toBe(true);
    const again = await v1(k.key, '/leads', 'POST', body, idem); expect(again.status).toBe(201); expect(again.body.id).toBe(rs.find((r) => r.status === 201)!.body.id);
    expect((await sql('SELECT COUNT(*) n FROM leads WHERE agency_id = ? AND email = ?', [A.agencyId, body.email]))[0].n).toBe(1);
    expect((await sql("SELECT source FROM leads WHERE email = ?", [body.email]))[0].source).toBe('api');
  });
  it('read endpoints are tenant-scoped, paginated and expose no internal fields', async () => {
    const c = await mkClient(), inv = await issued(c); await A.post('/invoices', { client_id: c, currency: 'USD', lines: [{ product_type: 'hotel', description: 'd', unit_cost: 5, markup_pct: 0, tax_rate: 0 }] });
    const k = await mkKey(['clients:read', 'invoices:read']), kb = await mkKey(['clients:read', 'invoices:read'], {}, B);
    const list = await v1(k.key, '/invoices?limit=100'); expect(list.body.data.map((i: any) => i.id)).toContain(inv); expect(list.body.data.every((i: any) => !['draft', 'reviewed'].includes(i.status))).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/unit_cost|markup|voucher|snapshot|cost/i);
    expect((await v1(kb.key, `/invoices/${inv}`)).status).toBe(404); expect((await v1(kb.key, '/invoices')).body.data).toEqual([]); expect((await v1(kb.key, '/clients')).body.data).toEqual([]);
    for (let i = 0; i < 2; i++) await mkClient(); const p1 = await v1(k.key, '/clients?limit=2'); expect(p1.body.data).toHaveLength(2); expect(p1.body.next_after_id).toBeTruthy();
    expect((await v1(k.key, `/clients?limit=2&after_id=${p1.body.next_after_id}`)).body.data[0].id).toBeGreaterThan(p1.body.next_after_id);
    expect((await v1(k.key, `/invoices/${inv}`)).body).toMatchObject({ id: inv, outstanding: 1210 });
  });
});

describe('signed webhooks', () => {
  it('delivers subscribed events with a verifiable signature and timestamp; others are filtered', async () => {
    received.length = 0; respond = 200;
    const all = await mkHook(['invoice.issued']), leadsOnly = await mkHook(['lead.created']);
    const c = await mkClient(), inv = await issued(c); const r = await processDue(100, A.agencyId); expect(r.success).toBeGreaterThanOrEqual(1);
    const got = received.filter((x) => x.headers['x-tf-event'] === 'invoice.issued'); expect(got).toHaveLength(1);
    const g = got[0], ts = Number(g.headers['x-tf-timestamp']); expect(Math.abs(Date.now() / 1000 - ts)).toBeLessThan(60);
    expect(g.headers['x-tf-signature']).toBe(sign(all.secret, ts, g.body)); expect(g.headers['x-tf-signature']).not.toBe(sign(leadsOnly.secret, ts, g.body));
    const ev = JSON.parse(g.body); expect(ev).toMatchObject({ type: 'invoice.issued', version: 1, data: { invoice_id: inv, client_id: c, total: 1210 } }); expect(ev.id).toBe(g.headers['x-tf-event-id']);
    expect(JSON.stringify(ev)).not.toMatch(/@/);                                                      // no email addresses in payloads
    expect((await A.get(`/hub/webhooks/${leadsOnly.id}/deliveries`)).body).toHaveLength(0);
  });
  it('retries with backoff, dead-letters after six attempts, and manual retry recovers', async () => {
    received.length = 0; respond = 500; const h = await mkHook(['receipt.created']);
    const c = await mkClient(); await A.post('/finance/receipts', { client_id: c, cash_account_id: bank, amount: 10, method: 'cash' });
    await processDue(100, A.agencyId); let d = (await A.get(`/hub/webhooks/${h.id}/deliveries`)).body[0]; expect(d).toMatchObject({ status: 'failed', attempts: 1, last_status_code: 500 });
    const path = new URL((await sql('SELECT url FROM webhook_endpoints WHERE id = ?', [h.id]))[0].url).pathname, hits = () => received.filter((x) => x.url === path).length, n = hits(); await processDue(100, A.agencyId); expect(hits()).toBe(n);   // not due yet
    for (let i = 0; i < 5; i++) { await sql('UPDATE webhook_deliveries SET next_attempt_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?', [d.id]); await processDue(100, A.agencyId); }
    d = (await A.get(`/hub/webhooks/${h.id}/deliveries`)).body[0]; expect(d).toMatchObject({ status: 'dead', attempts: 6 });
    expect((await A.get('/hub/health')).body.dead_deliveries).toBeGreaterThanOrEqual(1);
    expect((await B.post(`/hub/deliveries/${d.id}/retry`)).status).toBe(404);
    respond = 200; expect((await A.post(`/hub/deliveries/${d.id}/retry`)).status).toBe(200); await processDue(100, A.agencyId);
    expect((await A.get(`/hub/webhooks/${h.id}/deliveries`)).body[0]).toMatchObject({ status: 'success' }); expect((await A.post(`/hub/deliveries/${d.id}/retry`)).status).toBe(409);
  });
  it('concurrent workers send a delivery exactly once', async () => {
    received.length = 0; respond = 200; const h = await mkHook(['lead.created']); await v1((await mkKey(['leads:write'])).key, '/leads', 'POST', { name: 'Race', email: `${rnd()}@race.test` });
    await Promise.all([1, 2, 3, 4].map(() => processDue(100, A.agencyId)));
    const hp = new URL((await sql('SELECT url FROM webhook_endpoints WHERE id = ?', [h.id]))[0].url).pathname;
    expect(received.filter((x) => x.headers['x-tf-event'] === 'lead.created' && x.url === hp)).toHaveLength(1); expect((await A.get(`/hub/webhooks/${h.id}/deliveries`)).body[0].status).toBe('success');
  });
  it('refuses private/insecure URLs in production mode, never sends one tenant\'s events to another, and rotates secrets', async () => {
    policy.allowPrivate = false;
    try {
      for (const url of ['http://example.com/h', 'https://127.0.0.1/h', 'https://10.0.0.5/h', 'https://169.254.169.254/latest', 'https://[::1]/h', 'https://localhost/h', 'https://user:pw@example.com/h'])
        expect((await A.post('/hub/webhooks', { name: 'ssrf', url, events: ['*'] })).status, url).toBe(400);
    } finally { policy.allowPrivate = true; }
    received.length = 0; const hb = await mkHook(['*'], B); const ha = await mkHook(['lead.created']); await v1((await mkKey(['leads:write'])).key, '/leads', 'POST', { name: 'Iso', email: `${rnd()}@iso.test` });
    await processDue(100); expect((await B.get(`/hub/webhooks/${hb.id}/deliveries`)).body).toHaveLength(0); expect((await B.get(`/hub/webhooks/${ha.id}/deliveries`)).status).toBe(200);
    expect((await B.get(`/hub/webhooks/${ha.id}/deliveries`)).body).toEqual([]);
    const rot = (await A.post(`/hub/webhooks/${ha.id}/rotate-secret`)).body.secret; expect(rot).not.toBe(ha.secret); expect(rot).toMatch(/^whsec_/);
    expect((await agent.get('/hub/webhooks')).status).toBe(403); expect((await fin.post('/hub/webhooks', { name: 'x', url: rxUrl, events: ['*'] })).status).toBe(403);
    expect((await A.post('/hub/webhooks', { name: 'x', url: rxUrl, events: ['nope.event'] })).status).toBe(400);
    expect((await A.post(`/hub/webhooks/${ha.id}/test`)).body.success).toBeGreaterThanOrEqual(1);
  });
});

describe('accounting export', () => {
  it('exports balanced journals; provider formats refuse unmapped accounts; mapped export is complete', async () => {
    const c = await mkClient(A, '=HYPERLINK("http://evil")'); await issued(c); await A.post('/finance/receipts', { client_id: c, cash_account_id: bank, amount: 100, method: 'cash' });
    expect((await agent.get('/hub/exports/journals')).status).toBe(403);
    const g = await A.get(`/hub/exports/journals?from=2020-01-01&to=${today()}`); expect(g.status).toBe(200);
    const lines = String(g.body).split('\r\n').slice(1).map((l) => l.split(',')); const dr = lines.reduce((s, l) => s + Number(l[7]), 0), cr = lines.reduce((s, l) => s + Number(l[8]), 0); expect(Math.abs(dr - cr)).toBeLessThan(0.01); expect(dr).toBeGreaterThan(0);
    const x = await A.get(`/hub/exports/journals?format=xero&from=2020-01-01&to=${today()}`); expect(x.status).toBe(409); expect(x.body.problems.length).toBeGreaterThan(0);
    const maps = (await fin.get('/hub/mappings')).body as any[]; expect((await fin.put('/hub/mappings', { mappings: [] })).status).toBe(403);
    const used = new Set((await sql('SELECT DISTINCT account_id FROM gl_entries WHERE agency_id = ?', [A.agencyId])).map((r: any) => r.account_id));
    expect((await A.put('/hub/mappings', { mappings: maps.filter((m) => used.has(m.account_id)).map((m, i) => ({ account_id: m.account_id, external_code: String(200 + i) })) })).status).toBe(200);
    const ok = await A.get(`/hub/exports/journals?format=xero&from=2020-01-01&to=${today()}`); expect(ok.status).toBe(200);
    const rows = String(ok.body).split('\r\n'); expect(rows[0]).toContain('*AccountCode'); expect(rows.slice(1).reduce((s, l) => s + Number(l.split(',').pop()), 0)).toBeCloseTo(0, 2);   // Xero amounts net to zero
    const qb = await A.get(`/hub/exports/journals?format=quickbooks&from=2020-01-01&to=${today()}`); expect(qb.status).toBe(200); expect(String(qb.body)).toContain('Journal No');
    expect((await A.get('/hub/exports/invoices?format=xero')).status).toBe(400);
    const inv = String((await A.get(`/hub/exports/invoices?from=2020-01-01&to=${today()}`)).body); expect(inv).toContain(`"'=HYPERLINK`); expect(inv).not.toContain(',=HYPERLINK');   // formula injection neutralised
    const log = (await A.get('/hub/exports')).body; expect(log.length).toBeGreaterThanOrEqual(4); expect(log[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect((await B.get('/hub/exports')).body).toEqual([]);
  });
});

describe('CSV booking import', () => {
  const csv = (rows: string[]) => ['external_ref,client_email,client_name,destination,travel_start,travel_end,status,currency', ...rows].join('\n');
  it('previews without writing, commits once, treats re-imports as duplicates, and blocks bad batches', async () => {
    const email = `${rnd()}@guest.test`; await mkClient(A, 'Known Person', email);
    const ext = `EXT-${rnd()}`, body = csv([`${ext}-1,${email},,Bali,2027-03-01,2027-03-10,confirmed,USD`, `${ext}-2,${rnd()}@new.test,New Guest,Rome,2027-04-01,2027-04-07,,`, `${ext}-3,${rnd()}@new.test,,Paris,2027-13-45,,confirmed,USD`]);
    const pv = await A.post('/hub/imports/bookings', { csv: body }); expect(pv.status).toBe(200); expect(pv.body.summary).toEqual({ total: 3, ok: 1, duplicate: 0, error: 2 });   // 2 = unknown client, bad date
    expect((await sql('SELECT COUNT(*) n FROM bookings WHERE agency_id = ? AND external_ref LIKE ?', [A.agencyId, `${ext}%`]))[0].n).toBe(0);
    const blocked = await A.post('/hub/imports/bookings', { csv: body, commit: true, create_clients: true }); expect(blocked.status).toBe(409); expect(blocked.body.problems[0].message).toMatch(/Line 4/);
    const ok = await A.post('/hub/imports/bookings', { csv: body, commit: true, create_clients: true, skip_errors: true }); expect(ok.body.created).toBe(2);
    expect((await sql('SELECT COUNT(*) n FROM clients WHERE agency_id = ? AND name = ?', [A.agencyId, 'New Guest']))[0].n).toBe(1);
    const again = await A.post('/hub/imports/bookings', { csv: body, commit: true, create_clients: true, skip_errors: true }); expect(again.body.created).toBe(0); expect(again.body.summary.duplicate).toBe(2);
    const b = (await sql('SELECT status, currency, reference FROM bookings WHERE external_ref = ? AND agency_id = ?', [`${ext}-2`, A.agencyId]))[0]; expect(b.status).toBe('confirmed'); expect(b.currency).toBe('USD'); expect(b.reference).toMatch(/^BK/);
    const bEmail = await mkClient(B, 'B Person', email); void bEmail; expect((await B.post('/hub/imports/bookings', { csv: csv([`${ext}-1,${email},,Bali,2027-03-01,,confirmed,USD`]), commit: true })).body.created).toBe(1);   // other agency, same ref
    expect((await agent.post('/hub/imports/bookings', { csv: body })).status).toBe(403);
    expect((await A.post('/hub/imports/bookings', { csv: 'a,b\n1,2' })).status).toBe(400);
    expect((await A.get('/hub/imports')).body.length).toBeGreaterThanOrEqual(3);
  });
  it('rejects ambiguous client names and duplicate refs inside one file', async () => {
    const nm = `Twin ${rnd()}`; await mkClient(A, nm, null); await mkClient(A, nm, null);
    const r = await A.post('/hub/imports/bookings', { csv: csv([`D-${rnd()},,${nm},X,2027-01-01,,,`, 'S-1,a@b.test,,Y,2027-01-01,,,', 'S-1,a@b.test,,Y,2027-01-01,,,']), create_clients: true });
    expect(r.body.rows[0].message).toMatch(/ambiguous/); expect(r.body.rows[2].message).toMatch(/duplicate external_ref/);
  });
});

describe('connections', () => {
  it('admins can disconnect an OAuth provider; others cannot', async () => {
    await sql("INSERT INTO integrations (agency_id, provider, tenant_ref, tokens_enc) VALUES (?, 'xero', 't', 'x')", [A.agencyId]);
    expect((await A.get('/hub/health')).body.oauth.map((o: any) => o.provider)).toContain('xero');
    expect((await fin.del('/integrations/xero')).status).toBe(403); expect((await B.del('/integrations/xero')).status).toBe(404);
    expect((await A.del('/integrations/xero')).status).toBe(200); expect((await A.get('/hub/health')).body.oauth).toEqual([]);
  });
});
