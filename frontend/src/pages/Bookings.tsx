import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Pill, Table } from '../components/ui';
import { useList, useOpenOnNew } from '../lookup';
import { Archive, ArchiveRestore, Pencil, Plus, X } from 'lucide-react';

const STATUSES = ['enquiry', 'quoted', 'awaiting_client', 'confirmed', 'in_service', 'travel_completed', 'closed', 'on_hold', 'cancelled', 'refunded', 'lost'];
const NEEDS_REASON = ['cancelled', 'lost', 'on_hold', 'refunded'];
const TYPES = ['flight', 'hotel', 'package', 'cruise', 'transfer', 'tour', 'rail', 'car', 'insurance', 'visa', 'fee', 'other'];

/** Edit the details of an existing booking. Changes are written to the booking's change log, so a reason is required. */
function EditBooking({ b, onClose, onSaved }: { b: any; onClose(): void; onSaved(): void }) {
  const clients = useList('/clients'); const agents = useList('/team/agents'); const branches = useList('/accounting/branches');
  const [f, setF] = useState<any>({ client_id: b.client_id, agent_id: b.agent_id ?? '', branch_id: b.branch_id ?? '', destination: b.destination ?? '', travel_start: b.travel_start ? String(b.travel_start).slice(0, 10) : '', travel_end: b.travel_end ? String(b.travel_end).slice(0, 10) : '',
    channel: b.channel ?? '', trip_purpose: b.trip_purpose ?? '', overhead: b.overhead ?? 0, notes: b.notes ?? '', reason: '' });
  const [err, setErr] = useState(''); const { can } = useAuth(); const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try { await api(`/bookings/${b.id}`, 'PUT', { client_id: Number(f.client_id), ...(can('admin', 'finance_manager') ? { agent_id: f.agent_id ? Number(f.agent_id) : null, branch_id: f.branch_id ? Number(f.branch_id) : null } : {}),
      destination: f.destination || null, travel_start: f.travel_start || null, travel_end: f.travel_end || null, channel: f.channel || null, trip_purpose: f.trip_purpose || null, overhead: Number(f.overhead) || 0, notes: f.notes || null, reason: f.reason || undefined }); onSaved(); }
    catch (e: any) { setErr(e.message); }
  };
  const clientOpts = clients.some((c: any) => c.id === b.client_id) ? clients : [{ id: b.client_id, name: b.client?.name ?? b.client_name ?? `Client #${b.client_id}` }, ...clients];
  return <Modal title={`Edit ${b.reference}`} onClose={onClose}><Err e={err} />
    <div className="grid grid-cols-2 gap-x-4"><div className="col-span-2"><Field label="Client"><select className="input" value={f.client_id} onChange={set('client_id')}>{clientOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field></div>
      <Field label="Destination"><input className="input" value={f.destination} onChange={set('destination')} /></Field><Field label="Channel"><input className="input" value={f.channel} onChange={set('channel')} placeholder="web, phone, referral…" /></Field>
      <Field label="Travel start"><input className="input num" type="date" value={f.travel_start} onChange={set('travel_start')} /></Field><Field label="Travel end"><input className="input num" type="date" value={f.travel_end} onChange={set('travel_end')} /></Field>
      {can('admin', 'finance_manager') && <><Field label="Agent"><select className="input" value={f.agent_id} onChange={set('agent_id')}><option value="">Unassigned</option>{agents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Branch"><select className="input" value={f.branch_id} onChange={set('branch_id')}><option value="">None</option>{branches.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field></>}
      <Field label="Trip purpose"><input className="input" value={f.trip_purpose} onChange={set('trip_purpose')} placeholder="leisure, business…" /></Field><Field label="Overhead (cost to serve)"><input className="input num" type="number" min={0} step="0.01" value={f.overhead} onChange={set('overhead')} /></Field>
      <div className="col-span-2"><Field label="Notes"><textarea className="input" rows={3} value={f.notes} onChange={set('notes')} /></Field></div>
      <div className="col-span-2"><Field label="Reason for change (kept in the booking's change log)"><input className="input" value={f.reason} onChange={set('reason')} /></Field></div></div>
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={!f.client_id} onClick={save}>Save changes</button></div></Modal>;
}

/** "Delete" = archive: the booking leaves lists and reports but its history is kept and it can be restored. Live invoices/bills block it. */
function DeleteBooking({ b, onClose, onDone }: { b: any; onClose(): void; onDone(): void }) {
  const [u, setU] = useState<any>(null); const [reason, setReason] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { api(`/bookings/${b.id}/usage`).then(setU); }, []);
  const blocked = u?.live?.length > 0;
  return <Modal title={`Delete ${b.reference}?`} onClose={onClose}><Err e={err} />
    {blocked ? <p className="text-sm mb-3">This booking has <b>{u.live.map((d: any) => `${d.n} ${d.label}`).join(' and ')}</b> that aren't void. Void or credit them first — or set the booking to <b>Cancelled</b> to keep the history without deleting.</p>
      : <p className="text-sm mb-3">The booking is removed from lists and reports and its estimated commission is reversed. Everything stays in the audit trail and you can restore it later.</p>}
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn bg-danger text-white" disabled={blocked} onClick={async () => { try { await api(`/bookings/${b.id}`, 'DELETE', {}); onDone(); } catch (e: any) { setErr(e.message); } }}>Delete booking</button></div></Modal>;
}

export function BookingList() {
  const nav = useNavigate(); const { can } = useAuth(); const clients = useList('/clients');
  const [rows, setRows] = useState<any[]>([]); const [status, setStatus] = useState(''); const [q, setQ] = useState(''); const [form, setForm] = useState<any>(null); const [err, setErr] = useState(''); const [archived, setArchived] = useState(false); const [del, setDel] = useState<any>(null);
  const load = () => api(`/bookings?${archived ? 'archived=1&' : ''}${status ? `status=${status}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`).then(setRows);
  useOpenOnNew(() => setForm({ status: 'enquiry', client_id: '', destination: '', travel_start: '', travel_end: '' }));
  useEffect(() => { load(); }, [status, q, archived]);
  const create = async () => { try { const r = await api('/bookings', 'POST', { ...form, client_id: Number(form.client_id), travel_start: form.travel_start || null, travel_end: form.travel_end || null }); nav(`/bookings/${r.id}`); } catch (e: any) { setErr(e.message); } };
  return (
    <Page title="Bookings" actions={<><input className="input w-48" placeholder="Search ref / destination" value={q} onChange={(e) => setQ(e.target.value)} />
      <select className="input w-44" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
      <div className="inline-flex rounded-lg border border-line p-0.5 text-sm" role="group" aria-label="Show">{([false, true] as const).map((a) => <button key={String(a)} className={`px-3 py-1 rounded-md ${archived === a ? 'bg-accent text-accent-ink' : 'text-muted'}`} onClick={() => setArchived(a)}>{a ? 'Deleted' : 'Active'}</button>)}</div>
      {can('admin', 'finance_manager', 'agent') && <button className="btn" onClick={() => setForm({ status: 'enquiry', client_id: '', destination: '', travel_start: '', travel_end: '' })}><Plus size={15} /> New booking</button>}</>}>
      <Table rows={rows} onRow={(r) => nav(`/bookings/${r.id}`)} cols={[
        { h: 'Reference', render: (r) => <span className="num">{r.reference}</span> }, { h: 'Client', render: (r) => r.client_name }, { h: 'Destination', render: (r) => r.destination }, { h: 'Travel', render: (r) => <span className="num">{r.travel_start ?? '—'}</span> },
        { h: 'Status', render: (r) => <Pill s={r.status} /> }, { h: 'Agent', render: (r) => r.agent_name }, { h: 'Selling (net)', right: true, render: (r) => money(r.selling_net, r.currency) },
        { h: 'Margin', right: true, render: (r) => (r.selling_net > 0 ? `${(((r.selling_net - r.cost) / r.selling_net) * 100).toFixed(1)}%` : '—') },
        { h: '', render: (r) => (archived ? (can('admin', 'finance_manager') && <button className="btn-ghost" onClick={async (e) => { e.stopPropagation(); try { await api(`/bookings/${r.id}/restore`, 'POST', {}); load(); } catch (x: any) { setErr(x.message); } }}><ArchiveRestore size={14} /> Restore</button>) : (can('admin', 'finance_manager', 'agent') && <button className="btn-ghost text-danger" aria-label={`Delete ${r.reference}`} onClick={(e) => { e.stopPropagation(); setDel(r); }}><Archive size={14} /></button>)) }]} empty={archived ? 'No deleted bookings' : 'No bookings yet'} />
      <Err e={form ? '' : err} />{del && <DeleteBooking b={del} onClose={() => setDel(null)} onDone={() => { setDel(null); load(); }} />}
      {form && <Modal title="New booking" onClose={() => setForm(null)}><Err e={err} />
        <Field label="Client *"><select className="input" value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })}><option value="">Select…</option>{clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Destination"><input className="input" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Travel start"><input className="input num" type="date" value={form.travel_start} onChange={(e) => setForm({ ...form, travel_start: e.target.value })} /></Field><Field label="Travel end"><input className="input num" type="date" value={form.travel_end} onChange={(e) => setForm({ ...form, travel_end: e.target.value })} /></Field></div>
        <div className="flex justify-end"><button className="btn" disabled={!form.client_id} onClick={create}>Create</button></div></Modal>}
    </Page>
  );
}

export function BookingWorkspace() {
  const { id } = useParams(); const nav = useNavigate(); const { can } = useAuth();
  const suppliers = useList('/suppliers'); const allTravellers = useList('/travellers');
  const [b, setB] = useState<any>(null); const [tab, setTab] = useState('Overview'); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const [status, setStatus] = useState(''); const [reason, setReason] = useState(''); const [editing, setEditing] = useState(false); const [deleting, setDeleting] = useState(false);
  const [comp, setComp] = useState<any>(null); const [item, setItem] = useState<any>(null); const [trv, setTrv] = useState<any>(null); const [note, setNote] = useState('');
  const load = () => api(`/bookings/${id}`).then((d) => { setB(d); setStatus(d.status); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (!b) return <Page title="Booking">{err ? <Err e={err} /> : <div className="text-muted">Loading…</div>}</Page>;
  const write = can('admin', 'finance_manager', 'agent'); const f = b.finance;
  const run = async (fn: () => Promise<any>, ok = '') => { try { await fn(); setErr(''); setMsg(ok); await load(); } catch (e: any) { setErr(e.message); setMsg(''); } };
  const changeStatus = () => run(async () => { await api(`/bookings/${id}`, 'PUT', { status, reason: reason || undefined }); setReason(''); }, 'Status updated');
  const saveComp = () => run(async () => {
    const { id: cid, ...c } = comp; const body = { product_type: c.product_type, supplier_id: c.supplier_id ? Number(c.supplier_id) : null, supplier_ref: c.supplier_ref || null, description: c.description, service_start: c.service_start || null, service_end: c.service_end || null, quantity: Number(c.quantity), unit_cost: Number(c.unit_cost), markup_pct: Number(c.markup_pct), discount_pct: Number(c.discount_pct), tax_rate: Number(c.tax_rate), confirmation_status: c.confirmation_status, ticketing_status: c.ticketing_status, fulfilment_status: c.fulfilment_status, reason: c.reason || undefined };
    cid ? await api(`/bookings/${id}/components/${cid}`, 'PUT', body) : await api(`/bookings/${id}/components`, 'POST', body); setComp(null);
  }, 'Component saved');
  const tabs = ['Overview', 'Itinerary', 'Travellers', 'Components', 'Finance', 'Activity'];
  const days = [...new Set(b.itinerary.map((i: any) => i.day_no))] as number[];
  return (
    <Page title={`${b.reference} · ${b.destination ?? ''}`} actions={<><button className="btn-ghost" onClick={() => nav('/bookings')}>← Bookings</button>{write && !b.archived_at && <button className="btn-ghost" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button>}{write && !b.archived_at && <button className="btn-ghost text-danger" onClick={() => setDeleting(true)}><Archive size={14} /> Delete</button>}{b.archived_at && can('admin', 'finance_manager') && <button className="btn" onClick={() => run(() => api(`/bookings/${id}/restore`, 'POST', {}), 'Booking restored')}><ArchiveRestore size={14} /> Restore</button>}{b.quote_id && <button className="btn-ghost" onClick={() => nav(`/quotes/${b.quote_id}`)}>Source quote</button>}</>}>
      <Err e={err} />{msg && <div className="text-accent text-sm mb-3">{msg}</div>}
      {b.archived_at && <div className="rounded-lg border border-danger/30 bg-danger/10 text-danger text-sm p-3 mb-3">This booking was deleted on {String(b.archived_at).slice(0, 10)}{b.archive_reason ? ` — “${b.archive_reason}”` : ''}. It is read-only until restored.</div>}
      {editing && <EditBooking b={b} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setMsg('Booking updated'); load(); }} />}
      {deleting && <DeleteBooking b={b} onClose={() => setDeleting(false)} onDone={() => nav('/bookings')} />}
      <div className="card flex flex-wrap gap-x-8 gap-y-2 items-center mb-4 text-sm">
        <div><div className="text-xs text-muted">Client</div>{b.client?.name}</div><div><div className="text-xs text-muted">Travel</div><span className="num">{b.travel_start ?? '—'} → {b.travel_end ?? '—'}</span></div>
        <div><div className="text-xs text-muted">Booking status</div><Pill s={b.status} /></div>
        <div><div className="text-xs text-muted">Suppliers</div>{Object.entries(b.statuses.supplier_confirmation).map(([k, v]) => `${v} ${k}`).join(' · ') || '—'}</div>
        <div><div className="text-xs text-muted">Ticketing</div>{Object.entries(b.statuses.ticketing).filter(([k]) => k !== 'not_applicable').map(([k, v]) => `${v} ${k}`).join(' · ') || 'n/a'}</div>
        <div><div className="text-xs text-muted">Payment</div>{b.statuses.payment.replace('_', ' ')}</div>
        {write && <div className="ml-auto flex gap-2 items-center"><select className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
          <button className="btn" disabled={status === b.status} onClick={changeStatus}>Update</button></div>}</div>
      <div className="flex gap-1 border-b border-line mb-4">{tabs.map((t) => <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm ${tab === t ? 'text-accent border-b-2 border-accent' : 'text-muted'}`}>{t}{t === 'Components' ? ` (${b.components.length})` : t === 'Travellers' ? ` (${b.travellers.length})` : ''}</button>)}</div>

      {tab === 'Overview' && <div className="grid lg:grid-cols-3 gap-4">
        <div className="card lg:col-span-2 text-sm space-y-1"><div><span className="text-muted">Channel</span> {b.channel ?? '—'} · <span className="text-muted">Purpose</span> {b.trip_purpose ?? '—'}</div><div className="whitespace-pre-wrap">{b.notes}</div>
          <h4 className="font-bold pt-3">Tasks</h4>{b.tasks.map((k: any) => <div key={k.id} className="flex justify-between"><span className={k.status === 'done' ? 'line-through text-muted' : ''}>{k.title} <span className="text-muted num">{k.due_at}</span></span>{k.status === 'open' && <button className="text-accent" onClick={() => run(() => api(`/crm/tasks/${k.id}/complete`, 'POST', {}))}>Done</button>}</div>)}
          {write && <div className="flex gap-2 pt-2"><input className="input" placeholder="New task…" value={note} onChange={(e) => setNote(e.target.value)} /><button className="btn-ghost" disabled={!note} onClick={() => run(async () => { await api('/crm/tasks', 'POST', { title: note, entity_type: 'booking', entity_id: b.id }); setNote(''); })}>Add task</button></div>}</div>
        <div className="card text-sm space-y-1"><h4 className="font-bold mb-1">Snapshot</h4><div className="flex justify-between"><span className="text-muted">Selling total</span><span className="num">{money(f.selling_total, f.currency)}</span></div><div className="flex justify-between"><span className="text-muted">Supplier cost</span><span className="num">{money(f.supplier_cost, f.currency)}</span></div><div className="flex justify-between"><span className="text-muted">Margin</span><span className="num">{f.margin_pct ?? '—'}%</span></div><div className="flex justify-between"><span className="text-muted">Outstanding</span><span className="num">{money(f.outstanding, f.currency)}</span></div></div></div>}

      {tab === 'Itinerary' && <div>{write && <button className="btn mb-3" onClick={() => setItem({ day_no: days.length ? Math.max(...days) : 1, title: '', start_time: '', location: '', component_id: '' })}><Plus size={15} /> Add item</button>}
        {days.length === 0 && <div className="text-muted text-sm">No itinerary yet.</div>}
        {days.map((d) => <div key={d} className="card mb-3"><div className="font-bold mb-2">Day {d}</div>{b.itinerary.filter((i: any) => i.day_no === d).map((i: any) => (
          <div key={i.id} className="flex gap-3 text-sm py-1 border-t border-line"><span className="num w-14 text-muted">{i.start_time?.slice(0, 5) ?? ''}</span><div className="flex-1"><div>{i.title} {!i.confirmed && <span className="text-xs text-warn">(unconfirmed)</span>}</div><div className="text-xs text-muted">{i.location}</div></div>
            {write && <button className="text-danger text-xs" onClick={() => run(() => api(`/bookings/${id}/itinerary/${i.id}`, 'DELETE'))} aria-label="Remove"><X size={14} /></button>}</div>))}</div>)}</div>}

      {tab === 'Travellers' && <div>{write && <div className="flex gap-2 mb-3"><select className="input w-64" value={trv?.traveller_id ?? ''} onChange={(e) => setTrv({ ...trv, traveller_id: e.target.value })}><option value="">Add existing traveller…</option>{allTravellers.map((t: any) => <option key={t.id} value={t.id}>{t.first_name} {t.last_name}</option>)}</select>
        <button className="btn-ghost" disabled={!trv?.traveller_id} onClick={() => run(async () => { await api(`/bookings/${id}/travellers`, 'POST', { traveller_id: Number(trv.traveller_id) }); setTrv(null); })}>Add</button>
        <button className="btn" onClick={() => setTrv({ new: true, first_name: '', last_name: '', passport_no: '', passport_expiry: '', nationality: '', notes: '' })}><Plus size={15} /> New traveller</button></div>}
        <Table rows={b.travellers} cols={[{ h: 'Name', render: (t: any) => `${t.first_name} ${t.last_name}` }, { h: 'Nationality', render: (t: any) => t.nationality }, { h: 'Passport', render: (t: any) => <span className="num">{t.passport ?? '—'}</span> },
          { h: 'Expires', render: (t: any) => <span className="num">{t.passport_expiry ?? '—'}</span> }, { h: 'Notes', render: (t: any) => t.notes }, { h: '', render: (t: any) => write && <button className="text-danger text-xs" onClick={() => run(() => api(`/bookings/${id}/travellers/${t.id}`, 'DELETE'))}>Remove</button> }]} /></div>}

      {tab === 'Components' && <div>{write && <button className="btn mb-3" onClick={() => setComp({ product_type: 'hotel', description: '', quantity: 1, unit_cost: 0, markup_pct: 15, discount_pct: 0, tax_rate: 0 })}><Plus size={15} /> Add component</button>}
        <Table rows={b.components} onRow={write ? (c) => setComp({ ...c, supplier_id: c.supplier_id ?? '' }) : undefined} cols={[
          { h: 'Type', render: (c: any) => c.product_type }, { h: 'Description', render: (c: any) => c.description }, { h: 'Supplier', render: (c: any) => c.supplier_name }, { h: 'Dates', render: (c: any) => <span className="num">{c.service_start ?? '—'}</span> },
          { h: 'Confirmed', render: (c: any) => <Pill s={c.confirmation_status} /> }, { h: 'Ticketing', render: (c: any) => (c.ticketing_status === 'not_applicable' ? '—' : <Pill s={c.ticketing_status} />) },
          { h: 'Selling', right: true, render: (c: any) => money(c.net_total + c.tax_total, f.currency) }, { h: 'Cost', right: true, render: (c: any) => money(c.cost_total, f.currency) }]} /></div>}

      {tab === 'Finance' && <div className="grid lg:grid-cols-2 gap-4">
        <div className="card text-sm space-y-1"><h4 className="font-bold mb-1">Profitability ({f.currency})</h4>
          {([['Selling net', f.selling_net], ['Tax', f.tax], ['Selling total', f.selling_total], ['Supplier cost', f.supplier_cost], ['Gross margin', f.gross_margin], ['Overhead', f.overhead], ['Contribution', f.contribution]] as [string, number][]).map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-muted">{k}</span><span className="num">{money(v, f.currency)}</span></div>)}
          <div className="flex justify-between"><span className="text-muted">Margin %</span><span className="num">{f.margin_pct ?? '—'}%</span></div><p className="text-xs text-muted pt-2">{f.note}</p></div>
        <div className="card text-sm space-y-1"><h4 className="font-bold mb-1">Receivables</h4>
          {([['Invoiced', f.invoiced], ['Paid', f.paid], ['Outstanding', f.outstanding], ['Not yet invoiced', f.not_yet_invoiced]] as [string, number][]).map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-muted">{k}</span><span className="num">{money(v, f.currency)}</span></div>)}
          {f.other_currency_invoices > 0 && <div className="text-xs text-warn">{f.other_currency_invoices} invoice(s) in another currency are excluded from these totals.</div>}
          <div className="pt-2">{b.invoices.map((i: any) => <div key={i.id} className="flex justify-between"><span className="num">{i.number}</span><span>{i.status}</span><span className="num">{money(i.total, i.currency)}</span></div>)}</div></div></div>}

      {tab === 'Activity' && <div className="grid lg:grid-cols-2 gap-4">
        <div className="card"><h4 className="font-bold text-sm mb-2">Change log</h4><div className="space-y-2 text-xs max-h-96 overflow-auto">{b.changes.map((c: any) => <div key={c.id}><b>{c.field}</b>: <span className="text-muted">{c.old_value ?? '∅'}</span> → {c.new_value ?? '∅'}{c.reason && <span className="text-warn"> — “{c.reason}”</span>}<div className="text-muted">{c.user_name} · {new Date(c.created_at).toLocaleString()}</div></div>)}{!b.changes.length && <div className="text-muted">No changes yet</div>}</div></div>
        <div className="card"><h4 className="font-bold text-sm mb-2">Notes & activity</h4>{write && <div className="flex gap-2 mb-2"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" /><button className="btn-ghost" disabled={!note} onClick={() => run(async () => { await api('/crm/activities', 'POST', { entity_type: 'booking', entity_id: b.id, body: note }); setNote(''); })}>Add</button></div>}
          <div className="space-y-2 text-xs max-h-80 overflow-auto">{b.activities.map((a: any) => <div key={a.id}>{a.body}<div className="text-muted">{a.user_name ?? 'System'} · {new Date(a.created_at).toLocaleString()}</div></div>)}</div></div></div>}

      {comp && <Modal title={comp.id ? 'Edit component' : 'Add component'} onClose={() => setComp(null)}>
        <div className="grid grid-cols-2 gap-x-4">
          <Field label="Type"><select className="input" value={comp.product_type} onChange={(e) => setComp({ ...comp, product_type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Supplier"><select className="input" value={comp.supplier_id ?? ''} onChange={(e) => setComp({ ...comp, supplier_id: e.target.value })}><option value="">—</option>{suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <div className="col-span-2"><Field label="Description"><input className="input" value={comp.description} onChange={(e) => setComp({ ...comp, description: e.target.value })} /></Field></div>
          <Field label="Supplier reference"><input className="input" value={comp.supplier_ref ?? ''} onChange={(e) => setComp({ ...comp, supplier_ref: e.target.value })} /></Field>
          <Field label="Service start"><input className="input num" type="date" value={comp.service_start ?? ''} onChange={(e) => setComp({ ...comp, service_start: e.target.value })} /></Field>
          {(['quantity', 'unit_cost', 'markup_pct', 'discount_pct', 'tax_rate'] as const).map((k) => <Field key={k} label={k.replace('_', ' ')}><Num v={comp[k]} set={(v) => setComp({ ...comp, [k]: v === '' ? 0 : v })} /></Field>)}
          {comp.id && <><Field label="Supplier confirmation"><select className="input" value={comp.confirmation_status} onChange={(e) => setComp({ ...comp, confirmation_status: e.target.value })}>{['pending', 'requested', 'confirmed', 'waitlisted', 'cancelled'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Ticketing"><select className="input" value={comp.ticketing_status} onChange={(e) => setComp({ ...comp, ticketing_status: e.target.value })}>{['not_applicable', 'pending', 'ticketed'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Fulfilment"><select className="input" value={comp.fulfilment_status} onChange={(e) => setComp({ ...comp, fulfilment_status: e.target.value })}>{['pending', 'in_progress', 'done'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Reason for change"><input className="input" value={comp.reason ?? ''} onChange={(e) => setComp({ ...comp, reason: e.target.value })} /></Field></>}
        </div>
        <div className="flex justify-between">{comp.id ? <button className="btn-ghost text-danger" onClick={() => run(async () => { await api(`/bookings/${id}/components/${comp.id}`, 'DELETE'); setComp(null); })}>Remove</button> : <span />}<button className="btn" disabled={!comp.description} onClick={saveComp}>Save</button></div></Modal>}
      {item && <Modal title="Itinerary item" onClose={() => setItem(null)}><div className="grid grid-cols-2 gap-x-4">
        <Field label="Day"><Num v={item.day_no} set={(v) => setItem({ ...item, day_no: v || 1 })} /></Field><Field label="Time"><input className="input num" type="time" value={item.start_time} onChange={(e) => setItem({ ...item, start_time: e.target.value })} /></Field>
        <div className="col-span-2"><Field label="Title"><input className="input" value={item.title} onChange={(e) => setItem({ ...item, title: e.target.value })} /></Field></div>
        <div className="col-span-2"><Field label="Location / meeting point"><input className="input" value={item.location} onChange={(e) => setItem({ ...item, location: e.target.value })} /></Field></div>
        <Field label="Linked component"><select className="input" value={item.component_id} onChange={(e) => setItem({ ...item, component_id: e.target.value })}><option value="">—</option>{b.components.map((c: any) => <option key={c.id} value={c.id}>{c.description}</option>)}</select></Field>
        <label className="flex items-center gap-2 text-sm mt-6"><input type="checkbox" checked={!!item.confirmed} onChange={(e) => setItem({ ...item, confirmed: e.target.checked })} /> Confirmed</label></div>
        <div className="flex justify-end"><button className="btn" disabled={!item.title} onClick={() => run(async () => { await api(`/bookings/${id}/itinerary`, 'POST', { ...item, start_time: item.start_time || null, component_id: item.component_id ? Number(item.component_id) : null }); setItem(null); })}>Save</button></div></Modal>}
      {trv?.new && <Modal title="New traveller" onClose={() => setTrv(null)}><div className="grid grid-cols-2 gap-x-4">
        <Field label="First name"><input className="input" value={trv.first_name} onChange={(e) => setTrv({ ...trv, first_name: e.target.value })} /></Field><Field label="Last name"><input className="input" value={trv.last_name} onChange={(e) => setTrv({ ...trv, last_name: e.target.value })} /></Field>
        <Field label="Passport no. (stored encrypted)"><input className="input num" value={trv.passport_no} onChange={(e) => setTrv({ ...trv, passport_no: e.target.value })} autoComplete="off" /></Field><Field label="Passport expiry"><input className="input num" type="date" value={trv.passport_expiry} onChange={(e) => setTrv({ ...trv, passport_expiry: e.target.value })} /></Field>
        <Field label="Nationality"><input className="input" value={trv.nationality} onChange={(e) => setTrv({ ...trv, nationality: e.target.value })} /></Field><Field label="Dietary / accessibility"><input className="input" value={trv.notes} onChange={(e) => setTrv({ ...trv, notes: e.target.value })} /></Field></div>
        <div className="flex justify-end"><button className="btn" disabled={!trv.first_name || !trv.last_name} onClick={() => run(async () => { const r = await api('/travellers', 'POST', { client_id: b.client_id, first_name: trv.first_name, last_name: trv.last_name, passport_no: trv.passport_no || null, passport_expiry: trv.passport_expiry || null, nationality: trv.nationality || null, notes: trv.notes || null }); await api(`/bookings/${id}/travellers`, 'POST', { traveller_id: r.id }); setTrv(null); })}>Save & add</button></div></Modal>}
    </Page>
  );
}
