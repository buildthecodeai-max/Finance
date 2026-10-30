import { HttpError } from '../errors.js';
import { Tenant } from '../db.js';
import { assertSecondApprover, ensureSys, postVoucher, reverseVoucher } from './accounting.js';
import { Ctx, Rule, ruleAmount, selectRule, splitAmount } from './commission-rules.js';
import { getRateInfo } from './fx.js';
import { r2, today } from './money.js';

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const monthOf = (d: string) => String(d).slice(0, 7);
const periodEnd = (p: string) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
export const nextPeriod = (p: string) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); };
const jsonOf = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);

const REVERSED = ['cancelled', 'refunded', 'lost'], ESTIMATED = ['enquiry', 'quoted', 'awaiting_client', 'on_hold'];
const EDITABLE = ['estimated', 'accrued', 'eligible', 'reversed'];

/** Has the agency's configured trigger been met for this booking? */
async function triggerMet(t: Tenant, b: any, trigger: string): Promise<boolean> {
  if (trigger === 'booking_confirmed') return true;
  if (trigger === 'travel_completed') return ['travel_completed', 'closed'].includes(b.status) || (!!b.travel_end && String(b.travel_end) < today());
  if (trigger === 'client_paid') {
    const r = await t.one(`SELECT COUNT(*) n, COALESCE(SUM(total - amount_credited - amount_paid),0) open_, COALESCE(SUM(total - amount_credited),0) billed FROM invoices
      WHERE agency_id = ? AND booking_id = ? AND status IN ('sent','partially_paid','overdue','paid','credited')`, [t.agencyId, b.id]);
    return r!.n > 0 && r!.billed > 0 && r!.open_ <= 0.005;
  }
  if (trigger === 'supplier_paid') {
    const r = await t.one(`SELECT COUNT(*) n, COALESCE(SUM(total - amount_paid),0) open_ FROM supplier_bills WHERE agency_id = ? AND booking_id = ? AND status <> 'void'`, [t.agencyId, b.id]);
    return r!.n > 0 && r!.open_ <= 0.005;
  }
  return false;
}

async function loadLines(t: Tenant, b: any, base: string) {
  const comps = await t.query('SELECT id, product_type, supplier_id, description, net_total net, cost_total cost, commission_pct FROM booking_components WHERE agency_id = ? AND booking_id = ? ORDER BY id', [t.agencyId, b.id]);
  if (comps.length) {
    const fx = b.currency === base ? 1 : (await getRateInfo(t, b.currency, base, today())).rate;
    return { fx, legacy: false, lines: comps.map((c: any) => ({ ...c, net: r2(c.net * fx), cost: r2(c.cost * fx) })) };
  }
  // pre-R2 bookings: derive from their invoices' lines (already converted at each invoice's locked rate)
  const lines = await t.query(`SELECT l.id, l.product_type, l.supplier_id, l.description, l.line_net * i.fx_rate net, l.unit_cost * l.quantity * i.fx_rate cost, NULL commission_pct
    FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id AND i.agency_id = l.agency_id WHERE l.agency_id = ? AND i.booking_id = ? AND i.status NOT IN ('void','draft','reviewed')`, [t.agencyId, b.id]);
  return { fx: 1, legacy: true, lines: lines.map((c: any) => ({ ...c, net: r2(c.net), cost: r2(c.cost) })) };
}

const fallbackRule = (name: string, pct: number): Rule => ({ id: null, rule_key: null, version: null, name, kind: 'agent', basis: 'pct_margin', rate: pct, fixed_amount: null, tiers: null, deduct_overhead: 1,
  branch_id: null, product_type: null, supplier_id: null, destination: null, agent_id: null, effective_from: null, effective_to: null, priority: -1 });

/**
 * Recalculate commission for one booking: per-component rule selection, overhead allocation, agent splits, supplier commission,
 * lifecycle state, and — for entries already approved/paid — signed adjustments instead of edits.
 */
