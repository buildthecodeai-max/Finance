import type { Server } from 'node:http';
import { pool } from '../db.js';

let server: Server | undefined; let base = '';
export async function boot() {
  if (server) return;
  const { app } = await import('../app.js');
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
}
export const apiBase = () => base;
export async function shutdown() { await new Promise((r) => server?.close(r)); await pool.end(); }

export class Api {
  constructor(public token: string, public agencyId: number, public userId: number) {}
  async req(method: string, path: string, body?: unknown, agencyOverride?: number) {
    const r = await fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}`, 'x-agency-id': String(agencyOverride ?? this.agencyId) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  put = (p: string, b?: unknown) => this.req('PUT', p, b ?? {});
  del = (p: string) => this.req('DELETE', p);
}

const rnd = () => Math.random().toString(36).slice(2, 8);
export const PASSWORD = 'CorrectHorse#2026';

async function raw(path: string, body: unknown) {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

/** Registers a brand-new agency (admin user). Chart of accounts is seeded by register. */
export async function newAgency(name = 'Agency') {
  const email = `admin-${rnd()}@test.dev`;
  const r = await raw('/auth/register', { agencyName: `${name} ${rnd()}`, name: 'Admin', email, password: PASSWORD, baseCurrency: 'USD' });
  if (r.status !== 201) throw new Error(`register failed ${JSON.stringify(r.body)}`);
  return new Api(r.body.accessToken, r.body.agencies[0].id, r.body.user.id);
}

export async function addMember(admin: Api, role: 'admin' | 'finance_manager' | 'agent' | 'viewer', extra: Record<string, unknown> = {}) {
  const email = `${role}-${rnd()}@test.dev`;
  const r = await admin.post('/team', { email, name: role, role, password: PASSWORD, ...extra });
  if (r.status !== 201) throw new Error(`addMember failed ${JSON.stringify(r.body)}`);
  const l = await raw('/auth/login', { email, password: PASSWORD });
  return new Api(l.body.accessToken, admin.agencyId, l.body.user.id);
}

/** Minimal usable data set for an agency: a customer, an airline (+payable account) and the cash account id. */
export async function seedBasics(a: Api) {
  const acc = async (type: number, name: string) => (await a.post('/accounting/accounts', { type_code: type, name })).body.id as number;
  const client = await acc(120, `Customer ${rnd()}`);
  const airline = (await a.post('/airlines', { code: String(100 + Math.floor(Math.random() * 800)), name: `Air ${rnd()}`, commission_pct: 7 })).body.id as number;
  const lookup = (await a.get('/accounting/lookup?types=110,211')).body as any[];
  const cash = lookup.find((x) => x.type_code === 110)!.id as number;
  const airlineAcc = lookup.find((x) => x.type_code === 211)!.id as number;
  return { client, airline, cash, airlineAcc };
}

export const ticketBody = (client: number, airline: number, extra: Record<string, unknown> = {}) => ({
  client_account_id: client,
  lines: [{ airline_id: airline, passenger_name: 'TEST PAX', ticket_no: '0011111111', fare: 1000, yq: 50, sp_yi: 20, com_rec_pct: 7, psf: 30, fare_inc: 1000, taxes_inc: 70 }],
  ...extra,
});

export const sql = async (q: string, p: any[] = []) => (await pool.query(q, p))[0] as any[];
