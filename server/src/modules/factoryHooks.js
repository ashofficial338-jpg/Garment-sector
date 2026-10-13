/**
 * Business rules for factory operations: hourly production sheets (with automatic daily consolidation),
 * quality inspections and gates, rework & corrective action, attendance, payroll and factory expenses.
 * Same contract as hooks.js: beforeSave may mutate ctx.data and throws to block; guard() allows an
 * authorised override with a reason (audited); afterSave performs side effects.
 */
import mongoose from 'mongoose';
import { models } from './builder.js';
import { guard, dayRange, isoDay } from './guards.js';
import { ApiError } from '../utils/ApiError.js';
import { notify } from '../services/notify.js';
import { audit } from '../services/audit.js';
import { can } from '../services/permissions.js';
import { nextRefNo } from '../services/numbering.js';
import { applyCompute, MODULES } from '../../../shared/modules/index.js';
import { num, sum, round } from '../../../shared/calc.js';
import { SHIFTS, qcStage, reworkTotals, PRODUCTION_DEPARTMENTS } from '../../../shared/modules/factory.js';
import { DEFECT_CATEGORY_OF } from '../../../shared/modules/production.js';
import { flowViolations, loadRoutes, resolveRoute, cuttingLimit, stageSource, lotDisposition } from '../services/factoryFlow.js';
import { syncProductionPlan } from './hooks.js';

const oid = () => new mongoose.Types.ObjectId();
const stampNow = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const others = (key, ctx, extra = {}) => models[key].find({ isDeleted: false, _id: { $ne: ctx.existing?._id }, ...extra }).lean();

/** Production and costs are recorded against the leaf job: a main job with sub jobs is the sum of its sub jobs. */
async function requireLeafJob(job, what) {
  if (job && await models.orders.exists({ parentJob: job._id, isDeleted: false })) {
    throw ApiError.badRequest(`${job.jobNo} is a main job with sub jobs – record ${what} against the sub job (e.g. ${job.jobNo}-S01) so the main job total is not double counted`);
  }
}

/** Row-level audit: rows keep who entered them and when; a changed row is stamped with who changed it. */
function stampRows(rows, oldRows, fields, req) {
  const old = new Map((oldRows || []).map((r) => [String(r._id), r]));
  const who = req?.user?.name || 'system';
  return (rows || []).map((r) => {
    const prev = r._id ? old.get(String(r._id)) : null;
    if (!prev) return { ...r, enteredBy: who, enteredAt: stampNow() };
    const changed = fields.some((f) => String(prev[f] ?? '') !== String(r[f] ?? ''));
    return { ...r, enteredBy: prev.enteredBy || who, enteredAt: changed ? `${stampNow()} (changed by ${who})` : prev.enteredAt };
  });
}

/* ================================ Hourly production ================================ */
const SLOT_FIELDS = ['slot', 'color', 'size', 'target', 'inputQty', 'completedQty', 'rejectedQty', 'reworkQty', 'downtimeMin', 'delayReason', 'team', 'workingHours', 'remarks'];
/** Hourly departments consolidated into the existing daily department entries (so plans, lifecycle and reports follow). */
const CONSOLIDATE = { 'Sewing and Stitching': 'sewing', 'Ironing and Finishing': 'finishing' };
const shiftIdx = (s) => Math.max(SHIFTS.indexOf(s || 'General'), 0);

async function openingBalance(job, d, existingId) {
  const day = new Date(isoDay(d.entryDate));
  const prev = await models.hourlyProduction.find({ job: job._id, department: d.department, isDeleted: false, status: { $ne: 'Rejected' }, _id: { $ne: existingId }, entryDate: { $lte: day } }).lean();
  return sum(prev.filter((s) => new Date(s.entryDate) < day || shiftIdx(s.shift) < shiftIdx(d.shift)), (s) => num(s.inputQty) - num(s.completedQty) - num(s.rejectedQty));
}

