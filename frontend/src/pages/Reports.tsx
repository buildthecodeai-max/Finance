import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Banknote, BarChart3, CalendarClock, CheckCircle2, ChevronRight, Clock, Download, FileSpreadsheet, FileText, Home, Landmark, LineChart, RefreshCw, Search, Table2, Truck, Users, Wallet, XCircle, type LucideIcon } from 'lucide-react';
import { api, money, n2 } from '../api';
import { useAuth } from '../auth';
import { MenuBtn, Page, Popover, Skeleton } from '../components/ui';
import { isoDate, today, useAccounts } from '../lookup';
import { viewPdf } from '../components/PdfViewer';

/*
 * Reports: a home page with the numbers worth a glance, then each report with its filters, a summary, a chart where
 * it helps, and a table you can sort, search and download. What the filters are set to lives in the address, so a
 * link, a reload or the back button lands on the same report.
 */

interface Def { key: string; label: string; about: string; asAt?: boolean; account?: boolean; client?: 'required' | 'optional'; compare?: boolean; forecast?: boolean }
interface Cat { label: string; reports: Def[] }
interface Rep {
  title: string; columns: string[]; rows: any[][]; types?: string[]; kinds?: string[]; links?: (string | null)[]; note?: string; hints?: string[];
  reconcile?: { label: string; report: number; source: number; difference: number; ok: boolean }[];
  summary?: { label: string; value: string; unit?: '%'; tone?: 'good' | 'bad' | 'warn' | 'info' }[];
  chart?: { kind: 'bars'; labels: string[]; series: { name: string; values: number[]; tone?: string }[] };
}

let CATALOG: Cat[] | null = null;
function useCatalog() {
  const [cat, setCat] = useState<Cat[] | null>(CATALOG);
  useEffect(() => { if (!CATALOG) api('/reports/catalog').then((c) => { CATALOG = c; setCat(c); }).catch(() => setCat([])); }, []);
  return cat;
}
const RECENT = 'reports.recent';
const recents = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT) ?? '[]'); } catch { return []; } };
const remember = (key: string) => { try { localStorage.setItem(RECENT, JSON.stringify([key, ...recents().filter((k) => k !== key)].slice(0, 5))); } catch { /* private mode: nothing to remember */ } };

/* ---------- dates ---------- */
const D = (y: number, m: number, d: number) => isoDate(new Date(y, m, d));
const PRESETS: [string, () => [string, string]][] = [
  ['This month', () => { const n = new Date(); return [D(n.getFullYear(), n.getMonth(), 1), today()]; }],
  ['Last month', () => { const n = new Date(); return [D(n.getFullYear(), n.getMonth() - 1, 1), D(n.getFullYear(), n.getMonth(), 0)]; }],
  ['This quarter', () => { const n = new Date(); return [D(n.getFullYear(), Math.floor(n.getMonth() / 3) * 3, 1), today()]; }],
  ['Last quarter', () => { const n = new Date(), q = Math.floor(n.getMonth() / 3) * 3; return [D(n.getFullYear(), q - 3, 1), D(n.getFullYear(), q, 0)]; }],
  ['This year', () => [D(new Date().getFullYear(), 0, 1), today()]],
  ['Last year', () => { const y = new Date().getFullYear() - 1; return [D(y, 0, 1), D(y, 11, 31)]; }],
  ['Last 12 months', () => { const n = new Date(); return [D(n.getFullYear() - 1, n.getMonth(), n.getDate() + 1), today()]; }],
];
const AS_AT: [string, () => string][] = [['Today', today], ['End of last month', () => { const n = new Date(); return D(n.getFullYear(), n.getMonth(), 0); }], ['End of last quarter', () => { const n = new Date(); return D(n.getFullYear(), Math.floor(n.getMonth() / 3) * 3, 0); }], ['End of last year', () => D(new Date().getFullYear() - 1, 11, 31)]];
const AHEAD: [string, number][] = [['Next 4 weeks', 27], ['Next 8 weeks', 55], ['Next 12 weeks', 83]];
const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDate(d); };

