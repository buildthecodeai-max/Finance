import { useEffect, useState } from 'react';
import { Ban, Building2, Check, CheckCircle2, Copy, KeyRound, LogOut, Mail, MonitorSmartphone, Plus, Search, ShieldAlert, ShieldCheck, ShieldOff, UserCog, UserPlus, Users as UsersIcon, X } from 'lucide-react';
import { api } from '../api';
import { Avatar, Err, Field, Modal, Pager, Skeleton } from '../components/ui';

/* People in the platform console: the directory of every account, and the operators who run the console. Both are driven by the capabilities of the signed-in operator. */

type Me = { email: string; role: string; caps: string[] };
export const rel = (d: any) => {
  if (!d) return 'Never';
  const s = Math.max(0, (Date.now() - new Date(String(d).replace(' ', 'T') + (String(d).endsWith('Z') || /[+-]\d\d:?\d\d$/.test(String(d)) ? '' : 'Z')).getTime()) / 1000);
  return s < 90 ? 'Just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : s < 86400 * 30 ? `${Math.round(s / 86400)} d ago` : String(d).slice(0, 10);
};
const AGENCY_ROLE: Record<string, string> = { admin: 'Owner', finance_manager: 'Finance', agent: 'Agent', viewer: 'Viewer' };

/* ---------------------------------------------------------------------------- roles */
export const OPERATOR_ROLES: { key: string; name: string; blurb: string; tone: string; caps: string[] }[] = [
  { key: 'admin', name: 'Admin', blurb: 'Everything, including suspensions, people and operators.', tone: 'accent', caps: ['read', 'support', 'billing', 'suspend'] },
  { key: 'billing', name: 'Billing', blurb: 'Trials, plans, invoiced access and AI access.', tone: 'success', caps: ['read', 'billing'] },
  { key: 'support', name: 'Support', blurb: 'Look into customers and open read-only sessions.', tone: 'info', caps: ['read', 'support'] },
  { key: 'readonly', name: 'Read-only', blurb: 'Look at the console. Change nothing.', tone: 'muted', caps: ['read'] },
];
const CAP_ROWS: [string, string][] = [
  ['read', 'See agencies, plans, audit and system health'], ['support', 'Browse every user, open support sessions and customer workspaces'],
  ['billing', 'Change plans, trials, invoiced access and AI access'], ['suspend', 'Suspend agencies, manage operators, reset or switch off accounts'],
];
/** The roles inside a customer agency (what an agency's own admin hands out on their Team page), and what each can do. 'full' = all records, 'own' = only their own, 'view' = read-only. */
type Level = 'full' | 'own' | 'view' | 'none';
export const AGENCY_ROLES: { key: string; name: string; blurb: string; tone: string }[] = [
  { key: 'admin', name: 'Owner / Admin', blurb: 'Runs the agency: settings, billing, team and everything below.', tone: 'accent' },
  { key: 'finance_manager', name: 'Finance manager', blurb: 'All finance work and reports. No settings or billing.', tone: 'success' },
  { key: 'agent', name: 'Agent', blurb: 'Sells: leads, quotes, bookings and clients. Sees only their own work.', tone: 'info' },
  { key: 'viewer', name: 'Viewer', blurb: 'Read-only, for auditors, trainees and partners.', tone: 'muted' },
];
const AGENCY_MATRIX: [string, [Level, Level, Level, Level]][] = [
  ['Leads, quotes, bookings and clients', ['full', 'full', 'own', 'view']],
  ['Draft invoices', ['full', 'full', 'own', 'none']],
  ['Approve, issue and send invoices', ['full', 'full', 'none', 'none']],
  ['Payments, receipts, supplier bills and bank', ['full', 'full', 'none', 'none']],
  ['Ledger, journals and finance reports', ['full', 'full', 'none', 'none']],
  ['Agency settings, billing and invoice design', ['full', 'none', 'none', 'none']],
  ['Team, branches and the agency audit log', ['full', 'none', 'none', 'none']],
];
const LEVEL: Record<Level, [string, string]> = { full: ['Full', 'text-success'], own: ['Own only', 'text-info'], view: ['View', 'text-muted'], none: ['—', 'text-muted/60'] };
const roleTone = (r: string) => OPERATOR_ROLES.find((x) => x.key === r)?.tone ?? 'muted';
const RolePill = ({ role }: { role: string }) => <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `rgb(var(--${roleTone(role)}) / .14)`, color: `rgb(var(--${roleTone(role)}))` }}><ShieldCheck size={11} />{OPERATOR_ROLES.find((r) => r.key === role)?.name ?? role}</span>;

