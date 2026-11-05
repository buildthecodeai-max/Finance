import { useMemo, useState } from 'react';
import { api, money } from '../api';
import { Err, Page, Table } from '../components/ui';
import { isoDate, today, useList } from '../lookup';
import { csvDownload } from './SaleReports';

/** Pulls "ticket number … amount" out of pasted statement text: one ticket per line, any separators. */
export function parseStatement(text: string) {
  const lines: { ticket_no: string; amount: number }[] = [], skipped: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const m = line.match(/\d[\d-]{9,}\d/);                       // ticket number: 10+ digits, dashes allowed
    if (!m) { skipped.push(line); continue; }
    const rest = line.replace(m[0], ' '), nums = rest.match(/-?\d[\d,]*(?:\.\d+)?/g);
    if (!nums) { skipped.push(line); continue; }
    const amount = Number(nums[nums.length - 1].replace(/,/g, ''));
    if (!Number.isFinite(amount)) { skipped.push(line); continue; }
    lines.push({ ticket_no: m[0], amount });
  }
  return { lines, skipped };
}

const monthStart = () => today().slice(0, 7) + '-01';
const lastMonth = () => { const d = new Date(); return [isoDate(new Date(d.getFullYear(), d.getMonth() - 1, 1)), isoDate(new Date(d.getFullYear(), d.getMonth(), 0))] as const; };