export async function recalcBooking(t: Tenant, bookingId: number) {
  const b = await t.get('bookings', bookingId);
  if (!b) throw new HttpError(404, 'Booking not found');
  const agency = await t.agency(), base = agency.base_currency, today_ = today(), month = monthOf(today_);
  const rules = (await t.query('SELECT * FROM commission_rules WHERE agency_id = ? AND active = 1', [t.agencyId])) as Rule[];
  const { fx, legacy, lines } = await loadLines(t, b, base);
  const totalNet = r2(lines.reduce((s: number, l: any) => s + l.net, 0)), totalCost = r2(lines.reduce((s: number, l: any) => s + l.cost, 0)), margin = r2(totalNet - totalCost);
  const overhead = r2(b.overhead ?? 0);
  const created = String(b.created_at).slice(0, 10);

  // overhead is shared across lines in proportion to their margin (equally if there is no positive margin)
  const posMargin = lines.reduce((s: number, l: any) => s + Math.max(0, l.net - l.cost), 0);
  const alloc = (l: any) => (lines.length ? r2(posMargin > 0 ? (overhead * Math.max(0, l.net - l.cost)) / posMargin : overhead / lines.length) : 0);

  const primary: number | null = b.agent_id ?? null;
  const member = primary ? await t.one('SELECT default_commission_pct p FROM memberships WHERE agency_id = ? AND user_id = ?', [t.agencyId, primary]) : null;
  const cum = primary ? (await t.one(`SELECT COALESCE(SUM(margin),0) m FROM commission_entries WHERE agency_id = ? AND agent_id = ? AND period = ? AND booking_id <> ? AND status IN ('eligible','approved','paid')`, [t.agencyId, primary, month, bookingId]))!.m + margin : margin;

  // ---- agent commission per line
  let gross = 0; const comps: any[] = []; let anyRule = false, fallbackUsed = false;
  for (const l of lines) {
    const ctx: Ctx = { branch_id: b.branch_id ?? null, product_type: l.product_type, supplier_id: l.supplier_id ?? null, destination: b.destination ?? null, agent_id: primary, date: created };
    let rule = selectRule(rules, ctx, 'agent'), source = 'rule';
    if (!rule && l.supplier_id) {
      const s = await t.get('suppliers', l.supplier_id);
      if (s?.commission_override_pct != null) { rule = fallbackRule(`Supplier override (${s.name})`, s.commission_override_pct); source = 'supplier_override'; }
    }
    if (!rule && member?.p) { rule = fallbackRule('Agent default %', member.p); source = 'agent_default'; }
    const o = alloc(l), lm = r2(l.net - l.cost);
    let amount = 0, rate: number | null = null;
    if (rule) { ({ amount, rate } = ruleAmount(rule, { net: l.net, margin: lm, overhead: o }, cum)); if (source === 'rule') anyRule = true; else fallbackUsed = true; }
    gross = r2(gross + amount);
    comps.push({ id: l.id, type: l.product_type, supplier_id: l.supplier_id, description: l.description, net: l.net, cost: l.cost, margin: lm, overhead_alloc: o, rule_id: rule?.id ?? null, rule_name: rule?.name ?? null, rule_version: rule?.version ?? null, source: rule ? source : 'none', rate, amount });
  }
  const noRule = lines.length > 0 && !anyRule && !fallbackUsed;

  // ---- supplier-paid commission (receivable)
  const bySupplier = new Map<number, { amount: number; items: any[] }>();
  for (const l of lines) {
    if (!l.supplier_id) continue;
    const ctx: Ctx = { branch_id: b.branch_id ?? null, product_type: l.product_type, supplier_id: l.supplier_id, destination: b.destination ?? null, agent_id: null, date: created };
    const rule = selectRule(rules, ctx, 'supplier'); let amt = 0;
    if (rule) amt = ruleAmount(rule, { net: l.net, margin: r2(l.net - l.cost), overhead: 0 }).amount;
    else if (l.commission_pct) amt = r2((l.net * l.commission_pct) / 100);
    if (!amt) continue;
    const e = bySupplier.get(l.supplier_id) ?? { amount: 0, items: [] }; e.amount = r2(e.amount + amt); e.items.push({ line: l.id, amount: amt, rule: rule?.name ?? 'component commission %' }); bySupplier.set(l.supplier_id, e);
  }
  const state = REVERSED.includes(b.status) || b.archived_at ? 'reversed' : ESTIMATED.includes(b.status) ? 'estimated' : 'accrued';
  const eligible = state === 'accrued' && (await triggerMet(t, b, agency.commission_trigger));
  const existingSupp = await t.query('SELECT * FROM supplier_commissions WHERE agency_id = ? AND booking_id = ?', [t.agencyId, bookingId]);
  for (const [sid, v] of bySupplier) {
    const ex = existingSupp.find((e: any) => e.supplier_id === sid);
    if (!ex) await t.insert('supplier_commissions', { booking_id: bookingId, supplier_id: sid, amount: v.amount, status: state === 'reversed' ? 'void' : 'expected', calc_json: JSON.stringify(v.items) });
    else if (ex.status !== 'received') await t.update('supplier_commissions', ex.id, { amount: v.amount, status: state === 'reversed' ? 'void' : 'expected', calc_json: JSON.stringify(v.items) });
  }
  for (const ex of existingSupp) if (!bySupplier.has(ex.supplier_id) && ex.status === 'expected') await t.update('supplier_commissions', ex.id, { status: 'void' });
  const suppTotal = r2([...bySupplier.values()].reduce((s, v) => s + v.amount, 0));

  // ---- agent entries (splits)
  const splitRows = await t.query('SELECT agent_id, pct FROM commission_splits WHERE agency_id = ? AND booking_id = ?', [t.agencyId, bookingId]);
  const splits: { agent_id: number; pct: number }[] = splitRows.length ? splitRows : primary ? [{ agent_id: primary, pct: 100 }] : [];
  const shares = splits.length ? splitAmount(gross, splits.map((s) => s.pct)) : [];
  const existing = await t.query('SELECT * FROM commission_entries WHERE agency_id = ? AND booking_id = ?', [t.agencyId, bookingId]);
  const seen = new Set<number>(); const out: any[] = [];

  for (let i = 0; i < splits.length; i++) {
    const sp = splits[i]; seen.add(sp.agent_id);
    const ex = existing.find((e: any) => e.agent_id === sp.agent_id);
    const computed = shares[i], amount = ex?.override_amount != null ? ex.override_amount : computed;
    const calc = { booking_status: b.status, trigger: agency.commission_trigger, legacy_invoice_lines: legacy, currency: base, fx_to_base: fx, split_pct: sp.pct, primary_agent_id: primary, overhead, margin, gross_before_split: gross, computed_share: computed,
      override: ex?.override_amount != null ? { amount: ex.override_amount, reason: ex.override_reason } : null, tier_cumulative_margin: cum, components: comps };
    const summary = [...new Set(comps.map((c) => (c.rule_name ? `${c.rule_name}${c.rule_version ? ` v${c.rule_version}` : ''}` : 'no rule')))].join(', ').slice(0, 300);
    const target = state === 'reversed' ? 'reversed' : state === 'estimated' ? 'estimated' : eligible ? 'eligible' : 'accrued';
    const flags = [noRule && amount === 0 ? 'no_rule' : '', ex?.override_amount != null ? 'override' : ''].filter(Boolean).join(',') || null;
    const base_ = { split_pct: sp.pct, selling_net: totalNet, supplier_cost: totalCost, overhead_alloc: overhead, margin, gross_amount: gross, calc_json: JSON.stringify(calc), rule_summary: summary, flags };

    if (!ex) {
      if (state === 'reversed') continue;
      const id = await t.insert('commission_entries', { booking_id: bookingId, agent_id: sp.agent_id, ...base_, amount, status: target, ...(target === 'eligible' ? { eligible_at: nowSql(), period: month } : {}) });
      out.push({ id, agent_id: sp.agent_id, amount, status: target }); continue;
    }
    if (EDITABLE.includes(ex.status)) {
      const upd: Record<string, any> = { ...base_, amount, status: target };
      if (target === 'eligible') { if (ex.status !== 'eligible') { upd.eligible_at = nowSql(); upd.period = month; } } else { upd.eligible_at = null; upd.period = null; }
      await t.update('commission_entries', ex.id, upd); out.push({ id: ex.id, agent_id: sp.agent_id, amount, status: target }); continue;
    }
    // approved / paid: history is immutable — express any change as a signed adjustment in the current period
    await syncAdjustments(t, ex, amount, state === 'reversed', month);
    out.push({ id: ex.id, agent_id: sp.agent_id, amount: ex.amount, status: ex.status });
  }
  for (const ex of existing) {   // an agent who is no longer on the booking
    if (seen.has(ex.agent_id)) continue;
    if (EDITABLE.includes(ex.status)) await t.update('commission_entries', ex.id, { status: 'reversed', eligible_at: null, period: null, flags: 'removed_from_split' });
    else await syncAdjustments(t, ex, 0, true, month);
  }

  // ---- booking-level summary (kept for dashboards/reports)
  const active = (await t.query(`SELECT status, amount FROM commission_entries WHERE agency_id = ? AND booking_id = ? AND status <> 'reversed'`, [t.agencyId, bookingId]));
  const agentTotal = r2(active.reduce((s: number, e: any) => s + e.amount, 0));
  const row = { booking_id: bookingId, agent_id: primary, period: month, selling_price: totalNet, supplier_cost: totalCost, overhead, net_commission: r2(margin - overhead), agent_amount: agentTotal,
    supplier_commission: suppTotal, net_agency_margin: r2(margin - overhead + suppTotal - agentTotal), status: active.length && active.every((e: any) => ['approved', 'paid'].includes(e.status)) ? 'closed' : 'accrued' };
  const sum = await t.one('SELECT id, period FROM commissions WHERE agency_id = ? AND booking_id = ?', [t.agencyId, bookingId]);
  if (sum) await t.update('commissions', sum.id, { ...row, period: sum.period }); else await t.insert('commissions', row);
  return { ...row, gross_agent_commission: gross, entries: out, no_rule: noRule };
}

