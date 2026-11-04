import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Field, Modal, Page, Pill, Table, Err } from '../components/ui';
import { useOpenOnNew } from '../lookup';

const TYPES = ['flight', 'hotel', 'package', 'cruise', 'transfer', 'other'];
const blank = () => ({ product_type: 'flight', supplier_id: '', description: '', quantity: 1, unit_cost: 0, markup_pct: 10, tax_rate: 10 });

function InvoiceForm({ onDone }: { onDone(): void }) {
  const { agency } = useAuth();
  const [clients, setClients] = useState<any[]>([]); const [suppliers, setSuppliers] = useState<any[]>([]);
  const [client_id, setClient] = useState(''); const [currency, setCur] = useState(agency!.base_currency);
  const [lines, setLines] = useState([blank()]); const [err, setErr] = useState('');
  useEffect(() => { api('/clients').then(setClients); api('/suppliers').then(setSuppliers); }, []);
  const set = (i: number, k: string, v: any) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const sub = lines.reduce((s, l) => s + l.quantity * l.unit_cost * (1 + l.markup_pct / 100), 0);
  const tax = lines.reduce((s, l) => s + l.quantity * l.unit_cost * (1 + l.markup_pct / 100) * (l.tax_rate / 100), 0);
  const save = async () => {
    try {
      await api('/invoices', 'POST', { client_id: Number(client_id), currency, lines: lines.map((l) => ({ ...l, supplier_id: l.supplier_id ? Number(l.supplier_id) : null })) });
      onDone();
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <Modal title="New invoice (draft)" onClose={onDone}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Client"><select className="input" value={client_id} onChange={(e) => setClient(e.target.value)}><option value="">Select…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Currency"><input className="input" value={currency} maxLength={3} onChange={(e) => setCur(e.target.value.toUpperCase())} /></Field>
      </div>
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 mb-2">
          <select className="input col-span-2" value={l.product_type} onChange={(e) => set(i, 'product_type', e.target.value)}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          <select className="input col-span-2" value={l.supplier_id} onChange={(e) => set(i, 'supplier_id', e.target.value)}><option value="">Supplier</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <input className="input col-span-3" placeholder="Description" value={l.description} onChange={(e) => set(i, 'description', e.target.value)} />
          <input className="input col-span-1 num" type="number" title="Qty" value={l.quantity} onChange={(e) => set(i, 'quantity', +e.target.value)} />
          <input className="input col-span-2 num" type="number" title="Unit cost" value={l.unit_cost} onChange={(e) => set(i, 'unit_cost', +e.target.value)} />
          <input className="input col-span-1 num" type="number" title="Markup %" value={l.markup_pct} onChange={(e) => set(i, 'markup_pct', +e.target.value)} />
          <input className="input col-span-1 num" type="number" title={`${agency!.tax_label} %`} value={l.tax_rate} onChange={(e) => set(i, 'tax_rate', +e.target.value)} />
        </div>))}
      <button className="btn-ghost mb-3" onClick={() => setLines([...lines, blank()])}>+ Line</button>
      <div className="text-xs text-muted">Columns: type · supplier · description · qty · unit cost · markup % · {agency!.tax_label} %</div>
      <div className="text-right num mt-3">Subtotal {money(sub, currency)} · {agency!.tax_label} {money(tax, currency)} · <b>Total {money(sub + tax, currency)}</b></div>
      {err && <div className="text-danger text-sm mt-2">{err}</div>}
      <div className="flex justify-end gap-2 mt-4"><button className="btn-ghost" onClick={onDone}>Cancel</button><button className="btn" onClick={save} disabled={!client_id}>Save draft</button></div>
    </Modal>
  );
}


