/**
 * Centralised Report Center – every report supports JSON (for PDF/print), CSV and Excel with common filters
 * (date, job, buyer, department, style) and a unit scope: current unit, another assigned unit, or ALL (consolidated).
 */
import express from 'express';
import { models } from '../modules/builder.js';
import { MODULES } from '../../../shared/modules/index.js';
import { buildFilter, populateSpec } from '../modules/filters.js';
import { permit, scopeFromQuery } from '../middleware/auth.js';
import { ALL_UNITS } from '../services/unitContext.js';
import { getSetting } from '../services/settings.js';
import { can } from '../services/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { sendExport, moduleColumns } from '../services/exporter.js';
import { loadJobGraphs, computeProfit } from '../services/lifecycle.js';
import { audit } from '../services/audit.js';
import { num } from '../../../shared/calc.js';

const r = express.Router();
const c = (key, label) => ({ key, label });
const J = [c('jobNo', 'Job No'), c('buyerName', 'Buyer'), c('styleNo', 'Style'), c('poNo', 'PO')];

export const REPORTS = [
  { key: 'order-status', title: 'Order Status Report', module: 'orders', department: 'Head Office Merchandising', columns: [c('jobNo', 'Job No'), c('orderNo', 'Order No'), c('buyerName', 'Buyer'), c('poNo', 'PO'), c('styleNo', 'Style'), c('orderQty', 'Qty'), c('orderValue', 'Value'), c('currency', 'Cur'), c('shipmentDate', 'Ship Date'), c('currentStage', 'Current Stage'), c('progressPct', 'Progress %'), c('status', 'Status')] },
  { key: 'buyer-orders', title: 'Buyer Order Report', module: 'orders', department: 'Head Office Merchandising', columns: [c('buyerName', 'Buyer'), c('jobNo', 'Job No'), c('poNo', 'PO'), c('styleNo', 'Style'), c('product', 'Product'), c('orderDate', 'Order Date'), c('orderQty', 'Qty'), c('unitPrice', 'Price'), c('orderValue', 'Value'), c('destination', 'Destination'), c('status', 'Status')] },
  { key: 'costing', title: 'Costing Report', module: 'costing', department: 'Costing Factory' },
  { key: 'quotation', title: 'Quotation Report', module: 'quotation', department: 'Head Office Merchandising' },
  { key: 'spec', title: 'Specification Report', module: 'techSpec', department: 'Head Office Merchandising' },
  { key: 'bom', title: 'BOM Report', module: 'bom', department: 'Factory Merchandising', custom: 'bom' },
  { key: 'pattern', title: 'CAD / Pattern & Grading Report', module: 'pattern', department: 'CAD / Pattern', columns: [...J, c('refNo', 'Ref'), c('patternNo', 'Pattern No'), c('revision', 'Rev'), c('patternType', 'Type'), c('cadSystem', 'CAD System'), c('cadFileName', 'CAD File'), c('patternMaker', 'Pattern Maker'), c('baseSize', 'Base Size'), c('gradedSizes', 'Graded Sizes'), c('approvalDate', 'Approved On'), c('status', 'Status')] },
  { key: 'marker', title: 'Marker Consumption Report', module: 'marker', department: 'CAD / Pattern', columns: [...J, c('markerNo', 'Marker No'), c('color', 'Color'), c('fabricType', 'Fabric'), c('ratio', 'Ratio'), c('markerLength', 'Length'), c('markerLengthUnit', 'L Unit'), c('markerWidth', 'Width'), c('markerEfficiencyPct', 'Eff %'), c('garmentsPerMarker', 'Pcs / Marker'), c('consumptionPerPc', 'Cons / pc'), c('bomConsumption', 'BOM Cons / pc'), c('consumptionVariancePct', 'Variance %'), c('unit', 'Unit'), c('plannedPlies', 'Plies'), c('plannedCutQty', 'Planned Cut'), c('status', 'Status')] },
  { key: 'tna', title: 'T&A Report', module: 'tna', department: 'Factory Merchandising', custom: 'tna' },
  { key: 'fabric-forecast', title: 'Fabric Forecast Report', module: 'fabricForecast', department: 'Fabric Department', columns: [...J, c('refNo', 'Forecast'), c('fabricType', 'Fabric'), c('color', 'Color'), c('lotNo', 'Lot'), c('unit', 'Unit'), c('garmentQty', 'Garments'), c('forecastQty', 'Forecast'), c('requiredDate', 'Required'), c('receivedQty', 'Received'), c('transferredQty', 'Transferred'), c('balanceQty', 'Balance'), c('excessQty', 'Excess'), c('status', 'Status')] },
  { key: 'fabric-transfer', title: 'Fabric Transfer Report', module: 'fabricTransfer', department: 'Fabric Department', columns: [c('refNo', 'Transfer'), c('transferDate', 'Date'), c('fromUnit', 'From Unit'), c('jobNo', 'From Job'), c('fabric', 'Fabric'), c('lotNo', 'Lot'), c('qty', 'Qty'), c('unit', 'Unit'), c('toUnit', 'To Unit'), c('toJobNo', 'To Job'), c('destinationBooking', 'Received Into'), c('reason', 'Reason'), c('referenceDoc', 'Reference'), c('createdByName', 'Created By'), c('status', 'Status')] },
  { key: 'fabric-booking', title: 'Fabric Booking Report', module: 'fabricBooking', department: 'Fabric Department' },
  { key: 'fabric-balance', title: 'Fabric Balance Report', module: 'fabricBooking', department: 'Fabric Department', columns: [...J, c('refNo', 'Booking'), c('fabricType', 'Fabric'), c('color', 'Color'), c('unit', 'Unit'), c('requiredQty', 'Required'), c('bookedQty', 'Booked'), c('receivedQty', 'Received'), c('approvedQty', 'Approved'), c('issuedQty', 'Issued'), c('usedQty', 'Used'), c('balanceQty', 'Balance'), c('excessQty', 'Excess'), c('shortageQty', 'Shortage'), c('closureVerdict', 'Closure'), c('status', 'Status')] },
  { key: 'trim', title: 'Trim Report', module: 'trimBooking', department: 'Factory Merchandising' },
  { key: 'sample-status', title: 'Sample Status Report', module: 'sample', department: 'Factory Merchandising' },
  { key: 'production', title: 'Production Report', module: 'productionPlan', department: 'Production' },
  { key: 'cutting', title: 'Cutting Report', module: 'cutting', department: 'Cutting' },
  { key: 'sewing', title: 'Sewing Report', module: 'sewing', department: 'Sewing', columns: [...J, c('entryDate', 'Date'), c('floor', 'Floor'), c('line', 'Line'), c('operators', 'Operators'), c('sam', 'SAM'), c('targetQty', 'Target'), c('actualQty', 'Actual'), c('variance', 'Variance'), c('efficiencyPct', 'Eff %'), c('checkedQty', 'Checked'), c('defects', 'Defects'), c('dhu', 'DHU'), c('rejection', 'Rejection'), c('alteration', 'Alteration')] },
  { key: 'finishing', title: 'Finishing Report', module: 'finishing', department: 'Finishing' },
  { key: 'packing', title: 'Packing Report', module: 'packing', department: 'Packing' },
  { key: 'quality', title: 'Quality Report', module: 'inspection', department: 'Quality' },
  { key: 'shipment', title: 'Shipment Report', module: 'shipment', department: 'Shipment / Documentation' },
  { key: 'payment', title: 'Payment Report', module: 'payment', department: 'Accounts & Finance' },
  { key: 'outstanding', title: 'Outstanding Report', module: 'invoice', department: 'Accounts & Finance', columns: [...J, c('invoiceNo', 'Invoice'), c('invoiceDate', 'Date'), c('currency', 'Cur'), c('totalAmount', 'Amount'), c('receivedAmount', 'Received'), c('outstanding', 'Outstanding'), c('dueDate', 'Due Date'), c('overdueDays', 'Overdue Days'), c('status', 'Status')], custom: 'outstanding' },
  { key: 'profit', title: 'Profit Report', module: 'orders', perm: 'profit', department: 'Accounts & Finance', custom: 'profit', columns: [c('jobNo', 'Job No'), c('buyerName', 'Buyer'), c('styleNo', 'Style'), c('orderQty', 'Qty'), c('shippedQty', 'Shipped'), c('currency', 'Cur'), c('expectedRevenue', 'Exp. Revenue'), c('revenue', 'Revenue'), c('expectedCost', 'Est. Cost'), c('totalExpenses', 'Actual Cost'), c('cogs', 'COGS'), c('expectedProfit', 'Exp. Profit'), c('actualProfit', 'Actual Profit'), c('profitVariance', 'Variance'), c('profitPct', 'Profit %'), c('roiPct', 'ROI %'), c('status', 'Status')] },
  { key: 'job-closure', title: 'Job Closure Report', module: 'orders', perm: 'jobs', department: 'Admin', custom: 'closure', columns: [c('jobNo', 'Job No'), c('buyerName', 'Buyer'), c('styleNo', 'Style'), c('orderQty', 'Qty'), c('status', 'Status'), c('progressPct', 'Progress %'), c('readyToClose', 'Ready'), c('blockers', 'Pending Conditions'), c('closedAt', 'Closed At')] },
  { key: 'expense', title: 'Expense Report', module: 'expense', department: 'Accounts & Finance' },
];

