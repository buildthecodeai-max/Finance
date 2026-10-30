import crypto from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { HttpError } from '../errors.js';

/* ------------------------------------------------------------------ statement parsing */
export interface ParsedTxn { tx_date: string; amount: number; description: string; reference: string | null; counterparty: string | null; fitid: string | null; balance: number | null }
export interface ParsedStatement { txns: ParsedTxn[]; opening_balance: number | null; closing_balance: number | null }

const clean = (s: unknown) => String(s ?? '').trim();
/** "1,234.56" · "(100.00)" · "-100" · "$ 5" · "5 CR" → number (parentheses and DR mean negative). */
export function parseAmount(raw: unknown): number | null {
  let s = clean(raw); if (!s) return null;
  let neg = /^\(.*\)$/.test(s) || /\bDR\b/i.test(s) || s.startsWith('-');
  s = s.replace(/[()$€£,\sA-Za-z]|^-/g, '');
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Math.round(parseFloat(s) * 100) / 100; return neg ? -n : n;
}
export function parseDate(raw: unknown): string | null {
  const s = clean(raw); let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // day-first
  return null;
}

export function parseOfx(text: string): ParsedStatement {
  const tag = (src: string, t: string) => src.match(new RegExp(`<${t}>([^<\\r\\n]+)`, 'i'))?.[1]?.trim();
  const txns: ParsedTxn[] = [];
  for (const m of text.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)) {
    const date = parseDate(tag(m[1], 'DTPOSTED')), amount = parseAmount(tag(m[1], 'TRNAMT'));
    if (!date || amount === null) continue;
    txns.push({ tx_date: date, amount, description: tag(m[1], 'MEMO') ?? tag(m[1], 'NAME') ?? '', reference: tag(m[1], 'CHECKNUM') ?? tag(m[1], 'REFNUM') ?? null, counterparty: tag(m[1], 'NAME') ?? null, fitid: tag(m[1], 'FITID') ?? null, balance: null });
  }
  const led = text.match(/<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]+)/i);
  return { txns, opening_balance: null, closing_balance: led ? parseAmount(led[1]) : null };
}

export function parseCsvStatement(text: string): ParsedStatement {
  let rows: Record<string, string>[];
  try { rows = parseCsv(text, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }); }
  catch (e: any) { throw new HttpError(400, `Could not read the CSV: ${e.message}`); }
  const pick = (r: Record<string, string>, ...keys: string[]) => { for (const k of keys) if (r[k] !== undefined && r[k] !== '') return r[k]; return undefined; };
  const txns: ParsedTxn[] = [];
  rows.forEach((r, i) => {
    const date = parseDate(pick(r, 'date', 'transaction date', 'posted date', 'value date', 'booking date'));
    const credit = parseAmount(pick(r, 'credit', 'deposit', 'money in', 'paid in')), debit = parseAmount(pick(r, 'debit', 'withdrawal', 'money out', 'paid out'));
    const single = parseAmount(pick(r, 'amount', 'value'));
    const amount = single !== null ? single : credit !== null || debit !== null ? Math.round(((credit ?? 0) - Math.abs(debit ?? 0)) * 100) / 100 : null;
    if (!date || amount === null) throw new HttpError(400, `Row ${i + 2}: need a valid date (YYYY-MM-DD or DD/MM/YYYY) and an amount (or credit/debit columns)`);
    txns.push({ tx_date: date, amount, description: pick(r, 'description', 'memo', 'narrative', 'details', 'particulars') ?? '', reference: pick(r, 'reference', 'ref', 'cheque no', 'cheque number') ?? null,
      counterparty: pick(r, 'counterparty', 'payee', 'name', 'beneficiary') ?? null, fitid: pick(r, 'id', 'fitid', 'transaction id') ?? null, balance: parseAmount(pick(r, 'balance', 'running balance')) });
  });
  const last = [...txns].reverse().find((t) => t.balance !== null);
  return { txns, opening_balance: null, closing_balance: last?.balance ?? null };
}

/** Stable per-line fingerprint so re-importing a file (or an overlapping one) never duplicates lines. Identical lines in one file get an occurrence index. */
export function dedupeHashes(accountId: number, txns: ParsedTxn[]): string[] {
  const seen = new Map<string, number>();
  return txns.map((t) => {
    const key = [accountId, t.tx_date, t.amount.toFixed(2), t.description.toLowerCase().replace(/\s+/g, ' ').trim(), t.fitid ?? '', t.reference ?? ''].join('|');
    const n = (seen.get(key) ?? 0) + 1; seen.set(key, n);
    return crypto.createHash('sha1').update(`${key}#${n}`).digest('hex');
  });
}

