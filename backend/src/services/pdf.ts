import puppeteer, { Browser } from 'puppeteer';
import { fmt } from './money.js';

let browser: Browser | null = null;
async function getBrowser() {
  if (!browser || !browser.connected)
    browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  return browser;
}

/** footer: shows "label — Page x of y" in the page margin (used for invoices). */
export async function htmlToPdf(html: string, opts: { footer?: string } = {}): Promise<Buffer> {
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return Buffer.from(await page.pdf({
      format: 'A4', printBackground: true, margin: { top: '14mm', bottom: opts.footer ? '20mm' : '16mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: !!opts.footer, headerTemplate: '<span></span>',
      footerTemplate: opts.footer ? `<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#8a94a3;padding:0 14mm;display:flex;justify-content:space-between"><span>${esc(opts.footer)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>` : '',
    }));
  } finally { await page.close(); }
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const css = `*{box-sizing:border-box}body{font-family:Inter,Helvetica,Arial,sans-serif;color:#1b2430;font-size:11.5px;line-height:1.45;margin:0}
table{width:100%;border-collapse:collapse}.r{text-align:right;font-variant-numeric:tabular-nums}.m{color:#6b7686}
h1{font-size:30px;letter-spacing:2px;margin:0;color:#0f172a;font-weight:800}
.bar{height:6px;background:#00A586;border-radius:3px;margin-bottom:18px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
.brand{font-size:17px;font-weight:700;color:#0f172a}.addr{white-space:pre-line;color:#6b7686;margin-top:4px;max-width:260px}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
.paid{background:#d9f5ea;color:#067a55}.due{background:#fdf0d5;color:#9a5b00}.over{background:#fde2e2;color:#b42318}.draft{background:#e8ebf0;color:#566174}
.meta{display:flex;gap:0;margin:22px 0;border:1px solid #e3e7ee;border-radius:8px;overflow:hidden}
.meta>div{flex:1;padding:10px 14px;border-right:1px solid #e3e7ee}.meta>div:last-child{border-right:0}
.lbl{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#8a94a3;margin-bottom:3px}.val{font-weight:600;font-size:12px}
.billto{margin-bottom:20px}.billto .name{font-size:14px;font-weight:700}
.items th{background:#0f172a;color:#fff;text-align:left;padding:9px 10px;font-size:9.5px;text-transform:uppercase;letter-spacing:.8px}
.items th:first-child{border-radius:6px 0 0 6px}.items th:last-child{border-radius:0 6px 6px 0}
.items td{padding:10px;border-bottom:1px solid #eceff4;vertical-align:top}.items tr{page-break-inside:avoid}
.chip{display:inline-block;font-size:8.5px;text-transform:uppercase;letter-spacing:.7px;background:#eef2f7;color:#556176;border-radius:4px;padding:1px 6px;margin-right:6px;font-weight:600}
.tot{width:46%;margin-left:auto;margin-top:14px;page-break-inside:avoid}.tot td{padding:5px 10px}
.due-box{background:#00A586;color:#fff;border-radius:8px;padding:11px 14px;display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:14px;font-weight:700}
.due-box.zero{background:#067a55}
h3{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#0f172a;margin:24px 0 8px}
.sched td,.sched th{padding:7px 10px;border-bottom:1px solid #eceff4;text-align:left}.sched th{font-size:9px;text-transform:uppercase;color:#8a94a3;letter-spacing:.8px}
.note{background:#f6f8fb;border-left:3px solid #00A586;padding:10px 14px;border-radius:0 6px 6px 0;white-space:pre-line;page-break-inside:avoid}
.pay{border:1px solid #e3e7ee;border-radius:8px;padding:8px 14px;page-break-inside:avoid}.pay td{padding:4px 0;border:0}
.thanks{margin-top:28px;text-align:center;color:#6b7686;font-size:11px}`;

/** Bank rows to print, in a sensible order; blank fields are omitted. */
export const payRows = (a: any): [string, string][] => ([
  ['Bank', a.bank_name], ['Account name', a.bank_account_name], ['Account number', a.bank_account_number], ['BSB / Sort code / Routing', a.bank_routing], ['IBAN', a.bank_iban], ['SWIFT / BIC', a.bank_swift],
] as [string, string | null][]).filter(([, v]) => v && String(v).trim()) as [string, string][];

export function invoiceHtml(a: any, inv: any, lines: any[], client: any, installments: any[], logoData?: { data: string; mime: string } | null) {
  const c = inv.currency, balance = Math.max(0, Math.round((inv.total - inv.amount_paid) * 100) / 100);
  const today = new Date().toISOString().slice(0, 10);
  const [label, cls] = inv.status === 'void' ? ['Void', 'draft'] : inv.status === 'draft' || inv.status === 'reviewed' ? ['Draft', 'draft']
    : balance === 0 ? ['Paid', 'paid'] : inv.due_date < today ? ['Overdue', 'over'] : inv.amount_paid > 0 ? ['Partially paid', 'due'] : ['Payment due', 'due'];
  const rate = (l: any) => (l.line_net > 0 ? `${Math.round((l.line_tax / l.line_net) * 1000) / 10}%` : '—');
  const logoImg = logoData ? `<img src="data:${logoData.mime};base64,${logoData.data}" style="max-height:64px;max-width:200px;object-fit:contain;display:block;margin-bottom:6px" alt="logo">` : '';
  return `<html><head><meta charset="utf-8"><style>${css}</style></head><body>
  <div class="bar"></div>
  <div class="top">
    <div>${logoImg}<div class="brand">${esc(a.name)}</div><div class="addr">${esc(a.address ?? '')}</div>${a.tax_number ? `<div class="addr" style="margin-top:6px"><b>Tax no:</b> ${esc(a.tax_number)}</div>` : ''}</div>
    <div style="text-align:right"><h1>INVOICE</h1><div style="margin:6px 0 8px;font-size:13px;font-weight:600">${esc(inv.number)}</div><span class="badge ${cls}">${label}</span></div>
  </div>
  <div class="meta">
    <div><div class="lbl">Issue date</div><div class="val">${esc(inv.issue_date)}</div></div>
    <div><div class="lbl">Due date</div><div class="val">${esc(inv.due_date)}</div></div>
    <div><div class="lbl">Currency</div><div class="val">${esc(c)}</div></div>
    <div><div class="lbl">Amount due</div><div class="val">${fmt(balance, c)}</div></div>
  </div>
  <div class="billto"><div class="lbl">Bill to</div><div class="name">${esc(client.name)}</div>
    <div class="m" style="white-space:pre-line">${esc(client.address ?? '')}${client.email ? `\n${esc(client.email)}` : ''}${client.phone ? `\n${esc(client.phone)}` : ''}</div></div>
  <table class="items"><thead><tr><th style="width:4%">#</th><th>Description</th><th class="r" style="width:8%">Qty</th><th class="r" style="width:15%">Unit price</th><th class="r" style="width:9%">${esc(a.tax_label)}</th><th class="r" style="width:16%">Amount</th></tr></thead><tbody>
  ${lines.map((l, i) => `<tr><td class="m">${i + 1}</td><td><span class="chip">${esc(l.product_type)}</span>${esc(l.description)}</td><td class="r">${l.quantity}</td>
    <td class="r">${fmt(l.unit_price, c)}</td><td class="r m">${rate(l)}</td><td class="r"><b>${fmt(l.line_net, c)}</b></td></tr>`).join('')}
  </tbody></table>
  <table class="tot"><tr><td class="m">Subtotal</td><td class="r">${fmt(inv.subtotal, c)}</td></tr>
    <tr><td class="m">${esc(a.tax_label)}</td><td class="r">${fmt(inv.tax_total, c)}</td></tr>
    <tr><td style="border-top:1px solid #dfe4ec"><b>Total</b></td><td class="r" style="border-top:1px solid #dfe4ec"><b>${fmt(inv.total, c)}</b></td></tr>
    ${inv.amount_paid > 0 ? `<tr><td class="m">Paid to date</td><td class="r">− ${fmt(inv.amount_paid, c)}</td></tr>` : ''}</table>
  <div class="tot"><div class="due-box ${balance === 0 ? 'zero' : ''}"><span>${balance === 0 ? 'Paid in full' : 'Balance due'}</span><span class="r">${fmt(balance, c)}</span></div></div>
  ${installments.length ? `<h3>Payment schedule</h3><table class="sched"><tr><th>Instalment</th><th>Due date</th><th class="r">Amount</th><th>Status</th></tr>
    ${installments.map((i) => `<tr><td>${esc(i.label)}</td><td>${esc(i.due_date)}</td><td class="r">${fmt(i.amount, c)}</td><td>${i.paid ? '<span class="badge paid">Paid</span>' : i.due_date < today ? '<span class="badge over">Overdue</span>' : '<span class="badge due">Upcoming</span>'}</td></tr>`).join('')}</table>` : ''}

  ${balance > 0 && payRows(a).length ? `<h3>How to pay</h3><div class="pay"><table>${payRows(a).map(([k, v]) => `<tr><td class="m" style="width:34%">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}
    <tr><td class="m">Payment reference</td><td><b>${esc(inv.number)}</b></td></tr></table>${a.payment_instructions ? `<div class="m" style="margin-top:8px;white-space:pre-line">${esc(a.payment_instructions)}</div>` : ''}</div>` : ''}
  ${inv.notes ? `<h3>Notes</h3><div class="note">${esc(inv.notes)}</div>` : ''}
  <div class="thanks">Thank you for travelling with ${esc(String(a.name).replace(/\.$/, ""))}. Please quote <b>${esc(inv.number)}</b> with your payment.</div>
  </body></html>`;
}

export function tableHtml(title: string, columns: string[], rows: any[][]) {
  return `<html><head><style>${css}</style></head><body><h1 style="font-size:20px">${esc(title)}</h1>
  <table><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
  ${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</table></body></html>`;
}
