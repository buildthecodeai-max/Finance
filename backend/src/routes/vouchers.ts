import { Router } from 'express';
import { z } from 'zod';
import { HttpError, WRITERS, requireRole } from '../auth.js';
import { amountInWords, nextDocNo, postVoucher, unpostVoucher } from '../services/accounting.js';
import { today } from '../services/money.js';
import { esc } from '../services/pdf.js';
import { idParam, parse, T } from './util.js';
import { Tenant } from '../db.js';

export const vouchersRouter = Router();
const READERS = requireRole('admin', 'finance_manager', 'viewer');

const CV = z.object({
  voucher_date: z.string().default(() => today()), cash_account_id: z.number().int(), party_account_id: z.number().int(),
  amount: z.number().positive(), mode: z.enum(['cash', 'cheque', 'bank']).default('cash'),
  cheque_no: z.string().nullish(), cheque_date: z.string().nullish(), bank_name: z.string().nullish(),
  ticket_invoice_id: z.number().int().nullish(), narration: z.string().nullish(),
});

async function post(t: Tenant, kind: 'receipt' | 'payment', cv: any, date: string) {
  // receipt: money in (Dr cash/bank, Cr party). payment: money out (Dr party, Cr cash/bank).
  const [dr, cr] = kind === 'receipt' ? [cv.cash_account_id, cv.party_account_id] : [cv.party_account_id, cv.cash_account_id];
  const id = await postVoucher(t, {
    type: kind, date, narration: cv.narration ?? `${kind === 'receipt' ? 'Receipt' : 'Payment'} ${cv.voucher_no}${cv.cheque_no ? ` / Chq ${cv.cheque_no}` : ''}`,
    ref_table: 'cash_vouchers', ref_id: cv.id,
    legs: [{ account_id: dr, debit: cv.amount }, { account_id: cr, credit: cv.amount }],
  });
  await t.update('cash_vouchers', cv.id, { voucher_id: id });
  return id;
}

const base = (kind: 'receipt' | 'payment') => {
  const prefix = kind === 'receipt' ? 'RC' : 'PY';

  // scope=today | all | pending (uncleared cheques)
  vouchersRouter.get(`/${kind}s`, READERS, async (req, res) => {
    const t = T(req), scope = String(req.query.scope ?? 'all');
    res.json(await t.query(
      `SELECT c.*, cash.name cash_name, p.name party_name, p.code party_code FROM cash_vouchers c
       JOIN accounts cash ON cash.id = c.cash_account_id AND cash.agency_id = c.agency_id JOIN accounts p ON p.id = c.party_account_id AND p.agency_id = c.agency_id
       WHERE c.agency_id = ? AND c.kind = ? ${scope === 'today' ? 'AND c.voucher_date = CURDATE()' : ''} ${scope === 'pending' ? "AND c.mode = 'cheque' AND c.cleared = 0" : ''}
       ORDER BY c.voucher_date DESC, c.id DESC LIMIT 500`, [t.agencyId, kind]));
  });

  vouchersRouter.post(`/${kind}s`, requireRole(...WRITERS), async (req, res) => {
    const b = parse(CV, req.body); const t = T(req);
    if (b.mode === 'cheque' && !b.cheque_no) throw new HttpError(400, 'Cheque number required');
    await t.ref('accounts', b.cash_account_id, 'cash account'); await t.ref('accounts', b.party_account_id, 'party account'); await t.ref('ticket_invoices', b.ticket_invoice_id, 'invoice');
    const id = await t.tx(async (tx) => {
      const voucher_no = await nextDocNo(tx, 'cash_vouchers', 'voucher_no', prefix, 'kind = ?', [kind]);
      // Received cheques stay pending until cleared; everything else posts immediately.
      const deferred = kind === 'receipt' && b.mode === 'cheque';
      const cvId = await tx.insert('cash_vouchers', { ...b, kind, voucher_no, created_by: req.ctx!.userId, cleared: deferred ? 0 : 1, cleared_date: deferred ? null : b.voucher_date });
      if (!deferred) await post(tx, kind, { ...b, id: cvId, voucher_no }, b.voucher_date);
      return cvId;
    });
    res.status(201).json({ id });
  });
};
base('receipt'); base('payment');

// "Clear Checks": post a pending received cheque when it clears the bank.
vouchersRouter.post('/receipts/:id/clear', requireRole(...WRITERS), async (req, res) => {
  const { date } = parse(z.object({ date: z.string().default(() => today()) }), req.body);
  const t = T(req), id = idParam(req);
  const cv = await t.get('cash_vouchers', id);
  if (!cv || cv.kind !== 'receipt') throw new HttpError(404, 'Receipt not found');
  if (cv.cleared) throw new HttpError(409, 'Already cleared');
  await t.tx(async (tx) => { await post(tx, 'receipt', cv, date); await tx.update('cash_vouchers', id, { cleared: 1, cleared_date: date }); });
  res.json({ ok: true });
});

