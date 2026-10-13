/**
 * Department flow engine – derives, from saved records only, where every piece of a job is:
 *
 *   department   input / completed / rejected / rework / pending (WIP) from the hourly production sheets
 *   handover     what the previous department (or the quality gate) made available and the next one has not taken in
 *   quality gate lots submitted → passed / rework / rejected / held → reworked pieces passed on reinspection
 *                or released under concession; only `released` pieces may enter the gated department
 *   finished     FG inward, quality-held, pre-shipment released, shipped, available for shipment
 *
 * Nothing is stored: every figure is recalculated from the transactions, so reports and guards can never drift
 * from the source records. Jobs without hourly sheets are "not on department flow" – the flow rules do not apply.
 */
import { models } from '../modules/builder.js';
import { getSetting } from './settings.js';
import { num, sum, round } from '../../../shared/calc.js';
import { DEFAULT_ROUTE, QC_STAGES, qcStage, SHIPMENT_GATE, PRODUCTION_DEPARTMENTS } from '../../../shared/modules/factory.js';

const LIVE_SHEET = { isDeleted: false, status: { $ne: 'Rejected' } };
const INSPECTED = ['Passed', 'Final Approved', 'Failed', 'Re-inspection'];
const FG_STAGES = [SHIPMENT_GATE, 'Finished Goods Approval'];

/* ------------------------------ Routing ------------------------------ */
export async function loadRoutes() {
  return models.productionRoute.find({ isDeleted: false, status: 'Active' }).sort({ updatedAt: -1 }).lean();
}

/**
 * The route for a job: the most specific active route whose criteria all match (style > buyer > garment type),
 * otherwise the default full department flow with Final QC releasing pieces to Folding.
 */