export const hourlyProduction = {
  async beforeSave(ctx) {
    const d = ctx.data;
    await requireLeafJob(ctx.job, 'hourly production');
    if (new Date(d.entryDate) > new Date(Date.now() + 86400000)) throw ApiError.badRequest('Production cannot be entered for a future date');
    // one sheet per job, department, date, shift and line – a second sheet would post the same hours twice
    const dup = await models.hourlyProduction.findOne({ job: ctx.job._id, department: d.department, entryDate: dayRange(d.entryDate), shift: d.shift || 'General', line: d.line || { $in: [null, ''] }, isDeleted: false, _id: { $ne: ctx.existing?._id } }).select('refNo').lean();
    if (dup) throw ApiError.conflict(`Hourly sheet ${dup.refNo} already exists for ${ctx.job.jobNo} · ${d.department} · ${isoDay(d.entryDate)} · ${d.shift || 'General'}${d.line ? ` · ${d.line}` : ''} – add the hours to that sheet`);
    const slots = (d.slots || []).filter((s) => s && (s.slot || num(s.inputQty) || num(s.completedQty) || num(s.rejectedQty)));
    if (!slots.length) throw ApiError.badRequest('Enter at least one hourly row');
    const labels = slots.map((s) => String(s.slot || '').trim()).filter(Boolean);
    if (new Set(labels).size !== labels.length) throw ApiError.badRequest('The same hour / slot is entered twice on this sheet');
    slots.forEach((s, i) => {
      if (!String(s.slot || '').trim()) throw ApiError.badRequest(`Row ${i + 1}: hour / slot is required`);
      if (num(s.reworkQty) > num(s.inputQty) + num(s.completedQty)) throw ApiError.badRequest(`Row ${s.slot}: rework cannot exceed the pieces handled`);
    });
    d.slots = stampRows(slots.map((s) => ({ ...s, color: s.color || d.color, size: s.size || d.size })), ctx.existing?.slots, SLOT_FIELDS, ctx.req);
    d.openingQty = await openingBalance(ctx.job, d, ctx.existing?._id);

    const route = resolveRoute(ctx.job, await loadRoutes());
    guard(ctx, route.steps.some((s) => s.department === d.department), `${d.department} is not on the production route "${route.name}" of ${ctx.job.jobNo}`);
    const proposed = applyCompute(MODULES.hourlyProduction, { ...ctx.existing, ...d, _id: ctx.existing?._id || oid(), job: ctx.job._id, status: ctx.existing?.status || 'Submitted', isDeleted: false });
    const { violations, after } = await flowViolations(ctx.job, { sheet: proposed });
    violations.forEach((v) => guard(ctx, false, v));
    if (route.steps[0]?.department === d.department) {
      const limit = await cuttingLimit(ctx.job);
      guard(ctx, after.departments[0].input <= limit, `Cumulative ${d.department} input (${after.departments[0].input}) exceeds the order quantity + over-cut tolerance (${limit})`);
    }
  },
  async beforeStatus(gate) {
    // rejecting a sheet takes its quantities out of the flow – later departments must not depend on them
    if (gate.to !== 'Rejected' && gate.from !== 'Rejected') return;
    const job = await models.orders.findById(gate.doc.job).lean();
    const { violations } = await flowViolations(job, { sheet: { ...gate.doc, status: gate.to } });
    violations.forEach((v) => guard(gate, false, v));
  },
  async afterSave(ctx) { await consolidateDaily(ctx.saved, ctx.req); },
  async afterDelete(rec) { await consolidateDaily(rec, null); },
};

/**
 * Daily consolidation: all live hourly sheets of a job, department, date and line → one daily Sewing / Finishing
 * entry (created, updated or removed automatically). The daily entry is the sum of its hourly rows, so the
 * hourly and daily figures can never disagree.
 */
