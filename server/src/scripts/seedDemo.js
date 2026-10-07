/**
 * Optional demo data: buyers, suppliers, employees and jobs at different lifecycle stages.
 *   npm run seed:demo
 * Refuses to run when jobs already exist (never mixes demo data into live data).
 */
import mongoose from 'mongoose';
import { connectDb } from '../config/db.js';
import { bootstrap } from '../services/bootstrap.js';
import { models } from '../modules/builder.js';
import { MODULES, applyCompute } from '../../../shared/modules/index.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { DocumentFile } from '../models/Document.js';
import { createJob, createSubJobs } from '../services/orderFlow.js';
import { refreshJob } from '../services/lifecycle.js';
import { syncInvoice, syncProductionPlan } from '../modules/hooks.js';
import { nextRefNo } from '../services/numbering.js';
import { logger } from '../utils/logger.js';
import { seedStockDemo } from './stockDemo.js';

const DAY = 86400000;
const d = (offset) => new Date(new Date().setHours(0, 0, 0, 0) + offset * DAY);
let req;

async function add(key, job, data) {
  const def = MODULES[key];
  const body = applyCompute(def, { status: def.defaultStatus, ...(def.prefill && job ? def.prefill(job) : {}), ...data });
  return models[key].create({
    ...body,
    ...(job ? { job: job._id, jobNo: job.jobNo, parentJob: job.parentJob, parentJobNo: job.parentJobNo, buyerName: job.buyerName, styleNo: job.styleNo, poNo: job.poNo } : {}),
    refNo: await nextRefNo(def.prefix), createdBy: req.user._id, createdByName: req.user.name,
    statusHistory: [{ to: body.status, by: req.user._id, byName: req.user.name }],
  });
}
async function update(key, filter, patch) {
  const def = MODULES[key];
  const docs = await models[key].find(filter);
  for (const doc of docs) {
    const next = applyCompute(def, { ...doc.toObject(), ...patch });
    Object.keys(next).forEach((k) => { if (def.fields.some((f) => f.name === k) || k === 'status') doc.set(k, next[k]); });
    await doc.save();
  }
  return docs;
}
const jobDocs = (job) => ({ job: job._id, isDeleted: false });

