// External Import — the database side: batches, staging rows, duplicate detection, commit, rollback, reconciliation and reports.
import crypto from 'node:crypto';
import { HttpError } from '../../errors.js';
import { Tenant, pool } from '../../db.js';
import { fileKey, getFile, putFile } from '../../storage.js';
import { FIELDS, Field, Rec, SheetLayout, Totals, analyzeGrid, normaliseRow, parseAmount, readFile, strongKey, weakKey, paxKey, splitSector, RawRow } from './engine.js';
import { postImported } from './post.js';
import { voidInvoice, voidCreditNote } from '../finance.js';
import { reverseVoucher } from '../accounting.js';
import { CONFIRM_AT, Match, buildOpen, matchPayment, reserve } from './match.js';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const MAX_ROWS = 20000;
export const MAX_BYTES = 25 * 1024 * 1024;
const j = (v: unknown) => JSON.stringify(v ?? null);
const parseJ = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);

export async function ev(t: Tenant, batchId: number | null, action: string, detail: string, extra: { txn_id?: number | null; before?: unknown; after?: unknown } = {}) {
  await t.rawInsert('ext_events', { agency_id: t.agencyId, batch_id: batchId, txn_id: extra.txn_id ?? null, action, detail: detail.slice(0, 500), before_json: extra.before ? j(extra.before) : null, after_json: extra.after ? j(extra.after) : null, user_id: t.actor.userId });
}
const setBatch = (agencyId: number, id: number, f: Record<string, any>) => {
  const cols = Object.keys(f); return pool.query(`UPDATE ext_batches SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE agency_id = ? AND id = ?`, [...Object.values(f), agencyId, id]);
};
export async function getBatch(t: Tenant, id: number) {
  const b = await t.get('ext_batches', id); if (!b) throw new HttpError(404, 'Import not found');
  for (const k of ['sheets', 'control'] as const) b[k] = parseJ(b[k]);
  return b;
}

/* ───────────────────────────── upload & first pass ───────────────────────────── */

export async function createBatch(t: Tenant, fileName: string, buf: Buffer) {
  if (!buf.length) throw new HttpError(400, 'The file is empty');
  if (buf.length > MAX_BYTES) throw new HttpError(413, 'File too large (25 MB max)');
  const { detectFormat } = await import('./engine.js'); const format = detectFormat(fileName, buf);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const same = await t.one<any>(`SELECT id, status FROM ext_batches WHERE agency_id = ? AND file_hash = ? AND status IN ('review','imported','importing') ORDER BY id DESC LIMIT 1`, [t.agencyId, hash]);
  const key = await putFile(fileKey(t.agencyId, 'external-imports', fileName.replace(/[^\w.\- ]+/g, '_')), buf, 'application/octet-stream');
  const id = await t.insert('ext_batches', { file_name: fileName.slice(0, 255), file_format: format, file_size: buf.length, file_hash: hash, file_key: key, status: 'processing', stage: 'Queued', progress: 2, uploaded_by: t.actor.userId });
  await ev(t, id, 'uploaded', `${fileName} (${format}, ${(buf.length / 1024).toFixed(0)} KB)`);
  return { id, same_file: same ?? null };
}

/** Runs in the background after the upload returns; the page polls stage/progress. Any failure ends in status "failed" with a readable message. */
export async function processBatch(agencyId: number, actor: Tenant['actor'], id: number) {
  const t = new Tenant(agencyId, actor);
  try {
    const b = await getBatch(t, id);
    await setBatch(agencyId, id, { stage: 'Reading file', progress: 10 });
    const { grids } = await readFile(b.file_name, await getFile(b.file_key));
    await setBatch(agencyId, id, { stage: 'Detecting columns', progress: 35 });
    const tpl = await templateLabels(t);
    const sheets: (SheetLayout & { include: boolean })[] = [], rows: RawRow[] = [], totals: Totals[] = [], pairs: Record<string, Record<string, number>> = {};
    for (const g of grids) {
      const a = analyzeGrid(g, tpl);
      sheets.push({ ...a.layout, include: a.layout.kind === 'table' && a.layout.rowCount > 0 });
      if (a.layout.kind === 'table') { rows.push(...a.rows); totals.push(...a.totals); }
      else if (a.layout.kind === 'reference' && Object.keys(a.pairs).length) pairs[g.name] = a.pairs;
    }
    if (!sheets.some((s) => s.kind === 'table')) throw new HttpError(422, 'No table with recognisable column headings was found in this file. Check that it has a header row (e.g. Passenger, PNR, Date, Amount).');
    if (rows.length > MAX_ROWS) throw new HttpError(413, `This file has ${rows.length} lines; the limit is ${MAX_ROWS} per import. Split it by date range.`);
    await setBatch(agencyId, id, { stage: 'Saving rows', progress: 55 });
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await pool.query('INSERT INTO ext_rows (agency_id, batch_id, sheet, src_row, section, raw) VALUES ?', [chunk.map((r) => [agencyId, id, r.sheet, r.src_row, r.section, j({ cells: r.cells })])]);
    }
    const first = sheets.find((s) => s.kind === 'table');
    let payer = guessPayer(first?.title ?? '');
    if (!payer) {                                  // no title to read it from: use the file's own payer/customer column if it names exactly one party
      const names = new Set<string>();
      for (const r of rows) { const sh = sheets.find((x) => x.name === r.sheet); const c = sh?.map.payer; const v = c === undefined ? null : r.cells[c]; if (typeof v === 'string' && v.trim()) names.add(v.trim().toUpperCase()); }
      if (names.size === 1) payer = [...names][0];
    }
    const client = payer ? await findClient(t, payer) : undefined;
    const cur = detectCurrency(first?.title ?? '', first?.headers ?? []);
    await setBatch(agencyId, id, { sheets: j(sheets), control: j({ totals, pairs, sheets: [] }), payer_name: client?.name ?? payer, payer_client_id: client?.id ?? null, currency: cur, stage: 'Validating', progress: 70 });
    await rebuild(t, id);
    await ev(t, id, 'parsed', `${rows.length} lines read from ${sheets.filter((s) => s.kind === 'table').length} sheet(s)`);
  } catch (e: any) {
    await setBatch(agencyId, id, { status: 'failed', stage: 'Failed', error: String(e instanceof HttpError ? e.message : 'The file could not be processed').slice(0, 500) });
    await ev(t, id, 'failed', String(e?.message ?? e)).catch(() => {});
    if (!(e instanceof HttpError)) console.error('external import failed', e);
  }
}

