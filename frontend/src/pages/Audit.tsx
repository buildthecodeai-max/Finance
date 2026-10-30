import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal, Page, Table } from '../components/ui';

export default function Audit() {
  const [tab, setTab] = useState<'audit' | 'security'>('audit');
  const [rows, setRows] = useState<any[]>([]); const [entity, setEntity] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [view, setView] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => {
    const qs = tab === 'audit' ? `/admin/audit?${entity ? `entity=${entity}&` : ''}${from ? `from=${from}&` : ''}${to ? `to=${to}` : ''}` : '/admin/security-events';
    api(qs).then((r) => { setRows(r); setErr(''); }).catch((e) => setErr(e.message));
  }, [tab, entity, from, to]);
  return (
    <Page title="Audit log">
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        {(['audit', 'security'] as const).map((t) => <button key={t} className={tab === t ? 'btn' : 'btn-ghost'} onClick={() => setTab(t)}>{t === 'audit' ? 'Change history' : 'Security events'}</button>)}
        {tab === 'audit' && <><select className="input w-48" value={entity} onChange={(e) => setEntity(e.target.value)}><option value="">All entities</option>
          {['invoices', 'ticket_invoices', 'ticket_lines', 'vouchers', 'cash_vouchers', 'refunds', 'accounts', 'airlines', 'clients', 'suppliers', 'agencies', 'agencies.locked_through', 'memberships'].map((e) => <option key={e}>{e}</option>)}</select>
          <input className="input w-40 num" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><input className="input w-40 num" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></>}
      </div>
      {err && <div className="text-danger text-sm mb-3">{err}</div>}
      {tab === 'audit'
        ? <Table rows={rows} onRow={setView} cols={[{ h: 'When', render: (r) => <span className="num">{new Date(r.created_at).toLocaleString()}</span> }, { h: 'User', render: (r) => r.user_name ?? 'System' }, { h: 'Action', render: (r) => r.action },
          { h: 'Entity', render: (r) => `${r.entity} #${r.entity_id ?? ''}` }, { h: 'Reason', render: (r) => r.reason }, { h: 'IP', render: (r) => <span className="num">{r.ip}</span> }]} />
        : <Table rows={rows} cols={[{ h: 'When', render: (r) => <span className="num">{new Date(r.created_at).toLocaleString()}</span> }, { h: 'User', render: (r) => r.user_name ?? '—' }, { h: 'Event', render: (r) => r.event.replace(/_/g, ' ') }, { h: 'Detail', render: (r) => r.detail }, { h: 'IP', render: (r) => <span className="num">{r.ip}</span> }]} />}
      {view && <Modal title={`${view.action} ${view.entity} #${view.entity_id ?? ''}`} onClose={() => setView(null)}>
        <div className="grid grid-cols-2 gap-4 text-xs"><div><div className="text-muted mb-1">Before</div><pre className="bg-bg p-2 rounded overflow-auto max-h-96">{JSON.stringify(typeof view.before_json === 'string' ? JSON.parse(view.before_json) : view.before_json, null, 2) ?? '—'}</pre></div>
          <div><div className="text-muted mb-1">After</div><pre className="bg-bg p-2 rounded overflow-auto max-h-96">{JSON.stringify(typeof view.after_json === 'string' ? JSON.parse(view.after_json) : view.after_json, null, 2) ?? '—'}</pre></div></div></Modal>}
    </Page>
  );
}
