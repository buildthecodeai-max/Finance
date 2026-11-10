import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ALL_EDITORS, WRITERS, requireRole } from '../auth.js';
import { aiStatus, assertAi, askBooks, draftMessage, draftQuote, MESSAGE_KINDS, TONES } from '../services/ai.js';
import { parse, T } from './util.js';

/** AI assistant: draft a quote from an enquiry, answer questions about the agency's books, write client messages.
 *  It only drafts and reads. Nothing it produces is saved or sent until a person does that. */
export const aiRouter = Router();
const limit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `ai:${req.ctx?.userId ?? req.ip}`, message: { error: 'Too many AI requests — wait a minute and try again.' } });

aiRouter.get('/status', async (req, res) => res.json(await aiStatus(req.ctx!.agencyId)));
aiRouter.post('/quote-draft', limit, requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(z.object({ text: z.string().trim().min(15, 'Paste the client’s enquiry — a few lines at least.').max(6000) }), req.body);
  await assertAi(req); res.json(await draftQuote(req, T(req), b.text));
});
// Figures from the books are finance information, so only roles that can see them may ask.
aiRouter.post('/ask', limit, requireRole(...WRITERS), async (req, res) => {
  const b = parse(z.object({ question: z.string().trim().min(3).max(500) }), req.body);
  await assertAi(req); res.json(await askBooks(req, T(req), b.question));
});
aiRouter.post('/draft-message', limit, requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(z.object({ kind: z.enum(MESSAGE_KINDS), tone: z.enum(TONES).default('friendly'), client_id: z.number().int().nullish(), quote_id: z.number().int().nullish(), booking_id: z.number().int().nullish(), instructions: z.string().max(1000).optional() }), req.body);
  await assertAi(req); res.json(await draftMessage(req, T(req), b));
});
