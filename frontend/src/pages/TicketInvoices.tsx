import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Check, ChevronDown, Copy, Mail, MoreHorizontal, Plus, Printer, RefreshCw, Save, Trash2, Undo2 } from 'lucide-react';
import { api, money, n2 } from '../api';
import { useAuth } from '../auth';
import { AmountRow, AmountTotal, Banner, Err, Field, Locked, MenuBtn, Modal, More, Num, Page, Pill, Popover, Skeleton, Table } from '../components/ui';
import { viewPdf } from '../components/PdfViewer';
import { today, useAccounts, useList, useOpenOnNew } from '../lookup';

/*
 * Ticket invoices: one invoice per client, one card per passenger ticket.
 * The screen shows what an agent types every day (client, passenger, flight, fare, taxes, fee) and keeps the
 * accountant's fields (tax codes, commissions, withholding, VAT, agent commission) one click away under "More …".
 * What is sent to the server is unchanged — only the layout and the wording are.
 */

/** Every amount on a ticket line. A zero is shown as an empty box, so the form is not a wall of "0". */
const NUMS = ['fare', 'fare_nc', 'sp_yi', 'rg_cvt', 'yq', 'ced', 'pb_adv_yq', 'xz', 'yd', 'kb', 'xt_ur_us', 'other_tax', 'com_rec_pct', 'com_rec', 'com_paid_pct', 'com_paid', 'wh_air', 'insurance', 'vat_paid', 'psf', 'other_charges', 'discount_pct', 'discount', 'wh_client', 'fare_inc', 'taxes_inc', 'agent_amount', 'vat_pct', 'vat'];
const TAX_CODES: [string, string][] = [['sp_yi', 'SP + YI'], ['rg_cvt', 'RG / CVT'], ['yq', 'YQ'], ['ced', 'CED'], ['pb_adv_yq', 'PB / Adv YQ'], ['xz', 'XZ'], ['yd', 'YD'], ['kb', 'KB'], ['xt_ur_us', 'XT / UR / US'], ['other_tax', 'Other taxes']];
const CODED = TAX_CODES.slice(0, -1).map(([k]) => k);                 // the named tax codes; "Other taxes" doubles as the single Taxes box
const PRICING = ['fare_nc', ...CODED, 'com_rec', 'com_paid_pct', 'com_paid', 'wh_air', 'insurance', 'vat_paid', 'other_charges', 'discount_pct', 'discount', 'wh_client', 'vat_pct', 'vat', 'agent_account_id', 'agent_amount'];
const DETAILS = ['passport', 'nationality', 'phone_rt', 'group_no', 'con_ticket_no', 'ticket_type', 'sector', 'gds', 'gds_pnr', 'fare_class', 'xo', 'confirmation_no'];
const TRIP = ['airline_id', 'payable_account_id', 'route', 'sector', 'dep_date', 'return_date', 'pnr', 'gds', 'gds_pnr', 'fare_class', 'currency', 'fx_rate', 'com_rec_pct'];   // what the next passenger on the same booking shares
const SERVICES: [string, string][] = [['ticket', 'Ticket'], ['hotel', 'Hotel'], ['visa', 'Visa'], ['umrah', 'Umrah'], ['other', 'Other']];

let seq = 0;
const newKey = () => `t${++seq}`;
/** Gives a line a stable key for the screen and blanks its zero amounts. */
const tidy = (l: any) => { const o = { ...l, _k: l._k ?? newKey() }; for (const k of NUMS) if (!Number(o[k])) o[k] = ''; return o; };
const pick = (o: any, ks: string[]) => Object.fromEntries(ks.filter((k) => o?.[k] != null && o[k] !== '').map((k) => [k, o[k]]));
const blankLine = (prev?: any) => tidy({ mode: 'ticket', line_type: 'Normal', pax_type: 'Adult', fx_rate: 1, ...pick(prev, TRIP) });
const blankInv = () => ({ invoice_date: today(), status: 'tentative', active: true, lines: [blankLine()] });
/**
 * The server saves the amounts it works out (commission from the %, client fare, VAT…) into the same boxes people type in, where they
 * would later pass for typed values and stop following the fare. Anything that still equals what the other boxes work out is shown empty.
 */
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.006;
function unstick(l: any, airlines: any[]) {
  const o = { ...l }, n = (k: string) => Number(o[k]) || 0;
  const fare = n('fare') + n('fare_nc'), taxes = TAX_CODES.reduce((t, [k]) => t + n(k), 0);
  if (n('fare_inc') && near(o.fare_inc, fare)) o.fare_inc = '';
  if (n('taxes_inc') && near(o.taxes_inc, taxes)) o.taxes_inc = '';
  const clientFare = n('fare_inc') || fare;
  if (n('com_rec_pct') > 0 && near(o.com_rec, (n('fare') * n('com_rec_pct')) / 100)) o.com_rec = '';
  if (n('com_paid_pct') > 0 && near(o.com_paid, (n('fare') * n('com_paid_pct')) / 100)) o.com_paid = '';
  if (n('discount_pct') > 0 && near(o.discount, (clientFare * n('discount_pct')) / 100)) o.discount = '';
  if (n('vat_pct') > 0 && near(o.vat, ((n('psf') + n('other_charges')) * n('vat_pct')) / 100)) o.vat = '';
  const wh = Number(airlines.find((a) => a.id === o.airline_id)?.wh_pct) || 0, com = n('com_rec_pct') > 0 ? (n('fare') * n('com_rec_pct')) / 100 : n('com_rec');
  if (wh && n('wh_air') && near(o.wh_air, (com * wh) / 100)) o.wh_air = '';
  return o;
}
/** An invoice as the server returns it, keeping the screen's own line keys so open cards stay open after a save. */
const adopt = (inv: any, prev: any[] | undefined, airlines: any[]) => ({ ...inv, lines: inv.lines.map((l: any, i: number) => unstick(tidy({ ...l, _k: prev?.[i]?._k }), airlines)) });

