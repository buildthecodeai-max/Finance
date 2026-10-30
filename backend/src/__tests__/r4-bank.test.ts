import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, addMember, boot, newAgency, shutdown, sql } from './helpers.js';

let A: Api, B: Api, viewer: Api, bank: number, rent: number, feeAcc: number, bBank: number;
const csv = (rows: string[]) => `Date,Description,Reference,Amount\n${rows.join('\n')}`;
const imp = (rows: string[], extra: Record<string, unknown> = {}, name = `s-${Math.random().toString(36).slice(2, 6)}.csv`) => A.post('/bank/statements', { account_id: bank, filename: name, content: csv(rows), ...extra });
const txns = async (q = '') => (await A.get(`/bank/transactions?account_id=${bank}${q}`)).body as any[];
const ledger = async (a = A, acc = bank) => (await a.get(`/bank/ledger?account_id=${acc}`)).body as any[];
const client = async (a = A) => (await a.post('/clients', { name: `C${Math.random().toString(36).slice(2, 6)}`, currency: 'USD' })).body.id as number;
const receipt = (c: number, amount: number, date: string, reference = '', allocations: any[] = []) => A.post('/finance/receipts', { client_id: c, cash_account_id: bank, amount, method: 'bank_transfer', receipt_date: date, reference, allocations });
const payOut = (amount: number, date: string, cheque = '') => A.post('/vouchers/payments', { cash_account_id: bank, party_account_id: rent, amount, voucher_date: date, mode: cheque ? 'cheque' : 'bank', cheque_no: cheque || undefined });
const bookBal = async () => (await A.get('/bank/accounts')).body.find((x: any) => x.id === bank).book_balance as number;

beforeAll(async () => {
  await boot(); A = await newAgency('Bank'); B = await newAgency('BankB'); viewer = await addMember(A, 'viewer');
  const lk = (await A.get('/accounting/lookup?types=110,320,321')).body as any[];
  bank = lk.find((x) => x.name.includes('Bank')).id; rent = lk.find((x) => x.name === 'Rent').id; feeAcc = lk.find((x) => x.type_code === 321 || x.name.includes('Bank Charges'))?.id
    ?? (await A.post('/accounting/accounts', { type_code: 321, name: 'Bank Charges' })).body.id;
  bBank = ((await B.get('/accounting/lookup?types=110')).body as any[]).find((x) => x.name.includes('Bank')).id;
});
afterAll(shutdown);

describe('statement import', () => {
  it('imports CSV, normalises fields and skips lines already imported (also across overlapping files)', async () => {
    const a = await imp(['2026-09-01,Deposit,REF1,100.00', '2026-09-02,Coffee,,-4.50', '2026-09-02,Coffee,,-4.50'], { closing_balance: 91 }); expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ parsed: 3, added: 3, duplicates: 0 });                                  // two identical coffees are both real
    const again = await imp(['2026-09-01,Deposit,REF1,100.00', '2026-09-02,Coffee,,-4.50', '2026-09-02,Coffee,,-4.50', '2026-09-03,New,,10']); expect(again.body).toMatchObject({ added: 1, duplicates: 3 });
    expect((await txns()).length).toBe(4);
    const s = (await A.get(`/bank/statements?account_id=${bank}`)).body[0]; expect(s).toMatchObject({ status: 'open' });
  });
  it('reads OFX, and refuses bad rows, non-bank accounts, foreign currency, empty files and other tenants', async () => {
    const ofx = '<OFX><BANKTRANLIST><STMTTRN><DTPOSTED>20260915<TRNAMT>-42.10<FITID>OFX1<NAME>ACME<MEMO>Card</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>958.00</LEDGERBAL></OFX>';
    const o = await A.post('/bank/statements', { account_id: bank, filename: 'x.ofx', content: ofx }); expect(o.body.added).toBe(1); expect((await txns()).some((x) => x.fitid === 'OFX1' && x.amount === -42.1)).toBe(true);
    expect((await imp(['not-a-date,x,,5'])).body.error).toMatch(/Row 2/);
    expect((await A.post('/bank/statements', { account_id: rent, filename: 'x.csv', content: csv(['2026-09-01,x,,1']) })).status).toBe(400);
    expect((await imp(['2026-09-01,x,,1'], { currency: 'EUR' })).status).toBe(400);
    expect((await A.post('/bank/statements', { account_id: bank, filename: 'e.csv', content: 'Date,Amount\n' })).status).toBe(400);
    expect((await B.post('/bank/statements', { account_id: bank, filename: 'x.csv', content: csv(['2026-09-01,x,,1']) })).status).toBe(400);
    expect((await viewer.post('/bank/statements', { account_id: bank, filename: 'x.csv', content: csv(['2026-09-01,x,,1']) })).status).toBe(403);
  });
});

