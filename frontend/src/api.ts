// Access token lives in memory only; the refresh token is an HttpOnly cookie the JS can't read.
let token: string | null = null;
let agencyId: number | null = null;
export const setSession = (t: string | null, a?: number | null) => { token = t; if (a !== undefined) agencyId = a; };

async function raw(path: string, init: RequestInit = {}) {
  return fetch(`/api${path}`, {
    ...init, credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(agencyId ? { 'X-Agency-Id': String(agencyId) } : {}), ...init.headers },
  });
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
  if (r.status === 401 && !path.startsWith('/auth') && (await refresh())) r = await raw(path, { method, body: body ? JSON.stringify(body) : undefined, headers });
  const ct = r.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw Object.assign(new Error(data?.error ?? 'Request failed'), { status: r.status, data });
  return data as T;
}

export const money = (n: number, cur = 'USD') => new Intl.NumberFormat('en', { style: 'currency', currency: cur }).format(n ?? 0);
