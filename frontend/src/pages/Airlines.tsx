import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Num, Page, Table, Toolbar } from '../components/ui';

const blank = { code: '', name: '', iata_code: '', commission_pct: 0, wh_pct: '', details: '', show_flag: true };

export default function Airlines() {
  const { can } = useAuth();
  const [rows, setRows] = useState<any[]>([]); const [f, setF] = useState<any>(blank); const [err, setErr] = useState(''); const [q, setQ] = useState('');
  const load = () => api('/airlines?all=1').then(setRows);
  useEffect(() => { load(); }, []);
  const save = async () => {
    try {
      const body = { code: f.code, name: f.name, iata_code: f.iata_code || null, commission_pct: Number(f.commission_pct) || 0, wh_pct: f.wh_pct === '' || f.wh_pct == null ? null : Number(f.wh_pct), details: f.details || null, show_flag: !!f.show_flag };
      f.id ? await api(`/airlines/${f.id}`, 'PUT', body) : await api('/airlines', 'POST', body);
      setErr(''); setF(blank); load();
    } catch (e: any) { setErr(e.message); }
  };
  const del = async () => { if (!f.id || !confirm(`Delete ${f.name}?`)) return; try { await api(`/airlines/${f.id}`, 'DELETE'); setF(blank); load(); } catch (e: any) { setErr(e.message); } };
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const shown = rows.filter((r) => !q || `${r.code} ${r.name} ${r.iata_code}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Page title="Airlines">
      <Toolbar canWrite={can('admin', 'finance_manager')} onNew={() => setF(blank)} onSave={save} onDelete={f.id ? del : undefined} />
      <Err e={err} />
      <div className="card max-w-md mb-4">
        <Field label="Airline Code"><input className="input num" maxLength={3} value={f.code} onChange={set('code')} /></Field>
        <Field label="Airline Name"><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Code"><input className="input" maxLength={4} placeholder="(AA)" value={f.iata_code ?? ''} onChange={set('iata_code')} /></Field>
        <Field label="Commission %"><Num v={f.commission_pct} set={(v) => setF({ ...f, commission_pct: v })} /></Field>
        <Field label="WH %"><Num v={f.wh_pct} set={(v) => setF({ ...f, wh_pct: v })} /></Field>
        <Field label="Details"><input className="input" value={f.details ?? ''} onChange={set('details')} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.show_flag} onChange={(e) => setF({ ...f, show_flag: e.target.checked })} /> Show</label>
      </div>
      <input className="input max-w-xs mb-3" placeholder="Search airlines…" value={q} onChange={(e) => setQ(e.target.value)} />
      <Table rows={shown} onRow={(r) => setF({ ...r, show_flag: !!r.show_flag })} cols={[
        { h: 'Airline Code', render: (r) => <span className="num">{r.code}</span> }, { h: 'Airline Name', render: (r) => r.name }, { h: 'Code', render: (r) => (r.iata_code ? `(${r.iata_code})` : '') },
        { h: 'Commission', right: true, render: (r) => `${Number(r.commission_pct).toFixed(2)}%` }, { h: 'WH', right: true, render: (r) => (r.wh_pct != null ? `${r.wh_pct}%` : '') },
        { h: 'Details', render: (r) => r.details }, { h: 'Show', render: (r) => (r.show_flag ? '☑' : '☐') }]} />
    </Page>
  );
}
