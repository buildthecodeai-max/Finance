import { useEffect, useState } from 'react';
import { AlertTriangle, Brain, Building2, CalendarClock, CalendarDays, Check, CreditCard, ExternalLink, Infinity as InfinityIcon, Receipt, Sparkles, Users, Wallet, type LucideIcon } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Modal, Page, Pill, Skeleton, Table } from '../components/ui';

const FEATURE_LABEL: Record<string, string> = { portal: 'Client portal & payment links', accounting_export: 'Accounting export', automation: 'Automation rules', scheduled_reports: 'Scheduled reports', integrations: 'Webhooks & integrations', api: 'Public API', ai_assistant: 'AI assistant' };
const TIER_HUE = ['info', 'accent', 'success', 'warn'];
const day = (d: string | null) => (d ? String(d).slice(0, 10) : '—');
const daysTo = (d: string | null) => (d ? Math.max(0, Math.ceil((new Date(String(d).slice(0, 10)).getTime() - Date.now()) / 864e5)) : null);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const WALLET: Record<string, { label: string; dot: string }> = { jazzcash: { label: 'JazzCash', dot: '#e11d2a' }, easypaisa: { label: 'Easypaisa', dot: '#2fb344' } };
const PAY_NOTE: Record<string, { tone: string; text: string }> = {
  paid: { tone: 'success', text: 'Payment received. Thank you! Your plan is active.' },
  pending: { tone: 'info', text: 'We are still confirming your payment with the provider. If you completed it, your plan updates as soon as it is confirmed. If nothing changes within a few hours, contact support and quote the reference in Rupee payments below.' },
  failed: { tone: 'warn', text: 'The payment was not completed, so your plan has not changed. You can try again.' },
  error: { tone: 'danger', text: 'We could not verify that payment result, so nothing was changed. If you were charged, contact support and give them the payment time and amount.' },
  unknown: { tone: 'danger', text: 'We could not match that payment to your account, so nothing was changed. If you were charged, contact support.' },
};
const pkr = (n: number) => `PKR ${Number(n).toLocaleString('en', { maximumFractionDigits: 0 })}`;
/** The provider's checkout is either a link to open or a form to post: JazzCash wants a signed form. */
function goToGateway(r: { method: 'GET' | 'POST'; url: string; fields?: Record<string, string> }) {
  if (r.method === 'GET') { window.location.href = r.url; return; }
  const f = document.createElement('form'); f.method = 'POST'; f.action = r.url;
  for (const [k, v] of Object.entries(r.fields ?? {})) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); }
  document.body.appendChild(f); f.submit();
}

/** One thing the plan limits: how much is used, with a bar that warms up as it fills. */
function Meter({ label, used, limit, icon: Icon, unit }: { label: string; used: number; limit: number | null; icon: LucideIcon; unit?: string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0, hot = limit !== null && used >= limit, warm = !hot && pct > 80; const hue = hot ? 'danger' : warm ? 'warn' : 'accent';
  return (
    <div className="card glow-card" style={{ ['--hue' as any]: `var(--${hue})` }}>
      <div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{label}</span><span className="grid h-8 w-8 place-items-center rounded-xl" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}><Icon size={16} /></span></div>
      <div className="mt-2 flex items-baseline gap-1.5"><span className="text-3xl font-bold num">{used}</span><span className="text-sm text-muted">of {limit ?? 'unlimited'}{unit ? ` ${unit}` : ''}</span></div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface2" role="progressbar" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit ?? undefined}><div className="h-full rounded-full transition-all duration-700" style={{ width: `${limit ? Math.max(used ? 4 : 0, pct) : used ? 8 : 0}%`, background: `rgb(var(--${hue}))` }} /></div>
      <p className={`mt-1.5 min-h-[1rem] text-[11px] ${hot ? 'font-medium text-danger' : warm ? 'text-warn' : 'text-muted'}`}>{hot ? 'Limit reached. Upgrade to add more.' : warm ? `${pct}% used` : limit ? `${limit - used} left` : 'No limit on your plan'}</p>
    </div>
  );
}

