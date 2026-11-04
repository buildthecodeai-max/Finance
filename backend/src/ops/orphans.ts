/**
 * Rows left behind by agencies that no longer exist (tenant isolation is enforced in code, so the database has no foreign keys to clean them up).
 *   npm run db:orphans             report only — changes nothing
 *   npm run db:orphans -- --apply  delete them in one transaction (run `npm run backup` first)
 * The append-only evidence tables (audit_log, security_events, period_locks, booking_changes, platform_audit_log) are never touched.
 */
import 'dotenv/config';
import { pool } from '../db.js';
import { tenantTables } from '../services/platform.js';

const apply = process.argv.includes('--apply');
const where = 'agency_id NOT IN (SELECT id FROM agencies)';
try {
  const found: { table: string; rows: number }[] = [];
  for (const t of await tenantTables()) {
    const [[r]]: any = await pool.query(`SELECT COUNT(*) n FROM \`${t}\` WHERE ${where}`);
    if (r.n) found.push({ table: t, rows: r.n });
  }
  if (!found.length) console.log('No orphaned rows.');
  else {
    console.table(found);
    if (!apply) console.log('Report only. Run `npm run backup`, then re-run with --apply to delete these rows.');
    else {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const { table } of found) await conn.query(`DELETE FROM \`${table}\` WHERE ${where}`);
        await conn.commit();
        console.log(`Deleted ${found.reduce((s, f) => s + f.rows, 0)} orphaned rows from ${found.length} tables.`);
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    }
  }
} catch (e: any) { console.error(e.message); process.exitCode = 1; }
await pool.end();
