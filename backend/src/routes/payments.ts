import { Router } from 'express';
import { z } from 'zod';
import { HttpError, WRITERS, requireRole } from '../auth.js';
import { decrypt } from '../crypto.js';
import { fileKey, putFile, signedUrl } from '../storage.js';
import { htmlToPdf, esc, css, letterheadHtml } from '../services/pdf.js';
import { agencyLogoData } from '../services/vouchers.js';
import { syncInvoicePaid } from '../services/invoicing.js';
import { createReceipt } from '../services/finance.js';
import { ensureSys } from '../services/accounting.js';
import { getRate } from '../services/fx.js';
import { fmt, r2, today } from '../services/money.js';
import { idParam, parse, T } from './util.js';

export const paymentsRouter = Router();

paymentsRouter.get('/', async (req, res) => {
  const t = T(req);
  const dir = req.query.direction === 'outbound' ? 'outbound' : req.query.direction === 'inbound' ? 'inbound' : null;
  res.json(await t.query(
    `SELECT p.*, c.name client_name, s.name supplier_name, i.number invoice_number FROM payments p
     LEFT JOIN clients c ON c.id = p.client_id AND c.agency_id = p.agency_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.agency_id = p.agency_id
     LEFT JOIN invoices i ON i.id = p.invoice_id AND i.agency_id = p.agency_id
     WHERE p.agency_id = ? ${dir ? 'AND p.direction = ?' : ''} ORDER BY p.paid_at DESC, p.id DESC LIMIT 500`,
    dir ? [t.agencyId, dir] : [t.agencyId]));
});

// Inbound client payment against one invoice — a convenience wrapper over the receipt service (posts to the ledger).
paymentsRouter.post('/inbound', requireRole(...WRITERS), async (req, res) => {
  const b = parse(z.object({
    invoice_id: z.number().int(), amount: z.number().positive(),
    method: z.enum(['bank_transfer', 'stripe', 'direct_debit', 'cash']), paid_at: z.string().default(() => today()),
    reference: z.string().optional(),
  }), req.body);
  const t = T(req);
  const inv = await t.get('invoices', b.invoice_id);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (['draft', 'reviewed', 'void'].includes(inv.status)) throw new HttpError(409, 'Invoice has not been sent');
  if (!inv.voucher_id) throw new HttpError(409, 'This invoice is not in the ledger yet — run Finance → "Post existing invoices" first');
  const cash = await ensureSys(t, b.method === 'cash' ? 'cash' : 'bank');
  const idem = String(req.headers['idempotency-key'] ?? '').slice(0, 80) || null;
  const r = await createReceipt(t, { client_id: inv.client_id, cash_account_id: cash, amount: b.amount, currency: inv.currency, fx_rate: inv.fx_rate, receipt_date: b.paid_at, method: b.method, reference: b.reference ?? null,
    allocations: [{ invoice_id: inv.id, amount: b.amount }], idem_key: idem });
  const pay = await t.one('SELECT id FROM payments WHERE agency_id = ? AND receipt_id = ? LIMIT 1', [t.agencyId, r.receipt.id]);
  res.status(r.replay ? 200 : 201).json({ id: pay?.id, receipt_id: r.receipt.id, ...(await syncInvoicePaid(t, inv.id)) });
});

// ---- Supplier payment runs ----
paymentsRouter.get('/runs', async (req, res) => {
  const t = T(req);
  res.json(await t.query("SELECT * FROM payment_runs WHERE agency_id = ? AND kind = 'legacy' ORDER BY id DESC", [t.agencyId]));
});

paymentsRouter.get('/runs/:id', async (req, res) => {
  const t = T(req), id = idParam(req);
  const run = await t.get('payment_runs', id);
  if (!run) throw new HttpError(404, 'Not found');
  const items = await t.query(
    `SELECT p.*, s.name supplier_name FROM payments p JOIN suppliers s ON s.id = p.supplier_id AND s.agency_id = p.agency_id WHERE p.agency_id = ? AND p.run_id = ?`, [t.agencyId, id]);
  res.json({ run, items });
});

// Superseded: this created outbound payments with no bill, no approval and no ledger posting. Use /finance/payment-runs.
paymentsRouter.post('/runs', requireRole(...WRITERS), async () => { throw new HttpError(409, 'Supplier payment runs now start from approved bills: use Finance → Payment runs'); });

paymentsRouter.post('/runs/:id/approve', requireRole('admin', 'finance_manager'), async (req, res) => {
  const t = T(req), id = idParam(req);
  const run = await t.get('payment_runs', id);
  if (!run || run.kind !== 'legacy') throw new HttpError(404, 'Not found');
  if (run.status !== 'draft') throw new HttpError(409, 'Run not in draft');
  await t.update('payment_runs', id, { status: 'approved' });
  res.json({ status: 'approved' });
});

