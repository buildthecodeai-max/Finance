import { useEffect, useState } from 'react';
import { AlertTriangle, Ban, CheckCircle2, Clock, Hourglass, ShieldCheck, Undo2, XCircle } from 'lucide-react';
import { api } from '../api';
import { Avatar, Err, Field, Modal, Skeleton } from '../components/ui';
import { rel } from './PlatformPeople';

/* Suspending an agency needs two admin operators: one asks, a different one approves. This page is where the second operator decides. */

type Me = { email: string };
const parse = (d: any) => new Date(String(d).includes('T') ? d : `${String(d).replace(' ', 'T')}Z`).getTime();
const left = (d: any) => { const ms = parse(d) - Date.now(); if (ms <= 0) return 'Expired'; const m = Math.floor(ms / 60000), h = Math.floor(m / 60); return h >= 1 ? `${h} h ${m % 60} min left` : `${m} min left`; };
const share = (r: any) => Math.max(0, Math.min(1, (parse(r.expires_at) - Date.now()) / Math.max(1, parse(r.expires_at) - parse(r.requested_at))));
const OUTCOME: Record<string, { label: string; hue: string; icon: any }> = {
  approved: { label: 'Approved', hue: 'success', icon: CheckCircle2 }, rejected: { label: 'Rejected', hue: 'danger', icon: XCircle },
  cancelled: { label: 'Withdrawn', hue: 'muted', icon: Undo2 }, expired: { label: 'Expired', hue: 'muted', icon: Clock }, pending: { label: 'Waiting', hue: 'warn', icon: Hourglass },
};

