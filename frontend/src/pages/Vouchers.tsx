import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Num, Page, Pill, Table } from '../components/ui';
import { today, useAccounts, useList } from '../lookup';
import { X } from 'lucide-react';
import { viewHtml } from '../components/PdfViewer';

/** Shows a printable document inside the app, with a Print button. */
export const printHtml = (html: string, title = 'Print preview') => viewHtml(html, title);

export default function Vouchers({ kind }: { kind: 'receipt' | 'payment' }) {
  const { can } = useAuth(); const [sp, setSp] = useSearchParams();
  const view = sp.get('view') ?? 'new';
  const cash = useAccounts([110]); const party = useAccounts(kind === 'receipt' ? [120, 121, 123, 124, 420] : [210, 211, 212, 220, 320, 321, 123, 124]);
  const formats = useList('/cheque-formats');
  const [rows, setRows] = useState<any[]>([]); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const blank = { voucher_date: today(), cash_account_id: '', party_account_id: '', amount: '', mode: 'cash', cheque_no: '', cheque_date: '', bank_name: '', narration: '' };
  const [f, setF] = useState<any>(blank);
  const scope = view === 'today' ? 'today' : view === 'clear' ? 'pending' : 'all';
  const load = () => api(`/vouchers/${kind}s?scope=${scope}`).then(setRows);
  useEffect(() => { load(); }, [scope, kind]);
  const w = can('admin', 'finance_manager');
  const save = async () => {
    try {
      await api(`/vouchers/${kind}s`, 'POST', { ...f, cash_account_id: Number(f.cash_account_id), party_account_id: Number(f.party_account_id), amount: Number(f.amount), cheque_no: f.cheque_no || null, cheque_date: f.cheque_date || null, bank_name: f.bank_name || null, narration: f.narration || null });
      setF(blank); setErr(''); setMsg('Saved'); load();
    } catch (e: any) { setErr(e.message); setMsg(''); }
  };
  const label = kind === 'receipt' ? 'Receipts' : 'Payments';
  const tabs = kind === 'receipt' ? [['new', 'New receipt'], ['clear', 'Clear checks'], ['today', "Today's list"], ['all', 'All receipts']] : [['new', 'New payment'], ['all', 'All payments']];
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Page title={label}>
      <div className="flex gap-2 mb-4">{tabs.map(([k, l]) => <button key={k} className={view === k ? 'btn' : 'btn-ghost'} onClick={() => setSp({ view: k })}>{l}</button>)}</div>
      {view === 'new' && w && <div className="card max-w-2xl mb-6">
        <Err e={err} />{msg && <div className="text-accent text-sm mb-3">{msg}</div>}
        <div className="grid grid-cols-2 gap-x-4">
          <Field label="Date"><input className="input num" type="date" value={f.voucher_date} onChange={set('voucher_date')} /></Field>
          <Field label="Mode"><select className="input" value={f.mode} onChange={set('mode')}><option value="cash">Cash</option><option value="cheque">Cheque</option><option value="bank">Bank transfer</option></select></Field>
          <Field label={kind === 'receipt' ? 'Deposit to (cash/bank)' : 'Pay from (cash/bank)'}><select className="input" value={f.cash_account_id} onChange={set('cash_account_id')}><option value="">Select…</option>{cash.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></Field>
          <Field label={kind === 'receipt' ? 'Received from' : 'Paid to'}><select className="input" value={f.party_account_id} onChange={set('party_account_id')}><option value="">Select…</option>{party.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></Field>
          <Field label="Amount"><Num v={f.amount} set={(v) => setF({ ...f, amount: v })} /></Field>
          {f.mode === 'cheque' && <><Field label="Cheque no."><input className="input num" value={f.cheque_no} onChange={set('cheque_no')} /></Field>
            <Field label="Cheque date"><input className="input num" type="date" value={f.cheque_date} onChange={set('cheque_date')} /></Field>
            <Field label="Bank"><input className="input" value={f.bank_name} onChange={set('bank_name')} /></Field></>}
        </div>
        <Field label="Narration"><input className="input" value={f.narration} onChange={set('narration')} /></Field>
        {kind === 'receipt' && f.mode === 'cheque' && <p className="text-xs text-muted mb-3">Received cheques are posted to the ledger when you clear them (Clear Checks).</p>}
        <button className="btn" onClick={save} disabled={!f.cash_account_id || !f.party_account_id || !f.amount}>Save</button></div>}
      <Table rows={rows} cols={[
        { h: 'No', render: (r) => <span className="num">{r.voucher_no}</span> }, { h: 'Date', render: (r) => r.voucher_date }, { h: kind === 'receipt' ? 'From' : 'To', render: (r) => r.party_name },
        { h: 'Account', render: (r) => r.cash_name }, { h: 'Mode', render: (r) => (r.mode === 'cheque' ? `Cheque ${r.cheque_no ?? ''}` : r.mode) }, { h: 'Amount', right: true, render: (r) => money(r.amount) },
        { h: 'Status', render: (r) => (r.cleared ? <Pill s="cleared" /> : <Pill s="pending" />) },
        { h: '', render: (r) => w && <div className="flex gap-1 justify-end">
          {kind === 'receipt' && !r.cleared && <button className="btn" onClick={async () => { await api(`/vouchers/receipts/${r.id}/clear`, 'POST', {}); load(); }}>Clear</button>}
          {kind === 'payment' && r.mode === 'cheque' && formats.length > 0 && <select className="input w-32" defaultValue="" onChange={async (e) => { if (e.target.value) printHtml((await api(`/cheque-formats/print/${r.id}?format_id=${e.target.value}`)).html); e.target.value = ''; }}>
            <option value="">Print cheque…</option>{formats.map((x) => <option key={x.id} value={x.id}>{x.bank_name}</option>)}</select>}
          <button className="btn-ghost text-danger" onClick={async () => { if (confirm('Delete voucher and reverse its ledger entries?')) { await api(`/vouchers/${r.id}`, 'DELETE'); load(); } }} aria-label="Remove"><X size={14} /></button></div> }]} />
    </Page>
  );
}