/** After approval, corrections are separate signed rows; idempotent because the delta is measured against existing adjustments. */
async function syncAdjustments(t: Tenant, entry: any, newAmount: number, reversed: boolean, month: string) {
  const adj = await t.query(`SELECT * FROM commission_adjustments WHERE agency_id = ? AND entry_id = ? AND status <> 'void'`, [t.agencyId, entry.id]);
  const claw = adj.find((a: any) => a.kind === 'clawback'), recalc = r2(adj.filter((a: any) => a.kind === 'recalc').reduce((s: number, a: any) => s + a.amount, 0));
  if (reversed) {
    if (!claw && r2(entry.amount + recalc) !== 0) await t.insert('commission_adjustments', { entry_id: entry.id, agent_id: entry.agent_id, period: month, amount: -r2(entry.amount + recalc), kind: 'clawback', reason: 'Booking cancelled or refunded after commission was approved' });
    return;
  }
  if (claw && claw.status === 'open') await t.update('commission_adjustments', claw.id, { status: 'void' });   // booking reinstated before the clawback was approved
  if (claw && claw.status !== 'open') return;                                                               // clawback already settled: no automatic re-grant
  if (entry.override_amount != null) return;
  const delta = r2(newAmount - (entry.amount + recalc));
  if (Math.abs(delta) >= 0.01) await t.insert('commission_adjustments', { entry_id: entry.id, agent_id: entry.agent_id, period: month, amount: delta, kind: 'recalc', reason: 'Recalculated after the booking changed' });
}

