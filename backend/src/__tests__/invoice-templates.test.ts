import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Api, addMember, apiBase, boot, newAgency, seedBasics, shutdown, ticketBody } from './helpers.js';
import { invoiceHtml, ticketInvoiceHtml } from '../services/pdf.js';
import { DEFAULT_TEMPLATE, TEMPLATES, TEMPLATE_KEYS, templateOf } from '../services/invoiceTemplates.js';

// Every page the app turns into a PDF is also recorded here, so a test can see which design a client's copy was drawn with.
const drawn = vi.hoisted(() => ({ html: [] as string[] }));
vi.mock('../services/pdf.js', async (orig) => {
  const m: any = await orig();
  return { ...m, htmlToPdf: (html: string, o?: unknown) => { drawn.html.push(html); return m.htmlToPdf(html, o); } };
});

const agency = { name: 'Acme Travel', address: '1 Road', base_currency: 'USD', tax_label: 'GST', tax_number: '12 345 678', bank_name: 'HBL', bank_account_name: 'Acme Travel', bank_account_number: '0012345', bank_swift: 'HABBPKKA' };
const inv = (o: any = {}) => ({ number: 'INV-77', currency: 'USD', issue_date: '2026-01-01', due_date: '2099-01-01', subtotal: 100, tax_total: 10, total: 110, amount_paid: 0, status: 'sent', notes: 'Bring <b>passports</b>', ...o });
const lines = [{ product_type: 'hotel', description: 'Bali villa', quantity: 1, unit_price: 100, line_net: 100, line_tax: 10 }];
const client = { name: 'Northwind Ltd', address: '12 Harbour St', email: 'ap@northwind.test' };
const ticket = { invoice_no: 'TK-000009', status: 'confirmed', invoice_date: '2026-11-06', due_date: '2026-11-20', remarks: 'Pay <b>soon</b>', client_name: 'Acme',
  lines: [{ passenger_name: 'MALIK/SARA MS', pax_type: 'Adult', ticket_no: '2352148809001', airline_name: 'TURKISH AIRLINES', route: 'KHI-IST-KHI', dep_date: '2026-12-01', pnr: 'X7K2QD', currency: 'USD',
    fare_inc: 520, taxes_inc: 85, psf: 10, other_charges: 0, vat: 0, wh_client: 0, discount: 0, receivable_fc: 615, payable_fc: 548.6, com_rec: 36.4, com_paid: 0, profit_fc: 66.4, payable: 548.6, profit: 66.4 }] };

