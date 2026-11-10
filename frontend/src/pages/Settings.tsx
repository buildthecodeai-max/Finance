import { ReactNode, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, Banknote, Building2, Check, CheckCircle2, Circle, FileText, Globe2, ImageIcon, Lock, LockOpen, MessageSquare, Percent, ShieldCheck, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Avatar, Err, Field, Modal, Page, Table } from '../components/ui';
import InvoiceDesigns from '../components/InvoiceDesigns';
import { today } from '../lookup';

function SmsCard() {
  const [s, setS] = useState<any>(null); const [f, setF] = useState<any>({ account_sid: '', auth_token: '', from: '', default_cc: '' }); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [test, setTest] = useState(''); const [log, setLog] = useState<any[]>([]); const [busy, setBusy] = useState(false); const [askOff, setAskOff] = useState(false);
  const load = () => { api('/sms/settings').then((r) => { setS(r); if (r.configured) setF((x: any) => ({ ...x, from: r.from, default_cc: r.default_cc ?? '', account_sid: '' })); }); api('/sms/log').then(setLog).catch(() => {}); };
  useEffect(() => { load(); }, []);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => { setBusy(true); try { await api('/sms/settings', 'PUT', { account_sid: f.account_sid.trim() || undefined, auth_token: f.auth_token.trim() || undefined, from: f.from.trim(), default_cc: f.default_cc.trim() || null }); setErr(''); setMsg('Saved. Send yourself a test message below to check it works.'); setF({ ...f, auth_token: '' }); load(); } catch (e: any) { setErr(e.message); setMsg(''); } finally { setBusy(false); } };
  const sendTest = async () => { setBusy(true); try { await api('/sms/test', 'POST', { to: test }); setErr(''); setMsg(`Test message sent to ${test}.`); load(); } catch (e: any) { setErr(e.message); setMsg(''); } finally { setBusy(false); } };
  const disconnect = async () => { await api('/sms/settings', 'DELETE'); setMsg('Text messages disconnected.'); setF({ account_sid: '', auth_token: '', from: '', default_cc: '' }); load(); };
  if (!s) return null;
  return (<div className="card !p-0 overflow-hidden">
    <div className="flex items-start gap-3 border-b border-line/70 px-5 py-4"><span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"><MessageSquare size={17} /></span><div className="min-w-0 flex-1"><h3 className="font-semibold leading-tight">Text messages (SMS)</h3></div>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${s.configured ? 'bg-success/15 text-success' : 'bg-surface2 text-muted'}`}>{s.configured ? 'Connected' : 'Not connected'}</span></div>
    <div className="px-5 py-4">
    <p className="text-sm text-muted mb-3">Send clients booking confirmations, payment reminders and birthday wishes by text. Uses your own <a className="underline" href="https://www.twilio.com" target="_blank" rel="noreferrer">Twilio</a> account — you pay Twilio for the messages. {s.configured ? <>Connected as <b className="text-fg">{s.account_sid}</b>, sending from <b className="text-fg">{s.from}</b>.</> : 'Not connected yet.'}</p>
    <Err e={err} />{msg && <div className="text-accent text-sm mb-3">{msg}</div>}
    <div className="grid sm:grid-cols-2 gap-x-3">
      <Field label="Account SID" hint={s.configured ? 'Leave blank to keep the saved one' : 'Starts with AC — from your Twilio console'}><input className="input num" value={f.account_sid} onChange={set('account_sid')} autoComplete="off" placeholder={s.configured ? s.account_sid : 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'} /></Field>
      <Field label="Auth token" hint={s.configured ? 'Leave blank to keep the saved one' : 'Stored encrypted and never shown again'}><input className="input num" type="password" value={f.auth_token} onChange={set('auth_token')} autoComplete="new-password" /></Field>
      <Field label="Send from" hint="Your Twilio number (+14155550100) or a sender name"><input className="input" value={f.from} onChange={set('from')} /></Field>
      <Field label="Your country code" hint="So 0300 1234567 becomes +92 300 1234567"><input className="input num" value={f.default_cc} onChange={set('default_cc')} placeholder="+92" /></Field></div>
    <div className="flex flex-wrap gap-2 mb-4"><button className="btn" disabled={busy || !f.from.trim() || (!s.configured && (!f.account_sid.trim() || !f.auth_token.trim()))} onClick={save}>{s.configured ? 'Save changes' : 'Connect'}</button>{s.configured && <button className="btn-ghost text-danger" onClick={() => setAskOff(true)}>Disconnect</button>}</div>
    {s.configured && <div className="flex flex-wrap items-end gap-2 mb-4"><Field label="Send a test message to"><input className="input num" value={test} onChange={(e) => setTest(e.target.value)} placeholder="+92 300 1234567" /></Field><button className="btn-ghost mb-3" disabled={busy || !test.trim()} onClick={sendTest}>Send test</button></div>}
    {log.length > 0 && <><h4 className="text-sm font-bold mb-2">Recent texts</h4><Table rows={log.slice(0, 15)} noun="texts" cols={[{ h: 'When', render: (r: any) => new Date(r.created_at).toLocaleString() }, { h: 'To', render: (r: any) => <>{r.client_name ?? ''}<div className="text-xs text-muted num">{r.to_number}</div></> }, { h: 'Message', render: (r: any) => <span className="text-xs">{r.body}</span> }, { h: 'Result', render: (r: any) => (r.status === 'sent' ? <span className="text-success">Sent</span> : <span className="text-danger" title={r.error}>Failed</span>) }]} /></>}
    </div>
    {askOff && <Modal title="Disconnect text messages?" onClose={() => setAskOff(false)}><p className="mb-3 text-sm">Clients will no longer get texts from the app. Your Twilio account is not affected, and you can reconnect any time.</p>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setAskOff(false)}>Keep connected</button><button className="btn !bg-danger" onClick={async () => { await disconnect(); setAskOff(false); }}>Disconnect</button></div></Modal>}
  </div>);
}

