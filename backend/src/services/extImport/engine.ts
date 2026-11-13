// External Import — the reading side: file → grid → table layout → column mapping → normalised, validated rows.
// Pure functions only (no database), so every rule here is unit-testable.
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { HttpError } from '../../errors.js';
import { readXlsxLite } from './xlsxLite.js';

export type Cell = string | number | boolean | null | Date;
export interface Grid { name: string; rows: Cell[][] }

/* ───────────────────────────── reading files ───────────────────────────── */

const clean = (s: string) => s.replace(/[ ​]/g, ' ').replace(/\s+/g, ' ').trim();

function cellValue(v: any): Cell {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') { const s = clean(v); return s === '' ? null : s; }
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);              // formula → its cached result (never the formula text)
    if ('richText' in v) return cellValue(v.richText.map((r: any) => r.text).join(''));
    if ('text' in v) return cellValue(v.text);
    if ('error' in v) return null;
  }
  return null;
}

export const detectFormat = (name: string, buf: Buffer): 'xlsx' | 'csv' | 'pdf' => {
  const ext = name.toLowerCase().split('.').pop();
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'xlsx';                     // zip container
  if (buf[0] === 0xd0 && buf[1] === 0xcf) throw new HttpError(415, 'Legacy .xls files are not supported — open it in Excel and "Save As" .xlsx (or .csv), then upload again');
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') return 'csv';
  throw new HttpError(415, 'Unsupported file. Upload an Excel (.xlsx), CSV or PDF file');
};

async function readXlsx(buf: Buffer): Promise<Grid[]> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { return readXlsxLite(buf); }     // workbooks from other tools: use the tolerant reader
  if (!wb.worksheets.length) return readXlsxLite(buf);
  return wb.worksheets.map((ws) => {
    const rows: Cell[][] = [];
    const cols = Math.min(ws.columnCount || 0, 60);
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const out: Cell[] = [];
      for (let c = 1; c <= cols; c++) out.push(cellValue(row.getCell(c).value));
      rows[n - 1] = out;
    });
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    return { name: ws.name.trim(), rows };
  });
}

function readCsv(buf: Buffer): Grid[] {
  let text = buf.toString('utf8').replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const recs: string[][] = parseCsvSync(text, { delimiter: delim, relax_column_count: true, skip_empty_lines: true, bom: true, relax_quotes: true });
  return [{ name: 'CSV', rows: recs.map((r) => r.map((c) => cellValue(c))) }];
}

async function readPdf(buf: Buffer): Promise<Grid[]> {
  const pdfParse = (await import('pdf-parse/lib/pdf-parse.js' as any)).default;
  const pages: string[] = [];
  // Rebuild lines from text positions so table columns survive (columns are separated by a tab).
  const pagerender = async (page: any) => {
    const tc = await page.getTextContent();
    const items = tc.items.map((i: any) => ({ s: String(i.str), x: i.transform[4] as number, y: i.transform[5] as number, w: (i.width as number) || 0 })).filter((i: any) => i.s.trim() !== '');
    items.sort((a: any, b: any) => (Math.abs(a.y - b.y) > 3 ? b.y - a.y : a.x - b.x));
    const lines: any[][] = [];
    for (const it of items) { const l = lines[lines.length - 1]; if (l && Math.abs(l[0].y - it.y) <= 3) l.push(it); else lines.push([it]); }
    const out = lines.map((l) => { l.sort((a, b) => a.x - b.x); let s = '', end = -1e9; for (const it of l) { s += (s && it.x - end > 4 ? '\t' : '') + it.s; end = it.x + it.w; } return s; }).join('\n');
    pages.push(out); return out;
  };
  try { await pdfParse(buf, { pagerender }); } catch { throw new HttpError(422, 'This PDF could not be read (it may be damaged or password-protected)'); }
  const rows: Cell[][] = pages.join('\n').split('\n').map((l) => l.split('\t').map((c) => cellValue(c))).filter((r) => r.some((c) => c !== null));
  if (!rows.length) throw new HttpError(422, 'No text found in this PDF. It looks like a scanned image — OCR is not available; export the statement as Excel/CSV instead');
  return [{ name: 'PDF', rows }];
}