const guessPayer = (title: string) => { const m = /^(.*?)\s+(?:MONTH\s+OF|SOA|STATEMENT|INVOICES?|FOR\s+THE|\()/i.exec(title.trim()); const s = (m?.[1] ?? '').trim(); return s.length >= 3 && s.length < 80 ? s.toUpperCase() : null; };
const detectCurrency = (title: string, headers: string[]) => { const m = /\b(PKR|USD|AED|SAR|GBP|EUR|INR|QAR|OMR|KWD|BHD)\b/i.exec(`${title} ${headers.join(' ')}`); return m ? m[1].toUpperCase() : /\bRs\.?\b/.test(title) ? 'PKR' : null; };
async function findClient(t: Tenant, name: string) {
  const n = name.toLowerCase();
  const hits = await t.query<any>('SELECT id, name, currency FROM clients WHERE agency_id = ? AND archived_at IS NULL AND (LOWER(name) = ? OR LOWER(name) LIKE ?) ORDER BY (LOWER(name) = ?) DESC, id LIMIT 3', [t.agencyId, n, `%${n}%`, n]);
  return hits.length === 1 || (hits[0] && hits[0].name.toLowerCase() === n) ? hits[0] : undefined;
}

/* ───────────────────────────── re-validate everything (after upload, remap, settings, edits) ───────────────────────────── */

type Row = { id: number; sheet: string; src_row: number; section: string | null; raw: any; data: Rec | null; status: string; problems: any[]; edited: number; action: string; action_reason: string | null; dedupe_key: string | null; dup_txn_id: number | null; dup_kind: string | null; match_json: Match | null };

/** Re-derives every row from its stored source cells with the current mapping/settings, then re-runs duplicate detection and payment matching. Hand-edited rows keep their edits. */
export async function rebuild(t: Tenant, id: number) {
  const b = await getBatch(t, id);
  const sheets: Record<string, SheetLayout & { include: boolean }> = Object.fromEntries((b.sheets ?? []).map((s: any) => [s.name, s]));
  const rows = (await t.query<any>('SELECT * FROM ext_rows WHERE agency_id = ? AND batch_id = ? ORDER BY id', [t.agencyId, id])).map((r) => ({ ...r, raw: parseJ(r.raw), data: parseJ(r.data), problems: parseJ(r.problems) ?? [], match_json: parseJ(r.match_json) })) as Row[];
  for (const r of rows) {
    const s = sheets[r.sheet];
    if (!s || !s.include) { r.data = null; r.status = 'skipped'; r.problems = [{ level: 'warning', msg: 'Sheet not included in this import' }]; continue; }
    if (r.edited && r.data) { r.problems = revalidate(r.data); r.status = statusOf(r.problems); continue; }
    const n = normaliseRow(r.raw.cells as any[], s.map, r.section, { currency: b.currency, payer: b.payer_name });
    if (n.skip) { r.data = null; r.status = 'skipped'; r.problems = [{ level: 'warning', msg: n.skip }]; continue; }
    r.data = n.rec; r.problems = n.problems; r.status = statusOf(n.problems);
  }
  // Duplicates — inside this file, then against what is already imported
  const live = rows.filter((r) => r.data && r.status !== 'error');
  const existing = new Map<string, any>(), weak = new Map<string, any>();
  const keys = live.flatMap((r) => [strongKey(r.data!), weakKey(r.data!)]);
  for (let i = 0; i < keys.length; i += 800) {
    const part = keys.slice(i, i + 800); if (!part.length) continue;
    for (const x of await t.query<any>(`SELECT id, dedupe_key, weak_key FROM ext_txns WHERE agency_id = ? AND status = 'active' AND (dedupe_key IN (?) OR weak_key IN (?))`, [t.agencyId, part, part])) { existing.set(x.dedupe_key, x); if (!weak.has(x.weak_key)) weak.set(x.weak_key, x); }
  }
  const seen = new Set<string>();
  for (const r of rows) {
    r.dedupe_key = r.data ? strongKey(r.data) : null; r.dup_kind = null; r.dup_txn_id = null;
    if (!r.data || r.status === 'error') { if (r.status === 'skipped' || r.status === 'error') { if (r.action_reason === null) r.action = r.status === 'skipped' ? 'skip' : 'import'; } continue; }
    const sk = r.dedupe_key!, wk = weakKey(r.data);
    if (existing.has(sk)) { r.dup_kind = 'exact'; r.dup_txn_id = existing.get(sk).id; }
    else if (seen.has(sk)) r.dup_kind = 'in_file';
    else if (weak.has(wk)) { r.dup_kind = 'changed'; r.dup_txn_id = weak.get(wk).id; }
    seen.add(sk);
    if (r.dup_kind) { r.status = 'duplicate'; if (r.action_reason === null) r.action = 'skip'; }
    else if (r.action_reason === null) r.action = 'import';
  }
  await matchAll(t, b, rows);
  // Persist
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    for (const r of rows) await c.query('UPDATE ext_rows SET data = ?, status = ?, problems = ?, dedupe_key = ?, dup_txn_id = ?, dup_kind = ?, action = ?, match_json = ? WHERE agency_id = ? AND id = ?',
      [r.data ? j(r.data) : null, r.status, j(r.problems), r.dedupe_key, r.dup_txn_id, r.dup_kind, r.action, r.match_json ? j(r.match_json) : null, t.agencyId, r.id]);
    await c.commit();
  } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
  await refreshStats(t, id, rows);
}

const statusOf = (p: any[]) => (p.some((x) => x.level === 'error') ? 'error' : p.some((x) => x.level === 'warning') ? 'warning' : 'ok');

/** Validation for a hand-edited record (the same rules the importer applies to a file row). */
export function revalidate(d: Rec): any[] {
  const p: any[] = []; const isDate = (v: any) => v === null || /^\d{4}-\d\d-\d\d$/.test(v) && !Number.isNaN(new Date(v).getTime());
  if (!d.txn_date || !isDate(d.txn_date)) p.push({ level: 'error', field: 'txn_date', msg: 'A valid transaction date (YYYY-MM-DD) is required' });
  for (const f of ['invoice_date', 'payment_date', 'booking_date', 'travel_date', 'return_date'] as const) if (!isDate(d[f])) p.push({ level: 'error', field: f, msg: `${FIELDS[f as Field] ?? f} must be YYYY-MM-DD` });
  for (const f of ['gross', 'tax', 'service_charge', 'net'] as const) if (typeof d[f] !== 'number' || !Number.isFinite(d[f])) p.push({ level: 'error', field: f, msg: `${f} must be a number` });
  if (d.kind !== 'payment' && !(d.invoice_no || d.passenger_name || d.pnr || d.ticket_no)) p.push({ level: 'error', msg: 'Needs a passenger, invoice number, PNR or ticket number' });
  if (d.kind === 'payment' && !(d.net > 0)) p.push({ level: 'error', field: 'net', msg: 'Payment amount must be positive' });
  if (d.currency && !/^[A-Z]{3}$/.test(d.currency)) p.push({ level: 'error', field: 'currency', msg: 'Currency must be a 3-letter code' });
  if (d.kind !== 'payment' && !d.passenger_name) p.push({ level: 'warning', field: 'passenger_name', msg: 'Passenger name missing' });
  return p;
}

/* ───────────────────────────── payments → invoices ───────────────────────────── */

