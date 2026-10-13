/**
 * Factory operations E2E: hourly department flow and quantity guards, quality gates, rework & reinspection,
 * shipment release, daily consolidation, edit reasons, attendance, payroll, factory expenses, reports and
 * integrity checks. Runs in Unit-2 against the same throwaway server as e2e.mjs, AFTER it (it uses the admin
 * password e2e.mjs sets). NEVER run against a live database.
 *
 *   node tests/e2e.mjs && node tests/factory.e2e.mjs
 */
const BASE = process.env.BASE || 'http://localhost:5051/api';
let token = null;
async function call(method, path, body, expect = [200, 201]) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!expect.includes(res.status)) { console.error(`✗ ${method} ${path} → ${res.status}`, JSON.stringify(data).slice(0, 400)); process.exit(1); }
  return data;
}
const ok = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL:', msg); process.exit(1); } console.log('  ✓', msg); };
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const slot = (h, input, completed, rejected = 0, extra = {}) => ({ slot: `${String(h).padStart(2, '0')}:00-${String(h + 1).padStart(2, '0')}:00`, inputQty: input, completedQty: completed, rejectedQty: rejected, target: 100, ...extra });

let r = await call('POST', '/auth/login', { email: process.env.ADMIN_EMAIL || 'ashofficial338@gmail.com', password: process.env.ADMIN_PASS || 'NewAdmin@2026' });
token = r.accessToken;
r = await call('POST', '/auth/select-unit', { unit: 'U2' });
token = r.accessToken;
ok(r.user.unit.code === 'U2', 'Unit-2 selected for the factory tests');

const buyer = await call('POST', '/m/buyer', { name: 'Factory Test Buyer', code: 'FTB', country: 'India', currency: 'USD' });
const job = await call('POST', '/jobs', { buyer: buyer._id, poNo: 'FT-PO-1', styleNo: 'FT-TEE-1', orderDate: day(-30), orderQty: 600, unitPrice: 4, shipmentDate: day(20), destination: 'Chennai' });
const J = job.jobNo;
ok(/^U2-\d+$/.test(J), `job ${J} in the Unit-2 series`);

/* ---------- hourly production & flow guards ---------- */
const sheet = (department, d, slots, extra = {}) => call('POST', '/m/hourlyProduction', { job: J, entryDate: day(d), department, slots, ...extra });
const cut = await sheet('Cutting', -12, [slot(8, 300, 299, 1), slot(9, 310, 309, 1)]);
ok(cut.inputQty === 610 && cut.completedQty === 608 && cut.rejectedQty === 2 && cut.pendingQty === 0, 'cutting sheet totals = sum of hourly rows (610 in, 608 good, 2 rejected)');
ok(cut.slots.every((s) => s.enteredBy && s.enteredAt), 'each hourly row stamped with entering user and time');
await call('POST', '/m/hourlyProduction', { job: J, entryDate: day(-12), department: 'Cutting', slots: [slot(10, 1, 1)] }, [409]);
ok(true, 'second sheet for the same job, department, date, shift and line refused');
let e = await call('POST', '/m/hourlyProduction', { job: J, entryDate: day(-11), department: 'Sewing and Stitching', line: 'Line 1', slots: [slot(8, 50, 50)] }, [400]);
ok(e.details?.code === 'OVERRIDE_REQUIRED' && /exceeds/.test(e.message), 'sewing cannot take in pieces the previous department never handed over');
await call('POST', '/m/hourlyProduction', { job: J, entryDate: day(-12), shift: 'Shift B', department: 'Cutting', slots: [slot(14, 100, 100)] }, [400]);
ok(true, 'cutting beyond order quantity + over-cut tolerance refused');
for (const dep of ['Cutting Issue', 'Preparation', 'Assembly']) await sheet(dep, -11, [slot(8, 300, 300), slot(9, 308, 308)]);
const sew = await sheet('Sewing and Stitching', -10, [slot(8, 300, 298, 2, { reworkQty: 4, downtimeMin: 15, delayReason: 'Needle / bobbin change' }), slot(9, 308, 308)], { line: 'Line 1', operators: 20 });
ok(sew.completedQty === 606 && sew.downtimeMin === 15, 'sewing hourly sheet: 606 completed, downtime recorded');
const daily = (await call('GET', `/m/sewing?job=${J}`)).rows;
ok(daily.length === 1 && daily[0].actualQty === 606 && daily[0].autoPosted, 'daily sewing entry consolidated automatically from the hourly sheet');
e = await call('PUT', `/m/sewing/${daily[0]._id}`, { manualOutput: 999 }, [400]);
ok(e.details?.code === 'OVERRIDE_REQUIRED', 'consolidated daily entry cannot be edited directly');
for (const dep of ['Checking', 'Quality Control', 'Thread Trimming and Alteration', 'Ironing and Finishing']) await sheet(dep, -9, [slot(8, 300, 300), slot(9, 306, 306)]);
e = await call('POST', '/m/hourlyProduction', { job: J, entryDate: day(-9), department: 'Folding', slots: [slot(10, 10, 10)] }, [400]);
ok(/Final Garment Inspection released/.test(e.message), 'Folding is gated: nothing enters before Final QC releases it');

