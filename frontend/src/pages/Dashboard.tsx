import { ReactNode, useEffect, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Banknote, Briefcase, HandCoins, Wallet } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Page, Pill, Skeleton, Table } from '../components/ui';
import { useChartColors } from '../theme';

function Kpi({ label, value, trend, cur, icon }: { label: string; value: number; trend: number[]; cur: string; icon: ReactNode }) {
  const c = useChartColors(); const id = `g-${label.replace(/\W/g, '')}`;
  return (
    <div className="card !p-0 overflow-hidden">
      <div className="p-4 pb-2 flex items-start justify-between">
        <div><div className="text-xs font-medium text-muted">{label}</div><div className="num text-xl sm:text-[26px] font-semibold tracking-tight mt-1">{money(value, cur)}</div></div>
        <div className="hidden sm:grid h-9 w-9 rounded-lg bg-accent/10 text-accent place-items-center">{icon}</div>
      </div>
      <div className="h-14" aria-hidden>{trend.length > 1 && (
        <ResponsiveContainer><AreaChart data={trend.map((v, i) => ({ i, v }))} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c.accent} stopOpacity={0.28} /><stop offset="100%" stopColor={c.accent} stopOpacity={0} /></linearGradient></defs>
          <Area dataKey="v" type="monotone" stroke={c.accent} strokeWidth={2} fill={`url(#${id})`} dot={false} isAnimationActive={false} /></AreaChart></ResponsiveContainer>)}</div>
    </div>
  );
}

const ChartCard = ({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) => (
  <div className="card"><div className="mb-3"><h3 className="font-semibold">{title}</h3>{sub && <p className="text-xs text-muted">{sub}</p>}</div><div className="h-52">{children}</div></div>
);

export default function Dashboard() {
  const { agency, user } = useAuth(); const c = useChartColors();
  const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { setD(null); api('/dashboard').then(setD).catch((e) => setErr(e.message)); }, [agency?.id]);
  const hour = new Date().getHours(), greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const head = { title: `${greet}, ${(user?.name ?? '').split(' ')[0]}`, description: `${agency?.name ?? ''} · figures in ${agency?.base_currency ?? ''}, last 12 months` };
  if (err) return <Page title="Dashboard"><div className="card text-danger text-sm">{err}</div></Page>;
  if (!d) return (
    <Page {...head}><div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}</div>
      <div className="grid lg:grid-cols-3 gap-4 mb-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-72" />)}</div><Skeleton className="h-64" /></Page>);
  const cur = agency!.base_currency, k = d.kpis;
  const aging = [['Current', d.arAging.current_], ['1–30', d.arAging.d30], ['31–60', d.arAging.d60], ['60+', d.arAging.d90]].map(([name, v]) => ({ name, v: Number(v ?? 0) }));
  const tip = { contentStyle: { background: c.surface, border: `1px solid ${c.grid}`, borderRadius: 10, color: c.fg, fontSize: 12, boxShadow: '0 8px 24px rgb(0 0 0 / 0.2)' }, cursor: { fill: c.accentSoft }, formatter: (v: number) => money(v, cur) };
  const axis = { stroke: c.text, fontSize: 11, tickLine: false, axisLine: false } as const;
  return (
    <Page {...head}>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
        <Kpi label="Total revenue" value={k.revenue.value} trend={k.revenue.trend} cur={cur} icon={<Banknote size={18} />} />
        <Kpi label="Bookings value" value={k.bookings.value} trend={k.bookings.trend} cur={cur} icon={<Briefcase size={18} />} />
        <Kpi label="Outstanding AR" value={k.outstandingAr.value} trend={k.outstandingAr.trend} cur={cur} icon={<Wallet size={18} />} />
        <Kpi label="Net commission" value={k.netCommission.value} trend={k.netCommission.trend} cur={cur} icon={<HandCoins size={18} />} />
      </div>
      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <ChartCard title="Receivables aging" sub="Outstanding invoices by days past due">
          <ResponsiveContainer><BarChart data={aging} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}><CartesianGrid vertical={false} stroke={c.grid} strokeDasharray="3 3" /><XAxis dataKey="name" {...axis} /><YAxis hide /><Tooltip {...tip} />
            <Bar dataKey="v" radius={[6, 6, 0, 0]} maxBarSize={48}>{aging.map((_, i) => <Cell key={i} fill={c.aging[i]} />)}</Bar></BarChart></ResponsiveContainer></ChartCard>
        <ChartCard title="Revenue by product" sub="Confirmed invoices, selling net">
          <ResponsiveContainer><BarChart data={d.revenueByType} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}><CartesianGrid vertical={false} stroke={c.grid} strokeDasharray="3 3" /><XAxis dataKey="type" {...axis} /><YAxis hide /><Tooltip {...tip} />
            <Bar dataKey="v" fill={c.accent} radius={[6, 6, 0, 0]} maxBarSize={48} /></BarChart></ResponsiveContainer></ChartCard>
        <ChartCard title="Expenses" sub="Last 12 months by category">
          {d.expenses.length ? <div className="flex h-full items-center gap-3"><div className="h-full flex-1"><ResponsiveContainer><PieChart><Pie data={d.expenses} dataKey="v" nameKey="category" innerRadius="58%" outerRadius="88%" stroke="none" paddingAngle={2}>{d.expenses.map((_: any, i: number) => <Cell key={i} fill={c.series[i % c.series.length]} />)}</Pie><Tooltip {...tip} cursor={false} /></PieChart></ResponsiveContainer></div>
            <ul className="text-xs space-y-1.5 w-28 shrink-0">{d.expenses.slice(0, 6).map((e: any, i: number) => <li key={e.category} className="flex items-center gap-1.5 min-w-0"><span className="h-2 w-2 rounded-full shrink-0" style={{ background: c.series[i % c.series.length] }} /><span className="truncate text-muted">{e.category}</span></li>)}</ul></div>
            : <div className="h-full grid place-items-center text-sm text-muted">No expenses recorded</div>}</ChartCard>
      </div>
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2"><h3 className="font-semibold mb-2">Recent invoices</h3>
          <Table rows={d.recentInvoices} cols={[
            { h: 'Number', render: (r: any) => <span className="num font-medium">{r.number}</span> }, { h: 'Client', render: (r: any) => r.client },
            { h: 'Status', render: (r: any) => <Pill s={r.status} /> }, { h: 'Total', right: true, render: (r: any) => money(r.total, r.currency) }]} /></div>
        <div><h3 className="font-semibold mb-2">Recent activity</h3>
          <div className="card !p-0"><ul className="divide-y divide-line/70 max-h-[28rem] overflow-auto">
            {d.activity.map((a: any) => <li key={a.id} className="px-4 py-3 text-sm"><span className="font-medium">{a.user ?? 'System'}</span> <span className="text-muted">{a.action}d</span> {a.entity.replace(/_/g, ' ').replace(/s$/, '')} <span className="num text-muted">#{a.entity_id}</span>
              <div className="text-xs text-muted mt-0.5">{new Date(a.created_at).toLocaleString()}</div></li>)}
            {!d.activity.length && <li className="px-4 py-8 text-center text-sm text-muted">No activity yet</li>}</ul></div></div>
      </div>
    </Page>
  );
}
