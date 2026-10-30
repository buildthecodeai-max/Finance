import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money } from '../api';
import { Field, Page, Table } from '../components/ui';
import { Search } from 'lucide-react';

export default function TicketSearch() {
  const nav = useNavigate(); const [tab, setTab] = useState<'ticket' | 'confirmation'>('ticket');
  const [no, setNo] = useState(''); const [pax, setPax] = useState(''); const [conf, setConf] = useState(''); const [rows, setRows] = useState<any[]>([]); const [done, setDone] = useState(false);
  const find = async () => {
    const qs = tab === 'ticket' ? `ticket_no=${encodeURIComponent(no)}&passenger=${encodeURIComponent(pax)}` : `confirmation_no=${encodeURIComponent(conf)}`;
    setRows(await api(`/tickets/search?${qs}`)); setDone(true);
  };
  return (
    <Page title="Ticket Search">
      <div className="flex gap-2 mb-4">{(['ticket', 'confirmation'] as const).map((t) => <button key={t} className={tab === t ? 'btn' : 'btn-ghost'} onClick={() => { setTab(t); setRows([]); setDone(false); }}>{t === 'ticket' ? 'Ticket' : 'Confirmation'}</button>)}</div>
      <div className="card flex flex-wrap gap-4 items-end mb-4" onKeyDown={(e) => e.key === 'Enter' && find()}>
        {tab === 'ticket' ? <><Field label="Ticket No"><input className="input w-64" value={no} onChange={(e) => setNo(e.target.value)} autoFocus /></Field><Field label="Passenger"><input className="input w-64" value={pax} onChange={(e) => setPax(e.target.value)} /></Field></>
          : <Field label="Confirmation No"><input className="input w-64" value={conf} onChange={(e) => setConf(e.target.value)} autoFocus /></Field>}
        <button className="btn mb-3" onClick={find}><Search size={15} /> Find</button></div>
      {done && <Table rows={rows} cols={[
        { h: 'T-ID', render: (r) => <span className="num">{r.id}</span> }, { h: 'Invoice', render: (r) => <a className="text-accent cursor-pointer" onClick={() => nav('/ticket-invoices')}>{r.invoice_no}</a> }, { h: 'Ticket', render: (r) => r.ticket_no },
        { h: 'Passenger', render: (r) => r.passenger_name }, { h: 'Sector', render: (r) => r.sector ?? r.route }, { h: 'Amount', right: true, render: (r) => money(r.receivable) },
        { h: 'Refund', render: (r) => (r.refunded ? <span className="text-muted">Refunded</span> : <a className="text-accent underline cursor-pointer" onClick={() => nav(`/refunds?line=${r.id}`)}>Refund</a>) }]} />}
    </Page>
  );
}
