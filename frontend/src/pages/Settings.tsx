import { ReactNode, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2, FileText, MessageSquare, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Page, Table } from '../components/ui';
import InvoiceDesigns from '../components/InvoiceDesigns';
import { today } from '../lookup';

function SmsCard() {
  const [s, setS] = useState<any>(null); const [f, setF] = useState<any>({ account_sid: '', auth_token: '', from: '', default_cc: '' }); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [test, setTest] = useState(''); const [log, setLog] = useState<any[]>([]); const [busy, setBusy] = useState(false);
  const load = () => { api('/sms/settings').then((r) => { setS(r); if (r.configured) setF((x: any) => ({ ...x, from: r.from, default_cc: r.default_cc ?? '', account_sid: '' })); }); api('/sms/log').then(setLog).catch(() => {}); };
  useEffect(() => { load(); }, []);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => { setBusy(true); try { await api('/sms/settings', 'PUT', { account_sid: f.account_sid.trim() || undefined, auth_token: f.auth_token.trim() || undefined, from: f.from.trim(), default_cc: f.default_cc.trim() || null }); setErr(''); setMsg('Saved. Send yourself a test message below to check it works.'); setF({ ...f, auth_token: '' }); load(); } catch (e: any) { setErr(e.message); setMsg(''); } finally { setBusy(false); } };
  const sendTest = async () => { setBusy(true); try { await api('/sms/test', 'POST', { to: test }); setErr(''); setMsg(`Test message sent to ${test}.`); load(); } catch (e: any) { setErr(e.message); setMsg(''); } finally { setBusy(false); } };
  const disconnect = async () => { await api('/sms/settings', 'DELETE'); setMsg('Text messages disconnected.'); setF({ account_sid: '', auth_token: '', from: '', default_cc: '' }); load(); };
  if (!s) return null;
  return (<div className="card">
    <h3 className="font-bold mb-1">Text messages (SMS)</h3>
    <p className="text-sm text-muted mb-3">Send clients booking confirmations, payment reminders and birthday wishes by text. Uses your own <a className="underline" href="https://www.twilio.com" target="_blank" rel="noreferrer">Twilio</a> account — you pay Twilio for the messages. {s.configured ? <>Connected as <b className="text-fg">{s.account_sid}</b>, sending from <b className="text-fg">{s.from}</b>.</> : 'Not connected yet.'}</p>
    <Err e={err} />{msg && <div className="text-accent text-sm mb-3">{msg}</div>}
    <div className="grid sm:grid-cols-2 gap-x-3">
      <Field label="Account SID" hint={s.configured ? 'Leave blank to keep the saved one' : 'Starts with AC — from your Twilio console'}><input className="input num" value={f.account_sid} onChange={set('account_sid')} autoComplete="off" placeholder={s.configured ? s.account_sid : 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'} /></Field>
      <Field label="Auth token" hint={s.configured ? 'Leave blank to keep the saved one' : 'Stored encrypted and never shown again'}><input className="input num" type="password" value={f.auth_token} onChange={set('auth_token')} autoComplete="new-password" /></Field>
      <Field label="Send from" hint="Your Twilio number (+14155550100) or a sender name"><input className="input" value={f.from} onChange={set('from')} /></Field>
      <Field label="Your country code" hint="So 0300 1234567 becomes +92 300 1234567"><input className="input num" value={f.default_cc} onChange={set('default_cc')} placeholder="+92" /></Field></div>
    <div className="flex flex-wrap gap-2 mb-4"><button className="btn" disabled={busy || !f.from.trim() || (!s.configured && (!f.account_sid.trim() || !f.auth_token.trim()))} onClick={save}>{s.configured ? 'Save changes' : 'Connect'}</button>{s.configured && <button className="btn-ghost text-danger" onClick={() => confirm('Disconnect text messages?') && disconnect()}>Disconnect</button>}</div>
    {s.configured && <div className="flex flex-wrap items-end gap-2 mb-4"><Field label="Send a test message to"><input className="input num" value={test} onChange={(e) => setTest(e.target.value)} placeholder="+92 300 1234567" /></Field><button className="btn-ghost mb-3" disabled={busy || !test.trim()} onClick={sendTest}>Send test</button></div>}
    {log.length > 0 && <><h4 className="text-sm font-bold mb-2">Recent texts</h4><Table rows={log.slice(0, 15)} cols={[{ h: 'When', render: (r: any) => new Date(r.created_at).toLocaleString() }, { h: 'To', render: (r: any) => <>{r.client_name ?? ''}<div className="text-xs text-muted num">{r.to_number}</div></> }, { h: 'Message', render: (r: any) => <span className="text-xs">{r.body}</span> }, { h: 'Result', render: (r: any) => (r.status === 'sent' ? <span className="text-success">Sent</span> : <span className="text-danger" title={r.error}>Failed</span>) }]} /></>}
  </div>);
}

const SAVED = ['name', 'tax_label', 'address', 'timezone', 'invoice_prefix', 'min_margin_pct', 'approval_threshold', 'dual_control_runs', 'fx_max_age_days', 'commission_trigger', 'bill_tolerance_pct', 'payment_instructions', 'tax_number', 'bank_name', 'bank_account_name', 'bank_account_number', 'bank_routing', 'bank_iban', 'bank_swift'];
const BANK: [string, string][] = [['bank_name', 'Bank name'], ['bank_account_name', 'Account name'], ['bank_account_number', 'Account number'], ['bank_routing', 'BSB / Sort code / Routing no.'], ['bank_iban', 'IBAN'], ['bank_swift', 'SWIFT / BIC']];
const TABS: [string, string, any][] = [['profile', 'Profile', Building2], ['invoices', 'Branding & invoices', FileText], ['controls', 'Financial controls', ShieldCheck], ['messaging', 'Messaging', MessageSquare]];
const norm = (v: any) => (v === null || v === undefined ? '' : String(v));

/** A titled block inside a tab: what it is, then its fields. */
const Section = ({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) => (
  <section className="card"><h2 className="font-semibold">{title}</h2>{hint && <p className="text-sm text-muted mt-1 mb-4 max-w-2xl">{hint}</p>}{!hint && <div className="mb-3" />}{children}</section>
);

export default function Settings() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [s, setS] = useState<any>(null); const [base, setBase] = useState<any>(null); const [locks, setLocks] = useState<any[]>([]);
  const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [lockErr, setLockErr] = useState(''); const [busy, setBusy] = useState(false);
  const [lockDate, setLockDate] = useState(today());
  const [logoUrl, setLogoUrl] = useState<string | null>(null); const [logoErr, setLogoErr] = useState(''); const [logoMsg, setLogoMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
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

  return (
    <Page title="Agency settings" description={<>Your agency’s identity, invoices and financial rules{!admin && ' — only an Admin can change them'}.</>}>
      <div role="tablist" aria-label="Settings sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map(([k, label, Icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setParams({ tab: k }, { replace: true })}
            className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition -mb-px ${tab === k ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}><Icon size={16} />{label}</button>
        ))}
      </div>
      <div className={`grid grid-cols-1 gap-6 ${dirty ? 'pb-24' : ''}`}>
        {tab === 'profile' && <>
          <Section title="Agency profile" hint="Your name and address appear at the top of every invoice and document you send.">
            <div className="grid sm:grid-cols-2 gap-x-4 max-w-3xl">
              <Field label="Agency name">{input('name')}</Field>
              <Field label="Tax registration no. (GST / VAT / ABN)" hint="Printed on invoices. Leave blank to omit.">{input('tax_number', { autoComplete: 'off' })}</Field>
              <div className="sm:col-span-2"><Field label="Address"><textarea className="input h-20" value={s.address ?? ''} onChange={set('address')} disabled={!admin} /></Field></div>
            </div>
          </Section>
          <Section title="Regional" hint="How dates, taxes and numbering work for your agency.">
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
          <Section title="Logo" hint="Shown at the top of invoice PDFs. PNG, JPG, GIF, WebP or SVG, up to 2 MB; 300–600 px wide works best.">
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
          <Section title="Payment details" hint="Printed under “How to pay” while a balance is owed. Leave a field blank to leave it off.">
            <div className="grid sm:grid-cols-2 gap-x-4 max-w-3xl">{BANK.map(([k, label]) => <Field key={k} label={label}>{input(k, { autoComplete: 'off' })}</Field>)}</div>
            <div className="max-w-3xl"><Field label="Payment instructions (optional)"><textarea className="input h-20" value={s.payment_instructions ?? ''} onChange={set('payment_instructions')} disabled={!admin} placeholder="e.g. Please email the transfer receipt to accounts@…" /></Field></div>
          </Section>
        </>}

        {tab === 'controls' && <>
          <Section title="Approvals & guardrails" hint="Rules that protect margins and money leaving the agency.">
            <div className="grid sm:grid-cols-2 gap-x-4 max-w-3xl">
              <Field label="Minimum quote margin %" hint="Quotes below this margin are flagged.">{input('min_margin_pct', { type: 'number', className: 'input num' })}</Field>
              <Field label="Second-approver threshold" hint="Credit notes, refunds and bills above this need a different approver. 0 = off.">{input('approval_threshold', { type: 'number', className: 'input num' })}</Field>
              <Field label="Supplier bill tolerance %" hint="Allowed overage versus the booking cost.">{input('bill_tolerance_pct', { type: 'number', className: 'input num' })}</Field>
              <Field label="Payment runs" hint="Someone other than the creator must approve supplier payment runs."><label className="flex items-center gap-2 text-sm h-9"><input type="checkbox" checked={!!s.dual_control_runs} onChange={(e) => setS({ ...s, dual_control_runs: e.target.checked })} disabled={!admin} /> Separate approver required</label></Field>
            </div>
          </Section>
          <Section title="Commission & exchange rates">
            <div className="grid sm:grid-cols-2 gap-x-4 max-w-3xl">
              <Field label="Commission becomes eligible when" hint="Agents are paid only on eligible commission."><select className="input" value={s.commission_trigger ?? 'booking_confirmed'} onChange={set('commission_trigger')} disabled={!admin}>{[['booking_confirmed', 'the booking is confirmed'], ['client_paid', 'the client has paid in full'], ['travel_completed', 'travel is completed'], ['supplier_paid', 'suppliers are paid']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <Field label="Max exchange-rate age (days)" hint="Older rates are refused when issuing foreign-currency documents.">{input('fx_max_age_days', { type: 'number', className: 'input num' })}</Field>
            </div>
          </Section>
          {finance && <Section title="Accounting period lock" hint={<>Locked through <b className="num text-fg">{s.locked_through ?? 'nothing (all periods open)'}</b>. Nothing can be posted, edited or reversed on or before this date.</>}>
            <Err e={lockErr} />
            <div className="flex flex-wrap items-end gap-2 mb-5"><div className="w-44"><Field label="Lock through"><input className="input num" type="date" value={lockDate} onChange={(e) => setLockDate(e.target.value)} /></Field></div>
              <button className="btn mb-3" onClick={() => lock(lockDate)}>Lock period</button>
              {admin && s.locked_through && <button className="btn-ghost text-warn mb-3" onClick={() => confirm('Reopen all periods?') && lock(null)}>Reopen all</button>}</div>
            <h3 className="text-sm font-semibold mb-2">History</h3>
            <Table rows={locks} cols={[{ h: 'When', render: (r) => new Date(r.created_at).toLocaleString() }, { h: 'Action', render: (r) => r.action }, { h: 'Through', render: (r) => r.locked_through ?? '—' }, { h: 'By', render: (r) => r.user_name }, { h: 'Reason', render: (r) => r.reason }]} />
          </Section>}
        </>}

        {tab === 'messaging' && admin && <SmsCard />}
      </div>

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
