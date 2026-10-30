import { describe, expect, it } from 'vitest';
import { priceLines, r2, addDays } from '../services/money.js';
import { amountInWords } from '../services/accounting.js';
import { computeLine } from '../routes/tickets.js';
import { invoiceHtml } from '../services/pdf.js';

const L = (o: Record<string, number> = {}) => ({ fare: 0, fare_nc: 0, sp_yi: 0, rg_cvt: 0, yq: 0, ced: 0, pb_adv_yq: 0, xz: 0, yd: 0, kb: 0, xt_ur_us: 0, other_tax: 0,
  com_rec_pct: 0, com_rec: 0, com_paid_pct: 0, com_paid: 0, wh_air: 0, insurance: 0, vat_paid: 0, psf: 0, other_charges: 0, discount_pct: 0, discount: 0,
  wh_client: 0, fare_inc: 0, taxes_inc: 0, agent_amount: 0, vat_pct: 0, vat: 0, fx_rate: 1, ...o });

describe('pricing', () => {
  it('applies markup then tax on the marked-up net', () => {
    const p = priceLines([{ product_type: 'hotel', description: 'x', quantity: 2, unit_cost: 100, markup_pct: 10, tax_rate: 10 }]);
    expect(p).toMatchObject({ subtotal: 220, tax_total: 22, total: 242 });
  });
  it('rounds to cents without drift', () => { expect(r2(1.005 + 0.0000001)).toBe(1.01); expect(r2(0.1 + 0.2)).toBe(0.3); });
  it('adds days across month ends', () => { expect(addDays('2026-01-31', 1)).toBe('2026-02-01'); });
});

describe('ticket line maths', () => {
  it('derives taxes, ticket, payable, receivable and profit', () => {
    const c = computeLine(L({ fare: 1000, yq: 50, sp_yi: 20, com_rec_pct: 7, psf: 30, fare_inc: 1000, taxes_inc: 70 }));
    expect(c).toMatchObject({ total_taxes: 70, ticket_total: 1070, com_rec: 70, payable_fc: 1000, receivable_fc: 1100, profit_fc: 100 });
  });
  it('percentages override amounts; airline WH% applies when WH Air blank', () => {
    const c = computeLine(L({ fare: 1000, com_rec_pct: 10, com_rec: 5 }), { wh_pct: 10 });
    expect(c.com_rec).toBe(100); expect(c.wh_air).toBe(10);
  });
  it('commission paid and agent amount reduce profit only', () => {
    const c = computeLine(L({ fare: 1000, psf: 50, com_paid: 20, agent_amount: 10 }));
    expect(c.receivable_fc - c.payable_fc).toBe(50); expect(c.profit_fc).toBe(20);
  });
  it('converts to base currency with the line rate', () => {
    const c = computeLine(L({ fare: 100, fx_rate: 3.5 }));
    expect(c.receivable_fc).toBe(100); expect(c.receivable).toBe(350);
  });
});

describe('amount in words', () => {
  it.each([[0, 'Zero Only'], [1250.5, 'One Thousand Two Hundred Fifty and 50/100 Only'], [1000000, 'One Million Only'], [19, 'Nineteen Only'], [101, 'One Hundred One Only']])('%s', (n, w) => expect(amountInWords(n)).toBe(w));
});

