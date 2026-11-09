import { Tenant } from '../db.js';
import { BALANCE_SQL } from './accounting.js';
import { r2, today } from './money.js';

/*
 * What clients owe us, and what we owe suppliers and airlines, as a list of open items.
 *
 * Invoices and supplier bills carry their own payments, so each is aged on its own. Ticket invoices do not: money is
 * received against the client's ledger account (optionally naming the ticket invoice). Those are aged oldest-first —
 * receipts that name an invoice go to it, the rest clear the oldest invoices first — the way ledger-based books do.
 * None of this reads the ledger balance, so comparing it with the ledger still means something.
 */

export type DocKind = 'invoice' | 'bill' | 'ticket' | 'other';
export interface OpenItem {
  key: string;                       // who it is for: their ledger account, or the client/supplier when they have none yet
  clientId: number | null;           // CRM client or supplier id when there is one
  accountId: number | null;
  name: string;
  doc: DocKind; id: number | null; number: string; theirRef: string; due: string;
  currency: string; total: number;   // document currency
  docBalance: number;                // still open, document currency
  balance: number;                   // still open, base currency
}

export const isCurrent = (asAt: string) => asAt >= today();
export const daysLate = (asAt: string, due: string) => Math.round((Date.parse(`${asAt}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 864e5);
/** 0 = not yet due, 1 = 1–30 days late, 2 = 31–60, 3 = more than 60. */
export const bucketOf = (days: number) => (days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : 3);
export const BUCKETS = ['Current', '1-30', '31-60', '60+'];

interface TDoc { id: number; number: string; due: string; amount: number; linked: number }
/** Applies credits to documents that have no payments of their own: named ones first, then the rest to the oldest. */
export function fifo(docs: TDoc[], pool: number) {
  const left = docs.map((d) => { const rem = r2(d.amount - d.linked); if (rem < 0) pool = r2(pool - rem); return { d, rem: Math.max(0, rem) }; });
  left.sort((a, b) => a.d.due.localeCompare(b.d.due) || a.d.id - b.d.id);
  const open: { doc: TDoc; bal: number }[] = [];
  for (const x of left) { const take = Math.max(0, Math.min(pool, x.rem)); pool = r2(pool - take); x.rem = r2(x.rem - take); if (x.rem > 0.005) open.push({ doc: x.d, bal: x.rem }); }
  return { open, leftover: pool };   // leftover > 0: credit with nothing left to clear; < 0: more went out than was ever credited
}

interface Party { id: number | null; name: string; account_id: number | null }
async function parties(t: Tenant, table: 'clients' | 'suppliers') {
  const rows: Party[] = await t.query(`SELECT id, name, account_id FROM ${table} WHERE agency_id = ?`, [t.agencyId]);
  const byAccount = new Map<number, Party>(); for (const r of rows) if (r.account_id) byAccount.set(r.account_id, r);
  return { byId: new Map(rows.map((r) => [r.id as number, r])), byAccount };
}
const accountNames = async (t: Tenant) => new Map<number, string>((await t.query('SELECT id, name FROM accounts WHERE agency_id = ?', [t.agencyId])).map((a: any) => [a.id, a.name]));
const keyOf = (accountId: number | null, kind: string, id: number | null) => (accountId ? `acct:${accountId}` : `${kind}:${id}`);

/* ------------------------------------------------------------------ receivables */
export async function receivables(t: Tenant, asAt: string, opts: { clientId?: number } = {}): Promise<OpenItem[]> {
  const now = isCurrent(asAt), cl = await parties(t, 'clients'), names = await accountNames(t), items: OpenItem[] = [];
  const only = opts.clientId ? cl.byId.get(opts.clientId) : undefined;

  // invoices: as the invoice records stand today, or as they stood on the date asked for
  const inv: any[] = now
    ? await t.query(`SELECT i.id, i.number, i.client_id, i.due_date, i.currency, i.total, i.fx_rate, (i.total - i.amount_credited - i.amount_paid) bal FROM invoices i
        WHERE i.agency_id = ? AND i.status IN ('sent','partially_paid','overdue') ${opts.clientId ? 'AND i.client_id = ?' : ''}`, [t.agencyId, ...(opts.clientId ? [opts.clientId] : [])])
    : await t.query(`SELECT i.id, i.number, i.client_id, i.due_date, i.currency, i.total, i.fx_rate,
        i.total - COALESCE((SELECT SUM(cn.total) FROM credit_notes cn WHERE cn.agency_id = i.agency_id AND cn.invoice_id = i.id AND cn.status = 'issued' AND cn.issue_date <= ?), 0)
                - COALESCE((SELECT SUM(CASE WHEN p.direction = 'inbound' THEN p.amount ELSE -p.amount END) FROM payments p WHERE p.agency_id = i.agency_id AND p.invoice_id = i.id AND p.voided = 0 AND p.paid_at <= ?
                            AND (p.direction = 'inbound' OR p.client_id IS NOT NULL)), 0) bal
        FROM invoices i WHERE i.agency_id = ? AND i.issue_date <= ? AND i.status IN ('sent','partially_paid','overdue','paid','credited') ${opts.clientId ? 'AND i.client_id = ?' : ''}
        HAVING bal > 0.005`, [asAt, asAt, t.agencyId, asAt, ...(opts.clientId ? [opts.clientId] : [])]);
  for (const i of inv) {
    const c = cl.byId.get(i.client_id);
    items.push({ key: keyOf(c?.account_id ?? null, 'client', i.client_id), clientId: i.client_id, accountId: c?.account_id ?? null, name: c?.name ?? `Client #${i.client_id}`, doc: 'invoice', id: i.id, number: i.number, theirRef: '',
      due: i.due_date, currency: i.currency, total: Number(i.total), docBalance: Number(i.bal), balance: Number(i.bal) * Number(i.fx_rate) });
  }

  // ticket invoices
  const acct = only?.account_id ?? null;
  if (opts.clientId && !acct) return items;
  const docs: any[] = await t.query(
    `SELECT i.id, i.invoice_no number, i.client_account_id acct, COALESCE(i.due_date, i.invoice_date) due, SUM(l.receivable) amount FROM ticket_invoices i JOIN ticket_lines l ON l.invoice_id = i.id AND l.agency_id = i.agency_id
     WHERE i.agency_id = ? AND i.status = 'confirmed' AND i.invoice_date <= ? ${acct ? 'AND i.client_account_id = ?' : ''} GROUP BY i.id, i.invoice_no, i.client_account_id, i.due_date, i.invoice_date`, [t.agencyId, asAt, ...(acct ? [acct] : [])]);
  const linked = new Map<number, number>((await t.query(
    `SELECT ticket_invoice_id id, SUM(amount) amt FROM cash_vouchers WHERE agency_id = ? AND kind = 'receipt' AND cleared = 1 AND ticket_invoice_id IS NOT NULL AND COALESCE(cleared_date, voucher_date) <= ? GROUP BY ticket_invoice_id`, [t.agencyId, asAt])).map((r: any) => [r.id, Number(r.amt)]));
  const pool = new Map<number, number>(); const add = (a: number, v: number) => pool.set(a, r2((pool.get(a) ?? 0) + v));
  for (const r of await t.query(`SELECT party_account_id a, SUM(CASE WHEN kind = 'receipt' AND ticket_invoice_id IS NULL THEN amount WHEN kind = 'payment' THEN -amount ELSE 0 END) net FROM cash_vouchers
      WHERE agency_id = ? AND cleared = 1 AND COALESCE(cleared_date, voucher_date) <= ? ${acct ? 'AND party_account_id = ?' : ''} GROUP BY party_account_id`, [t.agencyId, asAt, ...(acct ? [acct] : [])])) add(r.a, Number(r.net));
  for (const r of await t.query(`SELECT client_account_id a, SUM(pay_to_customer * fx_rate) amt FROM refunds WHERE agency_id = ? AND pending = 0 AND refund_date <= ? ${acct ? 'AND client_account_id = ?' : ''} GROUP BY client_account_id`, [t.agencyId, asAt, ...(acct ? [acct] : [])])) add(r.a, Number(r.amt));

  const byAcct = new Map<number, TDoc[]>();
  for (const d of docs) byAcct.set(d.acct, [...(byAcct.get(d.acct) ?? []), { id: d.id, number: d.number, due: d.due, amount: Number(d.amount), linked: linked.get(d.id) ?? 0 }]);
  for (const a of new Set([...byAcct.keys(), ...[...pool.keys()].filter((x) => cl.byAccount.has(x))])) {   // accounts that bill tickets, and clients with receipts of their own
    const c = cl.byAccount.get(a), name = c?.name ?? names.get(a) ?? `Account #${a}`, who = { key: keyOf(a, 'client', c?.id ?? null), clientId: c?.id ?? null, accountId: a, name, theirRef: '', currency: '', total: 0 };
    const r = fifo(byAcct.get(a) ?? [], pool.get(a) ?? 0);
    for (const o of r.open) items.push({ ...who, doc: 'ticket', id: o.doc.id, number: o.doc.number, due: o.doc.due, total: o.doc.amount, docBalance: o.bal, balance: o.bal, currency: '' });
    if (r.leftover > 0.005) items.push({ ...who, doc: 'other', id: null, number: 'Unapplied receipts', due: asAt, docBalance: -r.leftover, balance: -r.leftover });
    else if (r.leftover < -0.005) items.push({ ...who, doc: 'other', id: null, number: 'Other ledger balance', due: asAt, docBalance: -r.leftover, balance: -r.leftover });
  }
  return items;
}

