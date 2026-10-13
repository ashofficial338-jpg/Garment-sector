/**
 * Factory operations sample data (used by sampleData.js): workforce, production routing and QC checkpoints,
 * hourly department production for jobs on department flow, quality inspections at every stage with
 * rework / reinspection, attendance, payroll, factory expenses – and negative tests that prove the guards hold.
 * Everything is created through the real API, so every hook, guard, consolidation and audit entry runs.
 */
import { aqlEvaluate } from '../../../shared/calc.js';
import { PRODUCTION_DEPARTMENTS } from '../../../shared/modules/factory.js';

export const SLOTS = ['08:00-09:00', '09:00-10:00', '10:00-11:00', '11:00-12:00', '12:00-13:00', '13:30-14:30', '14:30-15:30', '15:30-16:30', '16:30-17:30', '17:30-18:30'];
const spread = (total, n) => { const b = Math.floor(total / n); const r = total - b * n; return Array.from({ length: n }, (_, i) => b + (i < r ? 1 : 0)); };

/* ------------------------------ workforce ------------------------------ */
// [section, headcount, designation, wage type, monthly salary or daily wage (USD), employment type]
const STAFF = [
  ['Cutting', 3, 'Cutting master / cutter', 'Monthly salary', 175, 'Permanent'],
  ['Cutting Issue', 1, 'Bundle issuer', 'Monthly salary', 140, 'Permanent'],
  ['Preparation', 2, 'Preparation operator', 'Monthly salary', 150, 'Permanent'],
  ['Assembly', 2, 'Assembly operator', 'Monthly salary', 155, 'Permanent'],
  ['Sewing and Stitching', 8, 'Sewing operator', 'Monthly salary', 165, 'Permanent'],
  ['Checking', 2, 'In-line checker', 'Monthly salary', 150, 'Permanent'],
  ['Quality Control', 2, 'End-line QC checker', 'Monthly salary', 170, 'Permanent'],
  ['Thread Trimming and Alteration', 3, 'Trimmer / alteration tailor', 'Daily wage', 5.6, 'Contract'],
  ['Ironing and Finishing', 2, 'Ironing operator', 'Monthly salary', 150, 'Permanent'],
  ['Folding', 1, 'Folder', 'Daily wage', 5.2, 'Contract'],
  ['Packing', 2, 'Packer', 'Daily wage', 5.4, 'Contract'],
  ['Carton/Box Packing', 1, 'Carton packer', 'Daily wage', 5.4, 'Contract'],
  ['Finished Goods Inward', 1, 'FG store keeper', 'Monthly salary', 160, 'Permanent'],
  ['Quality Inspection', 2, 'QA inspector', 'Monthly salary', 215, 'Permanent'],
  ['Maintenance', 1, 'Machine mechanic', 'Monthly salary', 200, 'Permanent'],
  ['Stores', 1, 'Store assistant', 'Monthly salary', 155, 'Permanent'],
  ['Administration', 2, 'HR & admin executive', 'Monthly salary', 290, 'Permanent'],
];
const FIRST = { U1: ['Arun', 'Bala', 'Chitra', 'Deepa', 'Ezhil', 'Gowri', 'Hari', 'Indira', 'Jaya', 'Kumar', 'Latha', 'Mani', 'Nila', 'Oviya', 'Pandi', 'Rani', 'Selvam', 'Tamil', 'Uma', 'Vasu'], U2: ['Abdul', 'Bhavani', 'Charles', 'Dhanam', 'Elango', 'Fathima', 'Ganesh', 'Hema', 'Iqbal', 'Janaki', 'Kannan', 'Lalitha', 'Mohan', 'Nirmala', 'Pooja', 'Raja', 'Saroja', 'Thilak', 'Usha', 'Vimal'] };
const LAST = ['S.', 'K.', 'M.', 'R.', 'P.', 'V.', 'A.', 'N.'];

