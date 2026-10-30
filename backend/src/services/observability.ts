import crypto from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { pool } from '../db.js';

/* ------------------------------------------------------------------ request ids + structured logs */
declare module 'express-serve-static-core' { interface Request { id?: string } }
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

export const counters = { total: 0, byClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } as Record<string, number>, ms: { le50: 0, le200: 0, le1000: 0, le5000: 0, inf: 0 }, sumMs: 0, startedAt: Date.now() };

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const inbound = String(req.headers['x-request-id'] ?? '');
  req.id = SAFE_ID.test(inbound) ? inbound : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6, cls = `${Math.floor(res.statusCode / 100)}xx`;
    counters.total++; counters.byClass[cls] = (counters.byClass[cls] ?? 0) + 1; counters.sumMs += ms;
    counters.ms[ms <= 50 ? 'le50' : ms <= 200 ? 'le200' : ms <= 1000 ? 'le1000' : ms <= 5000 ? 'le5000' : 'inf']++;
    if (process.env.LOG_REQUESTS === 'false' || (process.env.NODE_ENV === 'test' && process.env.LOG_REQUESTS !== 'true')) return;
    // One JSON line per request. Never the body, query string, headers or tokens — ids and timings only.
    console.log(JSON.stringify({ t: new Date().toISOString(), lvl: res.statusCode >= 500 ? 'error' : 'info', rid: req.id, m: req.method, p: req.originalUrl.split('?')[0].slice(0, 200), s: res.statusCode, ms: Math.round(ms), agency: req.ctx?.agencyId ?? null, user: req.ctx?.userId ?? null }));
  });
  next();
}

export const logError = (rid: string | undefined, err: any) => console.error(JSON.stringify({ t: new Date().toISOString(), lvl: 'error', rid, err: String(err?.message ?? err).slice(0, 500), stack: String(err?.stack ?? '').split('\n').slice(0, 6).join(' | ') }));

/* ------------------------------------------------------------------ heartbeats and health */
export async function heartbeat(name: string, detail = 'ok') {
  await pool.query('INSERT INTO system_state (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = CURRENT_TIMESTAMP', [`hb:${name}`, detail]).catch(() => {});
}
const STALE_HOURS: Record<string, number> = { daily_job: 36, webhook_loop: 0.1 };
export async function health() {
  const checks: Record<string, any> = {};
  try { await pool.query('SELECT 1'); checks.database = 'ok'; } catch (e: any) { checks.database = `down: ${e.code ?? e.message}`; }
  if (checks.database === 'ok') {
    const [[m]]: any = await pool.query('SELECT COUNT(*) n, MAX(name) latest FROM schema_migrations').catch(() => [[{ n: 0, latest: null }]]);
    checks.migrations = { applied: m.n, latest: m.latest };
    const [hb]: any = await pool.query("SELECT k, v, TIMESTAMPDIFF(MINUTE, updated_at, CURRENT_TIMESTAMP) age_min FROM system_state WHERE k LIKE 'hb:%'");
    checks.jobs = Object.fromEntries(hb.map((h: any) => { const n = h.k.slice(3), limit = (STALE_HOURS[n] ?? 36) * 60; return [n, { age_minutes: h.age_min, status: h.age_min > limit ? 'stale' : 'ok' }]; }));
  }
  return { ok: checks.database === 'ok', checks };
}

export async function metricsText() {
  const [[w]]: any = await pool.query("SELECT SUM(status IN ('pending','failed')) backlog, SUM(status = 'dead') dead FROM webhook_deliveries");
  const [[e]]: any = await pool.query("SELECT COUNT(*) n FROM exceptions WHERE status = 'open' AND severity = 'critical'");
  const c = counters, L: string[] = [];
  const g = (name: string, help: string, v: number, labels = '') => L.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${v}`);
  g('tf_uptime_seconds', 'Process uptime', Math.round((Date.now() - c.startedAt) / 1000));
  L.push('# HELP tf_http_requests_total HTTP responses by class', '# TYPE tf_http_requests_total counter', ...Object.entries(c.byClass).map(([k, v]) => `tf_http_requests_total{class="${k}"} ${v}`));
  L.push('# HELP tf_http_request_duration_ms_bucket Cumulative request duration', '# TYPE tf_http_request_duration_ms_bucket counter');
  let cum = 0; for (const [le, k] of [['50', 'le50'], ['200', 'le200'], ['1000', 'le1000'], ['5000', 'le5000'], ['+Inf', 'inf']] as const) { cum += c.ms[k]; L.push(`tf_http_request_duration_ms_bucket{le="${le}"} ${cum}`); }
  g('tf_http_request_duration_ms_sum', 'Total request ms', Math.round(c.sumMs)); g('tf_webhook_backlog', 'Webhook deliveries waiting', Number(w.backlog ?? 0)); g('tf_webhook_dead', 'Dead-lettered webhook deliveries', Number(w.dead ?? 0));
  g('tf_open_critical_exceptions', 'Open critical exceptions', e.n);
  const mem = process.memoryUsage(); g('tf_memory_rss_bytes', 'Resident memory', mem.rss);
  return L.join('\n') + '\n';
}

/** Delete data past its useful life. Financial records, audit log and security events are never touched here. */
export async function purgeOld() {
  const q = async (sql: string) => ((await pool.query(sql)) as any)[0].affectedRows as number;
  return {
    api_log: await q('DELETE FROM api_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY) LIMIT 50000'),
    login_attempts: await q('DELETE FROM login_attempts WHERE created_at < DATE_SUB(NOW(), INTERVAL 2 DAY)'),
    password_resets: await q('DELETE FROM password_resets WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)'),
    refresh_tokens: await q('DELETE FROM refresh_tokens WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)'),
    api_idempotency: await q('DELETE FROM api_idempotency WHERE created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)'),
    webhook_deliveries: await q("DELETE FROM webhook_deliveries WHERE status = 'success' AND delivered_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)"),
    webhook_events: await q('DELETE FROM webhook_events WHERE created_at < DATE_SUB(NOW(), INTERVAL 60 DAY) AND id NOT IN (SELECT event_pk FROM webhook_deliveries)'),
    delivery_log: await q('DELETE FROM delivery_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 365 DAY)'),
  };
}