describe('matching', () => {
  let c: number;
  beforeAll(async () => { c = await client(); await sql('DELETE FROM bank_transactions WHERE agency_id = ?', [A.agencyId]); await sql('DELETE FROM bank_statements WHERE agency_id = ?', [A.agencyId]); });
  it('auto-matches a unique exact amount/date/reference, and leaves ambiguous lines for a person', async () => {
    await receipt(c, 500, '2026-10-01', 'INVOICE 77'); await receipt(c, 300, '2026-10-02'); await receipt(c, 300, '2026-10-02');
    await imp(['2026-10-01,Transfer INVOICE 77,,500', '2026-10-02,Deposit,,300']);
    const r = await A.post('/bank/auto-match', { account_id: bank }); expect(r.body).toMatchObject({ matched: 1, needs_review: 1 });
    const ts = await txns(); expect(ts.find((x) => x.amount === 500).status).toBe('matched'); expect(ts.find((x) => x.amount === 300).status).toBe('unmatched');
    const sug = (await A.get(`/bank/transactions/${ts.find((x) => x.amount === 300).id}/suggestions`)).body as any[]; expect(sug.length).toBe(2); expect(sug[0].confidence).toBe(sug[1].confidence);
    expect((await A.post('/bank/auto-match', { account_id: bank })).body.matched).toBe(0);                                  // idempotent
  });
  it('flags a matched client receipt as reconciled on the payments record', async () => {
    expect((await sql(`SELECT COUNT(*) n FROM payments WHERE agency_id = ? AND reconciled = 1`, [A.agencyId]))[0].n).toBeGreaterThanOrEqual(0);
    const c2 = await client(), inv = (await A.post('/invoices', { client_id: c2, currency: 'USD', lines: [{ product_type: 'hotel', description: 'x', unit_cost: 100, markup_pct: 0, tax_rate: 0 }] })).body.inv.id;
    await A.post(`/invoices/${inv}/status`, { status: 'reviewed' }); await A.post(`/invoices/${inv}/issue`); await receipt(c2, 100, '2026-10-05', 'PAYREC', [{ invoice_id: inv, amount: 100 }]);
    await imp(['2026-10-05,PAYREC from client,,100']); await A.post('/bank/auto-match', { account_id: bank });
    expect((await sql(`SELECT reconciled FROM payments WHERE agency_id = ? AND invoice_id = ?`, [A.agencyId, inv]))[0].reconciled).toBe(1);
    const t = (await txns()).find((x) => x.description?.startsWith('PAYREC')); await A.post(`/bank/transactions/${t.id}/unmatch`, { reason: 'Matched wrongly' });
    expect((await sql(`SELECT reconciled FROM payments WHERE agency_id = ? AND invoice_id = ?`, [A.agencyId, inv]))[0].reconciled).toBe(0);
  });
  it('a bank line can be matched across several ledger entries (combined deposit)', async () => {
    const c3 = await client(); for (const a of [111, 222, 333]) await receipt(c3, a, '2026-10-10');
    await imp(['2026-10-10,Batch deposit,,666']); const t = (await txns()).find((x) => x.amount === 666), l = (await ledger()).filter((e) => [111, 222, 333].includes(e.remaining));
    const sug = (await A.get(`/bank/transactions/${t.id}/suggestions`)).body as any[]; expect(sug[0]).toMatchObject({ combined: true }); expect(sug[0].entry_ids.length).toBe(3);
    await A.post('/bank/auto-match', { account_id: bank }); expect((await txns()).find((x) => x.id === t.id).status).toBe('unmatched');   // combinations are never applied automatically
    expect((await A.post(`/bank/transactions/${t.id}/match`, { entries: [{ gl_entry_id: l[0].id }, { gl_entry_id: l[1].id }] })).body).toMatchObject({ status: 'partially_matched', unmatched_amount: 333 });
    expect((await A.post(`/bank/transactions/${t.id}/match`, { entries: [{ gl_entry_id: l[2].id }] })).body.status).toBe('matched');
    expect((await txns()).find((x) => x.id === t.id).status).toBe('matched');
  });
  it('a ledger entry can be matched across several bank lines (split payment)', async () => {
    const c4 = await client(); await receipt(c4, 1000, '2026-10-12', 'SPLIT');
    await imp(['2026-10-12,Part 1 SPLIT,,600', '2026-10-13,Part 2 SPLIT,,400']); const [p2, p1] = (await txns()).filter((x) => /SPLIT/.test(x.description)).sort((a, b) => a.amount - b.amount).reverse();
    const e = (await ledger()).find((x) => x.remaining === 1000);
    expect((await A.post(`/bank/transactions/${p1.id}/match`, { entries: [{ gl_entry_id: e.id, amount: 400 }] })).body.status).toBe('matched');
    expect((await A.post(`/bank/transactions/${p2.id}/match`, { entries: [{ gl_entry_id: e.id, amount: 700 }] })).status).toBe(400);   // only 600 left
    expect((await A.post(`/bank/transactions/${p2.id}/match`, { entries: [{ gl_entry_id: e.id, amount: 600 }] })).body.status).toBe('matched');
    expect((await ledger()).some((x) => x.id === e.id)).toBe(false);                                                       // fully matched → leaves the outstanding list
  });
  it('refuses wrong direction, over-matching, foreign entries and double-matching', async () => {
    const c5 = await client(); await receipt(c5, 50, '2026-10-14'); await payOut(60, '2026-10-14');
    await imp(['2026-10-14,Dep,,50', '2026-10-14,Out,,-60']); const dep = (await txns()).find((x) => x.amount === 50), out = (await txns()).find((x) => x.amount === -60), l = await ledger();
    const eIn = l.find((x) => x.remaining === 50), eOut = l.find((x) => x.remaining === -60);
    expect((await A.post(`/bank/transactions/${dep.id}/match`, { entries: [{ gl_entry_id: eOut.id }] })).status).toBe(400);   // money-out entry for a deposit
    expect((await A.post(`/bank/transactions/${out.id}/match`, { entries: [{ gl_entry_id: eIn.id }] })).status).toBe(400);
    expect((await A.post(`/bank/transactions/${dep.id}/match`, { entries: [] })).status).toBe(400);
    const bOnly = (await B.post('/finance/receipts', { client_id: (await client(B)), cash_account_id: bBank, amount: 50, method: 'cash' })).body; void bOnly;
    const bEntry = (await ledger(B, bBank))[0]; expect((await A.post(`/bank/transactions/${dep.id}/match`, { entries: [{ gl_entry_id: bEntry.id }] })).status).toBe(400);
    expect((await A.post(`/bank/transactions/${dep.id}/match`, { entries: [{ gl_entry_id: eIn.id }] })).status).toBe(200);
    expect((await A.post(`/bank/transactions/${dep.id}/match`, { entries: [{ gl_entry_id: eIn.id }] })).status).toBe(409);       // already matched
  });
  it('two simultaneous matches of one ledger entry cannot both succeed', async () => {
    const c6 = await client(); await receipt(c6, 77.7, '2026-10-15'); await imp(['2026-10-15,One,,77.7', '2026-10-15,Two,,77.7']);
    const [t1, t2] = (await txns()).filter((x) => x.amount === 77.7), e = (await ledger()).find((x) => x.remaining === 77.7);
    const rs = await Promise.all([t1, t2].map((t) => A.post(`/bank/transactions/${t.id}/match`, { entries: [{ gl_entry_id: e.id }] })));
    expect(rs.filter((r) => r.status === 200).length).toBe(1); expect(rs.find((r) => r.status !== 200)!.status).toBeGreaterThanOrEqual(400);
    expect((await sql('SELECT COUNT(*) n FROM bank_matches WHERE gl_entry_id = ?', [e.id]))[0].n).toBe(1);
  });
});

