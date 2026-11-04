import { useState } from 'react';
import { api } from '../api';
import { Page } from '../components/ui';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';

const CATEGORIES = [
  {
    label: 'Financial Statements',
    reports: [
      ['gl-pnl', 'Profit & Loss (Ledger)'],
      ['pnl', 'Profit & Loss (Invoices)'],
      ['cash-flow', 'Cash Flow'],
    ],
  },
  {
    label: 'Receivables',
    reports: [
      ['ar-aging-summary', 'AR Aging Summary'],
      ['ar-aging-detail', 'AR Aging Detail'],
      ['invoice-register', 'Invoice Register'],
    ],
  },
  {
    label: 'Payables',
    reports: [
      ['ap-aging', 'Payables Aging'],
      ['supplier-payments', 'Supplier Payments'],
    ],
  },
  {
    label: 'Operations',
    reports: [
      ['commission-summary', 'Commission Summary'],
      ['revenue-by-destination', 'Revenue by Destination'],
      ['departures', 'Departures'],
    ],
  },
];

const ALL_REPORTS = CATEGORIES.flatMap((c) => c.reports);

export default function Reports() {
  const y = new Date().getFullYear();
  const [name, setName] = useState('gl-pnl');
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [rep, setRep] = useState<any>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const label = ALL_REPORTS.find(([k]) => k === name)?.[1] ?? name;
  const q = (fmt: string) => `/reports/${name}?from=${from}&to=${to}&format=${fmt}`;

  const run = async () => {
    try { setErr(''); setLoading(true); setRep(await api(q('json'))); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };
  const exp = async (fmt: 'pdf' | 'xlsx') => {
    try { window.open((await api(q(fmt))).url); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <Page title="Reports">
      <div className="grid grid-cols-[220px_1fr] gap-4">
        {/* sidebar */}
        <div className="card p-0 overflow-hidden h-fit">
          {CATEGORIES.map((cat) => (
            <div key={cat.label}>
              <div className="px-3 py-2 text-xs text-muted uppercase border-b border-line">{cat.label}</div>
              {cat.reports.map(([k, l]) => (
                <button key={k} onClick={() => { setName(k); setRep(null); setErr(''); }}
                  className={`block w-full text-left px-3 py-1.5 text-sm ${name === k ? 'bg-accent/15 text-accent font-medium' : 'hover:bg-surface2'}`}>
                  {l}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* report area */}
        <div>
          <div className="card flex flex-wrap gap-3 items-end mb-4">
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-base">{label}</div>
            </div>
            <div><div className="text-xs text-muted mb-1">From</div><input className="input num" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div><div className="text-xs text-muted mb-1">To</div><input className="input num" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            <button className="btn" onClick={run} disabled={loading}>{loading ? 'Running…' : 'Run'}</button>
            {rep && (
              <>
                <button className="btn-ghost flex items-center gap-1.5" onClick={() => exp('pdf')}><FileText size={15} />PDF</button>
                <button className="btn-ghost flex items-center gap-1.5" onClick={() => exp('xlsx')}><FileSpreadsheet size={15} />Excel</button>
              </>
            )}
          </div>

          {err && <div className="text-danger text-sm mb-3">{err}</div>}

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
                    {rep.columns.map((c: string, i: number) => (
                      <th key={i} className={`px-3 py-2 font-medium text-muted text-xs ${i > 0 ? 'text-right' : 'text-left'}`}>{c}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {rep.rows.map((row: any[], i: number) => {
                      const isSummary = typeof row[0] === 'string' && (row[0].toLowerCase().startsWith('total') || row[0].toLowerCase().startsWith('net') || row[0].toLowerCase().startsWith('gross'));
                      return (
                        <tr key={i} className={`border-b border-line/40 ${isSummary ? 'font-semibold bg-surface2' : 'hover:bg-surface2'}`}>
                          {row.map((cell, j) => (
                            <td key={j} className={`px-3 py-1.5 ${j > 0 ? 'text-right num' : ''}`}>{cell}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!rep && !err && !loading && (
            <div className="card flex flex-col items-center justify-center py-16 text-center">
              <Download size={32} className="text-muted mb-3" />
              <p className="text-muted text-sm">Select a report and click <b>Run</b> to generate it.</p>
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
