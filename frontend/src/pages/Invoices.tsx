import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Copy, Pencil, Plus, Search, X } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Page, Pill, Skeleton, Table } from '../components/ui';
import { today, useOpenOnNew } from '../lookup';
import { viewPdf } from '../components/PdfViewer';

const TYPES = ['flight', 'hotel', 'package', 'cruise', 'transfer', 'other'];
const PAYABLE = ['sent', 'partially_paid', 'overdue'];
const blank = () => ({ product_type: 'flight', supplier_id: '' as string | number, description: '', quantity: 1, unit_cost: 0, markup_pct: 10, tax_rate: 10 });
const r2 = (n: number) => Math.round(n * 100) / 100;
const balance = (r: any) => r2(r.total - r.amount_credited - r.amount_paid);
/** Whole days past the due date for an invoice that is still waiting to be paid (0 when not late). */
const daysLate = (r: any) => (PAYABLE.includes(r.status) && balance(r) > 0.005 ? Math.max(0, Math.floor((Date.parse(today()) - Date.parse(String(r.due_date).slice(0, 10))) / 864e5)) : 0);
const shownStatus = (r: any) => (daysLate(r) > 0 ? 'overdue' : r.status);

/** The six views people actually think in, rather than eight raw status codes. */
const TABS: { key: string; label: string; test: (r: any) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'draft', label: 'Drafts', test: (r) => r.status === 'draft' },
  { key: 'ready', label: 'Ready to send', test: (r) => r.status === 'reviewed' },
  { key: 'unpaid', label: 'Unpaid', test: (r) => PAYABLE.includes(r.status) && balance(r) > 0.005 },
  { key: 'overdue', label: 'Overdue', test: (r) => daysLate(r) > 0 },
  { key: 'paid', label: 'Paid', test: (r) => r.status === 'paid' },
  { key: 'closed', label: 'Void / credited', test: (r) => r.status === 'void' || r.status === 'credited' },
];

interface Initial { id?: number; client_id: number | string; booking_id?: number | string | null; currency: string; issue_date: string; due_date?: string; notes?: string; lines: any[]; installments: any[]; fresh?: boolean }

