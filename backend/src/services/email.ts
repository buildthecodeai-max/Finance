import sg from '@sendgrid/mail';
import { config } from '../config.js';

if (config.sendgridKey) sg.setApiKey(config.sendgridKey);

/** Captured mail in tests so flows that email a link can be exercised end to end. */
export type Attachment = { filename: string; content: Buffer; type: string };
export const testOutbox: { to: string; subject: string; html: string; attachments?: Attachment[] }[] = [];

export async function sendMail(to: string, subject: string, html: string, attachments?: Attachment[]) {
  if (process.env.NODE_ENV === 'test') { testOutbox.push({ to, subject, html, ...(attachments ? { attachments } : {}) }); return; }
  if (!config.sendgridKey) { console.warn(`[mail:disabled] ${to} — ${subject}`); return; }
  await sg.send({ to, from: config.mailFrom, subject, html, ...(attachments?.length ? { attachments: attachments.map((a) => ({ content: a.content.toString('base64'), filename: a.filename, type: a.type, disposition: 'attachment' })) } : {}) });
}
