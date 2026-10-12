/** Order & Job Tracking dashboard: the 15 tracking lists with counts, filters, unit scope and exports. */
import express from 'express';
import { permit, scopeFromQuery } from '../middleware/auth.js';
import { can } from '../services/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { buildTracking } from '../services/tracking.js';
import { sendExport } from '../services/exporter.js';
import { audit } from '../services/audit.js';
import { TRACKING_LIST, MAIN_JOB_COLUMNS } from '../../../shared/tracking.js';

const r = express.Router();
const FILTERS = ['buyer', 'jobNo', 'poNo', 'status', 'stage', 'from', 'to'];
const filtersOf = (q) => Object.fromEntries(FILTERS.map((k) => [k, String(q[k] || '').trim()]).filter(([, v]) => v));

r.get('/', permit('jobs', 'view'), scopeFromQuery, asyncHandler(async (req, res) => {
  res.json({ scope: req.scope, ...(await buildTracking(filtersOf(req.query), { withProfit: can(req.perms, 'profit', 'view') })) });
}));

r.get('/export', permit('jobs', 'view'), permit('reports', 'export'), scopeFromQuery, asyncHandler(async (req, res) => {
  const key = String(req.query.list || '');
  const def = key === 'mainJobs' ? { title: 'Main Job Dashboard', columns: MAIN_JOB_COLUMNS } : TRACKING_LIST[key];
  if (!def) throw ApiError.badRequest('Unknown list');
  const withProfit = can(req.perms, 'profit', 'view');
  const t = await buildTracking(filtersOf(req.query), { withProfit });
  const rows = key === 'mainJobs' ? t.mainJobs : t.lists[key];
  const columns = def.columns.filter((c) => withProfit || c.type !== 'money');
  await audit(req, { action: 'EXPORT', module: 'jobs', message: `Exported ${rows.length} rows of ${def.title} (${req.query.format || 'json'})` });
  await sendExport(res, req.query.format, columns, rows, def.title.replace(/\W+/g, '-').toLowerCase());
}));

export default r;
