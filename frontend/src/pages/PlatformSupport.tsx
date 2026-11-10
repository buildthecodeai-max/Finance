import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Globe, Inbox, Mail, Phone, Search, Send, Settings2, X } from 'lucide-react';
import { api } from '../api';
import { Avatar, Err, Field, Modal, Pager, Skeleton } from '../components/ui';
import { rel } from './PlatformPeople';

/* The support inbox: requests agencies sent from their Support page. Answer them here; the reply reaches the sender by email and on their page. */

const ST: Record<string, { label: string; hue: string }> = { open: { label: 'Open', hue: 'warn' }, in_progress: { label: 'In progress', hue: 'info' }, resolved: { label: 'Resolved', hue: 'success' } };
const CAT: Record<string, string> = { question: 'Question', problem: 'Problem', billing: 'Billing', request: 'Feature request' };

function Answer({ r, onClose, onDone }: { r: any; onClose(): void; onDone(msg: string): void }) {
  const [reply, setReply] = useState(r.reply ?? ''); const [status, setStatus] = useState(r.status === 'open' ? 'in_progress' : r.status); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async (st: string) => { setBusy(true); setErr(''); try { await api(`/platform/support-requests/${r.id}`, 'PUT', { status: st, reply: reply.trim() && reply.trim() !== (r.reply ?? '') ? reply.trim() : undefined }); onDone(st === 'resolved' ? 'Marked as resolved.' : 'Saved.'); } catch (e: any) { setErr(e.message); setBusy(false); } };
  return <Modal title={r.subject} wide onClose={onClose}><Err e={err} />
    <div className="mb-3 flex flex-wrap items-center gap-3"><Avatar name={r.agency_name} size={38} /><div className="min-w-0 flex-1"><div className="text-sm font-medium">{r.agency_name}</div><div className="text-xs text-muted">{r.user_name} · {r.user_email} · {CAT[r.category] ?? r.category} · {rel(r.created_at)}</div></div>
      <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `rgb(var(--${ST[r.status].hue}) / .14)`, color: `rgb(var(--${ST[r.status].hue}))` }}>{ST[r.status].label}</span></div>
    <div className="mb-4 whitespace-pre-wrap rounded-lg border border-line bg-surface2/50 p-3 text-sm">{r.message}</div>
    <Field label="Your reply" hint="Sent to the person by email and shown on their Support page."><textarea className="input" rows={6} autoFocus value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a clear, friendly answer…" /></Field>
    <div className="flex flex-wrap items-center justify-between gap-2"><label className="flex items-center gap-2 text-sm text-muted">Status<select className="input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option></select></label>
      <div className="flex gap-2"><button className="btn-ghost" onClick={onClose}>Close</button><button className="btn-ghost" disabled={busy} onClick={() => save(status)}>Save</button><button className="btn" disabled={busy || (!reply.trim() && !r.reply)} onClick={() => save('resolved')}><Send size={14} />Reply and resolve</button></div></div></Modal>;
}

