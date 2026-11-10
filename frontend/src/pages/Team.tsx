import { useEffect, useState } from 'react';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Err, Field, Modal, Page, Pill, Table } from '../components/ui';
import { PasswordField, passwordOk } from '../components/PasswordField';

const ROLES: [string, string][] = [['admin', 'Admin — everything, including team and settings'], ['finance_manager', 'Finance manager — finance, approvals, reports'], ['agent', 'Agent — own leads, quotes, bookings'], ['viewer', 'Viewer — read-only']];

function MemberForm({ initial, branches, onClose, onSaved }: { initial: any; branches: any[]; onClose(): void; onSaved(): void }) {
  const editing = !!initial.id; const [f, setF] = useState<any>(initial); const [err, setErr] = useState(''); const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      const common = { role: f.role, default_commission_pct: Number(f.default_commission_pct) || 0, branch_id: f.branch_id ? Number(f.branch_id) : null };
      if (editing) await api(`/team/${initial.id}`, 'PUT', common); else await api('/team', 'POST', { ...common, email: f.email.trim(), name: f.name.trim(), ...(f.password ? { password: f.password } : {}) });
      onSaved();
    } catch (e: any) { setErr(e.message); }
  };
  return <Modal title={editing ? `Edit ${initial.name}` : 'Add team member'} onClose={onClose}><Err e={err} />
    {!editing && <div className="grid grid-cols-2 gap-x-4"><Field label="Email *"><input className="input" type="email" value={f.email} onChange={set('email')} /></Field><Field label="Name *"><input className="input" value={f.name} onChange={set('name')} /></Field>
      <div className="col-span-2"><Field label="Initial password" hint="Needed for a brand-new user (10+ characters). Leave empty if they already have an account — they keep their own password."><input className="input" type="password" autoComplete="new-password" value={f.password ?? ''} onChange={set('password')} /></Field></div></div>}
    {editing && <div className="text-sm text-muted mb-3">{initial.email}</div>}
    <Field label="Role"><select className="input" value={f.role} onChange={set('role')}>{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
    <div className="grid grid-cols-2 gap-x-4"><Field label="Branch" hint="Agents and finance managers with a branch only see that branch."><select className="input" value={f.branch_id ?? ''} onChange={set('branch_id')}><option value="">No branch</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
      <Field label="Default commission (%)"><input className="input num" type="number" min={0} max={100} step="0.01" value={f.default_commission_pct} onChange={set('default_commission_pct')} /></Field></div>
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={!editing && (!f.email || !f.name)} onClick={save}>{editing ? 'Save changes' : 'Add member'}</button></div></Modal>;
}

/** The agency owner sets a password for someone on their team. The person is signed out everywhere, and the owner passes the new password on. */
function SetPassword({ m, onClose, onDone }: { m: any; onClose(): void; onDone(msg: string): void }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); setErr(''); try { await api(`/team/${m.id}/password`, 'PUT', { password: pw }); onDone(`${m.name}'s password was changed and they were signed out. Give them the new password yourself.`); } catch (e: any) { setErr(e.message); setBusy(false); } };
  return <Modal title={`Set a password for ${m.name}`} onClose={onClose}><Err e={err} />
    <p className="mb-3 text-sm text-muted">Use this for someone who can’t reset their own password, such as a new hire. They are signed out everywhere and need the new password to sign in again. Tell them to keep it private.</p>
    <Field label="New password" hint="Generate one, then copy it and send it to them in person or by a private message."><PasswordField value={pw} onChange={setPw} autoFocus /></Field>
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !passwordOk(pw)} onClick={save}>{busy ? 'Saving…' : 'Set password'}</button></div></Modal>;
}

function RemoveMember({ m, others, onClose, onDone }: { m: any; others: any[]; onClose(): void; onDone(): void }) {
  const [w, setW] = useState<any>(null); const [to, setTo] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { api(`/team/${m.id}/workload`).then(setW); }, []);
  const total = w ? w.leads + w.bookings + w.quotes + w.tasks : 0;
  return <Modal title={`Remove ${m.name}?`} onClose={onClose}><Err e={err} />
    <p className="text-sm mb-3">{m.name} loses access to this agency immediately and frees a seat. Their sign-in account is not deleted (it may belong to other agencies), and everything they created stays in the history.</p>
    {w && total > 0 && <><div className="rounded-lg border border-warn/30 bg-warn/10 text-sm p-3 mb-3">Open work: <b>{w.leads}</b> leads · <b>{w.bookings}</b> bookings · <b>{w.quotes}</b> quotes · <b>{w.tasks}</b> tasks</div>
      <Field label="Hand their open work to"><select className="input" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Leave as is (unassigned owner shown by name)</option>{others.map((o) => <option key={o.user_id} value={o.user_id}>{o.name}</option>)}</select></Field></>}
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn bg-danger text-white" onClick={async () => { try { await api(`/team/${m.id}`, 'DELETE', to ? { reassign_to: Number(to) } : {}); onDone(); } catch (e: any) { setErr(e.message); } }}>Remove from agency</button></div></Modal>;
}

