// End-to-end lifecycle test against a running API (test database).
// WARNING: changes the admin password – run ONLY against a disposable test database (see README).
const BASE = process.env.BASE || 'http://localhost:5051/api';
let token = '';
let cookie = '';
const call = async (method, path, body, expect = [200, 201]) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const txt = await res.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  if (!expect.includes(res.status)) { console.error('FAIL', method, path, res.status, JSON.stringify(data)); process.exit(1); }
  return data;
};
const r2 = (v) => Math.round(v * 100) / 100;
const ok = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL:', msg); process.exit(1); } console.log('  ✓', msg); };

let r = await call('POST', '/auth/login', { email: 'ashofficial338@gmail.com', password: 'Admin@12345' });
token = r.accessToken;
ok(r.user.mustChangePassword, 'first login forces password change');
await call('GET', '/dashboard', null, [403]);
r = await call('POST', '/auth/change-password', { currentPassword: 'Admin@12345', newPassword: 'Admin@12345' }, [400]);
r = await call('POST', '/auth/change-password', { currentPassword: 'Admin@12345', newPassword: 'NewAdmin@2026' });
token = r.accessToken;
ok(!r.user.mustChangePassword && r.user.isAdmin, 'password changed, admin session');
ok(r.user.unit === null && r.user.units.map((u) => u.code).join() === 'U1,U2', 'step 2: admin must select a unit (both units offered)');
const noUnit = await call('GET', '/dashboard', null, [403]);
ok(noUnit.details?.code === 'UNIT_REQUIRED', 'business API refuses requests before a unit is selected');
r = await call('POST', '/auth/select-unit', { unit: 'U1' });
token = r.accessToken;
ok(r.user.unit.code === 'U1', 'Unit-1 selected');
r = await call('POST', '/auth/refresh');
token = r.accessToken;
ok(!!token && r.user.unit?.code === 'U1', 'refresh token rotation keeps the selected unit');

const buyer = await call('POST', '/m/buyer', { name: 'Nordic Apparel AB', code: 'NOR', country: 'Sweden', currency: 'USD' });
const supplier = await call('POST', '/m/supplier', { name: 'Arvind Mills', supplierType: 'Fabric' });
const enq = await call('POST', '/m/enquiry', { enquiryDate: '2026-09-01', buyer: buyer._id, styleNo: 'NA-TS-101', product: 'Crew Neck Tee', expectedQty: 10000, fabric: 'Single Jersey', gsm: 180 });
ok(enq.refNo.startsWith('ENQ-'), `enquiry ${enq.refNo}`);
const cst = await call('POST', '/m/costing', { enquiry: enq._id, fabricConsumption: 0.18, fabricRate: 4.5, fabricWastagePct: 5, trimCost: 0.25, cuttingCost: 0.05, sewingCost: 0.35, finishingCost: 0.08, packingCost: 0.06, commissionPct: 3, profitMarginPct: 15 });
ok(cst.orderQty === 10000 && cst.buyer === buyer._id, 'costing pulled qty & buyer from enquiry');
ok(Math.abs(cst.fabricCost - 0.8505) < 1e-6, `fabric cost/pc ${cst.fabricCost}`);
console.log('    total cost/pc', cst.totalCostPerPc, 'FOB', cst.sellingPrice, 'profit%', cst.profitPct);
for (const s of ['Submitted', 'Under Review', 'Approved']) await call('POST', `/m/costing/${cst._id}/status`, { status: s });
await call('POST', `/m/costing/${cst._id}/status`, { status: 'Draft' }, [400, 403]);
const qtn = await call('POST', '/m/quotation', { costing: cst._id, quoteDate: '2026-09-05', paymentTerms: 'TT 30 days', fabric: 'Single Jersey', composition: '100% Cotton', gsm: 180 });
ok(qtn.price === cst.sellingPrice && qtn.version === 1, 'quotation pulled price from costing');
await call('POST', `/m/quotation/${qtn._id}/status`, { status: 'Approved' }, [400, 403]);
ok(true, 'cannot skip quotation stages without override reason');
for (const s of ['Sent', 'Under Review', 'Approved']) await call('POST', `/m/quotation/${qtn._id}/status`, { status: s });

const job = await call('POST', `/jobs/from-quotation/${qtn._id}`, { poNo: 'PO-77881', orderDate: '2026-09-10', shipmentDate: '2026-12-15', destination: 'Gothenburg', consumption: 0.18, wastagePct: 5, fabricType: 'Single Jersey', fabricColor: 'Navy', width: 72, trims: [{ item: 'Main Label', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 3, rate: 0.02 }, { item: 'Polybag', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 2, rate: 0.01 }] });
ok(job.jobNo === 'U1-1000' && job.orderNo === 'U1-ORD-1000' && job.businessUnit === 'U1', `Unit-1 job number series starts at ${job.jobNo}`);
ok(job.orderValue === Math.round(10000 * job.unitPrice * 100) / 100, 'order value computed');
await call('POST', `/jobs/from-quotation/${qtn._id}`, { poNo: 'PO-77881', shipmentDate: '2026-12-15' }, [400]);
ok(true, 'converted quotation cannot be converted twice');

let track = await call('GET', `/jobs/track/${job.jobNo}`);
ok(track.records.tna.length === 1 && track.records.tna[0].activities.length === 24, 'T&A generated with 24 activities (incl. spec, BOM, pattern, grading, marker)');
ok(track.records.sample.length === 4 && track.records.trimBooking.length === 2 && track.records.ppMeeting.length === 1 && track.records.productionPlan.length === 1, 'samples, trims, PPM, plan generated');
const fb = track.records.fabricBooking[0];
ok(fb.requiredQty === 1890, `fabric requirement carried: ${fb.requiredQty} KG (10,000 × 0.18 + 5%)`);
ok(track.lifecycle.stages.enquiry === 'done' && track.lifecycle.stages.costing === 'done' && track.lifecycle.stages.quotation === 'done', 'commercial stages done');

// ---------- Pre-production: Specification → BOM → CAD → Pattern → Grading → Marker ----------
ok(track.records.techSpec.length === 1 && track.records.bom.length === 1, 'specification and BOM generated with the order');
let bom = await call('GET', `/m/bom/${track.records.bom[0]._id}`);
ok(bom.lines.length === 3 && bom.lines.every((l) => l.bookingRef), `BOM lines linked to generated bookings (${bom.lines.map((l) => l.bookingRef).join(', ')})`);
ok(bom.lines[0].requiredQty === 1890 && bom.costedMaterialPerPc > 0, `BOM fabric line = booking requirement (${bom.lines[0].requiredQty}); costed material ${bom.costedMaterialPerPc}/pc`);
await call('POST', '/m/bom', { job: job.jobNo, lines: [] }, [409]);
ok(true, 'only one BOM per job');
const spec = await call('PUT', `/m/techSpec/${track.records.techSpec[0]._id}`, {
  sizes: ['S', 'M', 'L'], baseSize: 'M', construction: '4-thread overlock, coverstitch hems',
  measurements: [{ pom: 'Chest 1/2', baseValue: 52, gradeIncrement: 2, tolerance: 1 }, { pom: 'Body length', baseValue: 70, gradeIncrement: 1.5, tolerance: 1 }],
});
ok(spec.pomCount === 2, 'measurement chart saved');
let pat = await call('POST', '/m/pattern', { job: job.jobNo, patternNo: 'P-101', cadSystem: 'Gerber AccuMark', cadFileName: 'NA-TS-101.zip', pieceCount: 6 });
ok(pat.gradeRules.length === 2 && pat.gradeRules[0].graded === 'S 50 · M 52 · L 54' && pat.techSpec === spec._id, `grade rules pulled from spec: ${pat.gradeRules[0].graded}`);
await call('POST', '/m/pattern', { job: job.jobNo, patternNo: 'P-101' }, [409]);
ok(true, 'duplicate pattern no in a job blocked');
await call('POST', `/m/pattern/${pat._id}/status`, { status: 'Pattern Ready' });
await call('POST', `/m/pattern/${pat._id}/status`, { status: 'Pattern Approved' }, [400]);
ok(true, 'pattern approval blocked until the specification is approved');
for (const st of ['Submitted', 'Approved']) await call('POST', `/m/techSpec/${spec._id}/status`, { status: st });
for (const st of ['Pattern Approved', 'Graded']) pat = await call('POST', `/m/pattern/${pat._id}/status`, { status: st });
ok(pat.status === 'Graded', 'pattern approved and graded');

