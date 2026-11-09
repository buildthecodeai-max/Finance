import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Cake, CalendarRange, Check, CheckCircle2, ClipboardCheck, Clock, FileSignature, Mail, Pencil, Phone, Plane, Plus, Search, Stamp, Target, Truck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Banner, Err, Field, MenuBtn, Modal, Page, Popover, Skeleton } from '../components/ui';
import { isoDate, recordPath, today, useList, useOpenOnNew } from '../lookup';

/* What can be on the list. Each kind of item has a plain-English name, an icon and a colour. */
type Cat = 'followup' | 'task' | 'quote' | 'trip' | 'supplier' | 'passport' | 'birthday';
const CATS: Record<Cat, { label: string; noun: [string, string]; icon: LucideIcon; tone: string }> = {
  followup: { label: 'Follow-ups', noun: ['follow-up', 'follow-ups'], icon: Target, tone: 'bg-accent/15 text-accent' },
  task: { label: 'Tasks', noun: ['task', 'tasks'], icon: ClipboardCheck, tone: 'bg-info/15 text-info' },
  quote: { label: 'Quotes', noun: ['quote expiring', 'quotes expiring'], icon: FileSignature, tone: 'bg-warn/15 text-warn' },
  trip: { label: 'Departures', noun: ['departure', 'departures'], icon: Plane, tone: 'bg-success/15 text-success' },
  supplier: { label: 'Suppliers', noun: ['supplier to confirm', 'suppliers to confirm'], icon: Truck, tone: 'bg-warn/15 text-warn' },
  passport: { label: 'Passports', noun: ['passport check', 'passport checks'], icon: Stamp, tone: 'bg-danger/15 text-danger' },
  birthday: { label: 'Birthdays', noun: ['birthday', 'birthdays'], icon: Cake, tone: 'bg-info/15 text-info' },
};
const CAT_KEYS = Object.keys(CATS) as Cat[];
const KIND_CAT: Record<string, Cat> = { lead_followup: 'followup', task: 'task', overdue_task: 'task', quote_expiry: 'quote', departure: 'trip', unconfirmed_supplier: 'supplier', passport_expiry: 'passport', birthday: 'birthday' };
const TAG: Record<string, string> = { lead_followup: 'Lead follow-up', task: 'Task', quote_expiry: 'Quote expires', departure: 'Departure', unconfirmed_supplier: 'Supplier not confirmed', passport_expiry: 'Passport', birthday: 'Birthday' };
const RANK: Record<string, number> = { urgent: 0, high: 0, medium: 1, normal: 1, info: 2, low: 2 };
const PRIORITIES: [string, string][] = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']];
const HOW: [string, string][] = [['call', 'Call'], ['email', 'Email'], ['meeting', 'Meeting'], ['note', 'Note']];

/* When it is due, in the words people use. */
type Bucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'nodate';
const BUCKETS: { key: Bucket; label: string; showDate: boolean }[] = [
  { key: 'overdue', label: 'Overdue', showDate: true }, { key: 'today', label: 'Today', showDate: false }, { key: 'tomorrow', label: 'Tomorrow', showDate: false },
  { key: 'week', label: 'Coming up', showDate: true }, { key: 'later', label: 'Later', showDate: true }, { key: 'nodate', label: 'No date', showDate: false }];
type When = '' | 'overdue' | 'today' | 'soon' | 'later' | 'nodate';
const WHENS: When[] = ['overdue', 'today', 'soon', 'later', 'nodate'];