const SAVED = ['name', 'tax_label', 'address', 'timezone', 'invoice_prefix', 'min_margin_pct', 'approval_threshold', 'dual_control_runs', 'fx_max_age_days', 'commission_trigger', 'bill_tolerance_pct', 'payment_instructions', 'tax_number', 'bank_name', 'bank_account_name', 'bank_account_number', 'bank_routing', 'bank_iban', 'bank_swift'];
const BANK: [string, string][] = [['bank_name', 'Bank name'], ['bank_account_name', 'Account name'], ['bank_account_number', 'Account number'], ['bank_routing', 'BSB / Sort code / Routing no.'], ['bank_iban', 'IBAN'], ['bank_swift', 'SWIFT / BIC']];
const TABS: [string, string, any][] = [['profile', 'Profile', Building2], ['invoices', 'Branding & invoices', FileText], ['controls', 'Financial controls', ShieldCheck], ['messaging', 'Messaging', MessageSquare]];
const norm = (v: any) => (v === null || v === undefined ? '' : String(v));

/** A titled block inside a tab: an icon, what it is, then its fields. */
const Section = ({ title, hint, icon: Icon, children, aside }: { title: string; hint?: ReactNode; icon?: LucideIcon; children: ReactNode; aside?: ReactNode }) => (
  <section className="card !p-0 overflow-hidden">
    <div className="flex items-start gap-3 border-b border-line/70 px-5 py-4">
      {Icon && <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"><Icon size={17} /></span>}
      <div className="min-w-0 flex-1"><h2 className="font-semibold leading-tight">{title}</h2>{hint && <p className="mt-0.5 max-w-2xl text-sm text-muted">{hint}</p>}</div>{aside}</div>
    <div className="px-5 py-4">{children}</div>
  </section>
);
/** An on/off switch with a label, for settings that are a plain yes or no. */
const Switch = ({ on, onChange, label, disabled }: { on: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) => (
  <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)} className="flex h-9 items-center gap-3 text-sm disabled:opacity-60">
    <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-surface2 border border-line'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} /></span>{label}</button>
);

