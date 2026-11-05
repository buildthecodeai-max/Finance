import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Pill, Skeleton, Table } from '../components/ui';
import { ClientPick } from '../components/ClientPick';
import { isoDate, today, useList, useOpenOnNew } from '../lookup';
import { AlertTriangle, Archive, ArchiveRestore, CheckCircle2, FilePlus2, Pencil, Plus, Search, X } from 'lucide-react';

const STATUSES = ['enquiry', 'quoted', 'awaiting_client', 'confirmed', 'in_service', 'travel_completed', 'closed', 'on_hold', 'cancelled', 'refunded', 'lost'];
const LABEL: Record<string, string> = { enquiry: 'Enquiry', quoted: 'Quoted', awaiting_client: 'Awaiting client', confirmed: 'Confirmed', in_service: 'Travelling', travel_completed: 'Trip completed', closed: 'Closed', on_hold: 'On hold', cancelled: 'Cancelled', refunded: 'Refunded', lost: 'Lost' };
const FLOW = ['enquiry', 'quoted', 'awaiting_client', 'confirmed', 'in_service', 'travel_completed', 'closed'];
const NEXT: Record<string, string> = { enquiry: 'Mark as quoted', quoted: 'Quote sent — awaiting client', awaiting_client: 'Client confirmed', confirmed: 'Travel has started', in_service: 'Trip completed', travel_completed: 'Close booking' };
const NEEDS_REASON = ['cancelled', 'lost', 'on_hold', 'refunded'];
const TERMINAL = ['closed', 'cancelled', 'refunded', 'lost'];
const TYPES = ['flight', 'hotel', 'package', 'cruise', 'transfer', 'tour', 'rail', 'car', 'insurance', 'visa', 'fee', 'other'];
const PAYMENT: Record<string, string> = { not_invoiced: 'Not invoiced yet', unpaid: 'Unpaid', part_paid: 'Part paid', paid: 'Paid in full' };