/** Factory workforce of a unit (codes SMP-U1-F001 …), added only when missing. Returns [{ empCode, name, section }]. */
export async function ensureWorkforce(api, unit, day, created) {
  const have = new Map((await api.get('/m/employee?q=SMP-&limit=500')).rows.map((e) => [e.empCode, e]));
  const out = []; let n = 0;
  for (const [section, count, designation, wageType, rate, employmentType] of STAFF) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      const empCode = `SMP-${unit}-F${String(n).padStart(3, '0')}`;
      const name = `${LAST[n % LAST.length]} ${FIRST[unit][n % FIRST[unit].length]}${n > 20 ? ` ${n}` : ''}`;
      if (!have.has(empCode)) {
        const e = await api.post('/m/employee', {
          empCode, name, department: section === 'Quality Inspection' || section === 'Checking' || section === 'Quality Control' ? 'Quality' : section.startsWith('Cutting') ? 'Cutting' : ['Ironing and Finishing', 'Folding', 'Thread Trimming and Alteration'].includes(section) ? 'Finishing' : ['Packing', 'Carton/Box Packing', 'Finished Goods Inward'].includes(section) ? 'Packing' : section === 'Administration' ? 'HR' : 'Production',
          designation, section, line: section === 'Sewing and Stitching' ? `Line ${(i % 2) + 1}` : '', employmentType, contractor: employmentType === 'Contract' ? 'Sri Murugan Labour Contracts' : '',
          wageType, monthlySalary: wageType === 'Monthly salary' ? rate : 0, dailyWage: wageType === 'Daily wage' ? rate : 0, standardDays: 26, standardHours: 8,
          otRatePerHour: Math.round((wageType === 'Daily wage' ? rate / 8 : rate / 26 / 8) * 2 * 100) / 100, employerContributionPct: employmentType === 'Permanent' ? 13 : 0,
          skillGrade: i ? 'B' : 'A', isOperator: ['Sewing and Stitching', 'Assembly', 'Preparation'].includes(section), joinDate: day(-1200 + n * 23), workingDays: 26, presentDays: 25,
        });
        created.push(e._id);
      }
      out.push({ empCode, name, section });
    }
  }
  return out;
}

/* ------------------------------ routing & checkpoints (shared configuration) ------------------------------ */
export async function configureQuality(api, ids) {
  const routes = (await api.get('/m/productionRoute?limit=200')).rows;
  if (!routes.some((r) => r.name === 'Kids knits – no separate preparation')) {
    await api.post('/m/productionRoute', {
      name: 'Kids knits – no separate preparation', buyer: ids.buyers['Kiwi Kids Ltd'], preShipmentRequired: true,
      steps: PRODUCTION_DEPARTMENTS.filter((d) => d !== 'Preparation').map((department) => ({ department, gateStage: department === 'Folding' ? 'Final Garment Inspection' : department === 'Ironing and Finishing' ? 'End-line Inspection' : '' })),
      remarks: 'Kids tees: panels go straight from bundle issue to assembly; end-line QC releases to ironing (Sample / Test data)',
    });
  }
  const plans = (await api.get('/m/qcCheckpoint?limit=200')).rows;
  const add = async (p) => { if (!plans.some((x) => x.name === p.name)) await api.post('/m/qcCheckpoint', p); };
  await add({ name: 'Final garment – knits standard', inspectionStage: 'Final Garment Inspection', standard: 'ISO 2859-1 AQL', inspectionMethod: 'AQL sampling', majorAql: '2.5', minorAql: '4.0', checkpoints: [
    { parameter: 'Body length', specification: 'As per spec sheet', tolerance: '± 1 cm', method: 'Measure flat' }, { parameter: 'Chest width', specification: 'As per spec sheet', tolerance: '± 1 cm', method: 'Measure 2.5 cm below armhole' },
    { parameter: 'Shade vs approved sample', specification: 'Within shade band', tolerance: 'Grey scale ≥ 4', method: 'Light box D65' }, { parameter: 'Seam & stitch quality', specification: 'SPI 12–14, no skips', tolerance: '0 open seams', method: 'Visual' },
    { parameter: 'Labels & trims', specification: 'Main, care and size label correct', tolerance: '100 %', method: 'Visual' }] });
  await add({ name: 'End-line – sewing audit', inspectionStage: 'End-line Inspection', standard: 'In-house standard', inspectionMethod: 'AQL sampling', majorAql: '2.5', minorAql: '4.0', checkpoints: [
    { parameter: 'Seam strength / open seams', specification: 'No open or broken seams', tolerance: '0', method: 'Pull test' }, { parameter: 'Neck & hem finish', specification: 'Even, no puckering', tolerance: '—', method: 'Visual' }] });
  await add({ name: 'Pre-shipment – Nordic Apparel', inspectionStage: 'Pre-shipment Inspection', buyer: ids.buyers['Nordic Apparel AB'], standard: 'Buyer standard', inspectionMethod: 'AQL sampling', majorAql: '2.5', minorAql: '4.0', checkpoints: [
    { parameter: 'Carton marks & barcode', specification: 'As per buyer manual', tolerance: '100 %', method: 'Scan' }, { parameter: 'Assortment per carton', specification: 'Size ratio as PO', tolerance: '0 errors', method: 'Open 10 % cartons' }, { parameter: 'Garment inspection', specification: 'AQL 2.5 / 4.0', tolerance: '—', method: 'Random sample' }] });
  await add({ name: 'Pre-shipment – general', inspectionStage: 'Pre-shipment Inspection', standard: 'ISO 2859-1 AQL', inspectionMethod: 'AQL sampling', majorAql: '2.5', minorAql: '4.0', checkpoints: [
    { parameter: 'Carton count vs packing list', specification: 'Equal', tolerance: '0', method: 'Count' }, { parameter: 'Garment inspection', specification: 'AQL 2.5 / 4.0', tolerance: '—', method: 'Random sample' }] });
}

