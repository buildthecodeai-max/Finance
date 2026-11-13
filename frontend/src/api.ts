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

/** The signed-in agency's base currency: amounts shown without an explicit currency (ledger, accounts, statements…) are in this, not a hard-coded USD. */
let baseCurrency = 'USD';
export const setBaseCurrency = (c?: string | null) => { if (c && /^[A-Z]{3}$/.test(c)) baseCurrency = c; };
export const money = (n: number, cur: string = baseCurrency) => new Intl.NumberFormat('en', { style: 'currency', currency: cur }).format(n ?? 0);
/** A plain amount with thousands separators and two decimals; "—" when there is nothing to show. */
export const n2 = (v: any) => (v === '' || v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** Sends one file as the raw request body (with progress). The name travels in a header, so any file type and size up to the server limit works. */
export async function upload<T = any>(path: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  const send = () => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open('POST', `/api${path}`); x.withCredentials = true;
    if (token) x.setRequestHeader('Authorization', `Bearer ${token}`);
    if (agencyId) x.setRequestHeader('X-Agency-Id', String(agencyId));
    x.setRequestHeader('Content-Type', 'application/octet-stream'); x.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => { let body: any = x.responseText; try { body = JSON.parse(x.responseText); } catch { /* not JSON */ } resolve({ status: x.status, body }); };
    x.onerror = () => reject(new Error('Upload failed — check your connection'));
    x.send(file);
  });
  let r = await send();
  if (r.status === 401 && (await refresh())) r = await send();
  if (r.status >= 400) throw Object.assign(new Error(r.body?.error ?? 'Upload failed'), { status: r.status, data: r.body });
  return r.body as T;
}

/** Downloads an authenticated file (CSV etc.) through the browser's save flow. */
export async function download(path: string, filename: string) {
  let r = await raw(path);
  if (r.status === 401 && (await refresh())) r = await raw(path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Download failed');
  const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
