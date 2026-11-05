import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Archive, ArchiveRestore, FilePlus2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Page, Pill, Skeleton, Table } from '../components/ui';
import { useOpenOnNew } from '../lookup';
import { SendSms } from '../components/SendSms';

type Kind = 'clients' | 'suppliers';
const SUPPLIER_TYPES = ['airline', 'hotel', 'cruise', 'transfer', 'tour_operator', 'other'];
const blank = (kind: Kind, cur = 'USD') => (kind === 'clients' ? { name: '', email: '', phone: '', address: '', currency: cur, payment_terms_days: 14, billing_preference: 'email', notes: '' }
  : { name: '', email: '', supplier_type: 'other', currency: cur, payment_terms_days: 30, commission_override_pct: '', account_name: '', bsb: '', routing: '', account_number: '' });

/** Add / edit form shared by clients and suppliers. Bank details are write-only: leave blank to keep what is stored. */
function PartyForm({ kind, initial, onClose, onSaved, names = [] }: { kind: Kind; initial: any; onClose(): void; onSaved(id?: number): void; names?: string[] }) {
  const [f, setF] = useState<any>(initial); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const editing = !!initial.id;
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const dup = !editing && f.name.trim() && names.some((n) => n.toLowerCase() === f.name.trim().toLowerCase());
  const badEmail = !!f.email?.trim() && !/^\S+@\S+\.\S+$/.test(f.email.trim());
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
    <div className="grid grid-cols-2 gap-x-4"><div className="col-span-2"><Field label="Name *" hint={dup ? `You already have a ${kind === 'clients' ? 'client' : 'supplier'} called “${f.name.trim()}”. Check it isn't the same one before adding another.` : kind === 'clients' ? 'A person or a company, e.g. “Nguyen Family” or “Acme Corp”' : undefined}><input className="input" autoFocus value={f.name} onChange={set('name')} /></Field></div>
      <Field label="Email" hint={badEmail ? 'That doesn’t look like an email address.' : kind === 'clients' ? 'Quotes and invoices are emailed here' : undefined}><input className="input" type="email" value={f.email ?? ''} onChange={set('email')} /></Field>
      {kind === 'clients' ? <Field label="Phone"><input className="input" value={f.phone ?? ''} onChange={set('phone')} /></Field>
        : <Field label="Type"><select className="input" value={f.supplier_type} onChange={set('supplier_type')}>{SUPPLIER_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></Field>}
      <Field label="Currency"><input className="input num uppercase" maxLength={3} value={f.currency} onChange={set('currency')} /></Field>
      <Field label="Payment terms (days)" hint="How long they have to pay an invoice"><input className="input num" type="number" min={0} value={f.payment_terms_days} onChange={set('payment_terms_days')} /></Field>
      {kind === 'clients' && <><div className="col-span-2"><Field label="Address"><textarea className="input" rows={2} value={f.address ?? ''} onChange={set('address')} /></Field></div>
        <Field label="Send invoices by"><select className="input" value={f.billing_preference} onChange={set('billing_preference')}><option value="email">Email</option><option value="post">Post</option><option value="portal">Portal</option></select></Field>
        <div className="col-span-2"><Field label="Notes"><textarea className="input" rows={2} value={f.notes ?? ''} onChange={set('notes')} /></Field></div></>}
      {kind === 'suppliers' && <><Field label="Commission override (%)" hint="Leave empty to use the rules."><input className="input num" type="number" min={0} max={100} step="0.01" value={f.commission_override_pct ?? ''} onChange={set('commission_override_pct')} /></Field><div />
        <div className="col-span-2 text-xs text-muted mt-1 mb-1">Bank details {editing ? '(stored encrypted — enter new details only to replace them)' : '(stored encrypted)'}</div>
        <Field label="Account name"><input className="input" value={f.account_name ?? ''} onChange={set('account_name')} /></Field><Field label="Account number"><input className="input num" value={f.account_number ?? ''} onChange={set('account_number')} /></Field>
        <Field label="BSB (AU)"><input className="input num" value={f.bsb ?? ''} onChange={set('bsb')} /></Field><Field label="Routing (US)"><input className="input num" value={f.routing ?? ''} onChange={set('routing')} /></Field></>}</div>
    <div className="flex justify-end gap-2 mt-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || f.name.trim().length < 1 || badEmail || String(f.currency).length !== 3} onClick={save}>{busy ? 'Saving…' : editing ? 'Save changes' : kind === 'clients' ? 'Add client' : 'Add supplier'}</button></div></Modal>;
}

function Detail({ kind, id, canManage, canEdit, startDelete, onClose, onChanged }: { kind: Kind; id: number; canManage: boolean; canEdit: boolean; startDelete?: boolean; onClose(): void; onChanged(): void }) {
  const [d, setD] = useState<any>(null); const [tl, setTl] = useState<any[]>([]); const [usage, setUsage] = useState<any>(null); const [edit, setEdit] = useState(false); const [err, setErr] = useState(''); const [confirmDel, setConfirmDel] = useState(!!startDelete);
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
        {!usage ? <p className="text-sm text-muted">Checking what depends on this {kind === 'clients' ? 'client' : 'supplier'}…</p>
          : !usage.can_delete ? <><p className="text-sm mb-3">This {kind === 'clients' ? 'client' : 'supplier'} can't be deleted because it has <b>{usage.deps.map((x: any) => `${x.n} ${x.label}`).join(', ')}</b>. Archive it instead — it disappears from lists and pickers, and all history stays intact.</p>
          <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setConfirmDel(false)}>Close</button>{!d.archived_at && <button className="btn" onClick={() => act(() => api(`/${kind}/${id}/archive`, 'POST'))}>Archive instead</button>}</div></>
          : <><p className="text-sm mb-3">This permanently deletes the record. It has no invoices, bookings or payments attached. This can't be undone.</p><div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setConfirmDel(false)}>Cancel</button><button className="btn bg-danger text-white" onClick={() => act(() => api(`/${kind}/${id}`, 'DELETE'))}>Delete permanently</button></div></>}</Modal>}
    </Modal>
  );
}