/* ------------------------------ department flow ------------------------------ */
const CAP = { 'Cutting Issue': 3, Preparation: 2, Assembly: 1.6, 'Sewing and Stitching': 1, Checking: 1.4, 'Quality Control': 1.4, 'Thread Trimming and Alteration': 1.4, 'Ironing and Finishing': 1.4, Folding: 2, Packing: 2, 'Carton/Box Packing': 3, 'Finished Goods Inward': 6 };
const REJ = { Preparation: 0.001, 'Sewing and Stitching': 0.003, 'Quality Control': 0.004, 'Ironing and Finishing': 0.0015 };
const RW = { 'Sewing and Stitching': 0.015, Checking: 0.02, 'Quality Control': 0.025, 'Ironing and Finishing': 0.01, 'Thread Trimming and Alteration': 0.03 };
const DELAYS = ['Machine breakdown', 'Needle / bobbin change', 'Waiting for input / cut panels', 'Style changeover', 'Power failure'];

/** Defect lines that make an AQL lot pass (or fail) for its sample size. */
function defects(lot, pass, majorAql = '2.5', minorAql = '4.0', seed = 0) {
  const ac = aqlEvaluate({ lotSize: lot, majorAql, minorAql });
  const MAJ = ['Skip stitch', 'Open seam', 'Broken stitch', 'Measurement out of tolerance', 'Shade variation', 'Stain / spot'];
  const MIN = ['Loose thread', 'Uneven hem', 'Pressing / crease', 'Puckering', 'Wrong / missing label'];
  const major = pass ? Math.min(1, ac.majorAccept) : ac.majorAccept + 2 + (seed % 3);
  const minor = pass ? Math.min(2 + (seed % 2), ac.minorAccept) : ac.minorAccept;
  const lines = [];
  if (major) lines.push({ defectType: MAJ[seed % MAJ.length], severity: 'Major', location: 'Side seam', responsibleDept: 'Sewing and Stitching', count: major });
  if (minor) lines.push({ defectType: MIN[seed % MIN.length], severity: 'Minor', location: 'Hem / neck', responsibleDept: 'Thread Trimming and Alteration', count: minor });
  return lines;
}

/**
 * Hour-by-hour department production for a job, day by day from its first lay: every department takes in what
 * the previous one completed (Folding only what Final QC released), processes it within its daily capacity,
 * rejects and reworks a realistic share. Quality inspections run at their stages; failed lots go through
 * rework and reinspection. Returns the department totals and the last production day.
 */
