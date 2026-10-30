import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { Page, Table } from '../components/ui';

export default function CashBank() {
  const [rows, setRows] = useState<any[]>([]); const [tb, setTb] = useState<any>(null);
  useEffect(() => { api('/accounting/cash-bank').then(setRows); api('/accounting/trial-balance').then(setTb); }, []);
  const total = rows.reduce((s, r) => s + r.balance, 0);
  return (
    <Page title="Cash / Bank Balances">
      <Table rows={rows} cols={[{ h: 'Code', render: (r) => <span className="num">{r.code}</span> }, { h: 'Account', render: (r) => r.name }, { h: 'Balance', right: true, render: (r) => money(r.balance) }]} />
      <div className="text-right num mt-2 mb-8">Total: <b>{money(total)}</b></div>
      {tb && <><h3 className="font-bold mb-2">Trial balance</h3>
        <Table rows={tb.rows.map((r: any, i: number) => ({ id: i, ...r }))} cols={[{ h: 'Code', render: (r: any) => <span className="num">{r.code}</span> }, { h: 'Account', render: (r: any) => r.name }, { h: 'Type', render: (r: any) => r.type },
          { h: 'Debit', right: true, render: (r: any) => (r.debit ? money(r.debit) : '') }, { h: 'Credit', right: true, render: (r: any) => (r.credit ? money(r.credit) : '') }]} />
        <div className="text-right num mt-2">Dr {money(tb.debit)} · Cr {money(tb.credit)} {tb.debit === tb.credit ? '✓ balanced' : '✗ OUT OF BALANCE'}</div></>}
    </Page>
  );
}
