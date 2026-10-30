import { assertWithinLimit } from '../services/billing.js';
import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ALL_EDITORS, WRITERS, requireRole } from '../auth.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { pool, Tenant } from '../db.js';
import { sha256 } from '../crypto.js';
import { emit } from '../services/webhooks.js';
import { nextDocNo } from '../services/accounting.js';
import { sendMail } from '../services/email.js';
import { addDays, r2, today } from '../services/money.js';
import { marginPct, priceComponent } from '../services/pricing.js';
import { safeRecalc } from '../services/commissions.js';
import { assertCanEdit, findScoped, scope } from './scope.js';
import { idParam, parse, T } from './util.js';

export const quotesRouter = Router();
export const publicQuotesRouter = Router();

const TYPES = ['flight', 'hotel', 'package', 'cruise', 'transfer', 'tour', 'rail', 'car', 'insurance', 'visa', 'fee', 'other'] as const;
const nul = <S extends z.ZodTypeAny>(s: S) => s.nullish();
const Component = z.object({
  option_name: z.string().min(1).max(60).default('Option 1'), product_type: z.enum(TYPES), supplier_id: nul(z.number().int()), description: z.string().min(1).max(500),
  service_start: nul(z.string()), service_end: nul(z.string()), quantity: z.number().positive().default(1), unit_cost: z.number().min(0).default(0),
  markup_pct: z.number().min(0).default(0), discount_pct: z.number().min(0).max(100).default(0), tax_rate: z.number().min(0).default(0),
});
const QuoteIn = z.object({
  title: z.string().min(1).max(200), client_id: nul(z.number().int()), lead_id: nul(z.number().int()), currency: z.string().length(3), valid_until: nul(z.string()),
  inclusions: nul(z.string()), exclusions: nul(z.string()), payment_terms: nul(z.string()), cancellation_terms: nul(z.string()), internal_notes: nul(z.string()),
  components: z.array(Component).min(1),
});

// ---- helpers ----
function summarise(comps: any[]) {
  const by = new Map<string, { option: string; net: number; tax: number; cost: number }>();
  for (const c of comps) {
    const o = by.get(c.option_name) ?? { option: c.option_name, net: 0, tax: 0, cost: 0 };
    o.net = r2(o.net + c.net_total); o.tax = r2(o.tax + c.tax_total); o.cost = r2(o.cost + c.cost_total); by.set(c.option_name, o);
  }
  return [...by.values()].map((o) => ({ ...o, total: r2(o.net + o.tax), margin_pct: marginPct(o.net, o.cost) }));
}
const lowestMargin = (opts: { margin_pct: number | null }[]) => { const m = opts.map((o) => o.margin_pct).filter((x): x is number => x !== null); return m.length ? Math.min(...m) : null; };

async function insertComponents(t: Tenant, quoteId: number, version: number, comps: z.infer<typeof Component>[]) {
  let sort = 0;
  for (const c of comps) {
    await t.refActive('suppliers', c.supplier_id, 'supplier');
    await t.insert('quote_components', { ...c, quote_id: quoteId, version, sort: sort++, ...priceComponent(c) });
  }
}

async function loadVersion(t: Tenant, quoteId: number, version: number) {
  const v = await t.one('SELECT * FROM quote_versions WHERE agency_id = ? AND quote_id = ? AND version = ?', [t.agencyId, quoteId, version]);
  if (!v) throw new HttpError(404, 'Version not found');
  const components = await t.query(`SELECT c.*, s.name supplier_name FROM quote_components c LEFT JOIN suppliers s ON s.id = c.supplier_id AND s.agency_id = c.agency_id WHERE c.agency_id = ? AND c.quote_id = ? AND c.version = ? ORDER BY c.sort, c.id`, [t.agencyId, quoteId, version]);
  const options = summarise(components);
  return { ...v, components, options };
}

async function assertQuoteRefs(t: Tenant, b: { client_id?: number | null; lead_id?: number | null }, req: Request) {
  await t.refActive('clients', b.client_id, 'client');
  if (b.lead_id) await findScoped(t, req, 'leads', b.lead_id);
}

