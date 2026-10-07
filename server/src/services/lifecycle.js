/**
 * Lifecycle / workflow engine.
 * Derives the state of every stage of a Job from the actual records linked to it,
 * determines the next process, overall progress and closure readiness.
 * The Job document caches the result (stages, currentStage, progressPct, readyToClose).
 */
import mongoose from 'mongoose';
import { models } from '../modules/builder.js';
import { DocumentFile } from '../models/Document.js';
import { getSetting } from './settings.js';
import { notify } from './notify.js';
import { FABRIC_FLOW } from '../../../shared/modules/planning.js';
import { num, sum, round, profitAnalysis } from '../../../shared/calc.js';

const D = 'done', A = 'active', L = 'delayed', P = 'pending', NA = 'na';
const today = () => new Date(new Date().toDateString());
const live = (ids) => ({ job: { $in: ids }, isDeleted: false });

/** Collect every record linked to the job (and its sub jobs for forecast main jobs). */
const GRAPH_SOURCES = [
  ['tna', 'tna'], ['ppm', 'ppMeeting'], ['fabric', 'fabricBooking'], ['trims', 'trimBooking'], ['samples', 'sample'], ['plans', 'productionPlan'],
  ['cutting', 'cutting', { status: { $ne: 'Rejected' } }], ['sewing', 'sewing', { status: { $ne: 'Rejected' } }], ['finishing', 'finishing', { status: { $ne: 'Rejected' } }],
  ['packing', 'packing'], ['inspections', 'inspection'], ['shipments', 'shipment', { status: { $ne: 'Cancelled' } }],
  ['invoices', 'invoice', { status: { $ne: 'Cancelled' } }], ['payments', 'payment'], ['expenses', 'expense', { status: { $ne: 'Rejected' } }],
];

/**
 * Load the record graphs of many jobs with one query per collection (all in parallel),
 * instead of ~20 queries per job. Includes sub jobs of forecast main jobs.
 */
export async function loadJobGraphs(jobs) {
  if (!jobs.length) return [];
  const jobIds = jobs.map((j) => j._id);
  const subJobs = await models.orders.find({ parentJob: { $in: jobIds }, isDeleted: false }).lean();
  const idsOf = new Map(jobs.map((j) => [String(j._id), [j._id, ...subJobs.filter((s) => String(s.parentJob) === String(j._id)).map((s) => s._id)]]));
  const allIds = [...new Set([...idsOf.values()].flat().map(String))];
  const refIds = (field) => jobs.map((j) => j[field]).filter(Boolean);
  const commercial = (key, field) => models[key].find({ isDeleted: false, $or: [{ job: { $in: allIds } }, { _id: { $in: refIds(field) } }] }).lean();

  const results = await Promise.all([
    ...GRAPH_SOURCES.map(([, key, extra = {}]) => models[key].find({ ...live(allIds), ...extra }).lean()),
    DocumentFile.find({ job: { $in: allIds }, isDeleted: false }).lean(),
    commercial('enquiry', 'enquiry'), commercial('costing', 'costing'), commercial('quotation', 'quotation'),
  ]);
  const [docs, enquiries, costings, quotations] = results.slice(GRAPH_SOURCES.length);

  return jobs.map((job) => {
    const ids = idsOf.get(String(job._id));
    const mine = new Set(ids.map(String));
    const pick = (rows) => rows.filter((r) => mine.has(String(r.job)));
    const pickCommercial = (rows, field) => rows.filter((r) => mine.has(String(r.job)) || (job[field] && String(r._id) === String(job[field])));
    const g = { job, subJobs: subJobs.filter((s) => String(s.parentJob) === String(job._id)), ids };
    GRAPH_SOURCES.forEach(([name], i) => { g[name] = pick(results[i]); });
    return Object.assign(g, {
      docs: pick(docs),
      enquiries: pickCommercial(enquiries, 'enquiry'),
      costings: pickCommercial(costings, 'costing'),
      quotations: pickCommercial(quotations, 'quotation'),
    });
  });
}

