import { ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Banknote, BarChart3, BookOpen, Briefcase, Building2, CalendarClock, Calculator as CalcIcon, Check, ChevronRight, ChevronsLeft, ChevronsUpDown,
  Coins, CreditCard, FileMinus, FileSignature, FileText, HandCoins, LineChart, Truck, LayoutDashboard, Library, LogOut, Menu as MenuIcon, Monitor, Moon, NotebookPen, Percent, Plane, Plus, ScrollText, Search, Settings, ShieldCheck, Sun, Target, Ticket, TrendingUp, Undo2, Users, Wallet, X,
} from 'lucide-react';
import { api } from '../api';
import { useAuth, AgencyRef } from '../auth';
import { ThemeMode, useTheme } from '../theme';
import Calculator from './Calculator';
import Fallback from './Fallback';

type Role = AgencyRef['role'];
interface Item { to: string; label: string; icon: ReactNode; roles?: Role[] }
const I = (C: any) => <C size={17} strokeWidth={1.8} />;
const FINANCE: Role[] = ['admin', 'finance_manager', 'viewer'];

// module: which package module(s) gate this group. null = always visible. Array = visible if ANY match.
const GROUPS: { title: string; module: string | string[] | null; items: Item[] }[] = [
  { title: 'Overview', module: null, items: [{ to: '/', label: 'Dashboard', icon: I(LayoutDashboard) }, { to: '/operations', label: 'Operations', icon: I(CalendarClock) }] },
  { title: 'Sales', module: 'crm', items: [{ to: '/leads', label: 'Leads', icon: I(Target) }, { to: '/quotes', label: 'Quotes', icon: I(FileSignature) }, { to: '/bookings', label: 'Bookings', icon: I(Briefcase) }, { to: '/clients', label: 'Clients', icon: I(Users) }] },
  { title: 'Ticketing', module: 'ticketing', items: [{ to: '/ticket-invoices', label: 'Ticket Invoices', icon: I(Ticket) }, { to: '/refunds', label: 'Refunds', icon: I(Undo2) }, { to: '/ticket-search', label: 'Ticket Search', icon: I(Search) }, { to: '/airlines', label: 'Airlines', icon: I(Plane) }, { to: '/sale-reports', label: 'Sale Reports', icon: I(TrendingUp), roles: FINANCE }] },
  { title: 'Finance & Accounting', module: ['finance', 'accounting'], items: [
    // Overview & client-side
    { to: '/finance', label: 'Overview', icon: I(LineChart), roles: FINANCE },
    { to: '/invoices', label: 'Invoices', icon: I(FileText) },
    { to: '/client-receipts', label: 'Client Receipts', icon: I(HandCoins), roles: FINANCE },
    { to: '/credit-notes', label: 'Credit Notes & Refunds', icon: I(FileMinus), roles: FINANCE },
    { to: '/payments', label: 'Payments', icon: I(CreditCard) },
    { to: '/statements', label: 'Statements', icon: I(ScrollText), roles: FINANCE },
    // Supplier-side
    { to: '/supplier-bills', label: 'Supplier Bills', icon: I(Truck), roles: FINANCE },
    { to: '/payment-runs', label: 'Payment Runs', icon: I(Banknote), roles: FINANCE },
    // Cash & Bank
    { to: '/cash-bank', label: 'Cash / Bank', icon: I(Wallet), roles: FINANCE },
    { to: '/reconciliation', label: 'Bank Reconciliation', icon: I(ArrowLeftRight), roles: FINANCE },
    { to: '/receipts', label: 'Cash Receipts', icon: I(ArrowDownToLine), roles: FINANCE },
    { to: '/payment-vouchers', label: 'Cash Payments', icon: I(ArrowUpFromLine), roles: FINANCE },
    // General Ledger
    { to: '/accounts', label: 'Accounts & Ledger', icon: I(BookOpen), roles: FINANCE },
    { to: '/journal', label: 'Journal Voucher', icon: I(NotebookPen), roles: FINANCE },
    // Other
    { to: '/suppliers', label: 'Suppliers', icon: I(Building2) },
    { to: '/commissions', label: 'Commissions', icon: I(Percent) },
    { to: '/exchange-rates', label: 'Exchange Rates', icon: I(Coins), roles: FINANCE },
    { to: '/client-portal', label: 'Client Portal', icon: I(Users), roles: FINANCE },
    { to: '/cheque-format', label: 'Cheque Format', icon: I(Banknote), roles: FINANCE },
    { to: '/reports', label: 'Reports', icon: I(BarChart3), roles: FINANCE },
  ]},
  { title: 'Insights & Automation', module: 'insights', items: [{ to: '/reports', label: 'Reports', icon: I(BarChart3) }, { to: '/automation', label: 'Automation', icon: I(CalendarClock), roles: FINANCE }, { to: '/integrations', label: 'Integrations', icon: I(ArrowLeftRight), roles: FINANCE }] },
  { title: 'Administration', module: null, items: [{ to: '/settings', label: 'Settings', icon: I(Settings) }, { to: '/team', label: 'Team & Branches', icon: I(Users), roles: ['admin', 'finance_manager'] }, { to: '/billing', label: 'Billing', icon: I(CreditCard), roles: ['admin'] }, { to: '/audit', label: 'Audit Log', icon: I(ScrollText), roles: ['admin', 'finance_manager'] }] },
];
const FLAT = GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title })));
const findItem = (p: string) => FLAT.find((i) => i.to === p);
const labelFor = (p: string) => findItem(p)?.label ?? (p.startsWith('/bookings/') ? 'Booking' : p.startsWith('/quotes/') ? 'Quote' : undefined);
const groupFor = (p: string) => findItem(p)?.group ?? (p.startsWith('/bookings/') ? 'Sales' : p.startsWith('/quotes/') ? 'Sales' : '');

