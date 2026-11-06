import { Router } from 'express';
import { scope } from './scope.js';
import { T } from './util.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', async (req, res) => {
  const t = T(req), a = t.agencyId;
  const monthly = (sql: string) => t.query<{ m: string; v: number }>(sql, [a]);
  const [rev, book, comm, ar, recent, aging, byType, expenses, activity] = await Promise.all([
    monthly(`SELECT DATE_FORMAT(issue_date,'%Y-%m') m, SUM(subtotal*fx_rate) v FROM invoices WHERE agency_id = ? AND status NOT IN ('draft','void') AND issue_date >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH) GROUP BY m ORDER BY m`),
    monthly(`SELECT DATE_FORMAT(issue_date,'%Y-%m') m, SUM(total*fx_rate) v FROM invoices WHERE agency_id = ? AND status <> 'void' AND issue_date >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH) GROUP BY m ORDER BY m`),
    monthly(`SELECT period m, SUM(net_commission) v FROM commissions WHERE agency_id = ? GROUP BY period ORDER BY period DESC LIMIT 12`),
    t.query(`SELECT COALESCE(SUM((total-amount_credited-amount_paid)*fx_rate),0) v FROM invoices WHERE agency_id = ? AND status IN ('sent','partially_paid','overdue')`, [a]),
    t.query(`SELECT i.id, i.number, i.status, i.total, i.currency, i.due_date, c.name client FROM invoices i JOIN clients c ON c.id=i.client_id AND c.agency_id=i.agency_id WHERE i.agency_id = ? ORDER BY i.id DESC LIMIT 8`, [a]),
    t.query(`SELECT SUM(CASE WHEN due_date >= CURDATE() THEN b ELSE 0 END) current_, SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) BETWEEN 1 AND 30 THEN b ELSE 0 END) d30,
      SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) BETWEEN 31 AND 60 THEN b ELSE 0 END) d60, SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) > 60 THEN b ELSE 0 END) d90
      FROM (SELECT due_date, (total-amount_credited-amount_paid)*fx_rate b, agency_id FROM invoices WHERE status IN ('sent','partially_paid','overdue')) x WHERE agency_id = ?`, [a]),
    t.query(`SELECT l.product_type type, SUM(l.line_net*i.fx_rate) v FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id AND i.agency_id=l.agency_id WHERE l.agency_id = ? AND i.status NOT IN ('draft','void') GROUP BY l.product_type ORDER BY v DESC`, [a]),
    t.query(`SELECT category, SUM(amount*fx_rate) v FROM expenses WHERE agency_id = ? AND incurred_on >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) GROUP BY category ORDER BY v DESC`, [a]),
    t.query(`SELECT a.id, a.action, a.entity, a.entity_id, a.created_at, u.name user FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.agency_id = ? AND a.entity IN ('invoices','payments','payment_runs','commissions','clients','suppliers') ORDER BY a.id DESC LIMIT 12`, [a]),
  ]);
  // "What needs doing" counts. Agents only see their own records, and never agency-wide money.
  const agent = req.ctx!.role === 'agent', qs = scope(req, 'q'), bs = scope(req, 'b', { owner: 'agent_id' }), vs = scope(req, 'v', { owner: 'owner_id' });
  const one = async (sql: string, params: any[]) => (await t.one<any>(sql, params)) ?? {};
  const ls = scope(req, 'l');
  const [qt, bk, inv, visa, task, counts, lead] = await Promise.all([
    one(`SELECT SUM(q.status = 'accepted') accepted, SUM(q.status = 'changes_requested') changes, SUM(q.status = 'sent' AND q.valid_until BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)) expiring
         FROM quotes q WHERE q.agency_id = ?${qs.sql}`, [a, ...qs.params]),
    one(`SELECT COUNT(*) n FROM bookings b WHERE b.agency_id = ?${bs.sql} AND b.archived_at IS NULL AND b.status = 'confirmed' AND b.travel_start BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)`, [a, ...bs.params]),
    agent ? Promise.resolve({}) : one(`SELECT SUM(status IN ('sent','partially_paid','overdue') AND due_date < CURDATE()) overdue_n,
         COALESCE(SUM(CASE WHEN status IN ('sent','partially_paid','overdue') AND due_date < CURDATE() THEN (total-amount_credited-amount_paid)*fx_rate END), 0) overdue_amt, SUM(status = 'reviewed') ready, SUM(status = 'draft') drafts
         FROM invoices WHERE agency_id = ?`, [a]),
    one(`SELECT COUNT(*) n FROM visa_applications v WHERE v.agency_id = ?${vs.sql} AND v.status IN ('submitted','in_process') AND v.expected_on < CURDATE()`, [a, ...vs.params]),
    one(`SELECT COUNT(*) n FROM tasks k WHERE k.agency_id = ? AND k.status = 'open' AND k.due_at < CURDATE() ${agent ? 'AND k.owner_id = ?' : ''}`, [a, ...(agent ? [req.ctx!.userId] : [])]),
    one(`SELECT (SELECT COUNT(*) FROM clients WHERE agency_id = ? AND archived_at IS NULL) clients, (SELECT COUNT(*) FROM quotes WHERE agency_id = ?) quotes,
                (SELECT COUNT(*) FROM bookings WHERE agency_id = ? AND archived_at IS NULL) bookings, (SELECT COUNT(*) FROM invoices WHERE agency_id = ?) invoices`, [a, a, a, a]),
    one(`SELECT COUNT(*) n FROM leads l WHERE l.agency_id = ?${ls.sql} AND l.stage NOT IN ('won','lost') AND l.next_action_at IS NOT NULL AND l.next_action_at <= CURDATE()`, [a, ...ls.params]),
  ]);
  const n = (v: any) => Number(v ?? 0);
  const attention = { quotes_accepted: n(qt.accepted), quotes_changes: n(qt.changes), quotes_expiring: n(qt.expiring), departing_7d: n(bk.n), overdue_invoices: n(inv.overdue_n), overdue_amount: n(inv.overdue_amt), invoices_ready: n(inv.ready), invoices_draft: n(inv.drafts), visas_late: n(visa.n), tasks_overdue: n(task.n), leads_due: n(lead.n) };
  const series = (rows: { m: string; v: number }[]) => [...rows].sort((x, y) => x.m.localeCompare(y.m)).map((r) => r.v);
  const total = (rows: { v: number }[]) => rows.reduce((s, r) => s + r.v, 0);
  res.json({
    kpis: {
      revenue: { value: total(rev), trend: series(rev) },
      bookings: { value: total(book), trend: series(book) },
      outstandingAr: { value: ar[0].v, trend: [] },
      netCommission: { value: total(comm), trend: series(comm) },
    },
    attention, counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, n(v)])), recentInvoices: recent, arAging: aging[0], revenueByType: byType, expenses, activity,
  });
});
