import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, useNavigate } from 'react-router-dom';
import { Activity, Check, Copy, Infinity as InfinityIcon, LayoutGrid, List, MoreHorizontal, AlertTriangle, ArrowRight, Building2, ScrollText, Server, CheckSquare, Clock, CornerDownLeft, DollarSign, Layers, LayoutDashboard, LogOut, Plane, Plus, Search, Settings, ShieldAlert, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Avatar, Err, Field, Modal, Pager, Pill, Skeleton, Table } from '../components/ui';
import { ThemeMenuButton } from '../components/ThemeToggle';
import { PlatformOperators, PlatformUsers, rel } from './PlatformPeople';
import { PlatformAudit } from './PlatformAudit';
import { PlatformSecurity } from './PlatformSecurity';
import { PlatformSystem } from './PlatformSystem';
import { PlatformApprovals } from './PlatformApprovals';

const day = (d: any) => (d ? String(d).replace('T', ' ').slice(0, 16) : '—');
const FEATURES = ['portal', 'accounting_export', 'automation', 'scheduled_reports', 'integrations', 'api', 'ai_assistant'];
const MODULE_CODES: { code: string; label: string }[] = [
  { code: 'crm', label: 'CRM (Leads, Quotes, Bookings, Clients)' },
  { code: 'ticketing', label: 'Ticketing (Ticket Invoices, Refunds, Airlines)' },
  { code: 'finance', label: 'Finance (Invoices, Payments, Suppliers, Reconciliation)' },
  { code: 'accounting', label: 'Accounting (Ledger, Journals, Cash / Bank)' },
  { code: 'insights', label: 'Insights & Automation (Reports, Automation, Integrations)' },
];
type Cap = 'read' | 'support' | 'billing' | 'suspend';
interface Me { email: string; role: string; caps: Cap[] }
const OpCtx = createContext<{ me: Me; guarded<T>(fn: () => Promise<T>): Promise<T> }>(null as any);
const useOp = () => useContext(OpCtx);
type Tab = 'dashboard' | 'overview' | 'agencies' | 'users' | 'plans' | 'audit' | 'security' | 'system' | 'operators' | 'approvals';

const TAB_ICON: Record<string, any> = { dashboard: LayoutDashboard, overview: Activity, agencies: Building2, users: Users, plans: Layers, audit: ScrollText, approvals: CheckSquare, operators: Users, security: ShieldAlert, system: Server };
const TAB_HEAD: Record<string, [string, string]> = {
  dashboard: ['Dashboard', 'The whole platform at a glance: revenue, trials, agencies and what needs attention.'], overview: ['Overview', 'Fleet-wide usage and health.'],
  agencies: ['Agencies', 'Every customer agency, its plan and status.'], users: ['People', 'Every account on the platform: find anyone, see where they work, and reset, sign out or switch off an account.'], plans: ['Plans', 'Prices, limits and features customers can choose from.'],
  audit: ['Operator audit', 'Every operator action, kept as an append-only record.'], approvals: ['Approvals', 'Suspensions that need a second operator.'],
  operators: ['Operators', 'Who can use this console, and what they can do.'], security: ['Security events', 'Sign-in and access events across all agencies.'], system: ['System', 'Service health and background jobs.'],
};


/* ------------------------------------------------------------------ command palette (⌘K) ------------------------------------------------------------------ */
type PaletteItem = { id: string; label: string; hint: string; icon: any; run(): void };
/** Jump to any section, or type two letters to find an agency. Arrow keys move, Enter opens, Esc closes. */
function Palette({ tabs, onTab, onAgency, onClose }: { tabs: [Tab, string][]; onTab(t: Tab): void; onAgency(id: number): void; onClose(): void }) {
  const [q, setQ] = useState(''); const [ag, setAg] = useState<any[]>([]); const [sel, setSel] = useState(0); const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setAg([]); return; }
    let live = true; const h = setTimeout(() => api(`/platform/agencies?q=${encodeURIComponent(q.trim())}`).then((r) => live && setAg(r.rows.slice(0, 6))).catch(() => live && setAg([])), 200);
    return () => { live = false; clearTimeout(h); };
  }, [q]);
  const s = q.trim().toLowerCase();
  const items: PaletteItem[] = [
    ...ag.map((a) => ({ id: `a${a.id}`, label: a.name, hint: `Agency #${a.id} · ${a.plan_name ?? 'no plan'} · ${a.status ?? 'cancelled'}`, icon: Building2, run: () => onAgency(a.id) })),
    ...tabs.filter(([, l]) => !s || l.toLowerCase().includes(s)).map(([k, l]) => ({ id: k, label: l, hint: TAB_HEAD[k][1], icon: TAB_ICON[k], run: () => onTab(k) })),
  ];
  useEffect(() => { setSel(0); }, [q, ag.length]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); items[sel].run(); onClose(); }
    else if (e.key === 'Escape') onClose();
  };
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/55 p-4 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-label="Command palette" className="pop-in w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-pop" onKeyDown={key}>
        <div className="flex items-center gap-3 border-b border-line px-4"><Search size={16} className="shrink-0 text-muted" />
          <input autoFocus className="h-12 w-full bg-transparent text-sm outline-none focus-visible:!ring-0 focus-visible:!ring-offset-0 placeholder:text-muted" placeholder="Jump to a section, or search agencies…" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          <kbd className="kbd">esc</kbd></div>
        <div ref={list} role="listbox" className="max-h-80 overflow-auto p-2">
          {!items.length && <div className="px-3 py-8 text-center text-sm text-muted">{q.trim().length < 2 ? 'Nothing matches.' : 'No section or agency matches.'}</div>}
          {items.map((it, i) => { const I = it.icon; return (
            <button key={it.id} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => { it.run(); onClose(); }}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${i === sel ? 'bg-accent/12 bg-accent/10' : ''}`}>
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${i === sel ? 'bg-accent text-accent-ink' : 'bg-surface2 text-muted'}`}><I size={15} /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{it.label}</span><span className="block truncate text-xs text-muted">{it.hint}</span></span>
              {i === sel && <CornerDownLeft size={14} className="shrink-0 text-muted" />}</button>); })}
        </div>
        <div className="flex items-center gap-4 border-t border-line bg-surface2/50 px-4 py-2 text-[11px] text-muted"><span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move</span><span><kbd className="kbd">↵</kbd> open</span><span className="ml-auto">Type 2+ letters to search agencies</span></div>
      </div>
    </div>, document.body);
}