export default function Billing() {
  const { can } = useAuth(); const admin = can('admin');
  const [d, setD] = useState<any>(null); const [plans, setPlans] = useState<any[]>([]); const [invoices, setInvoices] = useState<any[]>([]); const [ai, setAi] = useState<any>(null);
  const [interval, setInterval_] = useState<'monthly' | 'yearly'>('monthly'); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(''); const [askCancel, setAskCancel] = useState(false); const [note, setNote] = useState<{ tone: string; text: string } | null>(null); const [rupee, setRupee] = useState<any[]>([]);
  const load = () => { api('/billing/subscription').then(setD); api('/billing/plans').then(setPlans); if (can('admin', 'finance_manager')) { api('/billing/invoices').then(setInvoices); api('/billing/local/payments').then(setRupee).catch(() => {}); } api('/ai/status').then(setAi).catch(() => {}); };
  useEffect(() => {
    load(); const q = new URLSearchParams(location.search);
    if (q.get('subscribed')) setMsg('Thanks! Your payment is being confirmed — your plan updates within a minute.');
    const back = q.get('pay'); if (back && PAY_NOTE[back]) { setNote(PAY_NOTE[back]); window.history.replaceState(null, '', location.pathname); }
  }, []);
  const go = async (key: string, fn: () => Promise<any>, ok?: string) => { setBusy(key); try { const r = await fn(); setErr(''); if (ok) setMsg(ok); load(); return r; } catch (e: any) { setErr(e.message); } finally { setBusy(''); } };
  const redirect = async (path: string, body?: unknown) => { const r = await api(path, 'POST', body); window.location.href = r.url; };
  const payLocal = (provider: string, plan: string) => go(`local-${provider}-${plan}`, async () => { goToGateway(await api('/billing/local/start', 'POST', { plan, interval, provider })); await new Promise((r) => setTimeout(r, 8000)); });
  if (!d) return <Page title="Billing"><div className="space-y-4"><Skeleton className="h-44" /><div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div></div></Page>;
  const s = d.subscription; if (!s) return <Page title="Billing"><div className="card text-muted">No subscription found.</div></Page>;
  const price = (p: any) => (interval === 'yearly' ? p.price_yearly : p.price_monthly);
  const rank = (code: string) => plans.findIndex((p) => p.code === code);
  const subscribed = s.has_payment_method && s.status === 'active';
  const mine = plans.find((p) => p.code === s.plan.code); const myPrice = mine ? (s.interval === 'yearly' ? mine.price_yearly : mine.price_monthly) : null;
  const saving = Math.max(0, ...plans.map((p) => (p.price_monthly > 0 ? Math.round((1 - p.price_yearly / (p.price_monthly * 12)) * 100) : 0)));
  const trialLeft = s.status === 'trialing' ? daysTo(s.trial_ends_at) : null; const renewLeft = daysTo(s.current_period_end);
  const toneBanner = (l: string) => (l === 'danger' ? 'border-danger/30 bg-danger/10 text-danger' : l === 'warn' ? 'border-warn/30 bg-warn/10 text-warn' : 'border-info/30 bg-info/10 text-info');
  const tight = (used: number, limit: number | null) => limit !== null && limit > 0 && used / limit >= 0.8;
  const strained = tight(d.usage.seats, d.limits.seats) || tight(d.usage.branches, d.limits.branches) || tight(d.usage.bookings, d.limits.bookings);
  const nextUp = strained && rank(s.plan.code) >= 0 ? plans[rank(s.plan.code) + 1]?.code : null;       // suggest the next plan up only when a limit is close
  const wallets = (['jazzcash', 'easypaisa'] as const).filter((k) => d.local_pay?.[k]);
  const paid = invoices.filter((i) => i.status === 'paid'); const paidTotal = paid.reduce((t, i) => t + Number(i.amount ?? 0), 0);
  const features: string[] = d.features; const allFeat = [...Object.keys(FEATURE_LABEL), ...features.filter((f) => !(f in FEATURE_LABEL) && !f.includes(' > '))];
  const heroHue = s.status === 'past_due' || s.status === 'grace' ? 'warn' : s.status === 'suspended' || s.status === 'cancelled' ? 'danger' : 'accent';
  const periodPct = trialLeft !== null ? Math.max(4, Math.min(100, (trialLeft / 14) * 100)) : renewLeft !== null ? Math.max(4, Math.min(100, (renewLeft / (s.interval === 'yearly' ? 365 : 31)) * 100)) : null;

  return (
    <Page title="Billing" description="Your plan, what you’re using, and your invoices.">
      <Err e={err} />{msg && <div role="status" className="mb-4 flex justify-between gap-3 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success"><span>{msg}</span><button aria-label="Dismiss" onClick={() => setMsg('')}>×</button></div>}
      {note && <div role="status" className={`mb-4 flex justify-between gap-3 rounded-lg border p-3 text-sm ${toneBanner(note.tone === 'success' ? 'info' : note.tone)} ${note.tone === 'success' ? '!border-success/30 !bg-success/10 !text-success' : ''}`}><span>{note.text}</span><button aria-label="Dismiss" onClick={() => setNote(null)}>×</button></div>}
      {d.banner && !(trialLeft !== null && d.banner.level === 'info') && <div className={`mb-4 flex gap-2 rounded-lg border p-3 text-sm ${toneBanner(d.banner.level)}`}><AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>{d.banner.message}</span></div>}
      {!d.online_billing && !wallets.length && admin && <div className="mb-4 rounded-lg border border-line bg-surface2/50 p-3 text-sm text-muted">Online billing isn't enabled on this installation. You can still switch plans during your trial; to continue after it, contact support to arrange invoicing.</div>}

      <section className="hero-mesh mb-5 rounded-2xl border border-line p-5 md:p-6" style={{ ['--hue' as any]: `var(--${heroHue})` }} aria-label="Your plan">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium uppercase tracking-wider text-muted">Your plan</span><Pill s={s.status} /></div>
            <h2 className="mt-1 text-3xl font-extrabold tracking-tight">{s.plan.name}</h2>
            <p className="mt-1 text-sm capitalize text-muted">Billed {s.interval}{s.plan.support_level ? ` · ${s.plan.support_level} support` : ''}{myPrice !== null && mine ? ` · ${money(myPrice, mine.currency)} per ${s.interval === 'yearly' ? 'year' : 'month'}` : ''}</p>
            {periodPct !== null && (trialLeft !== null || s.current_period_end) && <div className="mt-4 max-w-md">
              <div className="mb-1 flex items-center justify-between text-xs"><span className="flex items-center gap-1.5 font-medium">{trialLeft !== null ? <><Sparkles size={13} className="text-accent" />Free trial</> : <><CalendarClock size={13} className="text-muted" />{s.cancel_at_period_end ? 'Access ends' : s.manual ? 'Paid until' : 'Next renewal'}</>}</span>
                <span className={`num ${trialLeft !== null && trialLeft <= 3 ? 'font-medium text-warn' : 'text-muted'}`}>{trialLeft !== null ? `${plural(trialLeft, 'day')} left · ends ${day(s.trial_ends_at)}` : `${day(s.current_period_end)}${renewLeft !== null ? ` · in ${plural(renewLeft, 'day')}` : ''}`}</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-surface2/80"><div className="h-full rounded-full transition-all duration-700" style={{ width: `${periodPct}%`, background: trialLeft !== null && trialLeft <= 3 ? 'rgb(var(--warn))' : 'rgb(var(--accent))' }} /></div>
              {trialLeft !== null && <p className="mt-1.5 text-xs text-muted">Choose a plan below to keep going without interruption.</p>}</div>}
            {s.pending_plan && <p className="mt-3 text-sm"><span className="text-muted">Switching to</span> <b>{s.pending_plan.name}</b> <span className="text-muted">at your next renewal.</span></p>}
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/70 px-3 py-1 text-xs backdrop-blur"><CreditCard size={13} className="text-muted" />{s.has_payment_method ? 'Payment method on file' : s.manual && s.status === 'active' ? 'Paid by payment, no automatic renewal' : 'No payment method yet'}</span>
            {admin && <div className="flex flex-wrap gap-2 sm:justify-end">
              {s.has_payment_method && <button className="btn-ghost" disabled={!!busy} onClick={() => go('portal', () => redirect('/billing/portal'))}><ExternalLink size={14} />Payment method &amp; invoices</button>}
              {s.cancel_at_period_end && <button className="btn" disabled={!!busy} onClick={() => go('resume', () => api('/billing/resume', 'POST'), 'Cancellation withdrawn.')}>Keep my subscription</button>}
              {s.pending_plan && <button className="btn-ghost" disabled={!!busy} onClick={() => go('pend', () => api('/billing/cancel-pending-change', 'POST'), 'Scheduled change removed.')}>Undo scheduled change</button>}
              {subscribed && !s.cancel_at_period_end && <button className="btn-ghost text-danger" disabled={!!busy} onClick={() => setAskCancel(true)}>Cancel subscription</button>}</div>}
          </div>
        </div>
      </section>

      <div className="mb-3"><h2 className="text-lg font-semibold">Usage</h2><p className="text-sm text-muted">What your agency is using against this plan’s limits.</p></div>
      <div className={`mb-5 grid gap-3 sm:grid-cols-2 ${ai?.available || features.includes('ai_assistant') ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>
        <Meter label="Team members" used={d.usage.seats} limit={d.limits.seats} icon={Users} /><Meter label="Branches" used={d.usage.branches} limit={d.limits.branches} icon={Building2} />
        <Meter label="Bookings this month" used={d.usage.bookings} limit={d.limits.bookings} icon={CalendarDays} />
        {(ai?.available || features.includes('ai_assistant')) && ai && <Meter label="AI requests this month" used={ai.used} limit={ai.limit} icon={Brain} />}</div>

      <div className="mb-8 card">
        <h3 className="mb-3 text-sm font-semibold">Included in your plan</h3>
        <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">{allFeat.map((f) => { const on = features.includes(f); const subs = features.filter((x) => x.startsWith(f + ' > ')).map((x) => x.slice(f.length + 3));
          return <li key={f} className={`flex items-start gap-2 text-sm ${on ? '' : 'text-muted'}`}><span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full ${on ? 'bg-accent/15 text-accent' : 'bg-surface2 text-muted'}`}>{on ? <Check size={11} strokeWidth={3} /> : <span className="text-[10px]">–</span>}</span>
            <span>{FEATURE_LABEL[f] ?? f}{!on && <span className="text-[11px]"> · not on this plan</span>}{on && subs.length > 0 && <span className="block text-xs text-muted">{subs.join(' · ')}</span>}</span></li>; })}</ul>
      </div>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-semibold">Choose a plan</h2><p className="text-sm text-muted">Change plan at any time. Upgrades apply straight away; downgrades start at your next renewal.</p></div>
        <div className="inline-flex rounded-lg border border-line bg-surface2 p-0.5 text-sm" role="group" aria-label="Billing interval">{(['monthly', 'yearly'] as const).map((i) => <button key={i} aria-pressed={interval === i} className={`h-8 rounded-md px-3.5 capitalize transition ${interval === i ? 'bg-surface font-medium text-fg shadow-sm' : 'text-muted hover:text-fg'}`} onClick={() => setInterval_(i)}>{i}{i === 'yearly' && saving > 0 && <span className="ml-1.5 text-[11px] font-semibold text-accent">Save {saving}%</span>}</button>)}</div></div>
      <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{plans.map((p, idx) => {
        const current = p.code === s.plan.code, cta = rank(p.code) > rank(s.plan.code) ? 'Upgrade' : 'Switch', top = p.features.filter((f: string) => !f.includes(' > ')), hue = TIER_HUE[idx % TIER_HUE.length], recommended = nextUp === p.code;
        const limits: [number | null, string][] = [[p.max_seats, 'Seats'], [p.max_branches, 'Branches'], [p.max_bookings_month, 'Bookings / mo']];
        return <article key={p.code} className={`card glow-card flex flex-col overflow-hidden !p-0 ${current ? 'ring-2 ring-accent' : recommended ? 'ring-2 ring-info' : ''}`} style={{ ['--hue' as any]: `var(--${hue})` }}>
          <div className="px-5 pb-4 pt-5" style={{ background: `linear-gradient(135deg, rgb(var(--${hue}) / .18), transparent 70%)` }}>
            <div className="flex items-center justify-between gap-2"><h3 className="text-lg font-bold tracking-tight">{p.name}</h3>{current ? <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-ink">Current plan</span> : recommended ? <span className="rounded-full bg-info px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Recommended</span> : null}</div>
            <p className="mt-1 min-h-[2.5rem] text-xs leading-relaxed text-muted">{p.description}</p>
            <div className="mt-2 flex items-baseline gap-1"><span className="text-4xl font-extrabold num tracking-tight">{money(price(p), p.currency)}</span><span className="text-sm text-muted">/ {interval === 'yearly' ? 'year' : 'month'}</span></div>
            <div className="mt-1 h-4 text-xs text-muted num">{interval === 'yearly' && p.price_yearly > 0 ? `${money(p.price_yearly / 12, p.currency)} a month, billed yearly` : p.trial_days ? `${p.trial_days}-day free trial` : ''}</div></div>
          <div className="grid grid-cols-3 border-y border-line/70 text-center">{limits.map(([v, l], i) => <div key={l} className={`px-2 py-2.5 ${i ? 'border-l border-line/70' : ''}`}><div className="flex h-6 items-center justify-center text-lg font-bold num">{v === null ? <InfinityIcon size={18} aria-label="Unlimited" /> : v}</div><div className="text-[10px] uppercase tracking-wide text-muted">{l}</div></div>)}</div>
          <ul className="flex-1 space-y-2 px-5 py-4 text-sm">{top.map((f: string) => <li key={f}><div className="flex items-start gap-2"><Check size={15} className="mt-0.5 shrink-0" style={{ color: `rgb(var(--${hue}))` }} />{FEATURE_LABEL[f] ?? f}</div>{p.features.filter((x: string) => x.startsWith(f + ' > ')).map((x: string) => <div key={x} className="ml-6 text-xs text-muted">· {x.slice(f.length + 3)}</div>)}</li>)}
            <li className="flex items-start gap-2"><Check size={15} className="mt-0.5 shrink-0" style={{ color: `rgb(var(--${hue}))` }} /><span className="capitalize">{p.support_level} support</span></li></ul>
          {admin && !(!d.online_billing && s.status !== 'trialing' && wallets.length > 0) && <div className="px-5 pb-5"><button className={`${current && interval === s.interval ? 'btn-ghost' : 'btn'} w-full`} disabled={!!busy || (current && interval === s.interval && s.status === 'active')}
            onClick={() => subscribed || s.status === 'trialing' && !d.online_billing ? go('chg', async () => { const r = await api('/billing/change-plan', 'POST', { plan: p.code, interval }); setMsg(r.applied === 'now' ? `You're now on ${p.name}.` : `${p.name} starts on ${day(r.at)}.`); }) : go('sub', () => redirect('/billing/subscribe', { plan: p.code, interval }))}>
            {current && interval === s.interval && s.status === 'active' ? 'Your plan' : subscribed ? `${cta} to ${p.name}` : s.status === 'trialing' && !d.online_billing ? `Switch to ${p.name}` : `Choose ${p.name}`}</button></div>}
          {admin && !subscribed && wallets.length > 0 && Number(interval === 'yearly' ? p.price_yearly_pkr : p.price_monthly_pkr) > 0 && <div className="border-t border-line/70 bg-surface2/40 px-5 py-4">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium"><Wallet size={13} className="text-muted" />{current && s.status === 'active' ? 'Renew' : 'Pay'} <span className="num font-bold">{pkr(interval === 'yearly' ? p.price_yearly_pkr : p.price_monthly_pkr)}</span> {interval === 'yearly' ? 'for a year' : 'for a month'} with</div>
            <div className="flex flex-wrap gap-2">{wallets.map((k) => <button key={k} className="btn-ghost" disabled={!!busy} onClick={() => payLocal(k, p.code)}><span className="h-2 w-2 rounded-full" style={{ background: WALLET[k].dot }} aria-hidden />{busy === `local-${k}-${p.code}` ? 'Opening…' : WALLET[k].label}{d.local_pay[k].sandbox && <span className="rounded bg-warn/15 px-1 text-[10px] font-semibold text-warn">TEST</span>}</button>)}</div>
            <p className="mt-2 text-[11px] text-muted">One payment, no automatic renewal. Paying early adds time to your plan.</p></div>}
        </article>; })}</div>

      {plans.length > 1 && <div className="card mb-8 !p-0 overflow-hidden"><div className="border-b border-line px-4 py-3 text-sm font-semibold">Compare plans</div>
        <div className="overflow-x-auto"><table className="w-full border-separate border-spacing-0"><thead><tr><th>&nbsp;</th>{plans.map((p) => <th key={p.code} className={`text-center ${p.code === s.plan.code ? '!text-accent' : ''}`}>{p.name}</th>)}</tr></thead><tbody>
          {([['Price', (p: any) => money(price(p), p.currency)], ['Team members', (p: any) => p.max_seats ?? '∞'], ['Branches', (p: any) => p.max_branches ?? '∞'], ['Bookings / month', (p: any) => p.max_bookings_month ?? '∞']] as [string, (p: any) => any][]).map(([l, f]) => <tr key={l}><td className="text-sm text-muted">{l}</td>{plans.map((p) => <td key={p.code} className="text-center text-sm font-medium num">{f(p)}</td>)}</tr>)}
          {Object.keys(FEATURE_LABEL).map((f) => <tr key={f}><td className="text-sm">{FEATURE_LABEL[f]}</td>{plans.map((p) => <td key={p.code} className="text-center">{p.features.includes(f) ? <Check size={16} className="mx-auto text-success" aria-label="Included" /> : <span className="text-muted" aria-label="Not included">—</span>}</td>)}</tr>)}
        </tbody></table></div></div>}

      {can('admin', 'finance_manager') && <section aria-label="Invoices">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-semibold">Invoices</h2><p className="text-sm text-muted">Your payment history for this subscription.</p></div>
          {paid.length > 0 && <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2"><span className="grid h-8 w-8 place-items-center rounded-lg bg-success/10 text-success"><Receipt size={16} /></span><div><div className="text-[11px] text-muted">Paid to date · {plural(paid.length, 'invoice')}</div><div className="text-base font-bold num">{money(paidTotal, paid[0].currency)}</div></div></div>}</div>
        <Table rows={invoices} noun="invoices" empty="No invoices yet" cols={[{ h: 'Date', render: (i) => <span className="num">{day(i.paid_at ?? i.created_at)}</span> }, { h: 'Number', render: (i) => <span className="font-medium">{i.number ?? '—'}</span> }, { h: 'Amount', right: true, render: (i) => <span className="num font-medium">{money(i.amount, i.currency)}</span> },
          { h: 'Status', render: (i) => <Pill s={i.status === 'paid' ? 'paid' : i.status === 'failed' ? 'void' : 'pending'} /> }, { h: '', render: (i) => i.hosted_url && <a className="btn-ghost" href={i.hosted_url} target="_blank" rel="noopener noreferrer">View</a> }]} /></section>}

      {can('admin', 'finance_manager') && rupee.length > 0 && <section aria-label="Rupee payments" className="mt-8">
        <div className="mb-3"><h2 className="text-lg font-semibold">Rupee payments</h2><p className="text-sm text-muted">Payments made with JazzCash or Easypaisa. Keep the reference if you ever need to contact support.</p></div>
        <Table rows={rupee} noun="payments" empty="No payments yet" cols={[{ h: 'Date', render: (r) => <span className="num">{day(r.paid_at ?? r.created_at)}</span> }, { h: 'Reference', render: (r) => <span className="font-medium num">{r.txn_ref}</span> }, { h: 'Method', render: (r) => <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: WALLET[r.provider]?.dot }} aria-hidden />{WALLET[r.provider]?.label ?? r.provider}</span> },
          { h: 'Plan', render: (r) => <span className="capitalize">{r.plan_name} · {r.billing_interval}</span> }, { h: 'Amount', right: true, render: (r) => <span className="num font-medium">{pkr(r.amount_pkr)}</span> },
          { h: 'Status', render: (r) => <span title={r.gateway_message ?? undefined}><Pill s={r.status === 'paid' ? 'paid' : r.status === 'failed' ? 'void' : 'pending'} /></span> }]} /></section>}

      {askCancel && <Modal title="Cancel your subscription?" onClose={() => setAskCancel(false)}>
        <p className="mb-3 text-sm">You keep full access until <b>{day(s.current_period_end)}</b>{renewLeft !== null ? ` (${plural(renewLeft, 'more day')})` : ''}. After that the workspace becomes read-only: your data is kept, and you can resubscribe at any time.</p>
        <p className="mb-4 text-sm text-muted">You can change your mind before that date from this page, and nothing is lost.</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setAskCancel(false)}>Keep my plan</button><button className="btn !bg-danger" disabled={!!busy} onClick={async () => { await go('cancel', () => api('/billing/cancel', 'POST'), 'Cancellation scheduled.'); setAskCancel(false); }}>Cancel at period end</button></div></Modal>}
    </Page>
  );
}