async function progress(job, stage) {
  const J = jobDocs(job);
  const qty = job.orderQty;
  const order = ['fabric', 'samples', 'plan', 'cutting', 'sewing', 'finishing', 'packing', 'inspection', 'shipment', 'invoice', 'paid', 'docs', 'close'];
  const upto = (s) => order.indexOf(s) <= order.indexOf(stage);
  const tna = await models.tna.findOne(J);
  const markTna = async (names) => {
    tna.activities.forEach((a) => { if (names.includes(a.activity)) a.actualDate = new Date(Math.min(new Date(a.plannedDate).getTime() + 2 * DAY, Date.now())); });
    const next = applyCompute(MODULES.tna, tna.toObject());
    tna.set({ activities: next.activities, completedCount: next.completedCount, delayedCount: next.delayedCount, completionPct: next.completionPct, status: next.status });
    await tna.save();
  };
  await markTna(['Order Confirmation', 'PP Meeting', 'Fabric Booking', 'Trim Booking', 'Lab Dip']);
  await update('ppMeeting', J, { status: 'Held', fabricStatus: 'Ready', trimStatus: 'Ready', sampleApproval: 'Approved', attendees: 'Merchandising, Production, Quality, Cutting' });

  const fab = await models.fabricBooking.findOne(J);
  const reqQty = fab.requiredQty;
  if (upto('fabric')) {
    await update('fabricBooking', J, { supplier: (await models.supplier.findOne({ supplierType: 'Fabric' }))._id, supplierName: 'Arvind Mills', bookedQty: Math.ceil(reqQty), receivedQty: Math.ceil(reqQty) + 4, inspectedQty: Math.ceil(reqQty) + 4, approvedQty: Math.ceil(reqQty) + 4, deliveryDate: d(-20), status: 'Approved' });
    await update('trimBooking', J, {});
    for (const t of await models.trimBooking.find(J)) {
      await update('trimBooking', { _id: t._id }, { bookedQty: t.bookingQty, receivedQty: t.bookingQty, issuedQty: upto('cutting') ? t.bookingQty : 0, status: 'Received' });
    }
    await markTna(['Fabric In-house', 'Trim In-house', 'Strike-off']);
  }
  if (upto('samples')) {
    await update('sample', J, { status: 'Approved', sentDate: d(-30), buyerApprovalDate: d(-25) });
    await markTna(['Proto Sample', 'Fit Sample', 'Size Set', 'PP Sample', 'Approval']);
  }
  if (upto('plan')) await update('productionPlan', J, { line: 'Line 2', floor: 'Floor 1', operators: 38, machines: 42, sam: 7.2, plannedStart: d(-12), status: 'Released' });
  if (upto('cutting')) {
    await update('fabricBooking', J, { issuedQty: Math.ceil(reqQty), usedQty: upto('sewing') ? Math.ceil(reqQty) - 6 : 0, status: 'Issued' });
    const cutQty = stage === 'cutting' ? Math.round(qty * 0.5) : qty;
    await add('cutting', job, { entryDate: d(-11), layNo: 'L-01', markerNo: 'MK-1', ratio: 'S:1,M:2,L:2,XL:1', plies: Math.round(cutQty / 6), fabricIssued: Math.round(reqQty), fabricUsed: Math.round(reqQty * 0.97), status: 'Approved' });
    await markTna(['Cutting Start']);
  }
  if (upto('sewing')) {
    const days = 10;
    const target = Math.round(38 * 480 * 0.6 / 7.2);
    let left = stage === 'sewing' ? Math.round(qty * 0.62) : (await models.cutting.find(J)).reduce((s, c) => s + c.cutQty, 0);
    for (let i = days; i >= 1 && left > 0; i -= 1) {
      const eff = 0.48 + Math.random() * 0.2;
      const out = Math.min(left, Math.round(38 * 480 * eff / 7.2));
      left -= out;
      await add('sewing', job, { entryDate: d(-i), floor: 'Floor 1', line: ['Line 1', 'Line 2', 'Line 3'][i % 3], operators: 38, sam: 7.2, workingMinutes: 480, targetQty: target, manualOutput: out, inputQty: out + 40, checkedQty: out, defects: Math.round(out * (0.02 + Math.random() * 0.03)), alteration: Math.round(out * 0.015), rejection: Math.round(out * 0.003), status: 'Approved' });
    }
    await markTna(['Sewing Start']);
    await syncProductionPlan(job);
  }
  const sewn = (await models.sewing.find(J)).reduce((s, x) => s + x.actualQty, 0);
  if (upto('finishing')) {
    await add('finishing', job, { entryDate: d(-3), process: 'All', inputQty: sewn, passedQty: sewn - 30, rejection: 30, alteration: 60, rework: 25, status: 'Approved' });
    await markTna(['Finishing Start']);
  }
  if (upto('packing')) {
    const pcs = sewn - 30;
    const ctns = Math.floor(pcs / 24);
    await add('packing', job, { packingDate: d(-2), packingMethod: 'Solid Color Assorted Size', rows: [{ color: 'Navy', ratio: 'S:4,M:8,L:8,XL:4', cartonFrom: 1, cartonTo: ctns, netWtPerCarton: 7.2, grossWtPerCarton: 8.1, length: 60, width: 40, height: 32 }], status: 'Packed' });
    await markTna(['Packing']);
  }
  const packed = (await models.packing.find(J)).reduce((s, x) => s + x.totalQty, 0);
  if (upto('inspection')) {
    await add('inspection', job, { inspectionDate: d(-1), inspectionType: 'Final', inspector: 'QA – R. Kumar', inspectionAgency: 'Buyer QA', lotSize: packed, majorDefects: 3, minorDefects: 6, status: 'Passed' });
    await markTna(['Inspection']);
  }
  let shipment;
  if (upto('shipment')) {
    const pk = await models.packing.findOne(J);
    shipment = await add('shipment', job, { invoiceNo: `EXP/${job.jobNo.slice(-5)}`, mode: 'Sea', shipmentDate: d(-1), actualShipDate: d(-1), qty: packed, cartons: pk.totalCartons, netWeight: pk.totalNetWeight, grossWeight: pk.totalGrossWeight, cbm: pk.totalCbm, vesselFlight: 'MAERSK KENSINGTON 042W', containerNo: 'MSKU7781230', blAwbNo: `MAEU${Math.floor(Math.random() * 1e8)}`, portOfLoading: 'Chennai', destination: job.destination, forwarder: 'Maersk Logistics', status: 'Shipped' });
    await markTna(['Shipment']);
  }
  if (upto('invoice')) {
    const inv = await add('invoice', job, { invoiceNo: shipment.invoiceNo, invoiceDate: d(-1), shipment: shipment._id, qty: shipment.qty, unitPrice: job.unitPrice, currency: job.currency, dueDate: d(29), receivedAmount: 0, status: 'Issued' });
    await add('expense', job, { category: 'Freight', description: 'Ocean freight & THC', expenseDate: d(-1), amount: 1450, vendor: 'Maersk Logistics', status: 'Approved' });
    await add('expense', job, { category: 'Labour', description: 'Direct labour (sewing & finishing)', expenseDate: d(-2), amount: Math.round(qty * 0.42), status: 'Approved' });
    await add('expense', job, { category: 'Production', description: 'Cutting, finishing & packing cost', expenseDate: d(-2), amount: Math.round(qty * 0.2), status: 'Approved' });
    await add('expense', job, { category: 'Overhead', description: 'Factory overhead allocation', expenseDate: d(-2), amount: Math.round(qty * 0.12), status: 'Approved' });
    await add('payment', job, { invoice: inv._id, paymentDate: d(0), amount: stage === 'invoice' ? Math.round(inv.totalAmount * 0.3) : inv.totalAmount, currency: job.currency, mode: 'TT', reference: `TT-${Math.floor(Math.random() * 1e6)}`, isAdvance: false });
    await syncInvoice(inv._id);
  }
  if (upto('docs')) {
    for (const docType of ['Commercial Invoice', 'Packing List', 'Bill of Lading (BL)']) {
      await DocumentFile.create({ refNo: await nextRefNo('DOC'), job: job._id, jobNo: job.jobNo, department: 'Shipment / Documentation', docType, title: `${docType} – ${job.jobNo}`, versions: [{ version: 1, fileName: 'demo-placeholder.pdf', originalName: `${docType}.pdf`, mimeType: 'application/pdf', size: 1024, uploadedBy: req.user._id, uploadedByName: req.user.name }], createdBy: req.user._id, createdByName: req.user.name });
    }
  }
  await refreshJob(job._id, { notifyReady: true });
}

