import { Router, raw } from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { applyBillingEvent } from '../services/billing.js';
import { Tenant } from '../db.js';
import { createReceipt } from '../services/finance.js';
import { ensureSys } from '../services/accounting.js';
import { today } from '../services/money.js';

export const webhooksRouter = Router();

// Must receive the raw body for signature verification (mounted before express.json()).
webhooksRouter.post('/stripe', raw({ type: 'application/json' }), async (req, res) => {
  const stripe = new Stripe(config.stripeKey);
  let ev: Stripe.Event;
  try { ev = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] as string, config.stripeWebhookSecret); }
  catch { return void res.status(400).send('bad signature'); }

  const o: any = ev.data.object;
  if (ev.type.startsWith('customer.subscription.') || ev.type.startsWith('invoice.') || (ev.type === 'checkout.session.completed' && o.mode === 'subscription')) {
    await applyBillingEvent(ev);   // our own subscription billing, not a client's invoice payment
    return void res.json({ received: true });
  }
  if (ev.type === 'checkout.session.completed') {
    const s = ev.data.object as Stripe.Checkout.Session;
    const agencyId = Number(s.metadata?.agency_id), invoiceId = Number(s.metadata?.invoice_id);
    if (agencyId && invoiceId && s.payment_status === 'paid') {
      const t = new Tenant(agencyId, { userId: null, ip: 'stripe' });
      const inv = await t.get('invoices', invoiceId);
      // idempotency key = Stripe session id, so webhook retries/replays can never record the payment twice
      if (inv?.voucher_id) {
        await createReceipt(t, { client_id: inv.client_id, cash_account_id: await ensureSys(t, 'bank'), amount: (s.amount_total ?? 0) / 100, currency: inv.currency, fx_rate: inv.fx_rate, receipt_date: today(),
          method: 'stripe', reference: String(s.payment_intent ?? ''), allocations: [{ invoice_id: invoiceId, amount: (s.amount_total ?? 0) / 100 }], idem_key: `stripe:${s.id}` });
      }
    }
  }
  res.json({ received: true });
});
