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
import { loadJobGraphs, computeProfit, computeStages } from '../services/lifecycle.js';
import { audit } from '../services/audit.js';
import { num, sum, round, pct } from '../../../shared/calc.js';
import { STAGE_STATE } from '../../../shared/constants.js';
import { TRACKING_LIST, MAIN_JOB_COLUMNS } from '../../../shared/tracking.js';
import { buildTracking } from '../services/tracking.js';
import { buildJobClosureReport, CLOSURE_REGISTER_COLUMNS } from '../services/jobClosureReport.js';
import { escapeRegex } from '../utils/query.js';

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
  { key: 'fabric-return', title: 'Fabric Return & Stock Adjustment Report', module: 'fabricReturn', department: 'Fabric Department', columns: [...J, c('refNo', 'Ref'), c('returnDate', 'Date'), c('returnType', 'Type'), c('fabric', 'Fabric'), c('rollNos', 'Rolls / Lots'), c('qty', 'Qty'), c('unit', 'Unit'), c('rate', 'Rate'), c('amount', 'Value'), c('referenceDoc', 'Challan / Count Sheet'), c('reason', 'Reason'), c('status', 'Status')] },
  { key: 'fabric-debit', title: 'Fabric Debit Note Report (claims & recoveries)', module: 'fabricDebit', department: 'Fabric Department', columns: [...J, c('refNo', 'Debit Note'), c('debitDate', 'Date'), c('debitTo', 'Debit To'), c('supplierName', 'Supplier'), c('debitParty', 'Department'), c('reason', 'Reason'), c('fabric', 'Fabric'), c('qty', 'Qty'), c('unit', 'Unit'), c('rate', 'Rate'), c('otherCharges', 'Other'), c('amount', 'Amount'), c('costImpact', 'Job Cost Impact'), c('costEffect', 'Effect'), c('referenceDoc', 'Credit Note Ref'), c('status', 'Status')] },
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
  // ---------- management & closure ----------
  { key: 'dashboard', title: 'Dashboard Report (jobs by stage)', module: 'orders', perm: 'jobs', department: 'Admin', custom: 'dashboard', columns: [c('stage', 'Current Stage'), c('jobs', 'Jobs'), c('orderQty', 'Order Qty'), c('orderValue', 'Order Value'), c('delayed', 'Delayed'), c('readyToClose', 'Ready to Close')] },
  { key: 'job-close', title: 'Job Close Report (full)', module: 'orders', perm: 'jobs', department: 'Admin', custom: 'jobclose', columns: [c('unitName', 'Unit'), c('buyerName', 'Buyer'), c('orderNo', 'Order'), c('mainJob', 'Main Job'), c('subJob', 'Sub Job'), c('jobType', 'Job Type'), c('styleNo', 'Style'), c('poNo', 'PO'), c('orderQty', 'Order Qty'), c('fabricReceived', 'Fabric Received'), c('fabricUsed', 'Fabric Used'), c('fabricTransferred', 'Fabric Transferred'), c('fabricUnit', 'Fabric Unit'), c('productionQty', 'Production Qty'), c('shippedQty', 'Shipped Qty'), c('totalCost', 'Total Cost'), c('revenue', 'Revenue'), c('profit', 'Profit'), c('marginPct', 'Margin %'), c('accountsStatus', 'Accounts Status'), c('checklist', 'Closure Checklist'), c('status', 'Job Status'), c('closedAt', 'Closure Date'), c('closedByName', 'Closed By')] },
  { key: 'pending-jobs', title: 'Pending Job Report', module: 'orders', perm: 'jobs', department: 'Admin', custom: 'pending', columns: [c('jobNo', 'Job No'), c('jobType', 'Type'), c('buyerName', 'Buyer'), c('styleNo', 'Style'), c('orderQty', 'Qty'), c('shipmentDate', 'Ship Date'), c('daysToShip', 'Days to Ship'), c('currentStage', 'Current Stage'), c('progressPct', 'Progress %'), c('status', 'Status'), c('blockers', 'Pending Before Closure')] },
  { key: 'closed-jobs', title: 'Closed Job Report', module: 'orders', perm: 'jobs', department: 'Admin', custom: 'closed', columns: [c('jobNo', 'Job No'), c('jobType', 'Type'), c('buyerName', 'Buyer'), c('styleNo', 'Style'), c('orderQty', 'Qty'), c('shippedQty', 'Shipped'), c('revenue', 'Revenue'), c('totalExpenses', 'Cost'), c('actualProfit', 'Profit'), c('profitPct', 'Margin %'), c('closedAt', 'Closed On'), c('closedByName', 'Closed By'), c('closureRemarks', 'Remarks')] },
  { key: 'main-sub', title: 'Main Job / Sub Job Report', module: 'orders', perm: 'jobs', department: 'Admin', custom: 'mainsub', columns: [c('mainJob', 'Main Job'), c('subJob', 'Sub Job'), c('jobType', 'Type'), c('buyerName', 'Buyer'), c('styleNo', 'Style'), c('orderQty', 'Qty'), c('shipmentDate', 'Ship Date'), c('currentStage', 'Stage'), c('shippedQty', 'Shipped'), c('revenue', 'Revenue'), c('actualProfit', 'Profit'), c('status', 'Status')] },
  { key: 'buyer-history', title: 'Buyer History Report', module: 'orders', department: 'Head Office Merchandising', custom: 'buyer', columns: [c('buyerName', 'Buyer'), c('jobs', 'Jobs'), c('openJobs', 'Open'), c('orderQty', 'Order Qty'), c('orderValue', 'Order Value'), c('shippedQty', 'Shipped'), c('invoiced', 'Invoiced'), c('received', 'Received'), c('outstanding', 'Outstanding'), c('lastOrder', 'Last Order')] },
  // ---------- fabric ----------
  { key: 'fabric-receipt', title: 'Fabric Receipt Report (roll-wise)', module: 'fabricReceipt', department: 'Fabric Department', custom: 'rolls', columns: [...J, c('refNo', 'Receipt'), c('receiptDate', 'Date'), c('fabric', 'Fabric'), c('rollNo', 'Roll'), c('lotNo', 'Lot'), c('shade', 'Shade'), c('width', 'Width'), c('gsm', 'GSM'), c('qty', 'Qty'), c('unit', 'Unit'), c('points', 'Points'), c('pointsPer100', 'Pts/100 sq yd'), c('result', 'Result'), c('status', 'Status')] },
  { key: 'fabric-allocation', title: 'Fabric Allocation Report (roll-wise)', module: 'fabricAllocation', department: 'Fabric Department', custom: 'rolls', columns: [...J, c('refNo', 'Allocation'), c('allocationDate', 'Date'), c('fabric', 'Fabric'), c('cuttingTable', 'Cutting Table'), c('rollNo', 'Roll'), c('lotNo', 'Lot'), c('qty', 'Allocated'), c('unit', 'Unit'), c('status', 'Status')] },
  { key: 'fabric-consumption', title: 'Fabric Consumption & Variance Report', module: 'fabricBooking', department: 'Fabric Department', custom: 'consumption', columns: [...J, c('refNo', 'Booking'), c('fabricType', 'Fabric'), c('unit', 'Unit'), c('requiredQty', 'Required'), c('receivedQty', 'Received'), c('issuedQty', 'Issued'), c('usedQty', 'Consumed'), c('balanceQty', 'Balance'), c('cutQty', 'Cut Pcs'), c('plannedPerPc', 'Planned / pc'), c('actualPerPc', 'Actual / pc'), c('variancePct', 'Variance %'), c('varianceQty', 'Variance Qty')] },
  // ---------- commercial ----------
  { key: 'sales', title: 'Sales Report', module: 'invoice', department: 'Accounts & Finance', columns: [...J, c('invoiceNo', 'Invoice'), c('invoiceDate', 'Date'), c('qty', 'Qty'), c('unitPrice', 'Price'), c('currency', 'Cur'), c('totalAmount', 'Amount'), c('receivedAmount', 'Received'), c('outstanding', 'Outstanding'), c('status', 'Status')] },
  { key: 'accounts', title: 'Accounts Report (job-wise)', module: 'orders', perm: 'profit', department: 'Accounts & Finance', custom: 'accounts', columns: [c('jobNo', 'Job No'), c('buyerName', 'Buyer'), c('styleNo', 'Style'), c('currency', 'Cur'), c('revenue', 'Revenue'), c('invoiced', 'Invoiced'), c('received', 'Received'), c('outstanding', 'Outstanding'), c('purchaseCost', 'Purchase Cost (fabric + trims)'), c('productionCost', 'Production Cost'), c('otherCost', 'Other Cost'), c('totalExpenses', 'Job Cost'), c('actualProfit', 'Profit'), c('status', 'Status')] },
  // ---------- production ----------
  { key: 'operator-production', title: 'Operator Production Report', module: 'sewing', department: 'Sewing', custom: 'operators', columns: [...J, c('entryDate', 'Date'), c('line', 'Line'), c('empCode', 'Emp Code'), c('operatorName', 'Operator'), c('operation', 'Operation'), c('smv', 'SMV'), c('pieces', 'Pieces'), c('effPct', 'Eff %')] },
  { key: 'job-closure', title: 'Job Closure Status Report', module: 'orders', perm: 'jobs', department: 'Admin', custom: 'closure', columns: [c('jobNo', 'Job No'), c('buyerName', 'Buyer'), c('styleNo', 'Style'), c('orderQty', 'Qty'), c('status', 'Status'), c('progressPct', 'Progress %'), c('readyToClose', 'Ready'), c('blockers', 'Pending Conditions'), c('closedAt', 'Closed At')] },
  { key: 'expense', title: 'Expense Report', module: 'expense', department: 'Accounts & Finance' },
  { key: 'supplier-bills', title: 'Supplier Bills & Payables Report', module: 'supplierBill', department: 'Accounts & Finance', columns: [c('jobNo', 'Job No'), c('supplierName', 'Supplier'), c('billNo', 'Supplier Invoice'), c('billDate', 'Date'), c('dueDate', 'Due'), c('billType', 'Type'), c('poRef', 'PO / Booking'), c('qty', 'Qty'), c('rate', 'Rate'), c('amount', 'Amount'), c('taxAmount', 'Tax'), c('totalAmount', 'Total'), c('debitNoteAdjusted', 'Debit Notes Set Off'), c('paidAmount', 'Paid'), c('outstanding', 'Outstanding'), c('paymentStatus', 'Payment'), c('status', 'Status')] },
  // ---------- order & job tracking (same lists as the Order & Job Tracking dashboard) ----------
  ...[['new-orders', 'newOrders'], ['orders-awaiting-job', 'awaitingJob'], ['repeat-forecast-orders', 'forecastOrders'], ['advance-jobs-awaiting-po', 'advanceAwaitingPo'],
    ['pending-po-unfinished', 'unfinished'], ['finished-not-shipped', 'finishedPendingShipment'], ['partially-shipped', 'partiallyShipped'],
    ['po-pending-receipt', 'poPendingReceipt'], ['jobs-not-started', 'notStarted'], ['jobs-on-hold', 'onHold'], ['overdue-jobs', 'overdue'], ['jobs-awaiting-closure', 'awaitingClosure']]
    .map(([key, list]) => ({ key, title: `${TRACKING_LIST[list].title} Report`, module: list === 'newOrders' || list === 'awaitingJob' ? 'buyerOrder' : 'orders', perm: list === 'newOrders' || list === 'awaitingJob' ? 'buyerOrder' : 'jobs', department: 'Order & Job Tracking', tracking: list })),
  { key: 'main-job-dashboard', title: 'Main Job Dashboard Report', module: 'orders', perm: 'jobs', department: 'Order & Job Tracking', tracking: 'mainJobs' },
  { key: 'job-closure-register', title: 'Job Closure Report – Transaction Register (main + sub jobs)', module: 'orders', perm: 'jobs', department: 'Admin', register: true },
];

