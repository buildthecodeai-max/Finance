import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Page, Pill, Table } from '../components/ui';
import { today, useAccounts } from '../lookup';

const STEPS = ['draft', 'validated', 'submitted', 'approved', 'exported', 'processing', 'paid'];
const FILE: Record<string, string[]> = { USD: ['ach', 'csv'], AUD: ['aba', 'csv'] };

function Stepper({ status }: { status: string }) {
  const at = STEPS.indexOf(status === 'partially_paid' || status === 'failed' ? 'paid' : status);
  return <div className="flex flex-wrap gap-1.5 mb-4 text-xs">{STEPS.map((s, i) => <span key={s} className={`px-2 py-0.5 rounded-full border capitalize ${i <= at && at >= 0 ? 'bg-accent/15 border-accent/40 text-accent' : 'border-line text-muted'}`}>{s}</span>)}</div>;
}

export default function PaymentRuns() {
  const { can, agency } = useAuth(); const w = can('admin', 'finance_manager'); const banks = useAccounts([110]);
  const [rows, setRows] = useState<any[]>([]); const [err, setErr] = useState('');
  const [form, setForm] = useState<any>(null); const [bills, setBills] = useState<any[]>([]);
  const [view, setView] = useState<any>(null); const [problems, setProblems] = useState<any[]>([]); const [settle, setSettle] = useState<Record<number, any>>({});
  const load = () => api('/finance/payment-runs').then(setRows);
  useEffect(() => { load(); }, []);
  const open = async (id: number) => { setErr(''); setSettle({}); const d = await api(`/finance/payment-runs/${id}`); setView(d); setProblems(d.run.validation?.problems ?? []); };
  const act = async (fn: () => Promise<any>) => {
    try { await fn(); setErr(''); setProblems([]); } catch (e: any) { setErr(e.message); setProblems(e.data?.problems ?? []); }
    if (view) setView(await api(`/finance/payment-runs/${view.run.id}`)); load();
  };
  const post = (path: string, body?: unknown) => act(() => api(`/finance/payment-runs/${view.run.id}/${path}`, 'POST', body));
  const reasoned = (path: string) => post(path, {});
  const startNew = async () => {
    setErr(''); const all = (await api('/finance/bills')).filter((b: any) => ['approved', 'partially_paid'].includes(b.status) && b.outstanding > 0);
    setBills(all); setForm({ currency: agency?.base_currency ?? 'USD', bank_account_id: '', run_date: today(), notes: '', pick: {} });
  };
  const create = async () => {
    try {
      const items = Object.entries(form.pick).filter(([, v]: any) => v.on).map(([id, v]: any) => ({ bill_id: Number(id), amount: Number(v.amount) || undefined }));
      const r = await api('/finance/payment-runs', 'POST', { currency: form.currency, bank_account_id: Number(form.bank_account_id), run_date: form.run_date, notes: form.notes || undefined, items });
      setForm(null); await load(); open(r.id);
    } catch (e: any) { setErr(e.message); }
  };
  const download = async (fmt: string) => {
    try {
      const txt = await api(`/finance/payment-runs/${view.run.id}/bank-file?format=${fmt}`);
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' })); a.download = `payment-run-${view.run.id}.${fmt}`; a.click();
      setErr(''); setView(await api(`/finance/payment-runs/${view.run.id}`)); load();
    } catch (e: any) { setErr(e.message); setProblems(e.data?.problems ?? []); }
  };
  const record = () => {
    const results = Object.entries(settle).filter(([, v]: any) => v.outcome).map(([id, v]: any) => ({ item_id: Number(id), outcome: v.outcome, date: v.date || undefined,
      settlement_ref: v.outcome === 'paid' && !v.manual ? v.ref || undefined : undefined, manual_reason: v.outcome === 'paid' && v.manual ? v.reason : undefined, failure_reason: v.outcome === 'failed' ? v.reason : undefined }));
    if (!results.length) return setErr('Choose paid or failed for at least one item');
    post('settle', { results }).then(() => setSettle({}));
  };
  const r = view?.run, pending = view?.items.filter((i: any) => i.status === 'pending') ?? [];
  const cur = form ? bills.filter((b) => b.currency === form.currency) : [];
  const picked = form ? Object.values(form.pick).filter((v: any) => v.on) as any[] : [];

  return (
    <Page title="Payment runs" description="Pay approved supplier bills in batches. A run needs a second person's approval, and nothing is marked paid until you confirm what the bank actually did."
      actions={w && <button className="btn" onClick={startNew}><Plus size={15} /> New run</button>}>
      <Err e={view ? '' : err} />
      <Table rows={rows} onRow={(x) => open(x.id)} empty="No payment runs yet" cols={[
        { h: 'Run', render: (x) => <span className="num font-medium">#{x.id}</span> }, { h: 'Pay date', render: (x) => <span className="num">{String(x.run_date).slice(0, 10)}</span> },
        { h: 'Status', render: (x) => <Pill s={x.status} /> }, { h: 'Bills', right: true, render: (x) => x.items }, { h: 'Created by', render: (x) => x.created_by_name },
        { h: 'Total', right: true, render: (x) => money(x.total, x.currency) }]} />

      {form && <Modal title="New payment run" wide onClose={() => setForm(null)}><Err e={err} />
        <div className="grid grid-cols-3 gap-x-4">
          <Field label="Currency"><select className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value, pick: {} })}>{[...new Set([agency?.base_currency ?? 'USD', ...bills.map((b) => b.currency)])].map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Pay from"><select className="input" value={form.bank_account_id} onChange={(e) => setForm({ ...form, bank_account_id: e.target.value })}><option value="">Select…</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <Field label="Payment date"><input className="input" type="date" value={form.run_date} onChange={(e) => setForm({ ...form, run_date: e.target.value })} /></Field>
        </div>
        <Field label="Notes"><input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <div className="text-sm font-medium mb-1">Approved bills in {form.currency}</div>
        {cur.length === 0 ? <div className="text-muted text-sm py-4">No approved, unpaid bills in {form.currency}.</div> :
          <div className="card p-0 max-h-72 overflow-auto"><table className="w-full text-sm"><tbody>{cur.map((b) => { const p = form.pick[b.id] ?? { on: false, amount: b.outstanding };
            return <tr key={b.id} className="border-b border-line last:border-0"><td className="p-2 w-8"><input type="checkbox" checked={p.on} onChange={(e) => setForm({ ...form, pick: { ...form.pick, [b.id]: { ...p, on: e.target.checked } } })} /></td>
              <td className="p-2"><span className="num">{b.bill_no}</span> <span className="text-muted">· {b.supplier_name} · due {String(b.due_date).slice(0, 10)}</span></td>
              <td className="p-2 w-36"><input className="input num text-right py-1" type="number" step="0.01" max={b.outstanding} disabled={!p.on} value={p.amount} onChange={(e) => setForm({ ...form, pick: { ...form.pick, [b.id]: { ...p, amount: e.target.value } } })} /></td></tr>; })}</tbody></table></div>}
        <div className="flex justify-between items-center mt-4"><span className="text-sm text-muted">{picked.length} selected · <span className="num text-fg">{money(picked.reduce((s, v) => s + (Number(v.amount) || 0), 0), form.currency)}</span></span>
          <button className="btn" disabled={!picked.length || !form.bank_account_id} onClick={create}>Create draft</button></div></Modal>}

      {view && <Modal title={`Payment run #${r.id}`} wide onClose={() => { setView(null); setProblems([]); }}><Err e={err} />
        {problems.length > 0 && <div className="rounded-lg border border-warn/30 bg-warn/10 text-warn text-sm p-3 mb-3"><b>Fix before continuing</b><ul className="list-disc pl-5 mt-1">{problems.map((p, i) => <li key={i}>{p.message}</li>)}</ul></div>}
        <Stepper status={r.status} />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm mb-4"><Pill s={r.status} /><span className="num font-semibold">{money(r.total, r.currency)}</span><span className="text-muted">pay from {r.bank_account_name} on {String(r.run_date).slice(0, 10)}</span></div>
        <div className="text-xs text-muted mb-3 space-y-0.5">
          <div>Created by {r.created_by_name}{r.submitted_by_name && <> · submitted by {r.submitted_by_name}</>}{r.approved_by_name && <> · approved by {r.approved_by_name}</>}{r.exported_by_name && <> · exported by {r.exported_by_name} ({r.export_format?.toUpperCase()})</>}</div>
          {r.export_checksum && <div>File checksum <span className="num">{r.export_checksum.slice(0, 16)}…</span></div>}{r.cancelled_reason && <div className="text-danger">Cancelled: {r.cancelled_reason}</div>}</div>
        <Table rows={view.items} cols={[
          { h: 'Bill', render: (i: any) => <><span className="num">{i.bill_no}</span> <span className="text-muted text-xs">{i.supplier_ref}</span></> }, { h: 'Supplier', render: (i: any) => i.supplier_name },
          { h: 'Status', render: (i: any) => <><Pill s={i.status} />{i.failure_reason && <span className="text-xs text-danger ml-2">{i.failure_reason}</span>}{i.settlement_ref && <span className="text-xs text-muted ml-2 num">{i.settlement_ref}</span>}{i.manual_reason && <span className="text-xs text-warn ml-2">manual</span>}</> },
          { h: 'Amount', right: true, render: (i: any) => money(i.amount, r.currency) },
          { h: '', render: (i: any) => w && i.status === 'pending' && ['draft', 'validated'].includes(r.status) && <button className="btn-ghost text-danger" onClick={() => act(() => api(`/finance/payment-runs/${r.id}/items/${i.id}`, 'DELETE'))}>Remove</button> }]} />

        {w && SETTLING(r.status) && pending.length > 0 && <div className="mt-4"><div className="text-sm font-medium mb-1">Record what the bank did</div>
          <div className="card p-0"><table className="w-full text-sm"><tbody>{pending.map((i: any) => { const s = settle[i.id] ?? {}; const set = (p: any) => setSettle({ ...settle, [i.id]: { ...s, ...p } });
            return <tr key={i.id} className="border-b border-line last:border-0 align-top"><td className="p-2"><span className="num">{i.bill_no}</span><div className="text-xs text-muted">{i.supplier_name} · {money(i.amount, r.currency)}</div></td>
              <td className="p-2 w-32"><select className="input py-1" value={s.outcome ?? ''} onChange={(e) => set({ outcome: e.target.value })}><option value="">Pending</option><option value="paid">Paid</option><option value="failed">Failed</option></select></td>
              <td className="p-2">{s.outcome === 'paid' && <div className="space-y-1">{!s.manual ? <input className="input py-1" placeholder="Bank reference / statement line" value={s.ref ?? ''} onChange={(e) => set({ ref: e.target.value })} /> : <input className="input py-1" placeholder="Why confirmed without a bank reference (10+ chars)" value={s.reason ?? ''} onChange={(e) => set({ reason: e.target.value })} />}
                <label className="text-xs text-muted flex gap-1 items-center"><input type="checkbox" checked={!!s.manual} onChange={(e) => set({ manual: e.target.checked })} /> No bank reference — confirm manually</label></div>}
                {s.outcome === 'failed' && <input className="input py-1" placeholder="Failure reason" value={s.reason ?? ''} onChange={(e) => set({ reason: e.target.value })} />}</td>
              <td className="p-2 w-36">{s.outcome && <input className="input py-1" type="date" value={s.date ?? today()} onChange={(e) => set({ date: e.target.value })} />}</td></tr>; })}</tbody></table></div></div>}

        <div className="flex flex-wrap justify-end gap-2 mt-5">
          {w && r.status === 'draft' && <button className="btn" onClick={() => post('validate')}>Validate</button>}
          {w && r.status === 'validated' && <button className="btn" onClick={() => post('submit')}>Submit for approval</button>}
          {w && r.status === 'submitted' && <button className="btn" onClick={() => post('approve')}>Approve</button>}
          {w && ['validated', 'submitted', 'approved'].includes(r.status) && <button className="btn-ghost" onClick={() => reasoned('return')}>Return to draft</button>}
          {w && ['draft', 'validated', 'submitted', 'approved'].includes(r.status) && <button className="btn-ghost text-danger" onClick={() => reasoned('cancel')}>Cancel run</button>}
          {w && (r.status === 'approved' || (SETTLING(r.status) && pending.length > 0)) && (FILE[r.currency] ?? ['csv']).map((f) => <button key={f} className={r.status === 'approved' ? 'btn' : 'btn-ghost'} onClick={() => download(f)}>{r.status === 'approved' ? 'Export ' : 'Re-download '}{f.toUpperCase()}</button>)}
          {w && r.status === 'exported' && <button className="btn-ghost" onClick={() => post('processing')}>Mark processing</button>}
          {w && SETTLING(r.status) && pending.length > 0 && <button className="btn" onClick={record}>Record settlement</button>}
          {['paid', 'partially_paid'].includes(r.status) && view.items.some((i: any) => i.status === 'paid') && <button className="btn-ghost" onClick={async () => window.open((await api(`/finance/payment-runs/${r.id}/remittance`, 'POST')).url)}>Remittance PDF</button>}
        </div></Modal>}
    </Page>
  );
}
const SETTLING = (s: string) => ['exported', 'processing', 'partially_paid'].includes(s);
