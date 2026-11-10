import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Copy, Mail, MessageSquareText, Send, Sparkles, WandSparkles } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ClientPick } from './ClientPick';
import { Err, Field, Modal, Skeleton } from './ui';

type AiState = { available: boolean; reason: 'not_configured' | 'off' | 'plan' | 'limit' | null; message: string | null; used: number; limit: number };

/** Shown in place of a feature when the agency cannot use it, with the reason and, for a plan limit, the way to fix it. */
function Unavailable({ s, onClose }: { s: AiState; onClose(): void }) {
  const nav = useNavigate();
  return <div className="text-sm"><div className="flex gap-3 rounded-lg border border-line bg-surface2/60 p-4"><Sparkles size={18} className="mt-0.5 shrink-0 text-muted" /><p>{s.message}</p></div>
    <div className="mt-4 flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Close</button>{s.reason === 'plan' && <button className="btn" onClick={() => { onClose(); nav('/billing'); }}>See plans</button>}</div></div>;
}
const Usage = ({ s }: { s: AiState }) => <p className="mt-3 text-xs text-muted">{s.used} of {s.limit} AI requests used this month. The assistant drafts and answers — nothing is saved or sent until you do it.</p>;

const TOOL_LABEL: Record<string, string> = { unpaid_invoices: 'unpaid invoices', invoiced_totals: 'invoice totals', trip_results: 'trip results', upcoming_trips: 'upcoming trips', supplier_bills_due: 'supplier bills' };
const EXAMPLES = ['Who owes me money for more than 30 days?', 'Which trips leave in the next 2 weeks?', 'How much did we invoice each month this year?', 'What do we still owe suppliers?'];

