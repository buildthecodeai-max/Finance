import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Pill, Table } from '../components/ui';
import { useAccounts } from '../lookup';

export default function CreditNotes() {
  const { can } = useAuth(); const w = can('admin', 'finance_manager'); const cash = useAccounts([110]);
  const [tab, setTab] = useState<'cn' | 'refunds'>('cn');
  const [cns, setCns] = useState<any[]>([]); const [refunds, setRefunds] = useState<any[]>([]); const [invoices, setInvoices] = useState<any[]>([]);
  const [err, setErr] = useState(''); const [form, setForm] = useState<any>(null); const [rform, setRform] = useState<any>(null);
  const load = () => { api('/finance/credit-notes').then(setCns); api('/finance/client-refunds').then(setRefunds); };
  useEffect(() => { load(); api('/invoices').then((r) => setInvoices(r.filter((i: any) => !['draft', 'reviewed', 'void'].includes(i.status)))); }, []);
  const run = async (fn: () => Promise<any>) => { try { await fn(); setErr(''); load(); } catch (e: any) { setErr(e.message); } };
  const askReason = (what: string) => prompt(`Reason for ${what} (required):`) ?? '';
  return (
    <Page title="Credit notes & refunds" description="Corrections to issued invoices. Issued invoices are never edited — credit them, then refund any overpayment."
      actions={w && (tab === 'cn' ? <button className="btn" onClick={() => setForm({ invoice_id: '', reason: '', amount: '', tax: '' })}><Plus size={15} /> New credit note</button> : <button className="btn" onClick={() => setRform({ invoice_id: '', amount: '', method: 'bank_transfer', cash_account_id: '', reason: '' })}><Plus size={15} /> Request refund</button>)}>
      <div className="flex gap-2 mb-4">{([['cn', 'Credit notes'], ['refunds', 'Client refunds']] as const).map(([k, l]) => <button key={k} className={tab === k ? 'btn' : 'btn-ghost'} onClick={() => setTab(k)}>{l}</button>)}</div>
      <Err e={err} />
      {tab === 'cn' ? <Table rows={cns} cols={[
        { h: 'No.', render: (r) => <span className="num font-medium">{r.cn_no}</span> }, { h: 'Invoice', render: (r) => r.invoice_number }, { h: 'Client', render: (r) => r.client_name }, { h: 'Reason', render: (r) => r.reason },
        { h: 'Status', render: (r) => <Pill s={r.status} /> }, { h: 'Total', right: true, render: (r) => money(r.total, r.currency) },
        { h: '', render: (r) => w && <div className="flex gap-1 justify-end">
          {r.status === 'draft' && <button className="btn" onClick={() => run(() => api(`/finance/credit-notes/${r.id}/issue`, 'POST'))}>Issue</button>}
          {r.status !== 'void' && <button className="btn-ghost text-danger" onClick={() => { const x = askReason('voiding this credit note'); if (x) run(() => api(`/finance/credit-notes/${r.id}/void`, 'POST', { reason: x })); }}>Void</button>}</div> }]} />
        : <Table rows={refunds} cols={[
          { h: 'No.', render: (r) => <span className="num font-medium">{r.refund_no}</span> }, { h: 'Invoice', render: (r) => r.invoice_number }, { h: 'Client', render: (r) => r.client_name }, { h: 'Requested by', render: (r) => r.requested_by_name },
          { h: 'Status', render: (r) => <Pill s={r.status} /> }, { h: 'Amount', right: true, render: (r) => money(r.amount, r.currency) },
          { h: '', render: (r) => w && <div className="flex gap-1 justify-end">
            {r.status === 'requested' && <><button className="btn" onClick={() => run(() => api(`/finance/client-refunds/${r.id}/approve`, 'POST'))}>Approve</button><button className="btn-ghost" onClick={() => run(() => api(`/finance/client-refunds/${r.id}/reject`, 'POST'))}>Reject</button></>}
            {r.status === 'approved' && <button className="btn" onClick={() => run(() => api(`/finance/client-refunds/${r.id}/pay`, 'POST', {}))}>Mark paid</button>}</div> }]} />}
      {form && <Modal title="New credit note" onClose={() => setForm(null)}><Err e={err} />
        <Field label="Invoice"><select className="input" value={form.invoice_id} onChange={(e) => setForm({ ...form, invoice_id: e.target.value })}><option value="">Select…</option>{invoices.map((i) => <option key={i.id} value={i.id}>{i.number} — {i.client_name} — {money(i.total, i.currency)}</option>)}</select></Field>
        <Field label="Reason"><input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Amount (net)"><Num v={form.amount} set={(v) => setForm({ ...form, amount: v })} /></Field><Field label="Tax"><Num v={form.tax} set={(v) => setForm({ ...form, tax: v })} /></Field></div>
        <p className="text-xs text-muted mb-3">Created as a draft. Issuing posts it to the ledger; above the approval threshold a different person must issue it.</p>
        <div className="flex justify-end"><button className="btn" disabled={!form.invoice_id || !form.reason || !form.amount} onClick={() => run(async () => { await api('/finance/credit-notes', 'POST', { invoice_id: Number(form.invoice_id), reason: form.reason, lines: [{ description: form.reason, amount: Number(form.amount), tax: Number(form.tax) || 0 }] }); setForm(null); })}>Create draft</button></div></Modal>}
      {rform && <Modal title="Request client refund" onClose={() => setRform(null)}><Err e={err} />
        <Field label="Invoice (must be overpaid after credits)"><select className="input" value={rform.invoice_id} onChange={(e) => setRform({ ...rform, invoice_id: e.target.value })}><option value="">Select…</option>{invoices.filter((i) => i.amount_paid + i.amount_credited > i.total + 0.005).map((i) => <option key={i.id} value={i.id}>{i.number} — {i.client_name} — surplus {money(i.amount_paid + i.amount_credited - i.total, i.currency)}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Amount"><Num v={rform.amount} set={(v) => setRform({ ...rform, amount: v })} /></Field>
          <Field label="Pay from"><select className="input" value={rform.cash_account_id} onChange={(e) => setRform({ ...rform, cash_account_id: e.target.value })}><option value="">Select…</option>{cash.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field></div>
        <Field label="Reason"><input className="input" value={rform.reason} onChange={(e) => setRform({ ...rform, reason: e.target.value })} /></Field>
        <div className="flex justify-end"><button className="btn" disabled={!rform.invoice_id || !rform.cash_account_id || !rform.amount || !rform.reason} onClick={() => run(async () => { await api('/finance/client-refunds', 'POST', { invoice_id: Number(rform.invoice_id), amount: Number(rform.amount), method: rform.method, cash_account_id: Number(rform.cash_account_id), reason: rform.reason }); setRform(null); })}>Request</button></div></Modal>}
    </Page>
  );
}
