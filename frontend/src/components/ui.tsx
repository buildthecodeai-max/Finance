import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronLeft, ChevronRight, Inbox, Plus, Save, Trash2, X } from 'lucide-react';
import { n2 } from '../api';

/* ---------- Status pill: one tone per meaning, real status text ---------- */
type Tone = 'success' | 'warn' | 'danger' | 'info' | 'neutral';
const TONE: Record<Tone, string> = {
  success: 'bg-success/15 text-success', warn: 'bg-warn/15 text-warn', danger: 'bg-danger/15 text-danger', info: 'bg-info/15 text-info', neutral: 'bg-muted/15 text-muted',
};
const STATUS_TONE: Record<string, Tone> = {
  paid: 'success', collected: 'success', docs_received: 'info', docs_pending: 'warn', in_process: 'info', closed: 'success', approved: 'success', accepted: 'success', converted: 'success', confirmed: 'success', ticketed: 'success', done: 'success', in_service: 'success', travel_completed: 'success', won: 'success', cleared: 'success', reconciled: 'success', matched: 'success', posted: 'success', issued: 'success', received: 'success', active: 'success',
  new: 'info', contacted: 'info', negotiating: 'warn',
  draft: 'warn', trialing: 'info', grace: 'warn', past_due: 'warn', suspended: 'danger', critical: 'danger', warn: 'warn', info: 'info', validated: 'info', processing: 'info', failed: 'danger', reviewed: 'warn', sent: 'warn', accrued: 'warn', pending: 'warn', requested: 'warn', waitlisted: 'warn', enquiry: 'warn', quoted: 'warn', awaiting_client: 'warn', tentative: 'warn', unmatched: 'warn', pending_approval: 'warn',
  overdue: 'danger', void: 'danger', declined: 'danger', expired: 'danger', cancelled: 'danger', lost: 'danger', refunded: 'danger', voided: 'danger', rejected: 'danger', reversed: 'danger',
  reversal: 'info',
  partially_paid: 'info', credited: 'info', eligible: 'info', submitted: 'info', exported: 'info', changes_requested: 'info', on_hold: 'info', in_progress: 'info',
};
export const Pill = ({ s }: { s: string }) => <span className={`pill capitalize ${TONE[STATUS_TONE[s] ?? 'neutral']}`}>{s.replace(/_/g, ' ')}</span>;

