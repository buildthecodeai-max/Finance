import { useEffect, useState } from 'react';
import { Archive, ArchiveRestore, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Page, Pill, Table } from '../components/ui';

type Kind = 'clients' | 'suppliers';
const SUPPLIER_TYPES = ['airline', 'hotel', 'cruise', 'transfer', 'tour_operator', 'other'];
const blank = (kind: Kind) => (kind === 'clients' ? { name: '', email: '', phone: '', address: '', currency: 'USD', payment_terms_days: 14, billing_preference: 'email', notes: '' }
  : { name: '', email: '', supplier_type: 'other', currency: 'USD', payment_terms_days: 30, commission_override_pct: '', account_name: '', bsb: '', routing: '', account_number: '' });

/** Add / edit form shared by clients and suppliers. Bank details are write-only: leave blank to keep what is stored. */
function PartyForm({ kind, initial, onClose, onSaved }: { kind: Kind; initial: any; onClose(): void; onSaved(id?: number): void }) {
  const [f, setF] = useState<any>(initial); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const editing = !!initial.id;
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      const body: any = { name: f.name.trim(), email: f.email?.trim() || null, currency: String(f.currency).toUpperCase(), payment_terms_days: Number(f.payment_terms_days) || 0 };
      if (kind === 'clients') Object.assign(body, { phone: f.phone || null, address: f.address || null, billing_preference: f.billing_preference, notes: f.notes || null });
      else {
        Object.assign(body, { supplier_type: f.supplier_type, commission_override_pct: f.commission_override_pct === '' || f.commission_override_pct == null ? null : Number(f.commission_override_pct) });
        if (f.account_number?.trim()) body.bank_details = { account_name: f.account_name?.trim() || f.name, bsb: f.bsb?.trim() || undefined, routing: f.routing?.trim() || undefined, account_number: f.account_number.trim() };
      }
      const r = editing ? await api(`/${kind}/${initial.id}`, 'PUT', body) : await api(`/${kind}`, 'POST', body); onSaved(r?.id ?? initial.id);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <Modal title={editing ? `Edit ${kind === 'clients' ? 'client' : 'supplier'}` : `New ${kind === 'clients' ? 'client' : 'supplier'}`} onClose={onClose}><Err e={err} />
    <div className="grid grid-cols-2 gap-x-4"><div className="col-span-2"><Field label="Name *"><input className="input" value={f.name} onChange={set('name')} /></Field></div>
      <Field label="Email"><input className="input" type="email" value={f.email ?? ''} onChange={set('email')} /></Field>
      {kind === 'clients' ? <Field label="Phone"><input className="input" value={f.phone ?? ''} onChange={set('phone')} /></Field>
        : <Field label="Type"><select className="input" value={f.supplier_type} onChange={set('supplier_type')}>{SUPPLIER_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></Field>}
      <Field label="Currency"><input className="input num uppercase" maxLength={3} value={f.currency} onChange={set('currency')} /></Field>
      <Field label="Payment terms (days)"><input className="input num" type="number" min={0} value={f.payment_terms_days} onChange={set('payment_terms_days')} /></Field>
      {kind === 'clients' && <><div className="col-span-2"><Field label="Address"><textarea className="input" rows={2} value={f.address ?? ''} onChange={set('address')} /></Field></div>
        <Field label="Send invoices by"><select className="input" value={f.billing_preference} onChange={set('billing_preference')}><option value="email">Email</option><option value="post">Post</option><option value="portal">Portal</option></select></Field>
        <div className="col-span-2"><Field label="Notes"><textarea className="input" rows={2} value={f.notes ?? ''} onChange={set('notes')} /></Field></div></>}
      {kind === 'suppliers' && <><Field label="Commission override (%)" hint="Leave empty to use the rules."><input className="input num" type="number" min={0} max={100} step="0.01" value={f.commission_override_pct ?? ''} onChange={set('commission_override_pct')} /></Field><div />
        <div className="col-span-2 text-xs text-muted mt-1 mb-1">Bank details {editing ? '(stored encrypted — enter new details only to replace them)' : '(stored encrypted)'}</div>
        <Field label="Account name"><input className="input" value={f.account_name ?? ''} onChange={set('account_name')} /></Field><Field label="Account number"><input className="input num" value={f.account_number ?? ''} onChange={set('account_number')} /></Field>
        <Field label="BSB (AU)"><input className="input num" value={f.bsb ?? ''} onChange={set('bsb')} /></Field><Field label="Routing (US)"><input className="input num" value={f.routing ?? ''} onChange={set('routing')} /></Field></>}</div>
    <div className="flex justify-end gap-2 mt-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || f.name.trim().length < 1 || String(f.currency).length !== 3} onClick={save}>{editing ? 'Save changes' : 'Create'}</button></div></Modal>;
}

function Detail({ kind, id, canManage, canEdit, onClose, onChanged }: { kind: Kind; id: number; canManage: boolean; canEdit: boolean; onClose(): void; onChanged(): void }) {
  const [d, setD] = useState<any>(null); const [tl, setTl] = useState<any[]>([]); const [usage, setUsage] = useState<any>(null); const [edit, setEdit] = useState(false); const [err, setErr] = useState(''); const [confirmDel, setConfirmDel] = useState(false);
  const load = () => { api(`/${kind}/${id}`).then(setD); if (kind === 'clients') api(`/crm/timeline/client/${id}`).then(setTl).catch(() => {}); if (canManage) api(`/${kind}/${id}/usage`).then(setUsage).catch(() => {}); };
  useEffect(() => { load(); }, [id]);
  if (!d) return null;
  const act = async (fn: () => Promise<any>, done = true) => { try { await fn(); setErr(''); if (done) { onChanged(); onClose(); } else { load(); onChanged(); } } catch (e: any) { setErr(e.message); } };
  return (
    <Modal title={d.name} wide onClose={onClose}><Err e={err} />
      <div className="flex flex-wrap items-center gap-2 mb-3">{d.archived_at && <Pill s="cancelled" />}{d.archived_at && <span className="text-xs text-muted">Archived {String(d.archived_at).slice(0, 10)} — hidden from lists and pickers; history kept.</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {canEdit && <button className="btn-ghost" onClick={() => setEdit(true)}><Pencil size={14} /> Edit</button>}
          {canManage && (d.archived_at ? <button className="btn-ghost" onClick={() => act(() => api(`/${kind}/${id}/restore`, 'POST'), false)}><ArchiveRestore size={14} /> Restore</button> : <button className="btn-ghost" onClick={() => act(() => api(`/${kind}/${id}/archive`, 'POST'))}><Archive size={14} /> Archive</button>)}
          {canManage && <button className="btn-ghost text-danger" onClick={() => setConfirmDel(true)}><Trash2 size={14} /> Delete</button>}</div></div>
      <div className="grid gap-x-8 gap-y-1 text-sm mb-4 sm:grid-cols-2"><div><span className="text-muted">Email: </span>{d.email ?? '—'}</div>{kind === 'clients' ? <div><span className="text-muted">Phone: </span>{d.phone ?? '—'}</div> : <div><span className="text-muted">Type: </span><span className="capitalize">{String(d.supplier_type).replace('_', ' ')}</span></div>}
        <div><span className="text-muted">Currency / terms: </span>{d.currency} · {d.payment_terms_days} days</div>{kind === 'clients' ? <div><span className="text-muted">Address: </span>{d.address ?? '—'}</div> : <div><span className="text-muted">Bank: </span>{d.has_bank_details ? `encrypted${d.account_last4 ? ` · ••••${d.account_last4}` : ''}` : 'not set'}</div>}
        {kind === 'clients' && d.notes && <div className="sm:col-span-2"><span className="text-muted">Notes: </span>{d.notes}</div>}</div>
      <h3 className="font-bold mb-2">{kind === 'clients' ? 'Invoices' : 'Purchases'}</h3>
      <Table rows={kind === 'clients' ? d.invoices : d.purchases} empty="Nothing yet" cols={kind === 'clients' ? [
        { h: 'Number', render: (r: any) => r.number }, { h: 'Issued', render: (r: any) => <span className="num">{String(r.issue_date).slice(0, 10)}</span> }, { h: 'Status', render: (r: any) => <Pill s={r.status} /> }, { h: 'Total', right: true, render: (r: any) => money(r.total, r.currency) }]
        : [{ h: 'Invoice', render: (r: any) => r.number }, { h: 'Item', render: (r: any) => r.description }, { h: 'Cost', right: true, render: (r: any) => money(r.cost) }]} />
      <h3 className="font-bold mt-4 mb-2">Payments</h3>
      <Table rows={d.payments} empty="No payments" cols={[{ h: 'Date', render: (r: any) => String(r.paid_at).slice(0, 10) }, { h: 'Method', render: (r: any) => r.method }, { h: 'Amount', right: true, render: (r: any) => money(r.amount, r.currency) }]} />
      {kind === 'clients' && tl.length > 0 && <><h3 className="font-bold mt-4 mb-2">Timeline</h3><div className="space-y-2 max-h-64 overflow-auto">{tl.map((x: any, i: number) => <div key={i} className="text-sm flex gap-3"><span className="num text-xs text-muted shrink-0">{String(x.at ?? x.created_at ?? '').slice(0, 10)}</span><span>{x.text ?? x.body ?? x.title}</span></div>)}</div></>}
      {edit && <PartyForm kind={kind} initial={{ ...blank(kind), ...d, email: d.email ?? '', commission_override_pct: d.commission_override_pct ?? '' }} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); load(); onChanged(); }} />}
      {confirmDel && <Modal title={`Delete ${d.name}?`} onClose={() => setConfirmDel(false)}>
        {usage && !usage.can_delete ? <><p className="text-sm mb-3">This {kind === 'clients' ? 'client' : 'supplier'} can't be deleted because it has <b>{usage.deps.map((x: any) => `${x.n} ${x.label}`).join(', ')}</b>. Archive it instead — it disappears from lists and pickers, and all history stays intact.</p>
          <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setConfirmDel(false)}>Close</button>{!d.archived_at && <button className="btn" onClick={() => act(() => api(`/${kind}/${id}/archive`, 'POST'))}>Archive instead</button>}</div></>
          : <><p className="text-sm mb-3">This permanently deletes the record. It has no invoices, bookings or payments attached. This can't be undone.</p><div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setConfirmDel(false)}>Cancel</button><button className="btn bg-danger text-white" onClick={() => act(() => api(`/${kind}/${id}`, 'DELETE'))}>Delete permanently</button></div></>}</Modal>}
    </Modal>
  );
}

