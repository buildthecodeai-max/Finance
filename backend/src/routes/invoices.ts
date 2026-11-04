import { Router } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { ALL_EDITORS, HttpError, WRITERS, requireRole } from '../auth.js';
import { config } from '../config.js';
import { fileKey, getFile, putFile, signedUrl } from '../storage.js';
import { htmlToPdf, invoiceHtml } from '../services/pdf.js';
import { createLink, deliver } from '../services/portal.js';
const PAYABLE_STATUSES = ['sent', 'partially_paid', 'overdue'];
import { addDays, fmt, priceLines, today } from '../services/money.js';
import { NEXT } from '../services/invoicing.js';
import { issueInvoice, voidInvoice } from '../services/finance.js';
import { findRate } from '../services/fx.js';
import { idParam, parse, T } from './util.js';

export const invoicesRouter = Router();

const Body = z.object({
  client_id: z.number().int(),
  booking_id: z.number().int().nullish(),
  currency: z.string().length(3),
  issue_date: z.string().default(() => today()),
  due_date: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({
    product_type: z.enum(['flight', 'hotel', 'package', 'cruise', 'transfer', 'other']),
    supplier_id: z.number().int().nullish(),
    description: z.string().min(1),
    quantity: z.number().positive().default(1),
    unit_cost: z.number().min(0),
    markup_pct: z.number().min(0).default(0),
    tax_rate: z.number().min(0).default(0),
  })).min(1),
  installments: z.array(z.object({ label: z.string(), due_date: z.string(), amount: z.number().positive() })).default([]),
});

/** Drafts may exist before a rate does; the rate is mandatory (and locked) only when the invoice is issued. */
async function draftRate(tx: any, currency: string, base: string, date: string) {
  if (currency === base) return { fx_rate: 1, fx_source: 'base', fx_date: date };
  const r = await findRate(tx, currency, base, date);
  return r ? { fx_rate: r.rate, fx_source: r.source, fx_date: r.date } : { fx_rate: 1, fx_source: null, fx_date: null };
}

async function load(t: ReturnType<typeof T>, id: number) {
  const inv = await t.get('invoices', id);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  const lines = await t.query('SELECT * FROM invoice_lines WHERE agency_id = ? AND invoice_id = ? ORDER BY id', [t.agencyId, id]);
  const installments = await t.query('SELECT * FROM invoice_installments WHERE agency_id = ? AND invoice_id = ? ORDER BY due_date', [t.agencyId, id]);
  const payments = await t.query(`SELECT p.id, p.direction, p.amount, p.method, p.paid_at, p.reference, p.receipt_id, p.voided FROM payments p WHERE p.agency_id = ? AND p.invoice_id = ? ORDER BY p.paid_at, p.id`, [t.agencyId, id]);
  const credit_notes = await t.query('SELECT id, cn_no, status, total, issue_date, reason FROM credit_notes WHERE agency_id = ? AND invoice_id = ? ORDER BY id', [t.agencyId, id]);
  return { inv, lines, installments, payments, credit_notes };
}

function assertCanEdit(req: any, inv: any) {
  const { role, userId } = req.ctx;
  if (role === 'agent' && (inv.created_by !== userId || inv.status !== 'draft'))
    throw new HttpError(403, 'Agents can only edit their own drafts');
  if (!['draft', 'reviewed'].includes(inv.status)) throw new HttpError(409, 'Invoice is no longer editable');
}

invoicesRouter.get('/', async (req, res) => {
  const t = T(req);
  const { status, q } = req.query as Record<string, string>;
  const rows = await t.query(
    `SELECT i.*, c.name client_name FROM invoices i JOIN clients c ON c.id = i.client_id AND c.agency_id = i.agency_id
     WHERE i.agency_id = ? ${status ? 'AND i.status = ?' : ''} ${q ? 'AND (i.number LIKE ? OR c.name LIKE ?)' : ''}
     ${req.ctx!.role === 'agent' ? 'AND i.created_by = ?' : ''}
     ORDER BY i.id DESC LIMIT 500`,
    [t.agencyId, ...(status ? [status] : []), ...(q ? [`%${q}%`, `%${q}%`] : []), ...(req.ctx!.role === 'agent' ? [req.ctx!.userId] : [])]);
  res.json(rows);
});

