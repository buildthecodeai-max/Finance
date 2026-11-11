import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { pool } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import { addInterval, assertFits, getSub, log, planOrThrow } from './billing.js';
import { sendMail } from './email.js';

/**
 * Pay for a plan with JazzCash or Easypaisa (Pakistani rupees). The platform has one merchant account per provider, set in the Super Admin console.
 * A payment only extends a subscription after the gateway's answer has been checked: JazzCash signs its reply, and for Easypaisa we ask the gateway directly.
 * Anything we cannot check stays "pending" for an operator to settle by hand. A claimed success in a browser address bar is never enough.
 * NOTE: the signing and inquiry formats follow the providers' hosted-checkout guides as we understand them. They must be exercised once with sandbox credentials before going live.
 */
export type Provider = 'jazzcash' | 'easypaisa';
export const PROVIDERS: Provider[] = ['jazzcash', 'easypaisa'];
export const LABEL: Record<Provider, string> = { jazzcash: 'JazzCash', easypaisa: 'Easypaisa' };

export type JazzConfig = { merchant_id: string; password: string; integrity_salt: string; sandbox: boolean };
export type EasyConfig = { store_id: string; hash_key: string; sandbox: boolean; account_num?: string; username?: string; password?: string };

/** Swappable so tests never reach a real gateway. */
export const http = {
  async postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return { status: r.status, json: await r.json().catch(() => null) };
  },
};

/* ------------------------------------------------------------------ stored settings (encrypted, in platform_settings) */
async function getConfig<T>(p: Provider): Promise<T | null> {
  const [rows]: any = await pool.query('SELECT v_enc FROM platform_settings WHERE k = ?', [`lp_${p}`]);
  if (!rows.length) return null;
  try { return JSON.parse(decrypt(rows[0].v_enc)) as T; } catch { return null; }
}
export async function saveConfig(p: Provider, c: JazzConfig | EasyConfig, userId: number | null) {
  const id = p === 'jazzcash' ? (c as JazzConfig).merchant_id : (c as EasyConfig).store_id;
  await pool.query('INSERT INTO platform_settings (k, v_enc, hint, updated_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE v_enc = VALUES(v_enc), hint = VALUES(hint), updated_by = VALUES(updated_by)', [`lp_${p}`, encrypt(JSON.stringify(c)), id.slice(-4), userId]);
}
export async function removeConfig(p: Provider) { const [r]: any = await pool.query('DELETE FROM platform_settings WHERE k = ?', [`lp_${p}`]); return r.affectedRows > 0; }

const API = () => `${config.appUrl}/api/pay-return`;
/** What an operator sees: whether each provider is set up and in which mode. Never a secret. */
export async function info() {
  const [rows]: any = await pool.query("SELECT s.k, s.hint, s.updated_at, u.email FROM platform_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.k IN ('lp_jazzcash', 'lp_easypaisa')");
  const out: Record<string, any> = {};
  for (const p of PROVIDERS) {
    const row = rows.find((r: any) => r.k === `lp_${p}`), c: any = row ? await getConfig(p) : null;
    out[p] = { label: LABEL[p], configured: !!c, sandbox: c ? !!c.sandbox : null, hint: row?.hint ?? null, updated_at: row?.updated_at ?? null, updated_by: row?.email ?? null,
      ...(p === 'easypaisa' ? { can_verify: !!(c?.account_num && c?.username && c?.password) } : {}),
      return_url: p === 'jazzcash' ? `${API()}/jazzcash` : `${API()}/easypaisa/{reference}` };
  }
  return out;
}
/** For agencies: which ways to pay are switched on, and whether they are in test mode. */
export async function options() {
  const i = await info();
  return { jazzcash: i.jazzcash.configured ? { sandbox: !!i.jazzcash.sandbox } : null, easypaisa: i.easypaisa.configured ? { sandbox: !!i.easypaisa.sandbox } : null };
}