describe('invoice PDF billing details', () => {
  const inv = (o: any = {}) => ({ number: 'INV-1', currency: 'USD', issue_date: '2026-01-01', due_date: '2099-01-01', subtotal: 100, tax_total: 10, total: 110, amount_paid: 0, status: 'sent', ...o });
  const line = [{ product_type: 'hotel', description: 'x', quantity: 1, unit_price: 100, line_net: 100, line_tax: 10 }];
  const agency = { name: 'Acme', tax_label: 'GST', tax_number: '12 345 678', bank_name: 'HBL', bank_account_name: 'Acme Travel', bank_account_number: '0012345', bank_routing: '062-000', bank_iban: 'PK36SCBL0000001123456702', bank_swift: 'HABBPKKA', payment_instructions: 'Email receipt' };
  it('prints tax number and bank details while a balance is owed', () => {
    const h = invoiceHtml(agency, inv(), line, { name: 'C' }, []);
    for (const t of ['Tax no:', '12 345 678', 'How to pay', 'HBL', '0012345', '062-000', 'PK36SCBL0000001123456702', 'HABBPKKA', 'Email receipt', 'Payment reference']) expect(h).toContain(t);
  });
  it('omits bank block when fully paid or when no details are set; omits blank rows', () => {
    expect(invoiceHtml(agency, inv({ amount_paid: 110 }), line, { name: 'C' }, [])).not.toContain('How to pay');
    expect(invoiceHtml({ name: 'A', tax_label: 'GST' }, inv(), line, { name: 'C' }, [])).not.toMatch(/How to pay|Tax no/);
    const h = invoiceHtml({ ...agency, bank_iban: null, bank_swift: '  ' }, inv(), line, { name: 'C' }, []);
    expect(h).not.toContain('IBAN'); expect(h).not.toContain('SWIFT');
  });
  it('escapes HTML in user-supplied fields', () => {
    const h = invoiceHtml({ ...agency, bank_name: '<script>alert(1)</script>', payment_instructions: '<img src=x onerror=1>' }, inv(), line, { name: 'C' }, []);
    expect(h).not.toContain('<script>'); expect(h).not.toContain('<img'); expect(h).toContain('&lt;script&gt;');
  });
});

import { matches, ruleAmount, selectRule, specificity, splitAmount, tierRate, type Rule } from '../services/commission-rules.js';
const rule = (o: Partial<Rule> = {}): Rule => ({ id: 1, rule_key: 'k', version: 1, name: 'r', kind: 'agent', basis: 'pct_margin', rate: 10, fixed_amount: null, tiers: null, deduct_overhead: 0,
  branch_id: null, product_type: null, supplier_id: null, destination: null, agent_id: null, effective_from: null, effective_to: null, priority: 0, ...o });
const ctx = { branch_id: 1, product_type: 'hotel', supplier_id: 5, destination: 'Bali', agent_id: 9, date: '2026-06-15' };

describe('commission rules', () => {
  it('matches only when every specified scope field and the date window agree (case-insensitive text)', () => {
    expect(matches(rule(), ctx)).toBe(true);
    expect(matches(rule({ product_type: 'hotel', destination: 'bali' }), ctx)).toBe(true);
    expect(matches(rule({ product_type: 'flight' }), ctx)).toBe(false);
    expect(matches(rule({ effective_from: '2026-07-01' }), ctx)).toBe(false); expect(matches(rule({ effective_to: '2026-06-14' }), ctx)).toBe(false);
    expect(matches(rule({ effective_from: '2026-06-15', effective_to: '2026-06-15' }), ctx)).toBe(true);
    expect(matches(rule({ active: 0 }), ctx)).toBe(false);
  });
  it('picks the most specific rule, then priority, then the newest version', () => {
    const general = rule({ id: 1, rate: 5 }), hotel = rule({ id: 2, product_type: 'hotel', rate: 8 }), hotelBali = rule({ id: 3, product_type: 'hotel', destination: 'Bali', rate: 12 });
    expect(selectRule([general, hotel, hotelBali], ctx)!.id).toBe(3); expect(specificity(hotelBali)).toBe(2);
    expect(selectRule([rule({ id: 4, priority: 5 }), general], ctx)!.id).toBe(4);
    expect(selectRule([rule({ id: 5, version: 1 }), rule({ id: 6, version: 2 })], ctx)!.id).toBe(6);
    expect(selectRule([rule({ kind: 'supplier' })], ctx)).toBeUndefined(); expect(selectRule([rule({ kind: 'supplier' })], ctx, 'supplier')).toBeDefined();
  });
  it('computes each basis; overhead is deducted only when the rule says so; negatives never pay out', () => {
    const line = { net: 1000, margin: 200, overhead: 50 };
    expect(ruleAmount(rule({ basis: 'pct_selling', rate: 5 }), line).amount).toBe(50);
    expect(ruleAmount(rule({ basis: 'pct_margin', rate: 40 }), line).amount).toBe(80);
    expect(ruleAmount(rule({ basis: 'pct_margin', rate: 40, deduct_overhead: 1 }), line).amount).toBe(60);
    expect(ruleAmount(rule({ basis: 'fixed', fixed_amount: 25 }), line).amount).toBe(25);
    expect(ruleAmount(rule({ basis: 'pct_margin', rate: 40 }), { net: 100, margin: -30, overhead: 0 }).amount).toBe(0);
  });
  it('tiers: the highest reached threshold sets the rate', () => {
    const tiers = [{ from: 0, rate: 30 }, { from: 5000, rate: 40 }, { from: 10000, rate: 50 }];
    expect([0, 4999.99, 5000, 12000].map((m) => tierRate(tiers, m))).toEqual([30, 30, 40, 50]);
    expect(ruleAmount(rule({ basis: 'pct_margin', rate: 10, tiers: JSON.stringify(tiers) }), { net: 1000, margin: 200, overhead: 0 }, 6000).amount).toBe(80);
  });
  it('split amounts always sum exactly to the whole', () => {
    for (const [total, pcts] of [[100, [33.33, 33.33, 33.34]], [0.1, [50, 50]], [999.99, [60, 25, 15]], [1, [33.33, 66.67]]] as [number, number[]][])
      expect(Math.round(splitAmount(total, pcts).reduce((s, x) => s + x, 0) * 100) / 100).toBe(total);
    expect(() => splitAmount(10, [60, 30])).toThrow();
  });
});