export async function consolidateDaily(sheet, req) {
  const key = CONSOLIDATE[sheet.department];
  if (!key) return;
  const day = isoDay(sheet.entryDate);
  const ck = `${sheet.job}|${sheet.department}|${day}|${sheet.line || ''}`;
  const M = models[key]; const def = MODULES[key];
  const sheets = await models.hourlyProduction.find({ job: sheet.job, department: sheet.department, entryDate: dayRange(day), line: sheet.line || { $in: [null, ''] }, isDeleted: false, status: { $ne: 'Rejected' } }).sort({ shift: 1 }).lean();
  let doc = await M.findOne({ consolidationKey: ck, autoPosted: true });
  const who = { _id: req?.user?._id, name: req?.user?.name || 'system' };
  if (!sheets.length) {
    if (doc && !doc.isDeleted) {
      Object.assign(doc, { isDeleted: true, deletedAt: new Date(), deleteReason: 'Hourly sheets removed or rejected' });
      await doc.save();
      await audit(req, { action: 'DELETE', module: key, record: doc, message: `${def.singular} ${doc.refNo} removed – its hourly sheets were deleted or rejected` });
      if (key === 'sewing') await syncProductionPlan(await models.orders.findById(sheet.job).lean());
    }
    return;
  }
  const job = await models.orders.findById(sheet.job).lean();
  const slots = sheets.flatMap((s) => s.slots || []);
  const t = (k) => sum(sheets, k);
  const refs = sheets.map((s) => s.refNo).join(', ');
  let data;
  if (key === 'sewing') {
    const plan = await models.productionPlan.findOne({ job: sheet.job, isDeleted: false }).lean();
    const bySlot = new Map();
    slots.forEach((s) => { const h = bySlot.get(s.slot) || { hour: s.slot, target: 0, output: 0 }; h.target += num(s.target); h.output += num(s.completedQty); bySlot.set(s.slot, h); });
    data = {
      entryDate: new Date(day), line: sheet.line || 'Line (hourly)', floor: plan?.floor, supervisor: sheets.find((s) => s.supervisor)?.supervisor,
      operators: Math.max(...sheets.map((s) => num(s.operators))), helpers: Math.max(...sheets.map((s) => num(s.helpers))),
      sam: plan?.sam, workingMinutes: Math.max(...sheets.map((s) => (s.slots || []).length), 1) * 60,
      inputQty: t('inputQty'), targetQty: t('targetQty'), hourly: [...bySlot.values()], manualOutput: t('completedQty'),
      checkedQty: t('completedQty') + t('rejectedQty'), rejection: t('rejectedQty'), alteration: t('reworkQty'),
      remarks: `Consolidated automatically from hourly sheets ${refs}`,
    };
  } else {
    data = {
      entryDate: new Date(day), process: 'Ironing', color: sheets.find((s) => s.color)?.color,
      inputQty: t('inputQty'), passedQty: t('completedQty'), rework: t('reworkQty'), rejection: t('rejectedQty'), ironedQty: t('inputQty'),
      remarks: `Consolidated automatically from hourly sheets ${refs}`,
    };
  }
  data = applyCompute(def, data);
  const status = sheets.every((s) => s.status === 'Approved') ? 'Approved' : 'Submitted';
  const envelope = { job: job._id, jobNo: job.jobNo, parentJob: job.parentJob || null, parentJobNo: job.parentJobNo || null, buyerName: job.buyerName, styleNo: job.styleNo, poNo: job.poNo, autoPosted: true, consolidationKey: ck, sourceSheets: sheets.map((s) => s._id) };
  if (!doc) {
    doc = await M.create({ ...data, ...envelope, status, refNo: await nextRefNo(def.prefix), createdBy: who._id, createdByName: who.name, businessUnit: job.businessUnit, statusHistory: [{ from: null, to: status, by: who._id, byName: who.name, reason: 'Consolidated from hourly sheets' }] });
    await audit(req, { action: 'CREATE', module: key, record: doc, message: `${def.singular} ${doc.refNo} consolidated from hourly sheets ${refs}` });
  } else {
    def.fields.forEach((f) => { if (f.name in data) doc.set(f.name, data[f.name]); });
    Object.assign(doc, envelope, { isDeleted: false, deletedAt: null, deleteReason: null, updatedBy: who._id });
    if (doc.status !== status) doc.statusHistory.push({ from: doc.status, to: status, by: who._id, byName: who.name, reason: 'Hourly sheet approval' });
    doc.status = status;
    await doc.save();
    await audit(req, { action: 'UPDATE', module: key, record: doc, message: `${def.singular} ${doc.refNo} re-consolidated from hourly sheets ${refs}` });
  }
  await models.hourlyProduction.updateMany({ _id: { $in: sheets.map((s) => s._id) } }, { $set: { consolidatedTo: { module: key, refNo: doc.refNo, id: doc._id } } });
  if (key === 'sewing') await syncProductionPlan(job);
}

/** Daily entries that were consolidated from hourly sheets are edited through those sheets, not directly. */
export function lockConsolidated(ctx, what) {
  if (!ctx.isCreate && ctx.existing?.autoPosted) guard(ctx, false, `${what} ${ctx.existing.refNo} is consolidated from hourly sheets – change the hourly sheets instead`);
}