describe('differences, receipts from deposits, unmatch & ignore', () => {
  it('a bank fee is booked and matched in one step (reason required, different account required)', async () => {
    await imp(['2026-10-20,Monthly account fee,,-12.50']); const t = (await txns()).find((x) => x.amount === -12.5), before = await bookBal();
    expect((await A.post(`/bank/transactions/${t.id}/match`, { entries: [], adjustment: { account_id: feeAcc, reason: '' } })).status).toBe(400);
    expect((await A.post(`/bank/transactions/${t.id}/match`, { entries: [], adjustment: { account_id: bank, reason: 'fee' } })).status).toBe(400);
    expect((await A.post(`/bank/transactions/${t.id}/match`, { entries: [], adjustment: { account_id: B.agencyId, reason: 'fee' } })).status).toBe(400);
    const r = await A.post(`/bank/transactions/${t.id}/match`, { entries: [], adjustment: { account_id: feeAcc, reason: 'Bank charge' } }); expect(r.body.status).toBe('matched');
    expect(before - (await bookBal())).toBeCloseTo(12.5, 2); const tb = (await A.get('/accounting/trial-balance')).body; expect(tb.debit).toBeCloseTo(tb.credit, 2);
    expect((await sql(`SELECT reason FROM audit_log WHERE agency_id = ? AND entity = 'bank_adjustments' ORDER BY id DESC LIMIT 1`, [A.agencyId]))[0].reason).toBe('Bank charge');
  });
  it('an unmatched deposit can become a client receipt (allocated to the invoice) and is matched, exactly once', async () => {
    const c = await client(), inv = (await A.post('/invoices', { client_id: c, currency: 'USD', lines: [{ product_type: 'hotel', description: 'Trip', unit_cost: 800, markup_pct: 0, tax_rate: 0 }] })).body.inv.id;
    await A.post(`/invoices/${inv}/status`, { status: 'reviewed' }); await A.post(`/invoices/${inv}/issue`);
    await imp(['2026-10-21,Unknown deposit,,800', '2026-10-21,Cash out,,-5']); const dep = (await txns()).find((x) => x.description === 'Unknown deposit'), out = (await txns()).find((x) => x.description === 'Cash out');
    expect((await A.post(`/bank/transactions/${out.id}/create-receipt`, { client_id: c })).status).toBe(400);               // a debit cannot be a receipt
    const r = await A.post(`/bank/transactions/${dep.id}/create-receipt`, { client_id: c, allocations: [{ invoice_id: inv, amount: 800 }] }); expect(r.status).toBe(201);
    expect((await A.get(`/invoices/${inv}`)).body.inv.status).toBe('paid'); expect((await txns()).find((x) => x.id === dep.id).status).toBe('matched');
    const row = (await sql('SELECT receipt_date, cash_account_id FROM receipts WHERE id = ?', [r.body.receipt_id]))[0]; expect(String(row.receipt_date).slice(0, 10)).toBe('2026-10-21'); expect(row.cash_account_id).toBe(bank);
    expect((await A.post(`/bank/transactions/${dep.id}/create-receipt`, { client_id: c })).status).toBe(409);
  });
  it('unmatch and ignore both need a reason, are audited, and ignored lines are not real movements', async () => {
    const c = await client(); await receipt(c, 9, '2026-10-22'); await imp(['2026-10-22,Dup,,9', '2026-10-22,Noise,,13']);
    const t = (await txns()).find((x) => x.amount === 9), n = (await txns()).find((x) => x.amount === 13), e = (await ledger()).find((x) => x.remaining === 9);
    await A.post(`/bank/transactions/${t.id}/match`, { entries: [{ gl_entry_id: e.id }] });
    expect((await A.post(`/bank/transactions/${t.id}/unmatch`, { reason: '' })).status).toBe(400); expect((await A.post(`/bank/transactions/${t.id}/ignore`, { reason: 'dup' })).status).toBe(409); // matched ones can't be ignored
    expect((await A.post(`/bank/transactions/${t.id}/unmatch`, { reason: 'Matched to the wrong receipt' })).status).toBe(200); expect((await txns()).find((x) => x.id === t.id).status).toBe('unmatched');
    expect((await A.post(`/bank/transactions/${n.id}/ignore`, { reason: 'ab' })).status).toBe(400); expect((await A.post(`/bank/transactions/${n.id}/ignore`, { reason: 'Duplicate line in the file' })).status).toBe(200);
    expect((await A.get('/bank/reconciliation?account_id=' + bank)).body.bank_only.some((x: any) => x.id === n.id)).toBe(false);
    expect((await A.post(`/bank/transactions/${n.id}/unignore`)).status).toBe(200);
    expect((await sql(`SELECT reason FROM audit_log WHERE agency_id = ? AND entity = 'bank_matches' ORDER BY id DESC LIMIT 1`, [A.agencyId]))[0].reason).toBe('Matched to the wrong receipt');
  });
  it('voided receipts and their reversals are hidden from the outstanding list (they cancel out)', async () => {
    const c = await client(), r = await receipt(c, 31.37, '2026-10-23'); await A.post(`/finance/receipts/${r.body.id}/void`, { reason: 'Bounced' });
    expect((await ledger()).some((x) => Math.abs(Math.abs(x.remaining) - 31.37) < 0.001)).toBe(false);
    expect(((await A.get(`/bank/ledger?account_id=${bank}&show_reversed=1`)).body as any[]).filter((x) => Math.abs(Math.abs(x.remaining) - 31.37) < 0.001).length).toBe(2);
  });
});

