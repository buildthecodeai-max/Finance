import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Download, FilePlus2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { ClientPick } from '../components/ClientPick';
import { Err, Field, Modal, Num, Page, Pill, Skeleton, Table } from '../components/ui';
import { today, useList, useOpenOnNew } from '../lookup';
import { csvDownload } from './SaleReports';

const STATUS_LABEL: Record<string, string> = { open: 'Open for booking', closed: 'Full / closed', departed: 'Departed', completed: 'Completed', cancelled: 'Cancelled' };
const ROOM = ['single', 'double', 'triple', 'quad'];
const r2 = (n: number) => Math.round(n * 100) / 100;
const day = (d: any) => (d ? String(d).slice(0, 10) : '');
const daysFrom = (d: any) => Math.round((Date.parse(day(d)) - Date.parse(today())) / 864e5);
const nice = (d: any) => (d ? new Date(`${day(d)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const PASSPORT: Record<string, [string, string]> = { ok: ['Valid', 'text-success'], short: ['Under 6 months after return', 'text-warn'], expired: ['Expired', 'text-danger'], missing: ['Not entered', 'text-warn'] };

const blankGroup = (cur: string) => ({ name: '', departure_date: '', return_date: '', nights_makkah: 0, nights_madinah: 0, hotel_makkah: '', hotel_madinah: '', airline: '', flight_info: '', capacity: 0, currency: cur, cost_per_pax: 0, price_per_pax: 0, status: 'open', notes: '' });

function GroupForm({ initial, onClose, onSaved }: { initial: any; onClose(): void; onSaved(id: number): void }) {
  const [f, setF] = useState<any>(initial); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const editing = !!initial.id; const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const num = (k: string) => <Num v={f[k]} set={(v) => setF({ ...f, [k]: v })} min={0} />;
  const bad = f.departure_date && f.return_date && f.return_date < f.departure_date ? 'The return date is before the departure date.' : '';
  const missing = !f.name.trim() ? 'Give the group a name, e.g. “Ramadan Umrah — Group A”.' : !f.departure_date || !f.return_date ? 'Choose the departure and return dates.' : '';
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body = { name: f.name.trim(), departure_date: f.departure_date, return_date: f.return_date, nights_makkah: Number(f.nights_makkah) || 0, nights_madinah: Number(f.nights_madinah) || 0, hotel_makkah: f.hotel_makkah || null, hotel_madinah: f.hotel_madinah || null,
        airline: f.airline || null, flight_info: f.flight_info || null, capacity: Number(f.capacity) || 0, currency: String(f.currency).toUpperCase(), cost_per_pax: Number(f.cost_per_pax) || 0, price_per_pax: Number(f.price_per_pax) || 0, status: f.status, notes: f.notes || null };
      const r = editing ? await api(`/umrah/groups/${initial.id}`, 'PUT', body) : await api('/umrah/groups', 'POST', body); onSaved(r?.id ?? initial.id);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <Modal title={editing ? `Edit ${initial.reference}` : 'New Umrah group'} onClose={onClose} wide><Err e={err} />
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-4">
      <div className="lg:col-span-2"><Field label="Group name"><input className="input" autoFocus value={f.name} onChange={set('name')} placeholder="e.g. Ramadan Umrah — Group A" /></Field></div>
      <Field label="Status"><select className="input" value={f.status} onChange={set('status')}>{Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      <Field label="Departure"><input className="input num" type="date" value={f.departure_date} onChange={set('departure_date')} /></Field>
      <Field label="Return"><input className="input num" type="date" min={f.departure_date || undefined} value={f.return_date} onChange={set('return_date')} /></Field>
      <Field label="Seats" hint="0 = no limit">{num('capacity')}</Field>
      <Field label="Makkah hotel"><input className="input" value={f.hotel_makkah ?? ''} onChange={set('hotel_makkah')} /></Field><Field label="Nights in Makkah">{num('nights_makkah')}</Field><div className="hidden lg:block" />
      <Field label="Madinah hotel"><input className="input" value={f.hotel_madinah ?? ''} onChange={set('hotel_madinah')} /></Field><Field label="Nights in Madinah">{num('nights_madinah')}</Field><div className="hidden lg:block" />
      <Field label="Airline"><input className="input" value={f.airline ?? ''} onChange={set('airline')} /></Field><div className="lg:col-span-2"><Field label="Flight details"><input className="input" value={f.flight_info ?? ''} onChange={set('flight_info')} placeholder="e.g. PK 741 KHI–JED 02:30" /></Field></div>
      <Field label="Currency"><input className="input num uppercase" maxLength={3} value={f.currency} onChange={set('currency')} /></Field>
      <Field label="Cost per person" hint="What the package costs you">{num('cost_per_pax')}</Field>
      <Field label="Price per person" hint={Number(f.price_per_pax) > 0 ? `Margin per person: ${money(r2(Number(f.price_per_pax) - Number(f.cost_per_pax || 0)), String(f.currency).toUpperCase() || 'USD')}` : 'What the client pays'}>{num('price_per_pax')}</Field>
      <div className="sm:col-span-2 lg:col-span-3"><Field label="Notes"><textarea className="input" rows={2} value={f.notes ?? ''} onChange={set('notes')} /></Field></div></div>
    {(bad || missing) && <p role="alert" className="text-sm text-warn mb-2">{bad || missing}</p>}
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !!bad || !!missing || String(f.currency).length !== 3} onClick={save}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create group'}</button></div></Modal>;
}

export function UmrahList() {
  const nav = useNavigate(); const { can, agency } = useAuth(); const [sp] = useSearchParams(); const editor = can('admin', 'finance_manager', 'agent');
  const [rows, setRows] = useState<any[] | null>(null); const [err, setErr] = useState(''); const [form, setForm] = useState<any>(null); const [q, setQ] = useState(''); const [show, setShow] = useState(sp.get('show') ?? 'upcoming');
  useEffect(() => { api('/umrah/groups').then(setRows).catch((e) => { setErr(e.message); setRows([]); }); }, []);
  useOpenOnNew(() => { if (editor) setForm(blankGroup(agency?.base_currency ?? 'USD')); });
  const all = rows ?? [];
  const upcoming = (g: any) => ['open', 'closed'].includes(g.status) && daysFrom(g.departure_date) >= 0;
  const list = useMemo(() => { const s = q.trim().toLowerCase(); return all.filter((g) => (show === 'all' ? true : show === 'upcoming' ? upcoming(g) : !upcoming(g))).filter((g) => !s || `${g.reference} ${g.name} ${g.airline ?? ''}`.toLowerCase().includes(s)); }, [rows, show, q]);
  const up = all.filter(upcoming), seats = up.reduce((s, g) => s + (g.capacity ? Math.max(0, g.capacity - g.pilgrims) : 0), 0), pending = up.reduce((s, g) => s + Math.max(0, g.pilgrims - g.visas_ready), 0);
  const stat = (title: string, value: string, sub: string, tone = '') => <div className="card"><div className="text-xs text-muted">{title}</div><div className={`text-xl font-semibold num mt-0.5 ${tone}`}>{value}</div><div className="text-xs text-muted mt-0.5">{sub}</div></div>;
  return (
    <Page title="Umrah groups" description="Plan group departures, register pilgrims, and track every passport and visa until the group flies."
      actions={editor ? <button className="btn inline-flex items-center gap-1" onClick={() => setForm(blankGroup(agency?.base_currency ?? 'USD'))}><Plus size={16} />New group</button> : undefined}>
      {rows === null ? <div className="grid sm:grid-cols-3 gap-3 mb-4"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div> : (
        <div className="grid sm:grid-cols-3 gap-3 mb-4">
          {stat('Upcoming departures', String(up.length), up.length ? `Next: ${up.sort((a, b) => day(a.departure_date).localeCompare(day(b.departure_date)))[0].name}, ${nice(up[0].departure_date)}` : 'None planned')}
          {stat('Seats still open', String(seats), 'across upcoming groups')}
          {stat('Visas still to come', String(pending), pending ? 'pilgrims without an approved visa' : 'Everyone has a visa', pending ? 'text-warn' : '')}</div>)}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex rounded-lg border border-line p-0.5 text-sm" role="tablist">{[['upcoming', 'Upcoming'], ['past', 'Past & cancelled'], ['all', 'All']].map(([k, l]) => <button key={k} role="tab" aria-selected={show === k} className={`px-3 py-1.5 rounded-md ${show === k ? 'bg-accent text-accent-ink' : 'text-muted'}`} onClick={() => setShow(k)}>{l}</button>)}</div>
        <div className="relative w-full sm:w-64"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" /><input className="input pl-8" placeholder="Search groups…" aria-label="Search groups" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
      <Err e={form ? '' : err} />
      {rows === null ? <Skeleton className="h-64" /> : (
        <Table rows={list} onRow={(g) => nav(`/umrah/${g.id}`)} empty={all.length === 0 ? (editor ? 'No groups yet — click “New group” to plan your first departure.' : 'No groups yet.') : q ? `No group matches “${q}”.` : 'Nothing here.'} cols={[
          { h: 'Group', render: (g) => <><span className="font-medium">{g.name}</span><div className="text-xs text-muted num">{g.reference}</div></> },
          { h: 'Departs', render: (g) => <><span className="num">{day(g.departure_date)}</span>{upcoming(g) && <div className={`text-xs ${daysFrom(g.departure_date) <= 14 ? 'text-warn' : 'text-muted'}`}>{daysFrom(g.departure_date) === 0 ? 'today' : `in ${plural(daysFrom(g.departure_date), 'day')}`}</div>}</> },
          { h: 'Pilgrims', right: true, render: (g) => (g.capacity ? `${g.pilgrims} / ${g.capacity}` : g.pilgrims) },
          { h: 'Visas ready', right: true, render: (g) => (g.pilgrims ? <span className={g.visas_ready < g.pilgrims ? 'text-warn' : 'text-success'}>{g.visas_ready} / {g.pilgrims}</span> : '—') },
          { h: 'Status', render: (g) => <Pill s={g.status === 'open' ? 'active' : g.status} /> },
          { h: 'Price', right: true, render: (g) => (Number(g.price_per_pax) > 0 ? `${money(g.price_per_pax, g.currency)} pp` : '—') }]} />)}
      {form && <GroupForm initial={form} onClose={() => setForm(null)} onSaved={(id) => nav(`/umrah/${id}`)} />}
    </Page>
  );
}

function PilgrimForm({ g, initial, onClose, onSaved }: { g: any; initial: any; onClose(): void; onSaved(msg: string): void }) {
  const clients = useList('/clients'); const travellers = useList('/travellers'); const [f, setF] = useState<any>(initial); const [bulk, setBulk] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const editing = !!initial.id;
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const names = bulk.split('\n').map((s) => s.trim()).filter(Boolean);
  const pick = (id: string) => { const t = travellers.find((x: any) => String(x.id) === id); setF({ ...f, traveller_id: id, ...(t ? { name: `${t.first_name} ${t.last_name}`, dob: t.dob ? day(t.dob) : f.dob, passport_expiry: t.passport_expiry ? day(t.passport_expiry) : f.passport_expiry } : {}) }); };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const n = (v: any) => (v === '' || v == null ? null : v);
      const base = { client_id: Number(f.client_id), room_type: f.room_type, gender: n(f.gender), status: f.status ?? 'registered' };
      if (editing) await api(`/umrah/pilgrims/${initial.id}`, 'PUT', { ...base, traveller_id: f.traveller_id ? Number(f.traveller_id) : null, name: f.name.trim(), passport_no: n(f.passport_no), passport_expiry: n(f.passport_expiry), dob: n(f.dob), room_no: n(f.room_no), notes: n(f.notes) });
      else if (names.length) await api(`/umrah/groups/${g.id}/pilgrims`, 'POST', names.map((name) => ({ ...base, name })));
      else await api(`/umrah/groups/${g.id}/pilgrims`, 'POST', { ...base, traveller_id: f.traveller_id ? Number(f.traveller_id) : null, name: f.name.trim(), passport_no: n(f.passport_no), passport_expiry: n(f.passport_expiry), dob: n(f.dob), room_no: n(f.room_no), notes: n(f.notes) });
      onSaved(editing ? `${f.name} was updated.` : names.length ? `${plural(names.length, 'pilgrim')} added.` : `${f.name.trim()} was added.`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const ok = f.client_id && (editing ? f.name.trim() : names.length || f.name.trim());
  return <Modal title={editing ? `Edit ${initial.name}` : 'Add pilgrims'} onClose={onClose} wide><Err e={err} />
    <div className="grid sm:grid-cols-2 gap-x-4">
      <Field label="Who is paying? (client)" hint="Invoices go to this client"><ClientPick clients={clients} value={f.client_id} onChange={(v) => setF({ ...f, client_id: v })} autoFocus={!editing} /></Field>
      <Field label="Room type"><select className="input capitalize" value={f.room_type} onChange={set('room_type')}>{ROOM.map((r) => <option key={r}>{r}</option>)}</select></Field>
      {!bulk.trim() && <>
        <Field label="Pilgrim name"><input className="input" value={f.name} onChange={set('name')} placeholder="As on the passport" /></Field>
        <Field label="From a saved traveller (optional)"><select className="input" value={f.traveller_id ?? ''} onChange={(e) => pick(e.target.value)}><option value="">Type a name instead</option>{travellers.map((t: any) => <option key={t.id} value={t.id}>{t.first_name} {t.last_name}</option>)}</select></Field>
        <Field label="Passport number"><input className="input num" value={f.passport_no ?? ''} onChange={set('passport_no')} autoComplete="off" /></Field>
        <Field label="Passport expiry" hint={f.passport_expiry && f.passport_expiry < day(g.return_date) ? 'Expires before the group returns' : 'Needs 6 months after the return date'}><input className="input num" type="date" value={f.passport_expiry ?? ''} onChange={set('passport_expiry')} /></Field>
        <Field label="Date of birth"><input className="input num" type="date" value={f.dob ?? ''} onChange={set('dob')} /></Field>
        <Field label="Gender"><select className="input" value={f.gender ?? ''} onChange={set('gender')}><option value="">Not set</option><option value="male">Male</option><option value="female">Female</option></select></Field>
        {editing && <><Field label="Room number"><input className="input" value={f.room_no ?? ''} onChange={set('room_no')} /></Field><Field label="Status"><select className="input" value={f.status} onChange={set('status')}><option value="registered">Registered</option><option value="confirmed">Confirmed</option><option value="cancelled">Cancelled</option></select></Field></>}</>}
      {!editing && <div className="sm:col-span-2"><Field label="Or add several at once" hint={names.length ? `${plural(names.length, 'pilgrim')} will be added — fill in passports afterwards` : 'One name per line. Details can be filled in later.'}><textarea className="input" rows={3} placeholder={'Ahmed Khan\nFatima Khan\nBilal Khan'} value={bulk} onChange={(e) => setBulk(e.target.value)} /></Field></div>}</div>
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !ok} onClick={save}>{busy ? 'Saving…' : editing ? 'Save changes' : names.length > 1 ? `Add ${names.length} pilgrims` : 'Add pilgrim'}</button></div></Modal>;
}

export function UmrahGroup() {
  const { id } = useParams(); const nav = useNavigate(); const { can } = useAuth(); const editor = can('admin', 'finance_manager', 'agent');
  const [g, setG] = useState<any>(null); const [err, setErr] = useState(''); const [note, setNote] = useState(''); const [edit, setEdit] = useState<any>(null); const [pform, setPform] = useState<any>(null); const [confirmDel, setConfirmDel] = useState(false); const [busy, setBusy] = useState(false);
  const load = () => api(`/umrah/groups/${id}`).then(setG).catch((e) => setErr(e.message));
  useEffect(() => { setG(null); load(); }, [id]);
  if (!g) return <Page title="Umrah group">{err ? <Err e={err} /> : <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>}</Page>;
  const live = g.pilgrims.filter((p: any) => p.status !== 'cancelled'), s = g.summary, noVisa = live.filter((p: any) => !p.visa_id).length, left = daysFrom(g.departure_date);
  const locked = ['completed', 'cancelled'].includes(g.status);
  const payers = Object.values(live.reduce((m: any, p: any) => { (m[p.client_id] ??= { client_id: p.client_id, name: p.client_name, n: 0 }).n++; return m; }, {})) as { client_id: number; name: string; n: number }[];
  const act = async (fn: () => Promise<any>, msg: string) => { setBusy(true); try { await fn(); setErr(''); setNote(msg); await load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const manifest = () => csvDownload(`manifest-${g.reference}.csv`, ['#', 'Name', 'Gender', 'Date of birth', 'Passport no', 'Passport expiry', 'Room type', 'Room no', 'Visa no', 'Visa status', 'Paid by'],
    live.map((p: any, i: number) => [i + 1, p.name, p.gender ?? '', day(p.dob), p.passport_no ?? '', day(p.passport_expiry), p.room_type, p.room_no ?? '', p.visa_reference ?? '', p.visa_status ?? '', p.client_name]));
  const blankP = { client_id: '', name: '', traveller_id: '', passport_no: '', passport_expiry: '', dob: '', gender: '', room_type: 'quad', room_no: '', notes: '', status: 'registered' };
  return (
    <Page title={g.reference} description={`${g.name} · ${nice(g.departure_date)} → ${nice(g.return_date)}`}
      actions={<><button className="btn-ghost" onClick={() => nav('/umrah')}>← Groups</button>
        {editor && !locked && <button className="btn inline-flex items-center gap-1" onClick={() => setPform({ ...blankP })}><Plus size={15} />Add pilgrims</button>}
        {editor && <button className="btn-ghost inline-flex items-center gap-1" onClick={() => setEdit({ ...g, departure_date: day(g.departure_date), return_date: day(g.return_date) })}><Pencil size={14} />Edit group</button>}
        <button className="btn-ghost inline-flex items-center gap-1" disabled={!live.length} onClick={manifest}><Download size={14} />Manifest (CSV)</button>
        {editor && !g.pilgrims.length && <button className="btn-ghost text-danger inline-flex items-center gap-1" onClick={() => setConfirmDel(true)}><Trash2 size={14} />Delete</button>}</>}>
      <Err e={err} />{note && <div role="status" className="rounded-lg border border-success/30 bg-success/10 text-success text-sm px-3 py-2 mb-3 flex justify-between gap-3"><span>{note}</span><button className="opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={() => setNote('')}><X size={14} /></button></div>}
      <div className="card mb-4 flex flex-wrap gap-x-8 gap-y-3 text-sm">
        <div><div className="text-xs text-muted">Status</div><Pill s={g.status === 'open' ? 'active' : g.status} /></div>
        <div><div className="text-xs text-muted">Departs</div><span className="num">{nice(g.departure_date)}</span>{['open', 'closed'].includes(g.status) && left >= 0 && <div className={`text-xs ${left <= 14 ? 'text-warn' : 'text-muted'}`}>{left === 0 ? 'today' : `in ${plural(left, 'day')}`}</div>}</div>
        <div><div className="text-xs text-muted">Makkah</div>{g.hotel_makkah ?? '—'}{g.nights_makkah > 0 && <div className="text-xs text-muted">{plural(g.nights_makkah, 'night')}</div>}</div>
        <div><div className="text-xs text-muted">Madinah</div>{g.hotel_madinah ?? '—'}{g.nights_madinah > 0 && <div className="text-xs text-muted">{plural(g.nights_madinah, 'night')}</div>}</div>
        <div><div className="text-xs text-muted">Flight</div>{g.airline ?? '—'}{g.flight_info && <div className="text-xs text-muted">{g.flight_info}</div>}</div>
        <div><div className="text-xs text-muted">Seats</div><b>{s.count}</b>{g.capacity > 0 && ` / ${g.capacity}`}{s.seats_left !== null && <div className={`text-xs ${s.seats_left === 0 ? 'text-warn' : 'text-muted'}`}>{s.seats_left === 0 ? 'Full' : `${s.seats_left} left`}</div>}</div>
        <div><div className="text-xs text-muted">Price per person</div><span className="num">{money(g.price_per_pax, g.currency)}</span><div className="text-xs text-muted">margin {money(r2(g.price_per_pax - g.cost_per_pax), g.currency)}</div></div>
        <div><div className="text-xs text-muted">Ready to travel</div><b className={s.ready < s.count ? 'text-warn' : 'text-success'}>{s.ready} / {s.count}</b><div className="text-xs text-muted">valid passport + approved visa</div></div></div>

      {editor && !locked && noVisa > 0 && <div className="rounded-lg border border-warn/30 bg-warn/10 text-sm px-4 py-3 mb-4 flex flex-wrap items-center justify-between gap-2"><span>{plural(noVisa, 'pilgrim')} {noVisa === 1 ? 'has' : 'have'} no visa file yet.</span>
        <button className="btn-ghost" disabled={busy} onClick={() => act(() => api(`/umrah/groups/${id}/visas`, 'POST'), `Opened ${plural(noVisa, 'visa file')} — track them on the Visas page.`)}>Open visa files for all {noVisa}</button></div>}

      <Table rows={g.pilgrims} onRow={editor && !locked ? (p) => setPform({ ...p, client_id: String(p.client_id), traveller_id: p.traveller_id ?? '', passport_expiry: day(p.passport_expiry), dob: day(p.dob), gender: p.gender ?? '', room_no: p.room_no ?? '' }) : undefined}
        empty={editor ? 'No pilgrims yet — click “Add pilgrims”. You can paste a whole family’s names in one go.' : 'No pilgrims yet.'} cols={[
          { h: 'Pilgrim', render: (p: any) => <><span className={`font-medium ${p.status === 'cancelled' ? 'line-through text-muted' : ''}`}>{p.name}</span><div className="text-xs text-muted">Paid by {p.client_name}</div></> },
          { h: 'Passport', render: (p: any) => { const [l, c] = PASSPORT[p.passport_state]; return <><span className="num">{p.passport_no ?? '—'}</span><div className={`text-xs ${c}`}>{l}{p.passport_expiry && p.passport_state !== 'missing' ? ` · ${day(p.passport_expiry)}` : ''}</div></>; } },
          { h: 'Visa', render: (p: any) => (p.visa_status ? <button className="text-left" onClick={(e) => { e.stopPropagation(); nav(`/visas?open=${p.visa_id}`); }}><Pill s={p.visa_status} /><div className="text-xs text-muted num underline decoration-dotted">{p.visa_reference}</div></button> : <span className="text-muted">No file</span>) },
          { h: 'Room', render: (p: any) => <span className="capitalize">{p.room_type}{p.room_no ? ` · ${p.room_no}` : ''}</span> },
          { h: 'Ready', render: (p: any) => (p.status === 'cancelled' ? <Pill s="cancelled" /> : p.ready ? <span className="text-success">✓ Ready</span> : <span className="text-muted">Not yet</span>) }]} />

      {payers.length > 0 && Number(g.price_per_pax) > 0 && <div className="card mt-4"><h3 className="font-semibold text-sm mb-2">Invoicing</h3>
        <div className="space-y-2 text-sm">{payers.map((c) => <div key={c.client_id} className="flex flex-wrap items-center justify-between gap-2"><span>{c.name} — {plural(c.n, 'pilgrim')} · <b className="num">{money(r2(c.n * Number(g.price_per_pax)), g.currency)}</b></span>
          {editor && <button className="btn-ghost inline-flex items-center gap-1" onClick={() => nav(`/invoices?umrah=${g.id}&client=${c.client_id}`)}><FilePlus2 size={14} />Create invoice</button>}</div>)}</div>
        <p className="text-xs text-muted mt-2">Total {money(s.revenue, g.currency)} · cost {money(s.cost, g.currency)} · margin {money(r2(s.revenue - s.cost), g.currency)}</p></div>}

      {edit && <GroupForm initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setNote('Group updated.'); load(); }} />}
      {pform && <PilgrimForm g={g} initial={pform} onClose={() => setPform(null)} onSaved={(m) => { setPform(null); setNote(m); load(); }} />}
      {confirmDel && <Modal title={`Delete ${g.reference}?`} onClose={() => setConfirmDel(false)}><p className="text-sm mb-3">This group has no pilgrims, so it can be removed completely.</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setConfirmDel(false)}>Cancel</button><button className="btn bg-danger text-white" onClick={async () => { try { await api(`/umrah/groups/${id}`, 'DELETE'); nav('/umrah'); } catch (e: any) { setErr(e.message); setConfirmDel(false); } }}>Delete</button></div></Modal>}
      {editor && !locked && live.length > 0 && <p className="text-xs text-muted mt-2">Click a pilgrim to edit their details, change the room, or cancel them.</p>}
    </Page>
  );
}