import { autoPick, dedupeHashes, parseAmount, parseCsvStatement, parseDate, parseOfx, suggest } from '../services/bank-match.js';
describe('bank statement parsing', () => {
  it('reads messy amounts and day-first / ISO / OFX dates', () => {
    expect(['1,234.56', '(100.00)', '-5', '$ 7.5', '12.00 DR', '', 'abc'].map(parseAmount)).toEqual([1234.56, -100, -5, 7.5, -12, null, null]);
    expect([parseDate('2026-03-04'), parseDate('04/03/2026'), parseDate('20260304120000'), parseDate('4.3.2026'), parseDate('nope')]).toEqual(['2026-03-04', '2026-03-04', '2026-03-04', '2026-03-04', null]);
  });
  it('parses CSV with separate credit/debit columns, references, payees and a running balance', () => {
    const s = parseCsvStatement('Date,Description,Reference,Payee,Credit,Debit,Balance\n01/10/2026,Deposit,RCT-000009,Blue Sky,500.00,,1500.00\n02/10/2026,Bank fee,,,,12.50,1487.50');
    expect(s.txns).toMatchObject([{ tx_date: '2026-10-01', amount: 500, reference: 'RCT-000009', counterparty: 'Blue Sky' }, { tx_date: '2026-10-02', amount: -12.5 }]); expect(s.closing_balance).toBe(1487.5);
    expect(() => parseCsvStatement('date,amount\nnot-a-date,5')).toThrow(/Row 2/);
  });
  it('parses OFX transactions and the ledger balance', () => {
    const s = parseOfx('<OFX><STMTTRN><DTPOSTED>20261030<TRNAMT>-42.10<FITID>A1<NAME>ACME<MEMO>Card</STMTTRN><LEDGERBAL><BALAMT>958.00</LEDGERBAL></OFX>');
    expect(s.txns[0]).toMatchObject({ tx_date: '2026-10-30', amount: -42.1, fitid: 'A1' }); expect(s.closing_balance).toBe(958);
  });
  it('fingerprints are stable, and identical lines in one file stay distinct', () => {
    const t = { tx_date: '2026-01-01', amount: 5, description: 'Coffee', reference: null, counterparty: null, fitid: null, balance: null };
    const h = dedupeHashes(1, [t, t, { ...t, amount: 6 }]); expect(new Set(h).size).toBe(3); expect(dedupeHashes(1, [t, t, { ...t, amount: 6 }])).toEqual(h); expect(dedupeHashes(2, [t])[0]).not.toBe(h[0]);
  });
});
describe('bank match suggestions', () => {
  const txn = { amount: 500, tx_date: '2026-10-10', description: 'Transfer RCT-000009 Blue Sky', reference: null, counterparty: 'Blue Sky Events' };
  const c = (id: number, remaining: number, date: string, narration = '', voucher_no = '') => ({ id, remaining, entry_date: date, narration, voucher_no, party: null });
  it('exact amount + reference + date ranks first and auto-picks; an equally good rival blocks auto-pick', () => {
    const s = suggest(txn, [c(1, 500, '2026-10-10', 'Receipt RCT-000009', 'RV-1'), c(2, 500, '2026-10-12'), c(3, 499, '2026-10-10')]);
    expect(s[0].entry_ids).toEqual([1]); expect(s[0].confidence).toBeGreaterThan(s[1].confidence); expect(s.some((x) => x.entry_ids[0] === 3)).toBe(false); expect(autoPick(s)?.entry_ids).toEqual([1]);
    expect(autoPick(suggest({ ...txn, description: 'x', counterparty: null }, [c(1, 500, '2026-10-10'), c(2, 500, '2026-10-10')]))).toBeNull();
  });
  it('wrong sign or far-away entries are never suggested', () => {
    expect(suggest(txn, [c(1, -500, '2026-10-10'), c(2, 500, '2026-05-01')])).toEqual([]);
  });
  it('finds combined deposits, flags them, and never auto-applies them', () => {
    const s = suggest({ ...txn, amount: 450 }, [c(1, 100, '2026-10-09'), c(2, 150, '2026-10-10'), c(3, 200, '2026-10-10'), c(4, 999, '2026-10-10')]);
    expect(s[0]).toMatchObject({ combined: true, entry_ids: expect.arrayContaining([1, 2, 3]) }); expect(s[0].amounts.reduce((a, b) => a + b, 0)).toBe(450); expect(autoPick(s)).toBeNull();
  });
});

