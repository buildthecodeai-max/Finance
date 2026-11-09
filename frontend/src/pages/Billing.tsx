import { useEffect, useState } from 'react';
import { CalendarClock, Check, ExternalLink, Sparkles } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Page, Pill, Table } from '../components/ui';

const FEATURE_LABEL: Record<string, string> = { portal: 'Client portal & payment links', accounting_export: 'Accounting export', automation: 'Automation rules', scheduled_reports: 'Scheduled reports', integrations: 'Webhooks & integrations', api: 'Public API' };
const day = (d: string | null) => (d ? String(d).slice(0, 10) : '—');

const daysTo = (d: string | null) => (d ? Math.max(0, Math.ceil((new Date(String(d).slice(0, 10)).getTime() - Date.now()) / 864e5)) : null);

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0, hot = limit !== null && used >= limit;
  return <div><div className="flex items-baseline justify-between text-sm mb-1.5"><span className="font-medium">{label}</span><span className="num text-muted"><b className="text-fg">{used}</b> of {limit ?? 'unlimited'}</span></div>
    <div className="h-2 rounded-full bg-surface2 overflow-hidden" role="progressbar" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit ?? undefined}><div className={`h-full rounded-full transition-all ${hot ? 'bg-danger' : pct > 80 ? 'bg-warn' : 'bg-accent'}`} style={{ width: limit ? `${Math.max(pct, used ? 3 : 0)}%` : '100%', opacity: limit ? 1 : 0.15 }} /></div>
    {hot && <p className="text-xs text-danger mt-1">Limit reached. Upgrade to add more.</p>}{!hot && pct > 80 && <p className="text-xs text-warn mt-1">{pct}% used.</p>}</div>;
}
const Tick = () => <Check size={15} className="text-accent mt-0.5 shrink-0" />;

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

  const saving = Math.max(0, ...plans.map((p) => (p.price_monthly > 0 ? Math.round((1 - p.price_yearly / (p.price_monthly * 12)) * 100) : 0)));
  const trialLeft = s.status === 'trialing' ? daysTo(s.trial_ends_at) : null;
  const toneBanner = (l: string) => (l === 'danger' ? 'border-danger/30 bg-danger/10 text-danger' : l === 'warn' ? 'border-warn/30 bg-warn/10 text-warn' : 'border-info/30 bg-info/10 text-info');

  return (
    <Page title="Billing" description="Your plan, what you’re using, and your invoices.">
      <Err e={err} />{msg && <div role="status" className="rounded-lg border border-success/30 bg-success/10 text-success text-sm p-3 mb-4">{msg}</div>}
      {d.banner && !(trialLeft !== null && d.banner.level === 'info') && <div className={`rounded-lg border text-sm p-3 mb-4 ${toneBanner(d.banner.level)}`}>{d.banner.message}</div>}
      {!d.online_billing && admin && <div className="rounded-lg border border-line bg-surface2/50 text-sm p-3 mb-4 text-muted">Online card billing isn't enabled on this installation. You can still switch plans during your trial; to continue after it, contact support to arrange invoicing.</div>}

      <div className="grid gap-4 xl:grid-cols-3 mb-8">
        <section className="card flex flex-col">
          <div className="flex items-start justify-between gap-2"><div><div className="text-xs font-medium uppercase tracking-wide text-muted">Current plan</div><div className="text-2xl font-semibold mt-1">{s.plan.name}</div></div><Pill s={s.status} /></div>
          <div className="mt-1 text-sm text-muted capitalize">Billed {s.interval}{s.plan.support_level ? ` · ${s.plan.support_level} support` : ''}</div>
          {trialLeft !== null && <div className="mt-4 rounded-lg bg-accent/10 border border-accent/20 p-3"><div className="flex items-center gap-2 text-sm font-medium text-accent"><Sparkles size={15} />{trialLeft} day{trialLeft === 1 ? '' : 's'} left in your trial</div><div className="text-xs text-muted mt-0.5">Ends {day(s.trial_ends_at)}. Choose a plan below to keep going without interruption.</div></div>}
          <dl className="text-sm mt-4 divide-y divide-line">
            {s.current_period_end && <div className="flex justify-between py-2"><dt className="flex items-center gap-1.5 text-muted"><CalendarClock size={14} />{s.cancel_at_period_end ? 'Access ends' : 'Next renewal'}</dt><dd className="num">{day(s.current_period_end)}</dd></div>}
            {s.pending_plan && <div className="flex justify-between py-2"><dt className="text-muted">Switching to</dt><dd className="font-medium">{s.pending_plan.name}</dd></div>}
            <div className="flex justify-between py-2"><dt className="text-muted">Payment method</dt><dd>{s.has_payment_method ? 'On file' : 'None yet'}</dd></div></dl>
          {admin && <div className="flex flex-wrap gap-2 mt-auto pt-4">
            {s.has_payment_method && <button className="btn-ghost" disabled={!!busy} onClick={() => go('portal', () => redirect('/billing/portal'))}><ExternalLink size={14} /> Payment method & invoices</button>}
            {subscribed && !s.cancel_at_period_end && <button className="btn-ghost text-danger" disabled={!!busy} onClick={() => confirm('Cancel at the end of the current period? You keep access until then.') && go('cancel', () => api('/billing/cancel', 'POST'), 'Cancellation scheduled.')}>Cancel subscription</button>}
            {s.cancel_at_period_end && <button className="btn" disabled={!!busy} onClick={() => go('resume', () => api('/billing/resume', 'POST'), 'Cancellation withdrawn.')}>Keep my subscription</button>}
            {s.pending_plan && <button className="btn-ghost" disabled={!!busy} onClick={() => go('pend', () => api('/billing/cancel-pending-change', 'POST'), 'Scheduled change removed.')}>Undo scheduled change</button>}</div>}
        </section>
        <section className="card xl:col-span-2">
          <h2 className="font-semibold">Usage</h2><p className="text-sm text-muted mb-4">What your agency is using against this plan’s limits.</p>
          <div className="grid gap-5 sm:grid-cols-3"><Meter label="Team members" used={d.usage.seats} limit={d.limits.seats} /><Meter label="Branches" used={d.usage.branches} limit={d.limits.branches} /><Meter label="Bookings this month" used={d.usage.bookings} limit={d.limits.bookings} /></div>
          <h3 className="text-sm font-medium mt-6 mb-2">Included in your plan</h3>
          <div className="flex flex-wrap gap-1.5">{[...Object.keys(FEATURE_LABEL), ...d.features.filter((f: string) => !(f in FEATURE_LABEL) && !f.includes(' > '))].map((f) => { const on = d.features.includes(f); return <span key={f} className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border ${on ? 'border-accent/30 bg-accent/10 text-accent' : 'border-line text-muted'}`}>{on && <Check size={12} />}{FEATURE_LABEL[f] ?? f}{!on && <span className="opacity-70"> · not included</span>}</span>; })}</div>
        </section>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3 mb-4"><div><h2 className="font-semibold text-lg">Choose a plan</h2><p className="text-sm text-muted">Change plan at any time. Upgrades apply straight away; downgrades start at your next renewal.</p></div>
        <div className="inline-flex rounded-lg border border-line bg-surface2 p-0.5 text-sm" role="group" aria-label="Billing interval">{(['monthly', 'yearly'] as const).map((i) => <button key={i} aria-pressed={interval === i} className={`px-3.5 h-8 rounded-md capitalize transition ${interval === i ? 'bg-surface text-fg shadow-sm font-medium' : 'text-muted hover:text-fg'}`} onClick={() => setInterval_(i)}>{i}{i === 'yearly' && saving > 0 && <span className="ml-1.5 text-[11px] font-semibold text-accent">Save {saving}%</span>}</button>)}</div></div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 mb-10">{plans.map((p) => { const current = p.code === s.plan.code, cta = rank(p.code) > rank(s.plan.code) ? 'Upgrade' : 'Switch';
        const top = p.features.filter((f: string) => !f.includes(' > '));
        return <div key={p.code} className={`card flex flex-col ${current ? 'ring-2 ring-accent' : ''}`}>
          <div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-lg">{p.name}</h3>{current && <span className="pill bg-accent/15 text-accent">Current plan</span>}</div><p className="text-sm text-muted mt-1 min-h-[2.5rem]">{p.description}</p>
          <div className="mt-3 flex items-baseline gap-1"><span className="text-4xl font-semibold num tracking-tight">{money(price(p), p.currency)}</span><span className="text-sm text-muted">/ {interval === 'yearly' ? 'year' : 'month'}</span></div>
          <div className="text-xs text-muted mt-1 h-4">{interval === 'yearly' && p.price_yearly > 0 ? `${money(p.price_yearly / 12, p.currency)} a month, billed yearly` : p.trial_days ? `${p.trial_days}-day free trial` : ''}</div>
          <div className="my-4 border-t border-line" />
          <ul className="text-sm space-y-2 flex-1">
            <li className="flex gap-2"><Tick />{p.max_seats ?? 'Unlimited'} team {p.max_seats === 1 ? 'member' : 'members'}</li><li className="flex gap-2"><Tick />{p.max_branches ?? 'Unlimited'} {p.max_branches === 1 ? 'branch' : 'branches'}</li>
            <li className="flex gap-2"><Tick />{p.max_bookings_month ? `${p.max_bookings_month} bookings / month` : 'Unlimited bookings'}</li>
            {top.map((f: string) => <li key={f}><div className="flex gap-2"><Tick />{FEATURE_LABEL[f] ?? f}</div>{p.features.filter((x: string) => x.startsWith(f + ' > ')).map((x: string) => <div key={x} className="ml-6 text-xs text-muted">• {x.slice(f.length + 3)}</div>)}</li>)}
            <li className="flex gap-2"><Tick /><span className="capitalize">{p.support_level} support</span></li></ul>
          {admin && <button className={`${current && interval === s.interval ? 'btn-ghost' : 'btn'} mt-6 w-full`} disabled={!!busy || (current && interval === s.interval && s.status === 'active')}
            onClick={() => subscribed || s.status === 'trialing' && !d.online_billing ? go('chg', async () => { const r = await api('/billing/change-plan', 'POST', { plan: p.code, interval }); setMsg(r.applied === 'now' ? `You're now on ${p.name}.` : `${p.name} starts on ${day(r.at)}.`); }) : go('sub', () => redirect('/billing/subscribe', { plan: p.code, interval }))}>
            {current && interval === s.interval && s.status === 'active' ? 'Your plan' : subscribed ? `${cta} to ${p.name}` : s.status === 'trialing' && !d.online_billing ? `Switch to ${p.name}` : `Choose ${p.name}`}</button>}
        </div>; })}</div>

      {can('admin', 'finance_manager') && <section><h2 className="font-semibold text-lg mb-1">Invoices</h2><p className="text-sm text-muted mb-3">Your payment history for this subscription.</p>
        <Table rows={invoices} empty="No invoices yet" cols={[{ h: 'Date', render: (i) => <span className="num">{day(i.paid_at ?? i.created_at)}</span> }, { h: 'Number', render: (i) => i.number ?? '—' }, { h: 'Amount', right: true, render: (i) => <span className="num">{money(i.amount, i.currency)}</span> },
          { h: 'Status', render: (i) => <Pill s={i.status === 'paid' ? 'paid' : i.status === 'failed' ? 'void' : 'pending'} /> }, { h: '', render: (i) => i.hosted_url && <a className="btn-ghost" href={i.hosted_url} target="_blank" rel="noopener noreferrer">View</a> }]} /></section>}
    </Page>
  );
}
