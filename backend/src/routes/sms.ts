import { Router } from 'express';
import { z } from 'zod';
import { ALL_EDITORS, requireRole } from '../auth.js';
import { encrypt } from '../crypto.js';
import { HttpError } from '../errors.js';
import { loadSmsConfig, normalizeNumber, sendSms } from '../services/sms.js';
import { parse, T } from './util.js';

export const smsRouter = Router();
const e164OrSender = z.string().trim().refine((v) => /^\+\d{8,15}$/.test(v) || /^[A-Za-z0-9 ]{1,11}$/.test(v), 'Use a phone number like +14155550100, or a sender name of up to 11 letters or digits');

/** Anyone can ask whether texting is available (to show or hide the button); only an admin sees the settings. */
smsRouter.get('/status', async (req, res) => { res.json({ configured: !!(await loadSmsConfig(T(req))) }); });

smsRouter.get('/settings', requireRole('admin'), async (req, res) => {
  const c = await loadSmsConfig(T(req));
  res.json(c ? { configured: true, provider: 'twilio', account_sid: `${c.sid.slice(0, 4)}…${c.sid.slice(-4)}`, from: c.from, default_cc: c.default_cc, updated_at: c.updated_at } : { configured: false });
});
smsRouter.put('/settings', requireRole('admin'), async (req, res) => {
  const b = parse(z.object({ account_sid: z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, 'The Account SID starts with AC followed by 32 characters'), auth_token: z.string().trim().min(16).max(100).optional(), from: e164OrSender,
    default_cc: z.string().trim().regex(/^\+\d{1,4}$/, 'Country code like +92').nullish().transform((v) => v || null) }), req.body), t = T(req);
  const cur = await loadSmsConfig(t); const token = b.auth_token ?? cur?.token;
  if (!token) throw new HttpError(400, 'Enter the Auth Token from your Twilio account');
  const config_enc = encrypt(JSON.stringify({ sid: b.account_sid, token, from: b.from }));
  await t.tx(async (tx) => {
    const row = await tx.one('SELECT id FROM sms_settings WHERE agency_id = ?', [tx.agencyId]);
    if (row) await tx.update('sms_settings', row.id, { config_enc, default_cc: b.default_cc, updated_by: req.ctx!.userId }); else await tx.insert('sms_settings', { config_enc, default_cc: b.default_cc, provider: 'twilio', updated_by: req.ctx!.userId });
    await tx.event('update', 'sms_settings', null, { configured: !!cur }, { configured: true, from: b.from, account_sid: `${b.account_sid.slice(0, 4)}…` });
  });
  res.json({ ok: true });
});
smsRouter.delete('/settings', requireRole('admin'), async (req, res) => {
  const t = T(req); await t.query('DELETE FROM sms_settings WHERE agency_id = ?', [t.agencyId]); await t.event('delete', 'sms_settings', null, { configured: true }, { configured: false }); res.json({ ok: true });
});

smsRouter.post('/test', requireRole('admin'), async (req, res) => {
  const b = parse(z.object({ to: z.string().trim().min(5).max(30) }), req.body), t = T(req); const ag = await t.agency();
  res.json(await sendSms(t, b.to, `Test message from ${ag.name}. Text messages are working.`, { entity_type: 'test' }));
});

smsRouter.post('/send', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(z.object({ client_id: z.number().int().nullish(), to: z.string().trim().max(30).optional(), body: z.string().trim().min(1).max(480),
    entity_type: z.enum(['booking', 'invoice', 'quote', 'visa', 'umrah', 'client']).nullish(), entity_id: z.number().int().nullish() }), req.body), t = T(req);
  let to = b.to;
  if (!to && b.client_id) { const c = await t.get('clients', b.client_id); if (!c) throw new HttpError(404, 'Client not found'); if (!c.phone) throw new HttpError(409, `${c.name} has no phone number on file. Add one on the Clients page.`); to = c.phone; }
  if (!to) throw new HttpError(400, 'Choose who to text');
  if (b.client_id) await t.ref('clients', b.client_id, 'client');
  res.json(await sendSms(t, to, b.body, { client_id: b.client_id ?? null, entity_type: b.entity_type ?? null, entity_id: b.entity_id ?? null }));
});

smsRouter.get('/log', requireRole('admin', 'finance_manager'), async (req, res) => {
  const t = T(req);
  res.json(await t.query(`SELECT l.*, c.name client_name, u.name user_name FROM sms_log l LEFT JOIN clients c ON c.id = l.client_id AND c.agency_id = l.agency_id LEFT JOIN users u ON u.id = l.user_id WHERE l.agency_id = ? ORDER BY l.id DESC LIMIT 200`, [t.agencyId]));
});
export { normalizeNumber };
