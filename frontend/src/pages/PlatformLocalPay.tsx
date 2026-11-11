import { useEffect, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Clock, Copy, Trash2, Wallet, XCircle } from 'lucide-react';
import { api } from '../api';
import { Avatar, Err, Field, Modal, Pager, Skeleton } from '../components/ui';
import { rel } from './PlatformPeople';

/* Rupee payments: the platform's JazzCash and Easypaisa merchant accounts, and the payments agencies made with them.
   A payment only extends a plan once the provider's answer is verified; the ones that could not be verified wait here for an operator. */

const WALLET: Record<string, { label: string; dot: string }> = { jazzcash: { label: 'JazzCash', dot: '#e11d2a' }, easypaisa: { label: 'Easypaisa', dot: '#2fb344' } };
const ST: Record<string, { label: string; hue: string; icon: any }> = { pending: { label: 'Waiting', hue: 'warn', icon: Clock }, paid: { label: 'Paid', hue: 'success', icon: CheckCircle2 }, failed: { label: 'Failed', hue: 'danger', icon: XCircle } };
const pkr = (n: number) => `PKR ${Number(n).toLocaleString('en', { maximumFractionDigits: 0 })}`;

function CopyLine({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface2/50 px-2.5 py-1.5"><div className="min-w-0"><div className="text-[11px] text-muted">{label}</div><div className="break-all font-mono text-xs">{value}</div></div>
    <button type="button" className="shrink-0 rounded-md p-1.5 text-muted hover:bg-surface2 hover:text-fg" aria-label={`Copy ${label}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* the text is on screen */ } }}>{done ? <Check size={14} className="text-success" /> : <Copy size={14} />}</button></div>;
}

function ConfigDialog({ provider, info, onClose, onDone }: { provider: string; info: any; onClose(): void; onDone(m: string): void }) {
  const jazz = provider === 'jazzcash'; const [f, setF] = useState<any>({ sandbox: info?.sandbox ?? true }); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const ready = reason.trim().length >= 3 && (jazz ? f.merchant_id && f.password && f.integrity_salt : f.store_id && f.hash_key);
  const save = async () => { setBusy(true); setErr(''); try { await api(`/platform/settings/local-pay/${provider}`, 'PUT', { ...f, reason }); onDone(`${WALLET[provider].label} saved. Agencies can now pay with it${f.sandbox ? ' (test mode: no real money moves)' : ''}.`); } catch (e: any) { setErr(e.message); setBusy(false); } };
  return <Modal title={`${info?.configured ? 'Change' : 'Set up'} ${WALLET[provider].label}`} wide onClose={onClose}><Err e={err} />
    <p className="mb-3 text-sm text-muted">Enter the details from your {WALLET[provider].label} merchant account. They are stored encrypted and are never shown again, so you will need to enter them all to change anything.</p>
    {jazz ? <div className="grid gap-x-4 sm:grid-cols-3"><Field label="Merchant ID"><input className="input font-mono text-xs" autoFocus value={f.merchant_id ?? ''} onChange={set('merchant_id')} placeholder="MC12345" /></Field><Field label="Password"><input className="input font-mono text-xs" type="password" autoComplete="off" value={f.password ?? ''} onChange={set('password')} /></Field><Field label="Integrity salt"><input className="input font-mono text-xs" type="password" autoComplete="off" value={f.integrity_salt ?? ''} onChange={set('integrity_salt')} /></Field></div>
      : <><div className="grid gap-x-4 sm:grid-cols-2"><Field label="Store ID"><input className="input font-mono text-xs" autoFocus value={f.store_id ?? ''} onChange={set('store_id')} placeholder="12345" /></Field><Field label="Hash key" hint="16 characters."><input className="input font-mono text-xs" type="password" autoComplete="off" value={f.hash_key ?? ''} onChange={set('hash_key')} /></Field></div>
        <div className="mb-3 rounded-lg border border-line p-3"><div className="text-sm font-medium">Payment confirmation login <span className="font-normal text-muted">(strongly recommended)</span></div><p className="mb-2 text-xs text-muted">With these, we ask Easypaisa directly whether an order was paid before extending a plan. Without them, every Easypaisa payment waits for you to confirm it by hand.</p>
          <div className="grid gap-x-4 sm:grid-cols-3"><Field label="Account number"><input className="input font-mono text-xs" value={f.account_num ?? ''} onChange={set('account_num')} /></Field><Field label="Username"><input className="input font-mono text-xs" autoComplete="off" value={f.username ?? ''} onChange={set('username')} /></Field><Field label="Password"><input className="input font-mono text-xs" type="password" autoComplete="off" value={f.password ?? ''} onChange={set('password')} /></Field></div></div></>}
    <label className="mb-3 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={!!f.sandbox} onChange={(e) => setF({ ...f, sandbox: e.target.checked })} /><span><b>Test mode</b> (provider sandbox)<span className="block text-xs text-muted">Use this with sandbox credentials first. Untick it only when you have live credentials and a successful test payment.</span></span></label>
    <Field label="Reason" hint="Kept in the operator audit log. The secrets never are."><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Adding JazzCash sandbox for testing" /></Field>
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !ready} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div></Modal>;
}

function ReasonDialog({ title, body, cta, danger, onClose, onGo }: { title: string; body: React.ReactNode; cta: string; danger?: boolean; onClose(): void; onGo(reason: string): Promise<void> }) {
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  return <Modal title={title} onClose={onClose}><Err e={err} /><div className="mb-3 text-sm text-muted">{body}</div>
    <Field label="Reason" hint="Kept in the operator audit log."><input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className={`btn ${danger ? '!bg-danger' : ''}`} disabled={busy || reason.trim().length < 3} onClick={async () => { setBusy(true); setErr(''); try { await onGo(reason.trim()); } catch (e: any) { setErr(e.message); setBusy(false); } }}>{busy ? 'Working…' : cta}</button></div></Modal>;
}

export function PlatformLocalPay({ canEdit, canSettle }: { canEdit: boolean; canSettle: boolean }) {
  const [info, setInfo] = useState<any>(null); const [res, setRes] = useState<any>(null); const [status, setStatus] = useState('pending'); const [page, setPage] = useState(1); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const [cfg, setCfg] = useState<string | null>(null); const [rm, setRm] = useState<string | null>(null); const [act, setAct] = useState<{ p: any; kind: 'confirm' | 'reject' } | null>(null);
  const loadInfo = () => api('/platform/settings/local-pay').then(setInfo).catch((e) => setErr(e.message));
  const loadPay = () => api(`/platform/local-payments?${status ? `status=${status}&` : ''}page=${page}`).then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { loadInfo(); }, []); useEffect(() => { loadPay(); }, [status, page]); useEffect(() => { setPage(1); }, [status]);
  const c = res?.counts ?? {}; const tabs: [string, string, number | undefined][] = [['pending', 'Waiting', c.pending], ['paid', 'Paid', c.paid], ['failed', 'Failed', c.failed], ['', 'All', (c.pending ?? 0) + (c.paid ?? 0) + (c.failed ?? 0)]];
  const anyTest = info && Object.values(info).some((p: any) => p.configured && p.sandbox);
  return (
    <section className="card" aria-label="Rupee payments">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent"><Wallet size={18} /></span>
        <div><h3 className="text-sm font-semibold">Rupee payments: JazzCash &amp; Easypaisa</h3><p className="mt-0.5 max-w-2xl text-sm text-muted">Agencies pay for their plan in rupees with your merchant accounts. A payment extends the plan only after the provider’s answer has been checked.</p></div></div>
        {(c.pending ?? 0) > 0 && <button className="inline-flex items-center gap-1.5 rounded-full bg-warn/15 px-3 py-1 text-xs font-semibold text-warn" onClick={() => setStatus('pending')}><Clock size={13} />{c.pending} waiting for you</button>}</div>
      <div role="note" className="mt-3 flex gap-2 rounded-lg border border-warn/30 bg-warn/10 p-3 text-xs text-warn"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>These connections have not been exercised against the live providers yet. Before real money: add your sandbox credentials in test mode, make one test payment per provider, and check that the plan extends.</span></div>
      {msg && <div role="status" className="mt-3 flex justify-between gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"><span>{msg}</span><button aria-label="Dismiss" onClick={() => setMsg('')}>×</button></div>}
      <Err e={err} />

      <div className="mt-4 grid gap-3 lg:grid-cols-2">{!info ? <><Skeleton className="h-36" /><Skeleton className="h-36" /></> : (['jazzcash', 'easypaisa'] as const).map((k) => { const p = info[k], w = WALLET[k]; return (
        <div key={k} className="rounded-xl border border-line p-3.5">
          <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2 text-sm font-semibold"><span className="h-2.5 w-2.5 rounded-full" style={{ background: w.dot }} aria-hidden />{w.label}</div>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${!p.configured ? 'bg-surface2 text-muted' : p.sandbox ? 'bg-warn/15 text-warn' : 'bg-success/15 text-success'}`}>{!p.configured ? 'Not set up' : p.sandbox ? 'Test mode' : 'Live'}</span></div>
          <p className="mt-1 text-xs text-muted">{p.configured ? <>{k === 'jazzcash' ? 'Merchant' : 'Store'} ending <b className="font-mono text-fg">…{p.hint}</b>{p.updated_by ? <>, saved by {p.updated_by}</> : null}.{k === 'easypaisa' && <> {p.can_verify ? 'Payments are confirmed with Easypaisa automatically.' : 'No confirmation login saved: every payment waits for you to confirm it.'}</>}</> : 'Agencies cannot pay with it yet.'}</p>
          <div className="mt-3"><CopyLine label={k === 'jazzcash' ? 'Return and notification address (give this to JazzCash)' : 'Return address pattern (Easypaisa)'} value={p.return_url} /></div>
          {canEdit && <div className="mt-3 flex gap-2"><button className="btn" onClick={() => setCfg(k)}>{p.configured ? 'Change' : 'Set up'}</button>{p.configured && <button className="btn-ghost text-danger" onClick={() => setRm(k)}><Trash2 size={14} />Remove</button>}</div>}
        </div>); })}</div>
      {info && !canEdit && <p className="mt-2 text-xs text-muted">Only an admin operator can change these.</p>}
      {anyTest && <p className="mt-2 text-xs text-muted">While a provider is in test mode, agencies see a TEST tag next to it on their Billing page.</p>}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">Payments</h4>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Payment status">{tabs.map(([k, l, n]) => <button key={l} role="tab" aria-selected={status === k} onClick={() => setStatus(k)} className={`rounded-lg border px-3 py-1 text-sm ${status === k ? 'border-accent bg-accent/15 font-medium text-accent' : 'border-line hover:bg-surface2'}`}>{l}{res && <span className="ml-1.5 text-xs text-muted num">{n ?? 0}</span>}</button>)}</div></div>
      {!res ? <Skeleton className="mt-3 h-32" /> : <div className="mt-3 overflow-hidden rounded-xl border border-line">
        {!res.rows.length && <div className="px-4 py-10 text-center text-sm text-muted">{status === 'pending' ? 'Nothing is waiting for you.' : 'No payments here yet.'}</div>}
        <ul className="divide-y divide-line/70">{res.rows.map((r: any) => { const st = ST[r.status], Icon = st.icon; return (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-3.5 py-3"><Avatar name={r.agency_name} size={34} />
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-medium">{r.agency_name}</span><span className="inline-flex items-center gap-1 text-xs text-muted"><span className="h-1.5 w-1.5 rounded-full" style={{ background: WALLET[r.provider]?.dot }} aria-hidden />{WALLET[r.provider]?.label}</span></div>
              <div className="truncate text-xs text-muted"><span className="num">{pkr(r.amount_pkr)}</span> · {r.plan_name} {r.billing_interval} · <span className="font-mono">{r.txn_ref}</span> · {rel(r.created_at)}{r.payer_email ? ` · ${r.payer_email}` : ''}</div>
              {r.gateway_message && r.status !== 'paid' && <div className="mt-0.5 truncate text-xs text-muted" title={r.gateway_message}>{r.gateway_message}</div>}</div>
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `rgb(var(--${st.hue}) / .14)`, color: `rgb(var(--${st.hue}))` }}><Icon size={12} />{st.label}{r.status === 'paid' && r.settled_by === 'operator' ? ' by hand' : ''}</span>
            {canSettle && r.status !== 'paid' && <div className="flex gap-1.5"><button className="btn" onClick={() => setAct({ p: r, kind: 'confirm' })}>Mark received</button>{r.status === 'pending' && <button className="btn-ghost" onClick={() => setAct({ p: r, kind: 'reject' })}>Mark failed</button>}</div>}
          </li>); })}</ul>
        {res.total > res.page_size && <Pager total={res.total} page={page - 1} size={res.page_size} onPage={(p) => setPage(p + 1)} noun="payments" />}</div>}

      {cfg && <ConfigDialog provider={cfg} info={info?.[cfg]} onClose={() => setCfg(null)} onDone={(m) => { setCfg(null); setMsg(m); loadInfo(); }} />}
      {rm && <ReasonDialog title={`Remove ${WALLET[rm].label}?`} cta="Remove" danger body="Agencies will no longer be able to pay with it. Payments already made are not affected." onClose={() => setRm(null)} onGo={async (reason) => { await api(`/platform/settings/local-pay/${rm}`, 'DELETE', { reason }); setRm(null); setMsg(`${WALLET[rm].label} removed.`); loadInfo(); }} />}
      {act && <ReasonDialog title={act.kind === 'confirm' ? 'Mark this payment as received?' : 'Mark this payment as failed?'} cta={act.kind === 'confirm' ? 'Mark received' : 'Mark failed'} danger={act.kind === 'reject'} onClose={() => setAct(null)}
        body={act.kind === 'confirm' ? <>Only do this after you have seen <b>{pkr(act.p.amount_pkr)}</b> for reference <span className="font-mono">{act.p.txn_ref}</span> in your {WALLET[act.p.provider]?.label} merchant portal. {act.p.agency_name}’s {act.p.plan_name} plan will be extended by {act.p.billing_interval === 'yearly' ? 'a year' : 'a month'}.</> : <>Use this when the money never arrived. The agency’s plan is not changed.</>}
        onGo={async (reason) => { await api(`/platform/local-payments/${act.p.id}/${act.kind}`, 'POST', { reason }); setAct(null); setMsg(act.kind === 'confirm' ? 'Marked as received. The plan has been extended.' : 'Marked as failed.'); loadPay(); }} />}
    </section>
  );
}
