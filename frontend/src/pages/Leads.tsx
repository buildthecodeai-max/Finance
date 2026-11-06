import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, CalendarClock, LayoutGrid, List, Mail, Phone, Plus, Search, StickyNote, Users, X } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Pill, Skeleton, Table } from '../components/ui';
import { isoDate, today, useList, useOpenOnNew } from '../lookup';

const STAGES = ['new', 'contacted', 'quoted', 'negotiating', 'won', 'lost'] as const;
const OPEN = ['new', 'contacted', 'quoted', 'negotiating'];
const LABEL: Record<string, string> = { new: 'New', contacted: 'Contacted', quoted: 'Quote sent', negotiating: 'Negotiating', won: 'Won', lost: 'Lost' };
const HINT: Record<string, string> = { new: 'Just came in', contacted: 'You have spoken to them', quoted: 'They have a quote', negotiating: 'Close to deciding' };
const NEXT: Record<string, string> = { new: 'contacted', contacted: 'quoted', quoted: 'negotiating', negotiating: 'won' };
const NEXT_LABEL: Record<string, string> = { new: 'Mark contacted', contacted: 'Quote sent', quoted: 'Negotiating', negotiating: 'Mark won' };
const EDGE: Record<string, string> = { new: 'border-l-info', contacted: 'border-l-accent', quoted: 'border-l-warn', negotiating: 'border-l-[#a78bfa]', won: 'border-l-success', lost: 'border-l-danger' };
const SOURCES = ['Website', 'Phone call', 'Walk-in', 'Referral', 'Social media', 'WhatsApp', 'Repeat client', 'Other'];
const LOST_REASONS = ['Price too high', 'Chose another agency', 'No response', 'Postponed the trip', 'No longer travelling', 'Other'];
const KINDS: [string, string][] = [['note', 'Note'], ['call', 'Call'], ['email', 'Email'], ['meeting', 'Meeting']];