/* ================================ Quality inspections ================================ */
async function checkpointPlan(stage, job) {
  const plans = await models.qcCheckpoint.find({ isDeleted: false, status: 'Active', inspectionStage: stage }).lean();
  const fits = plans.filter((p) => (!p.buyer || String(p.buyer) === String(job.buyer)) && (!p.styleNo || p.styleNo.trim().toLowerCase() === String(job.styleNo || '').toLowerCase()));
  return fits.sort((a, b) => ((b.styleNo ? 2 : 0) + (b.buyer ? 1 : 0)) - ((a.styleNo ? 2 : 0) + (a.buyer ? 1 : 0)))[0];
}

/** Stage defaults, checkpoints, defect categories, lot disposition and the quantity reconciliation with production. */
export async function inspectionRules(ctx) {
  const d = ctx.data;
  const st = qcStage(d.inspectionStage);
  if (st) {
    if (d.inspectionType !== 'Re-inspection') d.inspectionType = st.type;
    const route = resolveRoute(ctx.job, await loadRoutes());
    if (!d.department) d.department = stageSource(route, d.inspectionStage) || st.dept || undefined;
    if (!(d.checklist || []).length) {
      const plan = await checkpointPlan(d.inspectionStage, ctx.job);
      if (plan) {
        d.checklist = (plan.checkpoints || []).map((c) => ({ parameter: c.parameter, specification: c.specification, tolerance: c.tolerance }));
        d.inspectionMethod ||= plan.inspectionMethod;
        if (ctx.isCreate) { d.majorAql = plan.majorAql || d.majorAql; d.minorAql = plan.minorAql || d.minorAql; }
      }
    }
  }
  d.defectLines = (d.defectLines || []).map((l) => ({ ...l, defectCategory: l.defectCategory || DEFECT_CATEGORY_OF[l.defectType] || (l.defectType ? 'Other' : undefined) }));
  const disp = ['passQty', 'reworkQty', 'rejectQty', 'heldQty'];
  if (disp.some((k) => d[k] !== null && d[k] !== undefined && d[k] !== '')) {
    const total = disp.reduce((t, k) => t + num(d[k]), 0);
    if (total !== num(d.lotSize)) throw ApiError.badRequest(`Passed + rework + rejected + held (${total}) must equal the lot quantity submitted (${num(d.lotSize)})`);
  }
  if (st) {
    const proposed = applyCompute(MODULES.inspection, { ...ctx.existing, ...d, _id: ctx.existing?._id || oid(), job: ctx.job._id, isDeleted: false });
    const { violations, after } = await flowViolations(ctx.job, { inspection: proposed });
    if (after.onFlow) violations.forEach((v) => guard(ctx, false, v));
  }
}

/** A status change that takes passed pieces back (e.g. a lot failed after release) must not strand later departments. */
export async function inspectionStatusRules(gate) {
  if (!gate.doc.inspectionStage) return;
  const job = await models.orders.findById(gate.doc.job).lean();
  const { violations, after } = await flowViolations(job, { inspection: { ...gate.doc, status: gate.to } });
  if (after.onFlow) violations.forEach((v) => guard(gate, false, v));
}