/** Approve or reject, in a proper dialog instead of a browser pop-up. Approving takes effect at once, so it says exactly what will happen. */
function Decide({ r, mode, onClose, onDone }: { r: any; mode: 'approve' | 'reject'; onClose(): void; onDone(msg: string): void }) {
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const approve = mode === 'approve';
  const go = async () => {
    setBusy(true); setErr('');
    try { await api(`/platform/approvals/${r.id}/${mode}`, 'POST', approve ? { note: note.trim() || undefined } : { reason: note.trim() }); onDone(approve ? `${r.agency_name} was suspended. Their workspace is now read-only.` : `The request to suspend ${r.agency_name} was rejected.`); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return <Modal title={approve ? `Approve suspending ${r.agency_name}?` : `Reject the request for ${r.agency_name}?`} onClose={onClose}><Err e={err} />
    {approve ? <div className="mb-3 flex gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>Their workspace becomes <b>read-only straight away</b>. Nobody can add or change anything until an operator releases the hold.</span></div>
      : <p className="mb-3 text-sm text-muted">The agency stays active. {r.requested_by_email} is told the request was rejected, with your reason.</p>}
    <div className="mb-3 rounded-lg bg-surface2 p-3 text-sm"><div className="text-xs text-muted">Reason given by {r.requested_by_email}</div><div className="mt-0.5">“{r.reason}”</div></div>
    <Field label={approve ? 'Note (optional)' : 'Why are you rejecting it?'} hint="Kept in the operator audit log."><input className="input" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={approve ? 'e.g. Chargeback confirmed with finance' : 'e.g. Customer has paid; no need to suspend'} /></Field>
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className={`btn ${approve ? '!bg-danger' : ''}`} disabled={busy || (!approve && note.trim().length < 3)} onClick={go}>{busy ? 'Working…' : approve ? 'Approve and suspend' : 'Reject request'}</button></div></Modal>;
}

export function PlatformApprovals({ me, onChange }: { me: Me; onChange(): void }) {
  const [rows, setRows] = useState<any[] | null>(null); const [err, setErr] = useState(''); const [tab, setTab] = useState<'decide' | 'mine' | 'history'>('decide'); const [dlg, setDlg] = useState<{ r: any; mode: 'approve' | 'reject' } | null>(null); const [msg, setMsg] = useState(''); const [, tick] = useState(0);
  const load = () => api('/platform/approvals').then((r) => { setRows(r); setErr(''); }).catch((e) => setErr(e.message)); useEffect(() => { load(); const h = setInterval(() => tick((t) => t + 1), 30_000); return () => clearInterval(h); }, []);
  const all = rows ?? []; const pending = all.filter((r) => r.status === 'pending'); const mineWaiting = pending.filter((r) => r.requested_by_email === me.email); const forMe = pending.filter((r) => r.requested_by_email !== me.email); const history = all.filter((r) => r.status !== 'pending');
  const count = (s: string) => all.filter((r) => r.status === s).length;
  const cancel = async (r: any) => { try { await api(`/platform/approvals/${r.id}/cancel`, 'POST'); setMsg(`Your request to suspend ${r.agency_name} was withdrawn.`); load(); onChange(); } catch (e: any) { setErr(e.message); } };
  const done = (m: string) => { setDlg(null); setMsg(m); load(); onChange(); };
  const tiles: [string, number | string, string, string, any][] = [['Needs your decision', forMe.length, 'Waiting for you', forMe.length ? 'warn' : 'success', Hourglass], ['Your requests', mineWaiting.length, 'Waiting for another admin', 'info', Clock], ['Approved', count('approved'), 'Agencies suspended', 'danger', Ban], ['Rejected or withdrawn', count('rejected') + count('cancelled'), 'Agencies left running', 'success', ShieldCheck]];
  const tabs: [typeof tab, string, number][] = [['decide', 'Needs your decision', forMe.length], ['mine', 'Your requests', mineWaiting.length], ['history', 'History', history.length]];
  const list = tab === 'decide' ? forMe : tab === 'mine' ? mineWaiting : history;
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{tiles.map(([l, v, hint, hue, Icon]) => <div key={l} className="card glow-card" style={{ ['--hue' as any]: `var(--${hue})` }}><div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{l}</span><span className="grid h-8 w-8 place-items-center rounded-xl" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}><Icon size={16} /></span></div><div className="mt-2 text-3xl font-bold num">{rows ? v : '—'}</div><div className="mt-0.5 text-[11px] text-muted">{hint}</div></div>)}</div>

    <div className="flex items-start gap-3 rounded-xl border border-line bg-surface2/50 px-4 py-3 text-sm"><ShieldCheck size={18} className="mt-0.5 shrink-0 text-accent" />
      <p className="text-muted"><b className="text-fg">Two people for every suspension.</b> One admin operator asks; a different one approves or rejects. You can’t approve your own request, and a request that isn’t decided within 24 hours expires.</p></div>

    {msg && <div role="status" className="flex justify-between gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"><span>{msg}</span><button aria-label="Dismiss" onClick={() => setMsg('')}>×</button></div>}
    <Err e={err} />
    <div className="flex gap-1 overflow-x-auto border-b border-line" role="tablist">{tabs.map(([k, l, n]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`whitespace-nowrap px-3.5 py-2 text-sm ${tab === k ? 'border-b-2 border-accent font-medium text-accent' : 'text-muted hover:text-fg'}`}>{l}{n > 0 && <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] num ${k === 'decide' ? 'bg-danger text-white' : 'bg-surface2 text-muted'}`}>{n}</span>}</button>)}</div>

    {!rows ? <Skeleton className="h-56" /> : !list.length ? (
      <div className="card py-14 text-center"><span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-success/12 bg-success/10 text-success"><CheckCircle2 size={24} /></span>
        <div className="text-sm font-semibold">{tab === 'decide' ? 'Nothing is waiting for your decision' : tab === 'mine' ? 'You have no open requests' : 'No decisions yet'}</div>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted">{tab === 'decide' ? 'When another admin operator asks to suspend an agency, it appears here.' : tab === 'mine' ? 'Request a suspension from an agency’s Manage menu. A second admin then has to approve it.' : 'Approved, rejected and withdrawn requests are kept here.'}</p></div>
    ) : tab !== 'history' ? (
      <div className="grid gap-4 lg:grid-cols-2">{list.map((r) => { const own = r.requested_by_email === me.email; const s = share(r); return (
        <article key={r.id} className="card glow-card overflow-hidden !p-0" style={{ ['--hue' as any]: 'var(--warn)' }}>
          <div className="h-1" style={{ background: 'linear-gradient(90deg, rgb(var(--warn)), rgb(var(--warn) / .15))' }} />
          <div className="p-4">
            <div className="flex items-start gap-3"><Avatar name={r.agency_name} size={44} /><div className="min-w-0 flex-1"><div className="truncate text-base font-semibold">{r.agency_name}</div><div className="text-xs text-muted">Suspension requested by <b className="text-fg">{r.requested_by_email}</b>{own ? ' (you)' : ''} · {rel(r.requested_at)}</div></div>
              <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">Pending</span></div>
            <blockquote className="mt-3 rounded-lg border-l-2 border-warn bg-surface2/60 px-3 py-2 text-sm">“{r.reason}”</blockquote>
            <div className="mt-3"><div className="mb-1 flex items-center justify-between text-xs"><span className="text-muted">Expires</span><span className={s < 0.15 ? 'font-medium text-danger' : 'text-muted'}>{left(r.expires_at)}</span></div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface2"><div className="h-full rounded-full" style={{ width: `${Math.round(s * 100)}%`, background: s < 0.15 ? 'rgb(var(--danger))' : 'rgb(var(--warn))' }} /></div></div>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">{own ? <><span className="mr-auto text-xs text-muted">Waiting for a second admin operator.</span><button className="btn-ghost" onClick={() => cancel(r)}><Undo2 size={14} />Withdraw request</button></>
              : <><button className="btn-ghost" onClick={() => setDlg({ r, mode: 'reject' })}>Reject</button><button className="btn !bg-danger" onClick={() => setDlg({ r, mode: 'approve' })}>Approve suspension</button></>}</div>
          </div></article>); })}</div>
    ) : (
      <div className="card !p-0 overflow-hidden"><ul className="divide-y divide-line/70">{history.map((r) => { const o = OUTCOME[r.status] ?? OUTCOME.cancelled; const Icon = o.icon; return (
        <li key={r.id} className="flex gap-3 px-4 py-3"><span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl" style={{ background: `rgb(var(--${o.hue}) / .14)`, color: `rgb(var(--${o.hue}))` }}><Icon size={15} /></span>
          <div className="min-w-0 flex-1"><div className="text-sm"><b>{r.agency_name}</b> <span className="text-muted">· suspension {o.label.toLowerCase()}</span></div>
            <div className="text-xs text-muted">Requested by {r.requested_by_email} · “{r.reason}”</div>
            {r.decided_by_email && <div className="mt-0.5 text-xs text-muted">{o.label} by <b className="text-fg">{r.decided_by_email}</b>{r.decision_note ? <> — “{r.decision_note}”</> : null}</div>}</div>
          <div className="shrink-0 text-right"><span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `rgb(var(--${o.hue}) / .14)`, color: `rgb(var(--${o.hue}))` }}>{o.label}</span><div className="mt-1 text-[11px] text-muted num">{rel(r.decided_at ?? r.expires_at)}</div></div></li>); })}</ul></div>
    )}
    {dlg && <Decide r={dlg.r} mode={dlg.mode} onClose={() => setDlg(null)} onDone={done} />}
  </div>;
}
