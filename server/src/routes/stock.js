/** Stock reports: yarn, knitting, grey, processing, in-process, finished fabric, trims. */
import express from 'express';
import { permit } from '../middleware/auth.js';
import { can } from '../services/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { STOCK_REPORTS } from '../services/stock.js';
import { sendExport } from '../services/exporter.js';
import { audit } from '../services/audit.js';
import { num, round } from '../../../shared/calc.js';

const r = express.Router();

r.get('/:type', permit('stock', 'view'), asyncHandler(async (req, res) => {
  const fn = STOCK_REPORTS[req.params.type];
  if (!fn) throw ApiError.notFound('Unknown stock report');
  const q = { from: req.query.from, to: req.query.to, job: req.query.job, supplier: req.query.supplier, process: req.query.process };
  const rep = await fn(q);
  const columns = rep.columns.map(([key, label]) => ({ key, label }));
  const totals = Object.fromEntries(rep.totals.map((k) => [k, round(rep.rows.reduce((s, x) => s + num(x[k]), 0), 2)]));
  if (req.query.format && req.query.format !== 'json') {
    if (!can(req.perms, 'stock', 'export')) throw ApiError.forbidden('Export permission required');
    await audit(req, { action: 'EXPORT', module: 'stock', message: `${req.user.name} exported ${rep.title} (${req.query.format})` });
    const totalRow = { [columns[0].key]: 'TOTAL', ...totals };
    return sendExport(res, req.query.format, columns, [...rep.rows, totalRow], `stock-${req.params.type}`);
  }
  res.json({ title: rep.title, columns, rows: rep.rows, totals });
}));

export default r;
