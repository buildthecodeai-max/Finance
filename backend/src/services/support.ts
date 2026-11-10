import type { Request } from 'express';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { pool } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import { health } from './observability.js';
import { sendMail } from './email.js';

/** How agencies reach the support team: set by an operator in the console, shown on every agency's Support page. */
export const SUPPORT_FIELDS = ['support_email', 'support_phone', 'support_hours', 'support_url'] as const;
export async function supportContact() {
  const [rows]: any = await pool.query(`SELECT k, v_enc FROM platform_settings WHERE k IN (${SUPPORT_FIELDS.map(() => '?').join(',')})`, [...SUPPORT_FIELDS]);
  const by = Object.fromEntries(rows.map((r: any) => { let v = ''; try { v = decrypt(r.v_enc); } catch { /* unreadable: treat as unset */ } return [r.k, v]; }));
  return { email: by.support_email || '', phone: by.support_phone || '', hours: by.support_hours || '', url: by.support_url || '' };
}
export async function saveSupportContact(userId: number, c: { email?: string; phone?: string; hours?: string; url?: string }) {
  for (const [field, v] of [['support_email', c.email], ['support_phone', c.phone], ['support_hours', c.hours], ['support_url', c.url]] as const) {
    const val = (v ?? '').trim();
    if (!val) await pool.query('DELETE FROM platform_settings WHERE k = ?', [field]);
    else await pool.query('INSERT INTO platform_settings (k, v_enc, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE v_enc = VALUES(v_enc), updated_by = VALUES(updated_by)', [field, encrypt(val), userId]);
  }
  return supportContact();
}

export const CATEGORIES = ['question', 'problem', 'billing', 'request'] as const;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

export async function createRequest(req: Request, b: { category: (typeof CATEGORIES)[number]; subject: string; message: string }) {
  const [[ag]]: any = await pool.query('SELECT name FROM agencies WHERE id = ?', [req.ctx!.agencyId]); const [[u]]: any = await pool.query('SELECT name, email FROM users WHERE id = ?', [req.ctx!.userId]);
  const [[dup]]: any = await pool.query("SELECT COUNT(*) n FROM help_requests WHERE agency_id = ? AND user_id = ? AND subject = ? AND message = ? AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)", [req.ctx!.agencyId, req.ctx!.userId, b.subject, b.message]);
  if (dup.n) throw new HttpError(409, 'You already sent this request a moment ago. We have it.');
  const [r]: any = await pool.query('INSERT INTO help_requests (agency_id, user_id, category, subject, message) VALUES (?,?,?,?,?)', [req.ctx!.agencyId, req.ctx!.userId, b.category, b.subject, b.message]);
  const to = (await supportContact()).email;
  if (to) void sendMail(to, `[Support #${r.insertId}] ${b.subject}`, `<p><b>${esc(ag.name)}</b> · ${esc(u.name)} &lt;${esc(u.email)}&gt; · ${b.category}</p><p>${esc(b.message)}</p><p style="color:#667">Reply from the platform console under Support.</p>`).catch(() => {});
  return r.insertId as number;
}

/** Open requests first, newest first within each group. */
export async function listAllRequests(q: { status?: string; q?: string; page?: number; size?: number }) {
  const where: string[] = ['1 = 1'], p: any[] = []; const size = Math.min(100, q.size ?? 25), page = Math.max(1, q.page ?? 1);
  if (q.status && ['open', 'in_progress', 'resolved'].includes(q.status)) { where.push('r.status = ?'); p.push(q.status); }
  const s = (q.q ?? '').trim().replace(/[%_]/g, ''); if (s) { where.push('(r.subject LIKE ? OR r.message LIKE ? OR ag.name LIKE ? OR u.email LIKE ?)'); p.push(...Array(4).fill(`%${s}%`)); }
  const w = where.join(' AND '); const base = 'FROM help_requests r JOIN agencies ag ON ag.id = r.agency_id JOIN users u ON u.id = r.user_id LEFT JOIN users rp ON rp.id = r.replied_by';
  const [[tot]]: any = await pool.query(`SELECT COUNT(*) n ${base} WHERE ${w}`, p);
  const [rows]: any = await pool.query(`SELECT r.id, r.agency_id, ag.name agency_name, r.user_id, u.name user_name, u.email user_email, r.category, r.subject, r.message, r.status, r.reply, rp.email replied_by, r.replied_at, r.created_at
    ${base} WHERE ${w} ORDER BY (r.status = 'resolved'), r.id DESC LIMIT ? OFFSET ?`, [...p, size, (page - 1) * size]);
  const [cs]: any = await pool.query('SELECT status, COUNT(*) n FROM help_requests GROUP BY status');
  return { rows, total: tot.n, page, page_size: size, counts: Object.fromEntries(cs.map((c: any) => [c.status, Number(c.n)])) };
}

export async function answerRequest(req: Request, id: number, b: { status: 'open' | 'in_progress' | 'resolved'; reply?: string }) {
  const [[r]]: any = await pool.query('SELECT r.*, u.email, u.name FROM help_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?', [id]); if (!r) throw new HttpError(404, 'Request not found');
  const reply = (b.reply ?? '').trim();
  await pool.query('UPDATE help_requests SET status = ?, reply = COALESCE(?, reply), replied_by = IF(? IS NULL, replied_by, ?), replied_at = IF(? IS NULL, replied_at, UTC_TIMESTAMP()) WHERE id = ?', [b.status, reply || null, reply || null, req.platform!.userId, reply || null, id]);
  if (reply) void sendMail(r.email, `Re: ${r.subject}`, `<p>Hi ${esc(r.name)},</p><p>${esc(reply)}</p><p style="color:#667">You can also see this reply on your Support page in Travel CRM.</p>`).catch(() => {});
  return { id, status: b.status };
}

export async function supportStatus() { const h = await health(); return { ok: h.ok, app_url: config.appUrl }; }