const r2 = (n: number) => Math.round(n * 100) / 100;
const day = (d: any) => (d ? String(d).slice(0, 10) : '');
const daysFrom = (d: any) => Math.round((Date.parse(day(d)) - Date.parse(today())) / 864e5);
const nice = (d: any) => (d ? new Date(`${day(d)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const niceDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const margin = (net: number, cost: number) => (net > 0 ? `${(((net - cost) / net) * 100).toFixed(1)}%` : '—');

/** "in 12 days", "Travelling now", "Returned 3 days ago" — empty when there are no dates. */
function when(start: any, end: any): { text: string; tone: 'soon' | 'now' | 'past' | 'later' | '' } {
  if (!start) return { text: '', tone: '' };
  const a = daysFrom(start), b = end ? daysFrom(end) : a;
  if (a > 0) return { text: a === 1 ? 'tomorrow' : `in ${a} days`, tone: a <= 30 ? 'soon' : 'later' };
  if (b >= 0) return { text: a === 0 ? 'leaves today' : 'travelling now', tone: 'now' };
  return { text: b === -1 ? 'returned yesterday' : `returned ${-b} days ago`, tone: 'past' };
}
const whenTone = { soon: 'text-warn', now: 'text-success', past: 'text-muted', later: 'text-muted', '': '' } as const;
const dateRangeError = (s: string, e: string) => (s && e && e < s ? 'The end date is before the start date.' : '');

const Banner = ({ ok, children, onClose }: { ok: boolean; children: any; onClose?(): void }) => (
  <div role={ok ? 'status' : 'alert'} className={`rounded-lg border text-sm px-3 py-2 mb-3 flex justify-between gap-3 ${ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>
    <span>{children}</span>{onClose && <button className="opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={onClose}><X size={14} /></button>}</div>
);

/** Edit the details of an existing booking. Changes are written to the booking's change log, so a reason is required. */
function EditBooking({ b, onClose, onSaved }: { b: any; onClose(): void; onSaved(): void }) {
  const clients = useList('/clients'); const agents = useList('/team/agents'); const branches = useList('/accounting/branches');
  const [f, setF] = useState<any>({ client_id: b.client_id, agent_id: b.agent_id ?? '', branch_id: b.branch_id ?? '', destination: b.destination ?? '', travel_start: day(b.travel_start), travel_end: day(b.travel_end),
    channel: b.channel ?? '', trip_purpose: b.trip_purpose ?? '', overhead: b.overhead ?? 0, notes: b.notes ?? '', reason: '' });
  const [err, setErr] = useState(''); const { can } = useAuth(); const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const bad = dateRangeError(f.travel_start, f.travel_end);
  const save = async () => {
    try { await api(`/bookings/${b.id}`, 'PUT', { client_id: Number(f.client_id), ...(can('admin', 'finance_manager') ? { agent_id: f.agent_id ? Number(f.agent_id) : null, branch_id: f.branch_id ? Number(f.branch_id) : null } : {}),
      destination: f.destination || null, travel_start: f.travel_start || null, travel_end: f.travel_end || null, channel: f.channel || null, trip_purpose: f.trip_purpose || null, overhead: Number(f.overhead) || 0, notes: f.notes || null, reason: f.reason || undefined }); onSaved(); }
    catch (e: any) { setErr(e.message); }
  };
  const clientOpts = clients.some((c: any) => c.id === b.client_id) ? clients : [{ id: b.client_id, name: b.client?.name ?? b.client_name ?? `Client #${b.client_id}` }, ...clients];
  return <Modal title={`Edit ${b.reference}`} onClose={onClose}><Err e={err} />
    <div className="grid sm:grid-cols-2 gap-x-4"><div className="sm:col-span-2"><Field label="Client"><select className="input" value={f.client_id} onChange={set('client_id')}>{clientOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field></div>
      <Field label="Destination"><input className="input" value={f.destination} onChange={set('destination')} placeholder="e.g. Bali, Indonesia" /></Field><Field label="How did they find you?" hint="Web, phone, referral…"><input className="input" value={f.channel} onChange={set('channel')} /></Field>
      <Field label="Travel start"><input className="input num" type="date" value={f.travel_start} onChange={set('travel_start')} /></Field><Field label="Travel end"><input className="input num" type="date" min={f.travel_start || undefined} value={f.travel_end} onChange={set('travel_end')} /></Field>
      {can('admin', 'finance_manager') && <><Field label="Agent"><select className="input" value={f.agent_id} onChange={set('agent_id')}><option value="">Unassigned</option>{agents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Branch"><select className="input" value={f.branch_id} onChange={set('branch_id')}><option value="">None</option>{branches.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field></>}
      <Field label="Trip purpose" hint="Leisure, business…"><input className="input" value={f.trip_purpose} onChange={set('trip_purpose')} /></Field><Field label="Overhead" hint="Your own cost to serve this booking"><input className="input num" type="number" min={0} step="0.01" value={f.overhead} onChange={set('overhead')} /></Field>
      <div className="sm:col-span-2"><Field label="Notes"><textarea className="input" rows={3} value={f.notes} onChange={set('notes')} /></Field></div>
      <div className="sm:col-span-2"><Field label="Reason for the change (optional)" hint="Kept in the booking's change log"><input className="input" value={f.reason} onChange={set('reason')} /></Field></div></div>
    {bad && <p role="alert" className="text-sm text-danger mb-2">{bad}</p>}
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={!f.client_id || !!bad} onClick={save}>Save changes</button></div></Modal>;
}

/** "Delete" = archive: the booking leaves lists and reports but its history is kept and it can be restored. Live invoices/bills block it. */
function DeleteBooking({ b, onClose, onDone }: { b: any; onClose(): void; onDone(): void }) {
  const [u, setU] = useState<any>(null); const [reason, setReason] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { api(`/bookings/${b.id}/usage`).then(setU).catch((e) => setErr(e.message)); }, []);
  const blocked = u?.live?.length > 0;
  return <Modal title={`Delete ${b.reference}?`} onClose={onClose}><Err e={err} />
    {blocked ? <p className="text-sm mb-3">This booking has <b>{u.live.map((d: any) => `${d.n} ${d.label}`).join(' and ')}</b> that aren't void. Void or credit them first — or set the booking to <b>Cancelled</b> to keep the history without deleting.</p>
      : <><p className="text-sm mb-3">The booking is removed from lists and reports and its estimated commission is reversed. Everything stays in the audit trail and you can restore it later.</p>
        <Field label="Reason (optional)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. entered twice" /></Field></>}
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn bg-danger text-white" disabled={blocked || !u} onClick={async () => { try { await api(`/bookings/${b.id}`, 'DELETE', { reason: reason.trim() || undefined }); onDone(); } catch (e: any) { setErr(e.message); } }}>Delete booking</button></div></Modal>;
}

/** The views people think in, instead of eleven raw status codes. */
const OPEN = ['enquiry', 'quoted', 'awaiting_client'];
const soon = (r: any) => !TERMINAL.includes(r.status) && r.status !== 'on_hold' && r.travel_start && daysFrom(r.travel_start) >= 0 && daysFrom(r.travel_start) <= 30;
const TABS: { key: string; label: string; test: (r: any) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'open', label: 'Enquiries & quotes', test: (r) => OPEN.includes(r.status) },
  { key: 'confirmed', label: 'Confirmed', test: (r) => r.status === 'confirmed' },
  { key: 'soon', label: 'Departing soon', test: soon },
  { key: 'travelling', label: 'Travelling', test: (r) => r.status === 'in_service' },
  { key: 'done', label: 'Completed', test: (r) => r.status === 'travel_completed' || r.status === 'closed' },
  { key: 'stopped', label: 'On hold / cancelled', test: (r) => ['on_hold', 'cancelled', 'refunded', 'lost'].includes(r.status) },
  { key: 'deleted', label: 'Deleted', test: () => true },
];

export function BookingList() {
  const nav = useNavigate(); const { can } = useAuth(); const clients = useList('/clients');
  const [sp, setSp] = useSearchParams();
  const [rows, setRows] = useState<any[] | null>(null);
  const [tab, setTab] = useState(TABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab')! : 'all'); const [q, setQ] = useState('');
  const [form, setForm] = useState<any>(null); const [err, setErr] = useState(''); const [del, setDel] = useState<any>(null); const [note, setNote] = useState('');
  const archived = tab === 'deleted'; const editor = can('admin', 'finance_manager', 'agent'); const writer = can('admin', 'finance_manager');
  const load = () => api(`/bookings?${archived ? 'archived=1&' : ''}${q.trim() ? `q=${encodeURIComponent(q.trim())}` : ''}`).then((r) => { setRows(r); setErr(''); }).catch((e) => { setErr(e.message); setRows([]); });
  const blank = () => ({ status: 'enquiry', client_id: sp.get('client') ?? '', destination: '', travel_start: '', travel_end: '' });
  useOpenOnNew(() => setForm(blank()));
  useEffect(() => { if (sp.get('client') && editor) { setForm(blank()); const n = new URLSearchParams(sp); n.delete('client'); setSp(n, { replace: true }); } }, []);
  useEffect(() => { setRows(null); const h = setTimeout(load, q ? 300 : 0); return () => clearTimeout(h); }, [q, archived]);

  const all = rows ?? [];
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, all.filter(t.test).length])), [rows]);
  const shown = useMemo(() => { const t = TABS.find((x) => x.key === tab)!; const l = all.filter(t.test); return tab === 'soon' ? [...l].sort((a, b) => day(a.travel_start).localeCompare(day(b.travel_start))) : l; }, [rows, tab]);
  const departing = all.filter(soon).sort((a, b) => day(a.travel_start).localeCompare(day(b.travel_start)));
  const openList = all.filter(TABS[1].test); const sameCur = new Set(openList.map((r) => r.currency)).size === 1;
  const openValue = r2(openList.reduce((s, r) => s + Number(r.selling_net), 0));
  const travelling = all.filter((r) => r.status === 'in_service');

  const create = async () => {
    try { const r = await api('/bookings', 'POST', { client_id: Number(form.client_id), status: form.status, destination: form.destination.trim() || null, travel_start: form.travel_start || null, travel_end: form.travel_end || null }); nav(`/bookings/${r.id}`); }
    catch (e: any) { setErr(e.message); }
  };
  const bad = form ? dateRangeError(form.travel_start, form.travel_end) : '';
  const stat = (key: string | null, title: string, value: string, sub: string, tone = '') => (
    <button type="button" disabled={!key} onClick={() => key && setTab(key)} className={`card text-left ${key ? 'hover:bg-surface2/70 transition-colors' : 'cursor-default'} ${key && tab === key ? 'ring-1 ring-accent' : ''}`}>
      <div className="text-xs text-muted">{title}</div><div className={`text-xl font-semibold num mt-0.5 ${tone}`}>{value}</div><div className="text-xs text-muted mt-0.5">{sub}</div></button>);

  return (
    <Page title="Bookings" description="Every trip you are selling, from first enquiry to the day the client gets home. Click a booking to see everything about it."
      actions={editor ? <button className="btn inline-flex items-center gap-1" onClick={() => setForm(blank())}><Plus size={16} />New booking</button> : undefined}>
      {!archived && (rows === null ? <div className="grid sm:grid-cols-3 gap-3 mb-4"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div> : (
        <div className="grid sm:grid-cols-3 gap-3 mb-4">
          {stat('open', 'Enquiries & quotes', String(openList.length), sameCur && openList.length ? `${money(openValue, openList[0].currency)} of potential sales` : openList.length ? 'waiting for the client' : 'None waiting')}
          {stat('soon', 'Departing in 30 days', String(departing.length), departing.length ? `Next: ${departing[0].client_name}, ${when(departing[0].travel_start, departing[0].travel_end).text}` : 'No departures soon', departing.length ? 'text-warn' : '')}
          {stat('travelling', 'Travelling now', String(travelling.length), travelling.length ? 'Check in on these clients' : 'Nobody is away')}
        </div>))}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1 basis-full min-w-0" role="tablist" aria-label="Booking views">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
              className={`whitespace-nowrap text-sm px-3 py-1.5 rounded-lg border ${tab === t.key ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>
              {t.label}{rows && t.key !== 'all' && t.key !== 'deleted' && !archived && <span className="ml-1.5 text-xs opacity-70 num">{counts[t.key]}</span>}</button>))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input className="input pl-8" placeholder="Search reference, client or destination…" aria-label="Search bookings" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {note && <Banner ok onClose={() => setNote('')}>{note}</Banner>}
      {!form && <Err e={err} />}
      {archived && <p className="text-sm text-muted mb-3">Deleted bookings are hidden from lists and reports but nothing is lost.{writer ? ' Restore one to bring it back.' : ' Ask finance or an admin to restore one.'}</p>}
      {rows === null ? <Skeleton className="h-64" /> : (
        <Table rows={shown} onRow={(r) => nav(`/bookings/${r.id}`)}
          empty={all.length === 0 ? (archived ? 'No deleted bookings.' : q ? `No booking matches “${q}”.` : editor ? 'No bookings yet — click “New booking” to start your first one.' : 'No bookings yet.') : `Nothing in “${TABS.find((t) => t.key === tab)!.label}”${q ? ` matching “${q}”` : ''}.`}
          cols={[
            { h: 'Booking', render: (r) => <><span className="num font-medium">{r.reference}</span>{r.destination && <div className="text-xs text-muted">{r.destination}</div>}</> },
            { h: 'Client', render: (r) => r.client_name },
            { h: 'Travel', render: (r) => { const w = when(r.travel_start, r.travel_end); return r.travel_start ? <><span className="num whitespace-nowrap">{day(r.travel_start)}{r.travel_end ? ` → ${day(r.travel_end).slice(5)}` : ''}</span>{!archived && !TERMINAL.includes(r.status) && w.text && <div className={`text-xs ${whenTone[w.tone]}`}>{w.text}</div>}</> : <span className="text-muted">No dates yet</span>; } },
            { h: 'Status', render: (r) => <Pill s={r.status} /> },
            { h: 'Agent', render: (r) => r.agent_name ?? <span className="text-muted">Unassigned</span> },
            { h: 'Selling', right: true, render: (r) => (r.selling_net > 0 ? money(r.selling_net, r.currency) : <span className="text-muted">Nothing added</span>) },
            { h: 'Margin', right: true, render: (r) => margin(r.selling_net, r.cost) },
            { h: '', render: (r) => <div className="whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>{archived
              ? (writer && <button className="btn-ghost inline-flex items-center gap-1" onClick={async () => { try { await api(`/bookings/${r.id}/restore`, 'POST', {}); setNote(`${r.reference} was restored.`); load(); } catch (x: any) { setErr(x.message); } }}><ArchiveRestore size={14} /> Restore</button>)
              : (editor && <button className="btn-ghost text-danger" title="Delete booking" aria-label={`Delete ${r.reference}`} onClick={() => setDel(r)}><Archive size={14} /></button>)}</div> }]} />
      )}
      {rows && rows.length >= 500 && <p className="text-xs text-muted mt-2">Showing the latest 500 bookings. Use the search box to find older ones.</p>}
      {del && <DeleteBooking b={del} onClose={() => setDel(null)} onDone={() => { setNote(`${del.reference} was deleted. You can restore it from the Deleted tab.`); setDel(null); load(); }} />}
      {form && <Modal title="New booking" onClose={() => { setForm(null); setErr(''); }}><Err e={err} />
        <Field label="Who is travelling? (client)" hint="Not in the list? Add them on the Clients page first."><ClientPick clients={clients} value={form.client_id} onChange={(id) => setForm({ ...form, client_id: id })} autoFocus /></Field>
        <Field label="Destination"><input className="input" placeholder="e.g. Bali, Indonesia" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Travel start"><input className="input num" type="date" value={form.travel_start} onChange={(e) => setForm({ ...form, travel_start: e.target.value })} /></Field><Field label="Travel end"><input className="input num" type="date" min={form.travel_start || undefined} value={form.travel_end} onChange={(e) => setForm({ ...form, travel_end: e.target.value })} /></Field></div>
        <Field label="Where is it at?"><select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{['enquiry', 'quoted', 'awaiting_client', 'confirmed'].map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}</select></Field>
        {bad && <p role="alert" className="text-sm text-danger mb-2">{bad}</p>}
        <p className="text-xs text-muted mb-3">You'll add flights, hotels and other items on the next screen.</p>
        <div className="flex justify-end"><button className="btn" disabled={!form.client_id || !!bad} onClick={create}>Create booking</button></div></Modal>}
    </Page>
  );
}

/** What the person looking at this booking probably needs to do next. */
function todo(b: any): { text: string; tab?: string; link?: [string, string] }[] {
  if (b.archived_at || TERMINAL.includes(b.status) || b.status === 'on_hold') return [];
  const f = b.finance, out: { text: string; tab?: string; link?: [string, string] }[] = [];
  const quoting = OPEN.includes(b.status);
  if (!b.components.length) out.push({ text: 'Nothing has been added to this booking yet — add what the client is buying.', tab: 'Components' });
  const unconfirmed = b.components.filter((c: any) => ['pending', 'requested', 'waitlisted'].includes(c.confirmation_status)).length;
  if (unconfirmed && !quoting) out.push({ text: `${plural(unconfirmed, 'item')} not yet confirmed by the supplier.`, tab: 'Components' });
  const toTicket = b.components.filter((c: any) => c.ticketing_status === 'pending').length;
  if (toTicket && !quoting) out.push({ text: `${plural(toTicket, 'ticket')} still to be issued.`, tab: 'Components' });
  if (!b.travellers.length && !quoting) out.push({ text: 'No travellers have been added yet.', tab: 'Travellers' });
  const end = day(b.travel_end || b.travel_start);
  if (end) {
    const limit = new Date(`${end}T00:00:00`); limit.setMonth(limit.getMonth() + 6); const lim = isoDate(limit);
    for (const t of b.travellers) if (t.passport_expiry && day(t.passport_expiry) < lim)
      out.push({ text: `${t.first_name} ${t.last_name}'s passport ${day(t.passport_expiry) < today() ? 'has expired' : `expires ${nice(t.passport_expiry)}`} — many countries need 6 months' validity after the trip.`, tab: 'Travellers' });
  }
  if (f.not_yet_invoiced > 0.005 && !quoting) out.push({ text: `${money(f.not_yet_invoiced, f.currency)} has not been invoiced yet.`, link: [`/invoices?booking=${b.id}`, 'Create invoice'] });
  if (f.outstanding > 0.005) out.push({ text: `${money(f.outstanding, f.currency)} has been invoiced but not paid.`, link: [`/client-receipts?client=${b.client_id}`, 'Receive payment'] });
  const late = b.tasks.filter((k: any) => k.status === 'open' && k.due_at && day(k.due_at) < today()).length;
  if (late) out.push({ text: `${plural(late, 'task')} overdue.`, tab: 'Overview' });
  return out;
}

export function BookingWorkspace() {
  const { id } = useParams(); const nav = useNavigate(); const { can } = useAuth(); const [sp, setSp] = useSearchParams();
  const suppliers = useList('/suppliers'); const allTravellers = useList('/travellers');
  const tabs = ['Overview', 'Itinerary', 'Travellers', 'Components', 'Finance', 'Activity'];
  const [b, setB] = useState<any>(null); const [tab, setTabState] = useState(tabs.includes(sp.get('tab') ?? '') ? sp.get('tab')! : 'Overview'); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const [status, setStatus] = useState(''); const [reason, setReason] = useState(''); const [editing, setEditing] = useState(false); const [deleting, setDeleting] = useState(false);
  const [comp, setComp] = useState<any>(null); const [item, setItem] = useState<any>(null); const [trv, setTrv] = useState<any>(null); const [note, setNote] = useState(''); const [task, setTask] = useState(''); const [taskDue, setTaskDue] = useState(''); const [confirmDel, setConfirmDel] = useState(false);
  const setTab = (t: string) => { setTabState(t); const n = new URLSearchParams(sp); t === 'Overview' ? n.delete('tab') : n.set('tab', t); setSp(n, { replace: true }); };
  const load = () => api(`/bookings/${id}`).then((d) => { setB(d); setStatus(d.status); }).catch((e) => setErr(e.message));
  useEffect(() => { setB(null); load(); }, [id]);
  if (!b) return <Page title="Booking">{err ? <Err e={err} /> : <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>}</Page>;
  const write = can('admin', 'finance_manager', 'agent'); const finance = can('admin', 'finance_manager'); const f = b.finance; const archived = !!b.archived_at;
  const locked = TERMINAL.includes(b.status); const editable = write && !archived && !locked;
  const run = async (fn: () => Promise<any>, ok = '') => { try { await fn(); setErr(''); setMsg(ok); await load(); } catch (e: any) { setErr(e.message); setMsg(''); } };
  const changeStatus = (to = status) => run(async () => { await api(`/bookings/${id}`, 'PUT', { status: to, reason: reason.trim() || undefined }); setReason(''); }, `Status changed to ${LABEL[to].toLowerCase()}.`);
  const saveComp = () => run(async () => {
    const { id: cid, ...c } = comp; const body = { product_type: c.product_type, supplier_id: c.supplier_id ? Number(c.supplier_id) : null, supplier_ref: c.supplier_ref || null, description: c.description.trim(), service_start: c.service_start || null, service_end: c.service_end || null, quantity: Number(c.quantity), unit_cost: Number(c.unit_cost), markup_pct: Number(c.markup_pct), discount_pct: Number(c.discount_pct), tax_rate: Number(c.tax_rate), confirmation_status: c.confirmation_status, ticketing_status: c.ticketing_status, fulfilment_status: c.fulfilment_status, reason: c.reason || undefined };
    cid ? await api(`/bookings/${id}/components/${cid}`, 'PUT', body) : await api(`/bookings/${id}/components`, 'POST', body); setComp(null);
  }, 'Item saved.');
  const addTask = () => { if (task.trim()) run(async () => { await api('/crm/tasks', 'POST', { title: task.trim(), entity_type: 'booking', entity_id: b.id, ...(taskDue ? { due_at: taskDue } : {}) }); setTask(''); setTaskDue(''); }, 'Task added.'); };
  const days = [...new Set(b.itinerary.map((i: any) => i.day_no))].sort((x: any, y: any) => x - y) as number[];
  const dayDate = (n: number) => { if (!b.travel_start) return ''; const d = new Date(`${day(b.travel_start)}T00:00:00`); d.setDate(d.getDate() + n - 1); return niceDay(d); };
  const w = when(b.travel_start, b.travel_end); const nights = b.travel_start && b.travel_end ? Math.max(0, Math.round((Date.parse(day(b.travel_end)) - Date.parse(day(b.travel_start))) / 864e5)) : null;
  const idx = FLOW.indexOf(b.status); const todos = todo(b); const statusChanged = status !== b.status; const needsReason = statusChanged && NEEDS_REASON.includes(status);
  const canMove = write && !archived && (finance || !locked);
  const openTasks = b.tasks.filter((k: any) => k.status === 'open').length;
  const price = comp ? (() => { const up = r2(Number(comp.unit_cost) * (1 + Number(comp.markup_pct) / 100)), net = r2(up * Number(comp.quantity) * (1 - Number(comp.discount_pct) / 100)); return { net, tax: r2(net * Number(comp.tax_rate) / 100), cost: r2(Number(comp.unit_cost) * Number(comp.quantity)) }; })() : null;
  const compBad = comp ? dateRangeError(comp.service_start ?? '', comp.service_end ?? '') : '';
  const sumNet = b.components.reduce((s: number, c: any) => s + c.net_total, 0), sumCost = b.components.reduce((s: number, c: any) => s + c.cost_total, 0), sumTax = b.components.reduce((s: number, c: any) => s + c.tax_total, 0);

  return (
    <Page title={b.reference} description={[b.client?.name, b.destination].filter(Boolean).join(' · ') || undefined}
      actions={<><button className="btn-ghost" onClick={() => nav('/bookings')}>← Bookings</button>
        {write && !archived && <button className="btn-ghost inline-flex items-center gap-1" onClick={() => nav(`/invoices?booking=${b.id}`)}><FilePlus2 size={14} /> Create invoice</button>}
        {write && !archived && <button className="btn-ghost inline-flex items-center gap-1" onClick={() => setEditing(true)}><Pencil size={14} /> Edit details</button>}
        {write && !archived && <button className="btn-ghost text-danger inline-flex items-center gap-1" onClick={() => setDeleting(true)}><Archive size={14} /> Delete</button>}
        {archived && finance && <button className="btn" onClick={() => run(() => api(`/bookings/${id}/restore`, 'POST', {}), 'Booking restored.')}><ArchiveRestore size={14} /> Restore</button>}
        {b.quote_id && <button className="btn-ghost" onClick={() => nav(`/quotes/${b.quote_id}`)}>Source quote</button>}</>}>
      <Err e={err} />{msg && <Banner ok onClose={() => setMsg('')}>{msg}</Banner>}
      {archived && <div className="rounded-lg border border-danger/30 bg-danger/10 text-danger text-sm p-3 mb-3">This booking was deleted on {day(b.archived_at)}{b.archive_reason ? ` — “${b.archive_reason}”` : ''}. It is read-only until restored.</div>}
      {locked && !archived && <div className="rounded-lg border border-line bg-surface2/60 text-sm p-3 mb-3">This booking is <b>{LABEL[b.status].toLowerCase()}</b>, so its items can't be changed. {finance || write ? (finance ? 'Change the status below to reopen it.' : 'Ask finance or an admin to reopen it.') : ''}</div>}
      {editing && <EditBooking b={b} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setMsg('Booking details updated.'); load(); }} />}
      {deleting && <DeleteBooking b={b} onClose={() => setDeleting(false)} onDone={() => nav('/bookings?tab=deleted')} />}

      <div className="card mb-4 space-y-4">
        <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
          <div><div className="text-xs text-muted">Travel</div><span className="num">{nice(b.travel_start)} → {nice(b.travel_end)}</span>{(nights !== null || w.text) && <div className={`text-xs ${whenTone[w.tone]}`}>{[nights !== null && plural(nights, 'night'), !locked && w.text].filter(Boolean).join(' · ')}</div>}</div>
          <div><div className="text-xs text-muted">Selling price</div><span className="num font-medium">{money(f.selling_total, f.currency)}</span><div className="text-xs text-muted">{margin(f.selling_net, f.supplier_cost)} margin</div></div>
          <div><div className="text-xs text-muted">Payment</div>{PAYMENT[b.statuses.payment] ?? b.statuses.payment}{f.outstanding > 0.005 && <div className="text-xs text-warn num">{money(f.outstanding, f.currency)} owed</div>}</div>
          <div><div className="text-xs text-muted">Suppliers</div>{Object.entries(b.statuses.supplier_confirmation).map(([k, v]) => `${v} ${k}`).join(' · ') || '—'}</div>
          <div><div className="text-xs text-muted">Tickets</div>{Object.entries(b.statuses.ticketing).filter(([k]) => k !== 'not_applicable').map(([k, v]) => `${v} ${k}`).join(' · ') || 'None needed'}</div>
        </div>
        <div>
          {idx >= 0
            ? <ol className="flex flex-wrap gap-1 text-xs" aria-label="Booking progress">{FLOW.map((s, i) => <li key={s} aria-current={i === idx ? 'step' : undefined} className={`px-2.5 py-1 rounded-full border ${i < idx ? 'border-success/40 bg-success/10 text-success' : i === idx ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line text-muted'}`}>{i < idx && '✓ '}{LABEL[s]}</li>)}</ol>
            : <div className="flex items-center gap-2 text-sm"><Pill s={b.status} /><span className="text-muted">This booking is not moving forward.</span></div>}
          {canMove && <div className="flex flex-wrap items-center gap-2 mt-3">
            {idx >= 0 && idx < FLOW.length - 1 && !statusChanged && <button className="btn" onClick={() => changeStatus(FLOW[idx + 1])}>{NEXT[b.status]} →</button>}
            <label className="text-xs text-muted flex items-center gap-2">{idx >= 0 && idx < FLOW.length - 1 ? 'or change to' : 'Change status to'}
              <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}</select></label>
            {needsReason && <input className="input w-64" placeholder={`Why is it ${LABEL[status].toLowerCase()}?`} aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />}
            {statusChanged && <><button className="btn" disabled={needsReason && !reason.trim()} onClick={() => changeStatus()}>Update status</button><button className="btn-ghost" onClick={() => { setStatus(b.status); setReason(''); }}>Cancel</button></>}</div>}
        </div>
      </div>

      {todos.length > 0 && <div className="rounded-lg border border-warn/30 bg-warn/10 text-sm px-4 py-3 mb-4"><div className="font-medium flex items-center gap-2 mb-1 text-warn"><AlertTriangle size={15} /> Needs your attention</div>
        <ul className="space-y-1">{todos.map((t, i) => <li key={i} className="flex flex-wrap items-center gap-x-3">{t.text}
          {t.tab && tab !== t.tab && <button className="underline text-accent" onClick={() => setTab(t.tab!)}>Go to {t.tab.toLowerCase()}</button>}
          {t.link && write && <Link className="underline text-accent" to={t.link[0]}>{t.link[1]}</Link>}</li>)}</ul></div>}
      {!todos.length && !archived && !locked && b.status !== 'on_hold' && b.components.length > 0 && <div className="flex items-center gap-2 text-sm text-success mb-4"><CheckCircle2 size={15} /> Nothing needs attention right now.</div>}

      <div className="flex gap-1 border-b border-line mb-4 overflow-x-auto" role="tablist">{tabs.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm whitespace-nowrap ${tab === t ? 'text-accent border-b-2 border-accent font-medium' : 'text-muted hover:text-fg'}`}>{t}{t === 'Components' ? ` (${b.components.length})` : t === 'Travellers' ? ` (${b.travellers.length})` : t === 'Overview' && openTasks ? ` (${openTasks} to do)` : ''}</button>)}</div>

      {tab === 'Overview' && <div className="grid lg:grid-cols-3 gap-4">
        <div className="card lg:col-span-2 text-sm space-y-2">
          <div className="flex flex-wrap gap-x-6 gap-y-1"><span><span className="text-muted">How they found you</span> {b.channel ?? '—'}</span><span><span className="text-muted">Purpose</span> {b.trip_purpose ?? '—'}</span></div>
          {b.notes ? <div className="whitespace-pre-wrap border-t border-line pt-2">{b.notes}</div> : write && !archived && <button className="text-accent underline text-xs" onClick={() => setEditing(true)}>Add notes about this trip</button>}
          <h4 className="font-semibold pt-3">To do</h4>
          {!b.tasks.length && <div className="text-muted">No tasks yet. Add reminders such as “send final documents”.</div>}
          {b.tasks.map((k: any) => { const late = k.status === 'open' && k.due_at && day(k.due_at) < today(); return <div key={k.id} className="flex justify-between gap-3 items-center"><span className={k.status === 'done' ? 'line-through text-muted' : ''}>{k.title}{k.due_at && <span className={`num ml-2 text-xs ${late ? 'text-danger' : 'text-muted'}`}>{late ? 'overdue · ' : 'due '}{nice(k.due_at)}</span>}</span>{k.status === 'open' && write && <button className="btn-ghost" onClick={() => run(() => api(`/crm/tasks/${k.id}/complete`, 'POST', {}), 'Task marked done.')}>Done</button>}</div>; })}
          {write && !archived && <div className="flex flex-wrap gap-2 pt-2"><input className="input flex-1 min-w-[12rem]" placeholder="New to-do…" aria-label="New to-do" value={task} onChange={(e) => setTask(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addTask(); }} />
            <input className="input w-40 num" type="date" aria-label="Due date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
            <button className="btn-ghost" disabled={!task.trim()} onClick={addTask}>Add</button></div>}</div>
        <div className="card text-sm space-y-1 h-fit"><h4 className="font-semibold mb-1">Money at a glance</h4>
          <div className="flex justify-between"><span className="text-muted">Selling price</span><span className="num">{money(f.selling_total, f.currency)}</span></div><div className="flex justify-between"><span className="text-muted">Cost from suppliers</span><span className="num">{money(f.supplier_cost, f.currency)}</span></div>
          <div className="flex justify-between"><span className="text-muted">Margin</span><span className="num">{f.margin_pct ?? '—'}{f.margin_pct !== null && '%'}</span></div>
          <div className="flex justify-between border-t border-line pt-1 mt-1"><span className="text-muted">Invoiced</span><span className="num">{money(f.invoiced, f.currency)}</span></div><div className="flex justify-between"><span className="text-muted">Received</span><span className="num">{money(f.paid, f.currency)}</span></div>
          <div className="flex justify-between font-medium"><span>Still owed</span><span className="num">{money(f.outstanding, f.currency)}</span></div>
          <button className="text-accent underline text-xs pt-1" onClick={() => setTab('Finance')}>See full breakdown</button></div></div>}

      {tab === 'Itinerary' && <div>{editable && <button className="btn mb-3 inline-flex items-center gap-1" onClick={() => setItem({ day_no: days.length ? days[days.length - 1] : 1, title: '', start_time: '', location: '', component_id: '' })}><Plus size={15} /> Add to itinerary</button>}
        {days.length === 0 && <div className="card text-sm text-muted">No itinerary yet. Add the day-by-day plan — flights, transfers, tours — so the whole trip is in one place.</div>}
        {days.map((d) => <div key={d} className="card mb-3"><div className="font-semibold mb-2 flex justify-between items-center"><span>Day {d}{dayDate(d) && <span className="text-muted font-normal"> · {dayDate(d)}</span>}</span>
          {editable && <button className="btn-ghost text-xs" onClick={() => setItem({ day_no: d, title: '', start_time: '', location: '', component_id: '' })}>+ Add</button>}</div>
          {b.itinerary.filter((i: any) => i.day_no === d).map((i: any) => (
            <div key={i.id} onClick={editable ? () => setItem({ ...i, start_time: i.start_time?.slice(0, 5) ?? '', location: i.location ?? '', component_id: i.component_id ?? '', confirmed: !!i.confirmed }) : undefined} className={`flex gap-3 text-sm py-1.5 border-t border-line ${editable ? 'cursor-pointer hover:bg-surface2/50' : ''}`}>
              <span className="num w-14 text-muted">{i.start_time?.slice(0, 5) ?? ''}</span><div className="flex-1"><div>{i.title} {!i.confirmed && <span className="text-xs text-warn">(unconfirmed)</span>}</div><div className="text-xs text-muted">{i.location}</div></div></div>))}</div>)}
        {editable && days.length > 0 && <p className="text-xs text-muted">Click any item to change or remove it.</p>}</div>}

      {tab === 'Travellers' && <div>{editable && <div className="flex flex-wrap gap-2 mb-3"><select className="input w-64" aria-label="Add an existing traveller" value={trv?.traveller_id ?? ''} onChange={(e) => setTrv({ ...trv, traveller_id: e.target.value })}><option value="">Add an existing traveller…</option>{allTravellers.filter((t: any) => !b.travellers.some((x: any) => x.id === t.id)).map((t: any) => <option key={t.id} value={t.id}>{t.first_name} {t.last_name}</option>)}</select>
        <button className="btn-ghost" disabled={!trv?.traveller_id} onClick={() => run(async () => { await api(`/bookings/${id}/travellers`, 'POST', { traveller_id: Number(trv.traveller_id) }); setTrv(null); }, 'Traveller added.')}>Add</button>
        <button className="btn inline-flex items-center gap-1" onClick={() => setTrv({ new: true, first_name: '', last_name: '', passport_no: '', passport_expiry: '', nationality: '', notes: '' })}><Plus size={15} /> New traveller</button></div>}
        <Table rows={b.travellers} empty="No travellers yet — add everyone who is going, including the client if they are travelling." cols={[{ h: 'Name', render: (t: any) => <span className="font-medium">{t.first_name} {t.last_name}</span> }, { h: 'Nationality', render: (t: any) => t.nationality ?? '—' }, { h: 'Passport', render: (t: any) => <span className="num">{t.passport ?? '—'}</span> },
          { h: 'Expires', render: (t: any) => { const e = day(t.passport_expiry); if (!e) return <span className="text-muted">—</span>; const end = day(b.travel_end || b.travel_start); const lim = end ? (() => { const d = new Date(`${end}T00:00:00`); d.setMonth(d.getMonth() + 6); return isoDate(d); })() : ''; return <span className={`num ${e < today() ? 'text-danger' : lim && e < lim ? 'text-warn' : ''}`} title={e < today() ? 'Expired' : lim && e < lim ? 'Less than 6 months valid after the trip' : undefined}>{e}{e < today() ? ' · expired' : lim && e < lim ? ' · check' : ''}</span>; } },
          { h: 'Notes', render: (t: any) => t.notes }, { h: '', render: (t: any) => editable && <button className="text-danger text-xs" onClick={() => run(() => api(`/bookings/${id}/travellers/${t.id}`, 'DELETE'), `${t.first_name} was removed from this booking.`)}>Remove</button> }]} /></div>}

      {tab === 'Components' && <div>{editable && <button className="btn mb-3 inline-flex items-center gap-1" onClick={() => setComp({ product_type: 'hotel', description: '', quantity: 1, unit_cost: 0, markup_pct: 15, discount_pct: 0, tax_rate: 0 })}><Plus size={15} /> Add item</button>}
        <Table rows={b.components} onRow={editable ? (c) => setComp({ ...c, supplier_id: c.supplier_id ?? '', service_start: day(c.service_start), service_end: day(c.service_end) }) : undefined}
          empty="Nothing added yet. Add each flight, hotel, transfer or tour the client is buying — with what it costs you and your markup." cols={[
          { h: 'Item', render: (c: any) => <><span className="capitalize text-muted">{c.product_type}</span> — {c.description}{c.supplier_ref && <div className="text-xs text-muted">Ref {c.supplier_ref}</div>}</> },
          { h: 'Supplier', render: (c: any) => c.supplier_name ?? <span className="text-muted">—</span> }, { h: 'Dates', render: (c: any) => c.service_start ? <span className="num whitespace-nowrap">{day(c.service_start)}{c.service_end && day(c.service_end) !== day(c.service_start) ? ` → ${day(c.service_end).slice(5)}` : ''}</span> : <span className="text-muted">—</span> },
          { h: 'Supplier confirmed', render: (c: any) => <Pill s={c.confirmation_status} /> }, { h: 'Ticket', render: (c: any) => (c.ticketing_status === 'not_applicable' ? <span className="text-muted">—</span> : <Pill s={c.ticketing_status} />) },
          { h: 'Selling', right: true, render: (c: any) => money(c.net_total + c.tax_total, f.currency) }, { h: 'Cost', right: true, render: (c: any) => money(c.cost_total, f.currency) }, { h: 'Margin', right: true, render: (c: any) => margin(c.net_total, c.cost_total) }]} />
        {b.components.length > 0 && <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm mt-3 num"><span className="text-muted">Selling <b className="text-fg">{money(r2(sumNet + sumTax), f.currency)}</b> <span className="text-xs">(incl. {money(r2(sumTax), f.currency)} tax)</span></span><span className="text-muted">Cost <b className="text-fg">{money(r2(sumCost), f.currency)}</b></span><span className="text-muted">Margin <b className="text-fg">{margin(sumNet, sumCost)}</b></span></div>}
        {editable && b.components.length > 0 && <p className="text-xs text-muted mt-1">Click any row to change it.</p>}</div>}

      {tab === 'Finance' && <div className="grid lg:grid-cols-2 gap-4">
        <div className="card text-sm space-y-1"><h4 className="font-semibold mb-1">Profitability ({f.currency})</h4>
          {([['Selling price (before tax)', f.selling_net], ['Tax', f.tax], ['Selling total', f.selling_total], ['Cost from suppliers', f.supplier_cost], ['Gross margin', f.gross_margin], ['Overhead', f.overhead], ['Contribution (what you keep)', f.contribution]] as [string, number][]).map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-muted">{k}</span><span className="num">{money(v, f.currency)}</span></div>)}
          <div className="flex justify-between"><span className="text-muted">Margin %</span><span className="num">{f.margin_pct ?? '—'}{f.margin_pct !== null && '%'}</span></div><p className="text-xs text-muted pt-2">{f.note}</p></div>
        <div className="card text-sm space-y-1"><h4 className="font-semibold mb-1">Money from the client</h4>
          {([['Invoiced', f.invoiced], ['Received', f.paid], ['Still owed', f.outstanding], ['Not yet invoiced', f.not_yet_invoiced]] as [string, number][]).map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-muted">{k}</span><span className="num">{money(v, f.currency)}</span></div>)}
          {f.other_currency_invoices > 0 && <div className="text-xs text-warn">{f.other_currency_invoices} invoice(s) in another currency are excluded from these totals.</div>}
          <div className="pt-2 border-t border-line mt-2 space-y-1">{b.invoices.length === 0 && <div className="text-muted">No invoices for this booking yet.</div>}
            {b.invoices.map((i: any) => <Link key={i.id} to={`/invoices?open=${i.id}`} className="flex justify-between items-center gap-2 hover:bg-surface2/60 rounded px-1 -mx-1 py-0.5"><span className="num underline decoration-dotted">{i.number}</span><Pill s={i.status} /><span className="num">{money(i.total, i.currency)}</span></Link>)}</div>
          {write && !archived && <div className="flex flex-wrap gap-2 pt-3"><button className="btn inline-flex items-center gap-1" onClick={() => nav(`/invoices?booking=${b.id}`)}><FilePlus2 size={14} /> Create invoice</button>
            {f.outstanding > 0.005 && finance && <button className="btn-ghost" onClick={() => nav(`/client-receipts?client=${b.client_id}`)}>Receive payment</button>}</div>}</div></div>}

      {tab === 'Activity' && <div className="grid lg:grid-cols-2 gap-4">
        <div className="card"><h4 className="font-semibold text-sm mb-2">Change log</h4><div className="space-y-2 text-xs max-h-96 overflow-auto">{b.changes.map((c: any) => <div key={c.id}><b>{c.field}</b>: <span className="text-muted">{c.old_value ?? '∅'}</span> → {c.new_value ?? '∅'}{c.reason && <span className="text-warn"> — “{c.reason}”</span>}<div className="text-muted">{c.user_name} · {new Date(c.created_at).toLocaleString()}</div></div>)}{!b.changes.length && <div className="text-muted">No changes yet</div>}</div></div>
        <div className="card"><h4 className="font-semibold text-sm mb-2">Notes & activity</h4>{write && !archived && <div className="flex gap-2 mb-2"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note — e.g. “client called about seats”" aria-label="Add a note" /><button className="btn-ghost" disabled={!note.trim()} onClick={() => run(async () => { await api('/crm/activities', 'POST', { entity_type: 'booking', entity_id: b.id, body: note.trim() }); setNote(''); }, 'Note added.')}>Add</button></div>}
          <div className="space-y-2 text-xs max-h-80 overflow-auto">{b.activities.map((a: any) => <div key={a.id}>{a.body}<div className="text-muted">{a.user_name ?? 'System'} · {new Date(a.created_at).toLocaleString()}</div></div>)}{!b.activities.length && <div className="text-muted">No notes yet</div>}</div></div></div>}

      {comp && <Modal title={comp.id ? 'Edit item' : 'Add an item'} onClose={() => { setComp(null); setConfirmDel(false); }}>
        <div className="grid sm:grid-cols-2 gap-x-4">
          <Field label="What is it?"><select className="input capitalize" value={comp.product_type} onChange={(e) => setComp({ ...comp, product_type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Supplier"><select className="input" value={comp.supplier_id ?? ''} onChange={(e) => setComp({ ...comp, supplier_id: e.target.value })}><option value="">Not chosen yet</option>{suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <div className="sm:col-span-2"><Field label="Description"><input className="input" autoFocus placeholder="e.g. Grand Hyatt Bali, 5 nights, ocean-view room" value={comp.description} onChange={(e) => setComp({ ...comp, description: e.target.value })} /></Field></div>
          <Field label="Starts"><input className="input num" type="date" value={comp.service_start ?? ''} onChange={(e) => setComp({ ...comp, service_start: e.target.value })} /></Field>
          <Field label="Ends"><input className="input num" type="date" min={comp.service_start || undefined} value={comp.service_end ?? ''} onChange={(e) => setComp({ ...comp, service_end: e.target.value })} /></Field>
          <Field label="Supplier's booking reference"><input className="input" value={comp.supplier_ref ?? ''} onChange={(e) => setComp({ ...comp, supplier_ref: e.target.value })} /></Field>
          <Field label="Quantity" hint="Rooms, seats, nights…"><Num v={comp.quantity} set={(v) => setComp({ ...comp, quantity: v === '' ? 0 : v })} min={0} /></Field>
          <Field label="What it costs you (each)"><Num v={comp.unit_cost} set={(v) => setComp({ ...comp, unit_cost: v === '' ? 0 : v })} min={0} /></Field>
          <Field label="Your markup %"><Num v={comp.markup_pct} set={(v) => setComp({ ...comp, markup_pct: v === '' ? 0 : v })} min={0} /></Field>
          <Field label="Discount to client %"><Num v={comp.discount_pct} set={(v) => setComp({ ...comp, discount_pct: v === '' ? 0 : v })} min={0} max={100} /></Field>
          <Field label="Tax %"><Num v={comp.tax_rate} set={(v) => setComp({ ...comp, tax_rate: v === '' ? 0 : v })} min={0} /></Field>
          {comp.id && <><Field label="Supplier confirmation"><select className="input capitalize" value={comp.confirmation_status} onChange={(e) => setComp({ ...comp, confirmation_status: e.target.value })}>{['pending', 'requested', 'confirmed', 'waitlisted', 'cancelled'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Ticketing"><select className="input" value={comp.ticketing_status} onChange={(e) => setComp({ ...comp, ticketing_status: e.target.value })}>{['not_applicable', 'pending', 'ticketed'].map((s) => <option key={s} value={s}>{s === 'not_applicable' ? 'No ticket needed' : s === 'pending' ? 'To be ticketed' : 'Ticketed'}</option>)}</select></Field>
            <Field label="Fulfilment"><select className="input" value={comp.fulfilment_status} onChange={(e) => setComp({ ...comp, fulfilment_status: e.target.value })}>{[['pending', 'Not started'], ['in_progress', 'In progress'], ['done', 'Done']].map(([s, l]) => <option key={s} value={s}>{l}</option>)}</select></Field>
            <Field label="Reason for change (optional)"><input className="input" value={comp.reason ?? ''} onChange={(e) => setComp({ ...comp, reason: e.target.value })} /></Field></>}
        </div>
        {price && <div className="rounded-lg border border-line bg-surface2/50 px-3 py-2 mb-3 text-sm grid grid-cols-3 gap-2 num"><div><div className="text-xs text-muted">Client pays</div><b>{money(price.net + price.tax, f.currency)}</b>{price.tax > 0 && <div className="text-xs text-muted">incl. {money(price.tax, f.currency)} tax</div>}</div><div><div className="text-xs text-muted">Costs you</div>{money(price.cost, f.currency)}</div><div><div className="text-xs text-muted">Your margin</div>{money(r2(price.net - price.cost), f.currency)} · {margin(price.net, price.cost)}</div></div>}
        {compBad && <p role="alert" className="text-sm text-danger mb-2">{compBad}</p>}
        <div className="flex justify-between items-center gap-3">{comp.id ? (confirmDel
          ? <span className="text-sm flex items-center gap-2">Remove this item? <button className="btn bg-danger text-white" onClick={() => run(async () => { await api(`/bookings/${id}/components/${comp.id}`, 'DELETE'); setComp(null); setConfirmDel(false); }, 'Item removed.')}>Yes, remove</button><button className="btn-ghost" onClick={() => setConfirmDel(false)}>No</button></span>
          : <button className="btn-ghost text-danger" onClick={() => setConfirmDel(true)}>Remove</button>) : <span />}<button className="btn" disabled={!comp.description.trim() || !Number(comp.quantity) || !!compBad} onClick={saveComp}>Save item</button></div></Modal>}
      {item && <Modal title={item.id ? 'Edit itinerary item' : 'Add to itinerary'} onClose={() => { setItem(null); setConfirmDel(false); }}><div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="Day number" hint={dayDate(item.day_no || 1) || 'Day 1 is the first day of travel'}><Num v={item.day_no} set={(v) => setItem({ ...item, day_no: v || 1 })} min={1} /></Field><Field label="Time (optional)"><input className="input num" type="time" value={item.start_time} onChange={(e) => setItem({ ...item, start_time: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="What happens"><input className="input" autoFocus placeholder="e.g. Transfer to hotel" value={item.title} onChange={(e) => setItem({ ...item, title: e.target.value })} /></Field></div>
        <div className="sm:col-span-2"><Field label="Where / meeting point"><input className="input" value={item.location} onChange={(e) => setItem({ ...item, location: e.target.value })} /></Field></div>
        <Field label="Linked item" hint="Optional — ties this to something you are selling"><select className="input" value={item.component_id} onChange={(e) => setItem({ ...item, component_id: e.target.value })}><option value="">None</option>{b.components.map((c: any) => <option key={c.id} value={c.id}>{c.description}</option>)}</select></Field>
        <label className="flex items-center gap-2 text-sm sm:mt-6 mb-3"><input type="checkbox" checked={!!item.confirmed} onChange={(e) => setItem({ ...item, confirmed: e.target.checked })} /> Confirmed with the supplier</label></div>
        <div className="flex justify-between items-center gap-3">{item.id ? (confirmDel
          ? <span className="text-sm flex items-center gap-2">Remove this? <button className="btn bg-danger text-white" onClick={() => run(async () => { await api(`/bookings/${id}/itinerary/${item.id}`, 'DELETE'); setItem(null); setConfirmDel(false); }, 'Itinerary item removed.')}>Yes, remove</button><button className="btn-ghost" onClick={() => setConfirmDel(false)}>No</button></span>
          : <button className="btn-ghost text-danger" onClick={() => setConfirmDel(true)}>Remove</button>) : <span />}
          <button className="btn" disabled={!item.title.trim()} onClick={() => run(async () => { const iid = item.id; const body = { day_no: Number(item.day_no) || 1, title: item.title.trim(), start_time: item.start_time || null, location: item.location || null, component_id: item.component_id ? Number(item.component_id) : null, confirmed: !!item.confirmed }; iid ? await api(`/bookings/${id}/itinerary/${iid}`, 'PUT', body) : await api(`/bookings/${id}/itinerary`, 'POST', body); setItem(null); }, 'Itinerary saved.')}>Save</button></div></Modal>}
      {trv?.new && <Modal title="New traveller" onClose={() => setTrv(null)}><div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="First name"><input className="input" autoFocus value={trv.first_name} onChange={(e) => setTrv({ ...trv, first_name: e.target.value })} /></Field><Field label="Last name"><input className="input" value={trv.last_name} onChange={(e) => setTrv({ ...trv, last_name: e.target.value })} /></Field>
        <Field label="Passport number" hint="Stored encrypted"><input className="input num" value={trv.passport_no} onChange={(e) => setTrv({ ...trv, passport_no: e.target.value })} autoComplete="off" /></Field><Field label="Passport expiry"><input className="input num" type="date" value={trv.passport_expiry} onChange={(e) => setTrv({ ...trv, passport_expiry: e.target.value })} /></Field>
        <Field label="Nationality"><input className="input" value={trv.nationality} onChange={(e) => setTrv({ ...trv, nationality: e.target.value })} /></Field><Field label="Dietary / accessibility needs"><input className="input" value={trv.notes} onChange={(e) => setTrv({ ...trv, notes: e.target.value })} /></Field></div>
        <div className="flex justify-end"><button className="btn" disabled={!trv.first_name.trim() || !trv.last_name.trim()} onClick={() => run(async () => { const r = await api('/travellers', 'POST', { client_id: b.client_id, first_name: trv.first_name.trim(), last_name: trv.last_name.trim(), passport_no: trv.passport_no || null, passport_expiry: trv.passport_expiry || null, nationality: trv.nationality || null, notes: trv.notes || null }); await api(`/bookings/${id}/travellers`, 'POST', { traveller_id: r.id }); setTrv(null); }, 'Traveller added.')}>Save & add to booking</button></div></Modal>}
    </Page>
  );
}
