/**
 * Platform-operator tool for customers billed outside Stripe (bank transfer, annual contract):
 *   npm run billing:grant -- <agencyId> <plan> <monthly|yearly> <until YYYY-MM-DD>
 * Activates the plan until that date; afterwards the normal grace → read-only lifecycle applies.
 */
import 'dotenv/config';
import { pool } from '../db.js';
import { grantManual } from '../services/billing.js';

const [id, plan, interval, until] = process.argv.slice(2);
if (!id || !plan || !['monthly', 'yearly'].includes(interval) || !/^\d{4}-\d{2}-\d{2}$/.test(until ?? '')) { console.error('usage: billing:grant <agencyId> <plan> <monthly|yearly> <YYYY-MM-DD>'); process.exit(1); }
await grantManual(Number(id), plan, interval as 'monthly' | 'yearly', new Date(`${until}T23:59:59Z`));
console.log(`agency ${id}: ${plan} (${interval}) active until ${until}`);
await pool.end();
