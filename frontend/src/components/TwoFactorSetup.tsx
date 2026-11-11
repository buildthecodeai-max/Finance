import { useState } from 'react';
import { Copy, LogOut, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { Err } from './ui';

/** Full-screen step shown when an administrator requires two-factor sign-in and the person has not set it up yet. Nothing else in the app opens until it is done. */
export default function TwoFactorSetup({ name, onDone, onLogout }: { name?: string; onDone(): void; onLogout(): void }) {
  const [s, setS] = useState<any>(null); const [code, setCode] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [copied, setCopied] = useState(false);
  const start = async () => { setBusy(true); setErr(''); try { setS(await api('/auth/2fa/setup', 'POST', {})); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const enable = async () => { setBusy(true); setErr(''); try { await api('/auth/2fa/enable', 'POST', { code: code.trim() }); onDone(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const copy = async () => { try { await navigator.clipboard.writeText(s.secret); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* the key stays selectable */ } };
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="card w-full max-w-lg !p-0 overflow-hidden">
        <div className="hero-mesh border-b border-line p-6"><span className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent/12 bg-accent/10 text-accent"><ShieldCheck size={24} /></span>
          <h1 className="text-xl font-bold tracking-tight">Set up two-factor sign-in</h1>
          <p className="mt-1 text-sm text-muted">{name ? `${name}, your` : 'Your'} administrator requires an authenticator app for your account. It takes a minute, and then you are in.</p></div>
        <div className="space-y-4 p-6">
          <Err e={err} />
          {!s ? <>
            <ol className="space-y-2 text-sm"><li className="flex gap-2"><b className="text-accent">1.</b>Install an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</li><li className="flex gap-2"><b className="text-accent">2.</b>Add this account using the key we show next.</li><li className="flex gap-2"><b className="text-accent">3.</b>Type the 6-digit code the app shows to finish.</li></ol>
            <button className="btn w-full" disabled={busy} onClick={start}>{busy ? 'Starting…' : 'Start setup'}</button></>
            : <>
              <div><div className="mb-1 text-xs font-medium text-muted">Setup key</div>
                <div className="flex gap-2"><input className="input num text-xs" readOnly value={s.secret} aria-label="Setup key" onFocus={(e) => e.target.select()} /><button className="btn-ghost shrink-0" onClick={copy}><Copy size={14} />{copied ? 'Copied' : 'Copy'}</button></div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted">In your app choose “Enter a setup key” and paste this. On a phone you can also <a className="text-accent underline" href={s.otpauth}>open it in your app</a>. Keep this key private.</p></div>
              <div><div className="mb-1 text-xs font-medium text-muted">6-digit code from the app</div>
                <div className="flex gap-2"><input className="input num w-40 text-lg tracking-widest" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6 && !busy) enable(); }} />
                  <button className="btn" disabled={busy || code.length !== 6} onClick={enable}>{busy ? 'Checking…' : 'Turn on 2FA'}</button></div></div></>}
          <button className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg" onClick={onLogout}><LogOut size={12} />Sign out instead</button>
        </div>
      </div>
    </div>
  );
}