// ---- list / read ----
quotesRouter.get('/', async (req, res) => {
  const t = T(req), s = scope(req, 'q'), { status } = req.query as Record<string, string>;
  const rows = await t.query(
    `SELECT q.id, q.quote_no, q.title, q.status, q.currency, q.valid_until, q.current_version, q.booking_id, q.created_at, c.name client_name, l.name lead_name, u.name owner_name,
       (SELECT margin_pct FROM quote_versions v WHERE v.agency_id = q.agency_id AND v.quote_id = q.id AND v.version = q.current_version) margin_pct,
       (SELECT MIN(x.t) FROM (SELECT quote_id, version, option_name, SUM(net_total + tax_total) t FROM quote_components WHERE agency_id = ? GROUP BY quote_id, version, option_name) x WHERE x.quote_id = q.id AND x.version = q.current_version) from_total
     FROM quotes q LEFT JOIN clients c ON c.id = q.client_id AND c.agency_id = q.agency_id LEFT JOIN leads l ON l.id = q.lead_id AND l.agency_id = q.agency_id LEFT JOIN users u ON u.id = q.owner_id
     WHERE q.agency_id = ?${s.sql} ${status ? 'AND q.status = ?' : ''} ORDER BY q.id DESC LIMIT 500`,
    [t.agencyId, t.agencyId, ...s.params, ...(status ? [status] : [])]);
  res.json(rows);
});

quotesRouter.get('/:id', async (req, res) => {
  const t = T(req), id = idParam(req), q = await findScoped(t, req, 'quotes', id);
  const { public_token_hash, ...quote } = q; void public_token_hash;
  res.json({
    ...quote, ...(await loadVersion(t, id, q.current_version)), id, version: q.current_version,
    versions: await t.query('SELECT version, sent_at, margin_pct, created_at FROM quote_versions WHERE agency_id = ? AND quote_id = ? ORDER BY version DESC', [t.agencyId, id]),
    activities: await t.query(`SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id = a.created_by WHERE a.agency_id = ? AND a.entity_type = 'quote' AND a.entity_id = ? ORDER BY a.id DESC`, [t.agencyId, id]),
  });
});
quotesRouter.get('/:id/versions/:v', async (req, res) => {
  const t = T(req), id = idParam(req); await findScoped(t, req, 'quotes', id);
  res.json(await loadVersion(t, id, Number(req.params.v)));
});

// ---- create / edit ----
async function activity(t: Tenant, quoteId: number, body: string) { await t.insert('activities', { entity_type: 'quote', entity_id: quoteId, kind: 'system', body, created_by: t.actor.userId }); }

quotesRouter.post('/', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(QuoteIn, req.body), t = T(req);
  await assertQuoteRefs(t, b, req);
  const id = await t.tx(async (tx) => {
    const quote_no = await nextDocNo(tx, 'quotes', 'quote_no', 'QT');
    const { components, inclusions, exclusions, payment_terms, cancellation_terms, internal_notes, ...head } = b;
    const qid = await tx.insert('quotes', { ...head, quote_no, owner_id: req.ctx!.userId, branch_id: req.ctx!.branchId, created_by: req.ctx!.userId, valid_until: head.valid_until ?? null });
    await insertComponents(tx, qid, 1, components);
    await tx.insert('quote_versions', { quote_id: qid, version: 1, inclusions, exclusions, payment_terms, cancellation_terms, internal_notes, margin_pct: lowestMargin(summarise(await tx.query('SELECT * FROM quote_components WHERE agency_id = ? AND quote_id = ? AND version = 1', [tx.agencyId, qid]))), created_by: req.ctx!.userId });
    await activity(tx, qid, `Quote ${quote_no} created`);
    return qid;
  });
  res.status(201).json({ id });
});

/**
 * Editing rules: a version that has never been sent is edited in place; once sent it is immutable, so any
 * change creates version N+1, returns the quote to draft and revokes the client link (a stale link can never accept new terms).
 */
