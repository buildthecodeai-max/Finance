import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Banknote, Bell, BriefcaseBusiness, CalendarClock, Check, CheckCheck, CheckCircle2, CircleDollarSign, FileText, Info, LifeBuoy, Plane, ShieldAlert, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import { Popover } from './ui';

export type Note = { key: string; category: 'money' | 'sales' | 'work' | 'trips' | 'account'; severity: 'success' | 'info' | 'warn' | 'danger'; title: string; body: string; at: string; link: string | null; read: boolean };
export const CATEGORY: Record<string, { label: string; icon: LucideIcon }> = {
  money: { label: 'Money', icon: CircleDollarSign }, sales: { label: 'Sales', icon: FileText }, work: { label: 'My work', icon: BriefcaseBusiness }, trips: { label: 'Trips', icon: Plane }, account: { label: 'Account', icon: LifeBuoy },
};
export const SEV: Record<string, { hue: string; icon: LucideIcon }> = { success: { hue: 'success', icon: CheckCircle2 }, info: { hue: 'info', icon: Info }, warn: { hue: 'warn', icon: AlertTriangle }, danger: { hue: 'danger', icon: ShieldAlert } };
const KIND_ICON = (k: string): LucideIcon => (k.startsWith('payment') ? Banknote : k.startsWith('quote') ? FileText : k.startsWith('trip') ? Plane : k.startsWith('task') || k.startsWith('lead') ? CalendarClock : k.startsWith('help') ? LifeBuoy : k.startsWith('inv') ? CircleDollarSign : k.startsWith('plan') ? ShieldAlert : AlertTriangle);

export const ago = (d: string) => { const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000); return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : s < 86400 * 7 ? `${Math.round(s / 86400)} d ago` : new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };

/** One row, used in the bell's list and on the Notifications page. */
export function NoteRow({ n, onOpen, onToggle, compact = false }: { n: Note; onOpen(n: Note): void; onToggle?(n: Note): void; compact?: boolean }) {
  const s = SEV[n.severity]; const Icon = KIND_ICON(n.key);
  return (
    <div className={`group relative flex items-start gap-3 ${compact ? 'px-3 py-2.5' : 'px-4 py-3'} ${n.read ? '' : 'bg-accent/[0.04]'}`}>
      {!n.read && <span className="absolute left-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-accent" aria-label="Unread" />}
      <button type="button" className="flex min-w-0 flex-1 items-start gap-3 text-left" onClick={() => onOpen(n)}>
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl" style={{ background: `rgb(var(--${s.hue}) / .14)`, color: `rgb(var(--${s.hue}))` }}><Icon size={15} /></span>
        <span className="min-w-0 flex-1"><span className={`block text-sm leading-snug ${n.read ? 'text-muted' : 'font-medium'}`}>{n.title}</span><span className="mt-0.5 block text-xs text-muted">{n.body}</span><span className="mt-0.5 block text-[11px] text-muted">{ago(n.at)}</span></span></button>
      {onToggle && <button type="button" className="mt-1 shrink-0 rounded-md p-1 text-muted opacity-0 transition hover:bg-surface2 hover:text-fg focus:opacity-100 group-hover:opacity-100" aria-label={n.read ? 'Mark as unread' : 'Mark as read'} title={n.read ? 'Mark as unread' : 'Mark as read'} onClick={() => onToggle(n)}>{n.read ? <Bell size={14} /> : <Check size={14} />}</button>}
    </div>
  );
}

/** The bell in the top bar: a count of what is unread, and a quick list. It refreshes itself every minute and when the tab comes back into view. */
export function NotificationBell() {
  const nav = useNavigate(); const [unread, setUnread] = useState(0); const [items, setItems] = useState<Note[] | null>(null);
  const count = useCallback(() => api('/notifications/count').then((r) => setUnread(r.unread)).catch(() => {}), []);
  useEffect(() => { window.addEventListener('tf:notifications', count); return () => window.removeEventListener('tf:notifications', count); }, [count]);   // the Notifications page changed something
  useEffect(() => { count(); const h = setInterval(count, 60_000); const v = () => { if (!document.hidden) count(); }; document.addEventListener('visibilitychange', v); return () => { clearInterval(h); document.removeEventListener('visibilitychange', v); }; }, [count]);
  const load = () => api('/notifications').then((r) => { setItems(r.items.slice(0, 7)); setUnread(r.unread); }).catch(() => setItems([]));
  const open = async (n: Note, close: () => void) => { close(); if (!n.read) { api('/notifications/read', 'POST', { keys: [n.key] }).then(count).catch(() => {}); } if (n.link) nav(n.link); };
  return (
    <Popover width="w-[22rem] max-w-[92vw]" trigger={(isOpen, toggle) => (
      <button className="btn-icon relative" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} title="Notifications" aria-expanded={isOpen} onClick={() => { if (!isOpen) load(); toggle(); }}>
        <Bell size={18} />{unread > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-[1rem] place-items-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-white">{unread > 99 ? '99+' : unread}</span>}</button>)}>
      {(close) => (
        <div role="dialog" aria-label="Notifications" className="-m-1">
          <div className="flex items-center justify-between border-b border-line px-3 py-2.5"><span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && <button className="inline-flex items-center gap-1 text-xs text-accent hover:underline" onClick={async () => { await api('/notifications/read', 'POST', { all: true }); load(); }}><CheckCheck size={13} />Mark all read</button>}</div>
          <div className="max-h-[26rem] divide-y divide-line/70 overflow-auto">
            {!items ? <div className="px-4 py-8 text-center text-sm text-muted">Loading…</div> : !items.length ? <div className="px-4 py-10 text-center"><span className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-2xl bg-success/10 text-success"><CheckCircle2 size={20} /></span><div className="text-sm font-medium">You are all caught up</div><p className="mt-0.5 text-xs text-muted">Nothing needs your attention right now.</p></div>
              : items.map((n) => <NoteRow key={n.key} n={n} compact onOpen={(x) => open(x, close)} />)}</div>
          <button className="w-full border-t border-line px-3 py-2.5 text-center text-sm font-medium text-accent hover:bg-surface2" onClick={() => { close(); nav('/notifications'); }}>See all notifications</button>
        </div>)}
    </Popover>
  );
}
