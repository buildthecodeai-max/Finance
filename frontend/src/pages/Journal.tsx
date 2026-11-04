import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Undo2, X } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Pill, Table } from '../components/ui';
import { today, useAccounts, useOpenOnNew } from '../lookup';

const blankLine = () => ({ account_id: '', debit: '', credit: '', narration: '' });
const state = (r: any) => (r.reversal_of ? 'reversal' : r.reversed_by ? 'reversed' : 'posted');

/* ---------- One posted voucher, with the option to reverse it ---------- */
function View({ id, writer, onClose, onChanged }: { id: number; writer: boolean; onClose: () => void; onChanged: (msg: string) => void }) {
  const [v, setV] = useState<any>(null); const [err, setErr] = useState('');
  const [asking, setAsking] = useState(false); const [date, setDate] = useState(today()); const [note, setNote] = useState('');
  const load = () => api(`/accounting/journal/${id}`).then(setV).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  const dr = v?.lines.reduce((s: number, l: any) => s + l.debit, 0) ?? 0, cr = v?.lines.reduce((s: number, l: any) => s + l.credit, 0) ?? 0;
  const canReverse = writer && v && v.voucher_type === 'journal' && !v.reversed_by && !v.ref_table;
  const reverse = async () => {
    try { const r = await api(`/accounting/journal/${id}/reverse`, 'POST', { date, reason: note || undefined }); setAsking(false); onChanged(`Reversed ${v.voucher_no}.`); setV(null); setErr(''); load(); return r; }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <Modal title={v?.voucher_no ?? 'Journal voucher'} onClose={onClose} wide>
      <Err e={err} />
      {v && <>
        <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
          <Pill s={state(v)} /><span className="text-muted num">{v.voucher_date}</span>
          {v.created_by_name && <span className="text-muted">· posted by {v.created_by_name}</span>}
          {v.reversed_by_voucher && <span className="text-muted">· reversed by <button className="text-accent hover:underline num" onClick={() => { setV(null); api(`/accounting/journal/${v.reversed_by_voucher.id}`).then(setV); }}>{v.reversed_by_voucher.voucher_no}</button></span>}
          {v.reversal_of_voucher && <span className="text-muted">· reverses <button className="text-accent hover:underline num" onClick={() => { setV(null); api(`/accounting/journal/${v.reversal_of_voucher.id}`).then(setV); }}>{v.reversal_of_voucher.voucher_no}</button></span>}
        </div>
        {v.narration && <p className="text-sm mb-3">{v.narration}</p>}
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="border-b border-line"><th className="text-left py-1.5 pr-3 text-xs font-medium text-muted">Account</th><th className="text-left py-1.5 pr-3 text-xs font-medium text-muted">Narration</th><th className="text-right py-1.5 pr-3 text-xs font-medium text-muted">Debit</th><th className="text-right py-1.5 text-xs font-medium text-muted">Credit</th></tr></thead>
          <tbody>
            {v.lines.map((l: any) => (
              <tr key={l.id} className="border-b border-line/40">
                <td className="py-1.5 pr-3"><Link className="text-accent hover:underline" to={`/accounts?open=${l.account_id}`}><span className="num text-muted mr-1.5">{l.code}</span>{l.name}</Link></td>
                <td className="py-1.5 pr-3 text-muted text-xs">{l.narration && l.narration !== v.narration ? l.narration : ''}</td>
                <td className="py-1.5 pr-3 text-right num">{l.debit ? money(l.debit) : ''}</td><td className="py-1.5 text-right num">{l.credit ? money(l.credit) : ''}</td>
              </tr>
            ))}
            <tr className="font-semibold"><td className="py-1.5" colSpan={2}>Total</td><td className="py-1.5 pr-3 text-right num">{money(dr)}</td><td className="py-1.5 text-right num">{money(cr)}</td></tr>
          </tbody>
        </table></div>
        {v.ref_table && v.voucher_type === 'journal' && <p className="text-xs text-muted mt-3">Created by another module ({v.ref_table.replace(/_/g, ' ')}); it is corrected there, not here.</p>}
        {canReverse && !asking && <div className="flex justify-end mt-4"><button className="btn-ghost flex items-center gap-1.5" onClick={() => setAsking(true)}><Undo2 size={14} />Reverse entry</button></div>}
        {asking && (
          <div className="mt-4 rounded-lg border border-line bg-surface2 p-3">
            <p className="text-sm mb-3">Posted entries are never edited or deleted. Reversing adds a mirror-image voucher so both stay on record and the net effect is zero.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Reversal date"><input className="input num" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            </div>
            <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setAsking(false)}>Cancel</button><button className="btn" onClick={reverse}>Reverse {v.voucher_no}</button></div>
          </div>
        )}
      </>}
    </Modal>
  );
}