r.get('/', permit('reports', 'view'), (req, res) => {
  res.json(REPORTS.filter((x) => can(req.perms, x.perm || x.module, 'view')).map(({ key, title, module, department }) => ({ key, title, module, department })));
});

r.get('/:key', permit('reports', 'view'), scopeFromQuery, asyncHandler(async (req, res) => {
  const rep = REPORTS.find((x) => x.key === req.params.key);
  if (!rep) throw ApiError.notFound('Report not found');
  if (!can(req.perms, rep.perm || rep.module, 'view')) throw ApiError.forbidden();
  if (req.query.format && req.query.format !== 'json' && !can(req.perms, 'reports', 'export') && !can(req.perms, rep.module, 'export')) throw ApiError.forbidden('Export permission required');
  const def = MODULES[rep.module];
  const filter = await buildFilter(def, req.query);
  if (rep.custom === 'outstanding') filter.outstanding = { $gt: 0 };
  let rows = await models[rep.module].find(filter).sort({ createdAt: -1 }).limit(20000).populate(populateSpec(def)).lean();
  let columns = rep.columns || moduleColumns(def);
  const today = new Date(new Date().toDateString());

  if (rep.custom === 'outstanding') {
    rows = rows.map((x) => ({ ...x, overdueDays: x.dueDate && new Date(x.dueDate) < today ? Math.round((today - new Date(x.dueDate)) / 86400000) : 0 }));
  }
  if (rep.custom === 'tna') {
    columns = [...J, c('activity', 'Activity'), c('department', 'Department'), c('plannedDate', 'Planned'), c('actualDate', 'Actual'), c('delayDays', 'Delay'), c('state', 'State'), c('responsible', 'Responsible'), c('remarks', 'Remarks')];
    rows = rows.flatMap((t) => (t.activities || []).map((a) => ({ ...a, businessUnit: t.businessUnit, jobNo: t.jobNo, buyerName: t.buyerName, styleNo: t.styleNo, poNo: t.poNo })));
    if (req.query.state) rows = rows.filter((a) => a.state === req.query.state);
  }
  if (rep.custom === 'bom') {
    columns = [...J, c('refNo', 'BOM'), c('status', 'Status'), c('category', 'Category'), c('item', 'Item'), c('description', 'Spec'), c('color', 'Color'), c('unit', 'Unit'), c('consumptionPerPc', 'Cons / pc'), c('wastagePct', 'Wastage %'), c('requiredQty', 'Required'), c('rate', 'Rate'), c('amount', 'Value'), c('bookingRef', 'Booking')];
    rows = rows.flatMap((b) => (b.lines || []).map((l) => ({ ...l, businessUnit: b.businessUnit, refNo: b.refNo, status: b.status, jobNo: b.jobNo, buyerName: b.buyerName, styleNo: b.styleNo, poNo: b.poNo, bookingRef: l.bookingRef || 'NOT BOOKED' })));
  }
  if (rep.custom === 'profit') {
    const jobs = rows.filter((x) => !(x.isForecast && num(x.subJobCount) > 0)).slice(0, 1000);
    rows = (await loadJobGraphs(jobs)).map((g) => ({ ...g.job, ...computeProfit(g) }));
  }
  if (rep.custom === 'closure') rows = rows.map((x) => ({ ...x, readyToClose: x.readyToClose ? 'Yes' : 'No', blockers: (x.closureBlockers || []).join('; ') }));

  // every row carries its unit; consolidated reports show it as the first column
  const unitName = Object.fromEntries((await getSetting('units')).map((u) => [u.code, u.name]));
  rows = rows.map((x) => ({ ...x, unitName: unitName[x.businessUnit || x.job?.businessUnit] || x.businessUnit || '' }));
  if (req.scope === ALL_UNITS) columns = [c('unitName', 'Unit'), ...columns];
  const scopeLabel = req.scope === ALL_UNITS ? 'both units' : unitName[req.scope] || req.scope;
  if (req.query.format && req.query.format !== 'json') await audit(req, { action: 'EXPORT', module: 'reports', message: `${req.user.name} exported ${rep.title} – ${scopeLabel} (${req.query.format}, ${rows.length} rows)` });
  await sendExport(res, req.query.format, columns, rows, rep.key);
}));

export default r;
