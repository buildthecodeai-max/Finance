import { useState } from 'react';
import { api, money } from '../api';
import { Page, Table } from '../components/ui';
import { today } from '../lookup';

export default function SaleReports() {
  const [group, setGroup] = useState('airline'); const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`); const [to, setTo] = useState(today());
  const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  const run = async () => { try { setErr(''); setD(await api(`/tickets/reports/sales?group=${group}&from=${from}&to=${to}`)); } catch (e: any) { setErr(e.message); } };
  const sum = (k: string) => (d?.rows ?? []).reduce((s: number, r: any) => s + (r[k] ?? 0), 0);
  return (
    <Page title="Sale Reports">
      <div className="card flex flex-wrap gap-3 items-end mb-4">
        <div><div className="text-xs text-muted mb-1">Group by</div><select className="input" value={group} onChange={(e) => setGroup(e.target.value)}>{['airline', 'client', 'date', 'employee', 'branch'].map((g) => <option key={g}>{g}</option>)}</select></div>
        <div><div className="text-xs text-muted mb-1">From</div><input className="input num" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><div className="text-xs text-muted mb-1">To</div><input className="input num" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <button className="btn" onClick={run}>Run</button></div>
      {err && <div className="text-danger text-sm">{err}</div>}
      {d && <><p className="text-xs text-muted mb-2">Confirmed (supervised) ticket invoices only. Amounts in base currency.</p>
        <Table rows={d.rows.map((r: any, i: number) => ({ id: i, ...r }))} cols={[{ h: group, render: (r: any) => r.label }, { h: 'Tickets', right: true, render: (r: any) => r.tickets }, { h: 'Fare', right: true, render: (r: any) => money(r.fare) },
          { h: 'Taxes', right: true, render: (r: any) => money(r.taxes) }, { h: 'Receivable', right: true, render: (r: any) => money(r.receivable) }, { h: 'Payable', right: true, render: (r: any) => money(r.payable) }, { h: 'Profit', right: true, render: (r: any) => money(r.profit) }]} />
        <div className="text-right num mt-2">Total receivable {money(sum('receivable'))} · profit <b>{money(sum('profit'))}</b></div></>}
    </Page>
  );
}
