import { addDays, r2, today } from './money.js';
import { invoiceHtml, payRows, ticketInvoiceHtml } from './pdf.js';
import type { TemplateKey } from './invoiceTemplates.js';

export type SampleDoc = 'invoice' | 'ticket';
type Logo = { data: string; mime: string } | null;

/** Puts the document on an A4 sheet (the PDF's page margins become padding) so it reads like paper on screen. */
const SHEET = '<style>html{background:#e6e9ef}body{width:210mm;min-height:297mm;margin:0 auto;padding:14mm 14mm 20mm;background:#fff;box-shadow:0 1px 10px rgba(15,23,42,.2)}</style>';

/**
 * A made-up booking drawn in the given design, with the agency's real letterhead, logo and bank details, so the agency sees
 * exactly what a client would receive. When no bank details are set yet, placeholders show where they print.
 */
export function sampleInvoiceHtml(agency: any, logo: Logo, template: TemplateKey, doc: SampleDoc): string {
  const a = { ...agency, name: agency.name || 'Your Travel Agency', tax_label: agency.tax_label || 'VAT' };
  if (!payRows(a).length) Object.assign(a, { bank_name: 'Your bank', bank_account_name: a.name, bank_account_number: '0000 0000 0000' });
  const cur: string = a.base_currency || 'USD', t0 = today();
  const client = { name: 'Northwind Holidays Ltd', address: '12 Harbour Street\nLondon EC2A 4NE', email: 'accounts@northwind.example', phone: '+44 20 7946 0000' };

  const html = doc === 'ticket' ? ticketSample(a, client, cur, t0, logo, template) : bookingSample(a, client, cur, t0, logo, template);
  return html.replace('</head>', `${SHEET}</head>`);
}

function bookingSample(a: any, client: any, cur: string, t0: string, logo: Logo, template: TemplateKey) {
  const rows = [
    ['flight', 'Return flights London – Dubai, economy, 2 passengers', 2, 412],
    ['hotel', 'Atlantis The Palm · Deluxe sea view room · 5 nights, breakfast included', 5, 186],
    ['transfer', 'Private airport transfers, return', 1, 78],
    ['other', 'Travel insurance, 7 days', 2, 22.5],
  ] as const;
  const lines = rows.map(([product_type, description, quantity, unit_price]) => {
    const line_net = r2(quantity * unit_price);
    return { product_type, description, quantity, unit_price, line_net, line_tax: r2(line_net * 0.05) };
  });
  const subtotal = r2(lines.reduce((s, l) => s + l.line_net, 0)), tax_total = r2(lines.reduce((s, l) => s + l.line_tax, 0)), total = r2(subtotal + tax_total), deposit = 500;
  const inv = { number: `${a.invoice_prefix || 'INV-'}00128`, currency: cur, issue_date: t0, due_date: addDays(t0, 14), subtotal, tax_total, total, amount_paid: deposit, status: 'sent',
    notes: 'Passports must be valid for six months after your return date.\nPlease let us know of any dietary needs before you travel.' };
  const installments = [{ label: 'Deposit', due_date: t0, amount: deposit, paid: true }, { label: 'Balance', due_date: addDays(t0, 14), amount: r2(total - deposit), paid: false }];
  return invoiceHtml(a, inv, lines, client, installments, logo, template);
}

function ticketSample(a: any, client: any, cur: string, t0: string, logo: Logo, template: TemplateKey) {
  const pax = (name: string, ticket_no: string, pnr: string, discount: number) => {
    const fare_inc = 640, taxes_inc = 188.4, psf = 25;
    return { passenger_name: name, pax_type: 'Adult', ticket_no, airline_name: 'EMIRATES', route: 'KHI – DXB – LHR', dep_date: addDays(t0, 30), return_date: addDays(t0, 44), pnr, fare_class: 'V', currency: cur,
      fare_inc, taxes_inc, psf, other_charges: 0, vat: 0, wh_client: 0, discount, receivable_fc: r2(fare_inc + taxes_inc + psf - discount) };
  };
  const inv = { invoice_no: 'TK-000042', status: 'confirmed', invoice_date: t0, due_date: addDays(t0, 7), ref_no: 'PO-7731', payment_terms: 'Net 7 days', client_name: client.name,
    remarks: 'Tickets are non-transferable. Name changes are not permitted after issue.',
    lines: [pax('KHAN/AHMED MR', '1762400128391', 'Q4LM2X', 0), pax('KHAN/SARA MRS', '1762400128392', 'Q4LM2X', 10)] };
  return ticketInvoiceHtml(a, inv, client, logo, template);
}