// BOM revision: extra rib fabric → approval raises its booking automatically
await call('POST', `/m/bom/${bom._id}/status`, { status: 'Submitted' });
await call('PUT', `/m/bom/${bom._id}`, { lines: [...bom.lines, { category: 'Fabric', item: 'Rib 1x1', description: '95/5 Cotton Lycra', color: 'Navy', unit: 'KG', consumptionPerPc: 0.02, wastagePct: 5, rate: 6 }] });
bom = await call('GET', `/m/bom/${bom._id}`);
ok(bom.lines.length === 4 && bom.lines.slice(0, 3).every((l) => l.bookingRef) && !bom.lines[3].bookingRef, 'booking links survive BOM edits');
await call('PUT', `/m/bom/${bom._id}`, { lines: bom.lines.slice(1) }, [400]);
ok(true, 'deleting a BOM line that is already booked is blocked');
await call('POST', `/m/bom/${bom._id}/status`, { status: 'Approved' });
bom = await call('GET', `/m/bom/${bom._id}`);
ok(bom.lines.every((l) => l.bookingRef), `approved BOM booked every line (rib → ${bom.lines[3].bookingRef})`);
const rib = (await call('GET', `/m/fabricBooking?job=${job.jobNo}&q=Rib`)).rows[0];
ok(rib && rib.requiredQty === 210 && rib.refNo === bom.lines[3].bookingRef, `rib booking requirement ${rib?.requiredQty} KG (10,000 × 0.02 + 5%)`);
await call('PUT', `/m/fabricBooking/${rib._id}`, { bookedQty: 210, receivedQty: 210, inspectedQty: 210, approvedQty: 210, issuedQty: 210, usedQty: 210 });
for (const st of ['Booked', 'In Production', 'In Transit', 'Received', 'Inspected', 'Approved']) await call('POST', `/m/fabricBooking/${rib._id}/status`, { status: st });

let mk = await call('POST', '/m/marker', { job: job.jobNo, markerNo: 'MK-1', ratio: 'S:2,M:4,L:4', markerLength: 5.5, markerWidth: 72, gsm: 180, unit: 'KG', plannedPlies: 1000, markerEfficiencyPct: 82, color: 'Navy' });
ok(mk.pattern === pat._id && mk.garmentsPerMarker === 10 && mk.plannedCutQty === 10000, 'marker linked to graded pattern; 10 pcs/marker');
ok(mk.consumptionPerPc === 0.1811 && mk.bomConsumption === 0.18 && mk.consumptionVariancePct === 0.61, `marker consumption ${mk.consumptionPerPc} kg/pc vs BOM ${mk.bomConsumption} (${mk.consumptionVariancePct}%)`);
for (const st of ['Submitted', 'Approved']) mk = await call('POST', `/m/marker/${mk._id}/status`, { status: st });
track = await call('GET', `/jobs/track/${job.jobNo}`);
const pre = ['spec', 'bom', 'cad', 'pattern', 'grading', 'marker'];
ok(pre.every((k) => track.lifecycle.stages[k] === 'done'), `pre-production stages done: ${pre.map((k) => `${k}=${track.lifecycle.stages[k]}`).join(' ')}`);
const doneActs = track.records.tna[0].activities.filter((a) => ['Tech Spec Approval', 'BOM Approval', 'Pattern Approval', 'Grading', 'Marker Ready'].includes(a.activity) && a.actualDate);
ok(doneActs.length === 5, 'T&A actual dates stamped for spec, BOM, pattern, grading, marker');
const ppmCheck = await call('GET', `/m/ppMeeting/${track.records.ppMeeting[0]._id}`);
ok(ppmCheck.patternStatus === 'Approved' && ppmCheck.markerStatus === 'Approved' && ppmCheck.measurementApproval === 'Approved', 'PP meeting readiness synced from spec / pattern / marker');
ok(track.lifecycle.order.findIndex((x) => x.key === 'marker') < track.lifecycle.order.findIndex((x) => x.key === 'fabric'), 'workflow order: … → Marker → Fabric → Cutting …');

// Fabric flow per spec example
let fab = await call('PUT', `/m/fabricBooking/${fb._id}`, { supplier: supplier._id, bookedQty: 1900, receivedQty: 1895, inspectedQty: 1895, approvedQty: 1895, issuedQty: 1890, usedQty: 1890, deliveryDate: '2026-10-01' });
ok(fab.balanceQty === 5 && fab.closureVerdict === 'READY TO CLOSE / EXCESS BALANCE', `fabric verdict: ${fab.closureVerdict}, balance ${fab.balanceQty}`);
await call('PUT', `/m/fabricBooking/${fb._id}`, { issuedQty: 2000 }, [400]);
ok(true, 'issuing more than approved fabric is blocked');
for (const s of ['Booked', 'In Production', 'In Transit', 'Received', 'Inspected', 'Approved']) await call('POST', `/m/fabricBooking/${fb._id}/status`, { status: s });
for (const t of track.records.trimBooking) {
  const tb = await call('GET', `/m/trimBooking/${t._id}`);
  await call('PUT', `/m/trimBooking/${t._id}`, { bookedQty: tb.bookingQty, receivedQty: tb.bookingQty, issuedQty: tb.bookingQty });
  for (const s of ['Booked', 'In Transit', 'Received']) await call('POST', `/m/trimBooking/${t._id}/status`, { status: s });
}
for (const s of track.records.sample) for (const st of ['Submitted', 'Buyer Review', 'Approved']) await call('POST', `/m/sample/${s._id}/status`, { status: st });
const ppm = track.records.ppMeeting[0];
await call('POST', `/m/ppMeeting/${ppm._id}/status`, { status: 'Held' });
const plan = track.records.productionPlan[0];
await call('PUT', `/m/productionPlan/${plan._id}`, { line: 'Line 1', operators: 40, sam: 6.5, plannedStart: '2026-10-05' });
await call('POST', `/m/productionPlan/${plan._id}/status`, { status: 'Approved' });