/* ---------- small popover ---------- */
function Popover({ trigger, children, align = 'right', width = 'w-56' }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: string }) {
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
const MenuBtn = ({ onClick, children, active }: { onClick(): void; children: ReactNode; active?: boolean }) => (
  <button onClick={onClick} className={`flex w-full items-center gap-2.5 px-2.5 py-2 text-sm rounded-lg text-left hover:bg-surface2 ${active ? 'text-accent' : ''}`}>{children}</button>
);

/* ---------- theme switch ---------- */
function ThemeMenu() {
  const { mode, resolved, setMode } = useTheme();
  const opts: { m: ThemeMode; label: string; icon: ReactNode }[] = [{ m: 'light', label: 'Light', icon: <Sun size={15} /> }, { m: 'dark', label: 'Dark', icon: <Moon size={15} /> }, { m: 'system', label: 'System', icon: <Monitor size={15} /> }];
  return (
    <Popover width="w-40" trigger={(_o, toggle) => <button className="btn-icon" onClick={toggle} aria-label={`Theme: ${mode}`} title="Theme">{resolved === 'dark' ? <Moon size={18} /> : <Sun size={18} />}</button>}>
      {(close) => opts.map((o) => <MenuBtn key={o.m} active={mode === o.m} onClick={() => { setMode(o.m); close(); }}>{o.icon}<span className="flex-1">{o.label}</span>{mode === o.m && <Check size={14} />}</MenuBtn>)}
    </Popover>
  );
}

/* ---------- global search (⌘/Ctrl+K) ---------- */
function GlobalSearch() {
  const nav = useNavigate(); const [q, setQ] = useState(''); const [res, setRes] = useState<any[]>([]); const [open, setOpen] = useState(false); const [sel, setSel] = useState(0);
  const ref = useRef<HTMLDivElement>(null); const input = useRef<HTMLInputElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false); document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus(); } }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return; }
    const id = setTimeout(() => api(`/admin/search?q=${encodeURIComponent(q.trim())}`).then((r) => { setRes(r); setSel(0); setOpen(true); }).catch(() => setRes([])), 220);
    return () => clearTimeout(id);
  }, [q]);
  const go = (r: any) => { setOpen(false); setQ(''); nav(r.route); };
  return (
    <div className="relative flex-1 max-w-md" ref={ref}>
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
      <input ref={input} className="input !pl-9 !pr-14 !bg-surface2/60" placeholder="Search clients, invoices, tickets…" aria-label="Global search" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => res.length && setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, res.length - 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); } else if (e.key === 'Enter' && res[sel]) go(res[sel]); else if (e.key === 'Escape') { setOpen(false); input.current?.blur(); } }} />
      <span className="kbd absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none hidden sm:inline-flex">⌘K</span>
      {open && q.trim().length >= 2 && (
        <div className="absolute left-0 right-0 z-50 mt-2 max-h-96 overflow-auto bg-surface border border-line rounded-xl shadow-pop p-1.5" role="listbox">
          {res.length === 0 && <div className="px-3 py-3 text-sm text-muted">No matches for “{q}”</div>}
          {res.map((r, i) => (
            <button key={i} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => go(r)} className={`flex w-full items-center justify-between gap-3 text-left px-3 py-2 text-sm rounded-lg ${i === sel ? 'bg-surface2' : ''}`}>
              <span className="truncate">{r.label}{r.sub && <span className="text-muted"> · {r.sub}</span>}</span><span className="text-[11px] font-medium text-accent shrink-0">{r.type}</span></button>))}
        </div>)}
    </div>
  );
}