/* ---------------------------------------------------------------------------- one account action, with the reason every action must carry */
type Act = { kind: 'password' | 'signout' | 'reset2fa' | 'disable' | 'enable'; user: { id: number; name: string; email: string } };
const ACT: Record<Act['kind'], { title: string; path: string; body: (u: string) => string; button: string; danger?: boolean }> = {
  password: { title: 'Send a password link', path: 'password-reset', body: (u) => `${u} gets a one-time link to choose a new password. It expires in 30 minutes, and any earlier link stops working.`, button: 'Send link' },
  signout: { title: 'Sign out everywhere', path: 'sign-out', body: (u) => `Every device where ${u} is signed in is signed out. They can sign in again straight away.`, button: 'Sign out everywhere' },
  reset2fa: { title: 'Reset two-factor sign-in', path: 'reset-2fa', body: (u) => `${u}'s authenticator is removed and they are signed out. Use this when they have lost their phone, after checking who they are. They set up 2FA again after the next sign-in.`, button: 'Reset 2FA', danger: true },
  disable: { title: 'Switch the account off', path: 'disable', body: (u) => `${u} can no longer sign in, and anything they have open stops working. Nothing is deleted, and you can switch the account back on at any time.`, button: 'Switch off', danger: true },
  enable: { title: 'Switch the account back on', path: 'enable', body: (u) => `${u} can sign in again.`, button: 'Switch on' },
};
function ActionDialog({ act, onClose, onDone }: { act: Act; onClose(): void; onDone(msg: string): void }) {
  const a = ACT[act.kind]; const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [link, setLink] = useState(''); const [copied, setCopied] = useState(false);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api(`/platform/users/${act.user.id}/${a.path}`, 'POST', { reason });
      if (act.kind === 'password' && r.link) { setLink(r.link); return; }
      onDone(act.kind === 'password' ? `A reset link was emailed to ${act.user.email}.` : act.kind === 'signout' ? `${act.user.name} was signed out (${r.sessions_ended} session${r.sessions_ended === 1 ? '' : 's'}).` : act.kind === 'reset2fa' ? `2FA was reset for ${act.user.name}.` : act.kind === 'disable' ? `${act.user.name}'s account was switched off.` : `${act.user.name}'s account was switched on.`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  if (link) return <Modal title="Reset link ready" onClose={() => onDone(`A reset link was created for ${act.user.email}.`)}>
    <p className="mb-2 text-sm text-muted">Email isn't set up on this server, so the link wasn't emailed. Give it to {act.user.name} yourself. It works once and expires in 30 minutes.</p>
    <div className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-surface2 p-2"><code className="min-w-0 flex-1 break-all text-xs">{link}</code>
      <button className="btn-ghost shrink-0" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* select it by hand */ } }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy'}</button></div>
    <div className="flex justify-end"><button className="btn" onClick={() => onDone(`A reset link was created for ${act.user.email}.`)}>Done</button></div></Modal>;
  return <Modal title={`${a.title}: ${act.user.name}`} onClose={onClose}><Err e={err} />
    <p className="mb-3 text-sm">{a.body(act.user.name)}</p>
    <Field label="Reason" hint="Kept in the operator audit log."><input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim().length >= 3 && !busy) go(); }} placeholder="e.g. Lost phone, identity checked by video call" /></Field>
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className={`btn ${a.danger ? '!bg-danger' : ''}`} disabled={busy || reason.trim().length < 3} onClick={go}>{busy ? 'Working…' : a.button}</button></div></Modal>;
}