export async function flowProduction(api, c) {
  const { unit, jobNo, spec, target, lays, line, operators, day, log, flowLog, inspector, counters } = c;
  const S = Object.fromEntries(PRODUCTION_DEPARTMENTS.map((d) => [d, { in: 0, out: 0, rej: 0 }]));
  const sewCap = Math.round((operators * 480 * 0.62) / spec.sam);
  const supervisor = unit === 'U1' ? 'K. Lakshmi' : 'S. Fathima';
  const teamOf = (dept) => (dept === 'Sewing and Stitching' ? `${line} team` : dept.startsWith('Cutting') ? 'Cutting table 1' : `${dept} team`);
  const post = async (dept, k, input, completed, rejected, rework, hourTarget) => {
    const n = Math.max(1, Math.min(8, Math.ceil(input / 25)));
    const ins = spread(input, n); const rej = spread(rejected, n).reverse(); const rw = spread(rework, n);
    const delay = dept === 'Sewing and Stitching' && Math.abs(k + counters.line) % 3 === 0 ? { slot: Math.min(2, n - 1), min: 15 + (Math.abs(k * 7) % 3) * 10, reason: DELAYS[Math.abs(k) % DELAYS.length] } : null;
    const team = teamOf(dept); const crew = dept === 'Sewing and Stitching' ? operators : Math.max(2, Math.round(operators / 6));
    const slots = ins.map((inp, i) => ({
      slot: SLOTS[i], target: hourTarget, inputQty: inp, completedQty: Math.max(inp - Math.min(rej[i], inp), 0), rejectedQty: Math.min(rej[i], inp), reworkQty: Math.min(rw[i], inp),
      downtimeMin: delay && i === delay.slot ? delay.min : 0, delayReason: delay && i === delay.slot ? delay.reason : '', team, workingHours: crew,
    }));
    const sheet = await api.post('/m/hourlyProduction', { job: jobNo, entryDate: day(k), shift: 'General', department: dept, line: dept === 'Sewing and Stitching' ? line : '', operation: dept === 'Sewing and Stitching' ? 'Complete garment' : '', supervisor, color: spec.fabric.color, operators: crew, slots });
    if ((counters.hps = (counters.hps || 0) + 1) % 4 === 0) await api.status('hourlyProduction', sheet._id, 'Approved');
    S[dept].in += sheet.inputQty; S[dept].out += sheet.completedQty; S[dept].rej += sheet.rejectedQty;
    flowLog.push({ unit, day: k, dept, jobNo });
    return sheet;
  };
  const inspect = async (stage, k, lot, { pass = true, disposition, method = 'AQL sampling', time = '15:30', who = inspector, agency = 'In-house QA', seed = 0 } = {}) => {
    const r = await api.post('/m/inspection', { job: jobNo, inspectionDate: day(k), inspectionTime: time, inspectionStage: stage, inspectionMethod: method, inspector: who, inspectionAgency: agency, lotSize: lot, line, color: spec.fabric.color, bundleNo: `B-${jobNo.split('-').slice(1).join('')}-${counters.bundle = (counters.bundle || 100) + 1}`, defectLines: defects(lot, pass, '2.5', '4.0', seed + counters.line), ...(disposition || { passQty: pass ? lot : undefined }) });
    const done = await api.status('inspection', r._id, 'Inspection', r.aqlResult === 'Passed' ? 'Passed' : 'Failed');
    if (done.status !== (pass ? 'Passed' : 'Failed')) throw new Error(`${jobNo}: ${stage} expected ${pass ? 'pass' : 'fail'}, got ${done.status}`);
    return done;
  };
  // rework of a failed / held lot: assigned, reworked, reinspected and closed (or left open for a quality hold)
  const resolve = async (ins, k, failed, { open = false } = {}) => {
    const reworked = open ? Math.round(failed * 0.6) : failed - 1;
    const reinspected = open ? Math.round(failed * 0.4) : reworked;
    const passed = open ? reinspected - 1 : reworked - 1;
    const body = {
      job: jobNo, inspection: ins._id, issueDate: day(k), assignedDept: 'Thread Trimming and Alteration', responsibleLine: line, responsibleTeam: `${line} – side seam operators`,
      reworkStartDate: day(k), reworkStartTime: '16:30', reworkEndDate: day(k + (open ? 0 : 1)), reworkEndTime: open ? '' : '11:30', reworkedQty: reworked, scrapQty: open ? 0 : 1,
      reworkMinutes: reworked * 6, labourRatePerMin: 0.021, materialCost: Math.round(reworked * 0.04 * 100) / 100, reinspectionCost: 4,
      reinspectionDate: day(k + (open ? 0 : 1)), reinspectedBy: inspector, reinspectedQty: reinspected, reinspPassedQty: passed, reinspRejectedQty: reinspected - passed,
      rootCause: 'Thread tension drift on two overlock machines; operator did not stop the line on first defect', correctiveAction: open ? '' : 'Machines re-tensioned, defective pieces re-sewn and reinspected 100 %',
      preventiveAction: 'Hourly needle and tension check added to the line checklist', capaDueDate: day(k + 5), capaStatus: open ? 'In Progress' : 'Implemented',
      remarks: open ? 'Lot on hold – rework in progress, balance awaiting reinspection' : '',
    };
    const qi = await api.post('/m/qcRework', body);
    await api.status('qcRework', qi._id, 'Assigned', 'In Rework');
    if (!open) await api.status('qcRework', qi._id, 'Reinspection', 'Closed');
    return qi;
  };

  // limits by target: mid-production jobs stop part-way through the flow
  const cutTotal = lays.reduce((t, l) => t + l.pcs - l.reject, 0);
  const lim = {};
  const after = (dept) => PRODUCTION_DEPARTMENTS.slice(PRODUCTION_DEPARTMENTS.indexOf(dept) + 1);
  if (target === 'sewing') { lim['Sewing and Stitching'] = Math.round(cutTotal * 0.45); after('Quality Control').forEach((d) => { lim[d] = 0; }); }
  if (target === 'packingPartial') lim.Folding = Math.round(cutTotal * 0.58);

  // cutting: the hourly board of each lay (the lay register itself is the Cutting entry)
  const cutByDay = new Map();
  for (const l of lays) {
    await post('Cutting', l.day, l.pcs, l.pcs - l.reject, l.reject, 0, Math.ceil(l.pcs / 6));
    cutByDay.set(l.day, (cutByDay.get(l.day) || 0) + l.pcs - l.reject);
  }
  if (target === 'cutting') return { S, lastDay: lays[lays.length - 1].day };

  let gateReleased = 0; let lotNo = 0; let k = lays[0].day; let idle = 0; let lastDay = k; let endline = 0;
  const due = []; // rework issues to raise the next morning
  while (idle < 2) {
    if (k > 0) throw new Error(`${jobNo}: department flow would run past today – start production earlier`);
    for (let i = due.length - 1; i >= 0; i -= 1) {
      if (due[i].k > k) continue;
      const [x] = due.splice(i, 1);
      gateReleased += await x.run();
    }
    let moved = 0;
    const cutSoFar = [...cutByDay.entries()].filter(([d]) => d <= k).reduce((t, [, q]) => t + q, 0);
    for (const dept of PRODUCTION_DEPARTMENTS.slice(1)) {
      const prev = PRODUCTION_DEPARTMENTS[PRODUCTION_DEPARTMENTS.indexOf(dept) - 1];
      const avail = dept === 'Cutting Issue' ? cutSoFar - S[dept].in : dept === 'Folding' ? gateReleased - S.Folding.in : S[prev].out - S[dept].in;
      const room = lim[dept] === undefined ? Infinity : lim[dept] - S[dept].in;
      const take = Math.max(0, Math.min(avail, Math.round(CAP[dept] * sewCap), room));
      if (!take) continue;
      const rej = Math.round(take * (REJ[dept] || 0)); const rw = Math.round(take * (RW[dept] || 0));
      const sh = await post(dept, k, take, take - rej, rej, rw, Math.round((CAP[dept] * sewCap) / 8));
      moved += take; lastDay = k;
      // quality inspections at their stages
      if (dept === 'Sewing and Stitching' && S[dept].in === sh.inputQty) await inspect('In-line Inspection', k, sh.inputQty, { method: 'Random sampling', time: '11:00', seed: 1 });
      if (dept === 'Checking') {
        endline += 1;
        // the second end-line audit of a job fails: lot held, reworked and reinspected (closed the next day)
        const failing = endline === 2 && !spec.qualityHold;
        const ins = await inspect('End-line Inspection', k, sh.completedQty, failing ? { pass: false, disposition: { passQty: 0, heldQty: sh.completedQty }, time: '16:00', seed: 2 } : { time: '16:00', seed: 3 });
        if (failing) due.push({ k: k + 1, run: async () => { await resolve(ins, k + 1, sh.completedQty); return 0; } });
      }
      if (dept === 'Ironing and Finishing' && lim.Folding !== 0 && sh.completedQty > 0) {
        lotNo += 1;
        const L = sh.completedQty;
        if (spec.qualityHold && lotNo === 2) {
          // quality hold: Final QC fails a lot, it is held and rework is still in progress
          const ins = await inspect('Final Garment Inspection', k, L, { pass: false, disposition: { passQty: 0, heldQty: L }, seed: 4 });
          due.push({ k: k + 1, run: async () => { const qi = await resolve(ins, k + 1, L, { open: true }); return qi.reinspPassedQty; } });
        } else if (lotNo === 2) {
          // a failed lot: most pieces pass, the defective ones are reworked and reinspected the next day
          const F = Math.max(4, Math.round(L * 0.035));
          const ins = await inspect('Final Garment Inspection', k, L, { pass: false, disposition: { passQty: L - F - 2, reworkQty: F, rejectQty: 2 }, seed: 5 });
          gateReleased += L - F - 2;
          due.push({ k: k + 1, run: async () => { const qi = await resolve(ins, k + 1, F); return qi.reinspPassedQty; } });
        } else {
          await inspect('Final Garment Inspection', k, L, { seed: lotNo });
          gateReleased += L;
        }
      }
    }
    if (moved || due.length) idle = 0; else idle += 1;
    k += 1;
  }
  if (target !== 'sewing' && target !== 'packingPartial' && S['Carton/Box Packing'].out) {
    await inspect('Packing & Carton Inspection', lastDay, S['Carton/Box Packing'].out, { method: 'Random sampling', time: '17:00', seed: 6 });
  }
  log(`      ${jobNo}: hourly flow cut ${S.Cutting.out} → sewn ${S['Sewing and Stitching'].out} → ironed ${S['Ironing and Finishing'].out} → FG ${S['Finished Goods Inward'].out}`);
  return { S, lastDay };
}

