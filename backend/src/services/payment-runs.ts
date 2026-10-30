import { createHash } from 'node:crypto';
import { HttpError } from '../errors.js';
import { Tenant } from '../db.js';
import { decrypt } from '../crypto.js';
import { esc } from './pdf.js';
import { assertSecondApprover } from './accounting.js';
import { payBillIn } from './finance.js';
import { BankFormat, FORMAT_CURRENCY, PayeeRow, buildBankFile, payeeProblems } from './bank-files.js';
import { fmt, r2, today } from './money.js';

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const PAYABLE = ['approved', 'partially_paid'];
const PRE_EXPORT = ['draft', 'validated', 'submitted', 'approved'];
const SETTLEABLE = ['exported', 'processing', 'partially_paid'];
export type Problem = { item_id?: number; message: string };

const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };

async function lockRun(tx: Tenant, id: number) {
  const run = (await tx.query('SELECT * FROM payment_runs WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, id]))[0];
  if (!run || run.kind !== 'bills') throw new HttpError(404, 'Payment run not found');
  return run;
}
const pendingItems = (tx: Tenant, runId: number) =>
  tx.query(`SELECT i.*, b.bill_no, b.status bill_status, b.total bill_total, b.amount_paid, b.currency bill_currency, b.fx_rate bill_fx, s.name supplier_name, s.bank_details_enc
    FROM payment_run_items i JOIN supplier_bills b ON b.id = i.bill_id AND b.agency_id = i.agency_id JOIN suppliers s ON s.id = i.supplier_id AND s.agency_id = i.agency_id
    WHERE i.agency_id = ? AND i.run_id = ? AND i.status = 'pending' ORDER BY i.id`, [tx.agencyId, runId]);
const readBank = (enc: string | null): Record<string, any> | null => { if (!enc) return null; try { return JSON.parse(decrypt(enc)); } catch { return null; } };
const formatFor = (cur: string): BankFormat | null => (Object.keys(FORMAT_CURRENCY) as BankFormat[]).find((f) => FORMAT_CURRENCY[f] === cur) ?? null;

/** Everything that must still be true for money to move. Re-run at validate, submit, approve and export. Locks the bills. */
async function check(tx: Tenant, run: any): Promise<{ items: any[]; problems: Problem[] }> {
  const items = await pendingItems(tx, run.id), problems: Problem[] = [];
  if (!items.length) problems.push({ message: 'The run has no payable items' });
  const acct = await tx.one('SELECT type_code FROM accounts WHERE agency_id = ? AND id = ?', [tx.agencyId, run.bank_account_id]);
  if (!acct || acct.type_code !== 110) problems.push({ message: 'The paying bank account is missing or is not a cash/bank account' });
  const fmtKey = formatFor(run.currency);
  if (items.length) await tx.query(`SELECT id FROM supplier_bills WHERE agency_id = ? AND id IN (${items.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, [tx.agencyId, ...items.map((i: any) => i.bill_id)]);
  for (const i of await pendingItems(tx, run.id)) {
    const out = r2(i.bill_total - i.amount_paid), tag = `${i.bill_no} (${i.supplier_name})`;
    if (!PAYABLE.includes(i.bill_status)) problems.push({ item_id: i.id, message: `${tag} is ${i.bill_status}, not payable` });
    else if (i.amount > out + 0.005) problems.push({ item_id: i.id, message: `${tag}: run pays ${i.amount} but only ${out} is outstanding` });
    if (i.bill_currency !== run.currency) problems.push({ item_id: i.id, message: `${tag} is in ${i.bill_currency}, run is ${run.currency}` });
    const bd = readBank(i.bank_details_enc);
    if (!bd) problems.push({ item_id: i.id, message: `${i.supplier_name} has no usable bank details` });
    else if (fmtKey) for (const m of payeeProblems(fmtKey, { name: i.supplier_name, amount: i.amount, reference: null, bd })) problems.push({ item_id: i.id, message: `${i.supplier_name}: ${m}` });
    else if (!bd.account_number && !bd.iban) problems.push({ item_id: i.id, message: `${i.supplier_name} has no account number or IBAN` });
  }
  return { items, problems };
}
const recomputeTotal = async (tx: Tenant, runId: number) => {
  const r = await tx.one(`SELECT COALESCE(SUM(amount),0) s FROM payment_run_items WHERE agency_id = ? AND run_id = ? AND status <> 'removed'`, [tx.agencyId, runId]);
  await tx.update('payment_runs', runId, { total: r2(r!.s) });
};

export async function createRun(t: Tenant, input: { run_date: string; currency: string; bank_account_id: number; notes?: string | null; items: { bill_id: number; amount?: number }[] }) {
  const ids = input.items.map((i) => i.bill_id);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'A bill can appear only once in a run');
  return t.tx(async (tx) => {
    const cash = await tx.get('accounts', input.bank_account_id);
    if (!cash || cash.type_code !== 110) { await tx.ref('accounts', input.bank_account_id, 'bank account'); throw new HttpError(400, 'Pay from a cash/bank account'); }
    for (const id of ids) await tx.ref('supplier_bills', id, 'bill');
    const bills = await tx.query(`SELECT * FROM supplier_bills WHERE agency_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, [tx.agencyId, ...ids]);
    const lines: { b: any; amount: number }[] = [];
    for (const b of bills) {
      const want = input.items.find((i) => i.bill_id === b.id)!, out = r2(b.total - b.amount_paid), amount = want.amount ?? out;
      if (!PAYABLE.includes(b.status)) throw new HttpError(409, `${b.bill_no} is ${b.status}; only approved bills can go into a payment run`);
      if (b.currency !== input.currency) throw new HttpError(409, `${b.bill_no} is in ${b.currency}; this run is ${input.currency}`);
      if (!(amount > 0) || amount > out + 0.005) throw new HttpError(400, `${b.bill_no}: amount must be between 0 and the outstanding ${out}`);
      const open = await tx.one(`SELECT run_id FROM payment_run_items WHERE agency_id = ? AND bill_id = ? AND status = 'pending' LIMIT 1 LOCK IN SHARE MODE`, [tx.agencyId, b.id]);   // locking read: a snapshot read would miss a run committed while we waited on the bill lock
      if (open) throw new HttpError(409, `${b.bill_no} is already in payment run #${open.run_id}`);
      lines.push({ b, amount: r2(amount) });
    }
    const runId = await tx.insert('payment_runs', { kind: 'bills', status: 'draft', run_date: input.run_date, currency: input.currency, bank_account_id: input.bank_account_id,
      notes: input.notes ?? null, total: r2(lines.reduce((s, l) => s + l.amount, 0)), created_by: tx.actor.userId });
    for (const l of lines) await tx.insert('payment_run_items', { run_id: runId, bill_id: l.b.id, supplier_id: l.b.supplier_id, amount: l.amount, status: 'pending' });
    return runId;
  });
}

