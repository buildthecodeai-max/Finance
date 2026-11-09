/**
 * Invoice designs. The agency picks one in Settings (agencies.invoice_template) and every client-facing invoice —
 * booking invoices and ticket invoices — is drawn with it.
 *
 * A design is a colour/type palette plus the arrangement of the top of the page. The line table, totals, payment
 * details and notes share one markup, so every design shows exactly the same facts and a new design cannot hide one.
 */
export const TEMPLATE_KEYS = ['classic', 'modern', 'minimal', 'elegant'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/** What a design needs to lay out the top of an invoice. Every value is HTML that is already escaped. */
export interface Parts {
  kind: 'invoice' | 'ticket';
  title: string;                                           // INVOICE / TICKET INVOICE
  number: string;
  badge: { label: string; cls: 'paid' | 'due' | 'over' | 'draft' };
  letterhead: string;                                      // logo, agency name, address, tax number
  billLabel: string;                                       // Bill to / Billed to
  billTo: string;
  facts: [label: string, value: string][];                 // dates, currency, reference, terms
  headline: { label: string; value: string; sub: string }; // what the client has to pay
}

export interface InvoiceTemplate { key: TemplateKey; name: string; about: string; css: string; head: (p: Parts) => string }

/** Shared styles. The variables hold the Classic palette; the other designs change them. Receipts and other documents use this sheet too. */
export const BASE_CSS = `:root{--ink:#1b2430;--head:#0f172a;--muted:#6b7686;--soft:#8a94a3;--line:#e3e7ee;--rule:#eceff4;--accent:#00A586;--th-bg:#0f172a;--th-fg:#fff;--box:#f6f8fb;--chip-bg:#eef2f7;--chip-fg:#556176;--ok:#067a55;--sans:Inter,Helvetica,Arial,sans-serif;--serif:Georgia,'Times New Roman','Liberation Serif','DejaVu Serif',serif}
*{box-sizing:border-box}body{font-family:var(--sans);color:var(--ink);font-size:11.5px;line-height:1.45;margin:0}
table{width:100%;border-collapse:collapse}.r{text-align:right;font-variant-numeric:tabular-nums}.m{color:var(--muted)}
h1{font-size:30px;letter-spacing:2px;margin:0;color:var(--head);font-weight:800}.no{margin:6px 0 8px;font-size:13px;font-weight:600}
.bar{height:6px;background:var(--accent);border-radius:3px;margin-bottom:18px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
.brand{font-size:17px;font-weight:700;color:var(--head)}.addr{white-space:pre-line;color:var(--muted);margin-top:4px;max-width:260px}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
.paid{background:#d9f5ea;color:#067a55}.due{background:#fdf0d5;color:#9a5b00}.over{background:#fde2e2;color:#b42318}.draft{background:#e8ebf0;color:#566174}
.meta{display:flex;gap:0;margin:22px 0;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.meta>div{flex:1;padding:10px 14px;border-right:1px solid var(--line)}.meta>div:last-child{border-right:0}
.lbl{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:var(--soft);margin-bottom:3px}.val{font-weight:600;font-size:12px}
.billto{margin-bottom:20px}.billto .name{font-size:14px;font-weight:700}
.items th{background:var(--th-bg);color:var(--th-fg);text-align:left;padding:9px 10px;font-size:9.5px;text-transform:uppercase;letter-spacing:.8px}
.items th:first-child{border-radius:6px 0 0 6px}.items th:last-child{border-radius:0 6px 6px 0}
.items td{padding:10px;border-bottom:1px solid var(--rule);vertical-align:top}.items tr{page-break-inside:avoid}
.pax{font-weight:700;font-size:12px}.sm{color:var(--muted);font-size:10.5px}.tkn{font-variant-numeric:tabular-nums;letter-spacing:.3px}
.chip{display:inline-block;font-size:8.5px;text-transform:uppercase;letter-spacing:.7px;background:var(--chip-bg);color:var(--chip-fg);border-radius:4px;padding:1px 6px;margin-right:6px;font-weight:600}
.tot{width:46%;margin-left:auto;margin-top:14px;page-break-inside:avoid}.tot td{padding:5px 10px}
.due-box{background:var(--accent);color:#fff;border-radius:8px;padding:11px 14px;display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:14px;font-weight:700}
.due-box.zero{background:var(--ok)}
h3{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--head);margin:24px 0 8px}
.sched td,.sched th{padding:7px 10px;border-bottom:1px solid var(--rule);text-align:left}.sched th{font-size:9px;text-transform:uppercase;color:var(--soft);letter-spacing:.8px}
.note{background:var(--box);border-left:3px solid var(--accent);padding:10px 14px;border-radius:0 6px 6px 0;white-space:pre-line;page-break-inside:avoid}
.pay{border:1px solid var(--line);border-radius:8px;padding:8px 14px;page-break-inside:avoid}.pay td{padding:4px 0;border:0}
.thanks{margin-top:28px;text-align:center;color:var(--muted);font-size:11px}`;

const badge = (p: Parts) => `<span class="badge ${p.badge.cls}">${p.badge.label}</span>`;
const billTo = (p: Parts) => `<div class="billto"><div class="lbl">${p.billLabel}</div>${p.billTo}</div>`;
const tiles = (facts: [string, string][]) => facts.map(([l, v]) => `<div><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');

const classic: InvoiceTemplate = {
  key: 'classic', name: 'Classic', about: 'The familiar look: a teal accent bar, a dark table header and the facts in a tidy strip.',
  css: '',
  head: (p) => `<div class="bar"></div>
  <div class="top">${p.letterhead}<div style="text-align:right"><h1>${p.title}</h1><div class="no">${p.number}</div>${badge(p)}</div></div>
  <div class="meta">${tiles(p.kind === 'invoice' ? [...p.facts, ['Amount due', p.headline.value]] : p.facts)}</div>
  ${billTo(p)}`,
};

const modern: InvoiceTemplate = {
  key: 'modern', name: 'Modern', about: 'A bold blue banner with the amount due up front, soft cards and a light table.',
  css: `.t-modern{--ink:#1e293b;--head:#0f1b4d;--muted:#64748b;--soft:#94a3b8;--line:#e2e8f0;--rule:#edf0f7;--accent:#2f4fdb;--th-bg:#eef2ff;--th-fg:#2b3a8f;--box:#f5f7ff;--chip-bg:#e8edff;--chip-fg:#3447b5}
.t-modern .band,.t-modern .info{break-inside:avoid}
.t-modern .band{display:flex;justify-content:space-between;align-items:center;gap:20px;margin:18px 0 22px;padding:18px 22px;border-radius:12px;color:#fff;background:linear-gradient(120deg,#1b2a8f 0%,#3358e6 100%)}
.t-modern .band h1{color:#fff;font-size:26px;letter-spacing:3px}.t-modern .band .no{margin:4px 0 8px;opacity:.9;letter-spacing:.3px}
.t-modern .band .badge{background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.4)}
.t-modern .amt{text-align:right}.t-modern .amt .lbl{color:rgba(255,255,255,.75)}.t-modern .amt .big{font-size:26px;font-weight:800;letter-spacing:-.3px;line-height:1.1}.t-modern .amt .sub{font-size:10.5px;opacity:.85;margin-top:4px}
.t-modern .info{display:flex;gap:22px;margin-bottom:22px}.t-modern .info .billto{flex:1.15;margin:0;padding:14px 16px;background:var(--box);border-radius:10px}
.t-modern .facts{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:12px 18px;align-content:start;padding:2px 4px}.t-modern .facts>div:last-child:nth-child(odd){grid-column:1/-1}
.t-modern .items th{letter-spacing:.9px;font-weight:700}.t-modern .items tbody tr:nth-child(even) td{background:#fafbff}
.t-modern table.tot{background:var(--box);border-radius:10px;padding:6px 4px}.t-modern .due-box{background:linear-gradient(120deg,#1b2a8f 0%,#3358e6 100%);border-radius:10px}.t-modern .due-box.zero{background:var(--ok)}
.t-modern .note{border-left-color:var(--accent)}.t-modern .pay{border-radius:10px}`,
  head: (p) => `<div>${p.letterhead}</div>
  <div class="band"><div><h1>${p.title}</h1><div class="no">${p.number}</div>${badge(p)}</div>
    <div class="amt"><div class="lbl">${p.headline.label}</div><div class="big">${p.headline.value}</div><div class="sub">${p.headline.sub}</div></div></div>
  <div class="info">${billTo(p)}<div class="facts">${tiles(p.facts)}</div></div>`,
};

const minimal: InvoiceTemplate = {
  key: 'minimal', name: 'Minimal', about: 'Quiet and clean: lots of white space, hairlines and a light title. The amount due leads the page.',
  css: `.t-minimal{--ink:#1f2937;--head:#0b0f19;--muted:#6b7280;--soft:#9ca3af;--line:#e5e7eb;--rule:#eef0f3;--accent:#111827;--th-bg:transparent;--th-fg:#6b7280;--box:#f9fafb;--chip-bg:#fff;--chip-fg:#4b5563}
.t-minimal .top,.t-minimal .hero,.t-minimal .cols{break-inside:avoid}
.t-minimal h1{font-size:30px;font-weight:300;letter-spacing:-.5px;text-transform:lowercase}.t-minimal h1::first-letter{text-transform:uppercase}
.t-minimal .no{margin:4px 0 8px;font-weight:500;color:var(--muted)}
.t-minimal .badge{background:none;border:1px solid currentColor;padding:2px 9px}
.t-minimal .hero{margin:26px 0 22px;padding:18px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.t-minimal .hero .big{font-size:32px;font-weight:600;letter-spacing:-.6px;color:var(--head);line-height:1.15}.t-minimal .hero .sub{color:var(--muted);margin-top:3px}
.t-minimal .cols{display:flex;justify-content:space-between;gap:28px;margin-bottom:22px}.t-minimal .cols .billto{margin:0;flex:1}
.t-minimal .facts{display:grid;grid-template-columns:repeat(2,minmax(110px,1fr));gap:12px 28px;text-align:left}.t-minimal .facts>div:last-child:nth-child(odd){grid-column:1/-1}
.t-minimal .items th{background:none;color:var(--th-fg);border-bottom:1px solid var(--head);border-radius:0;padding:8px 10px;font-weight:600}
.t-minimal .items th:first-child,.t-minimal .items th:last-child{border-radius:0}.t-minimal .items td{padding:11px 10px}
.t-minimal .chip{border:1px solid var(--line);background:#fff}
.t-minimal .tot{width:44%}.t-minimal .due-box{background:none;color:var(--head);border-radius:0;border-top:2px solid var(--head);padding:12px 10px 0;margin-top:8px;font-size:15px}.t-minimal .due-box.zero{background:none;color:var(--ok);border-top-color:var(--ok)}
.t-minimal h3{font-weight:600;color:var(--muted)}.t-minimal .note{background:none;border-left:2px solid var(--line);border-radius:0}.t-minimal .pay{border:0;border-top:1px solid var(--line);border-radius:0;padding:8px 0}
.t-minimal .thanks{margin-top:34px;border-top:1px solid var(--line);padding-top:14px}`,
  head: (p) => `<div class="top">${p.letterhead}<div style="text-align:right"><h1>${p.title}</h1><div class="no">${p.number}</div>${badge(p)}</div></div>
  <div class="hero"><div class="lbl">${p.headline.label}</div><div class="big">${p.headline.value}</div><div class="sub">${p.headline.sub}</div></div>
  <div class="cols">${billTo(p)}<div class="facts">${tiles(p.facts)}</div></div>`,
};

const elegant: InvoiceTemplate = {
  key: 'elegant', name: 'Elegant', about: 'A centred letterhead, serif headings and fine gold rules — a premium, stationery feel.',
  css: `.t-elegant{--ink:#2a2f3a;--head:#1c2740;--muted:#6f6a5f;--soft:#9a9384;--line:#e4dfd3;--rule:#eee9de;--accent:#a8873f;--th-bg:transparent;--th-fg:#1c2740;--box:#faf8f3;--chip-bg:#f4efe3;--chip-fg:#7a6530}
.t-elegant .crest,.t-elegant .cols{break-inside:avoid}
.t-elegant .lh{text-align:center}.t-elegant .lh img{margin:0 auto 8px !important}.t-elegant .brand{font-family:var(--serif);font-size:21px;letter-spacing:3px;text-transform:uppercase;font-weight:600}
.t-elegant .addr{margin:6px auto 0;max-width:340px;font-size:10.5px}
.t-elegant .rule{height:5px;border-top:1px solid var(--accent);border-bottom:1px solid var(--accent);margin:16px 0 16px}
.t-elegant h1{font-family:var(--serif);font-size:21px;letter-spacing:8px;font-weight:400;text-align:center}.t-elegant .no{text-align:center;margin:8px 0 0;font-size:12px;letter-spacing:.5px}
.t-elegant .badge{margin-left:8px;background:none;border:1px solid currentColor;padding:2px 9px;font-size:9px}
.t-elegant .cols{display:flex;justify-content:space-between;gap:30px;margin:24px 0 22px}.t-elegant .cols .billto{flex:1;margin:0}
.t-elegant .billto .name{font-family:var(--serif);font-size:15px;font-weight:600;color:var(--head)}
.t-elegant .facts{min-width:235px}.t-elegant .facts div{display:flex;justify-content:space-between;gap:16px;padding:5px 0;border-bottom:1px dotted var(--soft)}.t-elegant .facts span{color:var(--muted)}
.t-elegant .items th{background:none;color:var(--th-fg);border-top:1px solid var(--head);border-bottom:1px solid var(--head);border-radius:0;font-family:var(--serif);font-weight:600;letter-spacing:1.4px;padding:8px 10px}
.t-elegant .items th:first-child,.t-elegant .items th:last-child{border-radius:0}.t-elegant .items tr:last-child td{border-bottom:1px solid var(--head)}
.t-elegant .chip{border-radius:2px}.t-elegant .tot b{color:var(--head)}
.t-elegant .due-box{background:none;color:var(--head);border:1px solid var(--accent);border-radius:0;font-family:var(--serif);font-size:15px;letter-spacing:.3px}.t-elegant .due-box.zero{background:none;color:var(--ok);border-color:var(--ok)}
.t-elegant h3{font-family:var(--serif);letter-spacing:2px;font-weight:600}.t-elegant .note{border-radius:0;border-left-color:var(--accent)}.t-elegant .pay{border-radius:0}
.t-elegant .thanks{font-family:var(--serif);font-style:italic;font-size:12px;margin-top:34px;padding-top:14px;border-top:1px solid var(--accent)}`,
  head: (p) => `<div class="crest">${p.letterhead}</div><div class="rule"></div>
  <h1>${p.title}</h1><div class="no">No. ${p.number}${badge(p)}</div>
  <div class="cols">${billTo(p)}<div class="facts">${(p.kind === 'invoice' ? [...p.facts, ['Amount due', p.headline.value] as [string, string]] : p.facts).map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join('')}</div></div>`,
};

export const TEMPLATES: InvoiceTemplate[] = [classic, modern, minimal, elegant];
export const DEFAULT_TEMPLATE: TemplateKey = 'classic';

export const isTemplateKey = (k: unknown): k is TemplateKey => TEMPLATE_KEYS.includes(k as TemplateKey);

/** The design for an agency (its saved choice, or Classic). `override` is for previews. Unknown names fall back to Classic. */
export const templateOf = (agency: { invoice_template?: string | null } | null | undefined, override?: string | null): InvoiceTemplate =>
  TEMPLATES.find((t) => t.key === (override ?? agency?.invoice_template)) ?? TEMPLATES[0];

/** One complete invoice page: the design's stylesheet and header, then the shared body and closing line. */
export function invoicePage(t: InvoiceTemplate, p: Parts, body: string, thanks: string): string {
  return `<html><head><meta charset="utf-8"><style>${BASE_CSS}${t.css}</style></head><body class="t-${t.key}" data-template="${t.key}">
  ${t.head(p)}
  ${body}
  <div class="thanks">${thanks}</div>
  </body></html>`;
}
