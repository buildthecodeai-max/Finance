import { useState } from 'react';
import { api, money } from '../api';
import { Page, Table } from '../components/ui';
import { today, useAccounts } from '../lookup';

export default function Ledger() {
  const accounts = useAccounts([]);
  const [id, setId] = useState(''); const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`); const [to, setTo] = useState(today());
  const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  const run = async () => { try { setErr(''); setD(await api(`/accounting/ledger?account_id=${id}&from=${from}&to=${to}`)); } catch (e: any) { setErr(e.message); } };
  const bal = (n: number) => `${money(Math.abs(n))} ${n < 0 ? 'Cr' : 'Dr'}`;
  return (
    <Page title="Ledger">
      <div className="card flex flex-wrap gap-3 items-end mb-4">
        <div className="min-w-72"><div className="text-xs text-muted mb-1">Account</div><select className="input" value={id} onChange={(e) => setId(e.target.value)}><option value="">Select…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></div>
        <div><div className="text-xs text-muted mb-1">From</div><input className="input num" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><div className="text-xs text-muted mb-1">To</div><input className="input num" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <button className="btn" disabled={!id} onClick={run}>Show</button>
      </div>
      {err && <div className="text-danger text-sm mb-3">{err}</div>}
      {d && <><h3 className="font-bold mb-2">{d.account.code} — {d.account.name}</h3>
        <Table rows={[{ id: -1, narration: 'Opening balance', balance: d.opening } as any, ...d.rows]} cols={[
          { h: 'Date', render: (r: any) => <span className="num">{r.entry_date}</span> }, { h: 'Voucher', render: (r: any) => r.voucher_no }, { h: 'Narration', render: (r: any) => r.narration },
          { h: 'Debit', right: true, render: (r: any) => (r.debit ? money(r.debit) : '') }, { h: 'Credit', right: true, render: (r: any) => (r.credit ? money(r.credit) : '') }, { h: 'Balance', right: true, render: (r: any) => bal(r.balance) }]} />
        <div className="text-right mt-2 num">Closing: <b>{bal(d.closing)}</b></div></>}
    </Page>
  );
}