export async function loadJobGraph(job) {
  return (await loadJobGraphs([job]))[0];
}

/** Actual vs expected profit for a job graph. */
export function computeProfit(g) {
  const { job } = g;
  const shippedQty = sum(g.shipments.filter((s) => ['Shipped', 'Delivered'].includes(s.status)), 'qty');
  const invoiced = sum(g.invoices, 'totalAmount');
  const revenue = invoiced || shippedQty * num(job.unitPrice);
  const byCat = (cats) => sum(g.expenses.filter((e) => cats.includes(e.category)), 'amount');
  const fabricActual = sum(g.fabric, 'actualValue') + byCat(['Fabric']);
  const trimActual = sum(g.trims, 'actualAmount') + byCat(['Trims']);
  const costing = g.costings.find((c) => c.status === 'Approved') || g.costings[0];
  const qty = num(job.orderQty);
  const expectedProfit = costing ? num(costing.profitPerPc) * qty : num(job.expectedProfit);
  const expectedCost = costing ? num(costing.totalCostPerPc) * qty : num(job.expectedCost);

  // Where no actual expense is booked for a cost head, fall back to the costed (standard) value
  // for the produced quantity so actual profit is never overstated.
  const producedQty = shippedQty || sum(g.packing, 'totalQty') || 0;
  const std = (perPc) => (costing ? perPc * producedQty : 0);
  const basis = {};
  const head = (key, actual, standardPerPc) => {
    if (actual > 0 || !costing || !producedQty) { basis[key] = 'actual'; return actual; }
    basis[key] = standardPerPc > 0 ? 'standard' : 'actual';
    return std(standardPerPc);
  };
  const c = costing || {};
  const pa = profitAnalysis({
    revenue,
    fabricCost: head('fabric', fabricActual, num(c.fabricCost)),
    trimCost: head('trims', trimActual, num(c.trimCost) + num(c.accessoriesCost)),
    productionCost: head('production', byCat(['Production', 'Washing', 'Printing', 'Embroidery']),
      num(c.cuttingCost) + num(c.sewingCost) + num(c.finishingCost) + num(c.packingCost) + num(c.washingCost) + num(c.printingCost) + num(c.embroideryCost) + num(c.dyeingCost)),
    labourCost: head('labour', byCat(['Labour']), num(c.labourCost)),
    overheadCost: head('overhead', byCat(['Overhead', 'Commission']), num(c.factoryOverhead) + num(c.adminOverheadAmt) + num(c.commissionAmt) + num(c.financeAmt)),
    freightCost: head('freight', byCat(['Freight']), num(c.freightCost)),
    otherCost: head('other', byCat(['Testing', 'Other']), num(c.testingCost) + num(c.inspectionCost) + num(c.otherExpenses)),
    expectedProfit,
    expectedCost,
    expectedRevenue: qty * num(job.unitPrice),
  });
  const received = sum(g.payments, 'amount');
  return {
    ...pa,
    orderValue: round(qty * num(job.unitPrice)),
    expectedRevenue: round(qty * num(job.unitPrice)),
    invoiced: round(invoiced), received: round(received), outstanding: round(invoiced - received),
    shippedQty, currency: job.currency,
    costingRef: costing?.refNo,
    costBasis: basis,
  };
}