/** Packing list of the carton-packed pieces (full cartons + one part carton), so packing = hourly carton packing. */
export async function flowPackingList(api, c, S, dd) {
  const { jobNo, spec, unit, pcsPerMarker, counters, r2, day } = c;
  const total = S['Carton/Box Packing'].out;
  const ppc = pcsPerMarker * 3;
  const full = Math.floor(total / ppc); const rest = total - full * ppc;
  const ratio = spec.ratio.split(',').map((x) => { const [s, q] = x.split(':'); return `${s}:${Number(q) * 3}`; }).join(',');
  const wt = spec.fabric.unit === 'KG' ? spec.fabric.consumption : 0.2;
  const rows = [{ color: spec.fabric.color, ratio, cartonFrom: 1, cartonTo: full, pcsPerCarton: ppc, netWtPerCarton: r2(ppc * wt), grossWtPerCarton: r2(ppc * wt + 1.1), length: 60, width: 40, height: 30 }];
  if (rest) rows.push({ color: spec.fabric.color, ratio: 'Assorted (part carton)', cartonFrom: full + 1, cartonTo: full + 1, pcsPerCarton: rest, netWtPerCarton: r2(rest * wt), grossWtPerCarton: r2(rest * wt + 0.6), length: 60, width: 40, height: 30 });
  const p = await api.post('/m/packing', { job: jobNo, packingDate: day(dd), packingMethod: 'Solid Color Assorted Size', rows, warehouse: `${unit === 'U1' ? 'Unit-1' : 'Unit-2'} Finished Goods Warehouse`, location: `Bay ${(counters.cont % 4) + 1}`, barcodeRange: `SSCC 0089${unit === 'U1' ? 1 : 2}${String(counters.dc).padStart(5, '0')}0001–${String(full + (rest ? 1 : 0)).padStart(4, '0')}`, remarks: 'Cartons from the hourly carton-packing sheets' });
  await api.status('packing', p._id, 'Packed', 'Verified');
  return { pk: p, ppc, fullCartons: full };
}

