/** Orders / Jobs: confirmation, editing with impact analysis, control tower, forecast sub jobs, closure. */
import express from 'express';
import mongoose from 'mongoose';
import { models } from '../modules/builder.js';
import { MODULES, applyCompute, validateRecord } from '../../../shared/modules/index.js';
import { permit, adminOnly } from '../middleware/auth.js';
import { can } from '../services/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { diffObjects } from '../utils/diff.js';
import { audit, describeChanges } from '../services/audit.js';
import { notify } from '../services/notify.js';
import { createJob, convertQuotation, createSubJobs, propagateJobChanges, generateDownstream, ensureFabricForecast } from '../services/orderFlow.js';
import { refreshJob, loadJobGraph, computeStages, computeProfit } from '../services/lifecycle.js';
import { AuditLog } from '../models/AuditLog.js';
import { num, sum } from '../../../shared/calc.js';

const r = express.Router();
const def = MODULES.orders;
const Job = models.orders;
const ADMIN_ONLY_FIELDS = ['isForecast', 'forecastQty'];

async function findJob(idOrNo) {
  const key = String(idOrNo).trim();
  const job = mongoose.isValidObjectId(key) ? await Job.findById(key) : await Job.findOne({ jobNo: key });
  if (!job || job.isDeleted) throw ApiError.notFound(`Job ${key} not found`);
  return job;
}

function pick(body) {
  const out = {};
  def.fields.forEach((f) => {
    if (f.readOnly || !(f.name in body)) return;
    let v = body[f.name];
    if (f.type === 'ref' && v && typeof v === 'object') v = v._id;
    if (f.type === 'number') v = v === '' || v === null ? null : Number(v);
    if (f.type === 'date' && v === '') v = null;
    out[f.name] = v;
  });
  return out;
}

/* Confirm an order directly */
r.post('/', permit('orders', 'create'), asyncHandler(async (req, res) => {
  const data = pick(req.body);
  if (!req.perms.isAdmin) ADMIN_ONLY_FIELDS.forEach((k) => delete data[k]); // forecast control is Admin-only
  const errors = validateRecord(def, applyCompute(def, data));
  if (Object.keys(errors).length) throw ApiError.badRequest('Validation failed', errors);
  const job = await createJob(data, req);
  res.status(201).json(await Job.findById(job._id).lean());
}));

/* Quotation → Order */
r.post('/from-quotation/:quotationId', permit('orders', 'create'), asyncHandler(async (req, res) => {
  const job = await convertQuotation(req.params.quotationId, pick(req.body), req);
  res.status(201).json(await Job.findById(job._id).lean());
}));

/* Update order with impact propagation */
r.put('/:id', permit('orders', 'edit'), asyncHandler(async (req, res) => {
  const job = await findJob(req.params.id);
  if (['Closed', 'Cancelled'].includes(job.status) && !req.perms.isAdmin) throw ApiError.badRequest(`Job is ${job.status}`);
  const before = job.toObject();
  const data = pick(req.body);
  const forecastChange = ADMIN_ONLY_FIELDS.some((k) => k in data && String(data[k] ?? '') !== String(before[k] ?? ''));
  if (forecastChange && !req.perms.isAdmin) throw ApiError.forbidden('Only Admin can change forecast settings');
  const subCount = await Job.countDocuments({ parentJob: job._id, isDeleted: false });
  if (subCount && 'orderQty' in data && num(data.orderQty) !== num(before.orderQty)) {
    throw ApiError.badRequest('Main job quantity equals the sum of its sub jobs – change the sub job quantities instead');
  }
  if (before.parentJob && 'orderQty' in data && num(data.orderQty) !== num(before.orderQty) && !req.perms.isAdmin) {
    throw ApiError.forbidden('Only Admin can change sub job quantity');
  }
  if (data.poNo && (data.poNo !== before.poNo || String(data.buyer || before.buyer) !== String(before.buyer))) {
    const dup = await Job.exists({ _id: { $ne: job._id }, buyer: data.buyer || before.buyer, poNo: data.poNo, styleNo: data.styleNo || before.styleNo, isDeleted: false, parentJob: null });
    if (dup) throw ApiError.conflict(`PO ${data.poNo} already exists for this buyer/style`);
  }
  const merged = applyCompute(def, { ...before, ...data });
  const errors = validateRecord(def, merged);
  if (Object.keys(errors).length) throw ApiError.badRequest('Validation failed', errors);
  def.fields.forEach((f) => job.set(f.name, merged[f.name]));
  if (data.buyer) job.buyerName = (await models.buyer.findById(data.buyer).lean())?.name;
  job.updatedBy = req.user._id;
  await job.save();
  const changes = diffObjects(before, job.toObject()).filter((c) => !['stages', 'buyerName'].includes(c.field));
  if (changes.length) await audit(req, { action: 'UPDATE', module: 'orders', record: job, changes, message: describeChanges(req.user.name, def, changes) });
  const impact = changes.length ? await propagateJobChanges(job.toObject(), changes, req) : [];
  // sub jobs follow main job edits for shared fields
  await refreshJob(job._id);
  res.json({ job: await Job.findById(job._id).lean(), impact });
}));

