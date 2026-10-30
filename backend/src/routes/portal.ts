import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { HttpError, WRITERS, requireRole } from '../auth.js';
import { fileKey, signedUrl } from '../storage.js';
import * as P from '../services/portal.js';
import { renderAndStore } from './invoices.js';
import { idParam, parse, T } from './util.js';

/* ============ public: token only, no session, minimal surface ============ */
export const publicPortalRouter = Router();
publicPortalRouter.use(rateLimit({ windowMs: 15 * 60_000, limit: 120, standardHeaders: true }));
const tok = (req: any) => String(req.params.token);

publicPortalRouter.get('/:token', async (req, res) => { const { link, t } = await P.resolve(tok(req), req.ip); res.json(await P.portalView(t, link)); });

publicPortalRouter.get('/:token/invoices/:id/pdf', async (req, res) => {
  const { link, t } = await P.resolve(tok(req), req.ip), inv = await P.linkedInvoice(t, link, idParam(req));
  const key = inv.sent_at && inv.pdf_key ? inv.pdf_key : (await renderAndStore(t, inv.id)).key;   // a sent invoice keeps the exact PDF the client received
  res.json({ url: await signedUrl(t.agencyId, key, `${inv.number}.pdf`) });
});

publicPortalRouter.post('/:token/invoices/:id/pay', rateLimit({ windowMs: 15 * 60_000, limit: 20 }), async (req, res) => {
  const { link, t } = await P.resolve(tok(req), req.ip);
  res.json({ url: await P.startPayment(t, link, tok(req), idParam(req)) });
});

publicPortalRouter.post('/:token/requests', rateLimit({ windowMs: 60 * 60_000, limit: 10 }), async (req, res) => {
  const { link, t } = await P.resolve(tok(req), req.ip);
  if (link.scope !== 'portal') throw new HttpError(403, 'This link cannot be used to send requests');
  const b = parse(z.object({ subject: z.string().trim().min(3).max(200), message: z.string().trim().min(3).max(4000), booking_id: z.number().int().optional() }), req.body);
  res.status(201).json({ id: await P.createRequest(t, link, b) });
});

/* ============ staff ============ */
export const portalAdminRouter = Router();
portalAdminRouter.use(requireRole('admin', 'finance_manager', 'viewer'));
const W = requireRole(...WRITERS);
const LinkBody = z.object({ client_id: z.number().int(), invoice_id: z.number().int().optional(), days: z.number().int().min(1).max(365).default(30), send: z.boolean().default(false) });

async function makeLink(req: any, scope: 'portal' | 'invoice', b: z.infer<typeof LinkBody>) {
  const t = T(req), l = await P.createLink(t, { client_id: b.client_id, scope, invoice_id: b.invoice_id, days: b.days });
  let delivery: string | null = null;
  if (b.send) {
    if (!l.client.email) throw new HttpError(400, 'Client has no email — the link was created but not sent; copy it instead');
    const agency = await t.agency();
    delivery = await P.deliver(t, { kind: scope === 'invoice' ? 'payment_link' : 'portal_link', ref_table: 'portal_links', ref_id: l.id, to: l.client.email,
      subject: scope === 'invoice' ? `Pay your invoice — ${agency.name}` : `Your ${agency.name} client portal`,
      html: `<p>Hi ${l.client.name},</p><p>${scope === 'invoice' ? 'You can view and pay your invoice securely here' : 'You can see your quotes, invoices, itinerary and payments here'}: <a href="${l.url}">${l.url}</a></p><p>This private link expires on ${l.expires_at.slice(0, 10)}.</p>` });
  }
  return { id: l.id, url: l.url, expires_at: l.expires_at, delivery };
}
portalAdminRouter.post('/links', W, async (req, res) => res.status(201).json(await makeLink(req, 'portal', parse(LinkBody, req.body))));
portalAdminRouter.post('/payment-links', W, async (req, res) => {
  const b = parse(LinkBody, req.body); if (!b.invoice_id) throw new HttpError(400, 'invoice_id is required');
  res.status(201).json(await makeLink(req, 'invoice', b));
});
portalAdminRouter.get('/links', async (req, res) => res.json(await P.listLinks(T(req), req.query.client_id ? Number(req.query.client_id) : undefined)));
portalAdminRouter.post('/links/:id/revoke', W, async (req, res) => { await P.revokeLink(T(req), idParam(req)); res.json({ ok: true }); });

portalAdminRouter.get('/requests', async (req, res) => {
  const t = T(req), st = ['open', 'in_progress', 'resolved'].includes(String(req.query.status)) ? String(req.query.status) : null;
  res.json(await t.query(`SELECT r.*, c.name client_name, c.email client_email, b.reference booking_ref FROM support_requests r JOIN clients c ON c.id = r.client_id AND c.agency_id = r.agency_id
    LEFT JOIN bookings b ON b.id = r.booking_id AND b.agency_id = r.agency_id WHERE r.agency_id = ? ${st ? 'AND r.status = ?' : ''} ORDER BY r.id DESC LIMIT 200`, st ? [t.agencyId, st] : [t.agencyId]));
});
portalAdminRouter.post('/requests/:id/respond', W, async (req, res) => {
  const t = T(req), id = idParam(req), b = parse(z.object({ response: z.string().trim().min(1).max(4000).optional(), status: z.enum(['open', 'in_progress', 'resolved']).optional(), notify: z.boolean().default(false) }), req.body);
  const r = await t.get('support_requests', id); if (!r) throw new HttpError(404, 'Request not found');
  await t.update('support_requests', id, { ...(b.response ? { response: b.response, responded_by: t.actor.userId, responded_at: new Date().toISOString().slice(0, 19).replace('T', ' ') } : {}), status: b.status ?? (b.response ? 'in_progress' : r.status) });
  let delivery: string | null = null;
  if (b.notify && b.response) {
    const c = await t.get('clients', r.client_id), a = await t.agency();
    if (c?.email) delivery = await P.deliver(t, { kind: 'support_reply', ref_table: 'support_requests', ref_id: id, to: c.email, subject: `Re: ${r.subject}`, html: `<p>Hi ${c.name},</p><p>${b.response.replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p><p>— ${a.name}</p>` });
  }
  res.json({ ok: true, delivery });
});
portalAdminRouter.get('/deliveries', async (req, res) => { const t = T(req); res.json(await t.query('SELECT * FROM delivery_log WHERE agency_id = ? ORDER BY id DESC LIMIT 200', [t.agencyId])); });