const day = (d?: string) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const trip = (l: any) => [l.route, l.dep_date && `${day(l.dep_date)}${l.return_date ? ` → ${day(l.return_date)}` : ''}`].filter(Boolean).join(' · ');
const filled = (l: any, keys: string[]) => keys.filter((k) => l[k] != null && l[k] !== '' && l[k] !== 0).length;

/* ---------- small building blocks ---------- */
/* ---------- small building blocks ---------- */
const Group = ({ title, note, children }: { title: string; note?: string; children: ReactNode }) => (
  <div className="rounded-xl border border-line p-3">
    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</div>
    {note && <p className="mb-2 text-[11px] text-muted">{note}</p>}
    {children}
  </div>
);
/* ---------- one passenger ticket ---------- */
function TicketCard({ l, i, count, open, toggle, set, calc, airlines, vendors, agents, base, readOnly, flagged, onCopy, onRemove, onRefund }: any) {
  const [pricing, setPricing] = useState(false), [details, setDetails] = useState(false);
  const c = calc ?? {}, cur = String(l.currency || base).toUpperCase(), foreign = cur !== String(base).toUpperCase();
  const pay = c.payable_fc ?? l.payable_fc, recv = c.receivable_fc ?? l.receivable_fc, profit = c.profit_fc ?? l.profit_fc;
  const itemised = CODED.some((k) => Number(l[k]) > 0);
  const airline = airlines.find((a: any) => a.id === l.airline_id);
  const s = (k: string) => (e: any) => set({ ...l, [k]: e.target.value });
  const num = (k: string, ph = '0.00', label?: string) => <Num v={l[k]} set={(v) => set({ ...l, [k]: v })} placeholder={ph} aria-label={label} />;
  const askPay = !l.payable_account_id && (!!l.airline_id || flagged);   // an airline normally brings its own payable account; ask only when it cannot
  const txt = (k: string, label: string, ph?: string, type = 'text') => <Field label={label}><input className={`input ${type === 'date' ? 'num' : ''}`} type={type} value={l[k] ?? ''} onChange={s(k)} placeholder={ph} /></Field>;
  const chooseAirline = (e: any) => {
    const a = airlines.find((x: any) => x.id === Number(e.target.value));   // the airline brings its own payable account and usual commission
    set({ ...l, airline_id: e.target.value ? Number(e.target.value) : null, payable_account_id: a?.account_id ?? l.payable_account_id, com_rec_pct: l.com_rec_pct || Number(a?.commission_pct) || '' });
  };
  const payTo = (required: boolean) => (
    <Field label={required ? 'Who do you pay for this ticket? *' : 'Pay to'} hint={required ? 'Pick the airline above, or choose the vendor you owe here.' : 'Fills in from the airline. Change it only if you pay someone else.'}>
      <select className="input" value={l.payable_account_id ?? ''} onChange={(e) => set({ ...l, payable_account_id: e.target.value ? Number(e.target.value) : null })}>
        <option value="">Choose…</option>{vendors.map((a: any) => <option key={a.id} value={a.id}>{a.name} ({a.code})</option>)}</select></Field>
  );
  const nDetails = filled(l, DETAILS) + (l.mode && l.mode !== 'ticket' ? 1 : 0) + (l.line_type && l.line_type !== 'Normal' ? 1 : 0), nPricing = filled(l, PRICING);

  return (
    <div id={`t-${l._k}`} className="card !p-0 scroll-mt-24">
      <div className="flex items-center">
        <button type="button" aria-expanded={open} onClick={toggle} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-xs font-semibold text-accent">{i + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{l.passenger_name || <span className="font-normal text-muted">New ticket</span>}</span>
            <span className="block truncate text-xs text-muted">{[airline?.name, l.ticket_no, trip(l)].filter(Boolean).join(' · ') || 'Add the passenger and flight details'}</span>
          </span>
          <span className="shrink-0 text-right"><span className="num block text-sm font-medium">{n2(recv)}</span><span className="block text-[11px] text-muted">{cur}</span></span>
          <ChevronDown size={16} className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {(!readOnly || l.id) && (
          <Popover trigger={(_o, t) => <button type="button" className="btn-icon mr-2" aria-label={`Options for ticket ${i + 1}`} onClick={t}><MoreHorizontal size={16} /></button>}>
            {(close) => <>
              {!readOnly && <MenuBtn onClick={() => { close(); onCopy(); }}><Copy size={15} /> Duplicate this ticket</MenuBtn>}
              {l.id && <MenuBtn onClick={() => { close(); onRefund(); }}><Undo2 size={15} /> Refund this ticket</MenuBtn>}
              {!readOnly && count > 1 && <MenuBtn onClick={() => { close(); onRemove(); }}><span className="flex items-center gap-2.5 text-danger"><Trash2 size={15} /> Remove this ticket</span></MenuBtn>}
            </>}
          </Popover>)}
      </div>

      {open && (
        <div className="space-y-5 border-t border-line px-4 pb-4 pt-4">
          <Locked on={readOnly} className="min-w-0 space-y-5">
            <div>
              <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-4">
                {txt('passenger_name', 'Passenger name', 'SURNAME/FIRSTNAME TITLE')}
                <Field label="Passenger type"><select className="input" value={l.pax_type ?? ''} onChange={s('pax_type')}>{['Adult', 'Child', 'Infant'].map((m) => <option key={m}>{m}</option>)}</select></Field>
                <Field label="Airline"><select className="input" value={l.airline_id ?? ''} onChange={chooseAirline}><option value="">Choose…</option>{airlines.map((a: any) => <option key={a.id} value={a.id}>{a.name} ({a.code})</option>)}</select></Field>
                {txt('ticket_no', 'Ticket number')}
                {txt('route', 'Route', 'e.g. KHI-IST-KHI')}
                {txt('dep_date', 'Departs', undefined, 'date')}
                {txt('return_date', 'Returns', undefined, 'date')}
                {txt('pnr', 'Booking ref (PNR)')}
              </div>
              {askPay && <div className="rounded-lg border border-warn/40 bg-warn/5 px-3 pt-3">{payTo(true)}</div>}
            </div>

            <section>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Price</h3>
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                  <label className="flex items-center gap-1.5">Currency<input className="input !h-8 !w-20 uppercase" maxLength={3} placeholder={base} value={l.currency ?? ''} onChange={(e) => set({ ...l, currency: e.target.value.toUpperCase() })} /></label>
                  {foreign && <label className="flex items-center gap-1.5">1 {cur} =<span className="w-24"><Num v={l.fx_rate} set={(v) => set({ ...l, fx_rate: v })} aria-label={`Exchange rate to ${base}`} /></span>{base}</label>}
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-line p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">You pay the airline</div>
                  <AmountRow label="Fare">{num('fare', '0.00', 'Airline fare')}</AmountRow>
                  <AmountRow label={<>Taxes {!pricing && <button type="button" className="ml-1 text-xs text-accent hover:underline" onClick={() => setPricing(true)}>{itemised ? 'See tax codes' : 'Itemise'}</button>}</>} hint={itemised ? 'Added up from the tax codes' : undefined}>
                    {itemised ? <div className="num pr-3 text-right text-sm font-medium">{n2(c.total_taxes)}</div> : num('other_tax', '0.00', 'Airline taxes')}</AmountRow>
                  <AmountRow label="Commission you earn" hint="% of the fare">
                    <div className="flex items-center gap-1.5"><Num v={l.com_rec_pct} set={(v) => set({ ...l, com_rec_pct: v })} placeholder="0" aria-label="Commission percent" /><span className="text-sm text-muted">%</span></div>
                    <div className="num mt-0.5 text-right text-[11px] text-muted">− {n2(c.com_rec)}</div>
                  </AmountRow>
                  <AmountTotal label="You pay" value={pay} />
                </div>
                <div className="rounded-xl border border-line p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Client pays</div>
                  <AmountRow label="Fare" hint="Empty = same as the airline fare">{num('fare_inc', n2(c.fare_inc), 'Fare charged to the client')}</AmountRow>
                  <AmountRow label="Taxes" hint="Empty = same as the airline taxes">{num('taxes_inc', n2(c.taxes_inc), 'Taxes charged to the client')}</AmountRow>
                  <AmountRow label="Service fee" hint="Your fee for this ticket (PSF)">{num('psf', '0.00', 'Service fee')}</AmountRow>
                  <AmountTotal label="Client pays" value={recv} />
                </div>
              </div>
              <div className={`mt-3 flex items-baseline justify-between rounded-lg px-3 py-2 ${typeof profit !== 'number' ? 'bg-surface2 text-muted' : profit < 0 ? 'bg-danger/15 text-danger' : 'bg-success/15 text-success'}`}>
                <span className="text-sm font-medium">Your profit on this ticket</span><span className="num text-lg font-semibold">{n2(profit)} <span className="text-xs font-normal opacity-80">{cur}</span></span></div>
              {nPricing > 0 && <p className="mt-1.5 text-xs text-muted">These totals include the extras you filled in under “More pricing options”.</p>}
            </section>
          </Locked>

          <More title="More pricing options" hint="Tax codes, discount, VAT, extra commission, agent" count={nPricing} open={pricing} setOpen={setPricing}>
            <Locked on={readOnly} className="min-w-0">
              <div className="grid gap-3 lg:grid-cols-3">
                <Group title="Airline fare details">
                  <div className="grid grid-cols-2 gap-x-3">
                    <div className="col-span-2"><Field label="Non-commissionable fare">{num('fare_nc')}</Field></div>
                    {TAX_CODES.map(([k, label]) => <Field key={k} label={label}>{num(k)}</Field>)}
                  </div>
                </Group>
                <Group title="What you pay the airline" note="A percentage wins over an amount when both are filled in.">
                  <div className="grid grid-cols-2 gap-x-3">
                    <Field label="Commission earned (amount)">{num('com_rec')}</Field><Field label="Withholding on it (WH Air)">{num('wh_air')}</Field>
                    <Field label="Commission paid out %">{num('com_paid_pct', '0')}</Field><Field label="Commission paid out (amount)">{num('com_paid')}</Field>
                    <Field label="Insurance">{num('insurance')}</Field><Field label="VAT paid">{num('vat_paid')}</Field>
                  </div>
                </Group>
                <Group title="What the client pays, and the agent">
                  <div className="grid grid-cols-2 gap-x-3">
                    <Field label="Other charges">{num('other_charges')}</Field><Field label="Withholding (WH Client)">{num('wh_client')}</Field>
                    <Field label="Discount %">{num('discount_pct', '0')}</Field><Field label="Discount (amount)">{num('discount')}</Field>
                    <Field label="VAT %">{num('vat_pct', '0')}</Field><Field label="VAT (amount)">{num('vat')}</Field>
                    <div className="col-span-2"><Field label="Agent who earns a commission"><select className="input" value={l.agent_account_id ?? ''} onChange={(e) => set({ ...l, agent_account_id: e.target.value ? Number(e.target.value) : null })}><option value="">None</option>{agents.map((a: any) => <option key={a.id} value={a.id}>{a.name} ({a.code})</option>)}</select></Field></div>
                    <Field label="Agent commission (amount)">{num('agent_amount')}</Field>
                  </div>
                </Group>
              </div>
            </Locked>
          </More>

          <More title="Passenger & booking details" hint="Passport, nationality, class, GDS, confirmation no." count={nDetails} open={details} setOpen={setDetails}>
            <Locked on={readOnly} className="min-w-0">
              <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Service"><select className="input" value={l.mode ?? ''} onChange={s('mode')}>{SERVICES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></Field>
                <Field label="Ticket kind"><select className="input" value={l.line_type ?? ''} onChange={s('line_type')}>{['Normal', 'Reissue', 'Void', 'EMD'].map((m) => <option key={m}>{m}</option>)}</select></Field>
                {askPay ? null : payTo(false)}
                {txt('passport', 'Passport no.')}{txt('nationality', 'Nationality')}{txt('phone_rt', 'Phone / RT')}{txt('group_no', 'Group no.')}
                {txt('con_ticket_no', 'Conjunction ticket no.')}{txt('ticket_type', 'Ticket type')}{txt('sector', 'Sector / particulars')}{txt('gds', 'GDS')}
                {txt('gds_pnr', 'GDS booking ref')}{txt('fare_class', 'Booking class')}{txt('xo', 'XO / exchange order')}{txt('confirmation_no', 'Confirmation no.')}
              </div>
            </Locked>
          </More>
        </div>)}
    </div>
  );
}