// Over-cutting is blocked
await call('POST', '/m/cutting', { job: job.jobNo, entryDate: '2026-10-06', ratio: 'S:2,M:4,L:4', plies: 1200, fabricIssued: 1890, fabricUsed: 1850 }, [400]);
ok(true, 'cutting beyond order + tolerance is blocked');
const cut = await call('POST', '/m/cutting', { job: job.jobNo, entryDate: '2026-10-06', marker: mk._id, plies: 1000, fabricIssued: 1890, fabricUsed: 1850 });
ok(cut.cutQty === 10000 && cut.jobNo === job.jobNo && cut.buyerName === 'Nordic Apparel AB', 'cutting qty from ratio × plies, job data denormalised');
ok(cut.ratio === 'S:2,M:4,L:4' && cut.markerNo === 'MK-1' && cut.markerLength === 5.5 && cut.markerEfficiencyPct === 82, 'cutting pulled ratio and lay data from the approved marker');
ok((await call('GET', `/m/marker/${mk._id}`)).status === 'Issued to Cutting', 'marker moved to Issued to Cutting');
await call('POST', '/m/sewing', { job: job.jobNo, entryDate: '2026-10-08', line: 'Line 1', operators: 40, sam: 6.5, workingMinutes: 480, targetQty: 1800, manualOutput: 10001 }, [400]);
ok(true, 'sewing above cut qty blocked');
const sew = await call('POST', '/m/sewing', { job: job.jobNo, entryDate: '2026-10-08', line: 'Line 1', operators: 40, sam: 6.5, workingMinutes: 480, targetQty: 1800, manualOutput: 10000, checkedQty: 10000, defects: 250 });
ok(sew.efficiencyPct === Math.round(10000 * 6.5 / (40 * 480) * 10000) / 100 && sew.dhu === 2.5, `sewing efficiency ${sew.efficiencyPct}% DHU ${sew.dhu}`);
await call('POST', '/m/finishing', { job: job.jobNo, entryDate: '2026-10-12', inputQty: 10000, passedQty: 9950, rejection: 50, needleCheckedQty: 9900, needleFailQty: 2 }, [400]);
ok(true, 'only needle-detector cleared pieces can pass');
await call('POST', '/m/finishing', { job: job.jobNo, entryDate: '2026-10-12', inputQty: 10000, passedQty: 9950, rejection: 0, rework: 0, needleCheckedQty: 10000, needleFailQty: 2 }, [400]);
ok(true, 'metal-detected pieces must be rejected or reworked');
await call('POST', '/m/finishing', { job: job.jobNo, entryDate: '2026-10-12', inputQty: 10000, passedQty: 9950, rejection: 50, ironedQty: 10000, needleCheckedQty: 10000, needleFailQty: 2 });
const pk = await call('POST', '/m/packing', { job: job.jobNo, packingDate: '2026-10-14', rows: [{ color: 'Navy', ratio: 'S:2,M:4,L:4', cartonFrom: 1, cartonTo: 995, netWtPerCarton: 8, grossWtPerCarton: 9, length: 60, width: 40, height: 30 }] });
ok(pk.totalQty === 9950 && pk.totalCartons === 995 && Math.abs(pk.totalCbm - 71.64) < 0.01, `packing list: ${pk.totalCartons} ctns, ${pk.totalQty} pcs, ${pk.totalCbm} CBM`);
await call('POST', `/m/packing/${pk._id}/status`, { status: 'Packed' });
const insp = await call('POST', '/m/inspection', { job: job.jobNo, inspectionDate: '2026-10-15', inspector: 'QA-1', lotSize: 9950, majorDefects: 4, minorDefects: 8 });
ok(insp.sampleSize === 200 && insp.aqlResult === 'Passed', `AQL sample ${insp.sampleSize}, result ${insp.aqlResult}`);
await call('POST', `/m/inspection/${insp._id}/status`, { status: 'Inspection' });
await call('POST', `/m/inspection/${insp._id}/status`, { status: 'Passed' });
await call('POST', '/m/shipment', { job: job.jobNo, shipmentDate: '2026-10-20', qty: 10001 }, [400]);
ok(true, 'shipment above order qty blocked');
const shp = await call('POST', '/m/shipment', { job: job.jobNo, invoiceNo: 'INV-26-001', blAwbNo: 'MAEU123' });
ok(shp.qty === 9950 && shp.cartons === 995, 'shipment pulled qty/cartons from packing automatically');
for (const s of ['Booked', 'Stuffed', 'Shipped']) await call('POST', `/m/shipment/${shp._id}/status`, { status: s });

track = await call('GET', `/jobs/track/${job.jobNo}`);
ok(track.lifecycle.stages.shipment === 'done', 'shipment stage done (within short-ship tolerance)');
await call('POST', `/jobs/${job._id}/close`, {}, [400]);
ok(true, 'job cannot close while documentation/accounts/payment pending');

const inv = await call('POST', '/m/invoice', { job: job.jobNo, shipment: shp._id, invoiceDate: '2026-10-21', dueDate: '2026-11-20' });
ok(inv.qty === 9950 && inv.invoiceNo === 'INV-26-001', 'invoice pulled qty & no from shipment; unit price from order');
await call('POST', `/m/invoice/${inv._id}/status`, { status: 'Issued' });
await call('POST', '/m/payment', { job: job.jobNo, invoice: inv._id, paymentDate: '2026-11-01', amount: inv.totalAmount + 1 }, [400]);
ok(true, 'payment above invoice blocked');
await call('POST', '/m/payment', { job: job.jobNo, invoice: inv._id, paymentDate: '2026-11-01', amount: 10000 });
let i2 = await call('GET', `/m/invoice/${inv._id}`);
ok(i2.status === 'Partial' && i2.outstanding === Math.round((inv.totalAmount - 10000) * 100) / 100, `invoice partial, outstanding ${i2.outstanding}`);
await call('POST', '/m/payment', { job: job.jobNo, invoice: inv._id, paymentDate: '2026-11-15', amount: i2.outstanding });
i2 = await call('GET', `/m/invoice/${inv._id}`);
ok(i2.status === 'Fully Paid', 'invoice fully paid');
await call('POST', '/m/expense', { job: job.jobNo, category: 'Freight', expenseDate: '2026-10-20', amount: 1200 });

// Documents (simulate uploads)
for (const docType of ['Commercial Invoice', 'Packing List']) {
  const fd = new FormData();
  fd.append('job', job.jobNo); fd.append('docType', docType); fd.append('title', docType);
  fd.append('file', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), `${docType}.pdf`);
  const res = await fetch(`${BASE}/documents`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  ok(res.status === 201, `uploaded ${docType}`);
}
const ppmDoc = await call('GET', `/m/ppMeeting/${ppm._id}`);
track = await call('GET', `/jobs/track/${job.jobNo}`);
console.log('    stages:', JSON.stringify(track.lifecycle.stages));
console.log('    blockers:', track.lifecycle.blockers);
ok(track.lifecycle.readyToClose, 'JOB READY FOR CLOSURE');
ok(track.profit.actualProfit < track.profit.revenue && track.profit.revenue > 0, `profit: revenue ${track.profit.revenue}, actual ${track.profit.actualProfit}, expected ${track.profit.expectedProfit}`);
const closed = await call('POST', `/jobs/${job._id}/close`, { remarks: 'All complete' });
ok(closed.status === 'Closed', 'JOB CLOSED');
await call('POST', `/m/fabricBooking/${fb._id}/status`, { status: 'Fabric Job Closed' });
ok(true, 'fabric job closed');

// Forecast / sub jobs
const fj = await call('POST', '/jobs', { buyer: buyer._id, poNo: 'FC-2026', styleNo: 'NA-FC-1', orderDate: '2026-09-20', orderQty: 30000, unitPrice: 3.2, shipmentDate: '2027-03-01', isForecast: true, forecastQty: 30000, consumption: 0.2, fabricType: 'Fleece' });
const subs = await call('POST', `/jobs/${fj._id}/subjobs`, { subJobs: [{ orderQty: 10000 }, { orderQty: 8000 }, { orderQty: 12000 }] });
ok(subs.map((s) => s.jobNo).join() === `${fj.jobNo}-S01,${fj.jobNo}-S02,${fj.jobNo}-S03`, `sub jobs ${subs.map((s) => s.jobNo).join(', ')}`);
const ffc = await call('GET', `/m/fabricForecast?job=${fj.jobNo}`);
ok(ffc.total === 1 && ffc.rows[0].jobNo === fj.jobNo && ffc.rows[0].forecastQty === 6000, `forecast main job has its fabric forecast (${ffc.rows[0]?.forecastQty} ${ffc.rows[0]?.unit})`);
await call('POST', `/jobs/${fj._id}/subjobs`, { subJobs: [{ orderQty: 1 }] }, [400]);
ok(true, 'sub job total cannot exceed forecast qty');
const ft = await call('GET', `/jobs/track/${fj.jobNo}`);
ok(ft.job.orderQty === 30000 && ft.lifecycle.meta.subJobs.length === 3, 'main job qty = sum of sub jobs');
const sfb = await call('GET', `/m/fabricBooking?job=${subs[0].jobNo}`);
ok(sfb.rows[0]?.requiredQty === 2000, `sub job S01 has its own fabric requirement (${sfb.rows[0]?.requiredQty})`);

