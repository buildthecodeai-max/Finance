import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import { HttpError } from '../errors.js';
import { Tenant, pool } from '../db.js';

export const EVENT_TYPES = ['invoice.issued', 'receipt.created', 'lead.created', 'quote.accepted', 'bill.approved', 'booking.imported', 'ping'] as const;
const BACKOFF_MIN = [1, 5, 30, 120, 360];   // minutes before attempt 2..6; after attempt 6 the delivery is dead-lettered
export const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

/** Mutable so tests can allow loopback receivers; production always refuses them. */
export const policy = { allowPrivate: !config.isProd && process.env.NODE_ENV === 'test' };

export const sign = (secret: string, ts: number, body: string) => `v1=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

function privateIp(ip: string): boolean {
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:') && privateIp(l.slice(7)); }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
/** SSRF guard: https only, and the host must not resolve to a private/loopback/link-local address. Re-checked at every delivery. */
export async function assertSafeUrl(raw: string) {
  let u: URL; try { u = new URL(raw); } catch { throw new HttpError(400, 'Invalid URL'); }
  if (!policy.allowPrivate && u.protocol !== 'https:') throw new HttpError(400, 'Webhook URLs must use https');
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new HttpError(400, 'Invalid URL');
  if (policy.allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new HttpError(400, 'Webhook host cannot be resolved'); });
  if (addrs.some((a) => privateIp(a.address))) throw new HttpError(400, 'Webhook URLs cannot point at private or internal addresses');
}

export const newSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;

/** Write an event and one pending delivery per subscribed endpoint. Pass the transaction's Tenant so the event commits with the change. */
export async function emit(t: Tenant, type: string, payload: Record<string, unknown>) {
  const eps: any[] = await t.query('SELECT id, events FROM webhook_endpoints WHERE agency_id = ? AND active = 1', [t.agencyId]);
  const subs = eps.filter((e) => e.events === '*' || e.events.split(',').includes(type));
  if (!subs.length) return;
  const eventId = crypto.randomUUID();
  const pk = await t.rawInsert('webhook_events', { agency_id: t.agencyId, event_id: eventId, type, version: 1, payload: JSON.stringify(payload) });
  for (const e of subs) await t.rawInsert('webhook_deliveries', { agency_id: t.agencyId, endpoint_id: e.id, event_pk: pk, status: 'pending', next_attempt_at: sqlTime(new Date()) });
}

async function deliverOne(d: any) {
  // claim with a 2-minute lease so two workers never send the same delivery
  const [claim]: any = await pool.query(`UPDATE webhook_deliveries SET attempts = attempts + 1, next_attempt_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 MINUTE) WHERE id = ? AND status IN ('pending','failed') AND next_attempt_at <= UTC_TIMESTAMP() AND attempts = ?`, [d.id, d.attempts]);
  if (claim.affectedRows === 0) return 'skipped';
  const [[ep]]: any = await pool.query('SELECT * FROM webhook_endpoints WHERE id = ? AND agency_id = ?', [d.endpoint_id, d.agency_id]);
  const [[ev]]: any = await pool.query('SELECT * FROM webhook_events WHERE id = ? AND agency_id = ?', [d.event_pk, d.agency_id]);
  let code: number | null = null, error: string | null = null, ok = false;
  try {
    if (!ep || !ep.active) throw new Error('endpoint disabled');
    await assertSafeUrl(ep.url);
    const body = JSON.stringify({ id: ev.event_id, type: ev.type, version: ev.version, created: new Date(ev.created_at).toISOString(), data: typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload });
    const ts = Math.floor(Date.now() / 1000);
    const r = await fetch(ep.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', 'user-agent': 'TravelFinance-Webhooks/1', 'x-tf-event': ev.type, 'x-tf-event-id': ev.event_id, 'x-tf-timestamp': String(ts), 'x-tf-signature': sign(decrypt(ep.secret_enc), ts, body) }, body });
    code = r.status; ok = r.status >= 200 && r.status < 300; if (!ok) error = `HTTP ${r.status}`;
  } catch (e: any) { error = String(e?.message ?? e).slice(0, 280); }
  const attempts = d.attempts + 1;
  if (ok) {
    await pool.query(`UPDATE webhook_deliveries SET status = 'success', last_status_code = ?, last_error = NULL, delivered_at = UTC_TIMESTAMP() WHERE id = ?`, [code, d.id]);
    await pool.query('UPDATE webhook_endpoints SET consecutive_failures = 0, last_success_at = UTC_TIMESTAMP() WHERE id = ?', [d.endpoint_id]);
    return 'success';
  }
  const dead = attempts >= MAX_ATTEMPTS, next = new Date(Date.now() + (BACKOFF_MIN[attempts - 1] ?? 360) * 60_000);
  await pool.query(`UPDATE webhook_deliveries SET status = ?, last_status_code = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`, [dead ? 'dead' : 'failed', code, error, sqlTime(next), d.id]);
  await pool.query(`UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1, last_failure_at = UTC_TIMESTAMP() WHERE id = ?`, [d.endpoint_id]);
  await pool.query(`UPDATE webhook_endpoints SET active = 0, disabled_reason = 'Disabled automatically after 25 consecutive failures' WHERE id = ? AND consecutive_failures >= 25 AND active = 1`, [d.endpoint_id]);
  return dead ? 'dead' : 'failed';
}

/** Send everything that is due. Safe to call from several workers at once (claims are atomic). */
export async function processDue(limit = 50, agencyId?: number) {
  const [rows]: any = await pool.query(`SELECT * FROM webhook_deliveries WHERE status IN ('pending','failed') AND next_attempt_at <= UTC_TIMESTAMP() ${agencyId ? 'AND agency_id = ?' : ''} ORDER BY id LIMIT ?`, agencyId ? [agencyId, limit] : [limit]);
  const out: Record<string, number> = { success: 0, failed: 0, dead: 0, skipped: 0 };
  for (const d of rows) out[await deliverOne(d)]++;
  return out;
}

export async function retryDelivery(t: Tenant, id: number) {
  const d = await t.get('webhook_deliveries', id);
  if (!d) throw new HttpError(404, 'Delivery not found');
  if (d.status === 'success') throw new HttpError(409, 'Already delivered');
  await pool.query(`UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = UTC_TIMESTAMP(), last_error = NULL WHERE id = ? AND agency_id = ?`, [id, t.agencyId]);
  await pool.query(`UPDATE webhook_endpoints SET active = 1, disabled_reason = NULL, consecutive_failures = 0 WHERE id = ? AND agency_id = ?`, [d.endpoint_id, t.agencyId]);
}

export async function createEndpoint(t: Tenant, b: { name: string; url: string; events: string[] }) {
  await assertSafeUrl(b.url);
  for (const e of b.events) if (e !== '*' && !(EVENT_TYPES as readonly string[]).includes(e)) throw new HttpError(400, `Unknown event ${e}`);
  const secret = newSecret();
  const id = await t.insert('webhook_endpoints', { name: b.name, url: b.url, secret_enc: encrypt(secret), events: b.events.join(','), active: 1, created_by: t.actor.userId });
  return { id, secret };
}