async function main() {
  await connectDb();
  await bootstrap();
  if (await models.orders.exists({})) { logger.warn('Jobs already exist – demo seed skipped.'); return; }
  const adminRole = await Role.findOne({ isAdmin: true });
  const admin = await User.findOne({ role: adminRole._id });
  req = { user: admin, ip: '127.0.0.1', headers: { 'user-agent': 'seed' } };

  const buyers = {};
  for (const [name, code, country] of [['Nordic Apparel AB', 'NOR', 'Sweden'], ['Urban Threads Inc', 'UTI', 'USA'], ['Maison Lumière', 'MLU', 'France'], ['Kiwi Kids Ltd', 'KKL', 'United Kingdom']]) {
    buyers[code] = await add('buyer', null, { name, code, country, currency: 'USD', contactPerson: 'Sourcing Team', email: `sourcing@${code.toLowerCase()}.example`, paymentTerms: 'TT 30 days', status: 'Active' });
  }
  for (const [name, type] of [['Arvind Mills', 'Fabric'], ['Pioneer Knit Fabrics', 'Fabric'], ['YKK India', 'Trims'], ['Avery Dennison', 'Trims'], ['Maersk Logistics', 'Logistics'], ['SGS Testing', 'Testing Lab']]) {
    await add('supplier', null, { name, supplierType: type, code: name.slice(0, 3).toUpperCase(), country: 'India', leadTimeDays: 21, rating: 4, status: 'Active' });
  }
  const depts = ['Sewing', 'Sewing', 'Sewing', 'Sewing', 'Cutting', 'Cutting', 'Finishing', 'Packing', 'Quality', 'Fabric Department', 'Factory Merchandising', 'HR'];
  for (let i = 0; i < depts.length; i += 1) {
    await add('employee', null, { empCode: `E${1001 + i}`, name: ['Priya S', 'Arun K', 'Meena R', 'Karthik V', 'Lakshmi P', 'Ravi M', 'Divya N', 'Suresh B', 'Anitha J', 'Vijay T', 'Deepa L', 'Rahul G'][i], department: depts[i], designation: depts[i] === 'Sewing' ? 'Operator' : 'Executive', isOperator: depts[i] === 'Sewing', workingDays: 26, presentDays: 22 + (i % 5), joinDate: d(-400 + i * 20), status: i === 7 ? 'On Leave' : 'Active' });
  }

  // Pre-order pipeline
  const enq = await add('enquiry', null, { enquiryDate: d(-5), buyer: buyers.MLU._id, buyerName: 'Maison Lumière', styleNo: 'ML-DR-210', product: 'Jersey Dress', fabric: 'Viscose Jersey', gsm: 200, expectedQty: 6000, targetPrice: 6.4, status: 'Pending' });
  await add('enquiry', null, { enquiryDate: d(-2), buyer: buyers.KKL._id, buyerName: 'Kiwi Kids Ltd', styleNo: 'KK-HD-77', product: 'Kids Hoodie', fabric: 'Fleece', gsm: 280, expectedQty: 12000, targetPrice: 5.1, status: 'Under Review' });
  const enq2 = await add('enquiry', null, { enquiryDate: d(-9), buyer: buyers.UTI._id, buyerName: 'Urban Threads Inc', styleNo: 'UT-JG-05', product: 'Jogger', fabric: 'French Terry', gsm: 300, expectedQty: 15000, targetPrice: 7.2, status: 'Costing' });
  await add('costing', null, { enquiry: enq2._id, buyer: buyers.UTI._id, buyerName: 'Urban Threads Inc', styleNo: 'UT-JG-05', product: 'Jogger', orderQty: 15000, fabricConsumption: 0.42, fabricUnit: 'KG', fabricRate: 5.2, fabricWastagePct: 6, trimCost: 0.45, cuttingCost: 0.08, sewingCost: 0.65, finishingCost: 0.12, packingCost: 0.09, factoryOverhead: 0.25, testingCost: 0.03, freightCost: 0.12, commissionPct: 3, financeCostPct: 1.5, profitMarginPct: 14, status: 'Submitted' });
  void enq;

  const trims = [{ item: 'Main Label', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 3, rate: 0.02 }, { item: 'Care Label', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 3, rate: 0.01 }, { item: 'Hang Tag', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 2, rate: 0.03 }, { item: 'Polybag', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 2, rate: 0.015 }, { item: 'Carton', consumptionPerPc: 0.042, unit: 'Pcs', wastagePct: 1, rate: 0.9 }];
  const mk = async (o) => {
    const costing = await add('costing', null, { buyer: o.buyer._id, buyerName: o.buyer.name, styleNo: o.styleNo, product: o.product, orderQty: o.qty, fabricConsumption: o.cons, fabricUnit: 'KG', fabricRate: o.rate, fabricWastagePct: 5, trimCost: 0.12, cuttingCost: 0.05, sewingCost: 0.38, finishingCost: 0.08, packingCost: 0.06, labourCost: 0.1, factoryOverhead: 0.14, commissionPct: 3, financeCostPct: 1, profitMarginPct: 12, quotedPrice: o.price, status: 'Approved' });
    const quote = await add('quotation', null, { costing: costing._id, buyer: o.buyer._id, buyerName: o.buyer.name, styleNo: o.styleNo, product: o.product, quoteDate: d(o.orderOffset - 7), orderQty: o.qty, price: o.price, currency: 'USD', fabric: o.fabric, composition: '100% Cotton', gsm: o.gsm, paymentTerms: 'TT 30 days', deliveryTerms: 'FOB', version: 1, status: 'Converted' });
    const job = await createJob({
      buyer: o.buyer._id, poNo: o.po, styleNo: o.styleNo, product: o.product, garmentType: 'T-Shirt', orderDate: d(o.orderOffset), orderQty: o.qty, unitPrice: o.price, currency: 'USD',
      shipmentDate: d(o.shipOffset), deliveryDate: d(o.shipOffset + 25), paymentTerms: 'TT 30 days', deliveryTerms: 'FOB', destination: o.dest,
      fabricType: o.fabric, composition: '100% Cotton', gsm: o.gsm, width: 72, fabricColor: 'Navy', consumption: o.cons, consumptionUnit: 'KG', wastagePct: 5, processLossPct: 2, fabricRate: o.rate,
      colors: ['Navy', 'White'], sizes: ['S', 'M', 'L', 'XL'], trims, costing: costing._id, quotation: quote._id, isForecast: !!o.forecast, forecastQty: o.forecast || 0,
    }, req);
    await models.costing.updateOne({ _id: costing._id }, { $set: { job: job._id, jobNo: job.jobNo } });
    await models.quotation.updateOne({ _id: quote._id }, { $set: { job: job._id, jobNo: job.jobNo } });
    return job.toObject();
  };

  const j1 = await mk({ buyer: buyers.NOR, po: 'NOR-PO-4471', styleNo: 'NA-TS-101', product: 'Crew Neck Tee', qty: 8000, price: 2.35, cons: 0.18, rate: 4.4, fabric: 'Single Jersey', gsm: 160, dest: 'Gothenburg', orderOffset: -95, shipOffset: -3 });
  await progress(j1, 'close');
  await models.orders.updateOne({ _id: j1._id }, { $set: { status: 'Closed', closedAt: new Date(), closedBy: admin._id, closureRemarks: 'Shipped, documented and fully paid' } });
  await refreshJob(j1._id);

  const j2 = await mk({ buyer: buyers.UTI, po: 'UTI-88231', styleNo: 'UT-PL-12', product: 'Pique Polo', qty: 6000, price: 4.1, cons: 0.24, rate: 4.9, fabric: 'Pique', gsm: 220, dest: 'Los Angeles', orderOffset: -80, shipOffset: -2 });
  await progress(j2, 'invoice');
  const j3 = await mk({ buyer: buyers.NOR, po: 'NOR-PO-4520', styleNo: 'NA-SW-330', product: 'Sweatshirt', qty: 9000, price: 6.2, cons: 0.38, rate: 5.1, fabric: 'Fleece', gsm: 300, dest: 'Gothenburg', orderOffset: -60, shipOffset: 12 });
  await progress(j3, 'sewing');
  const j4 = await mk({ buyer: buyers.MLU, po: 'ML-2026-118', styleNo: 'ML-TP-44', product: 'Ladies Top', qty: 5000, price: 3.8, cons: 0.16, rate: 6.2, fabric: 'Modal Jersey', gsm: 150, dest: 'Le Havre', orderOffset: -40, shipOffset: 25 });
  await update('fabricBooking', jobDocs(j4), { supplierName: 'Pioneer Knit Fabrics', bookedQty: 900, receivedQty: 620, inspectedQty: 620, approvedQty: 600, deliveryDate: d(-6), status: 'Received' });
  await update('sample', { ...jobDocs(j4), sampleType: { $in: ['Proto Sample', 'Fit Sample'] } }, { status: 'Approved' });
  await update('sample', { ...jobDocs(j4), sampleType: 'Size Set' }, { status: 'Buyer Review', sentDate: d(-8) });
  await refreshJob(j4._id);
  const j5 = await mk({ buyer: buyers.KKL, po: 'KK-55120', styleNo: 'KK-TS-09', product: 'Kids Tee', qty: 12000, price: 1.95, cons: 0.11, rate: 4.2, fabric: 'Single Jersey', gsm: 150, dest: 'Felixstowe', orderOffset: -6, shipOffset: 70 });
  await refreshJob(j5._id);
  const j6 = await mk({ buyer: buyers.UTI, po: 'UTI-FC-2026', styleNo: 'UT-BT-01', product: 'Basic Tee (continuous)', qty: 30000, price: 2.1, cons: 0.17, rate: 4.3, fabric: 'Single Jersey', gsm: 150, dest: 'Los Angeles', orderOffset: -30, shipOffset: 90, forecast: 30000 });
  const subs = await createSubJobs(j6._id, [{ orderQty: 10000, shipmentDate: d(30) }, { orderQty: 8000, shipmentDate: d(60) }, { orderQty: 12000, shipmentDate: d(90) }], req);
  await progress(subs[0].toObject(), 'cutting');

  await seedStockDemo(req);
  logger.info('Demo data created: 6 jobs (+3 sub jobs), enquiries, costing, buyers, suppliers, employees');
}

main().catch((e) => { logger.error(e); process.exitCode = 1; }).finally(() => mongoose.disconnect());