/* ---------- the page ---------- */
export default function TicketInvoices() {
  const { can, agency } = useAuth(); const nav = useNavigate(); const [sp, setSp] = useSearchParams();
  const base = agency?.base_currency ?? 'USD';
  const clients = useAccounts([120]), vendors = useAccounts([210, 211]), agents = useAccounts([123, 124, 210]);
  const airlines = useList('/airlines'), branches = useList('/accounting/branches'), depts = useList('/accounting/departments');
  const [rows, setRows] = useState<any[] | null>(null), [q, setQ] = useState(''), [status, setStatus] = useState('');
  const [inv, setInv] = useState<any>(null), [saved, setSaved] = useState('');                 // `saved` is the invoice as last loaded/saved, to spot unsaved changes
  const [openK, setOpenK] = useState<Set<string>>(new Set()), [moreInv, setMoreInv] = useState(false);
  const [calcs, setCalcs] = useState<Record<string, any>>({});
  const [err, setErr] = useState(''), [tried, setTried] = useState(false), [note, setNote] = useState<{ text: string; send?: boolean } | null>(null), [busy, setBusy] = useState('');
  const [ask, setAsk] = useState<'' | 'issue' | 'delete' | 'leave'>(''), [mail, setMail] = useState<any>(null);

  const writer = can('admin', 'finance_manager'), editor = can('admin', 'finance_manager', 'agent');
  const readOnly = !editor || (!!inv?.supervised && !writer);
  const issued = !!inv?.supervised;
  const dirty = useMemo(() => !!inv && JSON.stringify(inv) !== saved, [inv, saved]);

  const listSeq = useRef(0);
  const load = () => {
    const p = new URLSearchParams(); if (q) p.set('q', q); if (status) p.set('status', status);
    const mine = ++listSeq.current;
    return api(`/tickets/invoices?${p}`).then((r) => { if (mine === listSeq.current) setRows(r); });
  };
  useEffect(() => { load(); }, [q, status]);

  const sigs = useRef<Record<string, string>>({}), calcSeq = useRef<Record<string, number>>({});
  const show = (v: any) => { sigs.current = {}; setCalcs({}); setInv(v); setSaved(JSON.stringify(v)); setOpenK(new Set(v.lines.length === 1 ? [v.lines[0]._k] : [])); setMoreInv(false); setErr(''); setTried(false); };
  const startNew = () => show(blankInv());
  const openInvoice = async (id: number) => { try { show(adopt(await api(`/tickets/invoices/${id}`), undefined, airlines)); } catch (e: any) { setErr(e.message); } };
  useOpenOnNew(startNew);
  useEffect(() => { const o = Number(sp.get('open')); if (o) { openInvoice(o); sp.delete('open'); setSp(sp, { replace: true }); } }, []);

  // Each ticket is priced by the server (one source of truth for the maths) a moment after it changes.
  useEffect(() => {
    if (!inv) return;
    const timers = inv.lines.map((l: any) => {
      const sig = JSON.stringify(l); if (sigs.current[l._k] === sig) return 0;
      return window.setTimeout(() => {
        sigs.current[l._k] = sig; const mine = (calcSeq.current[l._k] = (calcSeq.current[l._k] ?? 0) + 1);
        api('/tickets/calc', 'POST', l).then((c) => { if (calcSeq.current[l._k] === mine) setCalcs((m) => ({ ...m, [l._k]: c })); }).catch(() => {});
      }, 250);
    });
    return () => timers.forEach((t: number) => t && clearTimeout(t));
  }, [inv?.lines]);

  const totals = useMemo(() => {
    const t = { pay: 0, recv: 0, profit: 0 };
    for (const l of inv?.lines ?? []) { const c = calcs[l._k]; t.pay += Number(c ? c.payable : l.payable) || 0; t.recv += Number(c ? c.receivable : l.receivable) || 0; t.profit += Number(c ? c.profit : l.profit) || 0; }
    return t;
  }, [calcs, inv?.lines]);

  const h = (k: string) => (e: any) => setInv({ ...inv, [k]: e.target.value });
  const setLine = (k: string, l: any) => setInv((v: any) => ({ ...v, lines: v.lines.map((x: any) => (x._k === k ? l : x)) }));
  const reveal = (k: string) => { setOpenK((s) => new Set(s).add(k)); setTimeout(() => document.getElementById(`t-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); };
  const addTicket = () => { const l = blankLine(inv.lines[inv.lines.length - 1]); setInv({ ...inv, lines: [...inv.lines, l] }); reveal(l._k); };
  const copyTicket = (at: number) => {
    const { id, invoice_id, _k, ticket_no, con_ticket_no, passenger_name, passport, ...rest } = inv.lines[at];   // same trip and prices, but a new passenger
    const l = tidy(rest); setInv({ ...inv, lines: [...inv.lines.slice(0, at + 1), l, ...inv.lines.slice(at + 1)] }); reveal(l._k);
  };
  const removeTicket = (k: string) => setInv({ ...inv, lines: inv.lines.filter((x: any) => x._k !== k) });

  /** The first thing that stops this invoice from being saved, in plain words. */
  const problem = (v: any): { msg: string; k?: string } | null => {
    if (!v.client_account_id) return { msg: 'Choose the client this invoice is for.' };
    const i = v.lines.findIndex((l: any) => !l.payable_account_id && !airlines.find((a: any) => a.id === l.airline_id)?.account_id);
    return i < 0 ? null : { msg: `Ticket ${i + 1}: choose who you pay for it — an airline, or a vendor.`, k: v.lines[i]._k };
  };
  const save = async () => {
    const p = problem(inv);
    if (p) { setTried(true); setErr(''); if (p.k) reveal(p.k); else document.getElementById('f-client')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return null; }
    setBusy('save'); setErr(''); setTried(false);
    try {
      const body = { ...inv, client_account_id: Number(inv.client_account_id), branch_id: inv.branch_id || null, department_id: inv.department_id || null, active: !!inv.active };
      const r = adopt(inv.id ? await api(`/tickets/invoices/${inv.id}`, 'PUT', body) : await api('/tickets/invoices', 'POST', body), inv.lines, airlines);
      setInv(r); setSaved(JSON.stringify(r)); load(); return r;
    } catch (e: any) { setErr(e.message); return null; } finally { setBusy(''); }
  };
  const issue = async () => {
    setAsk(''); const cur = dirty ? await save() : inv; if (!cur) return;
    setBusy('issue');
    try {
      await api(`/tickets/invoices/${cur.id}/supervise`, 'POST');
      const r = adopt(await api(`/tickets/invoices/${cur.id}`), cur.lines, airlines); setInv(r); setSaved(JSON.stringify(r)); setNote({ text: 'Invoice issued — it is now in your books.', send: true }); load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };
  const repost = async () => { try { await api(`/tickets/invoices/${inv.id}/repost`, 'POST'); setNote({ text: 'Posted to your books again.' }); } catch (e: any) { setErr(e.message); } };
  const remove = async () => { setAsk(''); try { await api(`/tickets/invoices/${inv.id}`, 'DELETE'); setInv(null); setNote({ text: `Invoice ${inv.invoice_no} deleted.` }); load(); } catch (e: any) { setErr(e.message); } };
  const close = () => { setAsk(''); setInv(null); setErr(''); setNote(null); load(); };
  /** The PDF and the email are made from what is saved, so save pending changes first. */
  const savedCopy = async () => (dirty ? save() : inv);
  const print = async () => { const cur = await savedCopy(); if (cur) viewPdf(async () => (await api(`/tickets/invoices/${cur.id}/pdf-url`)).url, `Ticket invoice ${cur.invoice_no}`); };
  const askSend = async () => { if (await savedCopy()) setMail({ to: '', message: '' }); };
  const send = async () => {
    setMail({ ...mail, busy: true, err: '' });
    try {
      const r = await api(`/tickets/invoices/${inv.id}/send`, 'POST', { to: mail.to.trim() || undefined, message: mail.message.trim() || undefined });
      setNote({ text: r.delivery === 'sent' ? `Sent to ${r.to}.` : r.delivery === 'skipped' ? `Email isn't configured on this server, so nothing was sent to ${r.to}. Use Print / PDF to send it yourself.` : `The email to ${r.to} failed. Try again, or use Print / PDF.` }); setMail(null);
    } catch (e: any) { setMail({ ...mail, busy: false, err: e.message }); }
  };

  /* ---------- the list ---------- */
  if (!inv) return (
    <Page title="Ticket invoices" description="Airline tickets you sell to clients. A draft is not in your books until you issue it."
      actions={<><input className="input w-56" placeholder="Search number or client" aria-label="Search ticket invoices" value={q} onChange={(e) => setQ(e.target.value)} />{editor && <button className="btn" onClick={startNew}><Plus size={15} /> New invoice</button>}</>}>
      <Err e={err} />{note && <Banner onClose={() => setNote(null)}>{note.text}</Banner>}
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {[['', 'All'], ['tentative', 'Drafts'], ['confirmed', 'Issued']].map(([k, label]) => (
          <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)} className={`rounded-full border px-3 py-1 text-sm transition ${status === k ? 'border-accent bg-accent/10 font-medium text-accent' : 'border-line text-muted hover:bg-surface2'}`}>{label}</button>))}</div>
      {rows === null ? <Skeleton className="h-40" /> : (
        <Table rows={rows} onRow={(r) => openInvoice(r.id)} empty={q || status ? 'No invoices match.' : 'No ticket invoices yet. Click “New invoice” to write the first one.'} cols={[
          { h: 'Invoice', render: (r) => <span className="num font-medium">{r.invoice_no}</span> }, { h: 'Date', render: (r) => r.invoice_date }, { h: 'Client', render: (r) => r.client_name },
          { h: 'Tickets', right: true, render: (r) => r.n_lines }, { h: 'Status', render: (r) => <Pill s={r.supervised ? 'issued' : 'draft'} /> },
          { h: 'Client pays', right: true, render: (r) => money(r.receivable, base) }, { h: 'Profit', right: true, render: (r) => money(r.profit, base) }]} />)}
    </Page>
  );

  /* ---------- one invoice ---------- */
  const lines: any[] = inv.lines;
  const stop = tried ? problem(inv) : null, message = stop?.msg ?? err;   // what is wrong right now, once the person has tried to save
  return (
    <Page title={inv.id ? `Ticket invoice ${inv.invoice_no}` : 'New ticket invoice'}
      description={inv.id ? <><Pill s={issued ? 'issued' : 'draft'} /><span className="ml-2">{issued ? 'In your books. Changes you save are posted again automatically.' : 'Not in your books yet — issue it when it is final.'}</span></> : 'Choose the client, add the tickets, then save.'}
      actions={<>
        <button className="btn-ghost" onClick={() => (dirty ? setAsk('leave') : close())}><ArrowLeft size={15} /> All invoices</button>
        {inv.id && <button className="btn-ghost" title="The client's copy, with your letterhead — print it or save it as PDF" onClick={print}><Printer size={15} /> Print / PDF</button>}
        {inv.id && issued && <button className="btn-ghost" onClick={askSend}><Mail size={15} /> Send to client</button>}
        {inv.id && writer && (
          <Popover trigger={(_o, t) => <button type="button" className="btn-icon border border-line" aria-label="More actions" onClick={t}><MoreHorizontal size={16} /></button>}>
            {(closeMenu) => <>
              {issued && <MenuBtn onClick={() => { closeMenu(); repost(); }}><RefreshCw size={15} /> Post to the books again</MenuBtn>}
              <MenuBtn onClick={() => { closeMenu(); setAsk('delete'); }}><span className="flex items-center gap-2.5 text-danger"><Trash2 size={15} /> Delete this invoice</span></MenuBtn>
            </>}
          </Popover>)}
      </>}>
      {note && <Banner onClose={() => setNote(null)} action={note.send && issued ? { label: 'Send to client', onClick: askSend } : undefined}>{note.text}</Banner>}
      {readOnly && <div className="mb-3 rounded-lg border border-line bg-surface2/50 px-3 py-2 text-sm text-muted">{editor ? 'This invoice has been issued, so only an admin or finance manager can change it.' : 'You can look at this invoice but not change it.'}</div>}

      <div className="card mb-5">
        <Locked on={readOnly} className="min-w-0">
          <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Client *"><select id="f-client" className={`input ${stop && !stop.k ? '!border-danger' : ''}`} value={inv.client_account_id ?? ''} onChange={h('client_account_id')}><option value="">Choose a client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}</select></Field>
            <Field label="Invoice date *"><input className="input num" type="date" value={inv.invoice_date ?? ''} onChange={h('invoice_date')} /></Field>
            <Field label="Due date" hint="Empty = the invoice date"><input className="input num" type="date" value={inv.due_date ?? ''} onChange={h('due_date')} /></Field>
            <Field label="Your reference" hint="Printed on the client's copy"><input className="input" value={inv.ref_no ?? ''} onChange={h('ref_no')} /></Field>
          </div>
          <Field label="Notes"><input className="input" value={inv.remarks ?? ''} onChange={h('remarks')} placeholder="e.g. Business trip — Karachi to Istanbul" /></Field>
        </Locked>
        <More title="More options" hint="Branch, department, payment terms, tax invoice no." count={filled(inv, ['branch_id', 'department_id', 'payment_terms', 'due_vendor', 'stax_invoice_no', 'umrah_query_id', 'ticket_query_id'])} open={moreInv} setOpen={setMoreInv}>
          <Locked on={readOnly} className="min-w-0">
            <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Branch"><select className="input" value={inv.branch_id ?? ''} onChange={h('branch_id')}><option value="">None</option>{branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
              <Field label="Department"><select className="input" value={inv.department_id ?? ''} onChange={h('department_id')}><option value="">None</option>{depts.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
              <Field label="Payment terms" hint="Printed on the client's copy"><input className="input" value={inv.payment_terms ?? ''} onChange={h('payment_terms')} /></Field>
              <Field label="Pay the airline by"><input className="input num" type="date" value={inv.due_vendor ?? ''} onChange={h('due_vendor')} /></Field>
              <Field label="Tax invoice no."><input className="input" value={inv.stax_invoice_no ?? ''} onChange={h('stax_invoice_no')} /></Field>
              <Field label="Umrah enquiry ID"><input className="input" value={inv.umrah_query_id ?? ''} onChange={h('umrah_query_id')} /></Field>
              <Field label="Ticket enquiry ID"><input className="input" value={inv.ticket_query_id ?? ''} onChange={h('ticket_query_id')} /></Field>
              <label className="mb-3 flex items-center gap-2 self-center text-sm"><input type="checkbox" checked={!!inv.active} onChange={(e) => setInv({ ...inv, active: e.target.checked })} /> Active</label>
            </div>
          </Locked>
        </More>
      </div>

      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Tickets <span className="font-normal text-muted">({lines.length})</span></h2>
        {lines.length > 1 && <button type="button" className="text-xs text-accent hover:underline" onClick={() => setOpenK(openK.size ? new Set() : new Set(lines.map((l) => l._k)))}>{openK.size ? 'Collapse all' : 'Expand all'}</button>}
      </div>
      <div className="space-y-3">
        {lines.map((l, i) => (
          <TicketCard key={l._k} l={l} i={i} count={lines.length} open={openK.has(l._k)} toggle={() => setOpenK((s) => { const n = new Set(s); n.has(l._k) ? n.delete(l._k) : n.add(l._k); return n; })}
            set={(x: any) => setLine(l._k, x)} calc={calcs[l._k]} airlines={airlines} vendors={vendors} agents={agents} base={base} readOnly={readOnly} flagged={stop?.k === l._k}
            onCopy={() => copyTicket(i)} onRemove={() => removeTicket(l._k)} onRefund={() => nav(`/refunds?line=${l.id}`)} />))}
      </div>
      {!readOnly && <button type="button" className="btn-ghost mt-3" onClick={addTicket}><Plus size={15} /> Add another ticket</button>}

      {/* totals and the next step stay in reach while you scroll */}
      <div className="sticky bottom-0 z-20 -mx-4 mt-6 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur md:-mx-8 md:px-8">
        {message && <div role="alert" className="mb-2 flex items-start gap-2 text-sm text-danger"><AlertCircle size={16} className="mt-0.5 shrink-0" /><span>{message}</span></div>}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <span className="text-muted">{lines.length} ticket{lines.length === 1 ? '' : 's'}</span>
            <span>Client pays <b className="num">{money(totals.recv, base)}</b></span>
            <span>You pay <b className="num">{money(totals.pay, base)}</b></span>
            <span className={totals.profit < 0 ? 'text-danger' : 'text-success'}>Profit <b className="num">{money(totals.profit, base)}</b></span>
          </div>
          {!readOnly && (
            <div className="flex items-center gap-2">
              {dirty && inv.id && <span className="text-xs text-muted">Unsaved changes</span>}
              <button className={dirty || !inv.id ? 'btn' : 'btn-ghost'} onClick={save} disabled={!!busy || (!dirty && !!inv.id)}>
                {busy === 'save' ? 'Saving…' : <><Save size={15} /> {!inv.id ? 'Save' : dirty ? (issued ? 'Save changes' : 'Save') : 'Saved'}</>}</button>
              {inv.id && writer && !issued && <button className={dirty ? 'btn-ghost' : 'btn'} onClick={() => setAsk('issue')} disabled={!!busy}><Check size={15} /> Issue invoice</button>}
            </div>)}
        </div>
      </div>

      {ask === 'issue' && <Modal title={`Issue ${inv.invoice_no}?`} onClose={() => setAsk('')}>
        <p className="mb-3 text-sm">Issuing approves the invoice and posts it to your books. The client pays <b className="num">{money(totals.recv, base)}</b> and your profit is <b className="num">{money(totals.profit, base)}</b>.{dirty && ' Your unsaved changes are saved first.'}</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setAsk('')}>Not yet</button><button className="btn" onClick={issue}><Check size={15} /> Issue invoice</button></div></Modal>}
      {ask === 'delete' && <Modal title={`Delete ${inv.invoice_no}?`} onClose={() => setAsk('')}>
        <p className="mb-3 text-sm">This removes the invoice and its entries in your books. It cannot be undone.</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setAsk('')}>Keep it</button><button className="btn !bg-danger text-accent-ink" onClick={remove}><Trash2 size={15} /> Delete invoice</button></div></Modal>}
      {ask === 'leave' && <Modal title="Leave without saving?" onClose={() => setAsk('')}>
        <p className="mb-3 text-sm">You have changes that are not saved yet.</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setAsk('')}>Keep editing</button><button className="btn" onClick={close}>Leave without saving</button></div></Modal>}
      {mail && <Modal title={`Send ${inv.invoice_no} to the client`} onClose={() => setMail(null)}>
        <p className="mb-3 text-sm text-muted">The client's copy is emailed as a PDF attachment, with your letterhead. It shows fare, taxes, charges and the total — never your costs or commission.</p>
        <Field label="Email to" hint="Leave blank to use the client's email on file"><input className="input" type="email" value={mail.to} onChange={(e) => setMail({ ...mail, to: e.target.value })} placeholder="client@example.com" autoFocus /></Field>
        <Field label="Message (optional)"><textarea className="input" rows={3} value={mail.message} onChange={(e) => setMail({ ...mail, message: e.target.value })} placeholder="e.g. Please confirm the names match the passports." /></Field>
        <Err e={mail.err ?? ''} /><div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setMail(null)}>Cancel</button><button className="btn" disabled={mail.busy} onClick={send}>{mail.busy ? 'Sending…' : 'Send'}</button></div></Modal>}
    </Page>
  );
}
