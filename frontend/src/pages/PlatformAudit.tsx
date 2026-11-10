import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Download, Eye, KeyRound, Layers, LogIn, ScrollText, Search, ShieldAlert, UserCog, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import { Err, Pager, Skeleton } from '../components/ui';

/* The operator audit log: an append-only record of everything an operator looked at or changed. This page searches it, groups it by kind, and shows what changed. */

const CATS: { key: string; label: string; hue: string; icon: LucideIcon; blurb: string }[] = [
  { key: 'all', label: 'Everything', hue: 'accent', icon: ScrollText, blurb: 'Every recorded action' },
  { key: 'views', label: 'Looked at', hue: 'muted', icon: Eye, blurb: 'Agencies and people opened' },
  { key: 'access', label: 'Access', hue: 'info', icon: LogIn, blurb: 'Workspaces, support sessions, step-ups' },
  { key: 'billing', label: 'Plans & billing', hue: 'success', icon: Layers, blurb: 'Plans, trials, AI access, agency details' },
  { key: 'people', label: 'People', hue: 'warn', icon: UserCog, blurb: 'Operators and account actions' },
  { key: 'critical', label: 'Critical', hue: 'danger', icon: ShieldAlert, blurb: 'Suspensions and deletions' },
];
const CAT = (k: string) => CATS.find((c) => c.key === k) ?? { key: 'other', label: 'Other', hue: 'muted', icon: KeyRound, blurb: '' };

/** What the person did, as a short sentence fragment. Unknown actions fall back to their own name. */
const VERB: Record<string, string> = {
  view_agency: 'opened', view_user: 'opened the account of', workspace_access: 'entered the workspace of', support_session_start: 'started a support session on', support_session_revoke: 'ended a support session on',
  step_up_ok: 'confirmed a sensitive action with 2FA', step_up_failed: 'failed a 2FA confirmation', permission_denied: 'was denied an action',
  set_plan: 'changed the plan of', extend_trial: 'extended the trial of', grant_manual: 'granted invoiced access to', plan_create: 'created a plan', plan_update: 'edited a plan', set_ai_access: 'changed AI access for', edit_agency: 'edited the details of', agency_create: 'created the agency',
  operator_added: 'added an operator', operator_role_changed: 'changed an operator’s role', operator_revoked: 'removed an operator', operator_granted_cli: 'granted operator access (command line)', operator_role_set_cli: 'set an operator role (command line)', operator_revoked_cli: 'removed an operator (command line)',
  disable_user: 'switched off an account', enable_user: 'switched an account back on', reset_user_2fa: 'reset 2FA for', sign_out_user: 'signed out', send_user_password_reset: 'sent a password link to', agency_user_edit: 'edited a team member of', agency_user_remove: 'removed a team member from',
  suspend: 'suspended', suspend_requested: 'asked to suspend', suspend_approved: 'approved the suspension of', suspend_rejected: 'rejected the suspension of', suspend_cancelled: 'withdrew the suspension of', reactivate: 'released the hold on', delete_agency: 'deleted',
};
const verb = (a: string) => VERB[a] ?? a.replace(/_/g, ' ');

