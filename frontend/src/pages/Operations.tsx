import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Err, Page, Table } from '../components/ui';

const SEV: Record<string, string> = { high: 'bg-danger/15 text-danger', medium: 'bg-warn/15 text-warn', info: 'bg-info/15 text-info' };
const KIND: Record<string, string> = { departure: 'Departure', unconfirmed_supplier: 'Unconfirmed supplier', quote_expiry: 'Quote expiry', passport_expiry: 'Passport expiry', birthday: 'Birthday', lead_followup: 'Lead follow-up', task: 'Task due', overdue_task: 'Overdue task' };
const ROUTE: Record<string, (id: number) => string> = { booking: (id) => `/bookings/${id}`, quote: (id) => `/quotes/${id}`, lead: (id) => `/leads?open=${id}`, client: () => '/clients' };

export default function Operations() {
  const nav = useNavigate(); const { can } = useAuth();
  const [d, setD] = useState<any[]>([]); const [tasks, setTasks] = useState<any[]>([]); const [days, setDays] = useState(30); const [title, setTitle] = useState(''); const [due, setDue] = useState(''); const [err, setErr] = useState(''); const [kind, setKind] = useState('');
  const load = () => { api(`/ops/deadlines?days=${days}`).then(setD).catch((e) => setErr(e.message)); api('/crm/tasks?status=open').then(setTasks); };
  useEffect(() => { load(); }, [days]);
  const shown = d.filter((x) => !kind || x.kind === kind);
  return (
    <Page title="Operations" actions={<><select className="input w-40" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All deadlines</option>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <select className="input w-32" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 14, 30, 60, 90].map((n) => <option key={n} value={n}>Next {n} days</option>)}</select></>}>
      <Err e={err} />
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2"><h3 className="font-bold mb-2">Deadlines & exceptions ({shown.length})</h3>
          <Table rows={shown.map((x, i) => ({ id: i, ...x }))} onRow={(r: any) => nav(ROUTE[r.ref_type]?.(r.ref_id) ?? '/')} cols={[
            { h: 'Date', render: (r: any) => <span className="num">{r.date}</span> }, { h: 'Type', render: (r: any) => KIND[r.kind] ?? r.kind }, { h: 'Detail', render: (r: any) => r.title },
            { h: 'Severity', render: (r: any) => <span className={`pill ${SEV[r.severity]}`}>{r.severity}</span> }]} /></div>
        <div><h3 className="font-bold mb-2">My open tasks</h3>
          {can('admin', 'finance_manager', 'agent') && <div className="flex gap-2 mb-2"><input className="input" placeholder="New task" value={title} onChange={(e) => setTitle(e.target.value)} /><input className="input w-36 num" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            <button className="btn-ghost" disabled={!title} onClick={async () => { await api('/crm/tasks', 'POST', { title, due_at: due || null }); setTitle(''); setDue(''); load(); }}>Add</button></div>}
          <div className="card space-y-2">{tasks.map((k) => <div key={k.id} className="flex justify-between text-sm gap-2"><span>{k.title}<div className="text-xs text-muted num">{k.due_at ?? 'no date'} · {k.priority}{k.owner_name ? ` · ${k.owner_name}` : ''}</div></span><button className="text-accent shrink-0" onClick={async () => { await api(`/crm/tasks/${k.id}/complete`, 'POST', {}); load(); }}>Done</button></div>)}{!tasks.length && <div className="text-muted text-sm">Nothing open</div>}</div></div>
      </div>
    </Page>
  );
}
