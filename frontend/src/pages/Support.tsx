import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, CheckCircle2, Clock, Globe, LifeBuoy, Mail, MessageSquarePlus, Phone, Search, Send, ShieldCheck, Wrench, CreditCard, Lightbulb, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Err, Page, Skeleton } from '../components/ui';

const CATS: { key: string; label: string; hint: string; icon: LucideIcon }[] = [
  { key: 'question', label: 'A question', hint: 'How do I…?', icon: Lightbulb }, { key: 'problem', label: 'Something is wrong', hint: 'A bug or an error', icon: Wrench },
  { key: 'billing', label: 'Billing', hint: 'Plans, invoices, payments', icon: CreditCard }, { key: 'request', label: 'A feature request', hint: 'An idea to improve the app', icon: MessageSquarePlus },
];
const STATUS: Record<string, { label: string; hue: string }> = { open: { label: 'Received', hue: 'warn' }, in_progress: { label: 'Being looked at', hue: 'info' }, resolved: { label: 'Resolved', hue: 'success' } };
const ago = (d: any) => { const t = new Date(String(d).includes('T') ? d : `${String(d).replace(' ', 'T')}Z`).getTime(), s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const left = (d: any) => { const ms = new Date(String(d).includes('T') ? d : `${String(d).replace(' ', 'T')}Z`).getTime() - Date.now(); if (ms <= 0) return 'expired'; const m = Math.round(ms / 60000); return m >= 60 ? `${Math.round(m / 60)} h left` : `${m} min left`; };

/** The agency's Support page: how to reach the team, what is happening on the platform, the agency's own requests, and who can currently see its workspace. */
export default function Support() {
  const { can } = useAuth(); const nav = useNavigate(); const admin = can('admin'), canSend = can('admin', 'finance_manager', 'agent');
  const [info, setInfo] = useState<any>(null); const [reqs, setReqs] = useState<any[] | null>(null); const [access, setAccess] = useState<any[] | null>(null);
  const [q, setQ] = useState(''); const [cat, setCat] = useState('question'); const [subject, setSubject] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [sent, setSent] = useState('');
  const load = () => { api('/support/info').then(setInfo).catch(() => setInfo({ contact: {}, status: { ok: true } })); api('/support/requests').then(setReqs).catch(() => setReqs([])); if (admin) api('/admin/support-access').then(setAccess).catch(() => setAccess([])); };
  useEffect(() => { load(); }, []);
  const send = async () => {
    setBusy(true); setErr(''); setSent('');
    try { await api('/support/requests', 'POST', { category: cat, subject: subject.trim(), message: message.trim() }); setSubject(''); setMessage(''); setSent('Thanks, we have your message. You will see our reply right here, and by email.'); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const endAccess = async (id: number) => { try { await api(`/admin/support-access/${id}/revoke`, 'POST'); load(); } catch (e: any) { setErr(e.message); } };
  const c = info?.contact ?? {}; const hasContact = !!(c.email || c.phone || c.url || c.hours); const live = (access ?? []).filter((s) => !s.revoked_at && new Date(s.expires_at) > new Date());
  const tiles: [LucideIcon, string, string | null, string | null][] = [[Mail, 'Email', c.email || null, c.email ? `mailto:${c.email}` : null], [Phone, 'Phone', c.phone || null, c.phone ? `tel:${c.phone.replace(/\s/g, '')}` : null], [Globe, 'Help centre', c.url ? c.url.replace(/^https:\/\//, '') : null, c.url || null], [Clock, 'Hours', c.hours || null, null]];

  return (
    <Page title="Support" description="Get help, send us a message, and see who has access to your workspace.">
      <section className="hero-mesh mb-5 rounded-2xl border border-line p-5 md:p-7" aria-label="How can we help">
        <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 max-w-2xl">
          <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium backdrop-blur ${!info ? 'border-line text-muted' : info.status.ok ? 'border-success/40 bg-success/10 text-success' : 'border-warn/40 bg-warn/10 text-warn'}`}>{!info ? 'Checking…' : info.status.ok ? <><span className="live-dot" />All systems normal</> : 'We are having trouble. We are on it.'}</span>
          <h2 className="mt-3 text-2xl font-bold tracking-tight md:text-3xl">How can we help?</h2>
          <form className="relative mt-4 max-w-xl" onSubmit={(e) => { e.preventDefault(); nav(`/help${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`); }}>
            <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input className="input !h-11 pl-10 text-sm" aria-label="Search the user guide" placeholder="Search the user guide, e.g. “refund” or “invoice design”…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn absolute right-1.5 top-1/2 !h-8 -translate-y-1/2" aria-label="Search">Search</button></form>
          <p className="mt-2 text-xs text-muted">Most questions are answered in the <button className="text-accent underline" onClick={() => nav('/help')}>user guide</button>. If not, message us below.</p></div>
          <span className="hidden h-16 w-16 place-items-center rounded-2xl bg-accent/12 bg-accent/10 text-accent md:grid"><LifeBuoy size={30} /></span></div>
      </section>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{tiles.map(([Icon, label, value, href]) => (
        <div key={label} className="card glow-card"><div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{label}</span><span className="grid h-8 w-8 place-items-center rounded-xl bg-accent/10 text-accent"><Icon size={16} /></span></div>
          {!info ? <Skeleton className="mt-2 h-6" /> : value ? (href ? <a className="mt-2 block break-all text-base font-semibold text-accent hover:underline" href={href} {...(href.startsWith('https') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{value}</a> : <div className="mt-2 text-base font-semibold">{value}</div>) : <div className="mt-2 text-sm text-muted">Not provided</div>}</div>))}</div>
      {info && !hasContact && <p className="-mt-2 mb-5 text-xs text-muted">Your platform administrator has not added contact details yet. You can still send a message below.</p>}

      <div className="grid gap-5 xl:grid-cols-5">
        <section className="card !p-0 overflow-hidden xl:col-span-3" aria-label="Send us a message">
          <div className="flex items-start gap-3 border-b border-line/70 px-5 py-4"><span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"><Send size={16} /></span><div><h3 className="font-semibold leading-tight">Send us a message</h3><p className="mt-0.5 text-sm text-muted">Tell us what you need and we will reply here and by email.</p></div></div>
          <div className="px-5 py-4">
            {!canSend ? <p className="text-sm text-muted">Your role can read but not send requests. Ask an Admin to contact support for you.</p> : <>
              <Err e={err} />{sent && <div role="status" className="mb-3 flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"><CheckCircle2 size={16} className="mt-0.5 shrink-0" />{sent}</div>}
              <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4" role="radiogroup" aria-label="What is it about">{CATS.map((k) => { const I = k.icon; return <button key={k.key} type="button" role="radio" aria-checked={cat === k.key} onClick={() => setCat(k.key)} className={`rounded-xl border p-2.5 text-left transition ${cat === k.key ? 'border-accent bg-accent/10' : 'border-line hover:bg-surface2'}`}><I size={15} className={cat === k.key ? 'text-accent' : 'text-muted'} /><div className="mt-1 text-sm font-medium">{k.label}</div><div className="text-[11px] text-muted">{k.hint}</div></button>; })}</div>
              <label className="mb-3 block"><span className="mb-1 block text-xs font-medium text-muted">Title</span><input className="input" maxLength={160} placeholder="A short summary, e.g. “Invoice PDF is blank”" value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
              <label className="mb-1 block"><span className="mb-1 block text-xs font-medium text-muted">Details</span><textarea className="input" rows={6} maxLength={4000} placeholder="What were you doing, what did you expect, and what happened instead? Include invoice or booking numbers if it helps." value={message} onChange={(e) => setMessage(e.target.value)} /></label>
              <div className="mb-3 text-right text-[11px] text-muted num">{message.length} / 4000</div>
              <div className="flex justify-end"><button className="btn" disabled={busy || subject.trim().length < 3 || message.trim().length < 10} onClick={send}><Send size={15} />{busy ? 'Sending…' : 'Send message'}</button></div></>}
          </div>
        </section>

        <div className="space-y-5 xl:col-span-2">
          <section className="card !p-0 overflow-hidden" aria-label="Your requests">
            <div className="flex items-center gap-2 border-b border-line/70 px-5 py-3.5 text-sm font-semibold"><BookOpen size={15} className="text-accent" />Your requests{reqs && reqs.length > 0 && <span className="rounded-full bg-surface2 px-2 py-0.5 text-[11px] font-normal text-muted num">{reqs.length}</span>}</div>
            {!reqs ? <Skeleton className="m-4 h-28" /> : !reqs.length ? <div className="px-5 py-8 text-center text-sm text-muted">Nothing yet. When you send a message it appears here with our reply.</div>
              : <ul className="max-h-[32rem] divide-y divide-line/70 overflow-auto">{reqs.map((r) => { const st = STATUS[r.status] ?? STATUS.open; return (
                <li key={r.id} className="px-5 py-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="truncate text-sm font-medium">{r.subject}</div><div className="text-[11px] text-muted">{CATS.find((k) => k.key === r.category)?.label ?? r.category} · {ago(r.created_at)}{r.user_name ? ` · ${r.user_name}` : ''}</div></div>
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `rgb(var(--${st.hue}) / .14)`, color: `rgb(var(--${st.hue}))` }}>{st.label}</span></div>
                  <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs text-muted">{r.message}</p>
                  {r.reply && <div className="mt-2 rounded-lg border-l-2 border-accent bg-surface2/60 px-3 py-2 text-sm"><div className="mb-0.5 text-[11px] font-medium text-accent">Reply from support{r.replied_at ? ` · ${ago(r.replied_at)}` : ''}</div><p className="whitespace-pre-wrap">{r.reply}</p></div>}</li>); })}</ul>}
          </section>

          {admin && <section className="card !p-0 overflow-hidden" aria-label="Who can see your workspace">
            <div className="flex items-center gap-2 border-b border-line/70 px-5 py-3.5 text-sm font-semibold"><ShieldCheck size={15} className="text-accent" />Support access to your workspace</div>
            <div className="px-5 py-3"><p className="text-xs text-muted">To help with a problem, our team can open a read-only session in your workspace for a short time. They cannot change anything. You can end it at any time.</p></div>
            {!access ? <Skeleton className="m-4 h-16" /> : !access.length ? <div className="px-5 pb-5 text-sm text-muted">Nobody has accessed your workspace.</div>
              : <ul className="divide-y divide-line/70 border-t border-line/70">{access.slice(0, 8).map((s) => { const on = !s.revoked_at && new Date(s.expires_at) > new Date(); return (
                <li key={s.id} className="flex items-start gap-3 px-5 py-2.5"><div className="min-w-0 flex-1"><div className="truncate text-sm">{s.operator}</div><div className="truncate text-xs text-muted">{s.reason}</div><div className="text-[11px] text-muted">{ago(s.created_at)}</div></div>
                  {on ? <><span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">Live · {left(s.expires_at)}</span><button className="btn-ghost !h-7 !px-2 text-xs text-danger" onClick={() => endAccess(s.id)}>End access</button></> : <span className="rounded-full bg-surface2 px-2 py-0.5 text-[11px] text-muted">{s.revoked_at ? 'Ended' : 'Expired'}</span>}</li>); })}</ul>}
            {live.length > 0 && <div className="border-t border-line/70 bg-success/5 px-5 py-2 text-xs text-success">{live.length === 1 ? 'Someone has' : `${live.length} people have`} access right now.</div>}
          </section>}
        </div>
      </div>
    </Page>
  );
}