export async function readFile(name: string, buf: Buffer): Promise<{ format: 'xlsx' | 'csv' | 'pdf'; grids: Grid[] }> {
  const format = detectFormat(name, buf);
  const grids = format === 'xlsx' ? await readXlsx(buf).catch((e) => { if (e instanceof HttpError) throw e; throw new HttpError(422, 'This Excel file could not be read (damaged or password-protected)'); }) : format === 'csv' ? readCsv(buf) : await readPdf(buf);
  return { format, grids };
}

/* ───────────────────────────── field catalogue & synonyms ───────────────────────────── */

export const FIELDS = {
  invoice_date: 'Invoice date', invoice_no: 'Invoice number', doc_type: 'Document type', txn_date: 'Transaction date', payment_date: 'Payment date', booking_date: 'Booking date',
  passenger: 'Passenger name', pax_ref: 'Passenger ID / reference', pnr: 'PNR / booking ref', ticket_no: 'Ticket number', contact: 'Contact',
  sector: 'Sector / route', origin: 'Departure location', destination: 'Arrival location', travel_date: 'Travel date (out)', return_date: 'Return date (in)',
  airline: 'Airline', flight_no: 'Flight number',
  gross: 'Gross / fare', service_charge: 'Service charge (PSF)', tax: 'Tax', net: 'Net / total amount', debit: 'Debit', credit: 'Credit', amount_received: 'Amount received', outstanding: 'Outstanding',
  currency: 'Currency', payer: 'Payer / customer', payment_ref: 'Payment reference', description: 'Description', pay_status: 'Payment status', remarks: 'Remarks',
} as const;
export type Field = keyof typeof FIELDS;

const SYN: Record<Field, string[]> = {
  invoice_date: ['invoice date', 'inv date', 'date of invoice', 'issue date', 'bill date', 'document date', 'sale date', 'sales date', 'invoice dt'],
  invoice_no: ['invoice no', 'invoice number', 'invoice', 'inv no', 'inv number', 'inv', 'bill no', 'bill number', 'document no', 'doc no', 'invoice ref'],
  doc_type: ['invoice type', 'type', 'doc type', 'document type', 'transaction type', 'txn type', 'trans type', 'entry type'],
  txn_date: ['transaction date', 'txn date', 'trans date', 'value date', 'posting date', 'date'],
  payment_date: ['payment date', 'paid date', 'date paid', 'receipt date', 'pay date', 'received date', 'date received', 'payment dt'],
  booking_date: ['booking date', 'reservation date', 'booked on', 'date booked', 'booking dt'],
  passenger: ['pax name', 'passenger', 'passenger name', 'pax', 'customer name', 'traveller', 'traveler', 'traveller name', 'traveler name', 'guest name', 'name', 'name of passenger', 'pax names'],
  pax_ref: ['passenger id', 'pax id', 'passenger ref', 'pax ref', 'passenger reference', 'customer id', 'employee id', 'emp id', 'employee no', 'staff id'],
  pnr: ['pnr', 'booking reference', 'booking ref', 'record locator', 'confirmation no', 'confirmation number', 'reservation code', 'gds pnr', 'booking code', 'booking no', 'booking number', 'locator'],
  ticket_no: ['ticket no', 'ticket number', 'ticket', 'tkt no', 'tkt', 'e ticket', 'eticket', 'ticket num', 'tkt number', 'document number'],
  contact: ['contact', 'contact no', 'contact number', 'contact information', 'phone', 'mobile', 'email', 'phone number', 'mobile no'],
  sector: ['sector', 'route', 'itinerary', 'travel route', 'routing', 'sectors', 'origin destination', 'od'],
  origin: ['origin', 'from', 'departure', 'departure city', 'departure location', 'depart from', 'dep city', 'from city', 'departure airport', 'from airport'],
  destination: ['destination', 'to', 'arrival', 'arrival city', 'arrival location', 'arr city', 'to city', 'arrival airport', 'to airport', 'dest'],
  travel_date: ['travel date', 'departure date', 'flight date', 'date out bound', 'date outbound', 'out bound', 'outbound', 'dep date', 'date of travel', 'date of departure', 'outbound date', 'out bound date', 'date out'],
  return_date: ['return date', 'date in bound', 'date inbound', 'in bound', 'inbound', 'inbound date', 'in bound date', 'date of return', 'return', 'date in'],
  airline: ['airline', 'carrier', 'airlines', 'airline name', 'flight carrier', 'operating carrier'],
  flight_no: ['flight no', 'flight number', 'flight', 'flt no', 'flt number', 'flight num'],
  gross: ['gross', 'gross amount', 'fare', 'base fare', 'amount', 'total fare', 'basic fare', 'price', 'sale amount', 'invoice amount', 'sales amount', 'fare amount', 'selling price'],
  service_charge: ['psf', 'service charge', 'service charges', 'service fee', 'service fees', 'fee', 'fees', 'handling', 'handling fee', 'agency fee', 'processing fee', 'sc'],
  tax: ['tax', 'taxes', 'vat', 'gst', 'tax amount', 'sales tax', 'wht', 'other tax'],
  net: ['net', 'net amount', 'total', 'total amount', 'grand total', 'invoice total', 'net total', 'total invoice', 'invoiced amount', 'total payable', 'amount payable'],
  debit: ['debit', 'debit amount', 'dr', 'dr amount', 'debits'],
  credit: ['credit', 'credit amount', 'cr', 'cr amount', 'credits'],
  amount_received: ['amount received', 'received', 'payment', 'payment amount', 'paid amount', 'amount paid', 'receipt amount', 'received amount', 'paid', 'payments received', 'receipts'],
  outstanding: ['outstanding', 'balance', 'balance due', 'due', 'amount due', 'open amount', 'outstanding amount', 'pending', 'balance amount'],
  currency: ['currency', 'curr', 'ccy', 'cur'],
  payer: ['payer', 'payer name', 'paid by', 'client', 'client name', 'company', 'company name', 'account', 'account name', 'bill to', 'customer', 'party', 'party name', 'received from', 'remitter'],
  payment_ref: ['payment reference', 'payment ref', 'reference', 'ref no', 'ref', 'cheque no', 'check no', 'transaction ref', 'txn ref', 'utr', 'receipt no', 'transaction id', 'txn id', 'reference no', 'reference number', 'payment no', 'voucher no'],
  description: ['description', 'narration', 'particulars', 'details', 'payment description', 'narrative', 'memo'],
  pay_status: ['payment status', 'status', 'paid status'],
  remarks: ['remarks', 'remark', 'notes', 'note', 'comment', 'comments'],
};
const GENERIC = new Set(['date', 'no', 'type', 'number', 'name', 'amount', 'ref', 'status']);

