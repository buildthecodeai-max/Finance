import { useEffect, useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Page, Pill, Table } from '../components/ui';

const FEATURE_LABEL: Record<string, string> = { portal: 'Client portal & payment links', accounting_export: 'Accounting export', automation: 'Automation rules', scheduled_reports: 'Scheduled reports', integrations: 'Webhooks & integrations', api: 'Public API' };
const day = (d: string | null) => (d ? String(d).slice(0, 10) : '—');

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0, hot = limit !== null && used >= limit;
  return <div><div className="flex justify-between text-sm mb-1"><span>{label}</span><span className="num text-muted">{used} / {limit ?? '∞'}</span></div>
    <div className="h-2 rounded-full bg-surface2 overflow-hidden" role="progressbar" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit ?? undefined}><div className={`h-full ${hot ? 'bg-danger' : pct > 80 ? 'bg-warn' : 'bg-accent'}`} style={{ width: limit ? `${pct}%` : '8%', opacity: limit ? 1 : 0.3 }} /></div></div>;
}

export default function Billing() {
  const { can } = useAuth(); const admin = can('admin');
  const [d, setD] = useState<any>(null); const [plans, setPlans] = useState<any[]>([]); const [invoices, setInvoices] = useState<any[]>([]);
  const [interval, setInterval_] = useState<'monthly' | 'yearly'>('monthly'); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState('');
  const load = () => { api('/billing/subscription').then(setD); api('/billing/plans').then(setPlans); if (can('admin', 'finance_manager')) api('/billing/invoices').then(setInvoices); };
  useEffect(() => { load(); if (new URLSearchParams(location.search).get('subscribed')) setMsg('Thanks! Your payment is being confirmed — your plan updates within a minute.'); }, []);
  const go = async (key: string, fn: () => Promise<any>, ok?: string) => { setBusy(key); try { const r = await fn(); setErr(''); if (ok) setMsg(ok); load(); return r; } catch (e: any) { setErr(e.message); } finally { setBusy(''); } };
  const redirect = async (path: string, body?: unknown) => { const r = await api(path, 'POST', body); window.location.href = r.url; };
  if (!d) return <Page title="Billing"><div className="skeleton h-40" /></Page>;
  const s = d.subscription; if (!s) return <Page title="Billing"><div className="card text-muted">No subscription found.</div></Page>;
  const price = (p: any) => (interval === 'yearly' ? p.price_yearly : p.price_monthly);
  const rank = (code: string) => plans.findIndex((p) => p.code === code);
  const subscribed = s.has_payment_method && s.status === 'active';

  return (
    <Page title="Billing" description="Your plan, usage and invoices.">
      <Err e={err} />{msg && <div className="rounded-lg border border-success/30 bg-success/10 text-success text-sm p-3 mb-4">{msg}</div>}
      {d.banner && <div className={`rounded-lg border text-sm p-3 mb-4 ${d.banner.level === 'danger' ? 'border-danger/30 bg-danger/10 text-danger' : d.banner.level === 'warn' ? 'border-warn/30 bg-warn/10 text-warn' : 'border-info/30 bg-info/10 text-info'}`}>{d.banner.message}</div>}
      {!d.online_billing && admin && <div className="rounded-lg border border-line bg-surface2/50 text-sm p-3 mb-4 text-muted">Online card billing isn't enabled on this installation. You can still switch plans during your trial; to continue after it, contact support to arrange invoicing.</div>}

      <div className="grid gap-4 lg:grid-cols-3 mb-6">
        <div className="card"><div className="text-xs text-muted">Current plan</div><div className="text-xl font-semibold mt-1">{s.plan.name} <span className="text-sm font-normal text-muted capitalize">· {s.interval}</span></div>
          <div className="mt-2 flex items-center gap-2"><Pill s={s.status} /></div>
          <dl className="text-sm mt-3 space-y-1">{s.status === 'trialing' && <div className="flex justify-between"><dt className="text-muted">Trial ends</dt><dd className="num">{day(s.trial_ends_at)}</dd></div>}
            {s.current_period_end && <div className="flex justify-between"><dt className="text-muted">{s.cancel_at_period_end ? 'Ends' : 'Renews'}</dt><dd className="num">{day(s.current_period_end)}</dd></div>}
            {s.pending_plan && <div className="flex justify-between"><dt className="text-muted">Next plan</dt><dd>{s.pending_plan.name}</dd></div>}
            <div className="flex justify-between"><dt className="text-muted">Support</dt><dd className="capitalize">{s.plan.support_level}</dd></div></dl>
          {admin && <div className="flex flex-wrap gap-2 mt-4">
            {s.has_payment_method && <button className="btn-ghost" disabled={!!busy} onClick={() => go('portal', () => redirect('/billing/portal'))}><ExternalLink size={14} /> Payment method & invoices</button>}
            {subscribed && !s.cancel_at_period_end && <button className="btn-ghost text-danger" disabled={!!busy} onClick={() => confirm('Cancel at the end of the current period? You keep access until then.') && go('cancel', () => api('/billing/cancel', 'POST'), 'Cancellation scheduled.')}>Cancel subscription</button>}
            {s.cancel_at_period_end && <button className="btn" disabled={!!busy} onClick={() => go('resume', () => api('/billing/resume', 'POST'), 'Cancellation withdrawn.')}>Keep my subscription</button>}
            {s.pending_plan && <button className="btn-ghost" disabled={!!busy} onClick={() => go('pend', () => api('/billing/cancel-pending-change', 'POST'), 'Scheduled change removed.')}>Undo scheduled change</button>}</div>}
        </div>
        <div className="card lg:col-span-2"><div className="font-medium mb-3">Usage</div><div className="grid gap-4 sm:grid-cols-3">
          <Meter label="Team members" used={d.usage.seats} limit={d.limits.seats} /><Meter label="Branches" used={d.usage.branches} limit={d.limits.branches} /><Meter label="Bookings this month" used={d.usage.bookings} limit={d.limits.bookings} /></div>
          <div className="mt-4 flex flex-wrap gap-1.5">{Object.keys(FEATURE_LABEL).map((f) => <span key={f} className={`text-xs px-2 py-0.5 rounded-full border ${d.features.includes(f) ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line text-muted line-through'}`}>{FEATURE_LABEL[f]}</span>)}</div></div>
      </div>

      <div className="flex items-center justify-between mb-3"><h2 className="font-semibold">Plans</h2>
        <div className="inline-flex rounded-lg border border-line p-0.5 text-sm" role="group" aria-label="Billing interval">{(['monthly', 'yearly'] as const).map((i) => <button key={i} className={`px-3 py-1 rounded-md capitalize ${interval === i ? 'bg-accent text-accent-ink' : 'text-muted'}`} onClick={() => setInterval_(i)}>{i}{i === 'yearly' && ' · 2 months free'}</button>)}</div></div>
      <div className="grid gap-4 md:grid-cols-3 mb-8">{plans.map((p) => { const current = p.code === s.plan.code, cta = rank(p.code) > rank(s.plan.code) ? 'Upgrade' : 'Switch';
        return <div key={p.code} className={`card flex flex-col ${current ? 'ring-2 ring-accent' : ''}`}>
          <div className="flex items-center justify-between"><h3 className="font-semibold text-lg">{p.name}</h3>{current && <span className="text-xs text-accent">Current</span>}</div><p className="text-sm text-muted mt-1">{p.description}</p>
          <div className="mt-3"><span className="text-3xl font-semibold num">{money(price(p), p.currency)}</span><span className="text-sm text-muted"> / {interval === 'yearly' ? 'year' : 'month'}</span></div>
          <ul className="text-sm mt-4 space-y-1.5 flex-1">
            <li className="flex gap-2"><Check size={15} className="text-accent mt-0.5 shrink-0" />{p.max_seats ?? 'Unlimited'} team members</li><li className="flex gap-2"><Check size={15} className="text-accent mt-0.5 shrink-0" />{p.max_branches ?? 'Unlimited'} branches</li>
            <li className="flex gap-2"><Check size={15} className="text-accent mt-0.5 shrink-0" />{p.max_bookings_month ? `${p.max_bookings_month} bookings / month` : 'Unlimited bookings'}</li>
            {p.features.map((f: string) => <li key={f} className="flex gap-2"><Check size={15} className="text-accent mt-0.5 shrink-0" />{FEATURE_LABEL[f]}</li>)}<li className="flex gap-2"><Check size={15} className="text-accent mt-0.5 shrink-0" /><span className="capitalize">{p.support_level}</span> support</li></ul>
          {admin && <button className={`${current && interval === s.interval ? 'btn-ghost' : 'btn'} mt-5`} disabled={!!busy || (current && interval === s.interval && s.status === 'active')}
            onClick={() => subscribed || s.status === 'trialing' && !d.online_billing ? go('chg', async () => { const r = await api('/billing/change-plan', 'POST', { plan: p.code, interval }); setMsg(r.applied === 'now' ? `You're now on ${p.name}.` : `${p.name} starts on ${day(r.at)}.`); }) : go('sub', () => redirect('/billing/subscribe', { plan: p.code, interval }))}>
            {current && interval === s.interval && s.status === 'active' ? 'Your plan' : subscribed ? cta : s.status === 'trialing' && !d.online_billing ? `Switch to ${p.name}` : `Choose ${p.name}`}</button>}
        </div>; })}</div>

      {can('admin', 'finance_manager') && <><h2 className="font-semibold mb-3">Invoices</h2>
        <Table rows={invoices} empty="No invoices yet" cols={[{ h: 'Date', render: (i) => <span className="num">{day(i.paid_at ?? i.created_at)}</span> }, { h: 'Number', render: (i) => i.number ?? '—' }, { h: 'Amount', right: true, render: (i) => money(i.amount, i.currency) },
          { h: 'Status', render: (i) => <Pill s={i.status === 'paid' ? 'paid' : i.status === 'failed' ? 'void' : 'pending'} /> }, { h: '', render: (i) => i.hosted_url && <a className="btn-ghost" href={i.hosted_url} target="_blank" rel="noopener noreferrer">View</a> }]} /></>}
    </Page>
  );
}