/* ---------- quality gate, rework, reinspection ---------- */
await call('POST', '/m/inspection', { job: J, inspectionDate: day(-9), inspectionStage: 'Final Garment Inspection', lotSize: 606, passQty: 600 }, [400]);
ok(true, 'lot disposition must add up to the lot submitted');
await call('POST', '/m/inspection', { job: J, inspectionDate: day(-9), inspectionStage: 'Final Garment Inspection', lotSize: 700, passQty: 700 }, [400]);
ok(true, 'a lot larger than the submitting department’s output is refused');
let ins = await call('POST', '/m/inspection', { job: J, inspectionDate: day(-9), inspectionTime: '15:00', inspectionStage: 'Final Garment Inspection', inspector: 'QA Test', lotSize: 606, passQty: 596, reworkQty: 8, rejectQty: 2, majorDefects: 8, minorDefects: 2,
  defectLines: [{ defectType: 'Open seam', severity: 'Major', count: 8 }, { defectType: 'Loose thread', severity: 'Minor', count: 2 }] });
ok(ins.inspectionType === 'Final' && ins.department === 'Ironing and Finishing' && ins.defectLines[0].defectCategory === 'Stitching', 'stage sets type, inspected department and defect category');
ins = await call('POST', `/m/inspection/${ins._id}/status`, { status: 'Inspection' });
ins = await call('POST', `/m/inspection/${ins._id}/status`, { status: 'Failed' });
ok(ins.status === 'Failed' && ins.firstPassYieldPct === 98.35, 'lot failed AQL; first-pass yield 98.35 %');
await sheet('Folding', -9, [slot(16, 596, 596)]);
e = await call('POST', '/m/hourlyProduction', { job: J, entryDate: day(-8), department: 'Folding', slots: [slot(8, 1, 1)] }, [400]);
ok(/released/.test(e.message), 'reworked pieces are not released until reinspection passes them');
let qi = await call('POST', '/m/qcRework', { job: J, inspection: ins._id, issueDate: day(-8), assignedDept: 'Thread Trimming and Alteration', reworkedQty: 8, reinspectedQty: 8, reinspPassedQty: 7, reinspRejectedQty: 1, reinspectionDate: day(-8), reworkMinutes: 40, labourRatePerMin: 0.02 });
ok(qi.failedQty === 8 && qi.pendingQty === 0 && qi.acceptedQty === 7 && qi.reworkCost === 0.8, 'quality issue: 8 failed → 7 passed on reinspection, 1 rejected, rework cost 0.80');
await call('POST', '/m/qcRework', { job: J, inspection: ins._id, issueDate: day(-8), failedQty: 1 }, [400]);
ok(true, 'issues cannot exceed the failed / held quantity of the inspection');
for (const s of ['Assigned', 'In Rework', 'Reinspection']) qi = await call('POST', `/m/qcRework/${qi._id}/status`, { status: s });
await call('POST', `/m/qcRework/${qi._id}/status`, { status: 'Closed' }, [400]);
ok(true, 'issue cannot close without a corrective action');
await call('PUT', `/m/qcRework/${qi._id}`, { correctiveAction: 'Overlock re-tensioned', releasedQty: 0 });
qi = await call('POST', `/m/qcRework/${qi._id}/status`, { status: 'Closed' });
ok(qi.status === 'Closed', 'quality issue closed after reinspection');
await sheet('Folding', -8, [slot(8, 7, 7)]);
ok(true, 'pieces passed on reinspection are released to Folding');
for (const dep of ['Packing', 'Carton/Box Packing', 'Finished Goods Inward']) await sheet(dep, -7, [slot(8, 300, 300), slot(9, 303, 303)]);

/* ---------- finished goods & shipment release ---------- */
const shp = await call('POST', '/m/shipment', { job: J, invoiceNo: 'FT-EXP-1', shipmentDate: day(-3), qty: 600, cartons: 20 });
await call('POST', `/m/shipment/${shp._id}/status`, { status: 'Booked' });
await call('POST', `/m/shipment/${shp._id}/status`, { status: 'Stuffed' });
e = await call('POST', `/m/shipment/${shp._id}/status`, { status: 'Shipped' }, [400]);
ok(/quality-released/.test(e.message), 'goods without pre-shipment release cannot ship');
const pre = await call('POST', '/m/inspection', { job: J, inspectionDate: day(-4), inspectionStage: 'Pre-shipment Inspection', lotSize: 603, passQty: 603 });
await call('POST', `/m/inspection/${pre._id}/status`, { status: 'Inspection' });
await call('POST', `/m/inspection/${pre._id}/status`, { status: 'Passed' });
const shipped = await call('POST', `/m/shipment/${shp._id}/status`, { status: 'Shipped' });
ok(shipped.status === 'Shipped', 'released goods ship');
const wip = await call('GET', `/factory/report/wip?jobNo=${J}`);
const row = wip.tables.jobs.rows[0];
ok(row.cut === 608 && row.fgInward === 603 && row.shipped === 600 && row.available === 3 && row.inDepartments === 0, `flow reconciles: cut 608 → FG 603 → shipped 600, 3 in finished goods`);

