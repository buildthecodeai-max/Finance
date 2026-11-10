import { config } from '../config.js';
import { pool } from '../db.js';
import { decrypt } from '../crypto.js';
import { DEFAULT_MODELS, type AiProvider, PROVIDERS } from './aiProviders.js';

/**
 * Which AI service the assistant uses, and with what key and model. Settings an operator saved in the console (stored encrypted) win over the server's environment.
 * Kept in memory for a short time so a request does not read the database, and so a change made on one server reaches the others within a minute.
 */
const TTL_MS = 20_000;
export type AiSettings = { provider: AiProvider; key: string; model: string; baseUrl: string | null; source: 'console' | 'environment' | 'none'; hint: string | null; updated_at: string | null; updated_by: string | null };
let cached: (AiSettings & { at: number }) | null = null;

export const dropAiKeyCache = () => { cached = null; };
function fromEnvironment(): AiSettings {
  const asked = (process.env.AI_PROVIDER ?? '').toLowerCase() as AiProvider; const provider: AiProvider = PROVIDERS.includes(asked) ? asked : !config.anthropicKey && config.openaiKey ? 'openai' : 'anthropic';
  const key = provider === 'anthropic' ? config.anthropicKey : config.openaiKey;
  return { provider, key, model: process.env.AI_MODEL || DEFAULT_MODELS[provider], baseUrl: process.env.AI_BASE_URL || null, source: key ? 'environment' : 'none', hint: key ? key.slice(-4) : null, updated_at: null, updated_by: null };
}
export async function resolveAi(): Promise<AiSettings> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached;
  let r = fromEnvironment();
  try {
    const [rows]: any = await pool.query("SELECT s.k, s.v_enc, s.hint, s.updated_at, u.email FROM platform_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.k IN ('ai_api_key', 'ai_provider', 'ai_model', 'ai_base_url')");
    const by = Object.fromEntries(rows.map((x: any) => [x.k, x])); const val = (k: string) => (by[k] ? decrypt(by[k].v_enc) : null);
    if (by.ai_api_key) { const provider = (val('ai_provider') as AiProvider) || 'anthropic'; r = { provider, key: val('ai_api_key')!, model: val('ai_model') || DEFAULT_MODELS[provider], baseUrl: val('ai_base_url'), source: 'console', hint: by.ai_api_key.hint, updated_at: by.ai_api_key.updated_at, updated_by: by.ai_api_key.email ?? null }; }
  } catch { /* the table may not exist yet, or a stored value cannot be read: fall back to the environment */ }
  cached = { ...r, at: Date.now() }; return r;
}
/** Whether any key is set, without a database trip (whatever was resolved last, else the environment). */
export const aiKeySync = () => (cached ? cached.key : fromEnvironment().key);
export const resolveAiKey = resolveAi;