describe('reconcile, finalise and lock', () => {
  let Z: Api, zbank: number, zrent: number, zfee: number, stmt: number;
  const zimp = (rows: string[], extra: Record<string, unknown> = {}) => Z.post('/bank/statements', { account_id: zbank, filename: 'oct.csv', content: csv(rows), ...extra });
  const ztx = async () => (await Z.get(`/bank/transactions?account_id=${zbank}`)).body as any[];
  const zledger = async () => (await Z.get(`/bank/ledger?account_id=${zbank}`)).body as any[];
  beforeAll(async () => {
    Z = await newAgency('Rec'); const lk = (await Z.get('/accounting/lookup?types=110,320')).body as any[]; zbank = lk.find((x) => x.name.includes('Bank')).id; zrent = lk.find((x) => x.name === 'Rent').id;
    zfee = (await Z.post('/accounting/accounts', { type_code: 321, name: 'Bank Charges' })).body.id;
    const c = (await Z.post('/clients', { name: 'Zed', currency: 'USD' })).body.id;
    await Z.post('/finance/receipts', { client_id: c, cash_account_id: zbank, amount: 500, method: 'bank_transfer', receipt_date: '2026-10-01', reference: 'R-500' });
    await Z.post('/vouchers/payments', { cash_account_id: zbank, party_account_id: zrent, amount: 200, voucher_date: '2026-10-02', mode: 'bank' });
    await Z.post('/vouchers/payments', { cash_account_id: zbank, party_account_id: zrent, amount: 75, voucher_date: '2026-10-29', mode: 'cheque', cheque_no: '1001' });   // issued, not yet cleared
  });
  it('shows the classic bank reconciliation: outstanding cheque + bank-only fee explain the difference', async () => {
    stmt = (await zimp(['2026-10-01,Deposit R-500,,500', '2026-10-02,Rent,,-200', '2026-10-31,Account fee,,-10'], { opening_balance: 0, closing_balance: 290 })).body.statement_id;
    const rec = (await Z.get(`/bank/reconciliation?account_id=${zbank}&as_at=2026-10-31`)).body;
    expect(rec).toMatchObject({ book_balance: 225, bank_closing_balance: 290, outstanding_ledger_net: 225, bank_only_net: 290, expected_bank_balance: 290, difference: 0, ok: true });
    expect(rec.outstanding_ledger.length).toBe(3); expect(rec.bank_only.length).toBe(3);               // nothing matched yet: every item is listed on both sides
  });
  it('cannot finalise while lines are unmatched, or when the statement does not add up', async () => {
    const f = await Z.post(`/bank/statements/${stmt}/finalize`); expect(f.status).toBe(409); expect(f.body.error).toMatch(/still unmatched/);
    await Z.post('/bank/auto-match', { account_id: zbank });
    const t = await ztx(), fee = t.find((x) => x.amount === -10);
    await Z.post(`/bank/transactions/${fee.id}/match`, { entries: [], adjustment: { account_id: zfee, reason: 'Account fee' } });
    expect((await Z.put(`/bank/statements/${stmt}`, { opening_balance: 0, closing_balance: 999 })).status).toBe(200);
    expect((await Z.post(`/bank/statements/${stmt}/finalize`)).body.error).toMatch(/does not add up/);
    expect((await Z.put(`/bank/statements/${stmt}`, { opening_balance: 0, closing_balance: 290 })).status).toBe(200);
    expect((await Z.put(`/bank/statements/${stmt}`, { opening_balance: null, closing_balance: null })).status).toBe(200);
    expect((await Z.post(`/bank/statements/${stmt}/finalize`)).body.error).toMatch(/closing balance/);
    await Z.put(`/bank/statements/${stmt}`, { opening_balance: 0, closing_balance: 290 });
  });
  it('finalises when everything agrees (the uncleared cheque stays outstanding), then locks the matches', async () => {
    const rec = (await Z.get(`/bank/reconciliation?account_id=${zbank}&as_at=2026-10-31`)).body; expect(rec.difference).toBe(0); expect(rec.ok).toBe(true); expect(rec.outstanding_ledger.map((x: any) => x.remaining)).toEqual([-75]);
    expect((await Z.post(`/bank/statements/${stmt}/finalize`)).body).toMatchObject({ status: 'reconciled', difference: 0 });
    const t = (await ztx()).find((x) => x.amount === 500);
    expect((await Z.post(`/bank/transactions/${t.id}/unmatch`, { reason: 'try to undo' })).status).toBe(409);
    expect((await Z.post(`/bank/transactions/${t.id}/ignore`, { reason: 'try to hide' })).status).toBe(409);
    expect((await Z.put(`/bank/statements/${stmt}`, { closing_balance: 1 })).status).toBe(409); expect((await Z.post(`/bank/statements/${stmt}/finalize`)).status).toBe(409);
    expect((await Z.get('/bank/accounts')).body.find((x: any) => x.id === zbank).last_reconciled_to).toMatch(/2026-10-31/);
  });
  it('only an admin can reopen, with a reason; reopening unlocks changes and is audited', async () => {
    const fm = await addMember(Z, 'finance_manager'), t = (await ztx()).find((x) => x.amount === 500);
    expect((await fm.post(`/bank/statements/${stmt}/reopen`, { reason: 'Need to fix' })).status).toBe(403); expect((await Z.post(`/bank/statements/${stmt}/reopen`, { reason: 'x' })).status).toBe(400);
    expect((await Z.post(`/bank/statements/${stmt}/reopen`, { reason: 'Receipt matched to wrong line' })).status).toBe(200);
    expect((await Z.post(`/bank/transactions/${t.id}/unmatch`, { reason: 'Re-matching it' })).status).toBe(200);
    expect((await sql(`SELECT reason FROM audit_log WHERE agency_id = ? AND entity = 'bank_statements' ORDER BY id DESC LIMIT 1`, [Z.agencyId]))[0].reason).toBe('Receipt matched to wrong line');
    expect((await Z.post(`/bank/statements/${stmt}/finalize`)).body.error).toMatch(/still unmatched/);                          // and it cannot be re-finalised until the line is matched again
  });
  it('surfaces a disagreement instead of hiding it (opening balances that do not align)', async () => {
    const Y = await newAgency('Align'); const lk = (await Y.get('/accounting/lookup?types=110')).body as any[], yb = lk.find((x: any) => x.name.includes('Bank')).id;
    const c = (await Y.post('/clients', { name: 'Why', currency: 'USD' })).body.id;
    await Y.post('/finance/receipts', { client_id: c, cash_account_id: yb, amount: 100, method: 'cash', receipt_date: '2026-10-05', reference: 'Y100' });
    const s = (await Y.post('/bank/statements', { account_id: yb, filename: 'y.csv', content: csv(['2026-10-05,Y100,,100']), opening_balance: 40, closing_balance: 140 })).body.statement_id;   // bank opened with 40 the books don't know about
    await Y.post('/bank/auto-match', { account_id: yb });
    const f = await Y.post(`/bank/statements/${s}/finalize`); expect(f.status).toBe(409); expect(f.body.error).toMatch(/opening-balance journal/);
    expect((await Y.get(`/bank/reconciliation?account_id=${yb}&as_at=2026-10-31`)).body.opening_alignment).toMatchObject({ bank_opening: 40, book_before: 0, difference: 40 });
  });
});

