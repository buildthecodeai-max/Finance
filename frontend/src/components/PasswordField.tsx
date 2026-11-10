import { useState } from 'react';
import { Check, Copy, Eye, EyeOff, Wand2 } from 'lucide-react';

const LOWER = 'abcdefghijkmnopqrstuvwxyz', UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ', DIGIT = '23456789', SYMBOL = '#$%*+-=?@';
/** A random password that is easy to read out loud: no 0/O, 1/l/I. Always has a lower case letter, an upper case letter, a digit and a symbol. */
export function generatePassword(len = 14): string {
  const pick = (set: string) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)]; const all = LOWER + UPPER + DIGIT + SYMBOL;
  while (chars.length < len) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
export const passwordOk = (p: string) => p.length >= 10;
/** 0 = too short, then 1 (okay) to 4 (very strong). */
const strength = (p: string) => (p.length < 10 ? 0 : Math.min(4, 1 + (p.length >= 14 ? 1 : 0) + (/[a-z]/.test(p) && /[A-Z]/.test(p) ? 1 : 0) + (/\d/.test(p) && /[^A-Za-z0-9]/.test(p) ? 1 : 0)));
const LEVEL = [['Too short', 'danger'], ['Okay', 'warn'], ['Good', 'info'], ['Strong', 'success'], ['Very strong', 'success']] as const;

/** Password input with show/hide, a generator and a copy button, for setting a password on someone else's behalf. */
export function PasswordField({ value, onChange, autoFocus }: { value: string; onChange(v: string): void; autoFocus?: boolean }) {
  const [show, setShow] = useState(false); const [copied, setCopied] = useState(false);
  const sc = strength(value); const copy = async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setShow(true); } };
  return (
    <div>
      <div className="flex gap-2">
        <div className="relative flex-1"><input className="input num pr-9" type={show ? 'text' : 'password'} autoComplete="new-password" autoFocus={autoFocus} aria-label="New password" value={value} onChange={(e) => onChange(e.target.value)} placeholder="At least 10 characters" />
          <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-fg" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((s) => !s)}>{show ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
        <button type="button" className="btn-ghost shrink-0" onClick={() => { onChange(generatePassword()); setShow(true); }}><Wand2 size={14} />Generate</button>
        <button type="button" className="btn-ghost shrink-0" disabled={!value} onClick={copy} aria-label="Copy password">{copied ? <Check size={14} /> : <Copy size={14} />}</button></div>
      {value && <div className="mt-1.5 flex items-center gap-2" aria-live="polite"><div className="flex flex-1 gap-1">{[1, 2, 3, 4].map((i) => <span key={i} className="h-1 flex-1 rounded-full" style={{ background: i <= Math.max(1, sc) ? `rgb(var(--${LEVEL[sc][1]}))` : 'rgb(var(--surface-2))' }} />)}</div><span className="text-[11px] font-medium" style={{ color: `rgb(var(--${LEVEL[sc][1]}))` }}>{LEVEL[sc][0]}</span></div>}
    </div>
  );
}