export async function removeItem(t: Tenant, runId: number, itemId: number) {
  return t.tx(async (tx) => {
    const run = await lockRun(tx, runId);
    if (!['draft', 'validated'].includes(run.status)) throw new HttpError(409, `Items can only be removed while the run is draft or validated (it is ${run.status})`);
    const it = await tx.one(`SELECT * FROM payment_run_items WHERE agency_id = ? AND run_id = ? AND id = ? AND status = 'pending'`, [tx.agencyId, runId, itemId]);
    if (!it) throw new HttpError(404, 'Item not found');
    await tx.update('payment_run_items', itemId, { status: 'removed' });
    await recomputeTotal(tx, runId);
    await tx.update('payment_runs', runId, { status: 'draft', validated_at: null, validation_json: null });
    return { status: 'draft' };
  });
}

export async function validateRun(t: Tenant, id: number) {
  return t.tx(async (tx) => {
    const run = await lockRun(tx, id);
    if (!['draft', 'validated'].includes(run.status)) throw new HttpError(409, `Run is ${run.status}; only draft runs can be validated`);
    const { problems } = await check(tx, run), ok = problems.length === 0;
    await tx.update('payment_runs', id, { status: ok ? 'validated' : 'draft', validated_at: ok ? nowSql() : null, validation_json: JSON.stringify({ ok, problems, at: nowSql() }) });
    return { ok, status: ok ? 'validated' : 'draft', problems };
  });
}