/* ---------- small pieces ---------- */
const TONE: Record<string, string> = { good: 'text-success', bad: 'text-danger', warn: 'text-warn', info: 'text-info' };
const MONEY = /^-?\d+\.\d{2}$/;
const show = (v: any, type?: string) => (type === 'money' && MONEY.test(String(v)) ? Number(v).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v);
const short = (n: number) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const BAR: Record<string, string> = { good: 'rgb(var(--success))', bad: 'rgb(var(--danger))', warn: 'rgb(var(--warn))', accent: 'rgb(var(--accent))' };

/** A small bar chart, drawn here so it follows the light and dark theme exactly. */
function Bars({ chart }: { chart: NonNullable<Rep['chart']> }) {
  const W = 720, H = 190, top = 14, bottom = 34, n = chart.labels.length, all = chart.series.flatMap((s) => s.values), max = Math.max(1, ...all), min = Math.min(0, ...all);
  const span = max - min, y = (v: number) => top + ((max - v) / span) * (H - top - bottom), zero = y(0), gw = (W - 16) / Math.max(1, n), bw = Math.min(46, (gw * 0.7) / chart.series.length);
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted">{chart.series.length > 1 || chart.series[0].name ? chart.series.map((s) => <span key={s.name} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: BAR[s.tone ?? 'accent'] }} />{s.name}</span>) : null}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full" role="img" aria-label={`Bar chart: ${chart.series.map((s) => s.name).join(', ')} by ${chart.labels.join(', ')}`}>
        <line x1="8" x2={W - 8} y1={zero} y2={zero} style={{ stroke: 'rgb(var(--line))' }} />
        {chart.labels.map((lab, i) => {
          const cx = 8 + gw * i + gw / 2, x0 = cx - (bw * chart.series.length) / 2;
          return (
            <g key={`${lab}${i}`}>
              {chart.series.map((s, k) => { const v = s.values[i] ?? 0, yy = y(v), h = Math.max(1, Math.abs(zero - yy));
                return (<g key={s.name}><rect x={x0 + k * bw + 1} y={v >= 0 ? yy : zero} width={Math.max(2, bw - 2)} height={h} rx="2" style={{ fill: BAR[s.tone ?? 'accent'] }}><title>{`${lab} — ${s.name}: ${n2(v)}`}</title></rect>
                  {n <= 7 && v !== 0 && <text x={x0 + k * bw + bw / 2} y={v >= 0 ? yy - 3 : yy + h + 10} textAnchor="middle" fontSize="9" style={{ fill: 'rgb(var(--muted))' }}>{short(v)}</text>}</g>); })}
              <text x={cx} y={H - 14} textAnchor="middle" fontSize="10" style={{ fill: 'rgb(var(--muted))' }}>{lab.length > 16 ? `${lab.slice(0, 15)}…` : lab}</text>
            </g>);
        })}
      </svg>
    </div>
  );
}

/** As many cards per row as fit, so a figure like $75,251.28 is never cut off. */
const KPI_GRID = 'grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]';
/** Each report group gets its own icon and colour so the library is easy to scan. */
const GROUP: [RegExp, LucideIcon, string][] = [[/statement|ledger|account(?!s)/i, Landmark, 'accent'], [/sales|profit/i, LineChart, 'success'], [/client/i, Users, 'info'], [/supplier|payable|payment/i, Truck, 'warn'], [/cash|bank/i, Wallet, 'info'], [/tax/i, Banknote, 'accent'], [/planning|forecast|due|aging|upcoming/i, Clock, 'warn']];
const groupStyle = (label: string): { Icon: LucideIcon; hue: string } => { const g = GROUP.find(([re]) => re.test(label)); return { Icon: g?.[1] ?? BarChart3, hue: g?.[2] ?? 'accent' }; };
const Kpi = ({ label, value, sub, delta, to, tone, icon: Icon, hue = 'accent' }: { label: string; value: string; sub?: ReactNode; delta?: number | null; to: string; tone?: string; icon?: LucideIcon; hue?: string }) => (
  <Link to={to} className="card glow-card block focus-visible:border-accent" style={{ ['--hue' as any]: `var(--${hue})` }}>
    <div className="flex items-start justify-between gap-2"><span className="text-xs font-medium text-muted">{label}</span>{Icon && <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}><Icon size={14} /></span>}</div>
    <div className={`num mt-1.5 text-2xl font-bold tracking-tight ${tone ?? ''}`}>{value}</div>
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">{delta != null && <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 font-medium ${delta >= 0 ? 'bg-success/12 bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>{delta >= 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}{Math.abs(delta).toFixed(0)}%</span>}{sub}</div>
  </Link>
);

