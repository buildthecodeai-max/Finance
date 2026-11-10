import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { sha256 } from '../crypto.js';
import { sendMail } from './email.js';

export const MIN_PASSWORD = 10;

/**
 * Sets someone's password on their behalf (a platform operator, or the owner of their agency).
 * Ends every session they have, clears any sign-in lockout, and tells them by email. The password itself is never logged or emailed.
 */
export async function setPasswordFor(userId: number, plain: string, by: string) {
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(plain, 12), userId]);
  const [r]: any = await pool.query('UPDATE refresh_tokens SET revoked = 1, revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()) WHERE user_id = ? AND revoked = 0', [userId]);
  const [[u]]: any = await pool.query('SELECT email, name FROM users WHERE id = ?', [userId]);
  await pool.query('DELETE FROM login_attempts WHERE email_hash = ?', [sha256(String(u.email).toLowerCase())]);
  void sendMail(u.email, 'Your Travel CRM password was changed', `<p>Hi ${String(u.name).replace(/</g, '&lt;')},</p><p>${by.replace(/</g, '&lt;')} set a new password for your account, and you were signed out everywhere. If you did not expect this, contact your administrator.</p>`).catch(() => {});
  return { email: u.email as string, name: u.name as string, sessions_ended: Number(r.affectedRows) };
}