export async function submitRun(t: Tenant, id: number) {
  return t.tx(async (tx) => {
    const run = await lockRun(tx, id);
    if (run.status !== 'validated') throw new HttpError(409, `Run is ${run.status}; validate it before submitting`);
    const { problems } = await check(tx, run);
    if (problems.length) { await tx.update('payment_runs', id, { status: 'draft', validated_at: null, validation_json: JSON.stringify({ ok: false, problems, at: nowSql() }) }); return { ok: false, status: 'draft', problems }; }
    await tx.update('payment_runs', id, { status: 'submitted', submitted_by: tx.actor.userId, submitted_at: nowSql() });
    return { ok: true, status: 'submitted', problems: [] };
  });
}

export async function approveRun(t: Tenant, id: number) {
  return t.tx(async (tx) => {
    const run = await lockRun(tx, id), me = tx.actor.userId!, agency = await tx.agency();
    if (run.status !== 'submitted') throw new HttpError(409, `Run is ${run.status}; only submitted runs can be approved`);
    if (agency.dual_control_runs && (run.created_by === me || run.submitted_by === me)) throw new HttpError(403, 'Payment runs must be approved by someone who did not create or submit them');
    const { items, problems } = await check(tx, run);
    if (problems.length) throw Object.assign(new HttpError(409, `Run can no longer be approved: ${problems[0].message}`), { problems });
    const base = r2(items.reduce((s: number, i: any) => s + i.amount * i.bill_fx, 0));
    await assertSecondApprover(tx, base, run.submitted_by ?? run.created_by, me, 'A payment run');
    await tx.update('payment_runs', id, { status: 'approved', approved_by: me, approved_at: nowSql() });
    return { status: 'approved', base_total: base };
  });
}

/** Send a submitted/approved run back to draft (reviewer rejection or maker recall). The reason is audited. */
export async function returnToDraft(t: Tenant, id: number, reason: string) {
  return t.tx(async (tx) => {
    const run = await lockRun(tx, id);
    if (!['validated', 'submitted', 'approved'].includes(run.status)) throw new HttpError(409, `Run is ${run.status}; nothing to return`);
    await tx.update('payment_runs', id, { status: 'draft', validated_at: null, submitted_by: null, submitted_at: null, approved_by: null, approved_at: null });
    await tx.event('update', 'payment_runs', id, { status: run.status }, { status: 'draft' }, reason);
    return { status: 'draft' };
  });
}

/** Cancel before anything has been sent to the bank. After export the only way out is to settle items as failed. */
export async function cancelRun(t: Tenant, id: number, reason: string) {
  return t.tx(async (tx) => {
    const run = await lockRun(tx, id);
    if (!PRE_EXPORT.includes(run.status)) throw new HttpError(409, `Run is ${run.status}; once exported it can only be closed by settling its items (mark them failed if the bank did not pay)`);
    await tx.query(`UPDATE payment_run_items SET status = 'removed' WHERE agency_id = ? AND run_id = ? AND status = 'pending'`, [tx.agencyId, id]);
    await tx.update('payment_runs', id, { status: 'cancelled', cancelled_reason: reason });
    await tx.event('update', 'payment_runs', id, { status: run.status }, { status: 'cancelled' }, reason);
    return { status: 'cancelled' };
  });
}

export async function exportRun(t: Tenant, id: number, format: BankFormat | 'csv') {
  return t.tx(async (tx) => {
    const run = await lockRun(tx, id);
    if (run.status !== 'approved' && !SETTLEABLE.includes(run.status)) throw new HttpError(409, `Run is ${run.status}; only approved runs can be exported`);
    if (format !== 'csv' && FORMAT_CURRENCY[format] !== run.currency) throw new HttpError(409, `${format.toUpperCase()} files are ${FORMAT_CURRENCY[format]} only; this run is ${run.currency}. Use csv.`);
    const { items, problems } = await check(tx, run);
    if (problems.length) throw Object.assign(new HttpError(409, `Cannot export: ${problems[0].message}`), { problems });
    const by = new Map<number, PayeeRow & { id: number }>();
    for (const i of items) {
      const cur = by.get(i.supplier_id);
      if (cur) cur.amount = r2(cur.amount + i.amount);
      else by.set(i.supplier_id, { id: i.supplier_id, name: i.supplier_name, amount: i.amount, reference: `RUN-${id}`, bd: readBank(i.bank_details_enc)! });
    }
    const payees = [...by.values()], agency = await tx.agency();
    let body: string, ext: string;
    if (format === 'csv') {
      ext = 'csv';
      body = ['supplier,account_number,bsb,routing,iban,swift,amount,currency,reference', ...payees.map((p) => [p.name, p.bd.account_number, p.bd.bsb, p.bd.routing, p.bd.iban, p.bd.swift, p.amount.toFixed(2), run.currency, p.reference].map(csvCell).join(','))].join('\r\n');
    } else ({ body, ext } = buildBankFile(format, agency.name, payees, String(run.run_date).slice(0, 10)));
    const checksum = createHash('sha256').update(body).digest('hex');
    if (run.status === 'approved') await tx.update('payment_runs', id, { status: 'exported', exported_by: tx.actor.userId, exported_at: nowSql(), export_format: format, export_checksum: checksum });
    else await tx.event('update', 'payment_runs', id, { export_checksum: run.export_checksum }, { re_exported: true, format, checksum });
    return { body, filename: `payment-run-${id}.${ext}`, checksum };
  });
}

