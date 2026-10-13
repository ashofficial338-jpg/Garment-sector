/**
 * Factory reports API – production, quality, HR, expenses, finished goods, cost of quality, P&L, dashboards
 * and integrity checks. Every endpoint honours the unit scope (?unit=U1 | U2 | ALL) and the common filters
 * (from, to, buyer, jobNo, styleNo, department, line, shift, stage, inspector, defect, section, category).
 *
 *   GET /factory/dashboard                      KPIs for every area (+ Unit-1 vs Unit-2 when consolidated)
 *   GET /factory/report/:key?table=&format=     report tables; format=csv|xlsx exports one table
 *   GET /factory/job/:jobNo                     Main Job / Sub Job production & quality history
 *   GET /factory/integrity                      validation & reconciliation checks
 *   GET /factory/options                        filter vocabularies (departments, stages, routes)
 */
import express from 'express';
import { permit, scopeFromQuery } from '../middleware/auth.js';
import { can } from '../services/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { sendExport } from '../services/exporter.js';
import { audit } from '../services/audit.js';
import { REPORTS, dashboard, integrity, jobHistory, QC_STAGE_KEYS, PRODUCTION_DEPARTMENTS } from '../services/factoryReports.js';
import { LABOUR_SECTIONS, FACTORY_EXPENSE_CATEGORIES, SHIFTS } from '../../../shared/modules/factory.js';

const r = express.Router();
// production / quality / WIP / FG need the factory reports permission; P&L and cost of quality need the P&L
// permission; labour cost and factory expenses also open to the departments that own payroll / expenses
const allowed = (req, key) => {
  const pnl = can(req.perms, 'pnl', 'view');
  if (['pnl', 'copq'].includes(key)) return pnl;
  if (key === 'hr') return pnl || can(req.perms, 'payroll', 'view');
  if (key === 'expenses') return pnl || can(req.perms, 'factoryExpense', 'view');
  return can(req.perms, 'factoryReports', 'view');
};

r.use(scopeFromQuery);

r.get('/options', permit('factoryReports', 'view'), (_req, res) => res.json({ departments: PRODUCTION_DEPARTMENTS, stages: QC_STAGE_KEYS, sections: LABOUR_SECTIONS, categories: FACTORY_EXPENSE_CATEGORIES, shifts: SHIFTS }));

r.get('/dashboard', permit('factoryReports', 'view'), asyncHandler(async (req, res) => {
  const d = await dashboard(req.query);
  // financial blocks only for users who may see them
  if (!can(req.perms, 'pnl', 'view')) { delete d.pnl; delete d.hr; delete d.expenses; d.compare = d.compare.map(({ labour, expenses, revenue, operatingProfit, ...x }) => x); }
  res.json({ scope: req.scope, ...d });
}));

r.get('/report/:key', asyncHandler(async (req, res) => {
  const fn = REPORTS[req.params.key];
  if (!fn) throw ApiError.notFound('Unknown report');
  if (!allowed(req, req.params.key)) throw ApiError.forbidden(`Missing permission for the ${req.params.key} report`);
  const out = await fn(req.query);
  if (req.query.format && req.query.format !== 'json') {
    const t = out.tables[req.query.table] || Object.values(out.tables)[0];
    if (!can(req.perms, req.params.key === 'pnl' || req.params.key === 'copq' ? 'pnl' : 'factoryReports', 'export') && !req.perms.isAdmin) throw ApiError.forbidden('Export permission required');
    await audit(req, { action: 'EXPORT', module: 'reports', message: `${req.user.name} exported ${t.title} (${req.query.format}, ${t.rows.length} rows)` });
    return sendExport(res, req.query.format, t.columns.map((x) => ({ key: x.key, label: x.label })), t.rows, `${req.params.key}-${req.query.table || 'report'}`);
  }
  res.json({ scope: req.scope, ...out });
}));

r.get('/job/:jobNo', permit('factoryReports', 'view'), asyncHandler(async (req, res) => res.json(await jobHistory(req.params.jobNo))));

r.get('/integrity', permit('factoryReports', 'view'), asyncHandler(async (req, res) => res.json(await integrity())));

export default r;
