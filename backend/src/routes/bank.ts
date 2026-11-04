import { Router } from 'express';
import { z } from 'zod';
import { WRITERS, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { Tenant } from '../db.js';
import { ensureSys, postVoucher } from '../services/accounting.js';
import { Cand, ParsedStatement, autoPick, dedupeHashes, parseCsvStatement, parseOfx, suggest } from '../services/bank-match.js';
import { createReceipt } from '../services/finance.js';
import { r2, today } from '../services/money.js';
import { fileKey, putFile } from '../storage.js';
import { idParam, parse, T } from './util.js';

export const bankRouter = Router();
bankRouter.use(requireRole('admin', 'finance_manager', 'viewer'));
const W = requireRole(...WRITERS);
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

async function bankAccount(t: Tenant, id: number) {
  const a = await t.get('accounts', id);
  if (!a) { await t.ref('accounts', id, 'bank account'); throw new HttpError(400, 'Unknown bank account'); }
  if (a.type_code !== 110) throw new HttpError(400, 'Choose a cash/bank account');
  return a;
}

const PARTY = `(CASE v.ref_table
   WHEN 'receipts' THEN (SELECT CONCAT(c.name, ' ', COALESCE(r.reference,'')) FROM receipts r JOIN clients c ON c.id = r.client_id AND c.agency_id = r.agency_id WHERE r.id = v.ref_id AND r.agency_id = v.agency_id)
   WHEN 'supplier_bills' THEN (SELECT CONCAT(s.name, ' ', b.supplier_ref) FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id AND s.agency_id = b.agency_id WHERE b.id = v.ref_id AND b.agency_id = v.agency_id)
   WHEN 'cash_vouchers' THEN (SELECT CONCAT(a.name, ' ', COALESCE(cv.cheque_no,'')) FROM cash_vouchers cv JOIN accounts a ON a.id = cv.party_account_id AND a.agency_id = cv.agency_id WHERE cv.id = v.ref_id AND cv.agency_id = v.agency_id)
 END)`;

/** Ledger cash entries not yet (fully) matched to a bank line. Reversed vouchers and their reversals cancel out and are hidden by default. */
async function ledgerEntries(t: Tenant, accountId: number, o: { asAt?: string; from?: string; showReversed?: boolean } = {}) {
  const rows = await t.query(
    `SELECT g.id, g.entry_date, (g.debit - g.credit) net, g.narration, v.voucher_no, v.voucher_type, v.reversed_by, v.reversal_of, ${PARTY} party,
       COALESCE(m.s, 0) matched, ((g.debit - g.credit) - COALESCE(m.s, 0)) remaining
     FROM gl_entries g JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id
     LEFT JOIN (SELECT gl_entry_id, SUM(amount) s FROM bank_matches WHERE agency_id = ? GROUP BY gl_entry_id) m ON m.gl_entry_id = g.id
     WHERE g.agency_id = ? AND g.account_id = ? AND g.debit <> g.credit ${o.asAt ? 'AND g.entry_date <= ?' : ''} ${o.from ? 'AND g.entry_date >= ?' : ''}
       ${o.showReversed ? '' : 'AND v.reversed_by IS NULL AND v.reversal_of IS NULL'}
       AND ABS((g.debit - g.credit) - COALESCE(m.s, 0)) > 0.004 ORDER BY g.entry_date, g.id`,
    [t.agencyId, t.agencyId, accountId, ...(o.asAt ? [o.asAt] : []), ...(o.from ? [o.from] : [])]);
  return rows.map((r: any) => ({ ...r, remaining: r2(r.remaining) }));
}
const asCand = (e: any): Cand => ({ id: e.id, remaining: e.remaining, entry_date: e.entry_date, narration: e.narration, voucher_no: e.voucher_no, party: e.party });

async function loadTxn(t: Tenant, id: number, lock = false) {
  const x = (await t.query(`SELECT * FROM bank_transactions WHERE agency_id = ? AND id = ? ${lock ? 'FOR UPDATE' : ''}`, [t.agencyId, id]))[0];
  if (!x) throw new HttpError(404, 'Bank transaction not found');
  // when locking, read the match total with a locking read too: a plain read would use our older snapshot and miss a concurrent commit
  const m = await t.one(`SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM bank_matches WHERE agency_id = ? AND bank_txn_id = ? ${lock ? 'FOR UPDATE' : ''}`, [t.agencyId, id]);
  return { ...x, matched_amount: r2(m!.s), match_count: m!.n, remaining: r2(x.amount - m!.s) };
}
async function assertStatementOpen(t: Tenant, txn: any) {
  if (!txn.statement_id) return;
  const s = await t.get('bank_statements', txn.statement_id);
  if (s?.status === 'reconciled') throw new HttpError(409, 'This statement is reconciled. Reopen it (admin, with a reason) to change matches.');
}

/** Sync the legacy "reconciled" flag on client payments from the entries now fully matched. */
async function syncPaymentFlags(t: Tenant, glIds: number[]) {
  if (!glIds.length) return;
  await t.query(`UPDATE payments p JOIN receipts r ON r.id = p.receipt_id AND r.agency_id = p.agency_id JOIN gl_entries g ON g.voucher_id = r.voucher_id AND g.agency_id = r.agency_id
    SET p.reconciled = IF(ABS((g.debit - g.credit) - COALESCE((SELECT SUM(m.amount) FROM bank_matches m WHERE m.agency_id = g.agency_id AND m.gl_entry_id = g.id),0)) < 0.005, 1, 0) WHERE p.agency_id = ? AND g.id IN (?) AND g.account_id = r.cash_account_id`, [t.agencyId, glIds]);
}

interface MatchItem { gl_entry_id: number; amount?: number }
/** Record matches for one bank line. Handles split (partial) and combined (many entries) matches, and an explicit adjustment for a difference such as a bank fee. */
async function applyMatch(t: Tenant, txnId: number, items: MatchItem[], o: { method: 'auto' | 'manual' | 'receipt'; confidence?: number; adjustment?: { account_id: number; reason: string } }) {
  return t.tx(async (tx) => {
    const txn = await loadTxn(tx, txnId, true);
    if (txn.status === 'ignored') throw new HttpError(409, 'This line is ignored; un-ignore it first');
    await assertStatementOpen(tx, txn);
    if (Math.abs(txn.remaining) < 0.005) throw new HttpError(409, 'This line is already fully matched');
    if (!items.length && !o.adjustment) throw new HttpError(400, 'Choose at least one ledger entry');
    const sign = Math.sign(txn.remaining), touched: number[] = []; let sum = 0;
    const seen = new Set<number>();
    for (const it of items) {
      if (seen.has(it.gl_entry_id)) throw new HttpError(400, 'A ledger entry may appear once');
      seen.add(it.gl_entry_id);
      const g = (await tx.query(`SELECT g.*, (g.debit - g.credit) net FROM gl_entries g WHERE g.agency_id = ? AND g.id = ? AND g.account_id = ? FOR UPDATE`, [tx.agencyId, it.gl_entry_id, txn.account_id]))[0];
      if (!g) throw new HttpError(400, 'Unknown ledger entry for this bank account');
      const used = (await tx.one('SELECT COALESCE(SUM(amount),0) s FROM bank_matches WHERE agency_id = ? AND gl_entry_id = ? FOR UPDATE', [tx.agencyId, g.id]))!.s;   // locking read: sees a match committed while we waited
      const rem = r2(g.net - used), amt = r2(it.amount ?? rem);
      if (Math.sign(amt) !== sign || Math.sign(rem) !== sign) throw new HttpError(400, 'A deposit can only be matched to money-in entries and a payment to money-out entries');
      if (Math.abs(amt) > Math.abs(rem) + 0.005) throw new HttpError(400, `Entry #${g.id} only has ${rem} left to match`);
      sum = r2(sum + amt);
      await tx.query(`INSERT INTO bank_matches (agency_id, bank_txn_id, gl_entry_id, amount, method, confidence, matched_by) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)`,
        [tx.agencyId, txnId, g.id, amt, o.method, o.confidence ?? null, tx.actor.userId]); touched.push(g.id);
    }
    if (Math.abs(sum) > Math.abs(txn.remaining) + 0.005) throw new HttpError(400, `Selected entries (${sum}) exceed the bank line's unmatched amount (${txn.remaining})`);
    const diff = r2(txn.remaining - sum);
    if (Math.abs(diff) >= 0.005 && o.adjustment) {
      // the difference (e.g. a bank fee or write-off) is booked to the chosen account and matched in the same step
      const adjAcc = o.adjustment.account_id; if (adjAcc === txn.account_id) throw new HttpError(400, 'Choose a different account for the adjustment');
      await tx.ref('accounts', adjAcc, 'adjustment account');
      const vid = await postVoucher(tx, { type: 'journal', date: txn.tx_date, narration: `Bank adjustment: ${o.adjustment.reason}`, ref_table: 'bank_transactions', ref_id: txnId,
        legs: diff > 0 ? [{ account_id: txn.account_id, debit: diff }, { account_id: adjAcc, credit: diff }] : [{ account_id: adjAcc, debit: -diff }, { account_id: txn.account_id, credit: -diff }] });
      const g = (await tx.query('SELECT id FROM gl_entries WHERE agency_id = ? AND voucher_id = ? AND account_id = ?', [tx.agencyId, vid, txn.account_id]))[0];
      await tx.query(`INSERT INTO bank_matches (agency_id, bank_txn_id, gl_entry_id, amount, method, matched_by) VALUES (?,?,?,?, 'adjustment', ?)`, [tx.agencyId, txnId, g.id, diff, tx.actor.userId]);
      touched.push(g.id); sum = r2(sum + diff);
      await tx.event('create', 'bank_adjustments', txnId, null, { account_id: adjAcc, amount: diff }, o.adjustment.reason);
    }
    const left = r2(txn.remaining - sum);
    await tx.update('bank_transactions', txnId, { status: Math.abs(left) < 0.005 ? 'matched' : 'unmatched' });
    await syncPaymentFlags(tx, touched);
    return { status: Math.abs(left) < 0.005 ? 'matched' : 'partially_matched', unmatched_amount: left };
  });
}

// ---------------------------------------------------------------- overview
bankRouter.get('/accounts', async (req, res) => {
  const t = T(req);
  const accs = await t.query(`SELECT a.id, a.code, a.name, (a.opening_dr - a.opening_cr + COALESCE((SELECT SUM(g.debit - g.credit) FROM gl_entries g WHERE g.agency_id = a.agency_id AND g.account_id = a.id),0)) book_balance
    FROM accounts a WHERE a.agency_id = ? AND a.type_code = 110 ORDER BY a.code`, [t.agencyId]);
  for (const a of accs as any[]) {
    a.unmatched_bank = (await t.one(`SELECT COUNT(*) n FROM bank_transactions WHERE agency_id = ? AND account_id = ? AND status = 'unmatched'`, [t.agencyId, a.id]))!.n;
    a.unmatched_ledger = (await ledgerEntries(t, a.id)).length;
    a.last_reconciled_to = (await t.one(`SELECT MAX(period_to) d FROM bank_statements WHERE agency_id = ? AND account_id = ? AND status = 'reconciled'`, [t.agencyId, a.id]))!.d;
  }
  res.json(accs);
});

bankRouter.get('/statements', async (req, res) => {
  const t = T(req), acc = Number(req.query.account_id) || null;
  res.json(await t.query(`SELECT s.*, (SELECT COUNT(*) FROM bank_transactions x WHERE x.agency_id = s.agency_id AND x.statement_id = s.id AND x.status = 'unmatched') unmatched, u.name imported_by_name
    FROM bank_statements s LEFT JOIN users u ON u.id = s.imported_by WHERE s.agency_id = ? ${acc ? 'AND s.account_id = ?' : ''} ORDER BY s.period_to DESC, s.id DESC LIMIT 100`, acc ? [t.agencyId, acc] : [t.agencyId]));
});

// ---------------------------------------------------------------- import (CSV / OFX)
bankRouter.post('/statements', W, async (req, res) => {
  const b = parse(z.object({ account_id: z.number().int(), filename: z.string().min(1).max(200), content: z.string().min(1).max(8_000_000), opening_balance: z.number().nullish(), closing_balance: z.number().nullish(), currency: z.string().length(3).optional() }), req.body);
  const t = T(req), acc = await bankAccount(t, b.account_id), agency = await t.agency();
  if (b.currency && b.currency !== agency.base_currency) throw new HttpError(400, `Foreign-currency bank accounts are not supported yet (statement ${b.currency}, books ${agency.base_currency}).`);
  const parsed: ParsedStatement = /\.(ofx|qfx)$/i.test(b.filename) || /<OFX>/i.test(b.content) ? parseOfx(b.content) : parseCsvStatement(b.content);
  if (!parsed.txns.length) throw new HttpError(400, 'No transactions found in that file');
  const hashes = dedupeHashes(b.account_id, parsed.txns), dates = parsed.txns.map((x) => x.tx_date).sort();
  const key = await putFile(fileKey(t.agencyId, 'statements', b.filename), b.content, 'text/plain');
  const out = await t.tx(async (tx) => {
    const sid = await tx.insert('bank_statements', { account_id: b.account_id, filename: b.filename, statement_key: key, currency: agency.base_currency, period_from: dates[0], period_to: dates[dates.length - 1],
      opening_balance: b.opening_balance ?? parsed.opening_balance, closing_balance: b.closing_balance ?? parsed.closing_balance, line_count: 0, imported_by: tx.actor.userId });
    let added = 0, duplicates = 0;
    for (let i = 0; i < parsed.txns.length; i++) {
      const x = parsed.txns[i];
      if (await tx.one('SELECT id FROM bank_transactions WHERE agency_id = ? AND dedupe_hash = ?', [tx.agencyId, hashes[i]])) { duplicates++; continue; }
      await tx.insert('bank_transactions', { statement_id: sid, account_id: b.account_id, tx_date: x.tx_date, amount: x.amount, description: x.description?.slice(0, 500) ?? null, fitid: x.fitid, reference: x.reference?.slice(0, 120) ?? null,
        counterparty: x.counterparty?.slice(0, 200) ?? null, currency: agency.base_currency, statement_key: key, dedupe_hash: hashes[i], status: 'unmatched' });
      added++;
    }
    await tx.update('bank_statements', sid, { line_count: added });
    return { statement_id: sid, parsed: parsed.txns.length, added, duplicates };
  });
  void acc; res.status(201).json(out);
});

bankRouter.put('/statements/:id', W, async (req, res) => {
  const t = T(req), id = idParam(req), s = await t.get('bank_statements', id);
  if (!s) throw new HttpError(404, 'Not found');
  if (s.status === 'reconciled') throw new HttpError(409, 'Reconciled statements are locked');
  const b = parse(z.object({ opening_balance: z.number().nullish(), closing_balance: z.number().nullish() }), req.body);
  await t.update('bank_statements', id, { opening_balance: b.opening_balance ?? null, closing_balance: b.closing_balance ?? null }); res.json({ ok: true });
});

// ---------------------------------------------------------------- lists
bankRouter.get('/transactions', async (req, res) => {
  const t = T(req), { account_id, status, statement_id } = req.query as Record<string, string>;
  res.json((await t.query(`SELECT x.*, COALESCE((SELECT SUM(m.amount) FROM bank_matches m WHERE m.agency_id = x.agency_id AND m.bank_txn_id = x.id),0) matched_amount
    FROM bank_transactions x WHERE x.agency_id = ? ${account_id ? 'AND x.account_id = ?' : ''} ${status ? 'AND x.status = ?' : ''} ${statement_id ? 'AND x.statement_id = ?' : ''} ORDER BY x.tx_date DESC, x.id DESC LIMIT 1000`,
    [t.agencyId, ...(account_id ? [Number(account_id)] : []), ...(status ? [status] : []), ...(statement_id ? [Number(statement_id)] : [])])).map((x: any) => ({ ...x, remaining: r2(x.amount - x.matched_amount) })));
});
bankRouter.get('/ledger', async (req, res) => {
  const t = T(req), id = Number(req.query.account_id); await bankAccount(t, id);
  res.json(await ledgerEntries(t, id, { showReversed: req.query.show_reversed === '1' }));
});

// ---------------------------------------------------------------- suggestions & auto-match
bankRouter.get('/transactions/:id/suggestions', async (req, res) => {
  const t = T(req), txn = await loadTxn(t, idParam(req));
  const cands = (await ledgerEntries(t, txn.account_id)).map(asCand), byId = new Map(cands.map((c) => [c.id, c]));
  res.json(suggest({ ...txn, amount: txn.remaining }, cands).map((s) => ({ ...s, entries: s.entry_ids.map((i) => byId.get(i)) })));
});

bankRouter.post('/auto-match', W, async (req, res) => {
  const b = parse(z.object({ account_id: z.number().int(), statement_id: z.number().int().optional() }), req.body), t = T(req);
  await bankAccount(t, b.account_id);
  const txns = await t.query(`SELECT id FROM bank_transactions WHERE agency_id = ? AND account_id = ? AND status = 'unmatched' ${b.statement_id ? 'AND statement_id = ?' : ''} AND NOT EXISTS (SELECT 1 FROM bank_matches m WHERE m.agency_id = bank_transactions.agency_id AND m.bank_txn_id = bank_transactions.id)
    ORDER BY tx_date, id`, b.statement_id ? [t.agencyId, b.account_id, b.statement_id] : [t.agencyId, b.account_id]);
  let matched = 0, review = 0; const done: { txn: number; entry: number; confidence: number }[] = [];
  for (const row of txns) {
    const txn = await loadTxn(t, row.id);
    try { await assertStatementOpen(t, txn); } catch { continue; }
    const cands = (await ledgerEntries(t, txn.account_id)).map(asCand), s = suggest(txn, cands), pick = autoPick(s);
    if (!pick) { if (s.length) review++; continue; }
    try { await applyMatch(t, row.id, [{ gl_entry_id: pick.entry_ids[0] }], { method: 'auto', confidence: pick.confidence }); matched++; done.push({ txn: row.id, entry: pick.entry_ids[0], confidence: pick.confidence }); } catch { /* raced with another user: leave for review */ }
  }
  res.json({ matched, needs_review: review, remaining: txns.length - matched, matches: done });
});

// ---------------------------------------------------------------- manual match / unmatch / ignore
bankRouter.post('/transactions/:id/match', W, async (req, res) => {
  const b = parse(z.object({ entries: z.array(z.object({ gl_entry_id: z.number().int(), amount: z.number().optional() })).default([]), adjustment: z.object({ account_id: z.number().int(), reason: z.string().optional().default('') }).optional() }), req.body);
  res.json(await applyMatch(T(req), idParam(req), b.entries, { method: 'manual', adjustment: b.adjustment }));
});

bankRouter.post('/transactions/:id/unmatch', W, async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().optional().default('') }), req.body), t = T(req), id = idParam(req);
  await t.tx(async (tx) => {
    const txn = await loadTxn(tx, id, true); await assertStatementOpen(tx, txn);
    if (!txn.match_count) throw new HttpError(409, 'Nothing is matched');
    const gl = (await tx.query('SELECT gl_entry_id FROM bank_matches WHERE agency_id = ? AND bank_txn_id = ?', [tx.agencyId, id])).map((r: any) => r.gl_entry_id);
    await tx.query('DELETE FROM bank_matches WHERE agency_id = ? AND bank_txn_id = ?', [tx.agencyId, id]);
    await tx.update('bank_transactions', id, { status: 'unmatched' });
    await syncPaymentFlags(tx, gl);
    await tx.event('update', 'bank_matches', id, { matched: txn.matched_amount }, { matched: 0 }, reason);   // any adjustment voucher stays in the ledger; reverse it separately if wrong
  });
  res.json({ status: 'unmatched' });
});