/* ------------------------------------------------------------------ match suggestions */
export interface Txn { amount: number; tx_date: string; description: string | null; reference: string | null; counterparty: string | null }
export interface Cand { id: number; remaining: number; entry_date: string; narration: string | null; voucher_no: string | null; party: string | null }
export interface Suggestion { entry_ids: number[]; amounts: number[]; confidence: number; reasons: string[]; combined: boolean }

/** A suggestion at/above this confidence AND ahead of the runner-up by AUTO_MARGIN is applied by auto-match; anything else needs a human. */
export const AUTO_THRESHOLD = 75, AUTO_MARGIN = 15, MAX_COMBO = 4, WINDOW_DAYS = 45;
const STOP = new Set(['the', 'and', 'for', 'ref', 'payment', 'transfer', 'bank', 'from', 'with', 'receipt', 'invoice', 'voucher', 'deposit', 'credit', 'debit', 'inc', 'ltd', 'pty']);
const tokens = (s: string | null | undefined) => new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3 && !STOP.has(x)));
const days = (a: string, b: string) => Math.abs((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 864e5);

function datePoints(d: number) { return d === 0 ? 20 : d <= 2 ? 15 : d <= 5 ? 8 : d <= 10 ? 3 : 0; }
function textPoints(txn: Txn, cands: Cand[]): { pts: number; hits: string[] } {
  const a = tokens(`${txn.description} ${txn.reference} ${txn.counterparty}`), hits: string[] = []; let num = 0, word = 0;
  const b = new Set<string>(); for (const c of cands) for (const t of tokens(`${c.narration} ${c.voucher_no} ${c.party}`)) b.add(t);
  for (const t of a) if (b.has(t)) { hits.push(t); /\d/.test(t) ? (num += 10) : (word += 4); }
  return { pts: Math.min(20, num) + Math.min(12, word), hits };
}

/**
 * Candidate ledger entries for one bank line. Single-entry matches need the exact amount; combined deposits are found by a bounded
 * subset search (≤4 entries) and are capped below the auto-match threshold, so they are always reviewed by a person.
 */
export function suggest(txn: Txn, cands: Cand[]): Suggestion[] {
  const sign = Math.sign(txn.amount), near = cands.filter((c) => Math.sign(c.remaining) === sign && days(txn.tx_date, c.entry_date) <= WINDOW_DAYS);
  const out: Suggestion[] = [];
  for (const c of near) {
    if (Math.abs(c.remaining - txn.amount) >= 0.005) continue;
    const d = days(txn.tx_date, c.entry_date), tx = textPoints(txn, [c]), reasons = ['exact amount'];
    if (d <= 10) reasons.push(d === 0 ? 'same day' : `${d} day${d === 1 ? '' : 's'} apart`); if (tx.hits.length) reasons.push(`matches “${tx.hits.slice(0, 3).join(', ')}”`);
    out.push({ entry_ids: [c.id], amounts: [c.remaining], confidence: Math.min(100, 55 + datePoints(d) + tx.pts), reasons, combined: false });
  }
  const pool = near.filter((c) => Math.abs(c.remaining) < Math.abs(txn.amount) - 0.005).sort((a, b) => days(txn.tx_date, a.entry_date) - days(txn.tx_date, b.entry_date)).slice(0, 12);
  const walk = (start: number, picked: Cand[], sum: number) => {
    if (picked.length >= 2 && Math.abs(sum - txn.amount) < 0.005) {
      const d = Math.min(...picked.map((p) => days(txn.tx_date, p.entry_date))), tx = textPoints(txn, picked);
      out.push({ entry_ids: picked.map((p) => p.id), amounts: picked.map((p) => p.remaining), confidence: Math.min(AUTO_THRESHOLD - 1, 50 - 5 * (picked.length - 2) + datePoints(d) + tx.pts),
        reasons: [`${picked.length} entries add up exactly`, ...(tx.hits.length ? [`matches “${tx.hits.slice(0, 3).join(', ')}”`] : [])], combined: true });
      return;
    }
    if (picked.length >= MAX_COMBO) return;
    for (let i = start; i < pool.length; i++) {
      const next = sum + pool[i].remaining;
      if (Math.abs(next) > Math.abs(txn.amount) + 0.005) continue;
      walk(i + 1, [...picked, pool[i]], next);
    }
  };
  walk(0, [], 0);
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

/** Auto-match only when the best suggestion is a single entry, clears the threshold, and is clearly ahead of any runner-up. */
export function autoPick(s: Suggestion[]): Suggestion | null {
  const [best, second] = s; if (!best || best.combined || best.confidence < AUTO_THRESHOLD) return null;
  return !second || best.confidence - second.confidence >= AUTO_MARGIN ? best : null;
}
