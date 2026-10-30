import { useEffect, useState } from 'react';
import { Copy, Link2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Page, Pill, Table } from '../components/ui';
import { useList } from '../lookup';

export default function ClientPortal() {
  const { can } = useAuth(); const w = can('admin', 'finance_manager'); const clients = useList('/clients');
  const [tab, setTab] = useState<'requests' | 'links' | 'deliveries'>('requests');
  const [reqs, setReqs] = useState<any[]>([]); const [links, setLinks] = useState<any[]>([]); const [dl, setDl] = useState<any[]>([]);
  const [err, setErr] = useState(''); const [form, setForm] = useState<any>(null); const [made, setMade] = useState<any>(null); const [open, setOpen] = useState<any>(null); const [invs, setInvs] = useState<any[]>([]);
  const load = () => { api('/portal-admin/requests').then(setReqs); api('/portal-admin/links').then(setLinks); api('/portal-admin/deliveries').then(setDl); };
  useEffect(() => { load(); }, []);
  const pickClient = async (id: string) => { setForm({ ...form, client_id: id, invoice_id: '' }); setInvs(id ? (await api('/invoices')).filter((i: any) => String(i.client_id) === id && ['sent', 'partially_paid', 'overdue'].includes(i.status)) : []); };
  const create = async () => {
    try { const body = { client_id: Number(form.client_id), days: Number(form.days) || 30, send: !!form.send, ...(form.kind === 'invoice' ? { invoice_id: Number(form.invoice_id) } : {}) };
      setMade(await api(form.kind === 'invoice' ? '/portal-admin/payment-links' : '/portal-admin/links', 'POST', body)); setForm(null); setErr(''); load(); } catch (e: any) { setErr(e.message); }
  };
  const respond = async () => {
    try { await api(`/portal-admin/requests/${open.id}/respond`, 'POST', { response: open.reply || undefined, status: open.status, notify: !!open.notify }); setOpen(null); setErr(''); load(); } catch (e: any) { setErr(e.message); }
  };
  return (
    <Page title="Client portal" description="Secure expiring links for clients to view quotes, invoices, itineraries and pay online; plus their support requests."
      actions={<>{(['requests', 'links', 'deliveries'] as const).map((t) => <button key={t} className={`capitalize ${tab === t ? 'btn' : 'btn-ghost'}`} onClick={() => setTab(t)}>{t === 'requests' ? `Requests${reqs.filter((r) => r.status === 'open').length ? ` (${reqs.filter((r) => r.status === 'open').length})` : ''}` : t}</button>)}
        {w && <button className="btn" onClick={() => setForm({ kind: 'portal', client_id: '', days: 30 })}><Link2 size={15} /> New link</button>}</>}>
      <Err e={open || form ? '' : err} />
      {made && <div className="rounded-lg border border-success/30 bg-success/10 text-sm p-3 mb-4"><div className="font-medium text-success mb-1">Link created{made.delivery ? ` · email ${made.delivery}` : ''} — copy it now, it won't be shown again</div>
        <div className="flex gap-2 items-center"><input className="input num text-xs" readOnly value={made.url} onFocus={(e) => e.target.select()} /><button className="btn-ghost" onClick={() => navigator.clipboard?.writeText(made.url)}><Copy size={14} /></button></div></div>}
      {tab === 'requests' && <Table rows={reqs} onRow={(r) => setOpen({ ...r, reply: r.response ?? '', notify: true })} empty="No requests from clients" cols={[
        { h: 'Received', render: (r) => <span className="num">{String(r.created_at).slice(0, 10)}</span> }, { h: 'Client', render: (r) => r.client_name }, { h: 'Subject', render: (r) => <>{r.subject}{r.booking_ref && <span className="text-xs text-muted ml-2 num">{r.booking_ref}</span>}</> }, { h: 'Status', render: (r) => <Pill s={r.status === 'open' ? 'pending' : r.status === 'resolved' ? 'done' : 'in_progress'} /> }]} />}
      {tab === 'links' && <Table rows={links} empty="No links yet" cols={[
        { h: 'Client', render: (l) => l.client_name }, { h: 'Type', render: (l) => (l.scope === 'invoice' ? `Pay ${l.invoice_number}` : 'Portal') }, { h: 'Expires', render: (l) => <span className="num">{String(l.expires_at).slice(0, 10)}</span> },
        { h: 'Opened', right: true, render: (l) => `${l.use_count}×` }, { h: 'Status', render: (l) => <Pill s={l.revoked_at ? 'void' : l.active ? 'approved' : 'expired'} /> },
        { h: '', render: (l) => w && l.active && <button className="btn-ghost text-danger" onClick={async () => { if (confirm('Revoke this link? The client will no longer be able to use it.')) { await api(`/portal-admin/links/${l.id}/revoke`, 'POST'); load(); } }}>Revoke</button> }]} />}
      {tab === 'deliveries' && <Table rows={dl} empty="Nothing sent yet" cols={[
        { h: 'When', render: (r) => <span className="num">{String(r.created_at).replace('T', ' ').slice(0, 16)}</span> }, { h: 'Type', render: (r) => r.kind.replace('_', ' ') }, { h: 'To', render: (r) => r.recipient }, { h: 'Subject', render: (r) => r.subject },
        { h: 'Result', render: (r) => <><Pill s={r.status === 'sent' ? 'paid' : r.status === 'failed' ? 'void' : 'pending'} /><span className="text-xs text-muted ml-2">{r.status}{r.error ? `: ${r.error}` : r.status === 'skipped' ? ' (email not configured)' : ''}</span></> }]} />}

      {form && <Modal title="New client link" onClose={() => setForm(null)}><Err e={err} />
        <Field label="Client"><select className="input" value={form.client_id} onChange={(e) => pickClient(e.target.value)}><option value="">Select…</option>{clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Link type"><select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="portal">Full portal (quotes, invoices, trips, messages)</option><option value="invoice">Payment link for one invoice</option></select></Field>
        {form.kind === 'invoice' && <Field label="Invoice"><select className="input" value={form.invoice_id} onChange={(e) => setForm({ ...form, invoice_id: e.target.value })}><option value="">Select…</option>{invs.map((i: any) => <option key={i.id} value={i.id}>{i.number} — {(i.total - i.amount_paid).toFixed(2)} {i.currency} due</option>)}</select></Field>}
        <Field label="Expires in (days)"><input className="input num" type="number" min={1} max={365} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm mb-4"><input type="checkbox" checked={!!form.send} onChange={(e) => setForm({ ...form, send: e.target.checked })} /> Email the link to the client</label>
        <div className="flex justify-end"><button className="btn" disabled={!form.client_id || (form.kind === 'invoice' && !form.invoice_id)} onClick={create}>Create link</button></div></Modal>}
      {open && <Modal title={open.subject} onClose={() => setOpen(null)}><Err e={err} />
        <div className="text-xs text-muted mb-2">{open.client_name}{open.booking_ref && ` · ${open.booking_ref}`}</div><p className="text-sm whitespace-pre-wrap mb-4 rounded-lg bg-surface2 p-3">{open.message}</p>
        {w ? <><Field label="Reply"><textarea className="input" rows={4} value={open.reply} onChange={(e) => setOpen({ ...open, reply: e.target.value })} /></Field>
          <div className="flex items-center gap-3 mb-4"><select className="input w-40" value={open.status} onChange={(e) => setOpen({ ...open, status: e.target.value })}><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option></select>
            <label className="text-sm flex gap-2 items-center"><input type="checkbox" checked={!!open.notify} onChange={(e) => setOpen({ ...open, notify: e.target.checked })} /> Email the client</label></div>
          <div className="flex justify-end"><button className="btn" onClick={respond}>Save</button></div></> : open.response && <p className="text-sm">Reply: {open.response}</p>}</Modal>}
    </Page>
  );
}