/** Recalculate every booking that can still affect a payout. Per-booking failures (e.g. a missing FX rate) are reported, not fatal. */
export async function refreshAll(t: Tenant) {
  const rows = await t.query(`SELECT b.id FROM bookings b WHERE b.agency_id = ? AND (b.status NOT IN ('lost') OR EXISTS (SELECT 1 FROM commission_entries e WHERE e.agency_id = b.agency_id AND e.booking_id = b.id)) ORDER BY b.id LIMIT 2000`, [t.agencyId]);
  let ok = 0; const errors: string[] = [];
  for (const r of rows) { try { await recalcBooking(t, r.id); ok++; } catch (e: any) { errors.push(`booking #${r.id}: ${e.message}`); } }
  return { recalculated: ok, errors };
}

/** Best-effort hook for edit paths: never let a commission problem block a booking/finance operation. */
export async function safeRecalc(t: Tenant, bookingId: number | null | undefined) {
  if (!bookingId) return; try { await recalcBooking(t, bookingId); } catch { /* surfaced via Refresh */ }
}

/* =========================================================== period workflow */

export async function periodView(t: Tenant, period: string, agentId?: number) {
  const scope = agentId ? ' AND agent_id = ?' : '', sp = agentId ? [agentId] : [];
  const entries = await t.query(`SELECT e.*, b.reference, b.destination, u.name agent_name FROM commission_entries e JOIN bookings b ON b.id = e.booking_id AND b.agency_id = e.agency_id LEFT JOIN users u ON u.id = e.agent_id
    WHERE e.agency_id = ? AND e.period = ? AND e.status IN ('eligible','approved','paid')${scope.replace('agent_id', 'e.agent_id')} ORDER BY e.agent_id, e.id`, [t.agencyId, period, ...sp]);
  const adjustments = await t.query(`SELECT a.*, u.name agent_name FROM commission_adjustments a LEFT JOIN users u ON u.id = a.agent_id WHERE a.agency_id = ? AND a.status <> 'void' AND ((a.status = 'open' AND a.period <= ?) OR a.period = ?)${scope.replace('agent_id', 'a.agent_id')} ORDER BY a.agent_id, a.id`, [t.agencyId, period, period, ...sp]);
  const row = await t.one('SELECT * FROM commission_periods WHERE agency_id = ? AND period = ?', [t.agencyId, period]);
  const agents = new Map<number, { agent_id: number; agent_name: string; entries: number; commission: number; adjustments: number; net: number }>();
  const get = (id: number, name: string) => { if (!agents.has(id)) agents.set(id, { agent_id: id, agent_name: name, entries: 0, commission: 0, adjustments: 0, net: 0 }); return agents.get(id)!; };
  for (const e of entries) { const a = get(e.agent_id, e.agent_name); a.entries++; a.commission = r2(a.commission + e.amount); a.net = r2(a.net + e.amount); }
  for (const x of adjustments) { const a = get(x.agent_id, x.agent_name); a.adjustments = r2(a.adjustments + x.amount); a.net = r2(a.net + x.amount); }
  const exceptions: { severity: 'blocking' | 'warning'; message: string; ref?: string }[] = [];
  for (const e of entries.filter((x: any) => x.status === 'eligible')) if ((e.flags ?? '').includes('no_rule')) exceptions.push({ severity: 'blocking', message: `${e.reference}: no commission rule or default applies (amount 0). Add a rule or set an override.`, ref: `entry:${e.id}` });
  const waiting = await t.one(`SELECT COUNT(*) n FROM commission_entries WHERE agency_id = ? AND status IN ('estimated','accrued')`, [t.agencyId]);
  if (waiting!.n) exceptions.push({ severity: 'warning', message: `${waiting!.n} commission(s) are not yet eligible and roll forward until their trigger is met.` });
  for (const a of agents.values()) if (a.net < 0) exceptions.push({ severity: 'warning', message: `${a.agent_name}: net is negative (${a.net}); it will be carried forward, not paid.` });
  const ledgerTotal = r2(entries.filter((e: any) => e.status === 'eligible').reduce((s: number, e: any) => s + e.amount, 0) + adjustments.filter((x: any) => x.kind !== 'carry_forward' && x.status === 'open').reduce((s: number, x: any) => s + x.amount, 0));
  return { period, status: row?.status ?? 'open', record: row ?? null, entries, adjustments, agents: [...agents.values()], exceptions, blocking: exceptions.filter((x) => x.severity === 'blocking').length, total: r2([...agents.values()].reduce((s, a) => s + a.net, 0)), ledger_total_if_approved: ledgerTotal };
}