/** Compute stage states for a job graph. */
export async function computeStages(g) {
  const { job } = g;
  const workflow = await getSetting('workflow');
  const tol = await getSetting('tolerance');
  const isMain = job.isForecast && g.subJobs.length > 0;
  const qty = num(job.orderQty);
  const target = qty * (1 - num(tol.shortShipPct) / 100);
  const reached = (v) => qty > 0 && v >= target;
  const st = {};
  const meta = {};

  // Commercial
  const enq = g.enquiries[0];
  st.enquiry = enq ? D : NA;
  st.costing = g.costings.some((c) => c.status === 'Approved') ? D : g.costings.length ? A : NA;
  st.quotation = g.quotations.some((q) => ['Approved', 'Converted'].includes(q.status)) ? D : g.quotations.length ? A : NA;
  st.order = job.status === 'Cancelled' ? P : D;

  // T&A
  const tna = g.tna[0];
  st.tna = !g.tna.length ? P : g.tna.every((t) => t.status === 'Completed') ? D : g.tna.some((t) => num(t.delayedCount) > 0) ? L : A;
  meta.tna = tna ? { completionPct: tna.completionPct, delayed: sum(g.tna, 'delayedCount') } : null;

  // PP meeting
  st.ppMeeting = !g.ppm.length ? P : g.ppm.some((p) => ['Held', 'Completed'].includes(p.status)) ? D
    : g.ppm.some((p) => p.meetingDate && new Date(p.meetingDate) < today()) ? L : A;

  // Fabric
  const approvedIdx = FABRIC_FLOW.indexOf('Approved');
  const fabDone = (f) => f.status === 'Fabric Job Closed' || FABRIC_FLOW.indexOf(f.status) >= approvedIdx;
  st.fabric = !g.fabric.length ? P : g.fabric.every(fabDone) ? D
    : g.fabric.some((f) => num(f.shortageQty) > 0 && f.deliveryDate && new Date(f.deliveryDate) < today()) ? L : A;
  meta.fabric = { required: round(sum(g.fabric, 'requiredQty'), 2), received: round(sum(g.fabric, 'receivedQty'), 2), shortage: round(sum(g.fabric, 'shortageQty'), 2) };

  // Trims
  const trimDone = (t) => ['Received', 'Issued', 'Consumed', 'Closed'].includes(t.status) && num(t.shortageQty) <= 0;
  st.trims = !g.trims.length ? (job.trims?.length ? P : NA) : g.trims.every(trimDone) ? D
    : g.trims.some((t) => num(t.shortageQty) > 0 && t.deliveryDate && new Date(t.deliveryDate) < today()) ? L : A;

  // Sampling & approval
  const approved = (s) => ['Approved', 'Final Approved'].includes(s.status);
  st.sampling = !g.samples.length ? P : g.samples.every(approved) ? D : g.samples.some((s) => s.status === 'Rejected') ? L : A;
  const pp = g.samples.filter((s) => s.sampleType === 'PP Sample');
  st.approval = pp.some(approved) ? D : pp.some((s) => s.status === 'Rejected') ? L : g.samples.some(approved) ? A : P;

  // Planning
  st.planning = !g.plans.length ? P : g.plans.some((p) => ['Approved', 'Released', 'Running', 'Completed'].includes(p.status)) ? D : A;

  // Production quantities
  const cut = sum(g.cutting, 'cutQty');
  const sewn = sum(g.sewing, 'actualQty');
  const finished = sum(g.finishing, 'passedQty');
  const packed = sum(g.packing.filter((p) => p.status !== 'Draft'), 'totalQty');
  const packedAll = sum(g.packing, 'totalQty');
  const planEnd = g.plans.map((p) => p.plannedEnd).filter(Boolean).sort().pop();
  const prodLate = planEnd && new Date(planEnd) < today();
  const qtyState = (v, late) => (reached(v) ? D : v > 0 ? (late ? L : A) : P);
  st.cutting = qtyState(cut, prodLate);
  st.sewing = qtyState(sewn, prodLate);
  st.finishing = qtyState(finished, prodLate);
  st.packing = reached(packed) ? D : packedAll > 0 ? A : P;
  meta.production = { orderQty: qty, cut, sewn, finished, packed: packedAll, wip: Math.max(cut - sewn, 0), target: Math.ceil(target) };

  // Inspection
  const finals = g.inspections.filter((i) => ['Final', 'Re-inspection'].includes(i.inspectionType) || !i.inspectionType);
  const lastInsp = [...finals].sort((a, b) => new Date(b.inspectionDate) - new Date(a.inspectionDate))[0];
  st.inspection = !finals.length ? P : ['Passed', 'Final Approved'].includes(lastInsp.status) ? D : lastInsp.status === 'Failed' ? L : A;

  // Shipment
  const shippedQty = sum(g.shipments.filter((s) => ['Shipped', 'Delivered'].includes(s.status)), 'qty');
  const shipDue = job.shipmentDate && new Date(job.shipmentDate) < today();
  st.shipment = reached(shippedQty) ? D : g.shipments.length || shippedQty ? (shipDue ? L : A) : shipDue ? L : P;
  meta.shipment = { shippedQty, shipmentDate: job.shipmentDate };

  // Documentation
  const requiredDocs = [...new Set(workflow.flatMap((w) => (w.enabled === false ? [] : w.requiredDocuments || [])))];
  const haveDocs = new Set(g.docs.map((d) => d.docType));
  const missingDocs = requiredDocs.filter((d) => !haveDocs.has(d));
  st.documentation = requiredDocs.length && !missingDocs.length ? D : g.docs.length ? A : P;
  meta.documentation = { required: requiredDocs, missing: missingDocs, count: g.docs.length };

  // Accounts / payment
  const invQty = sum(g.invoices.filter((i) => i.status !== 'Draft'), 'qty');
  st.accounts = g.invoices.length && invQty >= Math.max(shippedQty, 1) ? D : g.invoices.length ? A : P;
  const invTotal = sum(g.invoices, 'totalAmount');
  const received = sum(g.payments, 'amount');
  const overdue = g.invoices.some((i) => num(i.outstanding) > 0 && i.dueDate && new Date(i.dueDate) < today());
  const paid = invTotal > 0 && g.invoices.every((i) => ['Fully Paid', 'Closed'].includes(i.status));
  st.payment = paid || (job.outstandingApproved && invTotal > 0) ? D : received > 0 ? (overdue ? L : A) : overdue ? L : P;
  meta.payment = { invoiced: round(invTotal), received: round(received), outstanding: round(invTotal - received), outstandingApproved: !!job.outstandingApproved };

  // Profit & closure
  st.profit = st.payment === D ? D : invTotal > 0 || shippedQty > 0 ? A : P;
  st.closure = job.status === 'Closed' ? D : P;

  // Forecast main job: production stages are carried by the sub jobs
  if (isMain) {
    const subsClosed = g.subJobs.every((s) => s.status === 'Closed');
    meta.subJobs = g.subJobs.map((s) => ({ _id: s._id, jobNo: s.jobNo, qty: s.orderQty, status: s.status, progressPct: s.progressPct, currentStage: s.currentStage }));
    if (subsClosed && st.closure !== D) st.closure = A;
  }

  // Apply workflow configuration (disabled stages are not applicable)
  const ordered = workflow.filter((w) => st[w.key] !== undefined);
  ordered.forEach((w) => { if (w.enabled === false) st[w.key] = NA; });

  const applicable = ordered.filter((w) => st[w.key] !== NA);
  const doneCount = applicable.filter((w) => st[w.key] === D).length;
  // T&A is a running calendar until shipment – it never blocks the 'next process' pointer
  const current = applicable.find((w) => st[w.key] !== D && w.key !== 'tna');

  // Closure readiness
  const blockers = [];
  if (isMain) {
    g.subJobs.filter((s) => s.status !== 'Closed').forEach((s) => blockers.push(`Sub job ${s.jobNo} is not closed`));
  } else {
    ordered.filter((w) => w.requiredForClosure && w.enabled !== false && st[w.key] !== D)
      .forEach((w) => blockers.push(`${w.label} not completed`));
    if (missingDocs.length) blockers.push(`Missing documents: ${missingDocs.join(', ')}`);
    const openSamples = g.samples.filter((s) => ['Pending', 'Submitted', 'Buyer Review', 'Revised'].includes(s.status));
    if (openSamples.length) blockers.push(`${openSamples.length} sample(s) still open`);
    const openFabric = g.fabric.filter((f) => num(f.shortageQty) > 0);
    if (openFabric.length) blockers.push(`${openFabric.length} fabric booking(s) with unresolved shortage`);
    const openPpm = g.ppm.flatMap((p) => p.actionItems || []).filter((a) => a.status === 'Open');
    if (openPpm.length) blockers.push(`${openPpm.length} PP meeting action item(s) open`);
  }
  if (['Closed', 'Cancelled'].includes(job.status)) blockers.length = 0;

  const stages = Object.fromEntries(ordered.map((w) => [w.key, st[w.key]]));
  return {
    stages,
    order: ordered.map((w) => ({ key: w.key, label: w.label, department: w.department, state: st[w.key], responsibleUser: w.responsibleUser })),
    currentStage: job.status === 'Closed' ? 'closure' : current?.key || 'closure',
    progressPct: applicable.length ? Math.round((doneCount / applicable.length) * 100) : 0,
    readyToClose: job.status !== 'Closed' && job.status !== 'Cancelled' && blockers.length === 0,
    blockers,
    meta,
  };
}

