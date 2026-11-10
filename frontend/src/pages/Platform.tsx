import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Activity, AlertTriangle, Building2, ScrollText, Server, CheckSquare, Clock, DollarSign, Layers, LayoutDashboard, Plane, Search, Settings, ShieldAlert, Users } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Pill, Table } from '../components/ui';
import { ThemeMenuButton } from '../components/ThemeToggle';

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
type Tab = 'dashboard' | 'overview' | 'agencies' | 'plans' | 'audit' | 'security' | 'system' | 'operators' | 'approvals';

const TAB_ICON: Record<string, any> = { dashboard: LayoutDashboard, overview: Activity, agencies: Building2, plans: Layers, audit: ScrollText, approvals: CheckSquare, operators: Users, security: ShieldAlert, system: Server };
const TAB_HEAD: Record<string, [string, string]> = {
  dashboard: ['Dashboard', 'The whole platform at a glance: revenue, trials, agencies and what needs attention.'], overview: ['Overview', 'Fleet-wide usage and health.'],
  agencies: ['Agencies', 'Every customer agency, its plan and status.'], plans: ['Plans', 'Prices, limits and features customers can choose from.'],
  audit: ['Operator audit', 'Every operator action, kept as an append-only record.'], approvals: ['Approvals', 'Suspensions that need a second operator.'],
  operators: ['Operators', 'Who can use this console, and what they can do.'], security: ['Security events', 'Sign-in and access events across all agencies.'], system: ['System', 'Service health and background jobs.'],
};

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
          <div className="h-8 w-8 rounded-lg bg-accent text-accent-ink grid place-items-center shrink-0"><Plane size={17} strokeWidth={2.2} /></div>
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
          <nav className="w-60 shrink-0 bg-surface border-r border-line py-5 px-3 hidden md:flex flex-col overflow-y-auto">
            {navGroups.map((group) => (
              <div key={group.label} className="mb-4">
                <div className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{group.label}</div>
                {group.items.map(([k, l]) => (
                  <button key={k} role="tab" aria-selected={tab === k}
                    className={`w-full text-left flex items-center justify-between rounded-lg px-3 py-2 text-sm mb-0.5 transition-colors ${tab === k ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:bg-surface2 hover:text-fg'}`}
                    onClick={() => setTab(k)}>
                    <span className="flex items-center gap-2.5">{(() => { const I = TAB_ICON[k]; return <I size={16} className="shrink-0" />; })()}{l}</span>
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
          <div className="w-full px-4 md:px-8 pt-6 pb-20 md:pb-8">
            {need2fa ? <TwoFactorGate onDone={() => { setNeed2fa(false); api('/platform/me').then(setMe); }} />
              : !me ? <div className="skeleton h-40" />
              : <OpCtx.Provider value={{ me, guarded }}>
                {/* Mobile tab strip */}
                <div className="hidden md:block mb-6"><h1 className="text-2xl font-semibold">{TAB_HEAD[tab][0]}</h1><p className="text-sm text-muted mt-0.5">{TAB_HEAD[tab][1]}</p></div>
                <div className="flex md:hidden gap-2 mb-5 overflow-x-auto pb-1" role="tablist">
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
        <AiAccess detail={detail} canEdit={me.caps.includes('billing')} onRefresh={onRefresh} />
        <MembersPanel detail={detail} canManage={me.caps.includes('suspend')} onRefresh={onRefresh} />
        <div className="grid gap-4 md:grid-cols-2">
          <div><div className="font-medium text-sm mb-1">Billing events</div><Table rows={detail.billing_events.map((m: any, i: number) => ({ ...m, id: i }))} empty="None" cols={[{ h: 'When', render: (e: any) => <span className="text-xs num">{day(e.created_at)}</span> }, { h: 'Event', render: (e: any) => <>{e.kind}<div className="text-xs text-muted">{e.detail}</div></> }]} /></div>
        </div>
        <div><div className="font-medium text-sm mb-1">Support access history</div>
          <Table rows={detail.support_sessions} empty="No support sessions" cols={[{ h: 'Operator', render: (s: any) => s.admin_email }, { h: 'Reason', render: (s: any) => s.reason }, { h: 'Expires', render: (s: any) => <span className="text-xs num">{day(s.expires_at)}</span> },
            { h: '', render: (s: any) => (s.revoked_at ? <Pill s="void" /> : new Date(s.expires_at) > new Date() ? me.caps.includes('support') ? <button className="btn-ghost" onClick={async () => { await api(`/platform/support-sessions/${s.id}/revoke`, 'POST', {}); onRefresh(); }}>End</button> : '' : '') }]} />
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
      <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{f.replace(/_/g, ' ')}{builtin && <span className="ml-2 text-[11px] font-normal text-muted">switches this on for agencies</span>}</span>
        <button type="button" className="text-xs text-danger hover:underline" onClick={() => toggleBuiltin(f, false)} aria-label={`Remove ${f}`}>Remove</button></div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {subsOf(f).map((x) => <span key={x} className="chip !m-0 inline-flex items-center gap-1">{x}<button type="button" className="text-muted hover:text-danger" aria-label={`Remove ${x}`} onClick={() => onChange(value.filter((y) => y !== f + SEP + x))}>×</button></span>)}
        <input className="input !h-7 !w-44 text-xs" placeholder="Add sub-feature…" value={sub[f] ?? ''} onChange={(e) => setSub({ ...sub, [f]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSub(f); } }} />
        <button type="button" className="btn-ghost !h-7 !px-2 text-xs" disabled={!clean(sub[f] ?? '')} onClick={() => addSub(f)}>Add</button></div>
    </div>);
  return (<div>
    <div className="mb-2 flex flex-wrap gap-x-4 gap-y-2">{FEATURES.map((f) => <label key={f} className="flex gap-1.5 items-center text-sm"><input type="checkbox" checked={value.includes(f)} onChange={(e) => toggleBuiltin(f, e.target.checked)} />{f.replace(/_/g, ' ')}</label>)}</div>
    <div className="grid gap-2 sm:grid-cols-2">{[...parents.filter((f) => (FEATURES as readonly string[]).includes(f)).map((f) => row(f, true)), ...custom.map((f) => row(f, false))]}</div>
    <div className="mt-3 flex flex-wrap items-center gap-2"><input className="input !w-64" placeholder="Add a feature, e.g. Priority onboarding" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addParent(); } }} /><button type="button" className="btn-ghost" disabled={!clean(name)} onClick={addParent}>Add feature</button>{msg && <span className="text-xs text-warn">{msg}</span>}</div>
  </div>);
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
    <div className="flex flex-wrap justify-between items-center gap-2 mb-4"><p className="text-sm text-muted max-w-2xl">Click a plan to edit it. Changes apply to every agency on the plan immediately; the reason you give is kept in the audit log.</p>{canEdit && <button className="btn" onClick={() => { setErr(''); setEdit(blank); }}>New plan</button>}</div>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {plans.map((p: any) => (
        <div key={p.id} className={`card flex flex-col gap-3 ${p.active ? '' : 'opacity-70'}`}>
          <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="font-semibold text-lg">{p.name} <span className="text-xs font-normal text-muted num">{p.code}</span></div><div className="text-xs text-muted">{p.description || '—'}</div></div>
            <span className={`pill ${p.active ? 'bg-success/15 text-success' : 'bg-muted/15 text-muted'}`}>{p.active ? 'Available' : 'Hidden'}</span></div>
          <div><span className="text-2xl font-semibold num">{money(p.price_monthly, p.currency)}</span><span className="text-sm text-muted"> / month</span><div className="text-xs text-muted num">{money(p.price_yearly, p.currency)} / year · {p.trial_days}-day trial</div></div>
          <div className="text-sm grid grid-cols-3 gap-2 text-center">{[[p.max_seats, 'seats'], [p.max_branches, 'branches'], [p.max_bookings_month, 'bookings/mo']].map(([v, l]: any) => <div key={l} className="rounded-lg bg-surface2 py-1.5"><div className="font-semibold num">{v ?? '∞'}</div><div className="text-[11px] text-muted">{l}</div></div>)}</div>
          <div className="flex flex-wrap gap-1">{p.features.filter((f: string) => !f.includes(' > ')).map((f: string) => { const n = p.features.filter((x: string) => x.startsWith(f + ' > ')).length; return <span key={f} className="chip" title={n ? p.features.filter((x: string) => x.startsWith(f + ' > ')).map((x: string) => x.slice(f.length + 3)).join(', ') : undefined}>{f.replace(/_/g, ' ')}{n ? ` +${n}` : ''}</span>; })}</div>
          <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted"><span>{p.agencies} agenc{p.agencies === 1 ? 'y' : 'ies'} · Stripe {p.stripe_price_monthly ? '✓' : <span className="text-warn">not set</span>}</span>{canEdit && <button className="btn-ghost" onClick={() => open(p)}>Edit</button>}</div>
        </div>))}
    </div>
    {edit && <Modal title={edit.isNew ? 'New plan' : `Edit ${edit.name}`} wide onClose={() => setEdit(null)}><Err e={err} />
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
      <div className="flex items-center justify-end gap-3 mt-2">{bad && <span className="text-xs text-warn mr-auto">{bad}</span>}<button className="btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn" disabled={!!bad || busy} onClick={save}>{busy ? 'Saving…' : edit.isNew ? 'Create plan' : 'Save changes'}</button></div></Modal>}
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
        <div className="flex gap-1 justify-end"><button className="btn" onClick={() => confirm(`Approve suspending ${r.agency_name}? Their workspace becomes read-only immediately.`) && run(() => api(`/platform/approvals/${r.id}/approve`, 'POST', {}))}>Approve</button><button className="btn-ghost" onClick={() => run(() => api(`/platform/approvals/${r.id}/reject`, 'POST', {}))}>Reject</button></div> }]} /></>;
}

