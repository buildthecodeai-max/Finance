import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Table } from '../components/ui';
import { today } from '../lookup';

export default function ExchangeRates() {
  const { can, agency } = useAuth(); const w = can('admin', 'finance_manager');
  const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [form, setForm] = useState<any>(null); const [confirmMsg, setConfirmMsg] = useState('');
  const load = () => api('/finance/rates').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const save = async (confirm = false) => {
    try { await api('/finance/rates', 'POST', { from: form.from.toUpperCase(), to: form.to.toUpperCase(), rate: Number(form.rate), date: form.date, confirm }); setForm(null); setConfirmMsg(''); setErr(''); load(); }
    catch (e: any) { if (/differs from the last known/.test(e.message)) setConfirmMsg(e.message); else { setErr(e.message); } }
  };
  return (
    <Page title="Exchange rates" description={`Rates convert foreign-currency documents into ${d?.base_currency ?? agency?.base_currency}. The rate is locked on each document when it is issued; rates older than ${d?.max_age_days ?? 7} days are not used.`}
      actions={w && <button className="btn" onClick={() => setForm({ from: '', to: d?.base_currency ?? 'USD', rate: '', date: today() })}><Plus size={15} /> Add rate</button>}>
      <Err e={err} />
      <Table rows={(d?.rates ?? []).map((r: any, i: number) => ({ id: i, ...r }))} empty="No rates yet. Add one before issuing invoices in a foreign currency." cols={[
        { h: 'Pair', render: (r: any) => <b>1 {r.base} = {r.quote}</b> }, { h: 'Rate', right: true, render: (r: any) => <span className="num">{Number(r.rate).toFixed(6)}</span> }, { h: 'Date', render: (r: any) => <span className="num">{String(r.rate_date).slice(0, 10)}</span> },
        { h: 'Source', render: (r: any) => <span className="capitalize">{r.source}</span> }, { h: 'Entered by', render: (r: any) => r.entered_by ?? '—' },
        { h: 'Freshness', render: (r: any) => (r.stale ? <span className="pill bg-danger/15 text-danger">stale · {r.age_days}d</span> : <span className="pill bg-success/15 text-success">{r.age_days === 0 ? 'today' : `${r.age_days}d old`}</span>) }]} />
      {form && <Modal title="Add exchange rate" onClose={() => { setForm(null); setConfirmMsg(''); }}><Err e={err} />
        {confirmMsg && <div className="rounded-lg border border-warn/30 bg-warn/10 text-warn text-sm p-3 mb-3">{confirmMsg}<div className="mt-2"><button className="btn" onClick={() => save(true)}>Yes, this rate is correct</button></div></div>}
        <div className="grid grid-cols-2 gap-x-4"><Field label="From currency"><input className="input num uppercase" maxLength={3} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder="EUR" /></Field><Field label="To currency"><input className="input num uppercase" maxLength={3} value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></Field>
          <Field label={`Rate: 1 ${form.from || '…'} = ? ${form.to || '…'}`}><Num v={form.rate} set={(v) => setForm({ ...form, rate: v })} /></Field><Field label="Rate date"><input className="input num" type="date" max={today()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field></div>
        <p className="text-xs text-muted mb-3">Manual rates are recorded with your name and the date, and are audited.</p>
        <div className="flex justify-end"><button className="btn" disabled={form.from.length !== 3 || form.to.length !== 3 || !form.rate} onClick={() => save(false)}>Save rate</button></div></Modal>}
    </Page>
  );
}
