import { decrypt } from '../crypto.js';
import { HttpError } from '../errors.js';
import type { Tenant } from '../db.js';

/** Captured texts in tests, like the mail outbox. */
export const testSmsOutbox: { to: string; body: string; from: string }[] = [];

/** E.164 number, or null. A leading 0 is read as a local number and gets the agency's default country code. */
export function normalizeNumber(raw: string, defaultCc?: string | null): string | null {
  let n = String(raw ?? '').replace(/[\s().-]/g, '');
  if (n.startsWith('00')) n = `+${n.slice(2)}`;
  else if (!n.startsWith('+') && defaultCc && n.startsWith('0')) n = `${defaultCc}${n.slice(1)}`;
  return /^\+\d{8,15}$/.test(n) ? n : null;
}

export async function loadSmsConfig(t: Tenant) {
  const row = await t.one('SELECT * FROM sms_settings WHERE agency_id = ?', [t.agencyId]);
  if (!row) return null;
  const c = JSON.parse(decrypt(row.config_enc)) as { sid: string; token: string; from: string };
  return { ...c, default_cc: row.default_cc as string | null, updated_at: row.updated_at };
}

const DAILY_CAP = 300;

/** Sends one text and records it. Never throws for a provider failure after logging it; throws HttpError for things the caller must fix. */
export async function sendSms(t: Tenant, rawTo: string, body: string, ctx: { client_id?: number | null; entity_type?: string | null; entity_id?: number | null } = {}) {
  const cfg = await loadSmsConfig(t);
  if (!cfg) throw new HttpError(409, 'SMS is not set up yet. An admin can connect it under Settings → Text messages.');
  const to = normalizeNumber(rawTo, cfg.default_cc);
  if (!to) throw new HttpError(400, 'That phone number needs its country code, e.g. +92 300 1234567.');
  const used = (await t.one<{ n: number }>("SELECT COUNT(*) n FROM sms_log WHERE agency_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)", [t.agencyId]))!.n;
  if (used >= DAILY_CAP) throw new HttpError(429, `Daily limit of ${DAILY_CAP} text messages reached. Try again tomorrow.`);
  const log = (status: 'sent' | 'failed', error: string | null, ref: string | null) => t.insert('sms_log', { to_number: to, body, status, error, provider_ref: ref, client_id: ctx.client_id ?? null, entity_type: ctx.entity_type ?? null, entity_id: ctx.entity_id ?? null, user_id: t.actor.userId });
  if (process.env.NODE_ENV === 'test') { testSmsOutbox.push({ to, body, from: cfg.from }); await log('sent', null, 'test'); return { to, status: 'sent' as const }; }
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`, {
      method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: cfg.from, Body: body }), signal: AbortSignal.timeout(10_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) { const why = String(j.message ?? `HTTP ${r.status}`).slice(0, 250); await log('failed', why, null); throw new HttpError(502, `The SMS provider refused the message: ${why}`); }
    await log('sent', null, String(j.sid ?? '').slice(0, 60) || null);
    return { to, status: 'sent' as const };
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    await log('failed', String(e?.message ?? e).slice(0, 250), null);
    throw new HttpError(502, 'Could not reach the SMS provider. Nothing was sent — try again in a moment.');
  }
}
