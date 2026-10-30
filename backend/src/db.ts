import mysql, { Pool, PoolConnection } from 'mysql2/promise';
import { config } from './config.js';
import { HttpError } from './errors.js';

export const pool: Pool = mysql.createPool({
  uri: config.databaseUrl,
  decimalNumbers: true,
  timezone: 'Z',
  connectionLimit: 10,
  dateStrings: true,
});

export interface Actor { userId: number | null; ip?: string | null }

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s: string) => {
  if (!IDENT.test(s)) throw new Error(`Bad identifier: ${s}`);
  return s;
};

/**
 * Tenant-scoped data access. Every query goes through here, so isolation is enforced in one place:
 *  - raw `query()` calls MUST mention agency_id (guard rejects otherwise)
 *  - insert/update/remove inject agency_id automatically and write the append-only audit log
 */
export class Tenant {
  constructor(
    readonly agencyId: number,
    readonly actor: Actor,
    private conn: Pool | PoolConnection = pool,
    readonly inTx = false,
  ) {}

  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    if (!/agency_id/i.test(sql)) throw new Error('Tenant.query requires an agency_id predicate');
    const [rows] = await this.conn.query(sql, params);
    return rows as T[];
  }

  async one<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  /** The agencies table is the tenant root (no agency_id column), so it gets dedicated accessors. */
  async agency(forUpdate = false): Promise<any> {
    const [r]: any = await this.conn.query(`SELECT * FROM agencies WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [this.agencyId]);
    return r[0];
  }

  /** Update columns of the tenant's own agency row (column names validated). */
  async updateAgency(fields: Record<string, any>): Promise<void> {
    const cols = Object.keys(fields).map(ident); if (!cols.length) return;
    await this.conn.query(`UPDATE agencies SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE id = ?`, [...Object.values(fields), this.agencyId]);
  }

  async takeInvoiceNumber(): Promise<string> {
    const a = await this.agency(true);
    await this.conn.query('UPDATE agencies SET next_invoice_no = next_invoice_no + 1 WHERE id = ?', [this.agencyId]);
    return `${a.invoice_prefix}${String(a.next_invoice_no).padStart(5, '0')}`;
  }

  /**
   * Validates a client-supplied foreign key belongs to THIS agency. Foreign and non-existent ids produce the same
   * error (no existence leak) and a security event is recorded for foreign-or-missing references.
   */
  async ref(table: string, id: number | null | undefined, label = table): Promise<void> {
    if (id === null || id === undefined) return;
    const r = await this.one(`SELECT id FROM ${ident(table)} WHERE agency_id = ? AND id = ?`, [this.agencyId, id]);
    if (!r) {
      await pool.query('INSERT INTO security_events (agency_id, user_id, ip, event, detail) VALUES (?,?,?,?,?)',
        [this.agencyId, this.actor.userId, this.actor.ip ?? null, 'foreign_reference_denied', `${table}#${id}`]).catch(() => {});
      throw new HttpError(400, `Unknown ${label.replace(/_/g, ' ')}`);
    }
  }

  /** ref() for NEW work (new bookings, invoices, quotes, bills): an archived client or supplier cannot be attached. Reading, receipts and statements still use plain ref(). */
  async refActive(table: 'clients' | 'suppliers', id: number | null | undefined, label: string = table): Promise<void> {
    if (id === null || id === undefined) return;
    await this.ref(table, id, label);
    const r = await this.one<any>(`SELECT archived_at FROM ${ident(table)} WHERE agency_id = ? AND id = ?`, [this.agencyId, id]);
    if (r?.archived_at) throw Object.assign(new HttpError(409, `This ${label} is archived — restore it before adding new records to it.`), { code: 'archived' });
  }

  /** Same as ref() but for a user id that must be a member of this agency. */
  async memberRef(userId: number | null | undefined, label = 'user'): Promise<void> {
    if (userId === null || userId === undefined) return;
    const r = await this.one('SELECT id FROM memberships WHERE agency_id = ? AND user_id = ?', [this.agencyId, userId]);
    if (!r) throw new HttpError(400, `Unknown ${label}`);
  }

  /** Throws if `date` falls inside a locked accounting period. */
  async assertPeriodOpen(date: string): Promise<void> {
    const a = await this.agency();
    if (a?.locked_through && String(date) <= String(a.locked_through))
      throw new HttpError(409, `Period is locked through ${a.locked_through}; use a later date or reopen the period`);
  }

  /** Public audit hook for changes that don't go through insert/update/remove (settings, period locks...). */
  async event(action: 'create' | 'update' | 'delete', entity: string, entityId: number | null, before: any, after: any, reason?: string) {
    await this.audit(action, entity, entityId as number, before, after, reason);
  }

  async get<T = any>(table: string, id: number): Promise<T | undefined> {
    return this.one<T>(`SELECT * FROM ${ident(table)} WHERE agency_id = ? AND id = ?`, [this.agencyId, id]);
  }

  /** Insert without an audit row — for high-volume system tables (webhook outbox). agency_id must be supplied by the caller. */
  async rawInsert(table: string, row: Record<string, any>): Promise<number> {
    if (row.agency_id !== this.agencyId) throw new Error('rawInsert: agency mismatch');
    const cols = Object.keys(row).map(ident);
    const [res]: any = await this.conn.query(`INSERT INTO ${ident(table)} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, Object.values(row));
    return res.insertId;
  }

  async insert(table: string, data: Record<string, any>): Promise<number> {
    const row = { ...data, agency_id: this.agencyId };
    const cols = Object.keys(row).map(ident);
    const [res]: any = await this.conn.query(
      `INSERT INTO ${ident(table)} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      Object.values(row),
    );
    await this.audit('create', table, res.insertId, null, row);
    return res.insertId;
  }

  async update(table: string, id: number, data: Record<string, any>): Promise<void> {
    const before = await this.get(table, id);
    if (!before) throw new HttpError(404, 'Not found');
    const cols = Object.keys(data).map(ident);
    if (!cols.length) return;
    await this.conn.query(
      `UPDATE ${ident(table)} SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE agency_id = ? AND id = ?`,
      [...Object.values(data), this.agencyId, id],
    );
    await this.audit('update', table, id, before, data);
  }

  async remove(table: string, id: number): Promise<void> {
    const before = await this.get(table, id);
    if (!before) throw new HttpError(404, 'Not found');
    await this.conn.query(`DELETE FROM ${ident(table)} WHERE agency_id = ? AND id = ?`, [this.agencyId, id]);
    await this.audit('delete', table, id, before, null);
  }

  /** Run fn inside a transaction; all writes (and their audit rows) commit or roll back together. */
  async tx<T>(fn: (t: Tenant) => Promise<T>): Promise<T> {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const out = await fn(new Tenant(this.agencyId, this.actor, c, true));
      await c.commit();
      return out;
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }

  private async audit(action: string, entity: string, entityId: number, before: any, after: any, reason?: string) {
    await this.conn.query(
      `INSERT INTO audit_log (agency_id, user_id, ip, action, entity, entity_id, before_json, after_json, reason)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        this.agencyId, this.actor.userId, this.actor.ip ?? null, action, entity, entityId,
        before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason ?? null,
      ],
    );
  }
}
