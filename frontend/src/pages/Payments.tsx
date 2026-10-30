import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Page, Pill, Table } from '../components/ui';

export default function Payments() {
  const { can } = useAuth();
  const [pay, setPay] = useState<any[]>([]); const [open, setOpen] = useState(false);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [f, setF] = useState<any>({ method: 'bank_transfer' }); const [err, setErr] = useState('');
  const load = () => api('/payments?direction=inbound').then(setPay);
  useEffect(() => { load(); }, []);
  const finance = can('admin', 'finance_manager');
  const start = async () => { setInvoices((await api('/invoices')).filter((i: any) => ['sent', 'partially_paid', 'overdue'].includes(i.status))); setOpen(true); };
  const submit = async () => {
    try { await api('/payments/inbound', 'POST', { invoice_id: +f.invoice_id, amount: +f.amount, method: f.method }); setOpen(false); setErr(''); setF({ method: 'bank_transfer' }); load(); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <Page title="Payments" description="Money received from clients." actions={<>{finance && <Link to="/payment-runs" className="btn-ghost">Supplier payment runs →</Link>}{finance && <button className="btn" onClick={start}>Record payment</button>}</>}>
      <Table rows={pay} cols={[
        { h: 'Date', render: (r) => <span className="num">{r.paid_at}</span> }, { h: 'Invoice', render: (r) => r.invoice_number }, { h: 'Client', render: (r) => r.client_name },
        { h: 'Method', render: (r) => r.method.replace('_', ' ') }, { h: 'Amount', right: true, render: (r) => money(r.amount, r.currency) },
        { h: 'Reconciled', render: (r) => (r.reconciled ? <Pill s="reconciled" /> : <Pill s="pending" />) }]} />
      {open && <Modal title="Record client payment" onClose={() => setOpen(false)}><Err e={err} />
        <Field label="Invoice"><select className="input" onChange={(e) => setF({ ...f, invoice_id: e.target.value })}><option value="">Select…</option>{invoices.map((i) => <option key={i.id} value={i.id}>{i.number} — {i.client_name} — {money(i.total - i.amount_paid, i.currency)} due</option>)}</select></Field>
        <Field label="Method"><select className="input" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{['bank_transfer', 'stripe', 'direct_debit', 'cash'].map((m) => <option key={m}>{m}</option>)}</select></Field>
        <Field label="Amount"><input className="input num" type="number" onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <div className="flex justify-end"><button className="btn" onClick={submit}>Save</button></div></Modal>}
    </Page>
  );
}
