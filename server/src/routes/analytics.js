/**
 * Management analytics API (dashboard KPIs → analytics pages → source transactions).
 * Admin has access; other users only with an explicit `analytics` permission (Roles & Permissions).
 * Every endpoint honours the unit scope (?unit=U1 | U2 | ALL) and the reporting period (?from=&to=).
 */
import express from 'express';
import { permit, scopeFromQuery } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { analyticsContext, summary, finance, inventory, roi, variance, operations, ROI_DIMENSIONS } from '../services/analytics.js';

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

export default r;