/** Operator-only console: fleet overview, agencies, plans, audit. Every change asks for a reason and is written to an append-only log. */
export default function Platform() {
  const { user, ready, logout } = useAuth(); const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('dashboard'); const [need2fa, setNeed2fa] = useState(false);
  const [me, setMe] = useState<Me | null>(null); const [pending, setPending] = useState(0);
  const [palette, setPalette] = useState(false); const [focus, setFocus] = useState<number | null>(null); const [focusUser, setFocusUser] = useState<number | null>(null);
  useEffect(() => { const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []);
  useEffect(() => { if (tab) refreshPending(); }, [tab, me]);
  const refreshPending = () => { if (me?.caps.includes('suspend')) api('/platform/approvals?status=pending').then((r) => setPending(r.length)).catch(() => {}); };
  useEffect(() => { if (user?.is_platform_admin) api('/platform/me').then(setMe).catch((e) => e.data?.code === 'platform_2fa_required' ? setNeed2fa(true) : null); }, [user]);
  const guarded = async <T,>(fn: () => Promise<T>): Promise<T> => fn();
  if (!ready) return <div className="min-h-screen grid place-items-center"><div className="h-8 w-8 rounded-full border-2 border-line border-t-accent animate-spin" role="status" aria-label="Loading" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.is_platform_admin) return <Navigate to="/" replace />;

  // Sidebar nav groups (desktop)
  const navGroups: { label: string; items: [Tab, string][] }[] = me ? [
    { label: 'Main', items: [['dashboard', 'Dashboard'], ['overview', 'Overview'], ['agencies', 'Agencies'], ...(me.caps.includes('support') ? [['users', 'People']] as [Tab, string][] : [])] },
    { label: 'Operations', items: [['plans', 'Plans'], ['audit', 'Operator audit'], ...(me.caps.includes('suspend') ? [['approvals', 'Approvals'], ['operators', 'Operators']] as [Tab, string][] : [])] },
    { label: 'System', items: [['security', 'Security events'], ['system', 'System']] },
  ] : [];

  // Mobile flat tab list
  const allTabs: [Tab, string][] = [['dashboard', 'Dashboard'], ['overview', 'Overview'], ['agencies', 'Agencies'], ...(me?.caps.includes('support') ? [['users', 'People']] as [Tab, string][] : []), ['plans', 'Plans'], ['audit', 'Operator audit'], ['security', 'Security events'], ['system', 'System'], ...(me?.caps.includes('suspend') ? [['approvals', 'Approvals'], ['operators', 'Operators']] as [Tab, string][] : [])];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-line bg-surface/80 backdrop-blur px-4 md:px-8 h-14 flex items-center justify-between shrink-0 sticky top-0 z-30">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent to-info text-accent-ink grid place-items-center shrink-0 shadow-sm"><Plane size={17} strokeWidth={2.2} /></div>
          <span className="text-sm font-semibold tracking-tight">Travel CRM <span className="text-muted font-normal">· Platform</span></span>
        </div>
        <div className="flex items-center gap-3">
          {me && !need2fa && <button type="button" onClick={() => setPalette(true)} aria-label="Open command palette" className="hidden lg:flex items-center gap-2 bg-surface2 border border-line rounded-lg pl-3 pr-1.5 h-8 w-64 text-xs text-muted hover:border-accent/50 hover:text-fg transition"><Search size={12} className="shrink-0" /><span className="flex-1 text-left">Search agencies or jump to…</span><kbd className="kbd">⌘K</kbd></button>}
          <div className="flex items-center gap-1.5 text-[11px] text-muted"><div className="live-dot" /><span className="hidden sm:inline">Live</span></div>
          <button className="btn-ghost" onClick={() => nav('/')}>Workspace</button><ThemeMenuButton /><button className="btn-ghost" onClick={async () => { await logout(); nav('/login'); }}>Sign out</button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar (desktop) */}
        {me && !need2fa && (
          <nav className="w-60 shrink-0 bg-surface border-r border-line py-5 px-3 hidden md:flex flex-col overflow-y-auto sticky top-14 self-start h-[calc(100vh-3.5rem)]">
            {navGroups.map((group) => (
              <div key={group.label} className="mb-4">
                <div className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{group.label}</div>
                {group.items.map(([k, l]) => (
                  <button key={k} role="tab" aria-selected={tab === k}
                    className={`w-full text-left flex items-center justify-between rounded-lg px-3 py-2 text-sm mb-0.5 transition-colors ${tab === k ? 'nav-active text-accent font-medium' : 'text-muted hover:bg-surface2 hover:text-fg'}`}
                    onClick={() => setTab(k)}>
                    <span className="flex items-center gap-2.5">{(() => { const I = TAB_ICON[k]; return <I size={16} className="shrink-0" />; })()}{l}</span>
                    {k === 'approvals' && pending > 0 && (
                      <span className="min-w-[1.1rem] h-4 px-1 text-[10px] font-bold rounded-full bg-danger text-white flex items-center justify-center leading-none">{pending}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
            <div className="mt-auto rounded-xl border border-line bg-surface2/60 p-3">
              <div className="flex items-center gap-2.5"><Avatar name={user.name ?? user.email} size={34} />
                <div className="min-w-0"><div className="truncate text-sm font-medium">{user.name ?? 'Operator'}</div><div className="truncate text-[11px] text-muted">{user.email}</div></div></div>
              <div className="mt-2.5 flex items-center justify-between"><span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium capitalize text-accent"><ShieldCheck size={11} />{me.role}</span>
                <button className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg" onClick={async () => { await logout(); nav('/login'); }}><LogOut size={12} />Sign out</button></div>
            </div>
          </nav>
        )}

        {/* Content */}
        <main className="flex-1 min-w-0 overflow-auto">
          <div className="w-full px-4 md:px-8 pt-6 pb-20 md:pb-8">
            {need2fa ? <TwoFactorGate onDone={() => { setNeed2fa(false); api('/platform/me').then(setMe); }} />
              : !me ? <div className="skeleton h-40" />
              : <OpCtx.Provider value={{ me, guarded }}>
                {/* Mobile tab strip */}
                <div className={`${tab === 'dashboard' ? 'hidden' : 'hidden md:block'} mb-6`}><h1 className="text-2xl font-semibold">{TAB_HEAD[tab][0]}</h1><p className="text-sm text-muted mt-0.5">{TAB_HEAD[tab][1]}</p></div>
                <div className="flex md:hidden gap-2 mb-5 overflow-x-auto pb-1" role="tablist">
                  {allTabs.map(([k, l]) => (
                    <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'btn' : 'btn-ghost'} onClick={() => setTab(k)}>
                      {l}{k === 'approvals' && pending > 0 && <span className="ml-1 min-w-[1rem] h-4 px-0.5 text-[9px] font-bold rounded-full bg-danger text-white inline-flex items-center justify-center">{pending}</span>}
                    </button>
                  ))}
                </div>
                {tab === 'dashboard' && <Dashboard onNavigate={setTab} focus={focus} onFocused={() => setFocus(null)} />}{tab === 'overview' && <Overview />}{tab === 'agencies' && <Agencies focus={focus} onFocused={() => setFocus(null)} />}{tab === 'plans' && <Plans />}{tab === 'audit' && <PlatformAudit me={me} />}{tab === 'security' && <PlatformSecurity onOpenUser={me.caps.includes('support') ? (id) => { setFocusUser(id); setTab('users'); } : undefined} />}{tab === 'system' && <PlatformSystem />}{tab === 'operators' && <PlatformOperators me={me} />}{tab === 'users' && <PlatformUsers me={me} focus={focusUser} onFocused={() => setFocusUser(null)} onOpenAgency={(id) => { setTab('agencies'); setFocus(id); }} />}{tab === 'approvals' && <PlatformApprovals me={me} onChange={refreshPending} />}
              </OpCtx.Provider>}
          </div>
        </main>
      </div>

      {/* Mobile bottom nav */}
      {me && !need2fa && (
        <nav className="fixed bottom-0 inset-x-0 h-16 bg-surface/90 backdrop-blur border-t border-line flex md:hidden z-40">
          {([
            ['dashboard', 'Home', LayoutDashboard],
            ['agencies', 'Agencies', Building2],
            ['approvals', 'Approvals', CheckSquare],
            ['plans', 'Plans', Layers],
            ['system', 'System', Settings],
          ] as [Tab, string, any][]).map(([k, l, Icon]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
                tab === k ? 'text-accent' : 'text-muted'
              }`}>
              <div className="relative">
                <Icon size={18} />
                {k === 'approvals' && pending > 0 && (
                  <span className="absolute -top-1 -right-1.5 min-w-[14px] h-3.5 px-0.5 bg-danger rounded-full text-white text-[8px] flex items-center justify-center font-bold">{pending > 9 ? '9+' : pending}</span>
                )}
              </div>
              <span>{l}</span>
            </button>
          ))}
        </nav>
      )}
      {palette && me && <Palette tabs={allTabs} onTab={setTab} onAgency={(id) => { if (tab !== 'dashboard' && tab !== 'agencies') setTab('agencies'); setFocus(id); }} onClose={() => setPalette(false)} />}
    </div>
  );
}


function TwoFactorGate({ onDone }: { onDone(): void }) {
  const [s, setS] = useState<any>(null); const [code, setCode] = useState(''); const [err, setErr] = useState('');
  return <div className="card max-w-lg"><h1 className="text-lg font-semibold mb-1">Turn on two-factor authentication</h1><p className="text-sm text-muted mb-4">The platform console can see every customer, so it only opens for accounts protected by an authenticator app.</p><Err e={err} />
    {!s ? <button className="btn" onClick={async () => { try { setS(await api('/auth/2fa/setup', 'POST', {})); } catch (e: any) { setErr(e.message); } }}>Start setup</button> : <>
      <p className="text-sm mb-2">Add this key to your authenticator app, then enter the 6-digit code.</p><input className="input num text-xs mb-1" readOnly value={s.secret} onFocus={(e) => e.target.select()} /><div className="text-[11px] text-muted mb-3 break-all">{s.otpauth}</div>
      <div className="flex gap-2"><input className="input num w-40" inputMode="numeric" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} /><button className="btn" onClick={async () => { try { await api('/auth/2fa/enable', 'POST', { code }); onDone(); } catch (e: any) { setErr(e.message); } }}>Enable</button></div></>}</div>;
}

const Stat = ({ label, value, tone }: { label: string; value: any; tone?: string }) => <div className="card"><div className="text-xs text-muted">{label}</div><div className={`text-2xl font-semibold num mt-1 ${tone ?? ''}`}>{value}</div></div>;

function Overview() {
  const [o, setO] = useState<any>(null); useEffect(() => { api('/platform/overview').then(setO); }, []);
  if (!o) return <div className="skeleton h-40" />;
  return <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <Stat label="Agencies" value={o.agencies} /><Stat label="New (30 days)" value={o.new_30d} /><Stat label="MRR (card billing)" value={money(o.mrr)} /><Stat label="ARR" value={money(o.arr)} />
    <Stat label="Invoiced MRR (manual)" value={money(o.manual_mrr)} /><Stat label="Trials ending ≤ 7 days" value={o.trials_ending_7d} tone={o.trials_ending_7d ? 'text-warn' : ''} /><Stat label="Operator holds" value={o.platform_holds} tone={o.platform_holds ? 'text-danger' : ''} /><Stat label="Suspensions awaiting approval" value={o.pending_approvals} tone={o.pending_approvals ? 'text-warn' : ''} /><Stat label="Live support sessions" value={o.active_support_sessions} /></div>
    <div className="grid gap-3 md:grid-cols-3"><div className="card"><div className="font-medium mb-2">By status</div>{Object.entries(o.by_status).map(([k, v]: any) => <div key={k} className="flex justify-between text-sm py-0.5"><Pill s={k} /><span className="num">{v}</span></div>)}</div>
      <div className="card"><div className="font-medium mb-2">By plan</div>{o.by_plan.map((p: any) => <div key={p.code} className="flex justify-between text-sm py-0.5"><span>{p.name}</span><span className="num">{p.n}</span></div>)}</div>
      <div className="card"><div className="font-medium mb-2">Needs attention</div><div className="text-sm space-y-1"><div className="flex justify-between"><span>Dead webhook deliveries</span><span className={`num ${o.dead_webhook_deliveries ? 'text-danger' : ''}`}>{o.dead_webhook_deliveries}</span></div><div className="flex justify-between"><span>Open critical exceptions</span><span className={`num ${o.open_critical_exceptions ? 'text-warn' : ''}`}>{o.open_critical_exceptions}</span></div></div></div></div></div>;
}

type Act = { kind: 'extend-trial' | 'set-plan' | 'grant' | 'suspend' | 'reactivate' | 'support-session' | 'access-workspace' | 'edit-agency' | 'delete-agency'; id: number; name: string; data?: Record<string, string> };
function NewAgencyModal({ plans, onClose, onDone }: { plans: any[]; onClose(): void; onDone(msg: string): void }) {
  const { guarded } = useOp();
  const [f, setF] = useState({ agencyName: '', adminName: '', adminEmail: '', adminPassword: '', planCode: plans[0]?.code ?? 'growth', baseCurrency: 'USD' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr('');
    try { await guarded(() => api('/platform/agencies', 'POST', f)); onDone(`Agency "${f.agencyName}" created with admin ${f.adminEmail}.`); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const valid = f.agencyName.length >= 2 && f.adminName.length >= 2 && f.adminEmail.includes('@') && f.adminPassword.length >= 10;
  return <Modal title="Create new agency" onClose={onClose}><Err e={err} />
    <div className="grid grid-cols-2 gap-x-4">
      <Field label="Agency name"><input className="input" value={f.agencyName} onChange={(e) => setF({ ...f, agencyName: e.target.value })} placeholder="Acme Travel" /></Field>
      <Field label="Base currency"><input className="input num" maxLength={3} value={f.baseCurrency} onChange={(e) => setF({ ...f, baseCurrency: e.target.value.toUpperCase() })} placeholder="USD" /></Field>
      <Field label="Admin full name"><input className="input" value={f.adminName} onChange={(e) => setF({ ...f, adminName: e.target.value })} placeholder="Jane Smith" /></Field>
      <Field label="Admin email"><input className="input" type="email" value={f.adminEmail} onChange={(e) => setF({ ...f, adminEmail: e.target.value })} placeholder="jane@acme.travel" /></Field>
      <Field label="Admin password (min 10 chars)"><input className="input" type="password" autoComplete="new-password" value={f.adminPassword} onChange={(e) => setF({ ...f, adminPassword: e.target.value })} /></Field>
      <Field label="Plan"><select className="input" value={f.planCode} onChange={(e) => setF({ ...f, planCode: e.target.value })}>{plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
    </div>
    <div className="flex justify-end mt-2"><button className="btn" disabled={busy || !valid} onClick={submit}>Create agency</button></div>
  </Modal>;
}
const STATUS_HUE: Record<string, string> = { trialing: 'info', active: 'success', past_due: 'warn', grace: 'warn', suspended: 'danger', cancelled: 'danger', none: 'muted' };
const STATUS_TILES: [string, string, any][] = [['', 'All agencies', Building2], ['trialing', 'Trialing', Clock], ['active', 'Active', ShieldCheck], ['past_due', 'Payment late', AlertTriangle], ['suspended', 'Suspended', ShieldAlert]];
const daysTo = (d: any) => (d ? Math.ceil((Date.parse(String(d).slice(0, 10)) - Date.now()) / 864e5) : null);
function Agencies({ focus, onFocused }: { focus?: number | null; onFocused?(): void }) {
  const [res, setRes] = useState<any>(null); const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [page, setPage] = useState(1);
  const [view, setView] = useState<'cards' | 'table'>(() => { try { return localStorage.getItem('tf-agencies-view') === 'table' ? 'table' : 'cards'; } catch { return 'cards'; } });
  const { me } = useOp(); const [notice, setNotice] = useState(''); const [detail, setDetail] = useState<any>(null); const [act, setAct] = useState<Act | null>(null); const [err, setErr] = useState('');
  const [newAgency, setNewAgency] = useState(false); const [plans, setPlans] = useState<any[]>([]);
  const load = () => api(`/platform/agencies?page=${page}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}${status ? `&status=${status}` : ''}`).then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { const h = setTimeout(load, q ? 250 : 0); return () => clearTimeout(h); }, [page, status, q]);
  useEffect(() => { setPage(1); }, [q, status]);
  useEffect(() => { if (me.caps.includes('billing')) api('/platform/plans').then(setPlans); }, []);
  const open = async (id: number) => { try { setDetail(await api(`/platform/agencies/${id}`)); } catch (e: any) { setErr(e.message); } };
  useEffect(() => { if (focus) { open(focus); onFocused?.(); } }, [focus]);
  const counts = res?.counts ?? {}; const total = Object.values(counts).reduce((s: number, n: any) => s + Number(n), 0);
  const setV = (v: 'cards' | 'table') => { setView(v); try { localStorage.setItem('tf-agencies-view', v); } catch { /* ignore */ } };
  const count = (k: string) => (k === '' ? total : k === 'past_due' ? Number(counts.past_due ?? 0) + Number(counts.grace ?? 0) : Number(counts[k] ?? 0));
  const rows: any[] = res?.rows ?? [];
  const card = (r: any) => {
    const hue = r.platform_hold ? 'danger' : STATUS_HUE[r.status ?? 'none'] ?? 'muted'; const end = r.status === 'trialing' ? r.trial_ends_at : r.current_period_end; const left = daysTo(end);
    return (
      <div key={r.id} role="button" tabIndex={0} onClick={() => open(r.id)} onKeyDown={(e) => e.key === 'Enter' && open(r.id)} aria-label={`Open ${r.name}`}
        className="card glow-card kpi-enter group cursor-pointer overflow-hidden !p-0 focus-visible:ring-2 focus-visible:ring-accent" style={{ ['--hue' as any]: `var(--${hue})` }}>
        <div className="h-1" style={{ background: `linear-gradient(90deg, rgb(var(--${hue})), rgb(var(--${hue}) / .15))` }} />
        <div className="p-4">
          <div className="flex items-start gap-3"><Avatar name={r.name} size={44} />
            <div className="min-w-0 flex-1"><div className="truncate font-semibold leading-tight">{r.name}</div><div className="mt-0.5 text-xs text-muted num">#{r.id} · joined {String(r.created_at).slice(0, 10)}</div></div>
            <Pill s={r.status ?? 'cancelled'} /></div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-accent/12 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">{r.plan_name ?? 'No plan'}</span>
            {!!r.is_manual && <span className="rounded-full bg-surface2 px-2 py-0.5 text-[11px] text-muted">Invoiced</span>}
            {!!r.platform_hold && <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-medium text-danger">On hold</span>}</div>
          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line/70 pt-3 text-center">
            <div><div className="text-lg font-semibold num">{r.seats}</div><div className="text-[10px] uppercase tracking-wide text-muted">Members</div></div>
            <div><div className="text-sm font-semibold leading-7">{rel(r.last_active)}</div><div className="text-[10px] uppercase tracking-wide text-muted">Last active</div></div>
            <div><div className={`text-sm font-semibold leading-7 ${left !== null && left <= 3 && r.status === 'trialing' ? 'text-warn' : ''}`}>{left === null ? '—' : left < 0 ? 'Ended' : `${left} d`}</div><div className="text-[10px] uppercase tracking-wide text-muted">{r.status === 'trialing' ? 'Trial left' : 'Renews in'}</div></div></div>
          {me.caps.includes('support') && <div className="mt-3 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100" onClick={(e) => e.stopPropagation()}>
            <button className="btn-ghost !h-8 flex-1 text-xs" onClick={() => open(r.id)}>View</button>
            <button className="btn !h-8 flex-1 text-xs" onClick={() => setAct({ kind: 'access-workspace', id: r.id, name: r.name })}>Access workspace</button></div>}
        </div>
      </div>);
  };
  return <div className="space-y-4">
    <Err e={err} />
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{STATUS_TILES.map(([k, label, Icon]) => { const hue = k === '' ? 'accent' : STATUS_HUE[k]; const n = res ? count(k) : null; return (
      <button key={k || 'all'} type="button" aria-pressed={status === k} onClick={() => setStatus(status === k ? '' : k)} className={`card glow-card text-left ${status === k ? 'ring-2 ring-accent' : ''}`} style={{ ['--hue' as any]: `var(--${hue})` }}>
        <div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{label}</span><span className="grid h-8 w-8 place-items-center rounded-xl" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}><Icon size={16} /></span></div>
        <div className="mt-2 text-3xl font-bold num">{n ?? '—'}</div></button>); })}</div>
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[14rem] flex-1 sm:max-w-md"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input className="input pl-8" aria-label="Search agencies" placeholder="Agency name or member email…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="ml-auto flex items-center gap-2">
        <div className="inline-flex rounded-lg border border-line p-0.5" role="group" aria-label="View">{([['cards', LayoutGrid, 'Cards'], ['table', List, 'Table']] as const).map(([k, I, l]) => <button key={k} aria-pressed={view === k} onClick={() => setV(k)} className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm ${view === k ? 'bg-accent text-accent-ink' : 'text-muted hover:text-fg'}`}><I size={14} />{l}</button>)}</div>
        {me.caps.includes('billing') && <button type="button" className="btn" onClick={() => setNewAgency(true)}><Plus size={16} />New agency</button>}</div></div>
    {newAgency && <NewAgencyModal plans={plans} onClose={() => setNewAgency(false)} onDone={(msg) => { setNewAgency(false); setNotice(msg); load(); }} />}
    {!res ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-52" />)}</div>
      : !rows.length ? <div className="card py-14 text-center"><Building2 size={28} className="mx-auto mb-2 text-muted" /><div className="text-sm font-medium">No agencies match</div><p className="mt-1 text-xs text-muted">{q ? `Nothing matches “${q}”.` : 'Try another status.'}</p></div>
      : view === 'cards' ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{rows.map(card)}</div>
      : <Table rows={rows} paginate={false} onRow={(r: any) => open(r.id)} empty="No agencies match" cols={[
        { h: 'Agency', render: (r: any) => <div className="flex min-w-0 items-center gap-3"><Avatar name={r.name} size={34} /><div className="min-w-0"><div className="truncate font-medium">{r.name}</div><div className="text-xs text-muted num">#{r.id} · created {String(r.created_at).slice(0, 10)}</div></div></div> },
        { h: 'Plan', render: (r: any) => r.plan_name ?? '—' },
        { h: 'Status', render: (r: any) => <><Pill s={r.status ?? 'cancelled'} />{!!r.platform_hold && <span className="ml-2 text-xs text-danger">hold</span>}{!!r.is_manual && <span className="ml-2 text-xs text-muted">invoiced</span>}</> },
        { h: 'Seats', right: true, render: (r: any) => r.seats }, { h: 'Last active', render: (r: any) => <span className="text-xs text-muted">{rel(r.last_active)}</span> }]} />}
    {res && res.total > res.page_size && <div className="card !p-0 overflow-hidden"><Pager total={res.total} page={page - 1} size={res.page_size} onPage={(p) => setPage(p + 1)} noun="agencies" /></div>}
    {detail && <AgencyDetailModal detail={detail} me={me} onClose={() => setDetail(null)} onAct={setAct} onRefresh={() => open(detail.agency.id)} />}
    {notice && <div className="fixed bottom-4 left-1/2 z-[60] max-w-md -translate-x-1/2 rounded-lg border border-info/30 bg-surface px-4 py-3 text-sm shadow-pop" role="status">{notice}<button className="ml-3 text-muted" onClick={() => setNotice('')}>×</button></div>}
    {act && <ActionModal act={act} onClose={() => setAct(null)} onDone={(msg, closeDetail) => { setAct(null); if (msg) setNotice(msg); load(); if (closeDetail) setDetail(null); else if (detail) open(detail.agency.id); }} />}
  </div>;
}

const AGENCY_ROLES: [string, string][] = [['admin', 'Owner / Admin'], ['finance_manager', 'Finance manager'], ['agent', 'Agent'], ['viewer', 'Viewer']];
const roleName = (r: string) => AGENCY_ROLES.find(([k]) => k === r)?.[1] ?? r;

/** The people in one agency. Operators with admin rights can rename them, change their role, remove them, or delete the account. */
function MembersPanel({ detail, canManage, onRefresh }: { detail: any; canManage: boolean; onRefresh(): void }) {
  const ag = detail.agency.id; const [edit, setEdit] = useState<any>(null); const [del, setDel] = useState<any>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<any>, ok: (r: any) => string) => { setBusy(true); try { const r = await fn(); setEdit(null); setDel(null); setErr(''); setMsg(ok(r)); onRefresh(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const openDel = async (m: any) => { setErr(''); setDel({ m, reassign: '', deleteAccount: false, reason: '', work: null }); try { const w = await api(`/platform/agencies/${ag}/users/${m.user_id}/workload`); setDel((d: any) => d && { ...d, work: w }); } catch { /* optional */ } };
  const others = (uid: number) => detail.members.filter((x: any) => x.user_id !== uid);
  const busyWork = (w: any) => w && w.leads + w.bookings + w.quotes + w.tasks > 0;
  return <div><div className="font-medium text-sm mb-1">Members</div>{msg && <div role="status" className="text-sm text-accent mb-2">{msg}</div>}
    <Table rows={detail.members.map((m: any, i: number) => ({ ...m, id: i }))} cols={[{ h: 'Name', render: (m: any) => <>{m.name}<div className="text-xs text-muted">{m.email}</div></> }, { h: 'Role', render: (m: any) => roleName(m.role) }, { h: '2FA', render: (m: any) => (m.totp_enabled ? '✓' : '—') },
      ...(canManage ? [{ h: '', render: (m: any) => <div className="flex justify-end gap-1"><button className="btn-ghost !py-0.5 !px-2 text-xs" onClick={() => { setErr(''); setEdit({ m, name: m.name, email: m.email, role: m.role, reason: '' }); }}>Edit</button><button className="btn-ghost !py-0.5 !px-2 text-xs text-danger" onClick={() => openDel(m)}>Remove</button></div> }] : [])]} />
    {edit && <Modal title={`Edit ${edit.m.name}`} onClose={() => setEdit(null)}><Err e={err} />
      <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
      <Field label="Sign-in email" hint="Changes the person's login everywhere they have access."><input className="input" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
      <Field label="Role in this agency" hint="The agency always keeps at least one admin."><select className="input" value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>{AGENCY_ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      <Field label="Reason" hint="Kept in the operator audit log."><input className="input" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></Field>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
        <button className="btn" disabled={busy || !edit.name.trim() || !edit.email.trim()} onClick={() => run(() => api(`/platform/agencies/${ag}/users/${edit.m.user_id}`, 'PUT', { name: edit.name.trim(), email: edit.email.trim(), role: edit.role, reason: edit.reason }), () => `${edit.name} updated.`)}>{busy ? 'Saving…' : 'Save changes'}</button></div></Modal>}
    {del && <Modal title={`Remove ${del.m.name}`} onClose={() => setDel(null)}><Err e={err} />
      <p className="text-sm mb-3">{del.m.name} ({roleName(del.m.role)}) will lose access to <b>{detail.agency.name}</b> immediately.</p>
      {busyWork(del.work) && <><div className="text-sm text-warn mb-2">Open work: {del.work.leads} leads, {del.work.bookings} bookings, {del.work.quotes} quotes, {del.work.tasks} tasks.</div>
        <Field label="Hand their open work to"><select className="input" value={del.reassign} onChange={(e) => setDel({ ...del, reassign: e.target.value })}><option value="">Leave as is</option>{others(del.m.user_id).map((x: any) => <option key={x.user_id} value={x.user_id}>{x.name}</option>)}</select></Field></>}
      <label className="flex items-start gap-2 text-sm mb-3"><input type="checkbox" className="mt-0.5" checked={del.deleteAccount} onChange={(e) => setDel({ ...del, deleteAccount: e.target.checked })} /><span>Also delete their account<span className="block text-xs text-muted">Only happens if they belong to no other agency and appear nowhere in the books; otherwise the account is kept.</span></span></label>
      <Field label="Reason" hint="Kept in the operator audit log."><input className="input" value={del.reason} onChange={(e) => setDel({ ...del, reason: e.target.value })} /></Field>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setDel(null)}>Cancel</button>
        <button className="btn !bg-danger" disabled={busy} onClick={() => run(() => api(`/platform/agencies/${ag}/users/${del.m.user_id}`, 'DELETE', { reason: del.reason, delete_account: del.deleteAccount, reassign_to: del.reassign ? Number(del.reassign) : null }), (r) => `${del.m.name} removed${del.deleteAccount ? ` (account ${r.account})` : ''}.`)}>{busy ? 'Removing…' : 'Remove'}</button></div></Modal>}
  </div>;
}

/** Operator control: may this agency use the AI assistant? Follow its plan, force it on, or switch it off, with an optional monthly cap. Every change needs a reason and is audited. */
function AiAccess({ detail, canEdit, onRefresh }: { detail: any; canEdit: boolean; onRefresh(): void }) {
  const ai = detail.ai, id = detail.agency.id;
  const [access, setAccess] = useState<string>(ai.access); const [cap, setCap] = useState<string>(detail.agency.ai_monthly_limit == null ? '' : String(detail.agency.ai_monthly_limit)); const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [ok, setOk] = useState('');
  const changed = access !== ai.access || cap !== (detail.agency.ai_monthly_limit == null ? '' : String(detail.agency.ai_monthly_limit));
  const save = async () => {
    setBusy(true); setErr(''); setOk('');
    try { await api(`/platform/agencies/${id}/ai`, 'PUT', { access, monthly_limit: cap.trim() === '' ? null : Number(cap), reason }); setReason(''); setOk('Saved.'); onRefresh(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const why: Record<string, string> = { not_configured: 'no AI key on the server', off: 'switched off for this agency', plan: 'not in their plan', limit: 'monthly limit reached' };
  return <div className="card">
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-medium text-sm">AI assistant</div>
      <span className={`text-xs px-2 py-0.5 rounded-full border ${ai.available ? 'border-success/30 bg-success/10 text-success' : 'border-line text-muted'}`}>{ai.available ? 'Available' : `Not available — ${why[ai.reason] ?? ai.reason}`}</span></div>
    <p className="text-xs text-muted mt-1">{ai.requests} request{ai.requests === 1 ? '' : 's'} this month (limit {ai.limit}) · {ai.tokens.toLocaleString()} tokens.{!ai.key_configured && ' The server has no ANTHROPIC_API_KEY, so nobody can use it yet.'}</p>
    {canEdit && <div className="grid gap-x-4 sm:grid-cols-3 mt-3">
      <Field label="Access"><select className="input" value={access} onChange={(e) => setAccess(e.target.value)}><option value="plan">Follow their plan</option><option value="on">Always on</option><option value="off">Off</option></select></Field>
      <Field label="Requests per month" hint="Blank = server default"><input className="input num" type="number" min={0} value={cap} onChange={(e) => setCap(e.target.value)} placeholder={String(ai.limit)} /></Field>
      <Field label="Reason (audited)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. pilot customer" /></Field></div>}
    <Err e={err} />{ok && <div role="status" className="text-sm text-success mb-2">{ok}</div>}
    {canEdit && <div className="flex justify-end"><button className="btn" disabled={busy || !changed || reason.trim().length < 3} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>}
  </div>;
}

function AgencyDetailModal({ detail, me, onClose, onAct, onRefresh }: { detail: any; me: Me; onClose(): void; onAct(a: Act): void; onRefresh(): void }) {
  const ag = detail.agency, sub = detail.subscription; const [tab, setTab] = useState<'overview' | 'people' | 'billing' | 'activity'>('overview'); const [menu, setMenu] = useState(false);
  const canBill = me.caps.includes('billing'), canSup = me.caps.includes('support'), canSus = me.caps.includes('suspend');
  const hue = sub?.platform_hold ? 'danger' : STATUS_HUE[sub?.status ?? 'none'] ?? 'muted'; const left = daysTo(sub?.status === 'trialing' ? sub?.trial_ends_at : sub?.current_period_end);
  const target = { id: ag.id, name: ag.name };
  const items: { label: string; on(): void; show: boolean; danger?: boolean }[] = [
    { label: 'Set plan', on: () => onAct({ kind: 'set-plan', ...target }), show: canBill }, { label: 'Extend trial', on: () => onAct({ kind: 'extend-trial', ...target }), show: canBill && sub?.status === 'trialing' },
    { label: 'Grant invoiced access', on: () => onAct({ kind: 'grant', ...target }), show: canBill },
    { label: 'Edit agency details', on: () => onAct({ kind: 'edit-agency', ...target, data: { name: ag.name, base_currency: ag.base_currency ?? 'USD', tax_label: ag.tax_label ?? 'TAX' } }), show: canBill },
    sub?.platform_hold ? { label: 'Release operator hold', on: () => onAct({ kind: 'reactivate', ...target }), show: canSus } : { label: 'Request suspension', on: () => onAct({ kind: 'suspend', ...target }), show: canSus, danger: true },
    { label: 'Delete agency', on: () => onAct({ kind: 'delete-agency', ...target }), show: canSus, danger: true },
  ].filter((i) => i.show);
  const tabs: [typeof tab, string, number?][] = [['overview', 'Overview'], ['people', 'People', detail.members.length], ['billing', 'Billing', detail.billing_events.length], ['activity', 'Activity']];
  const tile = (label: string, value: any, hint?: string, tone = '') => <div className="card !p-3"><div className="text-xs text-muted">{label}</div><div className={`mt-1 text-2xl font-bold num ${tone}`}>{value}</div>{hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}</div>;
  return <Modal title="Agency" wide onClose={onClose}>
    <section className="hero-mesh -mt-1 mb-4 rounded-xl border border-line p-4 md:p-5" style={{ ['--hue' as any]: `var(--${hue})` }}>
      <div className="flex flex-wrap items-start gap-4">
        <Avatar name={ag.name} size={60} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-xl font-bold tracking-tight md:text-2xl">{ag.name}</h3>{sub && <Pill s={sub.status} />}
            {sub && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">{sub.plan_name}{sub.interval ? ` · ${sub.interval}` : ''}</span>}
            {sub?.manual && <span className="rounded-full bg-surface2 px-2 py-0.5 text-[11px] text-muted">Invoiced</span>}{sub?.platform_hold && <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-medium text-danger">On operator hold</span>}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted"><span className="num">#{ag.id}</span><span>Joined {String(ag.created_at).slice(0, 10)}</span><span>{ag.base_currency}</span><span>Last active {rel(detail.last_active)}</span></div></div>
        <div className="flex flex-wrap items-center gap-2">
          {canSup && <button className="btn" onClick={() => onAct({ kind: 'access-workspace', ...target })}><ArrowRight size={15} />Access workspace</button>}
          {canSup && <button className="btn-ghost" onClick={() => onAct({ kind: 'support-session', ...target })}>Support session</button>}
          {items.length > 0 && <div className="relative"><button className="btn-ghost" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><MoreHorizontal size={16} />Manage</button>
            {menu && <><button className="fixed inset-0 z-10 cursor-default" aria-label="Close menu" onClick={() => setMenu(false)} />
              <div role="menu" className="pop-in absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop">{items.map((i) => <button key={i.label} role="menuitem" className={`block w-full px-3 py-2 text-left text-sm hover:bg-surface2 ${i.danger ? 'text-danger' : ''}`} onClick={() => { setMenu(false); i.on(); }}>{i.label}</button>)}</div></>}</div>}</div></div>
      {sub?.platform_hold && <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">Operator hold: {sub.hold_reason || 'no reason recorded'}</div>}
    </section>

    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist">{tabs.map(([k, l, n]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`whitespace-nowrap px-3.5 py-2 text-sm ${tab === k ? 'border-b-2 border-accent font-medium text-accent' : 'text-muted hover:text-fg'}`}>{l}{n != null && <span className="ml-1.5 rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] text-muted num">{n}</span>}</button>)}</div>

    {tab === 'overview' && <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{tile('Members', detail.usage.seats)}{tile('Branches', detail.usage.branches)}{tile('Bookings this month', detail.usage.bookings)}{tile('Requests (30 days)', detail.requests_30d.toLocaleString())}</div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="card"><div className="text-xs font-medium text-muted">Subscription</div>{sub ? <>
          <div className="mt-2 flex items-baseline justify-between"><span className="text-lg font-semibold">{sub.plan_name}</span><span className="text-xs text-muted capitalize">{sub.interval}</span></div>
          {left !== null && <div className="mt-3"><div className="mb-1 flex justify-between text-xs"><span className="text-muted">{sub.status === 'trialing' ? 'Trial' : 'Current period'}</span><span className={left <= 3 ? 'font-medium text-warn' : ''}>{left < 0 ? 'ended' : `${left} day${left === 1 ? '' : 's'} left`}</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface2"><div className="h-full rounded-full" style={{ width: `${Math.max(4, Math.min(100, (left / (sub.status === 'trialing' ? 14 : 31)) * 100))}%`, background: left <= 3 ? 'rgb(var(--warn))' : 'rgb(var(--accent))' }} /></div></div>}
          <dl className="mt-3 space-y-0.5 text-xs text-muted"><div>Trial ends <span className="num text-fg">{day(sub.trial_ends_at)}</span></div><div>Period ends <span className="num text-fg">{day(sub.current_period_end)}</span></div>{sub.cancel_at_period_end && <div className="text-warn">Cancels at the end of the period</div>}</dl></> : <p className="mt-2 text-sm text-muted">No subscription.</p>}</div>
        <div className="card"><div className="text-xs font-medium text-muted">Health</div>
          <div className="mt-2 grid grid-cols-2 gap-3"><div><div className={`text-2xl font-bold num ${detail.open_critical_exceptions ? 'text-danger' : 'text-success'}`}>{detail.open_critical_exceptions}</div><div className="text-[11px] text-muted">Critical exceptions</div></div>
            <div><div className={`text-2xl font-bold num ${detail.failed_emails_7d ? 'text-warn' : 'text-success'}`}>{detail.failed_emails_7d}</div><div className="text-[11px] text-muted">Failed emails (7 d)</div></div></div>
          <p className="mt-3 text-xs text-muted">{detail.open_critical_exceptions || detail.failed_emails_7d ? 'Something here needs a look. Access the workspace or open a support session to investigate.' : 'Nothing needs attention.'}</p></div></div>
      <AiAccess detail={detail} canEdit={canBill} onRefresh={onRefresh} />
    </div>}

    {tab === 'people' && <MembersPanel detail={detail} canManage={canSus} onRefresh={onRefresh} />}

    {tab === 'billing' && <div className="card !p-0 overflow-hidden"><div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Billing history</div>
      {!detail.billing_events.length && <div className="px-4 py-8 text-center text-sm text-muted">No billing events yet.</div>}
      <ol className="px-4 py-3">{detail.billing_events.map((e: any, i: number) => <li key={i} className="relative flex gap-3 pb-4 last:pb-0"><span className="relative mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-accent" />{i < detail.billing_events.length - 1 && <span className="absolute left-[4px] top-4 h-full w-px bg-line" aria-hidden />}
        <div className="min-w-0"><div className="text-sm font-medium capitalize">{String(e.kind).replace(/_/g, ' ')}</div>{e.detail && <div className="text-xs text-muted">{e.detail}</div>}<div className="text-[11px] text-muted num">{day(e.created_at)}</div></div></li>)}</ol></div>}

    {tab === 'activity' && <div className="grid gap-4 lg:grid-cols-2">
      <div className="card !p-0 overflow-hidden"><div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Support access</div>
        {!detail.support_sessions.length && <div className="px-4 py-8 text-center text-sm text-muted">No support sessions.</div>}
        {detail.support_sessions.map((x: any) => { const live = !x.revoked_at && new Date(x.expires_at) > new Date(); return <div key={x.id} className="flex items-start gap-3 border-b border-line/70 px-4 py-2.5 last:border-0"><div className="min-w-0 flex-1"><div className="truncate text-sm">{x.admin_email}</div><div className="truncate text-xs text-muted">{x.reason}</div><div className="text-[11px] text-muted num">{day(x.created_at)}</div></div>
          {live ? <><span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success">Live</span>{canSup && <button className="btn-ghost !h-7 !px-2 text-xs" onClick={async () => { await api(`/platform/support-sessions/${x.id}/revoke`, 'POST', {}); onRefresh(); }}>End</button>}</> : <span className="rounded-full bg-surface2 px-2 py-0.5 text-[11px] text-muted">{x.revoked_at ? 'Ended' : 'Expired'}</span>}</div>; })}</div>
      <div className="card !p-0 overflow-hidden"><div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Security events</div>
        {!detail.security_events.length && <div className="px-4 py-8 text-center text-sm text-muted">Nothing recorded.</div>}
        {detail.security_events.map((e: any, i: number) => <div key={i} className="border-b border-line/70 px-4 py-2 last:border-0"><div className="flex items-baseline justify-between gap-2"><span className="text-sm capitalize">{String(e.event).replace(/_/g, ' ')}</span><span className="shrink-0 text-[11px] text-muted num">{day(e.created_at)}</span></div>{e.detail && <div className="truncate text-xs text-muted">{e.detail}</div>}</div>)}</div>
    </div>}
  </Modal>;
}

/* ------------------------------------------------------------------ Dashboard KPI helpers ------------------------------------------------------------------ */

function useCountUp(target: number | undefined, duration = 750) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (target == null) return;
    if (target === 0) { setVal(0); return; }
    let rafId: number;
    let startTs: number | null = null;
    const run = (ts: number) => {
      if (!startTs) startTs = ts;
      const p = Math.min((ts - startTs) / duration, 1);
      setVal(Math.round((1 - Math.pow(1 - p, 3)) * target));
      if (p < 1) rafId = requestAnimationFrame(run);
    };
    rafId = requestAnimationFrame(run);
    return () => cancelAnimationFrame(rafId);
  }, [target]);
  return val;
}

const HUE: Record<string, string> = { accent: 'accent', success: 'success', info: 'info', warn: 'warn', danger: 'danger' };
function KpiCard({ label, icon: Icon, rawValue, formattedValue, sub, alert = false, hue = 'accent', trend, trendDir = 'flat', index }: {
  label: string; icon: any; rawValue?: number; formattedValue?: string; sub?: string;
  alert?: boolean; hue?: keyof typeof HUE; trend?: string; trendDir?: 'up' | 'down' | 'flat'; index: number;
}) {
  const counted = useCountUp(rawValue);
  const isLoading = rawValue == null && formattedValue == null;
  const display = formattedValue ?? (rawValue != null ? counted.toLocaleString() : null);
  const h = alert ? 'warn' : hue;
  return (
    <div className={`card glow-card kpi-enter overflow-hidden ${alert ? 'border-warn/40' : ''}`} style={{ animationDelay: `${index * 55}ms`, ['--hue' as any]: `var(--${h})` }}>
      <div className="flex items-start justify-between gap-2">
        <div className={`text-xs font-medium ${alert ? 'text-warn' : 'text-muted'}`}>{label}</div>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl" style={{ background: `rgb(var(--${h}) / 0.14)`, color: `rgb(var(--${h}))` }}><Icon size={16} /></span>
      </div>
      <div className="relative z-10 mt-2 text-3xl font-bold num tracking-tight" style={alert || hue !== 'accent' ? { color: alert ? `rgb(var(--warn))` : undefined } : { color: 'rgb(var(--accent))' }}>
        {isLoading ? <span className="block h-8 w-20 skeleton rounded" /> : display}
      </div>
      <div className={`relative z-10 mt-1 flex items-center gap-1 text-[11px] font-medium ${trendDir === 'up' ? 'text-success' : trendDir === 'down' ? 'text-danger' : 'text-muted'}`}>
        {trend != null ? <><span>{trendDir === 'up' ? '↑' : trendDir === 'down' ? '↓' : '→'}</span><span>{trend}</span></> : <span className="font-normal">{sub}</span>}
      </div>
    </div>
  );
}

/** The banner at the top of the dashboard: a greeting, the state of the platform, the headline number and a plan mix donut — all real figures. */
function Hero({ o, alerts, onNavigate, onNew, canNew, pending }: { o: any; alerts: string[]; onNavigate(t: Tab): void; onNew(): void; canNew: boolean; pending: number }) {
  const { user } = useAuth(); const hour = new Date().getHours(); const first = String(user?.name ?? 'there').split(' ')[0];
  const mrr = useCountUp(o ? Math.round(o.mrr + o.manual_mrr) : undefined);
  const plans: { name: string; n: number }[] = o?.by_plan ?? []; const total = plans.reduce((s, p) => s + p.n, 0);
  const COL = ['accent', 'info', 'warn', 'success', 'danger'];
  let acc = 0;
  return (
    <section className="hero-mesh rounded-2xl border border-line p-5 md:p-7 kpi-enter" aria-label="Platform summary">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0 max-w-xl">
          <div className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium backdrop-blur ${!o ? 'border-line text-muted' : alerts.length ? 'border-warn/40 bg-warn/10 text-warn' : 'border-success/40 bg-success/10 text-success'}`}>
            {!o ? 'Loading…' : alerts.length ? <><AlertTriangle size={12} />{alerts.length} thing{alerts.length === 1 ? '' : 's'} need{alerts.length === 1 ? 's' : ''} attention</> : <><span className="live-dot" />All clear</>}
          </div>
          <h2 className="mt-3 text-2xl font-bold tracking-tight md:text-3xl">{hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, {first}</h2>
          <p className="mt-1 text-sm text-muted">{o ? <>{o.agencies} agenc{o.agencies === 1 ? 'y' : 'ies'} on the platform{o.new_30d ? <>, <b className="text-fg">{o.new_30d}</b> joined this month</> : ''}.</> : 'Gathering the latest numbers…'}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            {canNew && <button className="btn" onClick={onNew}><Plus size={16} />New agency</button>}
            <button className="btn-ghost" onClick={() => onNavigate('approvals')}><ShieldCheck size={15} />Approvals{pending > 0 && <span className="ml-0.5 grid h-4 min-w-[1rem] place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">{pending}</span>}</button>
            <button className="btn-ghost" onClick={() => onNavigate('plans')}><Sparkles size={15} />Plans &amp; AI access</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-6 md:gap-8">
          <div><div className="text-xs font-medium uppercase tracking-wider text-muted">Monthly recurring revenue</div>
            <div className="mt-1 text-4xl font-extrabold num tracking-tight md:text-5xl" style={{ background: 'linear-gradient(90deg, rgb(var(--accent)), rgb(var(--info)))', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{o ? money(mrr) : '—'}</div>
            <div className="mt-1 text-xs text-muted">{o ? <>{money(o.mrr)} card · {money(o.manual_mrr)} invoiced · {money((o.mrr + o.manual_mrr) * 12)} a year</> : ' '}</div></div>
          <div className="flex items-center gap-4" aria-label="Agencies by plan">
            <svg viewBox="0 0 42 42" className="h-24 w-24 -rotate-90" role="img" aria-label={`${total} agencies across ${plans.length} plans`}>
              <circle cx="21" cy="21" r="15.915" fill="none" stroke="rgb(var(--line))" strokeWidth="5" />
              {total > 0 && plans.map((p, i) => { const len = (p.n / total) * 100, off = acc; acc += len; return <circle key={p.name} className="donut-seg" cx="21" cy="21" r="15.915" fill="none" stroke={`rgb(var(--${COL[i % COL.length]}))`} strokeWidth="5" strokeDasharray={`${Math.max(0, len - 1)} ${100 - Math.max(0, len - 1)}`} strokeDashoffset={-off} />; })}
            </svg>
            <ul className="space-y-1 text-xs">{plans.slice(0, 4).map((p, i) => <li key={p.name} className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: `rgb(var(--${COL[i % COL.length]}))` }} /><span className="text-muted">{p.name}</span><b className="num">{p.n}</b></li>)}</ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ Dashboard ------------------------------------------------------------------ */
function Dashboard({ onNavigate, focus, onFocused }: { onNavigate(t: Tab): void; focus?: number | null; onFocused?(): void }) {
  const { me } = useOp();
  const [o, setO] = useState<any>(null);
  const [res, setRes] = useState<any>({ rows: [], total: 0, page_size: 25 });
  const [recent, setRecent] = useState<any[]>([]);
  const [q, setQ] = useState(''); const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<any>(null); const [act, setAct] = useState<Act | null>(null);
  const [notice, setNotice] = useState(''); const [newAgency, setNewAgency] = useState(false);
  const [plans, setPlans] = useState<any[]>([]); const [err, setErr] = useState('');
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [barsVisible, setBarsVisible] = useState(false);

  const loadAgencies = (qs = q, st = status) =>
    api(`/platform/agencies?${qs ? `q=${encodeURIComponent(qs)}&` : ''}${st ? `status=${st}&` : ''}`).then(setRes).catch((e: any) => setErr(e.message));

  useEffect(() => {
    api('/platform/overview').then(setO).catch(() => {});
    loadAgencies();
    api('/platform/audit').then((r: any[]) => setRecent(r.slice(0, 8))).catch(() => {});
    if (me.caps.includes('billing')) api('/platform/plans').then(setPlans).catch(() => {});
  }, []);

  useEffect(() => {
    if (!o) return;
    const t = setTimeout(() => setBarsVisible(true), 200);
    return () => clearTimeout(t);
  }, [o]);

  const open = async (id: number) => { try { setDetail(await api(`/platform/agencies/${id}`)); } catch (e: any) { setErr(e.message); } };
  useEffect(() => { if (focus) { open(focus); onFocused?.(); } }, [focus]);

  const kpis = [
    { icon: Building2, label: 'Total agencies', rawValue: o?.agencies, sub: '', hue: 'accent' as const, trend: o ? `${o.new_30d} new this month` : undefined, trendDir: 'up' as const },
    { icon: DollarSign, label: 'MRR', formattedValue: o ? money(o.mrr) : undefined, sub: '', hue: 'success' as const, trend: o ? `${money(o.arr)} ARR` : undefined, trendDir: 'flat' as const },
    { icon: DollarSign, label: 'Invoiced MRR', formattedValue: o ? money(o.manual_mrr) : undefined, sub: '', hue: 'info' as const, trend: o ? 'manual billing' : undefined, trendDir: 'flat' as const },
    { icon: Clock, label: 'Trials expiring', rawValue: o?.trials_ending_7d, sub: 'within 7 days', hue: 'warn' as const, alert: !!(o?.trials_ending_7d), trend: o ? 'within 7 days' : undefined, trendDir: o?.trials_ending_7d ? 'down' as const : 'flat' as const },
    { icon: Users, label: 'Support sessions', rawValue: o?.active_support_sessions, sub: '', hue: 'info' as const, trend: o ? 'live now' : undefined, trendDir: 'flat' as const },
    { icon: ShieldAlert, label: 'Operator holds', rawValue: o?.platform_holds, sub: '', hue: 'danger' as const, alert: !!(o?.platform_holds || o?.pending_approvals), trend: o ? (o.pending_approvals ? `${o.pending_approvals} pending approval` : 'no holds') : undefined, trendDir: o?.platform_holds ? 'down' as const : 'flat' as const },
  ];

  const alerts: string[] = o ? [
    ...(o.trials_ending_7d ? [`${o.trials_ending_7d} trial(s) expiring within 7 days`] : []),
    ...(o.platform_holds ? [`${o.platform_holds} agenc${o.platform_holds === 1 ? 'y' : 'ies'} on operator hold`] : []),
    ...(o.pending_approvals ? [`${o.pending_approvals} suspension request(s) awaiting approval`] : []),
    ...(o.dead_webhook_deliveries ? [`${o.dead_webhook_deliveries} dead webhook deliveries`] : []),
    ...(o.open_critical_exceptions ? [`${o.open_critical_exceptions} open critical exception(s)`] : []),
  ] : [];

  return (
    <div className="space-y-5">
      <Hero o={o} alerts={alerts} onNavigate={onNavigate} onNew={() => setNewAgency(true)} canNew={me.caps.includes('billing')} pending={o?.pending_approvals ?? 0} />
      {/* KPI strip */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k, i) => <KpiCard key={k.label} index={i} {...k} />)}
      </div>

      {/* Alert banner */}
      {alerts.length > 0 && (
        <div className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <AlertTriangle size={15} className="text-warn shrink-0" />
          {alerts.map((a) => <span key={a} className="text-sm text-warn">{a}</span>)}
          {!!(o?.pending_approvals || o?.platform_holds) && (
            <button className="ml-auto text-xs font-medium text-warn underline underline-offset-2 shrink-0" onClick={() => onNavigate('approvals')}>Review →</button>
          )}
        </div>
      )}

      {/* Agency management table */}
      <div className="card !p-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-line">
          <span className="font-semibold text-sm">All agencies</span>
          <span className="pill bg-surface2 text-muted">{res.total}</span>
          <form className="flex flex-wrap gap-2 ml-auto" onSubmit={(e) => { e.preventDefault(); loadAgencies(); }}>
            <div className="relative"><Search size={14} className="absolute left-3 top-2.5 text-muted" />
              <input className="input pl-8 w-48" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <select className="input w-36" value={status} onChange={(e) => { setStatus(e.target.value); loadAgencies(q, e.target.value); }}>
              <option value="">All statuses</option>
              {['trialing', 'active', 'past_due', 'grace', 'suspended', 'cancelled'].map((s) => <option key={s}>{s}</option>)}
            </select>
            <button className="btn-ghost text-sm">Search</button>
          </form>
          {me.caps.includes('billing') && <button className="btn text-sm" onClick={() => setNewAgency(true)}>+ New agency</button>}
        </div>
        <Err e={err} />
        <Table rows={res.rows} onRow={(r: any) => open(r.id)} empty="No agencies match"
          cols={[
            { h: 'Agency', render: (r: any) => <div className="flex items-center gap-3 min-w-0"><Avatar name={r.name} size={34} /><div className="min-w-0"><div className="font-medium truncate">{r.name}</div><div className="text-xs text-muted num">#{r.id} · {String(r.created_at).slice(0, 10)}</div></div></div> },
            { h: 'Plan', render: (r: any) => <span className="text-sm">{r.plan_name ?? '—'}</span> },
            { h: 'Status', render: (r: any) => <><Pill s={r.status ?? 'cancelled'} />{!!r.platform_hold && <span className="text-xs text-danger ml-1.5">hold</span>}</> },
            { h: 'Seats', right: true, render: (r: any) => r.seats },
            { h: 'Last active', render: (r: any) => <span className="text-xs num text-muted">{day(r.last_active)}</span> },
            { h: '', render: (r: any) => (
              <div className="flex items-center gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
                <button className="btn-ghost !py-0.5 !px-2 text-xs" onClick={() => open(r.id)}>View</button>
                <div className="relative">
                  <button className="btn-ghost !py-0.5 !px-2 text-xs font-bold tracking-widest" onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === r.id ? null : r.id); }}>⋯</button>
                  {openMenu === r.id && (
                    <div className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-line bg-surface shadow-pop z-20 py-1" onMouseLeave={() => setOpenMenu(null)}>
                      {me.caps.includes('billing') && r.status === 'trialing' && <button className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface2" onClick={() => { setOpenMenu(null); setAct({ kind: 'extend-trial', id: r.id, name: r.name }); }}>Extend trial</button>}
                      {me.caps.includes('billing') && <button className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface2" onClick={() => { setOpenMenu(null); setAct({ kind: 'set-plan', id: r.id, name: r.name }); }}>Set plan</button>}
                      {me.caps.includes('support') && <button className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface2" onClick={() => { setOpenMenu(null); setAct({ kind: 'support-session', id: r.id, name: r.name }); }}>Support session</button>}
                      {me.caps.includes('support') && <button className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface2" onClick={() => { setOpenMenu(null); setAct({ kind: 'access-workspace', id: r.id, name: r.name }); }}>Access workspace</button>}
                      {me.caps.includes('suspend') && (r.platform_hold
                        ? <button className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface2 text-accent" onClick={() => { setOpenMenu(null); setAct({ kind: 'reactivate', id: r.id, name: r.name }); }}>Release hold</button>
                        : <button className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface2 text-danger" onClick={() => { setOpenMenu(null); setAct({ kind: 'suspend', id: r.id, name: r.name }); }}>Suspend</button>)}
                    </div>
                  )}
                </div>
              </div>
            )},
          ]} />
      </div>

      {/* Plan distribution + Recent audit */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold text-sm">Plan distribution</span>
            <button className="text-xs text-accent hover:underline" onClick={() => onNavigate('plans')}>Manage plans</button>
          </div>
          {!o && <div className="skeleton h-24 rounded" />}
          {o?.by_plan.map((p: any) => (
            <div key={p.code} className="flex items-center gap-2.5 py-1.5">
              <span className="text-sm flex-1 truncate">{p.name}</span>
              <div className="w-28 h-1.5 bg-surface2 rounded-full overflow-hidden shrink-0">
                <div className="h-full bg-accent rounded-full transition-all duration-700" style={{ width: barsVisible ? `${Math.min(100, Math.round((p.n / Math.max(1, o.agencies)) * 100))}%` : '0%' }} />
              </div>
              <span className="num text-sm w-5 text-right shrink-0 text-muted">{p.n}</span>
            </div>
          ))}
          {o && (
            <div className="mt-3 pt-3 border-t border-line grid grid-cols-3 gap-2 text-center">
              {Object.entries(o.by_status as Record<string, number>).slice(0, 3).map(([k, v]) => (
                <div key={k}><div className="text-lg font-semibold num">{v}</div><Pill s={k} /></div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold text-sm">Recent operator actions</span>
            <button className="text-xs text-accent hover:underline" onClick={() => onNavigate('audit')}>View all</button>
          </div>
          {!o && <div className="skeleton h-24 rounded" />}
          {o && recent.length === 0 && <div className="text-sm text-muted">No operator actions yet.</div>}
          <div className="space-y-2.5">
            {recent.map((a: any) => (
              <div key={a.id} className="flex items-start gap-2 text-xs">
                <span className="text-muted num shrink-0">{String(a.created_at).slice(0, 10)}</span>
                <div className="min-w-0 flex-1">
                  <span className="capitalize">{a.action.replace(/_/g, ' ')}</span>
                  {a.agency_name && <span className="text-muted"> · {a.agency_name}</span>}
                </div>
                <span className="text-muted shrink-0 truncate max-w-[80px]">{a.admin_email?.split('@')[0]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Modals */}
      {newAgency && <NewAgencyModal plans={plans} onClose={() => setNewAgency(false)} onDone={(msg) => { setNewAgency(false); setNotice(msg); loadAgencies(); }} />}
      {detail && <AgencyDetailModal detail={detail} me={me} onClose={() => setDetail(null)} onAct={setAct} onRefresh={() => open(detail.agency.id)} />}
      {act && <ActionModal act={act} onClose={() => setAct(null)} onDone={(msg, closeDetail) => { setAct(null); if (msg) setNotice(msg); loadAgencies(); if (closeDetail) setDetail(null); else if (detail) open(detail.agency.id); }} />}
      {notice && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] rounded-lg border border-info/30 bg-surface shadow-pop text-sm px-4 py-3 max-w-md" role="status">{notice}<button className="ml-3 text-muted" onClick={() => setNotice('')}>×</button></div>}
    </div>
  );
}

function ActionModal({ act, onClose, onDone }: { act: Act; onClose(): void; onDone(msg?: string, closeDetail?: boolean): void }) {
  const { guarded } = useOp();
  const [f, setF] = useState<any>({ reason: '', days: 7, plan: 'growth', interval: 'yearly', until: new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10), minutes: 30, name: act.data?.name ?? '', base_currency: act.data?.base_currency ?? 'USD', tax_label: act.data?.tax_label ?? 'TAX' }); const [err, setErr] = useState(''); const [plans, setPlans] = useState<any[]>([]);
  useEffect(() => { if (act.kind === 'set-plan' || act.kind === 'grant') api('/platform/plans').then(setPlans); }, []);
  const titles: Record<Act['kind'], string> = { 'extend-trial': 'Extend trial', 'set-plan': 'Set plan', grant: 'Grant invoiced access', suspend: 'Request suspension', reactivate: 'Release operator hold', 'support-session': 'Open read-only support session', 'access-workspace': 'Access agency workspace', 'edit-agency': 'Edit agency', 'delete-agency': 'Delete agency' };
  const submit = async () => {
    try {
      if (act.kind === 'edit-agency') {
        await guarded(() => api(`/platform/agencies/${act.id}`, 'PUT', { name: f.name, base_currency: f.base_currency, tax_label: f.tax_label }));
        onDone(`Agency "${f.name}" updated.`); return;
      }
      if (act.kind === 'delete-agency') {
        await guarded(() => api(`/platform/agencies/${act.id}`, 'DELETE', { reason: f.reason }));
        onDone(`Agency "${act.name}" deleted.`, true); return;
      }
      const body: any = { reason: f.reason, ...(act.kind === 'extend-trial' ? { days: Number(f.days) } : {}), ...(act.kind === 'set-plan' ? { plan: f.plan, interval: f.interval } : {}), ...(act.kind === 'grant' ? { plan: f.plan, interval: f.interval, until: f.until } : {}), ...(act.kind === 'support-session' ? { minutes: Number(f.minutes) } : {}) };
      const r = await guarded(() => api(`/platform/agencies/${act.id}/${act.kind}`, 'POST', body));
      if (act.kind === 'support-session') { const payload = btoa(JSON.stringify({ token: r.token, agency: r.agency })); window.open(`/support#${payload}`, '_blank', 'noopener'); }
      if (act.kind === 'access-workspace') { const payload = btoa(JSON.stringify({ accessToken: r.accessToken, user: r.user, agency: r.agency })); window.open(`/workspace-access#${payload}`, '_blank', 'noopener'); }
      onDone(act.kind === 'suspend' && r.status === 'pending' ? 'Suspension requested. A second admin operator must approve it under Approvals — nothing has changed for the customer yet.' : undefined);
    } catch (e: any) { setErr(e.message); }
  };
  const isEditValid = act.kind === 'edit-agency' ? f.name.length >= 2 && f.base_currency.length === 3 && f.tax_label.length >= 1 : true;
  return <Modal title={`${titles[act.kind]} — ${act.name}`} onClose={onClose}><Err e={err} />
    {act.kind === 'edit-agency' && <div className="grid grid-cols-2 gap-x-4">
      <Field label="Agency name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Base currency (3 letters)"><input className="input num" maxLength={3} value={f.base_currency} onChange={(e) => setF({ ...f, base_currency: e.target.value.toUpperCase() })} /></Field>
      <Field label="Tax label"><input className="input num" value={f.tax_label} onChange={(e) => setF({ ...f, tax_label: e.target.value })} /></Field>
    </div>}
    {act.kind === 'extend-trial' && <Field label="Extra days"><input className="input num" type="number" min={1} max={60} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>}
    {(act.kind === 'set-plan' || act.kind === 'grant') && <div className="grid grid-cols-2 gap-x-4"><Field label="Plan"><select className="input" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>{plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field><Field label="Interval"><select className="input" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option>monthly</option><option>yearly</option></select></Field></div>}
    {act.kind === 'grant' && <Field label="Access until"><input className="input num" type="date" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} /></Field>}
    {act.kind === 'support-session' && <Field label="Minutes (5–60)"><input className="input num" type="number" min={5} max={60} value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} /></Field>}
    {act.kind === 'delete-agency' && <p className="text-sm text-danger mb-3">This permanently deletes the agency and all its data. This action cannot be undone.</p>}
    <div className="flex justify-end"><button className={['suspend', 'delete-agency'].includes(act.kind) ? 'btn bg-danger text-white' : 'btn'} disabled={!isEditValid} onClick={submit}>Confirm</button></div></Modal>;
}

/** Plan features as a tree: built-in switches (they turn real functionality on) plus any feature you type, each with optional sub-features. Stored flat: "Feature" and "Feature > Sub". */
function FeatureEditor({ value, onChange }: { value: string[]; onChange(v: string[]): void }) {
  const [name, setName] = useState(''); const [sub, setSub] = useState<Record<string, string>>({}); const [msg, setMsg] = useState('');
  const SEP = ' > ', parents = value.filter((f) => !f.includes(SEP)), subsOf = (f: string) => value.filter((x) => x.startsWith(f + SEP)).map((x) => x.slice(f.length + SEP.length));
  const clean = (t: string) => t.trim().replace(/\s+/g, ' ');
  const valid = (t: string) => t.length > 0 && t.length <= 40 && !/[,<>;|]/.test(t);
  const addParent = () => { const t = clean(name); if (!valid(t)) return setMsg('Use 1–40 characters, without commas or < >.'); if (value.includes(t)) return setMsg('That feature is already listed.'); setMsg(''); onChange([...value, t]); setName(''); };
  const addSub = (f: string) => { const t = clean(sub[f] ?? ''), full = f + SEP + t; if (!valid(t)) return setMsg('Use 1–40 characters, without commas or < >.'); if (value.includes(full)) return setMsg('That sub-feature is already listed.'); setMsg(''); onChange([...value, full]); setSub({ ...sub, [f]: '' }); };
  const toggleBuiltin = (f: string, on: boolean) => onChange(on ? [...value, f] : value.filter((x) => x !== f && !x.startsWith(f + SEP)));
  const custom = parents.filter((f) => !(FEATURES as readonly string[]).includes(f));
  const row = (f: string, builtin: boolean) => (
    <div key={f} className="rounded-lg border border-line p-2.5">
      <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{featName(f)}{builtin && <span className="ml-2 text-[11px] font-normal text-muted">switches this on for agencies</span>}</span>
        <button type="button" className="text-xs text-danger hover:underline" onClick={() => toggleBuiltin(f, false)} aria-label={`Remove ${f}`}>Remove</button></div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {subsOf(f).map((x) => <span key={x} className="chip !m-0 inline-flex items-center gap-1">{x}<button type="button" className="text-muted hover:text-danger" aria-label={`Remove ${x}`} onClick={() => onChange(value.filter((y) => y !== f + SEP + x))}>×</button></span>)}
        <input className="input !h-7 !w-44 text-xs" placeholder="Add sub-feature…" value={sub[f] ?? ''} onChange={(e) => setSub({ ...sub, [f]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSub(f); } }} />
        <button type="button" className="btn-ghost !h-7 !px-2 text-xs" disabled={!clean(sub[f] ?? '')} onClick={() => addSub(f)}>Add</button></div>
    </div>);
  return (<div>
    <div className="mb-2 flex flex-wrap gap-x-4 gap-y-2">{FEATURES.map((f) => <label key={f} className="flex gap-1.5 items-center text-sm"><input type="checkbox" checked={value.includes(f)} onChange={(e) => toggleBuiltin(f, e.target.checked)} />{featName(f)}</label>)}</div>
    <div className="grid gap-2 sm:grid-cols-2">{[...parents.filter((f) => (FEATURES as readonly string[]).includes(f)).map((f) => row(f, true)), ...custom.map((f) => row(f, false))]}</div>
    <div className="mt-3 flex flex-wrap items-center gap-2"><input className="input !w-64" placeholder="Add a feature, e.g. Priority onboarding" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addParent(); } }} /><button type="button" className="btn-ghost" disabled={!clean(name)} onClick={addParent}>Add feature</button>{msg && <span className="text-xs text-warn">{msg}</span>}</div>
  </div>);
}

const FEATURE_NAME: Record<string, string> = { portal: 'Client portal & payment links', accounting_export: 'Accounting export', automation: 'Automation rules', scheduled_reports: 'Scheduled reports', integrations: 'Webhooks & integrations', api: 'Public API', ai_assistant: 'AI assistant' };
const featName = (f: string) => FEATURE_NAME[f] ?? f.replace(/_/g, ' ');
const TIER_HUE = ['info', 'accent', 'success', 'warn'];
const yearlySaving = (p: any) => (Number(p.price_monthly) > 0 && Number(p.price_yearly) > 0 ? Math.round((1 - Number(p.price_yearly) / (Number(p.price_monthly) * 12)) * 100) : null);

/** One plan as an agency would see it: price, limits and what is included. Used for the list and for the live preview while editing. */
function PlanCard({ p, tier = 0, popular = false, share, canEdit, onEdit, onCopy, preview = false }: { p: any; tier?: number; popular?: boolean; share?: number; canEdit?: boolean; onEdit?(): void; onCopy?(): void; preview?: boolean }) {
  const hue = TIER_HUE[tier % TIER_HUE.length]; const save = yearlySaving(p); const features: string[] = p.features ?? [];
  const parents = features.filter((f) => !f.includes(' > ')); const subs = (f: string) => features.filter((x) => x.startsWith(f + ' > ')).map((x) => x.slice(f.length + 3));
  const limits: [any, string][] = [[p.max_seats === '' ? null : p.max_seats, 'Seats'], [p.max_branches === '' ? null : p.max_branches, 'Branches'], [p.max_bookings_month === '' ? null : p.max_bookings_month, 'Bookings / mo']];
  return (
    <article className={`card glow-card flex flex-col overflow-hidden !p-0 ${p.active ? '' : 'opacity-75'} ${popular ? 'ring-2 ring-accent' : ''}`} style={{ ['--hue' as any]: `var(--${hue})` }}>
      <div className="relative px-5 pb-4 pt-5" style={{ background: `linear-gradient(135deg, rgb(var(--${hue}) / .18), transparent 70%)` }}>
        <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="truncate text-lg font-bold tracking-tight">{p.name || 'Untitled plan'}</h3><div className="text-xs text-muted num">{p.code || 'code'}</div></div>
          <div className="flex shrink-0 flex-col items-end gap-1">{popular && <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-ink">Most used</span>}
            <span className={`pill ${p.active ? 'bg-success/15 text-success' : 'bg-muted/15 text-muted'}`}>{p.active ? 'Available' : 'Hidden'}</span></div></div>
        <p className="mt-2 min-h-[2.25rem] text-xs leading-relaxed text-muted">{p.description || 'No description yet.'}</p>
        <div className="mt-3 flex items-baseline gap-1"><span className="text-3xl font-extrabold num tracking-tight">{money(Number(p.price_monthly) || 0, p.currency || 'USD')}</span><span className="text-sm text-muted">/ month</span></div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted num"><span>{money(Number(p.price_yearly) || 0, p.currency || 'USD')} / year</span>{save !== null && save > 0 && <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold text-success">Save {save}%</span>}<span>· {p.trial_days}-day trial</span></div>
      </div>
      <div className="grid grid-cols-3 border-y border-line/70 text-center">{limits.map(([v, l], i) => <div key={l} className={`px-2 py-2.5 ${i ? 'border-l border-line/70' : ''}`}><div className="flex h-6 items-center justify-center text-lg font-bold num">{v === null || v === undefined ? <InfinityIcon size={18} aria-label="Unlimited" /> : v}</div><div className="text-[10px] uppercase tracking-wide text-muted">{l}</div></div>)}</div>
      <ul className="flex-1 space-y-1.5 px-5 py-4 text-sm">{parents.map((f) => <li key={f}><div className="flex items-start gap-2"><Check size={15} className="mt-0.5 shrink-0" style={{ color: `rgb(var(--${hue}))` }} /><span>{featName(f)}</span></div>
        {subs(f).length > 0 && <ul className="ml-6 mt-1 space-y-0.5 text-xs text-muted">{subs(f).map((x) => <li key={x}>· {x}</li>)}</ul>}</li>)}
        {!parents.length && <li className="text-xs text-muted">No features listed.</li>}</ul>
      {!preview && <div className="border-t border-line/70 px-5 py-3">
        <div className="mb-1.5 flex items-center justify-between text-xs"><span className="text-muted"><b className="text-fg num">{p.agencies}</b> agenc{p.agencies === 1 ? 'y' : 'ies'}</span><span className={p.stripe_price_monthly ? 'text-success' : 'text-warn'}>{p.stripe_price_monthly ? 'Stripe connected' : 'Stripe not set'}</span></div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface2" title={`${Math.round((share ?? 0) * 100)}% of agencies`}><div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.max(share ? 4 : 0, Math.round((share ?? 0) * 100))}%`, background: `rgb(var(--${hue}))` }} /></div>
        {canEdit && <div className="mt-3 flex gap-2"><button className="btn flex-1" onClick={onEdit}>Edit plan</button><button className="btn-ghost" onClick={onCopy} aria-label={`Duplicate ${p.name}`} title="Duplicate as a new plan"><Copy size={15} /></button></div>}</div>}
    </article>);
}

function Plans() {
  const { me, guarded } = useOp(); const canEdit = me.caps.includes('billing');
  const [plans, setPlans] = useState<any[]>([]); const [edit, setEdit] = useState<any>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => api('/platform/plans').then(setPlans); useEffect(() => { load(); }, []);
  const n = (v: any) => (v === '' || v === null || v === undefined ? null : Number(v));
  const problem = (e: any) => !/^[A-Za-z]{3}$/.test(e.currency ?? '') ? 'Currency must be a 3-letter code.' : !e.name?.trim() ? 'Give the plan a name.' : e.isNew && !/^[a-z0-9_-]{2,30}$/.test(e.code) ? 'Code: 2–30 lowercase letters, numbers, - or _ (it cannot be changed later).'
    : [e.price_monthly, e.price_yearly, e.trial_days].some((v) => v === '' || Number(v) < 0 || Number.isNaN(Number(v))) ? 'Prices and trial days must be zero or more.'
    : [e.max_seats, e.max_branches, e.max_bookings_month].some((v) => v !== '' && v !== null && (Number(v) < 1 || Number.isNaN(Number(v)))) ? 'Limits must be 1 or more, or unlimited.' : '';
  const save = async () => {
    const { agencies, id, code, isNew, ...rest } = edit;
    const allowedMods = Array.isArray(rest.allowed_modules) && rest.allowed_modules.length > 0 ? rest.allowed_modules : null;
    const body = { ...rest, currency: String(rest.currency).toUpperCase(), price_monthly: Number(rest.price_monthly), price_yearly: Number(rest.price_yearly), trial_days: Number(rest.trial_days), sort: Number(rest.sort), max_seats: n(rest.max_seats), max_branches: n(rest.max_branches), max_bookings_month: n(rest.max_bookings_month), active: !!rest.active, features: rest.features, allowed_modules: allowedMods };
    setBusy(true);
    try { if (isNew) await guarded(() => api('/platform/plans', 'POST', { ...body, code })); else await guarded(() => api(`/platform/plans/${id}`, 'PUT', body)); setEdit(null); setErr(''); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const blank = { isNew: true, code: '', name: '', description: '', currency: 'USD', price_monthly: 0, price_yearly: 0, trial_days: 14, max_seats: '', max_branches: '', max_bookings_month: '', features: ['portal'], allowed_modules: [] as string[], support_level: 'email', stripe_price_monthly: '', stripe_price_yearly: '', active: true, sort: 10, reason: '' };
  const open = (p: any) => { setErr(''); setEdit({ ...p, reason: '' }); };
  const up = (k: string) => (e: any) => setEdit({ ...edit, [k]: e.target.value });
  const lim = (k: string, label: string, unit: string) => (
    <Field label={label}><div className="flex items-center gap-2"><input className="input num" type="number" min={1} disabled={edit[k] === '' || edit[k] === null} value={edit[k] ?? ''} placeholder="Unlimited" onChange={up(k)} />
      <label className="flex items-center gap-1.5 text-xs text-muted whitespace-nowrap"><input type="checkbox" checked={edit[k] === '' || edit[k] === null} onChange={(e) => setEdit({ ...edit, [k]: e.target.checked ? '' : 10 })} />Unlimited</label></div><span className="block text-[11px] text-muted mt-1">{unit}</span></Field>);
  const save_pct = edit && Number(edit.price_monthly) > 0 && Number(edit.price_yearly) > 0 ? Math.round((1 - Number(edit.price_yearly) / (Number(edit.price_monthly) * 12)) * 100) : null;
  const bad = edit ? problem(edit) : '';
  return <>
    {(() => {
      const sorted = [...plans].sort((x, y) => Number(x.sort) - Number(y.sort) || Number(x.price_monthly) - Number(y.price_monthly)); const totalAg = plans.reduce((t, p) => t + Number(p.agencies), 0); const top = [...plans].sort((x, y) => y.agencies - x.agencies)[0];
      const allFeat = [...new Set(sorted.flatMap((p) => p.features.filter((f: string) => !f.includes(' > '))))] as string[];
      const stat = (label: string, value: any, hint: string, Icon: any, hue = 'accent') => <div className="card glow-card" style={{ ['--hue' as any]: `var(--${hue})` }}><div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{label}</span><span className="grid h-8 w-8 place-items-center rounded-xl" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}><Icon size={16} /></span></div><div className="mt-2 truncate text-2xl font-bold num">{value}</div><div className="mt-0.5 truncate text-[11px] text-muted">{hint}</div></div>;
      return <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-2xl text-sm text-muted">Edits apply to every agency on the plan straight away. Each change asks for a reason and is kept in the audit log.</p>{canEdit && <button className="btn" onClick={() => { setErr(''); setEdit(blank); }}><Plus size={16} />New plan</button>}</div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stat('Plans', plans.length, `${plans.filter((p) => p.active).length} available to customers`, Layers)}{stat('Agencies on a plan', totalAg, 'across all plans', Building2, 'info')}
          {stat('Most used', top && top.agencies ? top.name : '—', top && top.agencies ? `${top.agencies} agenc${top.agencies === 1 ? 'y' : 'ies'}` : 'Nobody yet', Sparkles, 'success')}{stat('Stripe', `${plans.filter((p) => p.stripe_price_monthly).length}/${plans.length}`, 'plans connected to card billing', DollarSign, plans.every((p) => p.stripe_price_monthly) ? 'success' : 'warn')}</div>
        {!plans.length ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-96" />)}</div>
          : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{sorted.map((p, i) => <PlanCard key={p.id} p={p} tier={i} popular={top?.id === p.id && p.agencies > 0 && plans.length > 1} share={totalAg ? p.agencies / totalAg : 0} canEdit={canEdit} onEdit={() => open(p)}
            onCopy={() => { setErr(''); setEdit({ ...p, isNew: true, id: undefined, code: '', name: `${p.name} copy`, agencies: 0, stripe_price_monthly: '', stripe_price_yearly: '', reason: '' }); }} />)}</div>}
        {plans.length > 1 && <div className="card !p-0 overflow-hidden"><div className="border-b border-line px-4 py-3 text-sm font-semibold">Compare plans</div>
          <div className="overflow-x-auto"><table className="w-full border-separate border-spacing-0"><thead><tr><th>&nbsp;</th>{sorted.map((p) => <th key={p.id} className="text-center">{p.name}</th>)}</tr></thead><tbody>
            {([['Monthly price', (p: any) => money(p.price_monthly, p.currency)], ['Yearly price', (p: any) => money(p.price_yearly, p.currency)], ['Free trial', (p: any) => `${p.trial_days} days`], ['Seats', (p: any) => p.max_seats ?? '∞'], ['Branches', (p: any) => p.max_branches ?? '∞'], ['Bookings / month', (p: any) => p.max_bookings_month ?? '∞']] as [string, (p: any) => any][]).map(([l, f]) => <tr key={l}><td className="text-sm text-muted">{l}</td>{sorted.map((p) => <td key={p.id} className="text-center text-sm font-medium num">{f(p)}</td>)}</tr>)}
            {allFeat.map((f) => <tr key={f}><td className="text-sm">{featName(f)}</td>{sorted.map((p) => <td key={p.id} className="text-center">{p.features.includes(f) ? <Check size={16} className="mx-auto text-success" aria-label="Included" /> : <span className="text-muted" aria-label="Not included">—</span>}</td>)}</tr>)}
          </tbody></table></div></div>}
      </div>;
    })()}
    {edit && <Modal title={edit.isNew ? 'New plan' : `Edit ${edit.name}`} wide onClose={() => setEdit(null)}><Err e={err} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]"><div className="min-w-0">
      <h4 className="text-sm font-semibold mb-2">Basics</h4>
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="Name"><input className="input" value={edit.name} onChange={up('name')} /></Field>
        {edit.isNew ? <Field label="Code" hint="Lowercase, permanent. e.g. pro"><input className="input num" value={edit.code} onChange={up('code')} /></Field> : <Field label="Code"><input className="input num" value={edit.code} disabled /></Field>}
        <div className="sm:col-span-2"><Field label="Description" hint="Shown to agencies choosing a plan."><input className="input" maxLength={200} value={edit.description ?? ''} onChange={up('description')} /></Field></div>
        <Field label="Available to new customers"><label className="flex gap-2 items-center text-sm h-9"><input type="checkbox" checked={!!edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Shown on the Billing page</label></Field>
        <Field label="Order" hint="Lower numbers appear first."><input className="input num" type="number" value={edit.sort} onChange={up('sort')} /></Field>
      </div>
      <h4 className="text-sm font-semibold mt-3 mb-2">Pricing</h4>
      <div className="grid sm:grid-cols-4 gap-x-4">
        <Field label="Currency" hint="3-letter code, e.g. USD, EUR, PKR"><input className="input num uppercase" maxLength={3} value={edit.currency ?? 'USD'} onChange={(e) => setEdit({ ...edit, currency: e.target.value.toUpperCase() })} /></Field>
        <Field label="Monthly price"><input className="input num" type="number" min={0} value={edit.price_monthly} onChange={up('price_monthly')} /></Field>
        <Field label="Yearly price" hint={save_pct === null ? undefined : save_pct > 0 ? `Customers save ${save_pct}% by paying yearly` : save_pct === 0 ? 'Same as paying monthly' : 'Dearer than paying monthly — check this'}><input className="input num" type="number" min={0} value={edit.price_yearly} onChange={up('price_yearly')} /></Field>
        <Field label="Free trial (days)"><input className="input num" type="number" min={0} value={edit.trial_days} onChange={up('trial_days')} /></Field>
      </div>
      <h4 className="text-sm font-semibold mt-3 mb-2">Limits</h4>
      <div className="grid sm:grid-cols-3 gap-x-4">{lim('max_seats', 'Team seats', 'Users who can sign in')}{lim('max_branches', 'Branches', 'Offices')}{lim('max_bookings_month', 'Bookings per month', 'New bookings')}</div>
      <h4 className="text-sm font-semibold mt-3 mb-2">What’s included</h4>
      <Field label="Features" hint="Tick the built-in ones, or add your own. Sub-features sit under a feature and show on the plan card."><FeatureEditor value={edit.features} onChange={(v) => setEdit({ ...edit, features: v })} /></Field>
      <Field label="Allowed modules" hint="Leave all unchecked for full access. Tick specific modules to restrict this plan."><div className="grid sm:grid-cols-2 gap-2">{MODULE_CODES.map((m) => { const checked = Array.isArray(edit.allowed_modules) && edit.allowed_modules.includes(m.code); return (<label key={m.code} className="flex gap-2 items-center text-sm"><input type="checkbox" checked={checked} onChange={(e) => { const cur: string[] = Array.isArray(edit.allowed_modules) ? edit.allowed_modules : []; setEdit({ ...edit, allowed_modules: e.target.checked ? [...cur, m.code] : cur.filter((x: string) => x !== m.code) }); }} />{m.label}</label>); })}</div></Field>
      <h4 className="text-sm font-semibold mt-3 mb-2">Support & payments</h4>
      <div className="grid sm:grid-cols-3 gap-x-4">
        <Field label="Support level"><input className="input" value={edit.support_level} onChange={up('support_level')} /></Field>
        <Field label="Stripe price ID (monthly)"><input className="input num text-xs" value={edit.stripe_price_monthly ?? ''} onChange={up('stripe_price_monthly')} placeholder="price_…" /></Field>
        <Field label="Stripe price ID (yearly)"><input className="input num text-xs" value={edit.stripe_price_yearly ?? ''} onChange={up('stripe_price_yearly')} placeholder="price_…" /></Field>
      </div>
      {!edit.isNew && <>{edit.agencies > 0 && <div className="text-sm text-warn mb-3">{edit.agencies} agenc{edit.agencies === 1 ? 'y is' : 'ies are'} on this plan; changes apply to them immediately.</div>}
        <Field label="Reason for the change" hint="Kept in the audit log."><input className="input" value={edit.reason ?? ''} onChange={up('reason')} /></Field></>}
      </div>
      <aside className="hidden lg:block"><div className="sticky top-0"><div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">Live preview · what agencies see</div><PlanCard preview p={{ ...edit, price_monthly: edit.price_monthly === '' ? 0 : edit.price_monthly, features: edit.features ?? [] }} tier={Math.max(0, plans.findIndex((x: any) => x.id === edit.id))} /></div></aside></div>
      <div className="flex items-center justify-end gap-3 mt-2">{bad && <span className="text-xs text-warn mr-auto">{bad}</span>}<button className="btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn" disabled={!!bad || busy} onClick={save}>{busy ? 'Saving…' : edit.isNew ? 'Create plan' : 'Save changes'}</button></div></Modal>}
  </>;
}

export function AgencyAccessEntry() {
  const { ready, workspaceLogin, user } = useAuth(); const nav = useNavigate(); const [err, setErr] = useState(''); const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!ready) return;
    try { const p = JSON.parse(atob(location.hash.slice(1))); history.replaceState(null, '', '/workspace-access'); workspaceLogin(p.accessToken, p.user, p.agency); setEntered(true); }
    catch { setErr('This workspace access link is invalid. Open it from the platform console.'); }
  }, [ready]);
  useEffect(() => { if (entered && user) nav('/', { replace: true }); }, [entered, user]);
  return <div className="min-h-screen grid place-items-center p-6">{err ? <div className="card max-w-md text-center"><p className="text-danger text-sm">{err}</p></div> : <div className="h-8 w-8 rounded-full border-2 border-line border-t-accent animate-spin" role="status" aria-label="Opening workspace" />}</div>;
}

/** /support#<payload> — arrives from the console in a new tab; the token never touches the server log (URL fragment). */
export function SupportEntry() {
  const { ready, supportLogin, support } = useAuth(); const nav = useNavigate(); const [err, setErr] = useState('');
  useEffect(() => {
    if (!ready) return;
    try { const p = JSON.parse(atob(location.hash.slice(1))); history.replaceState(null, '', '/support'); supportLogin(p.token, p.agency); }
    catch { setErr('This support link is invalid. Open it again from the platform console.'); }
  }, [ready]);
  useEffect(() => { if (support) nav('/', { replace: true }); }, [support]);
  return <div className="min-h-screen grid place-items-center p-6">{err ? <div className="card max-w-md text-center"><p className="text-danger text-sm">{err}</p></div> : <div className="h-8 w-8 rounded-full border-2 border-line border-t-accent animate-spin" role="status" aria-label="Opening support session" />}</div>;
}