async function periodRow(tx: Tenant, period: string) {
  let row = (await tx.query('SELECT * FROM commission_periods WHERE agency_id = ? AND period = ? FOR UPDATE', [tx.agencyId, period]))[0];
  if (!row) { await tx.insert('commission_periods', { period, status: 'open' }); row = (await tx.query('SELECT * FROM commission_periods WHERE agency_id = ? AND period = ? FOR UPDATE', [tx.agencyId, period]))[0]; }
  return row;
}

export async function submitPeriod(t: Tenant, period: string) {
  await refreshAll(t);
  const v = await periodView(t, period);
  if (v.blocking) throw new HttpError(409, `Resolve ${v.blocking} blocking exception(s) first: ${v.exceptions.filter((e) => e.severity === 'blocking').map((e) => e.message).join(' ')}`);
  if (!v.entries.length && !v.adjustments.length) throw new HttpError(409, 'Nothing to approve in this period');
  return t.tx(async (tx) => {
    const row = await periodRow(tx, period);
    if (!['open', 'submitted'].includes(row.status)) throw new HttpError(409, `Period is ${row.status}`);
    await tx.update('commission_periods', row.id, { status: 'submitted', submitted_by: tx.actor.userId, submitted_at: nowSql(), total_amount: v.total });
    return { status: 'submitted', total: v.total };
  });
}