export const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const IDX = new Map<string, [Field, number][]>();
for (const f of Object.keys(SYN) as Field[]) for (const s of SYN[f]) { const k = norm(s); (IDX.get(k) ?? IDX.set(k, []).get(k)!).push([f, 100]); }

/** Best field for one header label with a confidence (0-100); null when nothing is close. */
export function guessField(label: string): { field: Field; confidence: number } | null {
  const n = norm(label); if (!n) return null;
  const exact = IDX.get(n); if (exact) return { field: exact[0][0], confidence: 100 };
  let best: { field: Field; confidence: number } | null = null;
  for (const f of Object.keys(SYN) as Field[]) for (const s of SYN[f]) {
    const k = norm(s); if (k.length < 3) continue;
    const c = ` ${n} `.includes(` ${k} `) ? 70 + Math.min(20, k.length) : k.length >= 5 && ` ${k} `.includes(` ${n} `) && n.length >= 4 ? 55 : 0;
    if (c > (best?.confidence ?? 0)) best = { field: f, confidence: c };
  }
  return best;
}

/** Map header labels → columns. A saved template (label→field) wins over the built-in dictionary. Each field gets one column. */
export function autoMap(headers: string[], template?: Record<string, string>): { map: Partial<Record<Field, number>>; confidence: Partial<Record<Field, number>> } {
  const cands: { col: number; field: Field; conf: number }[] = [];
  headers.forEach((h, col) => {
    const n = norm(h); if (!n) return;
    const t = template?.[n] as Field | undefined;
    if (t && t in FIELDS) { cands.push({ col, field: t, conf: 101 }); return; }
    const g = guessField(h); if (g) cands.push({ col, field: g.field, conf: g.confidence });
  });
  cands.sort((a, b) => b.conf - a.conf || a.col - b.col);
  const map: Partial<Record<Field, number>> = {}, confidence: Partial<Record<Field, number>> = {}, used = new Set<number>();
  for (const c of cands) { if (map[c.field] !== undefined || used.has(c.col)) continue; map[c.field] = c.col; confidence[c.field] = Math.min(100, c.conf); used.add(c.col); }
  // A lone "date" column is the invoice date when the file has no better one.
  if (map.txn_date !== undefined && map.invoice_date === undefined && map.payment_date === undefined) { map.invoice_date = map.txn_date; confidence.invoice_date = 60; delete map.txn_date; delete confidence.txn_date; }
  return { map, confidence };
}