/* Status change for orders (hold / cancel / resume) */
r.post('/:id/status', permit('orders', 'edit'), asyncHandler(async (req, res) => {
  const job = await findJob(req.params.id);
  const to = req.body.status;
  const reason = String(req.body.reason || '').trim();
  if (!def.statuses.includes(to)) throw ApiError.badRequest('Invalid status');
  if (to === 'Ready to Close') throw ApiError.badRequest('Ready to Close is calculated automatically');
  const normal = (def.transitions[job.status] || []).includes(to);
  if (!normal && !(can(req.perms, 'orders', 'override') && reason)) throw ApiError.badRequest('Status change not allowed without override & reason', { code: 'OVERRIDE_REQUIRED' });
  if (['Cancelled', 'On Hold'].includes(to) && !reason) throw ApiError.badRequest('Reason is mandatory');
  const from = job.status;
  job.status = to;
  job.statusHistory.push({ from, to, by: req.user._id, byName: req.user.name, reason, override: !normal });
  await job.save();
  await audit(req, { action: normal ? 'STATUS' : 'OVERRIDE', module: 'orders', record: job, reason, changes: [{ field: 'status', old: from, new: to }], message: `${req.user.name} changed ${job.jobNo} from ${from} to ${to}` });
  await refreshJob(job._id);
  res.json(await Job.findById(job._id).lean());
}));

/* Job Control Tower */
r.get('/track/:key', permit('jobs', 'view'), asyncHandler(async (req, res) => {
  const job = (await findJob(req.params.key)).toObject();
  const g = await loadJobGraph(job);
  const lifecycle = await computeStages(g);
  const profit = can(req.perms, 'profit', 'view') ? computeProfit(g) : null;
  const pickRows = (rows, fields) => rows.map((x) => Object.fromEntries(['_id', 'refNo', 'jobNo', 'status', ...fields].map((k) => [k, x[k]])));
  const parent = job.parentJob ? await Job.findById(job.parentJob).select('jobNo orderQty status forecastQty').lean() : null;
  const timeline = await AuditLog.find({ jobNo: { $in: [job.jobNo, ...g.subJobs.map((s) => s.jobNo)] } }).sort({ createdAt: -1 }).limit(60).lean();
  res.json({
    job, parent, lifecycle, profit, timeline,
    records: {
      enquiry: pickRows(g.enquiries, ['enquiryDate', 'expectedQty']),
      costing: pickRows(g.costings, ['totalCostPerPc', 'sellingPrice', 'profitPct']),
      quotation: pickRows(g.quotations, ['version', 'price', 'quoteValue']),
      techSpec: pickRows(g.specs, ['revision', 'specDate', 'baseSize', 'pomCount', 'buyerApprovalDate']),
      bom: pickRows(g.boms, ['revision', 'materialCostPerPc', 'materialVariancePerPc', 'totalMaterialValue', 'lines']),
      pattern: pickRows(g.patterns, ['patternNo', 'revision', 'patternType', 'cadSystem', 'cadFileName', 'gradedSizes', 'approvalDate']),
      marker: pickRows(g.markers, ['markerNo', 'ratio', 'markerLength', 'markerEfficiencyPct', 'consumptionPerPc', 'consumptionVariancePct']),
      tna: g.tna.map((t) => ({ _id: t._id, refNo: t.refNo, status: t.status, activities: t.activities, completionPct: t.completionPct, delayedCount: t.delayedCount })),
      ppMeeting: pickRows(g.ppm, ['meetingDate', 'fabricStatus', 'trimStatus']),
      fabricBooking: pickRows(g.fabric, ['fabricType', 'color', 'unit', 'requiredQty', 'bookedQty', 'receivedQty', 'issuedQty', 'balanceQty', 'shortageQty', 'closureVerdict']),
      trimBooking: pickRows(g.trims, ['item', 'bookingQty', 'receivedQty', 'shortageQty']),
      fabricForecast: pickRows(g.forecasts, ['fabricType', 'color', 'unit', 'lotNo', 'forecastQty', 'receivedQty', 'transferredQty', 'balanceQty', 'excessQty', 'requiredDate']),
      fabricTransfer: pickRows(g.transfers, ['transferDate', 'fabric', 'qty', 'unit', 'fromUnit', 'toUnit', 'toJobNo', 'jobNo', 'reason', 'referenceDoc', 'destinationBooking', 'createdByName']),
      sample: pickRows(g.samples, ['sampleType', 'sentDate', 'buyerApprovalDate', 'revision']),
      productionPlan: pickRows(g.plans, ['line', 'dailyTarget', 'plannedStart', 'plannedEnd', 'actualProduction', 'achievementPct']),
      cutting: pickRows(g.cutting, ['entryDate', 'cutQty', 'wastagePct']),
      sewing: pickRows(g.sewing, ['entryDate', 'line', 'targetQty', 'actualQty', 'efficiencyPct', 'dhu']),
      finishing: pickRows(g.finishing, ['entryDate', 'inputQty', 'passedQty', 'rejection']),
      packing: pickRows(g.packing, ['packingDate', 'totalCartons', 'totalQty', 'totalCbm']),
      inspection: pickRows(g.inspections, ['inspectionDate', 'inspectionType', 'aqlResult', 'totalDefects']),
      shipment: pickRows(g.shipments, ['shipmentDate', 'mode', 'qty', 'blAwbNo']),
      invoice: pickRows(g.invoices, ['invoiceNo', 'totalAmount', 'receivedAmount', 'outstanding', 'dueDate']),
      payment: pickRows(g.payments, ['paymentDate', 'amount', 'reference']),
      expense: pickRows(g.expenses, ['category', 'amount', 'expenseDate']),
      documents: g.docs.map((d) => ({ _id: d._id, refNo: d.refNo, docType: d.docType, title: d.title, currentVersion: d.currentVersion, jobNo: d.jobNo })),
    },
  });
}));

