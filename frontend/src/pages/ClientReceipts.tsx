import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Pill, Table } from '../components/ui';
import { today, useAccounts, useList, useOpenOnNew } from '../lookup';

const newKey = () => (crypto as any).randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

function NewReceipt({ onClose, onDone, preClient }: { onClose(): void; onDone(): void; preClient?: number }) {
  const clients = useList('/clients'); const cash = useAccounts([110]);
  const [f, setF] = useState<any>({ client_id: preClient ?? '', cash_account_id: '', amount: '', method: 'bank_transfer', receipt_date: today(), reference: '' });
  const [open, setOpen] = useState<any[]>([]); const [alloc, setAlloc] = useState<Record<number, number | ''>>({}); const [err, setErr] = useState(''); const [key] = useState(newKey); const [busy, setBusy] = useState(false);
  useEffect(() => { setAlloc({}); if (f.client_id) api(`/finance/clients/${f.client_id}/open-invoices`).then(setOpen).catch(() => setOpen([])); else setOpen([]); }, [f.client_id]);
  const allocated = Object.values(alloc).reduce<number>((s, v) => s + (Number(v) || 0), 0), amount = Number(f.amount) || 0, rest = Math.round((amount - allocated) * 100) / 100;
  const auto = () => { let left = amount; const a: Record<number, number> = {}; for (const i of open) { const x = Math.min(left, i.outstanding); if (x > 0) { a[i.id] = Math.round(x * 100) / 100; left = Math.round((left - x) * 100) / 100; } } setAlloc(a); };
  const save = async () => {
    setBusy(true);
    try {
      const allocations = Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([id, v]) => ({ invoice_id: Number(id), amount: Number(v) }));
      await api('/finance/receipts', 'POST', { client_id: Number(f.client_id), cash_account_id: Number(f.cash_account_id), amount, method: f.method, receipt_date: f.receipt_date, reference: f.reference || null, allocations }, { 'Idempotency-Key': key });
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const cur = open[0]?.currency ?? 'USD';
  return (
    <Modal title="New client receipt" onClose={onClose} wide>
      <Err e={err} />
      <div className="grid sm:grid-cols-3 gap-x-4">
        <Field label="Client"><select className="input" value={f.client_id} onChange={(e) => setF({ ...f, client_id: e.target.value })}><option value="">Select…</option>{clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Amount received"><Num v={f.amount} set={(v) => setF({ ...f, amount: v })} /></Field>
        <Field label="Date"><input className="input num" type="date" value={f.receipt_date} onChange={(e) => setF({ ...f, receipt_date: e.target.value })} /></Field>
        <Field label="Deposit to"><select className="input" value={f.cash_account_id} onChange={(e) => setF({ ...f, cash_account_id: e.target.value })}><option value="">Select…</option>{cash.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Method"><select className="input" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{['bank_transfer', 'cash', 'direct_debit', 'stripe'].map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}</select></Field>
        <Field label="Reference"><input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field></div>
      {f.client_id && <>
        <div className="flex items-center justify-between mb-2"><h4 className="font-semibold text-sm">Allocate to open invoices</h4><button className="btn-ghost" onClick={auto} disabled={!amount}>Auto-allocate oldest first</button></div>
        <Table rows={open} empty="This client has no open invoices — the whole receipt will be held as client credit." cols={[
          { h: 'Invoice', render: (i: any) => <span className="num font-medium">{i.number}</span> }, { h: 'Due', render: (i: any) => <span className="num">{i.due_date}</span> }, { h: 'Status', render: (i: any) => <Pill s={i.status} /> },
          { h: 'Outstanding', right: true, render: (i: any) => money(i.outstanding, i.currency) },
          { h: 'Allocate', right: true, render: (i: any) => <div className="w-32 ml-auto"><Num v={alloc[i.id] ?? ''} set={(v) => setAlloc({ ...alloc, [i.id]: v })} max={i.outstanding} aria-label={`Allocate to ${i.number}`} /></div> }]} />
        <div className="flex justify-end gap-6 text-sm mt-3 num"><span className="text-muted">Allocated <b className="text-fg">{money(allocated, cur)}</b></span><span className={rest < 0 ? 'text-danger' : 'text-muted'}>{rest < 0 ? 'Over-allocated by' : 'Held as client credit'} <b>{money(Math.abs(rest), cur)}</b></span></div></>}
      <div className="flex justify-end mt-4"><button className="btn" disabled={busy || !f.client_id || !f.cash_account_id || !amount || rest < 0} onClick={save}>{busy ? 'Saving…' : 'Record receipt'}</button></div>
    </Modal>
  );
}

export default function ClientReceipts() {
  const { can } = useAuth(); const [sp] = useSearchParams();
  const [rows, setRows] = useState<any[]>([]); const [creating, setCreating] = useState(false); const [view, setView] = useState<any>(null); const [err, setErr] = useState(''); const [reason, setReason] = useState('');
  const load = () => api('/finance/receipts').then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); if (sp.get('client')) setCreating(true); }, []);
  useOpenOnNew(() => setCreating(true));
  const w = can('admin', 'finance_manager');
  const open = async (id: number) => { setReason(''); setErr(''); setView(await api(`/finance/receipts/${id}`)); };
  const voidIt = async () => { try { await api(`/finance/receipts/${view.id}/void`, 'POST', { reason }); setView(null); load(); } catch (e: any) { setErr(e.message); } };
  return (
    <Page title="Client receipts" description="Money received from clients, allocated to invoices. Voiding reverses the ledger entry; nothing is deleted." actions={w && <button className="btn" onClick={() => setCreating(true)}><Plus size={15} /> New receipt</button>}>
      <Err e={err} />
      <Table rows={rows} onRow={(r) => open(r.id)} cols={[
        { h: 'Receipt', render: (r) => <span className="num font-medium">{r.receipt_no}</span> }, { h: 'Date', render: (r) => <span className="num">{r.receipt_date}</span> }, { h: 'Client', render: (r) => r.client_name },
        { h: 'Method', render: (r) => r.method.replace('_', ' ') }, { h: 'Status', render: (r) => <Pill s={r.status} /> }, { h: 'Amount', right: true, render: (r) => money(r.amount, r.currency) },
        { h: 'Unallocated', right: true, render: (r) => (r.unallocated > 0.005 ? <span className="text-warn">{money(r.unallocated, r.currency)}</span> : '—') }]} />
      {creating && <NewReceipt preClient={sp.get('client') ? Number(sp.get('client')) : undefined} onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
      {view && <Modal title={`Receipt ${view.receipt_no}`} onClose={() => setView(null)}><Err e={err} />
        <div className="grid grid-cols-3 gap-3 text-sm mb-4"><div><div className="text-xs text-muted">Amount</div><b className="num">{money(view.amount, view.currency)}</b></div><div><div className="text-xs text-muted">Unallocated</div><b className="num">{money(view.unallocated, view.currency)}</b></div><div><div className="text-xs text-muted">Status</div><Pill s={view.status} /></div></div>
        <Table rows={view.allocations} cols={[{ h: 'Invoice', render: (a: any) => a.invoice_number }, { h: 'Amount', right: true, render: (a: any) => money(a.amount, view.currency) }, { h: '', render: (a: any) => (a.voided ? <Pill s="voided" /> : '') }]} />
        {w && view.status === 'posted' && <div className="mt-4 flex gap-2"><input className="input" placeholder="Reason for voiding (required)" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="btn-ghost text-danger" disabled={reason.length < 3} onClick={voidIt}>Void receipt</button></div>}</Modal>}
    </Page>
  );
}