function InvoiceDetail({ id, onClose, onChange }: { id: number; onClose(): void; onChange(): void }) {
  const { can, agency } = useAuth(); const nav = useNavigate(); const finance = can('admin', 'finance_manager');
  const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [reason, setReason] = useState(''); const [voiding, setVoiding] = useState(false);
  const load = () => api(`/invoices/${id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (!d) return null;
  const { inv, lines, payments, credit_notes } = d, cur = inv.currency;
  const outstanding = Math.round((inv.total - inv.amount_credited - inv.amount_paid) * 100) / 100, issued = !!inv.voucher_id;
  const run = async (fn: () => Promise<any>) => { try { await fn(); setErr(''); await load(); onChange(); } catch (e: any) { setErr(e.message); } };
  return (
    <Modal title={`Invoice ${inv.number}`} onClose={onClose} wide>
      <Err e={err} />
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm mb-4"><Pill s={inv.status} />
        <div><span className="text-muted">Issued</span> <span className="num">{inv.issue_date}</span></div><div><span className="text-muted">Due</span> <span className="num">{inv.due_date}</span></div>
        <div><span className="text-muted">Ledger</span> {issued ? <span className="text-success">posted &amp; locked</span> : <span className="text-warn">not issued</span>}</div>
        {cur !== agency?.base_currency && <div><span className="text-muted">Rate</span> <span className="num">{inv.fx_rate}</span></div>}</div>
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2"><Table rows={lines} cols={[{ h: 'Description', render: (l: any) => <><span className="capitalize text-muted">{l.product_type}</span> — {l.description}</> }, { h: 'Qty', right: true, render: (l: any) => l.quantity }, { h: 'Amount', right: true, render: (l: any) => money(l.line_net, cur) }, { h: agency?.tax_label ?? 'Tax', right: true, render: (l: any) => money(l.line_tax, cur) }]} /></div>
        <div className="card text-sm space-y-1.5"><div className="flex justify-between"><span className="text-muted">Subtotal</span><span className="num">{money(inv.subtotal, cur)}</span></div><div className="flex justify-between"><span className="text-muted">{agency?.tax_label}</span><span className="num">{money(inv.tax_total, cur)}</span></div>
          <div className="flex justify-between font-semibold"><span>Total</span><span className="num">{money(inv.total, cur)}</span></div>
          {inv.amount_credited > 0 && <div className="flex justify-between"><span className="text-muted">Credited</span><span className="num">− {money(inv.amount_credited, cur)}</span></div>}
          <div className="flex justify-between"><span className="text-muted">Paid</span><span className="num">− {money(inv.amount_paid, cur)}</span></div>
          <div className={`flex justify-between rounded-lg px-3 py-2 font-semibold ${outstanding > 0.005 ? 'bg-warn/10 text-warn' : 'bg-success/10 text-success'}`}><span>{outstanding < -0.005 ? 'Client credit' : 'Balance'}</span><span className="num">{money(Math.abs(outstanding), cur)}</span></div></div></div>
      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <div><h4 className="font-semibold text-sm mb-2">Payments</h4><Table rows={payments} empty="No payments yet" cols={[{ h: 'Date', render: (p: any) => <span className="num">{p.paid_at}</span> }, { h: 'Type', render: (p: any) => (p.direction === 'outbound' ? 'Refund' : 'Receipt') }, { h: 'Method', render: (p: any) => p.method.replace('_', ' ') }, { h: 'Amount', right: true, render: (p: any) => <span className={p.voided ? 'line-through text-muted' : ''}>{money(p.amount, cur)}</span> }]} /></div>
        <div><h4 className="font-semibold text-sm mb-2">Credit notes</h4><Table rows={credit_notes} empty="None" cols={[{ h: 'No.', render: (c: any) => <span className="num">{c.cn_no}</span> }, { h: 'Status', render: (c: any) => <Pill s={c.status} /> }, { h: 'Total', right: true, render: (c: any) => money(c.total, cur) }]} /></div></div>
      {finance && <div className="flex flex-wrap items-center gap-2 mt-5">
        {inv.status === 'reviewed' && <button className="btn" onClick={() => run(() => api(`/invoices/${id}/issue`, 'POST'))}>Issue (post to ledger)</button>}
        {issued && outstanding > 0.005 && inv.status !== 'void' && <button className="btn" onClick={() => nav(`/client-receipts?client=${inv.client_id}`)}>Receive payment</button>}
        {issued && inv.status !== 'void' && <button className="btn-ghost" onClick={() => nav('/credit-notes')}>Credit note…</button>}
        {inv.status !== 'draft' && <button className="btn-ghost" onClick={() => run(async () => window.open((await api(`/invoices/${id}/pdf-url`)).url))}>PDF</button>}
        {inv.status !== 'void' && inv.status !== 'credited' && (voiding ? <><input className="input w-64" placeholder="Reason for voiding (required)" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="btn-ghost text-danger" disabled={reason.length < 3} onClick={() => run(() => api(`/invoices/${id}/void`, 'POST', { reason }))}>Confirm void</button></> : <button className="btn-ghost text-danger" onClick={() => setVoiding(true)}>Void…</button>)}</div>}
    </Modal>
  );
}

export default function Invoices() {
  const { can } = useAuth();
  const [rows, setRows] = useState<any[]>([]); const [status, setStatus] = useState(''); const [creating, setCreating] = useState(false); const [msg, setMsg] = useState(''); const [openId, setOpenId] = useState<number | null>(null);
  const load = () => api(`/invoices${status ? `?status=${status}` : ''}`).then(setRows);
  useOpenOnNew(() => setCreating(true));
  useEffect(() => { load(); }, [status]);
  const act = async (fn: () => Promise<any>) => { try { await fn(); setMsg(''); load(); } catch (e: any) { setMsg(e.message); } };
  const finance = can('admin', 'finance_manager');
  return (
    <Page title="Invoices" actions={<>
      <select className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>
        {['draft', 'reviewed', 'sent', 'partially_paid', 'paid', 'overdue', 'credited', 'void'].map((s) => <option key={s}>{s}</option>)}</select>
      {can('admin', 'finance_manager', 'agent') && <button className="btn" onClick={() => setCreating(true)}>New invoice</button>}</>}>
      {msg && <div className="text-danger text-sm mb-3">{msg}</div>}
      <Table rows={rows} onRow={(r) => setOpenId(r.id)} cols={[
        { h: 'Number', render: (r) => <span className="num">{r.number}</span> }, { h: 'Client', render: (r) => r.client_name },
        { h: 'Due', render: (r) => <span className="num">{r.due_date}</span> }, { h: 'Status', render: (r) => <Pill s={r.status} /> },
        { h: 'Total', right: true, render: (r) => money(r.total, r.currency) }, { h: 'Paid', right: true, render: (r) => money(r.amount_paid, r.currency) },
        { h: '', render: (r) => <div className="flex gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
          {finance && r.status === 'draft' && <button className="btn-ghost" onClick={() => act(() => api(`/invoices/${r.id}/status`, 'POST', { status: 'reviewed' }))}>Mark reviewed</button>}
          {finance && r.status === 'reviewed' && <button className="btn" onClick={() => act(() => api(`/invoices/${r.id}/send`, 'POST'))}>Send</button>}
          <button className="btn-ghost" onClick={() => setOpenId(r.id)}>View</button>
          {r.status !== 'draft' && <button className="btn-ghost" onClick={() => act(async () => window.open((await api(`/invoices/${r.id}/pdf-url`)).url))}>PDF</button>}</div> },
      ]} />
      {creating && <InvoiceForm onDone={() => { setCreating(false); load(); }} />}
      {openId && <InvoiceDetail id={openId} onClose={() => setOpenId(null)} onChange={load} />}
    </Page>
  );
}