function InvoiceForm({ initial, onDone, onSaved }: { initial?: Initial; onDone(): void; onSaved(id: number): void }) {
  const { agency } = useAuth();
  const editing = !!initial?.id;
  const [clients, setClients] = useState<any[]>([]); const [suppliers, setSuppliers] = useState<any[]>([]); const [bookings, setBookings] = useState<any[]>([]);
  const [client_id, setClient] = useState(String(initial?.client_id ?? '')); const [clientText, setClientText] = useState('');
  const [currency, setCur] = useState(initial?.currency ?? agency!.base_currency);
  const [issue_date, setIssue] = useState(String(initial?.issue_date ?? today()).slice(0, 10)); const [due_date, setDue] = useState(String(initial?.due_date ?? '').slice(0, 10));
  const [booking_id, setBooking] = useState(String(initial?.booking_id ?? '')); const [notes, setNotes] = useState(initial?.notes ?? '');
  const [lines, setLines] = useState<any[]>(initial?.lines?.length ? initial.lines : [blank()]);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api('/clients').then(setClients); api('/suppliers').then(setSuppliers); api('/bookings').then(setBookings).catch(() => {}); }, []);

  const label = (c: any) => (clients.filter((x) => x.name.toLowerCase() === c.name.toLowerCase()).length > 1 ? `${c.name} (#${c.id})` : c.name);
  useEffect(() => { const c = clients.find((x) => String(x.id) === client_id); if (c && label(c) !== clientText) setClientText(label(c)); }, [client_id, clients]);
  const chooseClient = (text: string) => {
    setClientText(text);
    const c = clients.find((x) => label(x).toLowerCase() === text.trim().toLowerCase());
    setClient(c ? String(c.id) : ''); setBooking('');
  };
  const client = clients.find((c) => String(c.id) === client_id);
  const clientBookings = bookings.filter((b) => String(b.client_id) === client_id);

  const set = (i: number, k: string, v: any) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const net = (l: any) => l.quantity * l.unit_cost * (1 + l.markup_pct / 100);
  const sub = lines.reduce((s, l) => s + net(l), 0), tax = lines.reduce((s, l) => s + net(l) * (l.tax_rate / 100), 0);
  const cost = lines.reduce((s, l) => s + l.quantity * l.unit_cost, 0);
  const missing = !client_id ? 'Choose a client' : lines.some((l) => !l.description.trim()) ? 'Give every line a description' : '';

  const save = async () => {
    try {
      setBusy(true); setErr('');
      const body = {
        client_id: Number(client_id), booking_id: booking_id ? Number(booking_id) : null, currency, issue_date, ...(due_date ? { due_date } : {}), notes: notes.trim() || undefined,
        lines: lines.map((l) => ({ product_type: l.product_type, description: l.description, quantity: l.quantity, unit_cost: l.unit_cost, markup_pct: l.markup_pct, tax_rate: l.tax_rate, supplier_id: l.supplier_id ? Number(l.supplier_id) : null })),
        installments: (initial?.installments ?? []).map((i: any) => ({ label: i.label, due_date: String(i.due_date).slice(0, 10), amount: Number(i.amount) })),
      };
      const r = editing ? await api(`/invoices/${initial!.id}`, 'PUT', body) : await api('/invoices', 'POST', body);
      onSaved(r.inv.id);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const cell = 'lg:grid-cols-[6.5rem_9rem_minmax(0,1fr)_4.5rem_6.5rem_5rem_5rem_6.5rem_2rem]';
  const L = ({ t }: { t: string }) => <span className="lg:hidden block text-[11px] text-muted mb-0.5">{t}</span>;
  return (
    <Modal title={editing ? 'Edit invoice' : initial && !initial.fresh ? 'New invoice (copy)' : 'New invoice'} onClose={onDone} wide>
      <Err e={err} />
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-3">
        <Field label="Client" hint={client ? `Terms: ${client.payment_terms_days ?? 14} days${client.currency && client.currency !== currency ? ` · usually pays in ${client.currency}` : ''}` : 'Start typing to search your clients'}>
          <input className="input" list="inv-clients" placeholder="Choose a client…" value={clientText} onChange={(e) => chooseClient(e.target.value)} />
          <datalist id="inv-clients">{clients.map((c) => <option key={c.id} value={label(c)} />)}</datalist></Field>
        <Field label="Issue date"><input className="input num" type="date" value={issue_date} onChange={(e) => setIssue(e.target.value)} /></Field>
        <Field label="Due date" hint="Leave blank to use the client’s payment terms"><input className="input num" type="date" value={due_date} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Currency"><input className="input" value={currency} maxLength={3} onChange={(e) => setCur(e.target.value.toUpperCase())} /></Field>
      </div>
      {client_id && clientBookings.length > 0 && (
        <Field label="Booking (optional)" hint="Links this invoice to the trip it bills for"><select className="input" value={booking_id} onChange={(e) => setBooking(e.target.value)}>
          <option value="">Not linked to a booking</option>{clientBookings.map((b) => <option key={b.id} value={b.id}>{b.reference}{b.destination ? ` — ${b.destination}` : ''}</option>)}</select></Field>
      )}

      <div className="text-xs font-semibold text-muted uppercase tracking-wide mt-1 mb-2">What you’re charging for</div>
      <div className={`hidden lg:grid ${cell} gap-2 text-[11px] text-muted mb-1 px-0.5`}>
        <span>Type</span><span>Supplier</span><span>Description</span><span className="text-right">Qty</span><span className="text-right">Supplier cost</span><span className="text-right">Markup %</span><span className="text-right">{agency!.tax_label} %</span><span className="text-right">Line total</span><span />
      </div>
      {lines.map((l, i) => (
        <div key={i} className={`grid grid-cols-2 ${cell} gap-2 mb-3 lg:mb-2 pb-3 lg:pb-0 border-b border-line/50 lg:border-0 items-end`}>
          <div><L t="Type" /><select className="input capitalize" value={l.product_type} onChange={(e) => set(i, 'product_type', e.target.value)}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
          <div><L t="Supplier" /><select className="input" value={l.supplier_id} onChange={(e) => set(i, 'supplier_id', e.target.value)}><option value="">No supplier</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          <div className="col-span-2 lg:col-span-1"><L t="Description" /><input className="input" placeholder="e.g. Return flights London – Dubai" value={l.description} onChange={(e) => set(i, 'description', e.target.value)} /></div>
          <div><L t="Qty" /><input className="input num" type="number" min={0} step="any" value={l.quantity} onChange={(e) => set(i, 'quantity', +e.target.value)} /></div>
          <div><L t="Supplier cost" /><input className="input num" type="number" min={0} step="any" value={l.unit_cost} onChange={(e) => set(i, 'unit_cost', +e.target.value)} /></div>
          <div><L t="Markup %" /><input className="input num" type="number" min={0} step="any" value={l.markup_pct} onChange={(e) => set(i, 'markup_pct', +e.target.value)} /></div>
          <div><L t={`${agency!.tax_label} %`} /><input className="input num" type="number" min={0} step="any" value={l.tax_rate} onChange={(e) => set(i, 'tax_rate', +e.target.value)} /></div>
          <div className="num col-span-2 lg:col-span-1 lg:text-right lg:py-2 font-medium"><L t="Line total" />{money(net(l), currency)}</div>
          <div className="text-right col-span-2 lg:col-span-1"><button type="button" className="btn-ghost !px-1.5" title="Remove this line" aria-label="Remove this line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}><X size={15} /></button></div>
        </div>))}
      <button type="button" className="btn-ghost mb-4 inline-flex items-center gap-1" onClick={() => setLines([...lines, blank()])}><Plus size={15} />Add another line</button>

      <Field label="Notes for the client (optional)"><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Shown on the invoice, e.g. payment instructions or booking reference" /></Field>
      {!!initial?.installments?.length && <p className="text-xs text-muted mb-2">This invoice has {initial.installments.length} payment instalment{initial.installments.length > 1 ? 's' : ''}; they are kept as they are.</p>}

      <div className="rounded-lg bg-surface2 px-4 py-3 text-sm space-y-1">
        <div className="flex justify-between"><span className="text-muted">Subtotal</span><span className="num">{money(sub, currency)}</span></div>
        <div className="flex justify-between"><span className="text-muted">{agency!.tax_label}</span><span className="num">{money(tax, currency)}</span></div>
        <div className="flex justify-between font-semibold text-base"><span>Total</span><span className="num">{money(sub + tax, currency)}</span></div>
        <div className="flex justify-between text-xs text-muted pt-1 border-t border-line/50"><span>Your margin on this invoice</span><span className="num">{money(sub - cost, currency)}{sub > 0 && ` · ${(((sub - cost) / sub) * 100).toFixed(1)}%`}</span></div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 mt-4">
        {missing && <span className="text-xs text-muted mr-auto">{missing} to continue.</span>}
        <button className="btn-ghost" onClick={onDone}>Cancel</button>
        <button className="btn" onClick={save} disabled={!!missing || busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Save as draft'}</button>
      </div>
    </Modal>
  );
}

function InvoiceDetail({ id, clientName, onClose, onChange, onEdit, onCopy }: { id: number; clientName?: string; onClose(): void; onChange(): void; onEdit(i: Initial): void; onCopy(i: Initial): void }) {
  const { can, agency, user } = useAuth(); const nav = useNavigate(); const finance = can('admin', 'finance_manager'); const editor = can('admin', 'finance_manager', 'agent');
  const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [ok, setOk] = useState(''); const [voiding, setVoiding] = useState(false); const [busy, setBusy] = useState(false);
  const load = () => api(`/invoices/${id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (!d) return err ? <Modal title="Invoice" onClose={onClose}><Err e={err} /></Modal> : null;
  const { inv, lines, payments, credit_notes, installments } = d, cur = inv.currency;
  const outstanding = r2(inv.total - inv.amount_credited - inv.amount_paid), issued = !!inv.voucher_id, late = daysLate(inv);
  const canEdit = ['draft', 'reviewed'].includes(inv.status) && (finance || (editor && inv.status === 'draft' && inv.created_by === user?.id));
  const run = async (fn: () => Promise<any>, done = '') => { try { setBusy(true); setOk(''); await fn(); setErr(''); await load(); onChange(); if (done) setOk(done); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const initial = (): Initial => ({ client_id: inv.client_id, booking_id: inv.booking_id, currency: cur, issue_date: inv.issue_date, due_date: inv.due_date, notes: inv.notes ?? '', installments,
    lines: lines.map((l: any) => ({ product_type: l.product_type, supplier_id: l.supplier_id ?? '', description: l.description, quantity: Number(l.quantity), unit_cost: Number(l.unit_cost), markup_pct: Number(l.markup_pct), tax_rate: Number(l.tax_rate) })) });
  return (
    <Modal title={`Invoice ${inv.number}`} onClose={onClose} wide>
      <Err e={err} />
      {ok && <div role="status" className="rounded-lg border border-success/30 bg-success/10 text-success text-sm px-3 py-2 mb-3">{ok}</div>}
      {late > 0 && <div className="rounded-lg border border-danger/30 bg-danger/10 text-danger text-sm px-3 py-2 mb-3">This invoice is {late} day{late > 1 ? 's' : ''} overdue — {money(outstanding, cur)} is still owed.</div>}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm mb-4"><Pill s={shownStatus(inv)} />
        {clientName && <div><span className="text-muted">Client</span> <b>{clientName}</b></div>}
        <div><span className="text-muted">Issued</span> <span className="num">{String(inv.issue_date).slice(0, 10)}</span></div><div><span className="text-muted">Due</span> <span className="num">{String(inv.due_date).slice(0, 10)}</span></div>
        <div><span className="text-muted">Ledger</span> {issued ? <span className="text-success">posted &amp; locked</span> : <span className="text-warn">not issued yet</span>}</div>
        {cur !== agency?.base_currency && <div><span className="text-muted">Rate</span> <span className="num">{inv.fx_rate}</span></div>}</div>
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2"><Table rows={lines} cols={[{ h: 'Description', render: (l: any) => <><span className="capitalize text-muted">{l.product_type}</span> — {l.description}</> }, { h: 'Qty', right: true, render: (l: any) => l.quantity }, { h: 'Amount', right: true, render: (l: any) => money(l.line_net, cur) }, { h: agency?.tax_label ?? 'Tax', right: true, render: (l: any) => money(l.line_tax, cur) }]} />
          {inv.notes && <p className="text-sm text-muted mt-3 whitespace-pre-wrap"><b className="text-fg">Notes:</b> {inv.notes}</p>}</div>
        <div className="card text-sm space-y-1.5 h-fit"><div className="flex justify-between"><span className="text-muted">Subtotal</span><span className="num">{money(inv.subtotal, cur)}</span></div><div className="flex justify-between"><span className="text-muted">{agency?.tax_label}</span><span className="num">{money(inv.tax_total, cur)}</span></div>
          <div className="flex justify-between font-semibold"><span>Total</span><span className="num">{money(inv.total, cur)}</span></div>
          {inv.amount_credited > 0 && <div className="flex justify-between"><span className="text-muted">Credited</span><span className="num">− {money(inv.amount_credited, cur)}</span></div>}
          <div className="flex justify-between"><span className="text-muted">Paid</span><span className="num">− {money(inv.amount_paid, cur)}</span></div>
          <div className={`flex justify-between rounded-lg px-3 py-2 font-semibold ${outstanding > 0.005 ? 'bg-warn/10 text-warn' : 'bg-success/10 text-success'}`}><span>{outstanding < -0.005 ? 'Client credit' : outstanding > 0.005 ? 'Balance due' : 'Settled'}</span><span className="num">{money(Math.abs(outstanding), cur)}</span></div></div></div>
      {installments.length > 0 && <div className="mt-4"><h4 className="font-semibold text-sm mb-2">Payment instalments</h4><Table rows={installments} cols={[{ h: 'Instalment', render: (i: any) => i.label }, { h: 'Due', render: (i: any) => <span className="num">{String(i.due_date).slice(0, 10)}</span> }, { h: 'Amount', right: true, render: (i: any) => money(i.amount, cur) }]} /></div>}
      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <div><h4 className="font-semibold text-sm mb-2">Payments</h4><Table rows={payments} empty="No payments yet" cols={[{ h: 'Date', render: (p: any) => <span className="num">{String(p.paid_at).slice(0, 10)}</span> }, { h: 'Type', render: (p: any) => (p.direction === 'outbound' ? 'Refund' : 'Receipt') }, { h: 'Method', render: (p: any) => p.method.replace('_', ' ') }, { h: 'Amount', right: true, render: (p: any) => <span className={p.voided ? 'line-through text-muted' : ''}>{money(p.amount, cur)}</span> }]} /></div>
        <div><h4 className="font-semibold text-sm mb-2">Credit notes</h4><Table rows={credit_notes} empty="None" cols={[{ h: 'No.', render: (c: any) => <span className="num">{c.cn_no}</span> }, { h: 'Status', render: (c: any) => <Pill s={c.status} /> }, { h: 'Total', right: true, render: (c: any) => money(c.total, cur) }]} /></div></div>

      <div className="flex flex-wrap items-center gap-2 mt-5">
        {canEdit && <button className="btn-ghost inline-flex items-center gap-1" onClick={() => onEdit({ ...initial(), id })}><Pencil size={14} />Edit</button>}
        {finance && inv.status === 'draft' && <button className="btn" disabled={busy} onClick={() => run(() => api(`/invoices/${id}/status`, 'POST', { status: 'reviewed' }), 'Marked as reviewed — it is ready to send.')}>Mark reviewed</button>}
        {finance && ['reviewed', ...PAYABLE].includes(inv.status) && <button className="btn" disabled={busy} onClick={() => run(() => api(`/invoices/${id}/send`, 'POST'), `Invoice ${inv.number} emailed to ${clientName ?? 'the client'}.`)}>{inv.status === 'reviewed' ? 'Send to client' : 'Re-send to client'}</button>}
        {finance && issued && outstanding > 0.005 && inv.status !== 'void' && <button className="btn" onClick={() => nav(`/client-receipts?client=${inv.client_id}`)}>Receive payment</button>}
        {inv.status !== 'draft' && <button className="btn-ghost" onClick={() => viewPdf(async () => (await api(`/invoices/${id}/pdf-url`)).url, `Invoice ${inv.number}`)}>View PDF</button>}
        {editor && <button className="btn-ghost inline-flex items-center gap-1" onClick={() => onCopy(initial())}><Copy size={14} />Duplicate</button>}
        {finance && issued && inv.status !== 'void' && <button className="btn-ghost" onClick={() => nav('/credit-notes')}>Credit note…</button>}
        {finance && inv.status !== 'void' && inv.status !== 'credited' && (voiding
          ? <><span className="text-sm text-danger">Void this invoice? This reverses it in the ledger.</span><button className="btn-ghost text-danger" onClick={() => run(() => api(`/invoices/${id}/void`, 'POST', {}), 'Invoice voided.')}>Yes, void it</button><button className="btn-ghost" onClick={() => setVoiding(false)}>Keep</button></>
          : <button className="btn-ghost text-danger ml-auto" onClick={() => setVoiding(true)}>Void…</button>)}
      </div>
    </Modal>
  );
}

export default function Invoices() {
  const { can, agency } = useAuth(); const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [rows, setRows] = useState<any[] | null>(null);
  const [tab, setTab] = useState(TABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab')! : 'all');
  const [q, setQ] = useState(''); const [form, setForm] = useState<{ initial?: Initial } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [openId, setOpenId] = useState<number | null>(Number(sp.get('open')) || null);
  const load = () => api(`/invoices${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`).then(setRows).catch((e) => { setNote({ ok: false, text: e.message }); setRows([]); });
  useOpenOnNew(() => setForm({}));
  // "Create invoice" on a booking lands here with ?booking=ID — start a draft with that booking's client, currency and components as lines.
  // "Create invoice" on an Umrah group lands here with ?umrah=GROUP&client=CLIENT: one package line for that payer's pilgrims.
  useEffect(() => {
    const gid = Number(sp.get('umrah')), cid = Number(sp.get('client')); if (!gid || !cid) return;
    const n = new URLSearchParams(sp); n.delete('umrah'); n.delete('client'); setSp(n, { replace: true });
    api(`/umrah/groups/${gid}`).then((g) => { const pax = g.pilgrims.filter((p: any) => p.client_id === cid && p.status !== 'cancelled').length, cost = Number(g.cost_per_pax), price = Number(g.price_per_pax);
      if (!pax) throw new Error('This client has no pilgrims in that group');
      setForm({ initial: { client_id: cid, booking_id: null, currency: g.currency, issue_date: today(), installments: [], fresh: true,
        lines: [{ product_type: 'package', supplier_id: '', description: `Umrah package — ${g.name} (${String(g.departure_date).slice(0, 10)} to ${String(g.return_date).slice(0, 10)})`, quantity: pax, unit_cost: cost > 0 ? cost : price, markup_pct: cost > 0 ? Math.round((price / cost - 1) * 1e6) / 1e4 : 0, tax_rate: 0 }] } }); })
      .catch((e) => setNote({ ok: false, text: e.message }));
  }, []);
  // "Create invoice" on a visa file lands here with ?visa=ID.
  useEffect(() => {
    const vid = Number(sp.get('visa')); if (!vid) return;
    const n = new URLSearchParams(sp); n.delete('visa'); setSp(n, { replace: true });
    api(`/visas/${vid}`).then((v) => { const cost = Number(v.cost), price = Number(v.price);
      setForm({ initial: { client_id: v.client_id, booking_id: v.booking_id ?? null, currency: v.currency, issue_date: today(), installments: [], fresh: true,
        lines: [{ product_type: 'other', supplier_id: v.supplier_id ?? '', description: `Visa processing — ${v.country} ${v.visa_type} visa, ${v.applicant_name}`, quantity: 1, unit_cost: cost > 0 ? cost : price, markup_pct: cost > 0 ? Math.round((price / cost - 1) * 1e6) / 1e4 : 0, tax_rate: 0 }] } }); })
      .catch((e) => setNote({ ok: false, text: e.message }));
  }, []);
  // "New invoice" on a client page lands here with ?client=ID.
  useEffect(() => {
    const cid = Number(sp.get('client')); if (!cid || sp.get('booking') || sp.get('umrah')) return;
    const n = new URLSearchParams(sp); n.delete('client'); setSp(n, { replace: true });
    api(`/clients/${cid}`).then((c) => setForm({ initial: { client_id: c.id, booking_id: null, currency: c.currency, issue_date: today(), installments: [], lines: [], fresh: true } })).catch((e) => setNote({ ok: false, text: e.message }));
  }, []);
  useEffect(() => {
    const bid = Number(sp.get('booking')); if (!bid) return;
    const n = new URLSearchParams(sp); n.delete('booking'); setSp(n, { replace: true });
    api(`/bookings/${bid}`).then((b) => setForm({ initial: { client_id: b.client_id, booking_id: b.id, currency: b.currency, issue_date: today(), installments: [], fresh: true,
      lines: b.components.map((c: any) => {
        const cost = Number(c.unit_cost), qty = Number(c.quantity), net = Number(c.net_total);
        const markup = cost > 0 && qty > 0 ? Math.round((net / (qty * cost) - 1) * 1e6) / 1e4 : Number(c.markup_pct);   // folds any discount into the markup, so the total matches the booking
        return { product_type: ['flight', 'hotel', 'package', 'cruise', 'transfer'].includes(c.product_type) ? c.product_type : 'other', supplier_id: c.supplier_id ?? '', description: c.description, quantity: qty, unit_cost: cost, markup_pct: markup, tax_rate: Number(c.tax_rate) };
      }) } })).catch((e) => setNote({ ok: false, text: e.message }));
  }, []);
  useEffect(() => { const h = setTimeout(load, q ? 300 : 0); return () => clearTimeout(h); }, [q]);
  const finance = can('admin', 'finance_manager'), editor = can('admin', 'finance_manager', 'agent'), base = agency!.base_currency;
  const act = async (fn: () => Promise<any>, done: string) => { try { await fn(); setNote({ ok: true, text: done }); load(); } catch (e: any) { setNote({ ok: false, text: e.message }); } };
  const openInvoice = (id: number | null) => { setOpenId(id); if (sp.has('open')) { sp.delete('open'); setSp(sp, { replace: true }); } };

  const all = rows ?? [];
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, all.filter(t.test).length])), [rows]);
  const money$ = (list: any[]) => list.reduce((s, r) => s + balance(r) * (r.fx_rate ?? 1), 0);
  const unpaid = all.filter(TABS[3].test), overdue = all.filter(TABS[4].test);
  const shown = all.filter(TABS.find((t) => t.key === tab)!.test);
  const stat = (key: string, title: string, value: string, sub: string, tone = '') => (
    <button type="button" onClick={() => setTab(key)} className={`card text-left hover:bg-surface2/70 transition-colors ${tab === key ? 'ring-1 ring-accent' : ''}`}>
      <div className="text-xs text-muted">{title}</div><div className={`text-xl font-semibold num mt-0.5 ${tone}`}>{value}</div><div className="text-xs text-muted mt-0.5">{sub}</div></button>);

  return (
    <Page title="Invoices" description="Create an invoice, review it, send it, then record the payment. Click any invoice to see everything about it."
      actions={editor ? <button className="btn inline-flex items-center gap-1" onClick={() => setForm({})}><Plus size={16} />New invoice</button> : undefined}>
      {rows === null ? <div className="grid sm:grid-cols-3 gap-3 mb-4"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div> : (
        <div className="grid sm:grid-cols-3 gap-3 mb-4">
          {stat('unpaid', 'Waiting to be paid', money(r2(money$(unpaid)), base), `${unpaid.length} invoice${unpaid.length === 1 ? '' : 's'}`)}
          {stat('overdue', 'Overdue', money(r2(money$(overdue)), base), overdue.length ? `${overdue.length} invoice${overdue.length === 1 ? '' : 's'} past due` : 'Nothing is late', overdue.length ? 'text-danger' : '')}
          {stat(counts.ready ? 'ready' : 'draft', 'To finish', String(counts.draft + counts.ready), `${counts.draft} draft · ${counts.ready} ready to send`)}
        </div>)}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1 flex-1 min-w-0" role="tablist" aria-label="Invoice views">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
              className={`whitespace-nowrap text-sm px-3 py-1.5 rounded-lg border ${tab === t.key ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>
              {t.label}{rows && t.key !== 'all' && <span className="ml-1.5 text-xs opacity-70 num">{counts[t.key]}</span>}</button>))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input className="input pl-8" placeholder="Search number or client…" aria-label="Search invoices" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {note && <div role={note.ok ? 'status' : 'alert'} className={`rounded-lg border text-sm px-3 py-2 mb-3 flex justify-between gap-3 ${note.ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>
        <span>{note.text}</span><button className="opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={() => setNote(null)}><X size={14} /></button></div>}

      {rows === null ? <Skeleton className="h-64" /> : (
        <Table rows={shown} onRow={(r) => openInvoice(r.id)}
          empty={all.length === 0 ? (q ? `No invoice matches “${q}”.` : editor ? 'No invoices yet — click “New invoice” to create your first one.' : 'No invoices yet.') : `Nothing in “${TABS.find((t) => t.key === tab)!.label}”${q ? ` matching “${q}”` : ''}.`}
          cols={[
            { h: 'Number', render: (r) => <span className="num font-medium">{r.number}</span> }, { h: 'Client', render: (r) => r.client_name },
            { h: 'Due', render: (r) => <><span className="num">{String(r.due_date).slice(0, 10)}</span>{daysLate(r) > 0 && <div className="text-xs text-danger">{daysLate(r)} day{daysLate(r) > 1 ? 's' : ''} late</div>}</> },
            { h: 'Status', render: (r) => <Pill s={shownStatus(r)} /> },
            { h: 'Total', right: true, render: (r) => money(r.total, r.currency) },
            { h: 'Balance', right: true, render: (r) => (['draft', 'reviewed', 'void'].includes(r.status) ? <span className="text-muted">—</span> : balance(r) > 0.005 ? <b>{money(balance(r), r.currency)}</b> : <span className="text-success">Paid</span>) },
            { h: '', render: (r) => <div className="flex gap-1 justify-end whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
              {finance && r.status === 'draft' && <button className="btn" onClick={() => act(() => api(`/invoices/${r.id}/status`, 'POST', { status: 'reviewed' }), `${r.number} is reviewed and ready to send.`)}>Mark reviewed</button>}
              {finance && r.status === 'reviewed' && <button className="btn" onClick={() => act(() => api(`/invoices/${r.id}/send`, 'POST'), `${r.number} was emailed to ${r.client_name}.`)}>Send</button>}
              {finance && PAYABLE.includes(r.status) && balance(r) > 0.005 && <button className="btn" onClick={() => nav(`/client-receipts?client=${r.client_id}`)}>Receive payment</button>}
              {r.status !== 'draft' && <button className="btn-ghost" onClick={() => viewPdf(async () => (await api(`/invoices/${r.id}/pdf-url`)).url, `Invoice ${r.number}`)}>PDF</button>}</div> },
          ]} />
      )}
      {rows && rows.length >= 500 && <p className="text-xs text-muted mt-2">Showing the latest 500 invoices. Use the search box to find older ones.</p>}

      {form && <InvoiceForm initial={form.initial} onDone={() => setForm(null)} onSaved={(id) => { setForm(null); load(); openInvoice(id); }} />}
      {openId && <InvoiceDetail id={openId} clientName={all.find((r) => r.id === openId)?.client_name} onClose={() => openInvoice(null)} onChange={load}
        onEdit={(i) => { setOpenId(null); setForm({ initial: i }); }} onCopy={(i) => { const { id: _drop, ...rest } = i; setOpenId(null); setForm({ initial: { ...rest, issue_date: today(), due_date: '' } }); }} />}
    </Page>
  );
}
