// External Import → the real books. Every imported sale becomes an issued invoice under the payer (client) with its ledger voucher
// (Dr client receivable / Cr booking revenue); credit notes and refunds become credit notes (or a standalone credit voucher when no parent invoice exists).
import { Tenant } from '../../db.js';
import { ensureParty, ensureSys, nextDocNo, postVoucher } from '../accounting.js';
import { findRate } from '../fx.js';
import { syncInvoicePaid } from '../invoicing.js';
import { addDays, r2 } from '../money.js';
import type { Rec } from './engine.js';

export interface Posting { txnId: number; d: Rec }
export interface NotPosted { invoice_no: string | null; why: string }

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const desc = (d: Rec) => [d.passenger_name, d.sector, d.pnr && `PNR ${d.pnr}`, d.airline, d.travel_date && `travel ${d.travel_date}`].filter(Boolean).join(' · ').slice(0, 480) || 'Imported line';

export async function postImported(tx: Tenant, batch: { id: number; file_name: string; currency: string }, clientId: number, items: Posting[]) {
  const agency = await tx.agency(), client = await tx.get<any>('clients', clientId);
  const notPosted: NotPosted[] = []; let invoices = 0, credits = 0;
  const sales = items.filter((i) => i.d.kind === 'sale' || i.d.kind === 'exchange'), credit = items.filter((i) => i.d.kind === 'credit_note' || i.d.kind === 'refund' || i.d.kind === 'reversal');
  const groups = new Map<string, Posting[]>();
  for (const s of sales) { const k = s.d.invoice_no ?? `#${s.txnId}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(s); }
  const link = (txnId: number, f: Record<string, any>) => tx.query('UPDATE ext_txns SET ' + Object.keys(f).map((c) => `${c} = ?`).join(',') + ' WHERE agency_id = ? AND id = ?', [...Object.values(f), tx.agencyId, txnId]);

  const fxFor = async (date: string) => {
    if (batch.currency === agency.base_currency) return { rate: 1, source: 'base', date };
    const r = await findRate(tx, batch.currency, agency.base_currency, date);
    if (!r) throw new Error(`no exchange rate ${batch.currency}→${agency.base_currency} near ${date} (add one under Finance → Exchange rates)`);
    return r;
  };
  const check = async (date: string) => { await tx.assertPeriodOpen(date); return fxFor(date); };

  for (const [key, g] of groups) {
    const no = key.startsWith('#') ? null : key;
    try {
      const date = g.map((x) => x.d.txn_date!).sort()[0];
      if (no && no.length > 30) throw new Error('invoice number is longer than 30 characters');
      if (no && await tx.one('SELECT id FROM invoices WHERE agency_id = ? AND number = ?', [tx.agencyId, no])) throw new Error(`an invoice numbered ${no} already exists`);
      const fx = await check(date);
      const number = no ?? await tx.takeInvoiceNumber();
      const lines: any[] = [];
      for (const s of g) {
        const type = /visa/i.test(s.d.section ?? s.d.doc_type ?? '') ? 'other' : 'flight';
        if (s.d.gross) lines.push({ product_type: type, description: desc(s.d), unit_cost: s.d.gross, line_net: s.d.gross });
        const extra = r2(s.d.net - s.d.gross);
        if (extra) lines.push({ product_type: type, description: `Service charge — ${s.d.passenger_name ?? s.d.pnr ?? ''}`.slice(0, 480), unit_cost: extra, line_net: extra });
      }
      const total = r2(g.reduce((a, s) => a + s.d.net, 0));
      const invId = await tx.insert('invoices', { number, client_id: clientId, created_by: tx.actor.userId, status: addDays(date, client?.payment_terms_days ?? 14) < new Date().toISOString().slice(0, 10) ? 'overdue' : 'sent', currency: batch.currency, fx_rate: fx.rate, fx_source: fx.source, fx_date: fx.date,
        issue_date: date, due_date: addDays(date, client?.payment_terms_days ?? 14), subtotal: total, tax_total: 0, total, sent_at: nowSql(), notes: `Imported from ${batch.file_name} (external import #${batch.id})` });
      for (const l of lines) await tx.insert('invoice_lines', { invoice_id: invId, product_type: l.product_type, description: l.description, quantity: 1, unit_cost: l.unit_cost, markup_pct: 0, unit_price: l.unit_cost, tax_rate: 0, line_net: l.line_net, line_tax: 0 });
      const ar = await ensureParty(tx, 'clients', clientId);
      const vid = await postVoucher(tx, { type: 'invoice', date, narration: `Invoice ${number} — ${client.name} (imported)`, ref_table: 'invoices', ref_id: invId,
        legs: [{ account_id: ar, debit: r2(total * fx.rate) }, { account_id: await ensureSys(tx, 'booking_revenue'), credit: r2(total * fx.rate) }] });
      await tx.update('invoices', invId, { voucher_id: vid });
      for (const s of g) await link(s.txnId, { invoice_id: invId, voucher_id: vid });
      invoices++;
    } catch (e: any) { notPosted.push({ invoice_no: no, why: e.message }); }
  }

  for (const c of credit) {
    try {
      const amt = Math.abs(c.d.net), date = c.d.txn_date!, fx = await check(date);
      // parent: an imported invoice for the same PNR (and passenger when known) with enough left to credit
      const cand = c.d.pnr ? await tx.query<any>(`SELECT i.id, i.number, i.total, i.amount_credited, i.status FROM ext_txns x JOIN invoices i ON i.id = x.invoice_id AND i.agency_id = x.agency_id
          WHERE x.agency_id = ? AND x.client_id = ? AND x.pnr = ? AND x.status = 'active' AND x.kind IN ('sale','exchange') AND i.status <> 'void' ORDER BY x.id DESC`, [tx.agencyId, clientId, c.d.pnr]) : [];
      const parent = cand.find((i) => r2(i.total - i.amount_credited) + 0.005 >= amt);
      const ar = await ensureParty(tx, 'clients', clientId), rev = await ensureSys(tx, 'booking_revenue'), base = r2(amt * fx.rate);
      if (parent) {
        const cn_no = await nextDocNo(tx, 'credit_notes', 'cn_no', 'CN');
        const cnId = await tx.insert('credit_notes', { cn_no, invoice_id: parent.id, client_id: clientId, issue_date: date, reason: `${c.d.doc_type ?? 'Credit'} ${c.d.invoice_no ?? ''} — imported (external import #${batch.id})`.slice(0, 300), currency: batch.currency, fx_rate: fx.rate,
          subtotal: amt, tax_total: 0, total: amt, status: 'issued', created_by: tx.actor.userId, issued_by: tx.actor.userId });
        await tx.insert('credit_note_lines', { credit_note_id: cnId, description: desc(c.d), amount: amt, tax: 0 });
        const vid = await postVoucher(tx, { type: 'credit_note', date, narration: `Credit note ${cn_no} against ${parent.number} (imported)`, ref_table: 'credit_notes', ref_id: cnId, legs: [{ account_id: rev, debit: base }, { account_id: ar, credit: base }] });
        await tx.update('credit_notes', cnId, { voucher_id: vid });
        await syncInvoicePaid(tx, parent.id);
        await link(c.txnId, { credit_note_id: cnId, invoice_id: parent.id, voucher_id: vid });
      } else {
        const vid = await postVoucher(tx, { type: 'credit_note', date, narration: `Credit ${c.d.invoice_no ?? ''} — ${c.d.passenger_name ?? c.d.pnr ?? ''} (imported, no parent invoice found)`.slice(0, 250), legs: [{ account_id: rev, debit: base }, { account_id: ar, credit: base }] });
        await link(c.txnId, { voucher_id: vid });
      }
      credits++;
    } catch (e: any) { notPosted.push({ invoice_no: c.d.invoice_no, why: e.message }); }
  }
  return { invoices, credits, notPosted };
}
