import puppeteer, { Browser } from 'puppeteer';
import { fmt } from './money.js';
import { BASE_CSS, invoicePage, templateOf } from './invoiceTemplates.js';

let browser: Browser | null = null;
async function getBrowser() {
  if (!browser || !browser.connected)
    browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  return browser;
}

/** footer: shows "label — Page x of y" in the page margin (used for invoices). */
export async function htmlToPdf(html: string, opts: { footer?: string; landscape?: boolean } = {}): Promise<Buffer> {
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return Buffer.from(await page.pdf({
      format: 'A4', landscape: !!opts.landscape, printBackground: true, margin: { top: '14mm', bottom: opts.footer ? '20mm' : '16mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: !!opts.footer, headerTemplate: '<span></span>',
      footerTemplate: opts.footer ? `<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#8a94a3;padding:0 14mm;display:flex;justify-content:space-between"><span>${esc(opts.footer)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>` : '',
    }));
  } finally { await page.close(); }
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The shared document stylesheet (invoice designs build on it; receipts, vouchers and run sheets use it as is). */
export const css = BASE_CSS;

/** Bank rows to print, in a sensible order; blank fields are omitted. */
export const payRows = (a: any): [string, string][] => ([
  ['Bank', a.bank_name], ['Account name', a.bank_account_name], ['Account number', a.bank_account_number], ['BSB / Sort code / Routing', a.bank_routing], ['IBAN', a.bank_iban], ['SWIFT / BIC', a.bank_swift],
] as [string, string | null][]).filter(([, v]) => v && String(v).trim()) as [string, string][];

type Logo = { data: string; mime: string } | null | undefined;

/** The lines of a client's address block, skipping blanks. */
const contactLines = (c: any) => [c?.address, c?.email, c?.phone].filter((v) => v && String(v).trim()).map(esc).join('\n');

/** Booking invoice, drawn in the agency's chosen design (or `template`, for previews). */
export function invoiceHtml(a: any, inv: any, lines: any[], client: any, installments: any[], logoData?: Logo, template?: string | null) {
  const c = inv.currency, balance = Math.max(0, Math.round((inv.total - inv.amount_paid) * 100) / 100);
  const today = new Date().toISOString().slice(0, 10);
  const [label, cls]: [string, 'paid' | 'due' | 'over' | 'draft'] = inv.status === 'void' ? ['Void', 'draft'] : inv.status === 'draft' || inv.status === 'reviewed' ? ['Draft', 'draft']
    : balance === 0 ? ['Paid', 'paid'] : inv.due_date < today ? ['Overdue', 'over'] : inv.amount_paid > 0 ? ['Partially paid', 'due'] : ['Payment due', 'due'];
  const rate = (l: any) => (l.line_net > 0 ? `${Math.round((l.line_tax / l.line_net) * 1000) / 10}%` : '—');
  const body = `<table class="items"><thead><tr><th style="width:4%">#</th><th>Description</th><th class="r" style="width:8%">Qty</th><th class="r" style="width:15%">Unit price</th><th class="r" style="width:9%">${esc(a.tax_label)}</th><th class="r" style="width:16%">Amount</th></tr></thead><tbody>
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
  ${inv.notes ? `<h3>Notes</h3><div class="note">${esc(inv.notes)}</div>` : ''}`;
  return invoicePage(templateOf(a, template), {
    kind: 'invoice', title: 'INVOICE', number: esc(inv.number), badge: { label, cls }, letterhead: letterheadHtml(a, logoData),
    billLabel: 'Bill to', billTo: `<div class="name">${esc(client.name)}</div><div class="m" style="white-space:pre-line">${contactLines(client)}</div>`,
    facts: [['Issue date', esc(inv.issue_date)], ['Due date', esc(inv.due_date)], ['Currency', esc(c)]],
    headline: { label: 'Amount due', value: fmt(balance, c), sub: balance === 0 ? 'Paid in full' : `Due ${esc(inv.due_date)}` },
  }, body, `Thank you for travelling with ${esc(String(a.name).replace(/\.$/, ''))}. Please quote <b>${esc(inv.number)}</b> with your payment.`);
}

/** The agency's letterhead: logo (when set), name, address and tax number. Used by every client-facing document. */
export function letterheadHtml(a: any, logo?: Logo) {
  const img = logo ? `<img src="data:${logo.mime};base64,${logo.data}" style="max-height:64px;max-width:200px;object-fit:contain;display:block;margin-bottom:6px" alt="logo">` : '';
  return `<div class="lh">${img}<div class="brand">${esc(a.name)}</div><div class="addr">${esc(a.address ?? '')}</div>${a.tax_number ? `<div class="addr" style="margin-top:6px"><b>Tax no:</b> ${esc(a.tax_number)}</div>` : ''}</div>`;
}

export function tableHtml(title: string, columns: string[], rows: any[][], brand?: { agency: any; logo?: { data: string; mime: string } | null }) {
  const head = brand ? `<div class="bar"></div><div style="margin-bottom:14px">${letterheadHtml(brand.agency, brand.logo)}</div>` : '';
  return `<html><head><style>${css}</style></head><body>${head}<h1 style="font-size:20px">${esc(title)}</h1>
  <table><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
  ${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</table></body></html>`;
}

/**
 * Client copy of a ticket invoice. Shows what the client pays — fare, taxes, charges, total — and never the agency's cost, commission or profit.
 * Amounts stay in each line's own currency. Drawn in the agency's chosen design (or `template`, for previews).
 */
export function ticketInvoiceHtml(a: any, inv: any, client: any, logo?: Logo, template?: string | null) {
  const cur = (l: any) => l.currency || a.base_currency || 'USD', d10 = (v: unknown) => (v ? String(v).slice(0, 10) : '');
  const charges = (l: any) => Math.round((Number(l.psf) + Number(l.other_charges) + Number(l.vat) + Number(l.wh_client)) * 100) / 100;
  const draft = inv.status !== 'confirmed';
  const byCur = new Map<string, number>(); for (const l of inv.lines) byCur.set(cur(l), Math.round(((byCur.get(cur(l)) ?? 0) + Number(l.receivable_fc)) * 100) / 100);
  const route = (l: any) => [l.route || l.sector, [d10(l.dep_date), d10(l.return_date)].filter(Boolean).join(' → ')].filter(Boolean).join('<br>');
  const pay = payRows(a);
  const body = `<table class="items"><tr><th style="width:24%">Passenger</th><th style="width:30%">Ticket &amp; itinerary</th><th class="r">Fare</th><th class="r">Taxes</th><th class="r">Charges</th><th class="r">Total</th></tr>
  ${inv.lines.map((l: any) => `<tr><td><div class="pax">${esc(l.passenger_name ?? '')}</div><div class="sm">${esc(l.pax_type ?? '')}${l.passport ? ` · Passport ${esc(l.passport)}` : ''}</div></td>
    <td><span class="chip">${esc(l.airline_name ?? 'Ticket')}</span><span class="tkn">${esc(l.ticket_no ?? '')}</span><div class="sm" style="margin-top:3px">${route(l)}</div>${l.pnr || l.confirmation_no ? `<div class="sm">Booking ref: <b>${esc(l.pnr || l.confirmation_no)}</b>${l.fare_class ? ` · Class ${esc(l.fare_class)}` : ''}</div>` : ''}</td>
    <td class="r">${fmt(Number(l.fare_inc), cur(l))}</td><td class="r">${fmt(Number(l.taxes_inc), cur(l))}</td><td class="r">${fmt(charges(l) - Number(l.discount), cur(l))}${Number(l.discount) > 0 ? `<div class="sm">incl. discount −${fmt(Number(l.discount), cur(l))}</div>` : ''}</td>
    <td class="r"><b>${fmt(Number(l.receivable_fc), cur(l))}</b></td></tr>`).join('')}</table>
  ${[...byCur.entries()].map(([c, v]) => `<div class="due-box"><span>Total payable (${esc(c)})</span><span>${fmt(v, c)}</span></div>`).join('')}
  ${inv.remarks ? `<h3>Notes</h3><div class="note">${esc(inv.remarks)}</div>` : ''}
  ${pay.length ? `<h3>How to pay</h3><div class="pay"><table>${pay.map(([k, v]) => `<tr><td class="m" style="width:34%">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table></div>` : ''}`;
  return invoicePage(templateOf(a, template), {
    kind: 'ticket', title: 'TICKET INVOICE', number: esc(inv.invoice_no), badge: draft ? { label: 'Draft', cls: 'draft' } : { label: 'Issued', cls: 'paid' }, letterhead: letterheadHtml(a, logo),
    billLabel: 'Billed to', billTo: `<div class="name">${esc(client?.name ?? inv.client_name ?? '')}</div><div class="m" style="white-space:pre-line">${contactLines(client)}</div>`,
    facts: [['Invoice date', esc(d10(inv.invoice_date))], ['Due date', esc(d10(inv.due_date) || '—')], ['Reference', esc(inv.ref_no || inv.stax_invoice_no || '—')], ['Terms', esc(inv.payment_terms || '—')]],
    headline: { label: 'Total payable', value: [...byCur.entries()].map(([c, v]) => fmt(v, c)).join(' + '), sub: d10(inv.due_date) ? `Due ${esc(d10(inv.due_date))}` : '' },
  }, body, `Thank you for travelling with ${esc(String(a.name).replace(/\.$/, ''))}. Please keep this invoice with your travel documents.`);
}