// Order change impact
const upd = await call('PUT', `/jobs/${subs[1]._id}`, { consumption: 0.22 });
ok(upd.impact.some((x) => x.module === 'Fabric Booking'), `order change impact: ${JSON.stringify(upd.impact)}`);

// RBAC: create fabric user and check backend enforcement
const roles = await call('GET', '/admin/roles');
const fabRole = roles.rows.find((x) => x.name === 'Fabric Department');
await call('POST', '/admin/users', { name: 'Fabric User', email: 'fabric@test.com', password: 'Fabric@123', role: fabRole._id });
const adminToken = token; token = ''; cookie = '';
r = await call('POST', '/auth/login', { email: 'fabric@test.com', password: 'Fabric@123' }); token = r.accessToken;
r = await call('POST', '/auth/change-password', { currentPassword: 'Fabric@123', newPassword: 'Fabric@1234' }); token = r.accessToken;
ok(r.user.units.map((u) => u.code).join() === 'U1', 'new user assigned to the creating admin\'s unit only');
await call('POST', '/auth/select-unit', { unit: 'U2' }, [403]);
ok(true, 'user cannot enter a unit that is not assigned');
r = await call('POST', '/auth/select-unit', { unit: 'U1' }); token = r.accessToken;
await call('GET', '/reports/order-status?unit=ALL', null, [403]);
ok(true, 'single-unit user cannot open consolidated reports');
await call('GET', '/m/fabricBooking');
await call('POST', '/m/payment', { job: job.jobNo, invoice: inv._id, amount: 1 }, [403]);
await call('GET', '/admin/users', null, [403]);
await call('POST', `/jobs/${fj._id}/subjobs`, { subJobs: [{ orderQty: 1 }] }, [403]);
ok(true, 'backend RBAC blocks payment, user admin and sub-job control for fabric user');
token = adminToken;

const audit = await call('GET', `/admin/audit?jobNo=${job.jobNo}&limit=5`);
ok(audit.total > 10, `audit trail has ${audit.total} entries for ${job.jobNo}`);
console.log('    e.g.', audit.rows.find((a) => a.action === 'UPDATE')?.message);
const dash = await call('GET', '/dashboard');
ok(dash.summary.activeJobs >= 3, `dashboard: ${JSON.stringify(dash.summary)}`);
const rep = await call('GET', '/reports/fabric-balance');
ok(rep.rows.length >= 4, 'fabric balance report');
const bomRep = await call('GET', `/reports/bom?job=${job.jobNo}`);
ok(bomRep.rows.length === 4 && bomRep.rows.every((x) => x.bookingRef !== 'NOT BOOKED'), 'BOM report: one row per material line, all booked');
const mkRep = await call('GET', `/reports/marker?job=${job.jobNo}`);
ok(mkRep.rows[0]?.consumptionVariancePct === 0.61, 'marker consumption report');
ok((await call('GET', '/search?q=MK-1')).results.some((x) => x.type === 'Marker'), 'global search finds markers');
ok(dash.kpis.preproduction && dash.kpis.preproduction.bomApprovedPct >= 0, `dashboard pre-production KPIs: ${JSON.stringify(dash.kpis.preproduction)}`);
const s = await call('GET', '/search?q=PO-77881');
ok(s.results.some((x) => x.jobNo === job.jobNo), 'global search by PO');
const csv = await fetch(`${BASE}/reports/order-status?format=xlsx`, { headers: { Authorization: `Bearer ${token}` } });
ok(csv.status === 200 && csv.headers.get('content-type').includes('spreadsheet'), 'excel export');

// ---------- Two units: separate data, separate job series, consolidated admin view ----------
const u1Token = token;
r = await call('POST', '/auth/select-unit', { unit: 'U2' }); token = r.accessToken;
ok(r.user.unit.code === 'U2', 'admin switched to Unit-2');
await call('GET', `/jobs/track/${job.jobNo}`, null, [404]);
ok((await call('GET', '/m/fabricBooking')).total === 0 && (await call('GET', '/m/orders')).total === 0, 'Unit-2 sees none of Unit-1\'s jobs or fabric');
ok(!(await call('GET', '/search?q=PO-77881')).results.length, 'global search does not cross units');
ok((await call('GET', '/dashboard')).summary.activeJobs === 0, 'Unit-2 dashboard is empty');
await call('PUT', `/m/fabricBooking/${fb._id}`, { bookedQty: 1 }, [404]);
await call('POST', '/m/cutting', { job: job.jobNo, entryDate: '2026-10-06', manualCutQty: 1 }, [400]);
ok(true, 'Unit-2 cannot edit Unit-1 records or post entries against Unit-1 jobs');
const u2a = await call('POST', '/jobs', { buyer: buyer._id, poNo: 'PO-77881', styleNo: 'NA-TS-101', orderDate: '2026-10-01', orderQty: 5000, unitPrice: 2.1, shipmentDate: '2027-01-15', consumption: 0.2, fabricType: 'Pique' });
const u2b = await call('POST', '/jobs', { buyer: buyer._id, poNo: 'PO-U2-2', styleNo: 'U2-ST-2', orderDate: '2026-10-02', orderQty: 1000, unitPrice: 3, shipmentDate: '2027-02-01' });
ok(u2a.jobNo === 'U2-3000' && u2b.jobNo === 'U2-3001' && u2a.businessUnit === 'U2', `Unit-2 job series: ${u2a.jobNo}, ${u2b.jobNo}`);
const u2Track = await call('GET', `/jobs/track/${u2a.jobNo}`);
ok(u2Track.records.bom.length === 1 && u2Track.records.fabricBooking.length === 1 && u2Track.records.tna.length === 1, 'Unit-2 job runs the same workflow (T&A, BOM, fabric generated)');
ok((await call('GET', `/m/fabricBooking/${u2Track.records.fabricBooking[0]._id}`)).businessUnit === 'U2', 'generated records belong to Unit-2');
await call('GET', '/reports/order-status?unit=U1');
const u2Units = await call('GET', '/admin/units');
ok(u2Units.rows.find((u) => u.code === 'U2').nextJobNo === 3002 && u2Units.rows.find((u) => u.code === 'U1').nextJobNo === 1002, 'Admin sees both series: next U1-1002, U2-3002');
await call('PUT', '/admin/units/U2', { nextJobNo: 3001 }, [400]);
ok(true, 'a job series cannot be moved backwards');
await call('PUT', '/admin/units/U2', { nextJobNo: 3500 });
ok((await call('POST', '/jobs', { buyer: buyer._id, poNo: 'PO-U2-3', styleNo: 'U2-ST-3', orderDate: '2026-10-03', orderQty: 100, unitPrice: 3, shipmentDate: '2027-02-01' })).jobNo === 'U2-3500', 'Admin moved the Unit-2 series forward to U2-3500');