// "Ignore" declares a line is not a real bank movement (duplicate / noise). It is excluded from the reconciliation, so it needs a reason and is audited.
bankRouter.post('/transactions/:id/ignore', W, async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().optional().default('') }), req.body), t = T(req), id = idParam(req), txn = await loadTxn(t, id);
  await assertStatementOpen(t, txn);
  if (txn.match_count) throw new HttpError(409, 'Unmatch it first'); if (txn.status === 'ignored') throw new HttpError(409, 'Already ignored');
  await t.update('bank_transactions', id, { status: 'ignored', ignore_reason: reason }); res.json({ status: 'ignored' });
});
bankRouter.post('/transactions/:id/unignore', W, async (req, res) => {
  const t = T(req), id = idParam(req), txn = await loadTxn(t, id); await assertStatementOpen(t, txn);
  if (txn.status !== 'ignored') throw new HttpError(409, 'Not ignored'); await t.update('bank_transactions', id, { status: 'unmatched', ignore_reason: null }); res.json({ status: 'unmatched' });
});

// Unmatched deposit → record the client receipt (into THIS bank account, on the bank's date) and match it in one step
bankRouter.post('/transactions/:id/create-receipt', W, async (req, res) => {
  const b = parse(z.object({ client_id: z.number().int(), allocations: z.array(z.object({ invoice_id: z.number().int(), amount: z.number().positive() })).default([]) }), req.body), t = T(req), id = idParam(req);
  const txn = await loadTxn(t, id); await assertStatementOpen(t, txn);
  if (txn.amount <= 0) throw new HttpError(400, 'Only a deposit can become a client receipt'); if (txn.match_count || txn.status !== 'unmatched') throw new HttpError(409, 'This line is already handled');
  const r = await createReceipt(t, { client_id: b.client_id, cash_account_id: txn.account_id, amount: txn.amount, receipt_date: txn.tx_date, method: 'bank_transfer', reference: (txn.reference ?? txn.description ?? '').slice(0, 100) || null, allocations: b.allocations, idem_key: `bank:${id}` });
  const g = await t.one('SELECT id FROM gl_entries WHERE agency_id = ? AND voucher_id = ? AND account_id = ?', [t.agencyId, r.receipt.voucher_id, txn.account_id]);
  await applyMatch(t, id, [{ gl_entry_id: g!.id }], { method: 'receipt' });
  res.status(201).json({ receipt_id: r.receipt.id, receipt_no: r.receipt.receipt_no });
});

