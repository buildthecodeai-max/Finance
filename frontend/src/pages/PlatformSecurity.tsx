import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, Eye, KeyRound, LifeBuoy, Search, Shield, ShieldAlert, ShieldBan, Siren, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import { Avatar, Err, Pager, Skeleton } from '../components/ui';
import { rel } from './PlatformPeople';

/* Security events from every agency in one place: refused access, sensitive record views, support access and account recovery. */

const CATS: { key: string; label: string; hue: string; icon: LucideIcon; blurb: string }[] = [
  { key: 'all', label: 'Everything', hue: 'accent', icon: Shield, blurb: 'Every recorded event' },
  { key: 'blocked', label: 'Blocked', hue: 'danger', icon: ShieldBan, blurb: 'Access that was refused' },
  { key: 'sensitive', label: 'Sensitive views', hue: 'warn', icon: Eye, blurb: 'Passports and similar records opened' },
  { key: 'support', label: 'Support access', hue: 'info', icon: LifeBuoy, blurb: 'Operator sessions into an agency' },
  { key: 'recovery', label: 'Account recovery', hue: 'success', icon: KeyRound, blurb: 'Password reset requests' },
  { key: 'platform', label: 'Platform actions', hue: 'muted', icon: Siren, blurb: 'Suspensions by operators' },
];
const cat = (k: string) => CATS.find((c) => c.key === k) ?? { key: 'other', label: 'Other', hue: 'muted', icon: Shield, blurb: '' };
const EVENT: Record<string, string> = {
  role_denied: 'was refused an action their role does not allow', agency_access_denied: 'tried to open an agency they do not belong to', foreign_reference_denied: 'referred to a record from another agency',
  sensitive_view: 'opened a sensitive record', support_access_granted: 'Operator support session opened', support_access_revoked: 'ended an operator support session',
  password_reset_requested: 'asked to reset their password', password_reset_completed: 'chose a new password', platform_suspended: 'Agency suspended by the platform',
};
const eventText = (e: string) => EVENT[e] ?? e.replace(/_/g, ' ');
const SEV: Record<string, { label: string; hue: string }> = { high: { label: 'High', hue: 'danger' }, medium: { label: 'Medium', hue: 'warn' }, info: { label: 'Info', hue: 'muted' } };
const dayKey = (d: any) => String(d).replace(' ', 'T').slice(0, 10);
const dayLabel = (k: string) => { const t = new Date(); const iso = (x: Date) => new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10); const y = new Date(t.getTime() - 864e5);
  return k === iso(t) ? 'Today' : k === iso(y) ? 'Yesterday' : new Date(`${k}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); };
const clock = (d: any) => new Date(String(d).includes('T') ? d : `${String(d).replace(' ', 'T')}Z`).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Events per day for two weeks. Red is the part that was blocked. */
function Trend({ days }: { days: { day: string; total: number; blocked: number }[] }) {
  const map = new Map(days.map((d) => [d.day, d])); const out: { day: string; total: number; blocked: number }[] = [];
  for (let i = 13; i >= 0; i--) { const t = new Date(Date.now() - i * 864e5); const k = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10); out.push(map.get(k) ?? { day: k, total: 0, blocked: 0 }); }
  const max = Math.max(1, ...out.map((d) => d.total)); const sum = out.reduce((s, d) => s + d.total, 0), blocked = out.reduce((s, d) => s + d.blocked, 0);
  return (
    <div className="card h-full">
      <div className="flex items-start justify-between gap-2"><div><div className="text-sm font-semibold">Last 14 days</div><div className="text-xs text-muted">{sum.toLocaleString()} events · <span className={blocked ? 'font-medium text-danger' : ''}>{blocked} blocked</span></div></div>
        <div className="flex gap-3 text-[10px] text-muted"><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-accent/60" />Other</span><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-danger" />Blocked</span></div></div>
      <div className="mt-4 flex h-28 items-end gap-1.5" role="img" aria-label={`Security events per day for the last 14 days: ${sum} in total, ${blocked} blocked`}>
        {out.map((d) => <div key={d.day} className="group relative flex h-full flex-1 flex-col justify-end" title={`${d.day}: ${d.total} event${d.total === 1 ? '' : 's'}, ${d.blocked} blocked`}>
          <div className="w-full rounded-t-sm bg-danger" style={{ height: `${(d.blocked / max) * 100}%` }} /><div className={`w-full bg-accent/60 ${d.blocked ? '' : 'rounded-t-sm'}`} style={{ height: `${((d.total - d.blocked) / max) * 100}%`, minHeight: d.total ? 0 : 2, opacity: d.total ? 1 : 0.25 }} /></div>)}</div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted num"><span>{out[0].day.slice(5)}</span><span>{out[13].day.slice(5)}</span></div>
    </div>
  );
}

export function PlatformSecurity({ onOpenUser }: { onOpenUser?(id: number): void }) {
  const [res, setRes] = useState<any>(null); const [err, setErr] = useState(''); const [q, setQ] = useState(''); const [category, setCategory] = useState('all'); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [page, setPage] = useState(1); const [busy, setBusy] = useState(false);
  const qs = (extra = '') => `category=${category}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}${extra}`;
  const load = () => api(`/platform/security-events?${qs(`&page=${page}`)}`).then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { const h = setTimeout(load, q ? 250 : 0); return () => clearTimeout(h); }, [q, category, from, to, page]);
  useEffect(() => { setPage(1); }, [q, category, from, to]);
  const groups = useMemo(() => { const m = new Map<string, any[]>(); for (const r of res?.rows ?? []) { const k = dayKey(r.created_at); m.set(k, [...(m.get(k) ?? []), r]); } return [...m.entries()]; }, [res]);
  const filtered = !!(q.trim() || from || to || category !== 'all'); const highs = res?.rows?.filter((r: any) => r.severity === 'high').length ?? 0;
  const exportCsv = async () => {
    setBusy(true);
    try {
      const all = await api(`/platform/security-events?${qs('&size=1000&page=1')}`); const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [['When', 'Severity', 'Category', 'Event', 'Person', 'Email', 'Agency', 'Detail', 'IP'].join(',')].concat(all.rows.map((r: any) => [String(r.created_at).replace('T', ' ').slice(0, 19), r.severity, cat(r.category).label, r.event, r.user_name ?? '', r.user_email ?? '', r.agency_name ?? '', r.detail, r.ip].map(esc).join(',')));
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = `security-events-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{CATS.map((c) => { const Icon = c.icon; const n = res?.summary?.[c.key]; const on = category === c.key; return (
      <button key={c.key} type="button" aria-pressed={on} onClick={() => setCategory(on && c.key !== 'all' ? 'all' : c.key)} className={`card glow-card text-left ${on ? 'ring-2 ring-accent' : ''}`} style={{ ['--hue' as any]: `var(--${c.hue})` }}>
        <div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{c.label}</span><span className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: `rgb(var(--${c.hue}) / .14)`, color: `rgb(var(--${c.hue}))` }}><Icon size={14} /></span></div>
        <div className={`mt-1.5 text-2xl font-bold num ${c.key === 'blocked' && n ? 'text-danger' : ''}`}>{n ?? '—'}</div><div className="mt-0.5 truncate text-[11px] text-muted" title={c.blurb}>{c.blurb}</div></button>); })}</div>

    <div className="grid gap-4 lg:grid-cols-5">
      <div className="lg:col-span-3">{res ? <Trend days={res.trend} /> : <Skeleton className="h-52" />}</div>
      <div className="card lg:col-span-2"><div className="flex items-center gap-2 text-sm font-semibold"><ShieldAlert size={15} className="text-danger" />Needs a look</div><p className="mb-2 text-xs text-muted">People refused most often{filtered ? ' in this view' : ''}.</p>
        {!res ? <Skeleton className="h-28" /> : !res.attention.length ? <div className="py-6 text-center text-sm text-muted">Nobody has been refused. All quiet.</div>
          : <ul className="divide-y divide-line/70">{res.attention.map((h: any) => <li key={`${h.id}-${h.agency_name}`} className="flex items-center gap-3 py-2"><Avatar name={h.name ?? h.email} size={30} />
            <div className="min-w-0 flex-1"><button className="truncate text-left text-sm font-medium hover:underline" onClick={() => onOpenUser?.(h.id)} disabled={!onOpenUser}>{h.name}</button><div className="truncate text-xs text-muted">{h.agency_name ?? 'No agency'} · {rel(h.last_at)}</div></div>
            <span className="rounded-full bg-danger/15 px-2 py-0.5 text-xs font-semibold text-danger num">{h.n}</span></li>)}</ul>}</div></div>

    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[14rem] flex-1 sm:max-w-sm"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input className="input pl-8" aria-label="Search security events" placeholder="Search person, agency, IP or detail…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <label className="flex items-center gap-1.5 text-xs text-muted">From<input className="input !w-auto num" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="flex items-center gap-1.5 text-xs text-muted">To<input className="input !w-auto num" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
      {filtered && <button className="btn-ghost" onClick={() => { setQ(''); setCategory('all'); setFrom(''); setTo(''); }}>Clear</button>}
      <button className="btn-ghost ml-auto" disabled={busy || !res?.total} onClick={exportCsv}><Download size={15} />{busy ? 'Preparing…' : 'Export CSV'}</button></div>
    <Err e={err} />
    {highs > 0 && <div role="status" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span><b>{highs}</b> event{highs === 1 ? '' : 's'} on this page {highs === 1 ? 'is' : 'are'} high severity: someone tried to reach another agency's data. It was refused, but worth checking who and why.</span></div>}

    {!res ? <Skeleton className="h-96" /> : <div className="card !p-0 overflow-hidden">
      {!groups.length && <div className="px-4 py-14 text-center"><Shield size={26} className="mx-auto mb-2 text-muted" /><div className="text-sm font-medium">{filtered ? 'No events match these filters' : 'No security events yet'}</div></div>}
      {groups.map(([k, rows]) => <section key={k} aria-label={dayLabel(k)}>
        <h3 className="sticky top-0 z-[1] border-b border-line bg-surface2/90 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted backdrop-blur">{dayLabel(k)} <span className="ml-1 font-normal normal-case">· {rows.length}</span></h3>
        <ul className="divide-y divide-line/70">{rows.map((r) => { const c = cat(r.category); const Icon = c.icon; const sev = SEV[r.severity] ?? SEV.info; const who = r.user_name || r.user_email; const operatorLed = ['support_access_granted', 'platform_suspended'].includes(r.event); return (
          <li key={r.id} className="flex gap-3 px-4 py-3">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl" style={{ background: `rgb(var(--${c.hue}) / .14)`, color: `rgb(var(--${c.hue}))` }} title={c.label}><Icon size={15} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-sm leading-snug">{operatorLed ? <span className="font-medium">{eventText(r.event)}</span> : <><b>{who ?? 'Someone'}</b> <span className="text-muted">{eventText(r.event)}</span></>}{r.agency_name && <span className="text-muted"> · <b className="font-medium text-fg">{r.agency_name}</b></span>}</div>
              {r.detail && <div className="mt-0.5 break-words font-mono text-[11px] text-muted">{r.detail}</div>}
              {r.user_email && who !== r.user_email && <div className="text-[11px] text-muted">{r.user_email}</div>}</div>
            <div className="flex shrink-0 flex-col items-end gap-1"><span className="text-xs text-muted num">{clock(r.created_at)}</span>
              <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: `rgb(var(--${sev.hue}) / .14)`, color: `rgb(var(--${sev.hue}))` }}>{sev.label}</span>
              {r.ip && <span className="text-[10px] text-muted num">{r.ip}</span>}</div></li>); })}</ul></section>)}
      {res.total > res.page_size && <Pager total={res.total} page={page - 1} size={res.page_size} onPage={(p) => setPage(p + 1)} noun="events" />}
    </div>}
  </div>;
}
