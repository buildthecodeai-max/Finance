import { Tenant } from '../db.js';
import { r2, today } from './money.js';

/**
 * Recompute amount_paid / amount_credited / status from source records (single source of truth):
 *  paid     = non-voided inbound allocations − paid client refunds
 *  credited = issued credit notes
 * Outstanding = total − credited − paid. A surplus (paid + credited > total) is client credit awaiting refund.
 */
export async function syncInvoicePaid(t: Tenant, invoiceId: number) {
  const inv = await t.get('invoices', invoiceId);
  if (!inv) throw new Error('Invoice not found');
  const inb = await t.one<{ s: number }>(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE agency_id = ? AND invoice_id = ? AND direction = 'inbound' AND voided = 0`, [t.agencyId, invoiceId]);
  const out = await t.one<{ s: number }>(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE agency_id = ? AND invoice_id = ? AND direction = 'outbound' AND client_id IS NOT NULL AND voided = 0`, [t.agencyId, invoiceId]);
  const cr = await t.one<{ s: number }>(`SELECT COALESCE(SUM(total),0) s FROM credit_notes WHERE agency_id = ? AND invoice_id = ? AND status = 'issued'`, [t.agencyId, invoiceId]);
  const paid = r2(inb!.s - out!.s), credited = r2(cr!.s);
  let status = inv.status;
  if (['sent', 'partially_paid', 'overdue', 'paid', 'credited'].includes(inv.status)) {
    const settled = paid + credited >= inv.total - 0.005;
    if (settled) status = credited >= inv.total - 0.005 ? 'credited' : 'paid';
    else if (paid + credited > 0) status = inv.due_date < today() ? 'overdue' : 'partially_paid';
    else status = inv.due_date < today() ? 'overdue' : 'sent';
  }
  await t.update('invoices', invoiceId, { amount_paid: paid, amount_credited: credited, status });
  let remaining = Math.max(0, paid);
  const inst = await t.query('SELECT id, amount FROM invoice_installments WHERE agency_id = ? AND invoice_id = ? ORDER BY due_date', [t.agencyId, invoiceId]);
  for (const i of inst) {
    const covered = remaining >= i.amount; if (covered) remaining = r2(remaining - i.amount);
    await t.query('UPDATE invoice_installments SET paid = ? WHERE agency_id = ? AND id = ?', [covered ? 1 : 0, t.agencyId, i.id]);
  }
  return { paid, credited, status, outstanding: r2(inv.total - credited - paid) };
}

export const NEXT: Record<string, string[]> = {
  draft: ['reviewed', 'void'],
  reviewed: ['sent', 'draft', 'void'],
  sent: ['void'],
  partially_paid: [],
  overdue: ['void'],
  paid: [],
  credited: [],
  void: [],
};
