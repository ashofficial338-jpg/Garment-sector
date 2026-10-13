/**
 * Factory reports – production (hourly → daily consolidation, WIP, job history), quality, HR & labour,
 * factory expenses, cost of quality, finished goods, profit & loss with cash flow, dashboards and integrity checks.
 *
 * Every figure is calculated here from saved transactions, in the request's unit scope (one unit, or both units –
 * see unitContext.js). Each report returns `tables` of rows whose `_link` points at the source record, so every
 * consolidated number can be traced back to the transactions it came from.
 */
import { models } from '../modules/builder.js';
import { getSetting } from './settings.js';
import { loadJobGraphs, computeProfit, computeStages } from './lifecycle.js';
import { flowsForJobs, lotDisposition, loadRoutes } from './factoryFlow.js';
import { allocations, expenseShare, unitsInScope } from './costAllocation.js';
import { num, round, sum, pct } from '../../../shared/calc.js';
import { sheetTotals, QUALITY_EXPENSE_CATEGORIES, PRODUCTION_DEPARTMENTS, QC_STAGE_KEYS, SHIPMENT_GATE } from '../../../shared/modules/factory.js';
import { COST_HEADS, financeLineOf, headOfExpense } from '../../../shared/costHeads.js';
import { DEFAULT_UNITS } from '../../../shared/constants.js';
import { ApiError } from '../utils/ApiError.js';

const DAY = 86400000;
const r2 = (v) => round(v, 2);
const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const monthOf = (d) => isoDay(d).slice(0, 7);
const c = (key, label, o = {}) => ({ key, label, ...o });
const N = (key, label, d = 0) => c(key, label, { num: d });
const link = (module, id) => ({ module, id: String(id) });
const T = (title, columns, rows, extra = {}) => ({ title, columns, rows, ...extra });