/** Recalculate and persist lifecycle cache for a job (and its parent). */
export async function refreshJob(jobId, { notifyReady = true } = {}) {
  if (!jobId || !mongoose.isValidObjectId(jobId)) return null;
  const Job = models.orders;
  const job = await Job.findById(jobId).lean();
  if (!job || job.isDeleted) return null;
  const g = await loadJobGraph(job);
  const lc = await computeStages(g);
  const profit = computeProfit(g);
  const update = {
    stages: lc.stages, currentStage: lc.currentStage, progressPct: lc.progressPct,
    readyToClose: lc.readyToClose, closureBlockers: lc.blockers,
    expectedProfit: profit.expectedProfit, expectedCost: round(num(profit.expectedRevenue) - num(profit.expectedProfit)),
  };
  if (lc.readyToClose && !['Ready to Close', 'Closed', 'Cancelled', 'On Hold'].includes(job.status)) update.status = 'Ready to Close';
  else if (!lc.readyToClose && job.status === 'Ready to Close') update.status = 'In Progress';
  else if (job.status === 'Confirmed' && lc.progressPct > 25) update.status = 'In Progress';
  if (job.isForecast && g.subJobs.length) update.orderQty = sum(g.subJobs, 'orderQty');
  await Job.updateOne({ _id: job._id }, { $set: update });

  if (notifyReady && lc.readyToClose && !job.readyToClose) {
    await notify({
      type: 'JOB_READY_TO_CLOSE', severity: 'success', title: `JOB READY FOR CLOSURE: ${job.jobNo}`,
      message: `${job.jobNo} (${job.styleNo}) has completed all closure conditions.`,
      departments: ['Admin', 'Accounts & Finance', 'Head Office Merchandising'], job, link: `/jobs/${job.jobNo}`,
      dedupeKey: `ready-${job._id}`,
    });
  }
  if (job.parentJob) await refreshJob(job.parentJob, { notifyReady });
  return { ...job, ...update };
}

/**
 * Recalculate a job's lifecycle in the background (after the HTTP response is sent).
 * Several saves on the same job in quick succession are coalesced into one recalculation.
 */
const queued = new Map();
export function refreshJobSoon(jobId) {
  if (!jobId) return;
  const key = String(jobId);
  if (queued.has(key)) return;
  queued.set(key, setTimeout(() => {
    queued.delete(key);
    refreshJob(key).catch((e) => console.error('[lifecycle] background refresh failed', key, e.message));
  }, 150));
}
