import { HttpError } from '../errors.js';

export interface PayeeRow { name: string; amount: number; reference: string | null; bd: Record<string, any> }
export type BankFormat = 'aba' | 'ach';
export const FORMAT_CURRENCY: Record<BankFormat, string> = { aba: 'AUD', ach: 'USD' };

const pad = (s: unknown, n: number) => String(s ?? '').slice(0, n).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n, '0');
const cents = (n: number) => Math.round(n * 100);
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** US ABA routing-number checksum (3·d1+7·d2+d3 …) mod 10 = 0. */
export const validRouting = (r: unknown) => { const d = digits(r); if (d.length !== 9) return false; const w = [3, 7, 1, 3, 7, 1, 3, 7, 1]; return d.split('').reduce((s, c, i) => s + Number(c) * w[i], 0) % 10 === 0; };

/** Problems that would make the bank reject this payee for the given format (empty array = fine). */
export function payeeProblems(format: BankFormat, p: PayeeRow): string[] {
  const out: string[] = [], acct = digits(p.bd.account_number);
  if (!acct) out.push('no account number');
  if (format === 'aba') { if (digits(p.bd.bsb).length !== 6) out.push('BSB must be 6 digits'); if (acct.length > 9) out.push('account number longer than 9 digits'); }
  else { if (!validRouting(p.bd.routing)) out.push('routing number is missing or fails its checksum'); if (acct.length > 17) out.push('account number longer than 17 digits'); }
  if (!(p.amount > 0)) out.push('amount must be positive');
  return out;
}

/**
 * Bank file text. ABA (Australian Direct Entry, 120-char records) and ACH (NACHA PPD credits).
 * Callers must have validated payees; this throws rather than emit a file the bank would reject.
 */
export function buildBankFile(format: BankFormat, company: string, payees: PayeeRow[], date: string): { body: string; ext: string; total: number } {
  if (!payees.length) throw new HttpError(400, 'Nothing to export');
  for (const p of payees) { const prob = payeeProblems(format, p); if (prob.length) throw new HttpError(409, `${p.name}: ${prob.join(', ')}`); }
  const [y, m, d] = date.split('-'), total = payees.reduce((s, p) => s + cents(p.amount), 0);
  if (format === 'aba') {
    const lines = [`0${pad('', 17)}01${pad('NAB', 3)}${pad('', 7)}${pad(company, 26)}${lpad('000000', 6)}${pad('PAYMENTS', 12)}${d}${m}${y.slice(2)}${pad('', 40)}`];
    for (const p of payees) {
      const bsb = digits(p.bd.bsb).padStart(6, '0'), bsbF = `${bsb.slice(0, 3)}-${bsb.slice(3)}`, acct = pad(digits(p.bd.account_number), 9).padStart(9);
      lines.push(`1${bsbF}${acct} 50${lpad(cents(p.amount), 10)}${pad(p.name, 32)}${pad(p.reference ?? '', 18)}${bsbF}${acct}${pad(company, 16)}${lpad(0, 8)}`);
    }
    lines.push(`7999-999${pad('', 12)}${lpad(total, 10)}${lpad(total, 10)}${lpad(0, 10)}${pad('', 24)}${lpad(payees.length, 6)}${pad('', 40)}`);
    return { body: lines.join('\r\n'), ext: 'aba', total: total / 100 };
  }
  const dt = `${y.slice(2)}${m}${d}`, hash = payees.reduce((s, p) => s + Number(digits(p.bd.routing).slice(0, 8)), 0) % 1e10;
  const lines = [
    `101 000000000 000000000${dt}0000A094101${pad('ODFI', 23)}${pad(company, 23)}${pad('', 8)}`,
    `5200${pad(company, 16)}${pad('', 20)}0000000000PPDPAYMENT   ${dt}${dt}   1000000000000001`,
    ...payees.map((p, n) => `622${digits(p.bd.routing)}${pad(digits(p.bd.account_number), 17)}${lpad(cents(p.amount), 10)}${pad(p.reference ?? p.name, 15)}${pad(p.name, 22)}  0000000000${lpad(n + 1, 6)}`),
    `8200${lpad(payees.length, 6)}${lpad(hash, 10)}${lpad(0, 12)}${lpad(total, 12)}0000000000${pad('', 25)}000000000000001`,
    `9000001000001${lpad(payees.length, 8)}${lpad(hash, 10)}${lpad(0, 12)}${lpad(total, 12)}${pad('', 39)}`,
  ];
  return { body: lines.join('\r\n'), ext: 'ach', total: total / 100 };
}