/* ================================ Rework & corrective action ================================ */
export const qcRework = {
  async beforeSave(ctx) {
    const d = ctx.data;
    const ins = await models.inspection.findById(d.inspection).lean();
    if (!ins || ins.isDeleted || String(ins.job) !== String(ctx.job._id)) throw ApiError.badRequest('The inspection belongs to a different job');
    d.inspectionStage = ins.inspectionStage || `${ins.inspectionType || ''} inspection`.trim();
    if (!d.defectType) {
      const top = [...(ins.defectLines || [])].sort((a, b) => num(b.count) - num(a.count))[0];
      if (top) Object.assign(d, { defectType: top.defectType, defectCategory: d.defectCategory || top.defectCategory, severity: top.severity || d.severity });
    }
    if (d.defectType && !d.defectCategory) d.defectCategory = DEFECT_CATEGORY_OF[d.defectType] || 'Other';
    // an issue resolves the failed (rework) and held pieces of its inspection – never more than that
    const disp = lotDisposition(ins);
    const pool = disp.rework + disp.held;
    const otherIssues = sum(await others('qcRework', ctx, { inspection: ins._id }), 'failedQty');
    if (ctx.isCreate && !num(d.failedQty)) d.failedQty = Math.max(pool - otherIssues, 0);
    if (num(d.failedQty) <= 0) throw ApiError.badRequest(`Nothing left to rework on ${ins.refNo}: its failed / held quantity (${pool}) is already covered`);
    if (otherIssues + num(d.failedQty) > pool) throw ApiError.badRequest(`Quality issues on ${ins.refNo} would cover ${otherIssues + num(d.failedQty)} pcs, but only ${pool} pcs failed or were held`);
    const must = (ok, msg) => { if (!ok) throw ApiError.badRequest(msg); };
    must(num(d.reworkedQty) + num(d.scrapQty) + num(d.releasedQty) <= num(d.failedQty), 'Reworked + scrapped + released cannot exceed the failed / held quantity');
    must(num(d.reinspectedQty) <= num(d.reworkedQty), 'Reinspected quantity cannot exceed the reworked quantity');
    must(num(d.reinspPassedQty) + num(d.reinspRejectedQty) <= num(d.reinspectedQty), 'Passed + rejected on reinspection cannot exceed the reinspected quantity');
    if ((num(d.reinspPassedQty) || num(d.reinspRejectedQty)) && !d.reinspectionDate) throw ApiError.badRequest('Record the reinspection date');
    if (d.reworkEndDate && d.reworkStartDate && new Date(d.reworkEndDate) < new Date(d.reworkStartDate)) throw ApiError.badRequest('Rework completion is before its start');
    // release under concession is a quality decision: Quality Release permission and a reason, audited
    const prevRel = num(ctx.existing?.releasedQty);
    if (num(d.releasedQty) !== prevRel) {
      if (!can(ctx.req.perms, 'qualityRelease', 'approve')) throw ApiError.forbidden('Releasing held goods requires the Quality Release permission');
      if (!String(d.releaseReason || '').trim()) throw ApiError.badRequest('A release reason is mandatory');
      d.releasedBy = `${ctx.req.user.name} · ${stampNow()}`;
      ctx.releaseChanged = { from: prevRel, to: num(d.releasedQty) };
    }
    const proposed = applyCompute(MODULES.qcRework, { ...ctx.existing, ...d, _id: ctx.existing?._id || oid(), job: ctx.job._id, isDeleted: false });
    const { violations, after } = await flowViolations(ctx.job, { rework: proposed });
    if (after.onFlow) violations.forEach((v) => guard(ctx, false, v));
  },
  async beforeStatus(gate) {
    const doc = gate.doc;
    if (gate.to === 'Reinspection' && !num(doc.reworkedQty)) throw ApiError.badRequest('Record the reworked quantity before submitting it for reinspection');
    if (gate.to === 'Closed') {
      if (!can(gate.req.perms, 'qcRework', 'approve')) throw ApiError.forbidden('Closing a quality issue requires approve permission');
      const t = reworkTotals(doc);
      if (t.pendingQty > 0 || t.awaitingReinspectionQty > 0) throw ApiError.badRequest(`Cannot close: ${t.pendingQty} pcs are still pending and ${t.awaitingReinspectionQty} reworked pcs have not been reinspected`);
      if (!String(doc.correctiveAction || '').trim()) throw ApiError.badRequest('Record the corrective action before closing the issue');
    }
  },
  async afterSave(ctx) {
    const d = ctx.saved;
    if (ctx.releaseChanged) {
      await audit(ctx.req, { action: 'OVERRIDE', module: 'qcRework', record: d, reason: d.releaseReason, changes: [{ field: 'releasedQty', old: ctx.releaseChanged.from, new: ctx.releaseChanged.to }], message: `${ctx.req.user.name} released ${ctx.releaseChanged.to} pcs of ${d.refNo} without rework (concession)` });
    }
    if (ctx.isCreate) {
      await notify({ type: 'QUALITY_FAIL', severity: 'warning', title: `Quality issue ${d.refNo} – ${d.jobNo}`, message: `${d.failedQty} pcs ${d.defectType || ''} at ${d.inspectionStage}. Assigned to ${d.assignedDept || 'not assigned yet'}.`, departments: ['Quality', 'Production', ...(d.assignedDept && ['Cutting', 'Sewing', 'Finishing', 'Packing'].includes(d.assignedDept) ? [d.assignedDept] : [])], job: ctx.job, module: 'qcRework', recordId: d._id });
    }
    if (ctx.saved.status === 'Closed' && ctx.existing?.status !== 'Closed') await models.qcRework.updateOne({ _id: d._id }, { $set: { closedAt: new Date() } });
  },
};