import { buildBankFile, payeeProblems, validRouting } from '../services/bank-files.js';
describe('bank files', () => {
  const p = (name: string, amount: number, bd: any) => ({ name, amount, reference: 'RUN-1', bd });
  it('ABA: 120-character records, correct payee line and trailer totals, refuses bad BSBs', () => {
    const f = buildBankFile('aba', 'Horizon Travel', [p('Coral Resorts', 500, { bsb: '062-000', account_number: '12345678' }), p('Sky Air', 250.5, { bsb: '033123', account_number: '999' })], '2026-10-30');
    const lines = f.body.split('\r\n'); expect(lines.every((l) => l.length === 120)).toBe(true); expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('062-000'); expect(lines[1].slice(18, 20)).toBe('50'); expect(lines[1].slice(20, 30)).toBe('0000050000'); expect(lines[3].slice(0, 8)).toBe('7999-999'); expect(lines[3].slice(20, 30)).toBe('0000075050'); expect(f.total).toBe(750.5); expect(lines[3].slice(74, 80)).toBe('000002');
    expect(() => buildBankFile('aba', 'X', [p('Bad', 1, { bsb: '12', account_number: '1' })], '2026-10-30')).toThrow(/BSB/);
  });
  it('ACH: validates routing checksums and totals the credits', () => {
    expect(validRouting('021000021')).toBe(true); expect(validRouting('021000022')).toBe(false); expect(payeeProblems('ach', p('A', 5, { routing: '123456789', account_number: '1' }))[0]).toMatch(/checksum/);
    const f = buildBankFile('ach', 'Horizon', [p('Vendor', 100.25, { routing: '021000021', account_number: '555' })], '2026-10-30'); expect(f.body.split('\r\n')).toHaveLength(5); expect(f.body).toContain('0000010025'); expect(f.ext).toBe('ach');
  });
  it('refuses to produce a file with an unpayable payee or no payees', () => {
    expect(() => buildBankFile('aba', 'X', [], '2026-10-30')).toThrow(/Nothing/); expect(() => buildBankFile('ach', 'X', [p('N', 5, { routing: '021000021' })], '2026-10-30')).toThrow(/no account number/);
  });
});
