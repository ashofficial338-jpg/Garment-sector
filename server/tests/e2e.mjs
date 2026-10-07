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
const ok = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL:', msg); process.exit(1); } console.log('  ✓', msg); };

let r = await call('POST', '/auth/login', { email: 'ashofficial338@gmail.com', password: 'Admin@12345' });
token = r.accessToken;
ok(r.user.mustChangePassword, 'first login forces password change');
await call('GET', '/dashboard', null, [403]);
r = await call('POST', '/auth/change-password', { currentPassword: 'Admin@12345', newPassword: 'Admin@12345' }, [400]);
r = await call('POST', '/auth/change-password', { currentPassword: 'Admin@12345', newPassword: 'NewAdmin@2026' });
token = r.accessToken;
ok(!r.user.mustChangePassword && r.user.isAdmin, 'password changed, admin session');
r = await call('POST', '/auth/refresh');
token = r.accessToken;
ok(!!token, 'refresh token rotation works');

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
ok(/^GAR-2026-\d{5}$/.test(job.jobNo), `job number ${job.jobNo}`);
ok(job.orderValue === Math.round(10000 * job.unitPrice * 100) / 100, 'order value computed');
await call('POST', `/jobs/from-quotation/${qtn._id}`, { poNo: 'PO-77881', shipmentDate: '2026-12-15' }, [400]);
ok(true, 'converted quotation cannot be converted twice');

let track = await call('GET', `/jobs/track/${job.jobNo}`);
ok(track.records.tna.length === 1 && track.records.tna[0].activities.length === 19, 'T&A generated with 19 activities');
ok(track.records.sample.length === 4 && track.records.trimBooking.length === 2 && track.records.ppMeeting.length === 1 && track.records.productionPlan.length === 1, 'samples, trims, PPM, plan generated');
const fb = track.records.fabricBooking[0];
ok(fb.requiredQty === 1890, `fabric requirement carried: ${fb.requiredQty} KG (10,000 × 0.18 + 5%)`);
ok(track.lifecycle.stages.enquiry === 'done' && track.lifecycle.stages.costing === 'done' && track.lifecycle.stages.quotation === 'done', 'commercial stages done');

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
const cut = await call('POST', '/m/cutting', { job: job.jobNo, entryDate: '2026-10-06', ratio: 'S:2,M:4,L:4', plies: 1000, fabricIssued: 1890, fabricUsed: 1850 });
ok(cut.cutQty === 10000 && cut.jobNo === job.jobNo && cut.buyerName === 'Nordic Apparel AB', 'cutting qty from ratio × plies, job data denormalised');
await call('POST', '/m/sewing', { job: job.jobNo, entryDate: '2026-10-08', line: 'Line 1', operators: 40, sam: 6.5, workingMinutes: 480, targetQty: 1800, manualOutput: 10001 }, [400]);
ok(true, 'sewing above cut qty blocked');
const sew = await call('POST', '/m/sewing', { job: job.jobNo, entryDate: '2026-10-08', line: 'Line 1', operators: 40, sam: 6.5, workingMinutes: 480, targetQty: 1800, manualOutput: 10000, checkedQty: 10000, defects: 250 });
ok(sew.efficiencyPct === Math.round(10000 * 6.5 / (40 * 480) * 10000) / 100 && sew.dhu === 2.5, `sewing efficiency ${sew.efficiencyPct}% DHU ${sew.dhu}`);
await call('POST', '/m/finishing', { job: job.jobNo, entryDate: '2026-10-12', inputQty: 10000, passedQty: 9950, rejection: 50 });
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
ok(subs.map((s) => s.jobNo).join() === `${fj.jobNo}-F01,${fj.jobNo}-F02,${fj.jobNo}-F03`, `sub jobs ${subs.map((s) => s.jobNo).join(', ')}`);
await call('POST', `/jobs/${fj._id}/subjobs`, { subJobs: [{ orderQty: 1 }] }, [400]);
ok(true, 'sub job total cannot exceed forecast qty');
const ft = await call('GET', `/jobs/track/${fj.jobNo}`);
ok(ft.job.orderQty === 30000 && ft.lifecycle.meta.subJobs.length === 3, 'main job qty = sum of sub jobs');
const sfb = await call('GET', `/m/fabricBooking?job=${subs[0].jobNo}`);
ok(sfb.rows[0]?.requiredQty === 2000, `sub job F01 has its own fabric requirement (${sfb.rows[0]?.requiredQty})`);

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
const s = await call('GET', '/search?q=PO-77881');
ok(s.results.some((x) => x.jobNo === job.jobNo), 'global search by PO');
const csv = await fetch(`${BASE}/reports/order-status?format=xlsx`, { headers: { Authorization: `Bearer ${token}` } });
ok(csv.status === 200 && csv.headers.get('content-type').includes('spreadsheet'), 'excel export');
console.log('\nALL E2E CHECKS PASSED');
