import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, CheckCircle2, Copy, MessageSquareWarning, Plus, Save, Search, Send, Sparkles, X, type LucideIcon } from 'lucide-react';
import { EnquiryModal } from '../components/AiAssistant';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { ClientPick } from '../components/ClientPick';
import { Avatar, Err, Field, Modal, Num, Page, Pill, Skeleton, Table } from '../components/ui';
import { today, useList, useOpenOnNew } from '../lookup';

const TYPES = ['flight', 'hotel', 'package', 'cruise', 'transfer', 'tour', 'rail', 'car', 'insurance', 'visa', 'fee', 'other'];
const LABEL: Record<string, string> = { draft: 'Not sent to the client yet', sent: 'Waiting for the client to reply', accepted: 'Ready to turn into a booking', converted: 'Turned into a booking', declined: 'The client said no', expired: 'Past its valid-until date', changes_requested: 'See the client’s message below' };
const r2 = (n: number) => Math.round(n * 100) / 100;
const day = (d: any) => (d ? String(d).slice(0, 10) : '');
const daysFrom = (d: any) => Math.round((Date.parse(day(d)) - Date.parse(today())) / 864e5);
const nice = (d: any) => (d ? new Date(`${day(d)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** A sent quote past its valid-until date is expired even though the stored status still says "sent". */
const shown = (r: any) => (r.status === 'sent' && r.valid_until && day(r.valid_until) < today() ? 'expired' : r.status);
// mirrors backend priceComponent
const price = (c: any) => { const up = r2(Number(c.unit_cost) * (1 + Number(c.markup_pct) / 100)); const net = r2(up * Number(c.quantity) * (1 - Number(c.discount_pct) / 100)); return { net, tax: r2(net * Number(c.tax_rate) / 100), cost: r2(Number(c.unit_cost) * Number(c.quantity)) }; };
const pct = (net: number, cost: number) => (net > 0 ? ((net - cost) / net) * 100 : null);

const TABS: { key: string; label: string; test: (r: any) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'draft', label: 'Drafts', test: (r) => shown(r) === 'draft' },
  { key: 'waiting', label: 'With the client', test: (r) => shown(r) === 'sent' },
  { key: 'changes', label: 'Changes requested', test: (r) => r.status === 'changes_requested' },
  { key: 'accepted', label: 'Ready to book', test: (r) => r.status === 'accepted' },
  { key: 'booked', label: 'Booked', test: (r) => r.status === 'converted' },
  { key: 'closed', label: 'Declined / expired', test: (r) => ['declined', 'expired'].includes(shown(r)) },
];

const Banner = ({ ok, children, onClose }: { ok: boolean; children: any; onClose?(): void }) => (
  <div role={ok ? 'status' : 'alert'} className={`rounded-lg border text-sm px-3 py-2 mb-3 flex justify-between gap-3 ${ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>
    <span>{children}</span>{onClose && <button className="opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={onClose}><X size={14} /></button>}</div>
);

export function QuoteList() {
  const nav = useNavigate(); const { can } = useAuth(); const [sp] = useSearchParams();
  const [rows, setRows] = useState<any[] | null>(null); const [err, setErr] = useState('');
  const [tab, setTab] = useState(TABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab')! : 'all'); const [q, setQ] = useState('');
  const editor = can('admin', 'finance_manager', 'agent'); const [enquiry, setEnquiry] = useState(false);
  const load = () => api('/quotes').then((r) => { setRows(r); setErr(''); }).catch((e) => { setErr(e.message); setRows([]); });
  useEffect(() => { load(); }, []);
  useOpenOnNew(() => nav('/quotes/new'));

  const all = rows ?? [];
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, all.filter(t.test).length])), [rows]);
  const list = useMemo(() => { const s = q.trim().toLowerCase(); return all.filter(TABS.find((t) => t.key === tab)!.test).filter((r) => !s || [r.quote_no, r.title, r.client_name, r.lead_name].some((v) => String(v ?? '').toLowerCase().includes(s))); }, [rows, tab, q]);
  const waiting = all.filter(TABS[2].test), expiring = waiting.filter((r) => r.valid_until && daysFrom(r.valid_until) <= 7);
  const convert = async (r: any) => { try { const x = await api(`/quotes/${r.id}/convert`, 'POST'); nav(`/bookings/${x.booking_id}`); } catch (e: any) { setErr(`${r.quote_no}: ${e.message}`); } };
  const stat = (key: string, title: string, value: string, sub: string, Icon: LucideIcon, tone = '') => {
    const t = tone.includes('success') ? ['border-l-4 !border-l-success', 'bg-success/10 text-success'] : tone ? ['border-l-4 !border-l-warn', 'bg-warn/10 text-warn'] : ['', 'bg-accent/10 text-accent'];
    return (<button type="button" aria-pressed={tab === key} onClick={() => setTab(key)} className={`card text-left hover:bg-surface2/70 transition-colors ${t[0]} ${tab === key ? 'ring-2 ring-accent' : ''}`}>
      <div className="flex items-start justify-between gap-2"><div className="text-xs font-medium text-muted">{title}</div><span className={`h-7 w-7 rounded-lg grid place-items-center shrink-0 ${t[1]}`}><Icon size={15} /></span></div>
      <div className={`text-2xl font-semibold num mt-1 ${tone}`}>{value}</div><div className="text-xs text-muted mt-0.5 truncate">{sub}</div></button>); };

  return (
    <Page title="Quotes" description="Price a trip, send it to the client, and turn it into a booking once they accept. Click any quote to open it."
      actions={editor ? <div className="flex flex-wrap gap-2"><button className="btn-ghost inline-flex items-center gap-1" onClick={() => setEnquiry(true)}><Sparkles size={16} />From an enquiry</button><button className="btn inline-flex items-center gap-1" onClick={() => nav('/quotes/new')}><Plus size={16} />New quote</button></div> : undefined}>
      {enquiry && <EnquiryModal onClose={() => setEnquiry(false)} />}
      {rows === null ? <div className="grid sm:grid-cols-3 gap-3 mb-4"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div> : (
        <div className="grid sm:grid-cols-3 gap-3 mb-4">
          {stat('waiting', 'With the client', String(waiting.length), expiring.length ? `${plural(expiring.length, 'quote')} expire within 7 days` : waiting.length ? 'Waiting for a reply' : 'Nothing waiting', Send, expiring.length ? 'text-warn' : '')}
          {stat('changes', 'Client asked for changes', String(counts.changes), counts.changes ? 'Revise and send again' : 'No requests', MessageSquareWarning, counts.changes ? 'text-warn' : '')}
          {stat('accepted', 'Accepted — ready to book', String(counts.accepted), counts.accepted ? 'Turn these into bookings' : 'Nothing to book yet', CheckCircle2, counts.accepted ? 'text-success' : '')}
        </div>)}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1 basis-full min-w-0" role="tablist" aria-label="Quote views">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
              className={`whitespace-nowrap text-sm px-3 py-1.5 rounded-lg border ${tab === t.key ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>
              {t.label}{rows && t.key !== 'all' && <span className="ml-1.5 text-xs opacity-70 num">{counts[t.key]}</span>}</button>))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input className="input pl-8" placeholder="Search number, title or client…" aria-label="Search quotes" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <Err e={err} />
      {rows === null ? <Skeleton className="h-64" /> : (
        <Table rows={list} noun="quotes" onRow={(r) => nav(`/quotes/${r.id}`)}
          empty={all.length === 0 ? (editor ? 'No quotes yet — click “New quote” to price your first trip.' : 'No quotes yet.') : `Nothing in “${TABS.find((t) => t.key === tab)!.label}”${q ? ` matching “${q}”` : ''}.`}
          cols={[
            { h: 'Quote', render: (r) => <><span className="num font-semibold">{r.quote_no}</span>{r.current_version > 1 && <span className="text-xs text-muted ml-1">v{r.current_version}</span>}<div className="text-xs text-muted truncate max-w-[16rem]">{r.title}</div></> },
            { h: 'For', render: (r) => { const n = r.client_name ?? r.lead_name; return n ? <div className="flex items-center gap-2.5 min-w-0"><Avatar name={n} size={28} /><div className="min-w-0"><div className="truncate">{n}</div>{!r.client_name && <div className="text-xs text-muted">Lead</div>}</div></div> : <span className="text-muted">—</span>; } },
            { h: 'Status', render: (r) => <Pill s={shown(r)} /> },
            { h: 'Valid until', render: (r) => { if (!r.valid_until) return <span className="text-muted">Not set</span>; const n = daysFrom(r.valid_until), live = r.status === 'sent'; return <><span className="num">{day(r.valid_until)}</span>{live && <div className={`text-xs ${n < 0 ? 'text-danger' : n <= 7 ? 'text-warn' : 'text-muted'}`}>{n < 0 ? `expired ${-n} day${n === -1 ? '' : 's'} ago` : n === 0 ? 'expires today' : `${n} day${n === 1 ? '' : 's'} left`}</div>}</>; } },
            { h: 'Price from', right: true, render: (r) => (r.from_total != null ? <span className="font-medium">{money(r.from_total, r.currency)}</span> : <span className="text-muted">No price yet</span>) },
            { h: 'Margin', right: true, render: (r) => (r.margin_pct != null ? <span className={r.margin_pct < 0 ? 'text-danger font-medium' : r.margin_pct < 10 ? 'text-warn' : ''}>{r.margin_pct}%</span> : '—') },
            { h: '', render: (r) => <div className="flex gap-1 justify-end whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
              {editor && r.status === 'accepted' && <button className="btn" onClick={() => convert(r)}>Create booking</button>}
              {r.booking_id && <button className="btn-ghost" onClick={() => nav(`/bookings/${r.booking_id}`)}>Open booking</button>}
              {editor && r.status === 'changes_requested' && <button className="btn-ghost" onClick={() => nav(`/quotes/${r.id}`)}>Revise</button>}</div> }]} />
      )}
      {rows && rows.length >= 500 && <p className="text-xs text-muted mt-2">Showing the latest 500 quotes.</p>}
    </Page>
  );
}

let seq = 0; const key = () => `k${++seq}`;
const line = (k: string): any => ({ _k: k, _lk: key(), product_type: 'hotel', description: '', quantity: 1, unit_cost: 0, markup_pct: 15, discount_pct: 0, tax_rate: 0, supplier_id: '', service_start: '', service_end: '' });
/** A quote pre-filled from the AI assistant's draft (see components/AiAssistant). Prices are left at zero for the agent. */
const fromAi = (base: any, r: any) => {
  const d = r.draft; const opts = (d.options as string[]).map((name) => ({ k: key(), name }));
  return { ...base, title: d.title, client_id: d.client_id ? String(d.client_id) : '', currency: d.currency, valid_until: d.valid_until ?? '', inclusions: d.inclusions, exclusions: d.exclusions, internal_notes: [d.internal_notes, r.client_guess ? `Client named in the enquiry: ${r.client_guess}` : '', r.missing?.length ? `To confirm with the client: ${r.missing.join('; ')}` : ''].filter(Boolean).join('\n'),
    opts, components: d.components.map((c: any) => ({ ...line(opts.find((o) => o.name === c.option_name)!.k), product_type: c.product_type, description: c.description, quantity: c.quantity, service_start: c.service_start, service_end: c.service_end })) };
};
const blankQuote = (sp: URLSearchParams, cur: string) => { const k = key(); return { title: '', client_id: sp.get('client') ?? '', lead_id: sp.get('lead') ? Number(sp.get('lead')) : null, currency: cur, valid_until: '', inclusions: '', exclusions: '', payment_terms: '', cancellation_terms: '', internal_notes: '', opts: [{ k, name: 'Option 1' }], components: [line(k)] }; };

export function QuoteEditor() {
  const { id } = useParams(); const [sp] = useSearchParams(); const nav = useNavigate(); const { can, agency } = useAuth();
  const clients = useList('/clients'); const suppliers = useList('/suppliers');
  const isNew = id === 'new'; const finance = can('admin', 'finance_manager'); const editor = can('admin', 'finance_manager', 'agent');
  const ai = (useLocation().state as any)?.aiDraft;                       // set when the agent came from "From an enquiry"
  const [q, setQ] = useState<any>(() => { const b = blankQuote(sp, agency?.base_currency ?? 'USD'); return ai ? fromAi(b, ai) : b; }); const [snap, setSnap] = useState(() => JSON.stringify(blankQuote(sp, agency?.base_currency ?? 'USD')));
  const [meta, setMeta] = useState<any>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [sent, setSent] = useState<any>(null); const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false); const [accepting, setAccepting] = useState<any>(null); const [minMargin, setMinMargin] = useState<number | null>(null); const [lead, setLead] = useState<any>(null);

  useEffect(() => { api('/admin/settings').then((s) => setMinMargin(s.min_margin_pct ?? null)).catch(() => {}); }, []);
  useEffect(() => { if (q.lead_id && !q.client_id) api(`/leads/${q.lead_id}`).then(setLead).catch(() => setLead(null)); else setLead(null); }, [q.lead_id, q.client_id]);
  const fromServer = (d: any) => {
    const names = [...new Set(d.components.map((c: any) => c.option_name))] as string[]; const opts = names.map((name) => ({ k: key(), name }));
    return { title: d.title, client_id: d.client_id ? String(d.client_id) : '', lead_id: d.lead_id, currency: d.currency, valid_until: day(d.valid_until), inclusions: d.inclusions ?? '', exclusions: d.exclusions ?? '', payment_terms: d.payment_terms ?? '', cancellation_terms: d.cancellation_terms ?? '', internal_notes: d.internal_notes ?? '',
      opts, components: d.components.map((c: any) => ({ ...c, _k: opts.find((o) => o.name === c.option_name)!.k, _lk: key(), supplier_id: c.supplier_id ?? '', service_start: day(c.service_start), service_end: day(c.service_end) })) };
  };
  const load = async () => { if (isNew) return; try { const d = await api(`/quotes/${id}`); const next = fromServer(d); setMeta(d); setQ(next); setSnap(JSON.stringify(next)); } catch (e: any) { setErr(e.message); } };
  useEffect(() => { load(); }, [id]);
  const dirty = JSON.stringify(q) !== snap;
  useEffect(() => { if (!dirty) return; const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h); }, [dirty]);

  const locked = !!meta && meta.status === 'converted'; const readOnly = locked || !editor;
  const status = meta ? shown(meta) : 'draft';
  const totals = q.opts.map((o: any) => { const cs = q.components.filter((c: any) => c._k === o.k); const t = cs.reduce((s: any, c: any) => { const p = price(c); return { net: s.net + p.net, tax: s.tax + p.tax, cost: s.cost + p.cost }; }, { net: 0, tax: 0, cost: 0 }); return { ...o, ...t, total: r2(t.net + t.tax), margin: pct(t.net, t.cost) }; });
  const lowest = totals.map((t: any) => t.margin).filter((m: any) => m !== null) as number[]; const low = lowest.length ? Math.min(...lowest) : null;
  const belowMin = minMargin !== null && low !== null && low < minMargin;
  const names = q.opts.map((o: any) => o.name.trim().toLowerCase());
  const problem = !q.title.trim() ? 'Give the quote a title.' : names.some((n: string) => !n) ? 'Every option needs a name.' : new Set(names).size !== names.length ? 'Two options have the same name.'
    : q.components.some((c: any) => !String(c.description).trim()) ? 'Every line needs a description.' : q.components.some((c: any) => !(Number(c.quantity) > 0)) ? 'Quantities must be more than zero.'
    : q.components.some((c: any) => c.service_start && c.service_end && c.service_end < c.service_start) ? 'A line ends before it starts.' : q.currency.length !== 3 ? 'Currency must be a 3-letter code.' : '';

  const setC = (k: string, f: string, v: any) => setQ({ ...q, components: q.components.map((c: any) => (c._lk === k ? { ...c, [f]: v } : c)) });
  const addLine = (k: string) => setQ({ ...q, components: [...q.components, line(k)] });
  const removeLine = (lk: string) => setQ({ ...q, components: q.components.filter((c: any) => c._lk !== lk) });
  const addOption = () => { const k = key(); setQ({ ...q, opts: [...q.opts, { k, name: `Option ${q.opts.length + 1}` }], components: [...q.components, line(k)] }); };
  const copyOption = (o: any) => { const k = key(); setQ({ ...q, opts: [...q.opts, { k, name: `${o.name} (copy)` }], components: [...q.components, ...q.components.filter((c: any) => c._k === o.k).map((c: any) => ({ ...c, id: undefined, _k: k, _lk: key() }))] }); };
  const removeOption = (o: any) => setQ({ ...q, opts: q.opts.filter((x: any) => x.k !== o.k), components: q.components.filter((c: any) => c._k !== o.k) });

  const body = () => ({ title: q.title.trim(), client_id: q.client_id ? Number(q.client_id) : null, lead_id: q.lead_id ?? null, currency: q.currency, valid_until: q.valid_until || null,
    inclusions: q.inclusions || null, exclusions: q.exclusions || null, payment_terms: q.payment_terms || null, cancellation_terms: q.cancellation_terms || null, internal_notes: q.internal_notes || null,
    components: q.opts.flatMap((o: any) => q.components.filter((c: any) => c._k === o.k).map((c: any) => ({ option_name: o.name.trim(), product_type: c.product_type, supplier_id: c.supplier_id ? Number(c.supplier_id) : null, description: String(c.description).trim(), quantity: Number(c.quantity), unit_cost: Number(c.unit_cost), markup_pct: Number(c.markup_pct), discount_pct: Number(c.discount_pct), tax_rate: Number(c.tax_rate), service_start: c.service_start || null, service_end: c.service_end || null }))) });
  /** Saves and returns a message describing what happened. */
  const persist = async (): Promise<string> => {
    if (isNew) { const r = await api('/quotes', 'POST', body()); setSnap(JSON.stringify(q)); nav(`/quotes/${r.id}`, { replace: true }); return 'Quote created.'; }
    const r = await api(`/quotes/${id}`, 'PUT', body());
    return r.version !== meta.current_version ? `Saved as version ${r.version}. Because the previous version was already sent, this one is back to draft and the old client link no longer works — send it again when ready.` : 'Changes saved.';
  };
  const act = async (fn: () => Promise<string | void>) => { setBusy(true); try { const m = await fn(); setErr(''); setMsg(m || ''); await load(); } catch (e: any) { setErr(e.message); setMsg(''); } finally { setBusy(false); } };
  const save = () => act(persist);
  const send = () => act(async () => {
    const saved = dirty; if (dirty) await persist();
    const r = await api(`/quotes/${id}/send`, 'POST', { email: true }); setSent(r); setCopied(false);
    return `${saved ? 'Changes saved and quote' : 'Quote'} sent${r.emailed ? ' — the client has been emailed' : ''}. It is valid until ${nice(r.valid_until)}.`;
  });
  const copy = async () => { try { await navigator.clipboard.writeText(sent.link); setCopied(true); } catch { setCopied(false); } };
  const client = clients.find((c: any) => String(c.id) === String(q.client_id));

  if (!isNew && !meta) return <Page title="Quote">{err ? <Err e={err} /> : <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>}</Page>;
  const cell = 'lg:grid-cols-[6.5rem_9rem_minmax(0,1fr)_8.5rem_8.5rem_4.5rem_6rem_4.5rem_4.5rem_4.5rem_6.5rem_2rem]';
  const L = ({ t }: { t: string }) => <span className="lg:hidden block text-[11px] text-muted mb-0.5">{t}</span>;
  const canSend = !isNew && !locked && editor && !problem;

  return (
    <Page title={isNew ? 'New quote' : `${meta.quote_no}${meta.current_version > 1 ? ` · version ${meta.current_version}` : ''}`} description={isNew ? 'Add one or more options for the client to choose from, then save and send.' : q.title}
      actions={<>
        <button className="btn-ghost" onClick={() => nav('/quotes')}>← Quotes</button>
        {!readOnly && <button className={dirty || isNew ? 'btn inline-flex items-center gap-1' : 'btn-ghost inline-flex items-center gap-1'} onClick={save} disabled={busy || !!problem || (!dirty && !isNew)}><Save size={15} />{isNew ? 'Create quote' : dirty ? 'Save changes' : 'Saved'}</button>}
        {canSend && <button className="btn inline-flex items-center gap-1" disabled={busy || (belowMin && !meta.margin_approved_by)} title={belowMin && !meta.margin_approved_by ? 'The margin needs approval first' : undefined} onClick={send}><Send size={15} />{meta.status === 'sent' ? 'Send again' : dirty ? 'Save & send' : 'Send to client'}</button>}
        {!isNew && editor && meta.status === 'sent' && status !== 'expired' && <button className="btn-ghost" onClick={() => setAccepting({ option: meta.options[0]?.option ?? '', name: client?.name ?? lead?.name ?? '' })}>Client accepted…</button>}
        {!isNew && editor && meta.status === 'accepted' && <button className="btn" disabled={busy || !meta.client_id} title={!meta.client_id ? 'Link the quote to a client first' : undefined} onClick={() => act(async () => { const r = await api(`/quotes/${id}/convert`, 'POST'); nav(`/bookings/${r.booking_id}`); })}>Create booking</button>}
        {meta?.booking_id && <button className="btn-ghost" onClick={() => nav(`/bookings/${meta.booking_id}`)}>Open booking</button>}</>}>
      <Err e={err} />{msg && <Banner ok onClose={() => setMsg('')}>{msg}</Banner>}
      {isNew && ai && <div className="mb-3 flex gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm"><Sparkles size={16} className="mt-0.5 shrink-0 text-accent" /><span><b>Draft from the enquiry.</b> Check every line, choose the client{ai.client ? '' : ' (none matched)'}, and add prices — the assistant doesn’t set them. {ai.missing?.length ? `Still to ask the client: ${ai.missing.join('; ')}.` : ''}</span></div>}

      {sent && <div className="card mb-4 text-sm"><div className="font-medium mb-1">Client link</div>
        <p className="text-xs text-muted mb-2">{sent.emailed ? `We emailed this link to ${client?.email ?? 'the client'}. ` : client?.email ? '' : 'This client has no email address on file, so nothing was emailed — copy the link and send it yourself. '}The client can view the quote and accept, decline or ask for changes. This link is shown only once; sending again replaces it.</p>
        <div className="flex gap-2"><input className="input num" readOnly aria-label="Client link" value={sent.link} onFocus={(e) => e.target.select()} /><button className="btn-ghost inline-flex items-center gap-1 whitespace-nowrap" onClick={copy}>{copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}</button></div></div>}

      {meta && <div className="card mb-4 text-sm flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2"><Pill s={status} /><span className="text-muted">{LABEL[status]}</span></div>
        {meta.status === 'sent' && meta.valid_until && <span className={daysFrom(meta.valid_until) < 0 ? 'text-danger' : daysFrom(meta.valid_until) <= 7 ? 'text-warn' : 'text-muted'}>{daysFrom(meta.valid_until) < 0 ? `Expired on ${nice(meta.valid_until)} — change the valid-until date and send again.` : `Valid until ${nice(meta.valid_until)}`}</span>}
        {(meta.status === 'accepted' || meta.status === 'converted') && <span className="text-muted">Accepted <b className="text-fg">{meta.accepted_option}</b> (version {meta.accepted_version}) — {meta.accepted_by_name}</span>}
        {meta.status === 'declined' && meta.client_message && <span className="text-muted">Reason: “{meta.client_message}”</span>}
        {meta.status === 'accepted' && !meta.client_id && <span className="text-warn">This quote is for a lead. Link it to a client before creating the booking.</span>}</div>}
      {meta?.status === 'changes_requested' && <div className="rounded-lg border border-warn/30 bg-warn/10 text-sm px-4 py-3 mb-4"><div className="font-medium text-warn mb-1">The client asked for changes</div><div className="whitespace-pre-wrap">“{meta.client_message}”</div><div className="text-xs text-muted mt-1">Make the changes below, save, and send again.</div></div>}
      {locked && <div className="rounded-lg border border-line bg-surface2/60 text-sm p-3 mb-4">This quote has been turned into a booking, so it can't be changed any more. Change the booking instead, or create a new quote.</div>}
      {meta?.status === 'accepted' && !readOnly && <div className="rounded-lg border border-warn/30 bg-warn/10 text-sm px-4 py-3 mb-4">The client has accepted this quote. If you change it, the acceptance is withdrawn: saving creates version {meta.current_version + 1} as a draft, and the client must accept the new terms. To keep the accepted terms, create the booking instead.</div>}
      {!readOnly && meta?.sent_at && !locked && meta.status !== 'accepted' && <p className="text-xs text-muted mb-3">This version has already been sent. Saving any change creates version {meta.current_version + 1} and cancels the link the client has.</p>}

      {belowMin && !locked && <div className={`rounded-lg border text-sm px-4 py-3 mb-4 flex flex-wrap items-center justify-between gap-2 ${meta?.margin_approved_by ? 'border-success/30 bg-success/10' : 'border-warn/30 bg-warn/10'}`}>
        <span>{meta?.margin_approved_by ? <><Check size={14} className="inline text-success" /> A margin of {low!.toFixed(1)}% was approved for this version.</> : <>The lowest margin here is <b>{low!.toFixed(1)}%</b>, below your agency minimum of {minMargin}%. {finance ? 'Approve it to allow sending, or raise the markup.' : 'A finance manager must approve it before the quote can be sent — or raise the markup.'}{dirty && !isNew && ' Save first.'}</>}</span>
        {finance && meta && !meta.margin_approved_by && !dirty && <button className="btn-ghost" onClick={() => act(async () => { await api(`/quotes/${id}/approve-margin`, 'POST'); return 'Margin approved — the quote can now be sent.'; })}>Approve margin</button>}</div>}

      <div className="card grid sm:grid-cols-2 lg:grid-cols-4 gap-x-4 mb-4">
        <div className="sm:col-span-2"><Field label="Title" hint="The client sees this, e.g. “Family week in Bali, July”"><input className="input" value={q.title} autoFocus={isNew} onChange={(e) => setQ({ ...q, title: e.target.value })} disabled={readOnly} /></Field></div>
        <Field label="Client" hint={q.lead_id && !q.client_id ? `For lead${lead ? `: ${lead.name}` : ''} — choose a client once they become one` : client?.email ? `Will be emailed to ${client.email}` : client ? 'No email on file — you will need to send the link yourself' : 'Leave empty for a lead'}>
          <ClientPick clients={clients} value={q.client_id} onChange={(v) => setQ({ ...q, client_id: v })} disabled={readOnly} placeholder={q.lead_id ? 'No client yet (lead)' : 'Start typing a client name…'} /></Field>
        <div className="grid grid-cols-[5rem_1fr] gap-x-3">
          <Field label="Currency"><input className="input num" maxLength={3} value={q.currency} onChange={(e) => setQ({ ...q, currency: e.target.value.toUpperCase() })} disabled={!isNew} /></Field>
          <Field label="Valid until" hint={q.valid_until ? undefined : '14 days after sending if blank'}><input className="input num" type="date" min={today()} value={q.valid_until} onChange={(e) => setQ({ ...q, valid_until: e.target.value })} disabled={readOnly} /></Field></div></div>

      {totals.map((o: any, oi: number) => (
        <div key={o.k} className="card mb-4">
          <div className="flex flex-wrap gap-3 justify-between items-center mb-3">
            <input className="input w-full sm:w-64 font-semibold" aria-label="Option name" value={o.name} onChange={(e) => setQ({ ...q, opts: q.opts.map((x: any) => (x.k === o.k ? { ...x, name: e.target.value } : x)) })} disabled={readOnly} />
            <div className="text-sm text-right num"><span className="text-muted">Client pays </span><b className="text-base">{money(o.total, q.currency)}</b>
              <div className="text-xs text-muted">{money(r2(o.net), q.currency)} + {money(r2(o.tax), q.currency)} tax · costs you {money(r2(o.cost), q.currency)} · <span className={o.margin != null && ((minMargin !== null && o.margin < minMargin) || o.margin < 0) ? 'text-warn' : 'text-success'}>margin {o.margin != null ? `${o.margin.toFixed(1)}%` : '—'}</span></div></div></div>
          <div className={`hidden lg:grid ${cell} gap-2 text-[11px] text-muted mb-1 px-0.5`}>
            <span>Type</span><span>Supplier</span><span>Description</span><span>Starts</span><span>Ends</span><span className="text-right">Qty</span><span className="text-right">Cost each</span><span className="text-right">Markup %</span><span className="text-right">Disc. %</span><span className="text-right">Tax %</span><span className="text-right">Client pays</span><span />
          </div>
          {q.components.filter((c: any) => c._k === o.k).map((c: any, i: number, arr: any[]) => { const p = price(c); return (
            <div key={c._lk ?? i} className={`grid grid-cols-2 ${cell} gap-2 mb-3 lg:mb-2 pb-3 lg:pb-0 border-b border-line/50 lg:border-0 items-end`}>
              <div><L t="Type" /><select className="input capitalize" value={c.product_type} onChange={(e) => setC(c._lk, 'product_type', e.target.value)} disabled={readOnly}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
              <div><L t="Supplier" /><select className="input" value={c.supplier_id} onChange={(e) => setC(c._lk, 'supplier_id', e.target.value)} disabled={readOnly}><option value="">No supplier</option>{suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
              <div className="col-span-2 lg:col-span-1"><L t="Description" /><input className="input" placeholder="e.g. Return flights Karachi – Istanbul" value={c.description} onChange={(e) => setC(c._lk, 'description', e.target.value)} disabled={readOnly} /></div>
              <div><L t="Starts" /><input className="input num" type="date" value={c.service_start} onChange={(e) => setC(c._lk, 'service_start', e.target.value)} disabled={readOnly} /></div>
              <div><L t="Ends" /><input className="input num" type="date" min={c.service_start || undefined} value={c.service_end} onChange={(e) => setC(c._lk, 'service_end', e.target.value)} disabled={readOnly} /></div>
              {([['quantity', 'Qty'], ['unit_cost', 'Cost each'], ['markup_pct', 'Markup %'], ['discount_pct', 'Disc. %'], ['tax_rate', 'Tax %']] as const).map(([k, l]) => <div key={k}><L t={l} /><Num v={c[k]} set={(v) => setC(c._lk, k, v === '' ? 0 : v)} min={0} disabled={readOnly} aria-label={l} /></div>)}
              <div className="num col-span-2 lg:col-span-1 lg:text-right lg:py-2 font-medium"><L t="Client pays" />{money(r2(p.net + p.tax), q.currency)}</div>
              <div className="text-right col-span-2 lg:col-span-1">{!readOnly && <button type="button" className="btn-ghost !px-1.5" title={arr.length === 1 ? 'An option needs at least one line' : 'Remove this line'} aria-label="Remove this line" disabled={arr.length === 1} onClick={() => removeLine(c._lk)}><X size={15} /></button>}</div>
            </div>); })}
          {!readOnly && <div className="flex flex-wrap gap-2"><button className="btn-ghost inline-flex items-center gap-1" onClick={() => addLine(o.k)}><Plus size={15} />Add a line</button>
            <button className="btn-ghost" onClick={() => copyOption(o)}>Copy as a new option</button>
            {q.opts.length > 1 && <button className="btn-ghost text-danger" onClick={() => removeOption(o)}>Remove option {oi + 1}</button>}</div>}
        </div>))}
      {!readOnly && <button className="btn-ghost mb-4 inline-flex items-center gap-1" onClick={addOption}><Plus size={15} />Add another option for the client to choose from</button>}

      <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Shown to the client</div>
      <div className="grid lg:grid-cols-2 gap-x-4">
        {([['inclusions', 'What’s included', 'e.g. Daily breakfast, airport transfers'], ['exclusions', 'What’s not included', 'e.g. Visa fees, travel insurance'], ['payment_terms', 'Payment terms', 'e.g. 30% deposit to confirm, balance 30 days before travel'], ['cancellation_terms', 'Cancellation terms', 'e.g. Non-refundable within 14 days of travel']] as const).map(([k, l, ph]) => <Field key={k} label={l}><textarea className="input h-20" placeholder={ph} value={q[k]} onChange={(e) => setQ({ ...q, [k]: e.target.value })} disabled={readOnly} /></Field>)}</div>
      <Field label="Internal notes" hint="Only your team sees these — never shown to the client"><textarea className="input h-20" value={q.internal_notes} onChange={(e) => setQ({ ...q, internal_notes: e.target.value })} disabled={readOnly} /></Field>
      {!readOnly && problem && <p className="text-sm text-warn mb-3">{problem}</p>}

      {meta && <div className="grid lg:grid-cols-2 gap-4 mt-2">
        <div className="card text-sm"><h4 className="font-semibold mb-2">Versions</h4><div className="space-y-1">{meta.versions.map((v: any) => <div key={v.version} className="flex justify-between gap-3"><span>Version {v.version}{v.version === meta.current_version && <span className="text-muted"> (current)</span>}</span><span className="text-muted">{v.sent_at ? `sent ${new Date(v.sent_at).toLocaleDateString()}` : 'not sent'} · margin {v.margin_pct ?? '—'}{v.margin_pct != null && '%'}</span></div>)}</div></div>
        <div className="card text-sm"><h4 className="font-semibold mb-2">History</h4><div className="space-y-1 text-xs max-h-48 overflow-auto">{meta.activities.map((a: any) => <div key={a.id}>{a.body}<div className="text-muted">{a.user_name ?? 'Client'} · {new Date(a.created_at).toLocaleString()}</div></div>)}{!meta.activities.length && <div className="text-muted">Nothing yet</div>}</div></div></div>}

      {accepting && <Modal title="Record the client’s acceptance" onClose={() => setAccepting(null)}>
        <p className="text-sm text-muted mb-3">Use this when the client said yes by phone or email instead of using their link.</p>
        {meta.options.length > 1 && <Field label="Which option did they choose?"><select className="input" value={accepting.option} onChange={(e) => setAccepting({ ...accepting, option: e.target.value })}>{meta.options.map((o: any) => <option key={o.option} value={o.option}>{o.option} — {money(o.total, meta.currency)}</option>)}</select></Field>}
        <Field label="Who accepted?" hint="Kept in the quote's history"><input className="input" value={accepting.name} onChange={(e) => setAccepting({ ...accepting, name: e.target.value })} placeholder="Client's name" /></Field>
        {dirty && <p className="text-sm text-warn mb-3">You have unsaved changes. The client accepts the version they were sent, not your edits.</p>}
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setAccepting(null)}>Cancel</button>
          <button className="btn" disabled={!accepting.name.trim() || busy} onClick={() => { const a = accepting; setAccepting(null); act(async () => { await api(`/quotes/${id}/accept`, 'POST', { option: a.option || undefined, name: a.name.trim() }); return `Recorded: ${a.name.trim()} accepted ${a.option || 'the quote'}. You can now create the booking.`; }); }}>Mark as accepted</button></div></Modal>}
    </Page>
  );
}