describe('isolation & roles', () => {
  it('another agency cannot see or act on bank data; viewers can read but not change', async () => {
    const t = (await txns())[0], s = (await A.get(`/bank/statements?account_id=${bank}`)).body[0];
    for (const [m, p, body] of [['GET', `/bank/transactions/${t.id}/suggestions`], ['POST', `/bank/transactions/${t.id}/match`, { entries: [] }], ['POST', `/bank/transactions/${t.id}/ignore`, { reason: 'steal it' }], ['POST', `/bank/transactions/${t.id}/unmatch`, { reason: 'steal it' }],
      ['POST', `/bank/statements/${s.id}/finalize`, {}], ['PUT', `/bank/statements/${s.id}`, { closing_balance: 1 }], ['POST', `/bank/statements/${s.id}/reopen`, { reason: 'steal it' }]] as any[])
      expect([400, 404]).toContain((await B.req(m, p, body)).status);
    expect(((await B.get(`/bank/transactions?account_id=${bank}`)).body as any[]).length).toBe(0); expect((await B.get(`/bank/ledger?account_id=${bank}`)).status).toBe(400);
    expect((await B.get(`/bank/reconciliation?account_id=${bank}`)).status).toBe(400); expect((await B.post('/bank/auto-match', { account_id: bank })).status).toBe(400);
    expect((await viewer.get('/bank/accounts')).status).toBe(200); expect((await viewer.post('/bank/auto-match', { account_id: bank })).status).toBe(403); expect((await viewer.post(`/bank/transactions/${t.id}/ignore`, { reason: 'viewer try' })).status).toBe(403);
  });
});
