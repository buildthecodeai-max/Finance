import { FormEvent, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { BarChart3, Plane, ShieldCheck, Ticket } from 'lucide-react';
import { useAuth } from '../auth';
import { Err } from '../components/ui';
import { ThemeMenuButton } from '../components/ThemeToggle';

const POINTS: [any, string, string][] = [
  [Ticket, 'Quotes to bookings', 'Versioned quotes, secure client acceptance and one-click conversion.'],
  [BarChart3, 'Finance you can trust', 'Double-entry ledger, period locks and reports that reconcile.'],
  [ShieldCheck, 'Built for control', 'Tenant isolation, role-based access and an append-only audit trail.'],
];

export default function Login() {
  const { user, login } = useAuth();
  const [f, setF] = useState({ email: '', password: '', totp: '' });
  const [needTotp, setNeedTotp] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  if (user) return <Navigate to="/" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await login(f.email, f.password, f.totp || undefined); }
    catch (x: any) { if (x.data?.totpRequired) setNeedTotp(true); else setErr(x.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr]">
      <aside className="hidden lg:flex flex-col justify-between p-12 relative overflow-hidden bg-surface border-r border-line">
        <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-accent/15 blur-3xl" aria-hidden /><div className="absolute -bottom-40 -right-24 h-[28rem] w-[28rem] rounded-full bg-info/10 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-2.5"><div className="h-9 w-9 rounded-xl bg-accent text-accent-ink grid place-items-center"><Plane size={19} strokeWidth={2.2} /></div><span className="font-head font-extrabold text-xl"><span className="text-accent">Travel</span> CRM</span></div>
        <div className="relative max-w-md"><h2 className="text-4xl font-semibold leading-tight tracking-tight">The operating system for your travel agency.</h2>
          <ul className="mt-8 space-y-5">{POINTS.map(([Icon, t, d]) => <li key={t} className="flex gap-3"><div className="h-9 w-9 rounded-lg bg-accent/10 text-accent grid place-items-center shrink-0"><Icon size={17} /></div><div><div className="font-medium">{t}</div><div className="text-sm text-muted">{d}</div></div></li>)}</ul></div>
        <div className="relative text-xs text-muted">© Travel CRM</div>
      </aside>
      <main className="flex flex-col p-6">
        <div className="flex justify-end"><ThemeMenuButton /></div>
        <div className="flex-1 grid place-items-center">
          <form onSubmit={submit} className="w-full max-w-sm">
            <div className="lg:hidden flex items-center gap-2.5 mb-8"><div className="h-9 w-9 rounded-xl bg-accent text-accent-ink grid place-items-center"><Plane size={19} /></div><span className="font-head font-extrabold text-xl"><span className="text-accent">Travel</span> CRM</span></div>
            <h1 className="text-2xl font-semibold">Welcome back</h1><p className="text-sm text-muted mt-1 mb-6">Sign in to your agency workspace.</p>
            <Err e={err} />
            <label className="block mb-4"><span className="block text-xs font-medium text-muted mb-1">Email</span><input className="input !h-11" type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoFocus /></label>
            <label className="block mb-4"><span className="block text-xs font-medium text-muted mb-1">Password</span><input className="input !h-11" type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></label>
            {needTotp && <label className="block mb-4"><span className="block text-xs font-medium text-muted mb-1">6-digit authentication code</span><input className="input !h-11 num tracking-widest" inputMode="numeric" autoComplete="one-time-code" value={f.totp} onChange={(e) => setF({ ...f, totp: e.target.value })} autoFocus /></label>}
            <button className="btn w-full !h-11 text-[15px]" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            <p className="text-sm mt-4 text-center"><Link to="/forgot-password" className="text-accent hover:underline">Forgot your password?</Link></p>
          </form>
        </div>
      </main>
    </div>
  );
}
