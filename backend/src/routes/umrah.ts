import { Router } from 'express';
import { z } from 'zod';
import { ALL_EDITORS, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { nextDocNo } from '../services/accounting.js';
import { assertCanEdit, findScoped, scope } from './scope.js';
import { idParam, parse, T } from './util.js';

export const umrahRouter = Router();
const OWN = { owner: 'owner_id' };
const nul = <S extends z.ZodTypeAny>(s: S) => s.nullish();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-03-10');

const Group = z.object({
  name: z.string().trim().min(1).max(150), departure_date: date, return_date: date, nights_makkah: z.number().int().min(0).default(0), nights_madinah: z.number().int().min(0).default(0),
  hotel_makkah: nul(z.string().max(150)), hotel_madinah: nul(z.string().max(150)), airline: nul(z.string().max(100)), flight_info: nul(z.string().max(200)),
  capacity: z.number().int().min(0).default(0), currency: z.string().length(3), cost_per_pax: z.number().min(0).default(0), price_per_pax: z.number().min(0).default(0),
  status: z.enum(['open', 'closed', 'departed', 'completed', 'cancelled']).default('open'), notes: nul(z.string()),
}).refine((g) => g.return_date >= g.departure_date, { message: 'The return date is before the departure date', path: ['return_date'] });
const Pilgrim = z.object({
  client_id: z.number().int(), traveller_id: nul(z.number().int()), name: z.string().trim().min(1).max(200), passport_no: nul(z.string().max(30)), passport_expiry: nul(date), dob: nul(date),
  gender: nul(z.enum(['male', 'female'])), room_type: z.enum(['single', 'double', 'triple', 'quad']).default('quad'), room_no: nul(z.string().max(20)),
  status: z.enum(['registered', 'confirmed', 'cancelled']).default('registered'), notes: nul(z.string().max(300)),
});

const d10 = (d: unknown) => (d ? String(d).slice(0, 10) : '');
/** Passport must be valid for 6 months after the return date — the usual Saudi entry rule. */
function passportState(expiry: unknown, ret: unknown): 'missing' | 'expired' | 'short' | 'ok' {
  const e = d10(expiry); if (!e) return 'missing';
  const r = new Date(`${d10(ret)}T00:00:00Z`); r.setUTCMonth(r.getUTCMonth() + 6);
  if (e < new Date().toISOString().slice(0, 10)) return 'expired';
  return e < r.toISOString().slice(0, 10) ? 'short' : 'ok';
}

umrahRouter.get('/groups', async (req, res) => {
  const t = T(req), s = scope(req, 'g', OWN);
  const groups = await t.query(
    `SELECT g.*, (SELECT COUNT(*) FROM umrah_pilgrims p WHERE p.agency_id = g.agency_id AND p.group_id = g.id AND p.status <> 'cancelled') pilgrims,
            (SELECT COUNT(*) FROM umrah_pilgrims p JOIN visa_applications v ON v.id = p.visa_id AND v.agency_id = p.agency_id WHERE p.agency_id = g.agency_id AND p.group_id = g.id AND p.status <> 'cancelled' AND v.status IN ('approved','collected')) visas_ready
     FROM umrah_groups g WHERE g.agency_id = ?${s.sql} ORDER BY g.departure_date DESC, g.id DESC LIMIT 300`, [t.agencyId, ...s.params]);
  res.json(groups);
});

async function loadGroup(t: ReturnType<typeof T>, g: any) {
  const rows = await t.query(
    `SELECT p.*, c.name client_name, v.status visa_status, v.reference visa_reference, v.valid_until visa_valid_until FROM umrah_pilgrims p JOIN clients c ON c.id = p.client_id AND c.agency_id = p.agency_id
     LEFT JOIN visa_applications v ON v.id = p.visa_id AND v.agency_id = p.agency_id WHERE p.agency_id = ? AND p.group_id = ? ORDER BY p.room_type, p.room_no, p.name`, [t.agencyId, g.id]);
  const pilgrims = rows.map((p: any) => {
    const passport = passportState(p.passport_expiry, g.return_date), visaOk = ['approved', 'collected'].includes(p.visa_status ?? '');
    return { ...p, passport_state: passport, ready: p.status !== 'cancelled' && passport === 'ok' && visaOk };
  });
  const live = pilgrims.filter((p: any) => p.status !== 'cancelled');
  return { ...g, pilgrims, summary: { count: live.length, ready: live.filter((p: any) => p.ready).length, seats_left: g.capacity ? Math.max(0, g.capacity - live.length) : null,
    revenue: Math.round(live.length * Number(g.price_per_pax) * 100) / 100, cost: Math.round(live.length * Number(g.cost_per_pax) * 100) / 100 } };
}

umrahRouter.get('/groups/:id', async (req, res) => { const t = T(req); res.json(await loadGroup(t, await findScoped(t, req, 'umrah_groups', idParam(req), OWN))); });

umrahRouter.post('/groups', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(Group, req.body), t = T(req);
  const id = await t.tx(async (tx) => tx.insert('umrah_groups', { ...b, reference: await nextDocNo(tx, 'umrah_groups', 'reference', 'UM'), owner_id: req.ctx!.userId, branch_id: req.ctx!.branchId ?? null, created_by: req.ctx!.userId }));
  res.status(201).json({ id });
});
umrahRouter.put('/groups/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), cur = await findScoped(t, req, 'umrah_groups', id, OWN); assertCanEdit(req, cur, 'owner_id');
  const b = parse(Group, { ...Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v])), ...req.body });
  const live = (await t.one<{ n: number }>("SELECT COUNT(*) n FROM umrah_pilgrims WHERE agency_id = ? AND group_id = ? AND status <> 'cancelled'", [t.agencyId, id]))!.n;
  if (b.capacity && b.capacity < live) throw new HttpError(409, `${live} pilgrims are already registered — capacity can't be lower than that`);
  await t.update('umrah_groups', id, b); res.json({ ok: true });
});
umrahRouter.delete('/groups/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), cur = await findScoped(t, req, 'umrah_groups', id, OWN); assertCanEdit(req, cur, 'owner_id');
  const n = (await t.one<{ n: number }>('SELECT COUNT(*) n FROM umrah_pilgrims WHERE agency_id = ? AND group_id = ?', [t.agencyId, id]))!.n;
  if (n) throw new HttpError(409, 'This group has pilgrims on it. Remove them first, or set the group to Cancelled to keep the record.');
  await t.remove('umrah_groups', id); res.json({ ok: true });
});