describe('the designs', () => {
  it('there are at least three, each with its own name and a description', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(TEMPLATES.map((t) => t.key)).size).toBe(TEMPLATES.length);
    expect(TEMPLATES.map((t) => t.key)).toEqual([...TEMPLATE_KEYS]);
    for (const t of TEMPLATES) { expect(t.name.length).toBeGreaterThan(2); expect(t.about.length).toBeGreaterThan(20); }
  });

  it.each(TEMPLATE_KEYS)('%s: a booking invoice shows every fact, and escapes what people typed', (key) => {
    const a = { ...agency, invoice_template: key, payment_instructions: '<img src=x onerror=1>' };
    const h = invoiceHtml(a, inv(), lines, client, [{ label: 'Deposit', due_date: '2026-02-01', amount: 50, paid: true }]);
    expect(h).toContain(`data-template="${key}"`);
    for (const t of ['INVOICE', 'INV-77', 'Acme Travel', 'Tax no:', '12 345 678', 'Northwind Ltd', '12 Harbour St', 'ap@northwind.test', 'Bali villa', '2026-01-01', '2099-01-01', '$110.00', 'Payment schedule', 'How to pay', 'HBL', '0012345', 'HABBPKKA', 'Payment reference']) expect(h, `${key}: ${t}`).toContain(t);
    expect(h).toContain('Bring &lt;b&gt;passports'); expect(h).not.toContain('Bring <b>'); expect(h).not.toContain('<img src=x');
    const paid = invoiceHtml(a, inv({ amount_paid: 110 }), lines, client, []);
    expect(paid).toContain('Paid in full'); expect(paid).not.toContain('How to pay');
    expect(invoiceHtml(a, inv({ due_date: '2000-01-01' }), lines, client, [])).toContain('Overdue');
    expect(invoiceHtml(a, inv({ status: 'draft' }), lines, client, [])).toContain('Draft');
  });

  it.each(TEMPLATE_KEYS)('%s: a ticket invoice shows the client what they pay and never the agency cost, commission or profit', (key) => {
    const h = ticketInvoiceHtml({ ...agency, invoice_template: key }, ticket, client, { data: 'QUJD', mime: 'image/png' });
    expect(h).toContain(`data-template="${key}"`);
    for (const t of ['TICKET INVOICE', 'TK-000009', 'MALIK/SARA MS', '2352148809001', 'X7K2QD', '$615.00', 'Total payable', 'data:image/png;base64,QUJD', 'HBL', 'Issued', 'Pay &lt;b&gt;soon']) expect(h, `${key}: ${t}`).toContain(t);
    for (const secret of ['548.6', '548.60', '36.4', '66.4', '66.40']) expect(h, `${key}: ${secret}`).not.toContain(secret);
    expect(ticketInvoiceHtml({ ...agency, invoice_template: key }, { ...ticket, status: 'tentative' }, null, null)).toContain('Draft');
  });

  it('Classic is the default, and the fallback when the saved name is unknown', () => {
    expect(DEFAULT_TEMPLATE).toBe('classic');
    expect(templateOf({}).key).toBe('classic'); expect(templateOf(null).key).toBe('classic'); expect(templateOf({ invoice_template: 'sparkly' }).key).toBe('classic');
    expect(invoiceHtml(agency, inv(), lines, client, [])).toContain('data-template="classic"');
    const classic = invoiceHtml(agency, inv(), lines, client, []);
    expect(classic).toContain('class="bar"'); expect(classic).toMatch(/Amount due<\/div><div class="val">\$110\.00/);   // the look agencies have today
  });

  it('a design can be asked for by name, which wins over the saved one (previews)', () => {
    const h = invoiceHtml({ ...agency, invoice_template: 'elegant' }, inv(), lines, client, [], null, 'modern');
    expect(h).toContain('data-template="modern"'); expect(h).not.toContain('data-template="elegant"');
  });

  it('the designs really are different, but share one set of facts', () => {
    const pages = TEMPLATE_KEYS.map((k) => invoiceHtml({ ...agency, invoice_template: k }, inv(), lines, client, []));
    expect(new Set(pages).size).toBe(TEMPLATE_KEYS.length);
    const text = (h: string) => h.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const p of pages) for (const w of ['Subtotal', 'GST', 'Total', 'Balance due', 'Thank you for travelling with Acme Travel']) expect(text(p)).toContain(w);
  });
});

