import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, money } from '../api';
import { Err, Page, Skeleton, Table } from '../components/ui';
import { isoDate, today, useList } from '../lookup';

export const csvDownload = (name: string, header: string[], rows: any[][]) => {
  const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([[header, ...rows].map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
};
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const monthStart = () => today().slice(0, 7) + '-01';
const lastMonth = () => { const d = new Date(); const a = new Date(d.getFullYear(), d.getMonth() - 1, 1), b = new Date(d.getFullYear(), d.getMonth(), 0); return [isoDate(a), isoDate(b)] as const; };
const PRESETS: [string, () => readonly [string, string]][] = [['This month', () => [monthStart(), today()]], ['Last month', lastMonth], ['This year', () => [yearStart(), today()]]];

function Range({ from, to, set }: { from: string; to: string; set(a: string, b: string): void }) {
  return <>
    <div><div className="text-xs text-muted mb-1">From</div><input className="input num" type="date" value={from} max={to} onChange={(e) => set(e.target.value, to)} /></div>
    <div><div className="text-xs text-muted mb-1">To</div><input className="input num" type="date" value={to} min={from} onChange={(e) => set(from, e.target.value)} /></div>
    <div className="flex gap-1 pb-0.5">{PRESETS.map(([l, f]) => <button key={l} type="button" className="btn-ghost text-xs" onClick={() => { const [a, b] = f(); set(a, b); }}>{l}</button>)}</div></>;
}

/** What the agency sold, grouped how you like. */
function Analysis() {
  const [group, setGroup] = useState('airline'); const [from, setFrom] = useState(yearStart()); const [to, setTo] = useState(today());
  const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setErr(''); setD(await api(`/tickets/reports/sales?group=${group}&from=${from}&to=${to}`)); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  useEffect(() => { run(); }, [group, from, to]);
  const sum = (k: string) => (d?.rows ?? []).reduce((s: number, r: any) => s + (r[k] ?? 0), 0);
  return (<>
    <div className="card flex flex-wrap gap-3 items-end mb-4">
      <div><div className="text-xs text-muted mb-1">Group by</div><select className="input capitalize" value={group} onChange={(e) => setGroup(e.target.value)}>{['airline', 'client', 'date', 'employee', 'branch'].map((g) => <option key={g}>{g}</option>)}</select></div>
      <Range from={from} to={to} set={(a, b) => { setFrom(a); setTo(b); }} /></div>
    <Err e={err} />
    {!d ? <Skeleton className="h-48" /> : <>
      <p className="text-xs text-muted mb-2">Confirmed (supervised) ticket invoices only. Amounts in base currency.</p>
      <Table rows={d.rows.map((r: any, i: number) => ({ id: i, ...r }))} empty="No confirmed ticket sales in this period." cols={[{ h: group[0].toUpperCase() + group.slice(1), render: (r: any) => r.label }, { h: 'Tickets', right: true, render: (r: any) => r.tickets }, { h: 'Fare', right: true, render: (r: any) => money(r.fare) },
        { h: 'Taxes', right: true, render: (r: any) => money(r.taxes) }, { h: 'Receivable', right: true, render: (r: any) => money(r.receivable) }, { h: 'Payable', right: true, render: (r: any) => money(r.payable) }, { h: 'Profit', right: true, render: (r: any) => money(r.profit) }]} />
      <div className="flex flex-wrap justify-between gap-2 mt-2 text-sm num"><button className="btn-ghost inline-flex items-center gap-1" disabled={!d.rows.length} onClick={() => csvDownload(`sales-by-${group}-${from}-${to}.csv`, [group, 'Tickets', 'Fare', 'Taxes', 'Receivable', 'Payable', 'Profit'], d.rows.map((r: any) => [r.label, r.tickets, r.fare, r.taxes, r.receivable, r.payable, r.profit]))}><Download size={14} />CSV</button>
        <span>Total receivable {money(sum('receivable'))} · profit <b>{money(sum('profit'))}</b>{busy && ' …'}</span></div></>}
  </>);
}

/** What is owed to each airline: the figure to check against the airline's BSP / IATA statement. */
function Remittance() {
  const airlines = useList('/airlines'); const [airline, setAirline] = useState(''); const [from, setFrom] = useState(monthStart()); const [to, setTo] = useState(today());
  const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { setD(null); api(`/tickets/reports/airline-remittance?from=${from}&to=${to}${airline ? `&airline_id=${airline}` : ''}`).then((r) => { setD(r); setErr(''); }).catch((e) => { setErr(e.message); setD({ airlines: [], lines: [], totals: {} }); }); }, [airline, from, to]);
  const t = d?.totals ?? {};
  const lines = (a: any) => d.lines.filter((l: any) => (l.airline_id ?? null) === (a.airline_id ?? null));
  return (<>
    <div className="card flex flex-wrap gap-3 items-end mb-4">
      <div><div className="text-xs text-muted mb-1">Airline</div><select className="input" value={airline} onChange={(e) => setAirline(e.target.value)}><option value="">All airlines</option>{airlines.map((a: any) => <option key={a.id} value={a.id}>{a.name} ({a.code})</option>)}</select></div>
      <Range from={from} to={to} set={(a, b) => { setFrom(a); setTo(b); }} /></div>
    <Err e={err} />
    {!d ? <Skeleton className="h-48" /> : <>
      <div className="grid sm:grid-cols-4 gap-3 mb-4">
        {[['Tickets issued', String(t.tickets ?? 0), `${money(t.gross ?? 0)} gross`], ['Commission earned', money(t.commission ?? 0), 'kept by the agency'], ['Refunds recovered', money(t.recovered ?? 0), 'credited back by airlines'], ['Net to remit', money(t.net ?? 0), 'what you owe the airlines']].map(([a, b, c], i) => (
          <div key={a} className="card"><div className="text-xs text-muted">{a}</div><div className={`text-xl font-semibold num mt-0.5 ${i === 3 ? 'text-accent' : ''}`}>{b}</div><div className="text-xs text-muted mt-0.5">{c}</div></div>))}</div>
      <p className="text-xs text-muted mb-2">Confirmed (supervised) ticket invoices issued in the period, less refunds recovered in the period. Click an airline to see its tickets. Check the “Net to remit” figure against the airline’s BSP / IATA statement — <a className="underline text-accent" href="/bsp-reconciliation">reconcile it ticket by ticket</a>.</p>
      <Table rows={d.airlines.map((a: any, i: number) => ({ id: i, ...a }))} onRow={(a: any) => setOpen(open === String(a.airline_id) ? null : String(a.airline_id))} empty="No confirmed ticket sales in this period." cols={[
        { h: 'Airline', render: (a: any) => <><span className="font-medium">{a.name}</span><div className="text-xs text-muted">{[a.code && `Code ${a.code}`, a.iata_code && `IATA ${a.iata_code}`].filter(Boolean).join(' · ')}</div></> },
        { h: 'Tickets', right: true, render: (a: any) => a.tickets }, { h: 'Fare', right: true, render: (a: any) => money(a.fare) }, { h: 'Taxes', right: true, render: (a: any) => money(a.taxes) }, { h: 'Gross', right: true, render: (a: any) => money(a.gross) },
        { h: 'Commission', right: true, render: (a: any) => money(a.commission) }, { h: 'Refunds', right: true, render: (a: any) => (a.refunds ? `${a.refunds} · −${money(a.recovered)}` : '—') }, { h: 'Net to remit', right: true, render: (a: any) => <b>{money(a.net)}</b> }]} />
      {d.airlines.filter((a: any) => open === String(a.airline_id)).map((a: any) => (
        <div key={a.airline_id} className="mt-4"><h3 className="font-semibold text-sm mb-2">{a.name} — tickets</h3>
          <Table rows={lines(a)} cols={[{ h: 'Date', render: (l: any) => <span className="num">{String(l.invoice_date).slice(0, 10)}</span> }, { h: 'Ticket', render: (l: any) => <span className="num">{l.ticket_no ?? '—'}</span> }, { h: 'Passenger', render: (l: any) => l.passenger_name },
            { h: 'Route', render: (l: any) => l.route ?? l.sector ?? '' }, { h: 'Invoice', render: (l: any) => l.invoice_no }, { h: 'Gross', right: true, render: (l: any) => money(l.gross) }, { h: 'Commission', right: true, render: (l: any) => money(l.commission) }, { h: 'Payable', right: true, render: (l: any) => money(l.payable) }]} /></div>))}
      {d.truncated && <p className="text-xs text-warn mt-2">This period has more than 5,000 tickets, so the airline totals above are incomplete. Narrow the dates.</p>}
      <div className="mt-3"><button className="btn-ghost inline-flex items-center gap-1" disabled={!d.lines.length} onClick={() => csvDownload(`airline-remittance-${from}-${to}.csv`, ['Date', 'Airline', 'Airline code', 'IATA', 'Ticket', 'Passenger', 'Route', 'Invoice', 'Fare', 'Taxes', 'Gross', 'Commission', 'Payable'],
        d.lines.map((l: any) => [String(l.invoice_date).slice(0, 10), l.airline_name, l.airline_code, l.iata_code, l.ticket_no, l.passenger_name, l.route ?? l.sector, l.invoice_no, l.fare, l.taxes, l.gross, l.commission, l.payable]))}><Download size={14} />Download all tickets (CSV)</button></div></>}
  </>);
}

export default function SaleReports() {
  const [view, setView] = useState<'analysis' | 'remit'>('remit');
  return (
    <Page title="Sale Reports" description="What you sold, and what you owe each airline for it.">
      <div className="inline-flex rounded-lg border border-line p-0.5 text-sm mb-4" role="tablist" aria-label="Report">
        {([['remit', 'Airline remittance (IATA / BSP)'], ['analysis', 'Sales analysis']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={view === k} className={`px-3 py-1.5 rounded-md ${view === k ? 'bg-accent text-accent-ink' : 'text-muted'}`} onClick={() => setView(k)}>{l}</button>)}</div>
      {view === 'remit' ? <Remittance /> : <Analysis />}
    </Page>
  );
}