const d10 = (d: any) => (d ? String(d).slice(0, 10) : '');
const daysFrom = (d: any) => Math.round((Date.parse(d10(d)) - Date.parse(today())) / 864e5);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const niceDate = (d: any) => (d ? new Date(`${d10(d)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const shortDate = (d: any) => new Date(`${d10(d)}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const monthYear = (d: any) => new Date(`${d10(d)}T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
const addDays = (n: number) => isoDate(new Date(Date.now() + n * 864e5));
const ago = (ts: any) => { if (!ts) return ''; const n = Math.floor((Date.now() - new Date(ts).getTime()) / 864e5); return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`; };
const sinceContact = (l: any) => Math.floor((Date.now() - new Date(l.last_contact_at ?? l.created_at).getTime()) / 864e5);
const isOpen = (l: any) => OPEN.includes(l.stage);
const dueNow = (l: any) => isOpen(l) && !!l.next_action_at && daysFrom(l.next_action_at) <= 0;
const quiet = (l: any) => isOpen(l) && sinceContact(l) >= 7 && !(l.next_action_at && daysFrom(l.next_action_at) > 0);
const isEmail = (v: string) => /^\S+@\S+\.\S+$/.test(v.trim());
const initials = (n?: string | null) => (n ?? '?').split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();

/** What the next follow-up is, and how urgent it is — in words, not just a date. */
function follow(l: any): { text: string; tone: string } | null {
  if (!isOpen(l)) return null;
  if (!l.next_action_at) return { text: 'No follow-up planned', tone: 'text-muted' };
  const n = daysFrom(l.next_action_at), what = l.next_action || 'Follow up';
  return n < 0 ? { text: `${what} — ${plural(-n, 'day')} overdue`, tone: 'text-danger' } : n === 0 ? { text: `${what} — today`, tone: 'text-warn' } : n === 1 ? { text: `${what} — tomorrow`, tone: 'text-muted' } : { text: `${what} — ${shortDate(l.next_action_at)}`, tone: 'text-muted' };
}
const trip = (l: any) => [l.destination ?? l.enquiry_type, l.party_size ? plural(l.party_size, 'traveller') : null, l.travel_start ? monthYear(l.travel_start) : null].filter(Boolean).join(' · ');

const Banner = ({ ok = true, children, onClose }: { ok?: boolean; children: any; onClose?(): void }) => (
  <div role={ok ? 'status' : 'alert'} className={`rounded-lg border text-sm px-3 py-2 mb-3 flex justify-between gap-3 ${ok ? 'border-success/30 bg-success/10 text-success' : 'border-warn/30 bg-warn/10 text-warn'}`}>
    <span>{children}</span>{onClose && <button className="opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={onClose}><X size={14} /></button>}</div>
);

/** One form for adding and editing a lead. */
function LeadForm({ initial, owners, canAssign, onClose, onSaved }: { initial: any; owners: any[]; canAssign: boolean; onClose(): void; onSaved(id: number, dupes: any[]): void }) {
  const { agency, user } = useAuth(); const editing = !!initial.id;
  const [f, setF] = useState<any>(initial); const [note, setNote] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [dupes, setDupes] = useState<any[]>([]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  useEffect(() => {
    if (editing) return; const email = isEmail(f.email ?? '') ? f.email.trim() : '', phone = String(f.phone ?? '').replace(/\D/g, '').length >= 6 ? f.phone.trim() : '';
    if (!email && !phone) { setDupes([]); return; }
    const h = setTimeout(() => api(`/leads/duplicates?email=${encodeURIComponent(email)}&phone=${encodeURIComponent(phone)}`).then(setDupes).catch(() => setDupes([])), 500);
    return () => clearTimeout(h);
  }, [f.email, f.phone]);
  const badEmail = !!f.email?.trim() && !isEmail(f.email), badDates = f.travel_start && f.travel_end && f.travel_end < f.travel_start;
  const missing = !f.name.trim() ? 'Enter the person’s name.' : '';
  const chip = (label: string, n: number) => <button key={label} type="button" className="btn-ghost text-xs" onClick={() => setF({ ...f, next_action_at: addDays(n), next_action: f.next_action || 'Call to follow up' })}>{label}</button>;
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const n = (v: any) => (v === '' || v == null ? null : v);
      const body: any = { name: f.name.trim(), email: n(f.email?.trim()), phone: n(f.phone?.trim()), source: n(f.source), destination: n(f.destination?.trim()), travel_start: n(f.travel_start), travel_end: n(f.travel_end),
        party_size: f.party_size === '' || f.party_size == null ? null : Number(f.party_size), budget_max: f.budget_max === '' || f.budget_max == null ? null : Number(f.budget_max), currency: String(f.currency || agency?.base_currency || 'USD').toUpperCase(),
        next_action: n(f.next_action?.trim()), next_action_at: n(f.next_action_at), ...(canAssign && f.owner_id ? { owner_id: Number(f.owner_id) } : {}) };
      const r = editing ? await api(`/leads/${initial.id}`, 'PUT', body) : await api('/leads', 'POST', body);
      const id = editing ? initial.id : r.id;
      if (!editing && note.trim()) await api('/crm/activities', 'POST', { entity_type: 'lead', entity_id: id, kind: 'note', body: note.trim() });
      onSaved(id, editing ? [] : r.duplicates ?? []);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <Modal title={editing ? `Edit ${initial.name}` : 'New lead'} onClose={onClose} wide><Err e={err} />
    {dupes.length > 0 && <div className="rounded-lg border border-warn/30 bg-warn/10 text-warn text-sm px-3 py-2 mb-3">This email or phone already belongs to {dupes.map((d) => `${d.type} “${d.name}”`).join(', ')}. You can still save, but check it isn’t the same person.</div>}
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-4">
      <Field label="Name"><input className="input" autoFocus value={f.name} onChange={set('name')} placeholder="Who is asking?" /></Field>
      <Field label="Phone" hint="Include the country code"><input className="input num" value={f.phone ?? ''} onChange={set('phone')} placeholder="+92 300 1234567" /></Field>
      <Field label="Email" hint={badEmail ? 'That doesn’t look like an email address.' : undefined}><input className="input" type="email" value={f.email ?? ''} onChange={set('email')} /></Field>
      <Field label="Where did they find you?"><select className="input" value={f.source ?? ''} onChange={set('source')}><option value="">Not sure</option>{SOURCES.map((s) => <option key={s}>{s}</option>)}{f.source && !SOURCES.includes(f.source) && <option>{f.source}</option>}</select></Field>
      <Field label="Where do they want to go?"><input className="input" value={f.destination ?? ''} onChange={set('destination')} placeholder="e.g. Maldives" /></Field>
      <Field label="Travellers"><Num v={f.party_size} set={(v) => setF({ ...f, party_size: v })} min={1} /></Field>
      <Field label="Leaving around"><input className="input num" type="date" value={f.travel_start ?? ''} onChange={set('travel_start')} /></Field>
      <Field label="Back around" hint={badDates ? 'That is before the start date.' : undefined}><input className="input num" type="date" min={f.travel_start || undefined} value={f.travel_end ?? ''} onChange={set('travel_end')} /></Field>
      <div className="grid grid-cols-[5rem_1fr] gap-x-2"><Field label="Currency"><input className="input num uppercase" maxLength={3} value={f.currency ?? ''} onChange={set('currency')} /></Field><Field label="Budget (up to)"><Num v={f.budget_max} set={(v) => setF({ ...f, budget_max: v })} min={0} /></Field></div>
      {canAssign && <Field label="Looked after by"><select className="input" value={f.owner_id ?? ''} onChange={set('owner_id')}>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}{o.id === user?.id ? ' (you)' : ''}</option>)}</select></Field>}
    </div>
    <div className="rounded-lg border border-line bg-surface2/40 p-3 mb-3">
      <div className="text-xs font-medium text-muted mb-2">Next follow-up</div>
      <div className="grid sm:grid-cols-[1fr_11rem] gap-3 mb-2"><input className="input" aria-label="What to do next" value={f.next_action ?? ''} onChange={set('next_action')} placeholder="e.g. Call to confirm dates" /><input className="input num" type="date" aria-label="Follow-up date" min={today()} value={f.next_action_at ? d10(f.next_action_at) : ''} onChange={set('next_action_at')} /></div>
      <div className="flex flex-wrap gap-1.5">{chip('Tomorrow', 1)}{chip('In 3 days', 3)}{chip('Next week', 7)}{f.next_action_at && <button type="button" className="btn-ghost text-xs" onClick={() => setF({ ...f, next_action_at: '', next_action: '' })}>Clear</button>}</div>
    </div>
    {!editing && <Field label="What did they ask for? (optional)" hint="Saved as the first note on the lead"><textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Honeymoon, wants an overwater villa, flexible on dates" /></Field>}
    {(missing || badEmail || badDates) && <p role="alert" className="text-sm text-warn mb-2">{missing || (badEmail ? 'Check the email address.' : 'The return date is before the departure date.')}</p>}
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !!missing || badEmail || !!badDates} onClick={save}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add lead'}</button></div></Modal>;
}

/** Asks why a lead was lost — it is the most useful thing to know later. */
function LostDialog({ lead, onClose, onDone }: { lead: any; onClose(): void; onDone(): void }) {
  const [why, setWhy] = useState(''); const [more, setMore] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await api(`/leads/${lead.id}`, 'PUT', { stage: 'lost', lost_reason: `${why}${more.trim() ? ` — ${more.trim()}` : ''}`.slice(0, 190) }); onDone(); } catch (e: any) { setErr(e.message); setBusy(false); } };
  return <Modal title={`Mark ${lead.name} as lost`} onClose={onClose}><Err e={err} />
    <p className="text-sm text-muted mb-3">Closed leads move out of your way. Saying why helps you see patterns later — for example if price is the main reason.</p>
    <Field label="Why was it lost?"><select className="input" autoFocus value={why} onChange={(e) => setWhy(e.target.value)}><option value="">Choose a reason…</option>{LOST_REASONS.map((r) => <option key={r}>{r}</option>)}</select></Field>
    <Field label="Anything to add? (optional)"><input className="input" value={more} onChange={(e) => setMore(e.target.value)} placeholder="e.g. Went with a cheaper package at $2,100" /></Field>
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn bg-danger text-white" disabled={!why || busy} onClick={save}>Mark as lost</button></div></Modal>;
}