/* ================================ Filters ================================ */
function asDay(v, end) {
  const s = String(v || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw ApiError.badRequest(`Invalid date ${v}`);
  return new Date(`${s}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
}
export function period(q = {}, defDays = 30) {
  const to = asDay(q.to || isoDay(Date.now()), true);
  const from = q.from ? asDay(q.from) : new Date(to.getTime() + 1 - defDays * DAY);
  if (from > to) throw ApiError.badRequest('From date is after To date');
  return { from, to, label: `${isoDay(from)} → ${isoDay(to)}` };
}
const inP = (d, p) => d && new Date(d) >= p.from && new Date(d) <= p.to;

/** Unit codes in the current scope. */
export const scopeUnits = unitsInScope;

async function unitNames() {
  return Object.fromEntries((await getSetting('units')).map((u) => [u.code, u.name]));
}

/**
 * Jobs in scope + the job filter (buyer / job / style). A main job number selects the main job and its sub jobs.
 * Returns { jobs (all, by id), ids (Set of selected job ids or null = no job filter) }.
 */
async function jobScope(q = {}) {
  const all = await models.orders.find({ isDeleted: false }).lean();
  const jobs = new Map(all.map((j) => [String(j._id), j]));
  const want = (v) => String(v || '').trim().toLowerCase();
  const [b, jn, st] = [want(q.buyer), want(q.jobNo), want(q.styleNo)];
  if (!b && !jn && !st) return { jobs, ids: null, all };
  const ids = new Set(all.filter((j) => (!b || want(j.buyerName).includes(b) || String(j.buyer) === q.buyer)
    && (!jn || want(j.jobNo) === jn || want(j.parentJobNo) === jn)
    && (!st || want(j.styleNo).includes(st))).map((j) => String(j._id)));
  return { jobs, ids, all };
}
const jobCols = (j, names) => ({ unit: names[j?.businessUnit] || j?.businessUnit || '', mainJob: j?.parentJobNo || j?.jobNo || '', jobNo: j?.jobNo || '', subJob: j?.parentJobNo ? j.jobNo : '', buyerName: j?.buyerName || '', poNo: j?.poNo || '', styleNo: j?.styleNo || '' });
const JOB_COLS = [c('unit', 'Unit'), c('mainJob', 'Main Job'), c('subJob', 'Sub Job'), c('buyerName', 'Buyer'), c('poNo', 'Order / PO'), c('styleNo', 'Style')];

/** Group rows by key fields and sum numeric fields; keeps the source references for drill-down. */
function group(rows, keys, sums, extra = () => ({})) {
  const m = new Map();
  rows.forEach((r) => {
    const k = keys.map((x) => r[x] ?? '').join('|');
    let g = m.get(k);
    if (!g) { g = { ...Object.fromEntries(keys.map((x) => [x, r[x] ?? ''])), _sources: [] }; sums.forEach((s) => { g[s] = 0; }); m.set(k, g); }
    sums.forEach((s) => { g[s] += num(r[s]); });
    if (r._ref && !g._sources.includes(r._ref)) g._sources.push(r._ref);
  });
  return [...m.values()].map((g) => ({ ...g, ...extra(g), sources: g._sources.join(', ') }));
}
const achieved = (g) => ({ achievementPct: g.target ? pct(g.completed, g.target, 1) : null, outputPerManHour: g.manHours ? r2(g.completed / g.manHours) : null });

/* ================================ Production ================================ */
export async function productionReport(q) {
  const p = period(q, 7);
  const names = await unitNames();
  const { jobs, ids } = await jobScope(q);
  const f = { isDeleted: false, entryDate: { $gte: p.from, $lte: p.to }, status: q.status || { $ne: 'Rejected' } };
  ['department', 'shift', 'line'].forEach((k) => { if (q[k]) f[k] = q[k]; });
  if (ids) f.job = { $in: [...ids] };
  const sheets = await models.hourlyProduction.find(f).sort({ entryDate: 1, department: 1, line: 1 }).lean();
  const hourly = sheets.flatMap((s) => (s.slots || []).map((r) => ({
    ...jobCols(jobs.get(String(s.job)) || s, names), date: isoDay(s.entryDate), month: monthOf(s.entryDate), shift: s.shift, department: s.department, line: s.line || '', operation: s.operation || '',
    slot: r.slot, color: r.color || s.color || '', size: r.size || s.size || '', target: num(r.target), input: num(r.inputQty), completed: num(r.completedQty), rejected: num(r.rejectedQty), rework: num(r.reworkQty),
    achievementPct: num(r.target) ? pct(r.completedQty, r.target, 1) : null, downtimeMin: num(r.downtimeMin), delayReason: r.delayReason || '', team: r.team || '', manHours: num(r.workingHours),
    sheet: s.refNo, status: s.status, enteredBy: r.enteredBy || s.createdByName, enteredAt: r.enteredAt || '', _ref: s.refNo, _link: link('hourlyProduction', s._id),
  })));
  const S = ['target', 'input', 'completed', 'rejected', 'rework', 'downtimeMin', 'manHours'];
  const daily = group(hourly, ['date', 'unit', 'department'], S, achieved);
  const shiftwise = group(hourly, ['date', 'shift', 'unit', 'department'], S, achieved);
  const deptwise = group(hourly, ['unit', 'department'], S, (g) => ({ ...achieved(g), rejectionPct: pct(g.rejected, g.input, 2), reworkPct: pct(g.rework, g.input, 2) }));
  const linewise = group(hourly, ['unit', 'department', 'line'], S, achieved);
  const jobwise = group(hourly, ['unit', 'mainJob', 'jobNo', 'buyerName', 'styleNo', 'department'], S, achieved);
  const teamwise = group(hourly.filter((h) => h.team), ['unit', 'department', 'line', 'team'], S, achieved);
  const slotwise = group(hourly, ['department', 'slot'], ['target', 'completed']).map((g) => ({ ...g, achievementPct: g.target ? pct(g.completed, g.target, 1) : null }));
  const monthly = group(hourly, ['month', 'unit', 'department'], S, achieved);
  const delays = hourly.filter((h) => h.downtimeMin > 0 || h.delayReason);
  // each sheet's stored daily totals must equal the sum of its hourly rows
  const mismatches = sheets.map((s) => {
    const t = sheetTotals(s.slots, s.openingQty);
    const diff = ['inputQty', 'completedQty', 'rejectedQty', 'reworkQty', 'targetQty'].filter((k) => num(s[k]) !== num(t[k]));
    return diff.length ? { sheet: s.refNo, date: isoDay(s.entryDate), department: s.department, jobNo: s.jobNo, fields: diff.join(', '), _link: link('hourlyProduction', s._id) } : null;
  }).filter(Boolean);
  const dept = (d) => deptwise.filter((x) => x.department === d).reduce((t, x) => t + x.completed, 0);
  const HC = [c('date', 'Date'), ...JOB_COLS, c('department', 'Department'), c('line', 'Line'), c('shift', 'Shift'), c('slot', 'Hour'), c('color', 'Colour'), c('size', 'Size'), N('target', 'Target'), N('input', 'Input'), N('completed', 'Completed'), N('rejected', 'Rejected'), N('rework', 'Rework'), N('achievementPct', 'Achv %', 1), N('downtimeMin', 'Downtime'), c('delayReason', 'Delay reason'), c('team', 'Team'), c('sheet', 'Sheet', { link: true }), c('status', 'Status'), c('enteredBy', 'Entered by')];
  const G = [N('target', 'Target'), N('input', 'Input'), N('completed', 'Completed'), N('rejected', 'Rejected'), N('rework', 'Rework'), N('achievementPct', 'Achv %', 1), N('downtimeMin', 'Downtime min'), N('manHours', 'Man-hours', 1), N('outputPerManHour', 'Output / man-hr', 2), c('sources', 'Source sheets')];
  return {
    period: p.label,
    summary: { sheets: sheets.length, hourlyRows: hourly.length, cut: dept('Cutting'), sewn: dept('Sewing and Stitching'), finished: dept('Ironing and Finishing'), cartonPacked: dept('Carton/Box Packing'), fgInward: dept('Finished Goods Inward'), rejected: sum(hourly, 'rejected'), rework: sum(hourly, 'rework'), downtimeMin: sum(hourly, 'downtimeMin'), target: sum(hourly.filter((h) => h.department === 'Sewing and Stitching'), 'target'), consistency: mismatches.length },
    tables: {
      daily: T('Daily production summary (consolidated from hourly entries)', [c('date', 'Date'), c('unit', 'Unit'), c('department', 'Department'), ...G], daily),
      hourly: T('Hourly production report', HC, hourly),
      department: T('Department-wise output & productivity', [c('unit', 'Unit'), c('department', 'Department'), ...G.slice(0, -1), N('rejectionPct', 'Rejection %', 2), N('reworkPct', 'Rework %', 2), c('sources', 'Source sheets')], deptwise),
      shift: T('Shift-wise production', [c('date', 'Date'), c('shift', 'Shift'), c('unit', 'Unit'), c('department', 'Department'), ...G], shiftwise),
      line: T('Line-wise production', [c('unit', 'Unit'), c('department', 'Department'), c('line', 'Line'), ...G], linewise),
      job: T('Job-wise production (Main Job / Sub Job)', [c('unit', 'Unit'), c('mainJob', 'Main Job'), c('jobNo', 'Job / Sub Job'), c('buyerName', 'Buyer'), c('styleNo', 'Style'), c('department', 'Department'), ...G], jobwise),
      target: T('Hourly target vs actual', [c('department', 'Department'), c('slot', 'Hour'), N('target', 'Target'), N('completed', 'Actual'), N('achievementPct', 'Achv %', 1)], slotwise),
      team: T('Employee / team-wise performance', [c('unit', 'Unit'), c('department', 'Department'), c('line', 'Line'), c('team', 'Team'), ...G], teamwise),
      monthly: T('Unit-wise monthly comparison', [c('month', 'Month'), c('unit', 'Unit'), c('department', 'Department'), ...G], monthly),
      delays: T('Downtime & delay reasons', HC, delays),
      consistency: T('Hourly ↔ daily consistency (sheets whose totals differ from their hourly rows)', [c('sheet', 'Sheet', { link: true }), c('date', 'Date'), c('department', 'Department'), c('jobNo', 'Job'), c('fields', 'Fields that differ')], mismatches),
    },
  };
}

/* ================================ WIP & finished goods ================================ */
async function leafJobs(q, { open = true } = {}) {
  const { jobs, ids } = await jobScope(q);
  const hasSubs = new Set([...jobs.values()].filter((j) => j.parentJob).map((j) => String(j.parentJob)));
  return [...jobs.values()].filter((j) => !hasSubs.has(String(j._id)) && (!ids || ids.has(String(j._id))) && (!open || !['Closed', 'Cancelled'].includes(j.status)) && j.status !== 'Cancelled');
}

export async function wipReport(q) {
  const names = await unitNames();
  const jobs = await leafJobs(q, { open: q.include !== 'all' });
  const flows = await flowsForJobs(jobs);
  const stageRows = []; const jobRows = [];
  jobs.forEach((j) => {
    const f = flows.get(String(j._id));
    if (!f.onFlow) return;
    f.departments.forEach((d) => stageRows.push({ ...jobCols(j, names), department: d.department, gate: d.gateStage, available: d.available, input: d.input, completed: d.completed, rejected: d.rejected, rework: d.rework, wip: d.pending, waiting: d.handover, sheets: d.sheets }));
    f.stages.filter((s) => s.gate || !s.sampling).forEach((s) => stageRows.push({ ...jobCols(j, names), department: `QC · ${s.stage}`, gate: s.gate ? 'Gate' : '', available: s.sourceCompleted, input: s.lots, completed: s.released, rejected: s.rejected, rework: s.rework, wip: s.held + s.awaiting, waiting: s.notSubmitted, sheets: s.inspections }));
    jobRows.push({ ...jobCols(j, names), orderQty: num(j.orderQty), route: f.route.name, cut: f.cut, sewn: f.fg.produced, fgInward: f.fg.fgInward, inDepartments: f.wip.inDepartments, betweenDepartments: f.wip.betweenDepartments, atQualityGates: f.wip.atQualityGates, held: f.wip.qualityHeld, rejected: f.rejected, shipped: f.fg.shipped, available: f.fg.availableForShipment, issues: f.issues.join('; '), _link: link('orders', j._id) });
  });
  return {
    summary: { jobs: jobRows.length, wip: sum(jobRows, (r) => r.inDepartments + r.betweenDepartments + r.atQualityGates), held: sum(jobRows, 'held'), issues: jobRows.filter((r) => r.issues).length },
    tables: {
      jobs: T('Stage-wise WIP by job', [...JOB_COLS, N('orderQty', 'Order'), c('route', 'Route'), N('cut', 'Cut'), N('sewn', 'Sewn'), N('fgInward', 'FG inward'), N('inDepartments', 'WIP in depts'), N('betweenDepartments', 'Waiting between depts'), N('atQualityGates', 'At QC gates'), N('held', 'Quality held'), N('rejected', 'Rejected'), N('shipped', 'Shipped'), N('available', 'FG available'), c('issues', 'Reconciliation issues')], jobRows),
      stages: T('Department & quality-gate balances', [...JOB_COLS, c('department', 'Department / stage'), c('gate', 'Gate'), N('available', 'Available to take in'), N('input', 'Input / lots'), N('completed', 'Completed / released'), N('rejected', 'Rejected'), N('rework', 'Rework'), N('wip', 'WIP / held'), N('waiting', 'Waiting'), N('sheets', 'Records')], stageRows),
    },
  };
}

/** Finished Goods Pending Shipment – quality-approved, held, packed, available, shipped and balance per job. */
export async function finishedGoodsReport(q) {
  const names = await unitNames();
  const jobs = await leafJobs(q, { open: q.include !== 'all' });
  const [flows, graphs] = await Promise.all([flowsForJobs(jobs), loadJobGraphs(jobs)]);
  const today = new Date();
  const rows = graphs.map((g) => {
    const j = g.job; const f = flows.get(String(j._id));
    const ok = (r) => r.status !== 'Rejected';
    const legacy = !f.onFlow;
    const shipments = g.shipments;
    const last = [...shipments].sort((a, b) => new Date(b.shipmentDate || 0) - new Date(a.shipmentDate || 0))[0];
    const produced = legacy ? sum(g.sewing.filter(ok), 'actualQty') : f.fg.produced;
    const packed = legacy ? sum(g.packing, 'totalQty') : f.fg.packed;
    const approved = legacy ? sum(g.inspections.filter((i) => ['Final', 'Re-inspection'].includes(i.inspectionType) && ['Passed', 'Final Approved'].includes(i.status)), 'lotSize') : f.fg.qualityApproved;
    const shipped = f.fg.shipped;
    const reworkPending = sum(g.reworks || [], (r) => (r.status === 'Closed' ? 0 : num(r.pendingQty)));
    const available = legacy ? Math.max(Math.min(packed, approved || packed) - shipped, 0) : f.fg.availableForShipment;
    const balance = Math.max(num(j.orderQty) - shipped, 0);
    const due = j.deliveryDate || j.shipmentDate;
    const late = due && new Date(due) < today && balance > 0;
    const reasons = [];
    if (late) {
      if (f.wip.qualityHeld > 0) reasons.push(`${f.wip.qualityHeld} pcs on quality hold`);
      if (!legacy && f.fg.fgInward < num(j.orderQty)) reasons.push(`production: ${f.fg.fgInward}/${j.orderQty} in finished goods`);
      if (legacy && packed < num(j.orderQty)) reasons.push(`packing ${packed}/${j.orderQty}`);
      if (!legacy && f.fg.preShipmentRequired && f.fg.onHand - f.fg.held > f.fg.qualityApproved - shipped) reasons.push(`${f.fg.onHand - f.fg.held - (f.fg.qualityApproved - shipped)} pcs awaiting pre-shipment inspection`);
      if (!shipments.length) reasons.push('shipment not booked');
      else if (last && !['Shipped', 'Delivered'].includes(last.status)) reasons.push(`shipment ${last.refNo} ${last.status}`);
      if (!reasons.length) reasons.push('balance not yet shipped');
    }
    return {
      ...jobCols(j, names), colors: (j.colors || []).join(', ') || [...new Set((j.sizeBreakdown || []).map((x) => x.color).filter(Boolean))].join(', '), sizes: (j.sizes || []).join(', ') || [...new Set((j.sizeBreakdown || []).map((x) => x.size).filter(Boolean))].join(', '),
      orderQty: num(j.orderQty), produced, qualityApproved: approved, rejected: f.onFlow ? f.rejected : sum(g.sewing, 'rejection') + sum(g.finishing, 'rejection'), rework: reworkPending, held: f.wip.qualityHeld + (f.onFlow ? f.fg.held : 0),
      packed, cartonPacked: legacy ? packed : f.fg.cartonPacked, fgInward: legacy ? packed : f.fg.fgInward, available, shipped, balance,
      shipmentStatus: last ? `${last.status}${last.refNo ? ` (${last.refNo})` : ''}` : 'Not planned', deliveryDate: isoDay(due), delayReason: reasons.join('; '), basis: legacy ? 'Daily entries' : 'Department flow',
      _link: link('orders', j._id),
    };
  });
  return {
    summary: { jobs: rows.length, fgAvailable: sum(rows, 'available'), held: sum(rows, 'held'), shipped: sum(rows, 'shipped'), balance: sum(rows, 'balance'), late: rows.filter((r) => r.delayReason).length },
    tables: {
      pending: T('Finished Goods Pending Shipment', [...JOB_COLS, c('colors', 'Colours'), c('sizes', 'Sizes'), N('orderQty', 'Order'), N('produced', 'Produced'), N('qualityApproved', 'Quality approved'), N('rejected', 'Rejected'), N('rework', 'Rework pending'), N('held', 'Held'), N('packed', 'Packed'), N('cartonPacked', 'Carton packed'), N('fgInward', 'FG inward'), N('available', 'FG available'), N('shipped', 'Shipped'), N('balance', 'Balance'), c('shipmentStatus', 'Shipment status'), c('deliveryDate', 'Delivery'), c('delayReason', 'Delay reason'), c('basis', 'Basis')], rows),
    },
  };
}

/** Main Job / Sub Job production & quality history (every transaction, in order). */
export async function jobHistory(jobNo) {
  const names = await unitNames();
  const job = await models.orders.findOne({ jobNo, isDeleted: false }).lean();
  if (!job) throw ApiError.notFound(`Job ${jobNo} not found`);
  const main = job.parentJob ? await models.orders.findById(job.parentJob).lean() : job;
  const subs = await models.orders.find({ parentJob: main._id, isDeleted: false }).sort({ jobNo: 1 }).lean();
  const all = [main, ...subs];
  const ids = all.map((j) => j._id);
  const [sheets, inspections, reworks, shipments] = await Promise.all([
    models.hourlyProduction.find({ job: { $in: ids }, isDeleted: false }).lean(),
    models.inspection.find({ job: { $in: ids }, isDeleted: false }).lean(),
    models.qcRework.find({ job: { $in: ids }, isDeleted: false }).lean(),
    models.shipment.find({ job: { $in: ids }, isDeleted: false }).lean(),
  ]);
  const byId = new Map(all.map((j) => [String(j._id), j]));
  const tl = [
    ...sheets.map((s) => ({ date: isoDay(s.entryDate), jobNo: s.jobNo, type: 'Hourly production', ref: s.refNo, where: `${s.department}${s.line ? ` · ${s.line}` : ''} · ${s.shift}`, input: s.inputQty, output: s.completedQty, rejected: s.rejectedQty, rework: s.reworkQty, status: s.status, _link: link('hourlyProduction', s._id) })),
    ...inspections.map((i) => { const d = lotDisposition(i); return { date: isoDay(i.inspectionDate), jobNo: i.jobNo, type: 'QC inspection', ref: i.refNo, where: i.inspectionStage || i.inspectionType, input: d.lot, output: d.pass, rejected: d.reject, rework: d.rework + d.held, status: i.status, _link: link('inspection', i._id) }; }),
    ...reworks.map((r) => ({ date: isoDay(r.issueDate), jobNo: r.jobNo, type: 'Quality issue / rework', ref: r.refNo, where: `${r.inspectionStage} → ${r.assignedDept || '—'}`, input: r.failedQty, output: num(r.reinspPassedQty) + num(r.releasedQty), rejected: num(r.reinspRejectedQty) + num(r.scrapQty), rework: r.reworkedQty, status: r.status, _link: link('qcRework', r._id) })),
    ...shipments.map((s) => ({ date: isoDay(s.actualShipDate || s.shipmentDate), jobNo: s.jobNo, type: 'Shipment', ref: s.refNo, where: s.mode, input: null, output: s.qty, rejected: null, rework: null, status: s.status, _link: link('shipment', s._id) })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.jobNo.localeCompare(b.jobNo));
  const flows = await flowsForJobs(all);
  const flowRows = all.map((j) => { const f = flows.get(String(j._id)); return { ...jobCols(j, names), level: j._id === main._id ? (subs.length ? 'Main job (incl. sub jobs)' : 'Job') : 'Sub job', orderQty: num(j.orderQty), cut: f.cut, sewn: f.fg.produced, fgInward: f.fg.fgInward, wip: f.wip.total, held: f.wip.qualityHeld, rejected: f.rejected, shipped: f.fg.shipped, available: f.fg.availableForShipment }; });
  return {
    job: { jobNo: main.jobNo, buyerName: main.buyerName, styleNo: main.styleNo, subJobs: subs.map((s) => s.jobNo), unit: names[main.businessUnit] },
    tables: {
      flow: T('Main Job and Sub Job totals (main = its own + sub jobs, each record counted once)', [...JOB_COLS, c('level', 'Level'), N('orderQty', 'Order'), N('cut', 'Cut'), N('sewn', 'Sewn'), N('fgInward', 'FG inward'), N('wip', 'WIP'), N('held', 'Held'), N('rejected', 'Rejected'), N('shipped', 'Shipped'), N('available', 'Available')], flowRows),
      timeline: T('Production & quality history', [c('date', 'Date'), c('jobNo', 'Job'), c('type', 'Type'), c('ref', 'Ref', { link: true }), c('where', 'Department / stage'), N('input', 'Input / lot'), N('output', 'Output / passed'), N('rejected', 'Rejected'), N('rework', 'Rework / held'), c('status', 'Status')], tl.map((r) => ({ ...r, unit: names[byId.get(String(r.jobNo))?.businessUnit] }))),
    },
  };
}

/* ================================ Quality ================================ */
export async function qualityReport(q) {
  const p = period(q, 30);
  const names = await unitNames();
  const { jobs, ids } = await jobScope(q);
  const f = { isDeleted: false, inspectionDate: { $gte: p.from, $lte: p.to } };
  if (q.stage) f.inspectionStage = q.stage;
  if (q.department) f.$or = [{ department: q.department }, { responsibleDept: q.department }];
  if (q.inspector) f.inspector = new RegExp(String(q.inspector).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (ids) f.job = { $in: [...ids] };
  let ins = await models.inspection.find(f).sort({ inspectionDate: 1 }).lean();
  if (q.defect) ins = ins.filter((i) => (i.defectLines || []).some((l) => String(l.defectType || '').toLowerCase().includes(String(q.defect).toLowerCase())));
  const insIds = ins.map((i) => i._id);
  const reworks = await models.qcRework.find({ isDeleted: false, $or: [{ inspection: { $in: insIds } }, { issueDate: { $gte: p.from, $lte: p.to }, ...(ids ? { job: { $in: [...ids] } } : {}) }] }).lean();
  const rwBy = new Map();
  reworks.forEach((r) => (rwBy.get(String(r.inspection)) || rwBy.set(String(r.inspection), []).get(String(r.inspection))).push(r));
  const rows = ins.map((i) => {
    const d = lotDisposition(i); const j = jobs.get(String(i.job)) || i; const rw = rwBy.get(String(i._id)) || [];
    const reinspPassed = sum(rw, 'reinspPassedQty'); const released = sum(rw, 'releasedQty'); const reinspRejected = sum(rw, 'reinspRejectedQty') + sum(rw, 'scrapQty');
    return {
      ...jobCols(j, names), date: isoDay(i.inspectionDate), month: monthOf(i.inspectionDate), hour: String(i.inspectionTime || '').slice(0, 2) ? `${String(i.inspectionTime).slice(0, 2)}:00` : '—',
      stage: i.inspectionStage || `${i.inspectionType || ''} (legacy)`, type: i.inspectionType, department: i.department || '', responsibleDept: i.responsibleDept || '', line: i.line || '', color: i.color || '', size: i.size || '', bundleNo: i.bundleNo || '',
      inspector: i.inspector || '', method: i.inspectionMethod || '', lot: d.lot, sample: num(i.inspectionQty) || num(i.sampleSize), awaiting: d.awaiting, passed: d.pass, rework: d.rework, rejected: d.reject, held: d.held,
      reinspPassed, released, reinspRejected, accepted: d.pass + reinspPassed + released, stillHeld: Math.max(d.rework + d.held - reinspPassed - released - reinspRejected, 0),
      defects: num(i.totalDefects), critical: num(i.criticalDefects), major: num(i.majorDefects), minor: num(i.minorDefects), aql: i.aqlResult || '', status: i.status,
      fpyPct: d.lot && !d.awaiting ? pct(d.pass, d.lot, 1) : null, ref: i.refNo, reworkCost: sum(rw, 'reworkCost'), _ref: i.refNo, _link: link('inspection', i._id),
    };
  });
  const S = ['lot', 'awaiting', 'passed', 'rework', 'rejected', 'held', 'reinspPassed', 'released', 'reinspRejected', 'accepted', 'stillHeld', 'defects', 'reworkCost'];
  const rates = (g) => ({ fpyPct: g.lot - g.awaiting ? pct(g.passed, g.lot - g.awaiting, 1) : null, rejectionPct: g.lot - g.awaiting ? pct(g.rejected + g.reinspRejected, g.lot - g.awaiting, 2) : null, reworkPct: g.lot - g.awaiting ? pct(g.rework, g.lot - g.awaiting, 2) : null, finalAcceptPct: g.lot - g.awaiting ? pct(g.accepted, g.lot - g.awaiting, 1) : null });
  const by = (keys) => group(rows, keys, S, rates).map(({ _sources, ...x }) => x);
  const QC = [N('lot', 'Lot qty'), N('passed', 'First-pass'), N('rework', 'Rework'), N('rejected', 'Rejected'), N('held', 'Held'), N('reinspPassed', 'Passed on reinsp.'), N('released', 'Released'), N('accepted', 'Accepted'), N('stillHeld', 'Still held'), N('defects', 'Defects'), N('fpyPct', 'FPY %', 1), N('rejectionPct', 'Rejection %', 2), N('reworkPct', 'Rework %', 2), N('reworkCost', 'Rework cost', 2)];
  // defects
  const defectRows = ins.flatMap((i) => (i.defectLines || []).filter((l) => num(l.count) > 0).map((l) => {
    const j = jobs.get(String(i.job)) || i;
    return { ...jobCols(j, names), date: isoDay(i.inspectionDate), stage: i.inspectionStage || i.inspectionType, defectType: l.defectType || 'Unspecified', category: l.defectCategory || 'Other', code: l.defectCode || '', severity: l.severity, location: l.location || '', department: l.responsibleDept || i.responsibleDept || i.department || '', line: l.responsibleLine || i.line || '', size: i.size || '', count: num(l.count), ref: i.refNo, _link: link('inspection', i._id) };
  }));
  const pareto = group(defectRows, ['defectType', 'category'], ['count']).map(({ _sources, ...x }) => x).sort((a, b) => b.count - a.count);
  const totalDef = sum(pareto, 'count'); let cum = 0;
  pareto.forEach((x) => { cum += x.count; x.sharePct = pct(x.count, totalDef, 1); x.cumulativePct = pct(cum, totalDef, 1); });
  const defectsBy = (keys) => group(defectRows, keys, ['count']).map(({ _sources, ...x }) => x).sort((a, b) => b.count - a.count);
  // repeated defects: same defect type on the same job / line in 2+ inspections
  const repeated = group(defectRows.map((d) => ({ ...d, _ref: d.ref })), ['jobNo', 'line', 'defectType'], ['count']).filter((g) => g._sources.length > 1).map(({ _sources, ...x }) => ({ ...x, inspections: _sources.length }));
  const today = new Date(new Date().toISOString().slice(0, 10));
  const capa = reworks.map((r) => ({ ...jobCols(jobs.get(String(r.job)) || r, names), ref: r.refNo, date: isoDay(r.issueDate), stage: r.inspectionStage, defectType: r.defectType || '', assignedDept: r.assignedDept || '', responsible: [r.responsibleLine, r.responsibleTeam].filter(Boolean).join(' / '), failed: num(r.failedQty), reworked: num(r.reworkedQty), passed: num(r.reinspPassedQty), rejected: num(r.reinspRejectedQty) + num(r.scrapQty), released: num(r.releasedQty), pending: num(r.pendingQty), reworkCost: num(r.reworkCost), rootCause: r.rootCause || '', correctiveAction: r.correctiveAction || '', capaStatus: r.capaStatus || 'Open', capaDue: isoDay(r.capaDueDate), overdue: r.capaDueDate && new Date(r.capaDueDate) < today && !['Implemented', 'Verified'].includes(r.capaStatus) ? 'OVERDUE' : '', status: r.status, _link: link('qcRework', r._id) }));
  const pendingInsp = rows.filter((r) => r.awaiting > 0);
  const holds = rows.filter((r) => r.stillHeld > 0);
  const finals = rows.filter((r) => ['Final Garment Inspection', 'Finished Goods Approval', SHIPMENT_GATE].includes(r.stage) || (r.type === 'Final' && r.stage.includes('legacy')));
  const preShip = rows.filter((r) => r.stage === SHIPMENT_GATE);
  const tot = by([]).at(0) || {};
  const IC = [c('date', 'Date'), c('hour', 'Hour'), ...JOB_COLS, c('stage', 'Stage'), c('department', 'Department'), c('line', 'Line'), c('color', 'Colour'), c('size', 'Size'), c('bundleNo', 'Bundle'), c('inspector', 'Inspector'), c('method', 'Method'), N('lot', 'Lot'), N('sample', 'Sample'), N('passed', 'Passed'), N('rework', 'Rework'), N('rejected', 'Rejected'), N('held', 'Held'), N('accepted', 'Accepted (after rework)'), N('stillHeld', 'Still held'), N('defects', 'Defects'), c('aql', 'AQL'), N('fpyPct', 'FPY %', 1), c('status', 'Status'), c('ref', 'Inspection', { link: true })];
  return {
    period: p.label,
    summary: { inspections: rows.length, lot: tot.lot || 0, passed: tot.passed || 0, accepted: tot.accepted || 0, rejected: (tot.rejected || 0) + (tot.reinspRejected || 0), rework: tot.rework || 0, held: tot.stillHeld || 0, defects: tot.defects || 0, fpyPct: tot.fpyPct ?? null, rejectionPct: tot.rejectionPct ?? null, reworkPct: tot.reworkPct ?? null, reworkCost: r2(sum(capa, 'reworkCost')), openIssues: capa.filter((x) => x.status !== 'Closed').length, overdueCapa: capa.filter((x) => x.overdue).length, pendingInspections: pendingInsp.length },
    tables: {
      inspections: T('Inspection register', IC, rows),
      daily: T('Daily quality summary', [c('date', 'Date'), c('unit', 'Unit'), ...QC], by(['date', 'unit'])),
      hourly: T('Hourly QC inspection report', [c('date', 'Date'), c('hour', 'Hour'), c('unit', 'Unit'), c('stage', 'Stage'), ...QC], by(['date', 'hour', 'unit', 'stage'])),
      stage: T('Stage-wise quality', [c('unit', 'Unit'), c('stage', 'Stage'), ...QC], by(['unit', 'stage'])),
      department: T('Department-wise quality', [c('unit', 'Unit'), c('department', 'Department'), ...QC], by(['unit', 'department'])),
      job: T('Job & Sub Job-wise quality', [c('unit', 'Unit'), c('mainJob', 'Main Job'), c('jobNo', 'Job / Sub Job'), c('buyerName', 'Buyer'), c('styleNo', 'Style'), ...QC], by(['unit', 'mainJob', 'jobNo', 'buyerName', 'styleNo'])),
      buyer: T('Buyer-wise quality performance', [c('buyerName', 'Buyer'), ...QC], by(['buyerName'])),
      style: T('Style & size-wise analysis', [c('styleNo', 'Style'), c('size', 'Size'), ...QC], by(['styleNo', 'size'])),
      inspector: T('Inspector-wise', [c('inspector', 'Inspector'), ...QC], by(['inspector'])),
      unit: T('Unit 1 vs Unit 2 quality comparison', [c('unit', 'Unit'), ...QC], by(['unit'])),
      monthly: T('Monthly quality trend', [c('month', 'Month'), c('unit', 'Unit'), ...QC], by(['month', 'unit'])),
      pareto: T('Defect Pareto', [c('defectType', 'Defect'), c('category', 'Category'), N('count', 'Count'), N('sharePct', 'Share %', 1), N('cumulativePct', 'Cumulative %', 1)], pareto),
      defects: T('Defect register', [c('date', 'Date'), ...JOB_COLS, c('stage', 'Stage'), c('defectType', 'Defect'), c('category', 'Category'), c('code', 'Code'), c('severity', 'Severity'), c('location', 'Location'), c('department', 'Responsible dept'), c('line', 'Line / team'), c('size', 'Size'), N('count', 'Count'), c('ref', 'Inspection', { link: true })], defectRows),
      defectDept: T('Department & team-wise defect trend', [c('department', 'Department'), c('line', 'Line / team'), c('defectType', 'Defect'), N('count', 'Count')], defectsBy(['department', 'line', 'defectType'])),
      defectSize: T('Size-wise defects', [c('styleNo', 'Style'), c('size', 'Size'), c('defectType', 'Defect'), N('count', 'Count')], defectsBy(['styleNo', 'size', 'defectType'])),
      repeated: T('Repeated defects (same job, line and defect in several inspections)', [c('jobNo', 'Job'), c('line', 'Line'), c('defectType', 'Defect'), N('inspections', 'Inspections'), N('count', 'Count')], repeated),
      holds: T('Quality hold report (failed / held pieces not yet resolved)', IC, holds),
      pending: T('Pending inspection report (lots submitted, not inspected)', IC, pendingInsp),
      final: T('Final inspection approval report', IC, finals),
      preshipment: T('Pre-shipment inspection report', IC, preShip),
      capa: T('Rework & corrective action status', [c('ref', 'Issue', { link: true }), c('date', 'Date'), ...JOB_COLS, c('stage', 'Stage'), c('defectType', 'Defect'), c('assignedDept', 'Assigned to'), c('responsible', 'Responsible'), N('failed', 'Failed / held'), N('reworked', 'Reworked'), N('passed', 'Passed'), N('rejected', 'Rejected'), N('released', 'Released'), N('pending', 'Pending'), N('reworkCost', 'Rework cost', 2), c('rootCause', 'Root cause'), c('correctiveAction', 'Corrective action'), c('capaStatus', 'CAPA'), c('capaDue', 'Due'), c('overdue', 'Overdue'), c('status', 'Status')], capa),
    },
  };
}

/* ================================ HR & labour ================================ */
export async function hrReport(q) {
  const p = period(q, 30);
  const names = await unitNames();
  const f = { isDeleted: false, attendanceDate: { $gte: p.from, $lte: p.to }, status: { $ne: 'Rejected' } };
  if (q.section || q.department) f.section = q.section || q.department;
  const sheets = await models.attendance.find(f).sort({ attendanceDate: 1 }).lean();
  const alloc = await allocations(scopeUnits());
  const sec = q.section || q.department;
  const costRows = alloc.rows.filter((r) => scopeUnits().includes(r.unit) && r.date >= isoDay(p.from) && r.date <= isoDay(p.to) && (!sec || r.section === sec));
  const days = sheets.map((s) => ({
    date: isoDay(s.attendanceDate), month: monthOf(s.attendanceDate), unit: names[s.businessUnit] || s.businessUnit, section: s.section, line: s.line || '', shift: s.shift,
    headcount: num(s.headcount), present: num(s.presentCount), absent: num(s.absentCount), leave: num(s.leaveCount), hours: num(s.totalHours), otHours: num(s.totalOtHours), estimatedCost: num(s.labourCost), _ref: s.refNo, _link: link('attendance', s._id),
  }));
  const absent = (g) => ({ absenteeismPct: g.headcount ? pct(g.absent + g.leave, g.headcount, 1) : null });
  const S = ['headcount', 'present', 'absent', 'leave', 'hours', 'otHours', 'estimatedCost'];
  const costBy = (keys) => group(costRows.map((r) => ({ ...r, unit: names[r.unit] || r.unit, total: r.actual + r.estimated })), keys, ['hours', 'actual', 'estimated', 'total']).map(({ _sources, ...x }) => ({ ...x, actual: r2(x.actual), estimated: r2(x.estimated), total: r2(x.total) }));
  const payrolls = await models.payroll.find({ isDeleted: false, status: { $ne: 'Cancelled' } }).sort({ period: 1 }).lean();
  const months = alloc.months.filter((m) => scopeUnits().includes(m.unit) && m.month >= monthOf(p.from) && m.month <= monthOf(p.to)).map((m) => ({ ...m, unit: names[m.unit] || m.unit, labourTotal: r2(m.labourActual + m.labourEstimated) }));
  const jobRows = [];
  alloc.byJob.forEach((v, id) => { if (v.labourActual + v.labourEstimated + v.qualityLabourActual + v.qualityLabourEstimated > 0) jobRows.push({ id, ...v }); });
  const jobsById = new Map((await models.orders.find({ _id: { $in: jobRows.map((x) => x.id) } }).lean()).map((j) => [String(j._id), j]));
  const labourByJob = jobRows.filter((x) => jobsById.has(x.id)).map((x) => ({ ...jobCols(jobsById.get(x.id), names), labour: r2(x.labourActual + x.labourEstimated), qualityLabour: r2(x.qualityLabourActual + x.qualityLabourEstimated), estimatedPart: r2(x.labourEstimated + x.qualityLabourEstimated), directHours: x.hours, byDept: Object.entries(x.byDept).map(([k, v]) => `${k} ${r2(v)}`).join(' · '), _link: link('orders', x.id) }));
  const payRows = payrolls.filter((x) => x.period >= monthOf(p.from) && x.period <= monthOf(p.to)).map((x) => ({ period: x.period, unit: names[x.businessUnit] || x.businessUnit, type: x.payrollType, ref: x.refNo, headcount: num(x.headcount), gross: num(x.totalGross), employer: num(x.totalEmployer), deductions: num(x.totalDeductions), net: num(x.totalNet), cost: num(x.totalCost), status: x.status, paymentDate: isoDay(x.paymentDate), _link: link('payroll', x._id) }));
  const tot = group(days, [], S, absent)[0] || {};
  return {
    period: p.label,
    summary: { sheets: sheets.length, headcount: tot.headcount || 0, present: tot.present || 0, absenteeismPct: tot.absenteeismPct ?? null, hours: r2(tot.hours || 0), otHours: r2(tot.otHours || 0), labourActual: r2(sum(costRows, 'actual')), labourEstimated: r2(sum(costRows, 'estimated')), payrollCost: r2(sum(payRows.filter((x) => x.status !== 'Draft'), 'cost')) },
    tables: {
      daily: T('Daily attendance & estimated labour cost', [c('date', 'Date'), c('unit', 'Unit'), c('section', 'Section'), c('line', 'Line'), c('shift', 'Shift'), N('headcount', 'Headcount'), N('present', 'Present'), N('absent', 'Absent'), N('leave', 'Leave'), N('hours', 'Hours', 1), N('otHours', 'OT hrs', 1), N('estimatedCost', 'Est. cost', 2), c('sources', 'Sheet')], group(days, ['date', 'unit', 'section', 'line', 'shift'], S, absent)),
      section: T('Section-wise attendance', [c('unit', 'Unit'), c('section', 'Section'), N('headcount', 'Man-days'), N('present', 'Present'), N('absent', 'Absent'), N('leave', 'Leave'), N('absenteeismPct', 'Absenteeism %', 1), N('hours', 'Hours', 1), N('otHours', 'OT hrs', 1), N('estimatedCost', 'Est. cost', 2)], group(days, ['unit', 'section'], S, absent).map(({ _sources, ...x }) => x)),
      cost: T('Daily labour cost – actual (payroll) vs estimated (attendance)', [c('date', 'Date'), c('unit', 'Unit'), c('section', 'Section'), N('hours', 'Hours', 1), N('actual', 'Actual', 2), N('estimated', 'Estimated', 2), N('total', 'Total', 2)], costBy(['date', 'unit', 'section'])),
      monthly: T('Monthly labour cost & allocation', [c('month', 'Month'), c('unit', 'Unit'), N('labourActual', 'Actual (payroll)', 2), N('labourEstimated', 'Estimated (no payroll yet)', 2), N('labourTotal', 'Total', 2), N('labourDirect', 'Direct to jobs', 2), N('labourAllocated', 'Allocated by output', 2), N('labourToOverhead', 'Indirect → overhead', 2), N('labourUnabsorbed', 'Unabsorbed', 2)], months),
      job: T('Labour cost by job', [...JOB_COLS, N('labour', 'Production labour', 2), N('qualityLabour', 'Inspection labour', 2), N('estimatedPart', 'of which estimated', 2), N('directHours', 'Directly booked hrs', 1), c('byDept', 'By department')], labourByJob),
      payroll: T('Payroll (actual salaries & wages)', [c('period', 'Month'), c('unit', 'Unit'), c('type', 'Type'), c('ref', 'Payroll', { link: true }), N('headcount', 'Employees'), N('gross', 'Gross', 2), N('employer', 'Employer contrib.', 2), N('deductions', 'Deductions', 2), N('net', 'Net pay', 2), N('cost', 'Cost to company', 2), c('status', 'Status'), c('paymentDate', 'Paid on')], payRows),
    },
  };
}

/* ================================ Factory expenses ================================ */
export async function expenseReport(q) {
  const p = period(q, 30);
  const names = await unitNames();
  const units = scopeUnits();
  // this unit's own bills + the other unit's shared bills (at this unit's share)
  const f = { isDeleted: false, expenseDate: { $gte: p.from, $lte: p.to }, $or: [{ businessUnit: { $in: units } }, { sharing: 'Shared – Unit-1 & Unit-2' }] };
  if (q.category) f.category = q.category;
  if (q.department) f.department = q.department;
  const rows = (await models.factoryExpense.find({ ...f, businessUnit: { $in: DEFAULT_UNITS.map((u) => u.code) } }).sort({ expenseDate: 1 }).lean()).map((e) => {
    const share = sum(units.map((u) => expenseShare(e, u)));
    return { date: isoDay(e.expenseDate), month: monthOf(e.expenseDate), enteredIn: names[e.businessUnit] || e.businessUnit, category: e.category, department: e.department || 'Common', payee: e.payee, ref: e.refNo, referenceNo: e.referenceNo || '', description: e.description || '', jobNo: e.jobNo || '', amount: num(e.amount), share: r2(share), shareU1: e.sharing?.startsWith('Shared') ? num(e.shareU1) : null, shareU2: e.sharing?.startsWith('Shared') ? num(e.shareU2) : null, sharing: e.sharing, paymentStatus: e.paymentStatus, paid: num(e.paidAmount), status: e.status, recurring: e.recurring ? `Yes ${e.period || ''}` : '', quality: QUALITY_EXPENSE_CATEGORIES.includes(e.category) ? 'Quality' : '', _ref: e.refNo, _link: link('factoryExpense', e._id) };
  }).filter((r) => r.share > 0 || r.status !== 'Approved');
  const approved = rows.filter((r) => r.status === 'Approved');
  const S = ['share', 'paid'];
  const EC = [c('date', 'Date'), c('enteredIn', 'Entered in'), c('category', 'Category'), c('department', 'Department'), c('payee', 'Payee'), c('referenceNo', 'Bill no'), c('description', 'Description'), c('jobNo', 'Job'), N('amount', 'Amount', 2), c('sharing', 'Allocation'), N('share', 'This scope’s share', 2), c('paymentStatus', 'Payment'), N('paid', 'Paid', 2), c('status', 'Approval'), c('recurring', 'Recurring'), c('ref', 'Ref', { link: true })];
  return {
    period: p.label,
    summary: { approved: r2(sum(approved, 'share')), pendingApproval: rows.filter((r) => r.status === 'Pending').length, pendingAmount: r2(sum(rows.filter((r) => r.status === 'Pending'), 'share')), unpaid: r2(sum(approved, (r) => r.share * (1 - (r.amount ? r.paid / r.amount : 0)))), quality: r2(sum(approved.filter((r) => r.quality), 'share')), shared: r2(sum(approved.filter((r) => r.sharing?.startsWith('Shared')), 'share')) },
    tables: {
      register: T('Factory expense register', EC, rows),
      category: T('Category-wise (approved)', [c('category', 'Category'), N('share', 'Amount', 2), N('paid', 'Paid', 2), c('sources', 'Records')], group(approved, ['category'], S).sort((a, b) => b.share - a.share)),
      daily: T('Daily factory expenses (approved)', [c('date', 'Date'), N('share', 'Amount', 2), N('paid', 'Paid', 2), c('sources', 'Records')], group(approved, ['date'], S)),
      monthly: T('Monthly by category (approved)', [c('month', 'Month'), c('category', 'Category'), N('share', 'Amount', 2)], group(approved, ['month', 'category'], S).map(({ _sources, ...x }) => x)),
      department: T('Department-wise (approved)', [c('department', 'Department'), N('share', 'Amount', 2)], group(approved, ['department'], S).map(({ _sources, ...x }) => x)),
      pending: T('Awaiting approval', EC, rows.filter((r) => r.status === 'Pending')),
      shared: T('Shared expenses – allocation between units', [c('date', 'Date'), c('enteredIn', 'Entered in'), c('category', 'Category'), c('payee', 'Payee'), N('amount', 'Bill amount', 2), N('shareU1', 'Unit-1', 2), N('shareU2', 'Unit-2', 2), c('ref', 'Ref', { link: true })], approved.filter((r) => r.sharing?.startsWith('Shared'))),
    },
  };
}

/* ================================ Profit & Loss ================================ */
const DIRECT_EXCLUDE = ['overhead', 'commercial'];
const LABOUR_DEPT_LABEL = (k) => `Labour – ${k}`;

/** Job-wise / Sub Job-wise profit & loss rows. */
async function jobPnl(q) {
  const names = await unitNames();
  const { jobs, ids } = await jobScope(q);
  const list = [...jobs.values()].filter((j) => j.status !== 'Cancelled' && (!ids || ids.has(String(j._id))) && (q.include === 'all' || !q.status || j.status === q.status));
  const graphs = await loadJobGraphs(list);
  const flows = await flowsForJobs(list);
  const bills = await models.supplierBill.find({ isDeleted: false, job: { $in: list.map((j) => j._id) } }).lean();
  return graphs.map((g) => {
    const j = g.job; const p = computeProfit(g); const f = flows.get(String(j._id));
    const head = (k) => p.heads.find((h) => h.key === k) || { actual: 0, estimated: 0 };
    const materials = head('fabric').actual + head('trims').actual;
    const direct = sum(p.heads.filter((h) => !DIRECT_EXCLUDE.includes(h.key)), 'actual');
    const overheads = head('overhead').actual + head('commercial').actual;
    const issued = g.invoices.filter((i) => i.status !== 'Draft');
    const creditNotes = sum(issued, 'discount');
    const ins = g.inspections; const insDisp = ins.map(lotDisposition);
    const lot = sum(insDisp, (d) => d.lot - d.awaiting);
    const rejected = f.onFlow ? f.rejected : sum(g.cutting, 'rejectQty') + sum(g.sewing, 'rejection') + sum(g.finishing, 'rejection');
    const accepted = f.onFlow ? f.fg.qualityApproved || f.fg.fgInward : (sum(g.packing, 'totalQty') || p.shippedQty);
    const qualityCost = head('quality').actual;
    const payables = sum(bills.filter((b) => String(b.job) === String(j._id) || g.ids.map(String).includes(String(b.job))), 'outstanding');
    return {
      ...jobCols(j, names), level: j.parentJob ? 'Sub job' : g.subJobs.length ? 'Main job (consolidated)' : 'Job', status: j.status, currency: j.currency, orderQty: num(j.orderQty),
      orderValue: r2(p.orderValue), invoiced: r2(sum(issued, 'totalAmount')), recognised: r2(p.revenue), creditNotes: r2(creditNotes), received: r2(p.received), receivables: r2(p.outstanding), payables: r2(payables),
      materials: r2(materials), labour: r2(head('labour').actual), quality: r2(qualityCost), subcontract: r2(sum(p.heads.filter((h) => ['cadPattern', 'cutting', 'sewing', 'finishing', 'washing', 'printing', 'packing', 'other'].includes(h.key)), 'actual')), freight: r2(head('freight').actual),
      directCost: r2(direct), grossProfit: r2(p.revenue - direct), factoryOverhead: r2(head('overhead').actual), commercial: r2(head('commercial').actual), overheads: r2(overheads),
      operatingProfit: r2(p.actualProfit), marginPct: p.revenue ? pct(p.actualProfit, p.revenue, 2) : null,
      totalCost: r2(p.totalExpenses), estimatedCost: r2(p.expectedCost), costVariance: r2(p.totalExpenses - (p.producedQty ? (p.expectedCost / Math.max(num(j.orderQty), 1)) * p.producedQty : 0)),
      acceptedQty: accepted, costPerAccepted: accepted ? round(p.totalExpenses / accepted, 4) : null, qualityCostPerPc: accepted ? round(qualityCost / accepted, 4) : null,
      rejectionPct: f.onFlow && f.cut ? pct(rejected, f.cut, 2) : lot ? pct(sum(insDisp, 'reject'), lot, 2) : null, reworkPct: lot ? pct(sum(insDisp, 'rework'), lot, 2) : null,
      labourBasis: p.costBasis?.labour, allocatedLabour: p.allocation?.labour, allocatedOverhead: p.allocation?.overhead, estimatedPart: p.allocation?.estimated,
      _link: link('orders', j._id), _main: !!(g.subJobs.length), _sub: !!j.parentJob,
    };
  });
}

const BUCKET = { day: (d) => d, week: (d) => { const x = new Date(`${d}T00:00:00Z`); const wd = (x.getUTCDay() + 6) % 7; return isoDay(new Date(x.getTime() - wd * DAY)); }, month: (d) => d.slice(0, 7) };

/** Period (daily / weekly / monthly) profit & loss of the units in scope + cash flow, kept separate. */
async function periodPnl(q) {
  const p = period(q, 31);
  const bucket = BUCKET[q.bucket] || BUCKET.month;
  const units = scopeUnits();
  const names = await unitNames();
  const all = await models.orders.find({ isDeleted: false }).lean();
  const hasSubs = new Set(all.filter((j) => j.parentJob).map((j) => String(j.parentJob)));
  const leaves = all.filter((j) => !hasSubs.has(String(j._id)));
  const graphs = await loadJobGraphs(leaves);
  const costPerPc = new Map(graphs.map((g) => { const pr = computeProfit(g); return [String(g.job._id), { cogs: pr.cogsPerPc || pr.estimatedCogsPerPc, basis: pr.cogsPerPc ? 'actual' : 'estimate' }]; }));
  const jobUnit = new Map(all.map((j) => [String(j._id), j.businessUnit]));
  const L = []; // ledger lines: { date, unit, line, amount, ref, link }
  const add = (date, unit, line, amount, ref, lk) => { if (amount && inP(date, p)) L.push({ date: isoDay(date), unit, line, amount: r2(amount), ref, _link: lk }); };
  const [invoices, shipments, expenses, alloc, payments, bills, payrolls, fexp] = await Promise.all([
    models.invoice.find({ isDeleted: false, status: { $nin: ['Draft', 'Cancelled'] } }).lean(),
    models.shipment.find({ isDeleted: false }).select('status').lean(),
    models.expense.find({ isDeleted: false, status: { $ne: 'Rejected' } }).lean(),
    allocations(units),
    models.payment.find({ isDeleted: false }).lean(),
    models.supplierBill.find({ isDeleted: false }).lean(),
    models.payroll.find({ isDeleted: false, status: 'Paid' }).lean(),
    models.factoryExpense.find({ isDeleted: false, status: 'Approved', businessUnit: { $in: DEFAULT_UNITS.map((u) => u.code) } }).lean(),
  ]);
  const shippedIds = new Set(shipments.filter((s) => ['Shipped', 'Delivered'].includes(s.status)).map((s) => String(s._id)));
  invoices.forEach((inv) => {
    // revenue is recognised when the goods are shipped (invoices raised against a shipment that has not sailed are deferred)
    if (inv.shipment && !shippedIds.has(String(inv.shipment))) return;
    const u = inv.businessUnit; const lk = link('invoice', inv._id);
    add(inv.invoiceDate, u, 'Gross sales', num(inv.grossAmount) + num(inv.otherCharges), inv.invoiceNo, lk);
    add(inv.invoiceDate, u, 'Sales returns / credit notes / discounts', -num(inv.discount), inv.invoiceNo, lk);
    const cp = costPerPc.get(String(inv.job));
    add(inv.invoiceDate, u, 'Cost of goods sold', -num(inv.qty) * num(cp?.cogs), `${inv.invoiceNo} · ${inv.qty} pcs × ${round(num(cp?.cogs), 4)} (${cp?.basis || 'no cost'})`, lk);
  });
  alloc.dated.filter((d) => units.includes(d.unit)).forEach((d) => add(d.date, d.unit, d.kind === 'Depreciation' ? 'Factory depreciation' : `${d.kind} (no output to absorb it)`, -d.amount, d.section, null));
  expenses.forEach((e) => {
    const head = headOfExpense(e.category); const fin = financeLineOf(e.category); const lk = link('expense', e._id);
    if (fin) add(e.expenseDate, e.businessUnit, fin.label, -num(e.amount), e.refNo, lk);
    else if (!(head?.cogs && e.job)) add(e.expenseDate, e.businessUnit, head && !head.cogs ? `Selling & admin – ${head.label}` : 'Other operating expenses', -num(e.amount), e.refNo, lk);
  });
  const lines = L.filter((x) => units.includes(x.unit));
  const ORDER = ['Gross sales', 'Sales returns / credit notes / discounts', 'Cost of goods sold'];
  const keyOf = (x) => bucket(x.date);
  const buckets = [...new Set(lines.map(keyOf))].sort();
  const statement = (rows) => {
    const s = (fn) => r2(sum(rows.filter(fn), 'amount'));
    const revenue = s((x) => ORDER.slice(0, 2).includes(x.line));
    const cogs = -s((x) => x.line === 'Cost of goods sold');
    const factory = -s((x) => x.line.startsWith('Unabsorbed') || x.line === 'Factory depreciation');
    const opex = -s((x) => x.line.startsWith('Selling') || x.line === 'Other operating expenses');
    const finance = -s((x) => ['Interest', 'Taxes', 'Depreciation', 'Amortization'].includes(x.line));
    return { revenue, cogs, grossProfit: r2(revenue - cogs), factoryOverheads: factory, sellingAdmin: opex, operatingProfit: r2(revenue - cogs - factory - opex), financeCosts: finance, netProfit: r2(revenue - cogs - factory - opex - finance), marginPct: revenue ? pct(revenue - cogs - factory - opex, revenue, 2) : null };
  };
  const byBucket = buckets.map((b) => ({ period: b, ...statement(lines.filter((x) => keyOf(x) === b)) }));
  const byUnit = units.map((u) => ({ unit: names[u] || u, ...statement(lines.filter((x) => x.unit === u)) }));
  if (units.length > 1) byUnit.push({ unit: 'Combined', ...statement(lines) });
  // cash flow – receipts and payments actually made in the period (separate from accounting profit)
  const C = [];
  const cash = (date, unit, line, amount, ref, lk) => { if (amount && inP(date, p) && units.includes(unit)) C.push({ date: isoDay(date), unit, line, amount: r2(amount), ref, _link: lk }); };
  payments.forEach((x) => { cash(x.paymentDate, x.businessUnit, 'Receipts from buyers', num(x.amount), x.reference || x.refNo, link('payment', x._id)); cash(x.paymentDate, x.businessUnit, 'Bank charges', -num(x.bankCharges), x.refNo, link('payment', x._id)); });
  bills.forEach((b) => (b.payments || []).forEach((pm) => cash(pm.date, b.businessUnit, 'Payments to suppliers', -num(pm.amount), `${b.billNo} ${pm.reference || ''}`, link('supplierBill', b._id))));
  payrolls.forEach((x) => cash(x.paymentDate, x.businessUnit, 'Salaries & wages paid', -num(x.totalCost), x.refNo, link('payroll', x._id)));
  fexp.forEach((e) => { if (num(e.paidAmount) > 0) units.forEach((u) => { const share = expenseShare(e, u); if (share) cash(e.paymentDate || e.expenseDate, u, 'Factory expenses paid', -round((share * num(e.paidAmount)) / num(e.amount), 2), e.refNo, link('factoryExpense', e._id)); }); });
  expenses.forEach((e) => cash(e.expenseDate, e.businessUnit, 'Job & company expenses (booked)', -num(e.amount), e.refNo, link('expense', e._id)));
  const cashBuckets = [...new Set(C.map(keyOf))].sort().map((b) => {
    const rows = C.filter((x) => keyOf(x) === b);
    const s = (l) => r2(sum(rows.filter((x) => x.line === l), 'amount'));
    return { period: b, receipts: s('Receipts from buyers'), suppliers: s('Payments to suppliers'), wages: s('Salaries & wages paid'), factory: s('Factory expenses paid'), expenses: s('Job & company expenses (booked)'), bank: s('Bank charges'), net: r2(sum(rows, 'amount')) };
  });
  const totals = statement(lines);
  return { period: p.label, totals, byBucket, byUnit, lines: lines.map((x) => ({ ...x, unit: names[x.unit] || x.unit })), cash: cashBuckets, cashLines: C.map((x) => ({ ...x, unit: names[x.unit] || x.unit })), netCash: r2(sum(C, 'amount')) };
}

export async function pnlReport(q) {
  const [jobs, per] = await Promise.all([jobPnl(q), periodPnl(q)]);
  const leaf = jobs.filter((r) => !r._main);
  const S = (k) => r2(sum(leaf, k));
  const PL = [N('orderValue', 'Order value', 2), N('invoiced', 'Invoiced', 2), N('recognised', 'Recognised revenue', 2), N('creditNotes', 'Credit notes / discounts', 2), N('materials', 'Fabric & trims', 2), N('labour', 'Labour', 2), N('quality', 'Quality & inspection', 2), N('subcontract', 'Process & subcontract', 2), N('freight', 'Shipment', 2), N('directCost', 'Direct cost', 2), N('grossProfit', 'Gross profit', 2), N('factoryOverhead', 'Factory overhead', 2), N('commercial', 'Commission / admin', 2), N('operatingProfit', 'Operating profit', 2), N('marginPct', 'Margin %', 2), N('acceptedQty', 'Accepted pcs'), N('costPerAccepted', 'Cost / accepted pc', 4), N('qualityCostPerPc', 'Quality cost / pc', 4), N('rejectionPct', 'Rejection %', 2), N('reworkPct', 'Rework %', 2), N('estimatedCost', 'Estimated cost', 2), N('costVariance', 'Cost variance (actual − est. for produced)', 2), N('received', 'Received', 2), N('receivables', 'Receivables', 2), N('payables', 'Payables', 2), c('labourBasis', 'Labour basis')];
  const ST = [N('revenue', 'Net revenue', 2), N('cogs', 'COGS', 2), N('grossProfit', 'Gross profit', 2), N('factoryOverheads', 'Unabsorbed factory cost & depreciation', 2), N('sellingAdmin', 'Selling & admin', 2), N('operatingProfit', 'Operating profit', 2), N('financeCosts', 'Interest, tax, D&A', 2), N('netProfit', 'Net profit', 2), N('marginPct', 'Operating margin %', 2)];
  return {
    period: per.period,
    summary: { ...per.totals, orderValue: S('orderValue'), invoiced: S('invoiced'), recognisedAllTime: S('recognised'), receivables: S('receivables'), payables: S('payables'), netCash: per.netCash, jobs: leaf.length },
    tables: {
      period: T(`Profit & loss by ${q.bucket || 'month'} (accounting – revenue recognised at shipment)`, [c('period', 'Period'), ...ST], per.byBucket),
      unit: T('Unit-wise and combined P&L', [c('unit', 'Unit'), ...ST], per.byUnit),
      job: T('Job & Sub Job P&L (life to date)', [...JOB_COLS, c('level', 'Level'), c('status', 'Status'), ...PL], jobs),
      lines: T('P&L source lines', [c('date', 'Date'), c('unit', 'Unit'), c('line', 'Line'), N('amount', 'Amount', 2), c('ref', 'Source')], per.lines),
      cash: T('Cash flow (receipts & payments – separate from profit)', [c('period', 'Period'), N('receipts', 'Receipts', 2), N('suppliers', 'Suppliers', 2), N('wages', 'Wages', 2), N('factory', 'Factory expenses', 2), N('expenses', 'Other expenses', 2), N('bank', 'Bank charges', 2), N('net', 'Net cash flow', 2)], per.cash),
      cashLines: T('Cash flow source lines', [c('date', 'Date'), c('unit', 'Unit'), c('line', 'Line'), N('amount', 'Amount', 2), c('ref', 'Source')], per.cashLines),
    },
  };
}

/* ================================ Cost of quality ================================ */
export async function copqReport(q) {
  const names = await unitNames();
  const jobs = await leafJobs(q, { open: false });
  const graphs = await loadJobGraphs(jobs);
  const flows = await flowsForJobs(jobs);
  const rows = graphs.map((g) => {
    const j = g.job; const p = computeProfit(g); const f = flows.get(String(j._id));
    const al = p.allocation || {};
    const jobExp = (cats) => sum(g.expenses.filter((e) => cats.includes(e.category)), 'amount');
    const rw = g.reworks || [];
    const inspectionLabour = r2(num(al.quality) - num(g.alloc?.byJob.get(String(j._id))?.directQuality));
    const directQ = num(g.alloc?.byJob.get(String(j._id))?.directQuality);
    const testing = r2(jobExp(['Inspection', 'Testing']));
    const claims = r2(sum(g.invoices.filter((i) => i.status !== 'Draft'), 'discount'));
    const rejectedQty = f.onFlow ? f.rejected : sum(g.cutting, 'rejectQty') + sum(g.sewing, 'rejection') + sum(g.finishing, 'rejection');
    const scrapEst = r2(rejectedQty * num(p.cogsPerPc || p.estimatedCogsPerPc) * 0.75);
    const accepted = f.onFlow ? (f.fg.qualityApproved || f.fg.fgInward) : (sum(g.packing, 'totalQty') || p.shippedQty);
    const actualAdded = r2(inspectionLabour + directQ + testing + claims);
    const memo = r2(sum(rw, 'reworkLabourCost') + sum(rw, 'materialCost') + sum(rw, 'reinspectionCost'));
    return {
      ...jobCols(j, names), inspectionLabour, testing, outsourced: r2(directQ), claims, reworkLabour: r2(sum(rw, 'reworkLabourCost')), reworkMaterial: r2(sum(rw, 'materialCost')), reinspection: r2(sum(rw, 'reinspectionCost')),
      rejectedQty, scrapEstimated: scrapEst, actualQualityCost: actualAdded, includedMemo: memo, acceptedQty: accepted, perPc: accepted ? round(actualAdded / accepted, 4) : null,
      shareOfRevenuePct: p.revenue ? pct(actualAdded, p.revenue, 2) : null, _link: link('orders', j._id),
    };
  });
  // department & unit level: in-house rework by assigned department; factory quality expenses (incl. not job-linked)
  const units = scopeUnits();
  const rw = await models.qcRework.find({ isDeleted: false }).lean();
  const deptRows = group(rw.map((r) => ({ department: r.assignedDept || 'Not assigned', reworkLabour: num(r.reworkLabourCost), material: num(r.materialCost), reinspection: num(r.reinspectionCost), failed: num(r.failedQty), scrap: num(r.scrapQty) + num(r.reinspRejectedQty), _ref: r.refNo })), ['department'], ['failed', 'scrap', 'reworkLabour', 'material', 'reinspection']).map((x) => ({ ...x, total: r2(x.reworkLabour + x.material + x.reinspection) }));
  const fx = await models.factoryExpense.find({ isDeleted: false, status: 'Approved', category: { $in: QUALITY_EXPENSE_CATEGORIES }, businessUnit: { $in: DEFAULT_UNITS.map((u) => u.code) } }).lean();
  const unitRows = units.map((u) => {
    const mine = rows.filter((r) => r.unit === (names[u] || u));
    // job-linked quality expenses are already in the job rows (outsourced); the rest is counted here at the unit's share
    const exp = r2(sum(fx, (e) => (e.job ? 0 : expenseShare(e, u))));
    return { unit: names[u] || u, inspectionLabour: r2(sum(mine, 'inspectionLabour')), testing: r2(sum(mine, 'testing')), outsourcedJob: r2(sum(mine, 'outsourced')), factoryQualityExpenses: exp, claims: r2(sum(mine, 'claims')), total: r2(sum(mine, 'actualQualityCost') + exp), memo: r2(sum(mine, 'includedMemo')), scrapEstimated: r2(sum(mine, 'scrapEstimated')) };
  });
  if (units.length > 1) unitRows.push({ unit: 'Combined', ...Object.fromEntries(['inspectionLabour', 'testing', 'outsourcedJob', 'factoryQualityExpenses', 'claims', 'total', 'memo', 'scrapEstimated'].map((k) => [k, r2(sum(unitRows, k))])) });
  const tot = unitRows.at(-1) || {};
  return {
    summary: { actual: tot.total || 0, memo: tot.memo || 0, estimatedScrap: tot.scrapEstimated || 0, claims: tot.claims || 0, perPc: sum(rows, 'acceptedQty') ? round(sum(rows, 'actualQualityCost') / sum(rows, 'acceptedQty'), 4) : null },
    notes: [
      'Actual quality cost = inspection labour (payroll / attendance of checking, QC and inspection sections allocated to the job) + testing and inspection expenses + outsourced rework / inspection + buyer claims and deductions. These are the amounts inside the job P&L – each counted once.',
      'In-house rework labour, extra material and reinspection recorded on quality issues are already part of labour (payroll) and material (issued) costs – shown for analysis only, never added again.',
      'Scrap / rejected-garment cost is an ESTIMATE (rejected pieces × 75 % of cost of goods per piece) – their material and labour are already in the job cost.',
    ],
    tables: {
      job: T('Cost of quality by job / sub job', [...JOB_COLS, N('inspectionLabour', 'Inspection labour', 2), N('testing', 'Testing & inspection', 2), N('outsourced', 'Outsourced rework / inspection', 2), N('claims', 'Buyer claims & deductions', 2), N('actualQualityCost', 'Actual quality cost', 2), N('perPc', 'per accepted pc', 4), N('shareOfRevenuePct', '% of revenue', 2), N('reworkLabour', 'Rework labour (incl.)', 2), N('reworkMaterial', 'Rework material (incl.)', 2), N('reinspection', 'Reinspection (incl.)', 2), N('rejectedQty', 'Rejected pcs'), N('scrapEstimated', 'Scrap (estimated)', 2)], rows),
      department: T('Rework cost by department (in-house, included in labour / material)', [c('department', 'Department'), N('failed', 'Failed pcs'), N('scrap', 'Scrapped / rejected'), N('reworkLabour', 'Labour', 2), N('material', 'Material', 2), N('reinspection', 'Reinspection', 2), N('total', 'Total', 2), c('sources', 'Issues')], deptRows),
      unit: T('Unit-wise cost of quality', [c('unit', 'Unit'), N('inspectionLabour', 'Inspection labour', 2), N('testing', 'Testing', 2), N('outsourcedJob', 'Outsourced (jobs)', 2), N('factoryQualityExpenses', 'Factory quality expenses (not job-linked)', 2), N('claims', 'Claims', 2), N('total', 'Actual total', 2), N('memo', 'In-house rework (incl.)', 2), N('scrapEstimated', 'Scrap (est.)', 2)], unitRows),
    },
  };
}

/* ================================ Dashboard ================================ */
export async function dashboard(q) {
  const units = scopeUnits();
  const names = await unitNames();
  const [prod, qual, hr, exp, fg, pnl] = await Promise.all([productionReport(q), qualityReport(q), hrReport(q), expenseReport(q), finishedGoodsReport({ ...q, include: undefined }), pnlReport(q)]);
  const compare = units.length > 1 ? units.map((u) => {
    const n = names[u] || u;
    const dept = (d) => sum(prod.tables.department.rows.filter((r) => r.unit === n && r.department === d), 'completed');
    const qu = qual.tables.unit.rows.find((r) => r.unit === n) || {};
    const pl = pnl.tables.unit.rows.find((r) => r.unit === n) || {};
    return { unit: n, cut: dept('Cutting'), sewn: dept('Sewing and Stitching'), fgInward: dept('Finished Goods Inward'), fpyPct: qu.fpyPct ?? null, rejectionPct: qu.rejectionPct ?? null, held: qu.stillHeld || 0, labour: r2(sum(hr.tables.cost.rows.filter((r) => r.unit === n), 'total')), expenses: r2(sum(exp.tables.register.rows.filter((r) => r.status === 'Approved'), (r) => (r.sharing?.startsWith('Shared') ? num(u === 'U1' ? r.shareU1 : r.shareU2) : r.enteredIn === n ? r.amount : 0))), revenue: pl.revenue || 0, operatingProfit: pl.operatingProfit || 0, fgAvailable: sum(fg.tables.pending.rows.filter((r) => r.unit === n), 'available') };
  }) : [];
  // holds and open quality issues are a current state – not limited to the selected period
  const today = new Date(new Date().toISOString().slice(0, 10));
  const openRw = await models.qcRework.find({ isDeleted: false, status: { $ne: 'Closed' } }).select('pendingQty capaDueDate capaStatus').lean();
  const current = { held: fg.summary.held, openIssues: openRw.length, overdueCapa: openRw.filter((r) => r.capaDueDate && new Date(r.capaDueDate) < today && !['Implemented', 'Verified'].includes(r.capaStatus)).length };
  return {
    production: { ...prod.summary, daily: prod.tables.daily.rows, department: prod.tables.department.rows, target: prod.tables.target.rows.filter((r) => r.department === 'Sewing and Stitching') },
    quality: { ...qual.summary, ...current, pareto: qual.tables.pareto.rows.slice(0, 8), daily: qual.tables.daily.rows, stage: qual.tables.stage.rows },
    hr: { ...hr.summary, section: hr.tables.section.rows },
    expenses: { ...exp.summary, category: exp.tables.category.rows.map(({ category, share }) => ({ category, amount: share })) },
    fg: fg.summary,
    pnl: { ...pnl.summary, period: pnl.tables.period.rows, unit: pnl.tables.unit.rows },
    compare,
  };
}

/* ================================ Integrity checks ================================ */
export async function integrity() {
  const names = await unitNames();
  const units = scopeUnits();
  const checks = [];
  const check = (area, title, rule, items) => checks.push({ area, title, rule, status: items.length ? 'FAIL' : 'PASS', count: items.length, items: items.slice(0, 50) });
  const all = await models.orders.find({ isDeleted: false }).lean();
  const leaves = all.filter((j) => !all.some((s) => String(s.parentJob) === String(j._id)));

  // 1. hourly ↔ daily
  const sheets = await models.hourlyProduction.find({ isDeleted: false }).lean();
  check('Production', 'Hourly sheet totals = sum of hourly rows', 'Each sheet’s daily totals are recalculated from its rows', sheets.filter((s) => { const t = sheetTotals(s.slots, s.openingQty); return ['inputQty', 'completedQty', 'rejectedQty', 'reworkQty'].some((k) => num(s[k]) !== num(t[k])); }).map((s) => ({ ref: s.refNo, jobNo: s.jobNo, _link: link('hourlyProduction', s._id) })));
  const posted = [...(await models.sewing.find({ autoPosted: true, isDeleted: false }).lean()).map((x) => ['sewing', x]), ...(await models.finishing.find({ autoPosted: true, isDeleted: false }).lean()).map((x) => ['finishing', x])];
  const live = sheets.filter((s) => s.status !== 'Rejected');
  check('Production', 'Daily department entries = consolidated hourly sheets', 'Auto-consolidated Sewing / Finishing entries equal the sum of their live hourly sheets', posted.filter(([k, x]) => {
    const src = live.filter((s) => `${s.job}|${s.department}|${isoDay(s.entryDate)}|${s.line || ''}` === x.consolidationKey);
    return k === 'sewing' ? num(x.actualQty) !== sum(src, 'completedQty') : num(x.passedQty) !== sum(src, 'completedQty');
  }).map(([k, x]) => ({ ref: x.refNo, jobNo: x.jobNo, _link: link(k, x._id) })));
  const dupSheets = group(live.map((s) => ({ k: `${s.job}|${s.department}|${isoDay(s.entryDate)}|${s.shift}|${s.line || ''}`, n: 1, _ref: s.refNo })), ['k'], ['n']).filter((g) => g.n > 1);
  check('Production', 'No duplicate hourly sheets', 'One sheet per job, department, date, shift and line', dupSheets.map((g) => ({ ref: g.sources })));

  // 2. flow reconciliation per job
  const flows = await flowsForJobs(leaves);
  const flowIssues = [];
  leaves.forEach((j) => { const f = flows.get(String(j._id)); f.issues.forEach((m) => flowIssues.push({ jobNo: j.jobNo, unit: names[j.businessUnit], message: m, _link: link('orders', j._id) })); });
  check('Production', 'Department input / output / rejection / WIP reconcile', 'No department takes in more than it was given or puts out more than it took in; quality-gate lots ≤ submitting department’s output', flowIssues);

  // 3. inspections
  const ins = await models.inspection.find({ isDeleted: false }).lean();
  check('Quality', 'Inspection quantities reconcile with the lot submitted', 'Passed + rework + rejected + held = lot', ins.filter((i) => num(i.unaccountedQty) !== 0 && i.unaccountedQty !== null && i.unaccountedQty !== undefined).map((i) => ({ ref: i.refNo, jobNo: i.jobNo, message: `${i.unaccountedQty} pcs not dispositioned`, _link: link('inspection', i._id) })));
  const rws = await models.qcRework.find({ isDeleted: false }).lean();
  check('Quality', 'Reworked pieces are reinspected before counting as passed', 'Reinspection passed + rejected ≤ reinspected ≤ reworked; closed issues have nothing pending', rws.filter((r) => num(r.reinspPassedQty) + num(r.reinspRejectedQty) > num(r.reinspectedQty) || num(r.reinspectedQty) > num(r.reworkedQty) || (r.status === 'Closed' && num(r.pendingQty) > 0)).map((r) => ({ ref: r.refNo, jobNo: r.jobNo, _link: link('qcRework', r._id) })));
  const insById = new Map(ins.map((i) => [String(i._id), i]));
  const overIssued = group(rws.map((r) => ({ k: String(r.inspection), q: num(r.failedQty), _ref: r.refNo })), ['k'], ['q']).filter((g) => { const i = insById.get(g.k); if (!i) return true; const d = lotDisposition(i); return g.q > d.rework + d.held; });
  check('Quality', 'Quality issues never exceed the failed / held quantity', 'Σ issue quantity ≤ rework + held of the inspection', overIssued.map((g) => ({ ref: g.sources, message: insById.get(g.k)?.refNo || 'inspection missing' })));
  check('Quality', 'Concession releases are authorised', 'Every released quantity has a reason and the releasing user', rws.filter((r) => num(r.releasedQty) > 0 && (!r.releaseReason || !r.releasedBy)).map((r) => ({ ref: r.refNo, jobNo: r.jobNo, _link: link('qcRework', r._id) })));
  check('Quality', 'Quality-held goods are not shipped', 'Shipped ≤ quality-released finished goods (jobs on department flow)', leaves.filter((j) => { const f = flows.get(String(j._id)); return f.onFlow && f.fg.shipped > f.fg.qualityApproved; }).map((j) => { const f = flows.get(String(j._id)); return { jobNo: j.jobNo, message: `shipped ${f.fg.shipped} > released ${f.fg.qualityApproved}`, _link: link('orders', j._id) }; }));

  // 4. main / sub jobs
  const mains = all.filter((j) => j.isForecast && num(j.subJobCount) > 0);
  check('Jobs', 'Main job quantity = sum of its sub jobs', 'Forecast / continuous main job order quantity equals its sub jobs', mains.filter((m) => num(m.orderQty) !== sum(all.filter((s) => String(s.parentJob) === String(m._id)), 'orderQty')).map((m) => ({ jobNo: m.jobNo, _link: link('orders', m._id) })));
  const mainProd = await models.hourlyProduction.find({ isDeleted: false, job: { $in: mains.map((m) => m._id) } }).select('refNo jobNo').lean();
  check('Jobs', 'No production booked on main jobs that have sub jobs', 'Production is recorded on the sub job, so the main job total is not double counted', mainProd.map((s) => ({ ref: s.refNo, jobNo: s.jobNo })));

  // 5. costs
  const att = await models.attendance.find({ isDeleted: false, status: { $ne: 'Rejected' } }).lean();
  const dayEmp = group(att.flatMap((s) => s.rows.map((r) => ({ k: `${s.businessUnit}|${isoDay(s.attendanceDate)}|${r.empCode}`, n: 1, _ref: s.refNo }))), ['k'], ['n']).filter((g) => g.n > 1);
  check('Costs', 'Each employee once per day on attendance', 'No duplicate wage posting through attendance', dayEmp.map((g) => ({ ref: g.sources, message: g.k })));
  const pr = await models.payroll.find({ isDeleted: false, status: { $ne: 'Cancelled' } }).lean();
  const prEmp = group(pr.flatMap((p) => p.lines.map((l) => ({ k: `${p.businessUnit}|${p.period}|${l.empCode}`, n: 1, _ref: p.refNo }))), ['k'], ['n']).filter((g) => g.n > 1);
  check('Costs', 'Each employee once per payroll month', 'No duplicate salary posting', prEmp.map((g) => ({ ref: g.sources, message: g.k })));
  const payMonths = new Set(pr.filter((p) => ['Approved', 'Paid'].includes(p.status)).map((p) => `${p.businessUnit}|${p.period}`));
  const lab = await models.expense.find({ isDeleted: false, status: { $ne: 'Rejected' }, category: 'Labour' }).lean();
  check('Costs', 'Wages are not also booked as job Labour expenses', 'No Labour expense in a month whose payroll is posted', lab.filter((e) => payMonths.has(`${e.businessUnit}|${monthOf(e.expenseDate)}`)).map((e) => ({ ref: e.refNo, jobNo: e.jobNo, _link: link('expense', e._id) })));
  const alloc = await allocations(units);
  const allocIssues = [];
  alloc.months.filter((m) => units.includes(m.unit)).forEach((m) => {
    const labour = m.labourActual + m.labourEstimated;
    const placed = m.labourDirect + m.labourAllocated + m.labourToOverhead + m.labourUnabsorbed;
    if (Math.abs(labour - placed) > 0.05) allocIssues.push({ message: `${names[m.unit]} ${m.month}: labour ${r2(labour)} vs allocated ${r2(placed)}` });
    const pool = m.expenses - m.expensesDirect - m.depreciation + m.labourToOverhead;
    if (Math.abs(pool - m.overheadPool) > 0.05 || Math.abs(m.overheadPool - m.overheadAllocated - m.overheadUnabsorbed) > 0.05) allocIssues.push({ message: `${names[m.unit]} ${m.month}: overhead pool ${r2(m.overheadPool)} vs allocated ${r2(m.overheadAllocated + m.overheadUnabsorbed)}` });
  });
  const jobAllocTotal = sum([...alloc.byJob.entries()].filter(([id]) => all.some((j) => String(j._id) === id && units.includes(j.businessUnit))).map(([, v]) => v), (v) => v.labourActual + v.labourEstimated + v.qualityLabourActual + v.qualityLabourEstimated);
  const monthJobLabour = sum(alloc.months.filter((m) => units.includes(m.unit)), (m) => m.labourDirect + m.labourAllocated);
  if (Math.abs(jobAllocTotal - monthJobLabour) > 0.5) allocIssues.push({ message: `Labour on jobs ${r2(jobAllocTotal)} ≠ labour allocated to jobs ${r2(monthJobLabour)}` });
  check('Costs', 'Labour and overhead allocated exactly once', 'Direct + allocated + to overhead + unabsorbed = labour cost; overhead pool = allocated + unabsorbed', allocIssues);
  const fexp = await models.factoryExpense.find({ isDeleted: false, status: { $ne: 'Rejected' } }).lean();
  const dupExp = group(fexp.filter((e) => e.referenceNo).map((e) => ({ k: `${String(e.payee).toLowerCase()}|${String(e.referenceNo).toLowerCase()}`, n: 1, _ref: e.refNo })), ['k'], ['n']).filter((g) => g.n > 1);
  check('Costs', 'No duplicate factory expenses', 'One bill per payee and reference number', dupExp.map((g) => ({ ref: g.sources, message: g.k })));
  check('Costs', 'Shared expenses split exactly', 'Unit-1 share + Unit-2 share = bill amount', fexp.filter((e) => e.sharing?.startsWith('Shared') && Math.abs(expenseShare(e, 'U1') + expenseShare(e, 'U2') - num(e.amount)) > 0.01).map((e) => ({ ref: e.refNo, _link: link('factoryExpense', e._id) })));

  // 6. units vs combined (only meaningful in the consolidated scope)
  if (units.length > 1) {
    const per = await periodPnl({ bucket: 'month', from: '2000-01-01' });
    const comb = per.byUnit.find((u) => u.unit === 'Combined');
    const parts = per.byUnit.filter((u) => u.unit !== 'Combined');
    const diff = ['revenue', 'cogs', 'factoryOverheads', 'operatingProfit', 'netProfit'].filter((k) => Math.abs(sum(parts, k) - num(comb?.[k])) > 0.05);
    check('Reporting', 'Unit-wise figures add up to the combined report', 'Unit-1 + Unit-2 = combined for revenue, COGS, overheads and profit', diff.map((k) => ({ message: `${k}: units ${r2(sum(parts, k))} vs combined ${comb?.[k]}` })));
  }

  // 7. closed jobs still satisfy closure rules
  const closed = all.filter((j) => j.status === 'Closed' && !all.some((s) => String(s.parentJob) === String(j._id)));
  const cg = await loadJobGraphs(closed);
  const reopenIssues = [];
  for (const g of cg) {
    const lc = await computeStages({ ...g, job: { ...g.job, status: 'In Progress' } });
    const hard = lc.blockers.filter((b) => /quality issue|inspection\(s\) not completed|WIP|not handed over|Quantity reconciliation/.test(b));
    if (hard.length) reopenIssues.push({ jobNo: g.job.jobNo, message: hard.join('; '), _link: link('orders', g.job._id) });
  }
  check('Jobs', 'Closed jobs meet the production, quality and inventory closure rules', 'No open quality issue, pending inspection, WIP or unreconciled quantity on a closed job', reopenIssues);

  return { units: units.map((u) => names[u] || u), checkedAt: new Date().toISOString(), passed: checks.filter((x) => x.status === 'PASS').length, failed: checks.filter((x) => x.status === 'FAIL').length, checks };
}

export const REPORTS = { production: productionReport, wip: wipReport, quality: qualityReport, hr: hrReport, expenses: expenseReport, pnl: pnlReport, copq: copqReport, fg: finishedGoodsReport };
export { QC_STAGE_KEYS, PRODUCTION_DEPARTMENTS, COST_HEADS, loadRoutes };
