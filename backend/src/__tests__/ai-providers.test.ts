import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authenticator } from 'otplib';
import { Api, PASSWORD, apiBase, boot, newAgency, shutdown, sql } from './helpers.js';
import { checkBaseUrl, fromOpenAIResponse, toOpenAIMessages, toOpenAIRequest } from '../services/aiProviders.js';
import { dropAiKeyCache } from '../services/aiKey.js';
import { setPlatformAdmin } from '../services/platform.js';
import { llm } from '../services/ai.js';

let base: string; const rnd = () => Math.random().toString(36).slice(2, 7);
const realFetch = globalThis.fetch;
const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await realFetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};
beforeAll(async () => { await boot(); base = apiBase().replace(/\/api$/, ''); });
afterAll(async () => { await sql("DELETE FROM platform_settings WHERE k LIKE 'ai_%'"); dropAiKeyCache(); await shutdown(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('OpenAI chat format translation', () => {
  it('turns the assistant’s messages, tools and a forced tool call into an OpenAI request', () => {
    const msgs = [{ role: 'user' as const, content: 'Who owes me money?' },
      { role: 'assistant' as const, content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'call_1', name: 'unpaid_invoices', input: { min_days_overdue: 30 } }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"invoices":[]}' }] }];
    const m = toOpenAIMessages('SYS', msgs);
    expect(m[0]).toEqual({ role: 'system', content: 'SYS' }); expect(m[1]).toEqual({ role: 'user', content: 'Who owes me money?' });
    expect(m[2]).toMatchObject({ role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'unpaid_invoices', arguments: '{"min_days_overdue":30}' } }] });
    expect(m[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"invoices":[]}' });
    const tool = { name: 'draft_quote', description: 'd', input_schema: { type: 'object', properties: { title: { type: 'string' } } } };
    const forced = toOpenAIRequest({ provider: 'openai', key: 'k', model: 'gpt-x' }, { system: 'S', messages: [{ role: 'user', content: 'x' }], tools: [tool], toolChoice: { type: 'tool', name: 'draft_quote' }, maxTokens: 500 });
    expect(forced).toMatchObject({ model: 'gpt-x', max_completion_tokens: 500, tool_choice: { type: 'function', function: { name: 'draft_quote' } }, tools: [{ type: 'function', function: { name: 'draft_quote', parameters: tool.input_schema } }] });
    expect(toOpenAIRequest({ provider: 'compatible', key: 'k', model: 'm' }, { system: 'S', messages: [], tools: [tool], maxTokens: 5 })).toMatchObject({ max_tokens: 5, tool_choice: 'auto' });
  });
  it('turns an OpenAI reply back into text and tool_use blocks, tolerating bad arguments', () => {
    const r = fromOpenAIResponse({ choices: [{ message: { content: 'Hi', tool_calls: [{ id: 'c1', function: { name: 'a', arguments: '{"x":1}' } }, { id: 'c2', function: { name: 'b', arguments: 'not json' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 7 } });
    expect(r.stop_reason).toBe('tool_use'); expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
    expect(r.content).toEqual([{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'c1', name: 'a', input: { x: 1 } }, { type: 'tool_use', id: 'c2', name: 'b', input: {} }]);
    expect(fromOpenAIResponse({ choices: [{ message: { content: 'Plain' } }] }).stop_reason).toBe('end_turn'); expect(() => fromOpenAIResponse({})).toThrow();
  });
  it('only allows safe service addresses', () => {
    expect(checkBaseUrl('https://api.groq.com/openai/v1/')).toBe('https://api.groq.com/openai/v1'); expect(checkBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    for (const bad of ['http://api.example.com/v1', 'ftp://x.com', 'not a url', 'https://169.254.169.254/latest', 'https://10.0.0.5/v1', 'https://192.168.1.2/v1', 'https://user:pw@api.example.com/v1', 'https://metadata.google.internal/']) expect(() => checkBaseUrl(bad), bad).toThrow();
  });
});

describe('using OpenAI end to end', () => {
  it('saves an OpenAI key from the console and the assistant then answers through it, tool calls included', async () => {
    await sql("DELETE FROM platform_settings WHERE k LIKE 'ai_%'"); dropAiKeyCache();
    const email = `op-${rnd()}@platform.test`, reg = await call(null, 'POST', '/auth/register', { agencyName: `Ops ${rnd()}`, name: 'Operator', email, password: PASSWORD }); const tok = reg.body.accessToken;
    await setPlatformAdmin(email, 'admin'); const s = await call(tok, 'POST', '/auth/2fa/setup', {}); await call(tok, 'POST', '/auth/2fa/enable', { code: authenticator.generate(s.body.secret) });
    const P = (method: string, path: string, body?: unknown) => call(tok, method, `/platform${path}`, body);
    const verify = vi.spyOn(llm, 'verify').mockResolvedValue(undefined);
    expect((await P('PUT', '/settings/ai', { provider: 'openai', api_key: 'sk-ant-api03-this-is-an-anthropic-key-xxxxxxxx', reason: 'wrong key type' })).status).toBe(400);           // an Anthropic key is not an OpenAI key
    expect((await P('PUT', '/settings/ai', { provider: 'compatible', api_key: 'abcdefgh12345678', model: 'm', reason: 'no address' })).body.error).toMatch(/address/);
    expect((await P('PUT', '/settings/ai', { provider: 'compatible', api_key: 'abcdefgh12345678', model: 'm', base_url: 'https://10.0.0.1/v1', reason: 'private' })).status).toBe(400);
    expect((await P('PUT', '/settings/ai', { provider: 'compatible', api_key: 'abcdefgh12345678', reason: 'no model' })).body.error).toMatch(/model/i);
    verify.mockRejectedValueOnce(new Error('model')); expect((await P('PUT', '/settings/ai', { provider: 'openai', api_key: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', model: 'no-such-model', reason: 'typo' })).body.error).toMatch(/does not know the model/);
    const ok = await P('PUT', '/settings/ai', { provider: 'openai', api_key: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', model: 'gpt-4o-mini', reason: 'Switch to OpenAI' });
    expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ configured: true, source: 'console', provider: 'openai', model: 'gpt-4o-mini' }); expect(JSON.stringify(ok.body)).not.toContain('sk-proj');
    expect(verify).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'openai', model: 'gpt-4o-mini' }));
    expect(JSON.stringify(await sql("SELECT * FROM platform_settings"))).not.toContain('sk-proj-ABCDEF');                                 // encrypted at rest

    const A: Api = await newAgency('OpenAiCo'); await sql("UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'growth') WHERE agency_id = ?", [A.agencyId]);
    await A.post('/clients', { name: 'Late Payer Ltd', currency: 'USD' });
    const seen: any[] = []; let turn = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
      if (!String(url).startsWith('https://api.openai.com/v1/chat/completions')) return realFetch(url, init);
      seen.push({ auth: init.headers.authorization, body: JSON.parse(init.body) });
      const reply = turn++ === 0 ? { choices: [{ message: { content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'supplier_bills_due', arguments: '{}' } }] } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }
        : { choices: [{ message: { content: 'No supplier bills are waiting to be paid.' } }], usage: { prompt_tokens: 60, completion_tokens: 12 } };
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const r = await A.post('/ai/ask', { question: 'What do we owe suppliers?' }); expect(r.status).toBe(200); expect(r.body.answer).toBe('No supplier bills are waiting to be paid.'); expect(r.body.used).toEqual(['supplier_bills_due']);
    expect(seen).toHaveLength(2); expect(seen[0].auth).toBe('Bearer sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'); expect(seen[0].body.model).toBe('gpt-4o-mini'); expect(seen[0].body.tools[0].function.name).toBe('unpaid_invoices');
    expect(seen[1].body.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_9')).toBe(true);                         // the tool result was sent back in OpenAI's format
    expect((await sql('SELECT SUM(input_tokens) i FROM ai_usage WHERE agency_id = ?', [A.agencyId]))[0].i).toBe(100);                     // usage is counted from OpenAI's numbers
    // an OpenAI failure becomes the same plain message as any other provider
    vi.mocked(globalThis.fetch).mockImplementation(async (url: any, init?: any) => String(url).includes('openai.com') ? new Response('{"error":"boom"}', { status: 500 }) : realFetch(url, init));
    const bad = await A.post('/ai/ask', { question: 'What do we owe suppliers?' }); expect(bad.status).toBe(502); expect(JSON.stringify(bad.body)).not.toMatch(/boom|sk-proj/);
    expect((await P('DELETE', '/settings/ai', { reason: 'cleanup' })).status).toBe(200);
  });
});