async function openIndex(t: Tenant, extra: Rec[]) {
  const lines = await t.query<any>(`SELECT invoice_no, txn_date, net, pnr, ticket_no, passenger_key, payer_name FROM ext_txns WHERE agency_id = ? AND status = 'active' AND kind <> 'payment' AND invoice_no IS NOT NULL`, [t.agencyId]);
  const paid = new Map<string, number>();
  for (const a of await t.query<any>(`SELECT invoice_no, SUM(amount) s FROM ext_allocations WHERE agency_id = ? AND status = 'confirmed' GROUP BY invoice_no`, [t.agencyId])) paid.set(a.invoice_no, Number(a.s));
  return buildOpen([...lines, ...extra], paid);
}

async function matchAll(t: Tenant, b: any, rows: Row[]) {
  const importable = (r: Row) => r.data && r.status !== 'error' && r.status !== 'skipped' && !(r.status === 'duplicate' && r.action === 'skip');
  const pays = rows.filter((r) => importable(r) && r.data!.kind === 'payment');
  for (const r of rows) r.match_json = null;
  if (!pays.length) return;
  const open = await openIndex(t, rows.filter((r) => importable(r) && r.data!.kind !== 'payment').map((r) => r.data!));
  for (const r of pays.sort((a, c) => (a.data!.txn_date ?? '').localeCompare(c.data!.txn_date ?? ''))) {
    const m = matchPayment(r.data!, open); r.match_json = m;
    reserve(open, { ...m, allocations: m.allocations.filter((a) => a.confidence >= CONFIRM_AT) });
  }
}

/* ───────────────────────────── statistics & source reconciliation ───────────────────────────── */

export async function refreshStats(t: Tenant, id: number, rows?: Row[]) {
  const b = await getBatch(t, id);
  rows ??= (await t.query<any>('SELECT id, sheet, status, data, action, match_json FROM ext_rows WHERE agency_id = ? AND batch_id = ?', [t.agencyId, id])).map((r) => ({ ...r, data: parseJ(r.data), match_json: parseJ(r.match_json) })) as Row[];
  const real = rows.filter((r) => r.status !== 'skipped');
  const ok = real.filter((r) => r.status === 'ok' || r.status === 'warning');
  const dup = real.filter((r) => r.status === 'duplicate'), err = real.filter((r) => r.status === 'error');
  const imp = rows.filter((r) => r.data && ['ok', 'warning', 'duplicate'].includes(r.status) && (r.status !== 'duplicate' || ['update', 'separate'].includes(r.action)) && r.status !== 'imported');
  const sum = (f: (d: Rec) => number, rs: Row[]) => r2(rs.reduce((s, r) => s + (r.data ? f(r.data) : 0), 0));
  const pay = rows.filter((r) => r.data?.kind === 'payment' && r.status !== 'error' && r.status !== 'skipped');
  // Source reconciliation: parsed sums per sheet against the totals the file itself prints
  const ctl = b.control ?? {}; const bySheet: any[] = [];
  const names = [...new Set(rows.filter((r) => r.data).map((r) => r.sheet))];
  for (const n of names) {
    const rs = rows.filter((r) => r.sheet === n && r.data && r.status !== 'skipped'); const tot = (ctl.totals ?? []).find((x: Totals) => x.sheet === n);
    const g = sum((d) => d.gross, rs), nn = sum((d) => d.net, rs);
    const fg = tot?.gross ?? null, fn = tot?.net ?? null;
    bySheet.push({ sheet: n, rows: rs.length, gross: g, net: nn, file_gross: fg, file_net: fn, diff_gross: fg === null ? null : r2(g - fg), diff_net: fn === null ? null : r2(nn - fn), ok: fg === null && fn === null ? null : Math.abs(g - (fg ?? g)) < 1 && Math.abs(nn - (fn ?? nn)) < 1.5 });
  }
  const index = Object.entries(ctl.pairs ?? {}).flatMap(([sheet, p]: any) => Object.entries(p).map(([label, value]: any) => {
    const hit = bySheet.find((s) => /trans|invoices|refund/i.test(label) ? false : Math.abs(s.gross - value) < 1 || Math.abs(s.net - value) < 1.5);
    const cnt = /transactions/i.test(label) ? bySheet.find((s) => s.rows === value) : undefined;
    return { sheet, label, value, matches: (hit ?? cnt)?.sheet ?? null };
  }));
  await setBatch(t.agencyId, id, {
    total_rows: real.length, valid_rows: ok.length, error_rows: err.length, duplicate_rows: dup.length, skipped_rows: rows.length - real.length,
    unmatched_payments: pay.filter((r) => !r.match_json?.allocations.length).length,
    total_gross: sum((d) => d.gross, imp), total_service: sum((d) => d.service_charge, imp), total_net: sum((d) => d.net, imp),
    total_debit: sum((d) => d.debit, imp), total_credit: sum((d) => d.credit, imp), total_payments: sum((d) => d.net, pay.filter((r) => imp.includes(r))),
    control: j({ ...ctl, sheets: bySheet, index }),
    ...(b.status === 'processing' ? { status: 'review', stage: 'Ready for review', progress: 100 } : {}),
  });
}

/* ───────────────────────────── committing ───────────────────────────── */

