import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from '../errors.js';

/** The AI providers the assistant can talk to. "compatible" means any service that speaks the OpenAI chat format: Gemini, Groq, Mistral, OpenRouter, Azure, or a model running locally with Ollama. */
export const PROVIDERS = ['anthropic', 'openai', 'compatible'] as const;
export type AiProvider = (typeof PROVIDERS)[number];
export const DEFAULT_MODELS: Record<AiProvider, string> = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-4o-mini', compatible: '' };
export const PROVIDER_LABEL: Record<AiProvider, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI (GPT)', compatible: 'OpenAI-compatible (Gemini, Groq, Mistral, local…)' };
export const OPENAI_URL = 'https://api.openai.com/v1';

/** The one message shape the assistant uses everywhere (Anthropic's): text and tool calls as blocks. Other providers are translated to and from it. */
export type Msg = { role: 'user' | 'assistant'; content: string | any[] };
export type Req = { system: string; messages: Msg[]; tools?: any[]; toolChoice?: any; maxTokens: number };
export type Res = { content: any[]; stop_reason: string | null; usage: { input_tokens: number; output_tokens: number } };
export type Target = { provider: AiProvider; key: string; model: string; baseUrl?: string | null };

/** Where an operator-supplied address may point. Must be https, except for a model on this same machine. Cloud metadata and private network addresses are refused. */
export function checkBaseUrl(raw: string): string {
  let u: URL; try { u = new URL(raw.trim()); } catch { throw new HttpError(400, 'That address is not a valid web address. It looks like https://api.example.com/v1'); }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase(); const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new HttpError(400, 'The address must start with https:// (plain http is only allowed for a model on this same machine).');
  if (u.username || u.password) throw new HttpError(400, 'Do not put a password in the address.');
  const privateNet = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|fc|fd|fe80)/.test(host) || host === 'metadata.google.internal';
  if (privateNet && !local) throw new HttpError(400, 'That address points inside a private network, which is not allowed.');
  return u.toString().replace(/\/+$/, '');
}

/* ---------------------------------------------------------------------------------------------- Anthropic */
async function runAnthropic(t: Target, p: Req): Promise<Res> {
  const client = new Anthropic({ apiKey: t.key, maxRetries: 1, timeout: 60_000 });
  return (await client.messages.create({ model: t.model, max_tokens: p.maxTokens, system: p.system, messages: p.messages as any, ...(p.tools ? { tools: p.tools } : {}), ...(p.toolChoice ? { tool_choice: p.toolChoice } : {}) })) as any;
}

/* ---------------------------------------------------------------------------------------------- OpenAI chat format */
/** Anthropic-shaped messages → OpenAI chat messages. Tool results become `tool` messages; an assistant turn with tool calls keeps its call ids so results line up. */
export function toOpenAIMessages(system: string, messages: Msg[]): any[] {
  const out: any[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'); const calls = m.content.filter((b) => b.type === 'tool_use');
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}) });
    } else {
      for (const b of m.content) { if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) }); else if (b.type === 'text') out.push({ role: 'user', content: b.text }); }
    }
  }
  return out;
}
export function toOpenAIRequest(t: Target, p: Req) {
  const body: any = { model: t.model, messages: toOpenAIMessages(p.system, p.messages), [t.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']: p.maxTokens };
  if (p.tools?.length) {
    body.tools = p.tools.map((x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.input_schema } }));
    body.tool_choice = p.toolChoice?.type === 'tool' ? { type: 'function', function: { name: p.toolChoice.name } } : 'auto';
  }
  return body;
}
/** OpenAI chat reply → the Anthropic-shaped reply the rest of the assistant expects. */
export function fromOpenAIResponse(j: any): Res {
  const m = j?.choices?.[0]?.message; if (!m) throw new Error('empty reply');
  const content: any[] = []; if (m.content) content.push({ type: 'text', text: String(m.content) });
  for (const c of m.tool_calls ?? []) { let input: any = {}; try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = {}; } content.push({ type: 'tool_use', id: c.id, name: c.function?.name, input }); }
  return { content, stop_reason: m.tool_calls?.length ? 'tool_use' : 'end_turn', usage: { input_tokens: Number(j.usage?.prompt_tokens ?? 0), output_tokens: Number(j.usage?.completion_tokens ?? 0) } };
}
async function postChat(t: Target, body: any, timeoutMs: number): Promise<any> {
  const base = (t.provider === 'openai' ? OPENAI_URL : t.baseUrl ?? '').replace(/\/+$/, ''); if (!base) throw Object.assign(new Error('no address'), { status: 0 });
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/chat/completions`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${t.key}` }, body: JSON.stringify(body) });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function runOpenAI(t: Target, p: Req): Promise<Res> { return fromOpenAIResponse(await postChat(t, toOpenAIRequest(t, p), 60_000)); }

/* ---------------------------------------------------------------------------------------------- public */
export async function runProvider(t: Target, p: Req): Promise<Res> { return t.provider === 'anthropic' ? runAnthropic(t, p) : runOpenAI(t, p); }

/** One tiny request to learn whether a key (and model, and address) work. Throws 'rejected' (bad key), 'model' (unknown model) or 'unreachable'. */
export async function verifyProvider(t: Target): Promise<void> {
  try {
    if (t.provider === 'anthropic') await new Anthropic({ apiKey: t.key, maxRetries: 0, timeout: 20_000 }).messages.create({ model: t.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    else await postChat(t, { model: t.model, messages: [{ role: 'user', content: 'ping' }], [t.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']: 1 }, 20_000);
  } catch (e: any) { throw Object.assign(new Error(e?.status === 401 || e?.status === 403 ? 'rejected' : e?.status === 404 || e?.status === 400 ? 'model' : 'unreachable'), { cause: e?.status }); }
}