export default function Team() {
  const { can, user } = useAuth(); const admin = can('admin');
  const [members, setMembers] = useState<any[]>([]); const [branches, setBranches] = useState<any[]>([]); const [sub, setSub] = useState<any>(null);
  const [form, setForm] = useState<any>(null); const [rm, setRm] = useState<any>(null); const [pwFor, setPwFor] = useState<any>(null); const [note, setNote] = useState(''); const [err, setErr] = useState(''); const [newBranch, setNewBranch] = useState('');
  const load = () => { api('/team').then(setMembers).catch((e) => setErr(e.message)); api('/accounting/branches').then(setBranches); api('/billing/subscription').then(setSub).catch(() => {}); };
  useEffect(() => { load(); }, []);
  const go = async (fn: () => Promise<any>) => { try { await fn(); setErr(''); load(); } catch (e: any) { setErr(e.message); } };
  const seats = sub?.usage?.seats, seatLimit = sub?.limits?.seats;
  return (
    <Page title="Team & branches" description="Who can sign in to this agency, what they can do, and which branch they work in."
      actions={admin && <button className="btn" onClick={() => setForm({ email: '', name: '', password: '', role: 'agent', branch_id: '', default_commission_pct: 0 })}><Plus size={15} /> Add member</button>}>
      <Err e={form || rm || pwFor ? '' : err} />
      {note && <div role="status" className="mb-3 flex justify-between gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"><span>{note}</span><button aria-label="Dismiss" onClick={() => setNote('')}>×</button></div>}
      {seats !== undefined && <div className="text-sm text-muted mb-3">{seats} of {seatLimit ?? 'unlimited'} seats used on the {sub.subscription?.plan?.name} plan.</div>}
      <Table rows={members} empty="No members" cols={[
        { h: 'Member', render: (m) => <><div className="font-medium">{m.name}{m.user_id === user?.id && <span className="text-xs text-muted ml-2">you</span>}</div><div className="text-xs text-muted">{m.email}</div></> },
        { h: 'Role', render: (m) => <span className="capitalize">{m.role.replace('_', ' ')}</span> }, { h: 'Branch', render: (m) => m.branch_name ?? <span className="text-muted">—</span> },
        { h: 'Commission', right: true, render: (m) => `${m.default_commission_pct ?? 0}%` }, { h: '2FA', render: (m) => (m.totp_enabled ? <span className="text-xs text-success">On</span> : <span className="text-xs text-muted">Off</span>) },
        { h: '', render: (m) => admin && <div className="flex gap-1 justify-end"><button className="btn-ghost" onClick={() => setForm({ ...m, branch_id: m.branch_id ?? '' })}><Pencil size={14} /> Edit</button>{m.user_id !== user?.id && m.role !== 'admin' && <button className="btn-ghost" aria-label={`Set a password for ${m.name}`} title="Set a password" onClick={() => setPwFor(m)}><KeyRound size={14} /></button>}{m.user_id !== user?.id && <button className="btn-ghost text-danger" aria-label={`Remove ${m.name}`} onClick={() => setRm(m)}><Trash2 size={14} /></button>}</div> }]} />

      <h2 className="font-semibold mt-8 mb-2">Branches</h2>
      <div className="card p-0">{branches.length === 0 && <div className="p-4 text-sm text-muted">No branches yet.</div>}
        {branches.map((b) => <div key={b.id} className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-line last:border-0 text-sm"><span>{b.name}</span>
          {can('admin', 'finance_manager') && <div className="flex gap-1"><button className="btn-ghost" onClick={() => { const n = prompt('Rename branch', b.name); if (n && n.trim() && n !== b.name) go(() => api(`/accounting/branches/${b.id}`, 'PUT', { name: n.trim() })); }}><Pencil size={14} /> Rename</button>
            <button className="btn-ghost text-danger" aria-label={`Delete ${b.name}`} onClick={() => confirm(`Delete branch "${b.name}"? This only works if nothing uses it.`) && go(() => api(`/accounting/branches/${b.id}`, 'DELETE'))}><Trash2 size={14} /></button></div>}</div>)}</div>
      {can('admin', 'finance_manager') && <form className="flex gap-2 mt-3 max-w-md" onSubmit={(e) => { e.preventDefault(); if (newBranch.trim()) go(async () => { await api('/accounting/branches', 'POST', { name: newBranch.trim() }); setNewBranch(''); }); }}>
        <input className="input" placeholder="New branch name" aria-label="New branch name" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} /><button className="btn" disabled={!newBranch.trim()}>Add branch</button></form>}

      {form && <MemberForm initial={form} branches={branches} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}
      {pwFor && <SetPassword m={pwFor} onClose={() => setPwFor(null)} onDone={(msg) => { setPwFor(null); setNote(msg); load(); }} />}
      {rm && <RemoveMember m={rm} others={members.filter((x) => x.id !== rm.id)} onClose={() => setRm(null)} onDone={() => { setRm(null); load(); }} />}
    </Page>
  );
}
