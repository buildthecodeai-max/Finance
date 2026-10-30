/**
 * Operators are created ONLY from the server, never through the API (so a compromised web session cannot promote itself).
 *   npm run platform:admin -- grant <email> <readonly|support|billing|admin>
 *   npm run platform:admin -- revoke <email>
 *   npm run platform:admin -- list
 *
 * Roles:  readonly = look at everything (audited) · support = + read-only customer sessions · billing = + trials, plans, invoiced access
 *         admin    = everything, including suspending / releasing a customer.
 * Risky actions also need a fresh authenticator code (step-up). The user must already exist and must enable 2FA before the console opens.
 */
import 'dotenv/config';
import { pool } from '../db.js';
import { OperatorRole, setPlatformAdmin } from '../services/platform.js';

const [cmd, email, role] = process.argv.slice(2);
try {
  if (cmd === 'list') { const [r]: any = await pool.query('SELECT email, name, platform_role role, totp_enabled FROM users WHERE is_platform_admin = 1'); console.table(r); }
  else if (cmd === 'grant' && email && role) { await setPlatformAdmin(email, role as OperatorRole); console.log(`${email}: operator role ${role}`); }
  else if (cmd === 'revoke' && email) { await setPlatformAdmin(email, null); console.log(`revoked platform access: ${email}`); }
  else { console.error('usage: platform:admin grant <email> <readonly|support|billing|admin> | revoke <email> | list'); process.exitCode = 1; }
} catch (e: any) { console.error(e.message); process.exitCode = 1; }
await pool.end();
