import { useEffect, useState } from 'react';
import { Info, Plus, RefreshCw } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Pill, Table } from '../components/ui';
import { today, useAccounts, useList } from '../lookup';

const download = (name: string, text: string, type = 'text/csv') => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); };
const BASIS: Record<string, string> = { pct_selling: '% of selling', pct_margin: '% of margin', fixed: 'fixed / line' };
const TYPES = ['', 'flight', 'hotel', 'package', 'cruise', 'transfer', 'tour', 'rail', 'car', 'insurance', 'visa', 'fee', 'other'];

function Explain({ id, onClose, onChange }: { id: number; onClose(): void; onChange(): void }) {
  const { can } = useAuth(); const w = can('admin', 'finance_manager');
  const [e, setE] = useState<any>(null); const [err, setErr] = useState(''); const [amt, setAmt] = useState<any>(''); const [reason, setReason] = useState('');
  const load = () => api(`/commissions/entries/${id}`).then(setE).catch((x) => setErr(x.message));
  useEffect(() => { load(); }, [id]);
  if (!e) return null; const c = e.calc_json ?? {}; const locked = ['approved', 'paid'].includes(e.status);
  const setOverride = async (amount: number | null) => { try { await api(`/commissions/entries/${id}/override`, 'PUT', { amount, reason }); setErr(''); await load(); onChange(); } catch (x: any) { setErr(x.message); } };
  return (
    <Modal title="How this commission was calculated" onClose={onClose} wide>
      <Err e={err} />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm mb-3"><Pill s={e.status} /><span className="text-muted">Booking status</span> {c.booking_status}<span className="text-muted">Trigger</span> {String(c.trigger ?? '').replace(/_/g, ' ')}<span className="text-muted">Period</span> <span className="num">{e.period ?? '—'}</span></div>
      <Table rows={c.components ?? []} empty="No components" cols={[
        { h: 'Line', render: (x: any) => <><span className="capitalize text-muted">{x.type}</span> {x.description}</> }, { h: 'Selling', right: true, render: (x: any) => money(x.net) }, { h: 'Cost', right: true, render: (x: any) => money(x.cost) },
        { h: 'Margin', right: true, render: (x: any) => money(x.margin) }, { h: 'Overhead', right: true, render: (x: any) => (x.overhead_alloc ? money(x.overhead_alloc) : '—') },
        { h: 'Rule applied', render: (x: any) => (x.rule_name ? `${x.rule_name}${x.rule_version ? ` v${x.rule_version}` : ''}` : <span className="text-danger">none</span>) }, { h: 'Rate', right: true, render: (x: any) => (x.rate != null ? `${x.rate}%` : '—') }, { h: 'Amount', right: true, render: (x: any) => money(x.amount) }]} />
      <div className="grid sm:grid-cols-3 gap-3 text-sm mt-4">
        <div className="card"><div className="text-xs text-muted">Booking commission</div><b className="num">{money(e.gross_amount)}</b></div>
        <div className="card"><div className="text-xs text-muted">This agent's share ({e.split_pct}%)</div><b className="num">{money(c.computed_share ?? e.amount)}</b></div>
        <div className="card"><div className="text-xs text-muted">{c.override ? 'Manual override (final)' : 'Final amount'}</div><b className="num">{money(e.amount)}</b>{c.override && <div className="text-xs text-warn mt-1">{c.override.reason}</div>}</div></div>
      {e.adjustments.length > 0 && <><h4 className="font-semibold text-sm mt-4 mb-2">Adjustments after approval</h4><Table rows={e.adjustments} cols={[{ h: 'Kind', render: (a: any) => a.kind }, { h: 'Period', render: (a: any) => a.period }, { h: 'Reason', render: (a: any) => a.reason }, { h: 'Status', render: (a: any) => <Pill s={a.status} /> }, { h: 'Amount', right: true, render: (a: any) => money(a.amount) }]} /></>}
      {w && !locked && <div className="flex flex-wrap items-end gap-2 mt-4"><Field label="Manual override amount"><div className="w-36"><Num v={amt} set={setAmt} /></div></Field><Field label="Reason (required)"><input className="input w-64" value={reason} onChange={(x) => setReason(x.target.value)} /></Field>
        <button className="btn mb-3" disabled={amt === '' || reason.length < 3} onClick={() => setOverride(Number(amt))}>Apply override</button>{c.override && <button className="btn-ghost mb-3" onClick={() => setOverride(null)}>Remove override</button>}</div>}
    </Modal>
  );
}

