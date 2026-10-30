import crypto from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { pool } from './db.js';
import { authenticate, HttpError } from './auth.js';
import { authRouter } from './routes/auth.js';
import { invoicesRouter } from './routes/invoices.js';
import { clientsRouter, suppliersRouter, teamRouter } from './routes/parties.js';
import { bookingsRouter, travellersRouter } from './routes/bookings.js';
import { leadsRouter, crmRouter, opsRouter } from './routes/crm.js';
import { quotesRouter, publicQuotesRouter } from './routes/quotes.js';
import { paymentsRouter } from './routes/payments.js';
import { commissionsRouter } from './routes/commissions.js';
import { reportsRouter } from './routes/reports.js';
import { dashboardRouter } from './routes/dashboard.js';
import { bankRouter } from './routes/bank.js';
import { integrationsRouter, integrationsCallbackRouter } from './routes/integrations.js';
import { useLocal, verifyLocal, LOCAL_DIR } from './storage.js';
import path from 'node:path';
import { accountingRouter } from './routes/accounting.js';
import { airlinesRouter } from './routes/airlines.js';
import { vouchersRouter, chequeRouter } from './routes/vouchers.js';
import { ticketsRouter } from './routes/tickets.js';
import { financeRouter } from './routes/finance.js';
import { v1Router } from './routes/v1.js';
import { hubRouter } from './routes/hub.js';
import compression from 'compression';
import { counters as _c, health, logError, metricsText, requestContext } from './services/observability.js';
import { platformRouter } from './routes/platform.js';
import { billingRouter } from './routes/billing.js';
import { subscriptionGuard } from './services/billing.js';
import { automationRouter } from './routes/automation.js';
import { portalAdminRouter, publicPortalRouter } from './routes/portal.js';
import { adminRouter } from './routes/admin.js';
import { webhooksRouter } from './routes/webhooks.js';

export const app = express();
app.set('trust proxy', 1); // behind cPanel/Apache/Passenger proxy
app.use(requestContext);
app.use(helmet());
app.use(compression());
app.use(cors({ origin: config.corsOrigin, credentials: true }));

// Request log: IP, user, endpoint, response code (registered first so it covers everything below)
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    pool.query('INSERT INTO api_log (agency_id, user_id, ip, method, endpoint, status_code, ms) VALUES (?,?,?,?,?,?,?)',
      [req.ctx?.agencyId ?? null, req.ctx?.userId ?? null, req.ip, req.method, req.originalUrl.split('?')[0].slice(0, 300), res.statusCode, Date.now() - start])
      .catch((e) => console.error('api_log failed', e.message));
  });
  next();
});

app.use('/api/webhooks', webhooksRouter);     // raw body, before json parser
app.use(express.json({ limit: '6mb' }));
app.use(cookieParser());
app.get('/api/health', (_q, r) => void r.json({ ok: true }));   // liveness: the process is up
app.get('/api/ready', async (_q, r) => { const h = await health(); r.status(h.ok ? 200 : 503).json(h); });   // readiness: database reachable, migrations, job heartbeats
app.get('/api/metrics', async (req, res) => {   // Prometheus text; off unless METRICS_TOKEN is set
  const tok = config.metricsToken;
  const given = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!tok || given.length !== tok.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(tok))) throw new HttpError(404, 'Not found');
  res.type('text/plain').send(await metricsText());
});
if (useLocal && !config.isProd)
  app.get('/api/dev-files', (req, res) => {
    const { key, exp, sig, name } = req.query as Record<string, string>;
    if (!key || !verifyLocal(key, Number(exp), String(sig))) throw new HttpError(403, 'Link expired or invalid');
    res.download(key, name || path.basename(key), { root: LOCAL_DIR });
  });
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: process.env.NODE_ENV === 'test' ? 5000 : 50 }), authRouter);
app.use('/api/integrations', integrationsCallbackRouter);
app.use('/api/public/portal', publicPortalRouter);
app.use('/api/v1', v1Router);
app.use('/api/platform', platformRouter);
app.use('/api/public/quotes', publicQuotesRouter); // token-authenticated, rate-limited, no session // OAuth redirect target (state-signed)

const api = express.Router();
api.use(authenticate);
api.use(subscriptionGuard);
api.use('/billing', billingRouter);
api.use('/dashboard', dashboardRouter);
api.use('/invoices', invoicesRouter);
api.use('/clients', clientsRouter);
api.use('/suppliers', suppliersRouter);
api.use('/bookings', bookingsRouter);
api.use('/team', teamRouter);
api.use('/payments', paymentsRouter);
api.use('/commissions', commissionsRouter);
api.use('/reports', reportsRouter);
api.use('/bank', bankRouter);
api.use('/integrations', integrationsRouter);
api.use('/accounting', accountingRouter);
api.use('/airlines', airlinesRouter);
api.use('/vouchers', vouchersRouter);
api.use('/cheque-formats', chequeRouter);
api.use('/tickets', ticketsRouter);
api.use('/admin', adminRouter);
api.use('/finance', financeRouter);
api.use('/portal-admin', portalAdminRouter);
api.use('/automation', automationRouter);
api.use('/hub', hubRouter);
api.use('/travellers', travellersRouter);
api.use('/leads', leadsRouter);
api.use('/crm', crmRouter);
api.use('/ops', opsRouter);
api.use('/quotes', quotesRouter);
app.use('/api', api);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, request_id: _req.id, ...Object.fromEntries(['code', 'limit_kind', 'limit', 'used', 'feature', 'sub_status', 'over'].filter((k) => (err as any)[k] !== undefined).map((k) => [k, (err as any)[k]])), ...((err as any).problems ? { problems: (err as any).problems } : {}) });
  if (err?.type === 'entity.too.large') return void res.status(413).json({ error: 'Request body too large', request_id: _req.id });
  if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Malformed JSON', request_id: _req.id });
  if (err?.code === 'ER_DUP_ENTRY') return void res.status(409).json({ error: 'Duplicate record' });
  logError(_req.id, err);
  res.status(500).json({ error: 'Internal error', request_id: _req.id });
});
