import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page } from '../components/ui';
import { today, useOpenOnNew } from '../lookup';
import { Plus } from 'lucide-react';

const STAGES = ['new', 'contacted', 'quoted', 'negotiating', 'won', 'lost'] as const;
const COLOR: Record<string, string> = { new: 'border-info', contacted: 'border-accent', quoted: 'border-warn', negotiating: 'border-[#a78bfa]', won: 'border-success', lost: 'border-danger' };
const blank = () => ({ name: '', email: '', phone: '', source: '', destination: '', party_size: 2, budget_max: '' as any, currency: 'USD', travel_start: '', stage: 'new' });

function LeadDetail({ id, onClose, onChange }: { id: number; onClose(): void; onChange(): void }) {
  const nav = useNavigate(); const { can } = useAuth();
  const [l, setL] = useState<any>(null); const [note, setNote] = useState(''); const [task, setTask] = useState(''); const [err, setErr] = useState(''); const [lost, setLost] = useState('');
  const load = () => api(`/leads/${id}`).then(setL);
  useEffect(() => { load(); }, [id]);
  if (!l) return null;
  const run = async (fn: () => Promise<any>) => { try { await fn(); setErr(''); await load(); onChange(); } catch (e: any) { setErr(e.message); } };
  const write = can('admin', 'finance_manager', 'agent');
  return (
    <Modal title={l.name} onClose={onClose}>
      <Err e={err} />
      {l.duplicates?.length > 0 && <div className="mb-3 text-sm text-warn bg-warn/10 rounded px-3 py-2">Possible duplicate of: {l.duplicates.map((d: any) => `${d.type} “${d.name}”`).join(', ')}</div>}
      <div className="grid grid-cols-2 gap-x-6 text-sm mb-3">
        <div><span className="text-muted">Email</span> {l.email ?? '—'}</div><div><span className="text-muted">Phone</span> {l.phone ?? '—'}</div>
        <div><span className="text-muted">Destination</span> {l.destination ?? '—'}</div><div><span className="text-muted">Party</span> {l.party_size ?? '—'}</div>
        <div><span className="text-muted">Travel</span> {l.travel_start ?? '—'}</div><div><span className="text-muted">Budget</span> {l.budget_max ? money(l.budget_max, l.currency ?? 'USD') : '—'}</div>
      </div>
      {write && <div className="flex flex-wrap gap-2 mb-4">
        <select className="input w-40" value={l.stage} onChange={(e) => e.target.value === 'lost' ? setLost('ask') : run(() => api(`/leads/${id}`, 'PUT', { stage: e.target.value }))}>{STAGES.map((s) => <option key={s}>{s}</option>)}</select>
        {lost && <><input className="input w-56" placeholder="Lost reason (required)" value={lost === 'ask' ? '' : lost} onChange={(e) => setLost(e.target.value || 'ask')} /><button className="btn" onClick={() => run(() => api(`/leads/${id}`, 'PUT', { stage: 'lost', lost_reason: lost }))}>Mark lost</button></>}
        {!l.client_id ? <button className="btn-ghost" onClick={() => run(() => api(`/leads/${id}/convert-client`, 'POST'))}>Convert to client</button> : <span className="text-xs text-success self-center">Client #{l.client_id}</span>}
        <button className="btn" onClick={() => nav(`/quotes/new?lead=${id}${l.client_id ? `&client=${l.client_id}` : ''}`)}>New quote</button></div>}
      <h4 className="font-bold text-sm mb-2">Tasks</h4>
      <div className="space-y-1 mb-2">{l.tasks.map((k: any) => <div key={k.id} className="flex justify-between text-sm"><span className={k.status === 'done' ? 'line-through text-muted' : ''}>{k.title} <span className="text-muted num">{k.due_at}</span></span>{k.status === 'open' && <button className="text-accent" onClick={() => run(() => api(`/crm/tasks/${k.id}/complete`, 'POST', {}))}>Done</button>}</div>)}</div>
      {write && <div className="flex gap-2 mb-4"><input className="input" placeholder="Add task (due in 2 days)" value={task} onChange={(e) => setTask(e.target.value)} /><button className="btn-ghost" disabled={!task} onClick={() => run(async () => { await api('/crm/tasks', 'POST', { title: task, entity_type: 'lead', entity_id: id, due_at: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) }); setTask(''); })}>Add</button></div>}
      <h4 className="font-bold text-sm mb-2">Activity</h4>
      {write && <div className="flex gap-2 mb-2"><input className="input" placeholder="Log a call / note…" value={note} onChange={(e) => setNote(e.target.value)} /><button className="btn-ghost" disabled={!note} onClick={() => run(async () => { await api('/crm/activities', 'POST', { entity_type: 'lead', entity_id: id, kind: 'note', body: note }); setNote(''); })}>Log</button></div>}
      <div className="space-y-2 max-h-56 overflow-auto">{l.activities.map((a: any) => <div key={a.id} className="text-sm"><span className={a.kind === 'system' ? 'text-muted' : ''}>{a.body}</span><div className="text-xs text-muted">{a.user_name ?? 'System'} · {new Date(a.created_at).toLocaleString()}</div></div>)}</div>
    </Modal>
  );
}

