import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { Page, Table } from '../components/ui';
import { today, useList } from '../lookup';

export default function Statements() {
  const [kind, setKind] = useState<'client' | 'supplier'>('client'); const list = useList(kind === 'client' ? '/clients' : '/suppliers');
  const [id, setId] = useState(''); const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`); const [to, setTo] = useState(today()); const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { setId(''); setD(null); }, [kind]);
  const run = async () => { try { setErr(''); setD(await api(`/finance/statements/${kind}/${id}?from=${from}&to=${to}`)); } catch (e: any) { setErr(e.message); } };
  return (
    <Page title="Statements" description="The party's ledger account in base currency, plus what is still open.">
      <div className="card flex flex-wrap gap-3 items-end mb-4">
        <div><div className="text-xs text-muted mb-1">Type</div><select className="input" value={kind} onChange={(e) => setKind(e.target.value as any)}><option value="client">Client</option><option value="supplier">Supplier</option></select></div>
        <div className="min-w-60"><div className="text-xs text-muted mb-1">{kind === 'client' ? 'Client' : 'Supplier'}</div><select className="input" value={id} onChange={(e) => setId(e.target.value)}><option value="">Select…</option>{list.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div><div className="text-xs text-muted mb-1">From</div><input className="input num" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><div className="text-xs text-muted mb-1">To</div><input className="input num" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <button className="btn" disabled={!id} onClick={run}>Show</button></div>
      {err && <div className="text-danger text-sm mb-3">{err}</div>}
      {d && <><h3 className="font-semibold mb-2">{d.party.name}</h3>
        <Table rows={[{ id: -1, narration: 'Opening balance', balance: d.opening } as any, ...d.rows]} cols={[
          { h: 'Date', render: (r: any) => <span className="num">{r.entry_date}</span> }, { h: 'Document', render: (r: any) => r.voucher_no }, { h: 'Narration', render: (r: any) => r.narration },
          { h: 'Debit', right: true, render: (r: any) => (r.debit ? money(r.debit) : '') }, { h: 'Credit', right: true, render: (r: any) => (r.credit ? money(r.credit) : '') }, { h: 'Balance', right: true, render: (r: any) => money(r.balance) }]} />
        <div className="text-right num mt-2 mb-6">Closing balance <b>{money(d.closing)}</b></div>
        {d.open.length > 0 && <><h3 className="font-semibold mb-2">Open items</h3><Table rows={d.open} cols={[{ h: 'Document', render: (o: any) => <span className="num">{o.ref}</span> }, { h: 'Due', render: (o: any) => <span className="num">{o.due_date}</span> }, { h: 'Outstanding', right: true, render: (o: any) => money(o.outstanding, o.currency) }]} /></>}</>}
    </Page>
  );
}