/* ---------- Layout ---------- */
export const Page = ({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) => {
  useEffect(() => { document.title = `${title} · Travel CRM`; }, [title]);   // screen readers announce the page on navigation
  return (
  <div className="px-4 md:px-8 py-6 max-w-[1440px] mx-auto w-full">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
      <div className="min-w-0"><h1 className="text-2xl font-semibold truncate">{title}</h1>{description && <p className="text-sm text-muted mt-0.5">{description}</p>}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
    {children}
  </div>
  );
};

export const Skeleton = ({ className = '' }: { className?: string }) => <div className={`skeleton ${className}`} aria-hidden />;

export const EmptyState = ({ title = 'Nothing here yet', hint }: { title?: string; hint?: string }) => (
  <div className="flex flex-col items-center justify-center py-12 text-center">
    <div className="h-10 w-10 rounded-full bg-surface2 grid place-items-center mb-3"><Inbox size={18} className="text-muted" /></div>
    <div className="text-sm font-medium">{title}</div>{hint && <div className="text-xs text-muted mt-1 max-w-xs">{hint}</div>}
  </div>
);

export interface Col<T> { h: string; render: (r: T) => ReactNode; right?: boolean }

const PAGE_SIZES = [10, 25, 50, 100];
const readPageSize = () => { try { const n = Number(localStorage.getItem('tf-page-size')); return PAGE_SIZES.includes(n) ? n : 25; } catch { return 25; } };
/** Page numbers to show: always the first and last, and the pages around the current one, with gaps as null. */
function pageList(cur: number, pages: number): (number | null)[] {
  const keep = new Set([0, pages - 1, cur - 1, cur, cur + 1].filter((n) => n >= 0 && n < pages)); const out: (number | null)[] = []; let prev = -1;
  for (const n of [...keep].sort((a, b) => a - b)) { if (n - prev > 1) out.push(null); out.push(n); prev = n; }
  return out;
}

/** Page controls under a table: which rows are showing, previous/next, numbered pages and how many rows per page (remembered across pages and visits). */
export function Pager({ total, page, size, onPage, onSize, noun = 'results' }: { total: number; page: number; size: number; onPage(p: number): void; onSize(n: number): void; noun?: string }) {
  const pages = Math.max(1, Math.ceil(total / size)), from = total ? page * size + 1 : 0, to = Math.min(total, (page + 1) * size);
  const btn = 'h-8 min-w-8 px-2 rounded-lg border text-sm transition disabled:opacity-40 disabled:cursor-not-allowed';
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line px-3 py-2 text-sm">
      <div className="text-muted num" role="status" aria-live="polite">Showing <b className="text-fg">{from}–{to}</b> of {total.toLocaleString()} {noun}</div>
      <div className="flex items-center gap-1">
        <button type="button" className={`${btn} border-line hover:bg-surface2 inline-flex items-center`} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>
        {pageList(page, pages).map((n, i) => n === null ? <span key={`gap${i}`} className="px-1 text-muted" aria-hidden>…</span>
          : <button key={n} type="button" aria-label={`Page ${n + 1}`} aria-current={n === page ? 'page' : undefined} onClick={() => onPage(n)} className={`${btn} num ${n === page ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>{n + 1}</button>)}
        <button type="button" className={`${btn} border-line hover:bg-surface2 inline-flex items-center`} disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted">Rows per page
        <select className="input !h-8 !w-auto !py-0" value={size} onChange={(e) => onSize(Number(e.target.value))}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
    </nav>
  );
}

/** Every table pages itself: 25 rows at a time by default, controls appear once there is more than a page. Pass `paginate={false}` to show every row. */
export function Table<T extends { id?: number }>({ rows, cols, onRow, empty, paginate = true, noun }: { rows: T[]; cols: Col<T>[]; onRow?: (r: T) => void; empty?: string; paginate?: boolean; noun?: string }) {
  const [size, setSize] = useState(readPageSize), [page, setPage] = useState(0); const box = useRef<HTMLDivElement>(null);
  const pages = Math.max(1, Math.ceil(rows.length / size)), cur = Math.min(page, pages - 1);
  const first = rows[0]?.id;
  useEffect(() => { setPage(0); }, [rows.length, first]);                 // a new search or filter starts again from page 1
  const go = (p: number) => { setPage(p); box.current?.scrollTo({ top: 0 }); };
  const chooseSize = (n: number) => { setSize(n); setPage(0); try { localStorage.setItem('tf-page-size', String(n)); } catch { /* ignore */ } };
  const shown = paginate ? rows.slice(cur * size, (cur + 1) * size) : rows;
  return (
    <div className="card p-0 overflow-hidden">
      <div ref={box} className="overflow-auto max-h-[calc(100vh-14rem)]">
        <table className="w-full border-separate border-spacing-0">
          <thead className="sticky top-0 z-10"><tr>{cols.map((c, i) => <th key={`${c.h}${i}`} className={`${c.right ? '!text-right' : ''} bg-surface2`}>{c.h}</th>)}</tr></thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r.id ?? `${cur}-${i}`} onClick={() => onRow?.(r)} onKeyDown={(e) => onRow && e.key === 'Enter' && onRow(r)} tabIndex={onRow ? 0 : undefined} className={onRow ? 'cursor-pointer hover:bg-surface2/70 focus-visible:bg-surface2/70' : 'hover:bg-surface2/40'}>
                {cols.map((c, j) => <td key={`${c.h}${j}`} className={c.right ? 'text-right num' : ''}>{c.render(r)}</td>)}
              </tr>))}
          </tbody>
        </table>
        {!rows.length && <EmptyState title={empty ?? 'Nothing here yet'} />}
      </div>
      {paginate && rows.length > PAGE_SIZES[0] && <Pager total={rows.length} page={cur} size={size} onPage={go} onSize={chooseSize} noun={noun} />}
    </div>
  );
}

/* ---------- Forms ---------- */
export const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <label className="block mb-3"><span className="block text-xs font-medium text-muted mb-1">{label}</span><div>{children}</div>{hint && <span className="block text-[11px] text-muted mt-1">{hint}</span>}</label>
);

export const Err = ({ e }: { e: string }) => (e ? (
  <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 text-danger text-sm px-3 py-2 mb-3"><AlertCircle size={16} className="mt-0.5 shrink-0" /><span>{e}</span></div>
) : null);

/** A short confirmation (or warning) that can be dismissed and can offer one follow-up action, such as Undo. */
export const Banner = ({ ok = true, children, onClose, action }: { ok?: boolean; children: ReactNode; onClose?(): void; action?: { label: string; onClick(): void } }) => (
  <div role={ok ? 'status' : 'alert'} className={`rounded-lg border text-sm px-3 py-2 mb-3 flex justify-between gap-3 ${ok ? 'border-success/30 bg-success/10 text-success' : 'border-warn/30 bg-warn/10 text-warn'}`}>
    <span className="min-w-0">{children}</span>
    <span className="flex items-start gap-3 shrink-0">{action && <button type="button" className="font-medium underline" onClick={action.onClick}>{action.label}</button>}{onClose && <button type="button" className="opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={onClose}><X size={14} /></button>}</span></div>
);

export const Num = ({ v, set, ...p }: { v: any; set(n: any): void } & React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} type="number" step="any" className="input num text-right" value={v ?? ''} onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))} />
);

/** Switches off every box inside it (a fieldset does that natively), without the app's default bordered-box look for fieldsets. */
export const Locked = ({ on, className = '', children }: { on: boolean; className?: string; children: ReactNode }) => (
  <fieldset disabled={on} className={`${className} !m-0 !rounded-none !border-0 !p-0`}>{children}</fieldset>
);

/** A collapsible group of optional fields. Shows how many are filled in, so nothing hides unnoticed. */
export function More({ title, hint, count = 0, open, setOpen, children }: { title: string; hint?: string; count?: number; open: boolean; setOpen(v: boolean): void; children: ReactNode }) {
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 py-1 text-left text-sm font-medium text-accent hover:underline">
        <ChevronDown size={15} className={`shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} /><span className="shrink-0 whitespace-nowrap">{title}</span>
        {!open && count > 0 && <span className="shrink-0 whitespace-nowrap rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium">{count} filled in</span>}
        {!open && hint && <span className="hidden min-w-0 truncate text-xs font-normal text-muted sm:inline">{hint}</span>}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** One line of a money form: what it is on the left, the box on the right. */
export const AmountRow = ({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) => (
  <div className="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,8.5rem)] items-center gap-3">
    <div className="min-w-0 text-sm">{label}{hint && <div className="text-[11px] leading-tight text-muted">{hint}</div>}</div>
    <div>{children}</div>
  </div>
);
export const AmountTotal = ({ label, value }: { label: string; value: any }) => (
  <div className="mt-1 flex items-baseline justify-between border-t border-line pt-2"><span className="text-sm font-medium">{label}</span><span className="num text-base font-semibold">{n2(value)}</span></div>
);

export const Toolbar = ({ onNew, onSave, onDelete, canWrite = true }: { onNew(): void; onSave(): void; onDelete?(): void; canWrite?: boolean }) => (
  <div className="flex gap-2 mb-4">
    <button className="btn-ghost" onClick={onNew} disabled={!canWrite}><Plus size={15} /> New</button>
    <button className="btn" onClick={onSave} disabled={!canWrite}><Save size={15} /> Save</button>
    {onDelete && <button className="btn-ghost text-danger" onClick={onDelete} disabled={!canWrite}><Trash2 size={15} /> Delete</button>}
  </div>
);

/* ---------- Overlay ---------- */
export const Modal = ({ title, onClose, children, wide }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) => {
  const box = useRef<HTMLDivElement>(null), titleId = useId(), close = useRef(onClose);
  close.current = onClose;   // callers pass inline functions; keep the effect from re-running (and stealing focus) on every render
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null, FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close.current();
      if (e.key !== 'Tab' || !box.current) return;   // keep keyboard focus inside the dialog
      const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !box.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', k); const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    (box.current?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea') ?? box.current?.querySelector<HTMLElement>('button'))?.focus();
    return () => { document.removeEventListener('keydown', k); document.body.style.overflow = prev; opener?.focus?.(); };   // hand focus back to what opened it
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 md:p-8 bg-black/50 backdrop-blur-sm" onMouseDown={() => close.current()}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`w-full ${wide ? 'max-w-5xl' : 'max-w-3xl'} mt-8 bg-surface border border-line rounded-2xl shadow-pop`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line"><h2 id={titleId} className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close dialog" className="btn-icon !h-8 !w-8"><X size={16} /></button></div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
};

/* ---------- small popover ---------- */
export function Popover({ trigger, children, align = 'right', width = 'w-56' }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: string }) {
  const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false); const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k); return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div className="relative" ref={ref}>{trigger(open, () => setOpen((o) => !o))}
      {open && <div className={`absolute z-50 mt-2 ${width} ${align === 'right' ? 'right-0' : 'left-0'} bg-surface border border-line rounded-xl shadow-pop p-1.5`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}
export const MenuBtn = ({ onClick, children, active }: { onClick(): void; children: ReactNode; active?: boolean }) => (
  <button onClick={onClick} className={`flex w-full items-center gap-2.5 px-2.5 py-2 text-sm rounded-lg text-left hover:bg-surface2 ${active ? 'text-accent' : ''}`}>{children}</button>
);

const TINTS = ['bg-accent/15 text-accent', 'bg-success/15 text-success', 'bg-warn/15 text-warn', 'bg-danger/10 text-danger', 'bg-surface2 text-fg'];
/** Round badge with the client's initials; the colour is picked from the name so a client always looks the same. */
export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const w = name.trim().split(/\s+/).filter(Boolean); const ini = ((w[0]?.[0] ?? '?') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
  const tint = TINTS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];
  return <span aria-hidden="true" className={`grid shrink-0 place-items-center rounded-full font-semibold ${tint}`} style={{ width: size, height: size, fontSize: size * 0.38 }}>{ini}</span>;
}