/* Profit analysis */
r.get('/:id/profit', permit('profit', 'view'), asyncHandler(async (req, res) => {
  const job = (await findJob(req.params.id)).toObject();
  res.json(computeProfit(await loadJobGraph(job)));
}));

/* Forecast: create sub jobs (Admin only) */
r.post('/:id/subjobs', adminOnly, asyncHandler(async (req, res) => {
  const created = await createSubJobs(req.params.id, req.body.subJobs || [], req);
  res.status(201).json(created);
}));

/* Forecast: change a sub job quantity (Admin only) */
r.put('/:id/subjobs/:subId', adminOnly, asyncHandler(async (req, res) => {
  const sub = await findJob(req.params.subId);
  if (String(sub.parentJob) !== String(req.params.id) && sub.parentJobNo !== req.params.id) throw ApiError.badRequest('Not a sub job of this job');
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw ApiError.badRequest('Reason is mandatory');
  const before = sub.orderQty;
  sub.orderQty = num(req.body.orderQty);
  if (!(sub.orderQty > 0)) throw ApiError.badRequest('Quantity must be greater than 0');
  sub.orderValue = num(sub.orderQty) * num(sub.unitPrice);
  await sub.save();
  await audit(req, { action: 'OVERRIDE', module: 'orders', record: sub, reason, changes: [{ field: 'orderQty', old: before, new: sub.orderQty }], message: `${req.user.name} changed sub job ${sub.jobNo} qty from ${before} to ${sub.orderQty}` });
  const impact = await propagateJobChanges(sub.toObject(), [{ field: 'orderQty' }], req);
  await refreshJob(sub._id);
  res.json({ job: sub, impact });
}));

/* Regenerate missing downstream records (Admin) */
r.post('/:id/regenerate', adminOnly, asyncHandler(async (req, res) => {
  const job = (await findJob(req.params.id)).toObject();
  const created = job.isForecast && !job.parentJob ? [await ensureFabricForecast(job, req)].filter(Boolean) : await generateDownstream(job, req);
  await refreshJob(job._id);
  res.json({ created: created.length });
}));