quotesRouter.put('/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(QuoteIn, req.body), t = T(req), id = idParam(req), q = await findScoped(t, req, 'quotes', id);
  assertCanEdit(req, q);
  if (['accepted', 'converted'].includes(q.status)) throw new HttpError(409, `A ${q.status} quote cannot be edited — create a new quote`);
  await assertQuoteRefs(t, b, req);
  const { components, inclusions, exclusions, payment_terms, cancellation_terms, internal_notes, ...head } = b;
  const cur = await loadVersion(t, id, q.current_version);
  const nextVersion = cur.sent_at ? q.current_version + 1 : q.current_version;
  await t.tx(async (tx) => {
    if (!cur.sent_at) await tx.query('DELETE FROM quote_components WHERE agency_id = ? AND quote_id = ? AND version = ?', [tx.agencyId, id, nextVersion]);
    await insertComponents(tx, id, nextVersion, components);
    const margin_pct = lowestMargin(summarise(await tx.query('SELECT * FROM quote_components WHERE agency_id = ? AND quote_id = ? AND version = ?', [tx.agencyId, id, nextVersion])));
    const vdata = { inclusions, exclusions, payment_terms, cancellation_terms, internal_notes, margin_pct };
    if (cur.sent_at) {
      await tx.insert('quote_versions', { quote_id: id, version: nextVersion, ...vdata, created_by: req.ctx!.userId });
      await tx.update('quotes', id, { ...head, valid_until: head.valid_until ?? null, current_version: nextVersion, status: 'draft', public_token_hash: null, public_token_expires: null });
      await activity(tx, id, `New version v${nextVersion} created after changes to a sent quote; client link revoked`);
    } else {
      await tx.query('UPDATE quote_versions SET margin_approved_by = NULL, margin_approved_at = NULL WHERE agency_id = ? AND quote_id = ? AND version = ?', [tx.agencyId, id, nextVersion]);
      await tx.update('quote_versions', cur.id, vdata);
      await tx.update('quotes', id, { ...head, valid_until: head.valid_until ?? null });
    }
  });
  res.json({ id, version: nextVersion });
});

// ---- margin guardrail ----
quotesRouter.post('/:id/approve-margin', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req), q = await findScoped(t, req, 'quotes', id), v = await loadVersion(t, id, q.current_version);
  await t.update('quote_versions', v.id, { margin_approved_by: req.ctx!.userId, margin_approved_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  await activity(t, id, `Margin ${v.margin_pct ?? 'n/a'}% approved for v${q.current_version}`);
  res.json({ ok: true });
});

// ---- send: issue a secure, expiring link (shown once) ----
quotesRouter.post('/:id/send', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(z.object({ email: z.boolean().default(false), valid_until: z.string().optional() }), req.body);
  const t = T(req), id = idParam(req), q = await findScoped(t, req, 'quotes', id);
  assertCanEdit(req, q);
  if (['accepted', 'converted'].includes(q.status)) throw new HttpError(409, `Quote is already ${q.status}`);
  const v = await loadVersion(t, id, q.current_version), agency = await t.agency();
  if (v.margin_pct !== null && v.margin_pct < agency.min_margin_pct && !v.margin_approved_by)
    throw new HttpError(409, `Margin ${v.margin_pct}% is below the agency minimum of ${agency.min_margin_pct}%. A finance manager must approve it first.`);
  const valid_until = b.valid_until ?? q.valid_until ?? addDays(today(), 14);
  if (valid_until < today()) throw new HttpError(400, 'Valid-until date is in the past');
  const token = crypto.randomBytes(32).toString('base64url');
  await t.tx(async (tx) => {
    await tx.update('quotes', id, { status: 'sent', valid_until, public_token_hash: sha256(token), public_token_expires: `${addDays(valid_until, 1)} 00:00:00` });
    if (!v.sent_at) await tx.update('quote_versions', v.id, { sent_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    await activity(tx, id, `Quote v${q.current_version} sent (valid until ${valid_until})`);
  });
  const link = `${config.appUrl}/q/${token}`;
  let emailed = false;
  if (b.email && q.client_id) {
    const c = await t.get('clients', q.client_id);
    if (c?.email) { await sendMail(c.email, `Your quote ${q.quote_no}`, `<p>Hi ${c.name},</p><p>Your travel quote <b>${q.title}</b> is ready to review. It is valid until ${valid_until}.</p><p><a href="${link}">View and respond to your quote</a></p>`); emailed = true; }
  }
  res.json({ link, emailed, valid_until, note: 'This link is shown once. Sending again issues a new link and revokes this one.' });
});

// ---- record an acceptance given offline (phone/email) ----
quotesRouter.post('/:id/accept', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(z.object({ option: z.string().optional(), name: z.string().optional() }), req.body);
  const t = T(req), id = idParam(req), q = await findScoped(t, req, 'quotes', id);
  assertCanEdit(req, q);
  await acceptQuote(t, q, b.option, b.name ? `${b.name} (recorded by staff)` : 'Recorded by staff', null);
  res.json({ status: 'accepted' });
});