/* ---------------------------------------------------------------------- payables */
export async function payables(t: Tenant, asAt: string): Promise<OpenItem[]> {
  const now = isCurrent(asAt), sp = await parties(t, 'suppliers'), names = await accountNames(t), items: OpenItem[] = [];
  const bills: any[] = now
    ? await t.query(`SELECT b.id, b.bill_no number, b.supplier_id, b.supplier_ref, b.due_date, b.currency, b.total, b.fx_rate, (b.total - b.amount_paid) bal FROM supplier_bills b
        WHERE b.agency_id = ? AND b.status IN ('approved','partially_paid') AND b.total - b.amount_paid > 0.005`, [t.agencyId])
    : await t.query(`SELECT b.id, b.bill_no number, b.supplier_id, b.supplier_ref, b.due_date, b.currency, b.total, b.fx_rate,
        b.total - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.agency_id = b.agency_id AND p.bill_id = b.id AND p.direction = 'outbound' AND p.voided = 0 AND p.paid_at <= ?), 0) bal
        FROM supplier_bills b WHERE b.agency_id = ? AND b.bill_date <= ? AND b.status IN ('approved','partially_paid','paid') HAVING bal > 0.005`, [asAt, t.agencyId, asAt]);
  for (const b of bills) {
    const s = sp.byId.get(b.supplier_id);
    items.push({ key: keyOf(s?.account_id ?? null, 'supplier', b.supplier_id), clientId: b.supplier_id, accountId: s?.account_id ?? null, name: s?.name ?? `Supplier #${b.supplier_id}`, doc: 'bill', id: b.id, number: b.bill_no, theirRef: b.supplier_ref ?? '',
      due: b.due_date, currency: b.currency, total: Number(b.total), docBalance: Number(b.bal), balance: Number(b.bal) * Number(b.fx_rate) });
  }

  // what we owe airlines and other vendors for issued ticket invoices
  const docs: any[] = await t.query(
    `SELECT i.id, i.invoice_no number, l.payable_account_id acct, COALESCE(i.due_vendor, i.due_date, i.invoice_date) due, SUM(l.payable) amount FROM ticket_invoices i JOIN ticket_lines l ON l.invoice_id = i.id AND l.agency_id = i.agency_id
     WHERE i.agency_id = ? AND i.status = 'confirmed' AND i.invoice_date <= ? GROUP BY i.id, i.invoice_no, l.payable_account_id, i.due_vendor, i.due_date, i.invoice_date`, [t.agencyId, asAt]);
  const linked = new Map<string, number>((await t.query(
    `SELECT ticket_invoice_id id, party_account_id a, SUM(amount) amt FROM cash_vouchers WHERE agency_id = ? AND kind = 'payment' AND cleared = 1 AND ticket_invoice_id IS NOT NULL AND voucher_date <= ? GROUP BY ticket_invoice_id, party_account_id`, [t.agencyId, asAt]))
    .map((r: any) => [`${r.id}:${r.a}`, Number(r.amt)]));
  const pool = new Map<number, number>(); const add = (a: number, v: number) => pool.set(a, r2((pool.get(a) ?? 0) + v));
  for (const r of await t.query(`SELECT party_account_id a, SUM(CASE WHEN kind = 'payment' AND ticket_invoice_id IS NULL THEN amount WHEN kind = 'receipt' THEN -amount ELSE 0 END) net FROM cash_vouchers
      WHERE agency_id = ? AND cleared = 1 AND COALESCE(cleared_date, voucher_date) <= ? GROUP BY party_account_id`, [t.agencyId, asAt])) add(r.a, Number(r.net));
  for (const r of await t.query(`SELECT payable_account_id a, SUM(rec_from_vendor * fx_rate) amt FROM refunds WHERE agency_id = ? AND pending = 0 AND refund_date <= ? GROUP BY payable_account_id`, [t.agencyId, asAt])) add(r.a, Number(r.amt));

  const byAcct = new Map<number, TDoc[]>();
  for (const d of docs) byAcct.set(d.acct, [...(byAcct.get(d.acct) ?? []), { id: d.id, number: d.number, due: d.due, amount: Number(d.amount), linked: linked.get(`${d.id}:${d.acct}`) ?? 0 }]);
  for (const a of new Set([...byAcct.keys(), ...[...pool.keys()].filter((x) => sp.byAccount.has(x))])) {
    const list = byAcct.get(a) ?? [], s = sp.byAccount.get(a), name = s?.name ?? names.get(a) ?? `Account #${a}`, who = { key: keyOf(a, 'supplier', s?.id ?? null), clientId: s?.id ?? null, accountId: a, name, currency: '', total: 0 };
    const r = fifo(list, pool.get(a) ?? 0);
    for (const o of r.open) items.push({ ...who, doc: 'ticket', id: o.doc.id, number: o.doc.number, theirRef: '', due: o.doc.due, total: o.doc.amount, docBalance: o.bal, balance: o.bal });
    if (r.leftover > 0.005) items.push({ ...who, doc: 'other', id: null, number: 'Unapplied payments', theirRef: '', due: asAt, docBalance: -r.leftover, balance: -r.leftover });
    else if (r.leftover < -0.005) items.push({ ...who, doc: 'other', id: null, number: 'Other ledger balance', theirRef: '', due: asAt, docBalance: -r.leftover, balance: -r.leftover });
  }
  return items;
}

