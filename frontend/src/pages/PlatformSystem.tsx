import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Brain, CheckCircle2, Clock, CreditCard, Database, FileBox, Gauge, HardDrive, Mail, MemoryStick, RefreshCw, Server, Timer, Webhook, XCircle, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import { Err, Skeleton } from '../components/ui';

/* The System page: is the platform healthy right now, what is it connected to, and what is it doing. Everything is a yes/no or a number; no secret ever reaches the browser. */

type State = 'ok' | 'warn' | 'bad' | 'off';
const TONE: Record<State, string> = { ok: 'success', warn: 'warn', bad: 'danger', off: 'muted' };
const WORD: Record<State, string> = { ok: 'Healthy', warn: 'Attention', bad: 'Down', off: 'Not set up' };
const human = (s: number) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m} min` : `${s}s`; };
const ago = (min: number) => (min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`);
const JOB_NAME: Record<string, [string, string]> = { daily_job: ['Daily job', 'Reminders, overdue checks, reports and clean-up. Runs once a day.'], webhook_loop: ['Webhook delivery', 'Sends events to customers’ systems. Runs every minute or so.'] };

function Dot({ state }: { state: State }) { return <span className="relative flex h-2.5 w-2.5 shrink-0"><span className={`absolute inline-flex h-full w-full rounded-full opacity-60 ${state === 'ok' ? 'animate-ping' : ''}`} style={{ background: `rgb(var(--${TONE[state]}))` }} /><span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: `rgb(var(--${TONE[state]}))` }} /></span>; }

function Tile({ icon: Icon, name, state, headline, detail }: { icon: LucideIcon; name: string; state: State; headline: string; detail: string }) {
  const hue = TONE[state];
  return (
    <div className="card glow-card" style={{ ['--hue' as any]: `var(--${hue})` }}>
      <div className="flex items-start justify-between gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}><Icon size={17} /></span>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium" style={{ color: `rgb(var(--${hue}))` }}><Dot state={state} />{WORD[state]}</span></div>
      <div className="mt-3 text-sm font-semibold">{name}</div><div className="mt-0.5 text-lg font-bold num leading-tight">{headline}</div><div className="mt-1 text-xs text-muted">{detail}</div>
    </div>);
}

