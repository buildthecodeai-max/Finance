import { useEffect, useRef, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { ThemeMode, useTheme } from '../theme';

/** Stand-alone theme switcher for pages outside the app shell (login, public quote). */
export function ThemeMenuButton() {
  const { mode, resolved, setMode } = useTheme(); const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false); document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  const opts: [ThemeMode, string, any][] = [['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'System', Monitor]];
  return (
    <div className="relative" ref={ref}>
      <button className="btn-icon" onClick={() => setOpen(!open)} aria-label={`Theme: ${mode}`}>{resolved === 'dark' ? <Moon size={18} /> : <Sun size={18} />}</button>
      {open && <div className="absolute right-0 z-50 mt-2 w-40 bg-surface border border-line rounded-xl shadow-pop p-1.5">{opts.map(([m, l, Icon]) => (
        <button key={m} onClick={() => { setMode(m); setOpen(false); }} className="flex w-full items-center gap-2.5 px-2.5 py-2 text-sm rounded-lg hover:bg-surface2"><Icon size={15} /><span className="flex-1 text-left">{l}</span>{mode === m && <Check size={14} />}</button>))}</div>}
    </div>
  );
}