async function pilgrimRefs(t: ReturnType<typeof T>, b: Record<string, any>) { await t.refActive('clients', b.client_id, 'client'); await t.ref('travellers', b.traveller_id, 'traveller'); }

umrahRouter.post('/groups/:id/pilgrims', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), g = await findScoped(t, req, 'umrah_groups', id, OWN); assertCanEdit(req, g, 'owner_id');
  if (['completed', 'cancelled'].includes(g.status)) throw new HttpError(409, `This group is ${g.status} and no longer takes pilgrims`);
  const list = parse(z.union([Pilgrim, z.array(Pilgrim).min(1).max(200)]), req.body), items = Array.isArray(list) ? list : [list];
  for (const p of items) await pilgrimRefs(t, p);
  const ids = await t.tx(async (tx) => {
    await tx.query('SELECT id FROM umrah_groups WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, id]);        // serialise concurrent registrations against capacity
    const live = (await tx.one<{ n: number }>("SELECT COUNT(*) n FROM umrah_pilgrims WHERE agency_id = ? AND group_id = ? AND status <> 'cancelled'", [tx.agencyId, id]))!.n;
    const adding = items.filter((p) => p.status !== 'cancelled').length;
    if (g.capacity && live + adding > g.capacity) throw new HttpError(409, `Not enough seats: ${g.capacity - live} left, ${adding} requested`);
    const out: number[] = []; for (const p of items) out.push(await tx.insert('umrah_pilgrims', { ...p, group_id: id })); return out;
  });
  res.status(201).json({ ids });
});

async function findPilgrim(t: ReturnType<typeof T>, req: any, pid: number) {
  const p = await t.one('SELECT * FROM umrah_pilgrims WHERE agency_id = ? AND id = ?', [t.agencyId, pid]);
  if (!p) throw new HttpError(404, 'Not found');
  const g = await findScoped(t, req, 'umrah_groups', p.group_id, OWN); assertCanEdit(req, g, 'owner_id');
  return { p, g };
}
umrahRouter.put('/pilgrims/:pid', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), pid = Number(req.params.pid), { p, g } = await findPilgrim(t, req, pid), b = parse(Pilgrim.partial(), req.body); await pilgrimRefs(t, b);
  if (b.status && b.status !== 'cancelled' && p.status === 'cancelled' && g.capacity) {
    const live = (await t.one<{ n: number }>("SELECT COUNT(*) n FROM umrah_pilgrims WHERE agency_id = ? AND group_id = ? AND status <> 'cancelled'", [t.agencyId, g.id]))!.n;
    if (live >= g.capacity) throw new HttpError(409, 'The group is full');
  }
  await t.update('umrah_pilgrims', pid, b); res.json({ ok: true });
});
umrahRouter.delete('/pilgrims/:pid', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), pid = Number(req.params.pid); await findPilgrim(t, req, pid); await t.remove('umrah_pilgrims', pid); res.json({ ok: true });
});

/** One click: open a visa file for every pilgrim who doesn't have one yet. */
umrahRouter.post('/groups/:id/visas', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), g = await findScoped(t, req, 'umrah_groups', id, OWN); assertCanEdit(req, g, 'owner_id');
  const todo = await t.query("SELECT * FROM umrah_pilgrims WHERE agency_id = ? AND group_id = ? AND status <> 'cancelled' AND visa_id IS NULL ORDER BY id", [t.agencyId, id]);
  const made = await t.tx(async (tx) => {
    let n = 0;
    for (const p of todo) {
      const reference = await nextDocNo(tx, 'visa_applications', 'reference', 'VS');
      const vid = await tx.insert('visa_applications', { reference, client_id: p.client_id, traveller_id: p.traveller_id, applicant_name: p.name, passport_no: p.passport_no, country: 'Saudi Arabia', visa_type: 'umrah', entry_type: 'single',
        status: 'docs_pending', currency: g.currency, cost: 0, price: 0, notes: `Umrah group ${g.reference} — ${g.name}`, owner_id: req.ctx!.userId, branch_id: req.ctx!.branchId ?? null, created_by: req.ctx!.userId });
      await tx.insert('visa_events', { visa_id: vid, status: 'docs_pending', note: `Opened from Umrah group ${g.reference}`, user_id: tx.actor.userId });
      await tx.update('umrah_pilgrims', p.id, { visa_id: vid }); n++;
    }
    return n;
  });
  res.status(201).json({ created: made });
});
