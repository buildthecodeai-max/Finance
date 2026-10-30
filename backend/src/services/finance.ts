import { HttpError } from '../errors.js';
import { Tenant } from '../db.js';
import { emit } from './webhooks.js';
import { assertSecondApprover, ensureParty, ensureSys, nextDocNo, postVoucher, reverseVoucher } from './accounting.js';
import { getRateInfo } from './fx.js';
import { syncInvoicePaid } from './invoicing.js';
import { r2, today } from './money.js';

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const base = (amount: number, fx: number) => r2(amount * fx);

/* ======================================================================== invoices */

/**
 * Issue = the financial event. Locks the FX rate, freezes a snapshot, and posts:
 *   Dr Client receivable (total)   Cr Booking revenue (net)   Cr Tax payable (tax)
 * Delivery (PDF/email) is separate and can be retried without touching the ledger.
 */
export async function issueInvoice(t: Tenant, invoiceId: number) {
  return t.tx(async (tx) => {
    const inv = (await tx.query('SELECT * FROM invoices WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, invoiceId]))[0];
    if (!inv) throw new HttpError(404, 'Invoice not found');
    if (inv.voucher_id) throw new HttpError(409, 'Invoice is already issued');
    if (inv.status !== 'reviewed') throw new HttpError(409, 'Invoice must be Reviewed before it is issued');
    const agency = await tx.agency();
    const ri = inv.currency === agency.base_currency ? { rate: 1, source: 'base', date: inv.issue_date } : await getRateInfo(tx, inv.currency, agency.base_currency, inv.issue_date);
    const fx = ri.rate;
    const lines = await tx.query('SELECT * FROM invoice_lines WHERE agency_id = ? AND invoice_id = ? ORDER BY id', [tx.agencyId, invoiceId]);
    const installments = await tx.query('SELECT * FROM invoice_installments WHERE agency_id = ? AND invoice_id = ? ORDER BY due_date', [tx.agencyId, invoiceId]);
    const client = await tx.get('clients', inv.client_id);
    const ar = await ensureParty(tx, 'clients', inv.client_id);
    const total = base(inv.total, fx), net = base(inv.subtotal, fx), tax = r2(total - net);
    const vid = await postVoucher(tx, {
      type: 'invoice', date: inv.issue_date, narration: `Invoice ${inv.number} — ${client.name}`, ref_table: 'invoices', ref_id: invoiceId,
      legs: [{ account_id: ar, debit: total }, { account_id: await ensureSys(tx, 'booking_revenue'), credit: net }, ...(tax !== 0 ? [{ account_id: await ensureSys(tx, 'tax_payable'), credit: tax }] : [])],
    });
    const snapshot = { invoice: { ...inv, fx_rate: fx }, lines, installments, client: { name: client.name, email: client.email, address: client.address }, agency: { name: agency.name, address: agency.address, tax_label: agency.tax_label, tax_number: agency.tax_number }, issued_at: nowSql() };
    await tx.update('invoices', invoiceId, { status: 'sent', sent_at: nowSql(), fx_rate: fx, fx_source: ri.source, fx_date: ri.date, voucher_id: vid, snapshot_json: JSON.stringify(snapshot) });
    await emit(tx, 'invoice.issued', { invoice_id: invoiceId, number: inv.number, client_id: inv.client_id, total: inv.total, currency: inv.currency, due_date: inv.due_date });
    return { voucher_id: vid, fx_rate: fx };
  });
}

/** Void an issued invoice by reversal. Only when nothing has been paid or credited — otherwise use a credit note. */
export async function voidInvoice(t: Tenant, invoiceId: number, reason: string, date: string) {
  return t.tx(async (tx) => {
    const inv = (await tx.query('SELECT * FROM invoices WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, invoiceId]))[0];
    if (!inv) throw new HttpError(404, 'Invoice not found');
    if (inv.status === 'void') throw new HttpError(409, 'Invoice is already void');
    if (!inv.voucher_id) { await tx.update('invoices', invoiceId, { status: 'void', voided_at: nowSql(), void_reason: reason }); return { reversal: null }; }
    const used = await tx.one<{ n: number }>(`SELECT (SELECT COUNT(*) FROM payments WHERE agency_id = ? AND invoice_id = ? AND voided = 0) + (SELECT COUNT(*) FROM credit_notes WHERE agency_id = ? AND invoice_id = ? AND status <> 'void') n`, [tx.agencyId, invoiceId, tx.agencyId, invoiceId]);
    if (used!.n > 0) throw new HttpError(409, 'Invoice has payments or credit notes — issue a credit note instead');
    const rid = await reverseVoucher(tx, inv.voucher_id, date, reason);
    await tx.update('invoices', invoiceId, { status: 'void', voided_at: nowSql(), void_reason: reason, void_voucher_id: rid });
    return { reversal: rid };
  });
}

/* ======================================================================== receipts & allocations */

export interface ReceiptIn {
  client_id: number; cash_account_id: number; amount: number; currency?: string; fx_rate?: number; receipt_date?: string;
  method: 'bank_transfer' | 'stripe' | 'direct_debit' | 'cash'; reference?: string | null; narration?: string | null;
  allocations?: { invoice_id: number; amount: number }[]; idem_key?: string | null;
}

async function allocate(tx: Tenant, receipt: any, allocs: { invoice_id: number; amount: number }[]) {
  const seen = new Set<number>(); let used = 0;
  const arAcc = await ensureParty(tx, 'clients', receipt.client_id);
  const fxAcc = await ensureSys(tx, 'fx_gain_loss');
  for (const a of allocs) {
    if (seen.has(a.invoice_id)) throw new HttpError(400, 'Each invoice may appear once per allocation');
    seen.add(a.invoice_id);
    if (!(a.amount > 0)) throw new HttpError(400, 'Allocation amounts must be positive');
    const inv = (await tx.query('SELECT * FROM invoices WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, a.invoice_id]))[0];
    if (!inv || inv.client_id !== receipt.client_id) throw new HttpError(400, 'Unknown invoice for this client');
    if (!inv.voucher_id || ['void', 'draft', 'reviewed'].includes(inv.status)) throw new HttpError(409, `Invoice ${inv.number} is not open for payment`);
    if (inv.currency !== receipt.currency) throw new HttpError(400, `Invoice ${inv.number} is in ${inv.currency}; the receipt is in ${receipt.currency}`);
    const outstanding = r2(inv.total - inv.amount_credited - inv.amount_paid);
    if (a.amount > outstanding + 0.005) throw new HttpError(400, `Allocation to ${inv.number} (${a.amount}) exceeds its outstanding balance (${outstanding})`);
    used = r2(used + a.amount);
    // realised FX difference between the receipt rate and the rate locked on the invoice
    const diff = r2(a.amount * (receipt.fx_rate - inv.fx_rate));
    let fxVoucher: number | null = null;
    if (Math.abs(diff) >= 0.01) {
      fxVoucher = await postVoucher(tx, { type: 'journal', date: receipt.receipt_date, narration: `Realised FX on ${receipt.receipt_no} → ${inv.number}`, ref_table: 'receipts', ref_id: receipt.id,
        legs: diff > 0 ? [{ account_id: arAcc, debit: diff }, { account_id: fxAcc, credit: diff }] : [{ account_id: fxAcc, debit: -diff }, { account_id: arAcc, credit: -diff }] });
    }
    await tx.insert('payments', { direction: 'inbound', method: receipt.method, invoice_id: inv.id, client_id: receipt.client_id, amount: a.amount, currency: receipt.currency, fx_rate: receipt.fx_rate,
      paid_at: receipt.receipt_date, reference: receipt.reference, receipt_id: receipt.id, voucher_id: fxVoucher });
    await syncInvoicePaid(tx, inv.id);
  }
  return used;
}

export async function createReceipt(t: Tenant, input: ReceiptIn) {
  if (input.idem_key) {
    const ex = await t.one('SELECT * FROM receipts WHERE agency_id = ? AND idem_key = ?', [t.agencyId, input.idem_key]);
    if (ex) return { receipt: ex, replay: true };
  }
  await t.ref('clients', input.client_id, 'client');
  const cash = await t.get('accounts', input.cash_account_id);
  if (!cash || cash.type_code !== 110) { await t.ref('accounts', input.cash_account_id, 'cash account'); throw new HttpError(400, 'Deposit account must be a cash/bank account'); }
  const agency = await t.agency(), allocs = input.allocations ?? [];
  const sum = r2(allocs.reduce((s, a) => s + a.amount, 0));
  if (sum > input.amount + 0.005) throw new HttpError(400, `Allocations (${sum}) exceed the receipt amount (${input.amount})`);
  let currency: string = input.currency ?? '';
  if (!currency && allocs.length) currency = (await t.get('invoices', allocs[0].invoice_id))?.currency ?? '';
  if (!currency) currency = (await t.get('clients', input.client_id))?.currency ?? agency.base_currency;
  const date = input.receipt_date ?? today();
  const ri = input.fx_rate ? { rate: input.fx_rate, source: 'manual', date } : currency === agency.base_currency ? { rate: 1, source: 'base', date } : await getRateInfo(t, currency, agency.base_currency, date);
  const fx = ri.rate;
  try {
    return await t.tx(async (tx) => {
      const arAcc = await ensureParty(tx, 'clients', input.client_id), amt = base(input.amount, fx);
      const receipt_no = await nextDocNo(tx, 'receipts', 'receipt_no', 'RCT');
      const vid = await postVoucher(tx, { type: 'receipt', date, narration: `Receipt ${receipt_no}${input.reference ? ` / ${input.reference}` : ''}`, ref_table: 'receipts',
        legs: [{ account_id: input.cash_account_id, debit: amt }, { account_id: arAcc, credit: amt }] });
      const id = await tx.insert('receipts', { receipt_no, client_id: input.client_id, cash_account_id: input.cash_account_id, amount: input.amount, currency, fx_rate: fx, receipt_date: date, fx_source: ri.source, fx_date: ri.date, method: input.method,
        reference: input.reference ?? null, narration: input.narration ?? null, unallocated: input.amount, voucher_id: vid, idem_key: input.idem_key ?? null, created_by: tx.actor.userId });
      const receipt = (await tx.get('receipts', id))!;
      const used = await allocate(tx, receipt, allocs);
      await tx.update('receipts', id, { unallocated: r2(input.amount - used) });
      await emit(tx, 'receipt.created', { receipt_id: id, receipt_no, client_id: input.client_id, amount: input.amount, currency, method: input.method });
      return { receipt: await tx.get('receipts', id), replay: false };
    });
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY' && input.idem_key) { // concurrent retry with the same key
      const ex = await t.one('SELECT * FROM receipts WHERE agency_id = ? AND idem_key = ?', [t.agencyId, input.idem_key]);
      if (ex) return { receipt: ex, replay: true };
    }
    throw e;
  }
}

export async function allocateReceipt(t: Tenant, receiptId: number, allocs: { invoice_id: number; amount: number }[]) {
  return t.tx(async (tx) => {
    const r = (await tx.query('SELECT * FROM receipts WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, receiptId]))[0];
    if (!r || r.status !== 'posted') throw new HttpError(404, 'Receipt not found');
    const sum = r2(allocs.reduce((s, a) => s + a.amount, 0));
    if (sum > r.unallocated + 0.005) throw new HttpError(400, `Only ${r.unallocated} of this receipt is unallocated`);
    const used = await allocate(tx, r, allocs);
    await tx.update('receipts', receiptId, { unallocated: r2(r.unallocated - used) });
    return tx.get('receipts', receiptId);
  });
}

/** Void by reversal: reverses the cash voucher and any FX vouchers, releases allocations, re-syncs invoices. */
export async function voidReceipt(t: Tenant, receiptId: number, reason: string, date: string) {
  return t.tx(async (tx) => {
    const r = (await tx.query('SELECT * FROM receipts WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, receiptId]))[0];
    if (!r) throw new HttpError(404, 'Receipt not found');
    if (r.status === 'voided') throw new HttpError(409, 'Receipt is already void');
    const pays = await tx.query('SELECT * FROM payments WHERE agency_id = ? AND receipt_id = ? AND voided = 0', [tx.agencyId, receiptId]);
    for (const p of pays) {
      if (p.voucher_id) await reverseVoucher(tx, p.voucher_id, date, reason);
      await tx.update('payments', p.id, { voided: 1 });
    }
    const rid = await reverseVoucher(tx, r.voucher_id, date, reason);
    await tx.update('receipts', receiptId, { status: 'voided', void_voucher_id: rid, void_reason: reason, unallocated: 0 });
    for (const inv of [...new Set(pays.map((p: any) => p.invoice_id))]) await syncInvoicePaid(tx, inv as number);
    return { reversal: rid };
  });
}

/* ======================================================================== credit notes */

export async function createCreditNote(t: Tenant, input: { invoice_id: number; reason: string; issue_date?: string; lines: { description: string; amount: number; tax?: number }[] }) {
  const inv = await t.get('invoices', input.invoice_id);
  if (!inv) throw new HttpError(400, 'Unknown invoice');
  if (!inv.voucher_id || ['draft', 'reviewed', 'void'].includes(inv.status)) throw new HttpError(409, 'Credit notes apply to issued invoices only');
  const subtotal = r2(input.lines.reduce((s, l) => s + l.amount, 0)), tax = r2(input.lines.reduce((s, l) => s + (l.tax ?? 0), 0)), total = r2(subtotal + tax);
  if (total <= 0) throw new HttpError(400, 'Credit note total must be positive');
  return t.tx(async (tx) => {
    const cn_no = await nextDocNo(tx, 'credit_notes', 'cn_no', 'CN');
    const id = await tx.insert('credit_notes', { cn_no, invoice_id: inv.id, client_id: inv.client_id, issue_date: input.issue_date ?? today(), reason: input.reason, currency: inv.currency, fx_rate: inv.fx_rate,
      subtotal, tax_total: tax, total, status: 'draft', created_by: tx.actor.userId });
    for (const l of input.lines) await tx.insert('credit_note_lines', { credit_note_id: id, description: l.description, amount: l.amount, tax: l.tax ?? 0 });
    return id;
  });
}

export async function issueCreditNote(t: Tenant, id: number) {
  return t.tx(async (tx) => {
    const cn = (await tx.query('SELECT * FROM credit_notes WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, id]))[0];
    if (!cn) throw new HttpError(404, 'Credit note not found');
    if (cn.status !== 'draft') throw new HttpError(409, `Credit note is ${cn.status}`);
    const inv = (await tx.query('SELECT * FROM invoices WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, cn.invoice_id]))[0];
    if (!inv || inv.status === 'void') throw new HttpError(409, 'Invoice is void');
    const room = r2(inv.total - inv.amount_credited);
    if (cn.total > room + 0.005) throw new HttpError(409, `Credit note (${cn.total}) exceeds what can still be credited on ${inv.number} (${room})`);
    await assertSecondApprover(tx, base(cn.total, cn.fx_rate), cn.created_by, tx.actor.userId!, 'A credit note');
    const ar = await ensureParty(tx, 'clients', cn.client_id), tot = base(cn.total, cn.fx_rate), net = base(cn.subtotal, cn.fx_rate), tax = r2(tot - net);
    const vid = await postVoucher(tx, { type: 'credit_note', date: cn.issue_date, narration: `Credit note ${cn.cn_no} against ${inv.number}`, ref_table: 'credit_notes', ref_id: id,
      legs: [{ account_id: await ensureSys(tx, 'booking_revenue'), debit: net }, ...(tax !== 0 ? [{ account_id: await ensureSys(tx, 'tax_payable'), debit: tax }] : []), { account_id: ar, credit: tot }] });
    await tx.update('credit_notes', id, { status: 'issued', voucher_id: vid, issued_by: tx.actor.userId });
    return { voucher_id: vid, invoice: await syncInvoicePaid(tx, cn.invoice_id) };
  });
}

export async function voidCreditNote(t: Tenant, id: number, reason: string, date: string) {
  return t.tx(async (tx) => {
    const cn = (await tx.query('SELECT * FROM credit_notes WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, id]))[0];
    if (!cn) throw new HttpError(404, 'Credit note not found');
    if (cn.status === 'void') throw new HttpError(409, 'Already void');
    if (cn.status === 'draft') { await tx.update('credit_notes', id, { status: 'void' }); return {}; }
    const inv = await tx.get('invoices', cn.invoice_id);
    if (r2(inv.amount_paid + inv.amount_credited - cn.total) > inv.total + 0.005) throw new HttpError(409, 'Void would leave the invoice over-settled; reverse the refund first');
    const rid = await reverseVoucher(tx, cn.voucher_id, date, reason);
    await tx.update('credit_notes', id, { status: 'void', void_voucher_id: rid });
    await syncInvoicePaid(tx, cn.invoice_id);
    return { reversal: rid };
  });
}

/* ======================================================================== client refunds (maker–checker) */

export async function surplus(t: Tenant, inv: any) {
  const reserved = await t.one<{ s: number }>(`SELECT COALESCE(SUM(amount),0) s FROM client_refunds WHERE agency_id = ? AND invoice_id = ? AND status IN ('requested','approved')`, [t.agencyId, inv.id]);
  return r2(inv.amount_paid + inv.amount_credited - inv.total - reserved!.s);
}

export async function requestRefund(t: Tenant, input: { invoice_id: number; amount: number; method: any; cash_account_id: number; reason: string }) {
  const inv = await t.get('invoices', input.invoice_id);
  if (!inv) throw new HttpError(400, 'Unknown invoice');
  const cash = await t.get('accounts', input.cash_account_id);
  if (!cash || cash.type_code !== 110) { await t.ref('accounts', input.cash_account_id, 'cash account'); throw new HttpError(400, 'Pay-out account must be a cash/bank account'); }
  const room = await surplus(t, inv);
  if (input.amount > room + 0.005) throw new HttpError(409, `Only ${Math.max(0, room)} is refundable on ${inv.number} (overpayment after credits)`);
  return t.tx(async (tx) => {
    const refund_no = await nextDocNo(tx, 'client_refunds', 'refund_no', 'CR');
    return tx.insert('client_refunds', { refund_no, client_id: inv.client_id, invoice_id: inv.id, amount: input.amount, currency: inv.currency, fx_rate: inv.fx_rate, method: input.method,
      cash_account_id: input.cash_account_id, reason: input.reason, status: 'requested', requested_by: tx.actor.userId });
  });
}

export async function approveRefund(t: Tenant, id: number) {
  const r = await t.get('client_refunds', id);
  if (!r) throw new HttpError(404, 'Refund not found');
  if (r.status !== 'requested') throw new HttpError(409, `Refund is ${r.status}`);
  await assertSecondApprover(t, base(r.amount, r.fx_rate), r.requested_by, t.actor.userId!, 'A refund');
  await t.update('client_refunds', id, { status: 'approved', approved_by: t.actor.userId, approved_at: nowSql() });
}

export async function rejectRefund(t: Tenant, id: number) {
  const r = await t.get('client_refunds', id);
  if (!r || r.status !== 'requested') throw new HttpError(409, 'Only a requested refund can be rejected');
  await t.update('client_refunds', id, { status: 'rejected' });
}

/** Paying out posts Dr client receivable / Cr cash and records an outbound payment against the invoice. */
export async function payRefund(t: Tenant, id: number, date = today()) {
  return t.tx(async (tx) => {
    const r = (await tx.query('SELECT * FROM client_refunds WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, id]))[0];
    if (!r) throw new HttpError(404, 'Refund not found');
    if (r.status !== 'approved') throw new HttpError(409, 'Refund must be approved before it is paid');
    const ar = await ensureParty(tx, 'clients', r.client_id), amt = base(r.amount, r.fx_rate);
    const vid = await postVoucher(tx, { type: 'payment', date, narration: `Client refund ${r.refund_no}`, ref_table: 'client_refunds', ref_id: id, legs: [{ account_id: ar, debit: amt }, { account_id: r.cash_account_id, credit: amt }] });
    const pid = await tx.insert('payments', { direction: 'outbound', method: r.method, invoice_id: r.invoice_id, client_id: r.client_id, amount: r.amount, currency: r.currency, fx_rate: r.fx_rate, paid_at: date, reference: r.refund_no });
    await tx.update('client_refunds', id, { status: 'paid', paid_at: date, voucher_id: vid, payment_id: pid });
    return syncInvoicePaid(tx, r.invoice_id);
  });
}

/* ======================================================================== supplier bills */

export interface BillIn {
  supplier_id: number; supplier_ref: string; bill_date: string; due_date?: string; currency?: string; booking_id?: number | null; notes?: string | null;
  lines: { component_id?: number | null; description: string; amount: number; tax?: number }[];
}

export async function createBill(t: Tenant, input: BillIn) {
  await t.refActive('suppliers', input.supplier_id, 'supplier');
  const sup = await t.get('suppliers', input.supplier_id);
  if (!sup) { await t.ref('suppliers', input.supplier_id, 'supplier'); throw new HttpError(400, 'Unknown supplier'); }
  await t.ref('bookings', input.booking_id, 'booking');
  const agency = await t.agency(), currency = input.currency ?? sup.currency ?? agency.base_currency;
  const warnings: string[] = [];
  const subtotal = r2(input.lines.reduce((s, l) => s + l.amount, 0)), tax = r2(input.lines.reduce((s, l) => s + (l.tax ?? 0), 0)), total = r2(subtotal + tax);
  if (total <= 0) throw new HttpError(400, 'Bill total must be positive');
  // duplicate detection: same supplier reference is rejected by the unique key; same supplier+amount+date is a warning
  const twin = await t.one(`SELECT bill_no FROM supplier_bills WHERE agency_id = ? AND supplier_id = ? AND total = ? AND bill_date = ? AND status <> 'void' LIMIT 1`, [t.agencyId, input.supplier_id, total, input.bill_date]);
  if (twin) warnings.push(`Possible duplicate: ${twin.bill_no} has the same supplier, amount and date`);
  // match to booking components: flag lines that exceed the remaining agreed cost beyond tolerance
  const mismatches: string[] = [];
  for (const l of input.lines) {
    if (!l.component_id) continue;
    const c = await t.one('SELECT * FROM booking_components WHERE agency_id = ? AND id = ?', [t.agencyId, l.component_id]);
    if (!c) throw new HttpError(400, 'Unknown booking component');
    if (input.booking_id && c.booking_id !== input.booking_id) throw new HttpError(400, 'Component does not belong to the selected booking');
    const billed = await t.one(`SELECT COALESCE(SUM(l2.amount),0) s FROM supplier_bill_lines l2 JOIN supplier_bills b ON b.id = l2.bill_id AND b.agency_id = l2.agency_id WHERE l2.agency_id = ? AND l2.component_id = ? AND b.status <> 'void'`, [t.agencyId, l.component_id]);
    const remaining = r2(c.cost_total - billed!.s), limit = r2(remaining * (1 + agency.bill_tolerance_pct / 100));
    if (l.amount > limit + 0.005) mismatches.push(`${c.description}: billed ${l.amount} vs ${remaining} remaining of agreed ${c.cost_total}`);
  }
  const ri = currency === agency.base_currency ? { rate: 1, source: 'base', date: input.bill_date } : await getRateInfo(t, currency, agency.base_currency, input.bill_date);
  const fx = ri.rate;
  const due = input.due_date ?? new Date(new Date(input.bill_date).getTime() + (sup.payment_terms_days ?? 30) * 864e5).toISOString().slice(0, 10);
  const id = await t.tx(async (tx) => {
    const bill_no = await nextDocNo(tx, 'supplier_bills', 'bill_no', 'BIL');
    const bid = await tx.insert('supplier_bills', { bill_no, supplier_id: input.supplier_id, supplier_ref: input.supplier_ref, bill_date: input.bill_date, due_date: due, currency, fx_rate: fx, subtotal, tax_total: tax, total,
      status: 'draft', booking_id: input.booking_id ?? null, notes: input.notes ?? null, mismatch_note: mismatches.length ? mismatches.join('; ').slice(0, 500) : null, created_by: tx.actor.userId });
    for (const l of input.lines) await tx.insert('supplier_bill_lines', { bill_id: bid, component_id: l.component_id ?? null, description: l.description, amount: l.amount, tax: l.tax ?? 0 });
    return bid;
  });
  return { id, warnings, mismatches };
}

export async function approveBill(t: Tenant, id: number, overrideReason?: string) {
  return t.tx(async (tx) => {
    const b = (await tx.query('SELECT * FROM supplier_bills WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, id]))[0];
    if (!b) throw new HttpError(404, 'Bill not found');
    if (!['draft', 'pending_approval'].includes(b.status)) throw new HttpError(409, `Bill is ${b.status}`);
    if (b.mismatch_note && !(overrideReason && overrideReason.trim().length >= 3)) throw new HttpError(409, `Bill does not match the booking cost (${b.mismatch_note}). Provide an override reason to approve it.`);
    await assertSecondApprover(tx, base(b.total, b.fx_rate), b.created_by, tx.actor.userId!, 'A supplier bill');
    const ap = await ensureParty(tx, 'suppliers', b.supplier_id), tot = base(b.total, b.fx_rate), net = base(b.subtotal, b.fx_rate), tax = r2(tot - net);
    const vid = await postVoucher(tx, { type: 'bill', date: b.bill_date, narration: `Supplier bill ${b.bill_no} (${b.supplier_ref})`, ref_table: 'supplier_bills', ref_id: id,
      legs: [{ account_id: await ensureSys(tx, 'cost_of_sales'), debit: net }, ...(tax !== 0 ? [{ account_id: await ensureSys(tx, 'tax_input'), debit: tax }] : []), { account_id: ap, credit: tot }] });
    await tx.update('supplier_bills', id, { status: 'approved', approved_by: tx.actor.userId, approved_at: nowSql(), voucher_id: vid, override_reason: overrideReason ?? null });
    await emit(tx, 'bill.approved', { bill_id: id, bill_no: b.bill_no, supplier_id: b.supplier_id, total: b.total, currency: b.currency, due_date: b.due_date });
    return { voucher_id: vid };
  });
}

export async function voidBill(t: Tenant, id: number, reason: string, date: string) {
  return t.tx(async (tx) => {
    const b = (await tx.query('SELECT * FROM supplier_bills WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, id]))[0];
    if (!b) throw new HttpError(404, 'Bill not found');
    if (b.status === 'void') throw new HttpError(409, 'Already void');
    if (b.amount_paid > 0) throw new HttpError(409, 'Bill has payments — void them first');
    const rid = b.voucher_id ? await reverseVoucher(tx, b.voucher_id, date, reason) : null;
    await tx.update('supplier_bills', id, { status: 'void', void_reason: reason, void_voucher_id: rid });
    return { reversal: rid };
  });
}

type PayBillInput = { cash_account_id: number; amount: number; date?: string; reference?: string | null; fx_rate?: number; run_id?: number };
export async function payBill(t: Tenant, id: number, input: PayBillInput) { return t.tx((tx) => payBillIn(tx, id, input)); }
/** payBill for callers that already hold a transaction (payment-run settlement), so the bill, ledger and run item commit together. */
export async function payBillIn(tx: Tenant, id: number, input: PayBillInput) {
  const cash = await tx.get('accounts', input.cash_account_id);
  if (!cash || cash.type_code !== 110) { await tx.ref('accounts', input.cash_account_id, 'cash account'); throw new HttpError(400, 'Pay from a cash/bank account'); }
  {
    const b = (await tx.query('SELECT * FROM supplier_bills WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, id]))[0];
    if (!b) throw new HttpError(404, 'Bill not found');
    if (!['approved', 'partially_paid'].includes(b.status)) throw new HttpError(409, `Bill is ${b.status}; only approved bills can be paid`);
    const outstanding = r2(b.total - b.amount_paid);
    if (!(input.amount > 0) || input.amount > outstanding + 0.005) throw new HttpError(400, `Payment must be between 0 and the outstanding ${outstanding}`);
    const agency = await tx.agency(), payDate = input.date ?? today();
    const fx = input.fx_rate ?? (b.currency === agency.base_currency ? 1 : (await getRateInfo(tx, b.currency, agency.base_currency, payDate)).rate);
    const ap = await ensureParty(tx, 'suppliers', b.supplier_id), fxAcc = await ensureSys(tx, 'fx_gain_loss');
    const apAmt = base(input.amount, b.fx_rate), cashAmt = base(input.amount, fx), diff = r2(cashAmt - apAmt); // paid more base than booked => loss
    const date = payDate;
    const vid = await postVoucher(tx, { type: 'payment', date, narration: `Payment of ${b.bill_no} (${b.supplier_ref})`, ref_table: 'supplier_bills', ref_id: id,
      legs: [{ account_id: ap, debit: apAmt }, ...(Math.abs(diff) >= 0.01 ? [{ account_id: fxAcc, debit: diff }] : []), { account_id: input.cash_account_id, credit: cashAmt }] });
    await tx.insert('payments', { direction: 'outbound', method: 'bank_transfer', supplier_id: b.supplier_id, bill_id: id, run_id: input.run_id ?? null, amount: input.amount, currency: b.currency, fx_rate: fx, paid_at: date, reference: input.reference ?? b.bill_no, voucher_id: vid });
    const paid = r2(b.amount_paid + input.amount);
    await tx.update('supplier_bills', id, { amount_paid: paid, status: paid >= b.total - 0.005 ? 'paid' : 'partially_paid' });
    return { paid, outstanding: r2(b.total - paid), voucher_id: vid };
  }
}

/* ======================================================================== backfill: bring pre-R3 data into the ledger */

export async function backfillLedger(t: Tenant) {
  const out = { invoices_posted: 0, receipts_created: 0, errors: [] as string[] };
  const invs = await t.query(`SELECT * FROM invoices WHERE agency_id = ? AND voucher_id IS NULL AND status IN ('sent','partially_paid','paid','overdue','credited') ORDER BY id`, [t.agencyId]);
  for (const inv of invs) {
    try {
      await t.tx(async (tx) => {
        const client = await tx.get('clients', inv.client_id), ar = await ensureParty(tx, 'clients', inv.client_id);
        const total = base(inv.total, inv.fx_rate), net = base(inv.subtotal, inv.fx_rate), tax = r2(total - net);
        const vid = await postVoucher(tx, { type: 'invoice', date: inv.issue_date, narration: `Invoice ${inv.number} — ${client.name} (migrated)`, ref_table: 'invoices', ref_id: inv.id,
          legs: [{ account_id: ar, debit: total }, { account_id: await ensureSys(tx, 'booking_revenue'), credit: net }, ...(tax !== 0 ? [{ account_id: await ensureSys(tx, 'tax_payable'), credit: tax }] : [])] });
        await tx.update('invoices', inv.id, { voucher_id: vid, snapshot_json: JSON.stringify({ backfilled: true, invoice: inv }) });
      });
      out.invoices_posted++;
    } catch (e: any) { out.errors.push(`${inv.number}: ${e.message}`); }
  }
  const pays = await t.query(`SELECT p.*, i.voucher_id inv_voucher FROM payments p JOIN invoices i ON i.id = p.invoice_id AND i.agency_id = p.agency_id
    WHERE p.agency_id = ? AND p.direction = 'inbound' AND p.receipt_id IS NULL AND p.voided = 0 ORDER BY p.id`, [t.agencyId]);
  for (const p of pays) {
    if (!p.inv_voucher) { out.errors.push(`payment #${p.id}: its invoice is not in the ledger yet`); continue; }
    try {
      await t.tx(async (tx) => {
        const ar = await ensureParty(tx, 'clients', p.client_id), cash = await ensureSys(tx, p.method === 'cash' ? 'cash' : 'bank'), amt = base(p.amount, p.fx_rate);
        const receipt_no = await nextDocNo(tx, 'receipts', 'receipt_no', 'RCT');
        const vid = await postVoucher(tx, { type: 'receipt', date: p.paid_at, narration: `Receipt ${receipt_no} (migrated payment #${p.id})`, ref_table: 'receipts', legs: [{ account_id: cash, debit: amt }, { account_id: ar, credit: amt }] });
        const rid = await tx.insert('receipts', { receipt_no, client_id: p.client_id, cash_account_id: cash, amount: p.amount, currency: p.currency, fx_rate: p.fx_rate, receipt_date: p.paid_at, method: p.method, reference: p.reference, narration: 'Migrated from payment record', unallocated: 0, voucher_id: vid, created_by: tx.actor.userId });
        await tx.update('payments', p.id, { receipt_id: rid });
      });
      out.receipts_created++;
    } catch (e: any) { out.errors.push(`payment #${p.id}: ${e.message}`); }
  }
  return out;
}
