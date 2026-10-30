import { useEffect, useState } from 'react';
import { Copy, Plus } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Page, Pill, Table } from '../components/ui';

const today = () => new Date().toISOString().slice(0, 10);
const ago = (d: string | null) => (d ? String(d).replace('T', ' ').slice(0, 16) : 'never');
const SCOPES = [['leads:write', 'Create leads'], ['clients:read', 'Read clients'], ['invoices:read', 'Read invoices']];
const download = async (path: string, name: string) => {
  const txt = await api(path); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/csv' })); a.download = name; a.click();
};

export default function Integrations() {
  const { can } = useAuth(); const admin = can('admin');
  const [tab, setTab] = useState<'health' | 'keys' | 'webhooks' | 'accounting' | 'imports'>(admin ? 'health' : 'accounting');
  const [health, setHealth] = useState<any>(null); const [keys, setKeys] = useState<any[]>([]); const [hooks, setHooks] = useState<any[]>([]); const [events, setEvents] = useState<string[]>([]);
  const [maps, setMaps] = useState<any[]>([]); const [exps, setExps] = useState<any[]>([]); const [imps, setImps] = useState<any[]>([]);
  const [err, setErr] = useState(''); const [form, setForm] = useState<any>(null); const [secret, setSecret] = useState<{ label: string; value: string } | null>(null); const [dl, setDl] = useState<any>(null);
  const [ex, setEx] = useState({ kind: 'journals', format: 'generic', from: today().slice(0, 8) + '01', to: today() }); const [imp, setImp] = useState<any>({ csv: '', create_clients: false, skip_errors: false, result: null });
  const load = () => {
    if (admin) { api('/hub/health').then(setHealth); api('/hub/api-keys').then(setKeys); api('/hub/webhooks').then(setHooks); api('/hub/webhook-events').then(setEvents); }
    api('/hub/mappings').then(setMaps).catch(() => {}); api('/hub/exports').then(setExps).catch(() => {}); api('/hub/imports').then(setImps).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  const go = async (fn: () => Promise<any>) => { try { const r = await fn(); setErr(''); load(); return r; } catch (e: any) { setErr(e.message + (e.data?.problems ? ' — ' + e.data.problems.map((p: any) => p.message).join('; ') : '')); } };
  const copy = (v: string) => navigator.clipboard?.writeText(v);
  const secretBox = secret && <div className="rounded-lg border border-success/30 bg-success/10 text-sm p-3 mb-4"><div className="font-medium text-success mb-1">{secret.label} — copy it now, it won't be shown again</div><div className="flex gap-2"><input className="input num text-xs" readOnly value={secret.value} onFocus={(e) => e.target.select()} /><button className="btn-ghost" onClick={() => copy(secret.value)}><Copy size={14} /></button></div></div>;
  const tabs: [typeof tab, string][] = [...(admin ? [['health', 'Health'], ['keys', 'API keys'], ['webhooks', 'Webhooks']] as [typeof tab, string][] : []), ['accounting', 'Accounting export'], ['imports', 'Imports']];

  return (
    <Page title="Integrations" description="Connect other systems: public API, signed webhooks, accounting exports and CSV imports. Every connection can be inspected and revoked here."
      actions={tabs.map(([k, l]) => <button key={k} className={tab === k ? 'btn' : 'btn-ghost'} onClick={() => setTab(k)}>{l}</button>)}>
      <Err e={form ? '' : err} />{secretBox}

      {tab === 'health' && health && <div className="grid gap-3 md:grid-cols-3">
        <div className="card"><div className="text-xs text-muted">API keys active</div><div className="text-2xl font-semibold num">{health.api_keys.n}</div><div className="text-xs text-muted">last used {ago(health.api_keys.last_used)}</div></div>
        <div className="card"><div className="text-xs text-muted">Webhook deliveries dead-lettered</div><div className={`text-2xl font-semibold num ${health.dead_deliveries ? 'text-danger' : ''}`}>{health.dead_deliveries}</div><div className="text-xs text-muted">retry them under Webhooks</div></div>
        <div className="card"><div className="text-xs text-muted">Last accounting export / import</div><div className="text-sm">{ago(health.last_export)}</div><div className="text-sm">{ago(health.last_import)}</div></div>
        <div className="card md:col-span-3"><div className="font-medium mb-2">Webhook endpoints</div>{health.webhooks.length === 0 ? <div className="text-sm text-muted">None configured.</div> : health.webhooks.map((h: any) => <div key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2 border-t border-line first:border-0 text-sm">
          <div><b>{h.name}</b> <span className="text-xs text-muted">{h.url}</span>{h.disabled_reason && <div className="text-xs text-danger">{h.disabled_reason}</div>}</div>
          <div className="flex items-center gap-3 text-xs"><Pill s={h.active ? (h.consecutive_failures ? 'overdue' : 'approved') : 'void'} /><span>backlog {h.backlog}</span><span className={h.dead ? 'text-danger' : ''}>dead {h.dead}</span><span className="text-muted">ok {ago(h.last_success_at)}</span></div></div>)}</div>
        <div className="card md:col-span-3"><div className="font-medium mb-2">Accounting connections (OAuth)</div>{health.oauth.length === 0 ? <div className="text-sm text-muted">No Xero / QuickBooks connection. Use Accounting export for CSV.</div> : health.oauth.map((o: any) => <div key={o.provider} className="flex justify-between items-center py-1 text-sm"><span className="capitalize">{o.provider} · linked {ago(o.updated_at)}</span><button className="btn-ghost text-danger" onClick={() => confirm(`Disconnect ${o.provider}? Stored tokens are deleted.`) && go(() => api(`/integrations/${o.provider}`, 'DELETE'))}>Disconnect</button></div>)}</div></div>}

      {tab === 'keys' && <>{admin && <div className="mb-3"><button className="btn" onClick={() => setForm({ kind: 'key', name: '', scopes: ['leads:write'], days: '' })}><Plus size={15} /> New API key</button></div>}
        <Table rows={keys} empty="No API keys" cols={[{ h: 'Name', render: (k) => <>{k.name} <span className="num text-xs text-muted">tfk_{k.key_prefix}…</span></> }, { h: 'Scopes', render: (k) => k.scopes.split(',').join(', ') }, { h: 'Last used', render: (k) => <span className="text-xs">{ago(k.last_used_at)} · {k.use_count}×</span> },
          { h: 'Status', render: (k) => <Pill s={k.revoked_at ? 'void' : k.expires_at && new Date(k.expires_at) < new Date() ? 'expired' : 'approved'} /> }, { h: '', render: (k) => !k.revoked_at && <button className="btn-ghost text-danger" onClick={() => confirm('Revoke this key? Anything using it stops working immediately.') && go(() => api(`/hub/api-keys/${k.id}/revoke`, 'POST'))}>Revoke</button> }]} />
        <p className="text-xs text-muted mt-3">Use <span className="num">Authorization: Bearer tfk_…</span> against <span className="num">/api/v1</span>: <span className="num">POST /leads</span> (send an <span className="num">Idempotency-Key</span>), <span className="num">GET /clients</span>, <span className="num">GET /invoices</span>. 120 requests/minute per key.</p></>}

      {tab === 'webhooks' && <>{admin && <div className="mb-3"><button className="btn" onClick={() => setForm({ kind: 'hook', name: '', url: '', events: ['*'] })}><Plus size={15} /> New endpoint</button></div>}
        <Table rows={hooks} empty="No webhook endpoints" cols={[{ h: 'Endpoint', render: (h) => <><div>{h.name}</div><div className="text-xs text-muted">{h.url}</div></> }, { h: 'Events', render: (h) => (h.events === '*' ? 'All' : h.events.split(',').join(', ')) },
          { h: 'Status', render: (h) => <><Pill s={h.active ? 'approved' : 'void'} />{h.disabled_reason && <div className="text-xs text-danger">{h.disabled_reason}</div>}</> },
          { h: '', render: (h) => <div className="flex gap-1 justify-end flex-wrap"><button className="btn-ghost" onClick={async () => setDl({ h, rows: await api(`/hub/webhooks/${h.id}/deliveries`) })}>Deliveries</button><button className="btn-ghost" onClick={() => go(async () => { const r = await api(`/hub/webhooks/${h.id}/test`, 'POST'); setErr(''); alert(`Test sent: ${r.success ? 'delivered' : 'failed — see Deliveries'}`); })}>Send test</button>
            <button className="btn-ghost" onClick={() => go(async () => setSecret({ label: 'New signing secret', value: (await api(`/hub/webhooks/${h.id}/rotate-secret`, 'POST')).secret }))}>Rotate secret</button><button className="btn-ghost" onClick={() => go(() => api(`/hub/webhooks/${h.id}`, 'PUT', { active: !h.active }))}>{h.active ? 'Pause' : 'Enable'}</button>
            <button className="btn-ghost text-danger" onClick={() => confirm('Delete this endpoint and its delivery history?') && go(() => api(`/hub/webhooks/${h.id}`, 'DELETE'))}>Delete</button></div> }]} />
        <p className="text-xs text-muted mt-3">Each POST carries <span className="num">X-TF-Signature: v1=HMAC_SHA256(secret, timestamp + "." + body)</span> and <span className="num">X-TF-Timestamp</span> — reject anything older than 5 minutes and de-duplicate on the event <span className="num">id</span>. Failed deliveries retry after 1, 5, 30, 120 and 360 minutes, then are dead-lettered for manual retry.</p></>}

      {tab === 'accounting' && <>
        <div className="card flex flex-wrap gap-3 items-end mb-4">
          <div><div className="text-xs text-muted mb-1">Export</div><select className="input" value={ex.kind} onChange={(e) => setEx({ ...ex, kind: e.target.value, format: e.target.value === 'journals' ? ex.format : 'generic' })}>{['journals', 'invoices', 'bills', 'payments'].map((k) => <option key={k}>{k}</option>)}</select></div>
          {ex.kind === 'journals' && <div><div className="text-xs text-muted mb-1">Format</div><select className="input" value={ex.format} onChange={(e) => setEx({ ...ex, format: e.target.value })}><option value="generic">Generic CSV</option><option value="xero">Xero manual journal</option><option value="quickbooks">QuickBooks journal</option></select></div>}
          <div><div className="text-xs text-muted mb-1">From</div><input className="input num" type="date" value={ex.from} onChange={(e) => setEx({ ...ex, from: e.target.value })} /></div>
          <div><div className="text-xs text-muted mb-1">To</div><input className="input num" type="date" value={ex.to} onChange={(e) => setEx({ ...ex, to: e.target.value })} /></div>
          <button className="btn" onClick={() => go(() => download(`/hub/exports/${ex.kind}?format=${ex.format}&from=${ex.from}&to=${ex.to}`, `${ex.kind}-${ex.from}-${ex.to}.csv`))}>Download CSV</button></div>
        <Err e={form ? '' : err} />
        {admin && <button className="btn-ghost mb-3" onClick={() => setForm({ kind: 'map', rows: maps.map((m) => ({ ...m })) })}>Edit account mapping ({maps.filter((m) => m.external_code).length}/{maps.length} mapped)</button>}
        <Table rows={exps} empty="No exports yet" cols={[{ h: 'When', render: (e) => <span className="num text-xs">{ago(e.created_at)}</span> }, { h: 'Export', render: (e) => `${e.kind} (${e.format})` }, { h: 'Period', render: (e) => `${String(e.date_from).slice(0, 10)} → ${String(e.date_to).slice(0, 10)}` }, { h: 'Rows', right: true, render: (e) => e.row_count }, { h: 'Checksum', render: (e) => <span className="num text-xs">{e.checksum.slice(0, 12)}…</span> }]} /></>}

      {tab === 'imports' && <>
        <div className="card mb-4"><div className="font-medium mb-1">Import bookings from CSV</div><p className="text-xs text-muted mb-2">Columns: <span className="num">external_ref, client_email, client_name, destination, travel_start, travel_end, status, currency</span>. Re-importing the same <span className="num">external_ref</span> is safe — it's skipped.</p>
          <input type="file" accept=".csv,text/csv" className="mb-2 text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setImp({ ...imp, csv: await f.text(), filename: f.name, result: null }); }} />
          <textarea className="input num text-xs mb-2" rows={5} placeholder="…or paste CSV here" value={imp.csv} onChange={(e) => setImp({ ...imp, csv: e.target.value, result: null })} />
          <div className="flex flex-wrap items-center gap-4 text-sm"><label className="flex gap-2 items-center"><input type="checkbox" checked={imp.create_clients} onChange={(e) => setImp({ ...imp, create_clients: e.target.checked, result: null })} /> Create missing clients</label>
            <label className="flex gap-2 items-center"><input type="checkbox" checked={imp.skip_errors} onChange={(e) => setImp({ ...imp, skip_errors: e.target.checked })} /> Skip rows with errors</label>
            <button className="btn-ghost ml-auto" disabled={!imp.csv} onClick={() => go(async () => setImp({ ...imp, result: await api('/hub/imports/bookings', 'POST', { csv: imp.csv, filename: imp.filename, create_clients: imp.create_clients }) }))}>Preview</button>
            <button className="btn" disabled={!imp.result || (!imp.result.summary.ok && !imp.result.summary.error)} onClick={() => go(async () => { const r = await api('/hub/imports/bookings', 'POST', { csv: imp.csv, filename: imp.filename, create_clients: imp.create_clients, skip_errors: imp.skip_errors, commit: true }); setImp({ ...imp, csv: '', result: null }); alert(`Imported ${r.created} booking(s).`); })}>Import</button></div>
          {imp.result && <div className="mt-3 text-sm"><div className="mb-2"><b>{imp.result.summary.ok}</b> ready · <b>{imp.result.summary.duplicate}</b> already imported · <b className={imp.result.summary.error ? 'text-danger' : ''}>{imp.result.summary.error}</b> with errors</div>
            {imp.result.rows.filter((r: any) => r.status !== 'ok').map((r: any) => <div key={r.line} className="text-xs"><Pill s={r.status === 'error' ? 'void' : 'pending'} /> line {r.line} · {r.external_ref} — {r.message}</div>)}</div>}</div>
        <Table rows={imps} empty="No imports yet" cols={[{ h: 'When', render: (i) => <span className="num text-xs">{ago(i.created_at)}</span> }, { h: 'File', render: (i) => i.filename ?? '—' }, { h: 'Mode', render: (i) => i.mode }, { h: 'Rows', right: true, render: (i) => i.total_rows }, { h: 'OK / dup / err', right: true, render: (i) => `${i.ok_rows} / ${i.duplicate_rows} / ${i.error_rows}` }]} /></>}

      {form?.kind === 'key' && <Modal title="New API key" onClose={() => setForm(null)}><Err e={err} />
        <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Website contact form" /></Field>
        <Field label="Scopes">{SCOPES.map(([s, l]) => <label key={s} className="flex gap-2 items-center text-sm"><input type="checkbox" checked={form.scopes.includes(s)} onChange={(e) => setForm({ ...form, scopes: e.target.checked ? [...form.scopes, s] : form.scopes.filter((x: string) => x !== s) })} /> {l} <span className="num text-xs text-muted">{s}</span></label>)}</Field>
        <Field label="Expires in (days, optional)"><input className="input num" type="number" min={1} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} /></Field>
        <div className="flex justify-end"><button className="btn" disabled={form.name.trim().length < 2 || !form.scopes.length} onClick={() => go(async () => { const r = await api('/hub/api-keys', 'POST', { name: form.name, scopes: form.scopes, ...(form.days ? { days: Number(form.days) } : {}) }); setSecret({ label: 'API key', value: r.key }); setForm(null); })}>Create key</button></div></Modal>}
      {form?.kind === 'hook' && <Modal title="New webhook endpoint" onClose={() => setForm(null)}><Err e={err} />
        <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="HTTPS URL" hint="Private and internal addresses are refused."><input className="input" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/hooks/travelfinance" /></Field>
        <Field label="Events"><label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={form.events.includes('*')} onChange={(e) => setForm({ ...form, events: e.target.checked ? ['*'] : [] })} /> All events</label>
          {!form.events.includes('*') && events.filter((e) => e !== 'ping').map((e) => <label key={e} className="flex gap-2 items-center text-sm"><input type="checkbox" checked={form.events.includes(e)} onChange={(c) => setForm({ ...form, events: c.target.checked ? [...form.events, e] : form.events.filter((x: string) => x !== e) })} /> <span className="num">{e}</span></label>)}</Field>
        <div className="flex justify-end"><button className="btn" disabled={form.name.trim().length < 2 || !form.url || !form.events.length} onClick={() => go(async () => { const r = await api('/hub/webhooks', 'POST', { name: form.name, url: form.url, events: form.events }); setSecret({ label: 'Signing secret', value: r.secret }); setForm(null); })}>Create endpoint</button></div></Modal>}
      {form?.kind === 'map' && <Modal title="Account mapping" wide onClose={() => setForm(null)}><Err e={err} /><p className="text-xs text-muted mb-2">Enter the code each account has in Xero / QuickBooks. Provider-format journal exports refuse to run until every account used has a code.</p>
        <div className="card p-0 max-h-96 overflow-auto"><table className="w-full text-sm"><tbody>{form.rows.map((m: any, i: number) => <tr key={m.account_id} className="border-b border-line last:border-0"><td className="p-2 num">{m.code}</td><td className="p-2">{m.name}</td><td className="p-2 w-40"><input className="input py-1 num" value={m.external_code ?? ''} onChange={(e) => setForm({ ...form, rows: form.rows.map((r: any, j: number) => (j === i ? { ...r, external_code: e.target.value } : r)) })} /></td></tr>)}</tbody></table></div>
        <div className="flex justify-end mt-3"><button className="btn" onClick={() => go(async () => { await api('/hub/mappings', 'PUT', { mappings: form.rows.map((m: any) => ({ account_id: m.account_id, external_code: (m.external_code ?? '').trim() || null })) }); setForm(null); })}>Save mapping</button></div></Modal>}
      {dl && <Modal title={`Deliveries — ${dl.h.name}`} wide onClose={() => setDl(null)}><Table rows={dl.rows} empty="No deliveries yet" cols={[{ h: 'Event', render: (d: any) => <><span className="num">{d.type}</span><div className="text-xs text-muted num">{d.event_id.slice(0, 8)}</div></> }, { h: 'Status', render: (d: any) => <><Pill s={d.status === 'success' ? 'paid' : d.status === 'dead' ? 'void' : 'pending'} /><span className="text-xs text-muted ml-2">{d.last_status_code ?? ''} {d.last_error ?? ''}</span></> },
        { h: 'Attempts', right: true, render: (d: any) => d.attempts }, { h: '', render: (d: any) => d.status !== 'success' && <button className="btn-ghost" onClick={async () => { await go(() => api(`/hub/deliveries/${d.id}/retry`, 'POST')); setDl({ ...dl, rows: await api(`/hub/webhooks/${dl.h.id}/deliveries`) }); }}>Retry</button> }]} /></Modal>}
    </Page>
  );
}
