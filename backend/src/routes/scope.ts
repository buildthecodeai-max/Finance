import type { Request } from 'express';
import { HttpError } from '../errors.js';
import type { Tenant } from '../db.js';

/** SQL fragment limiting rows to what the caller may see: agents → own records, branch-scoped users → their branch. */
export function scope(req: Request, alias: string, opts: { owner?: string; branch?: string | null } = {}) {
  const owner = opts.owner ?? 'owner_id', branch = opts.branch === undefined ? 'branch_id' : opts.branch;
  const parts: string[] = [], params: any[] = [];
  if (req.ctx!.role === 'agent') { parts.push(`${alias}.${owner} = ?`); params.push(req.ctx!.userId); }
  if (req.ctx!.branchId && branch) { parts.push(`${alias}.${branch} = ?`); params.push(req.ctx!.branchId); }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

/** Fetch one row the caller may see, or 404 (never reveals whether an out-of-scope row exists). */
export async function findScoped<T = any>(t: Tenant, req: Request, table: string, id: number, opts: { owner?: string; branch?: string | null } = {}): Promise<T> {
  const s = scope(req, 'x', opts);
  const row = await t.one<T>(`SELECT x.* FROM ${table} x WHERE x.agency_id = ? AND x.id = ?${s.sql}`, [t.agencyId, id, ...s.params]);
  if (!row) throw new HttpError(404, 'Not found');
  return row;
}

/** Agents may only modify records they own; finance/admin may modify any. */
export function assertCanEdit(req: Request, row: { [k: string]: any }, ownerCol = 'owner_id') {
  if (req.ctx!.role === 'viewer') throw new HttpError(403, 'Read-only role');
  if (req.ctx!.role === 'agent' && row[ownerCol] !== req.ctx!.userId) throw new HttpError(403, 'You can only edit your own records');
}
