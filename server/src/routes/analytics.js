/**
 * Management analytics API (dashboard KPIs → analytics pages → source transactions).
 * Admin has access; other users only with an explicit `analytics` permission (Roles & Permissions).
 * Every endpoint honours the unit scope (?unit=U1 | U2 | ALL) and the reporting period (?from=&to=).
 */
import express from 'express';
import { permit, scopeFromQuery } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { analyticsContext, summary, finance, inventory, roi, variance, operations, ROI_DIMENSIONS } from '../services/analytics.js';
import { financialReport } from '../services/financialReport.js';
import { financialWorkbook, SECTIONS } from '../services/financialWorkbook.js';
import { ALL_UNITS } from '../services/unitContext.js';
import { getSetting } from '../services/settings.js';
import { can } from '../services/permissions.js';
import { audit } from '../services/audit.js';
import { ApiError } from '../utils/ApiError.js';

const r = express.Router();
r.use(permit('analytics', 'view'), scopeFromQuery);

const handle = (fn) => asyncHandler(async (req, res) => {
  const ctx = await analyticsContext(req.query);
  res.json({ scope: req.scope, ...(await fn(ctx, req)) });
});

r.get('/summary', handle((ctx) => summary(ctx)));
r.get('/finance', handle((ctx) => finance(ctx)));
r.get('/inventory', handle((ctx) => inventory(ctx)));
r.get('/roi', handle(async (ctx, req) => ({ ...(await roi(ctx, req.query.by || 'style')), dimensions: Object.fromEntries(Object.entries(ROI_DIMENSIONS).map(([k, [l]]) => [k, l])) })));
r.get('/variance', handle((ctx) => variance(ctx)));
r.get('/operations', handle((ctx) => operations(ctx)));
r.get('/financial', handle((ctx, req) => financialReport(ctx, req.query.grain || 'month')));

/* Financial report pack as an Excel workbook – ?sections=summary,sales,… (default: all) */
r.get('/financial/export', asyncHandler(async (req, res) => {
  if (!can(req.perms, 'analytics', 'export') && !can(req.perms, 'reports', 'export')) throw ApiError.forbidden('Export permission required');
  const sections = String(req.query.sections || Object.keys(SECTIONS).join(',')).split(',').filter((k) => SECTIONS[k]);
  if (!sections.length) throw ApiError.badRequest('Choose at least one report section');
  const ctx = await analyticsContext(req.query);
  const rep = await financialReport(ctx, req.query.grain || 'month');
  const [company, units] = await Promise.all([getSetting('company'), getSetting('units')]);
  const scopeLabel = req.scope === ALL_UNITS ? 'Both units (consolidated)' : units.find((u) => u.code === req.scope)?.name || req.scope;
  const buf = await financialWorkbook(rep, { sections, company, scopeLabel, generatedBy: req.user.name });
  await audit(req, { action: 'EXPORT', module: 'analytics', message: `${req.user.name} exported the financial report pack – ${scopeLabel}, ${rep.period} (xlsx, ${sections.length} sections)` });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Financial-Report-${rep.from}-to-${rep.to}.xlsx"`);
  res.send(Buffer.from(buf));
}));

export default r;
