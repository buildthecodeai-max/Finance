import ExcelJS from 'exceljs';
import { esc, letterheadHtml } from './pdf.js';

/*
 * One place that turns a finished report into a file (Excel, PDF, CSV), so the on-screen table, the download and
 * the scheduled e-mail all look and add up the same way.
 */

export interface Reconcile { label: string; report: number; source: number; difference: number; ok: boolean }
export type ColType = 'text' | 'money' | 'int' | 'date';
export interface Summary { label: string; value: string; unit?: '%'; tone?: 'good' | 'bad' | 'warn' | 'info'; hint?: string }
export interface Chart { kind: 'bars'; labels: string[]; series: { name: string; values: number[]; tone?: 'good' | 'bad' | 'accent' | 'warn' }[] }
/**
 * links[i] is an in-app route for rows[i] (drill-down); kinds[i] is 'section' | 'total' | 'muted' for styling.
 * types, when given, says what each column holds; otherwise it is worked out from the cells.
 * summary = the few numbers worth seeing before the table; hints = softer "worth a look" notes (not a failed check).
 */
export interface Report {
  title: string; columns: string[]; rows: any[][]; reconcile?: Reconcile[]; note?: string; links?: (string | null)[]; kinds?: string[];
  types?: ColType[]; summary?: Summary[]; chart?: Chart; hints?: string[];
}

const MONEY = /^-?\d+\.\d{2}$/, INT = /^-?\d+$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID_LIKE = /code|number|ref|reference|voucher|\bno\b|\bid\b/i;   // columns whose digits are names, not quantities

/** What each column holds, so numbers line up on the right and dates, amounts and codes are written properly. */
export function colKinds(r: Pick<Report, 'columns' | 'rows' | 'kinds' | 'types'>): ColType[] {
  if (r.types && r.types.length === r.columns.length) return r.types;
  return r.columns.map((h, c) => {
    const cells = r.rows.filter((_, i) => !['total', 'section'].includes(r.kinds?.[i] ?? '')).map((row) => row[c]).filter((v) => v !== '' && v != null).map(String);
    if (!cells.length) return 'text';
    const share = (re: RegExp) => cells.filter((v) => re.test(v)).length / cells.length;
    if (share(DATE) === 1) return 'date';
    if (share(MONEY) >= 0.7) return 'money';
    if (share(INT) >= 0.7 && !ID_LIKE.test(h) && cells.every((v) => !INT.test(v) || String(Number(v)) === v)) return 'int';
    return 'text';
  });
}

/** A worksheet name Excel accepts: no \ / ? * : [ ], at most 31 characters, and without the dates that make titles long. */
export function sheetName(title: string) {
  const t = title.replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/[→,]/g, ' ').replace(/\s+as at\s*$/i, '').replace(/[\\/?*:[\]]/g, '-').replace(/\s+/g, ' ').replace(/^['\s-]+|['\s-]+$/g, '');
  return (t || 'Report').slice(0, 31);
}

const fmtMoney = (v: string) => Number(v).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cellValue = (v: any, k: ColType) => {
  if (v === '' || v == null) return null;
  const s = String(v);
  if ((k === 'money' && MONEY.test(s)) || (k === 'int' && INT.test(s))) return Number(s);
  if (k === 'date' && DATE.test(s)) return new Date(`${s}T00:00:00Z`);
  return v;
};
export const isWide = (r: Pick<Report, 'columns'>) => r.columns.length >= 7;

