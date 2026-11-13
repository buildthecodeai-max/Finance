import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Plus, Search, X } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Pill, Skeleton, Table } from '../components/ui';
import { isoDate, today, useCleared, useOpenOnNew } from '../lookup';

const METHODS = ['bank_transfer', 'cash', 'direct_debit', 'stripe'];
const METHOD_LABEL: Record<string, string> = { bank_transfer: 'Bank transfer', cash: 'Cash', direct_debit: 'Direct debit', stripe: 'Card (Stripe)' };
const PAYABLE = ['sent', 'partially_paid', 'overdue'];
const r2 = (n: number) => Math.round(n * 100) / 100;
const owed = (i: any) => r2(i.total - i.amount_credited - i.amount_paid);
const base$ = (p: any) => (Number(p.amount) || 0) * (Number(p.fx_rate) || 1);
const day = (d: any) => String(d).slice(0, 10);
const newKey = () => (crypto as any).randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

const monthStart = () => today().slice(0, 7) + '-01';
const daysAgo = (n: number) => isoDate(new Date(Date.now() - n * 864e5));
const PERIODS: { key: string; label: string; from: () => string }[] = [
  { key: 'all', label: 'All time', from: () => '' },
  { key: 'month', label: 'This month', from: monthStart },
  { key: '30', label: 'Last 30 days', from: () => daysAgo(30) },
  { key: 'year', label: 'This year', from: () => today().slice(0, 4) + '-01-01' },
];
const TABS: { key: string; label: string; test: (p: any) => boolean }[] = [
  { key: 'all', label: 'All', test: (p) => !p.voided },
  { key: 'pending', label: 'To reconcile', test: (p) => !p.voided && !p.reconciled },
  { key: 'reconciled', label: 'Reconciled', test: (p) => !p.voided && !!p.reconciled },
  { key: 'voided', label: 'Voided', test: (p) => !!p.voided },
];