export default function Settings() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [s, setS] = useState<any>(null); const [base, setBase] = useState<any>(null); const [locks, setLocks] = useState<any[]>([]);
  const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [lockErr, setLockErr] = useState(''); const [busy, setBusy] = useState(false);
  const [lockDate, setLockDate] = useState(today());
  const [logoUrl, setLogoUrl] = useState<string | null>(null); const [logoErr, setLogoErr] = useState(''); const [logoMsg, setLogoMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null); const [reopen, setReopen] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);   // bumped when the letterhead, bank details or logo change, so the invoice previews are redrawn
  const admin = can('admin'), finance = can('admin', 'finance_manager');
  const tabs = TABS.filter(([k]) => k !== 'messaging' || admin);
  const tab = tabs.some(([k]) => k === params.get('tab')) ? params.get('tab')! : 'profile';
  const loadLogo = () => api('/admin/logo').then((r: any) => setLogoUrl(r.url)).catch(() => {});
  const load = () => { api('/admin/settings').then((r: any) => { setS(r); setBase(r); if (r.has_logo && admin) loadLogo(); }); if (finance) api('/admin/period-locks').then(setLocks); };
  useEffect(() => { load(); }, []);
  const dirty = !!(admin && s && base && SAVED.some((k) => norm(s[k]) !== norm(base[k])));
  useEffect(() => { if (!dirty) return; const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h); }, [dirty]);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api('/admin/settings', 'PUT', { name: s.name, tax_label: s.tax_label, address: s.address, timezone: s.timezone, invoice_prefix: s.invoice_prefix, min_margin_pct: Number(s.min_margin_pct) || 0, approval_threshold: Number(s.approval_threshold) || 0, dual_control_runs: !!s.dual_control_runs, fx_max_age_days: Number(s.fx_max_age_days ?? 7), commission_trigger: s.commission_trigger, bill_tolerance_pct: Number(s.bill_tolerance_pct) || 0, payment_instructions: s.payment_instructions || null, tax_number: s.tax_number || null, ...Object.fromEntries(BANK.map(([k]) => [k, s[k] || null])) });
      setS(r); setBase(r); setErr(''); setMsg('Settings saved'); setPreviewKey((k) => k + 1); setTimeout(() => setMsg(''), 4000);
    } catch (e: any) { setErr(e.message); setMsg(''); } finally { setBusy(false); }
  };
  const discard = () => { setS({ ...s, ...Object.fromEntries(SAVED.map((k) => [k, base[k]])) }); setErr(''); };
  const uploadLogo = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) { setLogoErr('Logo must be under 2 MB'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const b64 = (reader.result as string).split(',')[1];
        const r: any = await api('/admin/logo', 'POST', { data: b64, mime: file.type });
        setLogoUrl(r.url); setLogoErr(''); setLogoMsg('Logo saved'); setPreviewKey((k) => k + 1);
        setS((prev: any) => ({ ...prev, has_logo: true }));
      } catch (e: any) { setLogoErr(e.message); }
    };
    reader.readAsDataURL(file);
  };
  const removeLogo = async () => {
    try { await api('/admin/logo', 'DELETE'); setLogoUrl(null); setLogoMsg('Logo removed'); setPreviewKey((k) => k + 1); setS((prev: any) => ({ ...prev, has_logo: false })); }
    catch (e: any) { setLogoErr(e.message); }
  };
  const lock = async (date: string | null) => {
    try { await api('/admin/period-locks', 'POST', { locked_through: date }); setLockErr(''); load(); }
    catch (e: any) { setLockErr(e.message); }
  };
  if (!s) return <Page title="Agency settings"><div className="text-muted">Loading…</div></Page>;
  const set = (k: string) => (e: any) => setS({ ...s, [k]: e.target.value });
  const input = (k: string, extra: any = {}) => <input className="input" value={s[k] ?? ''} onChange={set(k)} disabled={!admin} {...extra} />;

  const bankFilled = BANK.some(([k]) => norm(s[k]).trim());
  const steps: { done: boolean; label: string; tab: string; icon: LucideIcon }[] = [
    { done: !!norm(s.name).trim() && norm(s.address).trim().length > 5, label: 'Name and address', tab: 'profile', icon: Building2 },
    { done: !!norm(s.tax_number).trim(), label: 'Tax registration number', tab: 'profile', icon: Percent },
    { done: !!norm(s.timezone).trim(), label: 'Time zone', tab: 'profile', icon: Globe2 },
    { done: !!s.has_logo, label: 'Logo on invoices', tab: 'invoices', icon: ImageIcon },
    { done: bankFilled, label: 'Bank details on invoices', tab: 'invoices', icon: Banknote },
    { done: Number(s.min_margin_pct) > 0, label: 'Margin guardrail', tab: 'controls', icon: ShieldCheck },
  ];
  const doneN = steps.filter((x) => x.done).length; const missing = steps.filter((x) => !x.done);

  return (
    <Page title="Agency settings" description={<>Your agency’s identity, invoices and financial rules{!admin && ' — only an Admin can change them'}.</>}>
      <section className="hero-mesh mb-5 rounded-2xl border border-line p-5 md:p-6" aria-label="Agency summary">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div className="flex min-w-0 items-center gap-4">
            {logoUrl ? <img src={logoUrl} alt="" className="h-16 w-16 shrink-0 rounded-2xl border border-line bg-white object-contain p-1.5" /> : <Avatar name={s.name || 'A'} size={64} />}
            <div className="min-w-0"><h2 className="truncate text-xl font-bold tracking-tight md:text-2xl">{s.name || 'Your agency'}</h2>
              <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">{[s.base_currency, s.tax_label && `${s.tax_label} label`, s.timezone, s.invoice_prefix && `Invoices ${s.invoice_prefix}-…`].filter(Boolean).map((c: string) => <span key={c} className="rounded-full border border-line bg-surface/70 px-2 py-0.5 text-muted backdrop-blur">{c}</span>)}</div></div></div>
          <div className="w-full max-w-sm">
            <div className="mb-1.5 flex items-center justify-between text-xs"><span className="font-medium">{doneN === steps.length ? 'Your agency is fully set up' : `Setup ${doneN} of ${steps.length}`}</span><span className="num text-muted">{Math.round((doneN / steps.length) * 100)}%</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-surface2/80"><div className="h-full rounded-full transition-all duration-700" style={{ width: `${(doneN / steps.length) * 100}%`, background: doneN === steps.length ? 'rgb(var(--success))' : 'rgb(var(--accent))' }} /></div>
            {missing.length > 0 && <ul className="mt-2.5 flex flex-wrap gap-1.5">{missing.slice(0, 3).map((m) => { const I = m.icon; return <li key={m.label}><button className="inline-flex items-center gap-1 rounded-full border border-line bg-surface/70 px-2.5 py-1 text-[11px] text-muted backdrop-blur hover:border-accent/50 hover:text-fg" onClick={() => setParams({ tab: m.tab }, { replace: true })}><I size={11} />{m.label}<ArrowRight size={10} /></button></li>; })}</ul>}
          </div>
        </div>
      </section>
      <div role="tablist" aria-label="Settings sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map(([k, label, Icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setParams({ tab: k }, { replace: true })}
            className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition -mb-px ${tab === k ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}><Icon size={16} />{label}</button>
        ))}
      </div>
      <div className={`grid grid-cols-1 gap-6 ${dirty ? 'pb-24' : ''}`}>
        {tab === 'profile' && <>
          <Section icon={Building2} title="Agency profile" hint="Your name and address appear at the top of every invoice and document you send.">
            <div className="grid sm:grid-cols-2 gap-x-4 max-w-3xl">
              <Field label="Agency name">{input('name')}</Field>
              <Field label="Tax registration no. (GST / VAT / ABN)" hint="Printed on invoices. Leave blank to omit.">{input('tax_number', { autoComplete: 'off' })}</Field>
              <div className="sm:col-span-2"><Field label="Address"><textarea className="input h-20" value={s.address ?? ''} onChange={set('address')} disabled={!admin} /></Field></div>
            </div>
          </Section>
          <Section icon={Globe2} title="Regional" hint="How dates, taxes and numbering work for your agency.">
            <div className="grid sm:grid-cols-2 gap-x-4 max-w-3xl">
              <Field label="Base currency" hint="Locked once transactions exist."><input className="input num" value={s.base_currency} disabled /></Field>
              <Field label="Tax label (GST / VAT)">{input('tax_label')}</Field>
              <Field label="Time zone (IANA)" hint="For example Asia/Karachi">{input('timezone', { placeholder: 'Asia/Karachi' })}</Field>
              <Field label="Invoice number prefix" hint="Numbers look like INV-00001">{input('invoice_prefix')}</Field>
            </div>
          </Section>
        </>}

        {tab === 'invoices' && <>
          <InvoiceDesigns canEdit={admin} refreshKey={previewKey} />
          <Section icon={ImageIcon} title="Logo" hint="Shown at the top of invoice PDFs. PNG, JPG, GIF, WebP or SVG, up to 2 MB; 300–600 px wide works best.">
            {logoErr && <div role="alert" className="text-danger text-sm mb-2">{logoErr}</div>}
            {logoMsg && <div className="text-accent text-sm mb-2">{logoMsg}</div>}
            <div className="flex flex-wrap items-center gap-4">
              {logoUrl ? <img src={logoUrl} alt="Agency logo" className="max-h-16 max-w-[200px] object-contain border border-line rounded-lg p-2 bg-white" /> : <div className="h-16 w-32 border border-dashed border-line rounded-lg flex items-center justify-center text-xs text-muted">No logo</div>}
              {admin && <>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ''; }} />
                <button className="btn-ghost" onClick={() => fileRef.current?.click()}>{logoUrl ? 'Replace logo' : 'Upload logo'}</button>
                {logoUrl && <button className="btn-ghost text-danger" onClick={removeLogo}>Remove</button>}
              </>}
            </div>
          </Section>
          <Section icon={Banknote} title="Payment details" hint="Printed under “How to pay” while a balance is owed. Leave a field blank to leave it off.">
            <div className="grid sm:grid-cols-2 gap-x-4 max-w-3xl">{BANK.map(([k, label]) => <Field key={k} label={label}>{input(k, { autoComplete: 'off' })}</Field>)}</div>
            <div className="max-w-3xl"><Field label="Payment instructions (optional)"><textarea className="input h-20" value={s.payment_instructions ?? ''} onChange={set('payment_instructions')} disabled={!admin} placeholder="e.g. Please email the transfer receipt to accounts@…" /></Field></div>
          </Section>
        </>}

        {tab === 'controls' && <>
          <Section icon={ShieldCheck} title="Approvals & guardrails" hint="Rules that protect margins and money leaving the agency.">
            <div className="grid sm:grid-cols-2 gap-x-4 max-w-3xl">
              <Field label="Minimum quote margin %" hint="Quotes below this margin are flagged.">{input('min_margin_pct', { type: 'number', className: 'input num' })}</Field>
              <Field label="Second-approver threshold" hint="Credit notes, refunds and bills above this need a different approver. 0 = off.">{input('approval_threshold', { type: 'number', className: 'input num' })}</Field>
              <Field label="Supplier bill tolerance %" hint="Allowed overage versus the booking cost.">{input('bill_tolerance_pct', { type: 'number', className: 'input num' })}</Field>
              <Field label="Payment runs" hint="Someone other than the creator must approve supplier payment runs."><Switch on={!!s.dual_control_runs} onChange={(v) => setS({ ...s, dual_control_runs: v })} disabled={!admin} label="Separate approver required" /></Field>
            </div>
          </Section>
          <Section icon={Percent} title="Commission & exchange rates" hint="When agents earn commission, and how fresh exchange rates must be.">
            <div className="grid sm:grid-cols-2 gap-x-4 max-w-3xl">
              <Field label="Commission becomes eligible when" hint="Agents are paid only on eligible commission."><select className="input" value={s.commission_trigger ?? 'booking_confirmed'} onChange={set('commission_trigger')} disabled={!admin}>{[['booking_confirmed', 'the booking is confirmed'], ['client_paid', 'the client has paid in full'], ['travel_completed', 'travel is completed'], ['supplier_paid', 'suppliers are paid']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <Field label="Max exchange-rate age (days)" hint="Older rates are refused when issuing foreign-currency documents.">{input('fx_max_age_days', { type: 'number', className: 'input num' })}</Field>
            </div>
          </Section>
          {finance && <Section icon={s.locked_through ? Lock : LockOpen} title="Accounting period lock" hint="Closing a period stops anyone posting, editing or reversing anything dated on or before the lock date."
            aside={<span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${s.locked_through ? 'bg-warn/15 text-warn' : 'bg-success/15 text-success'}`}>{s.locked_through ? `Locked through ${s.locked_through}` : 'All periods open'}</span>}>
            <Err e={lockErr} />
            <div className="mb-5 flex flex-wrap items-end gap-2"><div className="w-44"><Field label="Lock through"><input className="input num" type="date" value={lockDate} onChange={(e) => setLockDate(e.target.value)} /></Field></div>
              <button className="btn mb-3" onClick={() => lock(lockDate)}><Lock size={14} />Lock period</button>
              {admin && s.locked_through && <button className="btn-ghost mb-3 text-warn" onClick={() => setReopen(true)}><LockOpen size={14} />Reopen all</button>}</div>
            <h3 className="mb-2 text-sm font-semibold">History</h3>
            {!locks.length ? <p className="text-sm text-muted">No period has been locked yet.</p> : <ol className="space-y-3">{locks.slice(0, 8).map((r, i) => <li key={i} className="relative flex gap-3"><span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-accent" />{i < Math.min(locks.length, 8) - 1 && <span className="absolute left-[4px] top-4 h-full w-px bg-line" aria-hidden />}
              <div className="min-w-0 text-sm"><div><b className="capitalize">{String(r.action).replace(/_/g, ' ')}</b>{r.locked_through && <> through <span className="num">{r.locked_through}</span></>}<span className="text-muted"> · {r.user_name}</span></div>{r.reason && <div className="text-xs text-muted">“{r.reason}”</div>}<div className="text-[11px] text-muted num">{new Date(r.created_at).toLocaleString()}</div></div></li>)}</ol>}
          </Section>}
        </>}

        {tab === 'messaging' && admin && <SmsCard />}
      </div>

      {reopen && <Modal title="Reopen all accounting periods?" onClose={() => setReopen(false)}>
        <p className="mb-3 text-sm">Entries dated on or before <b className="num">{s.locked_through}</b> can be posted, edited and reversed again. Reopening is recorded in the history below.</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setReopen(false)}>Keep locked</button><button className="btn !bg-warn" onClick={async () => { await lock(null); setReopen(false); }}>Reopen all periods</button></div></Modal>}
      {(msg || err) && !dirty && <div role="status" className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-line bg-surface px-4 py-2 text-sm shadow-pop">{err ? <span className="text-danger">{err}</span> : <span className="text-accent">{msg}</span>}</div>}
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur px-4 py-3 shadow-pop">
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3 md:px-4">
            <span className="text-sm font-medium flex-1 min-w-[10rem]">You have unsaved changes{err && <span className="ml-2 text-danger font-normal">{err}</span>}</span>
            <button className="btn-ghost" onClick={discard} disabled={busy}>Discard</button>
            <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          </div>
        </div>
      )}
    </Page>
  );
}