export async function commitBatch(t: Tenant, id: number, opts: { reason?: string } = {}) {
  const b = await getBatch(t, id);
  if (b.status !== 'review') throw new HttpError(409, 'This import is not waiting for review');
  if (!b.currency || !/^[A-Z]{3}$/.test(b.currency)) throw new HttpError(400, 'Confirm the currency before importing — it is never assumed');
  if (!b.payer_client_id && !b.payer_name) throw new HttpError(400, 'Choose who this statement is billed to (the payer) before importing');
  await setBatch(t.agencyId, id, { status: 'importing', stage: 'Importing', progress: 85 });
  try {
    return await t.tx(async (tx) => {
      const fresh = await getBatch(tx, id);
      let clientId = fresh.payer_client_id as number | null;
      if (clientId) await tx.ref('clients', clientId, 'payer');
      else { const hit = await findClient(tx, fresh.payer_name); clientId = hit?.id ?? await tx.insert('clients', { name: fresh.payer_name, currency: fresh.currency }); }
      const rows = (await tx.query<any>(`SELECT * FROM ext_rows WHERE agency_id = ? AND batch_id = ? AND status IN ('ok','warning','duplicate') ORDER BY id`, [tx.agencyId, id]))
        .map((r) => ({ ...r, data: parseJ(r.data), problems: parseJ(r.problems) })) as Row[];
      const todo = rows.filter((r) => r.data && (r.status !== 'duplicate' || r.action === 'update' || r.action === 'separate'));
      // Payments are matched again against the live ledger inside the transaction, so a payment can never be allocated twice.
      const pays = todo.filter((r) => r.data!.kind === 'payment');
      const trav = new Map<string, number>(); let imported = 0, failed = 0, amount = 0, unmatched = 0;
      const created = new Map<number, number>();
      for (const r of todo.filter((x) => x.data!.kind !== 'payment')) {
        try {
          const d = r.data!;
          if (r.status === 'duplicate' && r.action === 'update') {
            const old = r.dup_txn_id ? await tx.get<any>('ext_txns', r.dup_txn_id) : undefined;
            if (!old || old.status !== 'active') throw new Error('the record to update no longer exists');
            if (old.invoice_id) throw new Error('it was already posted to an invoice — correct it with a credit note on that invoice instead');
            if (await tx.one(`SELECT id FROM ext_allocations WHERE agency_id = ? AND status = 'confirmed' AND invoice_no = ?`, [tx.agencyId, old.invoice_no])) throw new Error('payments are already allocated to this invoice — it cannot be replaced');
            await tx.update('ext_txns', old.id, { status: 'superseded' });
            created.set(r.id, await insertTxn(tx, fresh, r, clientId!, trav, old.id));
            await ev(tx, id, 'record_updated', `Replaced txn #${old.id} (${old.invoice_no ?? old.pnr}) with the corrected line from ${fresh.file_name}`, { txn_id: old.id, before: old, after: d });
          } else created.set(r.id, await insertTxn(tx, fresh, r, clientId!, trav, null));
          imported++; amount += d.net;
        } catch (e: any) { failed++; r.problems.push({ level: 'error', msg: `Not imported: ${e.message}` }); await tx.query('UPDATE ext_rows SET status = ?, problems = ? WHERE agency_id = ? AND id = ?', ['failed', j(r.problems), tx.agencyId, r.id]); }
      }
      for (const [rowId, txnId] of created) await tx.query(`UPDATE ext_rows SET status = 'imported', txn_id = ? WHERE agency_id = ? AND id = ?`, [txnId, tx.agencyId, rowId]);
      // → invoices & ledger (under the payer), for everything that is not a payment
      const posting = await postImported(tx, { id, file_name: fresh.file_name, currency: fresh.currency }, clientId!, [...created].map(([rowId, txnId]) => ({ txnId, d: todo.find((r) => r.id === rowId)!.data! })).filter((x) => x.d.kind !== 'payment'));
      // payments
      const open = await openIndex(tx, []);
      for (const r of pays.sort((a, c) => (a.data!.txn_date ?? '').localeCompare(c.data!.txn_date ?? ''))) {
        try {
          const d = r.data!; const txnId = await insertTxn(tx, fresh, r, clientId!, trav, null);
          const m = matchPayment(d, open); reserve(open, { ...m, allocations: m.allocations.filter((a) => a.confidence >= CONFIRM_AT) });
          for (const a of m.allocations) await tx.insert('ext_allocations', { payment_txn_id: txnId, invoice_no: a.invoice_no, amount: a.amount, method: a.method, confidence: a.confidence, status: a.confidence >= CONFIRM_AT ? 'confirmed' : 'suggested', decided_by: a.confidence >= CONFIRM_AT ? tx.actor.userId : null, decided_at: a.confidence >= CONFIRM_AT ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null });
          if (!m.allocations.length) unmatched++;
          await tx.query(`UPDATE ext_rows SET status = 'imported', txn_id = ?, match_json = ? WHERE agency_id = ? AND id = ?`, [txnId, j(m), tx.agencyId, r.id]);
          imported++; amount += d.net;
        } catch (e: any) { failed++; r.problems.push({ level: 'error', msg: `Not imported: ${e.message}` }); await tx.query('UPDATE ext_rows SET status = ?, problems = ? WHERE agency_id = ? AND id = ?', ['failed', j(r.problems), tx.agencyId, r.id]); }
      }
      const errs = await tx.one<any>(`SELECT COUNT(*) n FROM ext_rows WHERE agency_id = ? AND batch_id = ? AND status IN ('error','failed')`, [tx.agencyId, id]);
      await setBatchTx(tx, id, { status: 'imported', stage: 'Imported', progress: 100, payer_client_id: clientId, imported_rows: imported, failed_rows: Number(errs?.n ?? 0), unmatched_payments: unmatched, imported_amount: r2(amount), posted_invoices: posting.invoices, posted_credits: posting.credits, not_posted: j(posting.notPosted), committed_by: tx.actor.userId, committed_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
      await ev(tx, id, 'imported', `${imported} record(s) imported${failed ? `, ${failed} failed` : ''}${opts.reason ? ` — ${opts.reason}` : ''}`);
      return { imported, failed, unmatched_payments: unmatched, invoices: posting.invoices, credit_notes: posting.credits, not_posted: posting.notPosted };
    });
  } catch (e) {
    await setBatch(t.agencyId, id, { status: 'review', stage: 'Ready for review', progress: 100 });
    throw e;
  }
}
const setBatchTx = async (tx: Tenant, id: number, f: Record<string, any>) => {
  const cols = Object.keys(f); await tx.query(`UPDATE ext_batches SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE agency_id = ? AND id = ?`, [...Object.values(f), tx.agencyId, id]);
};

async function insertTxn(tx: Tenant, b: any, r: Row, clientId: number, trav: Map<string, number>, supersedes: number | null) {
  const d = r.data!;
  let travellerId: number | null = null;
  if (d.passenger_key && d.kind !== 'payment') {
    const k = d.passenger_key;
    if (trav.has(k)) travellerId = trav.get(k)!;
    else {
      const found = (await tx.query<any>(`SELECT id, first_name, last_name FROM travellers WHERE agency_id = ? AND (client_id = ? OR client_id IS NULL) AND UPPER(CONCAT(first_name, ' ', last_name)) LIKE ?`, [tx.agencyId, clientId, `%${d.passenger_name!.split(' ').slice(-1)[0]}%`]))
        .find((x) => paxKey(`${x.first_name} ${x.last_name}`) === k);
      if (found) travellerId = found.id;
      else { const parts = d.passenger_name!.split(' '); const last = parts.length > 1 ? parts.pop()! : parts[0]; travellerId = await tx.insert('travellers', { client_id: clientId, first_name: parts.length ? parts.join(' ').slice(0, 100) : '', last_name: last.slice(0, 100), notes: `Created by external import #${b.id}` }); }
      trav.set(k, travellerId!);
    }
  }
  return tx.rawInsert('ext_txns', {
    agency_id: tx.agencyId, batch_id: b.id, row_id: r.id, kind: d.kind, section: d.section, doc_type: d.doc_type, invoice_no: d.invoice_no, invoice_date: d.invoice_date, txn_date: d.txn_date, payment_date: d.payment_date, booking_date: d.booking_date,
    passenger_name: d.passenger_name, passenger_key: d.passenger_key, traveller_id: travellerId, pax_ref: d.pax_ref, contact: d.contact, client_id: clientId, payer_name: d.payer_name ?? b.payer_name,
    pnr: d.pnr, ticket_no: d.ticket_no, payment_ref: d.payment_ref, sector: d.sector, origin: d.origin, destination: d.destination, airline: d.airline, flight_no: d.flight_no, travel_date: d.travel_date, return_date: d.return_date,
    currency: d.currency ?? b.currency, gross: d.gross, tax: d.tax, service_charge: d.service_charge, net: d.net, debit: d.debit, credit: d.credit, pay_status: d.pay_status, description: d.description, remarks: d.remarks,
    status: 'active', supersedes_id: supersedes, dedupe_key: r.action === 'separate' ? crypto.createHash('sha1').update(`${r.dedupe_key}|sep|${r.id}`).digest('hex') : r.dedupe_key, weak_key: weakKey(d),
    source_file: b.file_name, source_sheet: r.sheet, source_row: r.src_row, created_by: tx.actor.userId,
  });
}

/** Posts imported records that never reached Invoices/ledger (e.g. no exchange rate at the time). Safe to repeat: only unposted, active records are touched. */
export async function postPending(t: Tenant, id: number) {
  const b = await getBatch(t, id);
  if (b.status !== 'imported') throw new HttpError(409, 'Only an imported batch can be posted');
  if (!b.payer_client_id) throw new HttpError(409, 'This import has no client to post under');
  return t.tx(async (tx) => {
    const rows = await tx.query<any>(`SELECT * FROM ext_txns WHERE agency_id = ? AND batch_id = ? AND status = 'active' AND kind <> 'payment' AND invoice_id IS NULL AND voucher_id IS NULL ORDER BY id`, [tx.agencyId, id]);
    if (!rows.length) throw new HttpError(409, 'Everything in this import is already posted');
    const r = await postImported(tx, { id, file_name: b.file_name, currency: b.currency }, b.payer_client_id, rows.map((x) => ({ txnId: x.id, d: x as any })));
    await tx.query('UPDATE ext_batches SET posted_invoices = posted_invoices + ?, posted_credits = posted_credits + ?, not_posted = ? WHERE agency_id = ? AND id = ?', [r.invoices, r.credits, j(r.notPosted), tx.agencyId, id]);
    await ev(tx, id, 'posted', `${r.invoices} invoice(s) and ${r.credits} credit(s) posted${r.notPosted.length ? `; ${r.notPosted.length} still not posted` : ''}`);
    return { invoices: r.invoices, credit_notes: r.credits, not_posted: r.notPosted };
  });
}

/* ───────────────────────────── cancel & rollback ───────────────────────────── */

export async function cancelBatch(t: Tenant, id: number) {
  const b = await getBatch(t, id);
  if (!['review', 'failed', 'processing'].includes(b.status)) throw new HttpError(409, 'Only an import that has not been committed can be cancelled');
  await setBatch(t.agencyId, id, { status: 'cancelled', stage: 'Cancelled' });
  await ev(t, id, 'cancelled', 'Import cancelled before anything was saved');
}

/** Marks the batch's records as rolled back (never deletes). Records that have since been paid against, replaced, or edited stay, and are reported. */
export async function rollbackBatch(t: Tenant, id: number, reason: string) {
  const b = await getBatch(t, id);
  if (b.status !== 'imported') throw new HttpError(409, 'Only a committed import can be rolled back');
  // Undo the books first: credit notes, then invoices (each reversed, never deleted). Anything already paid/credited elsewhere stays.
  const linked = await t.query<any>(`SELECT id, kind, invoice_id, credit_note_id, voucher_id FROM ext_txns WHERE agency_id = ? AND batch_id = ? AND status = 'active' AND (invoice_id IS NOT NULL OR voucher_id IS NOT NULL)`, [t.agencyId, id]);
  const paidNos = new Set((await t.query<any>(`SELECT DISTINCT invoice_no FROM ext_allocations WHERE agency_id = ? AND status = 'confirmed'`, [t.agencyId])).map((x) => x.invoice_no));
  const today = new Date().toISOString().slice(0, 10), undone = new Set<number>(), why = new Map<number, string>();
  for (const x of linked.filter((l) => l.credit_note_id)) { try { await voidCreditNote(t, x.credit_note_id, `External import #${id} rolled back: ${reason}`.slice(0, 300), today); undone.add(x.id); } catch (e: any) { why.set(x.id, e.message); } }
  for (const x of linked.filter((l) => !l.credit_note_id && l.kind === 'credit_note' || l.kind === 'refund')) if (!x.credit_note_id && x.voucher_id) { try { await t.tx((tx) => reverseVoucher(tx, x.voucher_id, today, `External import #${id} rolled back`)); undone.add(x.id); } catch (e: any) { why.set(x.id, e.message); } }
  for (const inv of new Set(linked.filter((l) => l.invoice_id && !l.credit_note_id && (l.kind === 'sale' || l.kind === 'exchange')).map((l) => l.invoice_id as number))) {
    const row = await t.get<any>('invoices', inv);
    if (row && paidNos.has(row.number)) continue;                  // payments are allocated to it: it stays (reported below)
    try { if (row && row.status !== 'void') await voidInvoice(t, inv, `External import #${id} rolled back: ${reason}`.slice(0, 300), today); for (const x of linked.filter((l) => l.invoice_id === inv && !l.credit_note_id)) undone.add(x.id); }
    catch (e: any) { for (const x of linked.filter((l) => l.invoice_id === inv)) why.set(x.id, e.message); }
  }
  return t.tx(async (tx) => {
    const txns = await tx.query<any>(`SELECT * FROM ext_txns WHERE agency_id = ? AND batch_id = ? AND status = 'active'`, [tx.agencyId, id]);
    const blocked: { id: number; why: string }[] = []; let rolled = 0;
    const paidInv = new Set((await tx.query<any>(`SELECT DISTINCT invoice_no FROM ext_allocations WHERE agency_id = ? AND status = 'confirmed'`, [tx.agencyId])).map((x) => x.invoice_no));
    const supers = new Set((await tx.query<any>(`SELECT supersedes_id FROM ext_txns WHERE agency_id = ? AND supersedes_id IS NOT NULL AND batch_id <> ?`, [tx.agencyId, id])).map((x) => x.supersedes_id));
    for (const x of txns) {
      if ((x.invoice_id || x.voucher_id) && !undone.has(x.id)) { blocked.push({ id: x.id, why: why.get(x.id) ?? 'its invoice has been paid or credited in the books' }); continue; }
      if (x.kind !== 'payment' && x.invoice_no && paidInv.has(x.invoice_no)) { blocked.push({ id: x.id, why: `payments are allocated to invoice ${x.invoice_no}` }); continue; }
      if (x.kind === 'payment' && (await tx.one(`SELECT id FROM ext_allocations WHERE agency_id = ? AND payment_txn_id = ? AND status = 'confirmed'`, [tx.agencyId, x.id]))) {
        // Payments from this same batch are fine to roll back unless later activity touched them; confirmed allocations by a person block it.
        const manual = await tx.one(`SELECT id FROM ext_allocations WHERE agency_id = ? AND payment_txn_id = ? AND status = 'confirmed' AND method = 'manual'`, [tx.agencyId, x.id]);
        if (manual) { blocked.push({ id: x.id, why: 'a person allocated this payment by hand' }); continue; }
      }
      if (supers.has(x.id)) { blocked.push({ id: x.id, why: 'a later import replaced it' }); continue; }
      await tx.update('ext_txns', x.id, { status: 'rolled_back' });
      await tx.query(`UPDATE ext_allocations SET status = 'rejected', decided_by = ?, decided_at = NOW() WHERE agency_id = ? AND payment_txn_id = ? AND status <> 'rejected'`, [tx.actor.userId, tx.agencyId, x.id]);
      if (x.supersedes_id) await tx.query(`UPDATE ext_txns SET status = 'active' WHERE agency_id = ? AND id = ? AND status = 'superseded'`, [tx.agencyId, x.supersedes_id]);
      rolled++;
    }
    const all = blocked.length === 0;
    await setBatchTx(tx, id, { status: all ? 'rolled_back' : 'imported', rolled_back_by: tx.actor.userId, rolled_back_at: new Date().toISOString().slice(0, 19).replace('T', ' '), rollback_reason: reason.slice(0, 300) });
    await ev(tx, id, 'rolled_back', `${rolled} record(s) rolled back${blocked.length ? `; ${blocked.length} kept (${[...new Set(blocked.map((x) => x.why))].join('; ')})` : ''} — ${reason}`);
    return { rolled_back: rolled, kept: blocked };
  });
}

/* ───────────────────────────── editing rows & mapping ───────────────────────────── */

const EDITABLE = ['kind', 'invoice_no', 'invoice_date', 'txn_date', 'payment_date', 'booking_date', 'passenger_name', 'pax_ref', 'pnr', 'ticket_no', 'payment_ref', 'sector', 'origin', 'destination', 'airline', 'flight_no', 'travel_date', 'return_date', 'currency', 'gross', 'tax', 'service_charge', 'net', 'payer_name', 'description', 'remarks'] as const;

export async function editRow(t: Tenant, batchId: number, rowId: number, patch: Record<string, any>, reason: string) {
  const b = await getBatch(t, batchId); if (b.status !== 'review') throw new HttpError(409, 'This import can no longer be edited');
  const row = await t.one<any>('SELECT * FROM ext_rows WHERE agency_id = ? AND batch_id = ? AND id = ?', [t.agencyId, batchId, rowId]); if (!row) throw new HttpError(404, 'Row not found');
  const before = parseJ(row.data); if (!before) throw new HttpError(409, 'This line was skipped — there is nothing to edit');
  const d: Rec = { ...before };
  for (const [k, v] of Object.entries(patch)) {
    if (!(EDITABLE as readonly string[]).includes(k)) continue;
    if (['gross', 'tax', 'service_charge', 'net'].includes(k)) { const a = parseAmount(v as any); (d as any)[k] = a.n ?? (a.bad ? NaN : 0); }
    else (d as any)[k] = v === '' || v === undefined ? null : typeof v === 'string' ? v.trim() : v;
  }
  if (d.passenger_name) { d.passenger_name = d.passenger_name.toUpperCase(); d.passenger_key = paxKey(d.passenger_name); } else d.passenger_key = null;
  if (d.invoice_no) d.invoice_no = d.invoice_no.toUpperCase(); if (d.pnr) d.pnr = d.pnr.toUpperCase();
  if (patch.sector !== undefined && patch.origin === undefined && patch.destination === undefined) { const s = splitSector(d.sector); d.origin = s.origin; d.destination = s.destination; }
  if (!patch.net && (patch.gross !== undefined || patch.service_charge !== undefined || patch.tax !== undefined) && d.kind !== 'payment') d.net = r2(d.gross + d.service_charge + d.tax);
  if (d.kind === 'payment') { d.credit = Math.abs(d.net); d.debit = 0; } else if (d.kind === 'sale' || d.kind === 'exchange') { d.debit = Math.abs(d.net); d.credit = 0; } else { d.credit = Math.abs(d.net); d.debit = 0; }
  if (d.kind === 'payment') d.txn_date = d.payment_date ?? d.txn_date; else d.txn_date = d.invoice_date ?? d.txn_date;
  await t.rawInsert('ext_events', { agency_id: t.agencyId, batch_id: batchId, txn_id: null, action: 'row_edited', detail: `Row ${row.sheet}:${row.src_row} — ${reason}`.slice(0, 500), before_json: j(before), after_json: j(d), user_id: t.actor.userId });
  await pool.query('UPDATE ext_rows SET data = ?, edited = 1, action_reason = NULL WHERE agency_id = ? AND id = ?', [j(d), t.agencyId, rowId]);
  await rebuild(t, batchId);
}

export async function setMapping(t: Tenant, batchId: number, sig: string, map: Record<string, number | null>) {
  const b = await getBatch(t, batchId); if (b.status !== 'review') throw new HttpError(409, 'This import can no longer be changed');
  const sheets = b.sheets as any[]; const hit = sheets.filter((s) => s.sig === sig); if (!hit.length) throw new HttpError(404, 'Unknown layout');
  for (const s of hit) {
    const m: Record<string, number> = {}; const used = new Set<number>();
    for (const [f, c] of Object.entries(map)) { if (!(f in FIELDS)) throw new HttpError(400, `Unknown field ${f}`); if (c === null || c === undefined) continue; if (!Number.isInteger(c) || c < 0 || c >= s.headers.length) throw new HttpError(400, 'Bad column'); if (used.has(c)) throw new HttpError(400, `Column "${s.headers[c]}" is mapped twice`); used.add(c); m[f] = c; }
    s.map = m; s.confidence = Object.fromEntries(Object.keys(m).map((f) => [f, 100]));
  }
  await setBatch(t.agencyId, batchId, { sheets: j(sheets) });
  await ev(t, batchId, 'mapping_changed', `Column mapping changed for layout ${sig}`, { after: map });
  await rebuild(t, batchId);
}

export async function templateLabels(t: Tenant): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const tp of await t.query<any>('SELECT mapping FROM ext_mapping_templates WHERE agency_id = ? ORDER BY id', [t.agencyId])) Object.assign(out, parseJ(tp.mapping)?.labels ?? {});
  return out;
}