/* ───────────────────────────── layout (where the table is) ───────────────────────────── */

export interface SheetLayout {
  name: string; kind: 'table' | 'reference' | 'no_header' | 'empty'; reason?: string;
  headerRow?: number;                  // 1-based row of the (last) header line
  headers: string[]; map: Partial<Record<Field, number>>; confidence: Partial<Record<Field, number>>; sig: string;
  title?: string; rowCount: number; sections: string[]; sample?: string[];
}
export interface RawRow { sheet: string; src_row: number; section: string | null; cells: Cell[] }
export interface Totals { sheet: string; gross: number | null; service: number | null; net: number | null; src_row: number }

const REFERENCE_SHEET = /index|audit|issue|summary|log|control|reconcil|notes?$/i;
const isEmpty = (c: Cell) => c === null || c === '' || (typeof c === 'number' && c === 0);
const text = (c: Cell) => (typeof c === 'string' ? c : c instanceof Date ? '' : c == null ? '' : String(c));

/** Header text for one column: the sub-heading, prefixed by the group above it when the sub-heading is generic ("DATE" under "INVOICE"). */
function headerLabels(rows: Cell[][], hi: number): string[] {
  const sub = rows[hi] ?? [], group = hi > 0 ? rows[hi - 1] ?? [] : [];
  return sub.map((c, i) => {
    const s = text(c), g = text(group[i] ?? null);
    if (!s) return '';
    if (g && norm(g) !== norm(s) && GENERIC.has(norm(s)) && !/^s\s?no|sr|^no$/.test(norm(g))) return `${g} ${s}`;
    return s;
  });
}

export function analyzeGrid(g: Grid, template?: Record<string, string>): { layout: SheetLayout; rows: RawRow[]; totals: Totals[]; pairs: Record<string, number> } {
  const base: SheetLayout = { name: g.name, kind: 'empty', headers: [], map: {}, confidence: {}, sig: '', rowCount: 0, sections: [] };
  const rows = g.rows;
  if (!rows.some((r) => r?.some((c) => c !== null))) return { layout: { ...base, reason: 'Sheet is empty' }, rows: [], totals: [], pairs: {} };
  // Header = the row (in the first 40) whose cells look most like known column names.
  let best = -1, bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const labels = headerLabels(rows, i);
    const fields = new Set(labels.map((l) => guessField(l)).filter((g2) => g2 && g2.confidence >= 70).map((g2) => g2!.field));
    const strCells = (rows[i] ?? []).filter((c) => typeof c === 'string').length;
    const score = fields.size + (strCells >= fields.size ? 0 : -1);
    if (fields.size >= 3 && score > bestScore) { best = i; bestScore = score; }
  }
  const pairs = labelValuePairs(rows);
  const title = text(rows.find((r) => r?.some((c) => typeof c === 'string' && c.length > 12))?.find((c) => typeof c === 'string') ?? null) || undefined;
  if (best < 0) return { layout: { ...base, kind: 'no_header', reason: 'No column headings recognised in this sheet', title }, rows: [], totals: [], pairs };
  const headers = headerLabels(rows, best);
  const { map, confidence } = autoMap(headers, template);
  const sig = crypto.createHash('sha1').update(headers.map(norm).join('|')).digest('hex').slice(0, 12);
  const kind: SheetLayout['kind'] = REFERENCE_SHEET.test(g.name) ? 'reference' : 'table';
  const out: RawRow[] = [], totals: Totals[] = [], sections = new Set<string>();
  let section: string | null = null;
  for (let i = best + 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    const filled = cells.filter((c) => c !== null && c !== '');
    if (!filled.length) continue;
    const strs = filled.filter((c) => typeof c === 'string') as string[];
    if (strs.some((s) => /master\s+summary|^summary$/i.test(s))) break;                     // summary block at the foot of the sheet
    const distinct = new Set(filled.map((c) => String(c)));
    if (distinct.size === 1 && strs.length === filled.length && !/^total/i.test(strs[0]) && strs[0].length < 60) { section = strs[0].replace(/\s+/g, ' ').trim(); sections.add(section); continue; }
    if (strs.some((s) => /^(grand\s+)?total\b/i.test(s))) {
      const num = (f: Field) => { const c = map[f]; const v = c === undefined ? null : cells[c]; return typeof v === 'number' ? v : null; };
      totals.push({ sheet: g.name, gross: num('gross'), service: num('service_charge'), net: num('net'), src_row: i + 1 });
      continue;
    }
    if (!cells.some((c, ci) => !isEmpty(c) && ci > 0) ) continue;                           // a bare serial number or formula zeros
    out.push({ sheet: g.name, src_row: i + 1, section, cells });
  }
  const sample = headers.map((_, i) => { for (const r of out.slice(0, 8)) { const v = r.cells[i]; if (v !== null && v !== undefined && v !== '' && v !== 0) return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 30); } return ''; });
  return { layout: { ...base, kind, headerRow: best + 1, headers, map, confidence, sig, title, rowCount: out.length, sections: [...sections], sample }, rows: out, totals, pairs };
}

