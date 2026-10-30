import sg from '@sendgrid/mail';
import { config } from '../config.js';

if (config.sendgridKey) sg.setApiKey(config.sendgridKey);

/** Captured mail in tests so flows that email a link can be exercised end to end. */
export const testOutbox: { to: string; subject: string; html: string }[] = [];

export async function sendMail(to: string, subject: string, html: string) {
  if (process.env.NODE_ENV === 'test') { testOutbox.push({ to, subject, html }); return; }
  if (!config.sendgridKey) { console.warn(`[mail:disabled] ${to} — ${subject}`); return; }
  await sg.send({ to, from: config.mailFrom, subject, html });
}