/** The bank has acknowledged the file; still nothing is paid until items are settled. */
export async function markProcessing(t: Tenant, id: number) {
  return t.tx(async (tx) => {
    const run = await lockRun(tx, id);
    if (run.status !== 'exported') throw new HttpError(409, `Run is ${run.status}; only exported runs can move to processing`);
    await tx.update('payment_runs', id, { status: 'processing' });
    return { status: 'processing' };
  });
}

export interface Settlement { item_id: number; outcome: 'paid' | 'failed'; date?: string; settlement_ref?: string; manual_reason?: string; failure_reason?: string; fx_rate?: number }

/**
 * Record what the bank actually did. Only here does money hit the ledger (via payBill). Paid needs evidence —
 * a bank reference — or an explicit manual-confirmation reason; failed items stay payable on their bills.
 */
export async function settleRun(t: Tenant, id: number, results: Settlement[]) {
  return t.tx(async (tx) => {
    const run = await lockRun(tx, id);
    if (!SETTLEABLE.includes(run.status)) throw new HttpError(409, run.status === 'approved' ? 'Export the file first; a run is never paid just because it was approved' : `Run is ${run.status}; it cannot be settled`);
    if (new Set(results.map((r) => r.item_id)).size !== results.length) throw new HttpError(400, 'An item can be settled only once per request');
    const items = await tx.query(`SELECT * FROM payment_run_items WHERE agency_id = ? AND run_id = ? ORDER BY bill_id FOR UPDATE`, [tx.agencyId, id]);
    const byId = new Map(items.map((i: any) => [i.id, i]));
    for (const r of [...results].sort((a, b) => (byId.get(a.item_id)?.bill_id ?? 0) - (byId.get(b.item_id)?.bill_id ?? 0))) {
      const it = byId.get(r.item_id);
      if (!it) throw new HttpError(400, `Item ${r.item_id} is not part of this run`);
      if (it.status !== 'pending') throw new HttpError(409, `Item ${r.item_id} is already ${it.status}`);
      if (r.outcome === 'failed') {
        if (!r.failure_reason || r.failure_reason.trim().length < 3) throw new HttpError(400, 'A failed item needs a failure reason');
        await tx.update('payment_run_items', it.id, { status: 'failed', failure_reason: r.failure_reason.trim(), settled_date: r.date ?? today() });
        continue;
      }
      const ref = r.settlement_ref?.trim(), why = r.manual_reason?.trim();
      if (!ref && !(why && why.length >= 10)) throw new HttpError(400, 'Confirming a payment needs the bank reference, or a manual-confirmation reason (10+ characters)');
      const date = r.date ?? today();
      await payBillIn(tx, it.bill_id, { cash_account_id: run.bank_account_id, amount: it.amount, date, reference: `RUN-${id}${ref ? ` ${ref}` : ''}`, fx_rate: r.fx_rate, run_id: id });
      await tx.update('payment_run_items', it.id, { status: 'paid', settlement_ref: ref ?? null, manual_reason: ref ? null : why!, settled_date: date });
    }
    const all = await tx.query(`SELECT status, COUNT(*) n FROM payment_run_items WHERE agency_id = ? AND run_id = ? AND status <> 'removed' GROUP BY status`, [tx.agencyId, id]);
    const n = (s: string) => all.find((x: any) => x.status === s)?.n ?? 0;
    const status = n('pending') > 0 ? (n('paid') + n('failed') > 0 ? 'partially_paid' : run.status) : n('failed') === 0 ? 'paid' : n('paid') === 0 ? 'failed' : 'partially_paid';
    await tx.update('payment_runs', id, { status, ...(n('pending') === 0 ? { settled_at: nowSql() } : {}) });
    return { status, paid: n('paid'), failed: n('failed'), pending: n('pending') };
  });
}