/* ───────────────────────────── reports ───────────────────────────── */

export interface Filters { from?: string; to?: string; client_id?: number; passenger?: string; location?: string; status?: string; kind?: string; q?: string }
const isD = (s?: string) => !!s && /^\d{4}-\d\d-\d\d$/.test(s);

/** Active ledger lines plus, for each invoice, how much has been received — so every report shares one definition of "outstanding". */
export async function ledger(t: Tenant, f: Filters = {}) {
  const w = ['agency_id = ?', `status = 'active'`], p: any[] = [t.agencyId];
  if (isD(f.from)) { w.push('txn_date >= ?'); p.push(f.from); } if (isD(f.to)) { w.push('txn_date <= ?'); p.push(f.to); }
  if (f.client_id) { w.push('client_id = ?'); p.push(f.client_id); }
  if (f.kind) { w.push('kind = ?'); p.push(f.kind); }
  if (f.passenger) { w.push('(passenger_name LIKE ? OR passenger_key LIKE ?)'); p.push(`%${f.passenger}%`, `%${f.passenger.toUpperCase()}%`); }
  if (f.location) { w.push('(origin LIKE ? OR destination LIKE ? OR sector LIKE ?)'); p.push(`%${f.location}%`, `%${f.location}%`, `%${f.location}%`); }
  if (f.q) { w.push('(passenger_name LIKE ? OR pnr LIKE ? OR ticket_no LIKE ? OR invoice_no LIKE ? OR payment_ref LIKE ?)'); const q = `%${f.q}%`; p.push(q, q, q, q, q); }
  const txns = await t.query<any>(`SELECT * FROM ext_txns WHERE ${w.join(' AND ')} ORDER BY txn_date, id`, p);
  const billed = new Map<string, number>(), got = new Map<string, number>();
  for (const x of await t.query<any>(`SELECT invoice_no, SUM(net) s FROM ext_txns WHERE agency_id = ? AND status = 'active' AND kind <> 'payment' AND invoice_no IS NOT NULL GROUP BY invoice_no`, [t.agencyId])) billed.set(x.invoice_no, Number(x.s));
  for (const x of await t.query<any>(`SELECT invoice_no, SUM(amount) s FROM ext_allocations WHERE agency_id = ? AND status = 'confirmed' GROUP BY invoice_no`, [t.agencyId])) got.set(x.invoice_no, Number(x.s));
  const lastPay = new Map<number, string>();
  for (const x of await t.query<any>(`SELECT t.client_id, MAX(t.txn_date) d FROM ext_txns t WHERE t.agency_id = ? AND t.status = 'active' AND t.kind = 'payment' GROUP BY t.client_id`, [t.agencyId])) lastPay.set(x.client_id, x.d);
  const lines = txns.map((x) => {
    const inv = x.invoice_no, bt = inv ? billed.get(inv) ?? 0 : 0, gt = inv ? got.get(inv) ?? 0 : 0, share = x.kind !== 'payment' && inv && Math.abs(bt) > 0.004 ? x.net / bt : x.kind === 'payment' ? 0 : 1;
    const received = x.kind === 'payment' ? 0 : r2(gt * share), outstanding = x.kind === 'payment' ? 0 : r2(x.net - received);
    const status = x.kind === 'payment' ? 'payment' : bt <= 0.004 ? 'credit' : bt - gt <= 0.004 ? 'paid' : gt > 0.004 ? 'partial' : 'unpaid';
    return { ...x, received, outstanding, pay_state: status };
  });
  return { lines: f.status ? lines.filter((l) => l.pay_state === f.status) : lines, lastPay };
}