const d10 = (d: any) => (d ? String(d).slice(0, 10) : '');
const daysFrom = (d: any) => Math.round((Date.parse(d10(d)) - Date.parse(today())) / 864e5);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const shortDate = (d: any) => new Date(`${d10(d)}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const addDays = (n: number) => isoDate(new Date(Date.now() + n * 864e5));
const bucketOf = (date: string | null): Bucket => { if (!date) return 'nodate'; const n = daysFrom(date); return n < 0 ? 'overdue' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : n <= 7 ? 'week' : 'later'; };
const inWhen = (b: Bucket, w: When) => !w || (w === 'soon' ? b === 'tomorrow' || b === 'week' : w === b);

/** One thing on the list, whatever it came from. */
interface Item {
  key: string; kind: string; cat: Cat; date: string | null; title: string; rank: number;
  who?: string | null; detail?: string | null; phone?: string | null; email?: string | null; owner_id?: number | null; owner_name?: string | null;
  ref_type?: string | null; ref_id?: number | null; priority?: string; task?: any; action?: string | null; stage?: string;
}
const fromDeadline = (r: any, i: number): Item => ({ key: r.kind === 'lead_followup' ? `lead:${r.ref_id}` : `${r.kind}:${r.ref_id}:${i}`, kind: r.kind, cat: KIND_CAT[r.kind] ?? 'task', date: d10(r.date) || null, title: r.title, rank: RANK[r.severity] ?? 1,
  who: r.who, detail: r.detail, phone: r.phone, email: r.email, owner_id: r.owner_id, owner_name: r.owner_name, ref_type: r.ref_type, ref_id: r.ref_id, action: r.action, stage: r.stage });
const fromTask = (k: any): Item => ({ key: `task:${k.id}`, kind: 'task', cat: 'task', date: d10(k.due_at) || null, title: k.title, rank: RANK[k.priority] ?? 1, who: k.entity_label, detail: k.notes, phone: k.entity_phone, email: k.entity_email,
  owner_id: k.owner_id, owner_name: k.owner_name, ref_type: k.entity_type, ref_id: k.entity_id, priority: k.priority, task: k });
const byUrgency = (a: Item, b: Item) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.rank - b.rank || a.title.localeCompare(b.title);

const breakdown = (l: Item[]) => CAT_KEYS.map((c) => { const n = l.filter((i) => i.cat === c).length; return n ? `${n} ${CATS[c].noun[n === 1 ? 0 : 1]}` : ''; }).filter(Boolean).slice(0, 3).join(' · ');

const Chip = ({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) => (
  <button type="button" aria-pressed={on} onClick={onClick} className={`whitespace-nowrap text-sm px-3 py-1.5 rounded-lg border ${on ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>{children}</button>
);
const Pick = ({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) => (
  <button type="button" aria-pressed={on} onClick={onClick} className={`text-xs px-2.5 py-1 rounded-full border ${on ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line text-muted hover:bg-surface2'}`}>{children}</button>
);

/** Log what happened on a lead follow-up, and book the next one so the lead never goes cold. */
function FollowUpDialog({ it, onClose, onDone }: { it: Item; onClose(): void; onDone(msg: string): void }) {
  const nav = useNavigate(); const n = daysFrom(it.date);
  const [kind, setKind] = useState('call'); const [note, setNote] = useState(''); const [w, setW] = useState('3'); const [date, setDate] = useState(addDays(3)); const [next, setNext] = useState('');
  const [contacted, setContacted] = useState(true); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const choose = (v: string) => { setW(v); if (v !== 'pick' && v !== 'none') setDate(addDays(Number(v))); };
  const nextDate = w === 'none' ? null : date, markContacted = it.stage === 'new' && kind !== 'note' && contacted;
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api(`/leads/${it.ref_id}`, 'PUT', { next_action: nextDate ? next.trim() || null : null, next_action_at: nextDate, ...(markContacted ? { stage: 'contacted' } : {}) });
      await api('/crm/activities', 'POST', { entity_type: 'lead', entity_id: it.ref_id, kind, body: note.trim() || `${HOW.find(([k]) => k === kind)![1]} follow-up` });
      onDone(nextDate ? `Logged. Next follow-up with ${it.who}: ${shortDate(nextDate)}.` : `Logged. ${it.who} has no further follow-up planned.`);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={`Follow-up with ${it.who ?? 'this lead'}`} onClose={onClose}><Err e={err} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted mb-4">
        <span>{it.action ? `Planned: “${it.action}” · ` : ''}{n < 0 ? <span className="text-danger">{plural(-n, 'day')} overdue</span> : n === 0 ? 'due today' : `due ${shortDate(it.date)}`}</span>
        {it.phone && <a className="text-accent hover:underline inline-flex items-center gap-1 num" href={`tel:${it.phone}`}><Phone size={13} />{it.phone}</a>}
        {it.email && <a className="text-accent hover:underline inline-flex items-center gap-1 break-all" href={`mailto:${it.email}`}><Mail size={13} />{it.email}</a>}</div>
      <div className="mb-3"><div className="text-xs font-medium text-muted mb-1.5">How did you follow up?</div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="How you followed up">{HOW.map(([k, lb]) => <Pick key={k} on={kind === k} onClick={() => setKind(k)}>{lb}</Pick>)}</div></div>
      <Field label="What happened? (optional)"><textarea className="input" rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === 'call' ? 'e.g. Spoke to her — wants the Maldives options by Friday' : 'A line is enough — it goes on the lead’s history'} /></Field>
      <div className="rounded-lg border border-line bg-surface2/40 p-3 mb-3">
        <div className="text-xs font-medium text-muted mb-2">When should you follow up next?</div>
        <div className="flex flex-wrap gap-1.5 mb-2" role="group" aria-label="Next follow-up">
          {[['1', 'Tomorrow'], ['3', 'In 3 days'], ['7', 'Next week'], ['pick', 'Pick a date'], ['none', 'No more needed']].map(([k, lb]) => <Pick key={k} on={w === k} onClick={() => choose(k)}>{lb}</Pick>)}</div>
        {w === 'none' ? <p className="text-xs text-warn">The lead will have no follow-up date, so nothing will remind you about it. You can schedule one later from the lead.</p> : <>
          <div className="grid sm:grid-cols-[1fr_11rem] gap-2"><input className="input" aria-label="What to do next" maxLength={200} value={next} onChange={(e) => setNext(e.target.value)} placeholder="What’s next? e.g. Send the Maldives options" />
            <input className="input num" type="date" aria-label="Next follow-up date" min={today()} value={date} onChange={(e) => { setDate(e.target.value); setW('pick'); }} /></div></>}
      </div>
      {it.stage === 'new' && kind !== 'note' && <label className="flex items-center gap-2 text-sm mb-3"><input type="checkbox" checked={contacted} onChange={(e) => setContacted(e.target.checked)} />Also move this lead to “Contacted”</label>}
      <div className="flex flex-wrap justify-between gap-2">
        <button className="btn-ghost" onClick={() => nav(`/leads?open=${it.ref_id}`)}>Open lead</button>
        <span className="flex gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || (w !== 'none' && !date)} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></span></div>
    </Modal>
  );
}