function makeParty(kind: Kind, title: string) {
  return function Party() {
    const { can } = useAuth();
    const [rows, setRows] = useState<any[]>([]); const [open, setOpen] = useState<number | null>(null); const [askDelete, setAskDelete] = useState(false); const [form, setForm] = useState<any>(null);
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
                    : <button className="btn-ghost py-0.5 px-2 text-xs text-danger flex items-center gap-1" onClick={() => { setAskDelete(true); setOpen(r.id); }}>
                        <Trash2 size={12} /> Delete
                      </button>
                )}
              </div>
            ),
          },
        ]} />
        {open && <Detail key={`${open}-${askDelete}`} kind={kind} id={open} canManage={manage} canEdit={canEdit} startDelete={askDelete} onClose={() => { setOpen(null); setAskDelete(false); }} onChanged={load} />}
        {form && <PartyForm kind={kind} initial={form} onClose={() => setForm(null)} onSaved={(id) => { setForm(null); load(); if (id) setOpen(id); }} />}
      </Page>
    );
  };
}
export const Suppliers = makeParty('suppliers', 'Suppliers');

/* ======================================================  CLIENTS  ====================================================== */
const day = (d: any) => (d ? String(d).slice(0, 10) : '');
const r2 = (n: number) => Math.round(n * 100) / 100;
const owes = (i: any) => (['draft', 'void', 'paid', 'credited'].includes(i.status) ? 0 : r2(i.total - (i.amount_credited ?? 0) - i.amount_paid));
const sumBy = (rows: any[], f: (r: any) => number) => { const m: Record<string, number> = {}; for (const r of rows) { const v = f(r); if (v > 0.005) m[r.currency] = r2((m[r.currency] ?? 0) + v); } return m; };
const fmtMap = (m: Record<string, number>) => Object.entries(m).map(([c, v]) => money(v, c)).join(' + ') || '—';