vouchersRouter.delete('/:id', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req);
  const cv = await t.get('cash_vouchers', id);
  if (!cv) throw new HttpError(404, 'Not found');
  await t.tx(async (tx) => { await unpostVoucher(tx, cv.voucher_id); await tx.remove('cash_vouchers', id); });
  res.json({ ok: true });
});

// ---- Cheque formats & printing (all measurements in cm) ----
export const chequeRouter = Router();
chequeRouter.use(READERS);
const CF = z.object({
  bank_name: z.string().min(1), bank_code: z.string().nullish(), font_name: z.string().nullish(),
  width: z.number().nullish(), length: z.number().nullish(), top_print: z.boolean().default(true), date_format: z.string().nullish(),
}).and(z.record(z.string(), z.any()));
const NUMERIC = ['date_font_size', 'date_width', 'date_spacing', 'date_top', 'date_left', 'amount_width', 'amount_font_size', 'amount_top', 'amount_left',
  'party_width', 'party_font_size', 'party_top', 'party_left', 'words_width', 'words_font_size', 'words_top', 'words_left'];
const clean = (b: any) => {
  const o: Record<string, any> = { bank_name: b.bank_name, bank_code: b.bank_code ?? null, font_name: b.font_name ?? null, width: b.width ?? null, length: b.length ?? null, top_print: b.top_print ? 1 : 0, date_format: b.date_format ?? null };
  for (const k of NUMERIC) if (b[k] !== undefined && b[k] !== null && b[k] !== '') o[k] = Number(b[k]);
  return o;
};

chequeRouter.get('/', async (req, res) => res.json(await T(req).query('SELECT * FROM cheque_formats WHERE agency_id = ? ORDER BY bank_name', [T(req).agencyId])));
chequeRouter.post('/', requireRole(...WRITERS), async (req, res) => res.status(201).json({ id: await T(req).insert('cheque_formats', clean(parse(CF, req.body))) }));
chequeRouter.put('/:id', requireRole(...WRITERS), async (req, res) => { await T(req).update('cheque_formats', idParam(req), clean(parse(CF, req.body))); res.json({ ok: true }); });

function chequeHtml(f: any, d: { date: string; party: string; amount: number }) {
  const fmtDate = (s: string) => {
    const [y, m, day] = s.split('-'); const sep = f.date_spacing > 0 ? ' '.repeat(Math.round(f.date_spacing)) : '';
    const fm = (f.date_format ?? 'DDMMYYYY').toUpperCase();
    const out = fm.replace('DD', day).replace('MM', m).replace('YYYY', y).replace('YY', y.slice(2)).replace(/[^0-9A-Z]/g, '');
    return f.date_spacing > 0 ? out.split('').join(sep) : out;
  };
  const box = (p: string, text: string) =>
    `<div style="position:absolute;left:${f[p + '_left']}cm;top:${f[p + '_top']}cm;width:${f[p + '_width']}cm;font-size:${f[p + '_font_size'] ?? f.date_font_size}pt;white-space:nowrap;overflow:hidden">${esc(text)}</div>`;
  return `<html><head><style>@page{size:${f.width ?? 17.5}cm ${f.length ?? 8}cm;margin:0}body{margin:0;font-family:${esc(f.font_name || 'Arial')},sans-serif}
  .sheet{position:relative;width:${f.width ?? 17.5}cm;height:${f.length ?? 8}cm;outline:1px dashed #bbb}@media print{.sheet{outline:none}}</style></head>
  <body><div class="sheet">${box('date', fmtDate(d.date))}${box('amount', d.amount.toFixed(2))}${box('party', d.party)}${box('words', amountInWords(d.amount))}</div></body></html>`;
}

// Preview with sample or supplied values (frontend opens returned HTML in a print window)
chequeRouter.get('/:id/preview', async (req, res) => {
  const f = await T(req).get('cheque_formats', idParam(req));
  if (!f) throw new HttpError(404, 'Not found');
  res.json({ html: chequeHtml(f, { date: String(req.query.date ?? today()), party: String(req.query.party ?? 'SAMPLE PARTY NAME'), amount: Number(req.query.amount ?? 12345.5) }) });
});

// Print an issued payment on a chosen cheque format
chequeRouter.get('/print/:paymentId', async (req, res) => {
  const t = T(req);
  const pv = await t.one(`SELECT c.*, p.name party_name FROM cash_vouchers c JOIN accounts p ON p.id = c.party_account_id AND p.agency_id = c.agency_id WHERE c.agency_id = ? AND c.id = ? AND c.kind = 'payment'`, [t.agencyId, Number(req.params.paymentId)]);
  const f = await t.get('cheque_formats', Number(req.query.format_id));
  if (!pv || !f) throw new HttpError(404, 'Payment or cheque format not found');
  res.json({ html: chequeHtml(f, { date: String(pv.cheque_date ?? pv.voucher_date), party: pv.party_name, amount: pv.amount }) });
});
