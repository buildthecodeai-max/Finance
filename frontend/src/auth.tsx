import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { api, ownSession, refresh, setReenter, setSession } from './api';

export interface AgencyRef { id: number; name: string; base_currency: string; tax_label: string; role: 'admin' | 'finance_manager' | 'agent' | 'viewer' }
interface Ctx {
  user: any; agencies: AgencyRef[]; agency: AgencyRef | null; ready: boolean; support: boolean;
  supportLogin(token: string, agency: { id: number; name: string; base_currency: string; tax_label?: string }): void;
  workspaceLogin(accessToken: string, user: any, agency: { id: number; name: string; base_currency: string; tax_label?: string }): void;
  login(email: string, password: string, totp?: string): Promise<void>; logout(): Promise<void>; switchAgency(id: number): void;
  can(...roles: AgencyRef['role'][]): boolean;
  /** Super admin (platform operator): may open any agency's workspace from the sidebar. */
  operator: boolean; inAgency: boolean;
  listAgencies(q: string): Promise<{ id: number; name: string; status?: string; plan_name?: string }[]>;
  enterAgency(id: number): Promise<void>; leaveAgency(): Promise<void>;
}
const C = createContext<Ctx>(null as any);
export const useAuth = () => useContext(C);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<{ user: any; agencies: AgencyRef[] } | null>(null);
  const [aid, setAid] = useState<number | null>(null);
  const [ready, setReady] = useState(false); const [support, setSupport] = useState(false);
  const [inAgency, setInAgency] = useState(false); const current = useRef<number | null>(null);   // a super admin working inside someone else's agency

  const apply = (r: any) => {
    const pick = r.agencies.find((a: AgencyRef) => a.id === Number(localStorage.getItem('agency'))) ?? r.agencies[0];
    setSession(r.accessToken, pick?.id ?? null); setAid(pick?.id ?? null); setS({ user: r.user, agencies: r.agencies });
  };
  useEffect(() => { refresh().then((r) => r && apply(r)).finally(() => setReady(true)); }, []);

  const agency = s?.agencies.find((a) => a.id === aid) ?? null;
  // The operator's own token lives only in the refresh cookie, so every call below fetches it fresh and never disturbs the session in use.
  const asOperator = async () => {
    const o = await ownSession(); if (!o) throw new Error('Your session has expired. Please sign in again.');
    return { Authorization: `Bearer ${o.accessToken}`, 'X-Agency-Id': String(o.agencies?.[0]?.id ?? 0) };
  };
  const mint = (id: number, headers?: Record<string, string>) => api(`/platform/agencies/${id}/access-workspace`, 'POST', {}, headers);
  useEffect(() => {
    // when the 15-minute token lapses the refresh hands back the operator's own token; this returns them to the agency they were in
    setReenter(inAgency ? async () => { if (current.current) setSession((await mint(current.current)).accessToken); } : null);
    return () => setReenter(null);
  }, [inAgency]);
  const value: Ctx = {
    user: s?.user, agencies: s?.agencies ?? [], agency, ready, support,
    /** Operator support session: a read-only token for one agency. Held in memory only; a reload ends it. */
    supportLogin(token, a) { setSession(token, a.id); setAid(a.id); setSupport(true); setS({ user: { id: 0, name: 'Support (read-only)', email: '' }, agencies: [{ id: a.id, name: a.name, base_currency: a.base_currency, tax_label: a.tax_label ?? 'Tax', role: 'viewer' }] }); },
    /** Platform admin full workspace access: signs in as the agency's admin. Held in memory only; a reload ends it. */
    workspaceLogin(accessToken, user, a) { setSession(accessToken, a.id); setAid(a.id); setSupport(false); setS({ user, agencies: [{ id: a.id, name: a.name, base_currency: a.base_currency, tax_label: a.tax_label ?? 'Tax', role: 'admin' }] }); },
    async login(email, password, totp) { apply(await api('/auth/login', 'POST', { email, password, totp })); },
    async logout() { await api('/auth/logout', 'POST'); setSession(null, null); setS(null); setSupport(false); },
    switchAgency(id) { localStorage.setItem('agency', String(id)); setSession(null, id); setAid(id); location.reload(); },
    can: (...roles) => !!agency && roles.includes(agency.role),
    operator: inAgency || !!s?.user?.is_platform_admin, inAgency,
    async listAgencies(q) { const r = await api(`/platform/agencies${q ? `?q=${encodeURIComponent(q)}` : ''}`, 'GET', undefined, await asOperator()); return r.rows; },
    /** Signs in as that agency's admin through the audited workspace-access endpoint; the super admin keeps their own login to switch again. */
    async enterAgency(id) {
      const w = await mint(id, await asOperator());
      current.current = w.agency.id; setSession(w.accessToken, w.agency.id); setAid(w.agency.id); setSupport(false); setInAgency(true);
      setS({ user: w.user, agencies: [{ id: w.agency.id, name: w.agency.name, base_currency: w.agency.base_currency, tax_label: w.agency.tax_label ?? 'Tax', role: 'admin' }] });
    },
    async leaveAgency() { const o = await ownSession(); current.current = null; setInAgency(false); setSupport(false); if (o) apply(o); else { setSession(null, null); setS(null); } },
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}