function ClientDetail({ id, canManage, canEdit, startDelete, onClose, onChanged, names }: { id: number; canManage: boolean; canEdit: boolean; startDelete?: boolean; onClose(): void; onChanged(msg?: string): void; names: string[] }) {
  const nav = useNavigate(); const { agency } = useAuth(); const tabs = ['Overview', 'Bookings', 'Quotes', 'Invoices', 'Payments', 'Activity'];
  const [d, setD] = useState<any>(null); const [tl, setTl] = useState<any[]>([]); const [bks, setBks] = useState<any[]>([]); const [qts, setQts] = useState<any[]>([]); const [usage, setUsage] = useState<any>(null);
  const [tab, setTab] = useState('Overview'); const [sms, setSms] = useState(false); const [edit, setEdit] = useState(false); const [err, setErr] = useState(''); const [confirmDel, setConfirmDel] = useState(!!startDelete);
  const load = () => {
    api(`/clients/${id}`).then(setD).catch((e) => setErr(e.message));
    api(`/crm/timeline/client/${id}`).then(setTl).catch(() => {});
    api('/bookings').then((r) => setBks(r.filter((b: any) => b.client_id === id))).catch(() => {});
    api('/quotes').then((r) => setQts(r.filter((q: any) => q.client_id === id))).catch(() => {});
    if (canManage) api(`/clients/${id}/usage`).then(setUsage).catch(() => {});
  };
  useEffect(() => { load(); }, [id]);
  if (!d) return <Modal title="Client" wide onClose={onClose}>{err ? <Err e={err} /> : <Skeleton className="h-48" />}</Modal>;
  const act = async (fn: () => Promise<any>, msg: string, close = true) => { try { await fn(); setErr(''); onChanged(msg); if (close) onClose(); else load(); } catch (e: any) { setErr(e.message); } };
  const owed = sumBy(d.invoices, owes), billed = sumBy(d.invoices.filter((i: any) => !['draft', 'void'].includes(i.status)), (i) => i.total - (i.amount_credited ?? 0));
  const archived = !!d.archived_at; const go = (to: string) => nav(to);
  const nTab = (t: string) => (t === 'Bookings' ? ` (${bks.length})` : t === 'Quotes' ? ` (${qts.length})` : t === 'Invoices' ? ` (${d.invoices.length})` : '');

  return (
    <Modal title={d.name} wide onClose={onClose}><Err e={err} />
      {archived && <div className="rounded-lg border border-line bg-surface2/60 text-sm px-3 py-2 mb-3">Archived on {day(d.archived_at)} — hidden from lists and pickers, all history is kept.</div>}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {!archived && canEdit && <><button className="btn inline-flex items-center gap-1" onClick={() => go(`/bookings?client=${id}`)}><Plus size={14} />New booking</button>
          <button className="btn-ghost" onClick={() => go(`/quotes/new?client=${id}`)}>New quote</button>
          <button className="btn-ghost inline-flex items-center gap-1" onClick={() => go(`/invoices?client=${id}`)}><FilePlus2 size={14} />New invoice</button></>}
        {!archived && canEdit && <button className="btn-ghost" onClick={() => setSms(true)}>Send text</button>}
        {!archived && canManage && Object.keys(owed).length > 0 && <button className="btn-ghost" onClick={() => go(`/client-receipts?client=${id}`)}>Receive payment</button>}
        <div className="ml-auto flex flex-wrap gap-2">
          {canEdit && <button className="btn-ghost inline-flex items-center gap-1" onClick={() => setEdit(true)}><Pencil size={14} />Edit</button>}
          {canManage && (archived ? <button className="btn-ghost inline-flex items-center gap-1" onClick={() => act(() => api(`/clients/${id}/restore`, 'POST'), `${d.name} was restored.`, false)}><ArchiveRestore size={14} />Restore</button>
            : <button className="btn-ghost inline-flex items-center gap-1" title="Hide from lists but keep all history" onClick={() => act(() => api(`/clients/${id}/archive`, 'POST'), `${d.name} was archived. Find them under the Archived tab.`)}><Archive size={14} />Archive</button>)}
          {canManage && <button className="btn-ghost text-danger inline-flex items-center gap-1" onClick={() => setConfirmDel(true)}><Trash2 size={14} />Delete</button>}</div></div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card !p-3"><div className="text-xs text-muted">Owes you</div><div className={`font-semibold num ${Object.keys(owed).length ? 'text-warn' : ''}`}>{fmtMap(owed)}</div></div>
        <div className="card !p-3"><div className="text-xs text-muted">Invoiced in total</div><div className="font-semibold num">{fmtMap(billed)}</div></div>
        <div className="card !p-3"><div className="text-xs text-muted">Trips</div><div className="font-semibold num">{bks.length}</div></div></div>

      <div className="flex gap-1 border-b border-line mb-4 overflow-x-auto" role="tablist">{tabs.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm whitespace-nowrap ${tab === t ? 'text-accent border-b-2 border-accent font-medium' : 'text-muted hover:text-fg'}`}>{t}{nTab(t)}</button>)}</div>

      {tab === 'Overview' && <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <div><span className="text-muted">Email </span>{d.email ? <a className="text-accent hover:underline" href={`mailto:${d.email}`}>{d.email}</a> : <span className="text-warn">Not added — quotes and invoices can’t be emailed</span>}</div>
        <div><span className="text-muted">Phone </span>{d.phone ? <a className="text-accent hover:underline" href={`tel:${d.phone}`}>{d.phone}</a> : '—'}</div>
        <div><span className="text-muted">Pays in </span>{d.currency} · <b>{d.payment_terms_days}</b> day terms</div>
        <div><span className="text-muted">Invoices sent by </span><span className="capitalize">{d.billing_preference}</span></div>
        <div className="sm:col-span-2 whitespace-pre-wrap"><span className="text-muted">Address </span>{d.address || '—'}</div>
        <div className="sm:col-span-2 whitespace-pre-wrap"><span className="text-muted">Notes </span>{d.notes || (canEdit ? <button className="text-accent underline" onClick={() => setEdit(true)}>Add notes</button> : '—')}</div></div>}

      {tab === 'Bookings' && <Table rows={bks} onRow={(r) => go(`/bookings/${r.id}`)} empty="No trips booked yet." cols={[
        { h: 'Booking', render: (r: any) => <><span className="num font-medium">{r.reference}</span><div className="text-xs text-muted">{r.destination}</div></> }, { h: 'Travel', render: (r: any) => <span className="num">{day(r.travel_start) || '—'}</span> },
        { h: 'Status', render: (r: any) => <Pill s={r.status} /> }, { h: 'Selling', right: true, render: (r: any) => (r.selling_net > 0 ? money(r.selling_net, r.currency) : '—') }]} />}
      {tab === 'Quotes' && <Table rows={qts} onRow={(r) => go(`/quotes/${r.id}`)} empty="No quotes yet." cols={[
        { h: 'Quote', render: (r: any) => <><span className="num font-medium">{r.quote_no}</span><div className="text-xs text-muted">{r.title}</div></> }, { h: 'Status', render: (r: any) => <Pill s={r.status} /> },
        { h: 'Valid until', render: (r: any) => <span className="num">{day(r.valid_until) || '—'}</span> }, { h: 'Price from', right: true, render: (r: any) => (r.from_total != null ? money(r.from_total, r.currency) : '—') }]} />}
      {tab === 'Invoices' && <Table rows={d.invoices} onRow={(r) => go(`/invoices?open=${r.id}`)} empty="No invoices yet." cols={[
        { h: 'Number', render: (r: any) => <span className="num font-medium">{r.number}</span> }, { h: 'Issued', render: (r: any) => <span className="num">{day(r.issue_date)}</span> }, { h: 'Due', render: (r: any) => <span className="num">{day(r.due_date)}</span> },
        { h: 'Status', render: (r: any) => <Pill s={r.status} /> }, { h: 'Total', right: true, render: (r: any) => money(r.total, r.currency) }, { h: 'Owing', right: true, render: (r: any) => (owes(r) > 0 ? <b>{money(owes(r), r.currency)}</b> : <span className="text-muted">—</span>) }]} />}
      {tab === 'Payments' && <Table rows={d.payments} empty="No payments received yet." cols={[{ h: 'Date', render: (r: any) => <span className="num">{day(r.paid_at)}</span> }, { h: 'Method', render: (r: any) => <span className="capitalize">{String(r.method).replace('_', ' ')}</span> },
        { h: 'Status', render: (r: any) => (r.voided ? <Pill s="voided" /> : <Pill s="received" />) }, { h: 'Amount', right: true, render: (r: any) => money(r.amount, r.currency) }]} />}
      {tab === 'Activity' && (tl.length ? <div className="space-y-2 max-h-80 overflow-auto">{tl.map((x: any, i: number) => <div key={i} className="text-sm flex gap-3"><span className="num text-xs text-muted shrink-0">{day(x.at ?? x.created_at)}</span><span>{x.text ?? x.body ?? x.title}</span></div>)}</div> : <p className="text-sm text-muted">No activity recorded yet.</p>)}

      {sms && <SendSms target={{ client_id: id, name: d.name, phone: d.phone }} onClose={() => setSms(false)} onSent={(m) => { setSms(false); onChanged(m); }} />}
      {edit && <PartyForm kind="clients" initial={{ ...blank('clients', agency?.base_currency), ...d, email: d.email ?? '' }} names={names} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); load(); onChanged(`${d.name} was updated.`); }} />}
      {confirmDel && <Modal title={`Delete ${d.name}?`} onClose={() => setConfirmDel(false)}>
        {!usage ? <p className="text-sm text-muted">Checking what depends on this client…</p>
          : !usage.can_delete ? <><p className="text-sm mb-3">This client can't be deleted because it has <b>{usage.deps.map((x: any) => `${x.n} ${x.label}`).join(', ')}</b>. Archive it instead — it disappears from lists and pickers, and all history stays intact.</p>
            <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setConfirmDel(false)}>Close</button>{!archived && <button className="btn" onClick={() => act(() => api(`/clients/${id}/archive`, 'POST'), `${d.name} was archived.`)}>Archive instead</button>}</div></>
          : <><p className="text-sm mb-3">This permanently deletes the client. They have no invoices, bookings or payments attached. This can't be undone.</p><div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setConfirmDel(false)}>Cancel</button><button className="btn bg-danger text-white" onClick={() => act(() => api(`/clients/${id}`, 'DELETE'), `${d.name} was deleted.`)}>Delete permanently</button></div></>}</Modal>}
    </Modal>
  );
}

const CTABS: { key: string; label: string; test: (r: any) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'owing', label: 'Owe money', test: (r) => Number(r.outstanding) > 0.005 },
  { key: 'noemail', label: 'No email', test: (r) => !r.email },
  { key: 'archived', label: 'Archived', test: () => true },
];

export function Clients() {
  const { can, agency } = useAuth(); const [sp, setSp] = useSearchParams(); const nav = useNavigate();
  const [rows, setRows] = useState<any[] | null>(null); const [err, setErr] = useState(''); const [note, setNote] = useState('');
  const [tab, setTab] = useState(CTABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab')! : 'all'); const [q, setQ] = useState(sp.get('q') ?? ''); const [sort, setSort] = useState('name');
  const [open, setOpen] = useState<number | null>(Number(sp.get('open')) || null); const [askDelete, setAskDelete] = useState(false); const [form, setForm] = useState<any>(null);
  const archived = tab === 'archived'; const manage = can('admin', 'finance_manager'), canEdit = can('admin', 'finance_manager', 'agent');
  const load = () => api(`/clients?status=${archived ? 'archived' : 'active'}`).then((r) => { setRows(r); setErr(''); }).catch((e) => { setErr(e.message); setRows([]); });
  useEffect(() => { setRows(null); load(); }, [archived]);
  useOpenOnNew(() => { if (canEdit) setForm(blank('clients', agency?.base_currency)); });
  useEffect(() => { if (sp.has('open')) { const n = new URLSearchParams(sp); n.delete('open'); setSp(n, { replace: true }); } }, []);

  const all = rows ?? [];
  const counts = useMemo(() => Object.fromEntries(CTABS.map((t) => [t.key, all.filter(t.test).length])), [rows]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const l = all.filter(CTABS.find((t) => t.key === tab)!.test).filter((r) => !s || `${r.name} ${r.email ?? ''} ${r.phone ?? ''}`.toLowerCase().includes(s));
    return sort === 'owes' ? [...l].sort((a, b) => b.outstanding - a.outstanding) : sort === 'newest' ? [...l].sort((a, b) => b.id - a.id) : l;
  }, [rows, tab, q, sort]);
  const owing = all.filter(CTABS[1].test); const biggest = [...owing].sort((a, b) => b.outstanding - a.outstanding)[0];
  const owedTotals = sumBy(owing, (r) => Number(r.outstanding));
  const stat = (key: string | null, title: string, value: string, sub: string, tone = '') => (
    <button type="button" disabled={!key} onClick={() => key && setTab(key)} className={`card text-left ${key ? 'hover:bg-surface2/70 transition-colors' : 'cursor-default'} ${key && tab === key ? 'ring-1 ring-accent' : ''}`}>
      <div className="text-xs text-muted">{title}</div><div className={`text-xl font-semibold num mt-0.5 ${tone}`}>{value}</div><div className="text-xs text-muted mt-0.5">{sub}</div></button>);

  return (
    <Page title="Clients" description="The people and companies you sell to. Click a client to see their trips, quotes, invoices and payments in one place."
      actions={canEdit ? <button className="btn inline-flex items-center gap-1" onClick={() => setForm(blank('clients', agency?.base_currency))}><Plus size={16} />Add client</button> : undefined}>
      {!archived && (rows === null ? <div className="grid sm:grid-cols-3 gap-3 mb-4"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div> : (
        <div className="grid sm:grid-cols-3 gap-3 mb-4">
          {stat('all', 'Clients', String(all.length), all.length ? 'Active clients' : 'None yet')}
          {stat('owing', 'Owe you money', String(owing.length), owing.length ? `${fmtMap(owedTotals)} in total${biggest ? ` · most: ${biggest.name}` : ''}` : 'Everyone is paid up', owing.length ? 'text-warn' : '')}
          {stat('noemail', 'No email address', String(counts.noemail), counts.noemail ? 'Quotes can’t be emailed to them' : 'Everyone can be emailed', counts.noemail ? 'text-warn' : '')}
        </div>))}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1 basis-full min-w-0" role="tablist" aria-label="Client views">
          {CTABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
              className={`whitespace-nowrap text-sm px-3 py-1.5 rounded-lg border ${tab === t.key ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>
              {t.label}{rows && !archived && t.key !== 'all' && t.key !== 'archived' && <span className="ml-1.5 text-xs opacity-70 num">{counts[t.key]}</span>}</button>))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input className="input pl-8" placeholder="Search name, email or phone…" aria-label="Search clients" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="text-xs text-muted flex items-center gap-2">Sort by<select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value)}><option value="name">Name</option><option value="owes">Owes the most</option><option value="newest">Newest first</option></select></label>
      </div>

      {note && <div role="status" className="rounded-lg border border-success/30 bg-success/10 text-success text-sm px-3 py-2 mb-3 flex justify-between gap-3"><span>{note}</span><button className="opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={() => setNote('')}><X size={14} /></button></div>}
      <Err e={form ? '' : err} />
      {archived && <p className="text-sm text-muted mb-3">Archived clients are hidden from lists and pickers. Their history is kept.{manage ? ' Open one to restore it.' : ''}</p>}
      {rows === null ? <Skeleton className="h-64" /> : (
        <Table rows={list} onRow={(r) => { setAskDelete(false); setOpen(r.id); }}
          empty={all.length === 0 ? (archived ? 'No archived clients.' : canEdit ? 'No clients yet — click “Add client” to add your first one.' : 'No clients yet.') : q ? `No client matches “${q}”.` : `Nobody in “${CTABS.find((t) => t.key === tab)!.label}”.`}
          cols={[
            { h: 'Client', render: (r) => <><span className="font-medium">{r.name}</span>{r.email ? <div className="text-xs text-muted">{r.email}</div> : <div className="text-xs text-warn">No email</div>}</> },
            { h: 'Phone', render: (r) => r.phone ?? <span className="text-muted">—</span> },
            { h: 'Pays within', render: (r) => <span className="num">{r.payment_terms_days} days</span> },
            { h: 'Owes you', right: true, render: (r) => (Number(r.outstanding) > 0.005 ? <b className="text-warn">{money(r.outstanding, r.currency)}</b> : <span className="text-muted">—</span>) },
            { h: '', render: (r) => <div className="flex gap-1 justify-end whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
              {!archived && canEdit && <button className="btn-ghost" onClick={() => nav(`/bookings?client=${r.id}`)}>New booking</button>}
              {!archived && canEdit && <button className="btn-ghost" onClick={() => nav(`/quotes/new?client=${r.id}`)}>New quote</button>}
              {archived && manage && <button className="btn-ghost inline-flex items-center gap-1" onClick={() => api(`/clients/${r.id}/restore`, 'POST').then(() => { setNote(`${r.name} was restored.`); load(); }).catch((e) => setErr(e.message))}><ArchiveRestore size={14} />Restore</button>}</div> }]} />
      )}
      {rows && !archived && <p className="text-xs text-muted mt-2">{list.length} of {all.length} client{all.length === 1 ? '' : 's'}</p>}
      {open && <ClientDetail key={`${open}-${askDelete}`} id={open} names={all.map((r) => r.name)} canManage={manage} canEdit={canEdit} startDelete={askDelete} onClose={() => setOpen(null)} onChanged={(m) => { if (m) setNote(m); load(); }} />}
      {form && <PartyForm kind="clients" initial={form} names={all.map((r) => r.name)} onClose={() => setForm(null)} onSaved={(id) => { setForm(null); setNote('Client added.'); load(); if (id) setOpen(id); }} />}
    </Page>
  );
}
