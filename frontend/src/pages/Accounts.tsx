import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Num, Page, Table } from '../components/ui';
import { today, useAccounts, useList } from '../lookup';
import { Plus, X } from 'lucide-react';

function AccountsTab({ onDrillDown }: { onDrillDown: (id: number) => void }) {
  const { can } = useAuth();
  const types = useList('/accounting/types'); const branches = useList('/accounting/branches');
  const [type, setType] = useState<number | null>(null); const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]); const [edit, setEdit] = useState<any>(null); const [xfer, setXfer] = useState<any>(null); const [err, setErr] = useState('');
  const load = () => api(`/accounting/accounts?${type ? `type=${type}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`).then(setRows);
  useEffect(() => { load(); }, [type, q]);
  const save = async () => {
    try {
      const b = { type_code: edit.type_code, name: edit.name, branch_id: edit.branch_id ? Number(edit.branch_id) : null, city: edit.city || null, opening_dr: Number(edit.opening_dr) || 0, opening_cr: Number(edit.opening_cr) || 0, opening_date: edit.opening_date || null, details: edit.details || null };
      edit.id ? await api(`/accounting/accounts/${edit.id}`, 'PUT', b) : await api('/accounting/accounts', 'POST', b);
      setEdit(null); setErr(''); load();
    } catch (e: any) { setErr(e.message); }
  };
  const del = async (r: any) => { if (confirm(`Delete ${r.name}?`)) try { await api(`/accounting/accounts/${r.id}`, 'DELETE'); load(); } catch (e: any) { alert(e.message); } };
  const w = can('admin', 'finance_manager');
  return (
    <>
      <div className="grid grid-cols-[240px_1fr] gap-4">
        <div className="card p-0 overflow-hidden h-fit"><div className="px-3 py-2 text-xs text-muted uppercase">Account type</div>
          <button className={`block w-full text-left px-3 py-1.5 text-sm ${type === null ? 'bg-accent/15 text-accent' : 'hover:bg-surface2'}`} onClick={() => setType(null)}>All accounts</button>
          {types.map((t) => <button key={t.code} className={`flex justify-between w-full text-left px-3 py-1.5 text-sm ${type === t.code ? 'bg-accent/15 text-accent' : 'hover:bg-surface2'}`} onClick={() => setType(t.code)}>
            <span><span className="num text-muted mr-2">{t.code}</span>{t.name}</span><span className="text-muted">{t.n}</span></button>)}</div>
        <div>
          <input className="input max-w-xs mb-3" placeholder="Filter by name or code…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Table rows={rows} cols={[
            { h: 'Code', render: (r) => <span className="num">{r.code}</span> },
            { h: 'Name', render: (r) => <button className="text-accent hover:underline text-left" onClick={() => onDrillDown(r.id)}>{r.name}</button> },
            { h: 'Branch', render: (r) => r.branch }, { h: 'City/Category', render: (r) => r.city },
            { h: 'Opening Dr', right: true, render: (r) => (r.opening_dr ? money(r.opening_dr) : '-') },
            { h: 'Opening Cr', right: true, render: (r) => (r.opening_cr ? money(r.opening_cr) : '-') },
            { h: 'Balance', right: true, render: (r) => `${money(Math.abs(r.balance))} ${r.balance < 0 ? 'Cr' : 'Dr'}` },
            { h: '', render: (r) => <div className="flex gap-2 justify-end"><button className="text-accent text-sm" onClick={() => setEdit({ ...r })}>Edit</button>
              {w && !r.sys_key && <><button className="text-muted text-sm" onClick={() => setXfer({ ...r, to: r.type_code })}>Transfer</button><button className="text-danger text-sm" onClick={() => del(r)} aria-label="Remove"><X size={14} /></button></>}</div> }]} />
        </div>
      </div>
      {w && <div className="mt-4"><button className="btn" onClick={() => setEdit({ type_code: type ?? 320, opening_dr: 0, opening_cr: 0 })}><Plus size={15} /> New account</button></div>}
      {edit && <Modal title={edit.id ? `Account ${edit.code}` : 'New account'} onClose={() => setEdit(null)}>
        <Err e={err} />
        <Field label="Account type"><select className="input" disabled={!!edit.id} value={edit.type_code} onChange={(e) => setEdit({ ...edit, type_code: Number(e.target.value) })}>{types.map((t) => <option key={t.code} value={t.code}>{t.code} — {t.name}</option>)}</select></Field>
        <Field label="Name"><input className="input" value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Branch"><select className="input" value={edit.branch_id ?? ''} onChange={(e) => setEdit({ ...edit, branch_id: e.target.value })}><option value="">—</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <Field label="City / Category"><input className="input" value={edit.city ?? ''} onChange={(e) => setEdit({ ...edit, city: e.target.value })} /></Field>
          <Field label="Opening Dr"><Num v={edit.opening_dr} set={(v) => setEdit({ ...edit, opening_dr: v })} /></Field>
          <Field label="Opening Cr"><Num v={edit.opening_cr} set={(v) => setEdit({ ...edit, opening_cr: v })} /></Field>
          <Field label="Opening date"><input className="input num" type="date" value={edit.opening_date ?? ''} onChange={(e) => setEdit({ ...edit, opening_date: e.target.value })} /></Field>
        </div>
        <Field label="Details"><textarea className="input" value={edit.details ?? ''} onChange={(e) => setEdit({ ...edit, details: e.target.value })} /></Field>
        {w && <div className="flex justify-end"><button className="btn" onClick={save}>Save</button></div>}</Modal>}
      {xfer && <Modal title={`Transfer ${xfer.name}`} onClose={() => setXfer(null)}>
        <p className="text-sm text-muted mb-3">Moves the account to another account type and re-issues its code in that range.</p>
        <select className="input mb-3" value={xfer.to} onChange={(e) => setXfer({ ...xfer, to: Number(e.target.value) })}>{types.map((t) => <option key={t.code} value={t.code}>{t.code} — {t.name}</option>)}</select>
        <div className="flex justify-end"><button className="btn" onClick={async () => { try { await api(`/accounting/accounts/${xfer.id}/transfer`, 'POST', { type_code: xfer.to }); setXfer(null); load(); } catch (e: any) { alert(e.message); } }}>Transfer</button></div></Modal>}
    </>
  );
}

function LedgerTab({ initialAccountId }: { initialAccountId?: string }) {
  const accounts = useAccounts([]);
  const [id, setId] = useState(initialAccountId ?? '');
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(today());
  const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { if (initialAccountId) setId(initialAccountId); }, [initialAccountId]);
  const run = async () => { try { setErr(''); setD(await api(`/accounting/ledger?account_id=${id}&from=${from}&to=${to}`)); } catch (e: any) { setErr(e.message); } };
  useEffect(() => { if (id) run(); }, [id]);
  const bal = (n: number) => `${money(Math.abs(n))} ${n < 0 ? 'Cr' : 'Dr'}`;
  return (
    <>
      <div className="card flex flex-wrap gap-3 items-end mb-4">
        <div className="min-w-72"><div className="text-xs text-muted mb-1">Account</div>
          <select className="input" value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">Select…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></div>
        <div><div className="text-xs text-muted mb-1">From</div><input className="input num" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><div className="text-xs text-muted mb-1">To</div><input className="input num" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <button className="btn" disabled={!id} onClick={run}>Show</button>
      </div>
      {err && <div className="text-danger text-sm mb-3">{err}</div>}
      {d && <><h3 className="font-bold mb-2">{d.account.code} — {d.account.name}</h3>
        <Table rows={[{ id: -1, narration: 'Opening balance', balance: d.opening } as any, ...d.rows]} cols={[
          { h: 'Date', render: (r: any) => <span className="num">{r.entry_date}</span> }, { h: 'Voucher', render: (r: any) => r.voucher_no }, { h: 'Narration', render: (r: any) => r.narration },
          { h: 'Debit', right: true, render: (r: any) => (r.debit ? money(r.debit) : '') }, { h: 'Credit', right: true, render: (r: any) => (r.credit ? money(r.credit) : '') },
          { h: 'Balance', right: true, render: (r: any) => bal(r.balance) }]} />
        <div className="text-right mt-2 num">Closing: <b>{bal(d.closing)}</b></div></>}
    </>
  );
}

export default function Accounts() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'ledger' ? 'ledger' : 'accounts';
  const [drillAccountId, setDrillAccountId] = useState<string | undefined>();

  const switchTab = (t: string) => setParams(t === 'accounts' ? {} : { tab: t });

  const handleDrillDown = (id: number) => {
    setDrillAccountId(String(id));
    switchTab('ledger');
  };

  return (
    <Page title="Accounts & Ledger">
      <div className="flex gap-1 border-b border-line mb-5">
        {(['accounts', 'ledger'] as const).map((t) => (
          <button key={t} onClick={() => switchTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${tab === t ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-fg'}`}>
            {t === 'accounts' ? 'Chart of Accounts' : 'General Ledger'}
          </button>))}
      </div>
      {tab === 'accounts' && <AccountsTab onDrillDown={handleDrillDown} />}
      {tab === 'ledger' && <LedgerTab initialAccountId={drillAccountId} />}
    </Page>
  );
}
