import { Router } from 'express';
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
  const series = (rows: { m: string; v: number }[]) => [...rows].sort((x, y) => x.m.localeCompare(y.m)).map((r) => r.v);
  const total = (rows: { v: number }[]) => rows.reduce((s, r) => s + r.v, 0);
  res.json({
    kpis: {
      revenue: { value: total(rev), trend: series(rev) },
      bookings: { value: total(book), trend: series(book) },
      outstandingAr: { value: ar[0].v, trend: [] },
      netCommission: { value: total(comm), trend: series(comm) },
    },
    recentInvoices: recent, arAging: aging[0], revenueByType: byType, expenses, activity,
  });
});