/** One form for adding and editing a task. */
function TaskForm({ initial, owners, canAssign, onClose, onSaved }: { initial: any; owners: any[]; canAssign: boolean; onClose(): void; onSaved(msg: string): void }) {
  const { user } = useAuth(); const editing = !!initial.id;
  const [f, setF] = useState<any>(initial); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body: any = { title: f.title.trim(), due_at: f.due_at || null, priority: f.priority, notes: f.notes?.trim() || null, ...(canAssign && f.owner_id ? { owner_id: Number(f.owner_id) } : {}) };
      if (editing) await api(`/crm/tasks/${initial.id}`, 'PUT', body); else await api('/crm/tasks', 'POST', body);
      onSaved(editing ? 'Task updated.' : body.due_at ? `Task added for ${shortDate(body.due_at)}.` : 'Task added.');
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={editing ? 'Edit task' : 'New task'} onClose={onClose}><Err e={err} />
      <Field label="What needs doing?"><input className="input" autoFocus maxLength={200} value={f.title} onChange={set('title')} placeholder="e.g. Send the passport checklist to the Khan family" onKeyDown={(e) => { if (e.key === 'Enter' && f.title.trim() && !busy) save(); }} /></Field>
      <div className="mb-3"><div className="text-xs font-medium text-muted mb-1.5">When?</div>
        <div className="flex flex-wrap items-center gap-1.5 mb-2" role="group" aria-label="Due date shortcuts">
          {[['Today', today()], ['Tomorrow', addDays(1)], ['Next week', addDays(7)], ['No date', '']].map(([lb, v]) => <Pick key={lb} on={(f.due_at ?? '') === v} onClick={() => setF({ ...f, due_at: v })}>{lb}</Pick>)}</div>
        <input className="input num sm:w-44" type="date" aria-label="Due date" value={f.due_at ?? ''} onChange={set('due_at')} /></div>
      <div className="grid sm:grid-cols-2 gap-x-4">
        <div className="mb-3"><div className="text-xs font-medium text-muted mb-1.5">How important?</div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Priority">{PRIORITIES.map(([k, lb]) => <Pick key={k} on={f.priority === k} onClick={() => setF({ ...f, priority: k })}>{lb}</Pick>)}</div></div>
        {canAssign && <Field label="Whose task is it?"><select className="input" value={f.owner_id ?? ''} onChange={set('owner_id')}>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}{o.id === user?.id ? ' (you)' : ''}</option>)}</select></Field>}</div>
      {initial.who && <p className="text-xs text-muted mb-3">Linked to {initial.who}</p>}
      <Field label="Notes (optional)"><textarea className="input" rows={2} maxLength={500} value={f.notes ?? ''} onChange={set('notes')} /></Field>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !f.title.trim()} onClick={save}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add task'}</button></div>
    </Modal>
  );
}

