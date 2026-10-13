/**
 * Labour and factory overhead allocation – how payroll, attendance and factory expenses reach job costs.
 *
 * Labour (per unit, per month)
 *   • Cost of an attendance row is ACTUAL when the employee is on an approved / paid payroll of that month
 *     (payroll cost-to-company × row hours ÷ the employee's attendance hours that month), otherwise ESTIMATED
 *     (hours × master rate + overtime + employer contributions + incentive, as calculated on the sheet).
 *   • Payroll cost of an employee with no attendance hours that month goes to the employee's section pool.
 *   • A row with a Job No is a direct job cost. Other rows go to their section's pool, which is allocated to jobs
 *     by that section's completed output per job in the month (hourly sheets; production sections fall back to
 *     sewing output). Checking / QC / inspection sections are quality labour, allocated by the same output or by
 *     inspected lot quantity. Indirect sections (maintenance, stores, administration) join factory overhead.
 * Factory overhead
 *   • Approved factory expenses without a Job No (shared bills at this unit's share) + indirect labour, allocated
 *     to jobs by their share of the unit's sewing output in the month. Factory expenses with a Job No are direct.
 * Normal-capacity absorption: pools are absorbed in the proportion of the month's sewing output to the unit's normal
 *   capacity (Settings → costing: normal monthly output, prorated for the days the factory worked). A month below
 *   capacity charges jobs only for the capacity they used – the under-recovery is unabsorbed (a period cost), so a
 *   slow month never inflates the cost of the few garments made in it.
 * Factory depreciation is a period cost (below EBITDA), never absorbed into jobs.
 * Whatever has no output to absorb it in its month is UNABSORBED – a period cost in the P&L, never a job cost.
 * Every amount is allocated exactly once: Σ job allocations + unabsorbed = Σ costs (verified by the integrity checks).
 */
import { models } from '../modules/builder.js';
import { currentUnit, ALL_UNITS } from './unitContext.js';
import { getSetting } from './settings.js';
import { DEFAULT_UNITS } from '../../../shared/constants.js';
import { num, round, sum } from '../../../shared/calc.js';
import { QUALITY_SECTIONS, INDIRECT_SECTIONS, QUALITY_EXPENSE_CATEGORIES } from '../../../shared/modules/factory.js';

const UNIT_CODES = DEFAULT_UNITS.map((u) => u.code);
const SHARED = 'Shared – Unit-1 & Unit-2';
const monthOf = (d) => new Date(d).toISOString().slice(0, 7);
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
const PRESENT = ['Present', 'Half Day'];

/** This unit's part of a factory expense (shared bills are split; a bill belongs to one unit otherwise). */
export function expenseShare(e, unit) {
  if (e.sharing === SHARED) {
    const p1 = Math.min(Math.max(num(e.sharePctU1 ?? 50), 0), 100);
    const s1 = round((num(e.amount) * p1) / 100, 2);
    return unit === 'U1' ? s1 : unit === 'U2' ? round(num(e.amount) - s1, 2) : 0;
  }
  return e.businessUnit === unit ? num(e.amount) : 0;
}

/** Unit codes of the request's scope (one unit, or both). */
export function unitsInScope() {
  const u = currentUnit();
  return !u || u === ALL_UNITS ? UNIT_CODES : [u];
}

/* --------------------------- cache (invalidated by any write to a source collection) --------------------------- */
const SOURCES = new Set(['attendance', 'payroll', 'factoryExpense', 'hourlyProduction', 'sewing', 'cutting', 'finishing', 'packing', 'inspection', 'employee', 'orders']);
let version = 0;
const cache = new Map();
export function noteChange(moduleKey) { if (SOURCES.has(moduleKey)) { version += 1; cache.clear(); } }

/** Allocations for the given units (default: both). Result is shared, never mutate it. */
export async function allocations(units = UNIT_CODES) {
  const costing = await getSetting('costing');
  const key = `${[...units].sort().join(',')}|${JSON.stringify(costing)}`;
  const hit = cache.get(key);
  if (hit && hit.version === version) return hit.data;
  const parts = await Promise.all(units.map((u) => unitAllocation(u, costing)));
  const data = mergeUnits(parts);
  cache.set(key, { version, data });
  return data;
}

function mergeUnits(parts) {
  const byJob = new Map();
  parts.forEach((p) => p.byJob.forEach((v, k) => byJob.set(k, v)));
  return { byJob, months: parts.flatMap((p) => p.months), dated: parts.flatMap((p) => p.dated), rows: parts.flatMap((p) => p.rows) };
}

