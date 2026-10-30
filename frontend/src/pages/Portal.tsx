import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Download, Plane, XCircle } from 'lucide-react';
import { Err, Pill } from '../components/ui';
import { ThemeMenuButton } from '../components/ThemeToggle';

const money = (n: number, c: string) => new Intl.NumberFormat('en', { style: 'currency', currency: c }).format(n);
const day = (d: string | null) => (d ? String(d).slice(0, 10) : '');
async function call(token: string, path = '', method = 'GET', body?: unknown) {
  const r = await fetch(`/api/public/portal/${token}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? 'Something went wrong'); return j;
}

/** Client-facing portal and payment page. Standalone: token-only access, no app navigation, no internal data. */
export default function Portal() {
  const { token = '' } = useParams(); const [sp] = useSearchParams(); const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(0);
  const [tab, setTab] = useState('invoices'); const [form, setForm] = useState({ subject: '', message: '', booking_id: '' }); const [sent, setSent] = useState(false);
  const load = () => call(token).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [token]);
  const pay = async (id: number) => { setBusy(id); try { window.location.href = (await call(token, `/invoices/${id}/pay`, 'POST')).url; } catch (e: any) { setErr(e.message); setBusy(0); } };
  const pdf = async (id: number) => { try { window.open((await call(token, `/invoices/${id}/pdf`)).url); } catch (e: any) { setErr(e.message); } };
  const send = async () => {
    try { await call(token, '/requests', 'POST', { subject: form.subject, message: form.message, ...(form.booking_id ? { booking_id: Number(form.booking_id) } : {}) }); setForm({ subject: '', message: '', booking_id: '' }); setSent(true); setErr(''); load(); }
    catch (e: any) { setErr(e.message); }
  };
  const shell = (c: React.ReactNode) => (
    <div className="min-h-screen"><header className="h-14 border-b border-line bg-surface/80 backdrop-blur flex items-center justify-between px-4 md:px-8"><div className="flex items-center gap-2"><div className="h-7 w-7 rounded-lg bg-accent text-accent-ink grid place-items-center"><Plane size={15} /></div><span className="text-sm font-semibold">{d?.agency.name ?? 'Client portal'}</span></div><ThemeMenuButton /></header>
      <div className="max-w-3xl mx-auto p-4 md:p-8">{c}</div></div>);
  if (err && !d) return shell(<div className="card text-center py-12"><XCircle className="mx-auto text-muted mb-3" size={32} /><h1 className="text-xl font-semibold mb-1">Link unavailable</h1><p className="text-muted text-sm">{err}. Please ask your travel agent for a new link.</p></div>);
  if (!d) return shell(<div className="space-y-3"><div className="skeleton h-8 w-2/3" /><div className="skeleton h-40" /></div>);
  const full = d.scope === 'portal', a = d.agency, tabs = full ? ['invoices', 'trips', 'quotes', 'payments', 'messages'] : ['invoices'];
  const hasBank = a.bank_account_number || a.bank_iban || a.payment_instructions;
  return shell(<>
    <h1 className="text-xl font-semibold mb-1">Hello, {d.client.name}</h1>
    <p className="text-sm text-muted mb-5">{full ? 'Your quotes, invoices, itinerary and payments in one place.' : 'View and pay your invoice securely.'}</p>
    {sp.get('paid') && <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 text-success text-sm p-3 mb-4"><CheckCircle2 size={16} /> Thank you — your payment is being confirmed. It can take a minute to show here.</div>}
    <Err e={err} />
    {full && <div className="flex flex-wrap gap-2 mb-4">{tabs.map((t) => <button key={t} className={`capitalize ${tab === t ? 'btn' : 'btn-ghost'}`} onClick={() => setTab(t)}>{t}</button>)}</div>}

    {tab === 'invoices' && <div className="space-y-3">{d.invoices.length === 0 && <div className="card text-muted text-sm">No invoices yet.</div>}
      {d.invoices.map((i: any) => <div key={i.id} className="card">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><span className="num font-semibold">{i.number}</span> <Pill s={i.status} /><div className="text-xs text-muted mt-1">Issued {day(i.issue_date)} · due {day(i.due_date)}</div></div>
          <div className="text-right"><div className="num font-semibold">{money(i.total, i.currency)}</div>{i.outstanding > 0 && <div className="text-xs text-muted">Outstanding <span className="num">{money(i.outstanding, i.currency)}</span></div>}</div></div>
        <div className="flex flex-wrap gap-2 mt-3"><button className="btn-ghost" onClick={() => pdf(i.id)}><Download size={14} /> PDF</button>
          {i.payable && d.card_payments && <button className="btn" disabled={busy === i.id} onClick={() => pay(i.id)}>Pay {money(i.outstanding, i.currency)}</button>}</div>
        {i.payable && !d.card_payments && hasBank && <div className="text-xs text-muted mt-3 border-t border-line pt-3"><b className="text-fg">Pay by bank transfer</b> quoting {i.number}:{a.bank_account_name && <div>Account name: {a.bank_account_name}</div>}{a.bank_name && <div>Bank: {a.bank_name}</div>}{a.bank_account_number && <div>Account: <span className="num">{a.bank_account_number}</span> {a.bank_routing && <>· Routing/BSB: <span className="num">{a.bank_routing}</span></>}</div>}{a.bank_iban && <div>IBAN: <span className="num">{a.bank_iban}</span></div>}{a.payment_instructions && <div>{a.payment_instructions}</div>}</div>}
      </div>)}</div>}

    {tab === 'trips' && <div className="space-y-3">{d.bookings.length === 0 && <div className="card text-muted text-sm">No confirmed trips yet.</div>}
      {d.bookings.map((b: any) => <div key={b.id} className="card"><div className="font-semibold">{b.destination || b.reference} <span className="text-xs text-muted num">{b.reference}</span></div><div className="text-xs text-muted mb-2">{day(b.travel_start)} – {day(b.travel_end)}</div>
        {b.itinerary.length === 0 ? <div className="text-sm text-muted">Itinerary coming soon.</div> : <ol className="space-y-2">{b.itinerary.map((it: any, n: number) => <li key={n} className="text-sm"><span className="text-muted num text-xs">Day {it.day_no}{it.day_date ? ` · ${day(it.day_date)}` : ''}{it.start_time ? ` · ${String(it.start_time).slice(0, 5)}` : ''}</span><div className="font-medium">{it.title}{it.confirmed ? '' : <span className="text-xs text-warn ml-2">tentative</span>}</div>{it.location && <div className="text-xs text-muted">{it.location}</div>}{it.description && <div className="text-muted">{it.description}</div>}</li>)}</ol>}</div>)}</div>}

    {tab === 'quotes' && <div className="space-y-2">{d.quotes.length === 0 && <div className="card text-muted text-sm">No quotes.</div>}{d.quotes.map((q: any) => <div key={q.quote_no} className="card flex justify-between items-center"><div><span className="num font-medium">{q.quote_no}</span> · {q.title}{q.valid_until && <div className="text-xs text-muted">Valid until {day(q.valid_until)}</div>}</div><Pill s={q.status} /></div>)}<p className="text-xs text-muted">To accept or change a quote, use the link in the email we sent you, or send us a message.</p></div>}

    {tab === 'payments' && <div className="card p-0 overflow-hidden"><table className="w-full text-sm"><tbody>{d.receipts.length === 0 && <tr><td className="p-4 text-muted">No payments recorded yet.</td></tr>}{d.receipts.map((r: any) => <tr key={r.receipt_no} className="border-b border-line last:border-0"><td className="p-3 num">{r.receipt_no}</td><td className="p-3">{day(r.receipt_date)}</td><td className="p-3 capitalize">{r.method.replace('_', ' ')}</td><td className="p-3 text-right num">{money(r.amount, r.currency)}</td></tr>)}</tbody></table></div>}

    {tab === 'messages' && <div className="space-y-4">
      <div className="card"><div className="font-medium mb-2">Send us a message</div>
        <input className="input mb-2" placeholder="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        {d.bookings.length > 0 && <select className="input mb-2" value={form.booking_id} onChange={(e) => setForm({ ...form, booking_id: e.target.value })}><option value="">About… (optional)</option>{d.bookings.map((b: any) => <option key={b.id} value={b.id}>{b.destination || b.reference}</option>)}</select>}
        <textarea className="input mb-2" rows={4} placeholder="How can we help?" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
        <div className="flex items-center justify-between">{sent ? <span className="text-xs text-success">Sent — we'll reply soon.</span> : <span />}<button className="btn" disabled={form.subject.trim().length < 3 || form.message.trim().length < 3} onClick={send}>Send</button></div></div>
      {d.requests.map((r: any) => <div key={r.id} className="card"><div className="flex justify-between"><b>{r.subject}</b><Pill s={r.status} /></div><p className="text-sm text-muted mt-1 whitespace-pre-wrap">{r.message}</p>{r.response && <div className="mt-2 rounded-lg bg-accent/10 border border-accent/20 p-3 text-sm whitespace-pre-wrap"><div className="text-xs text-muted mb-1">Reply from {a.name}</div>{r.response}</div>}</div>)}</div>}
    <p className="text-xs text-muted mt-8 text-center">Private link — please don't share it.</p>
  </>);
}