/* ---------- the home page ---------- */
function Overview({ cat, open }: { cat: Cat[]; open: (k: string, extra?: Record<string, string>) => void }) {
  const [ov, setOv] = useState<any>(null);
  useEffect(() => { api('/reports/overview').then(setOv).catch(() => setOv(false)); }, []);
  const cur = ov?.currency ?? 'USD', m = ov?.month, p = ov?.previous, all = cat.flatMap((c) => c.reports), mine = recents().map((k) => all.find((r) => r.key === k)).filter(Boolean) as Def[];
  const chg = (a?: number, b?: number) => (b ? ((a! - b) / Math.abs(b)) * 100 : null);
  return (
    <div className="space-y-6">
      {ov === null ? <div className={KPI_GRID}>{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div> : ov && (
        <section aria-label="Key numbers">
          <div className={KPI_GRID}>
            <Kpi icon={LineChart} hue="success" label="Sales this month" value={money(m.revenue, cur)} delta={chg(m.revenue, p.revenue)} sub="vs same days last month" to={`/reports?report=pnl&from=${m.from}&to=${m.to}`} />
            <Kpi icon={BarChart3} hue="accent" label="Profit this month" value={money(m.profit, cur)} delta={chg(m.profit, p.profit)} sub="gross, sales basis" tone={m.profit < 0 ? 'text-danger' : ''} to={`/reports?report=pnl&from=${m.from}&to=${m.to}`} />
            <Kpi icon={Wallet} hue="info" label="Money in / out" value={money(m.cashIn, cur)} sub={<>out {money(m.cashOut, cur)}</>} to={`/reports?report=cash-flow&from=${m.from}&to=${m.to}`} />
            <Kpi icon={Users} hue="warn" label="Owed to you" value={money(ov.receivables.total, cur)} sub={ov.receivables.overdue ? <span className="text-warn">{money(ov.receivables.overdue, cur)} overdue</span> : 'nothing overdue'} to="/reports?report=ar-aging-summary" />
            <Kpi icon={Truck} hue="danger" label="You owe" value={money(ov.payables.total, cur)} sub={ov.payables.overdue ? <span className="text-warn">{money(ov.payables.overdue, cur)} overdue</span> : 'nothing overdue'} to="/reports?report=ap-aging" />
            <Kpi icon={Landmark} hue="info" label="Cash & bank" value={money(ov.cash, cur)} sub="in the ledger now" to="/reports?report=cash-book" />
          </div>
        </section>)}
      {mine.length > 0 && <section><h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Clock size={14} className="text-muted" />Recently opened</h2>
        <div className="flex flex-wrap gap-2">{mine.map((r) => <button key={r.key} className="btn-ghost" onClick={() => open(r.key)}>{r.label}</button>)}</div></section>}
      {cat.map((c) => (
        <section key={c.label}>{(() => { const { Icon, hue } = groupStyle(c.label); return <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}><Icon size={14} /></span>{c.label}<span className="rounded-full bg-surface2 px-2 py-0.5 text-[11px] font-normal text-muted num">{c.reports.length}</span></h2>; })()}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {c.reports.map((r) => { const { hue } = groupStyle(c.label); return (
              <button key={r.key} className="card glow-card group flex items-start justify-between gap-3 text-left" style={{ ['--hue' as any]: `var(--${hue})` }} onClick={() => open(r.key)}>
                <span className="min-w-0"><span className="block font-semibold">{r.label}</span><span className="mt-1 line-clamp-3 block text-xs leading-relaxed text-muted">{r.about}</span>
                  {(r.asAt || r.forecast || r.compare || r.client) && <span className="mt-2 flex flex-wrap gap-1">{r.asAt && <span className="rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] text-muted">As at a date</span>}{r.forecast && <span className="rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] text-muted">Forecast</span>}{r.compare && <span className="rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] text-muted">Compare periods</span>}{r.client && <span className="rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] text-muted">Per client</span>}</span>}</span>
                <ChevronRight size={16} className="mt-1 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-accent" />
              </button>); })}
          </div></section>))}
    </div>
  );
}

