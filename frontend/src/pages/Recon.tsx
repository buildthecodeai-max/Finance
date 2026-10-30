import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Lock, Sparkles, Upload } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Pill, Table } from '../components/ui';
import { useAccounts, useList } from '../lookup';

const conf = (n: number) => (n >= 75 ? 'bg-success' : n >= 55 ? 'bg-warn' : 'bg-muted');

function Workbench({ account, statements, onChange }: { account: number; statements: any[]; onChange(): void }) {
  const { can } = useAuth(); const w = can('admin', 'finance_manager'); const clients = useList('/clients'); const expense = useAccounts([320, 321, 322, 420]);
  const [stmt, setStmt] = useState(''); const [txns, setTxns] = useState<any[]>([]); const [ledger, setLedger] = useState<any[]>([]); const [sel, setSel] = useState<any>(null); const [sugg, setSugg] = useState<any[]>([]);
  const [picked, setPicked] = useState<Record<number, boolean>>({}); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [adj, setAdj] = useState<any>(null); const [rcpt, setRcpt] = useState<any>(null);
  const load = async () => { const [t, l] = await Promise.all([api(`/bank/transactions?account_id=${account}&status=unmatched${stmt ? `&statement_id=${stmt}` : ''}`), api(`/bank/ledger?account_id=${account}`)]); setTxns(t); setLedger(l); onChange(); };
  useEffect(() => { setSel(null); load(); }, [account, stmt]);
  useEffect(() => { setPicked({}); setSugg([]); if (sel) api(`/bank/transactions/${sel.id}/suggestions`).then(setSugg).catch(() => {}); }, [sel?.id]);
  const run = async (fn: () => Promise<any>, ok = '') => { try { const r = await fn(); setErr(''); setMsg(ok); setSel(null); await load(); return r; } catch (e: any) { setErr(e.message); setMsg(''); } };
  const pickedSum = useMemo(() => Math.round(ledger.filter((e) => picked[e.id]).reduce((s, e) => s + e.remaining, 0) * 100) / 100, [picked, ledger]);
  const eligible = sel ? ledger.filter((e) => Math.sign(e.remaining) === Math.sign(sel.remaining)) : [];
  const locked = sel && statements.find((s) => s.id === sel.statement_id)?.status === 'reconciled';
  return (
    <div>
      <Err e={err} />{msg && <div className="text-success text-sm mb-3" role="status">{msg}</div>}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select className="input w-64" value={stmt} onChange={(e) => setStmt(e.target.value)}><option value="">All statements</option>{statements.map((s) => <option key={s.id} value={s.id}>{s.filename} ({s.period_from?.slice(0, 10)} → {s.period_to?.slice(0, 10)})</option>)}</select>
        {w && <button className="btn" onClick={() => run(async () => { const r = await api('/bank/auto-match', 'POST', { account_id: account, ...(stmt ? { statement_id: Number(stmt) } : {}) }); setMsg(`Matched ${r.matched} automatically; ${r.needs_review} need your review.`); return r; }).then((r) => r && setMsg(`Matched ${r.matched} automatically; ${r.needs_review} need your review.`))}><Sparkles size={15} /> Auto-match</button>}
        <span className="text-sm text-muted">{txns.length} unmatched bank line(s) · {ledger.length} unmatched ledger entr{ledger.length === 1 ? 'y' : 'ies'}</span></div>
      <div className="grid lg:grid-cols-2 gap-4">
        <div><h3 className="font-semibold mb-2">Bank lines to match</h3>
          <Table rows={txns} onRow={setSel} empty="Every bank line is matched" cols={[{ h: 'Date', render: (t: any) => <span className="num">{String(t.tx_date).slice(0, 10)}</span> }, { h: 'Description', render: (t: any) => <div className={sel?.id === t.id ? 'text-accent font-medium' : ''}>{t.description || t.reference}<div className="text-xs text-muted">{t.counterparty}</div></div> },
            { h: 'Amount', right: true, render: (t: any) => <span className={t.amount < 0 ? 'text-danger' : ''}>{money(t.remaining)}</span> }]} /></div>
        <div><h3 className="font-semibold mb-2">{sel ? `Match ${money(sel.remaining)} · ${String(sel.tx_date).slice(0, 10)}` : 'Select a bank line'}</h3>
          {!sel ? <div className="card text-sm text-muted">Pick a line on the left to see suggested ledger matches.</div> : <div className="space-y-3">
            {locked && <div className="flex items-center gap-2 text-sm text-warn"><Lock size={14} /> This statement is reconciled and locked.</div>}
            <div className="card !p-0"><div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted border-b border-line">Suggestions</div>
              {sugg.length === 0 && <div className="px-4 py-3 text-sm text-muted">No exact-amount candidates. Pick entries below, book a difference, or create a receipt.</div>}
              {sugg.map((s, i) => <div key={i} className="px-4 py-3 border-b border-line last:border-0 flex items-center gap-3"><div className="w-14 shrink-0"><div className="text-xs num mb-1">{s.confidence}%</div><div className="h-1.5 rounded bg-surface2"><div className={`h-1.5 rounded ${conf(s.confidence)}`} style={{ width: `${s.confidence}%` }} /></div></div>
                <div className="flex-1 min-w-0 text-sm">{s.entries.map((e: any) => <div key={e.id} className="truncate">{e.voucher_no} · {e.party ?? e.narration} <span className="num text-muted">{String(e.entry_date).slice(0, 10)} {money(e.remaining)}</span></div>)}<div className="text-xs text-muted">{s.combined && <b className="text-warn">combined · </b>}{s.reasons.join(' · ')}</div></div>
                {w && !locked && <button className="btn-ghost" onClick={() => run(() => api(`/bank/transactions/${sel.id}/match`, 'POST', { entries: s.entry_ids.map((id: number, k: number) => ({ gl_entry_id: id, amount: s.amounts[k] })) }), 'Matched')}>Accept</button>}</div>)}</div>
            <div className="card !p-0"><div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted border-b border-line flex justify-between"><span>Choose ledger entries</span><span className="num normal-case">selected {money(pickedSum)}</span></div>
              <div className="max-h-56 overflow-auto">{eligible.map((e) => <label key={e.id} className="px-4 py-2 border-b border-line last:border-0 flex items-center gap-3 text-sm cursor-pointer hover:bg-surface2/60"><input type="checkbox" checked={!!picked[e.id]} onChange={(x) => setPicked({ ...picked, [e.id]: x.target.checked })} />
                <span className="flex-1 truncate">{e.voucher_no} · {e.party ?? e.narration}</span><span className="num text-muted">{String(e.entry_date).slice(0, 10)}</span><span className="num">{money(e.remaining)}</span></label>)}{!eligible.length && <div className="px-4 py-3 text-sm text-muted">No ledger entries in this direction.</div>}</div></div>
            {w && !locked && <div className="flex flex-wrap gap-2">
              <button className="btn" disabled={!Object.values(picked).some(Boolean)} onClick={() => run(() => api(`/bank/transactions/${sel.id}/match`, 'POST', { entries: Object.keys(picked).filter((k) => picked[Number(k)]).map((k) => ({ gl_entry_id: Number(k) })) }), 'Matched')}>Match selected</button>
              <button className="btn-ghost" onClick={() => setAdj({ account_id: '', reason: '' })}>Book difference / fee…</button>
              {sel.amount > 0 && <button className="btn-ghost" onClick={() => setRcpt({ client_id: '' })}>Create client receipt…</button>}
              <button className="btn-ghost" onClick={() => { const r = prompt('Why is this line not a real bank movement? (required)'); if (r) run(() => api(`/bank/transactions/${sel.id}/ignore`, 'POST', { reason: r }), 'Ignored'); }}>Ignore…</button></div>}</div>}</div></div>
      {adj && sel && <Modal title="Book a difference" onClose={() => setAdj(null)}><p className="text-sm text-muted mb-3">Posts {money(Math.abs(sel.remaining - pickedSum))} {sel.remaining - pickedSum < 0 ? 'out of' : 'into'} the bank account against the account you choose, and matches it to this line.</p>
        <Field label="Account (e.g. Bank Charges)"><select className="input" value={adj.account_id} onChange={(e) => setAdj({ ...adj, account_id: e.target.value })}><option value="">Select…</option>{expense.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></Field>
        <Field label="Reason (recorded in the audit log)"><input className="input" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Field>
        <div className="flex justify-end"><button className="btn" disabled={!adj.account_id || adj.reason.length < 3} onClick={() => run(async () => { await api(`/bank/transactions/${sel.id}/match`, 'POST', { entries: Object.keys(picked).filter((k) => picked[Number(k)]).map((k) => ({ gl_entry_id: Number(k) })), adjustment: { account_id: Number(adj.account_id), reason: adj.reason } }); setAdj(null); }, 'Booked and matched')}>Post &amp; match</button></div></Modal>}
      {rcpt && sel && <Modal title={`Create receipt for ${money(sel.amount)}`} onClose={() => setRcpt(null)}><p className="text-sm text-muted mb-3">Records the client receipt into this bank account on the bank's date and matches it. Allocate to invoices later from Client Receipts.</p>
        <Field label="Client"><select className="input" value={rcpt.client_id} onChange={(e) => setRcpt({ client_id: e.target.value })}><option value="">Select…</option>{clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <div className="flex justify-end"><button className="btn" disabled={!rcpt.client_id} onClick={() => run(async () => { await api(`/bank/transactions/${sel.id}/create-receipt`, 'POST', { client_id: Number(rcpt.client_id) }); setRcpt(null); }, 'Receipt created and matched')}>Create &amp; match</button></div></Modal>}
    </div>
  );
}

function Statements({ account, statements, onChange }: { account: number; statements: any[]; onChange(): void }) {
  const { can } = useAuth(); const w = can('admin', 'finance_manager'); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [bal, setBal] = useState<any>({ opening: '', closing: '' }); const [edit, setEdit] = useState<any>(null);
  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    try { const r = await api('/bank/statements', 'POST', { account_id: account, filename: file.name, content: await file.text(), opening_balance: bal.opening === '' ? null : Number(bal.opening), closing_balance: bal.closing === '' ? null : Number(bal.closing) }); setMsg(`Imported ${r.added} line(s); ${r.duplicates} already imported.`); setErr(''); onChange(); }
    catch (x: any) { setErr(x.message); setMsg(''); } e.target.value = '';
  };
  const act = async (fn: () => Promise<any>, ok: string) => { try { await fn(); setErr(''); setMsg(ok); onChange(); } catch (x: any) { setErr(x.message); setMsg(''); } };
  return (
    <div><Err e={err} />{msg && <div className="text-success text-sm mb-3" role="status">{msg}</div>}
      {w && <div className="card flex flex-wrap items-end gap-3 mb-4"><Field label="Opening balance (optional)"><div className="w-40"><Num v={bal.opening} set={(v) => setBal({ ...bal, opening: v })} /></div></Field><Field label="Closing balance"><div className="w-40"><Num v={bal.closing} set={(v) => setBal({ ...bal, closing: v })} /></div></Field>
        <label className="btn cursor-pointer mb-3"><Upload size={15} /> Import CSV / OFX<input type="file" accept=".csv,.ofx,.qfx" hidden onChange={upload} /></label>
        <p className="text-xs text-muted mb-3 max-w-md">CSV needs a date and an amount (or credit/debit) column; reference, payee and balance columns are used when present. Re-importing the same file never duplicates lines.</p></div>}
      <Table rows={statements} cols={[{ h: 'File', render: (s: any) => s.filename }, { h: 'Period', render: (s: any) => <span className="num">{s.period_from?.slice(0, 10)} → {s.period_to?.slice(0, 10)}</span> }, { h: 'Lines', right: true, render: (s: any) => s.line_count },
        { h: 'Unmatched', right: true, render: (s: any) => (s.unmatched ? <span className="text-warn">{s.unmatched}</span> : '—') }, { h: 'Opening', right: true, render: (s: any) => (s.opening_balance != null ? money(s.opening_balance) : '—') }, { h: 'Closing', right: true, render: (s: any) => (s.closing_balance != null ? money(s.closing_balance) : '—') },
        { h: 'Status', render: (s: any) => <Pill s={s.status === 'reconciled' ? 'reconciled' : 'pending'} /> },
        { h: '', render: (s: any) => w && <div className="flex gap-1 justify-end">{s.status === 'open' && <><button className="btn-ghost" onClick={() => setEdit({ id: s.id, opening: s.opening_balance ?? '', closing: s.closing_balance ?? '' })}>Balances</button><button className="btn" onClick={() => act(() => api(`/bank/statements/${s.id}/finalize`, 'POST'), 'Statement reconciled and locked')}><CheckCircle2 size={15} /> Finalise</button></>}
          {s.status === 'reconciled' && can('admin') && <button className="btn-ghost" onClick={() => { const r = prompt('Reason for reopening (required):'); if (r) act(() => api(`/bank/statements/${s.id}/reopen`, 'POST', { reason: r }), 'Reopened'); }}>Reopen…</button>}</div> }]} />
      {edit && <Modal title="Statement balances" onClose={() => setEdit(null)}><div className="grid grid-cols-2 gap-3"><Field label="Opening"><Num v={edit.opening} set={(v) => setEdit({ ...edit, opening: v })} /></Field><Field label="Closing"><Num v={edit.closing} set={(v) => setEdit({ ...edit, closing: v })} /></Field></div>
        <div className="flex justify-end"><button className="btn" onClick={() => act(async () => { await api(`/bank/statements/${edit.id}`, 'PUT', { opening_balance: edit.opening === '' ? null : Number(edit.opening), closing_balance: edit.closing === '' ? null : Number(edit.closing) }); setEdit(null); }, 'Saved')}>Save</button></div></Modal>}
    </div>
  );
}

function Report({ account }: { account: number }) {
  const [r, setR] = useState<any>(null); const [asAt, setAsAt] = useState(new Date().toISOString().slice(0, 10)); const [err, setErr] = useState('');
  useEffect(() => { api(`/bank/reconciliation?account_id=${account}&as_at=${asAt}`).then(setR).catch((e) => setErr(e.message)); }, [account, asAt]);
  if (err) return <Err e={err} />; if (!r) return null;
  const Row = ({ l, v, strong }: { l: string; v: any; strong?: boolean }) => <div className={`flex justify-between py-1.5 ${strong ? 'font-semibold border-t border-line mt-1 pt-2' : ''}`}><span className={strong ? '' : 'text-muted'}>{l}</span><span className="num">{v === null ? '—' : money(v)}</span></div>;
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="card text-sm"><div className="flex items-center justify-between mb-2"><h3 className="font-semibold">Reconciliation</h3><input className="input num w-40" type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)} /></div>
        <Row l="Balance per books" v={r.book_balance} /><Row l="Less: ledger entries not yet on the statement" v={-r.outstanding_ledger_net} /><Row l="Plus: bank lines not yet in the books" v={r.bank_only_net} /><Row l="Expected bank balance" v={r.expected_bank_balance} strong />
        <Row l={`Bank closing balance${r.bank_statement_date ? ` (${String(r.bank_statement_date).slice(0, 10)})` : ''}`} v={r.bank_closing_balance} />
        <div className={`mt-2 rounded-lg px-3 py-2 flex justify-between font-semibold ${r.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}><span>{r.difference === null ? 'No closing balance entered' : r.ok ? 'Reconciled — no difference' : 'Difference'}</span><span className="num">{r.difference === null ? '' : money(r.difference)}</span></div>
        {r.opening_alignment && <div className="mt-3 text-xs text-muted">Opening check: bank opened with <b className="num">{r.opening_alignment.bank_opening != null ? money(r.opening_alignment.bank_opening) : 'unknown'}</b>, books had <b className="num">{money(r.opening_alignment.book_before)}</b>{r.opening_alignment.difference ? <span className="text-danger"> — differ by {money(r.opening_alignment.difference)}; post an opening-balance journal.</span> : ' — aligned.'}</div>}</div>
      <div className="space-y-4"><div><h4 className="font-semibold text-sm mb-2">In the books, not on the statement</h4><Table rows={r.outstanding_ledger} empty="None" cols={[{ h: 'Date', render: (e: any) => <span className="num">{String(e.entry_date).slice(0, 10)}</span> }, { h: 'Entry', render: (e: any) => `${e.voucher_no} ${e.party ?? ''}` }, { h: 'Amount', right: true, render: (e: any) => money(e.remaining) }]} /></div>
        <div><h4 className="font-semibold text-sm mb-2">On the statement, not in the books</h4><Table rows={r.bank_only} empty="None" cols={[{ h: 'Date', render: (e: any) => <span className="num">{String(e.tx_date).slice(0, 10)}</span> }, { h: 'Line', render: (e: any) => e.description }, { h: 'Amount', right: true, render: (e: any) => money(e.remaining) }]} /></div></div>
    </div>
  );
}

export default function Recon() {
  const [accounts, setAccounts] = useState<any[]>([]); const [acc, setAcc] = useState<number | null>(null); const [statements, setStatements] = useState<any[]>([]); const [tab, setTab] = useState<'match' | 'statements' | 'report'>('match');
  const loadAcc = () => api('/bank/accounts').then((a) => { setAccounts(a); setAcc((cur) => cur ?? a[0]?.id ?? null); });
  const loadSt = () => acc && api(`/bank/statements?account_id=${acc}`).then(setStatements);
  useEffect(() => { loadAcc(); }, []); useEffect(() => { loadSt(); }, [acc]);
  const refresh = () => { loadAcc(); loadSt(); };
  return (
    <Page title="Bank reconciliation" description="Match bank statement lines to the ledger's cash entries, then lock the statement.">
      <div className="flex flex-wrap gap-3 mb-4">{accounts.map((a) => (
        <button key={a.id} onClick={() => setAcc(a.id)} className={`card text-left !py-3 min-w-56 ${acc === a.id ? 'border-accent' : ''}`}><div className="font-medium">{a.name}</div><div className="num text-lg font-semibold">{money(a.book_balance)}</div>
          <div className="text-xs text-muted">{a.unmatched_bank} bank · {a.unmatched_ledger} ledger unmatched{a.last_reconciled_to ? ` · reconciled to ${String(a.last_reconciled_to).slice(0, 10)}` : ''}</div></button>))}</div>
      {acc && <><div className="flex gap-2 mb-4">{([['match', 'Match'], ['statements', 'Statements'], ['report', 'Report']] as const).map(([k, l]) => <button key={k} className={tab === k ? 'btn' : 'btn-ghost'} onClick={() => setTab(k)}>{l}</button>)}</div>
        {tab === 'match' && <Workbench account={acc} statements={statements} onChange={refresh} />}{tab === 'statements' && <Statements account={acc} statements={statements} onChange={refresh} />}{tab === 'report' && <Report account={acc} />}</>}
    </Page>
  );
}