/** Tracking lists as reports: filter by unit (scope), buyer, PO, main / sub job, status and delivery date. */
async function trackingReport(req, res, rep) {
  const withProfit = can(req.perms, 'profit', 'view');
  const q = req.query;
  const t = await buildTracking({ buyer: q.buyer, jobNo: q.job, poNo: q.po, status: q.status, from: q.from, to: q.to }, { withProfit });
  const rows = rep.tracking === 'mainJobs' ? t.mainJobs : t.lists[rep.tracking];
  const columns = (rep.tracking === 'mainJobs' ? MAIN_JOB_COLUMNS : TRACKING_LIST[rep.tracking].columns).filter((x) => withProfit || x.type !== 'money');
  if (q.format && q.format !== 'json') await audit(req, { action: 'EXPORT', module: 'reports', message: `${req.user.name} exported ${rep.title} (${q.format}, ${rows.length} rows)` });
  await sendExport(res, q.format, columns.map(({ key, label }) => ({ key, label })), rows, rep.key);
}

/** Every transaction of the selected main job(s) and their sub jobs, in date order (filter by job, buyer, PO, department, dates). */
async function registerReport(req, res, rep) {
  const withMoney = can(req.perms, 'profit', 'view');
  const q = req.query;
  const key = String(q.job || '').trim();
  const rx = (v) => new RegExp(escapeRegex(v), 'i');
  const filter = { isDeleted: false, parentJob: null, ...(key ? { $or: [{ jobNo: key }, { jobNo: key.split('-').slice(0, 2).join('-') }] } : {}), ...(q.buyer ? { buyerName: rx(q.buyer) } : {}), ...(q.style ? { styleNo: rx(q.style) } : {}) };
  const mains = await models.orders.find(filter).sort({ jobNo: 1 }).limit(key ? 1 : 60).lean();
  let rows = [];
  for (const m of mains) rows.push(...(await buildJobClosureReport(m, { withMoney })).rows);
  if (key.split('-').length > 2) rows = rows.filter((x) => x.jobNo === key || x.jobNo === x.mainJobNo);
  if (q.po) rows = rows.filter((x) => rx(q.po).test(x.description) || rx(q.po).test(x.refNo || ''));
  if (q.department) rows = rows.filter((x) => x.department === q.department);
  if (q.from) rows = rows.filter((x) => x.date && new Date(x.date) >= new Date(q.from));
  if (q.to) rows = rows.filter((x) => x.date && new Date(x.date) <= new Date(`${q.to}T23:59:59`));
  if (q.format && q.format !== 'json') await audit(req, { action: 'EXPORT', module: 'reports', message: `${req.user.name} exported ${rep.title} (${q.format}, ${rows.length} rows)` });
  await sendExport(res, q.format, CLOSURE_REGISTER_COLUMNS.filter((c) => withMoney || !['rate', 'amount', 'costImpact', 'revenueImpact'].includes(c.key)), rows.map((x) => ({ ...x, _id: `${x.mainJobNo}-${x.seq}` })), rep.key);
}

