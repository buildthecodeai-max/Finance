import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Pill, Table } from '../components/ui';
import { today, useAccounts, useList, useOpenOnNew } from '../lookup';

export default function SupplierBills() {
  const { can } = useAuth(); const w = can('admin', 'finance_manager'); const suppliers = useList('/suppliers'); const cash = useAccounts([110]);
  const [rows, setRows] = useState<any[]>([]); const [status, setStatus] = useState(''); const [aging, setAging] = useState<any[]>([]); const [tab, setTab] = useState<'bills' | 'aging'>('bills');
  const [form, setForm] = useState<any>(null); const [view, setView] = useState<any>(null); const [pay, setPay] = useState<any>(null); const [err, setErr] = useState(''); const [info, setInfo] = useState<string[]>([]);
  const load = () => { api(`/finance/bills${status ? `?status=${status}` : ''}`).then(setRows); api('/finance/ap-aging').then(setAging); };
  useEffect(() => { load(); }, [status]);
  useOpenOnNew(() => setForm({ supplier_id: '', supplier_ref: '', bill_date: today(), description: '', amount: '', tax: '' }));
  const run = async (fn: () => Promise<any>, after?: () => void) => { try { const r = await fn(); setErr(''); after?.(); load(); return r; } catch (e: any) { setErr(e.message); } };
  const open = async (id: number) => { setErr(''); setView(await api(`/finance/bills/${id}`)); };
  const create = () => run(async () => {
    const r = await api('/finance/bills', 'POST', { supplier_id: Number(form.supplier_id), supplier_ref: form.supplier_ref, bill_date: form.bill_date, lines: [{ description: form.description || 'Supplier invoice', amount: Number(form.amount), tax: Number(form.tax) || 0 }] });
    setInfo([...r.warnings, ...r.mismatches]); setForm(null);
  });
  const approve = async () => {
    let override: string | undefined;
    if (view.mismatch_note) { override = prompt(`This bill does not match the booking cost:\n${view.mismatch_note}\n\nOverride reason (required to approve):`) ?? undefined; if (!override) return; }
    await run(() => api(`/finance/bills/${view.id}/approve`, 'POST', { override_reason: override }), () => setView(null));
  };
  return (
    <Page title="Supplier bills" description="What you owe suppliers. Approving a bill posts it to the ledger; paying it clears the payable."
      actions={<>{(['bills', 'aging'] as const).map((t) => <button key={t} className={tab === t ? 'btn' : 'btn-ghost'} onClick={() => setTab(t)}>{t === 'bills' ? 'Bills' : 'Payables aging'}</button>)}
        {w && <button className="btn" onClick={() => setForm({ supplier_id: '', supplier_ref: '', bill_date: today(), description: '', amount: '', tax: '' })}><Plus size={15} /> New bill</button>}</>}>
      <Err e={err} />{info.length > 0 && <div className="rounded-lg border border-warn/30 bg-warn/10 text-warn text-sm p-3 mb-3">{info.map((i) => <div key={i}>{i}</div>)}</div>}
      {tab === 'bills' ? <>
        <select className="input w-48 mb-3" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['draft', 'approved', 'partially_paid', 'paid', 'void'].map((s) => <option key={s}>{s}</option>)}</select>
        <Table rows={rows} onRow={(r) => open(r.id)} cols={[
          { h: 'Bill', render: (r) => <span className="num font-medium">{r.bill_no}</span> }, { h: 'Supplier', render: (r) => r.supplier_name }, { h: 'Their ref', render: (r) => r.supplier_ref }, { h: 'Due', render: (r) => <span className="num">{r.due_date}</span> },
          { h: 'Status', render: (r) => <Pill s={r.status} /> }, { h: 'Flags', render: (r) => (r.mismatch_note ? <span className="text-warn text-xs">cost mismatch</span> : '') },
          { h: 'Total', right: true, render: (r) => money(r.total, r.currency) }, { h: 'Outstanding', right: true, render: (r) => money(r.outstanding, r.currency) }]} /></>
        : <Table rows={aging} cols={[{ h: 'Bill', render: (r: any) => <span className="num">{r.bill_no}</span> }, { h: 'Supplier', render: (r: any) => r.supplier }, { h: 'Due', render: (r: any) => <span className="num">{r.due_date}</span> },
          { h: 'Days overdue', right: true, render: (r: any) => (r.days_overdue > 0 ? <span className="text-danger">{r.days_overdue}</span> : '—') }, { h: 'Outstanding', right: true, render: (r: any) => money(r.outstanding, r.currency) }]} />}
      {form && <Modal title="New supplier bill" onClose={() => setForm(null)}><Err e={err} />
        <div className="grid grid-cols-2 gap-x-4"><Field label="Supplier"><select className="input" value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}><option value="">Select…</option>{suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Supplier's invoice no." hint="Duplicates are rejected"><input className="input" value={form.supplier_ref} onChange={(e) => setForm({ ...form, supplier_ref: e.target.value })} /></Field>
          <Field label="Bill date"><input className="input num" type="date" value={form.bill_date} onChange={(e) => setForm({ ...form, bill_date: e.target.value })} /></Field>
          <Field label="Description"><input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Amount (net)"><Num v={form.amount} set={(v) => setForm({ ...form, amount: v })} /></Field><Field label="Tax"><Num v={form.tax} set={(v) => setForm({ ...form, tax: v })} /></Field></div>
        <p className="text-xs text-muted mb-3">To match a bill to booking components, create it via the API with component ids; the booking UI link is a next step.</p>
        <div className="flex justify-end"><button className="btn" disabled={!form.supplier_id || !form.supplier_ref || !form.amount} onClick={create}>Save draft</button></div></Modal>}
      {view && <Modal title={`${view.bill_no} · ${view.supplier_ref}`} onClose={() => setView(null)}><Err e={err} />
        <div className="grid grid-cols-4 gap-3 text-sm mb-3"><div><div className="text-xs text-muted">Status</div><Pill s={view.status} /></div><div><div className="text-xs text-muted">Total</div><b className="num">{money(view.total, view.currency)}</b></div><div><div className="text-xs text-muted">Paid</div><b className="num">{money(view.amount_paid, view.currency)}</b></div><div><div className="text-xs text-muted">Due</div><b className="num">{view.due_date}</b></div></div>
        {view.mismatch_note && <div className="rounded-lg border border-warn/30 bg-warn/10 text-warn text-sm p-3 mb-3">Does not match the booking cost: {view.mismatch_note}{view.override_reason && <div className="mt-1 text-fg">Override: {view.override_reason}</div>}</div>}
        <Table rows={view.lines} cols={[{ h: 'Description', render: (l: any) => l.description }, { h: 'Amount', right: true, render: (l: any) => money(l.amount, view.currency) }, { h: 'Tax', right: true, render: (l: any) => money(l.tax, view.currency) }]} />
        {w && <div className="flex flex-wrap gap-2 mt-4">
          {['draft', 'pending_approval'].includes(view.status) && <button className="btn" onClick={approve}>Approve</button>}
          {['approved', 'partially_paid'].includes(view.status) && <button className="btn" onClick={() => setPay({ cash_account_id: '', amount: Math.round((view.total - view.amount_paid) * 100) / 100, date: today() })}>Record payment</button>}
          {view.status !== 'void' && view.amount_paid === 0 && <button className="btn-ghost text-danger" onClick={() => { const r = prompt('Reason for voiding (required):'); if (r) run(() => api(`/finance/bills/${view.id}/void`, 'POST', { reason: r }), () => setView(null)); }}>Void</button>}</div>}</Modal>}
      {pay && view && <Modal title={`Pay ${view.bill_no}`} onClose={() => setPay(null)}><Err e={err} />
        <Field label="Pay from"><select className="input" value={pay.cash_account_id} onChange={(e) => setPay({ ...pay, cash_account_id: e.target.value })}><option value="">Select…</option>{cash.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Amount"><Num v={pay.amount} set={(v) => setPay({ ...pay, amount: v })} /></Field><Field label="Date"><input className="input num" type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field></div>
        <div className="flex justify-end"><button className="btn" disabled={!pay.cash_account_id || !pay.amount} onClick={() => run(() => api(`/finance/bills/${view.id}/pay`, 'POST', { cash_account_id: Number(pay.cash_account_id), amount: Number(pay.amount), date: pay.date }), () => { setPay(null); setView(null); })}>Pay</button></div></Modal>}
    </Page>
  );
}