function PeriodDetail({ period, onClose, onChange }: { period: string; onClose(): void; onChange(): void }) {
  const { can } = useAuth(); const w = can('admin', 'finance_manager'); const cash = useAccounts([110]);
  const [v, setV] = useState<any>(null); const [err, setErr] = useState(''); const [explain, setExplain] = useState<number | null>(null); const [payAcc, setPayAcc] = useState(''); const [msg, setMsg] = useState('');
  const load = () => api(`/commissions/periods/${period}`).then(setV).catch((x) => setErr(x.message));
  useEffect(() => { load(); }, [period]);
  if (!v) return null;
  const act = async (fn: () => Promise<any>, ok: string) => { try { const r = await fn(); setErr(''); setMsg(ok); await load(); onChange(); return r; } catch (x: any) { setErr(x.message); setMsg(''); } };
  const approve = () => { let reason: string | undefined; if (v.blocking) { reason = prompt('Blocking exceptions remain. Override reason (required to approve anyway):') ?? undefined; if (!reason) return; } act(() => api(`/commissions/periods/${period}/approve`, 'POST', { override_reason: reason }), 'Approved and posted to the ledger'); };
  return (
    <Modal title={`Commission ${period}`} onClose={onClose} wide>
      <Err e={err} />{msg && <div className="text-success text-sm mb-3" role="status">{msg}</div>}
      <div className="flex flex-wrap items-center gap-4 mb-3"><Pill s={v.status} /><span className="text-sm text-muted">Net payable (all agents)</span><b className="num text-lg">{money(v.total)}</b></div>
      {v.exceptions.map((x: any, i: number) => <div key={i} className={`rounded-lg border text-sm px-3 py-2 mb-2 ${x.severity === 'blocking' ? 'border-danger/30 bg-danger/10 text-danger' : 'border-warn/30 bg-warn/10 text-warn'}`}>{x.message}</div>)}
      <h4 className="font-semibold text-sm mb-2">By agent</h4>
      <Table rows={v.agents.map((a: any) => ({ id: a.agent_id, ...a }))} empty="Nothing eligible in this period yet" cols={[{ h: 'Agent', render: (a: any) => a.agent_name }, { h: 'Bookings', right: true, render: (a: any) => a.entries }, { h: 'Commission', right: true, render: (a: any) => money(a.commission) },
        { h: 'Adjustments', right: true, render: (a: any) => (a.adjustments ? money(a.adjustments) : '—') }, { h: 'Net', right: true, render: (a: any) => <b className={a.net < 0 ? 'text-danger' : ''}>{money(a.net)}</b> }]} />
      <h4 className="font-semibold text-sm mt-4 mb-2">Entries</h4>
      <Table rows={v.entries} onRow={(e: any) => setExplain(e.id)} cols={[{ h: 'Booking', render: (e: any) => <span className="num font-medium">{e.reference}</span> }, { h: 'Agent', render: (e: any) => e.agent_name }, { h: 'Rule', render: (e: any) => <span className="text-muted">{e.rule_summary}</span> },
        { h: 'Status', render: (e: any) => <Pill s={e.status} /> }, { h: 'Amount', right: true, render: (e: any) => money(e.amount) }, { h: '', render: () => <Info size={14} className="text-muted" /> }]} />
      {v.adjustments.length > 0 && <><h4 className="font-semibold text-sm mt-4 mb-2">Adjustments</h4><Table rows={v.adjustments} cols={[{ h: 'Agent', render: (a: any) => a.agent_name }, { h: 'Kind', render: (a: any) => a.kind.replace('_', ' ') }, { h: 'Reason', render: (a: any) => a.reason }, { h: 'Status', render: (a: any) => <Pill s={a.status} /> }, { h: 'Amount', right: true, render: (a: any) => money(a.amount) }]} /></>}
      {w && <div className="flex flex-wrap items-center gap-2 mt-5">
        {v.status === 'open' && <button className="btn" disabled={!v.entries.length && !v.adjustments.length} onClick={() => act(() => api(`/commissions/periods/${period}/submit`, 'POST'), 'Submitted for approval')}>Submit for approval</button>}
        {v.status === 'submitted' && <button className="btn" onClick={approve}>Approve &amp; post</button>}
        {['approved', 'paid'].includes(v.status) && <button className="btn-ghost" onClick={async () => download(`commission-payroll-${period}.csv`, await api(`/commissions/periods/${period}/payroll.csv`))}>Payroll CSV</button>}
        {v.status === 'approved' && <><select className="input w-48" value={payAcc} onChange={(e) => setPayAcc(e.target.value)}><option value="">Pay from…</option>{cash.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <button className="btn" disabled={!payAcc} onClick={() => act(() => api(`/commissions/periods/${period}/pay`, 'POST', { cash_account_id: Number(payAcc) }), 'Marked paid and posted')}>Pay</button></>}
        {v.status === 'approved' && can('admin') && <button className="btn-ghost text-danger" onClick={() => { const r = prompt('Reason for reopening (required):'); if (r) act(() => api(`/commissions/periods/${period}/reopen`, 'POST', { reason: r }), 'Reopened'); }}>Reopen…</button>}
      </div>}
      {explain && <Explain id={explain} onClose={() => setExplain(null)} onChange={load} />}
    </Modal>
  );
}

function RuleForm({ rule, onClose, onDone }: { rule: any; onClose(): void; onDone(): void }) {
  const suppliers = useList('/suppliers'); const team = useList('/team'); const branches = useList('/accounting/branches');
  const [f, setF] = useState<any>(rule ?? { name: '', kind: 'agent', basis: 'pct_margin', rate: 10, priority: 0, deduct_overhead: false }); const [err, setErr] = useState('');
  const [tiers, setTiers] = useState<string>((rule?.tiers ?? []).map((t: any) => `${t.from}:${t.rate}`).join(', '));
  const s = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      const num = (v: any) => (v === '' || v == null ? null : Number(v)), tr = tiers.trim() ? tiers.split(',').map((x) => { const [a, b] = x.split(':').map(Number); return { from: a, rate: b }; }) : null;
      const body = { name: f.name, kind: f.kind, basis: f.basis, rate: f.basis === 'fixed' ? null : num(f.rate), fixed_amount: f.basis === 'fixed' ? num(f.fixed_amount) : null, tiers: tr, deduct_overhead: !!f.deduct_overhead,
        branch_id: num(f.branch_id), product_type: f.product_type || null, supplier_id: num(f.supplier_id), destination: f.destination || null, agent_id: num(f.agent_id), effective_from: f.effective_from || null, effective_to: f.effective_to || null, priority: Number(f.priority) || 0 };
      rule?.id ? await api(`/commissions/rules/${rule.id}`, 'PUT', body) : await api('/commissions/rules', 'POST', body); onDone();
    } catch (x: any) { setErr(x.message); }
  };
  return (
    <Modal title={rule?.id ? `Edit rule (creates version ${rule.version + 1})` : 'New commission rule'} onClose={onClose}><Err e={err} />
      <div className="grid sm:grid-cols-3 gap-x-4">
        <div className="sm:col-span-2"><Field label="Name"><input className="input" value={f.name} onChange={s('name')} /></Field></div>
        <Field label="Pays"><select className="input" value={f.kind} onChange={s('kind')}><option value="agent">Agent (payable)</option><option value="supplier">Supplier → us (receivable)</option></select></Field>
        <Field label="Basis"><select className="input" value={f.basis} onChange={s('basis')}>{Object.entries(BASIS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {f.basis === 'fixed' ? <Field label="Amount per line"><input className="input num" type="number" value={f.fixed_amount ?? ''} onChange={s('fixed_amount')} /></Field> : <Field label="Rate %"><input className="input num" type="number" value={f.rate ?? ''} onChange={s('rate')} /></Field>}
        <Field label="Priority" hint="Higher wins a tie"><input className="input num" type="number" value={f.priority} onChange={s('priority')} /></Field>
        {f.basis !== 'fixed' && <div className="sm:col-span-3"><Field label="Tiers (optional)" hint="threshold:rate pairs on the agent's margin this month, e.g. 0:10, 5000:15, 10000:20"><input className="input num" value={tiers} onChange={(e) => setTiers(e.target.value)} /></Field></div>}
      </div>
      <h4 className="font-semibold text-sm mb-2">Applies to <span className="text-muted font-normal">(leave blank for any)</span></h4>
      <div className="grid sm:grid-cols-3 gap-x-4">
        <Field label="Product"><select className="input" value={f.product_type ?? ''} onChange={s('product_type')}>{TYPES.map((t) => <option key={t} value={t}>{t || 'any'}</option>)}</select></Field>
        <Field label="Supplier"><select className="input" value={f.supplier_id ?? ''} onChange={s('supplier_id')}><option value="">any</option>{suppliers.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="Destination"><input className="input" value={f.destination ?? ''} onChange={s('destination')} /></Field>
        {f.kind === 'agent' && <Field label="Agent"><select className="input" value={f.agent_id ?? ''} onChange={s('agent_id')}><option value="">any</option>{team.map((x: any) => <option key={x.user_id} value={x.user_id}>{x.name}</option>)}</select></Field>}
        <Field label="Branch"><select className="input" value={f.branch_id ?? ''} onChange={s('branch_id')}><option value="">any</option>{branches.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="Booked from"><input className="input num" type="date" value={f.effective_from?.slice?.(0, 10) ?? ''} onChange={s('effective_from')} /></Field>
        <Field label="Booked until"><input className="input num" type="date" value={f.effective_to?.slice?.(0, 10) ?? ''} onChange={s('effective_to')} /></Field></div>
      {f.kind === 'agent' && f.basis === 'pct_margin' && <label className="flex items-center gap-2 text-sm mb-3"><input type="checkbox" checked={!!f.deduct_overhead} onChange={(e) => setF({ ...f, deduct_overhead: e.target.checked })} /> Deduct the booking's overhead from margin first</label>}
      <div className="flex justify-end"><button className="btn" disabled={!f.name} onClick={save}>{rule?.id ? 'Save as new version' : 'Create rule'}</button></div>
    </Modal>
  );
}

export default function Commissions() {
  const { can } = useAuth(); const w = can('admin', 'finance_manager'); const agent = can('agent'); const cash = useAccounts([110]);
  const [tab, setTab] = useState<'periods' | 'entries' | 'rules' | 'supplier'>('periods');
  const [periods, setPeriods] = useState<any[]>([]); const [entries, setEntries] = useState<any[]>([]); const [rules, setRules] = useState<any[]>([]); const [supp, setSupp] = useState<any[]>([]);
  const [status, setStatus] = useState(''); const [open, setOpen] = useState<string | null>(null); const [explain, setExplain] = useState<number | null>(null); const [rform, setRform] = useState<any>(null); const [hist, setHist] = useState<any[] | null>(null);
  const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [rcv, setRcv] = useState<any>(null); const [recv, setRecv] = useState('');
  const load = () => { api('/commissions/periods').then(setPeriods); api(`/commissions/entries${status ? `?status=${status}` : ''}`).then(setEntries); if (!agent) { api('/commissions/rules').then(setRules).catch(() => {}); api('/commissions/supplier').then(setSupp).catch(() => {}); } };
  useEffect(() => { load(); }, [status]);
  const refresh = async () => { try { const r = await api('/commissions/refresh', 'POST'); setMsg(`Recalculated ${r.recalculated} booking(s)${r.errors.length ? `; ${r.errors.length} could not be calculated: ${r.errors[0]}` : ''}`); load(); } catch (e: any) { setErr(e.message); } };
  const tabs = [['periods', 'Month-end'], ['entries', 'Entries'], ...(agent ? [] : [['rules', 'Rules'], ['supplier', 'Supplier commission']])] as [string, string][];
  return (
    <Page title="Commissions" description="Agent commission by rule, with month-end approval. Every figure can be explained and reproduced." actions={<>{w && <button className="btn-ghost" onClick={refresh}><RefreshCw size={15} /> Recalculate</button>}{w && tab === 'rules' && <button className="btn" onClick={() => setRform({})}><Plus size={15} /> New rule</button>}</>}>
      <Err e={err} />{msg && <div className="text-success text-sm mb-3" role="status">{msg}</div>}
      <div className="flex gap-2 mb-4">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'btn' : 'btn-ghost'} onClick={() => setTab(k as any)}>{l}</button>)}</div>
      {tab === 'periods' && <Table rows={periods.map((p) => ({ id: p.period, ...p }))} empty="No commission is eligible yet" onRow={(p: any) => setOpen(p.period)} cols={[{ h: 'Period', render: (p: any) => <span className="num font-medium">{p.period}</span> }, { h: 'Status', render: (p: any) => <Pill s={p.status} /> },
        { h: 'Total', right: true, render: (p: any) => money(Number(p.total_amount ?? 0)) }, { h: 'Approved', render: (p: any) => (p.approved_at ? new Date(p.approved_at).toLocaleDateString() : '—') }, { h: 'Paid', render: (p: any) => (p.paid_at ? new Date(p.paid_at).toLocaleDateString() : '—') }]} />}
      {tab === 'entries' && <><select className="input w-48 mb-3" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['estimated', 'accrued', 'eligible', 'approved', 'paid', 'reversed'].map((s) => <option key={s}>{s}</option>)}</select>
        <Table rows={entries} onRow={(e: any) => setExplain(e.id)} cols={[{ h: 'Booking', render: (e: any) => <span className="num font-medium">{e.reference}</span> }, { h: 'Destination', render: (e: any) => e.destination }, { h: 'Agent', render: (e: any) => e.agent_name },
          { h: 'Status', render: (e: any) => <Pill s={e.status} /> }, { h: 'Flags', render: (e: any) => (e.flags ? <span className="text-warn text-xs">{e.flags.replace(/_/g, ' ')}</span> : '') }, { h: 'Margin', right: true, render: (e: any) => money(e.margin) }, { h: 'Commission', right: true, render: (e: any) => money(e.amount) }]} /></>}
      {tab === 'rules' && <Table rows={rules} cols={[{ h: 'Name', render: (r: any) => <><b>{r.name}</b> <span className="text-xs text-muted">v{r.version}</span></> }, { h: 'Pays', render: (r: any) => r.kind }, { h: 'Basis', render: (r: any) => `${BASIS[r.basis]} ${r.basis === 'fixed' ? money(r.fixed_amount) : r.tiers?.length ? '(tiered)' : `${r.rate}%`}` },
        { h: 'Applies to', render: (r: any) => [r.product_type, r.supplier_name, r.destination, r.agent_name, r.branch_id && `branch ${r.branch_id}`].filter(Boolean).join(' · ') || 'everything' }, { h: 'Window', render: (r: any) => (r.effective_from || r.effective_to ? `${r.effective_from?.slice(0, 10) ?? '…'} → ${r.effective_to?.slice(0, 10) ?? '…'}` : 'always') },
        { h: '', render: (r: any) => w && <div className="flex gap-1 justify-end"><button className="btn-ghost" onClick={() => setRform(r)}>Edit</button><button className="btn-ghost" onClick={async () => setHist(await api(`/commissions/rules/${r.rule_key}/history`))}>History</button><button className="btn-ghost text-danger" onClick={async () => { await api(`/commissions/rules/${r.id}/deactivate`, 'POST'); load(); }}>Retire</button></div> }]} />}
      {tab === 'supplier' && <Table rows={supp} empty="No supplier commission expected yet" cols={[{ h: 'Booking', render: (s: any) => <span className="num">{s.reference}</span> }, { h: 'Supplier', render: (s: any) => s.supplier_name }, { h: 'Status', render: (s: any) => <Pill s={s.status === 'expected' ? 'pending' : s.status} /> }, { h: 'Amount', right: true, render: (s: any) => money(s.amount) },
        { h: '', render: (s: any) => w && s.status === 'expected' && <button className="btn-ghost" onClick={() => setRcv(s)}>Mark received</button> }]} />}
      {open && <PeriodDetail period={open} onClose={() => setOpen(null)} onChange={load} />}
      {explain && <Explain id={explain} onClose={() => setExplain(null)} onChange={load} />}
      {rform && <RuleForm rule={rform.id ? rform : null} onClose={() => setRform(null)} onDone={() => { setRform(null); load(); }} />}
      {hist && <Modal title="Rule history" onClose={() => setHist(null)}><Table rows={hist} cols={[{ h: 'Version', render: (h: any) => `v${h.version}` }, { h: 'Name', render: (h: any) => h.name }, { h: 'Rate', right: true, render: (h: any) => (h.basis === 'fixed' ? money(h.fixed_amount) : `${h.rate ?? '—'}%`) }, { h: 'By', render: (h: any) => h.created_by_name }, { h: 'Current', render: (h: any) => (h.active ? 'yes' : '') }]} /></Modal>}
      {rcv && <Modal title={`Receive ${money(rcv.amount)} from ${rcv.supplier_name}`} onClose={() => setRcv(null)}><Field label="Deposit to"><select className="input" value={recv} onChange={(e) => setRecv(e.target.value)}><option value="">Select…</option>{cash.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <div className="flex justify-end"><button className="btn" disabled={!recv} onClick={async () => { try { await api(`/commissions/supplier/${rcv.id}/receive`, 'POST', { cash_account_id: Number(recv), date: today() }); setRcv(null); load(); } catch (e: any) { setErr(e.message); } }}>Record receipt</button></div></Modal>}
    </Page>
  );
}