token = u1Token;
await call('GET', `/jobs/track/${u2a.jobNo}`, null, [404]);
ok(!(await call('GET', '/m/orders')).rows.some((x) => x.businessUnit !== 'U1'), 'Unit-1 sees only Unit-1 jobs');
ok((await call('POST', '/jobs', { buyer: buyer._id, poNo: 'PO-U1-9', styleNo: 'U1-ST-9', orderDate: '2026-10-04', orderQty: 100, unitPrice: 3, shipmentDate: '2027-02-01' })).jobNo === 'U1-1002', 'Unit-1 series continues independently (U1-1002)');
const own = await call('GET', '/reports/order-status');
const onlyU2 = await call('GET', '/reports/order-status?unit=U2');
const both = await call('GET', '/reports/order-status?unit=ALL');
ok(own.rows.every((x) => x.businessUnit === 'U1') && onlyU2.rows.every((x) => x.businessUnit === 'U2') && onlyU2.rows.length === 3, 'unit-level reports never mix units');
ok(both.rows.length === own.rows.length + onlyU2.rows.length && both.columns[0].label === 'Unit', `consolidated report: ${both.rows.length} jobs with a Unit column`);
ok((await call('GET', '/reports/order-status?unit=ALL&style=NA-TS-101')).rows.length === 2, 'style-wise filter across both units');
ok((await call('GET', '/dashboard?unit=ALL')).summary.activeJobs > (await call('GET', '/dashboard')).summary.activeJobs, 'consolidated dashboard for admin');
const au = await call('GET', '/admin/audit?unit=ALL&action=UNIT_SWITCH');
ok(au.total >= 1, 'unit switches are audited');
const u1Audit = await call('GET', `/admin/audit?jobNo=${u2a.jobNo}`);
ok(u1Audit.total === 0, 'Unit-1 audit view does not show Unit-2 history');


// ---------- Management analytics: Revenue → COGS → EBITDA → Net, inventory → ITR → holding days, ROI ----------
// Deterministic Unit-2 job, values worked out by hand:
//   1,000 pcs × 10.00 = revenue 10,000 · fabric 200 kg × 5 = 1,000 · polybags 1,000 × 0.10 = 100 · sewing 2,000 · freight 300
//   COGS / pc = (1,000 + 100 + 2,000) / 1,000 = 3.10 → COGS 3,100 · opex = freight 300 + admin 400 = 700
//   EBITDA = 10,000 − 3,100 − 700 = 6,200 · Net = 6,200 − interest 100 − tax 200 − depreciation 150 − amortization 50 = 5,700
//   ROI = (10,000 − 3,400) ÷ 3,400 = 194.12 % · closing inventory = 50 kg fabric × 5 = 250 → ITR = 3,100 ÷ 125 = 24.8
{ // block scope keeps these names apart from the lifecycle test above
r = await call('POST', '/auth/select-unit', { unit: 'U2' }); token = r.accessToken;
const aj = await call('POST', '/jobs', { buyer: buyer._id, poNo: 'AN-PO-1', styleNo: 'AN-ST-1', product: 'Polo Shirt', orderDate: '2026-01-05', orderQty: 1000, unitPrice: 10, shipmentDate: '2026-03-31', consumption: 0.2, consumptionUnit: 'KG', fabricType: 'Jersey', fabricRate: 5, sizeBreakdown: [{ color: 'Red', size: 'M', qty: 600 }, { color: 'Blue', size: 'M', qty: 400 }], trims: [{ item: 'Polybag', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 0, rate: 0.1 }] });
const at = await call('GET', `/jobs/track/${aj.jobNo}`);
const afb = at.records.fabricBooking[0]; const atb = at.records.trimBooking[0];
await call('PUT', `/m/fabricBooking/${afb._id}`, { bookedQty: 200, receivedQty: 200, inspectedQty: 200, approvedQty: 200 });
await call('PUT', `/m/fabricBooking/${afb._id}`, { issuedQty: 150 });
await call('PUT', `/m/trimBooking/${atb._id}`, { bookedQty: 1000, receivedQty: 1000, issuedQty: 1000 });
await call('POST', '/m/cutting', { job: aj.jobNo, entryDate: '2026-02-01', manualCutQty: 1000 });
await call('POST', '/m/sewing', { job: aj.jobNo, entryDate: '2026-02-05', line: 'L9', operators: 10, sam: 5, workingMinutes: 480, manualOutput: 1000, rejection: 4 });
await call('POST', '/m/finishing', { job: aj.jobNo, entryDate: '2026-02-10', inputQty: 1000, passedQty: 1000 });
await call('POST', '/m/packing', { job: aj.jobNo, packingDate: '2026-02-12', rows: [{ cartonFrom: 1, cartonTo: 100, pcsPerCarton: 10 }] });
const ash = await call('POST', '/m/shipment', { job: aj.jobNo, invoiceNo: 'AN-INV-1', shipmentDate: '2026-02-20', actualShipDate: '2026-02-20' });
for (const st of ['Booked', 'Stuffed', 'Shipped']) await call('POST', `/m/shipment/${ash._id}/status`, { status: st });
const ainv = await call('POST', '/m/invoice', { job: aj.jobNo, shipment: ash._id, invoiceDate: '2026-02-25', dueDate: '2026-03-25' });
await call('POST', `/m/invoice/${ainv._id}/status`, { status: 'Issued' });
await call('POST', '/m/expense', { job: aj.jobNo, category: 'Sewing / CMT', expenseDate: '2026-02-05', amount: 2000 });
await call('POST', '/m/expense', { job: aj.jobNo, category: 'Freight', expenseDate: '2026-02-21', amount: 300 });
for (const [category, amount] of [['Admin Expense', 400], ['Interest', 100], ['Tax', 200], ['Depreciation', 150], ['Amortization', 50]]) {
  await call('POST', '/m/expense', { category, expenseDate: '2026-03-01', amount, description: `Company ${category}` });
}
ok(true, 'company-level expenses (no Job No) accepted for interest, tax, depreciation, amortization, admin');
const today = new Date().toISOString().slice(0, 10);
const P = `from=2026-01-01&to=${today}`;
const days = Math.round((Date.parse(`${today}T23:59:59.999Z`) + 1 - Date.parse('2026-01-01T00:00:00Z')) / 86400000);
const fin = await call('GET', `/analytics/finance?${P}`);
ok(fin.revenue === 10000 && fin.cogs === 3100 && fin.operatingExpenses === 700, `revenue ${fin.revenue}, COGS ${fin.cogs}, operating expenses ${fin.operatingExpenses}`);
ok(fin.ebitda === 6200 && fin.netProfit === 5700 && fin.ebitdaCheck === fin.ebitda, `EBITDA ${fin.ebitda} = net ${fin.netProfit} + I ${fin.interest} + T ${fin.taxes} + D ${fin.depreciation} + A ${fin.amortization}`);
ok(fin.sources.sales[0].jobNo === aj.jobNo && fin.sources.absorbed.length === 1 && fin.sources.interest[0].amount === 100, 'finance drill-down lists invoices (with Job No), absorbed job costs and finance lines');
const inv = await call('GET', `/analytics/inventory?${P}`);
const fab = inv.categories.find((c) => c.category === 'Fabric');
ok(inv.opening === 0 && inv.closing === 250 && inv.average === 125 && inv.itr === 24.8, `ITR ${inv.itr}x = COGS ${inv.cogs} ÷ avg inventory ${inv.average} (opening ${inv.opening}, closing ${inv.closing})`);
ok(inv.holdingDays === Math.round(250 / (3100 / days)) && fab.consumption === 750 && fab.holdingDays === Math.round(250 / (750 / days)), `holding period ${inv.holdingDays} days overall, fabric ${fab.holdingDays} days (${days}-day period)`);
const pkg = inv.categories.find((c) => c.category === 'Packing Materials');
ok(pkg.closing === 0 && pkg.holdingDays === 0 && inv.categories.find((c) => c.category === 'Yarn & Grey Fabric').itr === null, 'zero inventory / zero consumption give 0 or "not computable" – never Infinity');
ok(inv.closingDetail.materials.some((m) => m.refNo === afb.refNo && m.qty === 50) && inv.movements.some((m) => m.refNo === afb.refNo && m.direction === 'out' && m.qty === 150), 'stock ledger movements behind the figures (fabric issue 150 kg)');
const rs = await call('GET', `/analytics/roi?${P}&by=style`);
const st1 = rs.rows.find((x) => x.key === 'AN-ST-1');
ok(st1 && st1.revenue === 10000 && st1.cost === 3400 && st1.profit === 6600 && st1.roiPct === 194.12 && st1.jobs[0].jobNo === aj.jobNo, `style ROI ${st1?.roiPct}% (profit 6,600 ÷ cost 3,400) → job ${st1?.jobs[0].jobNo}`);
const rc = await call('GET', `/analytics/roi?${P}&by=color`);
ok(rc.rows.find((x) => x.key === 'Red').revenue === 6000 && rc.rows.find((x) => x.key === 'Blue').profit === 2640, 'colour ROI allocates by the colour/size breakdown (Red 60 %, Blue 40 %)');
const vr = await call('GET', `/analytics/variance?${P}`);
const vj = vr.jobs.find((x) => x.jobNo === aj.jobNo);
ok(vj.actualCost === 3400 && vj.rejectedQty === 4 && vj.rejectionLoss === 12.4 && vr.heads.find((h) => h.key === 'sewing').actual >= 2000, `cost variance by head; quality loss ${vj.rejectionLoss} (4 rejected × 3.10)`);
const op = await call('GET', `/analytics/operations?${P}`);
const oj = op.rows.find((x) => x.jobNo === aj.jobNo);
ok(oj.fabric.received === 200 && oj.fabric.issued === 150 && oj.production.produced === 1000 && oj.production.efficiencyPct === 104.17 && oj.shipment.shipped === 1000 && oj.shipment.onTime === true && oj.shipment.value === 10000, 'fabric, production (eff 104.17 %) and shipment performance per job');
const sm = await call('GET', `/analytics/summary?${P}`);
ok(sm.finance.ebitda === 6200 && sm.inventory.itr === 24.8 && sm.roi.topStyle.key === 'AN-ST-1' && sm.currency === 'USD', 'dashboard summary returns the same figures in the base currency');
// unit separation & consolidation
const u1fin = await call('GET', `/analytics/finance?${P}&unit=U1`);
const allfin = await call('GET', `/analytics/finance?${P}&unit=ALL`);
ok(!u1fin.sources.sales.some((x) => x.jobNo === aj.jobNo) && allfin.revenue === r2(u1fin.revenue + fin.revenue), `unit-wise finance kept apart; consolidated revenue ${allfin.revenue} = U1 ${u1fin.revenue} + U2 ${fin.revenue}`);
// change the data → KPIs move
await call('PUT', `/m/fabricBooking/${afb._id}`, { issuedQty: 200 });
ok((await call('GET', `/analytics/inventory?${P}`)).closing === 0, 'issuing the remaining fabric recalculates closing inventory to 0');
// permissions: non-admin needs an explicit grant
token = u1Token;
const fabUser = (await call('GET', '/admin/users?q=fabric@test.com')).rows[0];
const adminTok = token;
token = ''; cookie = '';
r = await call('POST', '/auth/login', { email: 'fabric@test.com', password: 'Fabric@1234' }); token = r.accessToken;
r = await call('POST', '/auth/select-unit', { unit: 'U1' }); token = r.accessToken;
await call('GET', `/analytics/summary?${P}`, null, [403]);
ok(true, 'non-admin user without the analytics permission is refused');
const fabTok = token; token = adminTok;
await call('PUT', `/admin/users/${fabUser._id}`, { permissions: { analytics: ['view'] } });
token = fabTok;
ok((await call('GET', `/analytics/summary?${P}`)).scope === 'U1', 'explicit analytics grant opens the drill-down (in the user\'s own unit)');
await call('GET', `/analytics/summary?${P}&unit=U2`, null, [403]);
ok(true, 'granted user still cannot read another unit');
token = adminTok;
}


