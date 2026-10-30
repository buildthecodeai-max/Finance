import { ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CheckCircle2, HandCoins, Landmark, Receipt, Wallet } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Page, Skeleton } from '../components/ui';
import { useChartColors } from '../theme';

const Stat = ({ label, value, sub, icon, onClick }: { label: string; value: string; sub?: string; icon: ReactNode; onClick?(): void }) => (
  <button onClick={onClick} disabled={!onClick} className="card text-left flex items-start justify-between hover:border-accent/50 transition disabled:hover:border-line">
    <div><div className="text-xs font-medium text-muted">{label}</div><div className="num text-2xl font-semibold mt-1">{value}</div>{sub && <div className="text-xs text-muted mt-1">{sub}</div>}</div>
    <div className="h-9 w-9 rounded-lg bg-accent/10 text-accent grid place-items-center shrink-0">{icon}</div></button>
);

function Aging({ title, d, cur }: { title: string; d: any; cur: string }) {
  const c = useChartColors();
  const data = [['Current', d.current_], ['1–30', d.d30], ['31–60', d.d60], ['61–90', d.d90], ['90+', d.d90p]].map(([name, v]) => ({ name, v: Number(v ?? 0) }));
  const tip = { contentStyle: { background: c.surface, border: `1px solid ${c.grid}`, borderRadius: 10, color: c.fg, fontSize: 12 }, cursor: { fill: c.accentSoft }, formatter: (v: number) => money(v, cur) };
  const cols = [c.aging[0], c.aging[1], c.aging[2], c.aging[3], c.aging[3]];
  return (
    <div className="card"><div className="flex justify-between mb-2"><h3 className="font-semibold">{title}</h3><span className="num text-sm text-muted">{d.n ?? 0} open · {money(Number(d.total ?? 0), cur)}</span></div>
      <div className="h-44"><ResponsiveContainer><BarChart data={data} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}><CartesianGrid vertical={false} stroke={c.grid} strokeDasharray="3 3" />
        <XAxis dataKey="name" stroke={c.text} fontSize={11} tickLine={false} axisLine={false} /><YAxis hide /><Tooltip {...tip} /><Bar dataKey="v" radius={[6, 6, 0, 0]} maxBarSize={44}>{data.map((_, i) => <Cell key={i} fill={cols[i]} />)}</Bar></BarChart></ResponsiveContainer></div></div>
  );
}

export default function FinanceOverview() {
  const nav = useNavigate(); const { can } = useAuth();
  const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = () => api('/finance/summary').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err) return <Page title="Finance"><Err e={err} /></Page>;
  if (!d) return <Page title="Finance"><div className="grid grid-cols-2 xl:grid-cols-4 gap-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div></Page>;
  const cur = d.base_currency, rec = d.reconciliation;
  const backfill = async () => { try { const r = await api('/finance/backfill-ledger', 'POST'); setMsg(`Posted ${r.invoices_posted} invoice(s) and ${r.receipts_created} payment(s)${r.errors.length ? `. ${r.errors.length} skipped: ${r.errors.slice(0, 3).join('; ')}` : ''}`); load(); } catch (e: any) { setErr(e.message); } };
  const Rec = ({ label, r }: { label: string; r: any }) => (
    <div className="flex items-center justify-between gap-3 py-2 border-t border-line first:border-0">
      <div className="flex items-center gap-2">{r.ok ? <CheckCircle2 size={16} className="text-success" /> : <AlertTriangle size={16} className="text-danger" />}<span className="text-sm font-medium">{label}</span></div>
      <div className="text-xs text-muted num text-right">ledger {money(r.ledger, cur)} · open documents {money(r.subledger, cur)}{!r.ok && <span className="text-danger"> · difference {money(r.difference, cur)}</span>}</div></div>);
  return (
    <Page title="Finance" description={`Base currency ${cur}. Figures come from the ledger and open documents.`}>
      {msg && <div className="text-success text-sm mb-3" role="status">{msg}</div>}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
        <Stat label="Receivable (AR)" value={money(Number(d.ar.total ?? 0), cur)} sub={`${d.overdue_invoices} overdue invoice(s)`} icon={<HandCoins size={18} />} onClick={() => nav('/invoices')} />
        <Stat label="Payable (AP)" value={money(Number(d.ap.total ?? 0), cur)} sub={`${d.bills_due_14d.n} bill(s) due in 14 days`} icon={<Landmark size={18} />} onClick={() => nav('/supplier-bills')} />
        <Stat label="Cash & bank" value={money(d.cash_total, cur)} sub={d.cash.map((c: any) => c.name).join(' · ')} icon={<Wallet size={18} />} />
        <Stat label="Received, last 30 days" value={money(d.receipts_30d, cur)} sub={d.unallocated_receipts.n ? `${money(d.unallocated_receipts.v, cur)} unallocated` : 'All allocated'} icon={<Receipt size={18} />} onClick={() => nav('/client-receipts')} />
      </div>
      <div className="grid lg:grid-cols-2 gap-4 mb-4"><Aging title="Receivables aging" d={d.ar} cur={cur} /><Aging title="Payables aging" d={d.ap} cur={cur} /></div>
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card lg:col-span-2"><h3 className="font-semibold mb-1">Reconciliation</h3><p className="text-xs text-muted mb-2">The ledger control balance must equal the sum of open invoices (less unallocated receipts) and open supplier bills.</p>
          <Rec label="Receivables" r={rec.ar} /><Rec label="Payables" r={rec.ap} />
          {rec.unposted_invoices > 0 && <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 text-warn text-sm p-3 flex flex-wrap items-center justify-between gap-2">
            <span>{rec.unposted_invoices} issued invoice(s) were created before the ledger existed and are not in it yet.</span>{can('admin') && <button className="btn-ghost" onClick={backfill}>Post existing invoices</button>}</div>}</div>
        <div className="card"><h3 className="font-semibold mb-2">Needs attention</h3><ul className="text-sm space-y-2">
          <li className="flex justify-between"><span className="text-muted">Overdue invoices</span><b className="num">{d.overdue_invoices}</b></li>
          <li className="flex justify-between"><span className="text-muted">Unallocated receipts</span><b className="num">{d.unallocated_receipts.n}</b></li>
          <li className="flex justify-between"><span className="text-muted">Refunds awaiting action</span><b className="num">{d.pending_refunds.n}</b></li>
          <li className="flex justify-between"><span className="text-muted">Bills due in 14 days</span><b className="num">{money(d.bills_due_14d.v, cur)}</b></li></ul></div>
      </div>
    </Page>
  );
}