export async function listRuns(t: Tenant) {
  return t.query(`SELECT r.id, r.run_date, r.currency, r.status, r.total, r.notes, r.export_format, u.name created_by_name,
    (SELECT COUNT(*) FROM payment_run_items i WHERE i.agency_id = r.agency_id AND i.run_id = r.id AND i.status <> 'removed') items
    FROM payment_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.agency_id = ? AND r.kind = 'bills' ORDER BY r.id DESC LIMIT 200`, [t.agencyId]);
}

export async function runDetail(t: Tenant, id: number) {
  const run = await t.one(`SELECT r.*, cu.name created_by_name, su.name submitted_by_name, au.name approved_by_name, eu.name exported_by_name, a.name bank_account_name
    FROM payment_runs r LEFT JOIN users cu ON cu.id = r.created_by LEFT JOIN users su ON su.id = r.submitted_by LEFT JOIN users au ON au.id = r.approved_by LEFT JOIN users eu ON eu.id = r.exported_by
    LEFT JOIN accounts a ON a.id = r.bank_account_id AND a.agency_id = r.agency_id WHERE r.agency_id = ? AND r.id = ? AND r.kind = 'bills'`, [t.agencyId, id]);
  if (!run) throw new HttpError(404, 'Payment run not found');
  const items = await t.query(`SELECT i.id, i.bill_id, i.supplier_id, i.amount, i.status, i.settlement_ref, i.manual_reason, i.settled_date, i.failure_reason, b.bill_no, b.supplier_ref, b.due_date, b.status bill_status, s.name supplier_name, (s.bank_details_enc IS NOT NULL) has_bank
    FROM payment_run_items i JOIN supplier_bills b ON b.id = i.bill_id AND b.agency_id = i.agency_id JOIN suppliers s ON s.id = i.supplier_id AND s.agency_id = i.agency_id
    WHERE i.agency_id = ? AND i.run_id = ? AND i.status <> 'removed' ORDER BY i.id`, [t.agencyId, id]);
  return { run: { ...run, validation: typeof run.validation_json === 'string' ? JSON.parse(run.validation_json) : run.validation_json, validation_json: undefined }, items };
}

/** One remittance page per supplier, listing only the bills the bank actually paid. */
export async function remittanceHtml(t: Tenant, id: number) {
  const { run, items } = await runDetail(t, id), agency = await t.agency();
  const paid = items.filter((i: any) => i.status === 'paid');
  if (!paid.length) throw new HttpError(409, 'Nothing has been paid in this run yet');
  const by = new Map<number, any[]>();
  for (const i of paid) by.set(i.supplier_id, [...(by.get(i.supplier_id) ?? []), i]);
  const pages = [...by.values()].map((rows) => `<div style="page-break-after:always"><h2 style="color:#00A586">Remittance Advice</h2>
    <p><b>${esc(agency.name)}</b> → <b>${esc(rows[0].supplier_name)}</b></p><p>Payment run #${run.id}</p>
    <table style="width:100%;border-collapse:collapse"><tr style="text-align:left"><th>Your invoice</th><th>Our ref</th><th>Paid on</th><th style="text-align:right">Amount</th></tr>
    ${rows.map((r) => `<tr><td>${esc(r.supplier_ref)}</td><td>${esc(r.bill_no)}</td><td>${esc(String(r.settled_date).slice(0, 10))}</td><td style="text-align:right">${esc(fmt(r.amount, run.currency))}</td></tr>`).join('')}</table>
    <h3 style="text-align:right">Total ${esc(fmt(r2(rows.reduce((s, r) => s + r.amount, 0)), run.currency))}</h3></div>`);
  return `<html><body style="font-family:Inter,Arial;font-size:12px">${pages.join('')}</body></html>`;
}