// ---------- Module structure: job type, order revision, roll-level fabric, BOM balance, defects, operators, reports ----------
{
const bj = await call('POST', '/jobs', { buyer: buyer._id, poNo: 'RL-PO-1', styleNo: 'RL-TS-9', product: 'Rib Tee', orderDate: '2026-09-25', orderQty: 1000, unitPrice: 5, shipmentDate: '2026-12-20', consumption: 1, consumptionUnit: 'Meter', fabricType: 'Rib Jersey', fabricRate: 2 });
ok(bj.jobType === 'Main Job' && bj.revision === 0 && /^U1-1\d{3}$/.test(bj.jobNo), `job type ${bj.jobType}, revision ${bj.revision}, ${bj.jobNo}`);
const rev = await call('PUT', `/jobs/${bj._id}`, { orderQty: 1100 });
ok(rev.job.revision === 1 && rev.job.revisions[0].fields.includes('orderQty'), 'order revision 1 recorded for the quantity change');
let bt = await call('GET', `/jobs/track/${bj.jobNo}`);
const bfb = bt.records.fabricBooking[0];
ok(bfb.requiredQty === 1100, `fabric requirement follows the revised order (${bfb.requiredQty} m)`);
const rc = await call('POST', '/m/fabricReceipt', { job: bj.jobNo, booking: bfb._id, receiptDate: '2026-10-02', supplierDc: 'DC-7781', rolls: [
  { rollNo: 'R1', lotNo: 'L-55', shade: 'A', width: 60, gsm: 200, qty: 600, points: 10 },
  { rollNo: 'R2', lotNo: 'L-55', shade: 'A', width: 60, gsm: 200, qty: 500, points: 6 },
  { rollNo: 'R3', lotNo: 'L-56', shade: 'B', width: 60, gsm: 200, qty: 100, points: 80 } ] });
ok(rc.totalRolls === 3 && rc.rolls[2].result === 'Fail' && rc.passedQty === 1100 && rc.rejectedQty === 100, `4-point: roll R3 ${rc.rolls[2].pointsPer100} pts/100 sq yd fails; passed ${rc.passedQty} m`);
await call('POST', '/m/fabricReceipt', { job: bj.jobNo, booking: bfb._id, receiptDate: '2026-10-03', rolls: [{ rollNo: 'R2', qty: 10 }] }, [409]);
ok(true, 'the same roll cannot be received twice');
await call('POST', '/m/fabricAllocation', { job: bj.jobNo, booking: bfb._id, allocationDate: '2026-10-04', rolls: [{ rollNo: 'R1', qty: 600 }] }, [400]);
ok(true, 'allocation needs an approved receipt');
for (const st of ['Inspected', 'Approved']) await call('POST', `/m/fabricReceipt/${rc._id}/status`, { status: st });
let bk = await call('GET', `/m/fabricBooking/${bfb._id}`);
ok(bk.receivedQty === 1200 && bk.inspectedQty === 1200 && bk.approvedQty === 1100 && bk.status === 'Approved', `booking follows the rolls: received ${bk.receivedQty}, approved ${bk.approvedQty}, status ${bk.status}`);
await call('POST', '/m/fabricAllocation', { job: bj.jobNo, booking: bfb._id, allocationDate: '2026-10-04', rolls: [{ rollNo: 'R3', qty: 100 }] }, [400]);
ok(true, 'a failed roll cannot be allocated');
const al = await call('POST', '/m/fabricAllocation', { job: bj.jobNo, booking: bfb._id, allocationDate: '2026-10-04', cuttingTable: 'Table 2', rolls: [{ rollNo: 'R1', qty: 600 }] });
ok(al.rolls[0].lotNo === 'L-55' && al.totalQty === 600, 'roll allocated with its lot');
await call('POST', '/m/fabricAllocation', { job: bj.jobNo, booking: bfb._id, allocationDate: '2026-10-05', rolls: [{ rollNo: 'R1', qty: 1 }] }, [400]);
ok(true, 'a roll cannot be allocated beyond its quantity');
bk = await call('GET', `/m/fabricBooking/${bfb._id}`);
ok(bk.reservedQty === 600 && !bk.issuedQty && bk.freeQty === bk.balanceQty - 600, `allocated rolls are reserved, not issued (reserved ${bk.reservedQty}, issued ${bk.issuedQty}, free ${bk.freeQty})`);
await call('POST', `/m/fabricAllocation/${al._id}/status`, { status: 'Issued to Cutting' });
bk = await call('GET', `/m/fabricBooking/${bfb._id}`);
ok(bk.issuedQty === 600 && !bk.reservedQty, 'issuing the reservation moves it to issued');
await call('PUT', `/m/fabricBooking/${bfb._id}`, { receivedQty: 5, issuedQty: 1 });
const bk2 = await call('GET', `/m/fabricBooking/${bfb._id}`);
ok(bk.issuedQty === 600 && bk2.receivedQty === 1200 && bk2.issuedQty === 600, 'received / issued come from rolls and cannot be typed over');
const bbom = await call('GET', `/m/bom/${bt.records.bom[0]._id}`);
const bline = bbom.lines.find((l) => l.bookingRef === bfb.refNo);
ok(bline.receivedQty === 1200 && bline.issuedQty === 600 && bline.balanceQty === 600, `BOM line: required ${bline.requiredQty} → received ${bline.receivedQty} → issued ${bline.issuedQty} → balance ${bline.balanceQty}`);
const insp = await call('POST', '/m/inspection', { job: bj.jobNo, inspectionDate: '2026-10-06', inspectionType: 'End-line', lotSize: 1000, defectLines: [{ defectType: 'Broken stitch', severity: 'Major', count: 3 }, { defectType: 'Loose thread', severity: 'Minor', count: 4 }, { defectType: 'Stain / spot', severity: 'Minor', count: 1 }] });
ok(insp.majorDefects === 3 && insp.minorDefects === 5 && insp.totalDefects === 8, 'end-line inspection: defects by type roll up to major 3 / minor 5');
const sw = await call('POST', '/m/cutting', { job: bj.jobNo, entryDate: '2026-10-06', manualCutQty: 500, fabricIssued: 520, fabricUsed: 510 });
const sew = await call('POST', '/m/sewing', { job: bj.jobNo, entryDate: '2026-10-07', line: 'Line 4', operators: 2, sam: 5, workingMinutes: 480, manualOutput: 150, operatorOutput: [{ empCode: 'E-101', operatorName: 'S. Kavitha', operation: 'Side seam', smv: 0.8, pieces: 420 }] });
ok(sw.cutQty === 500 && sew.operatorOutput[0].effPct === 70, `operator production: ${sew.operatorOutput[0].operatorName} ${sew.operatorOutput[0].effPct}% efficiency`);
const shpB = await call('GET', `/m/shipment/${shp._id}`);
ok(shpB.balanceQty === 50, `shipment shows the order balance (${shpB.balanceQty} pcs)`);
const R = async (key, q = '') => (await call('GET', `/reports/${key}${q}`)).rows;
const jc = (await R('job-close', `?job=${bj.jobNo}`))[0];
ok(jc && jc.mainJob === bj.jobNo && jc.fabricReceived === 1200 && jc.checklist.includes('✗ Cutting') && jc.accountsStatus === 'Not invoiced', `job close report: ${jc?.checklist.slice(0, 60)}…`);
const closedRows = await R('closed-jobs');
ok(closedRows.some((x) => x.jobNo === job.jobNo && x.closedByName === 'System Administrator'), 'closed job report shows closed by');
ok((await R('pending-jobs')).some((x) => x.jobNo === bj.jobNo && x.blockers), 'pending job report lists open jobs with their blockers');
ok((await R('main-sub')).some((x) => x.subJob && x.mainJob && x.jobType === 'Sub Job'), 'main job / sub job report');
ok((await R('fabric-receipt', `?job=${bj.jobNo}`)).length === 3 && (await R('fabric-allocation', `?job=${bj.jobNo}`)).length === 1, 'roll-wise fabric receipt and allocation reports');
const fc = (await R('fabric-consumption', `?job=${bj.jobNo}`))[0];
ok(fc.cutQty === 500 && fc.actualPerPc === 1.02 && fc.variancePct === 2, `fabric consumption: planned ${fc.plannedPerPc} vs actual ${fc.actualPerPc} m/pc (${fc.variancePct}%)`);
ok((await R('sales')).length >= 1 && (await R('accounts')).some((x) => x.jobNo === job.jobNo && x.purchaseCost > 0), 'sales and job-wise accounts reports');
ok((await R('buyer-history')).some((x) => x.buyerName === 'Nordic Apparel AB' && x.jobs >= 2), 'buyer history report');
ok((await R('operator-production', `?job=${bj.jobNo}`))[0]?.empCode === 'E-101', 'operator production report');
ok((await R('dashboard')).some((x) => x.stage === 'Closed'), 'dashboard report (jobs by stage)');
const allDash = await call('GET', '/dashboard');
const byBuyer = await call('GET', '/dashboard?buyer=Nordic%20Apparel%20AB');
ok(allDash.lists.buyers.includes('Nordic Apparel AB') && byBuyer.summary.activeJobs <= allDash.summary.activeJobs && Array.isArray(byBuyer.lists.pendingActivities), `buyer-wise dashboard (${byBuyer.summary.activeJobs} active jobs) with pending activities`);
ok((await call('GET', '/lookup/master/Defect%20Type')).length >= 10 && (await call('GET', '/lookup/master/Warehouse')).length >= 3, 'defect type and warehouse masters available');

// fabric returns and debit notes (Fabric Department) and the consolidated Job Closure Report
await call('PUT', `/m/fabricBooking/${bfb._id}`, { supplier: supplier._id, supplierPoNo: 'AM/RL/77', bookingDate: '2026-09-27', bookedQty: 1100, rate: 2 });
const ret1 = await call('POST', '/m/fabricReturn', { job: bj.jobNo, booking: bfb._id, returnType: 'Fabric Store → Supplier (rejected / excess)', returnDate: '2026-10-05', referenceDoc: 'RC-101', rollNos: 'R3', qty: 100, reason: 'Failed 4-point' });
let fb2 = await call('GET', `/m/fabricBooking/${bfb._id}`);
ok(ret1.amount === 200 && fb2.returnedToSupplierQty === 100 && fb2.netReceivedQty === 1100 && fb2.balanceQty === 500, `rejected roll back to the supplier: net received ${fb2.netReceivedQty}, store ${fb2.balanceQty} m`);
await call('POST', '/m/fabricReturn', { job: bj.jobNo, booking: bfb._id, returnType: 'Fabric Store → Supplier (rejected / excess)', returnDate: '2026-10-05', referenceDoc: 'RC-102', qty: 600, reason: 'x' }, [400]);
ok(true, 'cannot return more than the fabric in store');
await call('POST', '/m/fabricReturn', { job: bj.jobNo, booking: bfb._id, returnType: 'Cutting → Fabric Store (unused)', returnDate: '2026-10-08', referenceDoc: 'GP-1', qty: 100, reason: 'x' }, [400]);
ok(true, 'cannot return from cutting more than issued and not used (600 issued − 510 used)');
await call('POST', '/m/fabricReturn', { job: bj.jobNo, booking: bfb._id, returnType: 'Cutting → Fabric Store (unused)', returnDate: '2026-10-08', referenceDoc: 'GP-1', qty: 40, reason: 'End bits' });
fb2 = await call('GET', `/m/fabricBooking/${bfb._id}`);
ok(fb2.returnedFromCuttingQty === 40 && fb2.netIssuedQty === 560 && fb2.balanceQty === 540, `unused fabric back from cutting: net issued ${fb2.netIssuedQty}, store ${fb2.balanceQty} m`);
await call('POST', '/m/fabricDebit', { job: bj.jobNo, booking: bfb._id, debitDate: '2026-10-08', debitTo: 'Department – accountability', reason: 'Excess cutting wastage', qty: 5 }, [400]);
ok(true, 'an accountability debit names the department');
const profitBefore = await call('GET', `/jobs/${bj._id}/profit`);
const dn = await call('POST', '/m/fabricDebit', { job: bj.jobNo, fabricReturn: ret1._id, debitDate: '2026-10-06', debitTo: 'Supplier', reason: 'Rejected fabric (4-point inspection)', otherCharges: 15 });
ok(dn.qty === 100 && dn.rate === 2 && dn.amount === 215 && dn.costImpact === -215 && dn.supplierName, `supplier debit note ${dn.refNo}: ${dn.amount} pulled from the return (${dn.costEffect})`);
ok((await call('GET', `/jobs/track/${bj.jobNo}`)).lifecycle.blockers.some((b) => b.includes('debit note')), 'an unsettled debit note blocks job closure');
await call('POST', `/m/fabricDebit/${dn._id}/status`, { status: 'Accepted' });
const profitAfter = await call('GET', `/jobs/${bj._id}/profit`);
ok(Math.abs(profitBefore.costs.fabric - profitAfter.costs.fabric - 215) < 0.01 && (await call('GET', `/m/fabricBooking/${bfb._id}`)).debitRecovery === 215, `accepted supplier debit reduces the job fabric cost by 215 (${profitBefore.costs.fabric} → ${profitAfter.costs.fabric})`);
const cr = await call('GET', `/jobs/${bj.jobNo}/closure-report`);
const types = new Set(cr.rows.map((x) => x.txType));
ok(['Job Opened', 'Order Revision', 'Fabric Purchase', 'Fabric Inward', 'Fabric Issue', 'Fabric Return', 'Fabric Debit Note', 'Cutting', 'Sewing'].every((x) => types.has(x)), `job closure report lists every transaction (${cr.rows.length} rows)`);
ok(cr.checksPassed && cr.jobs[0].fabric.received === 1200 && cr.jobs[0].fabric.storeBalance === 540, 'job closure report reconciles fabric received / returned / issued / store balance');
ok(cr.rows.every((x, i) => !i || new Date(x.date || 0) >= new Date(cr.rows[i - 1].date || 0)), 'transactions in date order');
}

