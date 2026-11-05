import { assertWithinLimit, requireFeature } from '../services/billing.js';
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import * as K from '../services/apikeys.js';
import * as W from '../services/webhooks.js';
import * as X from '../services/exports.js';
import * as I from '../services/imports.js';
import { addDays, today } from '../services/money.js';
import { idParam, parse, T } from './util.js';

/** Integrations hub: credentials and connections are admin-only; accounting exports are open to finance managers too. */
export const hubRouter = Router();
const ADMIN = requireRole('admin'), FIN = requireRole('admin', 'finance_manager');
hubRouter.use(['/health', '/api-keys', '/webhooks', '/webhook-events', '/deliveries'], requireFeature('integrations'));
hubRouter.use(['/mappings', '/exports'], requireFeature('accounting_export'));

/* ---- health overview ---- */
hubRouter.get('/health', ADMIN, async (req, res) => {
  const t = T(req), a = t.agencyId;
  const [keys, hooks, dead, oauth, exp, imp] = await Promise.all([
    t.one(`SELECT COUNT(*) n, MAX(last_used_at) last_used FROM api_keys WHERE agency_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())`, [a]),
    t.query(`SELECT id, name, url, active, disabled_reason, consecutive_failures, last_success_at, last_failure_at, (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.agency_id = e.agency_id AND d.endpoint_id = e.id AND d.status IN ('pending','failed')) backlog,
      (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.agency_id = e.agency_id AND d.endpoint_id = e.id AND d.status = 'dead') dead FROM webhook_endpoints e WHERE e.agency_id = ? ORDER BY e.id`, [a]),
    t.one(`SELECT COUNT(*) n FROM webhook_deliveries WHERE agency_id = ? AND status = 'dead'`, [a]),
    t.query('SELECT provider, tenant_ref, updated_at FROM integrations WHERE agency_id = ?', [a]),
    t.one('SELECT MAX(created_at) at FROM accounting_exports WHERE agency_id = ?', [a]),
    t.one('SELECT MAX(created_at) at FROM import_batches WHERE agency_id = ? AND mode = \'commit\'', [a]),
  ]);
  res.json({ api_keys: keys, webhooks: hooks, dead_deliveries: dead!.n, oauth, last_export: exp!.at, last_import: imp!.at });
});

/* ---- API keys ---- */
hubRouter.get('/api-keys', ADMIN, async (req, res) => { const t = T(req); res.json(await t.query('SELECT id, name, key_prefix, scopes, expires_at, revoked_at, created_at, last_used_at, use_count FROM api_keys WHERE agency_id = ? ORDER BY id DESC', [t.agencyId])); });
hubRouter.post('/api-keys', ADMIN, async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(100), scopes: z.array(z.string()).min(1), days: z.number().int().min(1).max(730).optional() }), req.body);
  res.status(201).json(await K.createKey(T(req), b));
});
hubRouter.post('/api-keys/:id/revoke', ADMIN, async (req, res) => {
  const t = T(req), id = idParam(req), k = await t.get('api_keys', id); if (!k) throw new HttpError(404, 'Key not found');
  if (!k.revoked_at) await t.update('api_keys', id, { revoked_at: new Date().toISOString().slice(0, 19).replace('T', ' '), revoked_by: t.actor.userId });
  res.json({ ok: true });
});

/* ---- webhooks ---- */
const Ev = z.array(z.string()).min(1);
hubRouter.get('/webhook-events', ADMIN, (_req, res) => res.json([...W.EVENT_TYPES]));
hubRouter.get('/webhooks', ADMIN, async (req, res) => { const t = T(req); res.json(await t.query('SELECT id, name, url, events, active, disabled_reason, consecutive_failures, last_success_at, last_failure_at, created_at FROM webhook_endpoints WHERE agency_id = ? ORDER BY id DESC', [t.agencyId])); });
hubRouter.post('/webhooks', ADMIN, async (req, res) => res.status(201).json(await W.createEndpoint(T(req), parse(z.object({ name: z.string().trim().min(2).max(100), url: z.string().url().max(500), events: Ev }), req.body))));
hubRouter.put('/webhooks/:id', ADMIN, async (req, res) => {
  const t = T(req), id = idParam(req); if (!(await t.get('webhook_endpoints', id))) throw new HttpError(404, 'Endpoint not found');
  const b = parse(z.object({ active: z.boolean().optional(), url: z.string().url().max(500).optional(), events: Ev.optional(), name: z.string().trim().min(2).max(100).optional() }), req.body);
  if (b.url) await W.assertSafeUrl(b.url);
  await t.update('webhook_endpoints', id, { ...(b.name ? { name: b.name } : {}), ...(b.url ? { url: b.url } : {}), ...(b.events ? { events: b.events.join(',') } : {}), ...(b.active !== undefined ? { active: b.active ? 1 : 0, ...(b.active ? { disabled_reason: null, consecutive_failures: 0 } : {}) } : {}) });
  res.json({ ok: true });
});
hubRouter.post('/webhooks/:id/rotate-secret', ADMIN, async (req, res) => {
  const t = T(req), id = idParam(req); if (!(await t.get('webhook_endpoints', id))) throw new HttpError(404, 'Endpoint not found');
  const { encrypt } = await import('../crypto.js'), secret = W.newSecret(); await t.update('webhook_endpoints', id, { secret_enc: encrypt(secret) }); res.json({ secret });
});
hubRouter.delete('/webhooks/:id', ADMIN, async (req, res) => {
  const t = T(req), id = idParam(req); if (!(await t.get('webhook_endpoints', id))) throw new HttpError(404, 'Endpoint not found');
  await t.remove('webhook_endpoints', id); res.json({ ok: true });
});
hubRouter.get('/webhooks/:id/deliveries', ADMIN, async (req, res) => {
  const t = T(req); res.json(await t.query(`SELECT d.id, d.status, d.attempts, d.next_attempt_at, d.last_status_code, d.last_error, d.delivered_at, d.created_at, e.type, e.event_id FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_pk AND e.agency_id = d.agency_id
    WHERE d.agency_id = ? AND d.endpoint_id = ? ORDER BY d.id DESC LIMIT 100`, [t.agencyId, idParam(req)]));
});
hubRouter.post('/deliveries/:id/retry', ADMIN, async (req, res) => { await W.retryDelivery(T(req), idParam(req)); res.json({ ok: true }); });
hubRouter.post('/webhooks/:id/test', ADMIN, async (req, res) => {
  const t = T(req), id = idParam(req), ep = await t.get('webhook_endpoints', id); if (!ep) throw new HttpError(404, 'Endpoint not found');
  await t.tx(async (tx) => { const { default: c } = await import('node:crypto'); const pk = await tx.rawInsert('webhook_events', { agency_id: t.agencyId, event_id: c.randomUUID(), type: 'ping', version: 1, payload: JSON.stringify({ message: 'Test event from Travel CRM' }) });
    await tx.rawInsert('webhook_deliveries', { agency_id: t.agencyId, endpoint_id: id, event_pk: pk, status: 'pending', next_attempt_at: new Date().toISOString().slice(0, 19).replace('T', ' ') }); });
  res.json(await W.processDue(20, t.agencyId));
});
hubRouter.post('/webhooks/process', ADMIN, async (req, res) => res.json(await W.processDue(100, T(req).agencyId)));

