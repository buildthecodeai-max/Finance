import { HttpError } from '../errors.js';
import { Tenant, pool } from '../db.js';

let colCache: Map<string, string[]> | null = null;
/** tables that have both agency_id and the given column (e.g. client_id), discovered from the schema so new tables are covered automatically */
async function tablesWith(column: string): Promise<string[]> {
  if (!colCache) {
    const [rows]: any = await pool.query(`SELECT table_name t, column_name c FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name IN ('client_id','supplier_id','branch_id','booking_id','agent_id','owner_id') AND table_name IN (SELECT table_name FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'agency_id')`);
    colCache = new Map(); for (const r of rows) colCache.set(r.c, [...(colCache.get(r.c) ?? []), r.t]);
  }
  return colCache.get(column) ?? [];
}

const LABEL: Record<string, string> = { invoices: 'invoices', bookings: 'bookings', quotes: 'quotes', receipts: 'receipts', payments: 'payments', credit_notes: 'credit notes', client_refunds: 'refunds', leads: 'leads', travellers: 'travellers',
  booking_components: 'booking components', supplier_bills: 'supplier bills', invoice_lines: 'invoice lines', itinerary_items: 'itinerary items', payment_run_items: 'payment-run items', quote_components: 'quote components', commission_rules: 'commission rules',
  supplier_commissions: 'supplier commissions', accounts: 'ledger accounts', memberships: 'team members', refunds: 'refunds', ticket_invoices: 'ticket invoices', commission_entries: 'commission entries', commission_splits: 'commission splits', commissions: 'commissions', booking_travellers: 'travellers on bookings' };
export type Dep = { table: string; label: string; n: number };

/** Everything that points at this record, with counts. `ignore` lists tables that are cleaned up together with the record. */
export async function dependents(t: Tenant, column: 'client_id' | 'supplier_id' | 'branch_id' | 'booking_id', id: number, ignore: string[] = []): Promise<Dep[]> {
  const out: Dep[] = [];
  for (const table of await tablesWith(column)) {
    if (ignore.includes(table) || table === 'booking_changes') continue;
    const [[r]]: any = await pool.query(`SELECT COUNT(*) n FROM \`${table}\` WHERE agency_id = ? AND \`${column}\` = ?`, [t.agencyId, id]);
    if (r.n) out.push({ table, label: LABEL[table] ?? table.replace(/_/g, ' '), n: r.n });
  }
  return out;
}
export const depText = (d: Dep[]) => d.map((x) => `${x.n} ${x.label}`).join(', ');

export const ARCHIVABLE = { clients: 'client', suppliers: 'supplier' } as const;
export async function archive(t: Tenant, table: keyof typeof ARCHIVABLE, id: number) {
  const row = await t.get(table, id); if (!row) throw new HttpError(404, `${ARCHIVABLE[table]} not found`);
  if (row.archived_at) return;
  await t.update(table, id, { archived_at: new Date().toISOString().slice(0, 19).replace('T', ' '), archived_by: t.actor.userId });
}
export async function restore(t: Tenant, table: keyof typeof ARCHIVABLE | 'bookings', id: number) {
  const row = await t.get(table, id); if (!row) throw new HttpError(404, 'Not found');
  if (!row.archived_at) return;
  await t.update(table, id, { archived_at: null, archived_by: null, ...(table === 'bookings' ? { archive_reason: null } : {}) });
}

/** Hard-delete a client or supplier only when nothing depends on it; otherwise explain exactly what, and point to Archive. */
export async function deleteParty(t: Tenant, table: 'clients' | 'suppliers', id: number) {
  const col = table === 'clients' ? 'client_id' : 'supplier_id', cascade = table === 'clients' ? ['portal_links', 'support_requests'] : [];
  const row = await t.get(table, id); if (!row) throw new HttpError(404, 'Not found');
  const deps = await dependents(t, col, id, cascade);
  if (deps.length) throw Object.assign(new HttpError(409, `This ${ARCHIVABLE[table]} has ${depText(deps)}, so it can't be deleted — archive it instead (it disappears from lists and pickers but all history is kept).`), { code: 'has_dependents', deps });
  await t.tx(async (tx) => {
    for (const c of cascade) await tx.query(`DELETE FROM \`${c}\` WHERE agency_id = ? AND \`${col}\` = ?`, [tx.agencyId, id]);
    if (table === 'clients') { await tx.query(`DELETE FROM tasks WHERE agency_id = ? AND entity_type = 'client' AND entity_id = ?`, [tx.agencyId, id]); await tx.query(`DELETE FROM activities WHERE agency_id = ? AND entity_type = 'client' AND entity_id = ?`, [tx.agencyId, id]); }
    await tx.remove(table, id);
  });
}

