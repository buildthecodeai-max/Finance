import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Page, Table } from '../components/ui';
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

const BILLING: [string, string, string?][] = [
  ['tax_number', 'Tax registration no. (GST / VAT / ABN)'], ['bank_name', 'Bank name'], ['bank_account_name', 'Account name'], ['bank_account_number', 'Account number'],
  ['bank_routing', 'BSB / Sort code / Routing no.'], ['bank_iban', 'IBAN'], ['bank_swift', 'SWIFT / BIC'],
];

export default function Settings() {
  const { can } = useAuth();
  const [s, setS] = useState<any>(null); const [locks, setLocks] = useState<any[]>([]);
  const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [lockErr, setLockErr] = useState('');
  const [lockDate, setLockDate] = useState(today());
  const [logoUrl, setLogoUrl] = useState<string | null>(null); const [logoErr, setLogoErr] = useState(''); const [logoMsg, setLogoMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const loadLogo = () => api('/admin/logo').then((r: any) => setLogoUrl(r.url)).catch(() => {});
  const load = () => { api('/admin/settings').then((r: any) => { setS(r); if (r.has_logo) loadLogo(); }); if (can('admin', 'finance_manager')) api('/admin/period-locks').then(setLocks); };
  useEffect(() => { load(); }, []);
  const save = async () => {
    try { setS(await api('/admin/settings', 'PUT', { name: s.name, tax_label: s.tax_label, address: s.address, timezone: s.timezone, invoice_prefix: s.invoice_prefix, min_margin_pct: Number(s.min_margin_pct) || 0, approval_threshold: Number(s.approval_threshold) || 0, dual_control_runs: !!s.dual_control_runs, fx_max_age_days: Number(s.fx_max_age_days ?? 7), commission_trigger: s.commission_trigger, bill_tolerance_pct: Number(s.bill_tolerance_pct) || 0, payment_instructions: s.payment_instructions || null, ...Object.fromEntries(BILLING.map(([k]) => [k, s[k] || null])) })); setErr(''); setMsg('Settings saved'); }
    catch (e: any) { setErr(e.message); setMsg(''); }
  };
  const uploadLogo = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) { setLogoErr('Logo must be under 2 MB'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const b64 = (reader.result as string).split(',')[1];
        const r: any = await api('/admin/logo', 'POST', { data: b64, mime: file.type });
        setLogoUrl(r.url); setLogoErr(''); setLogoMsg('Logo saved');
        setS((prev: any) => ({ ...prev, has_logo: true }));
      } catch (e: any) { setLogoErr(e.message); }
    };
    reader.readAsDataURL(file);
  };
  const removeLogo = async () => {
    try { await api('/admin/logo', 'DELETE'); setLogoUrl(null); setLogoMsg('Logo removed'); setS((prev: any) => ({ ...prev, has_logo: false })); }
    catch (e: any) { setLogoErr(e.message); }
  };
  const lock = async (date: string | null) => {
    try { await api('/admin/period-locks', 'POST', { locked_through: date }); setLockErr(''); load(); }
    catch (e: any) { setLockErr(e.message); }
  };
  if (!s) return <Page title="Settings"><div className="text-muted">Loading…</div></Page>;
  const admin = can('admin'), set = (k: string) => (e: any) => setS({ ...s, [k]: e.target.value });
  return (
    <Page title="Agency settings">
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="font-bold mb-3">Agency profile</h3><Err e={err} />{msg && <div className="text-accent text-sm mb-3">{msg}</div>}
          <Field label="Agency name"><input className="input" value={s.name ?? ''} onChange={set('name')} disabled={!admin} /></Field>
          <Field label="Address"><textarea className="input" value={s.address ?? ''} onChange={set('address')} disabled={!admin} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Base currency"><input className="input num" value={s.base_currency} disabled title="Locked once transactions exist" /></Field>
            <Field label="Tax label (GST / VAT)"><input className="input" value={s.tax_label ?? ''} onChange={set('tax_label')} disabled={!admin} /></Field>
            <Field label="Time zone (IANA)"><input className="input" value={s.timezone ?? ''} onChange={set('timezone')} disabled={!admin} placeholder="Asia/Karachi" /></Field>
            <Field label="Invoice prefix"><input className="input" value={s.invoice_prefix ?? ''} onChange={set('invoice_prefix')} disabled={!admin} /></Field>
            <Field label="Minimum quote margin % (guardrail)"><input className="input num" type="number" value={s.min_margin_pct ?? 0} onChange={set('min_margin_pct')} disabled={!admin} /></Field>
            <Field label="Second-approver threshold" hint="Credit notes, refunds and bills above this need a different approver. 0 = off."><input className="input num" type="number" value={s.approval_threshold ?? 0} onChange={set('approval_threshold')} disabled={!admin} /></Field>
            <Field label="Payment runs" hint="Require someone other than the creator/submitter to approve supplier payment runs."><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!s.dual_control_runs} onChange={(e) => setS({ ...s, dual_control_runs: e.target.checked })} disabled={!admin} /> Separate approver required</label></Field>
            <Field label="Commission becomes eligible when" hint="Estimated → accrued → eligible. Agents are paid only on eligible commission."><select className="input" value={s.commission_trigger ?? 'booking_confirmed'} onChange={set('commission_trigger')} disabled={!admin}>{[['booking_confirmed', 'the booking is confirmed'], ['client_paid', 'the client has paid in full'], ['travel_completed', 'travel is completed'], ['supplier_paid', 'suppliers are paid']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Max exchange-rate age (days)" hint="Older rates are refused when issuing foreign-currency documents"><input className="input num" type="number" value={s.fx_max_age_days ?? 7} onChange={set('fx_max_age_days')} disabled={!admin} /></Field>
            <Field label="Supplier bill tolerance %" hint="Allowed overage vs the booking cost"><input className="input num" type="number" value={s.bill_tolerance_pct ?? 2} onChange={set('bill_tolerance_pct')} disabled={!admin} /></Field>
          </div>
          <h3 className="font-bold mt-5 mb-1">Agency logo</h3>
          <p className="text-xs text-muted mb-3">Shown on invoice PDFs. PNG, JPG, GIF, WebP or SVG, max 2 MB. Recommended width 300–600 px.</p>
          {logoErr && <div className="text-danger text-sm mb-2">{logoErr}</div>}
          {logoMsg && <div className="text-accent text-sm mb-2">{logoMsg}</div>}
          <div className="flex items-center gap-4 mb-3">
            {logoUrl ? <img src={logoUrl} alt="Agency logo" className="max-h-16 max-w-[200px] object-contain border border-line rounded-lg p-2 bg-surface" /> : <div className="h-16 w-32 border border-dashed border-line rounded-lg flex items-center justify-center text-xs text-muted">No logo</div>}
            {admin && <>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ''; }} />
              <button className="btn-ghost" onClick={() => fileRef.current?.click()}>Upload logo</button>
              {logoUrl && <button className="btn-ghost text-danger" onClick={removeLogo}>Remove</button>}
            </>}
          </div>
          <h3 className="font-bold mt-5 mb-1">Invoice details</h3><p className="text-xs text-muted mb-3">Printed on every invoice PDF. Leave a field blank to omit it. Bank details show only while a balance is owed.</p>
          <div className="grid grid-cols-2 gap-x-3">{BILLING.map(([k, label]) => <Field key={k} label={label}><input className="input" value={s[k] ?? ''} onChange={set(k)} disabled={!admin} autoComplete="off" /></Field>)}</div>
          <Field label="Payment instructions (optional)"><textarea className="input h-16" value={s.payment_instructions ?? ''} onChange={set('payment_instructions')} disabled={!admin} placeholder="e.g. Please email the transfer receipt to accounts@…" /></Field>
          {admin ? <button className="btn" onClick={save}>Save settings</button> : <p className="text-xs text-muted">Only an Admin can change agency settings.</p>}
        </div>
        {admin && <SmsCard />}
        {can('admin', 'finance_manager') && <div className="card">
          <h3 className="font-bold mb-1">Accounting period lock</h3>
          <p className="text-sm text-muted mb-3">Currently locked through: <b className="num text-fg">{s.locked_through ?? 'nothing (all periods open)'}</b>. Nothing can be posted, edited or reversed on or before this date.</p>
          <Err e={lockErr} />
          <div className="grid grid-cols-2 gap-3"><Field label="Lock through"><input className="input num" type="date" value={lockDate} onChange={(e) => setLockDate(e.target.value)} /></Field></div>
          <div className="flex gap-2 mb-5"><button className="btn" onClick={() => lock(lockDate)}>Lock period</button>
            {admin && s.locked_through && <button className="btn-ghost text-warn" onClick={() => confirm('Reopen all periods?') && lock(null)}>Reopen all</button>}</div>
          <h4 className="text-sm font-bold mb-2">History</h4>
          <Table rows={locks} cols={[{ h: 'When', render: (r) => new Date(r.created_at).toLocaleString() }, { h: 'Action', render: (r) => r.action }, { h: 'Through', render: (r) => r.locked_through ?? '—' }, { h: 'By', render: (r) => r.user_name }, { h: 'Reason', render: (r) => r.reason }]} />
        </div>}
      </div>
    </Page>
  );
}