/* ---------------------------------------------------------------------- Excel */
export async function reportXlsx(r: Report, brand?: { agency?: any }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); wb.creator = brand?.agency?.name ?? 'Travel CRM'; wb.created = new Date();
  const kinds = colKinds(r), n = r.columns.length;
  const ws = wb.addWorksheet(sheetName(r.title), { pageSetup: { paperSize: 9, orientation: isWide(r) ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const muted = { color: { argb: 'FF6B7686' }, size: 9 } as const;
  let row = 1;
  if (brand?.agency?.name) { ws.getCell(row, 1).value = brand.agency.name; ws.getCell(row, 1).font = { bold: true, size: 13 }; row++; }
  ws.getCell(row, 1).value = r.title; ws.getCell(row, 1).font = { bold: true, size: 12 }; row++;
  ws.getCell(row, 1).value = `Prepared ${new Date().toISOString().slice(0, 10)}`; ws.getCell(row, 1).font = muted; row += 2;

  const head = row;
  r.columns.forEach((c, i) => {
    const cell = ws.getCell(head, i + 1); cell.value = c; cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    cell.alignment = { horizontal: kinds[i] === 'money' || kinds[i] === 'int' ? 'right' : 'left', vertical: 'middle', wrapText: true };
  });
  ws.views = [{ state: 'frozen', ySplit: head }];
  const widths = r.columns.map((c, i) => Math.max(String(c).length + 2, kinds[i] === 'money' ? 14 : 8));

  r.rows.forEach((vals, ri) => {
    const kind = r.kinds?.[ri] ?? '', rowNo = head + 1 + ri;
    vals.forEach((v, ci) => {
      const cell = ws.getCell(rowNo, ci + 1), k = kinds[ci], val = cellValue(v, k);
      cell.value = val as any;
      if (val !== null && typeof val === 'number') cell.numFmt = k === 'money' ? '#,##0.00;[Red]-#,##0.00' : '0';
      if (val instanceof Date) cell.numFmt = 'yyyy-mm-dd';
      cell.alignment = { horizontal: k === 'money' || k === 'int' ? 'right' : 'left', vertical: 'top' };
      if (kind === 'total') { cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }; cell.border = { top: { style: 'thin', color: { argb: 'FF94A3B8' } } }; }
      else if (kind === 'section') { cell.font = { bold: true, color: { argb: 'FF007662' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F6F2' } }; }
      else if (kind === 'muted') cell.font = { italic: true, color: { argb: 'FF6B7686' } };
      const shown = typeof val === 'number' && k === 'money' ? fmtMoney(String(val)) : String(v ?? '');
      widths[ci] = Math.max(widths[ci], Math.min(shown.length + 2, 46));
    });
  });
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = Math.min(w, 46)));
  if (!r.rows.some((_, i) => ['total', 'section'].includes(r.kinds?.[i] ?? '')) && r.rows.length > 8) ws.autoFilter = { from: { row: head, column: 1 }, to: { row: head, column: n } };

  row = head + r.rows.length + 2;
  for (const c of r.reconcile ?? []) {
    ws.getCell(row, 1).value = `${c.ok ? 'Reconciled' : 'Does not reconcile'} — ${c.label} (report ${fmtMoney(String(c.report))}, source ${fmtMoney(String(c.source))}${c.ok ? '' : `, difference ${fmtMoney(String(c.difference))}`})`;
    ws.getCell(row, 1).font = { size: 9, bold: !c.ok, color: { argb: c.ok ? 'FF047051' : 'FFB91C1C' } }; row++;
  }
  for (const h of r.hints ?? []) { ws.getCell(row, 1).value = `Note — ${h}`; ws.getCell(row, 1).font = { size: 9, color: { argb: 'FFA44A07' } }; row++; }
  if (r.note) { ws.mergeCells(row, 1, row, Math.max(n, 2)); const c = ws.getCell(row, 1); c.value = r.note; c.font = muted; c.alignment = { wrapText: true, vertical: 'top' }; ws.getRow(row).height = Math.max(14, Math.ceil(r.note.length / (widths.reduce((s, w) => s + w, 0) * 1.1)) * 13); }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ------------------------------------------------------------------------ CSV */
export function reportCsv(r: Report): Buffer {
  // a cell that starts with = + - @ would run as a formula in Excel: prefix it (numbers are left alone)
  const cell = (v: unknown) => { const s = String(v ?? ''); const risky = /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s); const t = risky ? `'${s}` : s; return /[",\r\n]/.test(t) || risky ? `"${t.replace(/"/g, '""')}"` : t; };
  return Buffer.from('﻿' + [r.columns, ...r.rows].map((row) => row.map(cell).join(',')).join('\r\n'), 'utf8');
}

/* ------------------------------------------------------------------------ PDF */
export function reportHtml(r: Report, brand?: { agency: any; logo?: { data: string; mime: string } | null }): string {
  const kinds = colKinds(r), right = (i: number) => kinds[i] === 'money' || kinds[i] === 'int';
  const show = (v: any, k: ColType) => (k === 'money' && MONEY.test(String(v)) ? fmtMoney(String(v)) : String(v ?? ''));
  const head = brand ? `<div class="bar"></div><div style="margin-bottom:12px">${letterheadHtml(brand.agency, brand.logo)}</div>` : '';
  const checks = (r.reconcile ?? []).map((c) => `<div class="chk ${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓ Reconciled' : '⚠ Does not reconcile'} — ${esc(c.label)}<span>report ${fmtMoney(String(c.report))} · source ${fmtMoney(String(c.source))}${c.ok ? '' : ` · difference ${fmtMoney(String(c.difference))}`}</span></div>`).join('');
  const hints = (r.hints ?? []).map((h) => `<div class="chk warn">${esc(h)}</div>`).join('');
  const sums = (r.summary ?? []).length ? `<div class="sum">${r.summary!.map((s) => `<div><span>${esc(s.label)}</span><b class="${s.tone ?? ''}">${esc(s.unit === '%' ? `${fmtMoney(s.value)}%` : MONEY.test(s.value) ? fmtMoney(s.value) : s.value)}</b></div>`).join('')}</div>` : '';
  const body = r.rows.map((row, ri) => `<tr class="${r.kinds?.[ri] ?? ''}">${row.map((v, ci) => `<td class="${right(ci) ? 'r' : ''}">${esc(show(v, kinds[ci]))}</td>`).join('')}</tr>`).join('');
  const css = `*{box-sizing:border-box}body{font-family:Inter,Helvetica,Arial,sans-serif;color:#1b2430;font-size:10px;line-height:1.4;margin:0}
.bar{height:5px;background:#00A586;border-radius:3px;margin-bottom:14px}.brand{font-size:15px;font-weight:700;color:#0f172a}.addr{white-space:pre-line;color:#6b7686;margin-top:3px;max-width:260px}.m{color:#6b7686}
h1{font-size:17px;margin:0 0 4px;color:#0f172a}.gen{color:#8a94a3;font-size:9px;margin-bottom:10px}
.sum{display:flex;gap:10px;margin:0 0 10px}.sum div{flex:1;border:1px solid #e3e7ee;border-radius:6px;padding:6px 9px}.sum span{display:block;color:#6b7686;font-size:8.5px;text-transform:uppercase;letter-spacing:.5px}.sum b{font-size:13px}.sum b.good{color:#067a55}.sum b.bad{color:#b42318}.sum b.warn{color:#9a5b00}
.chk{border-radius:6px;padding:5px 9px;margin-bottom:5px;font-size:9.5px;display:flex;justify-content:space-between;gap:10px}.chk.ok{background:#e7f6ef;color:#067a55}.chk.bad{background:#fde9e9;color:#b42318}.chk.warn{background:#fdf0d5;color:#8a5200;display:block}
table.rep{width:100%;border-collapse:collapse;margin-top:6px}.rep thead{display:table-header-group}
.rep th{background:#0f172a;color:#fff;text-align:left;padding:6px 8px;font-size:8.5px;text-transform:uppercase;letter-spacing:.5px}.rep th.r,.rep td.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.rep td{padding:4px 8px;border-bottom:1px solid #e9edf3;vertical-align:top}.rep tr{page-break-inside:avoid}
.rep tr.total td{font-weight:700;background:#f1f5f9;border-top:1.5px solid #94a3b8}.rep tr.section td{font-weight:700;color:#007662;background:#e8f6f2;letter-spacing:.3px}.rep tr.muted td{color:#6b7686;font-style:italic}
.note{color:#6b7686;font-size:9px;margin-top:12px}`;
  return `<html><head><meta charset="utf-8"><style>${css}</style></head><body>${head}<h1>${esc(r.title)}</h1><div class="gen">Prepared ${new Date().toISOString().slice(0, 10)}</div>${sums}${checks}${hints}
<table class="rep"><thead><tr>${r.columns.map((c, i) => `<th class="${right(i) ? 'r' : ''}">${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}${r.rows.length ? '' : `<tr><td colspan="${r.columns.length}" style="text-align:center;color:#6b7686;padding:18px">Nothing to report for this period.</td></tr>`}</tbody></table>
${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}</body></html>`;
}