invoicesRouter.get('/:id', async (req, res) => res.json(await load(T(req), idParam(req))));

invoicesRouter.post('/', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(Body, req.body);
  const t = T(req);
  await t.refActive('clients', b.client_id, 'client');
  const client = await t.get('clients', b.client_id);
  if (!client) throw new HttpError(400, 'Unknown client');
  await t.ref('bookings', b.booking_id, 'booking'); for (const l of b.lines) await t.refActive('suppliers', l.supplier_id, 'supplier');
  const priced = priceLines(b.lines);
  if (b.installments.length) {
    const sum = b.installments.reduce((s, i) => s + i.amount, 0);
    if (Math.abs(sum - priced.total) > 0.01) throw new HttpError(400, `Instalments (${sum}) must equal invoice total (${priced.total})`);
  }
  const id = await t.tx(async (tx) => {
    const number = await tx.takeInvoiceNumber(); // per-agency sequence, row-locked
    const base = (await tx.agency()).base_currency;
    const invId = await tx.insert('invoices', {
      number, booking_id: b.booking_id ?? null, client_id: b.client_id, created_by: req.ctx!.userId, status: 'draft',
      currency: b.currency, ...(await draftRate(tx, b.currency, base, b.issue_date)), issue_date: b.issue_date,
      due_date: b.due_date ?? addDays(b.issue_date, client.payment_terms_days),
      subtotal: priced.subtotal, tax_total: priced.tax_total, total: priced.total, notes: b.notes ?? null,
    });
    for (const l of priced.lines) await tx.insert('invoice_lines', { invoice_id: invId, ...l });
    for (const i of b.installments) await tx.insert('invoice_installments', { invoice_id: invId, ...i });
    return invId;
  });
  res.status(201).json(await load(t, id));
});

invoicesRouter.put('/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req);
  const b = parse(Body, req.body);
  const { inv } = await load(t, id);
  assertCanEdit(req, inv);
  await t.ref('clients', b.client_id, 'client'); await t.ref('bookings', b.booking_id, 'booking'); for (const l of b.lines) await t.ref('suppliers', l.supplier_id, 'supplier');
  const priced = priceLines(b.lines);
  await t.tx(async (tx) => {
    await tx.update('invoices', id, {
      client_id: b.client_id, booking_id: b.booking_id ?? null, currency: b.currency, issue_date: b.issue_date,
      due_date: b.due_date ?? inv.due_date, subtotal: priced.subtotal, tax_total: priced.tax_total, total: priced.total, notes: b.notes ?? null,
    });
    await tx.query('DELETE FROM invoice_lines WHERE agency_id = ? AND invoice_id = ?', [t.agencyId, id]);
    await tx.query('DELETE FROM invoice_installments WHERE agency_id = ? AND invoice_id = ?', [t.agencyId, id]);
    for (const l of priced.lines) await tx.insert('invoice_lines', { invoice_id: id, ...l });
    for (const i of b.installments) await tx.insert('invoice_installments', { invoice_id: id, ...i });
  });
  res.json(await load(t, id));
});

// Workflow transitions. Agents cannot advance beyond draft.
invoicesRouter.post('/:id/status', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req);
  const { status } = parse(z.object({ status: z.enum(['draft', 'reviewed', 'void']) }), req.body);
  const { inv } = await load(t, id);
  if (!NEXT[inv.status]?.includes(status)) throw new HttpError(409, `Cannot go from ${inv.status} to ${status}`);
  if (status === 'void' && inv.voucher_id) throw new HttpError(409, 'Issued invoices are voided by reversal: POST /invoices/:id/void');
  await t.update('invoices', id, { status });
  res.json({ status });
});

async function agencyLogoData(agency: any): Promise<{ data: string; mime: string } | null> {
  if (!agency.logo_key) return null;
  try {
    const buf = await getFile(agency.logo_key);
    const ext = agency.logo_key.split('.').pop()?.toLowerCase() ?? '';
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { data: buf.toString('base64'), mime };
  } catch { return null; }
}