/* ------------------------------------------------------------------ JazzCash: hosted checkout, signed with HMAC-SHA256 */
const JAZZ_URL = (sandbox: boolean) => `https://${sandbox ? 'sandbox' : 'payments'}.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/`;
/** HMAC-SHA256 over the integrity salt and every non-empty pp_ value, in field-name order, joined by "&"; the salt is also the key. Upper-case hex. */
export function jazzSign(fields: Record<string, unknown>, salt: string): string {
  const keys = Object.keys(fields).filter((k) => /^pp/.test(k) && k !== 'pp_SecureHash' && fields[k] !== '' && fields[k] != null).sort();
  return crypto.createHmac('sha256', salt).update([salt, ...keys.map((k) => String(fields[k]))].join('&')).digest('hex').toUpperCase();
}
export function jazzVerify(fields: Record<string, unknown>, salt: string): boolean {
  const given = String(fields.pp_SecureHash ?? '').toUpperCase(), want = jazzSign(fields, salt);
  return given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}
/** Gateway clocks run on Pakistan time (UTC+5). */
const pkt = (d: Date) => new Date(d.getTime() + 5 * 3600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
function jazzForm(c: JazzConfig, o: { ref: string; amount: number; description: string; billRef: string }) {
  const now = new Date(), f: Record<string, string> = {
    pp_Version: '1.1', pp_TxnType: '', pp_Language: 'EN', pp_MerchantID: c.merchant_id, pp_SubMerchantID: '', pp_Password: c.password, pp_BankID: '', pp_ProductID: '',
    pp_TxnRefNo: o.ref, pp_Amount: String(Math.round(o.amount * 100)), pp_TxnCurrency: 'PKR', pp_TxnDateTime: pkt(now), pp_BillReference: o.billRef, pp_Description: o.description,
    pp_TxnExpiryDateTime: pkt(new Date(now.getTime() + 3600_000)), pp_ReturnURL: `${API()}/jazzcash`, ppmpf_1: '', ppmpf_2: '', ppmpf_3: '', ppmpf_4: '', ppmpf_5: '' };
  f.pp_SecureHash = jazzSign(f, c.integrity_salt);
  return f;
}

/* ------------------------------------------------------------------ Easypaisa: hosted checkout, request encrypted with AES-ECB, result confirmed by asking the gateway */
const EASY_BASE = (sandbox: boolean) => `https://${sandbox ? 'easypaystg' : 'easypay'}.easypaisa.com.pk`;
/** The request fields, sorted by name and joined as name=value&…, encrypted with the store's hash key (AES-ECB) and base64 encoded. */
export function easyHash(params: Record<string, string>, key: string): string {
  const text = Object.keys(params).filter((k) => params[k] !== '').sort().map((k) => `${k}=${params[k]}`).join('&');
  const c = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, Buffer.from(key, 'utf8'), null);
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64');
}
const easyAmount = (n: number) => (Number.isInteger(n * 10) ? n.toFixed(1) : n.toFixed(2));
function easyUrl(c: EasyConfig, o: { ref: string; amount: number; email: string }) {
  const p: Record<string, string> = { storeId: c.store_id, amount: easyAmount(o.amount), postBackURL: `${API()}/easypaisa/${o.ref}`, orderRefNum: o.ref, expiryDate: pkt(new Date(Date.now() + 3600_000)).replace(/^(\d{8})/, '$1 '), autoRedirect: '1', emailAddr: o.email };
  const q = new URLSearchParams({ ...p, merchantHashedReq: easyHash(p, c.hash_key) });
  return `${EASY_BASE(c.sandbox)}/easypay/Index.jsf?${q}`;
}
/** Ask Easypaisa directly whether the order was paid. null = could not find out (no inquiry login saved, or the gateway did not answer clearly). */
export async function easyInquire(c: EasyConfig, ref: string): Promise<{ paid: boolean; amount: number | null } | null> {
  if (!c.account_num || !c.username || !c.password) return null;
  try {
    const r = await http.postJson(`${EASY_BASE(c.sandbox)}/easypay-service/rest/v4/inquire-transaction`, { orderId: ref, storeId: c.store_id, accountNum: c.account_num }, { Credentials: Buffer.from(`${c.username}:${c.password}`).toString('base64') });
    const j = r.json; if (r.status !== 200 || !j || typeof j !== 'object') return null;
    if (String(j.transactionStatus ?? '').toUpperCase() === 'PAID') return { paid: true, amount: j.transactionAmount != null ? Number(j.transactionAmount) : null };
    return String(j.responseCode ?? '') ? { paid: false, amount: null } : null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ starting a payment */
const stamp = () => pkt(new Date());
export type Checkout = { provider: Provider; ref: string; method: 'POST' | 'GET'; url: string; fields?: Record<string, string> };

export async function start(o: { agencyId: number; userId: number; email: string; plan: string; interval: 'monthly' | 'yearly'; provider: Provider }): Promise<Checkout> {
  if (!PROVIDERS.includes(o.provider)) throw new HttpError(400, 'Choose JazzCash or Easypaisa.');
  const c = await getConfig<any>(o.provider);
  if (!c) throw new HttpError(501, `${LABEL[o.provider]} is not switched on yet. Choose another way to pay or contact support.`);
  const p = await planOrThrow(o.plan), amount = Number(o.interval === 'yearly' ? p.price_yearly_pkr : p.price_monthly_pkr);
  if (!(amount > 0)) throw new HttpError(409, `The ${p.name} plan has no price in rupees for ${o.interval} billing yet, so it cannot be paid this way.`);
  const s = await getSub(o.agencyId);
  if (s?.stripe_subscription_id && s.status === 'active') throw new HttpError(409, 'Your subscription is paid by card. Use Change plan, or cancel it first.');
  await assertFits(o.agencyId, p);
  const [[recent]]: any = await pool.query("SELECT COUNT(*) n FROM local_payments WHERE agency_id = ? AND status = 'pending' AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)", [o.agencyId]);
  if (recent.n >= 5) throw new HttpError(429, 'Several payments were started a moment ago. Please finish or wait a few minutes before trying again.');
  let ref = '';
  for (let i = 0; i < 5; i++) {   // T + date/time + 4 digits: 19 characters, letters and digits only, as both gateways require
    ref = `T${stamp()}${crypto.randomInt(1000, 10000)}`;
    try { await pool.query('INSERT INTO local_payments (agency_id, plan_id, billing_interval, provider, txn_ref, amount_pkr, created_by) VALUES (?,?,?,?,?,?,?)', [o.agencyId, p.id, o.interval, o.provider, ref, amount, o.userId]); break; }
    catch (e: any) { if (e.code !== 'ER_DUP_ENTRY' || i === 4) throw e; }
  }
  if (o.provider === 'jazzcash') return { provider: o.provider, ref, method: 'POST', url: JAZZ_URL(c.sandbox), fields: jazzForm(c, { ref, amount, description: `${p.name} plan ${o.interval}`.replace(/[^A-Za-z0-9 ]/g, ''), billRef: `agency${o.agencyId}` }) };
  return { provider: o.provider, ref, method: 'GET', url: easyUrl(c, { ref, amount, email: o.email }) };
}

/* ------------------------------------------------------------------ settling a payment */
export type Outcome = { status: 'paid' | 'pending' | 'failed' | 'unknown' | 'error'; ref?: string };
const byRef = async (ref: string) => { const [[r]]: any = await pool.query('SELECT * FROM local_payments WHERE txn_ref = ?', [ref]); return r as any | undefined; };

/** Marks the payment paid and extends the subscription, in one transaction, exactly once however many times the gateway repeats itself. */
export async function applyPaid(ref: string, d: { code?: string; message?: string; providerRef?: string; by: 'gateway' | 'operator'; operatorId?: number | null }): Promise<'applied' | 'duplicate' | 'missing'> {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [[pay]]: any = await c.query('SELECT * FROM local_payments WHERE txn_ref = ? FOR UPDATE', [ref]);
    if (!pay) { await c.rollback(); return 'missing'; }
    if (pay.status === 'paid') { await c.rollback(); return 'duplicate'; }
    const [[s]]: any = await c.query('SELECT * FROM subscriptions WHERE agency_id = ? FOR UPDATE', [pay.agency_id]);
    const now = new Date(), curEnd = s?.current_period_end ? new Date(`${String(s.current_period_end).replace(' ', 'T')}Z`) : null;
    const renewing = s?.status === 'active' && !!curEnd && curEnd > now;   // paying early adds to the time already paid for
    const from = renewing ? curEnd! : now, end = addInterval(from, pay.billing_interval), sql = (x: Date) => x.toISOString().slice(0, 19).replace('T', ' ');
    await c.query("UPDATE local_payments SET status = 'paid', paid_at = UTC_TIMESTAMP(), gateway_code = ?, gateway_message = ?, provider_ref = ?, settled_by = ?, confirmed_by = ? WHERE id = ?",
      [d.code ?? null, (d.message ?? '').slice(0, 300) || null, d.providerRef ?? null, d.by, d.operatorId ?? null, pay.id]);
    await c.query(`UPDATE subscriptions SET plan_id = ?, billing_interval = ?, status = 'active', is_manual = 1, current_period_start = ?, current_period_end = ?, grace_until = NULL, cancel_at_period_end = 0, trial_ends_at = NULL, pending_plan_id = NULL, pending_interval = NULL WHERE agency_id = ?`,
      [pay.plan_id, pay.billing_interval, renewing ? s.current_period_start : sql(now), sql(end), pay.agency_id]);
    await c.query("INSERT IGNORE INTO subscription_invoices (agency_id, stripe_invoice_id, number, amount, currency, status, period_start, period_end, paid_at) VALUES (?,?,?,?,?,'paid',?,?,UTC_TIMESTAMP())",
      [pay.agency_id, pay.txn_ref, pay.txn_ref, pay.amount_pkr, 'PKR', sql(from), sql(end)]);   // the stripe_invoice_id column simply holds the payment reference here
    await log(c, pay.agency_id, 'local_payment', `${LABEL[pay.provider as Provider]} PKR ${pay.amount_pkr}, paid until ${sql(end)}${d.by === 'operator' ? ' (confirmed by an operator)' : ''}`, `local:${pay.txn_ref}`, pay.created_by);
    await c.commit();
    void receipt(pay, end).catch(() => {});
    return 'applied';
  } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
}
async function receipt(pay: any, end: Date) {
  const [[u]]: any = await pool.query('SELECT email, name FROM users WHERE id = ?', [pay.created_by]); const [[p]]: any = await pool.query('SELECT name FROM plans WHERE id = ?', [pay.plan_id]);
  if (!u?.email) return;
  await sendMail(u.email, 'Payment received. Thank you', `<p>Hi ${String(u.name).replace(/</g, '&lt;')},</p><p>We received your ${LABEL[pay.provider as Provider]} payment of PKR ${Number(pay.amount_pkr).toLocaleString('en')} for the ${String(p?.name ?? '').replace(/</g, '&lt;')} plan (${pay.billing_interval}). Your plan is active until ${end.toISOString().slice(0, 10)}.</p><p>Reference: ${pay.txn_ref}</p>`);
}
async function markFailed(ref: string, code: string | undefined, message: string | undefined) {
  await pool.query("UPDATE local_payments SET status = 'failed', gateway_code = ?, gateway_message = ? WHERE txn_ref = ? AND status = 'pending'", [(code ?? '').slice(0, 20) || null, (message ?? '').slice(0, 300) || null, ref]);
}
const note = (ref: string, code: string | undefined, message: string | undefined) => pool.query("UPDATE local_payments SET gateway_code = ?, gateway_message = ? WHERE txn_ref = ? AND status <> 'paid'", [(code ?? '').slice(0, 20) || null, (message ?? '').slice(0, 300) || null, ref]);

/** JazzCash posts its signed result to the browser return address and (if set up) to the server notification address; both come here. */
export async function handleJazzCash(raw: Record<string, unknown>): Promise<Outcome> {
  const body: Record<string, string> = {}; for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && k.length < 60) body[k] = v.slice(0, 400);
  const ref = body.pp_TxnRefNo ?? '', row = ref ? await byRef(ref) : undefined, c = await getConfig<JazzConfig>('jazzcash');
  if (!row || row.provider !== 'jazzcash') return { status: 'unknown' };
  if (!c || !jazzVerify(body, c.integrity_salt)) return { status: 'error', ref };   // not signed by JazzCash: change nothing
  if (row.status === 'paid') return { status: 'paid', ref };
  if (Number(body.pp_Amount) !== Math.round(Number(row.amount_pkr) * 100)) { await note(ref, 'amount', 'The amount returned does not match the amount requested. Check with JazzCash.'); return { status: 'pending', ref }; }
  if (body.pp_ResponseCode === '000') { await applyPaid(ref, { code: '000', message: body.pp_ResponseMessage, providerRef: body.pp_RetreivalReferenceNo, by: 'gateway' }); return { status: 'paid', ref }; }
  if (body.pp_ResponseCode === '124') { await note(ref, '124', body.pp_ResponseMessage); return { status: 'pending', ref }; }   // still waiting for the customer
  await markFailed(ref, body.pp_ResponseCode, body.pp_ResponseMessage); return { status: 'failed', ref };
}