function Contact({ canEdit }: { canEdit: boolean }) {
  const [c, setC] = useState<any>(null); const [open, setOpen] = useState(false); const [f, setF] = useState<any>({ email: '', phone: '', hours: '', url: '', reason: '' }); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = () => api('/platform/settings/support').then(setC).catch(() => {}); useEffect(() => { load(); }, []);
  const save = async () => { setBusy(true); setErr(''); try { await api('/platform/settings/support', 'PUT', f); setOpen(false); setMsg('Saved. Agencies see these details on their Support page.'); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const rows: [any, string, string][] = [[Mail, 'Email', c?.email], [Phone, 'Phone', c?.phone], [Clock, 'Hours', c?.hours], [Globe, 'Help centre', c?.url]];
  return (
    <section className="card" aria-label="Contact details shown to agencies">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-semibold"><Settings2 size={15} className="text-accent" />Contact details shown to agencies</h3><p className="mt-0.5 text-xs text-muted">Appear on every agency’s Support page. New requests are also emailed to the address below.</p></div>
        {canEdit && c && <button className="btn-ghost" onClick={() => { setF({ email: c.email, phone: c.phone, hours: c.hours, url: c.url, reason: '' }); setErr(''); setOpen(true); }}>Edit</button>}</div>
      {msg && <div role="status" className="mt-3 flex justify-between gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"><span>{msg}</span><button aria-label="Dismiss" onClick={() => setMsg('')}><X size={14} /></button></div>}
      {!c ? <Skeleton className="mt-3 h-16" /> : <dl className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{rows.map(([I, l, v]) => <div key={l}><dt className="flex items-center gap-1.5 text-xs text-muted"><I size={12} />{l}</dt><dd className={`mt-0.5 break-all text-sm ${v ? 'font-medium' : 'text-muted'}`}>{v || 'Not set'}</dd></div>)}</dl>}
      {open && <Modal title="Support contact details" onClose={() => setOpen(false)}><Err e={err} />
        <div className="grid gap-x-4 sm:grid-cols-2"><Field label="Support email" hint="Requests are emailed here."><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="support@yourcompany.com" /></Field><Field label="Phone"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+1 555 0100" /></Field>
          <Field label="Hours"><input className="input" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} placeholder="Mon–Fri, 9am–6pm UTC" /></Field><Field label="Help centre address" hint="Must start with https://"><input className="input" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://help.yourcompany.com" /></Field></div>
        <Field label="Reason" hint="Kept in the operator audit log."><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={busy || f.reason.trim().length < 3} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div></Modal>}
    </section>
  );
}

export function PlatformSupport({ canEdit, onChange }: { canEdit: boolean; onChange(): void }) {
  const [res, setRes] = useState<any>(null); const [status, setStatus] = useState('open'); const [q, setQ] = useState(''); const [page, setPage] = useState(1); const [err, setErr] = useState(''); const [open, setOpen] = useState<any>(null); const [msg, setMsg] = useState('');
  const load = () => api(`/platform/support-requests?${status ? `status=${status}&` : ''}page=${page}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`).then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { const h = setTimeout(load, q ? 250 : 0); return () => clearTimeout(h); }, [status, q, page]); useEffect(() => { setPage(1); }, [status, q]);
  const c = res?.counts ?? {}; const tiles: [string, string, number, string, any][] = [['open', 'Open', c.open ?? 0, 'warn', Inbox], ['in_progress', 'In progress', c.in_progress ?? 0, 'info', Clock], ['resolved', 'Resolved', c.resolved ?? 0, 'success', CheckCircle2], ['', 'All requests', (c.open ?? 0) + (c.in_progress ?? 0) + (c.resolved ?? 0), 'accent', Inbox]];
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{tiles.map(([k, l, n, hue, Icon]) => <button key={l} type="button" aria-pressed={status === k} onClick={() => setStatus(k)} className={`card glow-card text-left ${status === k ? 'ring-2 ring-accent' : ''}`} style={{ ['--hue' as any]: `var(--${hue})` }}>
      <div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{l}</span><span className="grid h-8 w-8 place-items-center rounded-xl" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}><Icon size={16} /></span></div><div className="mt-2 text-3xl font-bold num">{res ? n : '—'}</div></button>)}</div>
    <Contact canEdit={canEdit} />
    <div className="relative max-w-sm"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input className="input pl-8" aria-label="Search requests" placeholder="Search title, message, agency or person…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
    {msg && <div role="status" className="flex justify-between gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"><span>{msg}</span><button aria-label="Dismiss" onClick={() => setMsg('')}><X size={14} /></button></div>}
    <Err e={err} />
    {!res ? <Skeleton className="h-64" /> : <div className="card !p-0 overflow-hidden">
      {!res.rows.length && <div className="px-4 py-14 text-center"><Inbox size={26} className="mx-auto mb-2 text-muted" /><div className="text-sm font-medium">{status === 'open' ? 'Inbox zero. Nothing is waiting.' : 'No requests match.'}</div></div>}
      <ul className="divide-y divide-line/70">{res.rows.map((r: any) => { const st = ST[r.status]; return (
        <li key={r.id}><button className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface2/60" onClick={() => setOpen(r)}><Avatar name={r.agency_name} size={36} />
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-medium">{r.subject}</span><span className="rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] text-muted">{CAT[r.category] ?? r.category}</span></div>
            <div className="truncate text-xs text-muted">{r.agency_name} · {r.user_name} · {rel(r.created_at)}</div><p className="mt-0.5 line-clamp-1 text-xs text-muted">{r.message}</p></div>
          <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `rgb(var(--${st.hue}) / .14)`, color: `rgb(var(--${st.hue}))` }}>{st.label}</span></button></li>); })}</ul>
      {res.total > res.page_size && <Pager total={res.total} page={page - 1} size={res.page_size} onPage={(p) => setPage(p + 1)} noun="requests" />}</div>}
    {open && <Answer r={open} onClose={() => setOpen(null)} onDone={(m) => { setOpen(null); setMsg(m); load(); onChange(); }} />}
  </div>;
}
