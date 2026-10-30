import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Num, Page, Pill, Table } from '../components/ui';
import { today, useAccounts, useList, useOpenOnNew } from '../lookup';
import { printHtml } from './Vouchers';
import { Check, Plus, Printer, Save } from 'lucide-react';

const NUMF = (keys: [string, string][]) => keys;
const TAX_FIELDS = NUMF([['sp_yi', 'SP + YI'], ['rg_cvt', 'RG/CVT'], ['yq', 'YQ'], ['ced', 'CED'], ['pb_adv_yq', 'PB/Adv YQ'], ['xz', 'XZ'], ['yd', 'YD'], ['kb', 'KB'], ['xt_ur_us', 'XT/UR/US'], ['other_tax', 'Other Tax']]);
const blankLine = (): any => ({ mode: 'ticket', line_type: 'Normal', pax_type: 'Adult', fx_rate: 1, fare: '', fare_nc: '' });
const blankInv = (): any => ({ invoice_date: today(), status: 'tentative', active: true, lines: [blankLine()] });

function LineForm({ l, set, airlines, vendors, agents, calc, readOnly }: any) {
  const s = (k: string) => (e: any) => set({ ...l, [k]: e.target.value });
  const n = (k: string, label: string) => <Field label={label}><Num v={l[k]} set={(v) => set({ ...l, [k]: v })} disabled={readOnly} /></Field>;
  const txt = (k: string, label: string, type = 'text') => <Field label={label}><input className="input" type={type} value={l[k] ?? ''} onChange={s(k)} disabled={readOnly} /></Field>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-3">
        <Field label="Mode"><select className="input" value={l.mode ?? ''} onChange={s('mode')}>{['ticket', 'hotel', 'visa', 'umrah', 'other'].map((m) => <option key={m}>{m}</option>)}</select></Field>
        <Field label="Type"><select className="input" value={l.line_type ?? ''} onChange={s('line_type')}>{['Normal', 'Reissue', 'Void', 'EMD'].map((m) => <option key={m}>{m}</option>)}</select></Field>
        {txt('passport', 'Passport')}{txt('passenger_name', 'Passenger Name')}
        <Field label="Pax type"><select className="input" value={l.pax_type ?? ''} onChange={s('pax_type')}>{['Adult', 'Child', 'Infant'].map((m) => <option key={m}>{m}</option>)}</select></Field>
        {txt('nationality', 'Nationality')}{txt('phone_rt', 'Ph/RT')}{txt('group_no', 'Group No')}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-3">
        <Field label="Airline"><select className="input" value={l.airline_id ?? ''} onChange={(e) => { const a = airlines.find((x: any) => x.id === Number(e.target.value)); set({ ...l, airline_id: e.target.value ? Number(e.target.value) : null, payable_account_id: a?.account_id ?? l.payable_account_id, com_rec_pct: l.com_rec_pct || a?.commission_pct || '' }); }}>
          <option value="">—</option>{airlines.map((a: any) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
        <Field label="Payable Code *"><select className="input" value={l.payable_account_id ?? ''} onChange={(e) => set({ ...l, payable_account_id: e.target.value ? Number(e.target.value) : null })}><option value="">Select…</option>{vendors.map((a: any) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></Field>
        {txt('ticket_no', 'Ticket No')}{txt('con_ticket_no', 'Con Ticket No')}{txt('ticket_type', 'Ticket Type')}{txt('sector', 'Sec/Par')}{txt('route', 'Route')}{txt('gds', 'GDS')}
        {txt('dep_date', 'Dep. Date', 'date')}{txt('return_date', 'Return Date', 'date')}{txt('pnr', 'PNR #')}{txt('gds_pnr', 'GDS PNR #')}{txt('fare_class', 'Class')}{txt('xo', 'XO')}{txt('confirmation_no', 'Confirmation No')}{txt('currency', 'Currency')}
        {n('fx_rate', 'Rate')}
      </div>
      <div className="grid lg:grid-cols-3 gap-4">
        <fieldset className="card"><legend className="px-2 text-sm font-bold text-accent">Ticket Details</legend>
          <div className="grid grid-cols-2 gap-x-3">{n('fare', 'Fare *')}{n('fare_nc', 'Fare NC')}{TAX_FIELDS.map(([k, label]) => <div key={k}>{n(k, label)}</div>)}</div>
          <div className="num text-sm mt-2">Total taxes <b>{calc?.total_taxes?.toFixed(2) ?? '-'}</b> · Ticket <b className="text-warn">{calc?.ticket_total?.toFixed(2) ?? '-'}</b></div></fieldset>
        <fieldset className="card"><legend className="px-2 text-sm font-bold text-accent">Payable / Vendor</legend>
          <div className="grid grid-cols-2 gap-x-3">{n('com_rec_pct', 'Com Rec %')}{n('com_rec', 'Com Rec')}{n('com_paid_pct', 'Com Paid %')}{n('com_paid', 'Com Paid')}{n('wh_air', 'WH Air')}{n('insurance', 'Insurance')}{n('vat_paid', 'VAT Paid')}</div>
          <div className="num text-sm mt-2">Com Rec = <b>{calc?.com_rec?.toFixed(2) ?? '-'}</b> · WH Air = <b>{calc?.wh_air?.toFixed(2) ?? '-'}</b></div></fieldset>
        <fieldset className="card"><legend className="px-2 text-sm font-bold text-accent">Receivable / Customer</legend>
          <div className="grid grid-cols-2 gap-x-3">{n('psf', 'PSF')}{n('other_charges', 'Other')}{n('discount_pct', 'Discount %')}{n('discount', 'Discount')}{n('wh_client', 'WH Client')}{n('fare_inc', 'Fare Inc')}{n('taxes_inc', 'Taxes Inc')}{n('vat_pct', 'VAT %')}{n('vat', 'VAT')}</div>
          <Field label="Agent Code"><select className="input" value={l.agent_account_id ?? ''} onChange={(e) => set({ ...l, agent_account_id: e.target.value ? Number(e.target.value) : null })}><option value="">—</option>{agents.map((a: any) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></Field>
          {n('agent_amount', 'Agent Amount')}</fieldset>
      </div>
      <div className="grid grid-cols-3 gap-3 max-w-2xl">
        {[['Payable', calc?.payable_fc, 'bg-danger/15'], ['Receivable', calc?.receivable_fc, 'bg-success/15'], ['Profit', calc?.profit_fc, 'bg-success/15']].map(([k, v, c]: any) => (
          <div key={k} className={`rounded-lg px-3 py-2 ${c}`}><div className="text-xs text-muted">{k}{l.currency ? ` (${l.currency})` : ''}</div><div className="num text-lg">{typeof v === 'number' ? v.toFixed(2) : '-'}</div></div>))}
      </div>
    </div>
  );
}

export default function TicketInvoices() {
  const { can, agency } = useAuth(); const nav = useNavigate();
  const clients = useAccounts([120]); const vendors = useAccounts([210, 211]); const agents = useAccounts([123, 124, 210]);
  const airlines = useList('/airlines'); const branches = useList('/accounting/branches'); const depts = useList('/accounting/departments'); const staff = useList('/accounting/lookup?types=0');
  const [rows, setRows] = useState<any[]>([]); const [inv, setInv] = useState<any>(null); const [idx, setIdx] = useState(0); const [tab, setTab] = useState<'list' | 'details'>('details');
  const [calc, setCalc] = useState<any>(null); const [err, setErr] = useState(''); const [q, setQ] = useState('');
  const load = () => api(`/tickets/invoices${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(setRows);
  useOpenOnNew(() => { setInv(blankInv()); setIdx(0); setTab('details'); });
  useEffect(() => { load(); }, [q]);
  void staff;
  const writer = can('admin', 'finance_manager');
  const line = inv?.lines[idx];
  const timer = useRef<any>();
  useEffect(() => { // live recalculation of the active line
    if (!line) return; clearTimeout(timer.current);
    timer.current = setTimeout(() => api('/tickets/calc', 'POST', line).then(setCalc).catch(() => {}), 250);
    return () => clearTimeout(timer.current);
  }, [JSON.stringify(line)]);
  const open = async (id: number) => { setInv(await api(`/tickets/invoices/${id}`)); setIdx(0); setTab('details'); setErr(''); };
  const setLine = (l: any) => setInv({ ...inv, lines: inv.lines.map((x: any, i: number) => (i === idx ? l : x)) });
  const h = (k: string) => (e: any) => setInv({ ...inv, [k]: e.target.value });
  const readOnly = !!inv?.supervised && !writer;
  const save = async () => {
    try {
      const body = { ...inv, client_account_id: Number(inv.client_account_id), branch_id: inv.branch_id || null, department_id: inv.department_id || null, active: !!inv.active };
      const saved = inv.id ? await api(`/tickets/invoices/${inv.id}`, 'PUT', body) : await api('/tickets/invoices', 'POST', body);
      setInv(saved); setErr(''); load();
    } catch (e: any) { setErr(e.message); }
  };
  const act = async (path: string, method = 'POST') => { try { await api(path, method); if (method === 'DELETE') setInv(null); else await open(inv.id); load(); } catch (e: any) { setErr(e.message); } };
  const total = (k: string) => inv?.lines.reduce((s: number, l: any) => s + (l[k] ?? 0), 0) ?? 0;

  if (!inv) return (
    <Page title="Ticket Invoices" actions={<><input className="input w-56" placeholder="Search no. / client" value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn" onClick={() => { setInv(blankInv()); setIdx(0); setTab('details'); }}><Plus size={15} /> New invoice</button></>}>
      <Table rows={rows} onRow={(r) => open(r.id)} cols={[
        { h: 'Invoice', render: (r) => <span className="num">{r.invoice_no}</span> }, { h: 'Date', render: (r) => r.invoice_date }, { h: 'Client', render: (r) => r.client_name }, { h: 'Tickets', right: true, render: (r) => r.n_lines },
        { h: 'Status', render: (r) => <Pill s={r.status} /> }, { h: 'Receivable', right: true, render: (r) => money(r.receivable) }, { h: 'Profit', right: true, render: (r) => money(r.profit) }]} />
    </Page>
  );

  return (
    <Page title={inv.id ? `Ticket Invoice ${inv.invoice_no}` : 'New Ticket Invoice'} actions={<>
      <button className="btn-ghost" onClick={() => { setInv(null); load(); }}>← Close</button>
      <button className="btn" onClick={save} disabled={readOnly}><Save size={15} /> Save</button>
      {inv.id && writer && !inv.supervised && <button className="btn" onClick={() => act(`/tickets/invoices/${inv.id}/supervise`)}><Check size={15} /> Supervise (post)</button>}
      {inv.id && writer && inv.supervised && <button className="btn-ghost" onClick={() => act(`/tickets/invoices/${inv.id}/repost`)}>Re-Post</button>}
      {inv.id && <button className="btn-ghost" onClick={() => printHtml(`<html><body style="font-family:Arial"><h2>${agency?.name}</h2><h3>Invoice ${inv.invoice_no}</h3><p>${inv.client_name ?? ''} — ${inv.invoice_date}</p><table border=1 cellpadding=6 style="border-collapse:collapse"><tr><th>Passenger</th><th>Ticket</th><th>Route</th><th>Amount</th></tr>${inv.lines.map((l: any) => `<tr><td>${l.passenger_name ?? ''}</td><td>${l.ticket_no ?? ''}</td><td>${l.route ?? ''}</td><td align=right>${(l.receivable_fc ?? 0).toFixed(2)}</td></tr>`).join('')}</table><h3>Total ${total('receivable').toFixed(2)}</h3></body></html>`)}><Printer size={15} /> Print</button>}
      {inv.id && writer && <button className="btn-ghost text-danger" onClick={() => confirm('Delete invoice and its ledger entries?') && act(`/tickets/invoices/${inv.id}`, 'DELETE')}>Delete</button>}</>}>
      <Err e={err} />
      <div className="card grid grid-cols-2 lg:grid-cols-4 gap-x-4 mb-4">
        <Field label="Invoice ID"><input className="input num" value={inv.invoice_no ?? '(New)'} disabled /></Field>
        <Field label="Invoice Date *"><input className="input num" type="date" value={inv.invoice_date ?? ''} onChange={h('invoice_date')} disabled={readOnly} /></Field>
        <Field label="Due Date"><input className="input num" type="date" value={inv.due_date ?? ''} onChange={h('due_date')} /></Field>
        <Field label="Due Vendor"><input className="input num" type="date" value={inv.due_vendor ?? ''} onChange={h('due_vendor')} /></Field>
        <Field label="Client Code *"><select className="input" value={inv.client_account_id ?? ''} onChange={h('client_account_id')} disabled={readOnly}><option value="">Select…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></Field>
        <Field label="Branch"><select className="input" value={inv.branch_id ?? ''} onChange={h('branch_id')}><option value="">—</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="Department"><select className="input" value={inv.department_id ?? ''} onChange={h('department_id')}><option value="">—</option>{depts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="S.Tax Invoice No"><input className="input" value={inv.stax_invoice_no ?? ''} onChange={h('stax_invoice_no')} /></Field>
        <Field label="Ref #"><input className="input" value={inv.ref_no ?? ''} onChange={h('ref_no')} /></Field>
        <Field label="Payment Terms"><input className="input" value={inv.payment_terms ?? ''} onChange={h('payment_terms')} /></Field>
        <Field label="Umrah Query ID"><input className="input" value={inv.umrah_query_id ?? ''} onChange={h('umrah_query_id')} /></Field>
        <Field label="Ticket Query ID"><input className="input" value={inv.ticket_query_id ?? ''} onChange={h('ticket_query_id')} /></Field>
        <Field label="Remarks"><input className="input" value={inv.remarks ?? ''} onChange={h('remarks')} /></Field>
        <Field label="Status"><div className="pt-2"><Pill s={inv.status} /> {inv.supervised ? <span className="text-xs text-success">supervised</span> : ''}</div></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!inv.active} onChange={(e) => setInv({ ...inv, active: e.target.checked })} /> Active</label>
      </div>
      <div className="flex gap-2 mb-3">{(['list', 'details'] as const).map((t) => <button key={t} className={tab === t ? 'btn' : 'btn-ghost'} onClick={() => setTab(t)}>{t === 'list' ? 'List' : 'Details'}</button>)}
        <div className="flex-1" /><span className="text-sm text-muted self-center">{idx + 1} of {inv.lines.length}</span>
        <button className="btn-ghost" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>‹ Back</button><button className="btn-ghost" disabled={idx >= inv.lines.length - 1} onClick={() => setIdx(idx + 1)}>Next ›</button>
        <button className="btn-ghost" onClick={() => { setInv({ ...inv, lines: [...inv.lines, blankLine()] }); setIdx(inv.lines.length); setTab('details'); }}>New Rec</button>
        {inv.lines.length > 1 && <button className="btn-ghost" onClick={() => { setInv({ ...inv, lines: inv.lines.filter((_: any, i: number) => i !== idx) }); setIdx(Math.max(0, idx - 1)); }}>Delete Rec</button>}
        {line?.id && <button className="btn-ghost" onClick={() => nav(`/refunds?line=${line.id}`)}>Refund</button>}</div>
      {tab === 'list'
        ? <Table rows={inv.lines.map((l: any, i: number) => ({ id: i, ...l }))} onRow={(r: any) => { setIdx(r.id); setTab('details'); }} cols={[
          { h: 'Passenger', render: (r: any) => r.passenger_name }, { h: 'Ticket', render: (r: any) => r.ticket_no }, { h: 'Route', render: (r: any) => r.route },
          { h: 'Payable', right: true, render: (r: any) => (r.payable_fc ?? 0).toFixed(2) }, { h: 'Receivable', right: true, render: (r: any) => (r.receivable_fc ?? 0).toFixed(2) }, { h: 'Profit', right: true, render: (r: any) => (r.profit_fc ?? 0).toFixed(2) }]} />
        : line && <LineForm l={line} set={setLine} airlines={airlines} vendors={vendors} agents={agents} calc={calc} readOnly={readOnly} />}
    </Page>
  );
}
