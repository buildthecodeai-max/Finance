import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, FileSpreadsheet, FileText, Loader2, RotateCcw, Search, UploadCloud, X } from 'lucide-react';
import { api, download, n2, upload } from '../api';
import { useAuth } from '../auth';
import { Banner, Err, Field, Modal, Page, Pager, Skeleton, Table } from '../components/ui';
import { useList } from '../lookup';

const TABS = [
  ['import', 'Upload & review'], ['history', 'Import history'], ['transactions', 'Transactions'], ['passengers', 'Passengers'],
  ['locations', 'Locations'], ['payers', 'Payers'], ['reconcile', 'Reconciliation'], ['templates', 'Mapping templates'],
] as const;
type Tab = (typeof TABS)[number][0];
const KIND: Record<string, string> = { sale: 'Sale', credit_note: 'Credit note', refund: 'Refund', exchange: 'Reissue / exchange', payment: 'Payment', reversal: 'Reversal' };
const STATE_TONE: Record<string, string> = { paid: 'bg-success/15 text-success', partial: 'bg-warn/15 text-warn', unpaid: 'bg-danger/10 text-danger', credit: 'bg-surface2 text-muted', payment: 'bg-accent/15 text-accent' };
const ST: Record<string, string> = { processing: 'Reading file', review: 'Waiting for review', importing: 'Importing', imported: 'Imported', cancelled: 'Cancelled', failed: 'Failed', rolled_back: 'Rolled back' };
const ST_TONE: Record<string, string> = { review: 'bg-warn/15 text-warn', imported: 'bg-success/15 text-success', failed: 'bg-danger/10 text-danger', rolled_back: 'bg-surface2 text-muted', cancelled: 'bg-surface2 text-muted', processing: 'bg-accent/15 text-accent', importing: 'bg-accent/15 text-accent' };
const Chip = ({ tone, children }: { tone?: string; children: ReactNode }) => <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone ?? 'bg-surface2 text-muted'}`}>{children}</span>;
const StatusChip = ({ s }: { s: string }) => <Chip tone={ST_TONE[s]}>{ST[s] ?? s}</Chip>;
const fmtDate = (d?: string | null) => (d ? String(d).slice(0, 10) : '—');
const fmtTime = (d?: string | null) => (d ? new Date(d).toLocaleString() : '—');
const mb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const Kpi = ({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: string; hint?: string }) => (
  <div className="card !p-3 min-w-0"><div className="text-[11px] uppercase tracking-wide text-muted">{label}</div><div className={`text-xl font-semibold num mt-0.5 truncate ${tone ?? ''}`}>{value}</div>{hint && <div className="text-[11px] text-muted mt-0.5">{hint}</div>}</div>
);
const J = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);

export default function ExternalImport() {
  const { can } = useAuth(); const [sp, setSp] = useSearchParams();
  const tab = (TABS.find((t) => t[0] === sp.get('tab'))?.[0] ?? 'import') as Tab;
  const go = (t: Tab, extra: Record<string, string> = {}) => setSp({ tab: t, ...extra });
  const canEdit = can('admin', 'finance_manager', 'agent'), canWrite = can('admin', 'finance_manager');
  return (
    <Page title="External import" description="Upload a statement from outside (Excel, CSV or PDF). It is read, checked and shown to you first — nothing is saved until you confirm.">
      <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1 mb-4" role="tablist" aria-label="External import views">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => go(k)}
            className={`whitespace-nowrap text-sm px-3 py-1.5 rounded-lg border ${tab === k ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>{label}</button>))}
      </div>
      {tab === 'import' && <ImportTab canEdit={canEdit} canWrite={canWrite} batchId={Number(sp.get('batch')) || null} open={(id) => setSp({ tab: 'import', ...(id ? { batch: String(id) } : {}) })} goReports={() => go('transactions')} />}
      {tab === 'history' && <HistoryTab canWrite={canWrite} openBatch={(id) => setSp({ tab: 'import', batch: String(id) })} />}
      {tab === 'transactions' && <TransactionsTab />}
      {tab === 'passengers' && <PassengersTab />}
      {tab === 'locations' && <LocationsTab />}
      {tab === 'payers' && <PayersTab openTx={(cid) => go('transactions', { client: String(cid) })} />}
      {tab === 'reconcile' && <ReconcileTab canWrite={canWrite} />}
      {tab === 'templates' && <TemplatesTab canWrite={canWrite} />}
    </Page>
  );
}

/* ───────────────────────────── upload & review ───────────────────────────── */

interface Up { name: string; size: number; progress: number; state: 'uploading' | 'done' | 'error'; error?: string; id?: number; same?: number }

