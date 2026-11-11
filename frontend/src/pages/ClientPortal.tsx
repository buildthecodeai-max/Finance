import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Clock, Copy, Eye, Inbox, Link2, Mail, MessageSquareText, Receipt, Send, Trash2, XCircle } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Avatar, Err, Field, Modal, Page, Skeleton } from '../components/ui';
import { useList } from '../lookup';

type Tab = 'requests' | 'links' | 'deliveries';
const ST: Record<string, { label: string; hue: string }> = { open: { label: 'Open', hue: 'warn' }, in_progress: { label: 'In progress', hue: 'info' }, resolved: { label: 'Resolved', hue: 'success' } };
const ago = (d: any) => { const t = new Date(String(d).includes('T') ? d : `${String(d).replace(' ', 'T')}Z`).getTime(), s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : s < 86400 * 14 ? `${Math.round(s / 86400)} d ago` : String(d).slice(0, 10); };
const daysLeft = (d: any) => Math.ceil((Date.parse(String(d).slice(0, 10)) - Date.now()) / 864e5);
const Chip = ({ hue, children }: { hue: string; children: React.ReactNode }) => <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}>{children}</span>;

/** Client portal, from the agency's side: the questions clients send, the secure links you have given them, and what has been emailed. */
export default function ClientPortal() {
  const { can } = useAuth(); const w = can('admin', 'finance_manager'); const clients = useList('/clients');
  const [tab, setTab] = useState<Tab>('requests'); const [filter, setFilter] = useState('open');
  const [reqs, setReqs] = useState<any[] | null>(null); const [links, setLinks] = useState<any[] | null>(null); const [dl, setDl] = useState<any[] | null>(null);
  const [err, setErr] = useState(''); const [form, setForm] = useState<any>(null); const [made, setMade] = useState<any>(null); const [open, setOpen] = useState<any>(null); const [invs, setInvs] = useState<any[]>([]); const [revoke, setRevoke] = useState<any>(null); const [copied, setCopied] = useState(false); const [busy, setBusy] = useState(false);
  const load = () => { api('/portal-admin/requests').then(setReqs).catch(() => setReqs([])); api('/portal-admin/links').then(setLinks).catch(() => setLinks([])); api('/portal-admin/deliveries').then(setDl).catch(() => setDl([])); };
  useEffect(() => { load(); }, []);
  const pickClient = async (id: string) => { setForm({ ...form, client_id: id, invoice_id: '' }); setInvs(id ? (await api('/invoices')).filter((i: any) => String(i.client_id) === id && ['sent', 'partially_paid', 'overdue'].includes(i.status)) : []); };
  const create = async () => {
    setBusy(true);
    try { const body = { client_id: Number(form.client_id), days: Number(form.days) || 30, send: !!form.send, ...(form.kind === 'invoice' ? { invoice_id: Number(form.invoice_id) } : {}) };
      setMade({ ...(await api(form.kind === 'invoice' ? '/portal-admin/payment-links' : '/portal-admin/links', 'POST', body)), kind: form.kind, client: clients.find((c: any) => String(c.id) === form.client_id)?.name }); setForm(null); setErr(''); setCopied(false); setTab('links'); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const respond = async () => {
    setBusy(true);
    try { await api(`/portal-admin/requests/${open.id}/respond`, 'POST', { response: open.reply || undefined, status: open.status, notify: !!open.notify }); setOpen(null); setErr(''); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const doRevoke = async () => { try { await api(`/portal-admin/links/${revoke.id}/revoke`, 'POST'); setRevoke(null); load(); } catch (e: any) { setErr(e.message); setRevoke(null); } };
  const copy = async () => { try { await navigator.clipboard.writeText(made.url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the address stays selectable */ } };

  const openReq = (reqs ?? []).filter((r) => r.status === 'open'); const activeLinks = (links ?? []).filter((l) => l.active && !l.revoked_at); const opens = (links ?? []).reduce((t, l) => t + Number(l.use_count ?? 0), 0); const failed = (dl ?? []).filter((r) => r.status === 'failed').length;
  const shownReqs = useMemo(() => (reqs ?? []).filter((r) => filter === 'all' || r.status === filter), [reqs, filter]);
  const tiles: [string, number | string, string, string, any, Tab | null][] = [['Open requests', openReq.length, 'Waiting for a reply', openReq.length ? 'warn' : 'success', Inbox, 'requests'], ['Active links', activeLinks.length, 'Clients can use these now', 'accent', Link2, 'links'], ['Link opens', opens, 'Times clients opened a link', 'info', Eye, 'links'], ['Emails', (dl ?? []).length, failed ? `${failed} failed to send` : 'All delivered', failed ? 'danger' : 'success', Mail, 'deliveries']];
  const tabs: [Tab, string, number][] = [['requests', 'Requests', openReq.length], ['links', 'Links', 0], ['deliveries', 'Emails sent', 0]];

  return (
    <Page title="Client portal" description="Give clients a secure page for their quotes, invoices and trips, with online payment, and answer what they send you."
      actions={w ? <button className="btn" onClick={() => { setErr(''); setForm({ kind: 'portal', client_id: '', days: 30, send: false }); }}><Link2 size={15} />New link</button> : undefined}>
      <Err e={open || form || revoke ? '' : err} />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">{tiles.map(([l, v, hint, hue, Icon, to]) => (
        <button key={l} type="button" onClick={() => to && setTab(to)} className="card glow-card text-left" style={{ ['--hue' as any]: `var(--${hue})` }}>
          <div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{l}</span><span className="grid h-8 w-8 place-items-center rounded-xl" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}><Icon size={16} /></span></div>
          <div className="mt-2 text-3xl font-bold num">{reqs && links && dl ? v : '—'}</div><div className="mt-0.5 text-[11px] text-muted">{hint}</div></button>))}</div>

      {made && <div role="status" className="mb-5 overflow-hidden rounded-xl border border-success/30 bg-success/5">
        <div className="flex items-start gap-3 p-4"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-success/15 text-success"><CheckCircle2 size={18} /></span>
          <div className="min-w-0 flex-1"><div className="font-semibold text-success">{made.kind === 'invoice' ? 'Payment link' : 'Portal link'} created{made.client ? ` for ${made.client}` : ''}{made.delivery ? ` · email ${made.delivery}` : ''}</div>
            <p className="mt-0.5 text-sm text-muted">Copy it now. For security it is <b className="text-fg">not shown again</b>. If you lose it, make a new one.</p>
            <div className="mt-3 flex gap-2"><input className="input num text-xs" readOnly aria-label="The link" value={made.url} onFocus={(e) => e.target.select()} /><button className="btn shrink-0" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy link'}</button></div></div>
          <button aria-label="Dismiss" className="text-muted hover:text-fg" onClick={() => setMade(null)}>×</button></div></div>}

      <div className="mb-4 flex gap-1 border-b border-line" role="tablist" aria-label="Client portal sections">{tabs.map(([k, l, n]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`whitespace-nowrap px-3.5 py-2 text-sm ${tab === k ? 'border-b-2 border-accent font-medium text-accent' : 'text-muted hover:text-fg'}`}>{l}{n > 0 && <span className="ml-1.5 rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-bold text-white num">{n}</span>}</button>)}</div>

      {tab === 'requests' && <>
        <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter requests">{[['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['all', 'All']].map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)} className={`rounded-full border px-3 py-1 text-xs ${filter === k ? 'border-accent bg-accent/15 font-medium text-accent' : 'border-line text-muted hover:bg-surface2'}`}>{l}</button>)}</div>
        {!reqs ? <Skeleton className="h-56" /> : !shownReqs.length ? <div className="card py-14 text-center"><span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-success/10 text-success"><Inbox size={24} /></span><div className="text-sm font-semibold">{reqs.length ? 'Nothing in this view' : 'No requests from clients yet'}</div><p className="mx-auto mt-1 max-w-sm text-xs text-muted">{reqs.length ? 'Try another filter.' : 'When a client writes to you from their portal, it shows up here. Share a portal link to let them.'}</p></div>
          : <div className="card !p-0 overflow-hidden"><ul className="divide-y divide-line/70">{shownReqs.map((r) => { const st = ST[r.status] ?? ST.open; return (
            <li key={r.id}><button className="flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-surface2/60" onClick={() => { setErr(''); setOpen({ ...r, reply: r.response ?? '', notify: true }); }}>
              <Avatar name={r.client_name ?? '?'} size={38} />
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-semibold">{r.subject}</span>{r.booking_ref && <span className="rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] text-muted num">{r.booking_ref}</span>}</div>
                <div className="text-xs text-muted">{r.client_name} · {ago(r.created_at)}</div><p className="mt-1 line-clamp-2 text-xs text-muted">{r.message}</p>
                {r.response && <p className="mt-1.5 flex items-start gap-1.5 text-xs text-accent"><MessageSquareText size={12} className="mt-0.5 shrink-0" /><span className="line-clamp-1">You replied: {r.response}</span></p>}</div>
              <Chip hue={st.hue}>{st.label}</Chip></button></li>); })}</ul></div>}</>}

      {tab === 'links' && (!links ? <Skeleton className="h-56" /> : !links.length ? <div className="card py-14 text-center"><span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent"><Link2 size={24} /></span><div className="text-sm font-semibold">No links yet</div><p className="mx-auto mt-1 max-w-sm text-xs text-muted">Create a portal link so a client can see their quotes, invoices and trips, or a payment link for one invoice.</p>{w && <button className="btn mt-4" onClick={() => setForm({ kind: 'portal', client_id: '', days: 30, send: false })}><Link2 size={15} />New link</button>}</div>
        : <div className="card !p-0 overflow-hidden"><div className="overflow-x-auto"><table className="w-full border-separate border-spacing-0"><thead><tr><th>Client</th><th>Type</th><th>Expires</th><th className="text-right">Opened</th><th>Status</th><th /></tr></thead><tbody>{links.map((l) => { const left = daysLeft(l.expires_at), live = l.active && !l.revoked_at; return (
          <tr key={l.id}><td><div className="flex items-center gap-2.5"><Avatar name={l.client_name ?? '?'} size={30} /><span className="font-medium">{l.client_name}</span></div></td>
            <td>{l.scope === 'invoice' ? <Chip hue="warn"><Receipt size={11} />Pay {l.invoice_number}</Chip> : <Chip hue="info"><Link2 size={11} />Full portal</Chip>}</td>
            <td className="whitespace-nowrap"><span className="num text-sm">{String(l.expires_at).slice(0, 10)}</span>{live && <div className={`text-xs ${left <= 3 ? 'text-warn' : 'text-muted'}`}>{left <= 0 ? 'expires today' : `${left} day${left === 1 ? '' : 's'} left`}</div>}</td>
            <td className="text-right num">{l.use_count}×</td>
            <td>{l.revoked_at ? <Chip hue="muted"><XCircle size={11} />Revoked</Chip> : live ? <Chip hue="success"><CheckCircle2 size={11} />Active</Chip> : <Chip hue="muted"><Clock size={11} />Expired</Chip>}</td>
            <td className="text-right">{w && live && <button className="btn-ghost !h-8 !px-2.5 text-xs text-danger" onClick={() => setRevoke(l)}><Trash2 size={13} />Revoke</button>}</td></tr>); })}</tbody></table></div></div>)}

      {tab === 'deliveries' && (!dl ? <Skeleton className="h-56" /> : !dl.length ? <div className="card py-14 text-center"><span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-info/10 text-info"><Mail size={24} /></span><div className="text-sm font-semibold">Nothing sent yet</div><p className="mx-auto mt-1 max-w-sm text-xs text-muted">Links and replies you email to clients are listed here, with whether they were delivered.</p></div>
        : <div className="card !p-0 overflow-hidden"><ul className="divide-y divide-line/70">{dl.map((r, i) => { const hue = r.status === 'sent' ? 'success' : r.status === 'failed' ? 'danger' : 'warn'; const Icon = r.status === 'sent' ? CheckCircle2 : r.status === 'failed' ? XCircle : AlertTriangle; return (
          <li key={i} className="flex items-start gap-3 px-4 py-3"><span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}><Icon size={15} /></span>
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{r.subject || String(r.kind).replace('_', ' ')}</div><div className="truncate text-xs text-muted capitalize">{String(r.kind).replace('_', ' ')} · to {r.recipient}</div>{(r.error || r.status === 'skipped') && <div className="mt-0.5 text-xs" style={{ color: `rgb(var(--${hue}))` }}>{r.error ? r.error : 'Not sent: email is not set up on this server.'}</div>}</div>
            <div className="shrink-0 text-right"><Chip hue={hue}>{r.status === 'sent' ? 'Delivered' : r.status === 'failed' ? 'Failed' : 'Skipped'}</Chip><div className="mt-1 text-[11px] text-muted num">{ago(r.created_at)}</div></div></li>); })}</ul></div>)}

      {form && <Modal title="New client link" onClose={() => setForm(null)}><Err e={err} />
        <Field label="Client"><select className="input" autoFocus value={form.client_id} onChange={(e) => pickClient(e.target.value)}><option value="">Select…</option>{clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="What should the link open?"><div className="grid gap-2 sm:grid-cols-2">{[['portal', 'Full portal', 'Quotes, invoices, trips and messages', Link2], ['invoice', 'Payment link', 'Pay one invoice online', Receipt]].map(([k, l, h, I]: any) => <label key={k} className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-sm ${form.kind === k ? 'border-accent bg-accent/10' : 'border-line'}`}><input type="radio" className="mt-1" name="lk" checked={form.kind === k} onChange={() => setForm({ ...form, kind: k })} /><span><span className="flex items-center gap-1.5 font-medium"><I size={14} />{l}</span><span className="block text-xs text-muted">{h}</span></span></label>)}</div></Field>
        {form.kind === 'invoice' && <Field label="Invoice" hint={form.client_id && !invs.length ? 'This client has no unpaid invoices.' : undefined}><select className="input" value={form.invoice_id} onChange={(e) => setForm({ ...form, invoice_id: e.target.value })}><option value="">Select…</option>{invs.map((i: any) => <option key={i.id} value={i.id}>{i.number} — {money(i.total - i.amount_paid - (i.amount_credited ?? 0), i.currency)} owing</option>)}</select></Field>}
        <Field label="Link expires in"><div className="flex flex-wrap items-center gap-2">{[7, 14, 30, 90].map((n) => <button key={n} type="button" aria-pressed={Number(form.days) === n} onClick={() => setForm({ ...form, days: n })} className={`rounded-full border px-3 py-1 text-xs ${Number(form.days) === n ? 'border-accent bg-accent/15 font-medium text-accent' : 'border-line text-muted hover:bg-surface2'}`}>{n} days</button>)}<input className="input num !w-24" type="number" min={1} max={365} aria-label="Days" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} /></div></Field>
        <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form.send} onChange={(e) => setForm({ ...form, send: e.target.checked })} />Email the link to the client now</label>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setForm(null)}>Cancel</button><button className="btn" disabled={busy || !form.client_id || (form.kind === 'invoice' && !form.invoice_id)} onClick={create}>{busy ? 'Creating…' : 'Create link'}</button></div></Modal>}

      {open && <Modal title={open.subject} wide onClose={() => setOpen(null)}><Err e={err} />
        <div className="mb-3 flex items-center gap-3"><Avatar name={open.client_name ?? '?'} size={40} /><div className="min-w-0 flex-1"><div className="text-sm font-medium">{open.client_name}</div><div className="text-xs text-muted">{ago(open.created_at)}{open.booking_ref && ` · ${open.booking_ref}`}</div></div><Chip hue={(ST[open.status] ?? ST.open).hue}>{(ST[open.status] ?? ST.open).label}</Chip></div>
        <p className="mb-4 whitespace-pre-wrap rounded-xl border border-line bg-surface2/50 p-3 text-sm">{open.message}</p>
        {w ? <><Field label="Your reply"><textarea className="input" rows={5} autoFocus value={open.reply} onChange={(e) => setOpen({ ...open, reply: e.target.value })} placeholder="Write a clear, friendly answer…" /></Field>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-2 text-sm text-muted">Status<select className="input !w-auto" value={open.status} onChange={(e) => setOpen({ ...open, status: e.target.value })}><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option></select></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!open.notify} onChange={(e) => setOpen({ ...open, notify: e.target.checked })} />Email the client</label></div>
          <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setOpen(null)}>Close</button><button className="btn" disabled={busy} onClick={respond}><Send size={14} />{busy ? 'Saving…' : 'Save reply'}</button></div></>
          : open.response && <div className="rounded-xl border-l-2 border-accent bg-surface2/60 px-3 py-2 text-sm"><div className="mb-0.5 text-[11px] font-medium text-accent">Reply</div>{open.response}</div>}</Modal>}

      {revoke && <Modal title="Revoke this link?" onClose={() => setRevoke(null)}>
        <p className="mb-3 text-sm">{revoke.client_name} will no longer be able to open {revoke.scope === 'invoice' ? `the payment link for ${revoke.invoice_number}` : 'their portal link'}. You can make a new one at any time.</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setRevoke(null)}>Keep it</button><button className="btn !bg-danger" onClick={doRevoke}>Revoke link</button></div></Modal>}
    </Page>
  );
}
