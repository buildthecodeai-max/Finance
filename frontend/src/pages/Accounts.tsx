import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Download, Eye, FileSpreadsheet, FileText, NotebookPen, Pencil, Plus, Scale, Trash2, X } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Pill } from '../components/ui';
import { today, useList } from '../lookup';
import { voucherHref } from '../voucherLink';

const NATURES = [
  { key: 'asset', label: 'Assets' }, { key: 'liability', label: 'Liabilities' }, { key: 'equity', label: 'Equity' },
  { key: 'income', label: 'Income' }, { key: 'expense', label: 'Expenses' },
];
const bal = (n: number) => `${money(Math.abs(n))} ${n < 0 ? 'Cr' : 'Dr'}`;

function saveCsv(name: string, rows: (string | number)[][]) {
  const text = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

/* ---------- Ledger for one account, shown under its row ---------- */
function LedgerPanel({ acc, onClose }: { acc: any; onClose: () => void }) {
  const y = new Date().getFullYear();
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(today());
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const run = async () => {
    try { setErr(''); setD(await api(`/accounting/ledger?account_id=${acc.id}&from=${from}&to=${to}`)); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { run(); }, [acc.id]);
  const exportFile = async (fmt: 'pdf' | 'xlsx') => {
    try { window.open((await api(`/reports/general-ledger?account_id=${acc.id}&from=${from}&to=${to}&format=${fmt}`)).url); }
    catch (e: any) { setErr(e.message); }
  };
  const csv = () => d && saveCsv(`ledger-${acc.code}.csv`, [
    ['Date', 'Voucher', 'Narration', 'Debit', 'Credit', 'Balance (+Dr / -Cr)'], ['', 'Opening balance', '', '', '', d.opening],
    ...d.rows.map((r: any) => [r.entry_date, r.voucher_no, r.narration ?? '', r.debit || '', r.credit || '', r.balance]), ['Total', '', '', d.debit, d.credit, d.closing]]);
  return (
    <tr>
      <td colSpan={99} className="p-0 bg-surface2">
        <div className="border-t border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h4 className="font-semibold text-sm">Ledger · {acc.code} — {acc.name}</h4>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <input className="input num py-1 px-2 h-8 text-xs w-32" type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
              <span className="text-muted">—</span>
              <input className="input num py-1 px-2 h-8 text-xs w-32" type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
              <button className="btn py-1 px-3 h-8 text-xs" onClick={run}>Show</button>
              {d && <>
                <button className="btn-ghost py-1 px-2 h-8 text-xs flex items-center gap-1" onClick={() => exportFile('pdf')}><FileText size={13} />PDF</button>
                <button className="btn-ghost py-1 px-2 h-8 text-xs flex items-center gap-1" onClick={() => exportFile('xlsx')}><FileSpreadsheet size={13} />Excel</button>
                <button className="btn-ghost py-1 px-2 h-8 text-xs flex items-center gap-1" onClick={csv}><Download size={13} />CSV</button>
              </>}
              <button className="text-muted hover:text-fg" onClick={onClose} aria-label="Close ledger"><X size={16} /></button>
            </div>
          </div>
          {err && <div className="text-danger text-sm mb-2">{err}</div>}
          {d ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-line">
                  {['Date', 'Voucher', 'Narration', 'Debit', 'Credit', 'Balance'].map((h, i) => <th key={h} className={`py-1 pr-3 font-medium text-muted text-xs ${i > 2 ? 'text-right' : 'text-left'}`}>{h}</th>)}
                </tr></thead>
                <tbody>
                  <tr className="border-b border-line/50 italic text-muted">
                    <td colSpan={5} className="py-1 pr-3 text-xs">Opening balance</td>
                    <td className="text-right py-1 num text-xs">{bal(d.opening)}</td>
                  </tr>
                  {d.rows.map((r: any) => {
                    const href = voucherHref(r);
                    return (
                      <tr key={r.id} className="border-b border-line/30 hover:bg-surface">
                        <td className="py-1 pr-3 num text-xs whitespace-nowrap">{r.entry_date}</td>
                        <td className="py-1 pr-3 text-xs whitespace-nowrap">
                          {href ? <Link className="text-accent hover:underline num" to={href}>{r.voucher_no}</Link> : <span className="num">{r.voucher_no}</span>}
                          {r.reversed_by && <span className="ml-1.5"><Pill s="reversed" /></span>}{r.reversal_of && <span className="ml-1.5"><Pill s="reversal" /></span>}
                        </td>
                        <td className="py-1 pr-3 text-xs">{r.narration}</td>
                        <td className="text-right py-1 pr-3 num text-xs">{r.debit ? money(r.debit) : ''}</td>
                        <td className="text-right py-1 pr-3 num text-xs">{r.credit ? money(r.credit) : ''}</td>
                        <td className="text-right py-1 num text-xs">{bal(r.balance)}</td>
                      </tr>
                    );
                  })}
                  {d.rows.length === 0 && <tr><td colSpan={6} className="py-4 text-center text-muted text-xs">No postings in this period.</td></tr>}
                  <tr className="font-semibold border-t border-line">
                    <td colSpan={3} className="py-1.5 pr-3 text-xs">Total · closing balance</td>
                    <td className="text-right py-1.5 pr-3 num text-xs">{money(d.debit)}</td>
                    <td className="text-right py-1.5 pr-3 num text-xs">{money(d.credit)}</td>
                    <td className="text-right py-1.5 num text-xs">{bal(d.closing)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : !err && <div className="text-muted text-xs py-2">Loading…</div>}
        </div>
      </td>
    </tr>
  );
}

/* ---------- Read-only account card ---------- */
function Detail({ id, writer, onClose, onEdit, onTransfer, onDelete }: { id: number; writer: boolean; onClose: () => void; onEdit: (a: any) => void; onTransfer: (a: any) => void; onDelete: (a: any) => void }) {
  const [a, setA] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { api(`/accounting/accounts/${id}`).then(setA).catch((e) => setErr(e.message)); }, [id]);
  const Row = ({ k, v }: { k: string; v: any }) => <div className="flex justify-between gap-4 py-1.5 border-b border-line/50 last:border-0 text-sm"><span className="text-muted">{k}</span><span className="text-right">{v ?? '—'}</span></div>;
  return (
    <Modal title={a ? `${a.code} — ${a.name}` : 'Account'} onClose={onClose}>
      <Err e={err} />
      {a && <>
        <div className="flex flex-wrap gap-2 mb-3">
          <Pill s={a.sys_key ? 'system' : 'active'} />
          <span className="pill bg-muted/15 text-muted">{a.type_name}</span><span className="pill bg-muted/15 text-muted capitalize">{a.nature}</span>
        </div>
        <Row k="Current balance" v={<b className="num">{bal(a.balance)}</b>} />
        <Row k="Opening balance" v={<span className="num">{money(a.opening_dr)} Dr · {money(a.opening_cr)} Cr{a.opening_date ? ` · ${a.opening_date}` : ''}</span>} />
        <Row k="Postings" v={<span className="num">{a.txns} · {money(a.debit)} Dr · {money(a.credit)} Cr</span>} />
        <Row k="Last posting" v={a.last_entry} />
        <Row k="Branch" v={a.branch} /><Row k="City / category" v={a.city} />
        <Row k="Linked to" v={a.linked ? <Link className="text-accent hover:underline" to={a.linked.kind === 'client' ? '/clients' : '/suppliers'}>{a.linked.name} ({a.linked.kind})</Link> : null} />
        <Row k="Created by" v={a.created_by_name} />
        {a.details && <p className="text-sm text-muted mt-3 whitespace-pre-wrap">{a.details}</p>}
        <div className="flex flex-wrap justify-end gap-2 mt-4">
          {writer && <button className="btn-ghost text-danger flex items-center gap-1 disabled:opacity-30" disabled={!!a.sys_key || a.txns > 0} title={a.sys_key ? 'System accounts cannot be deleted' : a.txns > 0 ? 'Accounts with postings cannot be deleted' : 'Delete account'} onClick={() => onDelete(a)}><Trash2 size={14} />Delete</button>}
          {writer && !a.sys_key && <button className="btn-ghost" onClick={() => onTransfer(a)}>Change type</button>}
          {writer && <button className="btn flex items-center gap-1" onClick={() => onEdit(a)}><Pencil size={14} />Edit</button>}
        </div>
      </>}
    </Modal>
  );
}

export default function Accounts() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const types = useList('/accounting/types');
  const branches = useList('/accounting/branches');
  const [type, setType] = useState<number | null>(null);
  const [nature, setNature] = useState<string | null>(null);
  const subTypes = nature ? types.filter((t: any) => t.nature === nature) : [];
  const pickNature = (n: string | null) => { setNature(n); setType(null); };
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [xfer, setXfer] = useState<any>(null);
  const [view, setView] = useState<number | null>(null);
  const [del, setDel] = useState<any>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [openLedger, setOpenLedger] = useState<number | null>(null);
  const w = can('admin', 'finance_manager');

  const load = () =>
    api(`/accounting/accounts?${type ? `type=${type}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`).then((r: any[]) => {
      // a category with no sub-type chosen shows every account whose type belongs to it
      const codes = new Set(subTypes.map((t: any) => t.code));
      setRows(!type && nature ? r.filter((a) => codes.has(a.type_code)) : r); setLoaded(true);
    });
  useEffect(() => { load(); }, [type, nature, q, types.length]);

  // deep link from a report: /accounts?open=<id> shows that account's category and expands its ledger
  useEffect(() => {
    const id = Number(sp.get('open')); if (!id) return;
    api(`/accounting/accounts/${id}`).then((a: any) => { setNature(a.nature); setType(null); setQ(''); setOpenLedger(id); setTimeout(() => document.getElementById(`acc-${id}`)?.scrollIntoView({ block: 'center' }), 500); })
      .catch(() => setMsg('That account no longer exists.')).finally(() => { sp.delete('open'); setSp(sp, { replace: true }); });
  }, [sp]);

  const totals = useMemo(() => {
    const dr = rows.reduce((s, r) => s + (r.balance > 0 ? r.balance : 0), 0), cr = rows.reduce((s, r) => s + (r.balance < 0 ? -r.balance : 0), 0);
    return { dr, cr, opDr: rows.reduce((s, r) => s + Number(r.opening_dr || 0), 0), opCr: rows.reduce((s, r) => s + Number(r.opening_cr || 0), 0) };
  }, [rows]);
  const wholeBook = !nature && !type && !q;
  const diff = Math.round((totals.dr - totals.cr) * 100) / 100;

  const save = async () => {
    if (!edit.name?.trim()) return setErr('Give the account a name.');
    try {
      const b = {
        type_code: edit.type_code, name: edit.name.trim(),
        branch_id: edit.branch_id ? Number(edit.branch_id) : null, city: edit.city || null,
        opening_dr: Number(edit.opening_dr) || 0, opening_cr: Number(edit.opening_cr) || 0,
        opening_date: edit.opening_date || null, details: edit.details || null,
      };
      edit.id ? await api(`/accounting/accounts/${edit.id}`, 'PUT', b) : await api('/accounting/accounts', 'POST', b);
      setMsg(edit.id ? `Saved ${edit.name}.` : `Created ${edit.name}.`); setEdit(null); setErr(''); load();
    } catch (e: any) { setErr(e.message); }
  };
  const remove = async () => {
    try { await api(`/accounting/accounts/${del.id}`, 'DELETE'); setMsg(`Deleted ${del.name}.`); setDel(null); setErr(''); load(); }
    catch (e: any) { setErr(e.message); }
  };
  const blocked = (r: any) => r.sys_key ? 'System accounts cannot be deleted' : r.txns > 0 ? `Has ${r.txns} posting(s) — it can no longer be deleted` : '';
  const toggleLedger = (id: number) => setOpenLedger((prev) => (prev === id ? null : id));

  return (
    <Page title="Accounts & Ledger" description="Chart of accounts, account ledgers and balances. Every figure comes straight from posted vouchers."
      actions={<>
        <Link to="/reports?report=trial-balance" className="btn-ghost flex items-center gap-1.5"><Scale size={15} />Trial balance</Link>
        {w && <Link to="/journal?new=1" className="btn-ghost flex items-center gap-1.5"><NotebookPen size={15} />Journal entry</Link>}
        {w && <button className="btn flex items-center gap-1.5" onClick={() => { setErr(''); setEdit({ type_code: type ?? subTypes[0]?.code ?? 320, opening_dr: 0, opening_cr: 0 }); }}><Plus size={15} />New account</button>}
      </>}>
      {msg && <div className="text-success text-sm mb-3" role="status">{msg}</div>}

      {/* where the money stands, for whatever is on screen */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div className="card py-3"><div className="text-xs text-muted">Accounts shown</div><div className="num text-xl font-semibold">{rows.length}</div></div>
        <div className="card py-3"><div className="text-xs text-muted">Debit balances</div><div className="num text-xl font-semibold">{money(totals.dr)}</div></div>
        <div className="card py-3"><div className="text-xs text-muted">Credit balances</div><div className="num text-xl font-semibold">{money(totals.cr)}</div></div>
        <div className="card py-3"><div className="text-xs text-muted">{wholeBook ? 'Books' : 'Net (Dr − Cr)'}</div>
          {wholeBook ? <div className={`text-sm font-semibold mt-1.5 ${diff === 0 ? 'text-success' : 'text-danger'}`}>{diff === 0 ? '✓ In balance' : `⚠ Out of balance by ${money(Math.abs(diff))}`}</div> : <div className="num text-xl font-semibold">{bal(diff)}</div>}</div>
      </div>

      {/* main categories: the five accounting natures, with an optional sub-type picker */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div role="tablist" aria-label="Account category" className="flex flex-wrap gap-1.5">
          {[{ key: null as string | null, label: 'All' }, ...NATURES].map((n) => {
            const count = n.key ? types.filter((t: any) => t.nature === n.key).reduce((s: number, t: any) => s + Number(t.n), 0) : types.reduce((s: number, t: any) => s + Number(t.n), 0);
            const on = nature === n.key;
            return (
              <button key={n.label} role="tab" aria-selected={on} onClick={() => pickNature(n.key)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${on ? 'bg-accent/10 text-accent border-accent/40' : 'border-line hover:bg-surface2'}`}>
                {n.label} <span className="text-muted ml-1">{count}</span>
              </button>
            );
          })}
        </div>
        {subTypes.length > 1 && (
          <select className="input h-9 py-1 w-auto" aria-label="Account sub-type" value={type ?? ''} onChange={(e) => setType(e.target.value ? Number(e.target.value) : null)}>
            <option value="">All {NATURES.find((n) => n.key === nature)?.label.toLowerCase()} accounts</option>
            {subTypes.map((t: any) => <option key={t.code} value={t.code}>{t.name} ({t.n})</option>)}
          </select>
        )}
        <input className="input max-w-xs h-9 py-1 ml-auto" placeholder="Search name or code…" aria-label="Search accounts" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line">
            <th className="px-3 py-2 w-6" />
            {['Code', 'Name', 'Branch', 'City'].map((h) => <th key={h} className="text-left px-3 py-2 font-medium text-muted text-xs">{h}</th>)}
            {['Opening Dr', 'Opening Cr', 'Balance'].map((h) => <th key={h} className="text-right px-3 py-2 font-medium text-muted text-xs">{h}</th>)}
            <th className="px-3 py-2 text-right font-medium text-muted text-xs">Actions</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr id={`acc-${r.id}`} className={`border-b border-line/50 hover:bg-surface2 ${openLedger === r.id ? 'bg-surface2' : ''}`}>
                  <td className="px-3 py-2 w-6">
                    <button className="text-muted hover:text-accent" onClick={() => toggleLedger(r.id)} title="Show ledger" aria-label={`Toggle ledger for ${r.name}`} aria-expanded={openLedger === r.id}>
                      {openLedger === r.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    </button>
                  </td>
                  <td className="px-3 py-2 num">{r.code}</td>
                  <td className="px-3 py-2"><button className="text-accent hover:underline text-left font-medium" onClick={() => toggleLedger(r.id)}>{r.name}</button>{r.sys_key && <span className="ml-2 text-[10px] uppercase text-muted">system</span>}</td>
                  <td className="px-3 py-2 text-muted">{r.branch}</td>
                  <td className="px-3 py-2 text-muted">{r.city}</td>
                  <td className="px-3 py-2 num text-right">{r.opening_dr ? money(r.opening_dr) : '—'}</td>
                  <td className="px-3 py-2 num text-right">{r.opening_cr ? money(r.opening_cr) : '—'}</td>
                  <td className="px-3 py-2 num text-right font-medium whitespace-nowrap">{bal(r.balance)}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1 justify-end">
                      <button className="btn-ghost p-1.5" onClick={() => setView(r.id)} title="View account" aria-label={`View ${r.name}`}><Eye size={14} /></button>
                      {w && <button className="btn-ghost p-1.5" onClick={() => { setErr(''); setEdit({ ...r }); }} title="Edit account" aria-label={`Edit ${r.name}`}><Pencil size={14} /></button>}
                      {w && <button className="btn-ghost p-1.5 text-danger disabled:opacity-30" disabled={!!blocked(r)} title={blocked(r) || 'Delete account'} aria-label={`Delete ${r.name}`} onClick={() => { setErr(''); setDel(r); }}><Trash2 size={14} /></button>}
                    </div>
                  </td>
                </tr>
                {openLedger === r.id && <LedgerPanel acc={r} onClose={() => setOpenLedger(null)} />}
              </Fragment>
            ))}
            {loaded && rows.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-muted text-sm">No accounts match. {w && 'Use “New account” to add one.'}</td></tr>}
          </tbody>
          {rows.length > 0 && <tfoot><tr className="border-t border-line font-semibold bg-surface2">
            <td /><td colSpan={4} className="px-3 py-2 text-xs">Total · {rows.length} account{rows.length === 1 ? '' : 's'}</td>
            <td className="px-3 py-2 num text-right">{money(totals.opDr)}</td><td className="px-3 py-2 num text-right">{money(totals.opCr)}</td>
            <td className="px-3 py-2 num text-right whitespace-nowrap">{bal(diff)}</td><td />
          </tr></tfoot>}
        </table>
      </div>

      {view && <Detail id={view} writer={w} onClose={() => setView(null)}
        onEdit={(a) => { setView(null); setErr(''); setEdit({ ...a }); }} onTransfer={(a) => { setView(null); setXfer({ ...a, to: a.type_code }); }} onDelete={(a) => { setView(null); setErr(''); setDel(a); }} />}

      {edit && (
        <Modal title={edit.id ? `Edit account ${edit.code}` : 'New account'} onClose={() => setEdit(null)}>
          <Err e={err} />
          <Field label="Account type" hint={edit.id ? 'To move it to another type use “Change type” on the account card.' : undefined}>
            <select className="input" disabled={!!edit.id} value={edit.type_code} onChange={(e) => setEdit({ ...edit, type_code: Number(e.target.value) })}>
              {types.map((t: any) => <option key={t.code} value={t.code}>{t.code} — {t.name}</option>)}
            </select>
          </Field>
          <Field label="Name"><input className="input" value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Branch">
              <select className="input" value={edit.branch_id ?? ''} onChange={(e) => setEdit({ ...edit, branch_id: e.target.value })}>
                <option value="">—</option>{branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="City / Category"><input className="input" value={edit.city ?? ''} onChange={(e) => setEdit({ ...edit, city: e.target.value })} /></Field>
            <Field label="Opening Dr"><Num v={edit.opening_dr} set={(v) => setEdit({ ...edit, opening_dr: v })} /></Field>
            <Field label="Opening Cr"><Num v={edit.opening_cr} set={(v) => setEdit({ ...edit, opening_cr: v })} /></Field>
            <Field label="Opening date"><input className="input num" type="date" value={edit.opening_date ?? ''} onChange={(e) => setEdit({ ...edit, opening_date: e.target.value })} /></Field>
          </div>
          <Field label="Details"><textarea className="input" value={edit.details ?? ''} onChange={(e) => setEdit({ ...edit, details: e.target.value })} /></Field>
          <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn" onClick={save}>{edit.id ? 'Save changes' : 'Create account'}</button></div>
        </Modal>
      )}

      {del && (
        <Modal title={`Delete ${del.name}?`} onClose={() => setDel(null)}>
          <Err e={err} />
          <p className="text-sm text-muted mb-4">{blocked(del) ? blocked(del) + '.' : `Account ${del.code} has no postings, so it can be removed safely. This cannot be undone.`}</p>
          <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setDel(null)}>Cancel</button><button className="btn bg-danger text-white disabled:opacity-40" disabled={!!blocked(del)} onClick={remove}>Delete account</button></div>
        </Modal>
      )}

      {xfer && (
        <Modal title={`Change type of ${xfer.name}`} onClose={() => setXfer(null)}>
          <Err e={err} />
          <p className="text-sm text-muted mb-3">Moves the account to another account type and issues it a new code in that range. Its postings and balance are unchanged.</p>
          <select className="input mb-3" value={xfer.to} onChange={(e) => setXfer({ ...xfer, to: Number(e.target.value) })}>
            {types.map((t: any) => <option key={t.code} value={t.code}>{t.code} — {t.name}</option>)}
          </select>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setXfer(null)}>Cancel</button>
            <button className="btn" disabled={xfer.to === xfer.type_code} onClick={async () => {
              try { await api(`/accounting/accounts/${xfer.id}/transfer`, 'POST', { type_code: xfer.to }); setMsg(`Moved ${xfer.name} to a new type.`); setXfer(null); setErr(''); load(); }
              catch (e: any) { setErr(e.message); }
            }}>Change type</button>
          </div>
        </Modal>
      )}
    </Page>
  );
}