/** Easypaisa sends the customer back to us, first with an auth token to confirm, then with a result. The result is never trusted on its own. */
export async function handleEasypaisa(ref: string, q: Record<string, unknown>): Promise<Outcome & { redirect?: string }> {
  const row = await byRef(ref), c = await getConfig<EasyConfig>('easypaisa');
  if (!row || row.provider !== 'easypaisa') return { status: 'unknown' };
  if (!c) return { status: 'error', ref };
  if (row.status === 'paid') return { status: 'paid', ref };
  const s = (k: string) => (typeof q[k] === 'string' ? (q[k] as string).slice(0, 300) : '');
  if (s('auth_token') && !s('status')) return { status: 'pending', ref, redirect: `${EASY_BASE(c.sandbox)}/easypay/Confirm.jsf?${new URLSearchParams({ auth_token: s('auth_token'), postBackURL: `${API()}/easypaisa/${ref}` })}` };
  const said = s('status'), failedLike = !!said && said !== '0000';
  const r = await easyInquire(c, ref);
  if (r?.paid) {
    if (r.amount !== null && Math.abs(r.amount - Number(row.amount_pkr)) > 0.001) { await note(ref, 'amount', 'The amount Easypaisa reports does not match the amount requested. Check with Easypaisa.'); return { status: 'pending', ref }; }
    await applyPaid(ref, { code: said || '0000', message: s('desc') || 'Paid (confirmed with Easypaisa)', by: 'gateway' }); return { status: 'paid', ref };
  }
  if (failedLike && r?.paid !== true) { await markFailed(ref, said, s('desc')); return { status: 'failed', ref }; }   // a failure can never grant access, so it is safe to believe
  await note(ref, said, said === '0000' ? 'Easypaisa reported success but it could not be confirmed automatically. An operator will confirm it.' : s('desc'));
  return { status: 'pending', ref };
}