function LeadDetail({ id, owners, canAssign, onClose, onChange, onEdit }: { id: number; owners: any[]; canAssign: boolean; onClose(): void; onChange(msg?: string): void; onEdit(l: any): void }) {
  const nav = useNavigate(); const { can } = useAuth(); const write = can('admin', 'finance_manager', 'agent');
  const [l, setL] = useState<any>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const [kind, setKind] = useState('note'); const [note, setNote] = useState(''); const [task, setTask] = useState(''); const [taskDue, setTaskDue] = useState('');
  const [fu, setFu] = useState<any>(null); const [lost, setLost] = useState(false);
  const load = () => api(`/leads/${id}`).then(setL).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (!l) return <Modal title="Lead" wide onClose={onClose}>{err ? <Err e={err} /> : <Skeleton className="h-48" />}</Modal>;
  const run = async (fn: () => Promise<any>, ok = '') => { try { await fn(); setErr(''); setMsg(ok); await load(); onChange(); } catch (e: any) { setErr(e.message); setMsg(''); } };
  const put = (body: any, ok = '') => run(() => api(`/leads/${id}`, 'PUT', body), ok);
  const before = (l.activities ?? []).map((a: any) => String(a.body).match(/Stage changed: (\w+) → lost/)?.[1]).find((x: any) => x && OPEN.includes(x)) ?? 'contacted';   // the stage it was in before it was lost
  const open = isOpen(l), f = follow(l), idx = ['new', 'contacted', 'quoted', 'negotiating', 'won'].indexOf(l.stage);
  const nights = l.travel_start && l.travel_end ? Math.max(0, Math.round((Date.parse(d10(l.travel_end)) - Date.parse(d10(l.travel_start))) / 864e5)) : null;
  const activityIcon = (k: string) => (k === 'call' ? <Phone size={13} /> : k === 'email' ? <Mail size={13} /> : k === 'meeting' ? <Users size={13} /> : k === 'note' ? <StickyNote size={13} /> : <span className="h-1.5 w-1.5 rounded-full bg-muted inline-block" />);
  return (
    <Modal title={l.name} wide onClose={onClose}>
      <Err e={err} />{msg && <Banner onClose={() => setMsg('')}>{msg}</Banner>}
      {l.duplicates?.length > 0 && <div className="mb-3 text-sm text-warn bg-warn/10 border border-warn/30 rounded-lg px-3 py-2">Possible duplicate of: {l.duplicates.map((d: any) => `${d.type} “${d.name}”`).join(', ')}</div>}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <Pill s={l.stage} />{l.source && <span className="text-muted">via {l.source}</span>}<span className="text-muted">· added {ago(l.created_at)}{l.owner_name ? ` · looked after by ${l.owner_name}` : ''}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {write && <button className="btn inline-flex items-center gap-1" onClick={() => nav(`/quotes/new?lead=${id}${l.client_id ? `&client=${l.client_id}` : ''}`)}>Create quote</button>}
          {write && (l.client_id ? <button className="btn-ghost" onClick={() => nav(`/clients?open=${l.client_id}`)}>Open client</button> : <button className="btn-ghost" title="Turns this person into a client so you can quote and book them" onClick={() => run(() => api(`/leads/${id}/convert-client`, 'POST'), `${l.name} is now a client.`)}>Convert to client</button>)}
          {write && <button className="btn-ghost" onClick={() => onEdit(l)}>Edit details</button>}
          {write && open && <button className="btn-ghost text-danger" onClick={() => setLost(true)}>Mark lost</button>}</div></div>

      {l.stage === 'lost' ? <div className="rounded-lg border border-danger/30 bg-danger/10 text-danger text-sm px-3 py-2 mb-3 flex flex-wrap items-center justify-between gap-2"><span>This lead was lost{l.lost_reason ? `: ${l.lost_reason}` : '.'}</span>{write && <button className="btn-ghost" onClick={() => put({ stage: before }, `Lead reopened as ${LABEL[before].toLowerCase()}.`)}>Reopen as “{LABEL[before]}”</button>}</div>
        : <ol className="flex flex-wrap gap-1 mb-3 text-xs" aria-label="Lead progress">{['new', 'contacted', 'quoted', 'negotiating', 'won'].map((s, i) => (
          <li key={s}><button type="button" disabled={!write || s === l.stage} aria-current={s === l.stage ? 'step' : undefined} title={HINT[s]} onClick={() => put({ stage: s }, `Moved to ${LABEL[s].toLowerCase()}.`)}
            className={`px-2.5 py-1 rounded-full border ${i < idx ? 'border-success/40 bg-success/10 text-success' : i === idx ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line text-muted hover:bg-surface2'} ${!write || s === l.stage ? 'cursor-default' : ''}`}>{i < idx && '✓ '}{LABEL[s]}</button></li>))}</ol>}

      <div className="grid lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3 space-y-4">
          <div className="card !p-4 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div><div className="text-xs text-muted">Email</div>{l.email ? <a className="text-accent hover:underline break-all" href={`mailto:${l.email}`}>{l.email}</a> : <span className="text-muted">Not added</span>}</div>
            <div><div className="text-xs text-muted">Phone</div>{l.phone ? <a className="text-accent hover:underline num" href={`tel:${l.phone}`}>{l.phone}</a> : <span className="text-muted">Not added</span>}</div>
            <div><div className="text-xs text-muted">Wants to go to</div>{l.destination ?? l.enquiry_type ?? <span className="text-muted">Not said</span>}</div>
            <div><div className="text-xs text-muted">Travellers</div>{l.party_size ?? <span className="text-muted">—</span>}</div>
            <div><div className="text-xs text-muted">Travel dates</div>{l.travel_start ? <>{niceDate(l.travel_start)}{l.travel_end ? ` → ${niceDate(l.travel_end)}` : ''}{nights ? <span className="text-xs text-muted"> · {plural(nights, 'night')}</span> : ''}</> : <span className="text-muted">Not decided</span>}</div>
            <div><div className="text-xs text-muted">Budget</div>{l.budget_max ? `up to ${money(l.budget_max, l.currency ?? 'USD')}` : <span className="text-muted">Not said</span>}</div>
            {canAssign && owners.length > 1 && <div className="sm:col-span-2"><div className="text-xs text-muted mb-1">Looked after by</div><select className="input w-auto" value={l.owner_id ?? ''} onChange={(e) => put({ owner_id: Number(e.target.value) }, 'Owner changed.')}>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>}
          </div>

          {open && <div className="card !p-4">
            <div className="flex items-center justify-between mb-2"><h4 className="font-semibold text-sm flex items-center gap-2"><CalendarClock size={15} />Next follow-up</h4>{write && !fu && <button className="text-accent text-xs underline" onClick={() => setFu({ text: l.next_action ?? '', date: d10(l.next_action_at) })}>{l.next_action_at ? 'Change' : 'Schedule'}</button>}</div>
            {!fu ? (f ? <div className={`text-sm ${f.tone}`}>{f.text}{!l.next_action_at && write && <div className="text-xs text-warn mt-1">Pick a date so this lead doesn’t go cold.</div>}</div> : null) : <>
              <div className="grid sm:grid-cols-[1fr_11rem] gap-2 mb-2"><input className="input" autoFocus aria-label="What to do next" placeholder="e.g. Send the Maldives options" value={fu.text} onChange={(e) => setFu({ ...fu, text: e.target.value })} /><input className="input num" type="date" aria-label="Follow-up date" min={today()} value={fu.date} onChange={(e) => setFu({ ...fu, date: e.target.value })} /></div>
              <div className="flex flex-wrap gap-1.5 items-center">{[['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7]].map(([lb, n]) => <button key={lb as string} type="button" className="btn-ghost text-xs" onClick={() => setFu({ ...fu, date: addDays(n as number), text: fu.text || 'Call to follow up' })}>{lb}</button>)}
                <span className="flex-1" /><button className="btn-ghost text-xs" onClick={() => setFu(null)}>Cancel</button>{l.next_action_at && <button className="btn-ghost text-xs text-danger" onClick={() => { put({ next_action: null, next_action_at: null }, 'Follow-up cleared.'); setFu(null); }}>Clear</button>}
                <button className="btn" disabled={!fu.date} onClick={() => { put({ next_action: fu.text.trim() || null, next_action_at: fu.date }, 'Follow-up scheduled.'); setFu(null); }}>Save</button></div></>}
          </div>}

          {l.quotes?.length > 0 && <div className="card !p-4"><h4 className="font-semibold text-sm mb-2">Quotes for this lead</h4><ul className="space-y-1 text-sm">{l.quotes.map((q: any) => <li key={q.id}><button className="w-full flex items-center justify-between gap-2 hover:bg-surface2/60 rounded px-1 py-0.5 text-left" onClick={() => nav(`/quotes/${q.id}`)}><span><span className="num font-medium">{q.quote_no}</span> <span className="text-muted">{q.title}</span></span><Pill s={q.status} /></button></li>)}</ul></div>}

          <div className="card !p-4"><h4 className="font-semibold text-sm mb-2">To-do</h4>
            {!l.tasks.length && <p className="text-sm text-muted mb-2">Nothing to do yet. Add reminders such as “send brochure”.</p>}
            <ul className="space-y-1.5 mb-2">{l.tasks.map((k: any) => { const late = k.status === 'open' && k.due_at && daysFrom(k.due_at) < 0; return <li key={k.id} className="flex justify-between gap-3 text-sm items-center"><span className={k.status === 'done' ? 'line-through text-muted' : ''}>{k.title}{k.due_at && <span className={`num text-xs ml-2 ${late ? 'text-danger' : 'text-muted'}`}>{late ? 'overdue · ' : 'due '}{shortDate(k.due_at)}</span>}</span>{k.status === 'open' && write && <button className="btn-ghost text-xs" onClick={() => run(() => api(`/crm/tasks/${k.id}/complete`, 'POST', {}), 'Task done.')}>Done</button>}</li>; })}</ul>
            {write && <div className="flex flex-wrap gap-2"><input className="input flex-1 min-w-[10rem]" aria-label="New to-do" placeholder="New to-do…" value={task} onChange={(e) => setTask(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && task.trim()) document.getElementById('lead-add-task')?.click(); }} />
              <input className="input w-36 num" type="date" aria-label="Due date" min={today()} value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
              <button id="lead-add-task" className="btn-ghost" disabled={!task.trim()} onClick={() => run(async () => { await api('/crm/tasks', 'POST', { title: task.trim(), entity_type: 'lead', entity_id: id, ...(taskDue ? { due_at: taskDue } : {}) }); setTask(''); setTaskDue(''); }, 'To-do added.')}>Add</button></div>}</div>
        </div>

        <div className="lg:col-span-2"><div className="card !p-4 h-full"><h4 className="font-semibold text-sm mb-2">Conversation</h4>
          {write && <div className="mb-3"><div className="flex gap-1 mb-2" role="group" aria-label="Type of entry">{KINDS.map(([k, lb]) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={`text-xs px-2.5 py-1 rounded-full border ${kind === k ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line text-muted hover:bg-surface2'}`}>{lb}</button>)}</div>
            <textarea className="input" rows={3} aria-label="What happened" placeholder={kind === 'call' ? 'What was said on the call?' : kind === 'email' ? 'What did you send or receive?' : kind === 'meeting' ? 'What was agreed?' : 'Write a note…'} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex justify-end mt-2"><button className="btn-ghost" disabled={!note.trim()} onClick={() => run(async () => { await api('/crm/activities', 'POST', { entity_type: 'lead', entity_id: id, kind, body: note.trim() }); setNote(''); }, `${KINDS.find(([k]) => k === kind)![1]} logged.`)}>Log {KINDS.find(([k]) => k === kind)![1].toLowerCase()}</button></div></div>}
          <ul className="space-y-3 max-h-[26rem] overflow-auto pr-1">{l.activities.map((a: any) => <li key={a.id} className="text-sm flex gap-2"><span className={`mt-1 shrink-0 ${a.kind === 'system' ? 'text-muted' : 'text-accent'}`}>{activityIcon(a.kind)}</span><div><div className={a.kind === 'system' ? 'text-muted' : ''}>{a.body}</div><div className="text-xs text-muted">{a.user_name ?? 'System'} · {new Date(a.created_at).toLocaleString()}</div></div></li>)}
            {!l.activities.length && <li className="text-sm text-muted">No history yet. Log calls, emails and notes here so anyone can pick up where you left off.</li>}</ul></div></div>
      </div>
      {lost && <LostDialog lead={l} onClose={() => setLost(false)} onDone={() => { setLost(false); setMsg('Lead marked as lost.'); load(); onChange(); }} />}
    </Modal>
  );
}

export default function Leads() {
  const { can, agency, user } = useAuth(); const nav = useNavigate(); const [sp, setSp] = useSearchParams();
  const write = can('admin', 'finance_manager', 'agent'), canAssign = can('admin', 'finance_manager'); const owners = useList('/team/agents');
  const TABS: { key: string; label: string; test: (l: any) => boolean }[] = [
    { key: 'open', label: 'Open', test: isOpen }, { key: 'followup', label: 'Follow-up due', test: dueNow }, { key: 'quiet', label: 'Going quiet', test: quiet },
    { key: 'won', label: 'Won', test: (l) => l.stage === 'won' }, { key: 'lost', label: 'Lost', test: (l) => l.stage === 'lost' }, { key: 'all', label: 'All', test: () => true }];
  const [rows, setRows] = useState<any[] | null>(null); const [err, setErr] = useState(''); const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [tab, setTab] = useState(TABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab')! : 'open'); const [q, setQ] = useState(sp.get('q') ?? ''); const [ownerF, setOwnerF] = useState('');
  const [view, setView] = useState<'board' | 'list'>(() => { try { const v = localStorage.getItem('tf-leads-view'); if (v === 'board' || v === 'list') return v; } catch { /* ignore */ } return typeof window !== 'undefined' && window.innerWidth < 768 ? 'list' : 'board'; });
  const [open, setOpen] = useState<number | null>(Number(sp.get('open')) || null); const [form, setForm] = useState<any>(null); const [lostFor, setLostFor] = useState<any>(null); const [drag, setDrag] = useState(''); const [rev, setRev] = useState(0);
  const load = () => api('/leads').then((r) => { setRows(r); setErr(''); }).catch((e) => { setErr(e.message); setRows([]); });
  useEffect(() => { load(); }, []);
  useEffect(() => { if (sp.has('open')) { const n = new URLSearchParams(sp); n.delete('open'); setSp(n, { replace: true }); } }, []);
  const blank = () => ({ name: '', email: '', phone: '', source: '', destination: '', party_size: 2, budget_max: '', currency: agency?.base_currency ?? 'USD', travel_start: '', travel_end: '', next_action: 'Call to follow up', next_action_at: addDays(1), owner_id: user?.id ?? '' });
  useOpenOnNew(() => { if (write) setForm(blank()); });

  const all = rows ?? [];
  const ownerList = useMemo(() => [...new Map(all.filter((l) => l.owner_id).map((l) => [l.owner_id, l.owner_name])).entries()], [rows]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, all.filter(t.test).length])), [rows]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase(), t = TABS.find((x) => x.key === tab)!;
    return all.filter(t.test).filter((l) => !ownerF || String(l.owner_id) === ownerF).filter((l) => !s || [l.name, l.email, l.phone, l.destination, l.source].some((v) => String(v ?? '').toLowerCase().includes(s)));
  }, [rows, tab, q, ownerF]);
  const openL = all.filter(isOpen), won = all.filter((l) => l.stage === 'won'), lostN = all.filter((l) => l.stage === 'lost').length, wonMonth = won.filter((l) => d10(l.updated_at) >= `${today().slice(0, 7)}-01`).length;
  const overdue = all.filter((l) => isOpen(l) && l.next_action_at && daysFrom(l.next_action_at) < 0).length;
  const budgets = openL.filter((l) => l.budget_max), curs = new Set(budgets.map((l) => l.currency ?? 'USD')), potential = curs.size === 1 ? budgets.reduce((s, l) => s + Number(l.budget_max), 0) : 0;
  const winRate = won.length + lostN ? Math.round((won.length / (won.length + lostN)) * 100) : null;
  const listView = view === 'list' || ['won', 'lost', 'all'].includes(tab);

  const move = async (l: any, stage: string) => {
    if (stage === l.stage || !write) return;
    if (stage === 'lost') { setLostFor(l); return; }
    const before = rows; setRows((rs) => (rs ?? []).map((x) => (x.id === l.id ? { ...x, stage } : x)));          // show the move at once; undo if the server says no
    try { await api(`/leads/${l.id}`, 'PUT', { stage }); setNote({ ok: true, text: `${l.name} moved to ${LABEL[stage].toLowerCase()}.` }); load(); }
    catch (e: any) { setRows(before); setNote({ ok: false, text: e.message }); }
  };
  const byDue = (a: any, b: any) => (a.next_action_at ? d10(a.next_action_at) : '9999').localeCompare(b.next_action_at ? d10(b.next_action_at) : '9999') || String(b.updated_at).localeCompare(String(a.updated_at));
  const stat = (key: string, title: string, value: string, sub: string, tone = '') => (
    <button type="button" onClick={() => setTab(key)} className={`card text-left hover:bg-surface2/70 transition-colors ${tab === key ? 'ring-1 ring-accent' : ''}`}>
      <div className="text-xs text-muted">{title}</div><div className={`text-xl font-semibold num mt-0.5 ${tone}`}>{value}</div><div className="text-[11px] sm:text-xs text-muted mt-0.5">{sub}</div></button>);
  const nextBtn = (l: any) => write && NEXT[l.stage] && <button type="button" className="btn-ghost !px-2 !py-0.5 text-[11px] inline-flex items-center gap-1" onClick={(e) => { e.stopPropagation(); move(l, NEXT[l.stage]); }}>{NEXT_LABEL[l.stage]}<ArrowRight size={11} /></button>;

  const card = (l: any, showStage = false) => { const fu = follow(l); return (
    <div key={l.id} role="button" tabIndex={0} draggable={write} onDragStart={(e) => e.dataTransfer.setData('id', String(l.id))} onClick={() => setOpen(l.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(l.id); }}
      className={`bg-bg border border-line border-l-4 ${EDGE[l.stage]} rounded-lg px-3 py-2.5 hover:bg-surface2/70 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent outline-none`}>
      <div className="flex items-start justify-between gap-2"><div className="text-sm font-medium truncate">{l.name}</div>{showStage ? <Pill s={l.stage} /> : ownerList.length > 1 && <span title={l.owner_name} className="text-[10px] h-5 w-5 rounded-full bg-surface2 text-muted grid place-items-center shrink-0">{initials(l.owner_name)}</span>}</div>
      <div className="text-xs text-muted truncate">{trip(l) || 'No trip details yet'}</div>
      {l.budget_max && <div className="text-xs text-muted num">up to {money(l.budget_max, l.currency ?? 'USD')}</div>}
      {fu && <div className={`text-xs mt-1 ${fu.tone}`}>{fu.text}</div>}
      <div className="text-[11px] text-muted mt-1">{l.quote_count > 0 ? `${plural(l.quote_count, 'quote')} · ` : ''}{l.last_contact_at ? `last spoke ${ago(l.last_contact_at)}` : 'not contacted yet'}</div>
      {NEXT[l.stage] && write && <div className="mt-1.5 flex justify-end">{nextBtn(l)}</div>}
    </div>); };

  return (
    <Page title="Leads" description="People who've asked about a trip but haven't booked yet — follow up, quote, win."
      actions={<><div className="inline-flex rounded-lg border border-line p-0.5 text-sm" role="group" aria-label="View">
        {([['board', LayoutGrid, 'Board'], ['list', List, 'List']] as const).map(([k, Icon, lb]) => <button key={k} aria-pressed={view === k} className={`px-2.5 py-1 rounded-md inline-flex items-center gap-1 ${view === k ? 'bg-accent text-accent-ink' : 'text-muted'}`} onClick={() => { setView(k); try { localStorage.setItem('tf-leads-view', k); } catch { /* ignore */ } if (k === 'board' && ['won', 'lost', 'all'].includes(tab)) setTab('open'); }}><Icon size={14} />{lb}</button>)}</div>
        {write && <button className="btn inline-flex items-center gap-1" onClick={() => setForm(blank())}><Plus size={16} />New lead</button>}</>}>
      {rows === null ? <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div> : (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
          {stat('open', 'Open leads', String(openL.length), `${openL.filter((l) => l.stage === 'new').length} brand new${potential > 0 ? ` · about ${money(potential, [...curs][0] as string)} in budgets` : ''}`)}
          {stat('followup', 'Follow-ups due', String(counts.followup), counts.followup ? `${overdue ? `${overdue} overdue · ` : ''}needs a call or message today` : 'Nothing due — nice', counts.followup ? 'text-warn' : '')}
          {stat('quiet', 'Going quiet', String(counts.quiet), counts.quiet ? 'No contact for a week or more' : 'Everyone has been contacted recently', counts.quiet ? 'text-warn' : '')}
          {stat('won', 'Won this month', String(wonMonth), winRate !== null ? `You win ${winRate}% of closed leads` : 'No closed leads yet', wonMonth ? 'text-success' : '')}</div>)}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1 basis-full min-w-0" role="tablist" aria-label="Lead views">
          {TABS.map((t) => <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className={`whitespace-nowrap text-sm px-3 py-1.5 rounded-lg border ${tab === t.key ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>{t.label}{rows && t.key !== 'all' && <span className="ml-1.5 text-xs opacity-70 num">{counts[t.key]}</span>}</button>)}</div>
        <div className="relative w-full sm:w-72"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" /><input className="input pl-8" placeholder="Search name, phone, email, destination…" aria-label="Search leads" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {canAssign && ownerList.length > 1 && <select className="input w-auto" aria-label="Looked after by" value={ownerF} onChange={(e) => setOwnerF(e.target.value)}><option value="">Everyone’s leads</option>{user && <option value={String(user.id)}>My leads</option>}{ownerList.filter(([id]) => id !== user?.id).map(([id, name]) => <option key={id} value={String(id)}>{name}</option>)}</select>}
      </div>

      {note && <Banner ok={note.ok} onClose={() => setNote(null)}>{note.text}</Banner>}
      <Err e={form ? '' : err} />
      {rows === null ? <Skeleton className="h-72" /> : all.length === 0 ? (
        <div className="card text-center py-12"><div className="text-sm font-medium mb-1">No leads yet</div><p className="text-xs text-muted max-w-sm mx-auto mb-4">A lead is anyone who has asked about a trip but hasn’t booked. Add them here, set a follow-up date, and you’ll never lose track of an enquiry.</p>{write && <button className="btn inline-flex items-center gap-1" onClick={() => setForm(blank())}><Plus size={16} />Add your first lead</button>}</div>
      ) : listView ? (<>
        <div className="sm:hidden space-y-2">{shown.map((l) => card(l, true))}{!shown.length && <div className="card text-center text-sm text-muted py-8">{q ? `No lead matches “${q}”.` : `Nothing in “${TABS.find((t) => t.key === tab)!.label}”.`}</div>}</div>
        <div className="hidden sm:block"><Table rows={shown} onRow={(l) => setOpen(l.id)} empty={q ? `No lead matches “${q}”.` : `Nothing in “${TABS.find((t) => t.key === tab)!.label}”.`} cols={[
          { h: 'Lead', render: (l) => <><span className="font-medium">{l.name}</span><div className="text-xs text-muted">{[l.phone, l.email].filter(Boolean).join(' · ') || 'No contact details'}</div></> },
          { h: 'Trip', render: (l) => <>{trip(l) || <span className="text-muted">—</span>}{l.budget_max && <div className="text-xs text-muted num">up to {money(l.budget_max, l.currency ?? 'USD')}</div>}</> },
          { h: 'Stage', render: (l) => <><Pill s={l.stage} />{l.quote_count > 0 && <div className="text-xs text-muted mt-0.5">{plural(l.quote_count, 'quote')}</div>}</> },
          { h: 'Next follow-up', render: (l) => { const fu = follow(l); return fu ? <span className={`text-xs ${fu.tone}`}>{fu.text}</span> : l.stage === 'lost' ? <span className="text-xs text-muted" title={l.lost_reason}>{l.lost_reason ?? 'Lost'}</span> : <span className="text-muted">—</span>; } },
          { h: 'Last contact', render: (l) => <span className="text-xs text-muted">{l.last_contact_at ? ago(l.last_contact_at) : 'None yet'}</span> },
          ...(ownerList.length > 1 ? [{ h: 'Owner', render: (l: any) => l.owner_name ?? '—' }] : []),
          { h: '', render: (l) => <div className="text-right whitespace-nowrap">{nextBtn(l)}</div> }]} /></div></>
      ) : (
        <div><div className="flex gap-3 overflow-x-auto pb-2 items-start">
          {OPEN.map((s) => { const items = shown.filter((l) => l.stage === s).sort(byDue); return (
            <section key={s} aria-label={LABEL[s]} onDragOver={(e) => { e.preventDefault(); setDrag(s); }} onDragLeave={() => setDrag('')} onDrop={(e) => { e.preventDefault(); setDrag(''); const l = all.find((x) => x.id === Number(e.dataTransfer.getData('id'))); if (l) move(l, s); }}
              className={`card !p-2 min-w-[14rem] flex-1 min-h-48 ${drag === s ? 'ring-2 ring-accent' : ''}`}>
              <div className="px-1 mb-2"><div className="flex justify-between text-xs font-semibold uppercase tracking-wide text-muted"><span>{LABEL[s]}</span><span className="num">{items.length}</span></div><div className="text-[11px] text-muted">{HINT[s]}</div></div>
              <div className="space-y-2">{items.map((l) => card(l))}{!items.length && <div className="text-xs text-muted text-center py-6 border border-dashed border-line rounded-lg">{write ? 'Drop a lead here' : 'Empty'}</div>}</div>
            </section>); })}
        </div>
          <div className="grid grid-cols-2 gap-3 mt-1">{(['won', 'lost'] as const).map((s) => (
            <section key={s} aria-label={LABEL[s]} onDragOver={(e) => { e.preventDefault(); setDrag(s); }} onDragLeave={() => setDrag('')} onDrop={(e) => { e.preventDefault(); setDrag(''); const l = all.find((x) => x.id === Number(e.dataTransfer.getData('id'))); if (l) move(l, s); }}
              className={`card !p-3 ${drag === s ? 'ring-2 ring-accent' : ''}`}><button className="w-full text-left" onClick={() => setTab(s)}><div className={`text-xs font-semibold uppercase tracking-wide ${s === 'won' ? 'text-success' : 'text-danger'}`}>{LABEL[s]}</div><div className="text-xl font-semibold num">{all.filter((l) => l.stage === s).length}</div><div className="text-[11px] text-muted">{write ? 'Drop here to close · click to view' : 'Click to view'}</div></button></section>))}</div>
        </div>
      )}
      {rows && rows.length >= 500 && <p className="text-xs text-muted mt-2">Showing the 500 most recently updated leads.</p>}

      {open && <LeadDetail key={`${open}-${rev}`} id={open} owners={owners} canAssign={canAssign} onClose={() => setOpen(null)} onChange={load} onEdit={(l) => setForm({ ...l, travel_start: d10(l.travel_start), travel_end: d10(l.travel_end), next_action_at: d10(l.next_action_at), budget_max: l.budget_max ?? '', party_size: l.party_size ?? '', currency: l.currency ?? agency?.base_currency ?? 'USD', owner_id: l.owner_id ?? '' })} />}
      {form && <LeadForm initial={form} owners={owners} canAssign={canAssign} onClose={() => setForm(null)} onSaved={(id, dupes) => {
        const wasEdit = !!form.id; setForm(null); load();
        setNote(dupes.length ? { ok: false, text: `Lead saved, but it may be a duplicate of: ${dupes.map((d: any) => `${d.type} “${d.name}”`).join(', ')}.` } : { ok: true, text: wasEdit ? 'Changes saved.' : 'Lead added. Next, log a call or send a quote.' });
        setRev((r) => r + 1); setOpen(id);
      }} />}
      {lostFor && <LostDialog lead={lostFor} onClose={() => setLostFor(null)} onDone={() => { setNote({ ok: true, text: `${lostFor.name} was marked as lost.` }); setLostFor(null); load(); }} />}
    </Page>
  );
}