/** Archive (soft-delete) a booking. Refused while live financial documents hang off it; its estimated commission is reversed by the recalc. */
export async function archiveBooking(t: Tenant, id: number, reason: string) {
  const b = await t.get('bookings', id); if (!b) throw new HttpError(404, 'Booking not found'); if (b.archived_at) return;
  const [[inv]]: any = await pool.query(`SELECT COUNT(*) n FROM invoices WHERE agency_id = ? AND booking_id = ? AND status <> 'void'`, [t.agencyId, id]);
  const [[bills]]: any = await pool.query(`SELECT COUNT(*) n FROM supplier_bills WHERE agency_id = ? AND booking_id = ? AND status <> 'void'`, [t.agencyId, id]);
  const [[com]]: any = await pool.query(`SELECT COUNT(*) n FROM commission_entries WHERE agency_id = ? AND booking_id = ? AND status IN ('approved','paid')`, [t.agencyId, id]);
  const blockers = [inv.n && `${inv.n} invoice(s)`, bills.n && `${bills.n} supplier bill(s)`, com.n && `${com.n} approved/paid commission entr${com.n === 1 ? 'y' : 'ies'}`].filter(Boolean);
  if (blockers.length) throw Object.assign(new HttpError(409, `This booking has ${blockers.join(', ')}. Void or credit them first — or set the booking to Cancelled to keep the history.`), { code: 'has_dependents' });
  await t.tx(async (tx) => {
    await tx.query('INSERT INTO booking_changes (agency_id, booking_id, field, old_value, new_value, reason, user_id) VALUES (?,?,?,?,?,?,?)', [tx.agencyId, id, 'archived', null, 'yes', reason, tx.actor.userId]);
    await tx.update('bookings', id, { archived_at: new Date().toISOString().slice(0, 19).replace('T', ' '), archived_by: tx.actor.userId, archive_reason: reason });
  });
}
export async function restoreBooking(t: Tenant, id: number, reason: string) {
  const b = await t.get('bookings', id); if (!b) throw new HttpError(404, 'Booking not found'); if (!b.archived_at) return;
  await t.ref('clients', b.client_id, 'client');   // cannot restore into an archived client
  await t.tx(async (tx) => { await tx.query('INSERT INTO booking_changes (agency_id, booking_id, field, old_value, new_value, reason, user_id) VALUES (?,?,?,?,?,?,?)', [tx.agencyId, id, 'archived', 'yes', null, reason, tx.actor.userId]); await tx.update('bookings', id, { archived_at: null, archived_by: null, archive_reason: null }); });
}

/* ------------------------------------------------------------------ team & branches */
const adminCount = async (t: Tenant, excludeMembershipId?: number) => ((await pool.query(`SELECT COUNT(*) n FROM memberships WHERE agency_id = ? AND role = 'admin' ${excludeMembershipId ? 'AND id <> ?' : ''}`, excludeMembershipId ? [t.agencyId, excludeMembershipId] : [t.agencyId])) as any)[0][0].n as number;

export async function changeMember(t: Tenant, id: number, patch: Record<string, any>, actorUserId: number) {
  const m = await t.get('memberships', id); if (!m) throw new HttpError(404, 'Team member not found');
  if (patch.role && patch.role !== 'admin' && m.role === 'admin' && (await adminCount(t, id)) === 0) throw new HttpError(409, 'This is the only admin. Make someone else an admin first.');
  if (patch.role && m.user_id === actorUserId && patch.role !== m.role && m.role === 'admin') throw new HttpError(409, 'You cannot demote yourself. Ask another admin.');
  await t.ref('branches', patch.branch_id, 'branch'); await t.update('memberships', id, patch);
}
export async function removeMember(t: Tenant, id: number, actorUserId: number, reassignTo?: number | null) {
  const m = await t.get('memberships', id); if (!m) throw new HttpError(404, 'Team member not found');
  if (m.user_id === actorUserId) throw new HttpError(409, 'You cannot remove yourself. Ask another admin.');
  if (m.role === 'admin' && (await adminCount(t, id)) === 0) throw new HttpError(409, 'This is the only admin and cannot be removed.');
  if (reassignTo) { await t.memberRef(reassignTo, 'new owner'); if (reassignTo === m.user_id) throw new HttpError(400, 'Choose someone else'); }
  const moved: Record<string, number> = {};
  await t.tx(async (tx) => {
    if (reassignTo) for (const [table, col] of [['leads', 'owner_id'], ['bookings', 'agent_id'], ['quotes', 'owner_id'], ['tasks', 'owner_id']] as const) {
      const r: any = await tx.query(`UPDATE \`${table}\` SET \`${col}\` = ? WHERE agency_id = ? AND \`${col}\` = ?`, [reassignTo, tx.agencyId, m.user_id]); moved[table] = r.affectedRows;
    }
    await tx.remove('memberships', id);   // the user account itself is untouched (they may belong to other agencies); access to this agency ends immediately
  });
  return { reassigned: moved };
}
export async function memberWorkload(t: Tenant, userId: number) {
  const q = async (sql: string) => ((await pool.query(sql, [t.agencyId, userId])) as any)[0][0].n as number;
  return { leads: await q("SELECT COUNT(*) n FROM leads WHERE agency_id = ? AND owner_id = ? AND stage NOT IN ('won','lost')"), bookings: await q("SELECT COUNT(*) n FROM bookings WHERE agency_id = ? AND agent_id = ? AND archived_at IS NULL AND status NOT IN ('closed','cancelled','lost')"),
    quotes: await q("SELECT COUNT(*) n FROM quotes WHERE agency_id = ? AND owner_id = ? AND status IN ('draft','sent')"), tasks: await q("SELECT COUNT(*) n FROM tasks WHERE agency_id = ? AND owner_id = ? AND status = 'open'") };
}
export async function renameBranch(t: Tenant, id: number, name: string) { if (!(await t.get('branches', id))) throw new HttpError(404, 'Branch not found'); await t.update('branches', id, { name }); }
export async function deleteBranch(t: Tenant, id: number) {
  if (!(await t.get('branches', id))) throw new HttpError(404, 'Branch not found');
  const deps = await dependents(t, 'branch_id', id);
  if (deps.length) throw Object.assign(new HttpError(409, `This branch is used by ${depText(deps)}. Move them to another branch first.`), { code: 'has_dependents', deps });
  await t.remove('branches', id);
}
