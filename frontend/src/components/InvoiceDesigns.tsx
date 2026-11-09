import { useEffect, useRef, useState } from 'react';
import { Check, Eye } from 'lucide-react';
import { api } from '../api';
import { Err, Skeleton } from './ui';
import { viewHtml } from './PdfViewer';

type Design = { key: string; name: string; about: string };
type Doc = 'invoice' | 'ticket';
// An A4 page is 210 × 297 mm, about 794 × 1123 px. Previews are laid out at that size, then scaled down to fit the card.
const PAGE_W = 794, PAGE_H = 1123;
const DOCS: [Doc, string][] = [['invoice', 'Booking invoice'], ['ticket', 'Ticket invoice']];

/** A page of the sample invoice, shrunk to fit its box. Scripts are disabled and clicks pass through to the card. */
function Sheet({ html, title }: { html?: string | null; title: string }) {
  const box = useRef<HTMLDivElement>(null); const [w, setW] = useState(0); const [ready, setReady] = useState(false);
  useEffect(() => setReady(false), [html]);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth)); ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="relative w-full overflow-hidden rounded-lg border border-line bg-white shadow-sm" style={{ aspectRatio: `${PAGE_W} / ${PAGE_H}` }}>
      {html ? <>
          <iframe title={title} sandbox="" srcDoc={html} tabIndex={-1} aria-hidden="true" scrolling="no" onLoad={() => setReady(true)} className="pointer-events-none absolute left-0 top-0 origin-top-left border-0" style={{ width: PAGE_W, height: PAGE_H, transform: `scale(${w / PAGE_W})`, opacity: ready ? 1 : 0 }} />
          {!ready && <Skeleton className="absolute inset-0 !rounded-none" />}</>
        : html === null ? <div className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-muted">Preview unavailable</div>
        : <Skeleton className="absolute inset-0 !rounded-none" />}
    </div>
  );
}

/**
 * Settings → Invoice design. Shows every design drawn with the agency's own logo, address and bank details; picking one makes it
 * the default for every invoice clients receive. Only an Admin can pick. `refreshKey` redraws the previews after the profile changes.
 */
export default function InvoiceDesigns({ canEdit, refreshKey = 0 }: { canEdit: boolean; refreshKey?: number }) {
  const [list, setList] = useState<{ selected: string; templates: Design[] } | null>(null);
  const [doc, setDoc] = useState<Doc>('invoice');
  const [pages, setPages] = useState<Record<string, string | null>>({});
  const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);

  useEffect(() => { api('/admin/invoice-templates').then(setList).catch((e) => setErr(e.message)); }, []);
  useEffect(() => {
    if (!list) return; let live = true; setPages({});
    for (const d of list.templates) api(`/admin/invoice-templates/${d.key}/preview?doc=${doc}`).then((r: any) => live && setPages((p) => ({ ...p, [d.key]: r.html }))).catch(() => live && setPages((p) => ({ ...p, [d.key]: null })));
    return () => { live = false; };
  }, [list?.templates, doc, refreshKey]);

  const choose = async (d: Design) => {
    if (!list || !canEdit || busy || d.key === list.selected) return;
    const before = list.selected; setBusy(true); setErr(''); setMsg(''); setList({ ...list, selected: d.key });
    try { await api('/admin/settings', 'PUT', { invoice_template: d.key }); setMsg(`Your invoices now use the ${d.name} design.`); }
    catch (e: any) { setList((l) => l && { ...l, selected: before }); setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h3 className="font-bold">Invoice design</h3>
          <p className="mt-1 text-sm text-muted">Choose the look of the invoices your clients receive. Your logo, address and bank details are filled in for you. The design you pick becomes the default for booking invoices and ticket invoices; invoices already sent keep the design the client received.</p>
        </div>
        <div className="inline-flex shrink-0 rounded-lg border border-line bg-surface2 p-0.5" role="group" aria-label="Preview with">
          {DOCS.map(([k, label]) => <button key={k} type="button" aria-pressed={doc === k} onClick={() => setDoc(k)} className={`h-8 rounded-md px-3 text-sm font-medium transition ${doc === k ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'}`}>{label}</button>)}
        </div>
      </div>
      <Err e={err} />
      <div role="status" aria-live="polite">{msg && <div className="mb-3 text-sm text-accent">{msg}</div>}</div>
      {!list && !err && <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-72" />)}</div>}
      {list && (
        <div role="radiogroup" aria-label="Invoice design" className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {list.templates.map((d) => {
            const on = d.key === list.selected;
            return (
              <div key={d.key} className="flex min-w-0 flex-col gap-2">
                <label className={`relative flex flex-1 flex-col gap-3 rounded-xl border p-3 transition focus-within:ring-2 focus-within:ring-accent/40 ${on ? 'border-accent bg-accent-soft/40 ring-2 ring-accent/30' : 'border-line bg-surface'} ${canEdit && !on ? 'cursor-pointer hover:border-accent/60' : ''}`}>
                  <input type="radio" name="invoice-design" className="sr-only" checked={on} disabled={!canEdit || busy} onChange={() => choose(d)} />
                  <Sheet html={pages[d.key]} title={`${d.name} design, sample`} />
                  <span className="min-w-0"><span className="flex items-center justify-between gap-2"><span className="font-semibold">{d.name}</span>{on && <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-ink"><Check size={12} strokeWidth={3} />Default</span>}</span><span className="mt-0.5 block text-xs leading-snug text-muted">{d.about}</span></span>
                </label>
                <button type="button" className="btn-ghost" disabled={!pages[d.key]} onClick={() => pages[d.key] && viewHtml(pages[d.key]!, `${d.name} design — sample ${doc === 'ticket' ? 'ticket invoice' : 'invoice'}`)}><Eye size={15} />Preview full size</button>
              </div>
            );
          })}
        </div>
      )}
      {list && !canEdit && <p className="mt-3 text-xs text-muted">Only an Admin can change the invoice design.</p>}
      {list && canEdit && <p className="mt-3 text-xs text-muted">Previews use sample bookings. Click a design to make it your default — it takes effect straight away.</p>}
    </div>
  );
}
