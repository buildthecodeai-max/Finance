import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal } from './ui';

type Target = { client_id: number; name: string; phone?: string | null };
const TEMPLATES: { key: string; label: string; text: (n: string, a: string) => string }[] = [
  { key: 'blank', label: 'Write my own', text: () => '' },
  { key: 'confirm', label: 'Booking confirmed', text: (n, a) => `Hi ${n}, your booking with ${a} is confirmed. We'll send your documents soon. Thank you!` },
  { key: 'payment', label: 'Payment reminder', text: (n, a) => `Hi ${n}, a friendly reminder that a payment for your trip with ${a} is due. Please let us know once it's done. Thank you.` },
  { key: 'docs', label: 'Documents ready', text: (n, a) => `Hi ${n}, your travel documents are ready. Please contact ${a} to collect or receive them.` },
  { key: 'trip', label: 'Safe travels', text: (n, a) => `Hi ${n}, wishing you a safe and wonderful trip! If you need anything while you're away, contact ${a}.` },
  { key: 'bday', label: 'Birthday wishes', text: (n, a) => `Happy birthday, ${n}! Warm wishes from all of us at ${a}.` },
];
const first = (n: string) => n.trim().split(/\s+/)[0] || n;

/** Texts one client. Needs SMS to be connected (Settings → Text messages); explains what to do when it isn't. */
export function SendSms({ target, entity, onClose, onSent }: { target: Target; entity?: { type: 'booking' | 'invoice' | 'quote' | 'visa' | 'umrah' | 'client'; id: number }; onClose(): void; onSent(msg: string): void }) {
  const { can, agency } = useAuth(); const [ready, setReady] = useState<boolean | null>(null);
  const [to, setTo] = useState(target.phone ?? ''); const [tpl, setTpl] = useState('blank'); const [body, setBody] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api('/sms/status').then((s) => setReady(!!s.configured)).catch(() => setReady(false)); }, []);
  const pick = (k: string) => { setTpl(k); setBody(TEMPLATES.find((t) => t.key === k)!.text(first(target.name), agency?.name ?? 'us')); };
  const send = async () => {
    setBusy(true); setErr('');
    try { await api('/sms/send', 'POST', { client_id: target.client_id, to: to.trim() || undefined, body: body.trim(), entity_type: entity?.type ?? 'client', entity_id: entity?.id ?? target.client_id }); onSent(`Text sent to ${target.name}.`); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const segs = body.length <= 160 ? 1 : Math.ceil(body.length / 153);
  return <Modal title={`Text ${target.name}`} onClose={onClose}>
    {ready === null ? <p className="text-sm text-muted">Checking…</p> : !ready ? <>
      <p className="text-sm mb-3">Text messages aren't set up yet.{can('admin') ? <> Connect your SMS account under <Link className="underline text-accent" to="/settings">Settings → Text messages</Link> and you can text clients from here.</> : ' Ask an admin to connect it under Settings → Text messages.'}</p>
      <div className="flex justify-end"><button className="btn-ghost" onClick={onClose}>Close</button></div></> : <>
      <Err e={err} />
      <Field label="Phone number" hint={to ? 'Include the country code, e.g. +92 300 1234567' : `${target.name} has no phone number saved — type one here`}><input className="input num" value={to} onChange={(e) => setTo(e.target.value)} placeholder="+92 300 1234567" autoComplete="off" /></Field>
      <Field label="Start from a template"><select className="input" value={tpl} onChange={(e) => pick(e.target.value)}>{TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></Field>
      <Field label="Message" hint={`${body.length} characters · ${segs} text${segs === 1 ? '' : 's'}${body.length > 480 ? ' — too long' : ''}`}><textarea className="input" rows={4} maxLength={480} autoFocus value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !body.trim() || !to.trim()} onClick={send}>{busy ? 'Sending…' : 'Send text'}</button></div></>}
  </Modal>;
}