// One PDF containing a remittance advice page per supplier; stored in R2.
paymentsRouter.post('/runs/:id/remittance', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req);
  const run = await t.get('payment_runs', id);
  if (!run || run.kind !== 'legacy') throw new HttpError(404, 'Not found');
  const agency = await t.agency();
  const items = await t.query(
    `SELECT p.*, s.name supplier_name FROM payments p JOIN suppliers s ON s.id = p.supplier_id AND s.agency_id = p.agency_id WHERE p.agency_id = ? AND p.run_id = ?`, [t.agencyId, id]);
  const head = letterheadHtml(agency, await agencyLogoData(agency));
  const html = `<html><head><meta charset="utf-8"><style>${css}</style></head><body style="font-family:Inter,Arial;font-size:12px">${items.map((p: any) => `
    <div style="page-break-after:always"><div style="height:6px;background:#00A586;border-radius:3px;margin-bottom:14px"></div>${head}<h2 style="color:#00A586;margin-top:18px">Remittance Advice</h2>
    <p>To: <b>${esc(p.supplier_name)}</b></p>
    <p>Payment date: ${esc(p.paid_at)}<br>Reference: ${esc(p.reference)}</p>
    <h3>${fmt(p.amount, p.currency)}</h3></div>`).join('')}</body></html>`;
  const key = await putFile(fileKey(t.agencyId, 'remittance', `run-${id}.pdf`), await htmlToPdf(html), 'application/pdf');
  await t.update('payment_runs', id, { remittance_key: key });
  res.json({ url: await signedUrl(t.agencyId, key, `remittance-run-${id}.pdf`) });
});

// Bank file export. Supported: ABA (AU Direct Entry) and ACH (NACHA). BACS not yet implemented.
paymentsRouter.get('/runs/:id/bank-file', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req);
  const format = String(req.query.format ?? 'aba');
  const run = await t.get('payment_runs', id);
  if (!run || run.kind !== 'legacy') throw new HttpError(404, 'Not found');
  if (run.status === 'draft') throw new HttpError(409, 'Approve the run first');
  const agency = await t.agency();
  const rows = await t.query(
    `SELECT p.amount, p.reference, s.name, s.bank_details_enc FROM payments p JOIN suppliers s ON s.id = p.supplier_id AND s.agency_id = p.agency_id WHERE p.agency_id = ? AND p.run_id = ?`, [t.agencyId, id]);
  const items = rows.map((r: any) => {
    if (!r.bank_details_enc) throw new HttpError(400, `${r.name} has no bank details`);
    return { ...r, bd: JSON.parse(decrypt(r.bank_details_enc)) };
  });
  const pad = (s: string, n: number) => String(s).slice(0, n).padEnd(n);
  const lpad = (s: string | number, n: number) => String(s).padStart(n, '0');
  const cents = (n: number) => Math.round(n * 100);
  let body = '', ext = 'txt';

  if (format === 'aba') {
    const d = today().split('-'); const dd = `${d[2]}${d[1]}${d[0].slice(2)}`;
    const lines = [`0${pad('', 17)}01${pad('NAB', 3)}${pad('', 7)}${pad(agency.name, 26)}${lpad('000000', 6)}${pad('PAYMENTS', 12)}${dd}${pad('', 40)}`];
    let sum = 0, total = 0;
    for (const i of items) {
      const bsb = String(i.bd.bsb ?? '').replace('-', '').padStart(6, '0'), bsbF = `${bsb.slice(0, 3)}-${bsb.slice(3)}`;
      sum += Number(bsb); total += cents(i.amount);
      lines.push(`1${bsbF}${pad(i.bd.account_number, 9).padStart(9)}${' '}50${lpad(cents(i.amount), 10)}${pad(i.name, 32)}${pad(i.reference ?? '', 18)}${bsbF}${pad(i.bd.account_number, 9).padStart(9)}${pad(agency.name, 16)}${lpad(0, 8)}`);
    }
    lines.push(`7999-999${pad('', 12)}${lpad(total, 10)}${lpad(total, 10)}${lpad(0, 10)}${pad('', 24)}${lpad(items.length, 6)}${pad('', 40)}`);
    body = lines.join('\r\n'); ext = 'aba';
  } else if (format === 'ach') {
    const rtn = (s: string) => String(s).padStart(9, '0');
    const total = items.reduce((s: number, i: any) => s + cents(i.amount), 0);
    const hash = items.reduce((s: number, i: any) => s + Number(String(i.bd.routing).slice(0, 8)), 0) % 1e10;
    const dt = today().replace(/-/g, '').slice(2);
    const L = [
      `101 000000000 000000000${dt}0000A094101${pad('ODFI', 23)}${pad(agency.name, 23)}${pad('', 8)}`,
      `5200${pad(agency.name, 16)}${pad('', 20)}0000000000PPDPAYMENT   ${dt}${dt}   1000000000000001`,
      ...items.map((i: any, n: number) =>
        `622${rtn(i.bd.routing)}${pad(i.bd.account_number, 17)}${lpad(cents(i.amount), 10)}${pad(String(i.name), 15)}${pad(i.name, 22)}  0000000000${lpad(n + 1, 6)}`),
      `8200${lpad(items.length, 6)}${lpad(hash, 10)}${lpad(0, 12)}${lpad(total, 12)}0000000000${pad('', 25)}000000000000001`,
      `9000001000001${lpad(items.length, 8)}${lpad(hash, 10)}${lpad(0, 12)}${lpad(total, 12)}${pad('', 39)}`,
    ];
    body = L.join('\r\n'); ext = 'ach';
  } else throw new HttpError(400, 'format must be aba or ach');

  await t.update('payment_runs', id, { status: 'exported' });
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="run-${id}.${ext}"`);
  res.send(body);
});
