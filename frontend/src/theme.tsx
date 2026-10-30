import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
interface Ctx { mode: ThemeMode; resolved: 'light' | 'dark'; setMode(m: ThemeMode): void }
const C = createContext<Ctx>({ mode: 'system', resolved: 'dark', setMode() {} });
export const useTheme = () => useContext(C);

const stored = (): ThemeMode => { try { const v = localStorage.getItem('tf-theme'); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; } };
const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(stored);
  const [sys, setSys] = useState(systemDark);
  useEffect(() => { const mq = matchMedia('(prefers-color-scheme: dark)'); const h = () => setSys(mq.matches); mq.addEventListener('change', h); return () => mq.removeEventListener('change', h); }, []);
  const wanted = mode === 'system' ? (sys ? 'dark' : 'light') : mode;
  // `resolved` only changes AFTER the attribute is on <html>, so anything reading CSS variables (charts) sees the new palette.
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'));
  useLayoutEffect(() => {
    const root = document.documentElement;
    // Switch instantly: without this, elements with colour transitions briefly show a mix of both palettes.
    root.classList.add('theme-switching'); root.setAttribute('data-theme', wanted); setResolved(wanted);
    const t = setTimeout(() => root.classList.remove('theme-switching'), 80); return () => clearTimeout(t);
  }, [wanted]);
  const setMode = useCallback((m: ThemeMode) => { setModeState(m); try { localStorage.setItem('tf-theme', m); } catch { /* private mode: still works for this session */ } }, []);
  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

/** Resolved hex/rgb strings for chart libraries (SVG attributes can't reliably read CSS variables). Recomputed on theme change. */
export function useChartColors() {
  const { resolved } = useTheme();
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const c = (n: string, a = 1) => `rgb(${css.getPropertyValue(`--${n}`).trim().split(/\s+/).join(' ')} / ${a})`;
    return {
      accent: c('accent'), accentSoft: c('accent', 0.18), grid: c('line'), text: c('muted'), surface: c('surface'), fg: c('fg'),
      series: [c('accent'), c('info'), c('warn'), '#a78bfa', c('danger'), c('muted')],
      aging: [c('success'), c('warn'), '#f97316', c('danger')],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);
}