/* -------------------------------------------------- the ledger side of the check */
/** Ledger balance of the accounts that receivables cover (client accounts and the accounts ticket invoices bill), plus receipts not yet matched to an invoice. */
export async function receivablesLedger(t: Tenant) {
  const gl = await t.one(`SELECT COALESCE(SUM(${BALANCE_SQL}),0) v FROM accounts a WHERE a.agency_id = ? AND (a.id IN (SELECT account_id FROM clients WHERE agency_id = ? AND account_id IS NOT NULL)
      OR a.id IN (SELECT client_account_id FROM ticket_invoices WHERE agency_id = ? AND status = 'confirmed'))`, [t.agencyId, t.agencyId, t.agencyId]);
  const un = await t.one(`SELECT COALESCE(SUM(unallocated * fx_rate),0) v FROM receipts WHERE agency_id = ? AND status = 'posted'`, [t.agencyId]);
  return Number(gl!.v) + Number(un!.v);
}
/** Ledger balance of the accounts payables cover (supplier accounts and the accounts ticket invoices owe), as a positive amount owed. */
export async function payablesLedger(t: Tenant) {
  const gl = await t.one(`SELECT COALESCE(SUM(${BALANCE_SQL}),0) v FROM accounts a WHERE a.agency_id = ? AND (a.id IN (SELECT account_id FROM suppliers WHERE agency_id = ? AND account_id IS NOT NULL)
      OR a.id IN (SELECT l.payable_account_id FROM ticket_lines l JOIN ticket_invoices i ON i.id = l.invoice_id AND i.agency_id = l.agency_id WHERE l.agency_id = ? AND i.status = 'confirmed' AND l.payable_account_id IS NOT NULL))`, [t.agencyId, t.agencyId, t.agencyId]);
  return -Number(gl!.v);
}

/* ------------------------------------------------------------------- grouping */
export interface PartyRow { key: string; name: string; clientId: number | null; accountId: number | null; b: [number, number, number, number]; total: number }
export function byParty(items: OpenItem[], asAt: string): PartyRow[] {
  const m = new Map<string, PartyRow>();
  for (const it of items) {
    const r = m.get(it.key) ?? { key: it.key, name: it.name, clientId: it.clientId, accountId: it.accountId, b: [0, 0, 0, 0] as [number, number, number, number], total: 0 };
    r.b[bucketOf(daysLate(asAt, it.due))] += it.balance; r.total += it.balance; m.set(it.key, r);
  }
  return [...m.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}