export function periodKey(d: string, view: string) {
  if (view === 'daily') return d;
  if (view === 'monthly') return d.slice(0, 7);
  if (view === 'yearly') return d.slice(0, 4);
  const dt = new Date(`${d}T00:00:00Z`), day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day);   // week starts Monday
  return dt.toISOString().slice(0, 10);
}

export async function byPeriod(t: Tenant, view: string, f: Filters) {
  const { lines } = await ledger(t, f); const m = new Map<string, any>();
  for (const l of lines) {
    const k = view === 'range' ? 'Selected range' : periodKey(l.txn_date, view);
    const o = m.get(k) ?? { period: k, count: 0, gross: 0, service: 0, invoiced: 0, credits: 0, payments: 0, received: 0, outstanding: 0, currencies: new Set<string>() };
    o.currencies.add(l.currency); o.count++;
    if (l.kind === 'payment') o.payments = r2(o.payments + l.net);
    else { o.gross = r2(o.gross + l.gross); o.service = r2(o.service + l.service_charge); if (l.net >= 0) o.invoiced = r2(o.invoiced + l.net); else o.credits = r2(o.credits + l.net); o.received = r2(o.received + l.received); o.outstanding = r2(o.outstanding + l.outstanding); }
    m.set(k, o);
  }
  const rows = [...m.values()].sort((a, b) => a.period.localeCompare(b.period)).map((o) => ({ ...o, currencies: [...o.currencies] }));
  const total = rows.reduce((s, o) => ({ count: s.count + o.count, gross: r2(s.gross + o.gross), service: r2(s.service + o.service), invoiced: r2(s.invoiced + o.invoiced), credits: r2(s.credits + o.credits), payments: r2(s.payments + o.payments), received: r2(s.received + o.received), outstanding: r2(s.outstanding + o.outstanding) }), { count: 0, gross: 0, service: 0, invoiced: 0, credits: 0, payments: 0, received: 0, outstanding: 0 });
  return { view, rows, total, currencies: [...new Set(rows.flatMap((r) => r.currencies))] };
}