/* ------------------------------------------------------------------ lists */
export async function listForAgency(agencyId: number) {
  const [r]: any = await pool.query("SELECT lp.id, lp.provider, lp.txn_ref, lp.amount_pkr, lp.billing_interval, lp.status, lp.gateway_message, lp.created_at, lp.paid_at, p.name plan_name FROM local_payments lp LEFT JOIN plans p ON p.id = lp.plan_id WHERE lp.agency_id = ? ORDER BY lp.id DESC LIMIT 20", [agencyId]);
  return r;
}
export async function listAll(o: { status?: string; page?: number; size?: number }) {
  const size = Math.min(100, Math.max(5, o.size ?? 20)), page = Math.max(1, o.page ?? 1), st = ['pending', 'paid', 'failed'].includes(String(o.status)) ? String(o.status) : null;
  const [[n]]: any = await pool.query(`SELECT COUNT(*) n FROM local_payments ${st ? 'WHERE status = ?' : ''}`, st ? [st] : []);
  const [[c]]: any = await pool.query("SELECT SUM(status = 'pending') pending, SUM(status = 'paid') paid, SUM(status = 'failed') failed FROM local_payments");
  const [rows]: any = await pool.query(`SELECT lp.*, a.name agency_name, p.name plan_name, u.email payer_email FROM local_payments lp JOIN agencies a ON a.id = lp.agency_id LEFT JOIN plans p ON p.id = lp.plan_id LEFT JOIN users u ON u.id = lp.created_by
    ${st ? 'WHERE lp.status = ?' : ''} ORDER BY lp.id DESC LIMIT ? OFFSET ?`, [...(st ? [st] : []), size, (page - 1) * size]);
  return { rows, total: n.n, page, page_size: size, counts: { pending: Number(c.pending ?? 0), paid: Number(c.paid ?? 0), failed: Number(c.failed ?? 0) } };
}
export const getPayment = byRef;
export const getPaymentById = async (id: number) => { const [[r]]: any = await pool.query('SELECT * FROM local_payments WHERE id = ?', [id]); return r as any | undefined; };
