import crypto from 'node:crypto';
import Stripe from 'stripe';
import { config } from '../config.js';
import { sha256 } from '../crypto.js';
import { HttpError } from '../errors.js';
import { Tenant, pool } from '../db.js';
import { sendMail } from './email.js';
import { r2 } from './money.js';

const PAYABLE = ['sent', 'partially_paid', 'overdue'];
const SHOWN = ['sent', 'partially_paid', 'paid', 'overdue', 'credited'];
const SHOWN_BOOKING = ['confirmed', 'ticketed', 'in_service', 'travel_completed', 'closed'];
const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

/** Swappable so tests (and other gateways) can replace Stripe. */
export const gateway = {
  async checkout(o: { agencyId: number; invoiceId: number; number: string; currency: string; cents: number; successUrl: string; cancelUrl: string }): Promise<string> {
    if (!config.stripeKey) throw new HttpError(501, 'Online card payment is not enabled for this agency — please pay by bank transfer using the details shown.');
    const meta = { agency_id: String(o.agencyId), invoice_id: String(o.invoiceId) };
    const s = await new Stripe(config.stripeKey).checkout.sessions.create({ mode: 'payment', metadata: meta, payment_intent_data: { metadata: meta }, success_url: o.successUrl, cancel_url: o.cancelUrl,
      line_items: [{ quantity: 1, price_data: { currency: o.currency.toLowerCase(), unit_amount: o.cents, product_data: { name: `Invoice ${o.number}` } } }] });
    return s.url!;
  },
};

/** Email with a delivery record: sent / failed (with the error) / skipped (mail not configured). Never throws. */
export async function deliver(t: Tenant, d: { kind: string; ref_table?: string; ref_id?: number; to: string; subject: string; html: string }) {
  let status: 'sent' | 'failed' | 'skipped' = 'sent', error: string | null = null;
  if (!config.sendgridKey) status = 'skipped';
  else try { await sendMail(d.to, d.subject, d.html); } catch (e: any) { status = 'failed'; error = String(e?.message ?? e).slice(0, 300); }
  await pool.query('INSERT INTO delivery_log (agency_id, kind, ref_table, ref_id, recipient, subject, status, error, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [t.agencyId, d.kind, d.ref_table ?? null, d.ref_id ?? null, d.to, d.subject.slice(0, 250), status, error, t.actor.userId ?? null]);
  return status;
}

export async function createLink(t: Tenant, i: { client_id: number; scope: 'portal' | 'invoice'; invoice_id?: number; days: number }) {
  return t.tx(async (tx) => {
    const client = await tx.get('clients', i.client_id);
    if (!client) { await tx.ref('clients', i.client_id, 'client'); throw new HttpError(404, 'Client not found'); }
    if (i.scope === 'invoice') {
      const inv = i.invoice_id ? await tx.get('invoices', i.invoice_id) : null;
      if (!inv || inv.client_id !== i.client_id) { if (i.invoice_id) await tx.ref('invoices', i.invoice_id, 'invoice'); throw new HttpError(400, 'Invoice does not belong to this client'); }
      if (!PAYABLE.includes(inv.status)) throw new HttpError(409, `Invoice is ${inv.status}; payment links are for issued invoices with a balance`);
    }
    const token = crypto.randomBytes(32).toString('base64url'), expires = new Date(Date.now() + i.days * 86400_000);
    const id = await tx.insert('portal_links', { client_id: i.client_id, scope: i.scope, invoice_id: i.scope === 'invoice' ? i.invoice_id : null, token_hash: sha256(token), expires_at: sqlTime(expires), created_by: tx.actor.userId });
    return { id, token, url: `${config.appUrl}/${i.scope === 'invoice' ? 'pay' : 'portal'}/${token}`, expires_at: sqlTime(expires), client };
  });
}

export const listLinks = (t: Tenant, clientId?: number) => t.query(
  `SELECT l.id, l.client_id, c.name client_name, l.scope, l.invoice_id, i.number invoice_number, l.expires_at, l.revoked_at, l.created_at, l.last_used_at, l.use_count,
   (l.revoked_at IS NULL AND l.expires_at > UTC_TIMESTAMP()) active FROM portal_links l JOIN clients c ON c.id = l.client_id AND c.agency_id = l.agency_id
   LEFT JOIN invoices i ON i.id = l.invoice_id AND i.agency_id = l.agency_id WHERE l.agency_id = ? ${clientId ? 'AND l.client_id = ?' : ''} ORDER BY l.id DESC LIMIT 200`, clientId ? [t.agencyId, clientId] : [t.agencyId]);

export async function revokeLink(t: Tenant, id: number) {
  const l = await t.get('portal_links', id);
  if (!l) throw new HttpError(404, 'Link not found');
  if (!l.revoked_at) await t.update('portal_links', id, { revoked_at: sqlTime(new Date()), revoked_by: t.actor.userId });
}

/** Resolve a public token. Wrong, expired and revoked tokens are indistinguishable on purpose. */
export async function resolve(token: string, ip?: string) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new HttpError(404, 'This link is invalid or has expired');
  const [rows]: any = await pool.query('SELECT * FROM portal_links WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()', [sha256(token)]);
  if (!rows.length) throw new HttpError(404, 'This link is invalid or has expired');
  const link = rows[0];
  await pool.query('UPDATE portal_links SET last_used_at = UTC_TIMESTAMP(), use_count = use_count + 1 WHERE id = ?', [link.id]);
  return { link, t: new Tenant(link.agency_id, { userId: null, ip: ip ?? null }) };
}

