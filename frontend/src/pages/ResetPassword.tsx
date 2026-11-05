import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Plane } from 'lucide-react';
import { Err } from '../components/ui';
import { ThemeMenuButton } from '../components/ThemeToggle';

async function post(path: string, body: unknown) {
  const r = await fetch(`/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? 'Something went wrong'); return j;
}
const Shell = ({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) => (
  <div className="min-h-screen flex flex-col p-6"><div className="flex justify-end"><ThemeMenuButton /></div>
    <main className="flex-1 grid place-items-center"><div className="w-full max-w-sm">
      <div className="flex items-center gap-2.5 mb-8"><div className="h-9 w-9 rounded-xl bg-accent text-accent-ink grid place-items-center"><Plane size={19} /></div><span className="font-semibold">Travel CRM</span></div>
      <h1 className="text-2xl font-semibold">{title}</h1><p className="text-sm text-muted mt-1 mb-6">{sub}</p>{children}</div></main></div>
);

/** /forgot-password — ask for a link. The response is identical whether or not the address has an account. */
export function ForgotPassword() {
  const [email, setEmail] = useState(''); const [done, setDone] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(''); try { setDone((await post('forgot', { email })).message); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } };
  return (
    <Shell title="Forgot your password?" sub="Enter your email and we'll send you a link to choose a new one.">
      {done ? <div className="rounded-lg border border-success/30 bg-success/10 text-success text-sm p-3 flex gap-2"><CheckCircle2 size={16} className="mt-0.5 shrink-0" /><span>{done}</span></div> :
        <form onSubmit={submit}><Err e={err} />
          <label className="block mb-4"><span className="block text-xs font-medium text-muted mb-1">Email</span><input className="input !h-11" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <button className="btn w-full !h-11" disabled={busy || !email}>{busy ? 'Sending…' : 'Send reset link'}</button></form>}
      <p className="text-sm mt-6"><Link to="/login" className="text-accent hover:underline">Back to sign in</Link></p>
    </Shell>
  );
}

/** /reset-password/:token — choose a new password. */
export default function ResetPassword() {
  const { token = '' } = useParams(); const nav = useNavigate();
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (pw.length < 10) return setErr('Use at least 10 characters.'); if (pw !== pw2) return setErr('The two passwords do not match.');
    setBusy(true); try { await post('reset', { token, password: pw }); setDone(true); window.history.replaceState(null, '', '/reset-password'); setTimeout(() => nav('/login', { replace: true }), 2500); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <Shell title="Choose a new password" sub="You'll be signed out everywhere else. If two-factor authentication is on, you'll still need your code to sign in.">
      {done ? <div className="rounded-lg border border-success/30 bg-success/10 text-success text-sm p-3 flex gap-2"><CheckCircle2 size={16} className="mt-0.5 shrink-0" /><span>Password changed. Redirecting to sign in…</span></div> :
        <form onSubmit={submit}><Err e={err} />
          <label className="block mb-4"><span className="block text-xs font-medium text-muted mb-1">New password (10+ characters)</span><input className="input !h-11" type="password" autoComplete="new-password" required autoFocus value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <label className="block mb-4"><span className="block text-xs font-medium text-muted mb-1">Repeat new password</span><input className="input !h-11" type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
          <button className="btn w-full !h-11" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
          {err.includes('invalid or has expired') && <p className="text-sm mt-4"><Link to="/forgot-password" className="text-accent hover:underline">Request a new link</Link></p>}</form>}
    </Shell>
  );
}
