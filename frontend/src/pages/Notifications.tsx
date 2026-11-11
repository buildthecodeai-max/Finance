import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, CheckCircle2 } from 'lucide-react';
import { api } from '../api';
import { CATEGORY, NoteRow, SEV, type Note } from '../components/Notifications';
import { Err, Page, Skeleton } from '../components/ui';

const dayKey = (d: string) => { const t = new Date(d); return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const dayLabel = (k: string) => { const now = new Date(); const iso = (x: Date) => new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10); const y = new Date(now.getTime() - 864e5);
  return k === iso(now) ? 'Today' : k === iso(y) ? 'Yesterday' : new Date(`${k}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); };

/** Everything that needs the person's attention, worked out from the agency's live records. Click one to jump to it; it is marked read as you go. */
export default function Notifications() {
  const nav = useNavigate();
  const [data, setData] = useState<{ items: Note[]; unread: number; counts: Record<string, number> } | null>(null); const [err, setErr] = useState(''); const [cat, setCat] = useState('all'); const [unreadOnly, setUnreadOnly] = useState(false);
  const load = () => api('/notifications').then((r) => { setData(r); setErr(''); window.dispatchEvent(new Event('tf:notifications')); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const items = data?.items ?? [];
  const shown = useMemo(() => items.filter((n) => (cat === 'all' || n.category === cat) && (!unreadOnly || !n.read)), [items, cat, unreadOnly]);
  const groups = useMemo(() => { const m = new Map<string, Note[]>(); for (const n of shown) { const k = dayKey(n.at); m.set(k, [...(m.get(k) ?? []), n]); } return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])); }, [shown]);
  const open = async (n: Note) => { if (!n.read) { setData((d) => d && { ...d, unread: d.unread - 1, items: d.items.map((x) => (x.key === n.key ? { ...x, read: true } : x)) }); api('/notifications/read', 'POST', { keys: [n.key] }).then(() => window.dispatchEvent(new Event('tf:notifications'))).catch(() => {}); } if (n.link) nav(n.link); };
  const toggle = async (n: Note) => { try { await api(`/notifications/${n.read ? 'unread' : 'read'}`, 'POST', { keys: [n.key] }); load(); } catch (e: any) { setErr(e.message); } };
  const markAll = async () => { try { await api('/notifications/read', 'POST', { all: true }); load(); } catch (e: any) { setErr(e.message); } };
  const attention = items.filter((n) => !n.read && (n.severity === 'danger' || n.severity === 'warn')).length;
  const cats = Object.keys(CATEGORY);

  return (
    <Page title="Notifications" description="What needs your attention, from your quotes, money, work, trips and account."
      actions={data && data.unread > 0 ? <button className="btn-ghost" onClick={markAll}><CheckCheck size={15} />Mark all as read</button> : undefined}>
      <Err e={err} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[['Unread', data?.unread, 'accent', Bell], ['Need action', attention, attention ? 'warn' : 'success', Bell], ['Money', data?.counts.money, 'success', Bell], ['My work', data?.counts.work, 'info', Bell]].map(([l, v, hue, Icon]: any, i) => (
          <button key={l} type="button" onClick={() => { if (i === 0) { setCat('all'); setUnreadOnly(true); } else if (i === 2) { setCat('money'); setUnreadOnly(false); } else if (i === 3) { setCat('work'); setUnreadOnly(false); } }} className="card glow-card text-left" style={{ ['--hue' as any]: `var(--${hue})` }}>
            <div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{l}</span><span className="grid h-8 w-8 place-items-center rounded-xl" style={{ background: `rgb(var(--${hue}) / .14)`, color: `rgb(var(--${hue}))` }}><Icon size={16} /></span></div>
            <div className="mt-2 text-3xl font-bold num">{data ? v ?? 0 : '—'}</div></button>))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Notification type">
          {[['all', 'All', data?.counts.all], ...cats.map((k) => [k, CATEGORY[k].label, data?.counts[k]])].map(([k, l, n]: any) => (
            <button key={k} role="tab" aria-selected={cat === k} onClick={() => setCat(k)} className={`whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm ${cat === k ? 'border-accent bg-accent/15 font-medium text-accent' : 'border-line hover:bg-surface2'}`}>{l}{!!n && <span className="ml-1.5 rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-bold text-white num">{n}</span>}</button>))}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />Unread only</label>
      </div>

      {!data ? <Skeleton className="h-72" /> : !shown.length ? (
        <div className="card py-16 text-center"><span className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-success/10 text-success"><CheckCircle2 size={28} /></span>
          <div className="text-base font-semibold">{items.length ? 'Nothing here' : 'You are all caught up'}</div>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{items.length ? 'Nothing matches these filters.' : 'When a client answers a quote, a payment arrives, an invoice goes overdue, a task falls due or a trip is about to leave, it appears here.'}</p>
          {items.length > 0 && <button className="btn-ghost mt-4" onClick={() => { setCat('all'); setUnreadOnly(false); }}>Show everything</button>}</div>
      ) : (
        <div className="card !p-0 overflow-hidden">
          {groups.map(([k, rows]) => (
            <section key={k} aria-label={dayLabel(k)}>
              <h2 className="sticky top-0 z-[1] border-b border-line bg-surface2/90 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted backdrop-blur">{dayLabel(k)} <span className="ml-1 font-normal normal-case">· {rows.length}</span></h2>
              <div className="divide-y divide-line/70">{rows.map((n) => <NoteRow key={n.key} n={n} onOpen={open} onToggle={toggle} />)}</div>
            </section>))}
        </div>
      )}
      <p className="mt-3 text-xs text-muted">These come straight from your records, so they clear on their own once the thing is dealt with. Read marks are personal to you.</p>
    </Page>
  );
}
void SEV;
