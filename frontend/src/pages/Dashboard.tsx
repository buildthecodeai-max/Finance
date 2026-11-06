import { ReactNode, useEffect, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Banknote, Briefcase, Check, ChevronRight, CircleCheck, HandCoins, Plus, Wallet } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Page, Pill, Skeleton, Table } from '../components/ui';
import { useChartColors } from '../theme';

function Kpi({ label, hint, value, trend, cur, icon, to }: { label: string; hint: string; value: number; trend: number[]; cur: string; icon: ReactNode; to: string }) {
  const c = useChartColors(); const id = `g-${label.replace(/\W/g, '')}`; const nav = useNavigate();
  return (
    <button type="button" onClick={() => nav(to)} title={`${hint} — click for details`} className="card !p-0 overflow-hidden text-left hover:bg-surface2/60 transition-colors">
      <div className="p-4 pb-2 flex items-start justify-between">
        <div><div className="text-xs font-medium text-muted">{label}</div><div className="num text-xl sm:text-[26px] font-semibold tracking-tight mt-1">{money(value, cur)}</div><div className="text-[11px] text-muted mt-0.5">{hint}</div></div>
        <div className="hidden sm:grid h-9 w-9 rounded-lg bg-accent/10 text-accent place-items-center">{icon}</div>
      </div>
      <div className="h-14" aria-hidden>{trend.length > 1 && (
        <ResponsiveContainer><AreaChart data={trend.map((v, i) => ({ i, v }))} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c.accent} stopOpacity={0.28} /><stop offset="100%" stopColor={c.accent} stopOpacity={0} /></linearGradient></defs>
          <Area dataKey="v" type="monotone" stroke={c.accent} strokeWidth={2} fill={`url(#${id})`} dot={false} isAnimationActive={false} /></AreaChart></ResponsiveContainer>)}</div>
    </button>
  );
}