/* ================================ Shipment quality release ================================ */
/** Goods are shipped only from quality-released, not-held finished goods (jobs on department flow). */
export async function shipmentStatusRules(gate) {
  if (!['Shipped', 'Delivered'].includes(gate.to) || ['Shipped', 'Delivered'].includes(gate.from)) return;
  const job = await models.orders.findById(gate.doc.job).lean();
  const { before, violations } = await flowViolations(job, { shipment: { ...gate.doc, status: gate.to } });
  if (!before.onFlow) return;
  const avail = before.fg.availableForShipment;
  const ok = num(gate.doc.qty) <= avail && !violations.length;
  if (!ok && gate.override && !can(gate.req.perms, 'qualityRelease', 'approve')) throw ApiError.forbidden('Shipping goods that are not quality-released requires the Quality Release permission');
  guard(gate, ok, `Only ${avail} pcs are quality-released and not held for shipment (${num(gate.doc.qty)} pcs on this shipment)${violations.length ? ` – ${violations.join('; ')}` : ''}`);
}

/* ================================ Attendance ================================ */
export const attendance = {
  async beforeSave(ctx) {
    const d = ctx.data;
    if (new Date(d.attendanceDate) > new Date(Date.now() + 86400000)) throw ApiError.badRequest('Attendance cannot be entered for a future date');
    const dup = await models.attendance.findOne({ attendanceDate: dayRange(d.attendanceDate), shift: d.shift || 'General', section: d.section, line: d.line || { $in: [null, ''] }, isDeleted: false, _id: { $ne: ctx.existing?._id } }).select('refNo').lean();
    if (dup) throw ApiError.conflict(`Attendance sheet ${dup.refNo} already exists for ${d.section}${d.line ? ` · ${d.line}` : ''} on ${isoDay(d.attendanceDate)} (${d.shift || 'General'})`);
    const rows = (d.rows || []).filter((r) => r && String(r.empCode || '').trim());
    if (!rows.length) throw ApiError.badRequest('Add at least one employee');
    const codes = rows.map((r) => String(r.empCode).trim());
    const twice = codes.filter((c, i) => codes.indexOf(c) !== i);
    if (twice.length) throw ApiError.badRequest(`Employee ${[...new Set(twice)].join(', ')} entered twice on this sheet`);
    const emps = new Map((await models.employee.find({ empCode: { $in: codes }, isDeleted: false }).lean()).map((e) => [e.empCode, e]));
    const unknown = codes.filter((c) => !emps.has(c));
    if (unknown.length) throw ApiError.badRequest(`Unknown employee code(s): ${unknown.join(', ')}`);
    const left = codes.filter((c) => emps.get(c).status === 'Resigned');
    if (left.length) throw ApiError.badRequest(`Employee(s) ${left.join(', ')} have resigned`);
    // each employee once per day across all sheets – otherwise the same wages would be posted twice
    const clash = await models.attendance.find({ attendanceDate: dayRange(d.attendanceDate), isDeleted: false, status: { $ne: 'Rejected' }, _id: { $ne: ctx.existing?._id }, 'rows.empCode': { $in: codes } }).select('refNo section rows.empCode').lean();
    if (clash.length) {
      const hit = clash.flatMap((s) => s.rows.filter((r) => codes.includes(r.empCode)).map((r) => `${r.empCode} (${s.refNo} ${s.section})`));
      throw ApiError.conflict(`Already on another attendance sheet for ${isoDay(d.attendanceDate)}: ${hit.join(', ')}`);
    }
    const jobNos = [...new Set(rows.map((r) => String(r.jobNo || '').trim()).filter(Boolean))];
    if (jobNos.length) {
      const jobs = await models.orders.find({ jobNo: { $in: jobNos }, isDeleted: false }).select('jobNo isForecast subJobCount').lean();
      const missing = jobNos.filter((j) => !jobs.some((x) => x.jobNo === j));
      if (missing.length) throw ApiError.badRequest(`Unknown job(s) in this unit: ${missing.join(', ')}`);
      const mains = jobs.filter((x) => x.isForecast && num(x.subJobCount) > 0).map((x) => x.jobNo);
      if (mains.length) throw ApiError.badRequest(`${mains.join(', ')} have sub jobs – allocate the hours to the sub job`);
    }
    const old = new Map((ctx.existing?.rows || []).map((r) => [String(r._id), r]));
    d.rows = rows.map((r) => {
      const e = emps.get(String(r.empCode).trim());
      const prev = r._id ? old.get(String(r._id)) : null;
      const keep = prev && prev.empCode === e.empCode && num(prev.hourlyRate) > 0;
      const hrs = num(r.hours) + num(r.otHours);
      if (num(r.hours) < 0 || hrs > 16) throw ApiError.badRequest(`${e.empCode}: hours + overtime cannot exceed 16 a day`);
      const hourlyRate = keep ? prev.hourlyRate : num(e.hourlyRate);
      return {
        ...r, empCode: e.empCode, name: e.name, jobNo: String(r.jobNo || '').trim() || undefined,
        hourlyRate, otRate: keep ? prev.otRate : num(e.otRatePerHour) || round(hourlyRate * 2, 4), employerPct: keep ? prev.employerPct : num(e.employerContributionPct),
      };
    });
  },
};

