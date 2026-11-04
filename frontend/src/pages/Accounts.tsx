import { Fragment, useEffect, useState } from 'react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Table } from '../components/ui';
import { today, useAccounts, useList } from '../lookup';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';

function LedgerPanel({ accountId, onClose }: { accountId: number; onClose: () => void }) {
  const accounts = useAccounts([]);
  const acc = accounts.find((a: any) => a.id === accountId);
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(today());
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const run = async () => {
    try { setErr(''); setD(await api(`/accounting/ledger?account_id=${accountId}&from=${from}&to=${to}`)); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { run(); }, [accountId]);
  const bal = (n: number) => `${money(Math.abs(n))} ${n < 0 ? 'Cr' : 'Dr'}`;
  return (
    <tr>
      <td colSpan={99} className="p-0 bg-surface2">
        <div className="border-t border-line p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-semibold text-sm">{acc ? `${acc.code} — ${acc.name}` : 'Ledger'}</h4>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-sm">
                <input className="input num py-1 px-2 h-8 text-xs w-32" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                <span className="text-muted">—</span>
                <input className="input num py-1 px-2 h-8 text-xs w-32" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                <button className="btn py-1 px-3 h-8 text-xs" onClick={run}>Show</button>
              </div>
              <button className="text-muted hover:text-fg" onClick={onClose} aria-label="Close"><X size={16} /></button>
            </div>
          </div>
          {err && <div className="text-danger text-sm mb-2">{err}</div>}
          {d ? (
            <>
              <table className="w-full text-sm">
                <thead><tr className="border-b border-line">
                  <th className="text-left py-1 pr-3 font-medium text-muted text-xs">Date</th>
                  <th className="text-left py-1 pr-3 font-medium text-muted text-xs">Voucher</th>
                  <th className="text-left py-1 pr-3 font-medium text-muted text-xs">Narration</th>
                  <th className="text-right py-1 pr-3 font-medium text-muted text-xs">Debit</th>
                  <th className="text-right py-1 pr-3 font-medium text-muted text-xs">Credit</th>
                  <th className="text-right py-1 font-medium text-muted text-xs">Balance</th>
                </tr></thead>
                <tbody>
                  <tr className="border-b border-line/50 italic text-muted">
                    <td colSpan={3} className="py-1 pr-3 text-xs">Opening balance</td>
                    <td /><td />
                    <td className="text-right py-1 num text-xs">{bal(d.opening)}</td>
                  </tr>
                  {d.rows.map((r: any) => (
                    <tr key={r.id} className="border-b border-line/30 hover:bg-surface">
                      <td className="py-1 pr-3 num text-xs">{r.entry_date}</td>
                      <td className="py-1 pr-3 text-xs">{r.voucher_no}</td>
                      <td className="py-1 pr-3 text-xs">{r.narration}</td>
                      <td className="text-right py-1 pr-3 num text-xs">{r.debit ? money(r.debit) : ''}</td>
                      <td className="text-right py-1 pr-3 num text-xs">{r.credit ? money(r.credit) : ''}</td>
                      <td className="text-right py-1 num text-xs">{bal(r.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-right mt-2 num text-sm font-semibold">Closing: {bal(d.closing)}</div>
            </>
          ) : !err && <div className="text-muted text-xs py-2">Loading…</div>}
        </div>
      </td>
    </tr>
  );
}

const NATURES = [
  { key: 'asset', label: 'Assets' }, { key: 'liability', label: 'Liabilities' }, { key: 'equity', label: 'Equity' },
  { key: 'income', label: 'Income' }, { key: 'expense', label: 'Expenses' },
];

export default function Accounts() {
  const { can } = useAuth();
  const types = useList('/accounting/types');
  const branches = useList('/accounting/branches');
  const [type, setType] = useState<number | null>(null);
  const [nature, setNature] = useState<string | null>(null);
  const subTypes = nature ? types.filter((t: any) => t.nature === nature) : [];
  const pickNature = (n: string | null) => { setNature(n); setType(null); };
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [xfer, setXfer] = useState<any>(null);
  const [err, setErr] = useState('');
  const [openLedger, setOpenLedger] = useState<number | null>(null);

  const load = () =>
    api(`/accounting/accounts?${type ? `type=${type}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`).then((r: any[]) => {
      // a category with no sub-type chosen shows every account whose type belongs to it
      const codes = new Set(subTypes.map((t: any) => t.code));
      setRows(!type && nature ? r.filter((a) => codes.has(a.type_code)) : r);
    });

  useEffect(() => { load(); }, [type, nature, q, types.length]);

  const save = async () => {
    try {
      const b = {
        type_code: edit.type_code, name: edit.name,
        branch_id: edit.branch_id ? Number(edit.branch_id) : null,
        city: edit.city || null,
        opening_dr: Number(edit.opening_dr) || 0,
        opening_cr: Number(edit.opening_cr) || 0,
        opening_date: edit.opening_date || null,
        details: edit.details || null,
      };
      edit.id ? await api(`/accounting/accounts/${edit.id}`, 'PUT', b) : await api('/accounting/accounts', 'POST', b);
      setEdit(null); setErr(''); load();
    } catch (e: any) { setErr(e.message); }
  };

  const del = async (r: any) => {
    if (confirm(`Delete ${r.name}?`))
      try { await api(`/accounting/accounts/${r.id}`, 'DELETE'); load(); }
      catch (e: any) { alert(e.message); }
  };

  const w = can('admin', 'finance_manager');

  const toggleLedger = (id: number) => setOpenLedger((prev) => (prev === id ? null : id));

  return (
    <Page title="Accounts & Ledger">
      <div>
        {/* main categories: the five accounting natures, with an optional sub-type picker */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div role="tablist" aria-label="Account category" className="flex flex-wrap gap-1.5">
            {[{ key: null, label: 'All' }, ...NATURES].map((n) => {
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
        </div>

        <div>
          <input className="input max-w-xs mb-3" placeholder="Filter by name or code…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="card p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-line">
                <th className="text-left px-3 py-2 font-medium text-muted text-xs w-6" />
                <th className="text-left px-3 py-2 font-medium text-muted text-xs">Code</th>
                <th className="text-left px-3 py-2 font-medium text-muted text-xs">Name</th>
                <th className="text-left px-3 py-2 font-medium text-muted text-xs">Branch</th>
                <th className="text-left px-3 py-2 font-medium text-muted text-xs">City</th>
                <th className="text-right px-3 py-2 font-medium text-muted text-xs">Opening Dr</th>
                <th className="text-right px-3 py-2 font-medium text-muted text-xs">Opening Cr</th>
                <th className="text-right px-3 py-2 font-medium text-muted text-xs">Balance</th>
                <th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className={`border-b border-line/50 hover:bg-surface2 ${openLedger === r.id ? 'bg-surface2' : ''}`}>
                      <td className="px-3 py-2 w-6">
                        <button className="text-muted hover:text-accent" onClick={() => toggleLedger(r.id)} title="View ledger" aria-label="Toggle ledger">
                          {openLedger === r.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </button>
                      </td>
                      <td className="px-3 py-2 num">{r.code}</td>
                      <td className="px-3 py-2">
                        <button className="text-accent hover:underline text-left font-medium" onClick={() => toggleLedger(r.id)}>{r.name}</button>
                      </td>
                      <td className="px-3 py-2 text-muted">{r.branch}</td>
                      <td className="px-3 py-2 text-muted">{r.city}</td>
                      <td className="px-3 py-2 num text-right">{r.opening_dr ? money(r.opening_dr) : '—'}</td>
                      <td className="px-3 py-2 num text-right">{r.opening_cr ? money(r.opening_cr) : '—'}</td>
                      <td className="px-3 py-2 num text-right font-medium">{`${money(Math.abs(r.balance))} ${r.balance < 0 ? 'Cr' : 'Dr'}`}</td>
                      <td className="px-3 py-2">
                        <div className="flex gap-2 justify-end">
                          <button className="text-accent text-xs hover:underline" onClick={() => setEdit({ ...r })}>Edit</button>
                          {w && !r.sys_key && <>
                            <button className="text-muted text-xs hover:underline" onClick={() => setXfer({ ...r, to: r.type_code })}>Transfer</button>
                            <button className="text-danger text-xs" onClick={() => del(r)} aria-label="Remove"><X size={13} /></button>
                          </>}
                        </div>
                      </td>
                    </tr>
                    {openLedger === r.id && <LedgerPanel accountId={r.id} onClose={() => setOpenLedger(null)} />}
                  </Fragment>
                ))}
                {rows.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-muted text-sm">No accounts found</td></tr>}
              </tbody>
            </table>
          </div>
          {w && <div className="mt-4"><button className="btn" onClick={() => setEdit({ type_code: type ?? subTypes[0]?.code ?? 320, opening_dr: 0, opening_cr: 0 })}><Plus size={15} /> New account</button></div>}
        </div>
      </div>

      {edit && (
        <Modal title={edit.id ? `Account ${edit.code}` : 'New account'} onClose={() => setEdit(null)}>
          <Err e={err} />
          <Field label="Account type">
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
          {w && <div className="flex justify-end"><button className="btn" onClick={save}>Save</button></div>}
        </Modal>
      )}

      {xfer && (
        <Modal title={`Transfer ${xfer.name}`} onClose={() => setXfer(null)}>
          <p className="text-sm text-muted mb-3">Moves the account to another account type and re-issues its code in that range.</p>
          <select className="input mb-3" value={xfer.to} onChange={(e) => setXfer({ ...xfer, to: Number(e.target.value) })}>
            {types.map((t: any) => <option key={t.code} value={t.code}>{t.code} — {t.name}</option>)}
          </select>
          <div className="flex justify-end">
            <button className="btn" onClick={async () => {
              try { await api(`/accounting/accounts/${xfer.id}/transfer`, 'POST', { type_code: xfer.to }); setXfer(null); load(); }
              catch (e: any) { alert(e.message); }
            }}>Transfer</button>
          </div>
        </Modal>
      )}
    </Page>
  );
}