const ChartCard = ({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) => (
  <div className="card"><div className="mb-3"><h3 className="font-semibold">{title}</h3>{sub && <p className="text-xs text-muted">{sub}</p>}</div><div className="h-52">{children}</div></div>
);

export default function Dashboard() {
  const { agency, user, can } = useAuth(); const c = useChartColors(); const nav = useNavigate(); const editor = can('admin', 'finance_manager', 'agent');
  const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [soon, setSoon] = useState<any[]>([]);
  useEffect(() => { setD(null); api('/dashboard').then(setD).catch((e) => setErr(e.message)); api('/ops/deadlines?days=14').then(setSoon).catch(() => {}); }, [agency?.id]);
  const hour = new Date().getHours(), greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const head = { title: `${greet}, ${(user?.name ?? '').split(' ')[0]}`, description: `${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · ${agency?.name ?? ''} · money shown in ${agency?.base_currency ?? ''}` };
  if (err) return <Page title="Dashboard"><div className="card text-danger text-sm">{err}</div></Page>;
  if (!d) return (
    <Page {...head}><div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}</div>
      <div className="grid lg:grid-cols-3 gap-4 mb-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-72" />)}</div><Skeleton className="h-64" /></Page>);
  const cur = agency!.base_currency, k = d.kpis;
  const aging = [['Current', d.arAging.current_], ['1–30', d.arAging.d30], ['31–60', d.arAging.d60], ['60+', d.arAging.d90]].map(([name, v]) => ({ name, v: Number(v ?? 0) }));
  const tip = { contentStyle: { background: c.surface, border: `1px solid ${c.grid}`, borderRadius: 10, color: c.fg, fontSize: 12, boxShadow: '0 8px 24px rgb(0 0 0 / 0.2)' }, cursor: { fill: c.accentSoft }, formatter: (v: number) => money(v, cur) };
  const at = d.attention, cn = d.counts;
  const todo: { n: number; text: string; to: string; tone: 'danger' | 'warn' | 'info' }[] = [
    { n: at.overdue_invoices, text: `overdue invoice${at.overdue_invoices === 1 ? '' : 's'} — ${money(at.overdue_amount, cur)} to collect`, to: '/invoices?tab=overdue', tone: 'danger' as const },
    { n: at.leads_due, text: `lead follow-up${at.leads_due === 1 ? '' : 's'} due — people waiting to hear from you`, to: '/leads?tab=followup', tone: 'warn' as const },
    { n: at.tasks_overdue, text: `overdue task${at.tasks_overdue === 1 ? '' : 's'}`, to: '/operations', tone: 'danger' as const },
    { n: at.visas_late, text: `visa decision${at.visas_late === 1 ? '' : 's'} later than expected — chase the embassy`, to: '/visas?tab=embassy', tone: 'warn' as const },
    { n: at.quotes_changes, text: `quote${at.quotes_changes === 1 ? '' : 's'} where the client asked for changes`, to: '/quotes?tab=changes', tone: 'warn' as const },
    { n: at.quotes_accepted, text: `accepted quote${at.quotes_accepted === 1 ? '' : 's'} ready to turn into a booking`, to: '/quotes?tab=accepted', tone: 'info' as const },
    { n: at.quotes_expiring, text: `quote${at.quotes_expiring === 1 ? '' : 's'} expiring within 7 days`, to: '/quotes?tab=waiting', tone: 'warn' as const },
    { n: at.departing_7d, text: `trip${at.departing_7d === 1 ? '' : 's'} leaving in the next 7 days`, to: '/bookings?tab=soon', tone: 'info' as const },
    { n: at.invoices_ready, text: `invoice${at.invoices_ready === 1 ? '' : 's'} reviewed and ready to send`, to: '/invoices?tab=ready', tone: 'info' as const },
    { n: at.invoices_draft, text: `draft invoice${at.invoices_draft === 1 ? '' : 's'} not finished`, to: '/invoices?tab=draft', tone: 'info' as const },
  ].filter((x) => x.n > 0);
  const TONE = { danger: 'text-danger', warn: 'text-warn', info: 'text-info' };
  const steps = [['Add your first client', cn.clients > 0, '/clients?new=1'], ['Price a trip with a quote', cn.quotes > 0, '/quotes/new'], ['Turn it into a booking', cn.bookings > 0, '/bookings?new=1'], ['Send an invoice', cn.invoices > 0, '/invoices?new=1']] as [string, boolean, string][];
  const newbie = steps.some(([, done]) => !done) && cn.invoices === 0;
  const actions: [string, string][] = [['New quote', '/quotes/new'], ['New booking', '/bookings?new=1'], ['New client', '/clients?new=1'], ...(can('admin', 'finance_manager') ? [['Record payment', '/payments?new=1'] as [string, string]] : [])];
  const axis = { stroke: c.text, fontSize: 11, tickLine: false, axisLine: false } as const;
  return (
    <Page {...head} actions={editor ? <>{actions.map(([l, to], i) => <button key={l} className={i === 0 ? 'btn inline-flex items-center gap-1' : 'btn-ghost inline-flex items-center gap-1'} onClick={() => nav(to)}><Plus size={14} />{l}</button>)}</> : undefined}>
      {newbie && editor && <div className="card mb-4"><h3 className="font-semibold mb-1">Getting started</h3><p className="text-xs text-muted mb-3">Four steps to your first sale. Each one opens the right screen.</p>
        <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">{steps.map(([l, done, to], i) => <li key={l}><button onClick={() => nav(to)} className={`w-full text-left rounded-lg border px-3 py-2 text-sm flex items-center gap-2 ${done ? 'border-success/40 bg-success/10 text-success' : 'border-line hover:bg-surface2'}`}><span className={`h-5 w-5 rounded-full grid place-items-center text-[11px] shrink-0 ${done ? 'bg-success text-white' : 'bg-surface2 text-muted'}`}>{done ? <Check size={12} /> : i + 1}</span>{l}</button></li>)}</ol></div>}

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="card lg:col-span-2"><h3 className="font-semibold mb-2 flex items-center gap-2">{todo.length ? <><AlertTriangle size={16} className="text-warn" />Needs your attention</> : <><CircleCheck size={16} className="text-success" />You're all caught up</>}</h3>
          {todo.length ? <ul className="divide-y divide-line/60">{todo.map((x) => <li key={x.to + x.text}><button onClick={() => nav(x.to)} className="w-full flex items-center gap-3 py-2 text-left hover:bg-surface2/50 rounded"><span className={`num text-lg font-semibold w-8 text-right ${TONE[x.tone]}`}>{x.n}</span><span className="text-sm flex-1">{x.text}</span><ChevronRight size={15} className="text-muted" /></button></li>)}</ul>
            : <p className="text-sm text-muted">No overdue invoices, late visas or waiting quotes. New things that need you will show up here.</p>}</div>
        <div className="card"><h3 className="font-semibold mb-2">Coming up · next 14 days</h3>
          {soon.length ? <ul className="space-y-2 max-h-56 overflow-auto">{soon.filter((x) => !['overdue_task'].includes(x.kind)).slice(0, 8).map((x, i) => <li key={i}><button className="text-left w-full text-sm hover:bg-surface2/50 rounded px-1 -mx-1" onClick={() => nav(x.ref_type === 'booking' ? `/bookings/${x.ref_id}` : x.ref_type === 'quote' ? `/quotes/${x.ref_id}` : '/operations')}><span className="num text-xs text-muted mr-2">{String(x.date).slice(5, 10)}</span>{x.title}</button></li>)}</ul>
            : <p className="text-sm text-muted">Nothing scheduled — no departures, expiries or birthdays in the next two weeks.</p>}
          {soon.length > 0 && <button className="text-xs text-accent underline mt-2" onClick={() => nav('/operations')}>See everything on Operations</button>}</div></div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-1">
        <Kpi label="Revenue" hint="Invoiced, before tax" value={k.revenue.value} trend={k.revenue.trend} cur={cur} icon={<Banknote size={18} />} to="/invoices" />
        <Kpi label="Trips sold" hint="Total value of invoices" value={k.bookings.value} trend={k.bookings.trend} cur={cur} icon={<Briefcase size={18} />} to="/bookings" />
        <Kpi label="Owed to you" hint="Unpaid client invoices" value={k.outstandingAr.value} trend={k.outstandingAr.trend} cur={cur} icon={<Wallet size={18} />} to="/invoices?tab=unpaid" />
        <Kpi label="Commission earned" hint="After deductions" value={k.netCommission.value} trend={k.netCommission.trend} cur={cur} icon={<HandCoins size={18} />} to="/commissions" />
      </div>
      <p className="text-xs text-muted mb-4">Totals cover the last 12 months, except “Owed to you”, which is everything unpaid today.</p>
      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <ChartCard title="Who is late paying" sub="Unpaid invoices by how many days past their due date">
          <ResponsiveContainer><BarChart data={aging} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}><CartesianGrid vertical={false} stroke={c.grid} strokeDasharray="3 3" /><XAxis dataKey="name" {...axis} /><YAxis hide /><Tooltip {...tip} />
            <Bar dataKey="v" radius={[6, 6, 0, 0]} maxBarSize={48}>{aging.map((_, i) => <Cell key={i} fill={c.aging[i]} />)}</Bar></BarChart></ResponsiveContainer></ChartCard>
        <ChartCard title="What sells" sub="Revenue by product type, before tax">
          <ResponsiveContainer><BarChart data={d.revenueByType} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}><CartesianGrid vertical={false} stroke={c.grid} strokeDasharray="3 3" /><XAxis dataKey="type" {...axis} /><YAxis hide /><Tooltip {...tip} />
            <Bar dataKey="v" fill={c.accent} radius={[6, 6, 0, 0]} maxBarSize={48} /></BarChart></ResponsiveContainer></ChartCard>
        <ChartCard title="Where the money goes" sub="Expenses, last 12 months">
          {d.expenses.length ? <div className="flex h-full items-center gap-3"><div className="h-full flex-1"><ResponsiveContainer><PieChart><Pie data={d.expenses} dataKey="v" nameKey="category" innerRadius="58%" outerRadius="88%" stroke="none" paddingAngle={2}>{d.expenses.map((_: any, i: number) => <Cell key={i} fill={c.series[i % c.series.length]} />)}</Pie><Tooltip {...tip} cursor={false} /></PieChart></ResponsiveContainer></div>
            <ul className="text-xs space-y-1.5 w-28 shrink-0">{d.expenses.slice(0, 6).map((e: any, i: number) => <li key={e.category} className="flex items-center gap-1.5 min-w-0"><span className="h-2 w-2 rounded-full shrink-0" style={{ background: c.series[i % c.series.length] }} /><span className="truncate text-muted">{e.category}</span></li>)}</ul></div>
            : <div className="h-full grid place-items-center text-sm text-muted text-center">No expenses recorded yet</div>}</ChartCard>
      </div>
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2"><h3 className="font-semibold mb-2 flex items-center justify-between">Recent invoices<button className="text-xs font-normal text-accent underline" onClick={() => nav('/invoices')}>See all</button></h3>
          <Table rows={d.recentInvoices} cols={[
            { h: 'Number', render: (r: any) => <span className="num font-medium">{r.number}</span> }, { h: 'Client', render: (r: any) => r.client },
            { h: 'Status', render: (r: any) => <Pill s={r.status} /> }, { h: 'Total', right: true, render: (r: any) => money(r.total, r.currency) }]} onRow={(r: any) => nav(`/invoices?open=${r.id}`)} empty="No invoices yet — they will appear here as you create them." /></div>
        <div><h3 className="font-semibold mb-2">Recent activity</h3>
          <div className="card !p-0"><ul className="divide-y divide-line/70 max-h-[28rem] overflow-auto">
            {d.activity.map((a: any) => <li key={a.id} className="px-4 py-3 text-sm"><span className="font-medium">{a.user ?? 'System'}</span> <span className="text-muted">{a.action}d</span> {a.entity.replace(/_/g, ' ').replace(/s$/, '')} <span className="num text-muted">#{a.entity_id}</span>
              <div className="text-xs text-muted mt-0.5">{new Date(a.created_at).toLocaleString()}</div></li>)}
            {!d.activity.length && <li className="px-4 py-8 text-center text-sm text-muted">No activity yet</li>}</ul></div></div>
      </div>
    </Page>
  );
}
