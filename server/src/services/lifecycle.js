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
import { PATTERN_FLOW } from '../../../shared/modules/preproduction.js';
import { COST_HEADS, COST_BUCKETS, financeLineOf } from '../../../shared/costHeads.js';
import { num, sum, round, pct, profitAnalysis } from '../../../shared/calc.js';
import { allocations, jobAllocation } from './costAllocation.js';
import { loadRoutes, resolveRoute, computeFlow } from './factoryFlow.js';
import { DEFAULT_UNITS } from '../../../shared/constants.js';

const D = 'done', A = 'active', L = 'delayed', P = 'pending', NA = 'na';
const today = () => new Date(new Date().toDateString());
const live = (ids) => ({ job: { $in: ids }, isDeleted: false });

/** Collect every record linked to the job (and its sub jobs for forecast main jobs). */
const GRAPH_SOURCES = [
  ['specs', 'techSpec'], ['boms', 'bom'], ['patterns', 'pattern'], ['markers', 'marker'],
  ['forecasts', 'fabricForecast', { status: { $ne: 'Cancelled' } }], ['transfers', 'fabricTransfer', { status: { $ne: 'Cancelled' } }],
  ['receipts', 'fabricReceipt', { status: { $ne: 'Rejected' } }], ['allocations', 'fabricAllocation', { status: { $ne: 'Cancelled' } }],
  ['returns', 'fabricReturn', { status: { $ne: 'Cancelled' } }], ['debits', 'fabricDebit', { status: { $nin: ['Rejected', 'Cancelled'] } }],
  ['bills', 'supplierBill'],
  ['tna', 'tna'], ['ppm', 'ppMeeting'], ['fabric', 'fabricBooking'], ['trims', 'trimBooking'], ['samples', 'sample'], ['plans', 'productionPlan'],
  ['cutting', 'cutting', { status: { $ne: 'Rejected' } }], ['sewing', 'sewing', { status: { $ne: 'Rejected' } }], ['finishing', 'finishing', { status: { $ne: 'Rejected' } }],
  ['packing', 'packing'], ['inspections', 'inspection'], ['shipments', 'shipment', { status: { $ne: 'Cancelled' } }],
  ['invoices', 'invoice', { status: { $ne: 'Cancelled' } }], ['payments', 'payment'], ['expenses', 'expense', { status: { $ne: 'Rejected' } }],
  ['hourly', 'hourlyProduction', { status: { $ne: 'Rejected' } }], ['reworks', 'qcRework'], ['factoryExpenses', 'factoryExpense', { status: 'Approved' }],
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

  const units = [...new Set(jobs.map((j) => j.businessUnit).filter(Boolean))];
  const [alloc, routes] = await Promise.all([allocations(units.length ? units : DEFAULT_UNITS.map((u) => u.code)), loadRoutes()]);
  const results = await Promise.all([
    // transfers are listed on the source job and on the job that received the fabric
    ...GRAPH_SOURCES.map(([, key, extra = {}]) => models[key].find(key === 'fabricTransfer'
      ? { isDeleted: false, ...extra, $or: [{ job: { $in: allIds } }, { toJob: { $in: allIds } }] }
      : { ...live(allIds), ...extra }).lean()),
    DocumentFile.find({ job: { $in: allIds }, isDeleted: false }).lean(),
    commercial('enquiry', 'enquiry'), commercial('costing', 'costing'), commercial('quotation', 'quotation'),
  ]);
  const [docs, enquiries, costings, quotations] = results.slice(GRAPH_SOURCES.length);

  return jobs.map((job) => {
    const ids = idsOf.get(String(job._id));
    const mine = new Set(ids.map(String));
    const pick = (rows) => rows.filter((r) => mine.has(String(r.job)));
    const pickCommercial = (rows, field) => rows.filter((r) => mine.has(String(r.job)) || (job[field] && String(r._id) === String(job[field])));
    const g = { job, subJobs: subJobs.filter((s) => String(s.parentJob) === String(job._id)), ids, alloc, route: resolveRoute(job, routes) };
    GRAPH_SOURCES.forEach(([name], i) => { g[name] = name === 'transfers' ? results[i].filter((r) => mine.has(String(r.job)) || mine.has(String(r.toJob))) : pick(results[i]); });
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

/**
 * Actual vs expected profit for a job graph, by garment cost head (see shared/costHeads.js).
 * Actual cost = booked fabric / trims + job expenses per head. Where a whole summary bucket has no actual
 * cost booked yet, the costed (standard) value for the produced quantity is used so profit is never overstated.
 * Also returns COGS (cost of goods, excl. freight & commercial costs), ROI and cost per piece.
 */
export function computeProfit(g) {
  if (g.subJobs?.length) return consolidatedProfit(g);
  const { job } = g;
  const shippedRows = g.shipments.filter((s) => ['Shipped', 'Delivered'].includes(s.status));
  const shippedQty = sum(shippedRows, 'qty');
  // a draft invoice is not revenue; an issued invoice is recognised once its shipment has sailed (FOB)
  const issued = g.invoices.filter((i) => i.status !== 'Draft');
  const shippedIds = new Set(shippedRows.map((s) => String(s._id)));
  const invoiced = sum(issued, 'totalAmount');
  const recognised = sum(issued.filter((i) => !i.shipment || shippedIds.has(String(i.shipment))), 'totalAmount');
  const revenue = recognised || (issued.length ? 0 : shippedQty * num(job.unitPrice));
  const costing = g.costings.find((c) => c.status === 'Approved') || g.costings[0];
  const c = costing || {};
  const qty = num(job.orderQty);
  const expectedProfit = costing ? num(costing.profitPerPc) * qty : num(job.expectedProfit);
  const expectedCost = costing ? num(costing.totalCostPerPc) * qty : num(job.expectedCost);
  // pieces the cost was incurred for: everything packed into finished goods (or shipped, if more) – a part-shipped
  // job's cost per piece is spread over all its finished goods, not only the shipped ones
  const fgIn = sum((g.hourly || []).filter((h) => h.department === 'Finished Goods Inward'), 'completedQty');
  const producedQty = Math.max(shippedQty, sum(g.packing, 'totalQty'), fgIn) || 0;

  // actual per head: booked materials + job expenses of the head's categories
  const jobCosts = g.expenses.filter((e) => !financeLineOf(e.category));
  // payroll / attendance labour and factory overhead allocated to this job (see costAllocation.js)
  const al = jobAllocation(g.alloc, job._id);
  const allocated = {
    labour: al.labourActual + al.labourEstimated,
    quality: al.qualityLabourActual + al.qualityLabourEstimated + al.directQuality,
    overhead: al.overheadActual + al.overheadEstimated + al.directOther,
  };
  const estimatedPart = { labour: al.labourEstimated, quality: al.qualityLabourEstimated, overhead: al.overheadEstimated };
  const actualOf = (h) => sum(jobCosts.filter((e) => h.expense.includes(e.category)), 'amount') + num(allocated[h.key])
    // fabric = received value ± accepted debit notes (supplier recoveries reduce it, additional charges add to it)
    + (h.key === 'fabric' ? sum(g.fabric, 'actualValue') + sum(g.debits.filter((d) => ['Accepted', 'Adjusted'].includes(d.status)), 'costImpact') : 0)
    + (h.key === 'trims' ? sum(g.trims, 'actualAmount') : 0);
  const perPc = (h) => h.costing.reduce((t, k) => t + num(c[k]), 0);
  const raw = COST_HEADS.map((h) => ({ h, actual: actualOf(h), perPc: perPc(h) }));
  const bucketHasActual = Object.fromEntries(COST_BUCKETS.map((b) => [b, raw.some((x) => x.h.bucket === b && x.actual > 0)]));
  // in-house conversion (cutting, sewing, finishing, packing) is paid through payroll and allocated as labour and
  // overhead – its costed standard must not be charged on top of that allocation
  if (allocated.labour + allocated.overhead > 0) bucketHasActual.production = true;
  const heads = raw.map(({ h, actual, perPc: pp }) => {
    const useStandard = !bucketHasActual[h.bucket] && costing && producedQty > 0 && pp > 0;
    return {
      key: h.key, label: h.label, bucket: h.bucket, cogs: h.cogs,
      estimated: round(pp * qty), estimatedPerPc: round(pp, 4),
      actual: round(useStandard ? pp * producedQty : actual),
      basis: useStandard ? 'standard' : num(estimatedPart[h.key]) > 0 ? 'estimated' : 'actual',
    };
  }).map((x) => ({ ...x, variance: round(x.actual - x.estimated) }));
  const bucketSum = (b) => sum(heads.filter((x) => x.bucket === b), 'actual');
  const basis = Object.fromEntries(COST_BUCKETS.map((b) => {
    const hs = heads.filter((x) => x.bucket === b);
    return [b, hs.some((x) => x.basis === 'standard') ? 'standard' : hs.some((x) => x.basis === 'estimated') ? 'estimated' : 'actual'];
  }));

  const pa = profitAnalysis({
    revenue,
    fabricCost: bucketSum('fabric'), trimCost: bucketSum('trims'), productionCost: bucketSum('production'),
    labourCost: bucketSum('labour'), overheadCost: bucketSum('overhead'), freightCost: bucketSum('freight'), otherCost: bucketSum('other'),
    expectedProfit, expectedCost, expectedRevenue: qty * num(job.unitPrice),
  });
  const cogs = round(sum(heads.filter((x) => x.cogs), 'actual'));
  const costQty = producedQty || qty;
  const received = sum(g.payments, 'amount');
  return {
    ...pa,
    orderValue: round(qty * num(job.unitPrice)),
    expectedRevenue: round(qty * num(job.unitPrice)),
    expectedCost: round(expectedCost),
    invoiced: round(invoiced), received: round(received), outstanding: round(invoiced - received),
    shippedQty, producedQty, currency: job.currency,
    costingRef: costing?.refNo,
    costBasis: basis,
    heads,
    cogs,
    cogsPerPc: costQty ? round(cogs / costQty, 4) : 0,
    estimatedCogsPerPc: round(sum(heads.filter((x) => x.cogs), 'estimatedPerPc'), 4),
    roiPct: pa.totalExpenses ? round((pa.actualProfit / pa.totalExpenses) * 100, 2) : 0,
    // gross = revenue − cost of goods; net = after freight, commission, finance and admin as well
    grossProfit: round(pa.revenue - cogs), netProfit: pa.actualProfit, grossMarginPct: pa.revenue ? round(((pa.revenue - cogs) / pa.revenue) * 100, 2) : 0,
    costPerPc: costQty ? round(pa.totalExpenses / costQty, 4) : 0,
    profitPerPc: (shippedQty || costQty) ? round(pa.actualProfit / (shippedQty || costQty), 4) : 0,
    allocation: { labour: round(allocated.labour, 2), quality: round(allocated.quality, 2), overhead: round(allocated.overhead, 2), estimated: round(sum(Object.values(estimatedPart)), 2), byDept: al.byDept },
  };
}

const tot2 = (parts, k) => round(parts.reduce((t, p) => t + num(p.allocation?.[k]), 0), 2);

/** A job's own slice of a (main job) graph: its records only, no sub jobs; commercial records are shared. */
function sliceGraph(g, job) {
  const id = String(job._id);
  const s = { job, subJobs: [], ids: [job._id], alloc: g.alloc, route: g.route, enquiries: g.enquiries, costings: g.costings, quotations: g.quotations, docs: g.docs.filter((r) => String(r.job) === id) };
  GRAPH_SOURCES.forEach(([name]) => { s[name] = g[name].filter((r) => String(r.job) === id || (name === 'transfers' && String(r.toJob) === id)); });
  return s;
}

/**
 * Main job profit = the sum of its sub jobs' own profits + main-level items (e.g. a debit recovery on the bulk
 * fabric forecast), so the main job, its sub jobs and the closure report always add up to the same figures.
 */
function consolidatedProfit(g) {
  const parts = [...g.subJobs.map((s) => computeProfit(sliceGraph(g, s))), computeProfit(sliceGraph(g, { ...g.job, orderQty: 0, expectedProfit: 0, expectedCost: 0 }))];
  const tot = (k) => round(parts.reduce((t, p) => t + num(p[k]), 0));
  const SUM = ['revenue', 'totalExpenses', 'actualProfit', 'expectedProfit', 'expectedCost', 'expectedRevenue', 'orderValue', 'invoiced', 'received', 'outstanding', 'shippedQty', 'producedQty', 'cogs', 'grossProfit', 'netProfit', 'profitVariance', 'costVariance'];
  const out = { ...parts[0], ...Object.fromEntries(SUM.map((k) => [k, tot(k)])) };
  out.costs = Object.fromEntries(COST_BUCKETS.map((b) => [b, round(parts.reduce((t, p) => t + num(p.costs?.[b]), 0))]));
  out.heads = parts[0].heads.map((h) => {
    const same = parts.map((p) => p.heads.find((x) => x.key === h.key));
    const actual = round(same.reduce((t, x) => t + num(x?.actual), 0));
    const estimated = round(same.reduce((t, x) => t + num(x?.estimated), 0));
    return { ...h, actual, estimated, variance: round(actual - estimated), basis: same.some((x) => x?.basis === 'standard') ? 'standard' : 'actual' };
  });
  out.costBasis = Object.fromEntries(COST_BUCKETS.map((b) => [b, parts.some((p) => p.costBasis?.[b] === 'standard') ? 'standard' : parts.some((p) => p.costBasis?.[b] === 'estimated') ? 'estimated' : 'actual']));
  out.allocation = { labour: tot2(parts, 'labour'), quality: tot2(parts, 'quality'), overhead: tot2(parts, 'overhead'), estimated: tot2(parts, 'estimated'), byDept: {} };
  const costQty = out.producedQty || num(g.job.orderQty);
  Object.assign(out, {
    currency: g.job.currency, costingRef: parts[0].costingRef,
    profitPct: pct(out.actualProfit, out.revenue), expectedProfitPct: pct(out.expectedProfit, out.expectedRevenue),
    roiPct: out.totalExpenses ? round((out.actualProfit / out.totalExpenses) * 100, 2) : 0,
    grossMarginPct: out.revenue ? round((out.grossProfit / out.revenue) * 100, 2) : 0,
    cogsPerPc: costQty ? round(out.cogs / costQty, 4) : 0, costPerPc: costQty ? round(out.totalExpenses / costQty, 4) : 0,
    profitPerPc: (out.shippedQty || costQty) ? round(out.actualProfit / (out.shippedQty || costQty), 4) : 0,
    subJobs: parts.length - 1,
  });
  return out;
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
  // an advance job (opened before the buyer PO) is not a confirmed order until its actual PO is linked
  st.order = job.status === 'Cancelled' ? P : job.poStatus === 'Awaiting PO' ? A : D;

  // Pre-production: Specification → BOM → CAD → Pattern → Grading → Marker.
  // Jobs that were already cutting before these records existed show them as not applicable.
  const legacy = sum(g.cutting, 'cutQty') > 0;
  const pre = (rows, done, issue = ['Rejected']) => (!rows.length ? (legacy ? NA : P)
    : rows.some((r) => done.includes(r.status)) ? D : rows.some((r) => issue.includes(r.status)) ? L : A);
  st.spec = pre(g.specs, ['Approved']);
  st.bom = pre(g.boms, ['Approved']);
  st.cad = pre(g.patterns, PATTERN_FLOW.slice(1), []);
  st.pattern = pre(g.patterns, PATTERN_FLOW.slice(2));
  st.grading = !g.patterns.length ? (legacy ? NA : P) : g.patterns.some((r) => PATTERN_FLOW.slice(3).includes(r.status)) ? D
    : g.patterns.some((r) => r.status === 'Pattern Approved') ? A : P;
  st.marker = pre(g.markers, ['Approved', 'Issued to Cutting']);
  const bom = g.boms[0];
  const mk = g.markers.filter((m) => m.status !== 'Rejected');
  meta.preproduction = {
    spec: g.specs[0] ? { refNo: g.specs[0].refNo, status: g.specs[0].status, revision: g.specs[0].revision, poms: g.specs[0].pomCount } : null,
    bom: bom ? { refNo: bom.refNo, status: bom.status, lines: (bom.lines || []).length, unbooked: (bom.lines || []).filter((l) => !l.bookingRef).length, materialCostPerPc: bom.materialCostPerPc, costedMaterialPerPc: bom.costedMaterialPerPc, variancePerPc: bom.materialVariancePerPc } : null,
    patterns: g.patterns.length, markers: mk.length,
    markerConsumption: mk.length ? round(sum(mk, 'consumptionPerPc') / mk.length, 4) : 0,
    markerVariancePct: mk.length ? round(sum(mk, 'consumptionVariancePct') / mk.length, 2) : 0,
  };

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
  const forecastDone = (f) => ['Received', 'Allocated', 'Closed'].includes(f.status) || (num(f.forecastQty) > 0 && num(f.receivedQty) >= num(f.forecastQty));
  const noFabric = !g.fabric.length && !g.forecasts.length && !job.fabricType && !num(job.consumption);
  st.fabric = noFabric ? NA : !g.fabric.length ? (!g.forecasts.length ? P : g.forecasts.every(forecastDone) ? D : A) : g.fabric.every(fabDone) ? D
    : g.fabric.some((f) => num(f.shortageQty) > 0 && f.deliveryDate && new Date(f.deliveryDate) < today()) ? L : A;
  meta.fabric = { required: round(sum(g.fabric, 'requiredQty'), 2), received: round(sum(g.fabric, 'receivedQty'), 2), shortage: round(sum(g.fabric, 'shortageQty'), 2),
    forecast: round(sum(g.forecasts, 'forecastQty'), 2), forecastReceived: round(sum(g.forecasts, 'receivedQty'), 2), transferred: round(sum(g.forecasts, 'transferredQty'), 2), forecastBalance: round(sum(g.forecasts, 'balanceQty'), 2) };

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
  const planEnd = g.plans.map((p) => p.plannedEnd).filter(Boolean).sort((a, b) => new Date(a) - new Date(b)).pop();
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
  // T&A is a running calendar until shipment – it never blocks the 'next process' pointer;
  // neither do open pre-production stages once cutting has started
  const PRE = ['spec', 'bom', 'cad', 'pattern', 'grading', 'marker'];
  const current = applicable.find((w) => st[w.key] !== D && w.key !== 'tna' && !(legacy && PRE.includes(w.key)));

  // Closure readiness
  const blockers = [];
  // fabric transfers still in progress and forecasts not closed (main and sub jobs alike)
  const openTransfers = g.transfers.filter((t) => ['Requested', 'Approved'].includes(t.status));
  if (openTransfers.length) blockers.push(`${openTransfers.length} fabric transfer(s) not completed`);
  g.forecasts.filter((f) => !['Closed', 'Cancelled'].includes(f.status)).forEach((f) => blockers.push(`Fabric forecast ${f.refNo} not closed (balance ${round(num(f.balanceQty), 2)} ${f.unit})`));
  if (job.poStatus === 'Awaiting PO' && !isMain) blockers.push('Actual buyer PO not received (advance job)');
  // fabric department transactions still open (main and sub jobs alike)
  const openDebits = g.debits.filter((d) => d.status === 'Raised');
  if (openDebits.length) blockers.push(`${openDebits.length} fabric debit note(s) not settled (${openDebits.map((d) => d.refNo).join(', ')})`);
  const openReturns = g.returns.filter((r) => r.status === 'Returned');
  if (openReturns.length) blockers.push(`${openReturns.length} fabric return(s) not accepted (${openReturns.map((r) => r.refNo).join(', ')})`);
  const openReservations = g.allocations.filter((a) => a.status === 'Allocated');
  if (openReservations.length) blockers.push(`${openReservations.length} fabric reservation(s) not issued or cancelled (${openReservations.map((a) => a.refNo).join(', ')})`);
  // department flow & quality (jobs on hourly production) – every piece accounted for before closure
  const flow = computeFlow({ job, route: g.route || resolveRoute(job, []), sheets: g.hourly || [], inspections: g.inspections, reworks: g.reworks || [], shipments: g.shipments });
  meta.flow = { onFlow: flow.onFlow, route: flow.route.name, wip: flow.wip, fg: flow.fg, issues: flow.issues, departments: flow.departments.map((d) => ({ department: d.department, input: d.input, completed: d.completed, rejected: d.rejected, pending: d.pending, handover: d.handover })) };
  // a main job's sub jobs carry their own quality blockers (reported as "Sub job … not closed")
  const own = (r) => String(r.job) === String(job._id);
  const openIssues = (g.reworks || []).filter((r) => r.status !== 'Closed' && own(r));
  if (openIssues.length) blockers.push(`${openIssues.length} quality issue(s) not closed (${openIssues.map((r) => r.refNo).join(', ')})`);
  const openInsp = g.inspections.filter((i) => ['Pending', 'Inspection'].includes(i.status) && own(i));
  if (openInsp.length) blockers.push(`${openInsp.length} inspection(s) not completed (${openInsp.map((i) => i.refNo).join(', ')})`);
  if (flow.onFlow && !isMain) {
    if (flow.wip.inDepartments > 0) blockers.push(`${flow.wip.inDepartments} pcs still in department WIP (${flow.departments.filter((d) => d.pending > 0).map((d) => `${d.department} ${d.pending}`).join(', ')})`);
    if (flow.wip.betweenDepartments + flow.wip.atQualityGates > 0) blockers.push(`${flow.wip.betweenDepartments + flow.wip.atQualityGates} pcs not handed over / not dispositioned at quality gates`);
    if (flow.issues.length) blockers.push(`Quantity reconciliation: ${flow.issues.join('; ')}`);
  }
  if (isMain) {
    g.subJobs.filter((s) => s.status !== 'Closed').forEach((s) => blockers.push(`Sub job ${s.jobNo} is not closed`));
  } else {
    ordered.filter((w) => w.requiredForClosure && w.enabled !== false && st[w.key] !== D && st[w.key] !== NA)
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
  // The status only moves if nobody changed it meanwhile (e.g. a close landing during a background refresh)
  const { status, ...cache } = update;
  await Job.updateOne({ _id: job._id }, { $set: cache });
  if (status) {
    const moved = await Job.updateOne({ _id: job._id, status: job.status }, { $set: { status } });
    if (!moved.modifiedCount) delete update.status;
  }

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