async function acceptQuote(t: Tenant, q: any, option: string | undefined, name: string | null, ip: string | null) {
  if (q.status !== 'sent') throw new HttpError(409, `Quote is ${q.status}; only a sent quote can be accepted`);
  if (q.valid_until && q.valid_until < today()) throw new HttpError(410, 'This quote has expired');
  const v = await loadVersion(t, q.id, q.current_version);
  const names = v.options.map((o: any) => o.option);
  const chosen = option ?? names[0];
  if (!names.includes(chosen)) throw new HttpError(400, `Choose one of: ${names.join(', ')}`);
  await t.tx(async (tx) => {
    // Conditional update guards against double-accept races
    const r: any = await tx.query(`UPDATE quotes SET status = 'accepted', accepted_version = ?, accepted_option = ?, accepted_at = UTC_TIMESTAMP(), accepted_by_name = ?, accepted_ip = ? WHERE agency_id = ? AND id = ? AND status = 'sent' AND current_version = ?`,
      [q.current_version, chosen, name, ip, tx.agencyId, q.id, q.current_version]);
    if (r.affectedRows !== 1) throw new HttpError(409, 'Quote changed while accepting; please reload');
    await activity(tx, q.id, `Accepted v${q.current_version} — ${chosen} (${name ?? 'client'})`);
    await emit(tx, 'quote.accepted', { quote_id: q.id, quote_no: q.quote_no, client_id: q.client_id, option: chosen, version: q.current_version });
  });
}

// ---- convert accepted quote → booking (exactly once) ----
quotesRouter.post('/:id/convert', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), seen = await findScoped(t, req, 'quotes', id);
  assertCanEdit(req, seen);
  if (!seen.booking_id) await assertWithinLimit(t.agencyId, 'bookings');
  const out = await t.tx(async (tx) => {
    const q: any = (await tx.query('SELECT * FROM quotes WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, id]))[0]; // serialise concurrent conversions
    if (q.booking_id) return { booking_id: q.booking_id, existing: true };
    if (q.status !== 'accepted') throw new HttpError(409, 'Only an accepted quote can be converted');
    if (!q.client_id) throw new HttpError(409, 'Link the quote to a client (convert the lead first) before creating a booking');
    const comps = await tx.query('SELECT * FROM quote_components WHERE agency_id = ? AND quote_id = ? AND version = ? AND option_name = ? ORDER BY sort', [tx.agencyId, id, q.accepted_version, q.accepted_option]);
    const v = await loadVersion(tx, id, q.accepted_version);
    const starts = comps.map((c: any) => c.service_start).filter(Boolean).sort(), ends = comps.map((c: any) => c.service_end ?? c.service_start).filter(Boolean).sort();
    const lead = q.lead_id ? await tx.get('leads', q.lead_id) : null;
    const reference = await nextDocNo(tx, 'bookings', 'reference', 'BK');
    const bid = await tx.insert('bookings', {
      client_id: q.client_id, agent_id: q.owner_id, branch_id: q.branch_id, reference, destination: lead?.destination ?? q.title, travel_start: starts[0] ?? null, travel_end: ends[ends.length - 1] ?? null,
      status: 'confirmed', quote_id: id, currency: q.currency, channel: 'quote', notes: v.inclusions ? `Inclusions: ${v.inclusions}` : null, overhead: 0,
    });
    for (const c of comps) {
      await tx.insert('booking_components', {
        booking_id: bid, product_type: c.product_type, supplier_id: c.supplier_id, description: c.description, service_start: c.service_start, service_end: c.service_end,
        quantity: c.quantity, unit_cost: c.unit_cost, markup_pct: c.markup_pct, discount_pct: c.discount_pct, tax_rate: c.tax_rate, unit_price: c.unit_price,
        net_total: c.net_total, tax_total: c.tax_total, cost_total: c.cost_total, cancellation_terms: v.cancellation_terms, source_quote_component_id: c.id,
        ticketing_status: c.product_type === 'flight' ? 'pending' : 'not_applicable',
      });
    }
    await tx.update('quotes', id, { status: 'converted', booking_id: bid });
    if (q.lead_id) { await tx.update('leads', q.lead_id, { stage: 'won' }); await tx.insert('activities', { entity_type: 'lead', entity_id: q.lead_id, kind: 'system', body: `Won — booking ${reference} created from ${q.quote_no}`, created_by: tx.actor.userId }); }
    await activity(tx, id, `Converted to booking ${reference}`);
    await tx.insert('activities', { entity_type: 'booking', entity_id: bid, kind: 'system', body: `Created from quote ${q.quote_no} v${q.accepted_version} (${q.accepted_option})`, created_by: tx.actor.userId });
    return { booking_id: bid, reference, existing: false };
  });
  if (!out.existing) await safeRecalc(t, out.booking_id);
  res.status(out.existing ? 200 : 201).json(out);
});