r.get('/', permit('reports', 'view'), (req, res) => {
  res.json(REPORTS.filter((x) => can(req.perms, x.perm || x.module, 'view')).map(({ key, title, module, department }) => ({ key, title, module, department })));
});

r.get('/:key', permit('reports', 'view'), scopeFromQuery, asyncHandler(async (req, res) => {
  const rep = REPORTS.find((x) => x.key === req.params.key);
  if (!rep) throw ApiError.notFound('Report not found');
  if (!can(req.perms, rep.perm || rep.module, 'view')) throw ApiError.forbidden();
  if (req.query.format && req.query.format !== 'json' && !can(req.perms, 'reports', 'export') && !can(req.perms, rep.module, 'export')) throw ApiError.forbidden('Export permission required');
  if (rep.tracking) return trackingReport(req, res, rep);
  if (rep.register) return registerReport(req, res, rep);
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
  if (rep.custom === 'rolls') rows = rows.flatMap((x) => (x.rolls || []).map((r) => ({ ...x, ...r, _id: `${x._id}-${r.rollNo}`, rolls: undefined })));
  if (rep.custom === 'operators') rows = rows.flatMap((x) => (x.operatorOutput || []).map((o) => ({ ...x, ...o, _id: `${x._id}-${o.empCode}-${o.operation}` })));
  if (rep.custom === 'consumption') {
    const cuts = await models.cutting.find({ isDeleted: false, status: { $ne: 'Rejected' }, job: { $in: rows.map((x) => x.job) } }).lean();
    rows = rows.map((x) => {
      const mine = cuts.filter((k) => String(k.job) === String(x.job));
      const cutQty = sum(mine, 'cutQty');
      const used = num(x.usedQty) || sum(mine, 'fabricUsed');
      const actual = cutQty ? round(used / cutQty, 4) : 0;
      const planned = round(num(x.consumption) * (1 + num(x.totalLossPct) / 100), 4);
      return { ...x, usedQty: used, cutQty, plannedPerPc: planned, actualPerPc: actual, variancePct: planned && actual ? pct(actual - planned, planned) : null, varianceQty: planned && cutQty ? round(used - planned * cutQty, 3) : null };
    });
  }
  if (['jobclose', 'pending', 'closed', 'mainsub', 'accounts', 'buyer', 'dashboard'].includes(rep.custom)) {
    if (rep.custom === 'pending') rows = rows.filter((x) => !['Closed', 'Cancelled'].includes(x.status));
    if (rep.custom === 'closed') rows = rows.filter((x) => x.status === 'Closed');
    if (rep.custom === 'mainsub') rows = rows.filter((x) => x.parentJob || (x.isForecast && num(x.subJobCount) > 0) || x.jobType === 'Forecast / Continuous Job');
    const graphs = await loadJobGraphs(rows.slice(0, 1000));
    const today = new Date();
    const rich = [];
    for (const g of graphs) {
      const j = g.job; const p = computeProfit(g);
      const base = { ...j, ...p, status: j.status, mainJob: j.parentJobNo || j.jobNo, subJob: j.parentJobNo ? j.jobNo : '' };
      if (rep.custom === 'jobclose') {
        const lc = await computeStages(g);
        const checklist = lc.order.filter((s) => s.state !== STAGE_STATE.NA).map((s) => `${s.state === STAGE_STATE.DONE ? '✓' : '✗'} ${s.label}`).join(' · ');
        const inv = p.invoiced; const out = p.outstanding;
        Object.assign(base, {
          fabricReceived: round(sum(g.fabric, 'receivedQty'), 2), fabricUsed: round(sum(g.fabric, 'usedQty') || sum(g.cutting, 'fabricUsed'), 2),
          fabricTransferred: round(sum(g.transfers.filter((t) => t.status === 'Completed'), 'qty'), 2), fabricUnit: g.fabric[0]?.unit || g.forecasts[0]?.unit || '',
          productionQty: sum(g.sewing.filter((s) => s.status !== 'Rejected'), 'actualQty'), totalCost: p.totalExpenses, profit: p.actualProfit, marginPct: p.profitPct,
          accountsStatus: !inv ? 'Not invoiced' : out <= 0.005 ? 'Fully paid' : j.outstandingApproved ? `Outstanding ${out} approved` : `Outstanding ${out}`,
          checklist: j.status === 'Closed' ? `${checklist} · ✓ Closed` : `${checklist}${lc.blockers.length ? ` · Pending: ${lc.blockers.join('; ')}` : ''}`,
        });
      }
      if (rep.custom === 'pending') {
        const lc = await computeStages(g);
        Object.assign(base, { blockers: lc.blockers.join('; '), daysToShip: j.shipmentDate ? Math.round((new Date(j.shipmentDate) - today) / 86400000) : null });
      }
      if (rep.custom === 'accounts') {
        const head = (keys) => round(sum(p.heads.filter((h) => keys.includes(h.key)), 'actual'), 2);
        Object.assign(base, { purchaseCost: head(['fabric', 'trims']), productionCost: head(['cadPattern', 'cutting', 'sewing', 'finishing', 'washing', 'printing', 'packing', 'labour', 'quality']), otherCost: head(['overhead', 'freight', 'commercial', 'other']) });
      }
      rich.push(base);
    }
    if (rep.custom === 'mainsub') rich.sort((a, b) => a.mainJob.localeCompare(b.mainJob) || a.subJob.localeCompare(b.subJob));
    if (rep.custom === 'buyer') {
      const m = new Map();
      rich.filter((x) => !(x.isForecast && num(x.subJobCount) > 0)).forEach((x) => {
        const b = m.get(x.buyerName) || m.set(x.buyerName, { _id: x.buyerName, buyerName: x.buyerName, jobs: 0, openJobs: 0, orderQty: 0, orderValue: 0, shippedQty: 0, invoiced: 0, received: 0, outstanding: 0, lastOrder: null }).get(x.buyerName);
        b.jobs += 1; if (!['Closed', 'Cancelled'].includes(x.status)) b.openJobs += 1;
        b.orderQty += num(x.orderQty); b.orderValue = round(b.orderValue + num(x.orderValue)); b.shippedQty += num(x.shippedQty);
        b.invoiced = round(b.invoiced + num(x.invoiced)); b.received = round(b.received + num(x.received)); b.outstanding = round(b.outstanding + num(x.outstanding));
        if (!b.lastOrder || new Date(x.orderDate) > new Date(b.lastOrder)) b.lastOrder = x.orderDate;
      });
      rows = [...m.values()].sort((a, b) => b.orderValue - a.orderValue);
    } else if (rep.custom === 'dashboard') {
      const m = new Map();
      rich.filter((x) => !(x.isForecast && num(x.subJobCount) > 0) && x.status !== 'Cancelled').forEach((x) => {
        const k = x.status === 'Closed' ? 'Closed' : x.currentStage || 'order';
        const b = m.get(k) || m.set(k, { _id: k, stage: k, jobs: 0, orderQty: 0, orderValue: 0, delayed: 0, readyToClose: 0 }).get(k);
        b.jobs += 1; b.orderQty += num(x.orderQty); b.orderValue = round(b.orderValue + num(x.orderValue));
        if (Object.values(x.stages || {}).includes('delayed')) b.delayed += 1; if (x.readyToClose) b.readyToClose += 1;
      });
      rows = [...m.values()];
    } else rows = rich;
  }

  // every row carries its unit; consolidated reports show it as the first column
  const unitName = Object.fromEntries((await getSetting('units')).map((u) => [u.code, u.name]));
  rows = rows.map((x) => ({ ...x, unitName: unitName[x.businessUnit || x.job?.businessUnit] || x.businessUnit || '' }));
  if (req.scope === ALL_UNITS) columns = [c('unitName', 'Unit'), ...columns];
  const scopeLabel = req.scope === ALL_UNITS ? 'both units' : unitName[req.scope] || req.scope;
  if (req.query.format && req.query.format !== 'json') await audit(req, { action: 'EXPORT', module: 'reports', message: `${req.user.name} exported ${rep.title} – ${scopeLabel} (${req.query.format}, ${rows.length} rows)` });
  await sendExport(res, req.query.format, columns, rows, rep.key);
}));

export default r;