function makeParty(kind: Kind, title: string) {
  return function Party() {
    const { can } = useAuth();
    const [rows, setRows] = useState<any[]>([]); const [open, setOpen] = useState<number | null>(null); const [form, setForm] = useState<any>(null);
    const [show, setShow] = useState<'active' | 'archived'>('active'); const [q, setQ] = useState('');
    const load = () => api(`/${kind}?status=${show}`).then(setRows);
    useEffect(() => { load(); }, [show]);
    const manage = can('admin', 'finance_manager'), canEdit = kind === 'clients' ? can('admin', 'finance_manager', 'agent') : manage;
    const shown = rows.filter((r) => !q || `${r.name} ${r.email ?? ''}`.toLowerCase().includes(q.toLowerCase()));
    return (
      <Page title={title} description={kind === 'clients' ? 'The people and companies you sell to.' : 'The airlines, hotels and operators you buy from.'}
        actions={<><div className="relative"><Search size={14} className="absolute left-3 top-3 text-muted" /><input className="input pl-8 w-52" placeholder="Search" aria-label={`Search ${title}`} value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="inline-flex rounded-lg border border-line p-0.5 text-sm" role="group" aria-label="Show">{(['active', 'archived'] as const).map((s) => <button key={s} className={`px-3 py-1 rounded-md capitalize ${show === s ? 'bg-accent text-accent-ink' : 'text-muted'}`} onClick={() => setShow(s)}>{s}</button>)}</div>
          {canEdit && <button className="btn" onClick={() => setForm(blank(kind))}><Plus size={15} /> Add {kind === 'clients' ? 'client' : 'supplier'}</button>}</>}>
        <Table rows={shown} empty={show === 'archived' ? 'Nothing archived' : `No ${title.toLowerCase()} yet`} cols={[
          { h: 'Name', render: (r) => <button className="font-medium text-accent hover:underline text-left" onClick={() => setOpen(r.id)}>{r.name}</button> },
          { h: 'Email', render: (r) => r.email ?? '' },
          { h: 'Currency', render: (r) => r.currency },
          kind === 'clients'
            ? { h: 'Outstanding', right: true, render: (r) => money(r.outstanding, r.currency) }
            : { h: 'Type', render: (r) => <span className="capitalize">{String(r.supplier_type).replace('_', ' ')}</span> },
          ...(kind === 'suppliers' ? [{ h: 'Bank details', render: (r: any) => (r.has_bank_details ? 'Encrypted' : <span className="text-muted">—</span>) }] : []),
          {
            h: '',
            render: (r) => (
              <div className="flex gap-2 justify-end" onClick={(e) => e.stopPropagation()}>
                {canEdit && (
                  <button className="btn-ghost py-0.5 px-2 text-xs flex items-center gap-1"
                    onClick={() => setForm({ ...blank(kind), ...r, email: r.email ?? '', commission_override_pct: r.commission_override_pct ?? '' })}>
                    <Pencil size={12} /> Edit
                  </button>
                )}
                <button className="btn-ghost py-0.5 px-2 text-xs text-muted flex items-center gap-1" onClick={() => setOpen(r.id)}>
                  View
                </button>
                {manage && (
                  r.archived_at
                    ? <button className="btn-ghost py-0.5 px-2 text-xs flex items-center gap-1" onClick={() => api(`/${kind}/${r.id}/restore`, 'POST').then(load)}>
                        <ArchiveRestore size={12} /> Restore
                      </button>
                    : <button className="btn-ghost py-0.5 px-2 text-xs text-danger flex items-center gap-1" onClick={() => setOpen(r.id)}>
                        <Trash2 size={12} /> Delete
                      </button>
                )}
              </div>
            ),
          },
        ]} />
        {open && <Detail kind={kind} id={open} canManage={manage} canEdit={canEdit} onClose={() => setOpen(null)} onChanged={load} />}
        {form && <PartyForm kind={kind} initial={form} onClose={() => setForm(null)} onSaved={(id) => { setForm(null); load(); if (id) setOpen(id); }} />}
      </Page>
    );
  };
}
export const Clients = makeParty('clients', 'Clients');
export const Suppliers = makeParty('suppliers', 'Suppliers');