/* Approve outstanding payment as acceptable for closure */
r.post('/:id/approve-outstanding', permit('jobs', 'approve'), asyncHandler(async (req, res) => {
  const job = await findJob(req.params.id);
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw ApiError.badRequest('Reason is mandatory');
  job.outstandingApproved = !!req.body.approved;
  job.outstandingApprovedBy = req.user._id;
  await job.save();
  await audit(req, { action: 'APPROVE', module: 'jobs', record: job, reason, message: `${req.user.name} ${job.outstandingApproved ? 'approved' : 'revoked'} outstanding status for ${job.jobNo}` });
  res.json(await refreshJob(job._id));
}));

/* Job closure */
r.post('/:id/close', permit('jobs', 'close'), asyncHandler(async (req, res) => {
  const job = await findJob(req.params.id);
  const fresh = await refreshJob(job._id, { notifyReady: false });
  const reason = String(req.body.reason || '').trim();
  if (fresh.status === 'Closed') throw ApiError.badRequest('Job already closed');
  let override = false;
  if (!fresh.readyToClose) {
    if (!can(req.perms, 'jobs', 'override') || !reason) {
      throw ApiError.badRequest('Job is not ready to close', { code: 'OVERRIDE_REQUIRED', blockers: fresh.closureBlockers });
    }
    override = true;
  }
  const from = fresh.status;
  await Job.updateOne({ _id: job._id }, {
    $set: { status: 'Closed', closedAt: new Date(), closedBy: req.user._id, closureRemarks: req.body.remarks || reason, readyToClose: false },
    $push: { statusHistory: { from, to: 'Closed', by: req.user._id, byName: req.user.name, reason, override } },
  });
  await audit(req, { action: override ? 'OVERRIDE' : 'CLOSE', module: 'jobs', record: job, reason, changes: [{ field: 'status', old: from, new: 'Closed' }], message: `${req.user.name} closed job ${job.jobNo}${override ? ` with override (${fresh.closureBlockers.join('; ')})` : ''}` });
  await notify({ type: 'INFO', severity: 'success', title: `JOB CLOSED: ${job.jobNo}`, message: `${job.styleNo} closed by ${req.user.name}.`, departments: ['Admin', 'Accounts & Finance', 'Head Office Merchandising', 'Factory Merchandising'], job });
  res.json(await refreshJob(job._id));
}));

/* Reopen (Admin) */
r.post('/:id/reopen', adminOnly, asyncHandler(async (req, res) => {
  const job = await findJob(req.params.id);
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw ApiError.badRequest('Reason is mandatory');
  if (job.status !== 'Closed') throw ApiError.badRequest('Job is not closed');
  job.status = 'In Progress';
  job.statusHistory.push({ from: 'Closed', to: 'In Progress', by: req.user._id, byName: req.user.name, reason, override: true });
  await job.save();
  await audit(req, { action: 'REOPEN', module: 'jobs', record: job, reason, message: `${req.user.name} reopened ${job.jobNo}` });
  res.json(await refreshJob(job._id));
}));

/* Soft delete / restore */
r.delete('/:id', permit('orders', 'delete'), asyncHandler(async (req, res) => {
  const job = await findJob(req.params.id);
  const reason = String(req.body?.reason || '').trim();
  if (!reason) throw ApiError.badRequest('Reason is mandatory');
  if (await Job.exists({ parentJob: job._id, isDeleted: false })) throw ApiError.badRequest('Delete sub jobs first');
  const activity = sum(await models.cutting.find({ job: job._id, isDeleted: false }).lean(), 'cutQty');
  if (activity > 0 && !req.perms.isAdmin) throw ApiError.forbidden('Job has production activity – only Admin can delete');
  job.isDeleted = true; job.deletedAt = new Date(); job.deletedBy = req.user._id; job.deleteReason = reason;
  await job.save();
  await audit(req, { action: 'DELETE', module: 'orders', record: job, reason, message: `${req.user.name} deleted job ${job.jobNo}` });
  if (job.parentJob) await refreshJob(job.parentJob);
  res.json({ ok: true });
}));

r.post('/:id/restore', adminOnly, asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job || !job.isDeleted) throw ApiError.notFound();
  job.isDeleted = false; job.deletedAt = null; job.deleteReason = null;
  await job.save();
  await audit(req, { action: 'RESTORE', module: 'orders', record: job, message: `${req.user.name} restored job ${job.jobNo}` });
  res.json(await refreshJob(job._id));
}));

export default r;
