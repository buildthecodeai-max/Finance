import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/ui';
import { today, useAccounts } from '../lookup';

/** [key, label, what it tells you]. `ledger` reports are for finance roles; `asAt` reports are a position on one date. */
interface Def { key: string; label: string; about: string; ledger?: boolean; asAt?: boolean; account?: boolean }
const CATEGORIES: { label: string; reports: Def[] }[] = [
  { label: 'Financial statements', reports: [
    { key: 'gl-pnl', label: 'Profit & Loss', ledger: true, about: 'Income less costs and expenses, from posted ledger entries.' },
    { key: 'balance-sheet', label: 'Balance Sheet', ledger: true, asAt: true, about: 'What the business owns, owes and is worth on one date. Assets must equal liabilities plus equity.' },
    { key: 'trial-balance', label: 'Trial Balance', ledger: true, asAt: true, about: 'Every account’s balance on one date. Total debits must equal total credits.' },
    { key: 'cash-flow', label: 'Cash Flow', about: 'Money in and out by month, from recorded payments (voided payments excluded).' },
    { key: 'pnl', label: 'Sales-basis P&L', about: 'Profit from issued invoices and recorded expenses — a management view that can differ from the ledger P&L until everything is posted.' },
  ] },
  { label: 'Ledgers & books', reports: [
    { key: 'general-ledger', label: 'General Ledger', ledger: true, account: true, about: 'Every posting to one account with a running balance. Click a voucher to open it.' },
    { key: 'day-book', label: 'Day Book', ledger: true, about: 'Every ledger posting in the period, in date order.' },
    { key: 'cash-book', label: 'Cash & Bank Book', ledger: true, about: 'Opening, receipts, payments and closing balance for each cash and bank account.' },
  ] },
  { label: 'Receivables', reports: [
    { key: 'ar-aging-summary', label: 'AR Aging Summary', asAt: true, about: 'What each client owes, by how overdue it is. Reconciled to the ledger.' },
    { key: 'ar-aging-detail', label: 'AR Aging Detail', asAt: true, about: 'Open invoices one by one.' },
    { key: 'invoice-register', label: 'Invoice Register', about: 'All invoices issued in the period.' },
  ] },
  { label: 'Payables & payments', reports: [
    { key: 'ap-aging', label: 'Payables Aging', asAt: true, about: 'What is owed to suppliers, by how overdue it is. Reconciled to the ledger.' },
    { key: 'supplier-payments', label: 'Supplier Payments', about: 'Total paid to each supplier in the period.' },
    { key: 'payment-register', label: 'Payment Register', ledger: true, about: 'Every payment received and made in the period, with totals.' },
  ] },
  { label: 'Operations', reports: [
    { key: 'commission-summary', label: 'Commission Summary', about: 'Agent commission earned and payable.' },
    { key: 'revenue-by-destination', label: 'Revenue by Destination', about: 'Booking revenue grouped by destination.' },
    { key: 'departures', label: 'Departures', about: 'Upcoming departures with the balance still due.' },
  ] },
];

const isoMonth = (d: Date, m: number) => new Date(Date.UTC(d.getFullYear(), d.getMonth() + m, 1));
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const PRESETS: [string, () => [string, string]][] = [
  ['This month', () => { const n = new Date(); return [fmt(isoMonth(n, 0)), today()]; }],
  ['Last month', () => { const n = new Date(); return [fmt(isoMonth(n, -1)), fmt(new Date(isoMonth(n, 0).getTime() - 864e5))]; }],
  ['This quarter', () => { const n = new Date(), q = Math.floor(n.getMonth() / 3) * 3; return [fmt(new Date(Date.UTC(n.getFullYear(), q, 1))), today()]; }],
  ['This year', () => [`${new Date().getFullYear()}-01-01`, today()]],
  ['Last year', () => { const y = new Date().getFullYear() - 1; return [`${y}-01-01`, `${y}-12-31`]; }],
];
const NUM = /^-?\d+(\.\d{1,2})?$/;