/** Pre-shipment inspection of finished goods (the quality gate before shipment). */
export async function preShipment(api, c, lot, dd, agency) {
  const { jobNo, spec } = c;
  const r = await api.post('/m/inspection', { job: jobNo, inspectionDate: c.day(dd), inspectionTime: '10:30', inspectionStage: 'Pre-shipment Inspection', inspectionMethod: 'AQL sampling', inspector: 'Buyer QA', inspectionAgency: agency || `${spec.buyer} QA`, lotSize: lot, passQty: lot, defectLines: defects(lot, true, '2.5', '4.0', 7) });
  await api.status('inspection', r._id, 'Inspection', 'Passed', 'Final Approved');
  return r;
}

/* ------------------------------ attendance & payroll ------------------------------ */
/** Daily attendance sheet per section; direct job allocation where a section worked on one job that day. */
export async function attendanceSheets(api, unit, staff, flowLog, fromDay, day, counters) {
  const bySection = new Map();
  staff.forEach((s) => (bySection.get(s.section) || bySection.set(s.section, []).get(s.section)).push(s));
  let n = 0;
  for (let k = fromDay; k <= -1; k += 1) {
    const date = new Date(day(k));
    if (date.getUTCDay() === 0) continue; // Sunday weekly off
    const busy = flowLog.filter((f) => f.unit === unit && f.day === k);
    for (const [section, people] of bySection) {
      const jobs = [...new Set(busy.filter((f) => f.dept === section).map((f) => f.jobNo))];
      const rows = people.map((p, i) => {
        const h = (Math.abs(k) * 31 + i * 17 + section.length * 7) % 100;
        const status = h < 3 ? 'Absent' : h < 5 ? 'Leave' : h < 7 ? 'Half Day' : 'Present';
        const ot = status === 'Present' && jobs.length && date.getUTCDay() === 5 ? 2 : 0;
        return { empCode: p.empCode, status, hours: status === 'Half Day' ? 4 : status === 'Present' ? 8 : 0, otHours: ot, incentive: status === 'Present' && section === 'Sewing and Stitching' && h > 90 ? 1.5 : 0, jobNo: jobs.length === 1 && i === 0 && status !== 'Absent' && status !== 'Leave' ? jobs[0] : undefined };
      });
      const sheet = await api.post('/m/attendance', { attendanceDate: day(k), shift: 'General', section, rows });
      if (k < -2) await api.status('attendance', sheet._id, 'Approved');
      n += 1;
    }
  }
  counters.attendance = (counters.attendance || 0) + n;
  return n;
}

/** Payroll for every month that has ended: built from attendance, approved and paid. */
export async function payrolls(api, unit, fromDay, day, TODAY) {
  const months = new Set();
  for (let k = fromDay; k <= -1; k += 1) months.add(day(k).slice(0, 7));
  const current = TODAY.toISOString().slice(0, 7);
  const out = [];
  for (const period of [...months].filter((m) => m < current).sort()) {
    for (const [payrollType, contractor] of [['Employees (salary & wages)', ''], ['Contract labour', 'Sri Murugan Labour Contracts']]) {
      const pr = await api.post('/m/payroll', { period, payrollType, contractor, remarks: `${period} ${payrollType} – built from attendance (Sample / Test data)` });
      const [y, m] = period.split('-').map(Number);
      const paid = new Date(Date.UTC(y, m, 7)).toISOString().slice(0, 10);
      await api.put(`/m/payroll/${pr._id}`, { paymentDate: paid });
      await api.status('payroll', pr._id, 'Approved', 'Paid');
      out.push(pr);
    }
  }
  return out;
}