// ---------- New Orders (buyer POs), advance jobs for repeat / forecast orders, order & job tracking ----------
{
  const bo = await call('POST', '/m/buyerOrder', { orderType: 'New Order', buyer: buyer._id, poNo: 'NOR-PO-9001', styleNo: 'NA-PL-900', product: 'Pique Polo', orderDate: '2026-10-01', deliveryDate: '2027-01-20', shipmentDate: '2026-12-30', orderQty: 1000, unitPrice: 6.5, color: 'White', sizeRatio: 'S:2,M:4,L:3,XL:1' });
  ok(bo.status === 'Received' && bo.jobCreation === 'Awaiting job creation' && bo.orderValue === 6500, `buyer PO ${bo.refNo} received, awaiting job creation`);
  await call('POST', '/m/buyerOrder', { buyer: buyer._id, poNo: 'NOR-PO-9001', styleNo: 'NA-PL-900', orderDate: '2026-10-01', deliveryDate: '2027-01-20', orderQty: 10 }, [409]);
  ok(true, 'duplicate buyer PO / style blocked');
  await call('POST', `/m/buyerOrder/${bo._id}/status`, { status: 'Job Created' }, [400]);
  ok(true, '"Job Created" cannot be set by hand');
  const t0 = await call('GET', '/tracking');
  ok(t0.lists.awaitingJob.some((x) => x._id === bo._id) && t0.counts.newOrders === t0.lists.newOrders.length, 'tracking: PO listed under orders awaiting job creation');
  const nj = await call('POST', `/jobs/from-buyer-order/${bo._id}`, {});
  const boAfter = await call('GET', `/m/buyerOrder/${bo._id}`);
  ok(/^U1-\d{4}$/.test(nj.jobNo) && nj.poNo === 'NOR-PO-9001' && nj.orderQty === 1000 && nj.sizeBreakdown.map((x) => x.qty).join() === '200,400,300,100', `job ${nj.jobNo} created from the PO with its size ratio`);
  ok(boAfter.status === 'Job Created' && boAfter.jobNo === nj.jobNo, `buyer PO shows assigned job ${boAfter.jobNo}`);
  await call('POST', `/jobs/from-buyer-order/${bo._id}`, {}, [400]);
  ok(true, 'a buyer PO converts into one job only');

  // advance job before the PO: not a confirmed order, cannot be shipped / invoiced
  const adv = await call('POST', '/jobs', { buyer: buyer._id, styleNo: 'NA-PL-900', product: 'Pique Polo', poStatus: 'Awaiting PO', expectedOrderMonth: '2027-01', repeatOfJobNo: nj.jobNo, orderDate: '2026-10-10', shipmentDate: '2027-02-15', orderQty: 1200, unitPrice: 6.5 });
  ok(adv.poStatus === 'Awaiting PO' && !adv.poNo, `advance job ${adv.jobNo} opened without a PO`);
  const advT = await call('GET', `/jobs/track/${adv.jobNo}`);
  ok(advT.lifecycle.stages.order === 'active' && advT.lifecycle.blockers.some((b) => b.includes('buyer PO')), 'advance job: order stage open, closure blocked until the PO arrives');
  await call('POST', '/m/shipment', { job: adv.jobNo, mode: 'Sea', qty: 10, shipmentDate: '2027-02-15' }, [400]);
  ok(true, 'advance job cannot be shipped before its PO');
  const t1 = await call('GET', '/tracking');
  ok(t1.lists.advanceAwaitingPo.some((x) => x.jobNo === adv.jobNo && x.repeatOfJobNo === nj.jobNo) && t1.lists.pendingPo.some((x) => x.jobNo === adv.jobNo) && t1.lists.repeatOrders.some((x) => x.jobNo === adv.jobNo), 'tracking: advance job in advance, pending PO and repeat order lists');
  ok(t1.totals.forecastQty >= 1200, `forecast quantity kept apart from confirmed orders (${t1.totals.forecastQty})`);

  // the actual PO arrives → linked to the advance job
  const po2 = await call('POST', '/m/buyerOrder', { orderType: 'Repeat Order', buyer: buyer._id, poNo: 'NOR-PO-9002', styleNo: 'NA-PL-900', orderDate: '2026-10-12', deliveryDate: '2027-02-28', shipmentDate: '2027-02-10', orderQty: 1500, unitPrice: 6.6, color: 'White', sizeRatio: 'S:1,M:1', repeatOfJobNo: nj.jobNo });
  const linked = await call('POST', `/jobs/${adv._id}/link-po`, { buyerOrder: po2._id });
  ok(linked.job.poStatus === 'PO Received' && linked.job.poNo === 'NOR-PO-9002' && linked.job.orderQty === 1500 && linked.job.revision === 1, `actual PO linked: ${linked.job.jobNo} now ${linked.job.orderQty} pcs (rev ${linked.job.revision})`);
  ok((await call('GET', `/m/buyerOrder/${po2._id}`)).status === 'Linked to Job', 'buyer PO marked Linked to Job');
  await call('POST', `/jobs/${adv._id}/link-po`, { poNo: 'X' }, [400]);
  ok(true, 'a PO-backed job cannot be linked again');
  const t2 = await call('GET', `/tracking?jobNo=${adv.jobNo}`);
  ok(!t2.lists.advanceAwaitingPo.length && Object.values(t2.lists).flat().every((x) => !x.jobNo || x.jobNo.startsWith(adv.jobNo)), 'tracking job filter, advance list cleared after linking');
  const u2t = await call('GET', '/tracking?unit=U2');
  ok(Object.values(u2t.lists).flat().every((x) => x.unit === 'U2'), 'Unit-2 tracking shows only Unit-2 rows');
}

console.log('\nALL E2E CHECKS PASSED');