export default function Reports() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const accounts = useAccounts([]);
  const finance = can('admin', 'finance_manager', 'viewer');
  const cats = useMemo(() => CATEGORIES.map((c) => ({ ...c, reports: c.reports.filter((r) => finance || !r.ledger) })).filter((c) => c.reports.length), [finance]);
  const all = cats.flatMap((c) => c.reports);
  const first = all[0]?.key ?? 'cash-flow';
  const wanted = sp.get('report');
  const [name, setName] = useState(all.some((r) => r.key === wanted) ? wanted! : first);
  const y = new Date().getFullYear();
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(today());
  const [account, setAccount] = useState(sp.get('account') ?? '');
  const [rep, setRep] = useState<any>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [bump, setBump] = useState(0);
  const seq = useRef(0);

  const def = all.find((r) => r.key === name) ?? all[0];
  const q = (fmtName: string) => `/reports/${name}?from=${from}&to=${to}&format=${fmtName}${def?.account ? `&account_id=${account}` : ''}`;
  const ready = !def?.account || !!account;

  const run = async () => {
    if (!ready) { setRep(null); setErr(''); return; }
    const mine = ++seq.current;                                             // ignore a slow answer for a report the user has already left
    try { setErr(''); setLoading(true); const r = await api(q('json')); if (mine === seq.current) setRep(r); }
    catch (e: any) { if (mine === seq.current) { setErr(e.message); setRep(null); } }
    finally { if (mine === seq.current) setLoading(false); }
  };
  const exp = async (f: 'pdf' | 'xlsx') => { try { window.open((await api(q(f))).url); } catch (e: any) { setErr(e.message); } };
  const pick = (k: string) => { setName(k); setRep(null); setErr(''); sp.set('report', k); sp.delete('account'); setSp(sp, { replace: true }); };

  // run as soon as a report (or its account) is chosen, so a deep link from the ledger lands on real numbers
  useEffect(() => { run(); }, [name, account, bump]);

  const numeric: boolean[] = useMemo(() => !rep ? [] : rep.columns.map((c: string, i: number) => {
    const cells = rep.rows.map((r: any[]) => r[i]).filter((x: any) => x !== '' && x != null);
    return c !== 'Code' && cells.length > 0 && cells.filter((x: any) => NUM.test(String(x))).length >= cells.length / 2;
  }), [rep]);
  const linkCol = rep ? (rep.columns.includes('Voucher') ? rep.columns.indexOf('Voucher') : rep.columns[0] === 'Code' ? 1 : 0) : 0;
  const styleOf = (i: number, row: any[]) => {
    const k = rep.kinds?.[i];
    if (k) return k;
    const f = typeof row[0] === 'string' ? row[0].toLowerCase() : '';
    return f.startsWith('total') || f.startsWith('net') || f.startsWith('gross') ? 'total' : '';
  };

  return (
    <Page title="Reports" description="Every ledger-based report ties back to the accounts and shows a reconciliation check.">
      <div className="grid grid-cols-1 md:grid-cols-[230px_minmax(0,1fr)] gap-4">
        {/* report list: sidebar on desktop, dropdown on phones */}
        <div className="card p-0 overflow-hidden h-fit hidden md:block">
          {cats.map((cat) => (
            <div key={cat.label}>
              <div className="px-3 py-2 text-xs text-muted uppercase border-b border-line">{cat.label}</div>
              {cat.reports.map((r) => (
                <button key={r.key} onClick={() => pick(r.key)} aria-current={name === r.key}
                  className={`block w-full text-left px-3 py-1.5 text-sm ${name === r.key ? 'bg-accent/15 text-accent font-medium' : 'hover:bg-surface2'}`}>{r.label}</button>
              ))}
            </div>
          ))}
        </div>

        <div className="min-w-0">
          <select className="input md:hidden mb-3" aria-label="Report" value={name} onChange={(e) => pick(e.target.value)}>
            {cats.map((c) => <optgroup key={c.label} label={c.label}>{c.reports.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</optgroup>)}
          </select>

          <div className="card mb-4">
            <div className="font-semibold text-base">{def?.label}</div>
            <p className="text-xs text-muted mb-3">{def?.about}</p>
            <div className="flex flex-wrap gap-3 items-end">
              {def?.account && (
                <div className="min-w-[14rem] flex-1"><div className="text-xs text-muted mb-1">Account</div>
                  <select className="input" value={account} onChange={(e) => { setAccount(e.target.value); }}>
                    <option value="">Choose an account…</option>{accounts.map((a: any) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                  </select></div>
              )}
              {!def?.asAt && <div><div className="text-xs text-muted mb-1">From</div><input className="input num" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>}
              <div><div className="text-xs text-muted mb-1">{def?.asAt ? 'As at' : 'To'}</div><input className="input num" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
              <button className="btn" onClick={run} disabled={loading || !ready}>{loading ? 'Running…' : 'Run'}</button>
              {rep && <>
                <button className="btn-ghost flex items-center gap-1.5" onClick={() => exp('pdf')}><FileText size={15} />PDF</button>
                <button className="btn-ghost flex items-center gap-1.5" onClick={() => exp('xlsx')}><FileSpreadsheet size={15} />Excel</button>
              </>}
            </div>
            {!def?.asAt && <div className="flex flex-wrap gap-1.5 mt-3">
              {PRESETS.map(([l, f]) => <button key={l} className="text-xs px-2 py-1 rounded-md border border-line hover:bg-surface2" onClick={() => { const [a, b] = f(); setFrom(a); setTo(b); setBump((n) => n + 1); }}>{l}</button>)}
            </div>}
          </div>

          {err && <div className="text-danger text-sm mb-3" role="alert">{err}</div>}

          {rep?.reconcile && (
            <div className="space-y-2 mb-4">
              {rep.reconcile.map((c: any) => (
                <div key={c.label} className={`rounded-lg border text-sm p-3 flex flex-wrap justify-between gap-2 ${c.ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>
                  <span>{c.ok ? '✓ Reconciled' : '⚠ Does not reconcile'} — {c.label}</span>
                  <span className="num">report {c.report.toFixed(2)} · source {c.source.toFixed(2)}{!c.ok && ` · diff ${c.difference.toFixed(2)}`}</span>
                </div>
              ))}
            </div>
          )}

          {rep && (
            <>
              <h3 className="font-bold mb-1">{rep.title}</h3>
              {rep.note && <p className="text-xs text-muted mb-3">{rep.note}</p>}
              <div className="card p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-line">
                    {rep.columns.map((c: string, i: number) => <th key={i} className={`px-3 py-2 font-medium text-muted text-xs ${numeric[i] ? 'text-right' : 'text-left'}`}>{c}</th>)}
                  </tr></thead>
                  <tbody>
                    {rep.rows.map((row: any[], i: number) => {
                      const kind = styleOf(i, row), link = rep.links?.[i];
                      return (
                        <tr key={i} className={`border-b border-line/40 ${kind === 'total' ? 'font-semibold bg-surface2' : kind === 'section' ? 'font-semibold text-accent bg-accent/5 tracking-wide' : kind === 'muted' ? 'italic text-muted' : 'hover:bg-surface2'}`}>
                          {row.map((cell, j) => {
                            const num = numeric[j] && kind !== 'section';
                            return (
                              <td key={j} className={`px-3 py-1.5 ${num ? 'text-right num whitespace-nowrap' : ''}`}>
                                {link && j === linkCol && cell !== '' ? <Link className="text-accent hover:underline" to={link}>{cell}</Link> : num && /^-?\d+\.\d{2}$/.test(String(cell)) ? Number(cell).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : cell}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                    {rep.rows.length === 0 && <tr><td colSpan={rep.columns.length} className="px-3 py-8 text-center text-muted text-sm">Nothing to report for this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!rep && !err && !loading && (
            <div className="card flex flex-col items-center justify-center py-16 text-center">
              <Download size={32} className="text-muted mb-3" />
              <p className="text-muted text-sm">{ready ? <>Click <b>Run</b> to generate this report.</> : 'Choose an account to see its ledger.'}</p>
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