// ---------------------------------------------------------------- reconciliation report
async function reconcile(t: Tenant, accountId: number, asAt: string) {
  const acc = await bankAccount(t, accountId);
  const book = r2(acc.opening_dr - acc.opening_cr + (await t.one<{ s: number }>('SELECT COALESCE(SUM(debit - credit),0) s FROM gl_entries WHERE agency_id = ? AND account_id = ? AND entry_date <= ?', [t.agencyId, accountId, asAt]))!.s);
  const first = await t.one<{ d: string | null }>('SELECT MIN(period_from) d FROM bank_statements WHERE agency_id = ? AND account_id = ?', [t.agencyId, accountId]);
  const latest = await t.one('SELECT * FROM bank_statements WHERE agency_id = ? AND account_id = ? AND period_to <= ? AND closing_balance IS NOT NULL ORDER BY period_to DESC, id DESC LIMIT 1', [t.agencyId, accountId, asAt]);
  // entries before the first imported statement are assumed to have cleared already
  const outstanding = await ledgerEntries(t, accountId, { asAt, from: first?.d ?? undefined });
  const bankOnly = await t.query(`SELECT x.id, x.tx_date, x.amount, x.description, x.amount - COALESCE((SELECT SUM(m.amount) FROM bank_matches m WHERE m.agency_id = x.agency_id AND m.bank_txn_id = x.id),0) remaining
    FROM bank_transactions x WHERE x.agency_id = ? AND x.account_id = ? AND x.status = 'unmatched' AND x.tx_date <= ? ORDER BY x.tx_date`, [t.agencyId, accountId, asAt]);
  const ledgerNet = r2(outstanding.reduce((s: number, e: any) => s + e.remaining, 0)), bankNet = r2(bankOnly.reduce((s: number, x: any) => s + x.remaining, 0));
  const expected = r2(book - ledgerNet + bankNet), bank = latest?.closing_balance ?? null, difference = bank === null ? null : r2(bank - expected);
  let opening: any = null;
  if (first?.d) {
    const s1 = await t.one('SELECT * FROM bank_statements WHERE agency_id = ? AND account_id = ? ORDER BY period_from, id LIMIT 1', [t.agencyId, accountId]);
    const sum = (await t.one<{ s: number }>('SELECT COALESCE(SUM(amount),0) s FROM bank_transactions WHERE agency_id = ? AND statement_id = ?', [t.agencyId, s1!.id]))!.s;
    const bankOpen = s1!.opening_balance ?? (s1!.closing_balance != null ? r2(s1!.closing_balance - sum) : null);
    const bookBefore = r2(acc.opening_dr - acc.opening_cr + (await t.one<{ s: number }>('SELECT COALESCE(SUM(debit - credit),0) s FROM gl_entries WHERE agency_id = ? AND account_id = ? AND entry_date < ?', [t.agencyId, accountId, first.d]))!.s);
    opening = { first_statement_from: first.d, bank_opening: bankOpen, book_before: bookBefore, difference: bankOpen === null ? null : r2(bankOpen - bookBefore) };
  }
  return { account: { id: acc.id, name: acc.name }, as_at: asAt, book_balance: book, bank_closing_balance: bank, bank_statement_date: latest?.period_to ?? null,
    outstanding_ledger_net: ledgerNet, bank_only_net: bankNet, expected_bank_balance: expected, difference, ok: difference !== null && Math.abs(difference) < 0.005, opening_alignment: opening,
    outstanding_ledger: outstanding, bank_only: bankOnly };
}
bankRouter.get('/reconciliation', async (req, res) => {
  const t = T(req), id = Number(req.query.account_id); res.json(await reconcile(t, id, String(req.query.as_at ?? today())));
});