export async function approvePeriod(t: Tenant, period: string, overrideReason?: string) {
  return t.tx(async (tx) => {
    const row = await periodRow(tx, period);
    if (row.status !== 'submitted') throw new HttpError(409, row.status === 'open' ? 'Submit the period for approval first' : `Period is already ${row.status}`);
    const v = await periodView(tx, period);
    if (v.blocking && !(overrideReason && overrideReason.trim().length >= 3)) throw new HttpError(409, 'Blocking exceptions remain; provide an override reason to approve anyway');
    await assertSecondApprover(tx, Math.abs(v.total), row.submitted_by, tx.actor.userId!, 'A commission period');
    const ents = v.entries.filter((e: any) => e.status === 'eligible'), adjs = v.adjustments.filter((a: any) => a.status === 'open');
    const total = r2(ents.reduce((s: number, e: any) => s + e.amount, 0) + adjs.filter((a: any) => a.kind !== 'carry_forward').reduce((s: number, a: any) => s + a.amount, 0));
    let vid: number | null = null;
    if (Math.abs(total) >= 0.005) {
      const end = periodEnd(period), date = end > today() ? today() : end;
      vid = await postVoucher(tx, { type: 'commission', date, narration: `Agent commission ${period}`, ref_table: 'commission_periods', ref_id: row.id,
        legs: [{ account_id: await ensureSys(tx, 'agent_commission_expense'), debit: total }, { account_id: await ensureSys(tx, 'commission_payable'), credit: total }] });
    }
    for (const e of ents) await tx.update('commission_entries', e.id, { status: 'approved', approved_at: nowSql(), approved_by: tx.actor.userId, voucher_id: vid });
    for (const a of adjs) await tx.update('commission_adjustments', a.id, { status: 'approved', voucher_id: vid, period });
    await tx.update('commission_periods', row.id, { status: 'approved', approved_by: tx.actor.userId, approved_at: nowSql(), total_amount: v.total, voucher_id: vid, override_reason: overrideReason ?? null });
    return { status: 'approved', total: v.total, voucher_id: vid };
  });
}