/* ------------------------------ factory expenses ------------------------------ */
/** Previous and current month factory bills of a unit (shared rent / security split between the units) + job-linked quality costs. */
export async function factoryExpenses(api, unit, day, TODAY, jobs) {
  const today = TODAY.getUTCDate();
  const months = [new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - 1, 1)), new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), 1))];
  const rel = (iso) => Math.round((new Date(iso) - TODAY) / 86400000);
  const s = unit === 'U1' ? 1 : 0.85;
  const rows = [];
  for (const m of months) {
    const period = m.toISOString().slice(0, 7);
    const isCur = m.getUTCMonth() === TODAY.getUTCMonth();
    if (isCur && today <= 2) continue;
    // bill date: day-of-month, never later than yesterday
    const at = (dom) => rel(`${period}-${String(isCur ? Math.min(dom, today - 1) : dom).padStart(2, '0')}`);
    const P = (cur) => (isCur ? cur : 'Paid');
    rows.push(
      { category: 'Electricity & Power', payee: unit === 'U1' ? 'TANGEDCO – HT service 0412' : 'TANGEDCO – HT service 0977', referenceNo: `EB-${unit}-${period}`, amount: Math.round(1400 * s), recurring: true, period, rel: at(5), paymentStatus: P('Unpaid'), status: isCur ? 'Pending' : 'Approved' },
      { category: 'Water', payee: 'Tiruppur Municipal Water Board', referenceNo: `WTR-${unit}-${period}`, amount: Math.round(90 * s), recurring: true, period, rel: at(6), paymentStatus: P('Paid') },
      { category: 'Fuel & Generator', payee: 'Indian Oil – diesel', referenceNo: `DSL-${unit}-${period}-1`, amount: Math.round(250 * s), rel: at(9), paymentStatus: P('Paid') },
      { category: 'Machinery Maintenance & Repairs', payee: 'Juki Service Centre', referenceNo: `JSC-${unit}-${period}-1`, amount: 120, rel: at(11), paymentStatus: P('Part paid'), paidAmount: isCur ? 60 : undefined, department: 'Sewing and Stitching' },
      { category: 'Machinery Maintenance & Repairs', payee: 'Brother Machines India', referenceNo: `BMI-${unit}-${period}`, amount: 60, rel: at(3), paymentStatus: P('Paid'), department: 'Assembly' },
      { category: 'Transportation & Logistics', payee: 'Sri Balaji Travels – staff bus', referenceNo: `BUS-${unit}-${period}`, amount: Math.round(350 * s), recurring: true, period, rel: at(2), paymentStatus: P('Paid') },
      { category: 'Canteen & Employee Welfare', payee: 'Annapoorna Caterers', referenceNo: `CAN-${unit}-${period}`, amount: Math.round(420 * s), recurring: true, period, rel: at(4), paymentStatus: P('Unpaid') },
      { category: 'Cleaning & Housekeeping', payee: 'Clean Pro Facility Services', referenceNo: `CLN-${unit}-${period}`, amount: Math.round(160 * s), recurring: true, period, rel: at(3), paymentStatus: P('Paid') },
      { category: 'Office & Administration', payee: 'Sakthi Stationers', referenceNo: `STN-${unit}-${period}`, amount: 60, rel: at(8), paymentStatus: P('Paid'), department: 'Administration' },
      { category: 'Production Consumables', payee: 'Groz-Beckert needles & machine oil', referenceNo: `GBN-${unit}-${period}`, amount: Math.round(90 * s), rel: at(7), paymentStatus: P('Paid'), department: 'Sewing and Stitching' },
      { category: 'QC Materials & Testing', payee: 'Datacolor light box lamps & tapes', referenceNo: `QCM-${unit}-${period}`, amount: 30, rel: at(10), paymentStatus: P('Paid'), department: 'Quality Inspection' },
    );
    if (unit === 'U1') rows.push({ category: 'Rent', payee: 'Sri Lakshmi Estates', referenceNo: `RENT-${period}`, amount: 2000, recurring: true, period, rel: at(1), paymentStatus: P('Paid'), sharing: 'Shared – Unit-1 & Unit-2', sharePctU1: 60, description: 'Factory building rent – shared 60 / 40 by floor area' });
    if (unit === 'U2') rows.push({ category: 'Security', payee: 'Eagle Security Services', referenceNo: `SEC-${period}`, amount: 600, recurring: true, period, rel: at(1), paymentStatus: P('Paid'), sharing: 'Shared – Unit-1 & Unit-2', sharePctU1: 50, description: 'Campus security – shared equally' });
  }
  // job-linked quality costs: third-party inspection and an outsourced repair (still awaiting approval)
  if (jobs.inspected) rows.push({ category: 'Outsourced Inspection', payee: 'Intertek India – final inspection', referenceNo: `ITK-${jobs.inspected.jobNo}`, amount: 220, rel: jobs.inspected.day, paymentStatus: 'Paid', job: jobs.inspected.jobNo, department: 'Quality Inspection', description: `Third-party final inspection ${jobs.inspected.jobNo}` });
  if (jobs.repaired) rows.push({ category: 'Outsourced Rework / Repair', payee: 'Stitch Fix Alterations', referenceNo: `SFA-${jobs.repaired.jobNo}`, amount: 85, rel: jobs.repaired.day, paymentStatus: 'Unpaid', job: jobs.repaired.jobNo, department: 'Thread Trimming and Alteration', description: `Re-stitching of held pieces ${jobs.repaired.jobNo}`, status: 'Pending' });
  const made = [];
  for (const { rel: r, status, ...body } of rows) {
    const e = await api.post('/m/factoryExpense', {
      ...body, expenseDate: day(r), description: body.description || `${body.category}${body.period ? ` – ${body.period}` : ''}`, documentRef: `Scan ${body.referenceNo}.pdf`,
      ...(body.paymentStatus !== 'Unpaid' ? { paymentDate: day(Math.min(r + 3, -1)) } : {}),
    });
    if ((status || 'Approved') === 'Approved') await api.status('factoryExpense', e._id, 'Approved');
    made.push(e);
  }
  return made;
}