const OP_ROLES: [string, string][] = [['readonly', 'Read-only: look at everything'], ['support', 'Support: read-only customer sessions'], ['billing', 'Billing: trials, plans, invoiced access'], ['admin', 'Admin: everything, incl. users and suspensions']];
function Operators() {
  const { me } = useOp(); const [rows, setRows] = useState<any[]>([]); const [dlg, setDlg] = useState<any>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => api('/platform/operators').then(setRows); useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<any>, ok: string) => { setBusy(true); try { await fn(); setDlg(null); setErr(''); setMsg(ok); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  return <>
    <div className="flex flex-wrap items-center justify-between gap-2 mb-4"><p className="text-sm text-muted max-w-2xl">Operators can use this console. An admin operator can add one (the person needs an account first), change a role, or end their operator access. Their account and agency access stay as they are.</p>
      <button className="btn" onClick={() => { setErr(''); setDlg({ kind: 'add', email: '', role: 'support', reason: '' }); }}>Add operator</button></div>
    {msg && <div role="status" className="text-sm text-accent mb-3">{msg}</div>}
    <Table rows={rows} cols={[{ h: 'Operator', render: (r: any) => <>{r.name}{r.email === me.email && <span className="ml-1.5 text-xs text-muted">(you)</span>}<div className="text-xs text-muted">{r.email}</div></> }, { h: 'Role', render: (r: any) => <span className="capitalize">{r.role}</span> }, { h: '2FA', render: (r: any) => (r.totp_enabled ? '✓' : <span className="text-danger">off</span>) },
      { h: '', render: (r: any) => r.email === me.email ? '' : <div className="flex justify-end gap-1"><button className="btn-ghost !py-0.5 !px-2 text-xs" onClick={() => { setErr(''); setDlg({ kind: 'edit', r, role: r.role, reason: '' }); }}>Change role</button><button className="btn-ghost !py-0.5 !px-2 text-xs text-danger" onClick={() => { setErr(''); setDlg({ kind: 'revoke', r, reason: '' }); }}>Revoke</button></div> }]} />
    {dlg && <Modal title={dlg.kind === 'add' ? 'Add operator' : dlg.kind === 'edit' ? `Change role: ${dlg.r.name}` : `Revoke ${dlg.r.name}`} onClose={() => setDlg(null)}><Err e={err} />
      {dlg.kind === 'add' && <Field label="Email of an existing account" hint="They must also turn on 2FA before the console opens for them."><input className="input" type="email" value={dlg.email} onChange={(e) => setDlg({ ...dlg, email: e.target.value })} /></Field>}
      {dlg.kind === 'revoke' ? <p className="text-sm mb-3">{dlg.r.email} will no longer be able to open the platform console. Their account is not deleted.</p>
        : <Field label="Operator role"><div className="space-y-1.5">{OP_ROLES.map(([k, l]) => <label key={k} className="flex items-center gap-2 text-sm"><input type="radio" name="oprole" checked={dlg.role === k} onChange={() => setDlg({ ...dlg, role: k })} />{l}</label>)}</div></Field>}
      <Field label="Reason" hint="Kept in the operator audit log."><input className="input" value={dlg.reason} onChange={(e) => setDlg({ ...dlg, reason: e.target.value })} /></Field>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setDlg(null)}>Cancel</button>
        {dlg.kind === 'add' && <button className="btn" disabled={busy || !dlg.email.includes('@')} onClick={() => run(() => api('/platform/operators', 'POST', { email: dlg.email.trim(), role: dlg.role, reason: dlg.reason }), `${dlg.email} is now an operator.`)}>Add operator</button>}
        {dlg.kind === 'edit' && <button className="btn" disabled={busy || dlg.role === dlg.r.role} onClick={() => run(() => api(`/platform/operators/${dlg.r.id}`, 'PUT', { role: dlg.role, reason: dlg.reason }), `${dlg.r.name} is now ${dlg.role}.`)}>Save role</button>}
        {dlg.kind === 'revoke' && <button className="btn !bg-danger" disabled={busy} onClick={() => run(() => api(`/platform/operators/${dlg.r.id}`, 'DELETE', { reason: dlg.reason }), `${dlg.r.name} is no longer an operator.`)}>Revoke access</button>}</div></Modal>}
  </>;
}

function Audit() { const [rows, setRows] = useState<any[]>([]); useEffect(() => { api('/platform/audit').then(setRows); }, []);
  return <Table rows={rows} empty="No operator actions yet" cols={[{ h: 'When', render: (a: any) => <span className="text-xs num">{day(a.created_at)}</span> }, { h: 'Operator', render: (a: any) => <>{a.admin_email}{a.actor_role && <div className="text-xs text-muted capitalize">{a.actor_role}</div>}</> }, { h: 'Action', render: (a: any) => a.action.replace(/_/g, ' ') }, { h: 'Agency', render: (a: any) => a.agency_name ?? '—' }, { h: 'Detail / reason', render: (a: any) => <>{a.detail}{a.reason && <div className="text-xs text-muted">“{a.reason}”</div>}{(a.before_json || a.after_json) && <details className="text-xs text-muted mt-1"><summary className="cursor-pointer">Before / after</summary><pre className="num whitespace-pre-wrap break-all mt-1">{JSON.stringify({ before: a.before_json, after: a.after_json }, null, 1)}</pre></details>}</> }]} />; }
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
