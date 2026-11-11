import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Banknote, CalendarDays, Check, CheckCircle2, ChevronRight, Copy, CreditCard, Download, FileText, Landmark, Lock, MapPin, MessageCircle, Plane, Receipt, Send, ShieldCheck, XCircle, type LucideIcon } from 'lucide-react';
import { Avatar, Err, Pill } from '../components/ui';
import { ThemeMenuButton } from '../components/ThemeToggle';
import { viewPdf } from '../components/PdfViewer';

const money = (n: number, c: string) => new Intl.NumberFormat('en', { style: 'currency', currency: c }).format(n);
const day = (d: string | null) => (d ? String(d).slice(0, 10) : '');
const nice = (d: string | null, long = false) => (d ? new Date(`${day(d)}T00:00:00`).toLocaleDateString(undefined, long ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const todayStr = () => { const t = new Date(); return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
/** Whole days from today to the date: negative once it has passed. */
const daysTo = (d: string | null) => (d ? Math.round((new Date(`${day(d)}T00:00:00`).getTime() - new Date(`${todayStr()}T00:00:00`).getTime()) / 864e5) : 0);
const dueText = (i: any) => { if (i.status === 'paid' || i.outstanding <= 0) return { t: 'Paid in full', tone: 'success' }; const n = daysTo(i.due_date);
  return n < 0 ? { t: `Overdue by ${-n} day${n === -1 ? '' : 's'}`, tone: 'danger' } : n === 0 ? { t: 'Due today', tone: 'warn' } : n <= 7 ? { t: `Due in ${n} day${n === 1 ? '' : 's'}`, tone: 'warn' } : { t: `Due ${nice(i.due_date)}`, tone: 'muted' }; };
const tone = (t: string) => (t === 'muted' ? 'rgb(var(--muted))' : `rgb(var(--${t}))`);

async function call(token: string, path = '', method = 'GET', body?: unknown) {
  const r = await fetch(`/api/public/portal/${token}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? 'Something went wrong'); return j;
}

function Copyable({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* the value is on screen to copy by hand */ } };
  return <div className="flex items-center justify-between gap-3 py-1.5"><div className="min-w-0"><div className="text-[11px] uppercase tracking-wide text-muted">{label}</div><div className="break-all text-sm font-medium num">{value}</div></div>
    <button type="button" className="shrink-0 rounded-md p-1.5 text-muted hover:bg-surface2 hover:text-fg" onClick={copy} aria-label={`Copy ${label}`}>{done ? <Check size={15} className="text-success" /> : <Copy size={15} />}</button></div>;
}

function Empty({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return <div className="card py-12 text-center"><span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-surface2 text-muted"><Icon size={22} /></span><div className="text-sm font-semibold">{title}</div><p className="mx-auto mt-1 max-w-xs text-sm text-muted">{body}</p></div>;
}

/** Client-facing portal and payment page. Standalone: token-only access, no app navigation, no internal data. */
export default function Portal() {
  const { token = '' } = useParams(); const [sp] = useSearchParams(); const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(0);
  const [tab, setTab] = useState('invoices'); const [form, setForm] = useState({ subject: '', message: '', booking_id: '' }); const [sent, setSent] = useState(false); const [sending, setSending] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const load = () => call(token).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [token]);
  const pay = async (id: number) => { setBusy(id); try { window.location.href = (await call(token, `/invoices/${id}/pay`, 'POST')).url; } catch (e: any) { setErr(e.message); setBusy(0); } };
  const pdf = (id: number) => viewPdf(async () => (await call(token, `/invoices/${id}/pdf`)).url, 'Invoice');
  const send = async () => {
    setSending(true);
    try { await call(token, '/requests', 'POST', { subject: form.subject.trim(), message: form.message.trim(), ...(form.booking_id ? { booking_id: Number(form.booking_id) } : {}) }); setForm({ subject: '', message: '', booking_id: '' }); setSent(true); setErr(''); load(); }
    catch (e: any) { setErr(e.message); } finally { setSending(false); }
  };

  const owing = useMemo(() => { const m = new Map<string, number>(); for (const i of d?.invoices ?? []) if (i.payable) m.set(i.currency, (m.get(i.currency) ?? 0) + i.outstanding); return [...m.entries()]; }, [d]);
  const nextTrip = useMemo(() => (d?.bookings ?? []).filter((b: any) => daysTo(b.travel_end ?? b.travel_start) >= 0).sort((x: any, y: any) => day(x.travel_start).localeCompare(day(y.travel_start)))[0], [d]);

  const shell = (c: React.ReactNode, a?: any) => (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/85 backdrop-blur"><div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2.5">{a?.name ? <Avatar name={a.name} size={30} /> : <div className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-accent-ink"><Plane size={15} /></div>}<span className="truncate text-sm font-semibold">{a?.name ?? 'Client portal'}</span></div>
        <div className="flex items-center gap-3"><span className="hidden items-center gap-1 text-xs text-muted sm:flex"><Lock size={12} />Secure private link</span><ThemeMenuButton /></div></div></header>
      <main className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">{c}</main>
      <footer className="mx-auto max-w-4xl px-4 pb-10 text-center text-xs text-muted md:px-6">{a?.address && <div className="mb-1 whitespace-pre-line">{a.name} · {String(a.address).replace(/\n/g, ' · ')}</div>}<div className="flex items-center justify-center gap-1"><ShieldCheck size={12} />This page is private to you. Please do not share the link.</div></footer>
    </div>);

  if (err && !d) return shell(<div className="card mx-auto mt-10 max-w-md py-12 text-center"><span className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-danger/10 text-danger"><XCircle size={28} /></span><h1 className="mb-1 text-xl font-semibold">This link is not available</h1><p className="text-sm text-muted">{err.replace(/\.$/, '')}. Please ask your travel agent to send you a new one.</p></div>);
  if (!d) return shell(<div className="space-y-3"><div className="skeleton h-36 rounded-2xl" /><div className="grid grid-cols-2 gap-3 md:grid-cols-4"><div className="skeleton h-24" /><div className="skeleton h-24" /><div className="skeleton h-24" /><div className="skeleton h-24" /></div><div className="skeleton h-40" /></div>);

  const full = d.scope === 'portal', a = d.agency;
  const hasBank = a.bank_account_number || a.bank_iban || a.payment_instructions;
  const waiting = (d.quotes ?? []).filter((q: any) => q.status === 'sent').length, openMsgs = (d.requests ?? []).filter((r: any) => r.status !== 'resolved').length;
  const counts: Record<string, number> = { invoices: (d.invoices as any[]).filter((i) => i.payable).length, trips: d.bookings?.length ?? 0, quotes: waiting, payments: d.receipts?.length ?? 0, messages: openMsgs };
  const TABS: [string, string, LucideIcon][] = [['invoices', 'Invoices', FileText], ['trips', 'Trips', MapPin], ['quotes', 'Quotes', Banknote], ['payments', 'Payments', Receipt], ['messages', 'Messages', MessageCircle]];
  const paidTotals = (() => { const m = new Map<string, number>(); for (const r of d.receipts ?? []) m.set(r.currency, (m.get(r.currency) ?? 0) + Number(r.amount)); return [...m.entries()]; })();

  const tiles: { label: string; value: string; sub: string; hue: string; icon: LucideIcon; go?: string }[] = full ? [
    { label: 'To pay', value: owing.length ? owing.map(([c, v]) => money(v, c)).join(' + ') : 'All settled', sub: owing.length ? `${counts.invoices} unpaid invoice${counts.invoices === 1 ? '' : 's'}` : 'Nothing is due', hue: owing.length ? 'warn' : 'success', icon: owing.length ? CreditCard : CheckCircle2, go: 'invoices' },
    { label: 'Next trip', value: nextTrip ? (nextTrip.destination || nextTrip.reference) : 'None booked', sub: nextTrip ? (daysTo(nextTrip.travel_start) > 0 ? `Leaves in ${daysTo(nextTrip.travel_start)} day${daysTo(nextTrip.travel_start) === 1 ? '' : 's'}` : 'Under way now') : 'Your trips appear here', hue: 'info', icon: Plane, go: 'trips' },
    { label: 'Quotes', value: String(waiting), sub: waiting ? 'waiting for your answer' : 'nothing waiting', hue: waiting ? 'accent' : 'muted', icon: Banknote, go: 'quotes' },
    { label: 'Messages', value: String(openMsgs), sub: openMsgs ? 'open conversation' + (openMsgs === 1 ? '' : 's') : 'no open conversations', hue: 'accent', icon: MessageCircle, go: 'messages' },
  ] : [];

  return shell(<>
    <section className="hero-mesh relative mb-5 overflow-hidden rounded-2xl border border-line p-5 md:p-7">
      <div className="text-xs font-medium uppercase tracking-wider text-muted">{full ? 'Your travel portal' : 'Invoice'}</div>
      <h1 className="mt-1 text-2xl font-bold md:text-3xl">Hello, {d.client.name}</h1>
      <p className="mt-1 max-w-xl text-sm text-muted">{full ? `Everything ${a.name} has prepared for you: quotes, invoices, itinerary and payments, in one place.` : `Review your invoice from ${a.name} and pay it securely.`}</p>
    </section>

    {sp.get('paid') && <div role="status" className="mb-4 flex items-start gap-2.5 rounded-xl border border-success/30 bg-success/10 p-3.5 text-sm text-success"><CheckCircle2 size={18} className="mt-0.5 shrink-0" /><div><div className="font-semibold">Thank you, your payment was received.</div><div className="opacity-90">It can take a minute to show here. A receipt will follow from {a.name}.</div></div></div>}
    <Err e={err} />

    {full && <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">{tiles.map((t) => (
      <button key={t.label} type="button" onClick={() => t.go && setTab(t.go)} className="card glow-card text-left" style={{ ['--hue' as any]: `var(--${t.hue === 'muted' ? 'accent' : t.hue})` }}>
        <div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{t.label}</span><span className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: `rgb(var(--${t.hue}) / .14)`, color: `rgb(var(--${t.hue}))` }}><t.icon size={15} /></span></div>
        <div className="mt-2 truncate text-lg font-bold num md:text-xl">{t.value}</div><div className="mt-0.5 truncate text-xs text-muted">{t.sub}</div></button>))}</div>}

    {full && <div className="mb-4 flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Portal sections">{TABS.map(([k, l, Icon]) => (
      <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-2 text-sm ${tab === k ? 'border-accent bg-accent/15 font-medium text-accent' : 'border-line hover:bg-surface2'}`}>
        <Icon size={15} />{l}{!!counts[k] && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold num ${tab === k ? 'bg-accent text-accent-ink' : 'bg-surface2 text-muted'}`}>{counts[k]}</span>}</button>))}</div>}

    {tab === 'invoices' && <div className="space-y-3">
      {d.invoices.length === 0 && <Empty icon={FileText} title="No invoices yet" body="When an invoice is issued to you, it will show up here to view and pay." />}
      {d.invoices.map((i: any) => { const due = dueText(i); const paid = i.outstanding <= 0 && i.total > 0; return (
        <article key={i.id} className="card !p-0 overflow-hidden">
          <div className="h-1" style={{ background: tone(due.tone === 'muted' ? 'accent' : due.tone) }} />
          <div className="p-4 md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><div className="flex items-center gap-2"><span className="text-base font-semibold num">{i.number}</span><Pill s={i.status} /></div>
                <div className="mt-1 text-sm font-medium" style={{ color: tone(due.tone) }}>{due.t}</div><div className="text-xs text-muted">Issued {nice(i.issue_date)}{!paid && ` · due ${nice(i.due_date)}`}</div></div>
              <div className="text-right"><div className="text-2xl font-bold num">{money(i.total, i.currency)}</div>
                {i.outstanding > 0 && i.outstanding !== i.total && <div className="text-xs text-muted">Still to pay <span className="font-semibold text-fg num">{money(i.outstanding, i.currency)}</span></div>}</div></div>
            <div className="mt-4 flex flex-wrap gap-2">
              {i.payable && d.card_payments && <button className="btn" disabled={busy === i.id} onClick={() => pay(i.id)}><CreditCard size={15} />{busy === i.id ? 'Opening secure payment…' : `Pay ${money(i.outstanding, i.currency)}`}</button>}
              <button className="btn-ghost" onClick={() => pdf(i.id)}><Download size={15} />Download PDF</button>
              {i.payable && !d.card_payments && hasBank && <button className="btn-ghost" onClick={() => setOpen(open === i.id ? null : i.id)} aria-expanded={open === i.id}><Landmark size={15} />How to pay<ChevronRight size={14} className={`transition ${open === i.id ? 'rotate-90' : ''}`} /></button>}</div>
            {i.payable && d.card_payments && <p className="mt-2 flex items-center gap-1 text-xs text-muted"><ShieldCheck size={12} />Card payments are handled on a secure payment page.</p>}
            {i.payable && !d.card_payments && hasBank && open === i.id && <div className="mt-4 rounded-xl border border-line bg-surface2/50 p-4">
              <div className="mb-1 text-sm font-semibold">Pay by bank transfer</div><p className="mb-2 text-xs text-muted">Use <b className="text-fg">{i.number}</b> as the payment reference so we can match it to your invoice.</p>
              <div className="divide-y divide-line/70">
                <Copyable label="Reference" value={i.number} />
                {a.bank_account_name && <Copyable label="Account name" value={a.bank_account_name} />}{a.bank_name && <Copyable label="Bank" value={a.bank_name} />}
                {a.bank_account_number && <Copyable label="Account number" value={a.bank_account_number} />}{a.bank_routing && <Copyable label="Routing / BSB" value={a.bank_routing} />}
                {a.bank_iban && <Copyable label="IBAN" value={a.bank_iban} />}{a.bank_swift && <Copyable label="SWIFT / BIC" value={a.bank_swift} />}</div>
              {a.payment_instructions && <p className="mt-3 whitespace-pre-wrap border-t border-line pt-3 text-sm text-muted">{a.payment_instructions}</p>}</div>}
            {i.payable && !d.card_payments && !hasBank && <p className="mt-3 text-xs text-muted">To pay this invoice, please contact {a.name}.</p>}
          </div></article>); })}</div>}

    {tab === 'trips' && <div className="space-y-4">
      {d.bookings.length === 0 && <Empty icon={MapPin} title="No trips yet" body="Once a booking is confirmed, your itinerary will appear here." />}
      {d.bookings.map((b: any) => { const n = daysTo(b.travel_start), grouped = new Map<number, any[]>(); for (const it of b.itinerary) grouped.set(it.day_no, [...(grouped.get(it.day_no) ?? []), it]);
        return <article key={b.id} className="card !p-0 overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line bg-surface2/40 p-4 md:p-5">
            <div><div className="flex items-center gap-2 text-lg font-semibold"><MapPin size={17} className="text-accent" />{b.destination || b.reference}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted"><span className="flex items-center gap-1"><CalendarDays size={12} />{nice(b.travel_start)}{b.travel_end ? ` to ${nice(b.travel_end)}` : ''}</span><span className="num">Ref {b.reference}</span></div></div>
            {n > 0 ? <span className="rounded-full bg-info/10 px-2.5 py-1 text-xs font-semibold text-info">Leaves in {n} day{n === 1 ? '' : 's'}</span> : daysTo(b.travel_end ?? b.travel_start) >= 0 ? <span className="rounded-full bg-success/10 px-2.5 py-1 text-xs font-semibold text-success">Under way</span> : <span className="rounded-full bg-surface2 px-2.5 py-1 text-xs font-medium text-muted">Completed</span>}</div>
          <div className="p-4 md:p-5">{b.itinerary.length === 0 ? <p className="text-sm text-muted">Your day-by-day itinerary is being prepared and will appear here soon.</p> :
            <ol className="space-y-5">{[...grouped.entries()].map(([no, items]) => (
              <li key={no} className="relative pl-9"><span className="absolute left-0 top-0 grid h-7 w-7 place-items-center rounded-full bg-accent/15 text-xs font-bold text-accent num">{no}</span><span className="absolute bottom-[-1.25rem] left-[13px] top-8 w-px bg-line" aria-hidden />
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Day {no}{items[0].day_date ? ` · ${nice(items[0].day_date, true)}` : ''}</div>
                <ul className="space-y-2.5">{items.map((it: any, k: number) => <li key={k} className="rounded-lg border border-line p-3"><div className="flex flex-wrap items-baseline justify-between gap-2"><span className="text-sm font-medium">{it.title}</span>{it.start_time && <span className="text-xs text-muted num">{String(it.start_time).slice(0, 5)}</span>}</div>
                  {it.location && <div className="mt-0.5 flex items-center gap-1 text-xs text-muted"><MapPin size={11} />{it.location}</div>}{it.description && <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{it.description}</p>}{!it.confirmed && <span className="mt-1.5 inline-block rounded-full bg-warn/10 px-2 py-0.5 text-[11px] font-medium text-warn">Tentative</span>}</li>)}</ul></li>))}</ol>}</div></article>; })}</div>}

    {tab === 'quotes' && <div className="space-y-3">
      {d.quotes.length === 0 && <Empty icon={Banknote} title="No quotes" body="Quotes your agent sends you will be listed here." />}
      {d.quotes.map((q: any) => <div key={q.quote_no} className="card flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><div className="truncate text-sm font-semibold">{q.title}</div><div className="text-xs text-muted"><span className="num">{q.quote_no}</span>{q.valid_until && ` · valid until ${nice(q.valid_until)}`}</div></div><Pill s={q.status} /></div>)}
      {d.quotes.length > 0 && <p className="rounded-xl bg-surface2/60 p-3 text-xs text-muted">To accept or ask for changes to a quote, use the link in the email we sent you, or send us a message.</p>}</div>}

    {tab === 'payments' && (d.receipts.length === 0 ? <Empty icon={Receipt} title="No payments yet" body="Payments we receive from you will be listed here with their receipt numbers." /> :
      <div className="card !p-0 overflow-hidden"><ul className="divide-y divide-line/70">{d.receipts.map((r: any) => <li key={r.receipt_no} className="flex items-center justify-between gap-3 px-4 py-3"><div className="flex min-w-0 items-center gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-success/10 text-success"><Check size={16} /></span><div className="min-w-0"><div className="text-sm font-medium capitalize">{String(r.method).replace('_', ' ')}</div><div className="text-xs text-muted"><span className="num">{r.receipt_no}</span> · {nice(r.receipt_date)}</div></div></div><div className="text-sm font-semibold num">{money(r.amount, r.currency)}</div></li>)}</ul>
        <div className="flex items-center justify-between border-t border-line bg-surface2/50 px-4 py-3 text-sm"><span className="text-muted">Total paid</span><span className="font-bold num">{paidTotals.map(([c, v]) => money(v, c)).join(' + ')}</span></div></div>)}

    {tab === 'messages' && <div className="space-y-4">
      <div className="card"><div className="mb-0.5 font-semibold">Send us a message</div><p className="mb-3 text-xs text-muted">Questions about a trip, an invoice or a quote? {a.name} will reply here and by email.</p>
        <input className="input mb-2" placeholder="Subject" maxLength={200} value={form.subject} onChange={(e) => { setForm({ ...form, subject: e.target.value }); setSent(false); }} />
        {d.bookings.length > 0 && <select className="input mb-2" value={form.booking_id} onChange={(e) => setForm({ ...form, booking_id: e.target.value })}><option value="">About a trip? (optional)</option>{d.bookings.map((b: any) => <option key={b.id} value={b.id}>{b.destination || b.reference}</option>)}</select>}
        <textarea className="input mb-2" rows={4} maxLength={4000} placeholder="How can we help?" value={form.message} onChange={(e) => { setForm({ ...form, message: e.target.value }); setSent(false); }} />
        <div className="flex items-center justify-between gap-3">{sent ? <span role="status" className="flex items-center gap-1 text-xs text-success"><CheckCircle2 size={13} />Sent. We will reply soon.</span> : <span className="text-xs text-muted">{form.message.length ? `${form.message.length}/4000` : ''}</span>}<button className="btn" disabled={sending || form.subject.trim().length < 3 || form.message.trim().length < 3} onClick={send}><Send size={14} />{sending ? 'Sending…' : 'Send message'}</button></div></div>
      {d.requests.length > 0 && <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted">Your conversations</h2>}
      {d.requests.map((r: any) => <article key={r.id} className="card"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-sm font-semibold">{r.subject}</div>{r.created_at && <div className="text-xs text-muted">Sent {nice(r.created_at)}</div>}</div><Pill s={r.status} /></div>
        <p className="mt-2 whitespace-pre-wrap rounded-lg bg-surface2/60 p-3 text-sm">{r.message}</p>
        {r.response ? <div className="mt-2 flex gap-2.5"><Avatar name={a.name} size={28} /><div className="min-w-0 flex-1 rounded-lg border border-accent/20 bg-accent/10 p-3 text-sm"><div className="mb-1 text-xs text-muted">{a.name}{r.responded_at ? ` · ${nice(r.responded_at)}` : ''}</div><div className="whitespace-pre-wrap">{r.response}</div></div></div> : <p className="mt-2 text-xs text-muted">Waiting for a reply from {a.name}.</p>}</article>)}</div>}
  </>, a);
}