export function PlatformSystem() {
  const [s, setS] = useState<any>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [at, setAt] = useState(0); const [tick, setTick] = useState(0);
  const load = async () => { setBusy(true); try { setS(await api('/platform/system')); setAt(Date.now()); setErr(''); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  useEffect(() => { load(); const h = setInterval(load, 30_000); return () => clearInterval(h); }, []);
  useEffect(() => { const h = setInterval(() => setTick((t) => t + 1), 5_000); return () => clearInterval(h); }, []);
  if (!s) return err ? <Err e={err} /> : <div className="space-y-4"><Skeleton className="h-36" /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36" />)}</div></div>;

  const h = s.health, reported = Object.entries(h.checks.jobs ?? {}) as [string, any][], missing = Object.keys(JOB_NAME).filter((n) => !reported.some(([k]) => k === n)), jobs = [...reported, ...missing.map((n) => [n, { status: 'never', age_minutes: 0 }] as [string, any])], stale = jobs.filter(([, j]) => j.status !== 'ok'), prod = s.process.env === 'production', i = s.integrations;
  const dbOk = h.checks.database === 'ok', t = s.traffic, q = s.queues;
  const tiles: { icon: LucideIcon; name: string; state: State; headline: string; detail: string }[] = [
    { icon: Database, name: 'Database', state: !dbOk ? 'bad' : s.database.latency_ms > 500 ? 'warn' : 'ok', headline: dbOk ? `${s.database.latency_ms} ms` : 'Unreachable', detail: dbOk ? `${s.database.size_mb} MB · ${s.database.agencies} agencies · ${s.database.users} users` : String(h.checks.database) },
    { icon: Timer, name: 'Background jobs', state: stale.some(([, j]) => j.status === 'stale') ? 'bad' : stale.length ? 'warn' : 'ok', headline: `${jobs.length - stale.length} of ${jobs.length} on time`, detail: stale.length ? `${stale.map(([n, j]) => `${JOB_NAME[n]?.[0] ?? n}${j.status === 'never' ? ' has not run yet' : ' is overdue'}`).join(' · ')}` : 'Every job reported on schedule' },
    { icon: Webhook, name: 'Webhook delivery', state: q.webhook_dead ? 'bad' : q.webhook_backlog > 50 ? 'warn' : 'ok', headline: `${q.webhook_backlog} waiting`, detail: q.webhook_dead ? `${q.webhook_dead} could not be delivered and were given up on` : 'Nothing has failed permanently' },
    { icon: Mail, name: 'Email', state: !i.email ? (prod ? 'bad' : 'off') : q.failed_emails_24h > 5 ? 'warn' : 'ok', headline: i.email ? `${q.failed_emails_24h} failed today` : 'Not set up', detail: i.email ? 'SendGrid is connected' : 'No emails are sent. Add a SendGrid key to turn them on.' },
    { icon: FileBox, name: 'File storage', state: i.storage ? 'ok' : prod ? 'bad' : 'off', headline: i.storage ? 'Cloud storage' : 'Local disk', detail: i.storage ? 'Invoices and documents are stored off the server' : 'Files stay on this machine. Fine for development, not for production.' },
    { icon: CreditCard, name: 'Card payments', state: !i.payments ? 'off' : i.payments_webhook ? 'ok' : 'warn', headline: i.payments ? 'Stripe connected' : 'Not connected', detail: !i.payments ? 'Customers can’t pay by card yet' : i.payments_webhook ? 'Webhook secret is set' : 'Webhook secret missing: payments won’t be confirmed' },
    { icon: Brain, name: 'AI assistant', state: i.ai ? 'ok' : 'off', headline: i.ai ? 'Available' : 'Not set up', detail: i.ai ? 'Agencies on a plan with AI can use it' : 'No AI key. Add ANTHROPIC_API_KEY to switch it on.' },
    { icon: Gauge, name: 'Exchange rates', state: i.exchange_rates ? 'ok' : 'off', headline: i.exchange_rates ? 'Live rates' : 'Manual rates', detail: i.exchange_rates ? 'Rates update automatically' : 'Agencies enter rates by hand' },
  ];
  const issues = tiles.filter((x) => x.state === 'bad' || x.state === 'warn'); const bad = tiles.some((x) => x.state === 'bad'); const overall: State = bad ? 'bad' : issues.length ? 'warn' : 'ok';
  const classes: [string, string, string][] = [['2xx', 'Succeeded', 'success'], ['3xx', 'Redirected', 'info'], ['4xx', 'Refused or invalid', 'warn'], ['5xx', 'Failed', 'danger']];
  const lat: [string, string, number][] = [['≤ 50 ms', 'le50', t.latency.le50], ['≤ 200 ms', 'le200', t.latency.le200], ['≤ 1 s', 'le1000', t.latency.le1000], ['≤ 5 s', 'le5000', t.latency.le5000], ['> 5 s', 'inf', t.latency.inf]];
  const latMax = Math.max(1, ...lat.map((x) => x[2])); const memPct = Math.min(100, Math.round((s.process.rss_mb / 1024) * 100));
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000)); void tick;

  return <div className="space-y-5">
    <section className="hero-mesh rounded-2xl border border-line p-5 md:p-6" style={{ ['--hue' as any]: `var(--${TONE[overall]})` }}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4"><span className="grid h-14 w-14 place-items-center rounded-2xl" style={{ background: `rgb(var(--${TONE[overall]}) / .16)`, color: `rgb(var(--${TONE[overall]}))` }}>{overall === 'ok' ? <CheckCircle2 size={28} /> : overall === 'warn' ? <AlertTriangle size={28} /> : <XCircle size={28} />}</span>
          <div><h2 className="text-xl font-bold tracking-tight md:text-2xl">{overall === 'ok' ? 'All systems operational' : overall === 'warn' ? 'Running, with things to check' : 'Something needs fixing now'}</h2>
            <p className="mt-0.5 text-sm text-muted">{issues.length ? issues.map((x) => x.name).join(' · ') + ' need attention.' : 'Database, jobs and connected services are all reporting normally.'}</p></div></div>
        <div className="flex items-center gap-3 text-xs text-muted"><span className="inline-flex items-center gap-1.5"><Clock size={13} />Updated {secs < 5 ? 'just now' : `${secs}s ago`}</span>
          <button className="btn-ghost" onClick={load} disabled={busy}><RefreshCw size={14} className={busy ? 'animate-spin' : ''} />Refresh</button></div></div>
    </section>
    <Err e={err} />

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{tiles.map((x) => <Tile key={x.name} {...x} />)}</div>

    <div className="grid gap-4 lg:grid-cols-3">
      <div className="card lg:col-span-2">
        <div className="flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-semibold"><Activity size={15} className="text-accent" />Traffic since the server started</div><span className="text-xs text-muted">{t.total.toLocaleString()} requests · avg {t.avg_ms} ms</span></div>
        <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-surface2" role="img" aria-label="Share of responses by outcome">{t.total ? classes.map(([k, , hue]) => <div key={k} style={{ width: `${((t.by_class[k] ?? 0) / t.total) * 100}%`, background: `rgb(var(--${hue}))` }} />) : null}</div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">{classes.map(([k, label, hue]) => <div key={k}><div className="flex items-center gap-1.5 text-xs text-muted"><i className="h-2 w-2 rounded-sm" style={{ background: `rgb(var(--${hue}))` }} />{label}</div><div className="text-lg font-bold num">{(t.by_class[k] ?? 0).toLocaleString()}</div></div>)}</div>
        <div className="mt-5 border-t border-line/70 pt-4"><div className="mb-2 flex items-center justify-between text-xs"><span className="font-medium">How fast requests were answered</span><span className={t.error_rate > 1 ? 'font-medium text-danger' : 'text-muted'}>{t.error_rate}% server errors</span></div>
          <div className="space-y-1.5">{lat.map(([label, k, n]) => <div key={k} className="flex items-center gap-3 text-xs"><span className="w-16 shrink-0 text-muted num">{label}</span><div className="h-2 flex-1 overflow-hidden rounded-full bg-surface2"><div className="h-full rounded-full transition-all duration-700" style={{ width: `${(n / latMax) * 100}%`, background: k === 'le50' || k === 'le200' ? 'rgb(var(--success))' : k === 'le1000' ? 'rgb(var(--warn))' : 'rgb(var(--danger))' }} /></div><span className="w-12 shrink-0 text-right num">{n.toLocaleString()}</span></div>)}</div>
          <p className="mt-2 text-[11px] text-muted">Counted in this server process, so the numbers start again after a restart.</p></div>
      </div>

      <div className="space-y-4">
        <div className="card"><div className="flex items-center gap-2 text-sm font-semibold"><Server size={15} className="text-accent" />This server</div>
          <dl className="mt-3 space-y-2 text-sm">{([['Environment', <span key="e" className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${prod ? 'bg-success/15 text-success' : 'bg-warn/15 text-warn'}`}>{s.process.env}</span>], ['Running for', human(s.process.uptime_s)], ['Node', s.process.node], ['Started', new Date(s.process.started_at).toLocaleString()]] as [string, any][]).map(([k, v]) => <div key={k} className="flex items-center justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="num">{v}</dd></div>)}</dl>
          <div className="mt-4"><div className="mb-1 flex items-center justify-between text-xs"><span className="flex items-center gap-1.5 text-muted"><MemoryStick size={13} />Memory</span><span className="num">{s.process.rss_mb} MB</span></div><div className="h-1.5 overflow-hidden rounded-full bg-surface2"><div className="h-full rounded-full" style={{ width: `${Math.max(3, memPct)}%`, background: memPct > 80 ? 'rgb(var(--danger))' : 'rgb(var(--accent))' }} /></div></div></div>
        <div className="card"><div className="flex items-center gap-2 text-sm font-semibold"><HardDrive size={15} className="text-accent" />Database</div>
          <dl className="mt-3 space-y-2 text-sm">{([['Size', `${s.database.size_mb} MB`], ['Migrations applied', s.database.migrations?.applied ?? '—'], ['Latest', <span key="m" className="max-w-[10rem] truncate text-xs" title={s.database.migrations?.latest}>{s.database.migrations?.latest ?? '—'}</span>]] as [string, any][]).map(([k, v]) => <div key={k} className="flex items-center justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="num">{v}</dd></div>)}</dl></div>
      </div>
    </div>

    <div className="card !p-0 overflow-hidden"><div className="border-b border-line px-4 py-3 text-sm font-semibold">Scheduled jobs</div>
      {<ul className="divide-y divide-line/70">{jobs.map(([name, j]) => { const [label, about] = JOB_NAME[name] ?? [name.replace(/_/g, ' '), 'Background task.']; const st: State = j.status === 'ok' ? 'ok' : j.status === 'never' ? 'warn' : 'bad'; return (
          <li key={name} className="flex items-center gap-3 px-4 py-3"><Dot state={st} /><div className="min-w-0 flex-1"><div className="text-sm font-medium capitalize">{label}</div><div className="text-xs text-muted">{about}</div></div>
            <div className="text-right"><div className="text-sm num">{j.status === 'never' ? 'Never' : ago(j.age_minutes)}</div><div className="text-[11px]" style={{ color: `rgb(var(--${TONE[st]}))` }}>{st === 'ok' ? 'On schedule' : st === 'warn' ? 'Not reported yet' : 'Overdue'}</div></div></li>); })}</ul>}</div>
  </div>;
}
