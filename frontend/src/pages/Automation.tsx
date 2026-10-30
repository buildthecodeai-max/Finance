import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Page, Pill, Table } from '../components/ui';

const TRIGGERS: Record<string, string> = { invoice_overdue: 'Invoice overdue by ≥ N days', quote_expiring: 'Quote expires within N days', departure_upcoming: 'Departure within N days', bill_due: 'Supplier bill due within N days' };
const CLIENT = ['invoice_overdue', 'quote_expiring', 'departure_upcoming'];
const REPORTS: Record<string, string> = { 'ar-aging-summary': 'AR aging summary', 'ap-aging': 'Payables aging', 'gl-pnl': 'Profit & Loss (ledger)', departures: 'Departures', 'invoice-register': 'Invoice register', 'commission-summary': 'Commission summary' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function Automation() {
  const { can, user } = useAuth(); const w = can('admin', 'finance_manager');
  const [tab, setTab] = useState<'exceptions' | 'rules' | 'schedules' | 'activity'>('exceptions');
  const [ex, setEx] = useState<any[]>([]); const [rules, setRules] = useState<any[]>([]); const [sch, setSch] = useState<any[]>([]); const [act, setAct] = useState<any[]>([]);
  const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [form, setForm] = useState<any>(null); const [runs, setRuns] = useState<any>(null);
  const load = () => { api('/automation/exceptions').then(setEx); api('/automation/rules').then(setRules); api('/automation/schedules').then(setSch); api('/automation/activity').then(setAct); };
  useEffect(() => { load(); }, []);
  const go = async (fn: () => Promise<any>, ok?: string) => { try { const r = await fn(); setErr(''); setMsg(ok ?? ''); load(); return r; } catch (e: any) { setErr(e.message); } };
  const rescan = () => go(async () => { const r = await api('/automation/exceptions/scan', 'POST'); setMsg(`${r.open} open · ${r.new} new · ${r.resolved} cleared`); });
  const runAll = () => go(async () => { const r = await api('/automation/run', 'POST'); setMsg(`Automations: ${r.automations.done} done, ${r.automations.failed} failed, ${r.automations.skipped} skipped · schedules run: ${r.schedules.ran}`); });
  const saveRule = () => go(async () => { await api('/automation/rules', 'POST', { name: form.name, trigger_kind: form.trigger_kind, days: Number(form.days) || 0, action: form.action, task_priority: form.task_priority, message: form.message || null }); setForm(null); });
  const saveSched = () => go(async () => { await api('/automation/schedules', 'POST', { name: form.name, report: form.report, range_kind: form.range_kind, frequency: form.frequency, format: form.format, recipients: form.recipients.split(/[,\s]+/).filter(Boolean),
    ...(form.frequency === 'weekly' ? { weekday: Number(form.weekday) } : {}), ...(form.frequency === 'monthly' ? { day_of_month: Number(form.day_of_month) } : {}) }); setForm(null); });
  const counts = ['critical', 'warn', 'info'].map((s) => ex.filter((e) => e.severity === s).length);
  return (
    <Page title="Automation" description="What needs attention, rules that act on it, and reports delivered on a schedule. Everything here is safe to re-run."
      actions={<>{(['exceptions', 'rules', 'schedules', 'activity'] as const).map((t) => <button key={t} className={`capitalize ${tab === t ? 'btn' : 'btn-ghost'}`} onClick={() => setTab(t)}>{t === 'exceptions' && ex.length ? `Exceptions (${ex.length})` : t}</button>)}
        {w && <button className="btn-ghost" onClick={runAll}>Run now</button>}</>}>
      <Err e={form ? '' : err} />{msg && <div className="rounded-lg border border-success/30 bg-success/10 text-success text-sm p-3 mb-3">{msg}</div>}

      {tab === 'exceptions' && <>
        <div className="flex flex-wrap items-center gap-4 mb-3 text-sm"><span><b className="text-danger">{counts[0]}</b> critical</span><span><b className="text-warn">{counts[1]}</b> warnings</span><span><b>{counts[2]}</b> info</span>{w && <button className="btn-ghost ml-auto" onClick={rescan}>Rescan</button>}</div>
        <Table rows={ex} empty="Nothing needs attention 🎉 (rescan to check again)" cols={[
          { h: 'Severity', render: (e) => <Pill s={e.severity} /> }, { h: 'Issue', render: (e) => <><div>{e.title}</div>{e.detail && <div className="text-xs text-muted">{e.detail}</div>}</> },
          { h: 'Amount', right: true, render: (e) => (e.amount != null ? money(e.amount) : '') }, { h: 'Since', render: (e) => <span className="num text-xs">{String(e.first_seen).slice(0, 10)}</span> },
          { h: 'State', render: (e) => (e.status === 'open' ? '' : <span className="text-xs text-muted capitalize">{e.status}</span>) },
          { h: '', render: (e) => w && <div className="flex gap-1 justify-end"><button className="btn-ghost" onClick={() => go(() => api(`/automation/exceptions/${e.id}/acknowledge`, 'POST', {}))}>Acknowledge</button><button className="btn-ghost" onClick={() => go(() => api(`/automation/exceptions/${e.id}/snooze`, 'POST', { days: 3 }))}>Snooze 3d</button></div> }]} /></>}

      {tab === 'rules' && <>{w && <div className="mb-3"><button className="btn" onClick={() => setForm({ kind: 'rule', name: '', trigger_kind: 'invoice_overdue', days: 7, action: 'create_task', task_priority: 'normal', message: '' })}><Plus size={15} /> New rule</button></div>}
        <Table rows={rules} empty="No rules yet" cols={[{ h: 'Rule', render: (r) => r.name }, { h: 'When', render: (r) => TRIGGERS[r.trigger_kind].replace('N', r.days) }, { h: 'Then', render: (r) => (r.action === 'create_task' ? `Create ${r.task_priority} task` : 'Email the client') },
          { h: 'Done / failed', right: true, render: (r) => `${r.done} / ${r.failed}` }, { h: 'Active', render: (r) => <input type="checkbox" checked={!!r.active} disabled={!w} onChange={(e) => go(() => api(`/automation/rules/${r.id}`, 'PUT', { active: e.target.checked }))} /> },
          { h: '', render: (r) => w && <button className="btn-ghost text-danger" onClick={() => confirm('Delete this rule? Its history is kept in the audit log.') && go(() => api(`/automation/rules/${r.id}`, 'DELETE'))}>Delete</button> }]} /></>}

      {tab === 'schedules' && <>{w && <div className="mb-3"><button className="btn" onClick={() => setForm({ kind: 'sched', name: '', report: 'ar-aging-summary', range_kind: 'last_month', frequency: 'monthly', weekday: 1, day_of_month: 1, format: 'csv', recipients: user?.email ?? '' })}><Plus size={15} /> New schedule</button></div>}
        <Table rows={sch} empty="No scheduled reports" cols={[{ h: 'Name', render: (s) => <><div>{s.name}</div><div className="text-xs text-muted">{REPORTS[s.report] ?? s.report} · {s.format.toUpperCase()} → {s.recipients}</div></> },
          { h: 'Runs', render: (s) => (s.frequency === 'daily' ? 'Daily' : s.frequency === 'weekly' ? `Weekly, ${DAYS[s.weekday]}` : `Monthly, day ${s.day_of_month}`) }, { h: 'Next', render: (s) => <span className="num">{String(s.next_run_at).slice(0, 10)}</span> },
          { h: 'Last', render: (s) => (s.last_status ? <Pill s={s.last_status === 'ok' ? 'paid' : s.last_status === 'failed' ? 'void' : 'pending'} /> : '—') }, { h: 'Active', render: (s) => <input type="checkbox" checked={!!s.active} disabled={!w} onChange={(e) => go(() => api(`/automation/schedules/${s.id}`, 'PUT', { active: e.target.checked }))} /> },
          { h: '', render: (s) => <div className="flex gap-1 justify-end"><button className="btn-ghost" onClick={async () => setRuns({ s, rows: await api(`/automation/schedules/${s.id}/runs`) })}>History</button>{w && <button className="btn-ghost" onClick={() => go(() => api(`/automation/schedules/${s.id}/run`, 'POST'), 'Report sent')}>Run now</button>}{w && <button className="btn-ghost text-danger" onClick={() => confirm('Delete this schedule?') && go(() => api(`/automation/schedules/${s.id}`, 'DELETE'))}>Delete</button>}</div> }]} /></>}

      {tab === 'activity' && <Table rows={act} empty="No automation activity yet" cols={[{ h: 'When', render: (a) => <span className="num text-xs">{String(a.updated_at).replace('T', ' ').slice(0, 16)}</span> }, { h: 'Rule', render: (a) => a.rule_name }, { h: 'Record', render: (a) => `${a.ref_table} #${a.ref_id}` },
        { h: 'Result', render: (a) => <><Pill s={a.status === 'done' ? 'paid' : a.status === 'failed' ? 'void' : 'pending'} /><span className="text-xs text-muted ml-2">{a.detail}{a.status === 'failed' ? ` · attempt ${a.attempts}/3` : ''}</span></> }]} />}

      {form?.kind === 'rule' && <Modal title="New automation rule" onClose={() => setForm(null)}><Err e={err} />
        <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-x-4"><Field label="When"><select className="input" value={form.trigger_kind} onChange={(e) => setForm({ ...form, trigger_kind: e.target.value, action: CLIENT.includes(e.target.value) ? form.action : 'create_task' })}>{Object.entries(TRIGGERS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="N (days)"><input className="input num" type="number" min={0} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} /></Field>
          <Field label="Then"><select className="input" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}><option value="create_task">Create a task</option>{CLIENT.includes(form.trigger_kind) && <option value="email_client">Email the client</option>}</select></Field>
          {form.action === 'create_task' && <Field label="Priority"><select className="input" value={form.task_priority} onChange={(e) => setForm({ ...form, task_priority: e.target.value })}>{['low', 'normal', 'high', 'urgent'].map((p) => <option key={p}>{p}</option>)}</select></Field>}</div>
        <Field label={form.action === 'email_client' ? 'Message to client' : 'Task note'}><textarea className="input" rows={3} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></Field>
        <div className="flex justify-end"><button className="btn" disabled={form.name.trim().length < 2} onClick={saveRule}>Create rule</button></div></Modal>}
      {form?.kind === 'sched' && <Modal title="New scheduled report" onClose={() => setForm(null)}><Err e={err} />
        <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-x-4"><Field label="Report"><select className="input" value={form.report} onChange={(e) => setForm({ ...form, report: e.target.value })}>{Object.entries(REPORTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Covers"><select className="input" value={form.range_kind} onChange={(e) => setForm({ ...form, range_kind: e.target.value })}><option value="last_month">Last month</option><option value="mtd">Month to date</option><option value="ytd">Year to date</option><option value="last_30d">Last 30 days</option></select></Field>
          <Field label="Frequency"><select className="input" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></Field>
          {form.frequency === 'weekly' && <Field label="On"><select className="input" value={form.weekday} onChange={(e) => setForm({ ...form, weekday: e.target.value })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></Field>}
          {form.frequency === 'monthly' && <Field label="Day of month (1–28)"><input className="input num" type="number" min={1} max={28} value={form.day_of_month} onChange={(e) => setForm({ ...form, day_of_month: e.target.value })} /></Field>}
          <Field label="Format"><select className="input" value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}><option value="csv">CSV</option><option value="xlsx">Excel</option><option value="pdf">PDF</option></select></Field></div>
        <Field label="Recipients" hint="Team members only, comma-separated (max 5)."><input className="input" value={form.recipients} onChange={(e) => setForm({ ...form, recipients: e.target.value })} /></Field>
        <div className="flex justify-end"><button className="btn" disabled={form.name.trim().length < 2} onClick={saveSched}>Create schedule</button></div></Modal>}
      {runs && <Modal title={`History — ${runs.s.name}`} onClose={() => setRuns(null)}><Table rows={runs.rows} empty="Not run yet" cols={[{ h: 'Run', render: (r: any) => <span className="num text-xs">{r.run_key}</span> }, { h: 'Result', render: (r: any) => <><Pill s={r.status === 'ok' ? 'paid' : r.status === 'failed' ? 'void' : 'pending'} />{r.error && <span className="text-xs text-danger ml-2">{r.error}</span>}{r.reconciled === 0 && <span className="text-xs text-warn ml-2">did not reconcile</span>}</> },
        { h: 'Rows', right: true, render: (r: any) => r.row_count ?? '' }, { h: '', render: (r: any) => r.file_key && <button className="btn-ghost" onClick={async () => window.open((await api(`/automation/report-runs/${r.id}/download`)).url)}>Download</button> }]} /></Modal>}
    </Page>
  );
}