const dayKey = (d: any) => String(d).replace(' ', 'T').slice(0, 10);
const dayLabel = (k: string) => { const t = new Date(); const iso = (x: Date) => new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10); const y = new Date(t.getTime() - 864e5);
  return k === iso(t) ? 'Today' : k === iso(y) ? 'Yesterday' : new Date(`${k}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); };
const clock = (d: any) => new Date(String(d).includes('T') ? d : `${String(d).replace(' ', 'T')}Z`).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const show = (v: any) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
/** Field-by-field changes from the stored before/after snapshots. */
function diff(before: any, after: any): { field: string; from: any; to: any }[] {
  const b = before && typeof before === 'object' ? before : {}, a = after && typeof after === 'object' ? after : {};
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k])).map((k) => ({ field: k, from: b[k], to: a[k] }));
}

function Entry({ r, open, onToggle }: { r: any; open: boolean; onToggle(): void }) {
  const c = CAT(r.category); const Icon = c.icon; const changes = diff(r.before_json, r.after_json); const hasMore = changes.length > 0 || !!r.ip || !!r.user_agent || ((!changes.length) && (r.before_json || r.after_json));
  const subject = r.agency_name ?? (r.agency_id ? `agency #${r.agency_id}` : null);
  return (
    <li className="relative flex gap-3 px-4 py-3">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl" style={{ background: `rgb(var(--${c.hue}) / .14)`, color: `rgb(var(--${c.hue}))` }} title={c.label}><Icon size={15} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-sm leading-snug"><b>{r.admin_name || r.admin_email.split('@')[0]}</b> <span className="text-muted">{verb(r.action)}</span>{subject && <> <b>{subject}</b></>}</div>
        {r.detail && <div className="mt-0.5 break-words text-xs text-muted">{r.detail}</div>}
        {r.reason && <div className="mt-1 inline-block max-w-full rounded-md bg-surface2 px-2 py-1 text-xs italic">“{r.reason}”</div>}
        {open && <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface2/50 p-3 text-xs">
          {changes.length > 0 && <table className="w-full"><thead><tr className="text-left text-[10px] uppercase tracking-wide text-muted"><th className="!bg-transparent !p-0 pb-1">Field</th><th className="!bg-transparent !p-0 pb-1">Before</th><th className="!bg-transparent !p-0 pb-1">After</th></tr></thead>
            <tbody>{changes.map((x) => <tr key={x.field}><td className="!border-0 !p-0 py-0.5 pr-3 font-medium">{x.field.replace(/_/g, ' ')}</td><td className="!border-0 !p-0 py-0.5 pr-3 text-danger line-through decoration-danger/40">{show(x.from)}</td><td className="!border-0 !p-0 py-0.5 font-medium text-success">{show(x.to)}</td></tr>)}</tbody></table>}
          {!changes.length && (r.before_json || r.after_json) && <pre className="whitespace-pre-wrap break-all num">{JSON.stringify({ before: r.before_json, after: r.after_json }, null, 1)}</pre>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted"><span>{r.admin_email}{r.actor_role ? ` · ${r.actor_role}` : ''}</span>{r.ip && <span className="num">IP {r.ip}</span>}{r.user_agent && <span className="max-w-full truncate" title={r.user_agent}>{r.user_agent}</span>}<span className="num">#{r.id}</span></div></div>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1"><span className="text-xs text-muted num">{clock(r.created_at)}</span>
        {r.actor_role && <span className="rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] capitalize text-muted">{r.actor_role}</span>}
        {hasMore && <button className="inline-flex items-center gap-0.5 text-[11px] text-accent hover:underline" aria-expanded={open} onClick={onToggle}>{open ? 'Less' : changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'Details'}<ChevronDown size={12} className={open ? 'rotate-180' : ''} /></button>}</div>
    </li>
  );
}

export function PlatformAudit({ me }: { me: { email: string } }) {
  const [res, setRes] = useState<any>(null); const [err, setErr] = useState(''); const [q, setQ] = useState(''); const [cat, setCat] = useState('all'); const [operator, setOperator] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [page, setPage] = useState(1); const [openId, setOpenId] = useState<number | null>(null); const [busy, setBusy] = useState(false);
  const qs = (extra = '') => `category=${cat}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}${operator ? `&operator=${encodeURIComponent(operator)}` : ''}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}${extra}`;
  const load = () => api(`/platform/audit?${qs(`&page=${page}`)}`).then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { const h = setTimeout(load, q ? 250 : 0); return () => clearTimeout(h); }, [q, cat, operator, from, to, page]);
  useEffect(() => { setPage(1); setOpenId(null); }, [q, cat, operator, from, to]);
  const groups = useMemo(() => { const m = new Map<string, any[]>(); for (const r of res?.rows ?? []) { const k = dayKey(r.created_at); m.set(k, [...(m.get(k) ?? []), r]); } return [...m.entries()]; }, [res]);
  const filtered = !!(q.trim() || operator || from || to || cat !== 'all');
  const exportCsv = async () => {
    setBusy(true);
    try {
      const all = await api(`/platform/audit?${qs('&size=1000&page=1')}`); const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [['When', 'Operator', 'Role', 'Category', 'Action', 'Agency', 'Detail', 'Reason', 'IP'].join(',')].concat(all.rows.map((r: any) => [String(r.created_at).replace('T', ' ').slice(0, 19), r.admin_email, r.actor_role, CAT(r.category).label, r.action, r.agency_name ?? '', r.detail, r.reason, r.ip].map(esc).join(',')));
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = `operator-audit-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{CATS.map((c) => { const Icon = c.icon; const n = res?.summary?.[c.key]; const on = cat === c.key; return (
      <button key={c.key} type="button" aria-pressed={on} onClick={() => setCat(on && c.key !== 'all' ? 'all' : c.key)} className={`card glow-card text-left ${on ? 'ring-2 ring-accent' : ''}`} style={{ ['--hue' as any]: `var(--${c.hue})` }}>
        <div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{c.label}</span><span className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: `rgb(var(--${c.hue}) / .14)`, color: `rgb(var(--${c.hue}))` }}><Icon size={14} /></span></div>
        <div className="mt-1.5 text-2xl font-bold num">{n ?? '—'}</div><div className="mt-0.5 truncate text-[11px] text-muted" title={c.blurb}>{c.blurb}</div></button>); })}</div>

    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[14rem] flex-1 sm:max-w-sm"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input className="input pl-8" aria-label="Search the audit log" placeholder="Search action, agency, person or reason…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <select className="input !w-auto" aria-label="Operator" value={operator} onChange={(e) => setOperator(e.target.value)}><option value="">All operators</option>{res?.operators?.map((o: string) => <option key={o} value={o}>{o === me.email ? `${o} (you)` : o}</option>)}</select>
      <label className="flex items-center gap-1.5 text-xs text-muted">From<input className="input !w-auto num" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="flex items-center gap-1.5 text-xs text-muted">To<input className="input !w-auto num" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
      {filtered && <button className="btn-ghost" onClick={() => { setQ(''); setCat('all'); setOperator(''); setFrom(''); setTo(''); }}>Clear</button>}
      <button className="btn-ghost ml-auto" disabled={busy || !res?.total} onClick={exportCsv}><Download size={15} />{busy ? 'Preparing…' : 'Export CSV'}</button></div>
    <Err e={err} />
    <p className="flex items-center gap-1.5 text-xs text-muted"><AlertTriangle size={12} />This log can only be added to. Nobody, including admin operators, can edit or delete an entry.</p>

    {!res ? <Skeleton className="h-96" /> : <div className="card !p-0 overflow-hidden">
      {!groups.length && <div className="px-4 py-14 text-center"><ScrollText size={26} className="mx-auto mb-2 text-muted" /><div className="text-sm font-medium">{filtered ? 'Nothing matches these filters' : 'No operator actions yet'}</div>{filtered && <p className="mt-1 text-xs text-muted">Try a wider date range or a different category.</p>}</div>}
      {groups.map(([k, rows]) => <section key={k} aria-label={dayLabel(k)}>
        <h3 className="sticky top-0 z-[1] border-b border-line bg-surface2/90 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted backdrop-blur">{dayLabel(k)} <span className="ml-1 font-normal normal-case">· {rows.length}</span></h3>
        <ul className="divide-y divide-line/70">{rows.map((r) => <Entry key={r.id} r={r} open={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} />)}</ul></section>)}
      {res.total > res.page_size && <Pager total={res.total} page={page - 1} size={res.page_size} onPage={(p) => setPage(p + 1)} noun="entries" />}
    </div>}
  </div>;
}
