import { Router } from 'express';
import { z } from 'zod';
import { dropFeedCache, feed, mark } from '../services/notifications.js';
import { parse, T } from './util.js';

/** The agency notification centre (the bell and the Notifications page). See services/notifications.ts for how the list is made. */
export const notificationsRouter = Router();
notificationsRouter.get('/', async (req, res) => res.json(await feed(req, T(req))));
notificationsRouter.get('/count', async (req, res) => { const f = await feed(req, T(req)); res.json({ unread: f.unread }); });
const Keys = z.object({ keys: z.array(z.string().min(1).max(120)).max(200).optional(), all: z.boolean().optional() }).refine((b) => b.all || b.keys?.length, 'Say which notifications');
notificationsRouter.post('/read', async (req, res) => res.json(await mark(req, T(req), parse(Keys, req.body), true)));
notificationsRouter.post('/unread', async (req, res) => res.json(await mark(req, T(req), parse(Keys, req.body), false)));
void dropFeedCache;