/* ---------- edit reasons & audit ---------- */
const approved = await call('POST', `/m/hourlyProduction/${cut._id}/status`, { status: 'Approved' });
e = await call('PUT', `/m/hourlyProduction/${approved._id}`, { remarks: 'late correction' }, [400]);
ok(e.details?.code === 'REASON_REQUIRED', 'approved sheet needs a reason to change');
await call('PUT', `/m/hourlyProduction/${approved._id}`, { remarks: 'late correction', _reason: 'Supervisor note added' });
const aud = await call('GET', `/admin/audit?recordId=${approved._id}&limit=10`);
ok(aud.rows.some((a) => a.action === 'UPDATE' && a.reason === 'Supervisor note added' && a.changes.some((c) => c.field === 'remarks')), 'change audited with user, old → new value and reason');

/* ---------- HR, payroll, factory expenses ---------- */
const emp = await call('POST', '/m/employee', { empCode: 'FT-E1', name: 'Test Operator', section: 'Sewing and Stitching', wageType: 'Monthly salary', monthlySalary: 182, standardDays: 26, standardHours: 8, otRatePerHour: 1.75, employerContributionPct: 13 });
ok(emp.hourlyRate === 0.875, 'employee standard cost / hour from salary');
const att = await call('POST', '/m/attendance', { attendanceDate: day(-10), section: 'Sewing and Stitching', rows: [{ empCode: 'FT-E1', status: 'Present', hours: 8, otHours: 2, jobNo: J }] });
ok(Math.abs(att.labourCost - round2((8 * 0.875 + 2 * 1.75) * 1.13)) <= 0.011, `attendance estimated labour cost ${att.labourCost} (wages + OT + employer contributions)`);
await call('POST', '/m/attendance', { attendanceDate: day(-10), section: 'Maintenance', rows: [{ empCode: 'FT-E1', status: 'Present', hours: 8 }] }, [409]);
ok(true, 'the same employee cannot be on two sheets for one day');
const period = day(-10).slice(0, 7);
let pr = await call('POST', '/m/payroll', { period });
ok(pr.lines.length === 1 && pr.lines[0].empCode === 'FT-E1' && pr.totalCost > 0, `payroll ${period} built from attendance`);
await call('POST', '/m/payroll', { period }, [409]);
ok(true, 'second payroll for the same month refused');
pr = await call('POST', `/m/payroll/${pr._id}/status`, { status: 'Approved' });
e = await call('POST', '/m/expense', { job: J, category: 'Labour', description: 'wages', expenseDate: day(-10), amount: 50 }, [400]);
ok(/payroll/.test(e.message), 'wages cannot also be booked as a job Labour expense');
const fx = await call('POST', '/m/factoryExpense', { expenseDate: day(-10), category: 'Electricity & Power', payee: 'Test EB', referenceNo: 'EB-1', amount: 120, paymentStatus: 'Paid' });
ok(fx.paidAmount === 120, 'paid factory expense records the paid amount');
await call('POST', `/m/factoryExpense/${fx._id}/status`, { status: 'Approved' });
await call('POST', '/m/factoryExpense', { expenseDate: day(-9), category: 'Electricity & Power', payee: 'test eb', referenceNo: 'eb-1', amount: 120 }, [409]);
ok(true, 'duplicate bill (same payee and reference) refused');

/* ---------- costs, reports, integrity ---------- */
const pnl = await call('GET', `/factory/report/pnl?jobNo=${J}&include=all&from=${day(-40)}`);
const jp = pnl.tables.job.rows.find((x) => x.jobNo === J);
ok(jp && jp.labour > 0 && jp.factoryOverhead > 0, `job P&L carries allocated labour ${jp?.labour} and factory overhead ${jp?.factoryOverhead}`);
for (const k of ['production', 'quality', 'fg', 'hr', 'expenses', 'copq']) {
  const rep = await call('GET', `/factory/report/${k}?from=${day(-40)}`);
  ok(Object.keys(rep.tables).length > 0, `${k} report`);
}
const hist = await call('GET', `/factory/job/${J}`);
ok(hist.tables.timeline.rows.length === 18, `job history lists ${hist.tables.timeline.rows.length} production, quality and shipment records`);
const integ = await call('GET', '/factory/integrity');
ok(integ.failed === 0, `integrity checks: ${integ.passed} passed, ${integ.failed} failed${integ.failed ? ` (${integ.checks.filter((c) => c.status === 'FAIL').map((c) => c.title).join('; ')})` : ''}`);

function round2(v) { return Math.round(v * 100) / 100; }
console.log('\nALL FACTORY E2E CHECKS PASSED');