export function resolveRoute(job, routes = []) {
  let best = null; let bestScore = -1;
  for (const r of routes) {
    if (!(r.steps || []).some((s) => s.department)) continue;
    if (r.styleNo && r.styleNo.trim().toLowerCase() !== String(job.styleNo || '').toLowerCase()) continue;
    if (r.buyer && String(r.buyer) !== String(job.buyer)) continue;
    if (r.garmentType && r.garmentType.trim().toLowerCase() !== String(job.garmentType || '').toLowerCase()) continue;
    const score = (r.styleNo ? 4 : 0) + (r.buyer ? 2 : 0) + (r.garmentType ? 1 : 0);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  if (!best) return { name: 'Standard flow', refNo: null, steps: DEFAULT_ROUTE, preShipmentRequired: true };
  const seen = new Set();
  const steps = best.steps.filter((s) => s.department && PRODUCTION_DEPARTMENTS.includes(s.department) && !seen.has(s.department) && seen.add(s.department))
    .map((s) => ({ department: s.department, gateStage: s.gateStage || '' }));
  return { name: best.name, refNo: best.refNo, _id: best._id, steps, preShipmentRequired: best.preShipmentRequired !== false };
}

/** Department whose output is submitted to a stage on this route (the gated department's predecessor for a gate). */
export function stageSource(route, stageKey) {
  const steps = route.steps;
  const gated = steps.findIndex((s) => s.gateStage === stageKey);
  if (gated > 0) return steps[gated - 1].department;
  if (gated === 0) return null;
  const st = qcStage(stageKey);
  if (!st?.dept) return null;
  if (steps.some((s) => s.department === st.dept)) return st.dept;
  // the stage's usual department is not on this route: nearest earlier department that is
  const order = PRODUCTION_DEPARTMENTS.indexOf(st.dept);
  const earlier = steps.filter((s) => PRODUCTION_DEPARTMENTS.indexOf(s.department) <= order);
  return earlier.length ? earlier[earlier.length - 1].department : null;
}

/* ------------------------------ Quantities ------------------------------ */
/** Disposition of one inspection lot (blank quantities follow the result: passed lot fully passed, failed lot fully held). */
export function lotDisposition(i) {
  const lot = num(i.lotSize);
  if (!INSPECTED.includes(i.status)) return { lot, awaiting: lot, pass: 0, rework: 0, reject: 0, held: 0 };
  const given = ['passQty', 'reworkQty', 'rejectQty', 'heldQty'].some((k) => i[k] !== null && i[k] !== undefined && i[k] !== '');
  if (!given) return i.status === 'Failed' ? { lot, awaiting: 0, pass: 0, rework: 0, reject: 0, held: lot } : { lot, awaiting: 0, pass: lot, rework: 0, reject: 0, held: 0 };
  return { lot, awaiting: 0, pass: num(i.passQty), rework: num(i.reworkQty), reject: num(i.rejectQty), held: num(i.heldQty) };
}

/** Quality result of one stage for one job: lots, first-pass, rework outcome, released, rejected and still held. */
export function stageResult(stageKey, inspections, reworks) {
  const ins = inspections.filter((i) => i.inspectionStage === stageKey && !i.isDeleted);
  const ids = new Set(ins.map((i) => String(i._id)));
  const rw = reworks.filter((r) => !r.isDeleted && ids.has(String(r.inspection)));
  const d = ins.map(lotDisposition);
  const t = (k) => sum(d, k);
  const reinspPassed = sum(rw, 'reinspPassedQty'); const reinspRejected = sum(rw, 'reinspRejectedQty');
  const scrap = sum(rw, 'scrapQty'); const concession = sum(rw, 'releasedQty');
  const failedPool = t('rework') + t('held');
  const resolved = reinspPassed + reinspRejected + scrap + concession;
  return {
    stage: stageKey, inspections: ins.length,
    lots: t('lot'), awaiting: t('awaiting'), firstPass: t('pass'), rework: t('rework'), heldAtInspection: t('held'), rejectedAtInspection: t('reject'),
    reinspPassed, reinspRejected, scrap, concession,
    released: t('pass') + reinspPassed + concession,
    rejected: t('reject') + reinspRejected + scrap,
    held: Math.max(failedPool - resolved, 0),
    overResolved: Math.max(resolved - failedPool, 0),
  };
}

const deptTotals = (sheets, department) => {
  const rows = sheets.filter((s) => s.department === department);
  const input = sum(rows, 'inputQty'); const completed = sum(rows, 'completedQty'); const rejected = sum(rows, 'rejectedQty');
  return { department, sheets: rows.length, input, completed, rejected, rework: sum(rows, 'reworkQty'), pending: input - completed - rejected, target: sum(rows, 'targetQty'), manHours: round(sum(rows, 'manHours'), 2) };
};

/**
 * Flow of one job (or of a main job with its sub jobs, when given all their records).
 * Records must already be filtered to the job(s); sheets exclude rejected sheets.
 */
export function computeFlow({ job, route, sheets = [], inspections = [], reworks = [], shipments = [] }) {
  const liveSheets = sheets.filter((s) => !s.isDeleted && s.status !== 'Rejected');
  const onFlow = liveSheets.length > 0;
  const steps = route.steps;
  const stageKeys = [...new Set([...steps.map((s) => s.gateStage).filter(Boolean), ...inspections.map((i) => i.inspectionStage).filter(Boolean), ...(route.preShipmentRequired ? [SHIPMENT_GATE] : [])])];
  const stages = Object.fromEntries(stageKeys.map((k) => [k, { ...stageResult(k, inspections, reworks), source: stageSource(route, k), gate: steps.some((s) => s.gateStage === k) || (k === SHIPMENT_GATE && route.preShipmentRequired), sampling: !!qcStage(k)?.sampling }]));
  // what each department may take in: the previous department's completed output, or what its quality gate released
  const depts = steps.map((s, i) => ({ ...deptTotals(liveSheets, s.department), gateStage: s.gateStage || '', fromDept: i ? steps[i - 1].department : null }));
  depts.forEach((d, i) => {
    d.available = i === 0 ? null : d.gateStage ? stages[d.gateStage].released : depts[i - 1].completed;
    d.handover = i === 0 ? 0 : d.available - d.input;
  });
  // lots reconcile with the output of the department that submitted them
  const byDept = Object.fromEntries(depts.map((d) => [d.department, d]));
  Object.values(stages).forEach((st) => {
    const src = st.source ? byDept[st.source] : null;
    st.sourceCompleted = src ? src.completed : null;
    st.notSubmitted = src && !st.sampling ? src.completed - st.lots : null;
  });

  // finished goods
  const fgDept = byDept['Finished Goods Inward'] ? 'Finished Goods Inward' : steps[steps.length - 1]?.department;
  const fgInward = fgDept ? byDept[fgDept].completed : 0;
  const fgStages = FG_STAGES.filter((k) => stages[k]);
  const fgHeld = sum(fgStages.map((k) => stages[k]), (s) => s.held + s.awaiting);
  // pieces failed at a finished-goods inspection leave finished goods (pre-shipment and FG approval inspect the same goods)
  const fgRejected = Math.max(0, ...fgStages.map((k) => stages[k].rejected));
  const shippedRows = shipments.filter((s) => !s.isDeleted && ['Shipped', 'Delivered'].includes(s.status));
  const plannedRows = shipments.filter((s) => !s.isDeleted && !['Shipped', 'Delivered', 'Cancelled'].includes(s.status));
  const shipped = sum(shippedRows, 'qty');
  const fgOnHand = fgInward - fgRejected - shipped;
  const releasedForShipment = route.preShipmentRequired ? (stages[SHIPMENT_GATE]?.released || 0) : fgInward - fgRejected;
  const fg = {
    department: fgDept, produced: byDept['Sewing and Stitching']?.completed ?? null, packed: byDept.Packing?.completed ?? null, cartonPacked: byDept['Carton/Box Packing']?.completed ?? null,
    fgInward, qualityApproved: releasedForShipment, held: fgHeld, rejected: fgRejected, shipped, plannedShipment: sum(plannedRows, 'qty'),
    onHand: fgOnHand,
    availableForShipment: Math.max(Math.min(fgOnHand - fgHeld, releasedForShipment - shipped), 0),
    preShipmentRequired: route.preShipmentRequired,
  };

  // where the pieces are (each piece once): department WIP, waiting between departments, quality pipeline
  const issues = [];
  depts.forEach((d) => {
    if (d.pending < 0) issues.push(`${d.department}: completed + rejected (${d.completed + d.rejected}) exceed input (${d.input})`);
    if (d.handover < 0) issues.push(`${d.department}: input ${d.input} exceeds ${d.gateStage ? `${d.gateStage} released` : `${d.fromDept} completed`} ${d.available}`);
  });
  Object.values(stages).forEach((st) => {
    // lots can only be reconciled with department output when the job's production is recorded by department
    if (onFlow && st.notSubmitted !== null && st.notSubmitted < 0) issues.push(`${st.stage}: lots ${st.lots} exceed ${st.source} completed ${st.sourceCompleted}`);
    if (st.overResolved > 0) issues.push(`${st.stage}: rework outcomes exceed failed / held quantity by ${st.overResolved}`);
  });
  if (onFlow && shipped > releasedForShipment) issues.push(`Shipped ${shipped} exceeds quality-released finished goods ${releasedForShipment}`);
  const gateWip = sum(Object.values(stages).filter((s) => s.gate), (s) => s.held + s.awaiting + Math.max(num(s.notSubmitted), 0));
  const wip = {
    inDepartments: sum(depts, (d) => Math.max(d.pending, 0)),
    betweenDepartments: sum(depts.filter((d) => !d.gateStage), (d) => Math.max(d.handover, 0)),
    atQualityGates: gateWip + sum(depts.filter((d) => d.gateStage), (d) => Math.max(d.handover, 0)),
    qualityHeld: sum(Object.values(stages), (s) => s.held),
  };
  wip.total = wip.inDepartments + wip.betweenDepartments + wip.atQualityGates;
  // pieces lost from the flow: department rejections + rejections at quality gates (other inspections only record
  // quality – the department sheet that holds those pieces records them as rejected)
  const rejected = sum(depts, 'rejected') + sum(Object.values(stages).filter((s) => s.gate), 'rejected');
  return {
    jobNo: job.jobNo, onFlow, route: { name: route.name, refNo: route.refNo, preShipmentRequired: route.preShipmentRequired, steps: steps.map((s) => ({ ...s })) },
    departments: depts, stages: Object.values(stages), fg, wip, rejected, issues,
    cut: depts[0]?.completed || 0,
  };
}

/** Load the flow inputs for many jobs at once (one query per collection). */
export async function loadFlowRecords(jobIds) {
  const ids = jobIds.map(String);
  const [sheets, inspections, reworks, shipments] = await Promise.all([
    models.hourlyProduction.find({ job: { $in: ids }, ...LIVE_SHEET }).lean(),
    models.inspection.find({ job: { $in: ids }, isDeleted: false }).lean(),
    models.qcRework.find({ job: { $in: ids }, isDeleted: false }).lean(),
    models.shipment.find({ job: { $in: ids }, isDeleted: false, status: { $ne: 'Cancelled' } }).lean(),
  ]);
  return { sheets, inspections, reworks, shipments };
}

const mine = (rows, ids) => rows.filter((r) => ids.has(String(r.job)));

/**
 * Flows for a list of jobs. A main job with sub jobs gets the consolidated flow of its own and its sub jobs'
 * records (each record belongs to exactly one job, so nothing is counted twice).
 */
export async function flowsForJobs(jobs, { routes } = {}) {
  if (!jobs.length) return new Map();
  routes ||= await loadRoutes();
  const subs = await models.orders.find({ parentJob: { $in: jobs.map((j) => j._id) }, isDeleted: false }).select('_id parentJob').lean();
  const idsOf = new Map(jobs.map((j) => [String(j._id), new Set([String(j._id), ...subs.filter((s) => String(s.parentJob) === String(j._id)).map((s) => String(s._id))])]));
  const rec = await loadFlowRecords([...new Set([...idsOf.values()].flatMap((s) => [...s]))]);
  const out = new Map();
  for (const job of jobs) {
    const ids = idsOf.get(String(job._id));
    out.set(String(job._id), computeFlow({
      job, route: resolveRoute(job, routes),
      sheets: mine(rec.sheets, ids), inspections: mine(rec.inspections, ids), reworks: mine(rec.reworks, ids), shipments: mine(rec.shipments, ids),
    }));
  }
  return out;
}

/**
 * Validate a change before it is saved: the flow is recalculated with the record replaced by its new version, and
 * every quantity rule that the change would newly break is returned (rules already broken before stay reported by
 * the integrity checks, but do not block unrelated edits).
 */
export async function flowViolations(job, { sheet, inspection, rework, shipment } = {}) {
  const routes = await loadRoutes();
  const route = resolveRoute(job, routes);
  const rec = await loadFlowRecords([job._id]);
  const swap = (rows, doc) => (doc ? [...rows.filter((r) => String(r._id) !== String(doc._id)), ...(doc.isDeleted || (doc.status === 'Rejected' && doc === sheet) ? [] : [doc])] : rows);
  const before = computeFlow({ job, route, ...rec });
  const after = computeFlow({ job, route, sheets: swap(rec.sheets, sheet), inspections: swap(rec.inspections, inspection), reworks: swap(rec.reworks, rework), shipments: swap(rec.shipments, shipment) });
  const had = new Set(before.issues);
  return { route, before, after, violations: after.issues.filter((m) => !had.has(m)) };
}

/** Over-cut tolerance limit for the first department of the route. */
export async function cuttingLimit(job) {
  const tol = await getSetting('tolerance');
  return Math.floor(num(job.orderQty) * (1 + num(tol.overCutPct) / 100));
}

export { QC_STAGES, FG_STAGES };
