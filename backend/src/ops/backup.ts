/**
 *   npm run backup                      full logical backup → backups/ (gzip, optional AES-256-GCM, sha256, manifest, retention)
 *   npm run backup:verify [file]        restore the newest (or given) backup into a scratch database and prove it is sound
 *   npm run backup:restore <file> <db>  restore into an EMPTY database (refuses to touch a non-empty one)
 *
 * Env: DATABASE_URL, BACKUP_DIR (default ./backups), BACKUP_KEEP (default 14), BACKUP_PASSPHRASE (optional but recommended:
 * backups contain personal data), MYSQLDUMP / MYSQL (binary names).
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import mysql from 'mysql2/promise';

const url = new URL(process.env.DATABASE_URL ?? '');
const DB = url.pathname.slice(1), dir = path.resolve(process.env.BACKUP_DIR ?? 'backups'), keep = Number(process.env.BACKUP_KEEP ?? 14), pass = process.env.BACKUP_PASSPHRASE;
const bin = (n: string) => process.env[n.toUpperCase()] ?? n;
const KEY_TABLES = ['agencies', 'users', 'memberships', 'clients', 'suppliers', 'bookings', 'invoices', 'receipts', 'supplier_bills', 'payments', 'vouchers', 'gl_entries', 'audit_log', 'accounts'];
const MAGIC = Buffer.from('TFB1');

/** Credentials go in a 0600 option file, never on the command line (visible in `ps`). */
function optionFile(): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tfb-')), 'my.cnf');
  fs.writeFileSync(f, `[client]\nuser=${decodeURIComponent(url.username)}\npassword="${decodeURIComponent(url.password).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nhost=${url.hostname}\nport=${url.port || 3306}\n`, { mode: 0o600 });
  return f;
}
const conn = (database?: string) => mysql.createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database, multipleStatements: false });
async function counts(c: mysql.Connection, db: string) { const out: Record<string, number> = {}; for (const t of KEY_TABLES) { const [[r]]: any = await c.query(`SELECT COUNT(*) n FROM \`${db}\`.\`${t}\``); out[t] = r.n; } return out; }
const sha = (f: string) => new Promise<string>((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
const key = (salt: Buffer) => crypto.scryptSync(pass!, salt, 32);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export async function backup() {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const c = await conn(), before = await counts(c, DB), cnf = optionFile();
  const file = path.join(dir, `${DB}-${stamp()}.sql.gz${pass ? '.enc' : ''}`);
  const dump = spawn(bin('mysqldump'), [`--defaults-extra-file=${cnf}`, '--single-transaction', '--routines', '--triggers', '--events', '--hex-blob', '--set-gtid-purged=OFF', '--no-tablespaces', DB], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; dump.stderr.on('data', (d) => (err += d)); const exit = new Promise<number>((r) => dump.on('close', r));
  const out = fs.createWriteStream(file, { mode: 0o600 });
  try {
    if (pass) {
      const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key(salt), iv);
      out.write(Buffer.concat([MAGIC, salt, iv]));
      await pipeline(dump.stdout, zlib.createGzip({ level: 9 }), cipher, out, { end: false } as any);
      out.end(cipher.getAuthTag()); await new Promise<void>((r) => out.on('close', () => r()));
    } else await pipeline(dump.stdout, zlib.createGzip({ level: 9 }), out);
    if ((await exit) !== 0) throw new Error(`mysqldump failed: ${err.trim()}`);
  } catch (e) { fs.rmSync(file, { force: true }); throw e; } finally { fs.rmSync(path.dirname(cnf), { recursive: true, force: true }); }
  const after = await counts(c, DB); await c.end();
  const checksum = await sha(file), size = fs.statSync(file).size;
  fs.writeFileSync(`${file}.json`, JSON.stringify({ database: DB, created: new Date().toISOString(), size, sha256: checksum, encrypted: !!pass, counts_before: before, counts_after: after, migrations: fs.readdirSync(path.resolve('sql/migrations')).filter((f) => f.endsWith('.sql')).length }, null, 2), { mode: 0o600 });
  // retention: keep the newest N complete backups
  const all = fs.readdirSync(dir).filter((f) => /\.sql\.gz(\.enc)?$/.test(f)).sort().reverse();
  for (const old of all.slice(keep)) for (const x of [old, `${old}.json`]) fs.rmSync(path.join(dir, x), { force: true });
  console.log(`backup ok: ${file} (${(size / 1048576).toFixed(2)} MB, sha256 ${checksum.slice(0, 16)}…, ${pass ? 'encrypted' : 'NOT encrypted — set BACKUP_PASSPHRASE'}); kept ${Math.min(all.length, keep)}`);
  return file;
}

async function decryptedStream(file: string): Promise<NodeJS.ReadableStream> {
  if (!file.endsWith('.enc')) return fs.createReadStream(file).pipe(zlib.createGunzip());
  if (!pass) throw new Error('This backup is encrypted: set BACKUP_PASSPHRASE');
  const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size, head = Buffer.alloc(32), tag = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 32, 0); fs.readSync(fd, tag, 0, 16, size - 16); fs.closeSync(fd);
  if (!head.subarray(0, 4).equals(MAGIC)) throw new Error('Not a TravelFinance backup');
  const d = crypto.createDecipheriv('aes-256-gcm', key(head.subarray(4, 20)), head.subarray(20, 32)); d.setAuthTag(tag);
  return fs.createReadStream(file, { start: 32, end: size - 17 }).pipe(d).pipe(zlib.createGunzip());
}

export async function restore(file: string, target: string) {
  if (target === DB) throw new Error(`Refusing to restore over the live database "${DB}"`);
  if (!/^[A-Za-z0-9_]+$/.test(target)) throw new Error('Bad database name');
  const man = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')); if (man.sha256 !== (await sha(file))) throw new Error('Checksum mismatch — the backup file is corrupt or was modified');
  const c = await conn();
  const [[ex]]: any = await c.query('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ?', [target]);
  if (ex.n > 0) throw new Error(`Database ${target} is not empty`);
  await c.query(`CREATE DATABASE IF NOT EXISTS \`${target}\` CHARACTER SET utf8mb4`); await c.end();
  const cnf = optionFile(), cli = spawn(bin('mysql'), [`--defaults-extra-file=${cnf}`, target], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = ''; cli.stderr.on('data', (d) => (err += d)); const exit = new Promise<number>((r) => cli.on('close', r));
  try { await pipeline(await decryptedStream(file), cli.stdin); if ((await exit) !== 0) throw new Error(`mysql restore failed: ${err.trim()}`); } finally { fs.rmSync(path.dirname(cnf), { recursive: true, force: true }); }
  return man;
}

/** Restore into a scratch database and check the things that matter: file integrity, row counts, ledger balance, append-only triggers, migrations. */
export async function verify(file?: string) {
  const f = file ?? fs.readdirSync(dir).filter((x) => /\.sql\.gz(\.enc)?$/.test(x)).sort().reverse().map((x) => path.join(dir, x))[0];
  if (!f) throw new Error('No backup found');
  const scratch = `${DB.replace(/_test$/, '')}_restore_check`, c = await conn(), problems: string[] = [];
  await c.query(`DROP DATABASE IF EXISTS \`${scratch}\``);
  try {
    const man = await restore(f, scratch), got = await counts(c, scratch);
    for (const t of KEY_TABLES) if (got[t] < (man.counts_before[t] ?? 0) || got[t] > (man.counts_after[t] ?? Infinity)) problems.push(`${t}: restored ${got[t]} rows, expected ${man.counts_before[t]}–${man.counts_after[t]}`);
    const [[g]]: any = await c.query(`SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) cr FROM \`${scratch}\`.gl_entries`);
    if (Math.abs(g.d - g.cr) > 0.005) problems.push(`ledger does not balance after restore (debit ${g.d}, credit ${g.cr})`);
    const [[tr]]: any = await c.query('SELECT COUNT(*) n FROM information_schema.triggers WHERE trigger_schema = ? AND event_object_table IN (\'audit_log\', \'security_events\')', [scratch]);
    if (tr.n < 2) problems.push('append-only audit triggers are missing from the restored database');
    const [[m]]: any = await c.query(`SELECT COUNT(*) n FROM \`${scratch}\`.schema_migrations`);
    if (m.n !== man.migrations) problems.push(`migrations: restored ${m.n}, backup recorded ${man.migrations}`);
    console.log(`restore check of ${path.basename(f)}: ${problems.length ? 'FAILED' : 'OK'}\n  rows: ${KEY_TABLES.map((t) => `${t}=${got[t]}`).join(' ')}\n  ledger debit=${g.d} credit=${g.cr}, triggers=${tr.n}, migrations=${m.n}`);
    for (const p of problems) console.log('  ✗ ' + p);
  } finally { await c.query(`DROP DATABASE IF EXISTS \`${scratch}\``); await c.end(); }
  if (problems.length) throw new Error('restore verification failed');
}

const [cmd, a1, a2] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  (cmd === 'verify' ? verify(a1) : cmd === 'restore' ? restore(path.resolve(a1), a2).then(() => console.log(`restored into ${a2}`)) : backup())
    .then(() => process.exit(0)).catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
