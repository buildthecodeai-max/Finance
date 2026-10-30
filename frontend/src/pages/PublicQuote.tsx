import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CalendarDays, CheckCircle2, Clock, Plane, XCircle } from 'lucide-react';
import { Err } from '../components/ui';
import { ThemeMenuButton } from '../components/ThemeToggle';

const money = (n: number, c: string) => new Intl.NumberFormat('en', { style: 'currency', currency: c }).format(n);
async function call(token: string, path = '', method = 'GET', body?: unknown) {
  const r = await fetch(`/api/public/quotes/${token}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? 'Something went wrong'); return j;
}
const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-screen">
    <header className="h-14 border-b border-line bg-surface/80 backdrop-blur flex items-center justify-between px-4 md:px-8"><div className="flex items-center gap-2"><div className="h-7 w-7 rounded-lg bg-accent text-accent-ink grid place-items-center"><Plane size={15} /></div><span className="text-sm font-semibold">Travel quote</span></div><ThemeMenuButton /></header>
    <div className="max-w-3xl mx-auto p-4 md:p-8">{children}</div>
  </div>
);

/** Client-facing quote page. Deliberately standalone: no login, no internal data, no app navigation. */
export default function PublicQuote() {
  const { token = '' } = useParams(); const [q, setQ] = useState<any>(null); const [err, setErr] = useState(''); const [done, setDone] = useState('');
  const [name, setName] = useState(''); const [opt, setOpt] = useState(''); const [mode, setMode] = useState<'' | 'changes' | 'decline'>(''); const [text, setText] = useState('');
  const load = () => call(token).then((d) => { setQ(d); setOpt((o) => o || d.options[0]?.name); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [token]);
  const act = async (fn: () => Promise<any>, ok: string) => { try { await fn(); setDone(ok); setErr(''); await load(); } catch (e: any) { setErr(e.message); } };
  if (err && !q) return <Shell><div className="card text-center py-12"><XCircle className="mx-auto text-muted mb-3" size={32} /><h1 className="text-xl font-semibold mb-1">Quote unavailable</h1><p className="text-muted text-sm">{err}</p></div></Shell>;
  if (!q) return <Shell><div className="space-y-3"><div className="skeleton h-8 w-2/3" /><div className="skeleton h-40" /><div className="skeleton h-40" /></div></Shell>;
  const open = q.status === 'sent', accepted = ['accepted', 'converted'].includes(q.status);
  return (
    <Shell>
      <div className="text-xs font-medium text-accent mb-1">{q.agency}</div>
      <h1 className="text-3xl font-semibold">{q.title}</h1>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted mt-2 mb-6"><span className="num">{q.quote_no} · version {q.version}</span><span className="inline-flex items-center gap-1.5"><Clock size={14} />Valid until <b className="num text-fg">{q.valid_until}</b></span></div>
      {!open && <div className={`card mb-5 flex items-start gap-3 text-sm ${accepted ? 'border-success/50 bg-success/5' : 'border-warn/50 bg-warn/5'}`}>{accepted ? <CheckCircle2 className="text-success shrink-0" size={20} /> : <Clock className="text-warn shrink-0" size={20} />}
        <div>{accepted ? `Thank you — you accepted “${q.accepted_option}”. Your travel consultant will be in touch.` : q.status === 'expired' ? 'This quote has expired. Please contact us for an updated quote.' : q.status === 'declined' ? 'You declined this quote.' : q.status === 'changes_requested' ? 'You asked for changes — we will send an updated quote.' : `Status: ${q.status}`}</div></div>}
      {done && <div className="text-success text-sm mb-3" role="status">{done}</div>}<Err e={err} />
      {q.options.map((o: any) => {
        const selected = open && opt === o.name;
        return (
          <section key={o.name} className={`card mb-4 !p-0 overflow-hidden transition ${selected ? 'border-accent ring-2 ring-accent/20' : ''}`}>
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-line bg-surface2/40">
              {open && q.options.length > 1 ? <label className="flex items-center gap-2.5 font-semibold cursor-pointer"><input type="radio" className="accent-[rgb(var(--accent))] h-4 w-4" checked={opt === o.name} onChange={() => setOpt(o.name)} />{o.name}</label> : <div className="font-semibold">{q.options.length > 1 ? o.name : 'Your trip'}</div>}
              <div className="num text-xl font-semibold">{money(o.total, q.currency)}</div></div>
            <ul className="divide-y divide-line/70">{o.items.map((c: any, i: number) => (
              <li key={i} className="flex items-start justify-between gap-4 px-5 py-3 text-sm"><div><div className="font-medium">{c.description}</div>
                <div className="text-xs text-muted capitalize flex items-center gap-1.5 mt-0.5">{c.product_type}{c.service_start && <><CalendarDays size={12} /><span className="num">{c.service_start}{c.service_end ? ` → ${c.service_end}` : ''}</span></>}</div></div>
                <div className="num shrink-0">{money(c.net_total + c.tax_total, q.currency)}</div></li>))}</ul>
            <div className="px-5 py-2 text-xs text-muted text-right num border-t border-line/70">includes {q.tax_label} {money(o.tax, q.currency)}</div>
          </section>);
      })}
      <div className="grid sm:grid-cols-2 gap-4 mb-4">
        {([['inclusions', 'Included'], ['exclusions', 'Not included'], ['payment_terms', 'Payment terms'], ['cancellation_terms', 'Cancellation terms']] as const).map(([k, l]) => q[k] && <div key={k} className="card"><h3 className="text-sm font-semibold mb-1">{l}</h3><p className="text-sm text-muted whitespace-pre-wrap">{q[k]}</p></div>)}</div>
      {open && <div className="card sticky bottom-4 shadow-pop border-accent/30">
        {mode === '' ? <><label className="block text-xs font-medium text-muted mb-1" htmlFor="pq-name">Your full name (as your acceptance)</label><input id="pq-name" className="input !h-11 mb-3" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          <div className="flex flex-wrap gap-2"><button className="btn !h-11" disabled={name.trim().length < 2} onClick={() => act(() => call(token, '/accept', 'POST', { name, option: opt }), 'Accepted — thank you!')}>Accept {q.options.length > 1 ? opt : 'quote'}</button>
            <button className="btn-ghost !h-11" onClick={() => setMode('changes')}>Request changes</button><button className="btn-ghost !h-11" onClick={() => setMode('decline')}>Decline</button></div></>
          : <><label className="block text-xs font-medium text-muted mb-1" htmlFor="pq-text">{mode === 'changes' ? 'What would you like changed?' : 'Reason (optional)'}</label><textarea id="pq-text" className="input h-24 mb-3" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex gap-2"><button className="btn" disabled={mode === 'changes' && !text} onClick={() => act(() => call(token, mode === 'changes' ? '/changes' : '/decline', 'POST', mode === 'changes' ? { message: text } : { reason: text }), 'Thank you — we have received your response.')}>Send</button><button className="btn-ghost" onClick={() => setMode('')}>Back</button></div></>}</div>}
    </Shell>
  );
}