/* ================================ Payroll ================================ */
const monthRange = (period) => {
  const [y, m] = period.split('-').map(Number);
  return { $gte: new Date(Date.UTC(y, m - 1, 1)), $lt: new Date(Date.UTC(y, m, 1)) };
};

/** Payroll lines built from the month's attendance: days, hours and approved overtime at the employee master rates. */
async function linesFromAttendance(period, contract) {
  const sheets = await models.attendance.find({ attendanceDate: monthRange(period), isDeleted: false, status: { $ne: 'Rejected' } }).lean();
  const byEmp = new Map();
  sheets.forEach((s) => s.rows.forEach((r) => {
    const x = byEmp.get(r.empCode) || { days: 0, leave: 0, hours: 0, ot: 0, incentive: 0, section: s.section };
    if (r.status === 'Present') x.days += 1; else if (r.status === 'Half Day') x.days += 0.5; else if (r.status === 'Leave') x.leave += 1;
    if (['Present', 'Half Day'].includes(r.status)) { x.hours += num(r.hours); x.ot += num(r.otHours); x.incentive += num(r.incentive); }
    byEmp.set(r.empCode, x);
  }));
  const emps = await models.employee.find({ empCode: { $in: [...byEmp.keys()] }, isDeleted: false }).lean();
  return emps.filter((e) => (e.employmentType === 'Contract') === contract).map((e) => {
    const x = byEmp.get(e.empCode);
    const std = num(e.standardDays) || 26;
    const basic = e.wageType === 'Daily wage' ? round(num(e.dailyWage) * x.days, 2) : round((num(e.monthlySalary) * Math.min(x.days + x.leave, std)) / std, 2);
    const otAmount = round(x.ot * (num(e.otRatePerHour) || num(e.hourlyRate) * 2), 2);
    const employer = round(((basic + otAmount) * num(e.employerContributionPct)) / 100, 2);
    return { empCode: e.empCode, name: e.name, section: e.section || x.section, daysWorked: x.days, hoursWorked: round(x.hours, 2), otHours: round(x.ot, 2), basicWages: basic, otAmount, incentive: round(x.incentive, 2), employerContribution: employer, deductions: num(e.employerContributionPct) ? round(basic * 0.12, 2) : 0 };
  }).sort((a, b) => a.empCode.localeCompare(b.empCode));
}

export const payroll = {
  async beforeSave(ctx) {
    const d = ctx.data;
    d.period = String(d.period || '').trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(d.period)) throw ApiError.badRequest('Payroll month must be YYYY-MM');
    const contract = d.payrollType === 'Contract labour';
    const dup = await models.payroll.findOne({ period: d.period, payrollType: d.payrollType, contractor: d.contractor || { $in: [null, ''] }, isDeleted: false, status: { $ne: 'Cancelled' }, _id: { $ne: ctx.existing?._id } }).select('refNo').lean();
    if (dup) throw ApiError.conflict(`Payroll ${dup.refNo} already exists for ${d.period} (${d.payrollType}) – salaries must not be posted twice`);
    if (!(d.lines || []).length) {
      d.lines = await linesFromAttendance(d.period, contract);
      if (!d.lines.length) throw ApiError.badRequest(`No attendance found for ${d.period} – enter the payroll lines or the attendance first`);
    }
    const codes = d.lines.map((l) => String(l.empCode || '').trim());
    if (codes.some((c) => !c)) throw ApiError.badRequest('Every payroll line needs an employee code');
    const twice = codes.filter((c, i) => codes.indexOf(c) !== i);
    if (twice.length) throw ApiError.badRequest(`Employee ${[...new Set(twice)].join(', ')} appears twice in this payroll`);
    const known = new Set((await models.employee.find({ empCode: { $in: codes }, isDeleted: false }).select('empCode').lean()).map((e) => e.empCode));
    const unknown = codes.filter((c) => !known.has(c));
    if (unknown.length) throw ApiError.badRequest(`Unknown employee code(s): ${unknown.join(', ')}`);
    const clash = await models.payroll.find({ period: d.period, isDeleted: false, status: { $ne: 'Cancelled' }, _id: { $ne: ctx.existing?._id }, 'lines.empCode': { $in: codes } }).select('refNo lines.empCode').lean();
    if (clash.length) throw ApiError.conflict(`Already paid in another ${d.period} payroll: ${clash.flatMap((p) => p.lines.filter((l) => codes.includes(l.empCode)).map((l) => `${l.empCode} (${p.refNo})`)).join(', ')}`);
    d.lines.forEach((l) => { ['basicWages', 'otAmount', 'incentive', 'employerContribution', 'deductions'].forEach((k) => { if (num(l[k]) < 0) throw ApiError.badRequest(`${l.empCode}: amounts cannot be negative`); }); });
  },
  async beforeStatus(gate) {
    if (gate.to === 'Paid' && !gate.doc.paymentDate) throw ApiError.badRequest('Enter the payment date before marking the payroll as paid');
  },
};

