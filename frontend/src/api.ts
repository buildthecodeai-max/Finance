// Access token lives in memory only; the refresh token is an HttpOnly cookie the JS can't read.
let token: string | null = null;
let agencyId: number | null = null;
export const setSession = (t: string | null, a?: number | null) => { token = t; if (a !== undefined) agencyId = a; };

/** Called after a token refresh while a super admin is working inside another agency, to mint that workspace's token again. */
let reenter: (() => Promise<void>) | null = null;
export const setReenter = (f: (() => Promise<void>) | null) => { reenter = f; };

async function raw(path: string, init: RequestInit = {}) {
  return fetch(`/api${path}`, {
    ...init, credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(agencyId ? { 'X-Agency-Id': String(agencyId) } : {}), ...init.headers },
  });
}

/** The real signed-in user's own session (from the refresh cookie), fetched WITHOUT replacing the token currently in use. */
export async function ownSession(): Promise<any | null> {
  const r = await raw('/auth/refresh', { method: 'POST' });
  return r.ok ? r.json() : null;
}

// Concurrent callers (StrictMode's double effect, several 401s at once) share one refresh: the token rotates on use,
// so a second simultaneous call would be rejected and bounce the user to the login page.
let inflight: Promise<any | null> | null = null;
export function refresh(): Promise<any | null> {
  inflight ??= (async () => {
    const r = await raw('/auth/refresh', { method: 'POST' });
    if (!r.ok) return null;
    const s = await r.json(); token = s.accessToken; return s;
  })().finally(() => { inflight = null; });
  return inflight;
}

export async function api<T = any>(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>): Promise<T> {
  let r = await raw(path, { method, body: body ? JSON.stringify(body) : undefined, headers });
  if (r.status === 401 && !path.startsWith('/auth') && (await refresh())) {
    if (reenter && !path.startsWith('/platform')) await reenter();   // the refresh gave back the operator's own token; step back into the agency
    r = await raw(path, { method, body: body ? JSON.stringify(body) : undefined, headers });
  }
  const ct = r.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok && r.status === 403 && data?.code === 'two_factor_required') window.dispatchEvent(new Event('tf:2fa-required'));
  if (!r.ok) throw Object.assign(new Error(data?.error ?? 'Request failed'), { status: r.status, data });
  return data as T;
}

export const money = (n: number, cur = 'USD') => new Intl.NumberFormat('en', { style: 'currency', currency: cur }).format(n ?? 0);
/** A plain amount with thousands separators and two decimals; "—" when there is nothing to show. */
export const n2 = (v: any) => (v === '' || v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
