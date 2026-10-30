import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { pool, Tenant } from '../db.js';
import { runDaily } from './reminders.js';
import { refreshRates } from '../services/fx.js';

if (!config.redisUrl) throw new Error('REDIS_URL required for worker (or use `npm run cron:daily` from cPanel cron)');
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue('daily', { connection });

await queue.add('reminders', {}, { repeat: { pattern: '0 8 * * *' }, jobId: 'reminders' });
await queue.add('fx', {}, { repeat: { pattern: '0 6 * * *' }, jobId: 'fx' });

new Worker('daily', async (job) => {
  if (job.name === 'reminders') return runDaily();
  if (job.name === 'fx' && config.oxrAppId) {
    const [ags]: any = await pool.query('SELECT id, base_currency FROM agencies');
    for (const a of ags) await refreshRates(new Tenant(a.id, { userId: null, ip: 'job' }), a.base_currency);
  }
}, { connection });
console.log('BullMQ worker running');