function ImportTab({ canEdit, canWrite, batchId, open, goReports }: { canEdit: boolean; canWrite: boolean; batchId: number | null; open(id: number | null): void; goReports(): void }) {
  const [ups, setUps] = useState<Up[]>([]), [drag, setDrag] = useState(false), [pending, setPending] = useState<any[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const loadPending = useCallback(async () => { try { setPending((await api<any[]>('/ext-import/batches')).filter((b) => ['processing', 'review', 'importing', 'failed'].includes(b.status))); } catch { setPending([]); } }, []);
  useEffect(() => { loadPending(); }, [loadPending, batchId]);
  useEffect(() => { if (!pending?.some((b) => b.status === 'processing' || b.status === 'importing')) return; const t = setTimeout(loadPending, 1200); return () => clearTimeout(t); }, [pending, loadPending]);

  const send = async (files: File[]) => {
    const list = files.filter((f) => /\.(xlsx|xls|csv|pdf|tsv|txt)$/i.test(f.name) || f.type.includes('sheet') || f.type.includes('pdf'));
    const items: Up[] = (list.length ? list : files).map((f) => ({ name: f.name, size: f.size, progress: 0, state: 'uploading' }));
    setUps((u) => [...items, ...u]);
    for (let i = 0; i < items.length; i++) {
      const f = (list.length ? list : files)[i], it = items[i];
      const patch = (p: Partial<Up>) => setUps((u) => u.map((x) => (x === it ? Object.assign(it, p) && { ...it } : x)) as Up[]);
      try { const r = await upload('/ext-import/upload', f, (p) => patch({ progress: p })); Object.assign(it, { state: 'done', progress: 1, id: r.id, same: r.same_file?.id }); setUps((u) => [...u]); if (files.length === 1) open(r.id); }
      catch (e: any) { Object.assign(it, { state: 'error', error: e.message }); setUps((u) => [...u]); }
    }
    loadPending();
  };

  if (batchId) return <Review id={batchId} canEdit={canEdit} canWrite={canWrite} back={() => { open(null); loadPending(); }} goReports={goReports} />;
  return (
    <div className="space-y-5">
      {canEdit ? (
        <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); send(Array.from(e.dataTransfer.files)); }}
          className={`rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${drag ? 'border-accent bg-accent/10' : 'border-line bg-surface'}`}>
          <UploadCloud className="mx-auto text-accent" size={38} strokeWidth={1.5} />
          <div className="mt-2 font-medium">Drag statements here, or</div>
          <button className="btn mt-3" onClick={() => input.current?.click()}>Browse files</button>
          <input ref={input} type="file" multiple hidden accept=".xlsx,.csv,.pdf,.tsv,.txt" onChange={(e) => { send(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          <div className="mt-4 flex flex-wrap justify-center gap-2 text-xs text-muted">
            <Chip><FileSpreadsheet size={12} className="mr-1" />Excel .xlsx</Chip><Chip><FileText size={12} className="mr-1" />CSV</Chip><Chip><FileText size={12} className="mr-1" />PDF (text-based)</Chip><Chip>Up to 25 MB · several files at once</Chip>
          </div>
          <p className="text-xs text-muted mt-3 max-w-xl mx-auto">Older .xls files: open in Excel and “Save As” .xlsx first. Scanned PDFs (pictures of paper) can't be read — export the statement as Excel instead.</p>
        </div>
      ) : <Banner ok={false}>You can view imports but not upload. Ask an admin or finance manager for access.</Banner>}

      {ups.length > 0 && (
        <div className="card !p-0 divide-y divide-line">
          {ups.map((u, i) => (
            <div key={i} className="px-4 py-2.5 flex items-center gap-3 text-sm">
              <FileSpreadsheet size={18} className="text-muted shrink-0" />
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{u.name} <span className="text-muted font-normal">· {mb(u.size)}</span></div>
                {u.state === 'uploading' && <div className="h-1.5 rounded bg-surface2 mt-1.5 overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${Math.round(u.progress * 100)}%` }} /></div>}
                {u.state === 'error' && <div className="text-danger text-xs mt-0.5">{u.error}</div>}
                {u.state === 'done' && u.same && <div className="text-warn text-xs mt-0.5 flex items-center gap-1"><AlertTriangle size={12} /> This exact file was uploaded before (import #{u.same}). Lines already imported will be flagged as duplicates.</div>}</div>
              {u.state === 'done' && u.id && <button className="btn-ghost" onClick={() => open(u.id!)}>Open</button>}
              {u.state === 'uploading' && <Loader2 size={16} className="animate-spin text-muted" />}
            </div>))}
        </div>)}

      <div>
        <h2 className="font-semibold mb-2">Pending imports</h2>
        {!pending ? <Skeleton className="h-16" /> : !pending.length ? <div className="card text-sm text-muted">Nothing waiting. Uploaded files that are read but not yet confirmed appear here.</div> : (
          <div className="grid gap-2">{pending.map((b) => (
            <div key={b.id} className="card !p-3 flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1"><div className="font-medium truncate">{b.file_name}</div>
                <div className="text-xs text-muted">Uploaded {fmtTime(b.uploaded_at)} by {b.uploaded_by_name ?? '—'}{b.status === 'review' && <> · {b.total_rows} lines · {b.error_rows} with errors · {b.duplicate_rows} duplicates</>}</div>
                {(b.status === 'processing' || b.status === 'importing') && <div className="h-1.5 rounded bg-surface2 mt-1.5 max-w-sm overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${b.progress}%` }} /></div>}
                {b.status === 'failed' && <div className="text-xs text-danger mt-0.5">{b.error}</div>}</div>
              <StatusChip s={b.status} /><span className="text-xs text-muted">{b.stage}</span>
              <button className="btn-ghost" onClick={() => open(b.id)}>{b.status === 'review' ? 'Review' : 'Open'}</button>
            </div>))}</div>)}
      </div>
    </div>
  );
}

/* ── one batch: summary, settings, mapping, preview, confirm ── */

function Review({ id, canEdit, canWrite, back, goReports }: { id: number; canEdit: boolean; canWrite: boolean; back(): void; goReports(): void }) {
  const [b, setB] = useState<any>(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState<any>(null);
  const [map, setMap] = useState(false), [confirm, setConfirm] = useState(false), [roll, setRoll] = useState(false);
  const load = useCallback(async () => { try { setB(await api(`/ext-import/batches/${id}`)); } catch (e: any) { setErr(e.message); } }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (b?.status !== 'processing' && b?.status !== 'importing') return; const t = setTimeout(load, 1000); return () => clearTimeout(t); }, [b, load]);
  const act = async (f: () => Promise<any>) => { setBusy(true); setErr(''); try { const r = await f(); await load(); return r; } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  if (!b) return err ? <><Err e={err} /><button className="btn-ghost" onClick={back}>Back</button></> : <Skeleton className="h-64" />;
  const editable = b.status === 'review' && canEdit;
  const settings = (s: any) => act(() => api(`/ext-import/batches/${id}/settings`, 'PUT', s));
  const tables = (b.sheets ?? []).filter((s: any) => s.kind === 'table');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-ghost" onClick={back}>← All imports</button>
        <div className="min-w-0"><div className="font-semibold truncate">{b.file_name}</div><div className="text-xs text-muted">{b.file_format.toUpperCase()} · {mb(b.file_size)} · uploaded {fmtTime(b.uploaded_at)}</div></div>
        <StatusChip s={b.status} />
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost" onClick={() => download(`/ext-import/batches/${id}/errors.csv`, `import-${id}-problems.csv`).catch((e) => setErr(e.message))}><Download size={15} />Problem report</button>
          {b.status === 'imported' && canWrite && <button className="btn-ghost" onClick={() => setRoll(true)}><RotateCcw size={15} />Roll back</button>}
        </div>
      </div>
      <Err e={err} />
      {done && <Banner onClose={() => setDone(null)} action={{ label: 'See transactions', onClick: goReports }}>Imported {done.imported} record{done.imported === 1 ? '' : 's'}{done.failed ? `, ${done.failed} could not be saved` : ''}{done.unmatched_payments ? `, ${done.unmatched_payments} payment(s) still unmatched` : ''}. {done.invoices} invoice{done.invoices === 1 ? '' : 's'} and {done.credit_notes} credit{done.credit_notes === 1 ? '' : 's'} were posted to the client's account in Invoices and the ledger.
        {done.not_posted?.length > 0 && <div className="mt-1 text-warn">Kept in External import but not posted to Invoices: {done.not_posted.slice(0, 4).map((n: any) => `${n.invoice_no ?? 'line'} (${n.why})`).join('; ')}{done.not_posted.length > 4 ? ` and ${done.not_posted.length - 4} more` : ''}.</div>}</Banner>}

      {(b.status === 'processing' || b.status === 'importing') && (
        <div className="card"><div className="flex items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin text-accent" /> {b.stage}…</div><div className="h-2 rounded bg-surface2 mt-2 overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${b.progress}%` }} /></div></div>)}
      {b.status === 'failed' && <div className="card border-danger/30"><div className="font-medium text-danger">This file could not be processed</div><p className="text-sm mt-1">{b.error}</p></div>}
      {b.status === 'imported' && b.unposted > 0 && (
        <div className="card border-warn/40">
          <div className="font-medium flex items-center gap-2"><AlertTriangle size={16} className="text-warn" />{b.unposted} imported record{b.unposted === 1 ? '' : 's'} not yet on invoices / ledger</div>
          {(b.not_posted ?? []).length > 0 && <ul className="text-sm mt-1 text-muted list-disc pl-5">{[...new Set((b.not_posted as any[]).map((n) => n.why))].slice(0, 4).map((w) => <li key={w}>{w}</li>)}</ul>}
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {canWrite ? <button className="btn" disabled={busy} onClick={async () => { const r = await act(() => api(`/ext-import/batches/${id}/post`, 'POST')); if (r) setDone({ imported: 0, failed: 0, ...r }); }}>Post to invoices now</button> : <span className="text-xs text-muted">An admin or finance manager can post these.</span>}
            <span className="text-xs text-muted">Fix the cause first (e.g. add the exchange rate under Finance → Exchange rates), then post. Records already posted are not touched.</span></div>
        </div>)}
      {b.status === 'rolled_back' && <Banner ok={false}>Rolled back {fmtTime(b.rolled_back_at)} — {b.rollback_reason}. The records are kept for audit but no longer count in reports.</Banner>}

      {['review', 'imported', 'rolled_back', 'cancelled'].includes(b.status) && <>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi label="Records detected" value={b.total_rows} hint={b.skipped_rows ? `${b.skipped_rows} blank/subtotal lines ignored` : undefined} />
          <Kpi label="Valid" value={b.valid_rows} tone="text-success" />
          <Kpi label="With errors" value={b.error_rows} tone={b.error_rows ? 'text-danger' : ''} hint={b.error_rows ? 'not imported until fixed' : undefined} />
          <Kpi label="Potential duplicates" value={b.duplicate_rows} tone={b.duplicate_rows ? 'text-warn' : ''} />
          <Kpi label="Unmatched payments" value={b.unmatched_payments} tone={b.unmatched_payments ? 'text-warn' : ''} />
          <Kpi label="Total payments" value={n2(b.total_payments)} hint={b.currency ?? undefined} />
          <Kpi label="Total debit" value={n2(b.total_debit)} hint="invoices to be added" />
          <Kpi label="Total credit" value={n2(b.total_credit)} hint="credit notes, refunds, payments" />
        </div>
        <div className="grid grid-cols-3 gap-3"><Kpi label="Gross" value={n2(b.total_gross)} /><Kpi label="Service charges" value={n2(b.total_service)} /><Kpi label="Net to import" value={n2(b.total_net)} /></div>

        <div className="card">
          <div className="grid md:grid-cols-3 gap-x-4">
            <Field label="Billed to (payer)" hint={b.client ? 'Existing client' : b.payer_name ? 'Not an existing client — it will be created when you import' : 'Choose or type who this statement belongs to'}>
              <PayerPick b={b} disabled={!editable} onPick={(v) => settings(v)} />
            </Field>
            <Field label="Currency" hint={b.currency ? 'Kept on every record as written' : 'Not in the file — confirm it; it is never assumed'}>
              <div className="flex gap-1"><input className={`input uppercase w-24 ${!b.currency ? 'border-danger' : ''}`} maxLength={3} disabled={!editable} defaultValue={b.currency ?? ''} key={b.currency ?? 'none'} placeholder="PKR" onBlur={(e) => { const v = e.target.value.trim().toUpperCase(); if (v.length === 3 && v !== b.currency) settings({ currency: v }); }} />
                {editable && !b.currency && ['PKR', b.suggest_currency, 'USD'].filter((x, i, a) => x && a.indexOf(x) === i).map((c) => <button key={c} className="btn-ghost !px-2" onClick={() => settings({ currency: c })}>{c}</button>)}</div>
            </Field>
            <Field label="Dates" hint="Day-first (13/08/2026 = 13 August). Original invoice and payment dates are kept; the upload date is never used."><div className="text-sm h-9 flex items-center">Read as written in the file</div></Field>
          </div>
        </div>

        <Sheets b={b} tables={tables} editable={editable} onToggle={(name, v) => settings({ include: { [name]: v } })} />
        <button className="text-sm flex items-center gap-1 text-accent" onClick={() => setMap(!map)}>{map ? <ChevronDown size={15} /> : <ChevronRight size={15} />}Detected columns & mapping</button>
        {map && <Mapping b={b} editable={editable} reload={load} onError={setErr} />}
        <Rows b={b} editable={editable} canWrite={canWrite} reload={load} />

        {editable && (
          <div className="card flex flex-wrap items-center gap-3 sticky bottom-3 shadow-lg">
            <div className="text-sm min-w-0 flex-1">{b.valid_rows ? <>Ready to import <b>{b.valid_rows}</b> record{b.valid_rows === 1 ? '' : 's'}{b.error_rows ? <>, leaving out <b className="text-danger">{b.error_rows}</b> with errors</> : ''}{b.duplicate_rows ? <> and <b>{b.duplicate_rows}</b> duplicate(s) per your choice</> : ''}.</> : 'Nothing valid to import yet.'}</div>
            <button className="btn-ghost" disabled={busy} onClick={() => act(async () => { await api(`/ext-import/batches/${id}/cancel`, 'POST'); back(); })}>Cancel import</button>
            {canWrite ? <button className="btn" disabled={busy || !b.valid_rows && !b.duplicate_rows} onClick={() => setConfirm(true)}>Confirm & import</button> : <span className="text-xs text-muted">An admin or finance manager confirms the import.</span>}
          </div>)}
        {b.events?.length > 0 && <Audit events={b.events} />}
      </>}

      {confirm && <Modal title="Confirm import" onClose={() => setConfirm(false)}>
        <p className="text-sm">This will save <b>{b.valid_rows}</b> record{b.valid_rows === 1 ? '' : 's'} totalling <b className="num">{n2(b.total_net)} {b.currency}</b>{b.client ? <> against <b>{b.client.name}</b></> : <> and create the client <b>{b.payer_name}</b></>}. Each sale becomes an issued invoice under that client, with its ledger entry (receivable / revenue); credit notes and refunds post as credits. Nothing existing is deleted or overwritten, and the import can be rolled back (invoices are reversed, not deleted). If the currency differs from your base currency, an exchange rate must exist for the invoice dates.</p>
        {b.control?.sheets?.some((s: any) => s.ok === false) && <p className="text-sm text-warn mt-2">Note: {b.control.sheets.filter((s: any) => s.ok === false).length} sheet total(s) in the file do not equal the sum of their lines. Review “Source totals check” if you haven't.</p>}
        <div className="flex justify-end gap-2 mt-4"><button className="btn-ghost" onClick={() => setConfirm(false)}>Not yet</button>
          <button className="btn" disabled={busy} onClick={async () => { const r = await act(() => api(`/ext-import/batches/${id}/commit`, 'POST', {})); setConfirm(false); if (r) setDone(r); }}>{busy ? 'Importing…' : 'Import now'}</button></div>
      </Modal>}
      {roll && <RollbackDialog id={id} onClose={() => setRoll(false)} onDone={() => { setRoll(false); load(); }} />}
    </div>
  );
}

function PayerPick({ b, disabled, onPick }: { b: any; disabled: boolean; onPick(v: any): void }) {
  const clients = useList('/clients'); const [txt, setTxt] = useState(b.payer_name ?? '');
  useEffect(() => setTxt(b.payer_name ?? ''), [b.payer_name]);
  return (
    <div className="flex gap-1">
      <select className="input" disabled={disabled} value={b.payer_client_id ?? ''} onChange={(e) => onPick(e.target.value ? { payer_client_id: Number(e.target.value) } : { payer_name: txt || null })}>
        <option value="">{b.payer_name ? `New client: ${b.payer_name}` : 'Choose client…'}</option>{b.client && !clients.some((c: any) => c.id === b.client.id) && <option value={b.client.id}>{b.client.name}</option>}{clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      {!b.payer_client_id && !disabled && <input className="input" placeholder="or type a new name" value={txt} onChange={(e) => setTxt(e.target.value)} onBlur={() => txt.trim() && txt !== b.payer_name && onPick({ payer_name: txt.trim() })} />}
    </div>
  );
}

function Sheets({ b, tables, editable, onToggle }: { b: any; tables: any[]; editable: boolean; onToggle(n: string, v: boolean): void }) {
  const [open, setOpen] = useState(false); const rec: any[] = b.control?.sheets ?? []; const bad = rec.filter((s) => s.ok === false);
  const skipped = (b.sheets ?? []).filter((s: any) => s.kind !== 'table');
  return (
    <div className="card">
      <button className="w-full flex items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<span className="font-medium">Source totals check</span>
        {bad.length ? <Chip tone="bg-warn/15 text-warn"><AlertTriangle size={11} className="mr-1" />{bad.length} sheet{bad.length === 1 ? '' : 's'} differ from the file's own totals</Chip> : rec.some((s) => s.ok === true) ? <Chip tone="bg-success/15 text-success"><CheckCircle2 size={11} className="mr-1" />All sheet totals agree with the lines</Chip> : <Chip>No totals printed in the file to compare with</Chip>}
        <span className="text-xs text-muted ml-auto">{tables.length} sheet{tables.length === 1 ? '' : 's'}{skipped.length ? ` · ${skipped.length} not imported` : ''}</span>
      </button>
      {open && <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted"><th className="py-1 pr-2">Use</th><th>Sheet</th><th className="text-right">Lines</th><th className="text-right">Gross (our sum)</th><th className="text-right">Gross (file total)</th><th className="text-right">Net (our sum)</th><th className="text-right">Net (file total)</th><th /></tr></thead>
          <tbody>{tables.map((s) => { const r = rec.find((x) => x.sheet === s.name);
            return <tr key={s.name} className="border-t border-line"><td className="py-1.5 pr-2"><input type="checkbox" disabled={!editable} checked={s.include} onChange={(e) => onToggle(s.name, e.target.checked)} aria-label={`Include ${s.name}`} /></td>
              <td className="pr-2 truncate max-w-[16rem]">{s.name}</td><td className="text-right num">{r?.rows ?? s.rowCount}</td><td className="text-right num">{n2(r?.gross)}</td><td className="text-right num text-muted">{n2(r?.file_gross)}</td><td className="text-right num">{n2(r?.net)}</td><td className="text-right num text-muted">{n2(r?.file_net)}</td>
              <td className="pl-2">{r?.ok === true && <CheckCircle2 size={15} className="text-success" />}{r?.ok === false && <span className="text-warn text-xs whitespace-nowrap" title="The total printed in the file is not the sum of its lines">differs by {n2(r.diff_gross ?? r.diff_net)}</span>}{r?.ok == null && <span className="text-xs text-muted">no total in file</span>}</td></tr>; })}</tbody></table>
        {skipped.map((s: any) => <div key={s.name} className="text-xs text-muted mt-1">Not imported: <b>{s.name}</b> — {s.kind === 'reference' ? 'looks like an index/summary/log sheet' : s.reason}</div>)}
        {b.control?.index?.length > 0 && <div className="mt-3 text-xs"><div className="font-medium mb-1">Control figures in the file</div>{b.control.index.map((c: any, i: number) => <div key={i}>{c.label}: <span className="num">{n2(c.value)}</span> {c.matches ? <span className="text-success">— agrees with “{c.matches}”</span> : <span className="text-muted">— no sheet matches</span>}</div>)}</div>}
      </div>}
    </div>
  );
}

function Mapping({ b, editable, reload, onError }: { b: any; editable: boolean; reload(): void; onError(s: string): void }) {
  const [fields, setFields] = useState<Record<string, string>>({}); const groups = useMemo(() => { const m = new Map<string, any>(); for (const s of b.sheets ?? []) if (s.kind === 'table') { const g = m.get(s.sig) ?? { ...s, names: [] }; g.names.push(s.name); m.set(s.sig, g); } return [...m.values()]; }, [b.sheets]);
  const [edit, setEdit] = useState<Record<string, Record<string, number | null>>>({}); const [tplName, setTplName] = useState('');
  useEffect(() => { api('/ext-import/fields').then(setFields).catch(() => {}); }, []);
  const colField = (g: any, col: number) => Object.entries(edit[g.sig] ?? g.map).find(([, c]) => c === col)?.[0] ?? '';
  const set = (g: any, col: number, field: string) => { const cur = { ...(edit[g.sig] ?? g.map) } as Record<string, number | null>; for (const k of Object.keys(cur)) if (cur[k] === col) delete cur[k]; if (field) { delete cur[field]; cur[field] = col; } setEdit({ ...edit, [g.sig]: cur }); };
  const save = async (g: any) => { try { await api(`/ext-import/batches/${b.id}/mapping`, 'PUT', { sig: g.sig, map: edit[g.sig] }); setEdit((e) => { const n = { ...e }; delete n[g.sig]; return n; }); reload(); } catch (e: any) { onError(e.message); } };
  const tpl = async (g: any) => { try { await api('/ext-import/templates', 'POST', { name: tplName.trim(), batch_id: b.id, sig: g.sig }); setTplName(''); onError(''); } catch (e: any) { onError(e.message); } };
  const required = ['invoice_date', 'passenger', 'net'];
  return (
    <div className="space-y-3">
      {groups.map((g) => { const cur = edit[g.sig] ?? g.map; const missing = required.filter((f) => cur[f] === undefined && !(f === 'net' && cur.gross !== undefined) && !(f === 'invoice_date' && (cur.payment_date !== undefined || cur.txn_date !== undefined)) && !(f === 'passenger' && (cur.invoice_no !== undefined || cur.pnr !== undefined)));
        return <div key={g.sig} className="card">
          <div className="flex flex-wrap items-center gap-2 mb-2"><div className="font-medium">Layout used by {g.names.length} sheet{g.names.length === 1 ? '' : 's'}</div><span className="text-xs text-muted truncate max-w-md">{g.names.slice(0, 3).join(', ')}{g.names.length > 3 ? '…' : ''}</span>
            {missing.length > 0 && <Chip tone="bg-warn/15 text-warn">not mapped: {missing.map((f) => fields[f] ?? f).join(', ')}</Chip>}</div>
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted"><th className="py-1 pr-3">Column in the file</th><th className="pr-3">Example</th><th>Meaning in the app</th></tr></thead><tbody>
            {g.headers.map((h: string, i: number) => h && <tr key={i} className="border-t border-line"><td className="py-1 pr-3 font-medium">{h}</td><td className="pr-3 text-muted truncate max-w-[10rem]">{g.sample?.[i] ?? ''}</td>
              <td><select className="input !h-8" disabled={!editable} value={colField(g, i)} onChange={(e) => set(g, i, e.target.value)}><option value="">— not used —</option>{Object.entries(fields).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td></tr>)}</tbody></table></div>
          {editable && <div className="flex flex-wrap gap-2 mt-3 items-center">
            <button className="btn" disabled={!edit[g.sig]} onClick={() => save(g)}>Apply mapping</button>
            <input className="input w-48" placeholder="Template name" value={tplName} onChange={(e) => setTplName(e.target.value)} /><button className="btn-ghost" disabled={tplName.trim().length < 2} onClick={() => tpl(g)}>Save as template</button>
            <span className="text-xs text-muted">Applying re-checks every line. Hand-edited lines keep their edits.</span></div>}
        </div>; })}
    </div>
  );
}

const PILLS = [['', 'All lines'], ['issues', 'Needs attention'], ['error', 'Errors'], ['duplicate', 'Duplicates'], ['payments', 'Payments'], ['imported', 'Imported'], ['skipped', 'Ignored']] as const;
function Rows({ b, editable, canWrite, reload }: { b: any; editable: boolean; canWrite: boolean; reload(): void }) {
  const [f, setF] = useState(''), [q, setQ] = useState(''), [sheet, setSheet] = useState(''), [page, setPage] = useState(0), [size, setSize] = useState(50), [d, setD] = useState<any>(null), [sel, setSel] = useState<any>(null);
  const load = useCallback(async () => { const p = new URLSearchParams({ page: String(page + 1), size: String(size) }); if (f) p.set('status', f); if (q) p.set('q', q); if (sheet) p.set('sheet', sheet); setD(await api(`/ext-import/batches/${b.id}/rows?${p}`)); }, [b.id, f, q, sheet, page, size]);
  useEffect(() => { load().catch(() => {}); }, [load, b.total_rows, b.error_rows, b.duplicate_rows, b.valid_rows, b.status, b.imported_rows]);
  useEffect(() => setPage(0), [f, q, sheet]);
  const tables = (b.sheets ?? []).filter((s: any) => s.kind === 'table' && s.include);
  const [dupBusy, setDupBusy] = useState(false);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h2 className="font-semibold mr-2">Preview</h2>
        {PILLS.map(([k, l]) => <button key={k} onClick={() => setF(k)} className={`text-sm px-2.5 py-1 rounded-lg border ${f === k ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>{l}</button>)}
        <div className="relative ml-auto w-full sm:w-60"><Search size={15} className="absolute left-2.5 top-2.5 text-muted" /><input className="input pl-8" placeholder="Passenger, PNR, invoice, ticket" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {tables.length > 1 && <select className="input w-auto" value={sheet} onChange={(e) => setSheet(e.target.value)}><option value="">All sheets</option>{tables.map((s: any) => <option key={s.name} value={s.name}>{s.name}</option>)}</select>}
      </div>
      {editable && b.duplicate_rows > 0 && <div className="flex flex-wrap items-center gap-2 mb-2 text-sm"><AlertTriangle size={15} className="text-warn" /> {b.duplicate_rows} duplicate line(s) are skipped unless you decide otherwise.
        <button className="btn-ghost !h-8" disabled={dupBusy} onClick={async () => { setDupBusy(true); try { await api(`/ext-import/batches/${b.id}/duplicates`, 'POST', { action: 'skip' }); reload(); load(); } finally { setDupBusy(false); } }}>Skip all duplicates</button></div>}
      {!d ? <Skeleton className="h-48" /> : (
        <div className="card !p-0 overflow-hidden">
          <div className="overflow-auto max-h-[60vh]"><table className="w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10"><tr>{['', 'Source', 'Date', 'Type', 'Invoice', 'Passenger', 'Route', 'PNR', 'Gross', 'Service', 'Net', 'Issues'].map((h, i) => <th key={i} className={`bg-surface2 ${i >= 8 && i <= 10 ? '!text-right' : ''}`}>{h}</th>)}</tr></thead>
            <tbody>{d.rows.map((r: any) => { const x = J(r.data), pr = J(r.problems) ?? [], mt = J(r.match_json);
              const tone = r.status === 'error' || r.status === 'failed' ? 'bg-danger/5' : r.status === 'duplicate' ? 'bg-warn/5' : r.status === 'imported' ? 'bg-success/5' : '';
              return <tr key={r.id} className={`cursor-pointer hover:bg-surface2/70 ${tone}`} onClick={() => setSel(r)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(r)}>
                <td className="pl-3">{r.status === 'error' || r.status === 'failed' ? <AlertTriangle size={15} className="text-danger" /> : r.status === 'duplicate' ? <Chip tone="bg-warn/15 text-warn">{r.dup_kind === 'changed' ? 'changed' : 'dup'}</Chip> : r.status === 'warning' ? <AlertTriangle size={15} className="text-warn" /> : r.status === 'imported' ? <CheckCircle2 size={15} className="text-success" /> : <CheckCircle2 size={15} className="text-muted/50" />}</td>
                <td className="text-xs text-muted whitespace-nowrap">{r.sheet.replace(/^KPMG /, '').slice(0, 14)} · {r.src_row}</td>
                <td className="num whitespace-nowrap">{x ? fmtDate(x.txn_date) : '—'}</td><td className="whitespace-nowrap">{x ? <span className={x.kind === 'sale' ? '' : 'text-accent'}>{KIND[x.kind] ?? x.kind}</span> : '—'}</td>
                <td className="num whitespace-nowrap">{x?.invoice_no ?? '—'}</td><td className="max-w-[14rem] truncate">{x?.passenger_name ?? (x?.payer_name ?? '—')}</td><td className="whitespace-nowrap">{x?.sector ?? '—'}</td><td className="num">{x?.pnr ?? '—'}</td>
                <td className="text-right num">{x ? n2(x.gross) : ''}</td><td className="text-right num">{x ? n2(x.service_charge) : ''}</td><td className="text-right num font-medium">{x ? n2(x.net) : ''}</td>
                <td className="text-xs max-w-[18rem]">{pr.slice(0, 2).map((p: any, i: number) => <div key={i} className={p.level === 'error' ? 'text-danger' : 'text-warn'}>{p.msg}</div>)}
                  {x?.kind === 'payment' && mt && <div className={mt.allocations.length ? 'text-success' : 'text-warn'}>{mt.allocations.length ? `→ ${mt.allocations.map((a: any) => `${a.invoice_no} ${n2(a.amount)} (${a.confidence}%)`).join(', ')}` : 'unmatched'}{mt.note ? ` · ${mt.note}` : ''}</div>}</td>
              </tr>; })}</tbody></table>
            {!d.rows.length && <div className="p-8 text-center text-sm text-muted">No lines match.</div>}</div>
          <Pager total={d.total} page={page} size={size} onPage={setPage} onSize={(n) => { setSize(n); setPage(0); }} noun="lines" />
        </div>)}
      {sel && <RowDialog b={b} row={sel} editable={editable} canWrite={canWrite} onClose={() => setSel(null)} onChanged={() => { setSel(null); reload(); load(); }} />}
    </div>
  );
}

const EDIT_FIELDS: [string, string, 'text' | 'date' | 'num'][] = [['invoice_no', 'Invoice no.', 'text'], ['invoice_date', 'Invoice date', 'date'], ['payment_date', 'Payment date', 'date'], ['passenger_name', 'Passenger', 'text'], ['pnr', 'PNR', 'text'], ['ticket_no', 'Ticket no.', 'text'], ['sector', 'Route', 'text'], ['airline', 'Airline', 'text'], ['travel_date', 'Travel date', 'date'], ['return_date', 'Return date', 'date'], ['gross', 'Gross', 'num'], ['service_charge', 'Service charge', 'num'], ['net', 'Net', 'num'], ['payment_ref', 'Payment reference', 'text'], ['remarks', 'Remarks', 'text']];
function RowDialog({ b, row, editable, canWrite, onClose, onChanged }: { b: any; row: any; editable: boolean; canWrite: boolean; onClose(): void; onChanged(): void }) {
  const x = J(row.data), pr = J(row.problems) ?? [], raw = J(row.raw)?.cells ?? [];
  const [v, setV] = useState<Record<string, any>>({}), [reason, setReason] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false), [auth, setAuth] = useState('');
  const run = async (f: () => Promise<any>) => { setBusy(true); setErr(''); try { await f(); onChanged(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const dirty = Object.keys(v).length > 0;
  return (
    <Modal title={`Line ${row.sheet} · row ${row.src_row}`} onClose={onClose} wide>
      <Err e={err} />
      {pr.length > 0 && <ul className="mb-3 text-sm space-y-0.5">{pr.map((p: any, i: number) => <li key={i} className={p.level === 'error' ? 'text-danger' : 'text-warn'}>• {p.msg}</li>)}</ul>}
      {row.status === 'duplicate' && <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 mb-3 text-sm">
        <div className="font-medium mb-1">{row.dup_kind === 'exact' ? 'Already imported earlier' : row.dup_kind === 'in_file' ? 'Appears twice in this file' : 'Same document line already imported, but the amount or date differs'}</div>
        <div className="flex flex-wrap gap-2 items-center">
          <button className={row.action === 'skip' ? 'btn' : 'btn-ghost'} disabled={!editable || busy} onClick={() => run(() => api(`/ext-import/batches/${b.id}/rows/${row.id}/action`, 'POST', { action: 'skip' }))}>Skip duplicate</button>
          {canWrite && editable && <>
            {row.dup_kind !== 'in_file' && <button className={row.action === 'update' ? 'btn' : 'btn-ghost'} disabled={busy || auth.trim().length < 3} onClick={() => run(() => api(`/ext-import/batches/${b.id}/rows/${row.id}/action`, 'POST', { action: 'update', reason: auth }))}>Update existing record</button>}
            <button className={row.action === 'separate' ? 'btn' : 'btn-ghost'} disabled={busy || auth.trim().length < 3} onClick={() => run(() => api(`/ext-import/batches/${b.id}/rows/${row.id}/action`, 'POST', { action: 'separate', reason: auth }))}>Import as separate transaction</button>
            <input className="input w-64" placeholder="Reason (needed to update / import separately)" value={auth} onChange={(e) => setAuth(e.target.value)} /></>}
        </div>
        {!canWrite && <div className="text-xs text-muted mt-1">Updating an existing record or importing a duplicate separately needs an admin or finance manager.</div>}
        <div className="text-xs mt-1">Current choice: <b>{row.action === 'skip' ? 'skip' : row.action === 'update' ? 'update the existing record (the old one is kept, marked replaced)' : 'import as a separate transaction'}</b></div></div>}
      {x ? <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-x-4">
        {EDIT_FIELDS.map(([k, l, ty]) => <Field key={k} label={l}><input className="input" type={ty === 'date' ? 'date' : 'text'} inputMode={ty === 'num' ? 'decimal' : undefined} disabled={!editable || row.status === 'imported'} value={v[k] ?? x[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>)}
      </div> : <p className="text-sm text-muted mb-3">This line was ignored (nothing to import).</p>}
      {editable && x && dirty && <div className="flex flex-wrap gap-2 items-end"><div className="flex-1 min-w-48"><Field label="Why are you changing it? (recorded in the audit trail)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. date taken from the invoice copy" /></Field></div>
        <button className="btn mb-3" disabled={busy || reason.trim().length < 3} onClick={() => run(() => api(`/ext-import/batches/${b.id}/rows/${row.id}`, 'PATCH', { data: v, reason }))}>Save correction</button></div>}
      <details className="mt-2"><summary className="text-sm cursor-pointer text-muted">Original line in the file</summary><div className="mt-1 text-xs font-mono break-words bg-surface2 rounded-lg p-2">{raw.map((c: any) => (c === null ? '·' : String(c))).join('  |  ')}</div></details>
    </Modal>
  );
}

function RollbackDialog({ id, onClose, onDone }: { id: number; onClose(): void; onDone(): void }) {
  const [reason, setReason] = useState(''), [err, setErr] = useState(''), [res, setRes] = useState<any>(null), [busy, setBusy] = useState(false);
  return <Modal title="Roll back this import" onClose={onClose}>
    {!res ? <>
      <p className="text-sm">The records from this file are marked <b>rolled back</b> and drop out of every report. Nothing is deleted. Records that payments have since been applied to, or that a later import replaced, are kept and listed.</p>
      <Err e={err} /><Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong client selected" /></Field>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Keep import</button><button className="btn" disabled={busy || reason.trim().length < 3} onClick={async () => { setBusy(true); try { setRes(await api(`/ext-import/batches/${id}/rollback`, 'POST', { reason })); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } }}>Roll back</button></div></>
      : <><p className="text-sm"><b>{res.rolled_back}</b> record(s) rolled back.</p>{res.kept.length > 0 && <div className="text-sm mt-2 text-warn"><b>{res.kept.length}</b> kept because: {[...new Set(res.kept.map((k: any) => k.why))].join('; ')}.</div>}<div className="flex justify-end mt-4"><button className="btn" onClick={onDone}>Done</button></div></>}
  </Modal>;
}

const Audit = ({ events }: { events: any[] }) => (
  <details className="card"><summary className="cursor-pointer font-medium">Audit trail <span className="text-muted font-normal text-sm">({events.length})</span></summary>
    <ul className="mt-2 text-sm divide-y divide-line">{events.map((e) => <li key={e.id} className="py-1.5 flex gap-3"><span className="text-xs text-muted w-36 shrink-0">{fmtTime(e.created_at)}</span><span className="min-w-0"><b className="capitalize">{e.action.replace(/_/g, ' ')}</b> — {e.detail} <span className="text-muted">· {e.user_name ?? 'system'}</span></span></li>)}</ul></details>
);

/* ───────────────────────────── history ───────────────────────────── */

function HistoryTab({ canWrite, openBatch }: { canWrite: boolean; openBatch(id: number): void }) {
  const [rows, setRows] = useState<any[] | null>(null), [err, setErr] = useState(''), [sel, setSel] = useState<any>(null), [roll, setRoll] = useState<number | null>(null);
  const load = () => api('/ext-import/batches').then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  return <>
    <Err e={err} />
    {!rows ? <Skeleton className="h-48" /> : <Table rows={rows} noun="imports" empty="No imports yet." onRow={setSel} cols={[
      { h: 'File', render: (r: any) => <span className="font-medium">{r.file_name}</span> }, { h: 'Uploaded', render: (r: any) => <span className="whitespace-nowrap text-sm">{fmtTime(r.uploaded_at)}<div className="text-xs text-muted">{r.uploaded_by_name ?? ''}</div></span> },
      { h: 'Format', render: (r: any) => r.file_format.toUpperCase() }, { h: 'Records', right: true, render: (r: any) => r.total_rows }, { h: 'Imported', right: true, render: (r: any) => r.imported_rows },
      { h: 'Failed', right: true, render: (r: any) => r.failed_rows || r.error_rows || '—' }, { h: 'Duplicates', right: true, render: (r: any) => r.duplicate_rows }, { h: 'Amount', right: true, render: (r: any) => r.imported_amount ? `${n2(r.imported_amount)} ${r.currency ?? ''}` : '—' },
      { h: 'Status', render: (r: any) => <StatusChip s={r.status} /> }]} />}
    {sel && <Modal title={sel.file_name} onClose={() => setSel(null)} wide>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3"><Kpi label="Records" value={sel.total_rows} /><Kpi label="Imported" value={sel.imported_rows} tone="text-success" /><Kpi label="Failed / errors" value={sel.failed_rows || sel.error_rows} /><Kpi label="Duplicates" value={sel.duplicate_rows} /></div>
      <div className="flex flex-wrap gap-2 mb-3"><StatusChip s={sel.status} />{sel.payer_name && <Chip>Payer: {sel.payer_name}</Chip>}{sel.rollback_reason && <Chip tone="bg-warn/15 text-warn">Rolled back: {sel.rollback_reason}</Chip>}</div>
      <div className="flex flex-wrap gap-2"><button className="btn" onClick={() => { openBatch(sel.id); }}>Open details</button>
        <button className="btn-ghost" onClick={() => download(`/ext-import/batches/${sel.id}/errors.csv`, `import-${sel.id}-problems.csv`).catch((e) => setErr(e.message))}><Download size={15} />Error report</button>
        {sel.status === 'imported' && canWrite && <button className="btn-ghost" onClick={() => { setRoll(sel.id); setSel(null); }}><RotateCcw size={15} />Roll back</button>}</div>
    </Modal>}
    {roll && <RollbackDialog id={roll} onClose={() => setRoll(null)} onDone={() => { setRoll(null); load(); }} />}
  </>;
}

/* ───────────────────────────── reports ───────────────────────────── */

interface Flt { from: string; to: string; client_id: string; passenger: string; location: string; status: string; kind: string; q: string }
const EMPTY: Flt = { from: '', to: '', client_id: '', passenger: '', location: '', status: '', kind: '', q: '' };
const qs = (f: Flt, extra: Record<string, string> = {}) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v); return p.toString(); };

function FilterBar({ f, set, show }: { f: Flt; set(f: Flt): void; show: (keyof Flt)[] }) {
  const clients = useList('/clients'); const u = (k: keyof Flt) => (e: any) => set({ ...f, [k]: e.target.value });
  return (
    <div className="card !p-3 mb-4 flex flex-wrap items-end gap-3">
      {show.includes('from') && <><div><div className="text-xs text-muted mb-1">From</div><input className="input num w-40" type="date" value={f.from} onChange={u('from')} /></div><div><div className="text-xs text-muted mb-1">To</div><input className="input num w-40" type="date" value={f.to} onChange={u('to')} /></div></>}
      {show.includes('client_id') && <div><div className="text-xs text-muted mb-1">Payer</div><select className="input w-48" value={f.client_id} onChange={u('client_id')}><option value="">All payers</option>{clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
      {show.includes('passenger') && <div><div className="text-xs text-muted mb-1">Passenger</div><input className="input w-44" value={f.passenger} onChange={u('passenger')} placeholder="Name contains…" /></div>}
      {show.includes('location') && <div><div className="text-xs text-muted mb-1">Location</div><input className="input w-36" value={f.location} onChange={u('location')} placeholder="e.g. KHI or BKK" /></div>}
      {show.includes('status') && <div><div className="text-xs text-muted mb-1">Payment status</div><select className="input w-36" value={f.status} onChange={u('status')}><option value="">Any</option><option value="unpaid">Unpaid</option><option value="partial">Partly paid</option><option value="paid">Paid</option><option value="credit">Credit</option></select></div>}
      {show.includes('kind') && <div><div className="text-xs text-muted mb-1">Type</div><select className="input w-40" value={f.kind} onChange={u('kind')}><option value="">All types</option>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>}
      {show.includes('q') && <div className="flex-1 min-w-48"><div className="text-xs text-muted mb-1">Search</div><div className="relative"><Search size={15} className="absolute left-2.5 top-2.5 text-muted" /><input className="input pl-8" value={f.q} onChange={u('q')} placeholder="Passenger, PNR, ticket, invoice" /></div></div>}
      <button className="btn-ghost" onClick={() => set(EMPTY)}><X size={14} />Clear</button>
    </div>
  );
}
function useReport<T = any>(path: string, f: Flt, extra: Record<string, string> = {}) {
  const [d, setD] = useState<T | null>(null), [err, setErr] = useState(''); const key = `${path}?${qs(f, extra)}`;
  useEffect(() => { let off = false; const t = setTimeout(() => { api<T>(`/ext-import/${key}`).then((r) => { if (!off) { setD(r); setErr(''); } }).catch((e) => !off && setErr(e.message)); }, 200); return () => { off = true; clearTimeout(t); }; }, [key]);
  return { d, err };
}
const cur = (a: string[] | undefined) => (a?.length === 1 ? a[0] : a && a.length > 1 ? 'mixed currencies' : '');

function TransactionsTab() {
  const [sp] = useSearchParams(); const [f, setF] = useState<Flt>({ ...EMPTY, client_id: sp.get('client') ?? '' }); const [view, setView] = useState('monthly'), [page, setPage] = useState(0), [size, setSize] = useState(50), [err2, setErr2] = useState('');
  const per = useReport<any>('report/period', f, { view }); const tx = useReport<any>('report/transactions', f, { page: String(page + 1), size: String(size) });
  useEffect(() => setPage(0), [f]);
  return <>
    <div className="flex flex-wrap gap-1 mb-3">{[['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly'], ['range', 'Custom range']].map(([k, l]) => <button key={k} onClick={() => setView(k)} className={`text-sm px-3 py-1.5 rounded-lg border ${view === k ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>{l}</button>)}
      <button className="btn-ghost ml-auto" onClick={() => download(`/ext-import/report/export.csv?${qs(f)}`, 'external-import-transactions.csv').catch((e) => setErr2(e.message))}><Download size={15} />Export CSV</button></div>
    <FilterBar f={f} set={setF} show={['from', 'client_id', 'passenger', 'location', 'status', 'kind', 'q']} /><Err e={per.err || tx.err || err2} />
    {view === 'range' && !f.from && !f.to && <p className="text-xs text-muted mb-2">Pick a From / To date above to see one range.</p>}
    {!per.d ? <Skeleton className="h-40" /> : <>
      <div className="text-xs text-muted mb-1">Amounts in {cur(per.d.currencies) || '—'} · grouped by the original invoice / payment date</div>
      <Table rows={per.d.rows.map((r: any) => ({ ...r, id: undefined }))} paginate={per.d.rows.length > 25} empty="No imported transactions in this range." cols={[
        { h: 'Period', render: (r: any) => <span className="font-medium num">{r.period}</span> }, { h: 'Lines', right: true, render: (r: any) => r.count }, { h: 'Gross', right: true, render: (r: any) => n2(r.gross) }, { h: 'Service', right: true, render: (r: any) => n2(r.service) },
        { h: 'Invoiced', right: true, render: (r: any) => n2(r.invoiced) }, { h: 'Credits', right: true, render: (r: any) => n2(r.credits) }, { h: 'Payments', right: true, render: (r: any) => n2(r.payments) }, { h: 'Outstanding', right: true, render: (r: any) => n2(r.outstanding) }]} />
      <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm mt-2 mb-6 num"><span>Lines <b>{per.d.total.count}</b></span><span>Invoiced <b>{n2(per.d.total.invoiced)}</b></span><span>Credits <b>{n2(per.d.total.credits)}</b></span><span>Payments <b>{n2(per.d.total.payments)}</b></span><span>Outstanding <b>{n2(per.d.total.outstanding)}</b></span></div></>}
    <h3 className="font-semibold mb-2">Transactions</h3>
    {!tx.d ? <Skeleton className="h-40" /> : <div className="card !p-0 overflow-hidden"><div className="overflow-auto max-h-[60vh]"><table className="w-full border-separate border-spacing-0 text-sm">
      <thead className="sticky top-0 z-10"><tr>{['Date', 'Type', 'Invoice', 'Passenger', 'Route', 'PNR', 'Travel', 'Payer', 'Net', 'Received', 'Outstanding', 'State'].map((h, i) => <th key={h} className={`bg-surface2 ${i >= 8 && i <= 10 ? '!text-right' : ''}`}>{h}</th>)}</tr></thead>
      <tbody>{tx.d.rows.map((l: any) => <tr key={l.id}><td className="num whitespace-nowrap">{fmtDate(l.txn_date)}</td><td className="whitespace-nowrap">{KIND[l.kind]}</td><td className="num whitespace-nowrap">{l.invoice_no ?? l.payment_ref ?? '—'}</td><td className="max-w-[13rem] truncate">{l.passenger_name ?? '—'}</td><td className="whitespace-nowrap">{l.sector ?? '—'}</td><td className="num">{l.pnr ?? '—'}</td><td className="num whitespace-nowrap">{fmtDate(l.travel_date)}</td><td className="max-w-[10rem] truncate">{l.payer_name ?? '—'}</td>
        <td className="text-right num">{n2(l.net)}</td><td className="text-right num">{l.kind === 'payment' ? '' : n2(l.received)}</td><td className="text-right num">{l.kind === 'payment' ? '' : n2(l.outstanding)}</td><td><Chip tone={STATE_TONE[l.pay_state]}>{l.pay_state}</Chip></td></tr>)}</tbody></table>
      {!tx.d.rows.length && <div className="p-8 text-center text-sm text-muted">No transactions.</div>}</div>
      <Pager total={tx.d.total} page={page} size={size} onPage={setPage} onSize={(n) => { setSize(n); setPage(0); }} noun="transactions" /></div>}
  </>;
}

function PassengersTab() {
  const [f, setF] = useState<Flt>(EMPTY); const { d, err } = useReport<any[]>('report/passengers', f); const [sel, setSel] = useState<string | null>(null);
  return <>
    <FilterBar f={f} set={setF} show={['from', 'client_id', 'passenger', 'location', 'status']} /><Err e={err} />
    {!d ? <Skeleton className="h-48" /> : <Table rows={d.map((r: any) => ({ ...r, id: undefined }))} noun="passengers" empty="No passengers imported yet." onRow={(r: any) => setSel(r.key)} cols={[
      { h: 'Passenger', render: (r: any) => <span className="font-medium">{r.name}</span> }, { h: 'Trips', right: true, render: (r: any) => r.trips }, { h: 'PNRs', right: true, render: (r: any) => r.pnrs }, { h: 'Invoices', right: true, render: (r: any) => r.invoices },
      { h: 'Travel', render: (r: any) => <span className="num whitespace-nowrap text-sm">{fmtDate(r.first_travel)}{r.last_travel && r.last_travel !== r.first_travel ? ` → ${fmtDate(r.last_travel)}` : ''}</span> },
      { h: 'Billed', right: true, render: (r: any) => n2(r.billed) }, { h: 'Received', right: true, render: (r: any) => n2(r.received) }, { h: 'Outstanding', right: true, render: (r: any) => <span className={r.outstanding > 0.5 ? 'text-danger' : ''}>{n2(r.outstanding)}</span> }]} />}
    {sel && <PassengerDialog k={sel} onClose={() => setSel(null)} />}
  </>;
}
function PassengerDialog({ k, onClose }: { k: string; onClose(): void }) {
  const [d, setD] = useState<any>(null), [err, setErr] = useState('');
  useEffect(() => { api(`/ext-import/report/passengers/detail?key=${encodeURIComponent(k)}`).then(setD).catch((e) => setErr(e.message)); }, [k]);
  return <Modal title={d?.name ?? 'Passenger'} onClose={onClose} wide><Err e={err} />{!d ? !err && <Skeleton className="h-40" /> : <>
    <div className="grid grid-cols-3 gap-3 mb-3"><Kpi label="Billed" value={n2(d.billed)} hint={d.currency} /><Kpi label="Payments received" value={n2(d.received)} tone="text-success" /><Kpi label="Outstanding" value={n2(d.outstanding)} tone={d.outstanding > 0.5 ? 'text-danger' : ''} /></div>
    <div className="text-xs text-muted mb-1">Payer: {d.payer ?? '—'}</div>
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted"><th className="py-1">Invoice</th><th>Invoice date</th><th>Route</th><th>PNR</th><th>Ticket</th><th>Travel</th><th>Booked</th><th className="text-right">Amount</th><th className="text-right">Outstanding</th></tr></thead>
      <tbody>{d.lines.map((l: any) => <tr key={l.id} className="border-t border-line"><td className="py-1 num">{l.invoice_no ?? '—'}<div className="text-[11px] text-muted">{KIND[l.kind]}</div></td><td className="num">{fmtDate(l.invoice_date)}</td><td>{l.sector ?? '—'}</td><td className="num">{l.pnr ?? '—'}</td><td className="num">{l.ticket_no ?? '—'}</td><td className="num">{fmtDate(l.travel_date)}</td><td className="num">{fmtDate(l.booking_date)}</td><td className="text-right num">{n2(l.net)}</td><td className="text-right num">{n2(l.outstanding)}</td></tr>)}</tbody></table></div>
    <h4 className="font-medium mt-4 mb-1">Payment history</h4>
    {!d.payments.length ? <p className="text-sm text-muted">No payments applied to this passenger's invoices yet.</p> : <table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted"><th>Date</th><th>Reference</th><th>Invoice</th><th className="text-right">Applied</th><th>How matched</th><th>Status</th></tr></thead><tbody>{d.payments.map((p: any) => <tr key={p.id} className="border-t border-line"><td className="num py-1">{fmtDate(p.txn_date)}</td><td>{p.payment_ref ?? '—'}</td><td className="num">{p.invoice_no}</td><td className="text-right num">{n2(p.amount)}</td><td>{p.method.replace(/_/g, ' ')} ({p.confidence}%)</td><td>{p.status}</td></tr>)}</tbody></table>}
  </>}</Modal>;
}

function LocationsTab() {
  const [f, setF] = useState<Flt>(EMPTY), [by, setBy] = useState('route'); const { d, err } = useReport<any[]>('report/locations', f, { by });
  return <>
    <div className="flex gap-1 mb-3">{[['route', 'By route'], ['origin', 'By departure'], ['destination', 'By arrival']].map(([k, l]) => <button key={k} onClick={() => setBy(k)} className={`text-sm px-3 py-1.5 rounded-lg border ${by === k ? 'border-accent bg-accent/15 text-accent font-medium' : 'border-line hover:bg-surface2'}`}>{l}</button>)}</div>
    <FilterBar f={f} set={setF} show={['from', 'client_id', 'passenger', 'status']} /><Err e={err} />
    {!d ? <Skeleton className="h-48" /> : <Table rows={d.map((r: any) => ({ ...r, id: undefined }))} noun="locations" empty="No travel data imported yet." cols={[
      { h: by === 'route' ? 'Route' : by === 'origin' ? 'Departure' : 'Arrival', render: (r: any) => <span className="font-medium">{r.location}</span> }, { h: 'Transactions', right: true, render: (r: any) => r.count }, { h: 'Total amount', right: true, render: (r: any) => n2(r.amount) },
      { h: 'Payments received', right: true, render: (r: any) => n2(r.received) }, { h: 'Outstanding', right: true, render: (r: any) => n2(r.outstanding) }]} />}
  </>;
}

function PayersTab({ openTx }: { openTx(clientId: number): void }) {
  const [f, setF] = useState<Flt>(EMPTY); const { d, err } = useReport<any[]>('report/payers', f);
  return <>
    <FilterBar f={f} set={setF} show={['from', 'client_id', 'passenger', 'location', 'status']} /><Err e={err} />
    {!d ? <Skeleton className="h-48" /> : <Table rows={d.map((r: any) => ({ ...r, id: undefined }))} noun="payers" empty="No payers yet." onRow={(r: any) => r.client_id && openTx(r.client_id)} cols={[
      { h: 'Payer', render: (r: any) => <span className="font-medium">{r.payer}</span> }, { h: 'Invoices', right: true, render: (r: any) => r.invoices }, { h: 'Billed', right: true, render: (r: any) => n2(r.billed) }, { h: 'Payments received', right: true, render: (r: any) => n2(r.received) },
      { h: 'Outstanding', right: true, render: (r: any) => <span className={r.outstanding > 0.5 ? 'text-danger font-medium' : ''}>{n2(r.outstanding)}</span> }, { h: 'Unapplied payments', right: true, render: (r: any) => (r.unapplied > 0.004 ? <span className="text-warn">{n2(r.unapplied)}</span> : '—') }, { h: 'Last payment', render: (r: any) => <span className="num">{fmtDate(r.last_payment)}</span> }]} />}
    <p className="text-xs text-muted mt-2">Select a payer to see their full transaction history.</p>
  </>;
}

/* ───────────────────────────── reconciliation ───────────────────────────── */

function ReconcileTab({ canWrite }: { canWrite: boolean }) {
  const [d, setD] = useState<any>(null), [err, setErr] = useState(''), [alloc, setAlloc] = useState<any>(null);
  const load = () => api('/ext-import/reconciliation').then(setD).catch((e) => setErr(e.message)); useEffect(() => { load(); }, []);
  const decide = async (id: number, what: 'confirm' | 'reject') => { try { setErr(''); await api(`/ext-import/allocations/${id}/${what}`, 'POST'); load(); } catch (e: any) { setErr(e.message); } };
  return <>
    <p className="text-sm text-muted mb-3">An invoice only counts as paid when a payment is matched to it with confidence of 90% or more, or when a person confirms the match here. Everything below is waiting for that.</p><Err e={err} />
    {!d ? <Skeleton className="h-48" /> : !d.payments.length ? <div className="card text-sm text-muted">Every imported payment is fully applied.</div> : <div className="space-y-3">{d.payments.map((p: any) => (
      <div key={p.id} className="card !p-3">
        <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><div className="font-medium">{n2(p.net)} {p.currency} <span className="text-muted font-normal text-sm">· {fmtDate(p.txn_date)} · {p.payment_ref ?? 'no reference'} · {p.payer_name ?? ''}</span></div>
          <div className="text-xs text-muted">{n2(p.unapplied)} not applied yet · from {p.source_file}</div></div>
          {canWrite && <button className="btn-ghost" onClick={() => setAlloc(p)}>Apply to an invoice</button>}</div>
        {p.suggestions.map((s: any) => <div key={s.id} className="mt-2 flex flex-wrap items-center gap-2 text-sm rounded-lg bg-warn/10 px-3 py-1.5"><span>Suggested: <b className="num">{s.invoice_no}</b> · {n2(s.amount)} · {s.method.replace(/_/g, ' ')} · {s.confidence}% sure</span>
          {canWrite && <span className="ml-auto flex gap-2"><button className="btn !h-8" onClick={() => decide(s.id, 'confirm')}>Confirm</button><button className="btn-ghost !h-8" onClick={() => decide(s.id, 'reject')}>Reject</button></span>}</div>)}
      </div>))}</div>}
    {d && d.open_invoices.length > 0 && <><h3 className="font-semibold mt-6 mb-2">Open invoices</h3><Table rows={d.open_invoices.map((r: any) => ({ ...r, id: undefined }))} noun="invoices" cols={[{ h: 'Invoice', render: (r: any) => <span className="num font-medium">{r.invoice_no}</span> }, { h: 'Date', render: (r: any) => <span className="num">{fmtDate(r.date)}</span> }, { h: 'Payer', render: (r: any) => r.payer ?? '—' }, { h: 'Billed', right: true, render: (r: any) => n2(r.billed) }, { h: 'Outstanding', right: true, render: (r: any) => n2(r.outstanding) }]} /></>}
    {alloc && d && <Modal title="Apply payment to an invoice" onClose={() => setAlloc(null)}><AllocForm p={alloc} invoices={d.open_invoices} onDone={() => { setAlloc(null); load(); }} /></Modal>}
  </>;
}
function AllocForm({ p, invoices, onDone }: { p: any; invoices: any[]; onDone(): void }) {
  const [inv, setInv] = useState(''), [amt, setAmt] = useState(String(p.unapplied)), [err, setErr] = useState('');
  const o = invoices.find((x) => x.invoice_no === inv);
  return <><Err e={err} /><p className="text-sm mb-3">{n2(p.unapplied)} of this payment is still unapplied.</p>
    <Field label="Invoice"><select className="input" value={inv} onChange={(e) => { setInv(e.target.value); const x = invoices.find((i) => i.invoice_no === e.target.value); if (x) setAmt(String(Math.min(x.outstanding, p.unapplied))); }}><option value="">Choose…</option>{invoices.map((i) => <option key={i.invoice_no} value={i.invoice_no}>{i.invoice_no} — {n2(i.outstanding)} outstanding</option>)}</select></Field>
    <Field label="Amount to apply" hint={o ? `The invoice has ${n2(o.outstanding)} outstanding` : undefined}><input className="input num" value={amt} onChange={(e) => setAmt(e.target.value)} /></Field>
    <div className="flex justify-end"><button className="btn" disabled={!inv || !(Number(amt) > 0)} onClick={async () => { try { await api(`/ext-import/payments/${p.id}/allocate`, 'POST', { invoice_no: inv, amount: Number(amt) }); onDone(); } catch (e: any) { setErr(e.message); } }}>Apply</button></div></>;
}

/* ───────────────────────────── templates ───────────────────────────── */

function TemplatesTab({ canWrite }: { canWrite: boolean }) {
  const [rows, setRows] = useState<any[] | null>(null), [err, setErr] = useState('');
  const load = () => api('/ext-import/templates').then(setRows).catch((e) => setErr(e.message)); useEffect(() => { load(); }, []);
  return <>
    <p className="text-sm text-muted mb-3">When you correct the column mapping of an upload, choose “Save as template”. Next time a file with the same column names arrives, those choices are applied automatically.</p><Err e={err} />
    {!rows ? <Skeleton className="h-32" /> : <Table rows={rows} empty="No saved templates yet." cols={[
      { h: 'Name', render: (r: any) => <span className="font-medium">{r.name}</span> }, { h: 'Columns remembered', render: (r: any) => <span className="text-sm text-muted">{Object.entries(r.mapping.labels ?? {}).map(([l, f]) => `${l} → ${f}`).slice(0, 4).join(' · ')}{Object.keys(r.mapping.labels ?? {}).length > 4 ? ' …' : ''}</span> },
      { h: 'Billed to', render: (r: any) => r.payer_hint ?? '—' }, { h: 'Saved', render: (r: any) => fmtDate(r.created_at) },
      { h: '', render: (r: any) => canWrite ? <button className="btn-ghost !h-8" onClick={async () => { await api(`/ext-import/templates/${r.id}`, 'DELETE').catch((e) => setErr(e.message)); load(); }}>Delete</button> : null }]} />}
  </>;
}