export default function BspRecon() {
  const airlines = useList('/airlines');
  const [from, setFrom] = useState(monthStart()); const [to, setTo] = useState(today()); const [airline, setAirline] = useState(''); const [basis, setBasis] = useState<'payable' | 'gross'>('payable');
  const [text, setText] = useState(''); const [r, setR] = useState<any>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [tab, setTab] = useState('different');
  const parsed = useMemo(() => parseStatement(text), [text]);
  const readFile = async (f?: File | null) => { if (f) setText(await f.text()); };
  const run = async () => {
    setBusy(true); setErr('');
    try { const out = await api('/tickets/bsp-reconcile', 'POST', { from, to, airline_id: airline ? Number(airline) : null, basis, lines: parsed.lines }); setR(out); setTab(out.totals.different ? 'different' : out.totals.missing_in_bsp ? 'missing_in_bsp' : out.totals.missing_in_system ? 'missing_in_system' : 'matched'); }
    catch (e: any) { setErr(e.message); setR(null); } finally { setBusy(false); }
  };
  const t = r?.totals;
  const TABS = r ? [['different', 'Amount differs', t.different], ['missing_in_bsp', 'Not on the statement', t.missing_in_bsp], ['missing_in_system', 'Not in your books', t.missing_in_system], ['matched', 'Matched', t.matched]] as const : [];
  const diffNet = r ? Math.round((t.bsp_amount - t.system_amount) * 100) / 100 : 0;
  const exportAll = () => csvDownload(`bsp-reconciliation-${from}-${to}.csv`, ['Result', 'Ticket', 'Passenger', 'Invoice', 'Your books', 'Statement', 'Difference'], [
    ...r.different.map((x: any) => ['Amount differs', x.ticket_no, x.passenger, x.invoice_no, x.system, x.bsp, x.diff]),
    ...r.missing_in_bsp.map((x: any) => ['Not on statement', x.ticket_no, x.passenger, x.invoice_no, x.system, '', '']),
    ...r.missing_in_system.map((x: any) => [x.in_other_period ? 'Not in books (booked in another period)' : 'Not in books', x.ticket_no, '', '', '', x.bsp, '']),
    ...r.matched.map((x: any) => ['Matched', x.ticket_no, x.passenger, x.invoice_no, x.system, x.bsp, 0])]);

  return (
    <Page title="BSP Reconciliation" description="Check the airline's BSP / IATA statement against the tickets in your books and find what doesn't agree before you pay.">
      <div className="card mb-4 space-y-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div><div className="text-xs text-muted mb-1">Statement period from</div><input className="input num" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><div className="text-xs text-muted mb-1">to</div><input className="input num" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="flex gap-1 pb-0.5"><button type="button" className="btn-ghost text-xs" onClick={() => { setFrom(monthStart()); setTo(today()); }}>This month</button><button type="button" className="btn-ghost text-xs" onClick={() => { const [a, b] = lastMonth(); setFrom(a); setTo(b); }}>Last month</button></div>
          <div><div className="text-xs text-muted mb-1">Airline (optional)</div><select className="input" value={airline} onChange={(e) => setAirline(e.target.value)}><option value="">All airlines</option>{airlines.map((a: any) => <option key={a.id} value={a.id}>{a.name} ({a.code})</option>)}</select></div>
          <div><div className="text-xs text-muted mb-1">Statement amounts are</div><select className="input" value={basis} onChange={(e) => setBasis(e.target.value as any)}><option value="payable">Net remittance (after commission)</option><option value="gross">Gross ticket value</option></select></div></div>
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1"><label className="text-xs text-muted" htmlFor="stmt">Paste the statement — one ticket per line: ticket number, then amount</label>
            <label className="btn-ghost text-xs cursor-pointer">Or choose a file…<input type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" onChange={(e) => readFile(e.target.files?.[0])} /></label></div>
          <textarea id="stmt" className="input num h-40 text-xs" placeholder={'2142400123456  1,250.00\n214-2400123457, 980.50\n…'} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="text-xs text-muted mt-1">{parsed.lines.length ? <>Read <b className="text-fg">{parsed.lines.length}</b> ticket{parsed.lines.length === 1 ? '' : 's'}{parsed.skipped.length > 0 && <span className="text-warn"> · {parsed.skipped.length} line{parsed.skipped.length === 1 ? '' : 's'} ignored (no ticket number or amount): “{parsed.skipped[0].slice(0, 40)}”{parsed.skipped.length > 1 ? '…' : ''}</span>}</> : 'Nothing read yet.'}</div></div>
        <div className="flex justify-end"><button className="btn" disabled={busy || !parsed.lines.length || to < from} onClick={run}>{busy ? 'Comparing…' : 'Compare with my books'}</button></div></div>
      <Err e={err} />
      {r && <>
        <div className="grid sm:grid-cols-4 gap-3 mb-4">
          {[['On the statement', String(t.bsp_lines), money(t.bsp_amount)], ['In your books', String(t.matched + t.different + t.missing_in_bsp), money(t.system_amount)], ['Everything agrees', String(t.matched), 'same ticket, same amount'], ['Needs attention', String(t.different + t.missing_in_bsp + t.missing_in_system), `statement ${diffNet === 0 ? 'equals' : diffNet > 0 ? 'is higher by' : 'is lower by'} ${diffNet === 0 ? 'your books' : money(Math.abs(diffNet))}`]].map(([a, b, c], i) => (
            <div key={a} className="card"><div className="text-xs text-muted">{a}</div><div className={`text-xl font-semibold num mt-0.5 ${i === 3 && Number(b) > 0 ? 'text-warn' : i === 3 ? 'text-success' : ''}`}>{b}</div><div className="text-xs text-muted mt-0.5">{c}</div></div>))}</div>
        {t.different + t.missing_in_bsp + t.missing_in_system === 0 && <div className="rounded-lg border border-success/30 bg-success/10 text-success text-sm px-3 py-2 mb-3">Everything matches — the statement and your books agree ticket for ticket.</div>}
        {t.duplicates > 0 && <div className="rounded-lg border border-warn/30 bg-warn/10 text-warn text-sm px-3 py-2 mb-3">{t.duplicates} ticket number{t.duplicates === 1 ? ' appears' : 's appear'} more than once on the statement; only the first was compared.</div>}
        <div className="flex flex-wrap items-center gap-2 mb-3"><div className="flex gap-1 overflow-x-auto flex-1 min-w-0" role="tablist">{TABS.map(([k, l, n]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`whitespace-nowrap text-sm px-3 py-1.5 rounded-lg border ${tab === k ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>{l}<span className="ml-1.5 text-xs opacity-70 num">{n}</span></button>)}</div>
          <button className="btn-ghost" onClick={exportAll}>Download result (CSV)</button></div>
        {tab === 'different' && <Table rows={r.different.map((x: any, i: number) => ({ id: i, ...x }))} empty="No amount differences." cols={[{ h: 'Ticket', render: (x: any) => <span className="num">{x.ticket_no}</span> }, { h: 'Passenger', render: (x: any) => x.passenger }, { h: 'Invoice', render: (x: any) => x.invoice_no }, { h: 'Your books', right: true, render: (x: any) => money(x.system) }, { h: 'Statement', right: true, render: (x: any) => money(x.bsp) }, { h: 'Difference', right: true, render: (x: any) => <b className={x.diff > 0 ? 'text-warn' : 'text-danger'}>{x.diff > 0 ? '+' : ''}{money(x.diff)}</b> }]} />}
        {tab === 'missing_in_bsp' && <><p className="text-xs text-muted mb-2">You issued these in the period but the statement doesn't list them. They may be on the next statement, or issued through another airline.</p><Table rows={r.missing_in_bsp.map((x: any, i: number) => ({ id: i, ...x }))} empty="Every ticket in your books is on the statement." cols={[{ h: 'Ticket', render: (x: any) => <span className="num">{x.ticket_no}</span> }, { h: 'Passenger', render: (x: any) => x.passenger }, { h: 'Airline', render: (x: any) => x.airline }, { h: 'Issued', render: (x: any) => <span className="num">{String(x.date).slice(0, 10)}</span> }, { h: 'Invoice', render: (x: any) => x.invoice_no }, { h: 'Your books', right: true, render: (x: any) => money(x.system) }]} /></>}
        {tab === 'missing_in_system' && <><p className="text-xs text-muted mb-2">The statement charges you for these, but there's no confirmed ticket in your books for the period. Check they were entered and supervised.</p><Table rows={r.missing_in_system.map((x: any, i: number) => ({ id: i, ...x }))} empty="Everything on the statement is in your books." cols={[{ h: 'Ticket', render: (x: any) => <span className="num">{x.ticket_no}</span> }, { h: 'Statement', right: true, render: (x: any) => money(x.bsp) }, { h: 'Note', render: (x: any) => (x.in_other_period ? <span className="text-warn">In your books, but issued in a different period</span> : <span className="text-danger">Not found in your books at all</span>) }]} /></>}
        {tab === 'matched' && <Table rows={r.matched.map((x: any, i: number) => ({ id: i, ...x }))} empty="Nothing matched." cols={[{ h: 'Ticket', render: (x: any) => <span className="num">{x.ticket_no}</span> }, { h: 'Passenger', render: (x: any) => x.passenger }, { h: 'Invoice', render: (x: any) => x.invoice_no }, { h: 'Amount', right: true, render: (x: any) => money(x.system) }]} />}
      </>}
    </Page>
  );
}