/** One line on the list: what it is, who it is about, when, and the buttons to deal with it right here. */
function Row({ it, write, showOwner, me, showDate, onOpen, onLog, onDone, onEdit, onMove }: { it: Item; write: boolean; showOwner: boolean; me?: number; showDate: boolean; onOpen(): void; onLog(): void; onDone(): void; onEdit(): void; onMove(date: string): void }) {
  const Icon = CATS[it.cat].icon, isFollow = it.cat === 'followup', isTask = it.cat === 'task', n = it.date ? daysFrom(it.date) : 0;
  const due = !it.date ? null : n < 0 ? { text: `${plural(-n, 'day')} overdue`, cls: 'text-danger' } : { text: shortDate(it.date), cls: 'text-muted' };
  const urgent = it.priority === 'urgent' || it.priority === 'high';
  const parts: ReactNode[] = [TAG[it.kind], it.who && !it.title.toLowerCase().includes(it.who.toLowerCase()) ? it.who : null, it.detail, showOwner ? (it.owner_id === me ? 'You' : it.owner_name) : null].filter(Boolean);
  if (urgent) parts.unshift(<span className="text-danger font-medium">{it.priority === 'urgent' ? 'Urgent' : 'High priority'}</span>);
  const moves: [string, number][] = [...(n < 0 ? [['Today', 0] as [string, number]] : []), ['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7]];
  const icon = 'btn-icon !h-8 !w-8';
  return (
    <li className="relative flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 hover:bg-surface2/50 first:rounded-t-xl last:rounded-b-xl">
      <span className={`h-8 w-8 rounded-full grid place-items-center shrink-0 ${CATS[it.cat].tone}`} aria-hidden><Icon size={15} /></span>
      <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-0">
        <button type="button" onClick={onOpen} className="text-left text-sm font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent focus-visible:after:rounded-lg">{it.title}</button>
        <div className="text-xs text-muted sm:truncate">{parts.map((p, i) => <span key={i}>{i > 0 && ' · '}{p}</span>)}</div></div>
      <div className="flex flex-wrap sm:flex-nowrap items-center justify-between sm:justify-end gap-x-2 gap-y-1 w-full sm:w-auto">
        {showDate && due && <span className={`text-xs font-medium num whitespace-nowrap ${due.cls}`}>{due.text}</span>}
        <div className="relative flex flex-wrap items-center justify-end gap-0.5 ml-auto">
          {it.phone && <a className={icon} href={`tel:${it.phone}`} aria-label={`Call ${it.who ?? it.phone}`} title={`Call ${it.phone}`}><Phone size={15} /></a>}
          {it.email && <a className={icon} href={`mailto:${it.email}`} aria-label={`Email ${it.who ?? it.email}`} title={`Email ${it.email}`}><Mail size={15} /></a>}
          {write && (isFollow || isTask) && <Popover width="w-52" trigger={(_o, t) => <button type="button" className={icon} onClick={t} aria-label={`Move “${it.title}” to another day`} title="Move to another day"><Clock size={15} /></button>}>
            {(close) => <><div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Move to</div>
              {moves.map(([lb, d]) => <MenuBtn key={lb} onClick={() => { close(); onMove(addDays(d)); }}>{lb}</MenuBtn>)}
              <div className="px-2.5 pt-1 pb-1.5"><div className="text-xs text-muted mb-1">Or pick a date</div><input type="date" className="input !h-8 num" min={today()} aria-label="Pick a date" onChange={(e) => { if (e.target.value) { close(); onMove(e.target.value); } }} /></div></>}</Popover>}
          {write && isTask && <button type="button" className={icon} onClick={onEdit} aria-label={`Edit “${it.title}”`} title="Edit task"><Pencil size={14} /></button>}
          {write && isTask && <button type="button" className="btn-ghost !h-8 !px-2.5 text-xs ml-1" onClick={onDone}><Check size={14} />Done</button>}
          {write && isFollow && <button type="button" className="btn !h-8 !px-3 text-xs ml-1" onClick={onLog}>Log follow-up</button>}</div></div>
    </li>
  );
}

export default function Operations() {
  const nav = useNavigate(); const [sp] = useSearchParams(); const { can, user } = useAuth();
  const write = can('admin', 'finance_manager', 'agent'), canAssign = can('admin', 'finance_manager'); const owners = useList('/team/agents');
  const [dl, setDl] = useState<any[] | null>(null); const [tasks, setTasks] = useState<any[] | null>(null); const [err, setErr] = useState(''); const [days, setDays] = useState(30);
  const [when, setWhen] = useState<When>(WHENS.includes(sp.get('when') as When) ? (sp.get('when') as When) : ''); const [type, setType] = useState<'' | Cat>(CAT_KEYS.includes(sp.get('type') as Cat) ? (sp.get('type') as Cat) : '');
  const [q, setQ] = useState(''); const [ownerF, setOwnerF] = useState('');
  const [form, setForm] = useState<any>(null); const [fu, setFu] = useState<Item | null>(null); const [note, setNote] = useState<{ ok: boolean; text: string; undo?: () => void } | null>(null);

  const load = () => {
    api(`/ops/deadlines?days=${days}`).then((r) => { setDl(r); setErr(''); }).catch((e) => { setErr(e.message); setDl([]); });
    api('/crm/tasks?status=open').then((r) => setTasks(r)).catch((e) => { setErr(e.message); setTasks([]); });
  };
  useEffect(() => { load(); }, [days]);
  useEffect(() => { if (!note?.ok) return; const h = setTimeout(() => setNote(null), 10000); return () => clearTimeout(h); }, [note]);   // good news fades; problems stay until dismissed
  const blankTask = () => ({ title: '', due_at: today(), priority: 'normal', notes: '', owner_id: user?.id ?? '' });
  useOpenOnNew(() => { if (write) setForm(blankTask()); });

  const loading = dl === null || tasks === null;
  const items = useMemo<Item[]>(() => (loading ? [] : [...dl!.filter((r) => !['task', 'overdue_task'].includes(r.kind)).map(fromDeadline), ...tasks!.map(fromTask)].sort(byUrgency)), [dl, tasks]);   // tasks come from the task list itself so undated ones show too
  const ownerList = useMemo(() => [...new Map(items.filter((i) => i.owner_id).map((i) => [i.owner_id as number, i.owner_name ?? 'Someone'])).entries()], [items]);
  const base = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((i) => (!ownerF || String(i.owner_id) === ownerF) && (!s || [i.title, i.who, i.detail, i.owner_name].some((v) => String(v ?? '').toLowerCase().includes(s))));
  }, [items, q, ownerF]);
  const inBucket = (w: When) => base.filter((i) => inWhen(bucketOf(i.date), w));
  const overdue = inBucket('overdue'), dueToday = inBucket('today'), soon = inBucket('soon'), openTasks = base.filter((i) => i.cat === 'task');
  const pool = useMemo(() => base.filter((i) => inWhen(bucketOf(i.date), when)), [base, when]);
  const shown = type ? pool.filter((i) => i.cat === type) : pool;
  const filtered = !!(when || type || q || ownerF), showOwner = ownerList.length > 1;
  const clear = () => { setWhen(''); setType(''); setQ(''); setOwnerF(''); };

  const flash = (text: string, ok = true, undo?: () => void) => setNote({ ok, text, undo });
  const run = async (fn: () => Promise<any>, okText?: string, undo?: () => void) => { try { await fn(); if (okText) flash(okText, true, undo); } catch (e: any) { flash(e.message, false); } load(); };
  const finish = (it: Item) => {
    const k = it.task; setTasks((ts) => (ts ?? []).filter((x) => x.id !== k.id));                       // it leaves the list at once; it comes back if the server says no
    run(() => api(`/crm/tasks/${k.id}/complete`, 'POST', {}), `Done: “${k.title}”`, () => run(() => api(`/crm/tasks/${k.id}/reopen`, 'POST', {}), 'Task put back on your list.'));
  };
  const move = (it: Item, date: string) => {
    if (it.task) { setTasks((ts) => (ts ?? []).map((x) => (x.id === it.task.id ? { ...x, due_at: date } : x))); run(() => api(`/crm/tasks/${it.task.id}`, 'PUT', { due_at: date }), `Moved to ${shortDate(date)}.`); }
    else { setDl((rs) => (rs ?? []).map((r) => (r.kind === 'lead_followup' && r.ref_id === it.ref_id ? { ...r, date } : r))); run(() => api(`/leads/${it.ref_id}`, 'PUT', { next_action_at: date }), `Follow-up with ${it.who} moved to ${shortDate(date)}.`); }
  };
  const openIt = (it: Item) => { const p = recordPath(it.ref_type, it.ref_id); if (p) nav(p); else if (it.task && write) setForm({ ...it.task, due_at: d10(it.task.due_at), notes: it.task.notes ?? '', owner_id: it.task.owner_id ?? '', who: it.who }); };

  const stat = (title: string, value: number, sub: string, tone: string, on: boolean, pick: () => void, Icon: LucideIcon) => (
    <button type="button" aria-pressed={on} onClick={() => (on ? clear() : pick())} className={`card text-left hover:bg-surface2/70 transition-colors ${on ? 'ring-2 ring-accent' : ''} ${tone && value ? (tone.includes('danger') ? 'border-l-4 !border-l-danger' : 'border-l-4 !border-l-warn') : ''}`}>
      <div className="flex items-start justify-between gap-2"><div className="text-xs font-medium text-muted">{title}</div><span className={`h-7 w-7 rounded-lg grid place-items-center shrink-0 ${value && tone ? (tone.includes('danger') ? 'bg-danger/10 text-danger' : 'bg-warn/10 text-warn') : 'bg-accent/10 text-accent'}`}><Icon size={15} /></span></div>
      <div className={`text-2xl font-semibold num mt-1 ${tone}`}>{value}</div><div className="text-[11px] sm:text-xs text-muted mt-0.5 truncate">{sub}</div></button>);
  const undated = openTasks.filter((i) => !i.date).length;

  return (
    <Page title="Operations" description="Your day in one list — follow-ups to make, tasks to finish, and the trips and quotes that need attention."
      actions={write && <button className="btn inline-flex items-center gap-1" onClick={() => setForm(blankTask())}><Plus size={16} />New task</button>}>
      {loading ? <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div> : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          {stat('Overdue', overdue.length, overdue.length ? breakdown(overdue) : 'Nothing overdue — nice', overdue.length ? 'text-danger' : '', when === 'overdue', () => { setWhen('overdue'); setType(''); }, AlertCircle)}
          {stat('Due today', dueToday.length, dueToday.length ? breakdown(dueToday) : 'Nothing due today', dueToday.length ? 'text-warn' : '', when === 'today', () => { setWhen('today'); setType(''); }, Clock)}
          {stat('Next 7 days', soon.length, soon.length ? breakdown(soon) : 'Nothing coming up', '', when === 'soon', () => { setWhen('soon'); setType(''); }, CalendarRange)}
          {stat('Open tasks', openTasks.length, openTasks.length ? (undated ? `${undated} with no date` : 'All have a date') : 'No tasks open', '', type === 'task' && !when, () => { setType('task'); setWhen(''); }, ClipboardCheck)}</div>)}

      {note && <Banner ok={note.ok} onClose={() => setNote(null)} action={note.undo ? { label: 'Undo', onClick: () => { const u = note.undo!; setNote(null); u(); } } : undefined}>{note.text}</Banner>}
      <Err e={form || fu ? '' : err} />

      {(items.length > 0 || filtered) && <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1 basis-full min-w-0" role="group" aria-label="Show">
          <Chip on={!type} onClick={() => setType('')}>All<span className="ml-1.5 text-xs opacity-70 num">{pool.length}</span></Chip>
          {CAT_KEYS.filter((c) => pool.some((i) => i.cat === c) || type === c).map((c) => <Chip key={c} on={type === c} onClick={() => setType(type === c ? '' : c)}>{CATS[c].label}<span className="ml-1.5 text-xs opacity-70 num">{pool.filter((i) => i.cat === c).length}</span></Chip>)}</div>
        <div className="relative w-full sm:w-72"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" /><input className="input pl-8" placeholder="Search name, trip, task…" aria-label="Search the list" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {canAssign && showOwner && <select className="input w-auto" aria-label="Whose items" value={ownerF} onChange={(e) => setOwnerF(e.target.value)}><option value="">Everyone’s</option>{user && <option value={String(user.id)}>Just mine</option>}{ownerList.filter(([id]) => id !== user?.id).map(([id, name]) => <option key={id} value={String(id)}>{name}</option>)}</select>}
        {filtered && <button type="button" className="text-xs text-accent underline" onClick={clear}>Clear filters</button>}
        <select className="input w-auto sm:ml-auto" aria-label="How far ahead to look" title="How far ahead to look for departures, quotes and follow-ups" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>Look ahead {d} days</option>)}</select>
      </div>}

      {loading ? <Skeleton className="h-72" /> : !items.length ? (
        <div className="card text-center py-16"><span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-success/10 text-success"><CheckCircle2 size={28} /></span><div className="text-base font-semibold mb-1">You’re all caught up</div>
          <p className="text-sm text-muted max-w-md mx-auto mb-5">Follow-ups that are due, quotes about to expire, trips about to leave and the tasks you add will appear here in the order you should do them.</p>
          <div className="flex flex-wrap justify-center gap-2">{write && <button className="btn inline-flex items-center gap-1" onClick={() => setForm(blankTask())}><Plus size={16} />Add a task</button>}<button className="btn-ghost" onClick={() => nav('/leads')}>Go to leads</button><button className="btn-ghost" onClick={() => nav('/bookings')}>Go to bookings</button></div></div>
      ) : !shown.length ? (
        <div className="card text-center py-10"><div className="text-sm font-medium mb-1">{q ? `Nothing matches “${q}”` : 'Nothing here'}</div><p className="text-xs text-muted mb-3">{filtered ? 'Try a different filter.' : 'You’re all caught up.'}</p>{filtered && <button className="btn-ghost" onClick={clear}>Show everything</button>}</div>
      ) : <>
        {!filtered && !overdue.length && !dueToday.length && <div className="rounded-lg border border-success/30 bg-success/10 text-success text-sm px-3 py-2 mb-4 flex items-center gap-2"><CheckCircle2 size={16} className="shrink-0" />You’re on top of things — nothing is overdue or due today.</div>}
        {BUCKETS.map((b) => { const list = shown.filter((i) => bucketOf(i.date) === b.key); if (!list.length) return null; return (
          <section key={b.key} aria-label={b.label} className="mb-5">
            <h3 className={`text-xs font-semibold uppercase tracking-wide mb-1.5 flex items-center gap-2 ${b.key === 'overdue' ? 'text-danger' : 'text-muted'}`}>{b.label}<span className="num font-normal opacity-70">{list.length}</span>{b.key === 'today' && <span className="normal-case font-normal tracking-normal">{shortDate(today())}</span>}</h3>
            <ul className="card !p-0 divide-y divide-line/70">{list.map((it) => <Row key={it.key} it={it} write={write} showOwner={showOwner} me={user?.id} showDate={b.showDate} onOpen={() => openIt(it)} onLog={() => setFu(it)} onDone={() => finish(it)} onEdit={() => setForm({ ...it.task, due_at: d10(it.task.due_at), notes: it.task.notes ?? '', owner_id: it.task.owner_id ?? '', who: it.who })} onMove={(d) => move(it, d)} />)}</ul>
          </section>); })}
      </>}

      {form && <TaskForm initial={form} owners={owners} canAssign={canAssign} onClose={() => setForm(null)} onSaved={(msg) => { setForm(null); flash(msg); load(); }} />}
      {fu && <FollowUpDialog it={fu} onClose={() => setFu(null)} onDone={(msg) => { setFu(null); flash(msg); load(); }} />}
    </Page>
  );
}
