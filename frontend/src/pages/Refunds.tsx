import { ReactNode, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, MoreHorizontal, Plus, Save, Search, Trash2 } from 'lucide-react';
import { api, money, n2 } from '../api';
import { useAuth } from '../auth';
import { AmountRow, Banner, Err, Field, Locked, MenuBtn, Modal, Num, Page, Pill, Popover, Skeleton, Table } from '../components/ui';
import { today, useAccounts, useOpenOnNew } from '../lookup';

/*
 * Ticket refunds: pick the ticket, say what the airline gives back and what you keep, save.
 * The old form also showed passport, hotel, confirmation no., commissions, withholding, VAT, discount, branch and
 * department. None of those change the refund or its postings (they were only copies from the ticket), so they are
 * no longer shown — but they are still carried along and saved exactly as before.
 */

/** Every amount on a refund. A zero is shown as an empty box. */
const MONEY = ['amount', 'rec_from_vendor', 'pay_to_customer', 'cancelation', 'service', 'com_rec', 'com_paid', 'wh_air', 'vat', 'discount'];
const num = (v: any) => Number(v) || 0;
/** What the client gets back: the amount typed in, or what is left of what they paid after the fees (the same rule the server uses). */
const worked = (r: any) => Math.max(0, num(r.amount) - num(r.cancelation) - num(r.service));
const clientGets = (r: any) => (num(r.pay_to_customer) > 0 ? num(r.pay_to_customer) : worked(r));
const blank = (): any => ({ refund_date: today(), pending: false, ...Object.fromEntries(MONEY.map((k) => [k, ''])) });
/**
 * A refund as the server returns it. Zero amounts show as empty boxes, and the "client gets back" figure the server
 * worked out is not kept as if it were typed — otherwise it would stop following the fees when they change.
 */
const tidy = (r: any) => {
  const o = { ...blank(), ...r, pending: !!r.pending };
  for (const k of MONEY) if (!num(o[k])) o[k] = '';
  if (num(o.pay_to_customer) && Math.abs(num(o.pay_to_customer) - worked(o)) < 0.006) o.pay_to_customer = '';
  return o;
};

const Step = ({ n, title, aside }: { n: number; title: string; aside?: ReactNode }) => (
  <div className="mb-3 flex items-center justify-between gap-3">
    <div className="flex items-center gap-2.5"><span className="grid h-6 w-6 place-items-center rounded-full bg-accent/15 text-xs font-semibold text-accent">{n}</span><h2 className="text-sm font-semibold">{title}</h2></div>
    {aside && <div className="text-xs text-muted">{aside}</div>}
  </div>
);