/* ---- accounting export ---- */
hubRouter.get('/mappings', FIN, async (req, res) => {
  const t = T(req); res.json(await t.query(`SELECT a.id account_id, a.code, a.name, a.type_code, m.external_code, m.external_name FROM accounts a LEFT JOIN account_mappings m ON m.account_id = a.id AND m.agency_id = a.agency_id WHERE a.agency_id = ? ORDER BY a.code`, [t.agencyId]));
});
hubRouter.put('/mappings', ADMIN, async (req, res) => {
  const b = parse(z.object({ mappings: z.array(z.object({ account_id: z.number().int(), external_code: z.string().trim().max(40).nullable(), external_name: z.string().max(150).nullish() })).min(1).max(500) }), req.body), t = T(req);
  await t.tx(async (tx) => { for (const m of b.mappings) await X.setMapping(tx, m.account_id, m.external_code || null, m.external_name); });
  res.json({ ok: true });
});
hubRouter.get('/exports', FIN, async (req, res) => { const t = T(req); res.json(await t.query('SELECT * FROM accounting_exports WHERE agency_id = ? ORDER BY id DESC LIMIT 100', [t.agencyId])); });
hubRouter.get('/exports/:kind', FIN, async (req, res) => {
  const q = parse(z.object({ kind: z.enum(['journals', 'invoices', 'bills', 'payments']), format: z.enum(['generic', 'xero', 'quickbooks']).default('generic'), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => addDays(today(), -30)), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => today()) }), { ...req.query, kind: req.params.kind });
  if (q.format !== 'generic' && q.kind !== 'journals') throw new HttpError(400, `${q.format} format is available for journals only`);
  const r = await X.buildExport(T(req), q.kind, q.format, q.from, q.to);
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', `attachment; filename="${q.kind}-${q.from}-${q.to}.csv"`); res.setHeader('X-File-Checksum', r.checksum); res.send(r.body);
});

/* ---- CSV booking import ---- */
hubRouter.post('/imports/bookings', requireRole('admin', 'finance_manager'), async (req, res) => {
  const b = parse(z.object({ csv: z.string().min(5), filename: z.string().max(200).optional(), commit: z.boolean().default(false), create_clients: z.boolean().default(false), skip_errors: z.boolean().default(false) }), req.body), t = T(req);
  const rows = await I.previewBookings(t, b.csv, b.create_clients), n = (s: string) => rows.filter((r) => r.status === s).length;
  const summary = { total: rows.length, ok: n('ok'), duplicate: n('duplicate'), error: n('error') };
  let created: number[] = [];
  if (b.commit) {
    if (summary.error && !b.skip_errors) throw Object.assign(new HttpError(409, `${summary.error} row(s) have errors — fix them or choose "skip rows with errors"`), { problems: rows.filter((r) => r.status === 'error').map((r) => ({ message: `Line ${r.line}: ${r.message}` })) });
    await assertWithinLimit(t.agencyId, 'bookings', summary.ok);
    created = await I.commitBookings(t, rows);
  }
  await t.insert('import_batches', { adapter: 'csv-bookings', filename: b.filename ?? null, mode: b.commit ? 'commit' : 'preview', total_rows: summary.total, ok_rows: summary.ok, duplicate_rows: summary.duplicate, error_rows: summary.error, created_by: t.actor.userId });
  res.json({ summary, created: created.length, rows: rows.map(({ line, external_ref, status, message }) => ({ line, external_ref, status, message })) });
});
hubRouter.get('/imports', FIN, async (req, res) => { const t = T(req); res.json(await t.query('SELECT * FROM import_batches WHERE agency_id = ? ORDER BY id DESC LIMIT 100', [t.agencyId])); });
