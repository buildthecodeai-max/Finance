import { config } from '../config.js';
import { Tenant } from '../db.js';
import { HttpError } from '../errors.js';
import { today } from './money.js';

export interface RateInfo { rate: number; source: string; date: string }

/** Pulls latest rates from Open Exchange Rates (free plan base = USD) and stores them per agency. */
export async function refreshRates(t: Tenant, base: string) {
  if (!config.oxrAppId) throw new Error('OXR_APP_ID not set');
  const r = await fetch(`https://openexchangerates.org/api/latest.json?app_id=${config.oxrAppId}`);
  if (!r.ok) throw new Error(`OXR ${r.status}`);
  const { rates } = (await r.json()) as { rates: Record<string, number> };
  const d = today();
  for (const [q, v] of Object.entries(rates)) {
    // a manual rate entered for today wins over the provider's
    await t.query(
      `INSERT INTO exchange_rates (agency_id, rate_date, base, quote, rate, source) VALUES (?,?,?,?,?, 'openexchangerates')
       ON DUPLICATE KEY UPDATE rate = IF(source = 'manual', rate, VALUES(rate)), source = IF(source = 'manual', source, VALUES(source))`,
      [t.agencyId, d, 'USD', q, v]);
  }
  return { date: d, count: Object.keys(rates).length, base };
}

const day = (s: string | Date) => String(s).slice(0, 10);
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** One directly stored (or inverted) rate for from→to on or before `date` and no older than `minDate`. */
async function leg(t: Tenant, from: string, to: string, date: string, minDate: string): Promise<RateInfo | null> {
  const rows = await t.query<{ base: string; quote: string; rate: number; rate_date: string; source: string }>(
    `SELECT base, quote, rate, rate_date, source FROM exchange_rates WHERE agency_id = ? AND rate_date <= ? AND rate_date >= ?
       AND ((base = ? AND quote = ?) OR (base = ? AND quote = ?)) ORDER BY rate_date DESC, (base = ?) DESC LIMIT 1`,
    [t.agencyId, date, minDate, from, to, to, from, from]);
  const r = rows[0]; if (!r || !(r.rate > 0)) return null;
  return { rate: r.base === from ? r.rate : 1 / r.rate, source: r.source, date: day(r.rate_date) };
}

/**
 * Rate to convert 1 unit of `from` into `to` as at `date`: a direct/inverse rate, else triangulated through USD.
 * Rates older than the agency's fx_max_age_days are not used. Returns null when none qualifies — callers must NOT guess.
 */
export async function findRate(t: Tenant, from: string, to: string, date: string = today()): Promise<RateInfo | null> {
  if (from === to) return { rate: 1, source: 'identity', date };
  const maxAge = (await t.agency()).fx_max_age_days ?? 7, minDate = addDays(day(date), -maxAge), d = day(date);
  const direct = await leg(t, from, to, d, minDate); if (direct) return direct;
  if (from !== 'USD' && to !== 'USD') {
    const a = await leg(t, from, 'USD', d, minDate), b = a && await leg(t, 'USD', to, d, minDate);
    if (a && b) return { rate: a.rate * b.rate, source: a.source === b.source ? `${a.source} (cross)` : 'cross', date: a.date < b.date ? a.date : b.date };
  }
  return null;
}

export async function getRateInfo(t: Tenant, from: string, to: string, date: string = today()): Promise<RateInfo> {
  const r = await findRate(t, from, to, date);
  if (!r) throw new HttpError(409, `No exchange rate for ${from}→${to} within ${(await t.agency()).fx_max_age_days} days of ${day(date)}. Add one in Finance → Exchange rates.`);
  return r;
}

/** Numeric convenience wrapper. Throws (never returns 1) when there is no qualifying rate. */
export async function getRate(t: Tenant, from: string, to: string, date?: string): Promise<number> {
  return (await getRateInfo(t, from, to, date)).rate;
}
