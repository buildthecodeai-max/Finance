// External Import — payment matching. Pure: takes payments + the open invoices and says where each payment should go and how sure we are.
// Nothing here writes; a payment is only treated as settling an invoice when the rules reach CONFIRM_AT, otherwise it is a suggestion for a person to confirm.
import type { Rec } from './engine.js';

export const CONFIRM_AT = 90;
export type Method = 'invoice_no' | 'pax_pnr' | 'ticket' | 'reference' | 'amount_date' | 'manual';

export interface OpenInvoice {
  invoice_no: string; date: string | null; billed: number; outstanding: number;
  pnrs: Set<string>; tickets: Set<string>; pax: Set<string>; payer: string | null;
}
export interface Alloc { invoice_no: string; amount: number; method: Method; confidence: number }
export interface Match { allocations: Alloc[]; unapplied: number; state: 'full' | 'partial' | 'multi' | 'over' | 'review' | 'unmatched'; note?: string }

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const upper = (s: string | null | undefined) => (s ?? '').toUpperCase();

/** Build the open-invoice index from ledger lines (sales, exchanges, credit notes, refunds) minus confirmed allocations. */
export function buildOpen(lines: Pick<Rec, 'invoice_no' | 'txn_date' | 'net' | 'pnr' | 'ticket_no' | 'passenger_key' | 'payer_name'>[], paid: Map<string, number>): Map<string, OpenInvoice> {
  const m = new Map<string, OpenInvoice>();
  for (const l of lines) {
    if (!l.invoice_no) continue;
    const o = m.get(l.invoice_no) ?? { invoice_no: l.invoice_no, date: l.txn_date, billed: 0, outstanding: 0, pnrs: new Set(), tickets: new Set(), pax: new Set(), payer: l.payer_name };
    o.billed = r2(o.billed + l.net);
    if (l.pnr) o.pnrs.add(upper(l.pnr)); if (l.ticket_no) o.tickets.add(upper(l.ticket_no)); if (l.passenger_key) o.pax.add(l.passenger_key);
    if (l.txn_date && (!o.date || l.txn_date < o.date)) o.date = l.txn_date;
    m.set(l.invoice_no, o);
  }
  for (const o of m.values()) o.outstanding = r2(o.billed - (paid.get(o.invoice_no) ?? 0));
  return m;
}

/**
 * Rules, strongest first:
 *  1. invoice number in the payment's own invoice column            → 98
 *  2. ticket number                                                  → 92
 *  3. invoice number written in the reference/description (one payment may list several invoices) → 90
 *  4. passenger AND PNR together                                     → 88
 *  5. PNR written in the reference/description                       → 80
 *  6. passenger name + exactly the outstanding amount                → 75
 *  7. exactly one open invoice has this amount outstanding, dated on/before the payment → 60
 * Only ≥ CONFIRM_AT is treated as confirmed; anything else is a suggestion.
 */
export function matchPayment(p: Pick<Rec, 'net' | 'txn_date' | 'invoice_no' | 'ticket_no' | 'pnr' | 'passenger_key' | 'payment_ref' | 'description' | 'remarks' | 'payer_name'>, open: Map<string, OpenInvoice>): Match {
  const amount = p.net;
  if (!(amount > 0)) return { allocations: [], unapplied: 0, state: 'unmatched', note: 'Not a positive payment amount' };
  const text = upper(`${p.payment_ref ?? ''} ${p.description ?? ''} ${p.remarks ?? ''}`);
  const cand = new Map<string, { method: Method; confidence: number }>();
  const bump = (inv: string, method: Method, confidence: number) => { const c = cand.get(inv); if (!c || confidence > c.confidence) cand.set(inv, { method, confidence }); };

  if (p.invoice_no && open.has(upper(p.invoice_no))) bump(upper(p.invoice_no), 'invoice_no', 98);
  for (const o of open.values()) {
    if (p.ticket_no && o.tickets.has(upper(p.ticket_no))) bump(o.invoice_no, 'ticket', 92);
    if (text && text.includes(o.invoice_no)) bump(o.invoice_no, 'reference', 90);
    if (p.passenger_key && p.pnr && o.pax.has(p.passenger_key) && o.pnrs.has(upper(p.pnr))) bump(o.invoice_no, 'pax_pnr', 88);
    else if (text) for (const pnr of o.pnrs) if (pnr.length >= 5 && new RegExp(`\\b${pnr}\\b`).test(text)) bump(o.invoice_no, 'reference', 80);
    if (p.passenger_key && o.pax.has(p.passenger_key) && Math.abs(o.outstanding - amount) < 0.005 && o.outstanding > 0) bump(o.invoice_no, 'amount_date', 75);
  }
  if (!cand.size) {
    const same = [...open.values()].filter((o) => Math.abs(o.outstanding - amount) < 0.005 && o.outstanding > 0 && (!p.txn_date || !o.date || o.date <= p.txn_date) && (!p.payer_name || !o.payer || upper(o.payer) === upper(p.payer_name)));
    if (same.length === 1) bump(same[0].invoice_no, 'amount_date', 60);
  }
  if (!cand.size) return { allocations: [], unapplied: amount, state: 'unmatched' };

  // Invoices ranked by confidence, then oldest first. A payment that names several invoices is spread across them in that order.
  const ranked = [...cand.entries()].map(([inv, c]) => ({ inv, ...c, o: open.get(inv)! })).sort((a, b) => b.confidence - a.confidence || (a.o.date ?? '').localeCompare(b.o.date ?? ''));
  const top = ranked[0].confidence;
  const use = ranked.filter((c) => c.confidence === top && c.o.outstanding > 0.005);
  if (!use.length) return { allocations: [], unapplied: amount, state: 'over', note: 'The matched invoice is already settled — treated as an overpayment, not applied' };
  // Several equally-likely invoices with only a weak signal → don't guess.
  if (use.length > 1 && top < CONFIRM_AT && !use.every((u) => u.method === 'reference')) return { allocations: [], unapplied: amount, state: 'review', note: `${use.length} invoices fit equally — choose one` };
  let left = amount; const allocations: Alloc[] = [];
  for (const u of use.sort((a, b) => (a.o.date ?? '').localeCompare(b.o.date ?? ''))) {
    if (left <= 0.004) break;
    const a = r2(Math.min(left, u.o.outstanding)); if (a <= 0) continue;
    allocations.push({ invoice_no: u.inv, amount: a, method: u.method, confidence: u.confidence }); left = r2(left - a);
  }
  const state: Match['state'] = top < CONFIRM_AT ? 'review' : left > 0.004 ? 'over' : allocations.length > 1 ? 'multi' : Math.abs(allocations[0].amount - ranked[0].o.outstanding) < 0.005 ? 'full' : 'partial';
  return { allocations, unapplied: left, state, note: state === 'over' ? `Overpaid by ${left.toFixed(2)}` : undefined };
}

/** Reserve an allocation against the in-memory index so the next payment sees the reduced balance (several payments, one invoice). */
export function reserve(open: Map<string, OpenInvoice>, m: Match) { for (const a of m.allocations) { const o = open.get(a.invoice_no); if (o) o.outstanding = r2(o.outstanding - a.amount); } }