export default function Refunds() {
  const { can, agency } = useAuth(); const [sp, setSp] = useSearchParams();
  const base = agency?.base_currency ?? 'USD', writer = can('admin', 'finance_manager');
  const clients = useAccounts([120]), vendors = useAccounts([210, 211]);
  const [rows, setRows] = useState<any[] | null>(null), [q, setQ] = useState(''), [show, setShow] = useState('');
  const [f, setF] = useState<any>(null), [snap, setSnap] = useState('');                            // f = the refund on screen, snap = how it was when opened (to spot unsaved changes)
  const [tk, setTk] = useState<any>(null), [manual, setManual] = useState(false), [override, setOverride] = useState(false);
  const [find, setFind] = useState(''), [hits, setHits] = useState<any[] | null>(null), [looking, setLooking] = useState(false);
  const [err, setErr] = useState(''), [tried, setTried] = useState(false), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [ask, setAsk] = useState<'' | 'delete' | 'leave'>('');

  const load = () => api('/tickets/refunds').then(setRows).catch((e) => { setErr(e.message); setRows([]); });
  useEffect(() => { load(); }, []);

  /** Puts a refund on screen. */
  const begin = (r: any) => { const v = tidy(r); setF(v); setSnap(JSON.stringify(v)); setOverride(num(v.pay_to_customer) > 0); setErr(''); setTried(false); setNote(''); setFind(''); setHits(null); };
  const startNew = () => { setTk(null); setManual(false); begin(blank()); };
  /** What the ticket card at the top shows. */
  const showTicket = async (lineId: number, invoiceId: number) => {
    try { const inv = await api(`/tickets/invoices/${invoiceId}`); const l = inv.lines.find((x: any) => x.id === lineId); setTk(l ? { ...l, invoice_no: inv.invoice_no, client_name: inv.client_name } : null); } catch { setTk(null); }
  };
  const refundTicket = async (lineId: number) => {
    try { const p = await api(`/tickets/refund-prefill/${lineId}`); setManual(false); begin(p); showTicket(lineId, p.invoice_id); } catch (e: any) { setErr(e.message); }
  };
  const openRefund = async (id: number) => {
    try { const r = await api(`/tickets/refunds/${id}`); setManual(!r.ticket_line_id); begin(r); if (r.ticket_line_id) showTicket(r.ticket_line_id, r.invoice_id); else setTk(null); } catch (e: any) { setErr(e.message); }
  };
  const openForTicket = (lineId: number) => { const r = rows?.find((x) => x.ticket_line_id === lineId); if (r) openRefund(r.id); };
  useOpenOnNew(startNew);
  // "Refund" links on a ticket arrive as ?line=ID: open that ticket's refund, or start one for it
  const lineParam = Number(sp.get('line')) || 0;
  useEffect(() => {
    if (!lineParam || rows === null) return;
    sp.delete('line'); setSp(sp, { replace: true });
    const done = rows.find((r) => r.ticket_line_id === lineParam);
    if (done) openRefund(done.id).then(() => setNote('This ticket was already refunded, so this is that refund.')); else refundTicket(lineParam);
  }, [rows]);

  // finding the ticket: one box for ticket number, passenger or booking ref
  const seq = useRef(0);
  useEffect(() => {
    const term = find.trim(); if (term.length < 2) { setHits(null); setLooking(false); return; }
    setLooking(true); const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const enc = encodeURIComponent(term), parts = await Promise.all(['ticket_no', 'passenger', 'confirmation_no'].map((k) => api(`/tickets/search?${k}=${enc}`)));
        const seen = new Map<number, any>(); for (const r of parts.flat()) seen.set(r.id, r);
        if (mine === seq.current) setHits([...seen.values()].sort((a, b) => b.id - a.id).slice(0, 12));
      } catch { if (mine === seq.current) setHits([]); } finally { if (mine === seq.current) setLooking(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [find]);

  const dirty = !!f && JSON.stringify(f) !== snap;
  const problem = (r: any) => {
    if (!manual && !r.ticket_line_id) return 'Find the ticket you are refunding first — or choose “This isn’t a ticket”.';
    if (!r.client_account_id) return 'Choose the client who gets the money back.';
    if (!r.payable_account_id) return 'Choose the airline or supplier that refunds you.';
    if (!num(r.amount)) return 'Enter what the client paid.';
    if (!r.pending && !num(r.rec_from_vendor) && !clientGets(r)) return 'There is nothing to post yet. Enter what the airline gives back and what the client gets, or keep the refund pending.';
    return null;
  };
  const save = async () => {
    if (problem(f)) { setTried(true); return; }
    setBusy(true); setErr(''); setTried(false);
    try {
      const body = { ...f, client_account_id: Number(f.client_account_id), payable_account_id: Number(f.payable_account_id), branch_id: f.branch_id || null, department_id: f.department_id || null };
      const r = f.id ? await api(`/tickets/refunds/${f.id}`, 'PUT', body) : await api('/tickets/refunds', 'POST', body);
      setF(null); setNote(`Refund ${r.refund_no} ${f.pending ? 'saved as pending — it is not in your books yet.' : 'saved and posted to your books.'}`); load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const remove = async () => { setAsk(''); try { await api(`/tickets/refunds/${f.id}`, 'DELETE'); setF(null); setNote(`Refund ${f.refund_no} deleted.`); load(); } catch (e: any) { setErr(e.message); } };
  const close = () => { setAsk(''); setF(null); setTk(null); setErr(''); };

  /* ---------- the list ---------- */
  if (!f) {
    const needle = q.trim().toLowerCase();
    const shown = (rows ?? []).filter((r) => (show === '' || (show === 'pending') === !!r.pending) && (!needle || `${r.refund_no} ${r.client_name} ${r.passenger ?? ''}`.toLowerCase().includes(needle)));
    const amt = (r: any, v: any) => (r.currency && r.currency !== base ? `${n2(v)} ${r.currency}` : money(v, base));
    return (
      <Page title="Ticket refunds" description="Money going back to a client when a ticket is cancelled."
        actions={<><input className="input w-60" placeholder="Search client, passenger or number" aria-label="Search refunds" value={q} onChange={(e) => setQ(e.target.value)} />{writer && <button className="btn" onClick={startNew}><Plus size={15} /> New refund</button>}</>}>
        <Err e={err} />{note && <Banner onClose={() => setNote('')}>{note}</Banner>}
        <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Show">
          {[['', 'All'], ['pending', 'Pending'], ['posted', 'Posted']].map(([k, label]) => (
            <button key={k} type="button" aria-pressed={show === k} onClick={() => setShow(k)} className={`rounded-full border px-3 py-1 text-sm transition ${show === k ? 'border-accent bg-accent/10 font-medium text-accent' : 'border-line text-muted hover:bg-surface2'}`}>{label}</button>))}</div>
        {rows === null ? <Skeleton className="h-40" /> : (
          <Table rows={shown} onRow={(r) => openRefund(r.id)} empty={q || show ? 'No refunds match.' : 'No refunds yet. When a ticket is cancelled, click “New refund” — or use “Refund this ticket” on the ticket itself.'} cols={[
            { h: 'Refund', render: (r) => <span className="num font-medium">{r.refund_no}</span> }, { h: 'Date', render: (r) => r.refund_date }, { h: 'Client', render: (r) => r.client_name }, { h: 'Passenger', render: (r) => r.passenger },
            { h: 'Airline gives back', right: true, render: (r) => amt(r, r.rec_from_vendor) }, { h: 'Client gets back', right: true, render: (r) => amt(r, r.pay_to_customer) },
            { h: 'Status', render: (r) => <Pill s={r.pending ? 'pending' : 'posted'} /> }, { h: 'Result', right: true, render: (r) => <span className={num(r.profit) < -0.005 ? 'text-warn' : 'text-success'}>{num(r.profit) < -0.005 ? '−' : '+'}{amt(r, Math.abs(num(r.profit)))}</span> }]} />)}
      </Page>
    );
  }

  /* ---------- one refund ---------- */
  const readOnly = !writer, set = (k: string, v: any) => setF({ ...f, [k]: v });
  const gets = clientGets(f), profit = num(f.rec_from_vendor) - gets, costs = profit < -0.005;
  const cur = String(f.currency || base).toUpperCase(), foreign = cur !== base.toUpperCase();
  const message = tried ? problem(f) : err;
  const nameOf = (list: any[], id: any) => list.find((a) => a.id === Number(id))?.name;
  const forTicket = !!f.ticket_line_id || (!!f.id && !manual);
  const amountBox = (k: string, label: string) => <Num v={f[k]} set={(v) => set(k, v)} placeholder="0.00" aria-label={label} />;
  const pick = (k: string, list: any[]) => <select className={`input ${tried && !f[k] ? '!border-danger' : ''}`} value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)}><option value="">Choose…</option>{list.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.code})</option>)}</select>;

  return (
    <Page title={f.id ? `Refund ${f.refund_no}` : 'New refund'}
      description={f.id ? <><Pill s={f.pending ? 'pending' : 'posted'} /><span className="ml-2">{f.pending ? 'Saved, but not in your books yet.' : 'In your books. Changes you save are posted again automatically.'}</span></> : 'Find the ticket, check the amounts, then save.'}
      actions={<>
        <button className="btn-ghost" onClick={() => (dirty ? setAsk('leave') : close())}><ArrowLeft size={15} /> All refunds</button>
        {f.id && writer && (
          <Popover trigger={(_o, t) => <button type="button" className="btn-icon border border-line" aria-label="More actions" onClick={t}><MoreHorizontal size={16} /></button>}>
            {(closeMenu) => <MenuBtn onClick={() => { closeMenu(); setAsk('delete'); }}><span className="flex items-center gap-2.5 text-danger"><Trash2 size={15} /> Delete this refund</span></MenuBtn>}
          </Popover>)}
      </>}>
      {note && <Banner onClose={() => setNote('')}>{note}</Banner>}
      {readOnly && <div className="mb-3 rounded-lg border border-line bg-surface2/50 px-3 py-2 text-sm text-muted">Only an admin or finance manager can record or change refunds.</div>}

      <div className="mx-auto max-w-3xl space-y-4">
        <section className="card">
          <Step n={1} title="What is being refunded" />
          {forTicket ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-line bg-surface2/40 p-3">
              <div className="min-w-0 text-sm">
                <div className="font-medium">{f.passenger || tk?.passenger_name || 'Ticket'}{tk?.airline_name && <span className="font-normal text-muted"> · {tk.airline_name}</span>}</div>
                <div className="mt-0.5 text-xs text-muted">{[tk?.ticket_no ?? f.ticket_no, tk?.route ?? tk?.sector, tk?.invoice_no && `Invoice ${tk.invoice_no}`].filter(Boolean).join(' · ')}</div>
                <div className="mt-1 text-xs">Client: <b>{nameOf(clients, f.client_account_id) ?? tk?.client_name ?? '—'}</b> · Refund comes from: <b>{nameOf(vendors, f.payable_account_id) ?? tk?.airline_name ?? '—'}</b></div>
              </div>
              {!f.id && !readOnly && <button type="button" className="shrink-0 text-xs text-accent hover:underline" onClick={startNew}>Change</button>}
            </div>
          ) : manual ? (
            <Locked on={readOnly}>
              <div className="grid gap-x-3 sm:grid-cols-2">
                <Field label="Client *">{pick('client_account_id', clients)}</Field>
                <Field label="Refund comes from *" hint="The airline or supplier that gives the money back">{pick('payable_account_id', vendors)}</Field>
                <div className="sm:col-span-2"><Field label="Passenger, or what it is for"><input className="input" value={f.passenger ?? ''} onChange={(e) => set('passenger', e.target.value)} /></Field></div>
              </div>
              {!f.id && <button type="button" className="text-xs text-accent hover:underline" onClick={() => setManual(false)}>← Find a ticket instead</button>}
            </Locked>
          ) : (
            <div>
              <div className="relative">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input className="input pl-9" autoFocus placeholder="Find the ticket — ticket number, passenger name or booking ref" aria-label="Find the ticket to refund" value={find} onChange={(e) => setFind(e.target.value)} />
              </div>
              {looking && <p className="mt-2 text-xs text-muted">Searching…</p>}
              {!looking && hits && (hits.length ? (
                <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
                  {hits.map((h) => (
                    <li key={h.id}>
                      <button type="button" disabled={readOnly} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface2/60 disabled:opacity-60" onClick={() => (h.refunded ? openForTicket(h.id) : refundTicket(h.id))}>
                        <span className="min-w-0"><span className="block truncate text-sm font-medium">{h.passenger_name || 'Passenger'}</span><span className="block truncate text-xs text-muted">{[h.ticket_no, h.route ?? h.sector, h.invoice_no].filter(Boolean).join(' · ')}</span></span>
                        <span className="shrink-0 text-right">{h.refunded ? <span className="text-xs text-muted">Already refunded — open it</span> : <span className="num text-sm">{money(h.receivable, base)}</span>}</span>
                      </button>
                    </li>))}
                </ul>
              ) : <p className="mt-2 text-sm text-muted">No ticket matches “{find}”.</p>)}
              {!looking && !hits && <p className="mt-2 text-xs text-muted">Type at least two characters of the ticket number, the passenger’s name or the booking ref.</p>}
              {!readOnly && <button type="button" className="mt-3 text-xs text-accent hover:underline" onClick={() => setManual(true)}>This isn’t a ticket — I’ll choose the client and supplier myself</button>}
            </div>)}
        </section>

        {(forTicket || manual) && <>
          <section className="card">
            <Step n={2} title="Amounts" aside={<>in {cur}{foreign && ` · posted at 1 ${cur} = ${f.fx_rate} ${base}`}</>} />
            <div className="max-w-lg">
              <Locked on={readOnly}>
                <AmountRow label="Client paid" hint="What the client paid for this ticket">{amountBox('amount', 'Amount the client paid')}</AmountRow>
                <AmountRow label="Airline gives back" hint="What the airline or supplier refunds to you">{amountBox('rec_from_vendor', 'Amount the airline gives back')}</AmountRow>
                <AmountRow label="Cancellation fee" hint="Kept from the client">{amountBox('cancelation', 'Cancellation fee')}</AmountRow>
                <AmountRow label="Your service fee" hint="Kept from the client">{amountBox('service', 'Your service fee')}</AmountRow>
                <div className="mt-1 grid grid-cols-[minmax(0,1fr)_minmax(0,8.5rem)] items-center gap-3 border-t border-line pt-2">
                  <div className="text-sm font-medium">Client gets back{!readOnly && !override && <button type="button" className="ml-2 text-xs font-normal text-accent hover:underline" onClick={() => setOverride(true)}>Change</button>}
                    <div className="text-[11px] font-normal leading-tight text-muted">{override ? 'Typed in by you' : 'What they paid, less the fees'}</div></div>
                  {override ? <Num v={f.pay_to_customer} set={(v) => set('pay_to_customer', v)} placeholder={n2(worked(f))} aria-label="Amount the client gets back" /> : <div className="num pr-3 text-right text-base font-semibold">{n2(gets)}</div>}
                </div>
                {override && <button type="button" className="mt-1 text-xs text-accent hover:underline" onClick={() => { set('pay_to_customer', ''); setOverride(false); }}>Work it out for me again</button>}
              </Locked>
            </div>
            <div className={`mt-4 flex items-baseline justify-between gap-3 rounded-lg px-3 py-2 ${costs ? 'bg-warn/15 text-warn' : 'bg-success/15 text-success'}`}>
              <span className="text-sm font-medium">{costs ? 'This refund costs you' : profit > 0.005 ? 'You make on this refund' : 'This refund breaks even'}</span><span className="num text-lg font-semibold">{n2(Math.abs(profit))} <span className="text-xs font-normal opacity-80">{cur}</span></span></div>
            <p className="mt-1.5 text-xs text-muted">{costs ? `The client gets ${n2(-profit)} more than the airline gives back. Add a cancellation or service fee if you charge one.` : `The airline gives you ${n2(num(f.rec_from_vendor))} and the client gets ${n2(gets)}. The difference goes to Service Charges in your books.`}</p>
          </section>

          <section className="card">
            <Step n={3} title="Date and note" />
            <Locked on={readOnly}>
              <div className="grid gap-x-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
                <Field label="Refund date *"><input className="input num" type="date" value={f.refund_date ?? ''} onChange={(e) => set('refund_date', e.target.value)} /></Field>
                <Field label="Note (optional)"><input className="input" value={f.particulars ?? ''} onChange={(e) => set('particulars', e.target.value)} placeholder="e.g. Cancelled by the client; airline penalty applied" /></Field>
              </div>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={!!f.pending} onChange={(e) => set('pending', e.target.checked)} />
                <span>Don’t post to the books yet<span className="block text-xs text-muted">Saves it as pending. It joins your books when you untick this and save again.</span></span></label>
            </Locked>
          </section>
        </>}
      </div>

      {(forTicket || manual) && (
        <div className="sticky bottom-0 z-20 -mx-4 mt-6 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur md:-mx-8 md:px-8">
          {message && <div role="alert" className="mb-2 flex items-start gap-2 text-sm text-danger"><AlertCircle size={16} className="mt-0.5 shrink-0" /><span>{message}</span></div>}
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
              <span>Airline gives back <b className="num">{n2(num(f.rec_from_vendor))}</b></span>
              <span>Client gets back <b className="num">{n2(gets)}</b></span>
              <span className={costs ? 'text-warn' : 'text-success'}>{costs ? 'Costs you' : 'You make'} <b className="num">{n2(Math.abs(profit))}</b></span>
            </div>
            {!readOnly && (
              <div className="flex items-center gap-2">
                {dirty && f.id && <span className="text-xs text-muted">Unsaved changes</span>}
                <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : <><Save size={15} /> {f.id ? 'Save changes' : f.pending ? 'Save as pending' : 'Save refund'}</>}</button>
              </div>)}
          </div>
        </div>)}

      {ask === 'delete' && <Modal title={`Delete ${f.refund_no}?`} onClose={() => setAsk('')}>
        <p className="mb-3 text-sm">This removes the refund and reverses its entries in your books. It cannot be undone.</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setAsk('')}>Keep it</button><button className="btn !bg-danger text-accent-ink" onClick={remove}><Trash2 size={15} /> Delete refund</button></div></Modal>}
      {ask === 'leave' && <Modal title="Leave without saving?" onClose={() => setAsk('')}>
        <p className="mb-3 text-sm">You have changes that are not saved yet.</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setAsk('')}>Keep editing</button><button className="btn" onClick={close}>Leave without saving</button></div></Modal>}
    </Page>
  );
}
