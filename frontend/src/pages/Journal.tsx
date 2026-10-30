import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Table } from '../components/ui';
import { today, useAccounts, useOpenOnNew } from '../lookup';
import { Plus } from 'lucide-react';

export default function Journal() {
  const { can } = useAuth(); const accounts = useAccounts([]);
  const [rows, setRows] = useState<any[]>([]); const [open, setOpen] = useState(false); const [view, setView] = useState<any>(null);
  const [date, setDate] = useState(today()); const [narr, setNarr] = useState(''); const [err, setErr] = useState('');
  const [lines, setLines] = useState<any[]>([{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }]);
  const load = () => api('/accounting/journal').then(setRows);
  useOpenOnNew(() => setOpen(true));
  useEffect(() => { load(); }, []);
  const dr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0), cr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const set = (i: number, k: string, v: any) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const save = async () => {
    try { await api('/accounting/journal', 'POST', { date, narration: narr, lines: lines.filter((l) => l.account_id).map((l) => ({ account_id: Number(l.account_id), debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })) }); setOpen(false); load(); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <Page title="Journal Voucher" actions={can('admin', 'finance_manager') && <button className="btn" onClick={() => { setLines([{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }]); setNarr(''); setErr(''); setOpen(true); }}><Plus size={15} /> New voucher</button>}>
      <Table rows={rows} onRow={async (r) => setView(await api(`/accounting/journal/${r.id}`))} cols={[{ h: 'No', render: (r) => <span className="num">{r.voucher_no}</span> }, { h: 'Date', render: (r) => r.voucher_date }, { h: 'Narration', render: (r) => r.narration }, { h: 'Amount', right: true, render: (r) => money(r.amount) }]} />
      {open && <Modal title="New journal voucher" onClose={() => setOpen(false)}>
        <Err e={err} />
        <div className="grid grid-cols-2 gap-3"><Field label="Date"><input className="input num" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field><Field label="Narration"><input className="input" value={narr} onChange={(e) => setNarr(e.target.value)} /></Field></div>
        {lines.map((l, i) => <div key={i} className="grid grid-cols-12 gap-2 mb-2">
          <select className="input col-span-6" value={l.account_id} onChange={(e) => set(i, 'account_id', e.target.value)}><option value="">Account…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select>
          <div className="col-span-3"><Num v={l.debit} set={(v) => set(i, 'debit', v)} placeholder="Debit" /></div><div className="col-span-3"><Num v={l.credit} set={(v) => set(i, 'credit', v)} placeholder="Credit" /></div></div>)}
        <button className="btn-ghost mb-3" onClick={() => setLines([...lines, { account_id: '', debit: '', credit: '' }])}>+ Line</button>
        <div className="flex justify-between items-center"><span className={`num text-sm ${dr === cr && dr > 0 ? 'text-success' : 'text-warn'}`}>Dr {money(dr)} · Cr {money(cr)} {dr === cr && dr > 0 ? '✓' : '(must balance)'}</span>
          <button className="btn" disabled={dr !== cr || dr === 0} onClick={save}>Post</button></div></Modal>}
      {view && <Modal title={view.voucher_no} onClose={() => setView(null)}>
        <Table rows={view.lines} cols={[{ h: 'Account', render: (r: any) => `${r.code} — ${r.name}` }, { h: 'Debit', right: true, render: (r: any) => (r.debit ? money(r.debit) : '') }, { h: 'Credit', right: true, render: (r: any) => (r.credit ? money(r.credit) : '') }]} /></Modal>}
    </Page>
  );
}