function Ask({ s, onUsed }: { s: AiState; onUsed(): void }) {
  const [q, setQ] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [a, setA] = useState<{ question: string; answer: string; used: string[] } | null>(null);
  const go = async (text = q) => {
    if (text.trim().length < 3 || busy) return; setBusy(true); setErr(''); setA(null); setQ(text);
    try { const r = await api('/ai/ask', 'POST', { question: text.trim() }); setA({ question: text.trim(), ...r }); onUsed(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <div>
    <p className="mb-3 text-sm text-muted">Ask about your own records in plain words. The assistant looks things up; it can’t change anything.</p>
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); go(); }}>
      <input className="input flex-1" autoFocus aria-label="Your question" placeholder="e.g. Who owes me money for more than 30 days?" maxLength={500} value={q} onChange={(e) => setQ(e.target.value)} />
      <button className="btn inline-flex items-center gap-1" disabled={busy || q.trim().length < 3}><Send size={15} />Ask</button></form>
    {!a && !busy && <div className="mt-3 flex flex-wrap gap-2">{EXAMPLES.map((x) => <button key={x} type="button" className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:bg-surface2 hover:text-fg" onClick={() => go(x)}>{x}</button>)}</div>}
    <div role="status" aria-live="polite" className="mt-4">
      <Err e={err} />
      {busy && <div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /><p className="text-xs text-muted">Looking through your records…</p></div>}
      {a && <div className="rounded-lg border border-line bg-surface2/50 p-4"><div className="text-xs text-muted">{a.question}</div><p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{a.answer}</p>
        {a.used.length > 0 && <p className="mt-3 text-xs text-muted">Looked at: {[...new Set(a.used)].map((u) => TOOL_LABEL[u] ?? u).join(', ')}</p>}</div>}
    </div>
    <Usage s={s} /></div>;
}

const KINDS: { key: string; label: string; needs?: 'quote' | 'booking' }[] = [
  { key: 'payment_reminder', label: 'Payment reminder' }, { key: 'quote_followup', label: 'Quote follow-up', needs: 'quote' }, { key: 'trip_reminder', label: 'Trip reminder', needs: 'booking' }, { key: 'custom', label: 'Something else' },
];

function Write({ s, clientId, onUsed }: { s: AiState; clientId?: number; onUsed(): void }) {
  const [clients, setClients] = useState<any[]>([]); const [cid, setCid] = useState(clientId ? String(clientId) : ''); const [kind, setKind] = useState('payment_reminder'); const [tone, setTone] = useState('friendly');
  const [quotes, setQuotes] = useState<any[]>([]); const [bookings, setBookings] = useState<any[]>([]); const [ref, setRef] = useState(''); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [out, setOut] = useState<{ subject: string; body: string } | null>(null); const [copied, setCopied] = useState(false);
  const k = KINDS.find((x) => x.key === kind)!;
  useEffect(() => { api('/clients').then(setClients).catch(() => {}); }, []);
  useEffect(() => {
    setRef(''); setQuotes([]); setBookings([]); if (!cid) return;
    if (k.needs === 'quote') api('/quotes').then((r) => setQuotes(r.filter((x: any) => String(x.client_id) === cid))).catch(() => {});
    if (k.needs === 'booking') api('/bookings').then((r) => setBookings(r.filter((x: any) => String(x.client_id) === cid))).catch(() => {});
  }, [cid, kind]);
  const client = clients.find((c) => String(c.id) === cid);
  const ready = !!cid && (!k.needs || !!ref) && !busy;
  const go = async () => {
    setBusy(true); setErr(''); setOut(null);
    try { const r = await api('/ai/draft-message', 'POST', { kind, tone, client_id: Number(cid), quote_id: k.needs === 'quote' ? Number(ref) : undefined, booking_id: k.needs === 'booking' ? Number(ref) : undefined, instructions: note.trim() || undefined }); setOut(r); onUsed(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const copy = async () => { if (!out) return; try { await navigator.clipboard.writeText(`${out.subject}\n\n${out.body}`); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* the text stays selectable */ } };
  const mailto = out && client?.email ? `mailto:${client.email}?subject=${encodeURIComponent(out.subject)}&body=${encodeURIComponent(out.body)}` : '';
  return <div>
    <p className="mb-3 text-sm text-muted">The assistant writes a first draft from your records. Read and edit it, then send it yourself.</p>
    <div className="grid gap-x-4 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Client"><ClientPick clients={clients} value={cid} onChange={setCid} autoFocus={!clientId} /></Field></div>
      <Field label="What for"><select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></Field>
      <Field label="Tone"><select className="input" value={tone} onChange={(e) => setTone(e.target.value)}><option value="friendly">Friendly</option><option value="formal">Formal</option><option value="firm">Firm</option></select></Field>
      {k.needs && <div className="sm:col-span-2"><Field label={k.needs === 'quote' ? 'Which quote' : 'Which trip'} hint={cid && !(k.needs === 'quote' ? quotes : bookings).length ? `This client has no ${k.needs === 'quote' ? 'quotes' : 'bookings'} yet.` : undefined}>
        <select className="input" value={ref} onChange={(e) => setRef(e.target.value)}><option value="">Choose…</option>{k.needs === 'quote' ? quotes.map((x) => <option key={x.id} value={x.id}>{x.quote_no} — {x.title}</option>) : bookings.map((x) => <option key={x.id} value={x.id}>{x.reference} — {x.destination}</option>)}</select></Field></div>}
      <div className="sm:col-span-2"><Field label={kind === 'custom' ? 'What should it say?' : 'Anything to add? (optional)'} hint="e.g. “mention the new payment deadline”"><textarea className="input" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div></div>
    <div className="mb-3 flex justify-end"><button className="btn inline-flex items-center gap-1" disabled={!ready || (kind === 'custom' && !note.trim())} onClick={go}><WandSparkles size={15} />{busy ? 'Writing…' : out ? 'Write again' : 'Write draft'}</button></div>
    <div role="status" aria-live="polite"><Err e={err} />
      {out && <div className="rounded-lg border border-line bg-surface2/50 p-3"><Field label="Subject"><input className="input" value={out.subject} onChange={(e) => setOut({ ...out, subject: e.target.value })} /></Field>
        <Field label="Message"><textarea className="input" rows={9} value={out.body} onChange={(e) => setOut({ ...out, body: e.target.value })} /></Field>
        <div className="flex flex-wrap justify-end gap-2"><button className="btn-ghost inline-flex items-center gap-1" onClick={copy}><Copy size={14} />{copied ? 'Copied' : 'Copy'}</button>
          {mailto ? <a className="btn inline-flex items-center gap-1" href={mailto}><Mail size={14} />Open in my email</a> : <span className="self-center text-xs text-warn">This client has no email address.</span>}</div></div>}</div>
    <Usage s={s} /></div>;
}

/** The assistant window: ask about the books (finance roles) and write client messages. */
export function AiPanel({ onClose, tab: first = 'ask', clientId }: { onClose(): void; tab?: 'ask' | 'write'; clientId?: number }) {
  const { can } = useAuth(); const finance = can('admin', 'finance_manager'); const [s, setS] = useState<AiState | null>(null); const [tab, setTab] = useState<'ask' | 'write'>(finance ? first : 'write');
  const refresh = () => api('/ai/status').then(setS).catch(() => {});
  useEffect(() => { refresh(); }, []);
  return <Modal title="AI assistant" wide onClose={onClose}>
    {!s ? <Skeleton className="h-40" /> : !s.available ? <Unavailable s={s} onClose={onClose} /> : <>
      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
        {finance && <button role="tab" aria-selected={tab === 'ask'} onClick={() => setTab('ask')} className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm ${tab === 'ask' ? 'border-b-2 border-accent font-medium text-accent' : 'text-muted hover:text-fg'}`}><Sparkles size={14} />Ask your records</button>}
        <button role="tab" aria-selected={tab === 'write'} onClick={() => setTab('write')} className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm ${tab === 'write' ? 'border-b-2 border-accent font-medium text-accent' : 'text-muted hover:text-fg'}`}><MessageSquareText size={14} />Write a message</button></div>
      {tab === 'ask' && finance ? <Ask s={s} onUsed={refresh} /> : <Write s={s} clientId={clientId} onUsed={refresh} />}</>}
  </Modal>;
}

/** Header button that opens the assistant. Hidden for read-only users. */
export function AiButton() {
  const { can } = useAuth(); const [open, setOpen] = useState(false);
  if (!can('admin', 'finance_manager', 'agent')) return null;
  return <><button className="btn-icon hidden sm:inline-flex" onClick={() => setOpen(true)} aria-label="AI assistant" title="AI assistant"><Sparkles size={18} /></button>{open && createPortal(<AiPanel onClose={() => setOpen(false)} />, document.body)}</>;   // portalled: the header is blurred, which would trap a fixed overlay inside it
}

/** Quotes → "From an enquiry": paste what the client wrote, get a draft quote to review in the normal editor. */
export function EnquiryModal({ onClose }: { onClose(): void }) {
  const nav = useNavigate(); const [s, setS] = useState<AiState | null>(null); const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { api('/ai/status').then(setS).catch(() => {}); }, []);
  const go = async () => {
    setBusy(true); setErr('');
    try { const r = await api('/ai/quote-draft', 'POST', { text }); onClose(); nav('/quotes/new', { state: { aiDraft: r } }); } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return <Modal title="Quote from an enquiry" wide onClose={onClose}>
    {!s ? <Skeleton className="h-40" /> : !s.available ? <Unavailable s={s} onClose={onClose} /> : <>
      <p className="mb-3 text-sm text-muted">Paste the client’s email or WhatsApp message. The assistant fills in a draft quote — client, dates, travellers and services. <b>It never sets prices</b>; you add those, then review and send as usual.</p>
      <Err e={err} />
      <textarea className="input" rows={9} autoFocus aria-label="The client's enquiry" maxLength={6000} placeholder="Hi, we're a family of 4 looking at Dubai for 5 nights in June. Flights from Karachi, a hotel near the beach, and an airport transfer if possible…" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-1 text-right text-xs text-muted">{text.length} / 6000</div>
      <div className="mt-3 flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn inline-flex items-center gap-1" disabled={busy || text.trim().length < 15} onClick={go}><WandSparkles size={15} />{busy ? 'Reading the enquiry…' : 'Create draft quote'}</button></div>
      <Usage s={s} /></>}
  </Modal>;
}
