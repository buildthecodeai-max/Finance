// cPanel cron fallback (no Redis):  0 8 * * *  cd ~/app && node dist/jobs/daily.js
import { runDaily } from './reminders.js';
import { pool, Tenant } from '../db.js';
import { config } from '../config.js';
import { refreshRates } from '../services/fx.js';

console.log(await runDaily());
if (config.oxrAppId) {
  const [ags]: any = await pool.query('SELECT id, base_currency FROM agencies');
  for (const a of ags) await refreshRates(new Tenant(a.id, { userId: null, ip: 'cron' }), a.base_currency);
}
await pool.end();