// =====================  PUBLIC (token) endpoints — no login, deliberately minimal surface  =====================
const publicLimit = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true });
publicQuotesRouter.use(publicLimit);

async function byToken(token: string) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new HttpError(404, 'Quote not found');
  const [rows]: any = await pool.query(`SELECT * FROM quotes WHERE public_token_hash = ? AND public_token_expires > UTC_TIMESTAMP()`, [sha256(token)]);
  if (!rows.length) throw new HttpError(404, 'This link is invalid or has expired'); // identical for wrong, revoked and expired tokens
  return rows[0];
}
const publicTenant = (q: any, req: Request) => new Tenant(q.agency_id, { userId: null, ip: req.ip });

publicQuotesRouter.get('/:token', async (req, res) => {
  const q = await byToken(req.params.token as string), t = publicTenant(q, req);
  const v = await loadVersion(t, q.id, q.current_version), agency = await t.agency();
  const options = v.options.map((o: any) => ({
    name: o.option, net: o.net, tax: o.tax, total: o.total,
    // client view: selling prices only — no supplier, cost, markup or margin
    items: v.components.filter((c: any) => c.option_name === o.option).map((c: any) => ({ product_type: c.product_type, description: c.description, service_start: c.service_start, service_end: c.service_end, quantity: c.quantity, unit_price: c.unit_price, discount_pct: c.discount_pct, net_total: c.net_total, tax_total: c.tax_total })),
  }));
  const expired = q.status === 'sent' && q.valid_until && q.valid_until < today();
  res.json({ agency: agency.name, tax_label: agency.tax_label, quote_no: q.quote_no, title: q.title, currency: q.currency, valid_until: q.valid_until, version: q.current_version, status: expired ? 'expired' : q.status,
    accepted_option: q.accepted_option, options, inclusions: v.inclusions, exclusions: v.exclusions, payment_terms: v.payment_terms, cancellation_terms: v.cancellation_terms });
});

publicQuotesRouter.post('/:token/accept', async (req, res) => {
  const b = parse(z.object({ option: z.string().optional(), name: z.string().min(2).max(150) }), req.body);
  const q = await byToken(req.params.token as string), t = publicTenant(q, req);
  await acceptQuote(t, q, b.option, b.name, req.ip ?? null);
  res.json({ status: 'accepted' });
});
async function respond(req: Request, res: any, status: 'declined' | 'changes_requested', message: string) {
  const q = await byToken(req.params.token as string), t = publicTenant(q, req);
  if (q.status !== 'sent') throw new HttpError(409, `Quote is ${q.status}`);
  await t.tx(async (tx) => { await tx.update('quotes', q.id, { status, client_message: message.slice(0, 1000) }); await activity(tx, q.id, `Client ${status.replace('_', ' ')}: ${message}`); });
  res.json({ status });
}
publicQuotesRouter.post('/:token/decline', (req, res) => respond(req, res, 'declined', parse(z.object({ reason: z.string().max(1000).default('') }), req.body).reason));
publicQuotesRouter.post('/:token/changes', (req, res) => respond(req, res, 'changes_requested', parse(z.object({ message: z.string().min(1).max(1000) }), req.body).message));