/** "SOA Gross | 3644970" style control figures at the top of an index/summary sheet. */
function labelValuePairs(rows: Cell[][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows.slice(0, 15)) for (let i = 0; i < (r?.length ?? 0) - 1; i++) {
    const k = r[i], v = r[i + 1];
    if (typeof k === 'string' && typeof v === 'number' && /gross|net|psf|transactions|invoices|refunds|total/i.test(k)) out[k.trim()] = v;
  }
  return out;
}

/* ───────────────────────────── value parsing ───────────────────────────── */

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y: number, m: number, d: number) => {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};

/** Day-first (DD/MM/YYYY) is assumed for slash/dash dates — the format the statement's region uses; ISO and named months are unambiguous. */
export function parseDate(v: Cell): { date: string | null; bad?: string } {
  if (v === null || v === '') return { date: null };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { date: null, bad: String(v) } : { date: v.toISOString().slice(0, 10) };
  if (typeof v === 'number') {
    if (v >= 20000 && v <= 80000) return { date: new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10) };   // Excel serial
    return { date: null, bad: String(v) };
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(s); if (m) { const d = iso(+m[1], +m[2], +m[3]); return d ? { date: d } : { date: null, bad: s }; }
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(s); if (m) { const d = iso(+m[3], +m[2], +m[1]); return d ? { date: d } : { date: null, bad: s }; }
  m = /^(\d{1,2})[\s\-/]([A-Za-z]{3,9})[\s\-/,]*(\d{2,4})$/.exec(s); if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) { const d = iso(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]); return d ? { date: d } : { date: null, bad: s }; }
  return { date: null, bad: s };
}

export function parseAmount(v: Cell): { n: number | null; bad?: string } {
  if (v === null || v === '') return { n: null };
  if (typeof v === 'number') return Number.isFinite(v) ? { n: v } : { n: null, bad: String(v) };
  let s = String(v).trim(); if (!s || /^[-–—]+$/.test(s)) return { n: null };
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/\bCR\b\s*$/i.test(s)) s = s.replace(/\bCR\b/i, ''); if (/\bDR\b\s*$/i.test(s)) s = s.replace(/\bDR\b/i, '');
  s = s.replace(/[A-Za-z]{3}\b|[$£€₨]|Rs\.?/g, '').replace(/[,\s]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(s)) return { n: null, bad: String(v) };
  return { n: neg ? -Number(s) : Number(s) };
}

const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'MSTR', 'MASTER', 'DR', 'PROF', 'INF', 'CHD']);
export const displayName = (s: string) => clean(s).toUpperCase();
/** Order-insensitive passenger identity: titles dropped, punctuation removed, words sorted. */
export const paxKey = (s: string | null) => s ? clean(s).toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter((w) => w && !TITLES.has(w)).sort().join(' ') || null : null;

