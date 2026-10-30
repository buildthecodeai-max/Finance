/**
 * Pure commission rule logic (no database). Kept separate so the maths can be unit-tested and so a historical result can
 * always be reproduced from the stored rule version + inputs.
 */
export interface Rule {
  id: number | null; rule_key: string | null; version: number | null; name: string; kind: 'agent' | 'supplier';
  basis: 'pct_selling' | 'pct_margin' | 'fixed'; rate: number | null; fixed_amount: number | null; tiers: { from: number; rate: number }[] | string | null; deduct_overhead: number | boolean;
  branch_id: number | null; product_type: string | null; supplier_id: number | null; destination: string | null; agent_id: number | null;
  effective_from: string | null; effective_to: string | null; priority: number; active?: number | boolean;
}
export interface Ctx { branch_id: number | null; product_type: string; supplier_id: number | null; destination: string | null; agent_id: number | null; date: string }

const SCOPE = ['branch_id', 'product_type', 'supplier_id', 'destination', 'agent_id'] as const;
const d10 = (s: string | null) => (s ? String(s).slice(0, 10) : null);
const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);

/** A rule applies when it is active, the date is inside its window, and EVERY scope field it specifies equals the context. */
export function matches(r: Rule, c: Ctx): boolean {
  if (r.active === 0 || r.active === false) return false;
  const from = d10(r.effective_from), to = d10(r.effective_to), day = d10(c.date)!;
  if ((from && day < from) || (to && day > to)) return false;
  return SCOPE.every((k) => r[k] === null || r[k] === undefined || norm(r[k]) === norm(c[k]));
}

/** More specific rules (more scope fields) beat general ones; then explicit priority; then the newest version. */
export const specificity = (r: Rule) => SCOPE.filter((k) => r[k] !== null && r[k] !== undefined).length;

export function selectRule(rules: Rule[], c: Ctx, kind: 'agent' | 'supplier' = 'agent'): Rule | undefined {
  return rules.filter((r) => r.kind === kind && matches(r, c))
    .sort((a, b) => specificity(b) - specificity(a) || b.priority - a.priority || (b.version ?? 0) - (a.version ?? 0) || (b.id ?? 0) - (a.id ?? 0))[0];
}

export const parseTiers = (t: Rule['tiers']): { from: number; rate: number }[] => {
  const arr = typeof t === 'string' ? JSON.parse(t) : t;
  return Array.isArray(arr) ? [...arr].sort((a, b) => a.from - b.from) : [];
};

/** Tiered target: the rate of the highest tier whose threshold the agent's cumulative period margin has reached. */
export function tierRate(tiers: Rule['tiers'], cumulativeMargin: number, fallback = 0): number {
  const ts = parseTiers(tiers); let rate = fallback;
  for (const t of ts) if (cumulativeMargin >= t.from) rate = t.rate;
  return rate;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Commission for one component line. Margin should already be net of allocated overhead when the rule deducts it. */
export function ruleAmount(r: Rule, line: { net: number; margin: number; overhead: number }, cumulativeMargin = 0): { amount: number; rate: number | null } {
  const tiered = r.tiers && parseTiers(r.tiers).length > 0;
  const rate = tiered ? tierRate(r.tiers, cumulativeMargin, r.rate ?? 0) : r.rate;
  if (r.basis === 'fixed') return { amount: r2(r.fixed_amount ?? 0), rate: null };
  const base = r.basis === 'pct_selling' ? line.net : Math.max(0, line.margin - (r.deduct_overhead ? line.overhead : 0));
  return { amount: r2((base * (rate ?? 0)) / 100), rate: rate ?? 0 };
}

/** Split an amount by percentages so the parts sum EXACTLY to the whole (remainder goes to the largest share). */
export function splitAmount(total: number, pcts: number[]): number[] {
  const sum = pcts.reduce((s, p) => s + p, 0);
  if (Math.abs(sum - 100) > 0.005) throw new Error('Split percentages must total 100');
  const parts = pcts.map((p) => r2((total * p) / 100)), diff = r2(total - parts.reduce((x, y) => x + y, 0));
  const k = pcts.indexOf(Math.max(...pcts)); parts[k] = r2(parts[k] + diff); // rounding remainder goes to the largest share
  return parts;
}