describe('choosing the default design', () => {
  let A: Api, B: Api, finance: Api, agent: Api, viewer: Api; let s: Awaited<ReturnType<typeof seedBasics>>;
  beforeAll(async () => {
    await boot(); A = await newAgency('IT-A'); B = await newAgency('IT-B'); s = await seedBasics(A);
    finance = await addMember(A, 'finance_manager'); agent = await addMember(A, 'agent'); viewer = await addMember(A, 'viewer');
  });
  afterAll(shutdown);

  it('lists the designs with the current choice; a new agency starts on Classic', async () => {
    const r = await A.get('/admin/invoice-templates'); expect(r.status).toBe(200);
    expect(r.body.selected).toBe('classic'); expect(r.body.templates.map((t: any) => t.key)).toEqual([...TEMPLATE_KEYS]);
    for (const t of r.body.templates) expect(Object.keys(t).sort()).toEqual(['about', 'key', 'name']);
    expect((await A.get('/admin/settings')).body.invoice_template).toBe('classic');
    for (const who of [finance, agent, viewer]) expect((await who.get('/admin/invoice-templates')).status).toBe(200);   // anyone who can open Settings can see them
  });

  it('only an Admin can choose; the choice is saved per agency and rejects unknown designs', async () => {
    expect((await A.put('/admin/settings', { invoice_template: 'sparkly' })).status).toBe(400);
    for (const who of [finance, agent, viewer]) expect((await who.put('/admin/settings', { invoice_template: 'modern' })).status).toBe(403);
    expect((await A.get('/admin/invoice-templates')).body.selected).toBe('classic');
    const ok = await A.put('/admin/settings', { invoice_template: 'modern' }); expect(ok.status).toBe(200); expect(ok.body.invoice_template).toBe('modern');
    expect((await A.get('/admin/invoice-templates')).body.selected).toBe('modern');
    expect((await viewer.get('/admin/settings')).body.invoice_template).toBe('modern');
    expect((await B.get('/admin/invoice-templates')).body.selected).toBe('classic');              // another agency is unaffected
    expect((await A.put('/admin/settings', { tax_label: 'VAT' })).body.invoice_template).toBe('modern');   // saving other settings keeps it
  });

  it('previews each design with the agency’s own details, whatever is saved', async () => {
    await A.put('/admin/settings', { invoice_template: 'modern', name: 'Preview Travel Co', bank_name: 'Preview Bank' });
    for (const key of TEMPLATE_KEYS) {
      const r = await A.get(`/admin/invoice-templates/${key}/preview`); expect(r.status, key).toBe(200);
      expect(r.body.html).toContain(`data-template="${key}"`); expect(r.body.html).toContain('Preview Travel Co'); expect(r.body.html).toContain('Preview Bank'); expect(r.body.html).toContain('INVOICE');
      const t = await A.get(`/admin/invoice-templates/${key}/preview?doc=ticket`); expect(t.status).toBe(200);
      expect(t.body.html).toContain(`data-template="${key}"`); expect(t.body.html).toContain('TICKET INVOICE'); expect(t.body.html).toContain('Preview Travel Co');
    }
    expect((await A.get('/admin/invoice-templates/sparkly/preview')).status).toBe(404);
    expect((await A.get('/admin/invoice-templates/modern/preview')).body.html).toContain('Northwind Holidays Ltd');      // made-up client: a preview never shows real clients
    // an agency with no bank details yet still sees where they print
    expect((await B.get('/admin/invoice-templates/classic/preview')).body.html).toContain('How to pay');
  });

  it('a ticket invoice and a booking invoice are drawn with the saved design', async () => {
    const tk = (await A.post('/tickets/invoices', ticketBody(s.client, s.airline))).body.id;
    const c = (await A.post('/clients', { name: 'Design Client', email: 'design@c.test', currency: 'USD' })).body.id;
    const bk = (await A.post('/invoices', { client_id: c, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Trip', unit_cost: 100, markup_pct: 10, tax_rate: 0 }] })).body.inv.id;
    for (const key of ['elegant', 'minimal', 'classic']) {
      expect((await A.put('/admin/settings', { invoice_template: key })).status).toBe(200);
      drawn.html.length = 0;
      const t = await A.get(`/tickets/invoices/${tk}/pdf-url`); expect(t.status, key).toBe(200);
      expect(drawn.html.at(-1), `ticket ${key}`).toContain(`data-template="${key}"`);
      const b = await A.get(`/invoices/${bk}/pdf-url`); expect(b.status, key).toBe(200);
      expect(drawn.html.at(-1), `booking ${key}`).toContain(`data-template="${key}"`);
      const bytes = Buffer.from(await (await fetch(new URL(t.body.url, apiBase()).toString())).arrayBuffer()); expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    }
  });

  it('an invoice already sent keeps the design the client received', async () => {
    const c = (await A.post('/clients', { name: 'Sent Client', email: 'sent@c.test', currency: 'USD' })).body.id;
    const id = (await A.post('/invoices', { client_id: c, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Trip', unit_cost: 100, markup_pct: 10, tax_rate: 0 }] })).body.inv.id;
    await A.put('/admin/settings', { invoice_template: 'modern' });
    await A.post(`/invoices/${id}/status`, { status: 'reviewed' });
    drawn.html.length = 0;
    const sent = await A.post(`/invoices/${id}/send`); expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(drawn.html.at(-1)).toContain('data-template="modern"');
    await A.put('/admin/settings', { invoice_template: 'elegant' });
    drawn.html.length = 0;
    expect((await A.get(`/invoices/${id}/pdf-url`)).status).toBe(200);
    expect(drawn.html).toHaveLength(0);                                                              // the PDF the client got is served as it was; nothing is redrawn
    drawn.html.length = 0;
    expect((await A.post(`/invoices/${id}/send`)).status).toBe(200);                                  // sending it again uses today's choice
    expect(drawn.html.at(-1)).toContain('data-template="elegant"');
  });
});