const AIRLINES: Record<string, string> = { airblue: 'Airblue', flyjinnah: 'Fly Jinnah', jinnah: 'Fly Jinnah', pia: 'PIA', pk: 'PIA', airsial: 'AirSial', emirates: 'Emirates', thaiair: 'Thai Airways', thai: 'Thai Airways', thaiairways: 'Thai Airways', qatar: 'Qatar Airways', qatarairways: 'Qatar Airways', etihad: 'Etihad', turkish: 'Turkish Airlines', turkishairlines: 'Turkish Airlines', saudia: 'Saudia', flydubai: 'flydubai', airarabia: 'Air Arabia', srilankan: 'SriLankan Airlines', singapore: 'Singapore Airlines', britishairways: 'British Airways', gulfair: 'Gulf Air', omanair: 'Oman Air' };
export const airlineName = (s: string | null) => { if (!s) return null; const k = s.toLowerCase().replace(/[^a-z]/g, ''); return AIRLINES[k] ?? clean(s).replace(/\b\w/g, (c) => c.toUpperCase()); };

/** KHI-BKK-KHI → origin KHI, destination BKK. Free-text routes ("SPAIN VISA") become the destination only. */
export function splitSector(sector: string | null): { origin: string | null; destination: string | null } {
  if (!sector) return { origin: null, destination: null };
  const toks = sector.toUpperCase().split(/\s*(?:[-/→>]|\bTO\b)\s*/).map((t) => t.trim()).filter(Boolean);
  if (toks.length >= 2 && toks.every((t) => /^[A-Z]{3}$/.test(t))) return { origin: toks[0], destination: toks.length >= 3 && toks[toks.length - 1] === toks[0] ? toks[1] : toks[toks.length - 1] };
  return { origin: null, destination: clean(sector).toUpperCase() };
}

/* ───────────────────────────── a row → a validated record ───────────────────────────── */

export type Kind = 'sale' | 'credit_note' | 'refund' | 'exchange' | 'payment' | 'reversal';
export interface Rec {
  kind: Kind; section: string | null; doc_type: string | null;
  invoice_no: string | null; invoice_date: string | null; txn_date: string | null; payment_date: string | null; booking_date: string | null;
  passenger_name: string | null; passenger_key: string | null; pax_ref: string | null; contact: string | null; payer_name: string | null;
  pnr: string | null; ticket_no: string | null; payment_ref: string | null;
  sector: string | null; origin: string | null; destination: string | null; airline: string | null; flight_no: string | null; travel_date: string | null; return_date: string | null;
  currency: string | null; gross: number; tax: number; service_charge: number; net: number; debit: number; credit: number;
  pay_status: string | null; description: string | null; remarks: string | null;
  outstanding_in_file: number | null;
}
export interface Problem { level: 'error' | 'warning'; field?: string; msg: string }
export interface Normalised { rec: Rec | null; problems: Problem[]; skip?: string }

const SALE_WORDS = /^(sales?|sale|visa|ticket|invoice|inv|hotel|package|umrah|service|insurance|booking|new)$/i;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function classify(docType: string | null, section: string | null): Kind | 'unknown' | 'none' {
  const t = (docType ?? '').toUpperCase().replace(/\s+/g, ' ').trim(), s = (section ?? '').toUpperCase();
  if (/REFUND/.test(t)) return 'refund';
  if (/CREDIT\s*NOTE|^CN$/.test(t)) return 'credit_note';
  if (/RE-?ISSUE|EXCHANGE|REVALIDAT|DATE CHANGE/.test(t)) return 'exchange';
  if (/REVERS|VOID|CANCEL/.test(t)) return 'reversal';
  if (/PAYMENT|RECEIPT|RECEIVED|REMITT/.test(t)) return 'payment';
  if (!t) return 'none';
  if (SALE_WORDS.test(t)) return /CREDIT\s*NOTE/.test(s) ? 'credit_note' : 'sale';
  return 'unknown';
}