// ---------------------------------------------------------------- finalise / reopen (locks the matches)
bankRouter.post('/statements/:id/finalize', W, async (req, res) => {
  const t = T(req), id = idParam(req);
  const out = await t.tx(async (tx) => {
    const s = (await tx.query('SELECT * FROM bank_statements WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, id]))[0];
    if (!s) throw new HttpError(404, 'Not found'); if (s.status === 'reconciled') throw new HttpError(409, 'Already reconciled');
    if (s.closing_balance === null) throw new HttpError(409, 'Enter the statement closing balance first');
    const open = await tx.one(`SELECT COUNT(*) n FROM bank_transactions WHERE agency_id = ? AND statement_id = ? AND status = 'unmatched'`, [tx.agencyId, id]);
    if (open!.n) throw new HttpError(409, `${open!.n} line(s) are still unmatched. Match, create a receipt/adjustment, or ignore them (with a reason).`);
    const sum = (await tx.one<{ s: number }>(`SELECT COALESCE(SUM(amount),0) s FROM bank_transactions WHERE agency_id = ? AND statement_id = ? AND status <> 'ignored'`, [tx.agencyId, id]))!.s;
    if (s.opening_balance !== null && Math.abs(s.opening_balance + sum - s.closing_balance) > 0.005) throw new HttpError(409, `The statement does not add up: opening ${s.opening_balance} + lines ${r2(sum)} ≠ closing ${s.closing_balance}.`);
    const rec = await reconcile(tx, s.account_id, String(s.period_to).slice(0, 10));
    if (!rec.ok) throw new HttpError(409, `The bank balance does not agree with the books: difference ${rec.difference}. ${rec.opening_alignment?.difference ? `Opening balances differ by ${rec.opening_alignment.difference} — post an opening-balance journal.` : 'Check outstanding items.'}`);
    await tx.update('bank_statements', id, { status: 'reconciled', reconciled_by: tx.actor.userId, reconciled_at: nowSql() });
    return { status: 'reconciled', difference: rec.difference };
  });
  res.json(out);
});
bankRouter.post('/statements/:id/reopen', requireRole('admin'), async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().optional().default('') }), req.body), t = T(req), id = idParam(req), s = await t.get('bank_statements', id);
  if (!s) throw new HttpError(404, 'Not found'); if (s.status !== 'reconciled') throw new HttpError(409, 'Not reconciled');
  await t.update('bank_statements', id, { status: 'open', reconciled_by: null, reconciled_at: null, reopened_reason: reason });
  await t.event('update', 'bank_statements', id, { status: 'reconciled' }, { status: 'open' }, reason); res.json({ status: 'open' });
});