/* ================================ Factory expenses ================================ */
export const factoryExpense = {
  async beforeSave(ctx) {
    const d = ctx.data;
    if (ctx.job) await requireLeafJob(ctx.job, 'job costs');
    if (num(d.amount) <= 0) throw ApiError.badRequest('Amount must be greater than 0');
    const payee = String(d.payee || '').trim();
    const rx = (v) => new RegExp(`^${String(v).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (d.recurring) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(d.period || ''))) throw ApiError.badRequest('A recurring bill needs its bill period (YYYY-MM)');
      const dup = await models.factoryExpense.findOne({ recurring: true, period: d.period, category: d.category, payee: rx(payee), isDeleted: false, status: { $ne: 'Rejected' }, _id: { $ne: ctx.existing?._id } }).select('refNo').lean();
      if (dup) throw ApiError.conflict(`${d.category} bill of ${payee} for ${d.period} is already recorded (${dup.refNo})`);
    }
    if (String(d.referenceNo || '').trim()) {
      const dup = await models.factoryExpense.findOne({ payee: rx(payee), referenceNo: rx(d.referenceNo), isDeleted: false, status: { $ne: 'Rejected' }, _id: { $ne: ctx.existing?._id } }).select('refNo').lean();
      if (dup) throw ApiError.conflict(`Bill ${d.referenceNo} of ${payee} is already recorded (${dup.refNo})`);
    }
    // the same payee, category, date and amount twice is almost always a double entry
    const same = await models.factoryExpense.exists({ payee: rx(payee), category: d.category, expenseDate: dayRange(d.expenseDate), amount: num(d.amount), isDeleted: false, status: { $ne: 'Rejected' }, _id: { $ne: ctx.existing?._id } });
    guard(ctx, !same, `An identical ${d.category} expense of ${num(d.amount)} to ${payee} on ${isoDay(d.expenseDate)} already exists (possible duplicate)`);
    if (d.paymentStatus === 'Unpaid') d.paidAmount = 0;
    if (d.paymentStatus === 'Paid') d.paidAmount = num(d.amount);
    if (num(d.paidAmount) > num(d.amount)) throw ApiError.badRequest('Paid amount cannot exceed the expense amount');
    if (d.paymentStatus === 'Part paid' && !(num(d.paidAmount) > 0 && num(d.paidAmount) < num(d.amount))) throw ApiError.badRequest('Part paid needs a paid amount between 0 and the expense amount');
    if (d.paymentStatus !== 'Unpaid' && !d.paymentDate) d.paymentDate = d.expenseDate;
  },
};

/* ================================ Job expenses vs payroll ================================ */
/** Wages are posted through Payroll; booking them again as a job expense would count them twice. */
export async function expenseRules(ctx) {
  const d = ctx.data;
  if (d.category !== 'Labour' || !d.expenseDate) return;
  const period = isoDay(d.expenseDate).slice(0, 7);
  const posted = await models.payroll.findOne({ period, isDeleted: false, status: { $in: ['Approved', 'Paid'] } }).select('refNo').lean();
  guard(ctx, !posted, `Salaries and wages for ${period} are posted through payroll ${posted?.refNo} and allocated to jobs from attendance – a Labour expense would count them twice`);
}

export { PRODUCTION_DEPARTMENTS };