/** Everything a client may see — selling prices and status only; never cost, margin, supplier or internal notes. */
export async function portalView(t: Tenant, link: any) {
  const agency = await t.agency(), client = await t.get('clients', link.client_id);
  const invs = await t.query(`SELECT id, number, issue_date, due_date, currency, total, amount_paid, amount_credited, status FROM invoices
    WHERE agency_id = ? AND client_id = ? AND status IN (${SHOWN.map(() => '?').join(',')}) ${link.scope === 'invoice' ? 'AND id = ?' : ''} ORDER BY issue_date DESC, id DESC LIMIT 100`,
    [t.agencyId, link.client_id, ...SHOWN, ...(link.scope === 'invoice' ? [link.invoice_id] : [])]);
  const invoices = invs.map((i: any) => { const outstanding = Math.max(0, r2(i.total - i.amount_credited - i.amount_paid)); return { ...i, outstanding, payable: PAYABLE.includes(i.status) && outstanding > 0 }; });
  const out: any = { agency: { name: agency.name, tax_label: agency.tax_label, address: agency.address, payment_instructions: agency.payment_instructions, bank_name: agency.bank_name, bank_account_name: agency.bank_account_name,
    bank_account_number: agency.bank_account_number, bank_routing: agency.bank_routing, bank_iban: agency.bank_iban, bank_swift: agency.bank_swift }, client: { name: client.name }, scope: link.scope, invoices, card_payments: !!config.stripeKey };
  if (link.scope === 'portal') {
    out.quotes = await t.query(`SELECT quote_no, title, status, currency, valid_until FROM quotes WHERE agency_id = ? AND client_id = ? AND status IN ('sent','accepted','converted','changes_requested') ORDER BY id DESC LIMIT 50`, [t.agencyId, link.client_id]);
    const bookings = await t.query(`SELECT id, reference, destination, travel_start, travel_end, status FROM bookings WHERE agency_id = ? AND client_id = ? AND status IN (${SHOWN_BOOKING.map(() => '?').join(',')}) ORDER BY travel_start DESC LIMIT 50`, [t.agencyId, link.client_id, ...SHOWN_BOOKING]);
    for (const b of bookings) b.itinerary = await t.query('SELECT day_no, day_date, start_time, title, description, location, confirmed FROM itinerary_items WHERE agency_id = ? AND booking_id = ? ORDER BY day_no, sort, id', [t.agencyId, b.id]);
    out.bookings = bookings;
    out.receipts = await t.query(`SELECT receipt_no, receipt_date, amount, currency, method FROM receipts WHERE agency_id = ? AND client_id = ? AND status = 'posted' ORDER BY receipt_date DESC, id DESC LIMIT 50`, [t.agencyId, link.client_id]);
    out.requests = await t.query('SELECT id, subject, message, status, response, responded_at, created_at FROM support_requests WHERE agency_id = ? AND client_id = ? ORDER BY id DESC LIMIT 50', [t.agencyId, link.client_id]);
  }
  return out;
}

/** The invoice must be the client's own and, for an invoice link, the linked one. */
export async function linkedInvoice(t: Tenant, link: any, invoiceId: number) {
  if (link.scope === 'invoice' && link.invoice_id !== invoiceId) throw new HttpError(404, 'Invoice not found');
  const inv = await t.one(`SELECT * FROM invoices WHERE agency_id = ? AND id = ? AND client_id = ? AND status IN (${SHOWN.map(() => '?').join(',')})`, [t.agencyId, invoiceId, link.client_id, ...SHOWN]);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  return inv;
}

export async function startPayment(t: Tenant, link: any, token: string, invoiceId: number) {
  const inv = await linkedInvoice(t, link, invoiceId);
  const due = Math.round((inv.total - inv.amount_credited - inv.amount_paid) * 100);
  if (!PAYABLE.includes(inv.status) || due <= 0) throw new HttpError(409, 'Nothing is outstanding on this invoice');
  if (!inv.voucher_id) throw new HttpError(409, 'This invoice cannot be paid online yet');
  const back = `${config.appUrl}/${link.scope === 'invoice' ? 'pay' : 'portal'}/${token}`;
  return gateway.checkout({ agencyId: t.agencyId, invoiceId: inv.id, number: inv.number, currency: inv.currency, cents: due, successUrl: `${back}?paid=1`, cancelUrl: back });
}

export async function createRequest(t: Tenant, link: any, b: { subject: string; message: string; booking_id?: number }) {
  if (b.booking_id) {
    const ok = await t.one('SELECT id FROM bookings WHERE agency_id = ? AND id = ? AND client_id = ?', [t.agencyId, b.booking_id, link.client_id]);
    if (!ok) throw new HttpError(400, 'Unknown booking');
  }
  const open = await t.one(`SELECT COUNT(*) n FROM support_requests WHERE agency_id = ? AND client_id = ? AND status = 'open'`, [t.agencyId, link.client_id]);
  if (open!.n >= 10) throw new HttpError(429, 'You have several open requests already — please wait for a reply.');
  return t.insert('support_requests', { client_id: link.client_id, booking_id: b.booking_id ?? null, link_id: link.id, subject: b.subject, message: b.message, status: 'open' });
}
