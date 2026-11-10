import { config } from '../config.js';
import { pool } from '../db.js';
import { decrypt } from '../crypto.js';

/**
 * Where the AI provider key comes from: a key an operator saved in the console (stored encrypted) wins over ANTHROPIC_API_KEY in the environment.
 * Kept in memory for a short time so a request does not read the database, and so a key saved on one server reaches the others within a minute.
 */
const TTL_MS = 20_000;
type Resolved = { key: string; source: 'console' | 'environment' | 'none'; hint: string | null; updated_at: string | null; updated_by: string | null };
let cached: (Resolved & { at: number }) | null = null;

export const dropAiKeyCache = () => { cached = null; };
export async function resolveAiKey(): Promise<Resolved> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached;
  let r: Resolved = { key: config.anthropicKey, source: config.anthropicKey ? 'environment' : 'none', hint: config.anthropicKey ? config.anthropicKey.slice(-4) : null, updated_at: null, updated_by: null };
  try {
    const [[row]]: any = await pool.query("SELECT s.v_enc, s.hint, s.updated_at, u.email FROM platform_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.k = 'ai_api_key'");
    if (row) r = { key: decrypt(row.v_enc), source: 'console', hint: row.hint, updated_at: row.updated_at, updated_by: row.email ?? null };
  } catch { /* the table may not exist yet, or the stored value cannot be read: fall back to the environment */ }
  cached = { ...r, at: Date.now() }; return r;
}
/** The key without a database trip (whatever was resolved last, else the environment). */
export const aiKeySync = () => cached?.key ?? config.anthropicKey;
