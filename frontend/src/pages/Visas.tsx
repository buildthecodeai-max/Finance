import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FilePlus2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { ClientPick } from '../components/ClientPick';
import { Err, Field, Modal, Num, Page, Pill, Skeleton, Table } from '../components/ui';
import { today, useList, useOpenOnNew } from '../lookup';

const FLOW = ['docs_pending', 'docs_received', 'submitted', 'in_process', 'approved', 'collected'];
const LABEL: Record<string, string> = { docs_pending: 'Collecting documents', docs_received: 'Documents received', submitted: 'Submitted', in_process: 'In process', approved: 'Approved', rejected: 'Rejected', collected: 'Visa collected', cancelled: 'Cancelled' };
const NEXT: Record<string, string> = { docs_pending: 'Documents received', docs_received: 'Submitted to embassy', submitted: 'Now being processed', in_process: 'Visa approved', approved: 'Visa collected / handed over' };
const TYPES = ['tourist', 'business', 'umrah', 'hajj', 'transit', 'student', 'work', 'family visit', 'other'];
const ACTIVE = ['docs_pending', 'docs_received', 'submitted', 'in_process'];
const r2 = (n: number) => Math.round(n * 100) / 100;
const day = (d: any) => (d ? String(d).slice(0, 10) : '');
const daysFrom = (d: any) => Math.round((Date.parse(day(d)) - Date.parse(today())) / 864e5);
const nice = (d: any) => (d ? new Date(`${day(d)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const late = (v: any) => ['submitted', 'in_process'].includes(v.status) && v.expected_on && daysFrom(v.expected_on) < 0;
const expiring = (v: any) => ['approved', 'collected'].includes(v.status) && v.valid_until && daysFrom(v.valid_until) <= 60;
const badRange = (a: string, b: string) => (a && b && b < a ? 'The end date is before the start date.' : '');

const TABS: { key: string; label: string; test: (v: any) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'docs', label: 'Documents', test: (v) => ['docs_pending', 'docs_received'].includes(v.status) },
  { key: 'embassy', label: 'With the embassy', test: (v) => ['submitted', 'in_process'].includes(v.status) },
  { key: 'ready', label: 'Approved', test: (v) => v.status === 'approved' },
  { key: 'done', label: 'Collected', test: (v) => v.status === 'collected' },
  { key: 'stopped', label: 'Rejected / cancelled', test: (v) => ['rejected', 'cancelled'].includes(v.status) },
];

function VisaForm({ initial, onClose, onSaved }: { initial: any; onClose(): void; onSaved(id: number): void }) {
  const { agency } = useAuth(); const clients = useList('/clients'); const suppliers = useList('/suppliers'); const [bookings, setBookings] = useState<any[]>([]); const [travellers, setTravellers] = useState<any[]>([]);
  const [f, setF] = useState<any>(initial); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const editing = !!initial.id; const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  useEffect(() => { api('/bookings').then(setBookings).catch(() => {}); api('/travellers').then(setTravellers).catch(() => {}); }, []);
  const mine = bookings.filter((b) => String(b.client_id) === String(f.client_id));
  const ppl = travellers.filter((t) => !f.client_id || String(t.client_id) === String(f.client_id) || !t.client_id);
  const pickTraveller = (id: string) => { const t = travellers.find((x) => String(x.id) === id); setF({ ...f, traveller_id: id, ...(t ? { applicant_name: `${t.first_name} ${t.last_name}`, nationality: t.nationality ?? f.nationality } : {}) }); };
  const bad = badRange(f.valid_from, f.valid_until);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const n = (v: any) => (v === '' || v == null ? null : v);
      const body = { client_id: Number(f.client_id), booking_id: f.booking_id ? Number(f.booking_id) : null, traveller_id: f.traveller_id ? Number(f.traveller_id) : null, supplier_id: f.supplier_id ? Number(f.supplier_id) : null,
        applicant_name: f.applicant_name.trim(), passport_no: n(f.passport_no), nationality: n(f.nationality), country: f.country.trim(), visa_type: f.visa_type, entry_type: f.entry_type,
        submitted_on: n(f.submitted_on), expected_on: n(f.expected_on), visa_number: n(f.visa_number), valid_from: n(f.valid_from), valid_until: n(f.valid_until), embassy_ref: n(f.embassy_ref),
        currency: String(f.currency).toUpperCase(), cost: Number(f.cost) || 0, price: Number(f.price) || 0, notes: n(f.notes) };
      const r = editing ? await api(`/visas/${initial.id}`, 'PUT', body) : await api('/visas', 'POST', body); onSaved(r?.id ?? initial.id);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const missing = !f.client_id ? 'Choose the client this visa is for.' : !f.applicant_name.trim() ? 'Enter the applicant’s name.' : !f.country.trim() ? 'Enter the country the visa is for.' : '';
  return <Modal title={editing ? `Edit ${initial.reference}` : 'New visa application'} onClose={onClose} wide><Err e={err} />
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-4">
      <Field label="Client"><ClientPick clients={clients} value={f.client_id} onChange={(v) => setF({ ...f, client_id: v, booking_id: '', traveller_id: '' })} autoFocus={!editing} /></Field>
      <Field label="Traveller (optional)" hint="Fills in the name for you"><select className="input" value={f.traveller_id} onChange={(e) => pickTraveller(e.target.value)}><option value="">Type a name instead</option>{ppl.map((t) => <option key={t.id} value={t.id}>{t.first_name} {t.last_name}</option>)}</select></Field>
      <Field label="Applicant name"><input className="input" value={f.applicant_name} onChange={set('applicant_name')} placeholder="As on the passport" /></Field>
      <Field label="Country applying for"><input className="input" value={f.country} onChange={set('country')} placeholder="e.g. Saudi Arabia" /></Field>
      <Field label="Visa type"><select className="input capitalize" value={f.visa_type} onChange={set('visa_type')}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
      <Field label="Entries"><select className="input" value={f.entry_type} onChange={set('entry_type')}><option value="single">Single entry</option><option value="multiple">Multiple entry</option></select></Field>
      <Field label="Passport number"><input className="input num" value={f.passport_no ?? ''} onChange={set('passport_no')} autoComplete="off" /></Field>
      <Field label="Nationality"><input className="input" value={f.nationality ?? ''} onChange={set('nationality')} /></Field>
      <Field label="Linked booking (optional)"><select className="input" value={f.booking_id} onChange={set('booking_id')} disabled={!f.client_id}><option value="">Not linked</option>{mine.map((b) => <option key={b.id} value={b.id}>{b.reference}{b.destination ? ` — ${b.destination}` : ''}</option>)}</select></Field>
      <Field label="Processed through" hint="Visa agent or embassy account"><select className="input" value={f.supplier_id} onChange={set('supplier_id')}><option value="">Not chosen</option>{suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Submitted on"><input className="input num" type="date" value={f.submitted_on ?? ''} onChange={set('submitted_on')} /></Field>
      <Field label="Decision expected by"><input className="input num" type="date" min={f.submitted_on || undefined} value={f.expected_on ?? ''} onChange={set('expected_on')} /></Field>
      {editing && <><Field label="Visa number"><input className="input num" value={f.visa_number ?? ''} onChange={set('visa_number')} /></Field><Field label="Embassy reference"><input className="input num" value={f.embassy_ref ?? ''} onChange={set('embassy_ref')} /></Field>
        <Field label="Valid from"><input className="input num" type="date" value={f.valid_from ?? ''} onChange={set('valid_from')} /></Field><Field label="Valid until"><input className="input num" type="date" min={f.valid_from || undefined} value={f.valid_until ?? ''} onChange={set('valid_until')} /></Field></>}
      <Field label="Currency"><input className="input num uppercase" maxLength={3} value={f.currency} onChange={set('currency')} /></Field>
      <Field label="Fee you pay" hint="Embassy / agent fee"><Num v={f.cost} set={(v) => setF({ ...f, cost: v })} min={0} /></Field>
      <Field label="Price to the client" hint={Number(f.price) > 0 ? `Your margin: ${money(r2(Number(f.price) - Number(f.cost || 0)), String(f.currency).toUpperCase() || 'USD')}` : undefined}><Num v={f.price} set={(v) => setF({ ...f, price: v })} min={0} /></Field>
      <div className="sm:col-span-2 lg:col-span-3"><Field label="Notes"><textarea className="input" rows={2} value={f.notes ?? ''} onChange={set('notes')} placeholder="e.g. Passport collected, photo to be retaken" /></Field></div></div>
    {(bad || missing) && <p role="alert" className="text-sm text-warn mb-2">{bad || missing}</p>}
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !!missing || !!bad || String(f.currency).length !== 3} onClick={save}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Open visa file'}</button></div></Modal>;
}

function VisaDetail({ id, canEdit, onClose, onChanged, onEdit }: { id: number; canEdit: boolean; onClose(): void; onChanged(msg?: string): void; onEdit(v: any): void }) {
  const nav = useNavigate(); const [v, setV] = useState<any>(null); const [err, setErr] = useState(''); const [status, setStatus] = useState(''); const [note, setNote] = useState(''); const [confirmDel, setConfirmDel] = useState(false);
  const [approve, setApprove] = useState<any>(null);
  const load = () => api(`/visas/${id}`).then((d) => { setV(d); setStatus(d.status); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (!v) return <Modal title="Visa file" wide onClose={onClose}>{err ? <Err e={err} /> : <Skeleton className="h-40" />}</Modal>;
  const idx = FLOW.indexOf(v.status); const changed = status !== v.status; const needsNote = changed && ['rejected', 'cancelled'].includes(status);
  const move = async (to: string, extra: any = {}) => { try { await api(`/visas/${id}`, 'PUT', { status: to, note: note.trim() || undefined, ...extra }); setErr(''); setNote(''); setApprove(null); onChanged(`${v.applicant_name}: ${LABEL[to].toLowerCase()}.`); load(); } catch (e: any) { setErr(e.message); } };
  const margin = r2(Number(v.price) - Number(v.cost));
  const next = FLOW[idx + 1];
  return (
    <Modal title={`${v.reference} · ${v.applicant_name}`} wide onClose={onClose}><Err e={err} />
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Pill s={v.status} /><span className="text-sm text-muted">{v.country} · <span className="capitalize">{v.visa_type}</span> · {v.entry_type} entry</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {canEdit && Number(v.price) > 0 && !['cancelled', 'rejected'].includes(v.status) && <button className="btn-ghost inline-flex items-center gap-1" onClick={() => nav(`/invoices?visa=${id}`)}><FilePlus2 size={14} />Create invoice</button>}
          {canEdit && <button className="btn-ghost inline-flex items-center gap-1" onClick={() => onEdit(v)}><Pencil size={14} />Edit</button>}
          {canEdit && ['docs_pending', 'cancelled'].includes(v.status) && <button className="btn-ghost text-danger inline-flex items-center gap-1" onClick={() => setConfirmDel(true)}><Trash2 size={14} />Delete</button>}</div></div>

      {idx >= 0 ? <ol className="flex flex-wrap gap-1 text-xs mb-3" aria-label="Visa progress">{FLOW.map((s, i) => <li key={s} aria-current={i === idx ? 'step' : undefined} className={`px-2.5 py-1 rounded-full border ${i < idx ? 'border-success/40 bg-success/10 text-success' : i === idx ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line text-muted'}`}>{i < idx && '✓ '}{LABEL[s]}</li>)}</ol>
        : <div className="rounded-lg border border-danger/30 bg-danger/10 text-danger text-sm px-3 py-2 mb-3">This application was {v.status}.{v.events[0]?.note ? ` “${v.events[0].note}”` : ''}</div>}
      {late(v) && <div className="rounded-lg border border-warn/30 bg-warn/10 text-sm px-3 py-2 mb-3 text-warn">A decision was expected by {nice(v.expected_on)} ({-daysFrom(v.expected_on)} days ago) — chase the embassy.</div>}
      {expiring(v) && <div className="rounded-lg border border-warn/30 bg-warn/10 text-sm px-3 py-2 mb-3 text-warn">{daysFrom(v.valid_until) < 0 ? `This visa expired on ${nice(v.valid_until)}.` : `This visa expires on ${nice(v.valid_until)} (${daysFrom(v.valid_until)} days).`}</div>}

      {canEdit && <div className="flex flex-wrap items-center gap-2 mb-4">
        {next && !changed && <button className="btn" onClick={() => (next === 'approved' && !v.visa_number && !v.valid_until ? setApprove({ visa_number: '', valid_from: '', valid_until: '' }) : move(next))}>{NEXT[v.status]} →</button>}
        <label className="text-xs text-muted flex items-center gap-2">{next ? 'or change to' : 'Change status to'}<select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>{Object.keys(LABEL).map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}</select></label>
        {needsNote && <input className="input w-64" aria-label="Reason" placeholder={`Why was it ${status}?`} value={note} onChange={(e) => setNote(e.target.value)} />}
        {changed && <><button className="btn" disabled={needsNote && !note.trim()} onClick={() => (status === 'approved' && !v.visa_number && !v.valid_until ? setApprove({ visa_number: '', valid_from: '', valid_until: '' }) : move(status))}>Update status</button><button className="btn-ghost" onClick={() => { setStatus(v.status); setNote(''); }}>Cancel</button></>}</div>}

      <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3 mb-4">
        <div><span className="text-muted">Client </span>{v.client_name}</div>
        <div><span className="text-muted">Passport </span><span className="num">{v.passport_no || '—'}</span>{v.nationality && <span> · {v.nationality}</span>}</div>
        <div><span className="text-muted">Processed through </span>{v.supplier_name ?? '—'}</div>
        <div><span className="text-muted">Submitted </span>{nice(v.submitted_on)}</div><div><span className="text-muted">Decision expected </span>{nice(v.expected_on)}</div><div><span className="text-muted">Decided </span>{nice(v.decided_on)}</div>
        <div><span className="text-muted">Visa number </span><span className="num">{v.visa_number || '—'}</span></div><div><span className="text-muted">Valid </span>{v.valid_from || v.valid_until ? `${nice(v.valid_from)} → ${nice(v.valid_until)}` : '—'}</div><div><span className="text-muted">Embassy ref </span><span className="num">{v.embassy_ref || '—'}</span></div>
        <div><span className="text-muted">Fee you pay </span><span className="num">{money(v.cost, v.currency)}</span></div><div><span className="text-muted">Price to client </span><span className="num">{money(v.price, v.currency)}</span></div><div><span className="text-muted">Margin </span><span className={`num ${margin < 0 ? 'text-danger' : ''}`}>{money(margin, v.currency)}</span></div>
        {v.booking_id && <div><button className="text-accent underline" onClick={() => nav(`/bookings/${v.booking_id}`)}>Open linked booking</button></div>}
        {v.notes && <div className="sm:col-span-2 lg:col-span-3 whitespace-pre-wrap"><span className="text-muted">Notes </span>{v.notes}</div>}</div>

      <h4 className="font-semibold text-sm mb-2">History</h4>
      <div className="space-y-1 text-xs max-h-40 overflow-auto">{v.events.map((e: any) => <div key={e.id}><b>{LABEL[e.status] ?? e.status}</b>{e.note && <span className="text-muted"> — {e.note}</span>}<div className="text-muted">{e.user_name ?? 'System'} · {new Date(e.created_at).toLocaleString()}</div></div>)}</div>

      {approve && <Modal title="Record the approved visa" onClose={() => setApprove(null)}>
        <p className="text-sm text-muted mb-3">Enter the visa details from the approval. You need at least the visa number or the validity dates.</p>
        <div className="grid grid-cols-2 gap-x-3"><div className="col-span-2"><Field label="Visa number"><input className="input num" autoFocus value={approve.visa_number} onChange={(e) => setApprove({ ...approve, visa_number: e.target.value })} /></Field></div>
          <Field label="Valid from"><input className="input num" type="date" value={approve.valid_from} onChange={(e) => setApprove({ ...approve, valid_from: e.target.value })} /></Field>
          <Field label="Valid until"><input className="input num" type="date" min={approve.valid_from || undefined} value={approve.valid_until} onChange={(e) => setApprove({ ...approve, valid_until: e.target.value })} /></Field></div>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setApprove(null)}>Cancel</button>
          <button className="btn" disabled={(!approve.visa_number.trim() && !approve.valid_until) || !!badRange(approve.valid_from, approve.valid_until)} onClick={() => move('approved', { visa_number: approve.visa_number.trim() || null, valid_from: approve.valid_from || null, valid_until: approve.valid_until || null })}>Mark as approved</button></div></Modal>}
      {confirmDel && <Modal title={`Delete ${v.reference}?`} onClose={() => setConfirmDel(false)}><p className="text-sm mb-3">This removes the file completely. Use Cancelled instead if you want to keep a record.</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setConfirmDel(false)}>Cancel</button><button className="btn bg-danger text-white" onClick={async () => { try { await api(`/visas/${id}`, 'DELETE'); onChanged(`${v.reference} was deleted.`); onClose(); } catch (e: any) { setErr(e.message); setConfirmDel(false); } }}>Delete</button></div></Modal>}
    </Modal>
  );
}

