// A tolerant .xlsx reader used when ExcelJS cannot open a workbook (files written by other tools — prefixed XML namespaces,
// missing relationship parts, etc.). Reads cached cell values only (never formulas), shared strings, dates and merged cells.
import JSZip from 'jszip';
import type { Cell, Grid } from './engine.js';

const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as any)[e.toLowerCase()];
});
const attr = (tag: string, name: string) => { const m = new RegExp(`(?:^|\\s)(?:[\\w]+:)?${name}\\s*=\\s*"([^"]*)"`).exec(tag); return m ? decode(m[1]) : null; };
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const textOf = (xml: string) => [...xml.replace(/<(?:\w+:)?rPh[\s\S]*?<\/(?:\w+:)?rPh>/g, '').matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decode(m[1])).join('');

export async function readXlsxLite(buf: Buffer): Promise<Grid[]> {
  const zip = await JSZip.loadAsync(buf);
  const file = async (p: string) => { const f = zip.file(p.replace(/^\//, '')); return f ? f.async('string') : null; };
  const wbXml = await file('xl/workbook.xml'); if (!wbXml) throw new Error('not a workbook');
  const rels = (await file('xl/_rels/workbook.xml.rels')) ?? '';
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) { const id = attr(m[0], 'Id'), t = attr(m[0], 'Target'); if (id && t) target.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`); }
  const sheets = [...wbXml.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)].map((m) => ({ name: attr(m[0], 'name') ?? 'Sheet', rid: attr(m[0], 'id') }));
  const ss: string[] = [];
  const ssXml = await file('xl/sharedStrings.xml');
  if (ssXml) for (const m of ssXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)) ss.push(textOf(m[1]));
  // Which cell styles are dates
  const isDateXf: boolean[] = [];
  const stXml = await file('xl/styles.xml');
  if (stXml) {
    const custom = new Map<number, string>();
    for (const m of stXml.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') ?? '');
    const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(stXml)?.[1] ?? '';
    for (const m of xfs.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)) {
      const id = Number(attr(m[0], 'numFmtId') ?? 0), code = custom.get(id);
      isDateXf.push(code !== undefined ? /[dmyh]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) && !/^general$/i.test(code) : BUILTIN_DATE.has(id));
    }
  }
  const out: Grid[] = [];
  for (const s of sheets) {
    const path = s.rid ? target.get(s.rid) : undefined; const xml = path ? await file(path) : null;
    if (!xml) continue;
    const rows: Cell[][] = [];
    for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
      const rn = Number(attr(rm[1], 'r')) - 1; if (!(rn >= 0) || !rm[2]) continue;
      const cells: Cell[] = [];
      for (const cm of rm[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const ref = attr(cm[1], 'r'); if (!ref) continue; const ci = colIndex(ref); if (ci > 59) continue;
        const t = attr(cm[1], 't'), sx = Number(attr(cm[1], 's') ?? -1), body = cm[2] ?? '';
        const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
        let val: Cell = null;
        if (t === 'inlineStr') val = textOf(body) || null;
        else if (v !== undefined) {
          if (t === 's') val = ss[Number(v)] ?? null;
          else if (t === 'str') val = decode(v);
          else if (t === 'b') val = v === '1';
          else if (t === 'e') val = null;
          else if (t === 'd') val = new Date(v);
          else { const n = Number(v); val = Number.isFinite(n) ? (isDateXf[sx] ? new Date(Math.round((n - 25569) * 86400000)) : n) : null; }
        }
        if (typeof val === 'string') { val = val.replace(/[ ​]/g, ' ').replace(/\s+/g, ' ').trim() || null; }
        cells[ci] = val;
      }
      for (let i = 0; i < cells.length; i++) cells[i] ??= null;
      rows[rn] = cells;
    }
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    // Merged ranges: copy the top-left value across the range (headings are often merged across columns/rows)
    for (const mm of xml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*>/g)) {
      const ref = attr(mm[0], 'ref'); const p = ref?.split(':'); if (!p || p.length !== 2) continue;
      const r1 = Number(p[0].replace(/\D/g, '')) - 1, r2 = Number(p[1].replace(/\D/g, '')) - 1, c1 = colIndex(p[0]), c2 = colIndex(p[1]);
      const v = rows[r1]?.[c1] ?? null; if (v === null || r2 - r1 > 5 || c2 - c1 > 20) continue;
      for (let r = r1; r <= r2; r++) { rows[r] ??= []; for (let c = c1; c <= c2; c++) if (rows[r][c] == null) rows[r][c] = v; }
    }
    out.push({ name: s.name.trim(), rows: rows.map((r) => { const o = [...r]; for (let i = 0; i < o.length; i++) o[i] ??= null; return o; }) });
  }
  if (!out.length) throw new Error('no sheets');
  return out;
}