export async function passengers(t: Tenant, f: Filters) {
  const { lines } = await ledger(t, f); const m = new Map<string, any>();
  for (const l of lines) {
    if (l.kind === 'payment' || !l.passenger_key) continue;
    const o = m.get(l.passenger_key) ?? { key: l.passenger_key, name: l.passenger_name, traveller_id: l.traveller_id, trips: 0, pnrs: new Set<string>(), invoices: new Set<string>(), billed: 0, received: 0, outstanding: 0, first_travel: null as string | null, last_travel: null as string | null, currency: l.currency };
    o.trips++; if (l.pnr) o.pnrs.add(l.pnr); if (l.invoice_no) o.invoices.add(l.invoice_no);
    o.billed = r2(o.billed + l.net); o.received = r2(o.received + l.received); o.outstanding = r2(o.outstanding + l.outstanding);
    if (l.travel_date) { if (!o.first_travel || l.travel_date < o.first_travel) o.first_travel = l.travel_date; if (!o.last_travel || l.travel_date > o.last_travel) o.last_travel = l.travel_date; }
    m.set(l.passenger_key, o);
  }
  return [...m.values()].map((o) => ({ ...o, pnrs: o.pnrs.size, invoices: o.invoices.size })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function passengerDetail(t: Tenant, key: string) {
  const { lines } = await ledger(t, {}); const mine = lines.filter((l) => l.passenger_key === key);
  if (!mine.length) throw new HttpError(404, 'Passenger not found');
  const invs = new Set(mine.map((l) => l.invoice_no).filter(Boolean));
  const pays = invs.size ? await t.query<any>(`SELECT a.id, a.invoice_no, a.amount, a.method, a.confidence, a.status, p.txn_date, p.payment_ref, p.net payment_total FROM ext_allocations a JOIN ext_txns p ON p.id = a.payment_txn_id AND p.agency_id = a.agency_id WHERE a.agency_id = ? AND a.invoice_no IN (?) AND a.status <> 'rejected' ORDER BY p.txn_date`, [t.agencyId, [...invs]]) : [];
  const sum = (k: string) => r2(mine.reduce((s, l) => s + l[k], 0));
  return { name: mine[0].passenger_name, key, traveller_id: mine[0].traveller_id, payer: mine[0].payer_name, currency: mine[0].currency, billed: sum('net'), received: sum('received'), outstanding: sum('outstanding'), lines: mine, payments: pays };
}

export async function locations(t: Tenant, f: Filters, by: 'route' | 'origin' | 'destination') {
  const { lines } = await ledger(t, f); const m = new Map<string, any>();
  for (const l of lines) {
    if (l.kind === 'payment') continue;
    const k = (by === 'route' ? l.sector : by === 'origin' ? l.origin : l.destination)?.trim() || '(not stated)';
    const o = m.get(k) ?? { location: k, origin: l.origin, destination: l.destination, count: 0, amount: 0, received: 0, outstanding: 0 };
    o.count++; o.amount = r2(o.amount + l.net); o.received = r2(o.received + l.received); o.outstanding = r2(o.outstanding + l.outstanding); m.set(k, o);
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}

export async function payers(t: Tenant, f: Filters) {
  const { lines, lastPay } = await ledger(t, f); const m = new Map<number, any>();
  const names = new Map((await t.query<any>('SELECT id, name FROM clients WHERE agency_id = ?', [t.agencyId])).map((c) => [c.id, c.name]));
  for (const l of lines) {
    const cid = l.client_id ?? 0; const o = m.get(cid) ?? { client_id: cid, payer: names.get(cid) ?? l.payer_name ?? '(unknown)', invoices: new Set<string>(), billed: 0, payments: 0, received: 0, outstanding: 0, unapplied: 0, last_payment: lastPay.get(cid) ?? null };
    if (l.kind === 'payment') o.payments = r2(o.payments + l.net);
    else { if (l.invoice_no) o.invoices.add(l.invoice_no); o.billed = r2(o.billed + l.net); o.received = r2(o.received + l.received); o.outstanding = r2(o.outstanding + l.outstanding); }
    m.set(cid, o);
  }
  return [...m.values()].map((o) => ({ ...o, invoices: o.invoices.size, unapplied: r2(o.payments - o.received) })).sort((a, b) => b.outstanding - a.outstanding);
}

/** Payments that are unmatched or only suggested, with the candidate invoices, for the reconciliation screen. */
export async function reconciliation(t: Tenant) {
  const pays = await t.query<any>(`SELECT p.*, COALESCE((SELECT SUM(amount) FROM ext_allocations a WHERE a.agency_id = p.agency_id AND a.payment_txn_id = p.id AND a.status = 'confirmed'), 0) allocated FROM ext_txns p WHERE p.agency_id = ? AND p.status = 'active' AND p.kind = 'payment' ORDER BY p.txn_date DESC, p.id DESC LIMIT 500`, [t.agencyId]);
  const sugg = await t.query<any>(`SELECT * FROM ext_allocations WHERE agency_id = ? AND status = 'suggested' ORDER BY id`, [t.agencyId]);
  const open = await openIndex(t, []);
  return {
    payments: pays.map((p) => ({ ...p, allocated: Number(p.allocated), unapplied: r2(p.net - Number(p.allocated)), suggestions: sugg.filter((s) => s.payment_txn_id === p.id) })).filter((p) => p.unapplied > 0.004),
    open_invoices: [...open.values()].filter((o) => o.outstanding > 0.004).map((o) => ({ invoice_no: o.invoice_no, date: o.date, billed: o.billed, outstanding: o.outstanding, payer: o.payer })).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')).slice(0, 1000),
  };
}

export async function decideAllocation(t: Tenant, id: number, decision: 'confirm' | 'reject') {
  const a = await t.get<any>('ext_allocations', id); if (!a) throw new HttpError(404, 'Allocation not found');
  if (a.status !== 'suggested') throw new HttpError(409, 'Already decided');
  if (decision === 'confirm') {
    const open = await openIndex(t, []); const o = open.get(a.invoice_no);
    if (!o || o.outstanding + 0.005 < a.amount) throw new HttpError(409, 'The invoice no longer has enough outstanding to take this payment');
    const pay = await t.get<any>('ext_txns', a.payment_txn_id); const used = (await t.one<any>(`SELECT COALESCE(SUM(amount),0) s FROM ext_allocations WHERE agency_id = ? AND payment_txn_id = ? AND status = 'confirmed'`, [t.agencyId, a.payment_txn_id]))!.s;
    if (!pay || pay.net - Number(used) + 0.005 < a.amount) throw new HttpError(409, 'The payment has already been used elsewhere');
  }
  await t.update('ext_allocations', id, { status: decision === 'confirm' ? 'confirmed' : 'rejected', decided_by: t.actor.userId, decided_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  await ev(t, null, decision === 'confirm' ? 'allocation_confirmed' : 'allocation_rejected', `Payment #${a.payment_txn_id} → ${a.invoice_no} (${a.amount})`, { txn_id: a.payment_txn_id });
}

export async function manualAllocate(t: Tenant, paymentId: number, invoiceNo: string, amount: number) {
  const pay = await t.get<any>('ext_txns', paymentId); if (!pay || pay.kind !== 'payment' || pay.status !== 'active') throw new HttpError(404, 'Payment not found');
  const used = Number((await t.one<any>(`SELECT COALESCE(SUM(amount),0) s FROM ext_allocations WHERE agency_id = ? AND payment_txn_id = ? AND status = 'confirmed'`, [t.agencyId, paymentId]))!.s);
  const o = (await openIndex(t, [])).get(invoiceNo.toUpperCase()); if (!o) throw new HttpError(404, 'Invoice not found');
  amount = r2(amount);
  if (!(amount > 0)) throw new HttpError(400, 'Amount must be positive');
  if (amount > r2(pay.net - used) + 0.004) throw new HttpError(409, `Only ${r2(pay.net - used)} of this payment is still unapplied`);
  if (amount > o.outstanding + 0.004) throw new HttpError(409, `Invoice ${o.invoice_no} only has ${o.outstanding} outstanding`);
  const id = await t.insert('ext_allocations', { payment_txn_id: paymentId, invoice_no: o.invoice_no, amount, method: 'manual', confidence: 100, status: 'confirmed', decided_by: t.actor.userId, decided_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  await ev(t, pay.batch_id, 'allocation_manual', `Payment #${paymentId} → ${o.invoice_no} (${amount})`, { txn_id: paymentId });
  return id;
}

export const errorReport = async (t: Tenant, id: number) => {
  const b = await getBatch(t, id);
  const rows = await t.query<any>(`SELECT sheet, src_row, status, problems, raw FROM ext_rows WHERE agency_id = ? AND batch_id = ? AND status IN ('error','failed','duplicate') ORDER BY id`, [t.agencyId, id]);
  return { b, rows: rows.map((r) => ({ sheet: r.sheet, row: r.src_row, status: r.status, problems: (parseJ(r.problems) ?? []).map((p: any) => `${p.level}: ${p.msg}`).join(' | '), source: (parseJ(r.raw)?.cells ?? []).map((c: any) => (c === null ? '' : String(c))).join(' ; ') })) };
};