export default function Visas() {
  const { can, agency } = useAuth(); const [sp, setSp] = useSearchParams(); const canEdit = can('admin', 'finance_manager', 'agent');
  const [rows, setRows] = useState<any[] | null>(null); const [err, setErr] = useState(''); const [note, setNote] = useState('');
  const [tab, setTab] = useState(TABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab')! : 'all'); const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(Number(sp.get('open')) || null); const [form, setForm] = useState<any>(null); const [rev, setRev] = useState(0);
  const blank = () => ({ client_id: sp.get('client') ?? '', booking_id: '', traveller_id: '', supplier_id: '', applicant_name: '', passport_no: '', nationality: '', country: '', visa_type: 'tourist', entry_type: 'single', submitted_on: '', expected_on: '', currency: agency?.base_currency ?? 'USD', cost: 0, price: 0, notes: '' });
  const load = () => api('/visas').then((r) => { setRows(r); setErr(''); }).catch((e) => { setErr(e.message); setRows([]); });
  useEffect(() => { load(); }, []);
  useOpenOnNew(() => { if (canEdit) setForm(blank()); });
  useEffect(() => { if (sp.has('open') || sp.has('client')) { if (sp.get('client') && canEdit) setForm(blank()); const n = new URLSearchParams(sp); n.delete('open'); n.delete('client'); setSp(n, { replace: true }); } }, []);

  const all = rows ?? [];
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, all.filter(t.test).length])), [rows]);
  const list = useMemo(() => { const s = q.trim().toLowerCase(); return all.filter(TABS.find((t) => t.key === tab)!.test).filter((v) => !s || [v.reference, v.applicant_name, v.client_name, v.country, v.visa_number, v.passport_no].some((x) => String(x ?? '').toLowerCase().includes(s))); }, [rows, tab, q]);
  const inProgress = all.filter((v) => ACTIVE.includes(v.status)), overdue = all.filter(late), soon = all.filter(expiring);
  const stat = (key: string | null, title: string, value: string, sub: string, tone = '') => (
    <button type="button" disabled={!key} onClick={() => key && setTab(key)} className={`card text-left ${key ? 'hover:bg-surface2/70 transition-colors' : 'cursor-default'} ${key && tab === key ? 'ring-1 ring-accent' : ''}`}>
      <div className="text-xs text-muted">{title}</div><div className={`text-xl font-semibold num mt-0.5 ${tone}`}>{value}</div><div className="text-xs text-muted mt-0.5">{sub}</div></button>);

  return (
    <Page title="Visas" description="Track every visa application from collecting documents to handing the visa over, and invoice the client when it is done."
      actions={canEdit ? <button className="btn inline-flex items-center gap-1" onClick={() => setForm(blank())}><Plus size={16} />New application</button> : undefined}>
      {rows === null ? <div className="grid sm:grid-cols-3 gap-3 mb-4"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div> : (
        <div className="grid sm:grid-cols-3 gap-3 mb-4">
          {stat('docs', 'In progress', String(inProgress.length), `${counts.docs} waiting on documents · ${counts.embassy} with the embassy`)}
          {stat('embassy', 'Decision overdue', String(overdue.length), overdue.length ? 'Past the expected date — chase the embassy' : 'Nothing is late', overdue.length ? 'text-warn' : '')}
          {stat(null, 'Visas expiring in 60 days', String(soon.length), soon.length ? soon.slice(0, 2).map((v) => `${v.applicant_name} (${nice(v.valid_until)})`).join(', ') : 'None expiring soon', soon.length ? 'text-warn' : '')}
        </div>)}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1 basis-full min-w-0" role="tablist" aria-label="Visa views">
          {TABS.map((t) => <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className={`whitespace-nowrap text-sm px-3 py-1.5 rounded-lg border ${tab === t.key ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>{t.label}{rows && t.key !== 'all' && <span className="ml-1.5 text-xs opacity-70 num">{counts[t.key]}</span>}</button>)}</div>
        <div className="relative w-full sm:w-72"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input className="input pl-8" placeholder="Name, client, country or visa no…" aria-label="Search visas" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
      {note && <div role="status" className="rounded-lg border border-success/30 bg-success/10 text-success text-sm px-3 py-2 mb-3 flex justify-between gap-3"><span>{note}</span><button className="opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={() => setNote('')}><X size={14} /></button></div>}
      <Err e={form ? '' : err} />
      {rows === null ? <Skeleton className="h-64" /> : (
        <Table rows={list} onRow={(r) => setOpen(r.id)}
          empty={all.length === 0 ? (canEdit ? 'No visa applications yet — click “New application” when a client needs a visa.' : 'No visa applications yet.') : q ? `No application matches “${q}”.` : `Nothing in “${TABS.find((t) => t.key === tab)!.label}”.`}
          cols={[
            { h: 'Applicant', render: (r) => <><span className="font-medium">{r.applicant_name}</span><div className="text-xs text-muted"><span className="num">{r.reference}</span> · {r.client_name}</div></> },
            { h: 'Visa', render: (r) => <>{r.country}<div className="text-xs text-muted capitalize">{r.visa_type} · {r.entry_type}</div></> },
            { h: 'Status', render: (r) => <Pill s={r.status} /> },
            { h: 'Decision', render: (r) => (r.expected_on && ACTIVE.includes(r.status) ? <><span className="num">{day(r.expected_on)}</span>{late(r) && <div className="text-xs text-warn">{-daysFrom(r.expected_on)} days overdue</div>}</> : r.decided_on ? <span className="num">{day(r.decided_on)}</span> : <span className="text-muted">—</span>) },
            { h: 'Valid until', render: (r) => (r.valid_until ? <><span className="num">{day(r.valid_until)}</span>{expiring(r) && <div className="text-xs text-warn">{daysFrom(r.valid_until) < 0 ? 'expired' : `${daysFrom(r.valid_until)} days left`}</div>}</> : <span className="text-muted">—</span>) },
            { h: 'Price', right: true, render: (r) => (Number(r.price) > 0 ? money(r.price, r.currency) : <span className="text-muted">—</span>) }]} />
      )}
      {open && <VisaDetail key={`${open}-${rev}`} id={open} canEdit={canEdit} onClose={() => setOpen(null)} onChanged={(m) => { if (m) setNote(m); load(); }} onEdit={(v) => setForm({ ...blank(), ...v, client_id: String(v.client_id), booking_id: v.booking_id ?? '', traveller_id: v.traveller_id ?? '', supplier_id: v.supplier_id ?? '', submitted_on: day(v.submitted_on), expected_on: day(v.expected_on), valid_from: day(v.valid_from), valid_until: day(v.valid_until) })} />}
      {form && <VisaForm initial={form} onClose={() => setForm(null)} onSaved={(id) => { setForm(null); setNote(form.id ? 'Changes saved.' : 'Visa file opened.'); load(); setRev((r) => r + 1); setOpen(id); }} />}
    </Page>
  );
}
