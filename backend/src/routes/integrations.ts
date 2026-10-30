import { Router } from 'express';
import crypto from 'node:crypto';
import { HttpError, requireRole } from '../auth.js';
import { config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import { Tenant } from '../db.js';
import { T } from './util.js';

/**
 * Xero / QuickBooks OAuth 2.0 (authorization-code flow). Implemented: connect, callback, encrypted token
 * storage, refresh. NOT yet implemented: the actual two-way entity sync (invoices/contacts/payments mapping).
 */
export const integrationsRouter = Router();
export const integrationsCallbackRouter = Router(); // unauthenticated: provider redirects the browser here

const P = {
  xero: { auth: 'https://login.xero.com/identity/connect/authorize', token: 'https://identity.xero.com/connect/token', scope: 'offline_access accounting.transactions accounting.contacts', ...config.xero },
  quickbooks: { auth: 'https://appcenter.intuit.com/connect/oauth2', token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', scope: 'com.intuit.quickbooks.accounting', ...config.qbo },
} as const;
type Provider = keyof typeof P;
const redirectUri = (p: string) => `${config.appUrl}/api/integrations/${p}/callback`;

// state = agencyId.nonce.hmac  (binds the callback to the agency without a session)
const sign = (agencyId: number) => {
  const n = crypto.randomBytes(8).toString('hex');
  return `${agencyId}.${n}.${crypto.createHmac('sha256', config.jwtSecret).update(`${agencyId}.${n}`).digest('hex')}`;
};
const verify = (state: string) => {
  const [a, n, h] = state.split('.');
  const ok = h && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(crypto.createHmac('sha256', config.jwtSecret).update(`${a}.${n}`).digest('hex')));
  if (!ok) throw new HttpError(400, 'Bad state');
  return Number(a);
};

integrationsRouter.get('/', async (req, res) => {
  const t = T(req);
  res.json(await t.query('SELECT provider, tenant_ref, updated_at FROM integrations WHERE agency_id = ?', [t.agencyId]));
});

integrationsRouter.delete('/:provider', requireRole('admin'), async (req, res) => {
  const t = T(req), row = await t.one('SELECT id FROM integrations WHERE agency_id = ? AND provider = ?', [t.agencyId, String(req.params.provider)]);
  if (!row) throw new HttpError(404, 'Not connected');
  await t.remove('integrations', row.id); res.json({ ok: true });   // tokens are deleted; the provider-side grant should also be revoked in their console
});

integrationsRouter.get('/:provider/connect', requireRole('admin'), (req, res) => {
  const p = P[req.params.provider as Provider];
  if (!p?.id) throw new HttpError(501, 'Provider not configured');
  const q = new URLSearchParams({ response_type: 'code', client_id: p.id, redirect_uri: redirectUri(req.params.provider as string), scope: p.scope, state: sign(req.ctx!.agencyId) });
  res.json({ url: `${p.auth}?${q}` });
});

integrationsCallbackRouter.get('/:provider/callback', async (req, res) => {
  const provider = req.params.provider as Provider, p = P[provider];
  if (!p) throw new HttpError(404, 'Unknown provider');
  const agencyId = verify(String(req.query.state));
  const r = await fetch(p.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${p.id}:${p.secret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri(provider) }),
  });
  if (!r.ok) throw new HttpError(502, `Token exchange failed (${r.status})`);
  const tokens = { ...(await r.json() as object), obtained_at: Date.now() };
  const t = new Tenant(agencyId, { userId: null });
  const ex = await t.one('SELECT id FROM integrations WHERE agency_id = ? AND provider = ?', [agencyId, provider]);
  const data = { provider, tenant_ref: String(req.query.realmId ?? ''), tokens_enc: encrypt(JSON.stringify(tokens)) };
  if (ex) await t.update('integrations', ex.id, data); else await t.insert('integrations', data);
  res.redirect(`${config.appUrl}/settings?connected=${provider}`);
});

export async function getAccessToken(t: Tenant, provider: Provider): Promise<string> {
  const row = await t.one('SELECT * FROM integrations WHERE agency_id = ? AND provider = ?', [t.agencyId, provider]);
  if (!row) throw new Error(`${provider} not connected`);
  let tok = JSON.parse(decrypt(row.tokens_enc));
  if (Date.now() > tok.obtained_at + (tok.expires_in - 60) * 1000) {
    const p = P[provider];
    const r = await fetch(p.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${p.id}:${p.secret}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }),
    });
    if (!r.ok) throw new Error(`refresh failed ${r.status}`);
    tok = { ...(await r.json() as object), obtained_at: Date.now() };
    await t.update('integrations', row.id, { tokens_enc: encrypt(JSON.stringify(tok)) });
  }
  return tok.access_token;
}
