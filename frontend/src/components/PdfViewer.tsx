import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Printer, X } from 'lucide-react';

type Job = { title: string; source: (() => Promise<string>) | string; html?: false } | { title: string; html: string };
const EVT = 'app:view-doc';

/** Show a PDF inside the app. `source` may be a URL or an async function that returns one (the viewer opens at once and shows a spinner meanwhile). */
export const viewPdf = (source: string | (() => Promise<string>), title: string) => window.dispatchEvent(new CustomEvent(EVT, { detail: { title, source } satisfies Job }));
/** Show a printable HTML document inside the app (cheques, vouchers…), with a Print button. */
export const viewHtml = (html: string, title: string) => window.dispatchEvent(new CustomEvent(EVT, { detail: { title, html } satisfies Job }));

/** Mount once at the app root. Listens for viewPdf / viewHtml and shows the document in a large window. */
export function DocViewerHost() {
  const [job, setJob] = useState<Job | null>(null); const [url, setUrl] = useState(''); const [err, setErr] = useState(''); const [loaded, setLoaded] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null); const closeBtn = useRef<HTMLButtonElement>(null); const opener = useRef<HTMLElement | null>(null);
  useEffect(() => { const h = (e: Event) => { opener.current = document.activeElement as HTMLElement; setUrl(''); setErr(''); setLoaded(false); setJob((e as CustomEvent<Job>).detail); }; window.addEventListener(EVT, h); return () => window.removeEventListener(EVT, h); }, []);
  useEffect(() => {
    if (!job || 'html' in job) return; let live = true;
    Promise.resolve(typeof job.source === 'function' ? job.source() : job.source).then((u) => live && setUrl(u)).catch((e) => live && setErr(e?.message ?? 'Could not load the document'));
    return () => { live = false; };
  }, [job]);
  const close = () => { setJob(null); setUrl(''); opener.current?.focus?.(); };
  useEffect(() => { if (!job) return; closeBtn.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; window.addEventListener('keydown', k); const prev = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { window.removeEventListener('keydown', k); document.body.style.overflow = prev; }; }, [job]);
  if (!job) return null;
  const isHtml = 'html' in job && job.html !== undefined;
  const print = () => { try { frame.current?.contentWindow?.focus(); frame.current?.contentWindow?.print(); } catch { if (url) window.open(url, '_blank', 'noopener'); } };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-2 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-modal="true" aria-label={job.title} className="flex flex-col w-full max-w-5xl h-full max-h-[94vh] rounded-xl border border-line bg-surface shadow-pop overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line shrink-0">
          <h2 className="font-semibold truncate flex-1">{job.title}</h2>
          {(isHtml || url) && <button className="btn-ghost inline-flex items-center gap-1" onClick={print}><Printer size={15} />Print</button>}
          {url && <a className="btn-ghost inline-flex items-center gap-1" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />Open in new tab</a>}
          <button ref={closeBtn} className="btn-ghost !px-2" aria-label="Close" onClick={close}><X size={17} /></button></div>
        <div className="relative flex-1 min-h-0 bg-surface2">
          {err ? <div className="h-full grid place-items-center p-6 text-center"><div><p className="text-danger text-sm mb-3">{err}</p><button className="btn-ghost" onClick={close}>Close</button></div></div>
            : isHtml ? <iframe ref={frame} title={job.title} srcDoc={(job as { html: string }).html} className="w-full h-full bg-white" />
            : url ? <>{!loaded && <div className="absolute inset-0 grid place-items-center text-sm text-muted pointer-events-none">Loading document…</div>}
              <iframe ref={frame} title={job.title} src={url} onLoad={() => setLoaded(true)} className="w-full h-full bg-white" /></>
            : <div className="h-full grid place-items-center text-sm text-muted">Preparing document…</div>}
        </div>
        {url && <p className="px-4 py-1.5 text-[11px] text-muted border-t border-line shrink-0">Can't see the document? Use “Open in new tab”. To save it, use the download button in the viewer above.</p>}
      </div>
    </div>
  );
}