/* ---------- sidebar ---------- */
function SidebarBody({ collapsed, onNavigate, onCollapse, allowedModules }: { collapsed: boolean; onNavigate?(): void; onCollapse?(): void; allowedModules?: string[] | null }) {
  const { user, agency, agencies, switchAgency } = useAuth();
  const role = agency?.role ?? 'viewer';
  const isPlatformAdmin = !!user?.is_platform_admin;
  const nav = useNavigate();
  const canSwitch = agencies.length > 1 || isPlatformAdmin;
  return (
    <div className="flex h-full flex-col">
      <div className={`flex items-center h-14 shrink-0 px-4 border-b border-line ${collapsed ? 'justify-center' : 'justify-between'}`}>
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-8 w-8 rounded-lg bg-accent text-accent-ink grid place-items-center shrink-0"><Plane size={17} strokeWidth={2.2} /></div>
          {!collapsed && <div className="font-head font-extrabold text-[15px] tracking-tight truncate"><span className="text-accent">Travel</span>Finance</div>}
        </div>
      </div>
      {!collapsed && (
        <div className="px-3 pt-3">
          {canSwitch ? (
            <Popover align="left" width="w-64" trigger={(_o, t) => (
              <button onClick={t} className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface2/50 px-2.5 py-2 text-left text-sm hover:bg-surface2">
                <span className="flex-1 truncate font-medium">{agency?.name}</span>
                <ChevronsUpDown size={14} className="text-muted" />
              </button>)}>
              {(close) => (
                <>
                  {agencies.map((a) => (
                    <MenuBtn key={a.id} active={a.id === agency?.id} onClick={() => { close(); switchAgency(a.id); }}>
                      <span className="flex-1 truncate">{a.name}</span>
                      <span className="text-[11px] text-muted capitalize">{a.role.replace('_', ' ')}</span>
                    </MenuBtn>
                  ))}
                  {isPlatformAdmin && (
                    <>
                      {agencies.length > 0 && <div className="border-t border-line my-1" />}
                      <MenuBtn onClick={() => { close(); nav('/platform'); }}>
                        <ShieldCheck size={14} className="text-muted" /><span className="flex-1 truncate">Platform console</span>
                        <span className="text-[11px] text-muted">Switch workspace</span>
                      </MenuBtn>
                    </>
                  )}
                </>
              )}
            </Popover>
          ) : <div className="rounded-lg border border-line bg-surface2/50 px-2.5 py-2 text-sm font-medium truncate">{agency?.name}</div>}
        </div>)}
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-4" aria-label="Main">
        {GROUPS.map((g) => {
          // null module = always visible; string[] = visible if ANY match; otherwise check single module
          const mods = Array.isArray(g.module) ? g.module : g.module ? [g.module] : null;
          if (mods !== null && allowedModules != null && !mods.some((m) => allowedModules.includes(m))) return null;
          const items = g.items.filter((i) => !i.roles || i.roles.includes(role));
          if (!items.length) return null;
          return (
            <div key={g.title}>
              {!collapsed ? <div className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted/80">{g.title}</div> : <div className="mx-2 mb-1.5 border-t border-line first:hidden" />}
              <div className="space-y-0.5">{items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'} onClick={onNavigate} title={collapsed ? i.label : undefined}
                  className={({ isActive }) => `group flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors ${collapsed ? 'justify-center' : ''} ${isActive ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-fg hover:bg-surface2'}`}>
                  {i.icon}{!collapsed && <span className="truncate">{i.label}</span>}</NavLink>))}</div>
            </div>);
        })}
      </nav>
      {onCollapse && <div className="hidden lg:block shrink-0 border-t border-line p-3">
        <button onClick={onCollapse} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-muted hover:text-fg hover:bg-surface2 ${collapsed ? 'justify-center' : ''}`}>
          <ChevronsLeft size={17} className={collapsed ? 'rotate-180' : ''} />{!collapsed && <span>Collapse</span>}</button></div>}
    </div>
  );
}

export default function Layout() {
  const { user, agency, logout } = useAuth();
  const [bill, setBill] = useState<any>(null); const { support } = useAuth();
  useEffect(() => { if (agency) api('/billing/subscription').then(setBill).catch(() => setBill(null)); }, [agency?.id, useLocation().pathname]);   // refreshed on navigation so the banner clears after paying
  const role = agency?.role ?? 'viewer';
  const loc = useLocation(); const nav = useNavigate(); const path = loc.pathname;
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('tf-sidebar') === '1'; } catch { return false; } });
  const [mobile, setMobile] = useState(false); const [calc, setCalc] = useState(false);
  useEffect(() => { try { localStorage.setItem('tf-sidebar', collapsed ? '1' : '0'); } catch { /* ignore */ } }, [collapsed]);
  useEffect(() => { setMobile(false); }, [path]);
  const initials = (user?.name ?? '?').split(' ').map((s: string) => s[0]).slice(0, 2).join('').toUpperCase();
  const g = groupFor(path), l = labelFor(path);
  const canCreate = agency?.role !== 'viewer';

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:btn" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
      {/* desktop sidebar */}
      <aside className={`hidden lg:block fixed inset-y-0 left-0 z-40 bg-surface border-r border-line transition-[width] duration-200 ${collapsed ? 'w-[68px]' : 'w-64'}`}>
        <SidebarBody collapsed={collapsed} onCollapse={() => setCollapsed((c) => !c)} allowedModules={bill?.allowed_modules ?? null} />
      </aside>
      {/* mobile drawer */}
      {mobile && <div className="lg:hidden fixed inset-0 z-50 flex"><div className="w-72 max-w-[85vw] bg-surface border-r border-line shadow-pop"><SidebarBody collapsed={false} onNavigate={() => setMobile(false)} allowedModules={bill?.allowed_modules ?? null} /></div><button aria-label="Close menu" className="flex-1 bg-black/50 backdrop-blur-sm" onClick={() => setMobile(false)} /></div>}

      <div className={`transition-[padding] duration-200 ${collapsed ? 'lg:pl-[68px]' : 'lg:pl-64'}`}>
        <header className="sticky top-0 z-30 h-14 flex items-center gap-3 px-4 md:px-8 bg-bg/80 backdrop-blur border-b border-line">
          <button className="btn-icon lg:hidden -ml-2" onClick={() => setMobile(true)} aria-label="Open menu"><MenuIcon size={20} /></button>
          <nav aria-label="Breadcrumb" className="hidden md:flex items-center gap-1.5 text-sm text-muted min-w-0 shrink-0">
            {g && <><span>{g}</span><ChevronRight size={14} /></>}<span className="text-fg font-medium truncate">{l ?? 'TravelFinance'}</span></nav>
          <div className="flex-1 flex justify-center md:justify-end lg:justify-center px-0 md:px-4"><GlobalSearch /></div>
          <div className="flex items-center gap-1">
            {canCreate && (
              <Popover width="w-52" trigger={(_o, t) => <button className="btn !px-3" onClick={t}><Plus size={16} /><span className="hidden sm:inline">Create</span></button>}>
                {(close) => ([['New quote', '/quotes/new', FileSignature], ['New lead', '/leads?new=1', Target], ['New booking', '/bookings?new=1', Briefcase], ['New ticket invoice', '/ticket-invoices?new=1', Ticket], ['New invoice', '/invoices?new=1', FileText],
                  ...(agency?.role !== 'agent' ? [['Client receipt', '/client-receipts?new=1', HandCoins], ['Supplier bill', '/supplier-bills?new=1', Truck], ['Journal voucher', '/journal?new=1', NotebookPen]] : [])] as [string, string, any][]).map(([label, to, Icon]) => (
                  <MenuBtn key={to} onClick={() => { close(); nav(to); }}><Icon size={15} className="text-muted" />{label}</MenuBtn>))}
              </Popover>)}
            <button className="btn-icon hidden sm:inline-flex" onClick={() => setCalc(true)} aria-label="Calculator" title="Calculator"><CalcIcon size={18} /></button>
            <ThemeMenu />
            <Popover width="w-60" trigger={(_o, t) => <button onClick={t} aria-label="Account menu" className="ml-1 h-9 w-9 rounded-full bg-accent/15 text-accent text-xs font-semibold grid place-items-center hover:bg-accent/25">{initials}</button>}>
              {(close) => <>
                <div className="px-2.5 py-2"><div className="text-sm font-medium truncate">{user?.name}</div><div className="text-xs text-muted truncate">{user?.email}</div><div className="mt-1 text-[11px] capitalize text-accent">{agency?.role.replace('_', ' ')} · {agency?.name}</div></div>
                {user?.is_platform_admin && <MenuBtn onClick={() => { close(); nav('/platform'); }}><ShieldCheck size={15} className="text-muted" />Platform console</MenuBtn>}<div className="my-1 border-t border-line" /><MenuBtn onClick={() => { close(); nav('/settings'); }}><Settings size={15} className="text-muted" />Settings</MenuBtn>
                <MenuBtn onClick={() => { close(); logout(); }}><LogOut size={15} className="text-muted" />Sign out</MenuBtn></>}
            </Popover>
          </div>
        </header>
        {support && <div role="status" className="px-4 md:px-8 py-2 text-sm bg-info/15 text-info border-b border-info/30">Support session — read-only view of this workspace. The customer can see and end this access. Reloading the page ends it.</div>}
        {bill?.banner && bill.banner.level !== 'info' && <div role="status" className={`px-4 md:px-8 py-2 text-sm flex flex-wrap items-center gap-x-3 border-b ${bill.banner.level === 'danger' ? 'bg-danger/10 text-danger border-danger/30' : 'bg-warn/10 text-warn border-warn/30'}`}><span>{bill.banner.message}</span>{role === 'admin' && <NavLink to="/billing" className="underline font-medium">Go to Billing</NavLink>}</div>}
        <main id="main" tabIndex={-1} className="outline-none"><Suspense fallback={<Fallback />}><Outlet /></Suspense></main>
      </div>
      {calc && <Calculator onClose={() => setCalc(false)} />}
    </div>
  );
}
