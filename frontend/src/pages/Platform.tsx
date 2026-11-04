import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AlertTriangle, Building2, CheckSquare, Clock, DollarSign, Layers, LayoutDashboard, Plane, Search, Settings, ShieldAlert, Users } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Pill, Table } from '../components/ui';
import { ThemeMenuButton } from '../components/ThemeToggle';

const day = (d: any) => (d ? String(d).replace('T', ' ').slice(0, 16) : '—');
const FEATURES = ['portal', 'accounting_export', 'automation', 'scheduled_reports', 'integrations', 'api'];
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
type Tab = 'dashboard' | 'overview' | 'agencies' | 'plans' | 'audit' | 'security' | 'system' | 'operators' | 'approvals';

/** Operator-only console: fleet overview, agencies, plans, audit. Every change asks for a reason and is written to an append-only log. */
export default function Platform() {
  const { user, ready, logout } = useAuth(); const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('dashboard'); const [need2fa, setNeed2fa] = useState(false);
  const [me, setMe] = useState<Me | null>(null); const [pending, setPending] = useState(0);
  useEffect(() => { if (tab) refreshPending(); }, [tab, me]);
  const refreshPending = () => { if (me?.caps.includes('suspend')) api('/platform/approvals?status=pending').then((r) => setPending(r.length)).catch(() => {}); };
  useEffect(() => { if (user?.is_platform_admin) api('/platform/me').then(setMe).catch((e) => e.data?.code === 'platform_2fa_required' ? setNeed2fa(true) : null); }, [user]);
  const guarded = async <T,>(fn: () => Promise<T>): Promise<T> => fn();
  if (!ready) return <div className="min-h-screen grid place-items-center"><div className="h-8 w-8 rounded-full border-2 border-line border-t-accent animate-spin" role="status" aria-label="Loading" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.is_platform_admin) return <Navigate to="/" replace />;

  // Sidebar nav groups (desktop)
  const navGroups: { label: string; items: [Tab, string][] }[] = me ? [
    { label: 'Main', items: [['dashboard', 'Dashboard'], ['overview', 'Overview'], ['agencies', 'Agencies']] },
    { label: 'Operations', items: [['plans', 'Plans'], ['audit', 'Operator audit'], ...(me.caps.includes('suspend') ? [['approvals', 'Approvals'], ['operators', 'Operators']] as [Tab, string][] : [])] },
    { label: 'System', items: [['security', 'Security events'], ['system', 'System']] },
  ] : [];

  // Mobile flat tab list
  const allTabs: [Tab, string][] = [['dashboard', 'Dashboard'], ['overview', 'Overview'], ['agencies', 'Agencies'], ['plans', 'Plans'], ['audit', 'Operator audit'], ['security', 'Security events'], ['system', 'System'], ...(me?.caps.includes('suspend') ? [['approvals', 'Approvals'], ['operators', 'Operators']] as [Tab, string][] : [])];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-line bg-surface/80 backdrop-blur px-4 md:px-8 h-14 flex items-center justify-between shrink-0 sticky top-0 z-30">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-indigo-500 text-white grid place-items-center"><Plane size={15} /></div>
          <span className="text-sm font-semibold">Platform console</span>
          <span className="text-xs text-muted hidden sm:inline">· {user.email}</span>
          {me && <span className="pill bg-surface2 text-muted capitalize">{me.role}</span>}
        </div>
        <div className="flex items-center gap-3">
          {me && !need2fa && <div className="hidden lg:flex items-center gap-2 bg-surface2 border border-line rounded-lg px-3 h-8 text-xs text-muted cursor-default"><Search size={12} className="shrink-0" /><span>Search agencies…</span><kbd className="kbd ml-1">⌘K</kbd></div>}
          <div className="flex items-center gap-1.5 text-[11px] text-muted"><div className="live-dot" /><span className="hidden sm:inline">Live</span></div>
          <button className="btn-ghost" onClick={() => nav('/')}>Workspace</button><ThemeMenuButton /><button className="btn-ghost" onClick={async () => { await logout(); nav('/login'); }}>Sign out</button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar (desktop) */}
        {me && !need2fa && (
          <nav className="w-52 shrink-0 border-r border-line py-4 px-2 hidden md:flex flex-col overflow-y-auto">
            {navGroups.map((group) => (
              <div key={group.label} className="mb-4">
                <div className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{group.label}</div>
                {group.items.map(([k, l]) => (
                  <button key={k} role="tab" aria-selected={tab === k}
                    className={`w-full text-left flex items-center justify-between rounded-lg px-3 py-2 text-sm mb-0.5 transition-colors ${tab === k ? 'bg-indigo-500/10 text-indigo-500 font-medium' : 'text-muted hover:bg-surface2 hover:text-fg'}`}
                    onClick={() => setTab(k)}>
                    <span>{l}</span>
                    {k === 'approvals' && pending > 0 && (
                      <span className="min-w-[1.1rem] h-4 px-1 text-[10px] font-bold rounded-full bg-danger text-white flex items-center justify-center leading-none">{pending}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        )}

        {/* Content */}
        <main className="flex-1 min-w-0 overflow-auto">
          <div className="max-w-[1200px] mx-auto px-4 md:px-6 pt-6 pb-20 md:pb-6">
            {need2fa ? <TwoFactorGate onDone={() => { setNeed2fa(false); api('/platform/me').then(setMe); }} />
              : !me ? <div className="skeleton h-40" />
              : <OpCtx.Provider value={{ me, guarded }}>
                {/* Mobile tab strip */}
                <div className="hidden md:flex flex-wrap gap-2 mb-5" role="tablist">
                  {allTabs.map(([k, l]) => (
                    <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'btn' : 'btn-ghost'} onClick={() => setTab(k)}>
                      {l}{k === 'approvals' && pending > 0 && <span className="ml-1 min-w-[1rem] h-4 px-0.5 text-[9px] font-bold rounded-full bg-danger text-white inline-flex items-center justify-center">{pending}</span>}
                    </button>
                  ))}
                </div>
                {tab === 'dashboard' && <Dashboard onNavigate={setTab} />}{tab === 'overview' && <Overview />}{tab === 'agencies' && <Agencies />}{tab === 'plans' && <Plans />}{tab === 'audit' && <Audit />}{tab === 'security' && <SecurityEvents />}{tab === 'system' && <System />}{tab === 'operators' && <Operators />}{tab === 'approvals' && <Approvals onChange={refreshPending} />}
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
function Agencies() {
  const [res, setRes] = useState<any>({ rows: [], total: 0 }); const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [page, setPage] = useState(1);
  const { me } = useOp(); const [notice, setNotice] = useState(''); const [detail, setDetail] = useState<any>(null); const [act, setAct] = useState<Act | null>(null); const [err, setErr] = useState('');
  const [newAgency, setNewAgency] = useState(false); const [plans, setPlans] = useState<any[]>([]);
  const load = () => api(`/platform/agencies?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}${status ? `&status=${status}` : ''}`).then(setRes).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [page, status]);
  useEffect(() => { if (me.caps.includes('billing')) api('/platform/plans').then(setPlans); }, []);
  const open = async (id: number) => { try { setDetail(await api(`/platform/agencies/${id}`)); } catch (e: any) { setErr(e.message); } };
  return <>
    <Err e={err} />
    <form className="flex flex-wrap gap-2 mb-3" onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }}>
      <div className="relative"><Search size={14} className="absolute left-3 top-3 text-muted" /><input className="input pl-8 w-64" placeholder="Agency name or member email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search agencies" /></div>
      <select className="input w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status"><option value="">All statuses</option>{['trialing', 'active', 'past_due', 'grace', 'suspended', 'cancelled'].map((s) => <option key={s}>{s}</option>)}</select><button className="btn-ghost">Search</button>
      {me.caps.includes('billing') && <button type="button" className="btn ml-auto" onClick={() => setNewAgency(true)}>New agency</button>}
    </form>
    {newAgency && <NewAgencyModal plans={plans} onClose={() => setNewAgency(false)} onDone={(msg) => { setNewAgency(false); setNotice(msg); load(); }} />}
    <Table rows={res.rows} onRow={(r: any) => open(r.id)} empty="No agencies match" cols={[
      { h: 'Agency', render: (r: any) => <><div className="font-medium">{r.name}</div><div className="text-xs text-muted num">#{r.id} · created {String(r.created_at).slice(0, 10)}</div></> }, { h: 'Plan', render: (r: any) => r.plan_name ?? '—' },
      { h: 'Status', render: (r: any) => <><Pill s={r.status ?? 'cancelled'} />{!!r.platform_hold && <span className="text-xs text-danger ml-2">hold</span>}{!!r.is_manual && <span className="text-xs text-muted ml-2">invoiced</span>}</> },
      { h: 'Seats', right: true, render: (r: any) => r.seats }, { h: 'Last active', render: (r: any) => <span className="text-xs num">{day(r.last_active)}</span> }]} />
    <div className="flex items-center justify-between mt-3 text-sm text-muted"><span>{res.total} agencies</span><div className="flex gap-2"><button className="btn-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button className="btn-ghost" disabled={page * res.page_size >= res.total} onClick={() => setPage(page + 1)}>Next</button></div></div>

    {detail && <AgencyDetailModal detail={detail} me={me} onClose={() => setDetail(null)} onAct={setAct} onRefresh={() => open(detail.agency.id)} />}
    {notice && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] rounded-lg border border-info/30 bg-surface shadow-pop text-sm px-4 py-3 max-w-md" role="status">{notice}<button className="ml-3 text-muted" onClick={() => setNotice('')} aria-label="Dismiss">×</button></div>}
    {act && <ActionModal act={act} onClose={() => setAct(null)} onDone={(msg, closeDetail) => { setAct(null); if (msg) setNotice(msg); load(); if (closeDetail) setDetail(null); else if (detail) open(detail.agency.id); }} />}
  </>;
}

function AgencyDetailModal({ detail, me, onClose, onAct, onRefresh }: { detail: any; me: Me; onClose(): void; onAct(a: Act): void; onRefresh(): void }) {
  const ag = detail.agency;
  return <Modal title={ag.name} wide onClose={onClose}>
    <div className="flex gap-5">
      {/* Left: data */}
      <div className="flex-1 min-w-0 space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="card"><div className="text-xs text-muted">Subscription</div>{detail.subscription ? <><div className="mt-1"><Pill s={detail.subscription.status} /> <span className="font-medium ml-1">{detail.subscription.plan_name}</span> <span className="text-xs text-muted">{detail.subscription.interval}</span></div>
            <dl className="text-xs mt-2 space-y-0.5 text-muted"><div>Trial ends: <span className="num text-fg">{day(detail.subscription.trial_ends_at)}</span></div><div>Period ends: <span className="num text-fg">{day(detail.subscription.current_period_end)}</span></div>{detail.subscription.manual && <div>Invoiced customer (no card)</div>}{detail.subscription.platform_hold && <div className="text-danger">Hold: {detail.subscription.hold_reason}</div>}</dl></> : '—'}</div>
          <div className="card"><div className="text-xs text-muted">Usage</div><div className="text-sm mt-1">{detail.usage.seats} members · {detail.usage.branches} branches · {detail.usage.bookings} bookings this month</div><div className="text-xs text-muted mt-2">Last active {day(detail.last_active)} · {detail.requests_30d} req / 30 d</div></div>
          <div className="card"><div className="text-xs text-muted">Health</div><div className="text-sm mt-1">{detail.open_critical_exceptions} critical exceptions · {detail.failed_emails_7d} failed emails (7 d)</div></div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div><div className="font-medium text-sm mb-1">Members</div><Table rows={detail.members.map((m: any, i: number) => ({ ...m, id: i }))} cols={[{ h: 'Name', render: (m: any) => <>{m.name}<div className="text-xs text-muted">{m.email}</div></> }, { h: 'Role', render: (m: any) => m.role }, { h: '2FA', render: (m: any) => (m.totp_enabled ? '✓' : '—') }]} /></div>
          <div><div className="font-medium text-sm mb-1">Billing events</div><Table rows={detail.billing_events.map((m: any, i: number) => ({ ...m, id: i }))} empty="None" cols={[{ h: 'When', render: (e: any) => <span className="text-xs num">{day(e.created_at)}</span> }, { h: 'Event', render: (e: any) => <>{e.kind}<div className="text-xs text-muted">{e.detail}</div></> }]} /></div>
        </div>
        <div><div className="font-medium text-sm mb-1">Support access history</div>
          <Table rows={detail.support_sessions} empty="No support sessions" cols={[{ h: 'Operator', render: (s: any) => s.admin_email }, { h: 'Reason', render: (s: any) => s.reason }, { h: 'Expires', render: (s: any) => <span className="text-xs num">{day(s.expires_at)}</span> },
            { h: '', render: (s: any) => (s.revoked_at ? <Pill s="void" /> : new Date(s.expires_at) > new Date() ? me.caps.includes('support') ? <button className="btn-ghost" onClick={async () => { const reason = prompt('Reason for ending this session:'); if (reason) { await api(`/platform/support-sessions/${s.id}/revoke`, 'POST', { reason }); onRefresh(); } }}>End</button> : '' : '') }]} />
        </div>
      </div>

      {/* Right: action panel */}
      <div className="w-48 shrink-0 space-y-5">
        {(me.caps.includes('billing') || me.caps.includes('support')) && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5 px-1">Billing</div>
            <div className="flex flex-col gap-0.5">
              {me.caps.includes('billing') && detail.subscription?.status === 'trialing' && <button className="w-full btn-ghost text-left text-sm !justify-start" onClick={() => onAct({ kind: 'extend-trial', id: ag.id, name: ag.name })}>Extend trial</button>}
              {me.caps.includes('billing') && <button className="w-full btn-ghost text-left text-sm !justify-start" onClick={() => onAct({ kind: 'set-plan', id: ag.id, name: ag.name })}>Set plan</button>}
              {me.caps.includes('billing') && <button className="w-full btn-ghost text-left text-sm !justify-start" onClick={() => onAct({ kind: 'grant', id: ag.id, name: ag.name })}>Grant invoiced access</button>}
              {me.caps.includes('billing') && <button className="w-full btn-ghost text-left text-sm !justify-start" onClick={() => onAct({ kind: 'edit-agency', id: ag.id, name: ag.name, data: { name: ag.name, base_currency: ag.base_currency ?? 'USD', tax_label: ag.tax_label ?? 'TAX' } })}>Edit agency</button>}
            </div>
          </div>
        )}
        {me.caps.includes('support') && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5 px-1">Workspace</div>
            <div className="flex flex-col gap-0.5">
              <button className="w-full btn-ghost text-left text-sm !justify-start" onClick={() => onAct({ kind: 'support-session', id: ag.id, name: ag.name })}>Open support session</button>
              <button className="w-full btn text-sm" onClick={() => onAct({ kind: 'access-workspace', id: ag.id, name: ag.name })}>Access workspace</button>
            </div>
          </div>
        )}
        {me.caps.includes('suspend') && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-danger mb-1.5 px-1">Danger zone</div>
            <div className="flex flex-col gap-0.5">
              {detail.subscription?.platform_hold
                ? <button className="w-full btn text-sm" onClick={() => onAct({ kind: 'reactivate', id: ag.id, name: ag.name })}>Release hold</button>
                : <button className="w-full btn-ghost text-left text-sm !justify-start text-danger" onClick={() => onAct({ kind: 'suspend', id: ag.id, name: ag.name })}>Request suspension</button>}
              <button className="w-full btn-ghost text-left text-sm !justify-start text-danger" onClick={() => onAct({ kind: 'delete-agency', id: ag.id, name: ag.name })}>Delete agency</button>
            </div>
          </div>
        )}
        {me.role === 'readonly' && <p className="text-xs text-muted px-1">Read-only operator role.</p>}
      </div>
    </div>
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

function KpiCard({ label, icon: Icon, rawValue, formattedValue, sub, alert = false, glow, trend, trendDir = 'flat', sparkline = false, index }: {
  label: string; icon: any; rawValue?: number; formattedValue?: string; sub?: string;
  alert?: boolean; glow?: 'accent' | 'success';
  trend?: string; trendDir?: 'up' | 'down' | 'flat';
  sparkline?: boolean; index: number;
}) {
  const counted = useCountUp(rawValue);
  const isLoading = rawValue == null && formattedValue == null;
  const display = formattedValue ?? (rawValue != null ? counted.toLocaleString() : null);

  return (
    <div
      className={`card relative overflow-hidden transition-all hover:-translate-y-0.5 kpi-enter ${
        alert ? 'border-l-4 !border-l-warn border-warn/30 bg-warn/5' : ''
      }`}
      style={{ animationDelay: `${index * 55}ms` }}
    >
      {glow && (
        <div className={`absolute -top-10 -right-4 w-32 h-32 rounded-full pointer-events-none opacity-70 ${
          glow === 'accent' ? 'bg-accent/15' : 'bg-success/15'
        }`} style={{ filter: 'blur(20px)' }} />
      )}
      <div className={`flex items-center gap-1.5 text-xs font-medium mb-1.5 relative z-10 ${alert ? 'text-warn' : 'text-muted'}`}>
        <Icon size={12} />{label}
      </div>
      <div className={`text-3xl font-bold num tracking-tight relative z-10 ${
        alert ? 'text-warn' : glow === 'accent' ? 'text-accent' : glow === 'success' ? 'text-success' : ''
      }`}>
        {isLoading ? <span className="block h-8 w-20 skeleton rounded" /> : display}
      </div>
      {trend != null ? (
        <div className={`flex items-center gap-1 text-[11px] font-medium mt-1 relative z-10 ${
          trendDir === 'up' ? 'text-success' : trendDir === 'down' ? 'text-danger' : 'text-muted'
        }`}>
          <span>{trendDir === 'up' ? '↑' : trendDir === 'down' ? '↓' : '→'}</span>
          <span>{trend}</span>
        </div>
      ) : (
        <div className="text-[11px] text-muted mt-0.5 relative z-10">{sub}</div>
      )}
      {sparkline && !isLoading && (
        <svg className="mt-2 w-full relative z-10" viewBox="0 0 120 28" fill="none" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={`spk${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity="0.2" />
              <stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d="M0 24 C30 24 50 20 70 17 C90 14 105 12 120 11" stroke="rgb(var(--accent))" strokeWidth="1.5" opacity="0.5" />
          <path d="M0 24 C30 24 50 20 70 17 C90 14 105 12 120 11 L120 28 L0 28 Z" fill={`url(#spk${index})`} />
          <circle cx="120" cy="11" r="2.5" fill="rgb(var(--accent))" />
        </svg>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Dashboard ------------------------------------------------------------------ */
function Dashboard({ onNavigate }: { onNavigate(t: Tab): void }) {
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

  const kpis = [
    { icon: Building2, label: 'Total agencies', rawValue: o?.agencies, sub: '', glow: 'accent' as const, trend: o ? `${o.new_30d} new this month` : undefined, trendDir: 'up' as const },
    { icon: DollarSign, label: 'MRR', formattedValue: o ? money(o.mrr) : undefined, sub: '', sparkline: true, trend: o ? `${money(o.arr)} ARR` : undefined, trendDir: 'flat' as const },
    { icon: DollarSign, label: 'Invoiced MRR', formattedValue: o ? money(o.manual_mrr) : undefined, sub: '', trend: o ? 'manual billing' : undefined, trendDir: 'flat' as const },
    { icon: Clock, label: 'Trials expiring', rawValue: o?.trials_ending_7d, sub: 'within 7 days', alert: !!(o?.trials_ending_7d), trend: o ? 'within 7 days' : undefined, trendDir: o?.trials_ending_7d ? 'down' as const : 'flat' as const },
    { icon: Users, label: 'Support sessions', rawValue: o?.active_support_sessions, sub: '', trend: o ? 'live now' : undefined, trendDir: 'flat' as const },
    { icon: ShieldAlert, label: 'Operator holds', rawValue: o?.platform_holds, sub: '', alert: !!(o?.platform_holds || o?.pending_approvals), trend: o ? (o.pending_approvals ? `${o.pending_approvals} pending approval` : 'no holds') : undefined, trendDir: o?.platform_holds ? 'down' as const : 'flat' as const },
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
      {/* KPI strip */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k, i) => <KpiCard key={k.label} index={i} {...k} />)}
      </div>

      {/* Alert banner */}
      {alerts.length > 0 && (
        <div className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <AlertTriangle size={15} className="text-warn shrink-0" />
          {alerts.map((a) => <span key={a} className="text-sm text-warn">{a}</span>)}
          {(o?.pending_approvals || o?.platform_holds) && (
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
            { h: 'Agency', render: (r: any) => <><div className="font-medium">{r.name}</div><div className="text-xs text-muted num">#{r.id} · {String(r.created_at).slice(0, 10)}</div></> },
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
  const isDeleteValid = act.kind === 'delete-agency' ? f.reason.trim().length >= 5 : true;
  const isReasonRequired = !['edit-agency', 'delete-agency'].includes(act.kind);
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
    {(isReasonRequired || act.kind === 'delete-agency') && <Field label="Reason (recorded in the audit log)"><textarea className="input" rows={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Customer ticket #1234" /></Field>}
    <div className="flex justify-end"><button className={['suspend', 'delete-agency'].includes(act.kind) ? 'btn bg-danger text-white' : 'btn'} disabled={!(isEditValid && isDeleteValid) || (isReasonRequired && f.reason.trim().length < 5)} onClick={submit}>Confirm</button></div></Modal>;
}

function Plans() {
  const { me, guarded } = useOp(); const canEdit = me.caps.includes('billing');
  const [plans, setPlans] = useState<any[]>([]); const [edit, setEdit] = useState<any>(null); const [err, setErr] = useState('');
  const load = () => api('/platform/plans').then(setPlans); useEffect(() => { load(); }, []);
  const save = async () => {
    const n = (v: any) => (v === '' || v === null || v === undefined ? null : Number(v)); const { agencies, id, code, ...rest } = edit;
    const allowedMods = Array.isArray(rest.allowed_modules) && rest.allowed_modules.length > 0 ? rest.allowed_modules : null;
    const body = { ...rest, price_monthly: Number(rest.price_monthly), price_yearly: Number(rest.price_yearly), trial_days: Number(rest.trial_days), sort: Number(rest.sort), max_seats: n(rest.max_seats), max_branches: n(rest.max_branches), max_bookings_month: n(rest.max_bookings_month), active: !!rest.active, features: rest.features, allowed_modules: allowedMods };
    try { if (edit.isNew) await guarded(() => api('/platform/plans', 'POST', { ...body, code: edit.code })); else await guarded(() => api(`/platform/plans/${id}`, 'PUT', { ...body, reason: edit.reason })); setEdit(null); setErr(''); load(); } catch (e: any) { setErr(e.message); }
  };
  const blank = { isNew: true, code: '', name: '', description: '', price_monthly: 0, price_yearly: 0, trial_days: 14, max_seats: '', max_branches: '', max_bookings_month: '', features: ['portal'], allowed_modules: [] as string[], support_level: 'email', stripe_price_monthly: '', stripe_price_yearly: '', active: true, sort: 10, reason: '' };
  return <>
    <div className="flex justify-between items-center mb-3"><p className="text-sm text-muted">Plan changes apply to every agency on the plan immediately. Leave a limit empty for unlimited.</p>{canEdit && <button className="btn" onClick={() => setEdit(blank)}>New plan</button>}</div>
    <Table rows={plans} onRow={canEdit ? (p) => setEdit({ ...p, reason: '' }) : undefined} cols={[{ h: 'Plan', render: (p: any) => <><div className="font-medium">{p.name} <span className="text-xs text-muted num">{p.code}</span></div><div className="text-xs text-muted">{p.features.join(', ')}</div></> },
      { h: 'Price', render: (p: any) => `${money(p.price_monthly, p.currency)} / ${money(p.price_yearly, p.currency)}` }, { h: 'Limits', render: (p: any) => `${p.max_seats ?? '∞'} seats · ${p.max_branches ?? '∞'} branches · ${p.max_bookings_month ?? '∞'} bookings` },
      { h: 'Stripe', render: (p: any) => (p.stripe_price_monthly ? '✓' : <span className="text-warn text-xs">not set</span>) }, { h: 'Agencies', right: true, render: (p: any) => p.agencies }, { h: 'Active', render: (p: any) => (p.active ? '✓' : '—') }]} />
    {edit && <Modal title={edit.isNew ? 'New plan' : `Edit ${edit.name}`} wide onClose={() => setEdit(null)}><Err e={err} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4">
        {edit.isNew && <Field label="Code"><input className="input num" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>}
        <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field><Field label="Monthly price"><input className="input num" type="number" value={edit.price_monthly} onChange={(e) => setEdit({ ...edit, price_monthly: e.target.value })} /></Field>
        <Field label="Yearly price"><input className="input num" type="number" value={edit.price_yearly} onChange={(e) => setEdit({ ...edit, price_yearly: e.target.value })} /></Field><Field label="Trial days"><input className="input num" type="number" value={edit.trial_days} onChange={(e) => setEdit({ ...edit, trial_days: e.target.value })} /></Field>
        <Field label="Max seats"><input className="input num" type="number" value={edit.max_seats ?? ''} onChange={(e) => setEdit({ ...edit, max_seats: e.target.value })} /></Field><Field label="Max branches"><input className="input num" type="number" value={edit.max_branches ?? ''} onChange={(e) => setEdit({ ...edit, max_branches: e.target.value })} /></Field>
        <Field label="Bookings / month"><input className="input num" type="number" value={edit.max_bookings_month ?? ''} onChange={(e) => setEdit({ ...edit, max_bookings_month: e.target.value })} /></Field><Field label="Support level"><input className="input" value={edit.support_level} onChange={(e) => setEdit({ ...edit, support_level: e.target.value })} /></Field>
        <Field label="Stripe price (monthly)"><input className="input num text-xs" value={edit.stripe_price_monthly ?? ''} onChange={(e) => setEdit({ ...edit, stripe_price_monthly: e.target.value })} /></Field><Field label="Stripe price (yearly)"><input className="input num text-xs" value={edit.stripe_price_yearly ?? ''} onChange={(e) => setEdit({ ...edit, stripe_price_yearly: e.target.value })} /></Field>
        <Field label="Sort"><input className="input num" type="number" value={edit.sort} onChange={(e) => setEdit({ ...edit, sort: e.target.value })} /></Field><Field label="Available to new customers"><label className="flex gap-2 items-center text-sm h-10"><input type="checkbox" checked={!!edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label></Field></div>
      <Field label="Features"><div className="flex flex-wrap gap-3">{FEATURES.map((f) => <label key={f} className="flex gap-1.5 items-center text-sm"><input type="checkbox" checked={edit.features.includes(f)} onChange={(e) => setEdit({ ...edit, features: e.target.checked ? [...edit.features, f] : edit.features.filter((x: string) => x !== f) })} />{f.replace(/_/g, ' ')}</label>)}</div></Field>
      <Field label="Allowed modules"><p className="text-xs text-muted mb-2">Leave all unchecked to allow every module (full access). Check specific modules to restrict this plan.</p><div className="flex flex-col gap-2">{MODULE_CODES.map((m) => { const checked = Array.isArray(edit.allowed_modules) && edit.allowed_modules.includes(m.code); return (<label key={m.code} className="flex gap-2 items-center text-sm"><input type="checkbox" checked={checked} onChange={(e) => { const cur: string[] = Array.isArray(edit.allowed_modules) ? edit.allowed_modules : []; setEdit({ ...edit, allowed_modules: e.target.checked ? [...cur, m.code] : cur.filter((x: string) => x !== m.code) }); }} />{m.label}</label>); })}</div></Field>
      {!edit.isNew && <><div className="text-sm text-warn mb-2">{edit.agencies} agenc{edit.agencies === 1 ? 'y is' : 'ies are'} on this plan; changes apply to them immediately.</div><Field label="Reason (recorded in the audit log)"><input className="input" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></Field></>}
      <div className="flex justify-end"><button className="btn" disabled={!edit.name || (!edit.isNew && edit.reason.trim().length < 5)} onClick={save}>{edit.isNew ? 'Create plan' : 'Save changes'}</button></div></Modal>}
  </>;
}

function Approvals({ onChange }: { onChange(): void }) {
  const { me, guarded } = useOp(); const [rows, setRows] = useState<any[]>([]); const [err, setErr] = useState('');
  const load = () => api('/platform/approvals').then(setRows).catch((e) => setErr(e.message)); useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<any>) => { try { await guarded(fn); setErr(''); } catch (e: any) { setErr(e.message); } load(); onChange(); };
  return <><p className="text-sm text-muted mb-3">Suspensions need a second admin operator. You can't approve your own request; requests expire after 24 hours.</p><Err e={err} />
    <Table rows={rows} empty="No approval requests" cols={[
      { h: 'Agency', render: (r: any) => <><div className="font-medium">{r.agency_name}</div><div className="text-xs text-muted">suspend · requested by {r.requested_by_email}</div></> }, { h: 'Reason', render: (r: any) => <>{r.reason}{r.decision_note && <div className="text-xs text-muted">“{r.decision_note}” — {r.decided_by_email}</div>}</> },
      { h: 'Status', render: (r: any) => <Pill s={r.status === 'approved' ? 'approved' : r.status === 'pending' ? 'pending' : r.status === 'rejected' ? 'rejected' : 'cancelled'} /> }, { h: 'Expires', render: (r: any) => <span className="text-xs num">{day(r.expires_at)}</span> },
      { h: '', render: (r: any) => r.status !== 'pending' ? '' : r.requested_by_email === me.email ? <button className="btn-ghost" onClick={() => run(() => api(`/platform/approvals/${r.id}/cancel`, 'POST'))}>Cancel request</button> :
        <div className="flex gap-1 justify-end"><button className="btn" onClick={() => confirm(`Approve suspending ${r.agency_name}? Their workspace becomes read-only immediately.`) && run(() => api(`/platform/approvals/${r.id}/approve`, 'POST', {}))}>Approve</button><button className="btn-ghost" onClick={() => { const reason = prompt('Reason for rejecting:'); if (reason) run(() => api(`/platform/approvals/${r.id}/reject`, 'POST', { reason })); }}>Reject</button></div> }]} /></>;
}

function Operators() { const [rows, setRows] = useState<any[]>([]); useEffect(() => { api('/platform/operators').then(setRows); }, []);
  return <><p className="text-sm text-muted mb-3">Operators and their roles are managed from the server only: <span className="num">npm run platform:admin -- grant &lt;email&gt; &lt;role&gt;</span>. Roles: readonly · support · billing · admin.</p>
    <Table rows={rows.map((r, i) => ({ ...r, id: i }))} cols={[{ h: 'Operator', render: (r: any) => <>{r.name}<div className="text-xs text-muted">{r.email}</div></> }, { h: 'Role', render: (r: any) => <span className="capitalize">{r.role}</span> }, { h: '2FA', render: (r: any) => (r.totp_enabled ? '✓' : <span className="text-danger">off</span>) }, { h: 'Last confirmation', render: (r: any) => <span className="text-xs num">{day(r.platform_stepup_at)}</span> }]} /></>; }

function Audit() { const [rows, setRows] = useState<any[]>([]); useEffect(() => { api('/platform/audit').then(setRows); }, []);
  return <Table rows={rows} empty="No operator actions yet" cols={[{ h: 'When', render: (a: any) => <span className="text-xs num">{day(a.created_at)}</span> }, { h: 'Operator', render: (a: any) => a.admin_email }, { h: 'Action', render: (a: any) => a.action.replace(/_/g, ' ') }, { h: 'Agency', render: (a: any) => a.agency_name ?? '—' }, { h: 'Detail / reason', render: (a: any) => <>{a.detail}{a.reason && <div className="text-xs text-muted">“{a.reason}”</div>}</> }]} />; }
function SecurityEvents() { const [rows, setRows] = useState<any[]>([]); useEffect(() => { api('/platform/security-events').then(setRows); }, []);
  return <Table rows={rows} empty="No events" cols={[{ h: 'When', render: (a: any) => <span className="text-xs num">{day(a.created_at)}</span> }, { h: 'Agency', render: (a: any) => a.agency_name ?? '—' }, { h: 'Event', render: (a: any) => a.event.replace(/_/g, ' ') }, { h: 'Detail', render: (a: any) => a.detail }, { h: 'IP', render: (a: any) => <span className="text-xs num">{a.ip}</span> }]} />; }
function System() { const [s, setS] = useState<any>(null); useEffect(() => { api('/platform/system').then(setS); }, []);
  if (!s) return <div className="skeleton h-40" />; const h = s.health;
  return <div className="grid gap-3 md:grid-cols-2"><div className="card"><div className="font-medium mb-2">Readiness</div><div className="text-sm space-y-1"><div className="flex justify-between"><span>Database</span><Pill s={h.checks.database === 'ok' ? 'approved' : 'void'} /></div><div className="flex justify-between"><span>Migrations</span><span className="num text-xs">{h.checks.migrations?.applied} · {h.checks.migrations?.latest}</span></div></div></div>
    <div className="card"><div className="font-medium mb-2">Background jobs</div>{Object.entries(h.checks.jobs ?? {}).map(([k, v]: any) => <div key={k} className="flex justify-between text-sm py-0.5"><span>{k.replace(/_/g, ' ')}</span><span className="text-xs"><Pill s={v.status === 'ok' ? 'approved' : 'overdue'} /> <span className="text-muted ml-1">{v.age_minutes} min ago</span></span></div>)}{!Object.keys(h.checks.jobs ?? {}).length && <div className="text-sm text-muted">No heartbeats yet — the daily job has not run.</div>}</div></div>; }

/** /workspace-access#<payload> — opens agency workspace with full admin access in a new tab. */
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