export default function Journal() {
  const { can } = useAuth(); const accounts = useAccounts([]);
  const w = can('admin', 'finance_manager');
  const [sp, setSp] = useSearchParams();
  const [rows, setRows] = useState<any[]>([]); const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [open, setOpen] = useState(false); const [view, setView] = useState<number | null>(null); const [msg, setMsg] = useState('');
  const [date, setDate] = useState(today()); const [narr, setNarr] = useState(''); const [err, setErr] = useState('');
  const [lines, setLines] = useState<any[]>([blankLine(), blankLine()]);
  const load = () => api(`/accounting/journal?${new URLSearchParams({ ...(q && { q }), ...(from && { from }), ...(to && { to }) })}`).then((r) => { setRows(r); setLoaded(true); });
  useEffect(() => { load(); }, [q, from, to]);
  const start = () => { setLines([blankLine(), blankLine()]); setNarr(''); setDate(today()); setErr(''); setOpen(true); };
  useOpenOnNew(start);
  useEffect(() => { const id = Number(sp.get('view')); if (id) { setView(id); sp.delete('view'); setSp(sp, { replace: true }); } }, [sp]);

  const dr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0), cr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const diff = Math.round((dr - cr) * 100) / 100;
  const filled = lines.filter((l) => l.account_id);
  const both = lines.some((l) => Number(l.debit) > 0 && Number(l.credit) > 0);
  const problem = filled.length < 2 ? 'Choose at least two accounts.' : both ? 'A line is either a debit or a credit, not both.' : dr === 0 ? 'Enter an amount.' : diff !== 0 ? `Out of balance by ${money(Math.abs(diff))}.` : '';
  const set = (i: number, k: string, v: any) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  // put the missing amount on a line: the quickest way to finish a balanced entry
  const balanceOn = (i: number) => setLines(lines.map((l, j) => (j !== i ? l : diff > 0 ? { ...l, credit: String((Number(l.credit) || 0) + diff), debit: '' } : { ...l, debit: String((Number(l.debit) || 0) - diff), credit: '' })));
  const save = async () => {
    try {
      await api('/accounting/journal', 'POST', { date, narration: narr || undefined, lines: filled.map((l) => ({ account_id: Number(l.account_id), debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, narration: l.narration || undefined })) });
      setOpen(false); setMsg('Journal voucher posted.'); load();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <Page title="Journal Voucher" description="Manual entries to the ledger. Posted vouchers are corrected by reversing them, never by editing."
      actions={w && <button className="btn flex items-center gap-1.5" onClick={start}><Plus size={15} />New voucher</button>}>
      {msg && <div className="text-success text-sm mb-3" role="status">{msg}</div>}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input className="input max-w-xs h-9 py-1" placeholder="Search voucher no. or narration…" aria-label="Search vouchers" value={q} onChange={(e) => setQ(e.target.value)} />
        <input className="input num h-9 py-1 w-36" type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-muted text-sm">to</span>
        <input className="input num h-9 py-1 w-36" type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
        {(q || from || to) && <button className="btn-ghost h-9 py-1 flex items-center gap-1" onClick={() => { setQ(''); setFrom(''); setTo(''); }}><X size={13} />Clear</button>}
      </div>
      <Table rows={rows} onRow={(r) => setView(r.id)} empty={loaded ? (q || from || to ? 'No vouchers match these filters.' : 'No journal vouchers yet.') : 'Loading…'} cols={[
        { h: 'No', render: (r) => <span className="num">{r.voucher_no}</span> }, { h: 'Date', render: (r) => <span className="num">{r.voucher_date}</span> },
        { h: 'Narration', render: (r) => r.narration }, { h: 'Status', render: (r) => <Pill s={state(r)} /> },
        { h: 'Amount', right: true, render: (r) => <span className="num">{money(r.amount)}</span> },
      ]} />

      {open && <Modal title="New journal voucher" onClose={() => setOpen(false)} wide>
        <Err e={err} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Date"><input className="input num" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Narration"><input className="input" placeholder="What is this entry for?" value={narr} onChange={(e) => setNarr(e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-12 gap-2 text-xs text-muted mb-1 hidden sm:grid"><span className="col-span-5">Account</span><span className="col-span-3">Line note</span><span className="col-span-2">Debit</span><span className="col-span-2">Credit</span></div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 mb-2 items-center">
            <select className="input col-span-12 sm:col-span-5" aria-label={`Line ${i + 1} account`} value={l.account_id} onChange={(e) => set(i, 'account_id', e.target.value)}>
              <option value="">Account…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
            </select>
            <input className="input col-span-12 sm:col-span-3" placeholder="Note (optional)" aria-label={`Line ${i + 1} note`} value={l.narration} onChange={(e) => set(i, 'narration', e.target.value)} />
            <div className="col-span-5 sm:col-span-2"><Num v={l.debit} set={(v) => set(i, 'debit', v)} placeholder="Debit" aria-label={`Line ${i + 1} debit`} /></div>
            <div className="col-span-5 sm:col-span-2 flex items-center gap-1"><div className="flex-1 min-w-0"><Num v={l.credit} set={(v) => set(i, 'credit', v)} placeholder="Credit" aria-label={`Line ${i + 1} credit`} /></div>
              {lines.length > 2 && <button className="text-muted hover:text-danger shrink-0" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}><X size={14} /></button>}</div>
            {diff !== 0 && l.account_id && !(Number(l.debit) || Number(l.credit)) && <button className="col-span-2 text-xs text-accent hover:underline text-left" onClick={() => balanceOn(i)}>Balance here</button>}
          </div>
        ))}
        <button className="btn-ghost mb-3" onClick={() => setLines([...lines, blankLine()])}>+ Line</button>
        <div className="flex flex-wrap justify-between items-center gap-2">
          <span className={`num text-sm ${problem ? 'text-warn' : 'text-success'}`}>Dr {money(dr)} · Cr {money(cr)} · {problem || 'Balanced ✓'}</span>
          <div className="flex gap-2"><button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={!!problem} onClick={save}>Post voucher</button></div>
        </div>
      </Modal>}

      {view && <View id={view} writer={w} onClose={() => setView(null)} onChanged={(m) => { setMsg(m); load(); }} />}
    </Page>
  );
}
