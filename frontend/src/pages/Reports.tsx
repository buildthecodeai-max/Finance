import { useState } from 'react';
import { api } from '../api';
import { Page, Table } from '../components/ui';

const REPORTS = [['pnl', 'Profit & Loss'], ['cash-flow', 'Cash Flow'], ['ar-aging-summary', 'AR Aging Summary'], ['ar-aging-detail', 'AR Aging Detail'],
  ['commission-summary', 'Commission Summary'], ['revenue-by-destination', 'Revenue by Destination'], ['supplier-payments', 'Supplier Payments'], ['invoice-register', 'Invoice Register'],
  ['gl-pnl', 'Profit & Loss (ledger)'], ['ap-aging', 'Payables Aging'], ['departures', 'Departures']];

export default function Reports() {
  const y = new Date().getFullYear();
  const [name, setName] = useState('pnl'); const [from, setFrom] = useState(`${y}-01-01`); const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [rep, setRep] = useState<any>(null); const [err, setErr] = useState('');
  const q = (fmt: string) => `/reports/${name}?from=${from}&to=${to}&format=${fmt}`;
  const run = async () => { try { setErr(''); setRep(await api(q('json'))); } catch (e: any) { setErr(e.message); } };
  const exp = async (fmt: 'pdf' | 'xlsx') => { try { window.open((await api(q(fmt))).url); } catch (e: any) { setErr(e.message); } };
  return (
    <Page title="Reports">
      <div className="card flex flex-wrap gap-3 items-end mb-4">
        <div><div className="text-xs text-muted mb-1">Report</div><select className="input" value={name} onChange={(e) => setName(e.target.value)}>{REPORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div><div className="text-xs text-muted mb-1">From</div><input className="input num" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><div className="text-xs text-muted mb-1">To</div><input className="input num" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <button className="btn" onClick={run}>Run</button>
        {rep && <><button className="btn-ghost" onClick={() => exp('pdf')}>Export PDF</button><button className="btn-ghost" onClick={() => exp('xlsx')}>Export Excel</button></>}
      </div>
      {err && <div className="text-danger text-sm mb-3">{err}</div>}
      {rep?.reconcile && <div className="space-y-2 mb-3">{rep.reconcile.map((c: any) => <div key={c.label} className={`rounded-lg border text-sm p-3 flex flex-wrap justify-between gap-2 ${c.ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}><span>{c.ok ? '✓ Reconciled' : '⚠ Does not reconcile'} — {c.label}</span><span className="num">report {c.report.toFixed(2)} · source {c.source.toFixed(2)}{!c.ok && ` · difference ${c.difference.toFixed(2)}`}</span></div>)}</div>}
      {rep && <><h3 className="font-bold mb-1">{rep.title}</h3>{rep.note && <p className="text-xs text-muted mb-2">{rep.note}</p>}
        <Table rows={rep.rows.map((r: any[], i: number) => ({ id: i, r }))} cols={rep.columns.map((c: string, i: number) => ({ h: c, right: i > 0 && /^-?[\d.,]+$/.test(String(rep.rows[0]?.[i] ?? '')), render: (x: any) => x.r[i] }))} /></>}
    </Page>
  );
}