/** Record money received against one invoice. For one payment across several invoices, Client receipts is the better tool. */
function RecordPayment({ preInvoice, onClose, onDone }: { preInvoice?: number; onClose(): void; onDone(text: string): void }) {
  const [invoices, setInvoices] = useState<any[] | null>(null);
  const [text, setText] = useState(''); const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | ''>(''); const [method, setMethod] = useState('bank_transfer'); const [date, setDate] = useState(today()); const [reference, setReference] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [key] = useState(newKey);

  useEffect(() => { api('/invoices').then((rows: any[]) => setInvoices(rows.filter((i) => PAYABLE.includes(i.status) && owed(i) > 0.005))).catch((e) => { setErr(e.message); setInvoices([]); }); }, []);
  const label = (i: any) => `${i.number} — ${i.client_name} — ${money(owed(i), i.currency)} due`;
  const picked = invoices?.find((i) => i.id === invoiceId) ?? null;
  const choose = (i: any | null) => { setInvoiceId(i?.id ?? null); setText(i ? label(i) : ''); setAmount(i ? owed(i) : ''); };
  useEffect(() => { if (preInvoice && invoices && invoiceId === null) { const i = invoices.find((x) => x.id === preInvoice); if (i) choose(i); } }, [invoices]);
  const onText = (v: string) => {
    setText(v); const hit = invoices?.find((i) => label(i) === v);
    if (hit) { setInvoiceId(hit.id); setAmount(owed(hit)); } else setInvoiceId(null);
  };
  const due = picked ? owed(picked) : 0, amt = Number(amount) || 0, after = r2(due - amt), over = !!picked && amt > due + 0.005;
  const problem = !picked ? 'Choose an invoice.' : !amt ? 'Enter the amount received.' : over ? `That is ${money(r2(amt - due), picked.currency)} more than the invoice balance.` : '';

  const save = async () => {
    if (problem || !picked) return;
    setBusy(true); setErr('');
    try {
      await api('/payments/inbound', 'POST', { invoice_id: picked.id, amount: amt, method, paid_at: date, reference: reference.trim() || undefined }, { 'Idempotency-Key': key });
      onDone(`Recorded ${money(amt, picked.currency)} from ${picked.client_name} against ${picked.number}${after <= 0.005 ? ' — the invoice is now fully paid.' : ` — ${money(after, picked.currency)} still due.`}`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal title="Record a client payment" onClose={onClose}>
      <Err e={err} />
      <Field label="Which invoice is being paid?" hint={invoices && !invoices.length ? 'There are no sent invoices waiting for payment.' : 'Type an invoice number or client name, then pick from the list.'}>
        <input className="input" list="pay-invoices" placeholder={invoices ? 'Start typing…' : 'Loading invoices…'} value={text} onChange={(e) => onText(e.target.value)} autoFocus />
        <datalist id="pay-invoices">{invoices?.map((i) => <option key={i.id} value={label(i)} />)}</datalist>
      </Field>
      {picked && (
        <div className="rounded-lg border border-line bg-surface2/50 px-3 py-2 mb-3 text-sm grid grid-cols-3 gap-2 num">
          <div><div className="text-xs text-muted">Invoice total</div>{money(picked.total, picked.currency)}</div>
          <div><div className="text-xs text-muted">Already paid</div>{money(picked.amount_paid + picked.amount_credited, picked.currency)}</div>
          <div><div className="text-xs text-muted">Balance due</div><b>{money(due, picked.currency)}</b></div></div>)}
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label={`Amount received${picked ? ` (${picked.currency})` : ''}`}>
          <div className="flex gap-2"><Num v={amount} set={setAmount} min={0} aria-label="Amount received" />
            {picked && <button type="button" className="btn-ghost whitespace-nowrap" onClick={() => setAmount(due)} disabled={amt === due}>Full balance</button>}</div></Field>
        <Field label="Date received"><input className="input num" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Paid by"><select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></Field>
        <Field label="Reference (optional)" hint="Bank reference, cheque number…"><input className="input" value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} /></Field></div>
      {picked && amt > 0 && !over && (
        <p className="text-sm mb-3 num text-muted">{after <= 0.005 ? <span className="text-success">This clears the invoice — it will be marked paid.</span> : <>After this payment, <b className="text-fg">{money(after, picked.currency)}</b> will still be due.</>}</p>)}
      {over && <p role="alert" className="text-sm text-danger mb-3">{problem} To keep the extra as client credit, use <Link to="/client-receipts" className="underline">Client receipts</Link>.</p>}
      <div className="flex items-center justify-between gap-3 mt-2">
        <Link to="/client-receipts" className="text-xs text-muted underline">Paying several invoices at once? Use Client receipts</Link>
        <button className="btn" disabled={busy || !!problem} onClick={save}>{busy ? 'Saving…' : 'Record payment'}</button></div>
    </Modal>
  );
}

export default function Payments() {
  const { can, agency } = useAuth(); const [sp, setSp] = useSearchParams();
  const finance = can('admin', 'finance_manager'); const baseCur = agency?.base_currency ?? 'USD';
  const [rows, setRows] = useState<any[] | null>(null); const [loadErr, setLoadErr] = useState('');
  const [tab, setTab] = useState('all'); const [period, setPeriod] = useState('all'); const [method, setMethod] = useState(''); const [q, setQ] = useState('');
  const [recording, setRecording] = useState(false); const [preInvoice, setPreInvoice] = useState<number | undefined>(); const [note, setNote] = useState('');
  const load = () => api('/payments?direction=inbound').then((r) => { setRows(r); setLoadErr(''); }).catch((e) => { setLoadErr(e.message); setRows([]); });
  useEffect(() => { load(); }, []);
  useOpenOnNew(() => { if (finance) setRecording(true); });
  useEffect(() => { const inv = Number(sp.get('invoice')); if (inv && finance) { setPreInvoice(inv); setRecording(true); sp.delete('invoice'); setSp(sp, { replace: true }); } }, [sp]);

  const cl = useCleared(`cleared-void-payments-${agency?.id}`);
  const all = (rows ?? []).filter((p) => !(p.voided && cl.ids.has(p.id)));
  const from = PERIODS.find((p) => p.key === period)!.from();
  const inPeriod = useMemo(() => all.filter((p) => (!from || day(p.paid_at) >= from) && (!method || p.method === method)), [all, from, method]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, inPeriod.filter(t.test).length])), [inPeriod]);
  const shown = useMemo(() => {
    const t = TABS.find((x) => x.key === tab)!, s = q.trim().toLowerCase();
    return inPeriod.filter(t.test).filter((p) => !s || [p.client_name, p.invoice_number, p.reference, p.method].some((v) => String(v ?? '').toLowerCase().includes(s)));
  }, [inPeriod, tab, q]);

  const sum = (list: any[]) => r2(list.reduce((s, p) => s + base$(p), 0));
  const live = all.filter((p) => !p.voided);
  const thisMonth = live.filter((p) => day(p.paid_at) >= monthStart());
  const pending = live.filter((p) => !p.reconciled);
  const shownTotal = sum(shown.filter((p) => !p.voided));

  const csv = () => {
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Date', 'Client', 'Invoice', 'Method', 'Reference', 'Currency', 'Amount', 'Reconciled', 'Voided'].join(',')].concat(
      shown.map((p) => [day(p.paid_at), p.client_name, p.invoice_number, METHOD_LABEL[p.method] ?? p.method, p.reference, p.currency, p.amount, p.reconciled ? 'yes' : 'no', p.voided ? 'yes' : 'no'].map(esc).join(',')));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = `client-payments-${today()}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  const stat = (key: string | null, title: string, value: string, sub: string, tone = '') => (
    <button type="button" disabled={!key} onClick={() => key && (setPeriod('all'), setMethod(''), setTab(key))} className={`card text-left ${key ? 'hover:bg-surface2/70 transition-colors' : 'cursor-default'} ${key && tab === key ? 'ring-1 ring-accent' : ''}`}>
      <div className="text-xs text-muted">{title}</div><div className={`text-xl font-semibold num mt-0.5 ${tone}`}>{value}</div><div className="text-xs text-muted mt-0.5">{sub}</div></button>);

  const filtered = !!q || !!method || period !== 'all';
  return (
    <Page title="Payments" description="Money received from clients. To record one payment across several invoices, or to keep extra as client credit, use Client receipts."
      actions={<>{finance && <Link to="/client-receipts" className="btn-ghost">Client receipts</Link>}{finance && <Link to="/payment-runs" className="btn-ghost">Supplier payment runs →</Link>}
        {finance && <button className="btn inline-flex items-center gap-1" onClick={() => { setPreInvoice(undefined); setRecording(true); }}><Plus size={16} />Record payment</button>}</>}>
      <Err e={loadErr} />
      {rows === null ? <div className="grid sm:grid-cols-3 gap-3 mb-4"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div> : (
        <div className="grid sm:grid-cols-3 gap-3 mb-4">
          {stat(null, 'Received this month', money(sum(thisMonth), baseCur), `${thisMonth.length} payment${thisMonth.length === 1 ? '' : 's'}`)}
          {stat('pending', 'Not yet reconciled', money(sum(pending), baseCur), pending.length ? `${pending.length} payment${pending.length === 1 ? '' : 's'} to match with the bank` : 'Everything is matched', pending.length ? 'text-warn' : '')}
          {tab === 'voided' ? stat(null, 'Voided payments', money(sum(shown), baseCur), `${shown.length} reversed — not counted in any total`)
            : stat(null, filtered ? 'In this view' : 'All payments shown', money(shownTotal, baseCur), `${shown.length} payment${shown.length === 1 ? '' : 's'}`)}
        </div>)}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1 basis-full min-w-0" role="tablist" aria-label="Payment views">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
              className={`whitespace-nowrap text-sm px-3 py-1.5 rounded-lg border ${tab === t.key ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>
              {t.label}{rows && t.key !== 'all' && <span className="ml-1.5 text-xs opacity-70 num">{counts[t.key]}</span>}</button>))}
        </div>
        <select className="input w-auto" aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
        <select className="input w-auto" aria-label="Payment method" value={method} onChange={(e) => setMethod(e.target.value)}><option value="">Any method</option>{METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select>
        <div className="relative w-full sm:w-56">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input className="input pl-8" placeholder="Client, invoice or reference…" aria-label="Search payments" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn-ghost inline-flex items-center gap-1" onClick={csv} disabled={!shown.length} title="Download the payments in this view"><Download size={14} />CSV</button>
      </div>

      {note && <div role="status" className="rounded-lg border border-success/30 bg-success/10 text-success text-sm px-3 py-2 mb-3 flex justify-between gap-3">
        <span>{note}</span><button className="opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={() => setNote('')}><X size={14} /></button></div>}

      {rows === null ? <Skeleton className="h-64" /> : (<>
{tab === 'voided' && (shown.length > 0 || cl.ids.size > 0) && <div className="flex flex-wrap items-center gap-2 mb-2 text-sm"><span className="text-muted">Voided records stay in the books and audit log; clearing only hides them here.</span>
          {shown.length > 0 && <button className="btn-ghost" onClick={() => cl.clear(shown.map((p) => p.id))}>Clear voided ({shown.length})</button>}{cl.ids.size > 0 && <button className="btn-ghost" onClick={cl.restore}>Show cleared</button>}</div>}
        <Table rows={shown}
          empty={all.length === 0 ? (finance ? 'No payments yet — click “Record payment” when a client pays an invoice.' : 'No payments yet.') : `No ${tab === 'all' ? '' : TABS.find((t) => t.key === tab)!.label.toLowerCase() + ' '}payments${filtered ? ' match these filters' : ''}.`}
          cols={[
            { h: 'Date', render: (r) => <span className={`num ${r.voided ? 'text-muted line-through' : ''}`}>{day(r.paid_at)}</span> },
            { h: 'Client', render: (r) => <span className={r.voided ? 'text-muted' : ''}>{r.client_name ?? '—'}</span> },
            { h: 'Invoice', render: (r) => (r.invoice_id ? <Link to={`/invoices?open=${r.invoice_id}`} className="num underline decoration-dotted hover:text-accent">{r.invoice_number}</Link> : <span className="text-muted" title="Held as client credit — not yet applied to an invoice">Client credit</span>) },
            { h: 'Method', render: (r) => <>{METHOD_LABEL[r.method] ?? r.method}{r.reference && <div className="text-xs text-muted truncate max-w-[12rem]" title={r.reference}>Ref {r.reference}</div>}</> },
            { h: 'Amount', right: true, render: (r) => <span className={r.voided ? 'text-muted line-through' : ''}>{money(r.amount, r.currency)}{r.currency !== baseCur && !r.voided && <div className="text-xs text-muted">≈ {money(base$(r), baseCur)}</div>}</span> },
            { h: 'Status', render: (r) => (r.voided ? <Pill s="voided" /> : r.reconciled ? <Pill s="reconciled" /> : <Pill s="pending" />) }]} />
      </>)}
      {rows && rows.length >= 500 && <p className="text-xs text-muted mt-2">Showing the latest 500 payments. Use Reports → Payment register for the full history.</p>}

      {recording && <RecordPayment preInvoice={preInvoice} onClose={() => setRecording(false)} onDone={(t) => { setRecording(false); setNote(t); load(); }} />}
    </Page>
  );
}
