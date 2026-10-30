import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Num, Page, Toolbar } from '../components/ui';
import { printHtml } from './Vouchers';
import { Eye } from 'lucide-react';

const DEF: any = { bank_name: '', bank_code: '', font_name: 'Arial', width: 17.5, length: 8, top_print: true, date_format: 'DDMMYYYY',
  date_font_size: 9, date_width: 1.5, date_spacing: 0, date_top: 3, date_left: 5.5, amount_width: 1, amount_font_size: 9, amount_top: 3.5, amount_left: 6,
  party_width: 5, party_font_size: 9, party_top: 3.5, party_left: 1, words_width: 5, words_font_size: 9, words_top: 3.8, words_left: 1 };

export default function ChequeFormat() {
  const { can } = useAuth(); const [list, setList] = useState<any[]>([]); const [f, setF] = useState<any>(DEF); const [err, setErr] = useState('');
  const load = () => api('/cheque-formats').then(setList);
  useEffect(() => { load(); }, []);
  const save = async () => {
    try { const r = f.id ? await api(`/cheque-formats/${f.id}`, 'PUT', f) : await api('/cheque-formats', 'POST', f); if (!f.id) setF({ ...f, id: r.id }); setErr(''); load(); }
    catch (e: any) { setErr(e.message); }
  };
  const group = (title: string, p: string, extra?: React.ReactNode) => (
    <fieldset className="card"><legend className="px-2 text-sm font-bold">{title}</legend>{extra}
      {['width', 'font_size', 'top', 'left'].map((k) => (p === 'date' || p === 'amount' || p === 'party' || p === 'words') && (
        <Field key={k} label={k.replace('_', ' ')}><Num v={f[`${p}_${k}`]} set={(v) => setF({ ...f, [`${p}_${k}`]: v })} /></Field>))}
      {p === 'date' && <Field label="Spacing"><Num v={f.date_spacing} set={(v) => setF({ ...f, date_spacing: v })} /></Field>}</fieldset>
  );
  return (
    <Page title="Cheque Format">
      <Toolbar canWrite={can('admin', 'finance_manager')} onNew={() => setF(DEF)} onSave={save} />
      <div className="flex gap-2 mb-4 flex-wrap">{list.map((c) => <button key={c.id} className={f.id === c.id ? 'btn' : 'btn-ghost'} onClick={() => setF({ ...c, top_print: !!c.top_print })}>{c.bank_name}</button>)}</div>
      <Err e={err} />
      <div className="grid md:grid-cols-2 gap-4 max-w-4xl">
        <fieldset className="card"><legend className="px-2 text-sm font-bold">Cheque</legend>
          <Field label="Bank name"><input className="input" value={f.bank_name} onChange={(e) => setF({ ...f, bank_name: e.target.value })} /></Field>
          <Field label="Bank code"><input className="input" value={f.bank_code ?? ''} onChange={(e) => setF({ ...f, bank_code: e.target.value })} /></Field>
          <Field label="Font name"><input className="input" value={f.font_name ?? ''} onChange={(e) => setF({ ...f, font_name: e.target.value })} /></Field>
          <Field label="Width (cm)"><Num v={f.width} set={(v) => setF({ ...f, width: v })} /></Field><Field label="Length (cm)"><Num v={f.length} set={(v) => setF({ ...f, length: v })} /></Field>
          <Field label="Date format"><select className="input" value={f.date_format ?? ''} onChange={(e) => setF({ ...f, date_format: e.target.value })}>{['DDMMYYYY', 'DD-MM-YYYY', 'DDMMYY', 'YYYYMMDD', 'MMDDYYYY'].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={!!f.top_print} onChange={(e) => setF({ ...f, top_print: e.target.checked })} /> Top print</label></fieldset>
        {group('Date', 'date')}{group('Amount', 'amount')}{group('Party', 'party')}{group('Words', 'words')}
      </div>
      <div className="card max-w-4xl mt-4 text-sm text-warn bg-warn/10">Notes: all measurements are in centimetres. Use Preview, then print on plain paper over a real cheque to align.</div>
      <button className="btn-ghost mt-4" disabled={!f.id} onClick={async () => printHtml((await api(`/cheque-formats/${f.id}/preview`)).html)}><Eye size={15} /> Preview</button>
    </Page>
  );
}
