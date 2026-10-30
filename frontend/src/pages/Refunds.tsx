import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Num, Page, Table, Toolbar } from '../components/ui';
import { today, useAccounts, useList } from '../lookup';

const blank = (): any => ({ refund_date: today(), amount: '', rec_from_vendor: '', pay_to_customer: '', cancelation: '', service: '', com_rec: '', com_paid: '', wh_air: '', vat: '', discount: '', pending: false });

export default function Refunds() {
  const { can } = useAuth(); const [sp] = useSearchParams(); const lineId = sp.get('line');
  const clients = useAccounts([120]); const vendors = useAccounts([210, 211]); const branches = useList('/accounting/branches'); const depts = useList('/accounting/departments');
  const [rows, setRows] = useState<any[]>([]); const [f, setF] = useState<any>(blank()); const [err, setErr] = useState('');
  const load = () => api('/tickets/refunds').then(setRows);
  useEffect(() => { load(); }, []);
  useEffect(() => { if (lineId) api(`/tickets/refund-prefill/${lineId}`).then((p) => setF({ ...blank(), ...p })).catch((e) => setErr(e.message)); }, [lineId]);
  const w = can('admin', 'finance_manager');
  const s = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const n = (k: string, label: string) => <Field label={label}><Num v={f[k]} set={(v) => setF({ ...f, [k]: v })} /></Field>;
  const pay = f.pay_to_customer || Math.max(0, (Number(f.amount) || 0) - (Number(f.cancelation) || 0) - (Number(f.service) || 0));
  const profit = (Number(f.rec_from_vendor) || 0) - pay;
  const save = async () => {
    try {
      const body = { ...f, client_account_id: Number(f.client_account_id), payable_account_id: Number(f.payable_account_id), branch_id: f.branch_id || null, department_id: f.department_id || null };
      f.id ? await api(`/tickets/refunds/${f.id}`, 'PUT', body) : await api('/tickets/refunds', 'POST', body);
      setF(blank()); setErr(''); load();
    } catch (e: any) { setErr(e.message); }
  };
  const del = async () => { if (f.id && confirm('Delete refund and reverse its ledger entries?')) { await api(`/tickets/refunds/${f.id}`, 'DELETE'); setF(blank()); load(); } };
  return (
    <Page title="Refund">
      <Toolbar canWrite={w} onNew={() => setF(blank())} onSave={save} onDelete={f.id ? del : undefined} />
      <Err e={err} />
      <div className="grid lg:grid-cols-[1fr_320px] gap-4 mb-6">
        <div className="card grid grid-cols-2 lg:grid-cols-3 gap-x-3">
          <Field label="Refund ID"><input className="input num" disabled value={f.refund_no ?? '(New)'} /></Field>
          <Field label="Date *"><input className="input num" type="date" value={f.refund_date ?? ''} onChange={s('refund_date')} /></Field>
          <Field label="Branch"><select className="input" value={f.branch_id ?? ''} onChange={s('branch_id')}><option value="">—</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <Field label="Department"><select className="input" value={f.department_id ?? ''} onChange={s('department_id')}><option value="">—</option>{depts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <Field label="Client Code *"><select className="input" value={f.client_account_id ?? ''} onChange={s('client_account_id')}><option value="">Select…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></Field>
          <Field label="Payable *"><select className="input" value={f.payable_account_id ?? ''} onChange={s('payable_account_id')}><option value="">Select…</option>{vendors.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></Field>
          <Field label="Passenger"><input className="input" value={f.passenger ?? ''} onChange={s('passenger')} /></Field>
          <Field label="Passport"><input className="input" value={f.passport ?? ''} onChange={s('passport')} /></Field>
          <Field label="Hotel"><input className="input" value={f.hotel ?? ''} onChange={s('hotel')} /></Field>
          <Field label="Confirmation No"><input className="input" value={f.confirmation_no ?? ''} onChange={s('confirmation_no')} /></Field>
          <Field label="Particulars"><input className="input" value={f.particulars ?? ''} onChange={s('particulars')} /></Field>
          {n('amount', 'Amount *')}{n('com_rec', 'Com Rec')}{n('com_paid', 'Com Paid')}{n('wh_air', 'WH Air')}{n('vat', 'VAT')}{n('discount', 'Discount')}
          {n('cancelation', 'Cancelation')}{n('service', 'Service')}{n('rec_from_vendor', 'Rec from Vendor')}{n('pay_to_customer', 'Pay to Customer (auto)')}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.pending} onChange={(e) => setF({ ...f, pending: e.target.checked })} /> Pending (don't post yet)</label>
        </div>
        <div className="card h-fit space-y-2 text-sm">
          {[['Rec from Vendor', f.rec_from_vendor, 'bg-success/15'], ['Pay to Customer', pay, 'bg-danger/15'], ['Profit', profit, 'bg-warn/15']].map(([k, v, c]: any) => (
            <div key={k} className={`flex justify-between rounded px-3 py-2 ${c}`}><span>{k}</span><span className="num">{Number(v || 0).toFixed(2)}</span></div>))}
          <p className="text-xs text-muted pt-2">Posting: Dr vendor, Cr client; the difference goes to Service Charges.</p></div>
      </div>
      <Table rows={rows} onRow={(r) => setF({ ...r, pending: !!r.pending })} cols={[
        { h: 'Refund', render: (r) => <span className="num">{r.refund_no}</span> }, { h: 'Date', render: (r) => r.refund_date }, { h: 'Client', render: (r) => r.client_name }, { h: 'Passenger', render: (r) => r.passenger },
        { h: 'From vendor', right: true, render: (r) => money(r.rec_from_vendor) }, { h: 'To customer', right: true, render: (r) => money(r.pay_to_customer) }, { h: 'Profit', right: true, render: (r) => money(r.profit) }]} />
    </Page>
  );
}
