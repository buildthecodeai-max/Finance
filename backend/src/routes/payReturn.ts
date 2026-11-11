import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import * as L from '../services/localPay.js';

/**
 * Where JazzCash and Easypaisa send the customer back to (and, for JazzCash, its server notification). No session: the gateway's own signature or an inquiry to the gateway
 * proves the result. Whatever happens, the customer lands on the Billing page, which shows the outcome.
 */
export const payReturnRouter = Router();
payReturnRouter.use(rateLimit({ windowMs: 15 * 60_000, limit: process.env.NODE_ENV === 'test' ? 5000 : 200, standardHeaders: true }));
const back = (o: { status: string; ref?: string }) => `${config.appUrl}/billing?pay=${o.status}${o.ref ? `&ref=${encodeURIComponent(o.ref)}` : ''}`;

payReturnRouter.post('/jazzcash', express.urlencoded({ extended: false, limit: '30kb' }), async (req, res) => {
  let o: L.Outcome; try { o = await L.handleJazzCash(req.body ?? {}); } catch (e) { console.error('jazzcash return failed', e); o = { status: 'error' }; }
  res.redirect(303, back(o));
});
payReturnRouter.get('/easypaisa/:ref', async (req, res) => {
  let o: L.Outcome & { redirect?: string }; try { o = await L.handleEasypaisa(String(req.params.ref).slice(0, 40), req.query as Record<string, unknown>); } catch (e) { console.error('easypaisa return failed', e); o = { status: 'error' }; }
  res.redirect(303, o.redirect ?? back(o));
});