/* ---------------------------------------------------------------------------- the person window */
function UserWindow({ id, me, onClose, onOpenAgency, onChanged }: { id: number; me: Me; onClose(): void; onOpenAgency(id: number): void; onChanged(msg: string): void }) {
  const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [act, setAct] = useState<Act | null>(null); const canAct = me.caps.includes('suspend');
  const load = () => api(`/platform/users/${id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (!d) return <Modal title="Person" wide onClose={onClose}>{err ? <Err e={err} /> : <Skeleton className="h-56" />}</Modal>;
  const u = d.user, self = u.email === me.email, off = !!u.disabled_at; const target = { id: u.id, name: u.name, email: u.email };
  const Btn = ({ kind, icon: I, label, danger }: { kind: Act['kind']; icon: any; label: string; danger?: boolean }) => <button className={`btn-ghost w-full !justify-start ${danger ? 'text-danger' : ''}`} onClick={() => setAct({ kind, user: target })}><I size={15} />{label}</button>;
  return (
    <Modal title="Person" wide onClose={onClose}>
      <div className="mb-4 flex flex-wrap items-center gap-4"><Avatar name={u.name} size={56} />
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-xl font-semibold">{u.name}</h3>{self && <span className="text-xs text-muted">(you)</span>}
          {!!u.is_platform_admin && <RolePill role={u.platform_role} />}
          {off ? <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-medium text-danger"><Ban size={11} />Switched off</span> : <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"><CheckCircle2 size={11} />Active</span>}</div>
          <div className="text-sm text-muted">{u.email}</div></div></div>
      {off && <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">Switched off on {String(u.disabled_at).slice(0, 10)}{u.disabled_reason ? `: ${u.disabled_reason}` : '.'}</div>}
      <Err e={err} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[['Agencies', String(d.memberships.length), Building2], ['Last signed in', rel(d.last_seen), MonitorSmartphone], ['Live sessions', String(d.live_sessions), UsersIcon], ['Two-factor', u.totp_enabled ? 'On' : 'Off', u.totp_enabled ? ShieldCheck : ShieldOff]].map(([l, v, I]: any) =>
          <div key={l} className="card !p-3"><div className="flex items-center justify-between text-xs text-muted">{l}<I size={14} /></div><div className={`mt-1 text-lg font-semibold ${l === 'Two-factor' && !u.totp_enabled ? 'text-warn' : ''}`}>{v}</div></div>)}</div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="card !p-0 overflow-hidden"><div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Works at</div>
            {!d.memberships.length && <div className="px-4 py-6 text-center text-sm text-muted">Not a member of any agency.</div>}
            {d.memberships.map((m: any) => <div key={m.agency_id} className="flex items-center gap-3 border-b border-line/70 px-4 py-2.5 last:border-0"><Avatar name={m.agency_name} size={30} />
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{m.agency_name}</div><div className="text-xs text-muted">#{m.agency_id}</div></div>
              <span className="rounded-full bg-surface2 px-2 py-0.5 text-[11px] font-medium">{AGENCY_ROLE[m.role] ?? m.role}</span>
              <button className="btn-ghost !h-8 !px-2.5 text-xs" onClick={() => { onClose(); onOpenAgency(m.agency_id); }}>Open</button></div>)}</div>
          <div className="card !p-0 overflow-hidden"><div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Recent security events</div>
            {!d.events.length && <div className="px-4 py-6 text-center text-sm text-muted">Nothing recorded for this person.</div>}
            {d.events.map((e: any, i: number) => <div key={i} className="flex items-baseline gap-3 border-b border-line/70 px-4 py-2 text-sm last:border-0"><span className="num w-28 shrink-0 text-xs text-muted">{String(e.created_at).slice(0, 16).replace('T', ' ')}</span><span className="capitalize">{String(e.event).replace(/_/g, ' ')}</span>{e.detail && <span className="truncate text-xs text-muted">{e.detail}</span>}</div>)}</div>
        </div>
        <div className="space-y-2">
          <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Account actions</div>
          {canAct && !self ? <>
            <Btn kind="password" icon={Mail} label="Send password link" />
            <Btn kind="signout" icon={LogOut} label={`Sign out everywhere${d.live_sessions ? ` (${d.live_sessions})` : ''}`} />
            {u.totp_enabled ? <Btn kind="reset2fa" icon={KeyRound} label="Reset 2FA" danger /> : null}
            {off ? <Btn kind="enable" icon={CheckCircle2} label="Switch account on" /> : <Btn kind="disable" icon={Ban} label="Switch account off" danger />}
            {d.reset_pending && <p className="px-1 text-xs text-muted">A password link is waiting to be used.</p>}
          </> : <p className="px-1 text-xs text-muted">{self ? 'These actions are not available on your own account. Ask another admin operator.' : 'Your role can look at people but not change their accounts.'}</p>}
        </div>
      </div>
      {act && <ActionDialog act={act} onClose={() => setAct(null)} onDone={(msg) => { setAct(null); onChanged(msg); load(); }} />}
    </Modal>
  );
}

/* ---------------------------------------------------------------------------- the directory */
const FILTERS: [string, string][] = [['all', 'Everyone'], ['operators', 'Operators'], ['owners', 'Agency owners'], ['multi', 'Several agencies'], ['no2fa', 'No 2FA'], ['disabled', 'Switched off']];
export function PlatformUsers({ me, onOpenAgency, focus, onFocused }: { me: Me; onOpenAgency(id: number): void; focus?: number | null; onFocused?(): void }) {
  const [res, setRes] = useState<any>(null); const [q, setQ] = useState(''); const [filter, setFilter] = useState('all'); const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  useEffect(() => { if (focus) { setOpen(focus); onFocused?.(); } }, [focus]);
  const load = () => api(`/platform/users?page=${page}&filter=${filter}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`).then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { const h = setTimeout(load, q ? 250 : 0); return () => clearTimeout(h); }, [q, filter, page]);
  useEffect(() => { setPage(1); }, [q, filter]);
  const c = res?.counts;
  const tile = (label: string, value: number | undefined, f: string, Icon: any, tone = 'accent') => (
    <button type="button" aria-pressed={filter === f} onClick={() => setFilter(filter === f ? 'all' : f)} className={`card glow-card text-left ${filter === f ? 'ring-2 ring-accent' : ''}`} style={{ ['--hue' as any]: `var(--${tone})` }}>
      <div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{label}</span><span className="grid h-8 w-8 place-items-center rounded-xl" style={{ background: `rgb(var(--${tone}) / .14)`, color: `rgb(var(--${tone}))` }}><Icon size={16} /></span></div>
      <div className="mt-2 text-3xl font-bold num">{value ?? '—'}</div></button>);
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{tile('All users', c?.users, 'all', UsersIcon)}{tile('Operators', c?.operators, 'operators', ShieldCheck, 'info')}{tile('No 2FA', c?.no2fa, 'no2fa', ShieldAlert, c?.no2fa ? 'warn' : 'success')}{tile('Switched off', c?.disabled, 'disabled', Ban, c?.disabled ? 'danger' : 'success')}</div>
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Filter people">{FILTERS.map(([k, l]) => <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} className={`whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm ${filter === k ? 'border-accent bg-accent/15 font-medium text-accent' : 'border-line hover:bg-surface2'}`}>{l}</button>)}</div>
      <div className="relative w-full sm:w-80"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input className="input pl-8" aria-label="Search people" placeholder="Name, email or agency…" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
    {msg && <div role="status" className="flex justify-between gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"><span>{msg}</span><button aria-label="Dismiss" onClick={() => setMsg('')}><X size={14} /></button></div>}
    <Err e={err} />
    {!res ? <Skeleton className="h-72" /> : <div className="card !p-0 overflow-hidden">
      <div className="overflow-x-auto"><table className="w-full border-separate border-spacing-0"><thead><tr><th>Person</th><th>Works at</th><th>Access</th><th>2FA</th><th>Last signed in</th></tr></thead>
        <tbody>{res.rows.map((r: any) => <tr key={r.id} tabIndex={0} className="cursor-pointer hover:bg-surface2/70 focus-visible:bg-surface2/70" onClick={() => setOpen(r.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(r.id)}>
          <td><div className="flex min-w-0 items-center gap-3"><Avatar name={r.name} size={34} /><div className="min-w-0"><div className="truncate font-medium">{r.name}{r.email === me.email && <span className="ml-1.5 text-xs font-normal text-muted">(you)</span>}</div><div className="truncate text-xs text-muted">{r.email}</div></div></div></td>
          <td><div className="flex max-w-xs flex-wrap gap-1">{r.memberships.slice(0, 2).map((m: any) => <span key={m.agency_id} className="max-w-[10rem] truncate rounded-full bg-surface2 px-2 py-0.5 text-[11px]" title={`${m.agency_name} · ${AGENCY_ROLE[m.role] ?? m.role}`}>{m.agency_name} <span className="text-muted">· {AGENCY_ROLE[m.role] ?? m.role}</span></span>)}{r.memberships.length > 2 && <span className="rounded-full bg-surface2 px-2 py-0.5 text-[11px] text-muted">+{r.memberships.length - 2}</span>}{!r.memberships.length && <span className="text-xs text-muted">None</span>}</div></td>
          <td><div className="flex flex-wrap items-center gap-1.5">{r.disabled_at ? <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-medium text-danger"><Ban size={11} />Switched off</span> : <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"><CheckCircle2 size={11} />Active</span>}{!!r.is_platform_admin && <RolePill role={r.platform_role} />}</div></td>
          <td>{r.totp_enabled ? <span className="inline-flex items-center gap-1 text-xs text-success"><ShieldCheck size={13} />On</span> : <span className="inline-flex items-center gap-1 text-xs text-warn"><ShieldOff size={13} />Off</span>}</td>
          <td className="whitespace-nowrap text-xs text-muted">{rel(r.last_seen)}</td></tr>)}
        </tbody></table>
        {!res.rows.length && <div className="px-4 py-12 text-center text-sm text-muted">No one matches{q ? ` “${q}”` : ' this filter'}.</div>}</div>
      {res.total > res.page_size && <Pager total={res.total} page={page - 1} size={res.page_size} onPage={(p) => setPage(p + 1)} noun="people" />}
    </div>}
    {open && <UserWindow id={open} me={me} onClose={() => setOpen(null)} onOpenAgency={onOpenAgency} onChanged={(m) => { setMsg(m); load(); }} />}
  </div>;
}

/* ---------------------------------------------------------------------------- operators */
export function PlatformOperators({ me }: { me: Me }) {
  const [rows, setRows] = useState<any[] | null>(null); const [dlg, setDlg] = useState<any>(null); const [act, setAct] = useState<Act | null>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => api('/platform/operators').then(setRows).catch((e) => setErr(e.message)); useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<any>, ok: string) => { setBusy(true); try { await fn(); setDlg(null); setErr(''); setMsg(ok); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const [roleCounts, setRoleCounts] = useState<any[] | null>(null); useEffect(() => { api('/platform/agency-roles').then(setRoleCounts).catch(() => setRoleCounts(null)); }, []);
  const all = rows ?? []; const no2fa = all.filter((r) => !r.totp_enabled && !r.disabled_at);
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><p className="max-w-2xl text-sm text-muted">Give each person the lowest role that lets them do their job. Everything an operator does is written to the audit log with their name and a reason.</p>
      <button className="btn" onClick={() => { setErr(''); setDlg({ kind: 'add', email: '', role: 'support', reason: '' }); }}><UserPlus size={16} />Add operator</button></div>
    {msg && <div role="status" className="flex justify-between gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"><span>{msg}</span><button aria-label="Dismiss" onClick={() => setMsg('')}><X size={14} /></button></div>}
    {no2fa.length > 0 && <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5 text-sm text-warn"><ShieldAlert size={16} className="mt-0.5 shrink-0" /><span><b>{no2fa.map((r) => r.name).join(', ')}</b> {no2fa.length === 1 ? 'has' : 'have'} no two-factor sign-in, so the console stays closed to {no2fa.length === 1 ? 'them' : 'them'} until it is turned on.</span></div>}

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{OPERATOR_ROLES.map((r) => { const n = all.filter((o) => o.role === r.key && !o.disabled_at).length; return (
      <div key={r.key} className="card glow-card" style={{ ['--hue' as any]: `var(--${r.tone === 'muted' ? 'muted' : r.tone})` }}>
        <div className="flex items-center justify-between"><RolePill role={r.key} /><span className="text-2xl font-bold num">{n}</span></div>
        <p className="mt-2 text-xs leading-relaxed text-muted">{r.blurb}</p></div>); })}</div>

    <div className="card !p-0 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3"><UserCog size={16} className="text-muted" /><span className="text-sm font-semibold">Operators</span><span className="rounded-full bg-surface2 px-2 py-0.5 text-xs text-muted">{all.length}</span></div>
      {!rows ? <Skeleton className="m-4 h-40" /> : <div className="overflow-x-auto"><table className="w-full border-separate border-spacing-0"><thead><tr><th>Operator</th><th>Role</th><th>2FA</th><th>Last signed in</th><th className="text-right">Actions (30 d)</th><th /></tr></thead>
        <tbody>{all.map((r) => { const self = r.email === me.email; return <tr key={r.id} className={r.disabled_at ? 'opacity-60' : ''}>
          <td><div className="flex items-center gap-3"><Avatar name={r.name} size={34} /><div className="min-w-0"><div className="truncate font-medium">{r.name}{self && <span className="ml-1.5 text-xs font-normal text-muted">(you)</span>}{r.disabled_at && <span className="ml-1.5 rounded-full bg-danger/15 px-1.5 py-0.5 text-[10px] font-medium text-danger">switched off</span>}</div><div className="truncate text-xs text-muted">{r.email}</div></div></div></td>
          <td><RolePill role={r.role} /></td>
          <td>{r.totp_enabled ? <span className="inline-flex items-center gap-1 text-xs text-success"><ShieldCheck size={13} />On</span> : <span className="inline-flex items-center gap-1 text-xs text-warn"><ShieldOff size={13} />Off</span>}</td>
          <td className="whitespace-nowrap text-xs text-muted">{rel(r.last_seen)}</td>
          <td className="text-right num">{r.actions_30d}</td>
          <td>{self ? null : <div className="flex flex-nowrap items-center justify-end gap-1 whitespace-nowrap">
            <button className="btn-ghost !h-8 !px-2.5 text-xs" onClick={() => { setErr(''); setDlg({ kind: 'edit', r, role: r.role, reason: '' }); }}>Change role</button>
            {r.totp_enabled ? <button className="btn-icon !h-8 !w-8 border border-line" aria-label={`Reset 2FA for ${r.name}`} title="Reset 2FA: remove their authenticator and sign them out" onClick={() => setAct({ kind: 'reset2fa', user: r })}><KeyRound size={14} /></button> : null}
            <button className="btn-icon !h-8 !w-8 border border-line" aria-label={`Sign ${r.name} out everywhere`} title="Sign out everywhere" onClick={() => setAct({ kind: 'signout', user: r })}><LogOut size={14} /></button>
            <button className={`btn-icon !h-8 !w-8 border border-line ${r.disabled_at ? '' : 'text-danger'}`} aria-label={r.disabled_at ? `Switch ${r.name} on` : `Switch ${r.name} off`} title={r.disabled_at ? 'Switch account on' : 'Switch account off'} onClick={() => setAct({ kind: r.disabled_at ? 'enable' : 'disable', user: r })}>{r.disabled_at ? <CheckCircle2 size={14} /> : <Ban size={14} />}</button>
            <button className="btn-icon !h-8 !w-8 border border-line text-danger" aria-label={`Remove ${r.name} as operator`} title="Remove operator access" onClick={() => { setErr(''); setDlg({ kind: 'revoke', r, reason: '' }); }}><X size={14} /></button></div>}</td></tr>; })}</tbody></table></div>}
    </div>

    <div className="card !p-0 overflow-hidden"><div className="border-b border-line px-4 py-3 text-sm font-semibold">What each role can do</div>
      <div className="overflow-x-auto"><table className="w-full border-separate border-spacing-0"><thead><tr><th>Capability</th>{OPERATOR_ROLES.map((r) => <th key={r.key} className="text-center">{r.name}</th>)}</tr></thead>
        <tbody>{CAP_ROWS.map(([cap, label]) => <tr key={cap}><td className="text-sm">{label}</td>{OPERATOR_ROLES.map((r) => <td key={r.key} className="text-center">{r.caps.includes(cap) ? <Check size={16} className="mx-auto text-success" aria-label="Allowed" /> : <span className="text-muted" aria-label="Not allowed">—</span>}</td>)}</tr>)}</tbody></table></div></div>

    <div className="pt-2"><h3 className="text-lg font-semibold">Agency roles</h3>
      <p className="mt-0.5 max-w-3xl text-sm text-muted">These are the roles inside every customer agency, chosen by that agency's own admin. They never grant access to this console. Open a person under People to see where they work.</p></div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{AGENCY_ROLES.map((r) => { const c = roleCounts?.find((x: any) => x.role === r.key); return (
      <div key={r.key} className="card glow-card" style={{ ['--hue' as any]: `var(--${r.tone})` }}>
        <div className="flex items-center justify-between"><span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `rgb(var(--${r.tone}) / .14)`, color: `rgb(var(--${r.tone}))` }}><Building2 size={11} />{r.name}</span><span className="text-2xl font-bold num">{c?.people ?? '—'}</span></div>
        <p className="mt-2 text-xs leading-relaxed text-muted">{r.blurb}</p><p className="mt-2 text-[11px] text-muted">{c ? `across ${c.agencies} agenc${c.agencies === 1 ? 'y' : 'ies'}` : ' '}</p></div>); })}</div>
    <div className="card !p-0 overflow-hidden"><div className="border-b border-line px-4 py-3 text-sm font-semibold">What each agency role can do</div>
      <div className="overflow-x-auto"><table className="w-full border-separate border-spacing-0"><thead><tr><th>Area</th>{AGENCY_ROLES.map((r) => <th key={r.key} className="text-center">{r.name}</th>)}</tr></thead>
        <tbody>{AGENCY_MATRIX.map(([label, lv]) => <tr key={label}><td className="text-sm">{label}</td>{lv.map((l, i) => <td key={i} className={`text-center text-xs font-medium ${LEVEL[l][1]}`}>{l === 'full' ? <Check size={16} className="mx-auto" aria-label="Full access" /> : LEVEL[l][0]}</td>)}</tr>)}</tbody></table></div></div>

    {dlg && <Modal title={dlg.kind === 'add' ? 'Add operator' : dlg.kind === 'edit' ? `Change role: ${dlg.r.name}` : `Remove ${dlg.r.name}`} onClose={() => setDlg(null)}><Err e={err} />
      {dlg.kind === 'add' && <Field label="Email of an existing account" hint="They must also turn on 2FA before the console opens for them."><input className="input" type="email" autoFocus value={dlg.email} onChange={(e) => setDlg({ ...dlg, email: e.target.value })} /></Field>}
      {dlg.kind === 'revoke' ? <p className="mb-3 text-sm">{dlg.r.email} will no longer be able to open the platform console. Their account is not deleted.</p>
        : <Field label="Role"><div className="space-y-1.5">{OPERATOR_ROLES.map((r) => <label key={r.key} className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-sm ${dlg.role === r.key ? 'border-accent bg-accent/10' : 'border-line'}`}><input type="radio" className="mt-1" name="oprole" checked={dlg.role === r.key} onChange={() => setDlg({ ...dlg, role: r.key })} /><span><b>{r.name}</b><span className="block text-xs text-muted">{r.blurb}</span></span></label>)}</div></Field>}
      <Field label="Reason" hint="Kept in the operator audit log."><input className="input" value={dlg.reason} onChange={(e) => setDlg({ ...dlg, reason: e.target.value })} /></Field>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setDlg(null)}>Cancel</button>
        {dlg.kind === 'add' && <button className="btn" disabled={busy || !dlg.email.includes('@')} onClick={() => run(() => api('/platform/operators', 'POST', { email: dlg.email.trim(), role: dlg.role, reason: dlg.reason }), `${dlg.email} is now an operator.`)}><Plus size={15} />Add operator</button>}
        {dlg.kind === 'edit' && <button className="btn" disabled={busy || dlg.role === dlg.r.role} onClick={() => run(() => api(`/platform/operators/${dlg.r.id}`, 'PUT', { role: dlg.role, reason: dlg.reason }), `${dlg.r.name} is now ${dlg.role}.`)}>Save role</button>}
        {dlg.kind === 'revoke' && <button className="btn !bg-danger" disabled={busy} onClick={() => run(() => api(`/platform/operators/${dlg.r.id}`, 'DELETE', { reason: dlg.reason }), `${dlg.r.name} is no longer an operator.`)}>Remove access</button>}</div></Modal>}
    {act && <ActionDialog act={act} onClose={() => setAct(null)} onDone={(m) => { setAct(null); setMsg(m); load(); }} />}
  </div>;
}
