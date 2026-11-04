import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Num, Page, Pill, Table } from '../components/ui';
import { useList } from '../lookup';
import { Plus, Save } from 'lucide-react';

const TYPES = ['flight', 'hotel', 'package', 'cruise', 'transfer', 'tour', 'rail', 'car', 'insurance', 'visa', 'fee', 'other'];
const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'converted', 'declined', 'expired', 'changes_requested'];
const comp = (option = 'Option 1'): any => ({ option_name: option, product_type: 'hotel', description: '', quantity: 1, unit_cost: 0, markup_pct: 15, discount_pct: 0, tax_rate: 0, supplier_id: '' });
// mirrors backend priceComponent
const price = (c: any) => { const up = Math.round(c.unit_cost * (1 + c.markup_pct / 100) * 100) / 100; const net = Math.round(up * c.quantity * (1 - c.discount_pct / 100) * 100) / 100; return { net, tax: Math.round(net * c.tax_rate) / 100, cost: Math.round(c.unit_cost * c.quantity * 100) / 100 }; };

export function QuoteList() {
  const nav = useNavigate(); const { can } = useAuth(); const [rows, setRows] = useState<any[]>([]); const [status, setStatus] = useState('');
  useEffect(() => { api(`/quotes${status ? `?status=${status}` : ''}`).then(setRows); }, [status]);
  return (
    <Page title="Quotes" actions={<><select className="input w-44" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{QUOTE_STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
      {can('admin', 'finance_manager', 'agent') && <button className="btn" onClick={() => nav('/quotes/new')}><Plus size={15} /> New quote</button>}</>}>
      <Table rows={rows} onRow={(r) => nav(`/quotes/${r.id}`)} cols={[
        { h: 'Quote', render: (r) => <span className="num">{r.quote_no}</span> }, { h: 'Title', render: (r) => r.title }, { h: 'Client / lead', render: (r) => r.client_name ?? r.lead_name ?? '—' },
        { h: 'Status', render: (r) => <Pill s={r.status} /> }, { h: 'Ver', render: (r) => `v${r.current_version}` }, { h: 'Valid until', render: (r) => r.valid_until ?? '—' },
        { h: 'From', right: true, render: (r) => (r.from_total != null ? money(r.from_total, r.currency) : '—') }, { h: 'Margin', right: true, render: (r) => (r.margin_pct != null ? `${r.margin_pct}%` : '—') },
        { h: '', render: (r) => <div className="flex gap-1 justify-end" onClick={(e) => e.stopPropagation()}><button className="btn-ghost" onClick={() => nav(`/quotes/${r.id}`)}>View</button></div> }]} />
    </Page>
  );
}

export function QuoteEditor() {
  const { id } = useParams(); const [sp] = useSearchParams(); const nav = useNavigate(); const { can, agency } = useAuth();
  const clients = useList('/clients'); const suppliers = useList('/suppliers');
  const isNew = id === 'new';
  const [q, setQ] = useState<any>({ title: '', client_id: sp.get('client') ? Number(sp.get('client')) : '', lead_id: sp.get('lead') ? Number(sp.get('lead')) : null, currency: agency?.base_currency ?? 'USD', valid_until: '', inclusions: '', exclusions: '', payment_terms: '', cancellation_terms: '', internal_notes: '', components: [comp()] });
  const [meta, setMeta] = useState<any>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [link, setLink] = useState('');
  const load = async () => {
    if (isNew) return; const d = await api(`/quotes/${id}`);
    setMeta(d); setQ({ title: d.title, client_id: d.client_id ?? '', lead_id: d.lead_id, currency: d.currency, valid_until: d.valid_until ?? '', inclusions: d.inclusions ?? '', exclusions: d.exclusions ?? '', payment_terms: d.payment_terms ?? '', cancellation_terms: d.cancellation_terms ?? '', internal_notes: d.internal_notes ?? '',
      components: d.components.map((c: any) => ({ ...c, supplier_id: c.supplier_id ?? '' })) });
  };
  useEffect(() => { load(); }, [id]);
  const locked = meta && ['accepted', 'converted'].includes(meta.status);
  const options = [...new Set(q.components.map((c: any) => c.option_name))] as string[];
  const totals = options.map((o) => { const cs = q.components.filter((c: any) => c.option_name === o); const t = cs.reduce((s: any, c: any) => { const p = price(c); return { net: s.net + p.net, tax: s.tax + p.tax, cost: s.cost + p.cost }; }, { net: 0, tax: 0, cost: 0 }); return { o, ...t, total: t.net + t.tax, margin: t.net > 0 ? ((t.net - t.cost) / t.net) * 100 : null }; });
  const setC = (i: number, k: string, v: any) => setQ({ ...q, components: q.components.map((c: any, j: number) => (j === i ? { ...c, [k]: v } : c)) });
  const body = () => ({ ...q, client_id: q.client_id ? Number(q.client_id) : null, valid_until: q.valid_until || null,
    components: q.components.map((c: any) => ({ option_name: c.option_name, product_type: c.product_type, supplier_id: c.supplier_id ? Number(c.supplier_id) : null, description: c.description, quantity: Number(c.quantity), unit_cost: Number(c.unit_cost), markup_pct: Number(c.markup_pct), discount_pct: Number(c.discount_pct), tax_rate: Number(c.tax_rate), service_start: c.service_start || null, service_end: c.service_end || null })) });
  const act = async (fn: () => Promise<any>, ok = '') => { try { await fn(); setErr(''); setMsg(ok); await load(); } catch (e: any) { setErr(e.message); setMsg(''); } };
  const save = () => act(async () => { if (isNew) { const r = await api('/quotes', 'POST', body()); nav(`/quotes/${r.id}`, { replace: true }); } else { const r = await api(`/quotes/${id}`, 'PUT', body()); if (r.version !== meta.current_version) setMsg(`Saved as new version v${r.version}`); } }, 'Saved');

  return (
    <Page title={isNew ? 'New quote' : `${meta?.quote_no ?? ''} · v${meta?.current_version ?? 1}`} actions={<>
      <button className="btn-ghost" onClick={() => nav('/quotes')}>← Quotes</button>
      {!locked && <button className="btn" onClick={save} disabled={!q.title}><Save size={15} /> Save</button>}
      {!isNew && !locked && <button className="btn" onClick={() => act(async () => { const r = await api(`/quotes/${id}/send`, 'POST', { email: true }); setLink(r.link); }, 'Sent — copy the link below')}>Send to client</button>}
      {!isNew && meta?.status === 'sent' && <button className="btn-ghost" onClick={() => act(() => api(`/quotes/${id}/accept`, 'POST', { name: 'Client (by phone/email)', option: options[0] }), 'Marked accepted')}>Record acceptance</button>}
      {!isNew && meta?.status === 'accepted' && <button className="btn" onClick={() => act(async () => { const r = await api(`/quotes/${id}/convert`, 'POST'); nav(`/bookings/${r.booking_id}`); })}>Convert to booking</button>}
      {meta?.booking_id && <button className="btn-ghost" onClick={() => nav(`/bookings/${meta.booking_id}`)}>Open booking</button>}</>}>
      <Err e={err} />{msg && <div className="text-accent text-sm mb-3">{msg}</div>}
      {link && <div className="card mb-4 text-sm"><div className="text-muted text-xs mb-1">Secure client link — shown once; sending again revokes it</div><div className="flex gap-2"><input className="input num" readOnly value={link} onFocus={(e) => e.target.select()} /><button className="btn-ghost" onClick={() => navigator.clipboard.writeText(link)}>Copy</button></div></div>}
      {meta && <div className="text-sm mb-4 flex gap-3 items-center"><Pill s={meta.status} /><span className="text-muted">{meta.status === 'accepted' || meta.status === 'converted' ? `Accepted v${meta.accepted_version} — ${meta.accepted_option} by ${meta.accepted_by_name}` : meta.status === 'changes_requested' ? `Client asks: ${meta.client_message}` : ''}</span>
        {meta.margin_pct != null && <span className={`num ${meta.margin_pct < 10 ? 'text-warn' : 'text-muted'}`}>lowest margin {meta.margin_pct}%</span>}
        {can('admin', 'finance_manager') && meta.status !== 'accepted' && <button className="text-accent text-xs" onClick={() => act(() => api(`/quotes/${id}/approve-margin`, 'POST'), 'Margin approved')}>Approve margin</button>}</div>}
      <div className="card grid grid-cols-2 lg:grid-cols-4 gap-x-4 mb-4">
        <Field label="Title *"><input className="input" value={q.title} onChange={(e) => setQ({ ...q, title: e.target.value })} disabled={locked} /></Field>
        <Field label="Client"><select className="input" value={q.client_id} onChange={(e) => setQ({ ...q, client_id: e.target.value })} disabled={locked}><option value="">— none (lead) —</option>{clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Currency"><input className="input num" maxLength={3} value={q.currency} onChange={(e) => setQ({ ...q, currency: e.target.value.toUpperCase() })} disabled={!isNew} /></Field>
        <Field label="Valid until"><input className="input num" type="date" value={q.valid_until} onChange={(e) => setQ({ ...q, valid_until: e.target.value })} disabled={locked} /></Field></div>
      {options.map((o) => (
        <div key={o} className="card mb-4"><div className="flex flex-wrap gap-2 justify-between items-center mb-2"><input className="input w-56 font-bold" value={o} onChange={(e) => setQ({ ...q, components: q.components.map((c: any) => (c.option_name === o ? { ...c, option_name: e.target.value } : c)) })} disabled={locked} />
          <div className="num text-sm text-right">{(() => { const t = totals.find((x) => x.o === o)!; return <>net {money(t.net, q.currency)} · tax {money(t.tax, q.currency)} · <b>total {money(t.total, q.currency)}</b> · <span className={t.margin != null && t.margin < 10 ? 'text-warn' : 'text-success'}>margin {t.margin != null ? `${t.margin.toFixed(1)}%` : '—'}</span></>; })()}</div></div>
          <div className="grid grid-cols-12 gap-2 text-[10px] uppercase text-muted px-1"><div className="col-span-2">Type</div><div className="col-span-2">Supplier</div><div className="col-span-3">Description</div><div>Qty</div><div>Unit cost</div><div>Mark-up %</div><div>Disc %</div><div>Tax %</div></div>
          {q.components.map((c: any, i: number) => c.option_name === o && (
            <div key={i} className="grid grid-cols-12 gap-2 mb-2">
              <select className="input col-span-2" value={c.product_type} onChange={(e) => setC(i, 'product_type', e.target.value)} disabled={locked}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
              <select className="input col-span-2" value={c.supplier_id} onChange={(e) => setC(i, 'supplier_id', e.target.value)} disabled={locked}><option value="">—</option>{suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              <input className="input col-span-3" value={c.description} onChange={(e) => setC(i, 'description', e.target.value)} disabled={locked} />
              {(['quantity', 'unit_cost', 'markup_pct', 'discount_pct', 'tax_rate'] as const).map((k) => <Num key={k} v={c[k]} set={(v) => setC(i, k, v === '' ? 0 : v)} disabled={locked} />)}
            </div>))}
          {!locked && <div className="flex gap-3"><button className="btn-ghost" onClick={() => setQ({ ...q, components: [...q.components, comp(o)] })}>+ Line</button>
            {options.length > 1 && <button className="btn-ghost text-danger" onClick={() => setQ({ ...q, components: q.components.filter((c: any) => c.option_name !== o) })}>Remove option</button>}</div>}
        </div>))}
      {!locked && <button className="btn-ghost mb-4" onClick={() => setQ({ ...q, components: [...q.components, comp(`Option ${options.length + 1}`)] })}>+ Add option</button>}
      <div className="grid lg:grid-cols-2 gap-4">
        {([['inclusions', 'Inclusions'], ['exclusions', 'Exclusions'], ['payment_terms', 'Payment terms'], ['cancellation_terms', 'Cancellation terms']] as const).map(([k, l]) => <Field key={k} label={l}><textarea className="input h-20" value={q[k]} onChange={(e) => setQ({ ...q, [k]: e.target.value })} disabled={locked} /></Field>)}
        <Field label="Internal notes (never shown to the client)"><textarea className="input h-20" value={q.internal_notes} onChange={(e) => setQ({ ...q, internal_notes: e.target.value })} disabled={locked} /></Field></div>
      {meta && <div className="card mt-4"><h4 className="font-bold text-sm mb-2">Versions & history</h4>
        <div className="text-sm space-y-1 mb-3">{meta.versions.map((v: any) => <div key={v.version}>v{v.version} · {v.sent_at ? `sent ${new Date(v.sent_at).toLocaleDateString()}` : 'never sent'} · margin {v.margin_pct ?? '—'}%{v.version === meta.current_version ? ' (current)' : ''}</div>)}</div>
        <div className="space-y-1 text-xs text-muted max-h-40 overflow-auto">{meta.activities.map((a: any) => <div key={a.id}>{new Date(a.created_at).toLocaleString()} — {a.body}</div>)}</div></div>}
    </Page>
  );
}
