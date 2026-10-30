import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, refresh, setSession } from './api';

export interface AgencyRef { id: number; name: string; base_currency: string; tax_label: string; role: 'admin' | 'finance_manager' | 'agent' | 'viewer' }
interface Ctx {
  user: any; agencies: AgencyRef[]; agency: AgencyRef | null; ready: boolean; support: boolean;
  supportLogin(token: string, agency: { id: number; name: string; base_currency: string; tax_label?: string }): void;
  login(email: string, password: string, totp?: string): Promise<void>; logout(): Promise<void>; switchAgency(id: number): void;
  can(...roles: AgencyRef['role'][]): boolean;
}
const C = createContext<Ctx>(null as any);
export const useAuth = () => useContext(C);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<{ user: any; agencies: AgencyRef[] } | null>(null);
  const [aid, setAid] = useState<number | null>(null);
  const [ready, setReady] = useState(false); const [support, setSupport] = useState(false);

  const apply = (r: any) => {
    const pick = r.agencies.find((a: AgencyRef) => a.id === Number(localStorage.getItem('agency'))) ?? r.agencies[0];
    setSession(r.accessToken, pick?.id ?? null); setAid(pick?.id ?? null); setS({ user: r.user, agencies: r.agencies });
  };
  useEffect(() => { refresh().then((r) => r && apply(r)).finally(() => setReady(true)); }, []);

  const agency = s?.agencies.find((a) => a.id === aid) ?? null;
  const value: Ctx = {
    user: s?.user, agencies: s?.agencies ?? [], agency, ready, support,
    /** Operator support session: a read-only token for one agency. Held in memory only; a reload ends it. */
    supportLogin(token, a) { setSession(token, a.id); setAid(a.id); setSupport(true); setS({ user: { id: 0, name: 'Support (read-only)', email: '' }, agencies: [{ id: a.id, name: a.name, base_currency: a.base_currency, tax_label: a.tax_label ?? 'Tax', role: 'viewer' }] }); },
    async login(email, password, totp) { apply(await api('/auth/login', 'POST', { email, password, totp })); },
    async logout() { await api('/auth/logout', 'POST'); setSession(null, null); setS(null); setSupport(false); },
    switchAgency(id) { localStorage.setItem('agency', String(id)); setSession(null, id); setAid(id); location.reload(); },
    can: (...roles) => !!agency && roles.includes(agency.role),
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}