export async function renderAndStore(t: ReturnType<typeof T>, id: number) {
  const { inv, lines, installments } = await load(t, id);
  const agency = await t.agency();
  const client = await t.get('clients', inv.client_id);
  const logoData = await agencyLogoData(agency);
  const pdf = await htmlToPdf(invoiceHtml(agency, inv, lines, client, installments, logoData), { footer: `${agency.name} · ${inv.number}` });
  const key = await putFile(fileKey(t.agencyId, 'invoices', `${inv.number}.pdf`), pdf, 'application/pdf');
  await t.update('invoices', id, { pdf_key: key });
  return { inv, client, key, agency };
}

// Issue = financial event (posts to the ledger, freezes the invoice). Delivery is separate and retryable.
invoicesRouter.post('/:id/issue', requireRole(...WRITERS), async (req, res) => {
  res.json({ status: 'sent', ...(await issueInvoice(T(req), idParam(req))) });
});

invoicesRouter.post('/:id/void', requireRole(...WRITERS), async (req, res) => {
  const b = parse(z.object({ reason: z.string().optional().default(''), date: z.string().optional() }), req.body);
  res.json(await voidInvoice(T(req), idParam(req), b.reason, b.date ?? today()));
});

// Send: issue if still Reviewed, then render the PDF and email the client. Safe to call again to re-send an issued invoice.
invoicesRouter.post('/:id/send', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req);
  const { inv } = await load(t, id);
  if (!['reviewed', 'sent', 'partially_paid', 'overdue'].includes(inv.status)) throw new HttpError(409, 'Invoice must be Reviewed (or already issued) before sending');
  const clientCheck = await t.get('clients', inv.client_id);
  if (!clientCheck?.email) throw new HttpError(400, 'Client has no email');
  if (inv.status === 'reviewed') await issueInvoice(t, id);
  const { client, key, agency } = await renderAndStore(t, id);
  const fresh = (await load(t, id)).inv;
  const url = await signedUrl(t.agencyId, key, `${fresh.number}.pdf`);
  const pay = PAYABLE_STATUSES.includes(fresh.status) ? await createLink(t, { client_id: client.id, scope: 'invoice', invoice_id: id, days: 60 }) : null;
  const delivery = await deliver(t, { kind: 'invoice', ref_table: 'invoices', ref_id: id, to: client.email, subject: `Invoice ${fresh.number} from ${agency.name}`,
    html: `<p>Hi ${client.name},</p><p>Your invoice <b>${fresh.number}</b> for <b>${fmt(fresh.total, fresh.currency)}</b> is due ${fresh.due_date}.</p>
     <p><a href="${url}">Download PDF</a> (link expires in ${Math.round(config.r2.signedTtl / 60)} minutes)</p>${pay ? `<p><a href="${pay.url}">View and pay online</a></p>` : ''}` });
  res.json({ status: fresh.status, delivery });
});

invoicesRouter.get('/:id/pdf-url', async (req, res) => {
  const t = T(req), id = idParam(req);
  const { inv } = await load(t, id);
  // A sent invoice keeps the exact PDF the client received; anything not yet sent is re-rendered from current data.
  const key = inv.sent_at && inv.pdf_key ? inv.pdf_key : (await renderAndStore(t, id)).key;
  res.json({ url: await signedUrl(t.agencyId, key, `${inv.number}.pdf`), expiresIn: config.r2.signedTtl });
});

// Stripe Checkout for the outstanding balance
invoicesRouter.post('/:id/pay-link', requireRole(...WRITERS), async (req, res) => {
  if (!config.stripeKey) throw new HttpError(501, 'Stripe not configured');
  const t = T(req), id = idParam(req);
  const { inv } = await load(t, id);
  const due = Math.round((inv.total - inv.amount_paid) * 100);
  if (due <= 0) throw new HttpError(409, 'Nothing outstanding');
  const stripe = new Stripe(config.stripeKey);
  const s = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: inv.currency.toLowerCase(), unit_amount: due, product_data: { name: `Invoice ${inv.number}` } } }],
    metadata: { agency_id: String(t.agencyId), invoice_id: String(id) },
    payment_intent_data: { metadata: { agency_id: String(t.agencyId), invoice_id: String(id) } },
    success_url: `${config.appUrl}/invoices/${id}?paid=1`, cancel_url: `${config.appUrl}/invoices/${id}`,
  });
  res.json({ url: s.url });
});
