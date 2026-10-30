import { app } from './app.js';
import { assertProductionConfig, config } from './config.js';
import { processDue } from './services/webhooks.js';
import { heartbeat } from './services/observability.js';

if (config.isProd) { const bad = assertProductionConfig(); if (bad.length) { console.error('Refusing to start:\n - ' + bad.join('\n - ')); process.exit(1); } }
app.listen(config.port, () => console.log(`TravelFinance API on :${config.port}`));

// Webhook delivery loop (claims are atomic, so running several API processes is safe).
setInterval(() => { processDue(50).then(() => heartbeat('webhook_loop')).catch((e) => console.error('[webhooks]', e)); }, 30_000).unref();