/* ---------- the page ---------- */
export default function Reports() {
  const { can } = useAuth(); const nav = useNavigate(); const [sp, setSp] = useSearchParams();
  const finance = can('admin', 'finance_manager', 'viewer'), canSchedule = can('admin', 'finance_manager');
  const cat = useCatalog(), accounts = useAccounts([]);
  const all = useMemo(() => (cat ?? []).flatMap((c) => c.reports), [cat]);
  const key = sp.get('report') ?? '', def = all.find((r) => r.key === key);
  const forecast = !!def?.forecast;
  const from = sp.get('from') || (forecast ? today() : D(new Date().getFullYear(), 0, 1)), to = sp.get('to') || (forecast ? plusDays(55) : today());
  const account = sp.get('account') ?? '', clientId = sp.get('client') ?? '', compare = sp.get('compare') ?? '';
  const go = (patch: Record<string, string | null | undefined>) => { const next = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); } setSp(next, { replace: true }); };

  const [clients, setClients] = useState<any[]>([]), [clientText, setClientText] = useState('');
  const [find, setFind] = useState(''), [rep, setRep] = useState<Rep | null>(null), [err, setErr] = useState(''), [loading, setLoading] = useState(false), [bump, setBump] = useState(0);
  const [ran, setRan] = useState<{ key: string; qs: string } | null>(null), [exporting, setExporting] = useState(''), [sort, setSort] = useState<{ c: number; dir: 1 | -1 } | null>(null), [filter, setFilter] = useState('');
  const seq = useRef(0);

  const ready = !!def && (!def.account || !!account) && (def.client !== 'required' || !!clientId) && (def.asAt || forecast || from <= to);
  const qs = () => new URLSearchParams({ ...(def?.asAt ? {} : { from }), to, ...(def?.account && account ? { account_id: account } : {}), ...(def?.client && clientId ? { client_id: clientId } : {}), ...(def?.compare && compare ? { compare } : {}), ...(forecast ? { from } : {}) }).toString();

  // run as soon as the choices are complete, and again whenever one changes
  useEffect(() => {
    if (!def) return;
    if (!ready) { setRep(null); setErr(''); return; }
    const mine = ++seq.current, q = qs(); setLoading(true); setErr('');
    const t = setTimeout(() => {
      api(`/reports/${def.key}?${q}`).then((r) => { if (mine === seq.current) { setRep(r); setRan({ key: def.key, qs: q }); } })
        .catch((e) => { if (mine === seq.current) { setErr(e.message); setRep(null); } }).finally(() => { if (mine === seq.current) setLoading(false); });
    }, 250);
    return () => clearTimeout(t);
  }, [key, def?.key, from, to, account, clientId, compare, bump]);
  useEffect(() => { setRep(null); setSort(null); setFilter(''); setErr(''); if (key) remember(key); }, [key]);
  useEffect(() => { setSort(null); setFilter(''); }, [rep]);
  useEffect(() => { if (def?.client && !clients.length) api('/clients').then(setClients).catch(() => {}); }, [def?.key]);

  const dupe = useMemo(() => { const seen = new Map<string, number>(); for (const c of clients) seen.set(c.name.toLowerCase(), (seen.get(c.name.toLowerCase()) ?? 0) + 1); return seen; }, [clients]);
  const label = (c: any) => (dupe.get(c.name.toLowerCase())! > 1 ? `${c.name} (#${c.id})` : c.name);   // clients with the same name show their number
  useEffect(() => { const c = clients.find((x) => String(x.id) === clientId); setClientText(c ? label(c) : ''); }, [clientId, clients]);
  const chooseClient = (text: string) => { setClientText(text); const c = clients.find((x) => label(x).toLowerCase() === text.trim().toLowerCase()); if (c) go({ client: String(c.id) }); else if (!text.trim()) go({ client: '' }); };
  const open = (k: string, extra: Record<string, string> = {}) => { const d = all.find((r) => r.key === k); const next: Record<string, string> = { report: k, account: '', compare: '', from: '', to: '', ...extra };
    if (d && !!d.forecast !== forecast) { next.from = ''; next.to = ''; } else { next.from = sp.get('from') ?? ''; next.to = sp.get('to') ?? ''; } go({ ...next, ...extra }); };

  const exp = async (kind: 'pdf' | 'xlsx' | 'csv') => {
    if (!ran) return; setExporting(kind); setErr('');
    try {
      const url = `/reports/${ran.key}?${ran.qs}&format=${kind}`;
      if (kind === 'pdf') await viewPdf(async () => (await api(url)).url, rep?.title ?? 'Report'); else window.open((await api(url)).url);   // what you download is what is on screen
    } catch (e: any) { setErr(e.message); } finally { setExporting(''); }
  };

  /* ----- the table: sort, filter, and where each row leads ----- */
  const types = useMemo(() => rep?.types ?? (rep ? rep.columns.map(() => 'text') : []), [rep]);
  const plain = !!rep && !rep.kinds?.some((k) => k === 'section' || k === 'muted');
  const order = useMemo(() => {
    if (!rep) return [] as number[];
    const idx = rep.rows.map((_, i) => i), foot = idx.filter((i) => rep.kinds?.[i] === 'total');
    let body = idx.filter((i) => rep.kinds?.[i] !== 'total');
    if (!plain) return idx;
    const f = filter.trim().toLowerCase(); if (f) body = body.filter((i) => rep.rows[i].some((c) => String(c ?? '').toLowerCase().includes(f)));
    if (sort) { const t = types[sort.c]; body = [...body].sort((a, b) => { const x = rep.rows[a][sort.c], y = rep.rows[b][sort.c]; return sort.dir * (t === 'money' || t === 'int' ? (Number(x) || 0) - (Number(y) || 0) : String(x ?? '').localeCompare(String(y ?? ''))); }); }
    return [...body, ...foot];
  }, [rep, sort, filter, types, plain]);
  const linkCol = rep ? (rep.columns.includes('Voucher') ? rep.columns.indexOf('Voucher') : rep.columns[0] === 'Code' ? 1 : 0) : 0;
  const bodyCount = rep ? rep.rows.filter((_, i) => rep.kinds?.[i] !== 'total').length : 0, shown = rep ? order.filter((i) => rep.kinds?.[i] !== 'total').length : 0;
  const sortBy = (c: number) => setSort((s) => (s?.c === c ? (s.dir === 1 ? { c, dir: -1 } : null) : { c, dir: 1 }));

  if (!finance) return <Page title="Reports"><div className="card text-sm text-muted">Reports show the agency’s finances, so they are for admins, finance managers and viewers.</div></Page>;

  const menu = (cat ?? []).map((c) => ({ ...c, reports: c.reports.filter((r) => !find.trim() || `${r.label} ${r.about}`.toLowerCase().includes(find.trim().toLowerCase())) })).filter((c) => c.reports.length);
  const inputCls = 'input num';
  return (
    <Page title="Reports" description="The numbers behind the business. Ledger reports tie back to your accounts and show a reconciliation check.">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[230px_minmax(0,1fr)]">
        {/* report list: sidebar on desktop, dropdown on phones */}
        <nav aria-label="Reports" className="card hidden h-fit overflow-hidden p-0 md:sticky md:top-4 md:block md:max-h-[calc(100vh-2rem)] md:overflow-y-auto">
          <div className="relative border-b border-line p-2">
            <Search size={14} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
            <input className="input pl-8 text-sm" placeholder="Find a report…" aria-label="Find a report" value={find} onChange={(e) => setFind(e.target.value)} />
          </div>
          <button onClick={() => go({ report: '' })} aria-current={!key} className={`flex w-full items-center gap-2 border-b border-line px-3 py-2.5 text-left text-sm ${!key ? 'nav-active font-medium text-accent' : 'hover:bg-surface2'}`}><Home size={14} />Overview</button>
          {menu.map((c) => (
            <div key={c.label}>
              <div className="flex items-center gap-1.5 border-b border-line bg-surface2/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted">{(() => { const { Icon } = groupStyle(c.label); return <Icon size={11} />; })()}{c.label}</div>
              {c.reports.map((r) => <button key={r.key} onClick={() => open(r.key)} aria-current={key === r.key} className={`block w-full px-3 py-1.5 text-left text-sm ${key === r.key ? 'nav-active font-medium text-accent' : 'hover:bg-surface2'}`}>{r.label}</button>)}
            </div>))}
          {cat && menu.length === 0 && <div className="px-3 py-4 text-sm text-muted">No report matches “{find}”.</div>}
        </nav>

        <div className="min-w-0">
          <select className="input mb-3 md:hidden" aria-label="Report" value={key} onChange={(e) => (e.target.value ? open(e.target.value) : go({ report: '' }))}>
            <option value="">Overview</option>{(cat ?? []).map((c) => <optgroup key={c.label} label={c.label}>{c.reports.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</optgroup>)}
          </select>

          {cat === null ? <Skeleton className="h-64" /> : !def ? <Overview cat={cat} open={open} /> : (<>
            <div className="card mb-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">{(() => { const c = (cat ?? []).find((x) => x.reports.some((r) => r.key === def.key)); if (!c) return null; const { Icon, hue } = groupStyle(c.label); return <span className="mb-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}><Icon size={11} />{c.label}</span>; })()}<h2 className="text-lg font-bold tracking-tight">{def.label}</h2><p className="mt-0.5 max-w-2xl text-xs text-muted">{def.about}</p></div>
                <div className="flex flex-wrap items-center gap-2">
                  {canSchedule && !def.account && def.client !== 'required' && !forecast && <Link to={`/automation?schedule=${def.key}`} className="btn-ghost"><CalendarClock size={15} />Schedule</Link>}
                  <button className="btn-icon border border-line" aria-label="Run again" title="Run again" onClick={() => setBump((n) => n + 1)} disabled={!ready || loading}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
                  <Popover trigger={(_o, t) => <button className="btn" onClick={t} disabled={!rep || !!exporting}><Download size={15} />{exporting ? 'Preparing…' : 'Download'}</button>}>
                    {(close) => <>
                      <MenuBtn onClick={() => { close(); exp('pdf'); }}><FileText size={15} /> PDF (view or print)</MenuBtn>
                      <MenuBtn onClick={() => { close(); exp('xlsx'); }}><FileSpreadsheet size={15} /> Excel</MenuBtn>
                      <MenuBtn onClick={() => { close(); exp('csv'); }}><Table2 size={15} /> CSV</MenuBtn>
                    </>}
                  </Popover>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-end gap-3">
                {def.account && <div className="min-w-[14rem] flex-1"><div className="mb-1 text-xs text-muted">Account</div>
                  <select className="input" value={account} onChange={(e) => go({ account: e.target.value })}><option value="">Choose an account…</option>{accounts.map((a: any) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></div>}
                {def.client && <div className="min-w-[14rem] flex-1"><div className="mb-1 text-xs text-muted">Client{def.client === 'optional' && ' (optional)'}</div>
                  <input className="input" list="report-clients" placeholder={def.client === 'required' ? 'Start typing a client name…' : 'All clients — type to pick one'} value={clientText} onChange={(e) => chooseClient(e.target.value)} />
                  <datalist id="report-clients">{clients.map((c) => <option key={c.id} value={label(c)} />)}</datalist></div>}
                {!def.asAt && <div><div className="mb-1 text-xs text-muted">{forecast ? 'Starting' : 'From'}</div><input className={inputCls} type="date" value={from} max={forecast ? undefined : to} onChange={(e) => e.target.value && go({ from: e.target.value })} /></div>}
                <div><div className="mb-1 text-xs text-muted">{def.asAt ? 'As at' : forecast ? 'Until' : 'To'}</div><input className={inputCls} type="date" value={to} min={def.asAt || forecast ? undefined : from} onChange={(e) => e.target.value && go({ to: e.target.value })} /></div>
                {def.compare && <div><div className="mb-1 text-xs text-muted">Compare with</div>
                  <select className="input" value={compare} onChange={(e) => go({ compare: e.target.value })}><option value="">Nothing</option><option value="prev">The period before</option><option value="year">Same period last year</option></select></div>}
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Quick dates">
                {def.asAt ? AS_AT.map(([l, f]) => <button key={l} className="rounded-full border border-line px-2.5 py-1 text-xs text-muted transition hover:border-accent/50 hover:bg-surface2 hover:text-fg" onClick={() => go({ to: f() })}>{l}</button>)
                  : forecast ? AHEAD.map(([l, n]) => <button key={l} className="rounded-full border border-line px-2.5 py-1 text-xs text-muted transition hover:border-accent/50 hover:bg-surface2 hover:text-fg" onClick={() => go({ from: today(), to: plusDays(n) })}>{l}</button>)
                    : PRESETS.map(([l, f]) => <button key={l} className="rounded-full border border-line px-2.5 py-1 text-xs text-muted transition hover:border-accent/50 hover:bg-surface2 hover:text-fg" onClick={() => { const [a, b] = f(); go({ from: a, to: b }); }}>{l}</button>)}
              </div>
            </div>

            {err && <div className="mb-3 text-sm text-danger" role="alert">{err}</div>}
            {!ready && !err && <div className="card py-12 text-center text-sm text-muted">{def.client === 'required' && !clientId ? 'Choose a client to see their statement.' : def.account && !account ? 'Choose an account to see its ledger.' : 'The start date is after the end date.'}</div>}
            {ready && !rep && !err && <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-56" /></div>}

            {rep && (
              <div className={loading ? 'opacity-60 transition' : 'transition'}>
                {rep.summary && rep.summary.length > 0 && (
                  <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                    {rep.summary.map((s) => <div key={s.label} className={`card !py-3 ${s.tone === 'bad' ? 'border-l-4 !border-l-danger' : s.tone === 'warn' ? 'border-l-4 !border-l-warn' : s.tone === 'good' ? 'border-l-4 !border-l-success' : ''}`}><div className="text-xs font-medium text-muted">{s.label}</div><div className={`num mt-1 text-xl font-bold tracking-tight ${s.tone ? TONE[s.tone] : ''}`}>{s.unit === '%' ? `${show(s.value, 'money')}%` : show(s.value, MONEY.test(s.value) ? 'money' : undefined)}</div></div>)}
                  </div>)}
                {rep.reconcile && <div className="mb-4 space-y-2">{rep.reconcile.map((c) => (
                  <div key={c.label} className={`flex flex-wrap justify-between gap-2 rounded-lg border p-3 text-sm ${c.ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>
                    <span className="flex items-center gap-2">{c.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}<span><b>{c.ok ? 'Reconciled' : 'Does not reconcile'}</b> — {c.label}</span></span>
                    <span className="num">report {show(c.report.toFixed(2), 'money')} · source {show(c.source.toFixed(2), 'money')}{!c.ok && ` · diff ${show(c.difference.toFixed(2), 'money')}`}</span></div>))}</div>}
                {rep.hints?.map((h) => <div key={h} className="mb-3 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm text-warn" role="note"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>{h}</span></div>)}
                {rep.chart && rep.chart.labels.length > 0 && <div className="card mb-4"><Bars chart={rep.chart} /></div>}

                <h3 className="mb-1 flex items-center gap-2 font-bold">{rep.title}{ran && <span className="rounded-full bg-surface2 px-2 py-0.5 text-[11px] font-normal text-muted num">{bodyCount} row{bodyCount === 1 ? '' : 's'}</span>}</h3>
                {rep.note && <p className="mb-3 text-xs text-muted">{rep.note}</p>}
                {plain && bodyCount > 12 && (
                  <div className="relative mb-2 max-w-xs"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                    <input className="input pl-8 text-sm" placeholder="Filter these rows…" aria-label="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>)}
                <div className="card max-h-[75vh] overflow-auto p-0">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-surface"><tr className="border-b border-line">
                      {rep.columns.map((c, i) => {
                        const right = types[i] === 'money' || types[i] === 'int', on = sort?.c === i;
                        return <th key={i} aria-sort={on ? (sort!.dir === 1 ? 'ascending' : 'descending') : undefined} className={`px-3 py-2 text-xs font-medium text-muted ${right ? 'text-right' : 'text-left'}`}>
                          {plain && rep.rows.length > 2 ? <button className={`inline-flex items-center gap-1 hover:text-fg ${right ? 'flex-row-reverse' : ''}`} onClick={() => sortBy(i)}>{c}{on ? (sort!.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : <ArrowUpDown size={11} className="opacity-40" />}</button> : c}</th>; })}
                    </tr></thead>
                    <tbody>
                      {rep.rows.length > 0 && !!filter.trim() && shown === 0 && <tr><td colSpan={rep.columns.length} className="px-3 py-8 text-center text-sm text-muted">No rows match “{filter}”.</td></tr>}
                      {order.map((i) => {
                        const row = rep.rows[i], kind = rep.kinds?.[i] ?? '', link = rep.links?.[i];
                        return (
                          <tr key={i} onClick={link ? () => nav(link) : undefined} className={`border-b border-line/40 ${link ? 'cursor-pointer' : ''} ${kind === 'total' ? 'bg-surface2 font-semibold' : kind === 'section' ? 'bg-accent/5 font-semibold tracking-wide text-accent' : kind === 'muted' ? 'italic text-muted' : 'hover:bg-surface2'}`}>
                            {row.map((cell, j) => {
                              const right = (types[j] === 'money' || types[j] === 'int') && kind !== 'section', neg = types[j] === 'money' && Number(cell) < 0 && kind !== 'total';
                              return <td key={j} className={`px-3 py-1.5 ${right ? 'num whitespace-nowrap text-right' : ''} ${neg ? 'text-danger' : ''}`}>{link && j === linkCol && cell !== '' ? <Link className="text-accent hover:underline" to={link} onClick={(e) => e.stopPropagation()}>{cell}</Link> : show(cell, types[j])}</td>; })}
                          </tr>); })}
                      {rep.rows.length === 0 && <tr><td colSpan={rep.columns.length} className="px-3 py-10 text-center text-sm text-muted">Nothing to report for this period. Try a wider date range.</td></tr>}
                    </tbody>
                  </table>
                </div>
                {plain && bodyCount > 12 && <p className="mt-1.5 text-xs text-muted">{filter.trim() ? `Showing ${shown} of ${bodyCount} rows` : `${bodyCount} rows`}</p>}
              </div>)}
          </>)}
        </div>
      </div>
    </Page>
  );
}