export async function reopenPeriod(t: Tenant, period: string, reason: string) {
  return t.tx(async (tx) => {
    const row = await periodRow(tx, period);
    if (row.status !== 'approved') throw new HttpError(409, row.status === 'paid' ? 'A paid period cannot be reopened — post adjustments instead' : `Period is ${row.status}`);
    if (row.voucher_id) await reverseVoucher(tx, row.voucher_id, today(), `Commission period ${period} reopened: ${reason}`);
    await tx.query(`UPDATE commission_entries SET status = 'eligible', approved_at = NULL, approved_by = NULL, voucher_id = NULL WHERE agency_id = ? AND period = ? AND status = 'approved'`, [tx.agencyId, period]);
    await tx.query(`UPDATE commission_adjustments SET status = 'open', voucher_id = NULL WHERE agency_id = ? AND period = ? AND status = 'approved'`, [tx.agencyId, period]);
    await tx.update('commission_periods', row.id, { status: 'open', approved_by: null, approved_at: null, voucher_id: null, reopened_reason: reason });
    await tx.event('update', 'commission_periods', row.id, { status: 'approved' }, { status: 'open' }, reason);
    return { status: 'open' };
  });
}

/** Pay approved commission. Agents whose net is not positive are not paid; the negative balance is carried into the next period. */
export async function payPeriod(t: Tenant, period: string, input: { cash_account_id: number; date?: string }) {
  const cash = await t.get('accounts', input.cash_account_id);
  if (!cash || cash.type_code !== 110) { await t.ref('accounts', input.cash_account_id, 'cash account'); throw new HttpError(400, 'Pay from a cash/bank account'); }
  return t.tx(async (tx) => {
    const row = await periodRow(tx, period);
    if (row.status !== 'approved') throw new HttpError(409, row.status === 'paid' ? 'Already paid' : 'Approve the period before paying');
    const ents = await tx.query(`SELECT * FROM commission_entries WHERE agency_id = ? AND period = ? AND status = 'approved'`, [tx.agencyId, period]);
    const adjs = await tx.query(`SELECT * FROM commission_adjustments WHERE agency_id = ? AND period = ? AND status = 'approved'`, [tx.agencyId, period]);
    const net = new Map<number, number>();
    for (const e of ents) net.set(e.agent_id, r2((net.get(e.agent_id) ?? 0) + e.amount));
    for (const a of adjs) net.set(a.agent_id, r2((net.get(a.agent_id) ?? 0) + a.amount));
    let pay = 0; const carried: { agent_id: number; amount: number }[] = [];
    for (const [agent, n] of net) { if (n > 0.005) pay = r2(pay + n); else if (n < -0.005) carried.push({ agent_id: agent, amount: n }); }
    const date = input.date ?? today(); let vid: number | null = null;
    if (pay > 0) vid = await postVoucher(tx, { type: 'payment', date, narration: `Commission payout ${period}`, ref_table: 'commission_periods', ref_id: row.id,
      legs: [{ account_id: await ensureSys(tx, 'commission_payable'), debit: pay }, { account_id: input.cash_account_id, credit: pay }] });
    for (const e of ents) await tx.update('commission_entries', e.id, { status: 'paid', paid_at: nowSql() });
    for (const a of adjs) await tx.update('commission_adjustments', a.id, { status: 'paid' });
    for (const c of carried) await tx.insert('commission_adjustments', { agent_id: c.agent_id, period: nextPeriod(period), amount: c.amount, kind: 'carry_forward', reason: `Negative balance carried forward from ${period}` });
    await tx.update('commission_periods', row.id, { status: 'paid', paid_at: nowSql(), pay_voucher_id: vid });
    return { status: 'paid', paid: pay, carried_forward: carried };
  });
}