const emptyJob = () => ({ labourActual: 0, labourEstimated: 0, qualityLabourActual: 0, qualityLabourEstimated: 0, overheadActual: 0, overheadEstimated: 0, directQuality: 0, directOther: 0, byDept: {}, hours: 0 });

/** Split `amount` over `basis` (Map key → weight). Returns [] when nothing can absorb it. */
function split(amount, basis) {
  const tot = [...basis.values()].reduce((a, b) => a + b, 0);
  if (!(tot > 0) || !amount) return [];
  return [...basis.entries()].filter(([, w]) => w > 0).map(([k, w]) => [k, (amount * w) / tot]);
}

async function unitAllocation(unit, costing = {}) {
  const U = { businessUnit: unit, isDeleted: false };
  const [jobs, sheets, payrolls, employees, hourly, sewing, inspections, ownExp, sharedOther, cutting, finishing, packing] = await Promise.all([
    models.orders.find(U).select('jobNo').lean(),
    models.attendance.find({ ...U, status: { $ne: 'Rejected' } }).lean(),
    models.payroll.find({ ...U, status: { $in: ['Approved', 'Paid'] } }).lean(),
    models.employee.find({ businessUnit: unit }).select('empCode section').lean(),
    models.hourlyProduction.find({ ...U, status: { $ne: 'Rejected' } }).select('job department entryDate completedQty').lean(),
    models.sewing.find({ ...U, status: { $ne: 'Rejected' } }).select('job entryDate actualQty autoPosted').lean(),
    models.inspection.find(U).select('job inspectionDate lotSize').lean(),
    models.factoryExpense.find({ ...U, status: 'Approved' }).lean(),
    models.factoryExpense.find({ businessUnit: { $in: UNIT_CODES.filter((c) => c !== unit) }, isDeleted: false, status: 'Approved', sharing: SHARED, job: null }).lean(),
    models.cutting.find({ ...U, status: { $ne: 'Rejected' } }).select('job entryDate cutQty').lean(),
    models.finishing.find({ ...U, status: { $ne: 'Rejected' }, autoPosted: { $ne: true } }).select('job entryDate passedQty').lean(),
    models.packing.find(U).select('job packingDate totalQty').lean(),
  ]);
  const jobIdByNo = new Map(jobs.map((j) => [j.jobNo, String(j._id)]));
  const sectionOf = new Map(employees.map((e) => [e.empCode, e.section]));
  const byJob = new Map();
  const J = (id) => byJob.get(id) || byJob.set(id, emptyJob()).get(id);
  const rows = []; const dated = [];

  // output bases per month
  const basis = {}; // basis[month][kind] = Map(jobId → qty)
  const add = (m, kind, job, q) => { if (!job || !(num(q) > 0)) return; const b = ((basis[m] ||= {})[kind] ||= new Map()); b.set(String(job), (b.get(String(job)) || 0) + num(q)); };
  hourly.forEach((h) => add(monthOf(h.entryDate), `dept:${h.department}`, h.job, h.completedQty));
  // jobs recorded through the daily department entries (no hourly sheet for that department and month)
  const hasHourly = new Set(hourly.map((h) => `${monthOf(h.entryDate)}|${h.department}|${h.job}`));
  const daily = (rows, dateKey, qtyKey, depts) => rows.forEach((r) => depts.forEach((dep) => {
    if (!hasHourly.has(`${monthOf(r[dateKey])}|${dep}|${r.job}`)) add(monthOf(r[dateKey]), `dept:${dep}`, r.job, r[qtyKey]);
  }));
  daily(cutting, 'entryDate', 'cutQty', ['Cutting']);
  daily(sewing.filter((x) => !x.autoPosted), 'entryDate', 'actualQty', ['Sewing and Stitching']);
  daily(finishing, 'entryDate', 'passedQty', ['Ironing and Finishing']);
  daily(packing, 'packingDate', 'totalQty', ['Packing', 'Carton/Box Packing']);
  sewing.forEach((s) => add(monthOf(s.entryDate), 'sewing', s.job, s.actualQty));
  inspections.forEach((i) => add(monthOf(i.inspectionDate), 'inspected', i.job, i.lotSize));
  const basisFor = (m, section) => {
    const b = basis[m] || {};
    if (INDIRECT_SECTIONS.includes(section)) return null; // → overhead
    if (QUALITY_SECTIONS.includes(section)) return b[`dept:${section}`] || b.inspected || b.sewing;
    return b[`dept:${section}`] || b.sewing;
  };

  // payroll cost per employee and month
  const pay = new Map();
  payrolls.forEach((p) => (p.lines || []).forEach((l) => {
    const k = `${l.empCode}|${p.period}`;
    const x = pay.get(k) || { cost: 0, section: l.section, refNo: p.refNo };
    x.cost += num(l.totalCost) || num(l.basicWages) + num(l.otAmount) + num(l.incentive) + num(l.employerContribution);
    pay.set(k, x);
  }));
  const hoursOf = new Map();
  sheets.forEach((s) => s.rows.forEach((r) => { if (PRESENT.includes(r.status)) { const k = `${r.empCode}|${monthOf(s.attendanceDate)}`; hoursOf.set(k, (hoursOf.get(k) || 0) + num(r.hours) + num(r.otHours)); } }));

  // labour pools per month & section: entries keep their date for period reporting
  const pools = {}; // pools[month][section] = [{ date, actual, estimated }]
  const toPool = (m, section, e) => (((pools[m] ||= {})[section] ||= []).push(e));
  const isQuality = (s) => QUALITY_SECTIONS.includes(s);
  sheets.forEach((s) => s.rows.forEach((r) => {
    if (!PRESENT.includes(r.status)) return;
    const hrs = num(r.hours) + num(r.otHours);
    const m = monthOf(s.attendanceDate);
    const p = pay.get(`${r.empCode}|${m}`);
    const actual = p ? round((p.cost * hrs) / (hoursOf.get(`${r.empCode}|${m}`) || 1), 4) : 0;
    const estimated = p ? 0 : num(r.totalCost);
    if (!actual && !estimated) return;
    const job = r.jobNo ? jobIdByNo.get(r.jobNo) : null;
    rows.push({ unit, date: dayOf(s.attendanceDate), month: m, sheet: s.refNo, empCode: r.empCode, section: s.section, hours: hrs, actual, estimated, jobNo: r.jobNo || '', basis: p ? `payroll ${p.refNo}` : 'attendance estimate' });
    if (job) {
      const x = J(job);
      if (isQuality(s.section)) { x.qualityLabourActual += actual; x.qualityLabourEstimated += estimated; } else { x.labourActual += actual; x.labourEstimated += estimated; }
      x.byDept[s.section] = (x.byDept[s.section] || 0) + actual + estimated; x.hours += hrs;
    } else toPool(m, s.section, { date: dayOf(s.attendanceDate), actual, estimated });
  }));
  // payroll of employees with no attendance hours in the month (e.g. staff not on the muster) → their section
  pay.forEach((p, k) => {
    const [emp, m] = k.split('|');
    if (hoursOf.get(k)) return;
    const section = p.section || sectionOf.get(emp) || 'Administration';
    toPool(m, section, { date: `${m}-01`, actual: p.cost, estimated: 0 });
    rows.push({ unit, date: `${m}-01`, month: m, sheet: p.refNo, empCode: emp, section, hours: 0, actual: p.cost, estimated: 0, jobNo: '', basis: `payroll ${p.refNo} (no attendance)` });
  });

  // normal capacity of the month (prorated by the days the factory worked) and how much of it was used
  const stdDays = num(costing.standardWorkingDays) || 26;
  const normal = num(costing.normalMonthlyOutput?.[unit] ?? costing.normalMonthlyOutput) || 0;
  const workDays = {};
  sheets.forEach((s) => { const m = monthOf(s.attendanceDate); (workDays[m] ||= new Set()).add(dayOf(s.attendanceDate)); });
  const capacityOf = (m) => (normal ? round(normal * Math.min(1, (workDays[m]?.size || stdDays) / stdDays), 0) : 0);
  const outputOf = (m) => [...(basis[m]?.sewing?.values() || [])].reduce((a, b) => a + b, 0);
  const absorb = (m) => { const cap = capacityOf(m); return cap > 0 ? Math.min(1, outputOf(m) / cap) : 1; };
  const months = {};
  const M = (m) => (months[m] ||= { unit, month: m, capacity: capacityOf(m), output: outputOf(m), absorptionPct: round(absorb(m) * 100, 1), labourActual: 0, labourEstimated: 0, labourDirect: 0, labourAllocated: 0, labourToOverhead: 0, labourUnabsorbed: 0, expenses: 0, expensesDirect: 0, depreciation: 0, overheadPool: 0, overheadAllocated: 0, overheadUnabsorbed: 0 });
  rows.forEach((r) => { const x = M(r.month); x.labourActual += r.actual; x.labourEstimated += r.estimated; if (r.jobNo && jobIdByNo.has(r.jobNo)) x.labourDirect += r.actual + r.estimated; });

  const overheadPool = {}; // month → [{ date, actual, estimated }]
  Object.entries(pools).forEach(([m, secs]) => Object.entries(secs).forEach(([section, entries]) => {
    const a = sum(entries, 'actual'); const e = sum(entries, 'estimated');
    const b = basisFor(m, section);
    if (b === null) { (overheadPool[m] ||= []).push(...entries); M(m).labourToOverhead += a + e; return; }
    const parts = split(1, b || new Map());
    const f = parts.length ? absorb(m) : 0;
    if (f < 1) {
      M(m).labourUnabsorbed += (a + e) * (1 - f);
      entries.forEach((x) => dated.push({ unit, date: x.date, kind: 'Unabsorbed labour', section, amount: (x.actual + x.estimated) * (1 - f) }));
    }
    if (!f) return;
    parts.forEach(([job, share]) => {
      const x = J(job);
      if (isQuality(section)) { x.qualityLabourActual += a * f * share; x.qualityLabourEstimated += e * f * share; } else { x.labourActual += a * f * share; x.labourEstimated += e * f * share; }
      x.byDept[section] = (x.byDept[section] || 0) + (a + e) * f * share;
    });
    M(m).labourAllocated += (a + e) * f;
  }));

  // factory expenses: job-linked → direct; others → overhead pool at this unit's share
  const expRows = [...ownExp, ...sharedOther];
  expRows.forEach((e) => {
    const amt = expenseShare(e, unit);
    if (!amt) return;
    const m = monthOf(e.expenseDate);
    M(m).expenses += amt;
    if (e.job && e.businessUnit === unit) {
      const x = J(String(e.job));
      if (QUALITY_EXPENSE_CATEGORIES.includes(e.category)) x.directQuality += amt; else x.directOther += amt;
      M(m).expensesDirect += amt;
      return;
    }
    if (e.category === 'Depreciation') {
      M(m).depreciation += amt;
      dated.push({ unit, date: dayOf(e.expenseDate), kind: 'Depreciation', section: e.refNo, amount: amt });
      return;
    }
    (overheadPool[m] ||= []).push({ date: dayOf(e.expenseDate), actual: amt, estimated: 0, expense: e.refNo });
  });
  Object.entries(overheadPool).forEach(([m, entries]) => {
    const a = sum(entries, 'actual'); const e = sum(entries, 'estimated');
    M(m).overheadPool += a + e;
    const parts = split(1, basis[m]?.sewing || new Map());
    const f = parts.length ? absorb(m) : 0;
    if (f < 1) {
      M(m).overheadUnabsorbed += (a + e) * (1 - f);
      entries.forEach((x) => dated.push({ unit, date: x.date, kind: 'Unabsorbed overhead', section: x.expense || 'Indirect labour', amount: (x.actual + x.estimated) * (1 - f) }));
    }
    if (!f) return;
    parts.forEach(([job, share]) => { const x = J(job); x.overheadActual += a * f * share; x.overheadEstimated += e * f * share; });
    M(m).overheadAllocated += (a + e) * f;
  });

  byJob.forEach((x) => {
    ['labourActual', 'labourEstimated', 'qualityLabourActual', 'qualityLabourEstimated', 'overheadActual', 'overheadEstimated', 'directQuality', 'directOther', 'hours'].forEach((k) => { x[k] = round(x[k], 2); });
    Object.keys(x.byDept).forEach((k) => { x.byDept[k] = round(x.byDept[k], 2); });
  });
  const monthRows = Object.values(months).map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'number' ? round(v, 2) : v]))).sort((a, b) => a.month.localeCompare(b.month));
  return { byJob, months: monthRows, dated: dated.map((d) => ({ ...d, amount: round(d.amount, 2) })), rows };
}

/** Allocation of one job (zeros when nothing is allocated). */
export function jobAllocation(alloc, jobId) {
  return alloc?.byJob.get(String(jobId)) || emptyJob();
}