export default function Leads() {
  const { can } = useAuth(); const [rows, setRows] = useState<any[]>([]); const [open, setOpen] = useState<number | null>(null);
  const [form, setForm] = useState<any>(null); const [err, setErr] = useState(''); const [warn, setWarn] = useState('');
  const load = () => api('/leads').then(setRows);
  useOpenOnNew(() => setForm(blank()));
  useEffect(() => { load(); }, []);
  const save = async () => {
    try {
      const r = await api('/leads', 'POST', { ...form, budget_max: form.budget_max === '' ? null : Number(form.budget_max), email: form.email || null, travel_start: form.travel_start || null });
      if (r.duplicates?.length) setWarn(`Saved. Possible duplicates: ${r.duplicates.map((d: any) => d.name).join(', ')}`); else setWarn('');
      setForm(null); setErr(''); load();
    } catch (e: any) { setErr(e.message); }
  };
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });
  const move = async (id: number, stage: string) => { if (stage === 'lost') { setOpen(id); return; } await api(`/leads/${id}`, 'PUT', { stage }); load(); };
  const open_ = rows.filter((r) => !['won', 'lost'].includes(r.stage)).length;
  return (
    <Page title="Leads" actions={can('admin', 'finance_manager', 'agent') && <button className="btn" onClick={() => setForm(blank())}><Plus size={15} /> New lead</button>}>
      {warn && <div className="text-warn text-sm mb-3">{warn}</div>}
      <p className="text-xs text-muted mb-3">{open_} open · {rows.filter((r) => r.stage === 'won').length} won · {rows.filter((r) => r.stage === 'lost').length} lost. Drag a card between columns to change stage.</p>
      <div className="grid grid-cols-2 xl:grid-cols-6 gap-3 items-start">
        {STAGES.map((s) => (
          <div key={s} className="card p-2 min-h-40" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const id = Number(e.dataTransfer.getData('id')); if (id && can('admin', 'finance_manager', 'agent')) move(id, s); }}>
            <div className="text-xs uppercase tracking-wide text-muted px-1 mb-2 flex justify-between"><span>{s}</span><span>{rows.filter((r) => r.stage === s).length}</span></div>
            <div className="space-y-2">{rows.filter((r) => r.stage === s).map((r) => (
              <button key={r.id} draggable onDragStart={(e) => e.dataTransfer.setData('id', String(r.id))} onClick={() => setOpen(r.id)} className={`w-full text-left bg-bg border-l-4 ${COLOR[s]} rounded px-2 py-2 hover:bg-surface2`}>
                <div className="text-sm font-medium truncate">{r.name}</div><div className="text-xs text-muted truncate">{r.destination ?? r.enquiry_type ?? '—'}{r.party_size ? ` · ${r.party_size} pax` : ''}</div>
                {r.next_action_at && <div className={`text-xs num ${r.next_action_at < today() ? 'text-danger' : 'text-muted'}`}>{r.next_action_at} {r.next_action}</div>}
                <div className="text-[10px] text-muted mt-1">{r.owner_name}</div></button>))}</div>
          </div>))}
      </div>
      {open && <LeadDetail id={open} onClose={() => setOpen(null)} onChange={load} />}
      {form && <Modal title="New lead" onClose={() => setForm(null)}><Err e={err} />
        <div className="grid grid-cols-2 gap-x-4">
          <Field label="Name *"><input className="input" value={form.name} onChange={set('name')} /></Field><Field label="Source"><input className="input" placeholder="Website, referral…" value={form.source} onChange={set('source')} /></Field>
          <Field label="Email"><input className="input" value={form.email} onChange={set('email')} /></Field><Field label="Phone"><input className="input" value={form.phone} onChange={set('phone')} /></Field>
          <Field label="Destination"><input className="input" value={form.destination} onChange={set('destination')} /></Field><Field label="Travel start"><input className="input num" type="date" value={form.travel_start} onChange={set('travel_start')} /></Field>
          <Field label="Party size"><Num v={form.party_size} set={(v) => setForm({ ...form, party_size: v })} /></Field><Field label="Budget (max)"><Num v={form.budget_max} set={(v) => setForm({ ...form, budget_max: v })} /></Field></div>
        <div className="flex justify-end"><button className="btn" disabled={!form.name} onClick={save}>Save lead</button></div></Modal>}
    </Page>
  );
}