/* ------------------------------ negative tests ------------------------------ */
/** The rules must refuse wrong entries. Returns [{ test, ok, got }]. */
export async function negativeTests(api, ctx) {
  const out = [];
  const expect = async (test, fn, want) => {
    try { await fn(); out.push({ test, ok: false, got: 'accepted' }); } catch (e) { out.push({ test, ok: want.test(e.message), got: e.message.slice(0, 160) }); }
  };
  const { jobNo, sheet, day, payroll, expense, attendance, heldJob } = ctx;
  if (sheet) {
    await expect('Duplicate hourly sheet is refused', () => api.post('/m/hourlyProduction', { job: jobNo, entryDate: sheet.entryDate, shift: sheet.shift, department: sheet.department, line: sheet.line, slots: [{ slot: '08:00-09:00', inputQty: 1, completedQty: 1 }] }), /409/);
    await expect('Department cannot take in more than it was given', () => api.post('/m/hourlyProduction', { job: jobNo, entryDate: day(0), shift: 'Shift C', department: 'Finished Goods Inward', slots: [{ slot: '20:00-21:00', inputQty: 999999, completedQty: 999999 }] }), /OVERRIDE|exceeds/);
    await expect('Approved hourly sheet needs a reason to change', () => api.put(`/m/hourlyProduction/${sheet._id}`, { remarks: 'edited' }), /reason/);
  }
  if (heldJob) await expect('Production on a main job with sub jobs is refused', () => api.post('/m/hourlyProduction', { job: heldJob, entryDate: day(-1), department: 'Cutting', slots: [{ slot: '08:00-09:00', inputQty: 1, completedQty: 1 }] }), /sub job/);
  if (payroll) await expect('Second payroll for the same month is refused', () => api.post('/m/payroll', { period: payroll.period, payrollType: payroll.payrollType, contractor: payroll.contractor }), /409/);
  if (expense) await expect('Duplicate factory bill is refused', () => api.post('/m/factoryExpense', { expenseDate: day(-1), category: expense.category, payee: expense.payee, referenceNo: expense.referenceNo, amount: expense.amount }), /409/);
  if (attendance) await expect('Same employee twice on one day is refused', () => api.post('/m/attendance', { attendanceDate: attendance.attendanceDate, section: 'Maintenance', line: 'Duplicate test', rows: [{ empCode: attendance.rows[0].empCode, status: 'Present', hours: 8 }] }), /409/);
  if (ctx.labourExpense) await expect('Wages booked as a job Labour expense are refused once payroll is posted', () => api.post('/m/expense', { job: ctx.labourExpense.jobNo, category: 'Labour', description: 'Sewing wages', expenseDate: ctx.labourExpense.date, amount: 100 }), /payroll/);
  if (ctx.holdShipment) await expect('Shipping quality-held goods is refused', () => api.status('shipment', ctx.holdShipment, 'Booked', 'Stuffed', 'Shipped'), /quality-released|OVERRIDE/);
  return out;
}