export function normaliseRow(cells: Cell[], map: Partial<Record<Field, number>>, section: string | null, ctx: { currency?: string | null; payer?: string | null } = {}): Normalised {
  const problems: Problem[] = [];
  const raw = (f: Field): Cell => { const c = map[f]; return c === undefined ? null : (cells[c] ?? null); };
  const str = (f: Field, max = 200) => { const v = raw(f); if (v === null) return null; const s = v instanceof Date ? v.toISOString().slice(0, 10) : clean(String(v)); return s ? s.slice(0, max) : null; };
  const remarks: string[] = [];
  const date = (f: Field) => { const v = raw(f); const p = parseDate(v); if (p.bad !== undefined) { problems.push({ level: 'warning', field: f, msg: `"${p.bad}" is not a date — kept in remarks, not used as a date` }); remarks.push(`${FIELDS[f]}: ${p.bad}`); } return p.date; };
  const amount = (f: Field) => { const p = parseAmount(raw(f)); if (p.bad !== undefined) problems.push({ level: 'error', field: f, msg: `"${p.bad}" is not a valid amount` }); return p.n; };

  const docType = str('doc_type', 40);
  let kind = classify(docType, section);
  if (kind === 'credit_note' && classify(docType, null) === 'sale') problems.push({ level: 'warning', field: 'doc_type', msg: `Typed “${docType}” but listed under “${section}” — treated as a credit note (amount is deducted)` });
  const invoice_no = str('invoice_no', 60)?.toUpperCase() ?? null;
  const passengerRaw = str('passenger', 200);
  const pnr = str('pnr', 30)?.toUpperCase().replace(/\s+/g, '') ?? null;
  const ticket_no = str('ticket_no', 40)?.replace(/[\s-]/g, '') ?? null;
  const sector = str('sector', 120)?.toUpperCase() ?? null;
  const sp = splitSector(sector);
  const origin = str('origin', 60)?.toUpperCase() ?? sp.origin, destination = str('destination', 60)?.toUpperCase() ?? sp.destination;

  let gross = amount('gross'), service = amount('service_charge'), tax = amount('tax'), net = amount('net');
  const debit = amount('debit'), credit = amount('credit'), received = amount('amount_received'), outstanding = amount('outstanding');
  const inv_date = date('invoice_date'), pay_date = date('payment_date'), txn_date0 = date('txn_date');

  const hasCore = !!(invoice_no || passengerRaw || pnr || ticket_no);
  const anyAmount = [gross, net, received, debit, credit].some((x) => x !== null && x !== 0);
  if (!hasCore && !anyAmount) return { rec: null, problems, skip: 'No passenger, invoice or amount on this line' };
  if (!hasCore && anyAmount && kind === 'none' && received === null && credit === null) return { rec: null, problems, skip: 'Looks like a subtotal or note line (amount without any passenger or invoice)' };

  // Payments are rows that carry a received amount (or only a credit) and no sales figures.
  if (kind === 'none' && /CREDIT\s*NOTE/i.test(section ?? '') && hasCore) kind = 'credit_note';
  const salesFigures = (gross ?? 0) !== 0 || (net ?? 0) !== 0 || (debit ?? 0) !== 0;
  if (kind === 'none') kind = !salesFigures && ((received ?? 0) !== 0 || (credit ?? 0) !== 0) ? 'payment' : salesFigures ? 'sale' : 'none';
  if (kind === 'unknown') { problems.push({ level: 'error', field: 'doc_type', msg: `Unrecognised document type "${docType}" — map it or fix the cell` }); kind = 'sale'; }
  if (kind === 'none') { problems.push({ level: 'error', msg: 'Could not tell whether this line is a sale, credit note or payment' }); kind = 'sale'; }

  let amountNet: number;
  if (kind === 'payment') {
    const a = received ?? credit ?? net ?? gross;
    if (a === null || a === 0) { problems.push({ level: 'error', field: 'amount_received', msg: 'Payment amount missing' }); amountNet = 0; } else amountNet = Math.abs(a);
    gross = amountNet; service = 0; tax = 0; net = amountNet;
  } else {
    if (net === null && gross === null && debit !== null) { net = debit; }
    if (gross === null && net !== null) { gross = r2(net - (service ?? 0) - (tax ?? 0)); problems.push({ level: 'warning', field: 'gross', msg: 'Gross not in the file — worked out as net minus charges' }); }
    if (net === null && gross !== null) net = r2(gross + (service ?? 0) + (tax ?? 0));
    if (gross === null || net === null) { problems.push({ level: 'error', field: 'net', msg: 'No amount on this line' }); gross = net = 0; }
    else if (Math.abs(net - (gross + (service ?? 0) + (tax ?? 0))) > 1) problems.push({ level: 'warning', field: 'net', msg: `Net ${net} differs from gross + charges ${r2(gross + (service ?? 0) + (tax ?? 0))}` });
    const sign = kind === 'credit_note' || kind === 'refund' || kind === 'reversal' ? -1 : 1;
    gross = r2(sign * Math.abs(gross)); net = r2(sign * Math.abs(net)); service = r2(sign * Math.abs(service ?? 0)); tax = r2(sign * Math.abs(tax ?? 0));
    amountNet = net;
  }

  const txn_date = kind === 'payment' ? pay_date ?? txn_date0 : inv_date ?? txn_date0;
  if (!txn_date) problems.push({ level: 'error', field: kind === 'payment' ? 'payment_date' : 'invoice_date', msg: `${kind === 'payment' ? 'Payment' : 'Invoice'} date missing or unreadable — the upload date is never used instead` });
  else if (+txn_date.slice(0, 4) < 2000 || +txn_date.slice(0, 4) > 2100) problems.push({ level: 'error', field: 'invoice_date', msg: `Date ${txn_date} is out of range` });
  if (kind !== 'payment' && !hasCore) problems.push({ level: 'error', msg: 'Needs a passenger, invoice number, PNR or ticket number' });
  if (kind !== 'payment' && !passengerRaw) problems.push({ level: 'warning', field: 'passenger', msg: 'Passenger name missing' });
  if (kind === 'payment' && !str('payment_ref') && !invoice_no && !pnr && !ticket_no && !passengerRaw && !str('payer')) problems.push({ level: 'warning', msg: 'Payment has no reference, invoice or passenger — it will stay unmatched' });
  const trav = date('travel_date'), ret = date('return_date'), booking = date('booking_date');
  if (trav && ret && ret < trav) problems.push({ level: 'warning', field: 'return_date', msg: 'Return date is before the travel date' });
  const cur = (str('currency', 3) ?? ctx.currency ?? null)?.toUpperCase() ?? null;
  if (cur && !/^[A-Z]{3}$/.test(cur)) problems.push({ level: 'error', field: 'currency', msg: `"${cur}" is not a 3-letter currency code` });
  const rem = [str('remarks', 500), ...remarks].filter(Boolean).join(' · ').slice(0, 500) || null;

  const rec: Rec = {
    kind, section, doc_type: docType, invoice_no, invoice_date: inv_date, txn_date, payment_date: pay_date, booking_date: booking,
    passenger_name: passengerRaw ? displayName(passengerRaw) : null, passenger_key: paxKey(passengerRaw), pax_ref: str('pax_ref', 60), contact: str('contact'), payer_name: str('payer') ?? ctx.payer ?? null,
    pnr, ticket_no, payment_ref: str('payment_ref', 100), sector, origin, destination, airline: airlineName(str('airline', 80)), flight_no: str('flight_no', 20)?.toUpperCase() ?? null,
    travel_date: trav, return_date: ret, currency: cur, gross: gross ?? 0, tax: tax ?? 0, service_charge: service ?? 0, net: amountNet,
    debit: 0, credit: 0, pay_status: str('pay_status', 30), description: str('description', 300), remarks: rem, outstanding_in_file: outstanding,
  };
  // Ledger view from the client's side: invoices debit the account; payments, credit notes and refunds credit it.
  if (kind === 'sale' || kind === 'exchange') rec.debit = Math.abs(rec.net); else rec.credit = Math.abs(rec.net);
  if (debit !== null && kind !== 'payment' && debit !== 0 && Math.abs(Math.abs(debit) - Math.abs(rec.net)) > 1) problems.push({ level: 'warning', field: 'debit', msg: `Debit column (${debit}) differs from the line amount (${rec.net})` });
  return { rec, problems };
}

/* ───────────────────────────── duplicate keys ───────────────────────────── */

const h = (...p: unknown[]) => crypto.createHash('sha1').update(p.map((x) => String(x ?? '').toUpperCase()).join('|')).digest('hex');
/** Strong key: everything that identifies this exact line. Weak key: the same document line regardless of amount/date (a possible correction). */
export const strongKey = (r: Rec) => r.kind === 'payment' ? h('P', r.payment_ref, r.payment_date, r.net, r.payer_name, r.invoice_no) : h('S', r.kind, r.invoice_no, r.pnr, r.ticket_no, r.passenger_key, r.sector, r.txn_date, r.net);
export const weakKey = (r: Rec) => r.kind === 'payment' ? h('PW', r.payment_ref || r.invoice_no, r.payer_name) : h('SW', r.kind, r.invoice_no, r.pnr, r.ticket_no, r.passenger_key, r.sector);
