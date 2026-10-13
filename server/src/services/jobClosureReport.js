/**
 * Consolidated Job Closure Report – the complete, dated transaction history of a main job and all its sub jobs
 * under the same Job No: commercial → pre-production → fabric purchase / inward / transfer / issue / return / debit
 * → trims → cutting → sewing → finishing → quality → packing (finished goods in) → shipment (finished goods out)
 * → invoices → payments → expenses → closure, followed by per-job reconciliation of quantities and amounts.
 *
 * Cost recognition (ties to job profit exactly):
 *   fabric  = value received into the job's fabric bookings (roll receipts, transfers in, typed receipts)
 *             ± accepted fabric debit notes (supplier recovery − / additional charge +)
 *   trims   = received trim value · job expenses and job-linked factory expenses = their amount
 *   labour, inspection labour and factory overhead = the job's share of payroll / attendance and factory expenses
 *             (costAllocation.js), booked as allocation lines
 *   a cost bucket with no actual cost at all is charged at its costed standard × produced qty (shown as such)
 */
import { models } from '../modules/builder.js';
import { loadJobGraph, computeProfit, computeStages } from './lifecycle.js';
import { jobAllocation } from './costAllocation.js';
import { QUALITY_EXPENSE_CATEGORIES } from '../../../shared/modules/factory.js';
import { transfersInto } from './fabricRolls.js';
import { getSetting } from './settings.js';
import { financeLineOf } from '../../../shared/costHeads.js';
import { RETURN_TO_STORE, RETURN_TO_SUPPLIER, ADJUST_SHORT, ADJUST_EXCESS } from '../../../shared/modules/planning.js';
import { num, sum, round } from '../../../shared/calc.js';

const SHIPPED = ['Shipped', 'Delivered'];
const at = (rec, statuses) => rec.statusHistory?.find((h) => statuses.includes(h.to))?.at;
const r2 = (v) => round(num(v), 2);
const r3 = (v) => round(num(v), 3);

/** Transaction register columns (screen, Excel / CSV, Report Center). */
export const CLOSURE_REGISTER_COLUMNS = [
  ['seq', '#'], ['date', 'Date'], ['mainJobNo', 'Main Job'], ['jobNo', 'Job / Sub Job'], ['department', 'Department'], ['txType', 'Transaction'], ['refNo', 'Reference No'],
  ['description', 'Details'], ['qty', 'Qty'], ['unit', 'Unit'], ['rate', 'Rate'], ['amount', 'Amount'], ['costImpact', 'Job Cost'], ['revenueImpact', 'Revenue'], ['status', 'Status'],
].map(([key, label]) => ({ key, label }));

/** Display order of transaction types on the same day (process order). */
const SEQ = ['Buyer Enquiry', 'Costing', 'Quotation', 'Buyer PO', 'Job Opened', 'Sub Job Opened', 'Order Revision', 'Specification', 'BOM', 'CAD / Pattern', 'Marker',
  'Fabric Purchase', 'Fabric Forecast Purchase', 'Fabric Inward', 'Fabric Transfer In', 'Fabric Transfer Out', 'Fabric Reservation', 'Fabric Issue', 'Fabric Return', 'Fabric Debit Note', 'Fabric Consumed', 'Fabric Job Closed',
  'Fabric Stock Adjustment', 'Trim Purchase', 'Trim Inward', 'Cutting', 'Hourly Production', 'Sewing', 'Finishing', 'Quality Inspection', 'Quality Issue / Rework', 'Packing → Finished Goods', 'Shipment → Finished Goods Out', 'Invoice', 'Payment', 'Supplier Bill', 'Supplier Payment', 'Expense',
  'Factory Expense (job)', 'Labour Allocated', 'Inspection Labour Allocated', 'Factory Overhead Allocated', 'Standard Cost Applied', 'Document', 'Job Closed'];

export async function buildJobClosureReport(jobDoc, { withMoney = true } = {}) {
  const main = jobDoc.parentJob ? await models.orders.findById(jobDoc.parentJob).lean() : jobDoc;
  const g = await loadJobGraph(main);
  const jobs = [main, ...g.subJobs];
  const jobOf = new Map(jobs.map((j) => [String(j._id), j]));
  const [buyerOrders, transfersIn, units] = await Promise.all([
    models.buyerOrder.find({ job: { $in: jobs.map((j) => j._id) }, isDeleted: false }).lean(),
    transfersInto(g.fabric.map((b) => b._id)),
    getSetting('units'),
  ]);
  const bookingById = new Map(g.fabric.map((b) => [String(b._id), b]));
  const forecastById = new Map(g.forecasts.map((f) => [String(f._id), f]));
  const rows = [];
  const add = (rec, o) => rows.push({
    date: o.date || null, jobNo: o.jobNo || rec?.jobNo, department: o.department, txType: o.txType, refNo: o.refNo ?? rec?.refNo, description: o.description || '',
    qty: o.qty ?? null, unit: o.unit || '', rate: o.rate ?? null, amount: o.amount ?? null, costImpact: r2(o.costImpact), revenueImpact: r2(o.revenueImpact),
    status: o.status ?? rec?.status ?? '', module: o.module || '', recordId: rec?._id || null,
  });

  // ---------- commercial & job ----------
  g.enquiries.forEach((e) => add(e, { jobNo: main.jobNo, date: e.enquiryDate, department: 'Merchandising', txType: 'Buyer Enquiry', module: 'enquiry', description: `${e.styleNo} · ${e.product || ''}`, qty: e.expectedQty, unit: 'pcs', rate: e.targetPrice }));
  g.costings.forEach((c) => add(c, { jobNo: main.jobNo, date: c.costingDate || at(c, ['Approved']) || c.createdAt, department: 'Costing', txType: 'Costing', module: 'costing', description: `Cost ${r2(c.totalCostPerPc)}/pc · FOB ${r2(c.sellingPrice)} · margin ${c.profitPct}%`, qty: c.orderQty, unit: 'pcs', rate: c.totalCostPerPc, amount: withMoney ? r2(num(c.totalCostPerPc) * num(c.orderQty)) : null }));
  g.quotations.forEach((q) => add(q, { jobNo: main.jobNo, date: q.quoteDate, department: 'Merchandising', txType: 'Quotation', module: 'quotation', description: `v${q.version} · ${q.paymentTerms || ''} ${q.deliveryTerms || ''}`, qty: q.orderQty, unit: 'pcs', rate: q.price, amount: q.quoteValue }));
  buyerOrders.forEach((b) => add(b, { jobNo: b.jobNo, date: b.orderDate, department: 'Merchandising', txType: 'Buyer PO', module: 'buyerOrder', description: `${b.orderType} PO ${b.poNo} · ${b.color || ''} ${b.sizeRatio || ''} · delivery ${b.deliveryDate ? new Date(b.deliveryDate).toISOString().slice(0, 10) : '—'}`, qty: b.orderQty, unit: 'pcs', rate: b.unitPrice, amount: b.orderValue }));
  jobs.forEach((j) => {
    add(j, { jobNo: j.jobNo, refNo: j.orderNo, date: j.orderDate, department: 'Merchandising', txType: j.parentJob ? 'Sub Job Opened' : 'Job Opened', module: 'orders', status: j.status,
      description: `${j.jobType || 'Job'} · ${j.buyerName} · style ${j.styleNo} · PO ${j.poNo || '(awaiting)'}${j.parentJobNo ? ` · under ${j.parentJobNo}` : ''}`, qty: j.orderQty, unit: 'pcs', rate: j.unitPrice, amount: j.orderValue });
    (j.revisions || []).forEach((v) => add(j, { jobNo: j.jobNo, refNo: `${j.orderNo} rev ${v.rev}`, date: v.at, department: 'Merchandising', txType: 'Order Revision', module: 'orders', status: `Rev ${v.rev}`, description: `${v.fields.join(', ')} – ${v.reason || ''} (${v.byName})` }));
  });
  // ---------- pre-production ----------
  g.specs.forEach((x) => add(x, { date: x.buyerApprovalDate || at(x, ['Approved']) || x.specDate, department: 'Merchandising', txType: 'Specification', module: 'techSpec', description: `Rev ${x.revision || 1} · base ${x.baseSize || '—'} · ${x.pomCount || 0} POMs` }));
  g.boms.forEach((x) => add(x, { date: x.bomDate || at(x, ['Approved']) || x.createdAt, department: 'Merchandising', txType: 'BOM', module: 'bom', description: `${(x.lines || []).length} lines · material ${r2(x.materialCostPerPc)}/pc`, amount: x.totalMaterialValue }));
  g.patterns.forEach((x) => add(x, { date: x.approvalDate || at(x, ['Graded', 'Pattern Approved']) || x.cadStartDate, department: 'CAD / Pattern', txType: 'CAD / Pattern', module: 'pattern', description: `${x.patternNo} · ${x.cadSystem || ''} · ${x.gradedSizes || 0} sizes graded` }));
  g.markers.forEach((x) => add(x, { date: x.markerDate || at(x, ['Approved']) || x.createdAt, department: 'CAD / Pattern', txType: 'Marker', module: 'marker', description: `${x.markerNo} · ratio ${x.ratio} · ${r3(x.consumptionPerPc)}/pc · eff ${x.markerEfficiencyPct}%`, qty: x.plannedPlies, unit: 'plies' }));

  // ---------- fabric ----------
  g.forecasts.forEach((f) => add(f, { date: f.poDate || f.createdAt, department: 'Fabric Department', txType: 'Fabric Forecast Purchase', module: 'fabricForecast', description: `${f.fabricType} ${f.color || ''} · supplier PO ${f.supplierPoNo || '—'} · bulk for call-off sub jobs`, qty: f.forecastQty, unit: f.unit, rate: f.rate, amount: r2(num(f.forecastQty) * num(f.rate)) }));
  g.fabric.forEach((b) => add(b, { date: b.bookingDate || b.createdAt, department: 'Fabric Department', txType: 'Fabric Purchase', module: 'fabricBooking', description: `${b.fabricType} ${b.color || ''} · supplier PO ${b.supplierPoNo || '—'} · required ${r3(b.requiredQty)}`, qty: b.bookedQty, unit: b.unit, rate: b.rate, amount: b.bookingValue }));
  g.receipts.forEach((rc) => {
    const b = rc.booking && bookingById.get(String(rc.booking)); const f = rc.forecast && forecastById.get(String(rc.forecast));
    const rate = num((b || f)?.rate);
    add(rc, { date: rc.receiptDate, department: 'Fabric Department', txType: 'Fabric Inward', module: 'fabricReceipt', description: `${rc.totalRolls} rolls · DC ${rc.supplierDc || '—'} · passed ${r3(rc.passedQty)}${num(rc.rejectedQty) ? ` · rejected ${r3(rc.rejectedQty)} (4-point)` : ''}${f ? ` · into forecast ${f.refNo}` : ` · into ${b?.refNo}`}`,
      qty: rc.totalQty, unit: rc.unit, rate, amount: r2(num(rc.totalQty) * rate), costImpact: b ? num(rc.totalQty) * rate : 0 });
  });
  const tIn = new Set(transfersIn.map((t) => String(t._id)));
  transfersIn.forEach((t) => {
    const b = bookingById.get(String(t.toBooking));
    add(t, { jobNo: t.toJobNo || b?.jobNo, date: t.transferDate, department: 'Fabric Department', txType: 'Fabric Transfer In', module: 'fabricTransfer', status: t.status,
      description: `${t.fabric} lot ${t.lotNo || '—'} from ${t.jobNo} (${t.fromUnit}) → ${b?.refNo} · ${t.reason} · ${t.referenceDoc || ''}`, qty: t.qty, unit: t.unit, rate: b?.rate, amount: r2(num(t.qty) * num(b?.rate)), costImpact: num(t.qty) * num(b?.rate) });
  });
  g.transfers.filter((t) => t.status === 'Completed' && !tIn.has(String(t._id))).forEach((t) => add(t, { jobNo: t.jobNo, date: t.transferDate, department: 'Fabric Department', txType: 'Fabric Transfer Out', module: 'fabricTransfer',
    description: `${t.fabric} lot ${t.lotNo || '—'} → ${t.toJobNo} (${t.toUnit}) · ${t.reason} · ${t.referenceDoc || ''}`, qty: -num(t.qty), unit: t.unit }));
  g.allocations.forEach((a) => {
    const b = bookingById.get(String(a.booking));
    // 'Allocated' = rolls reserved for cutting (held in store, not issued); 'Issued to Cutting' = issued
    const reserved = a.status === 'Allocated';
    add(a, { date: a.allocationDate, department: 'Fabric Department', txType: reserved ? 'Fabric Reservation' : 'Fabric Issue', module: 'fabricAllocation', description: `${a.totalRolls} roll(s) / lot(s) ${reserved ? 'reserved for' : 'to'} cutting ${a.cuttingTable || ''} · from ${b?.refNo}${reserved ? ' · held in store, not issued' : ''}`, qty: a.totalQty, unit: a.unit, rate: b?.rate, amount: r2(num(a.totalQty) * num(b?.rate)) });
  });
  // signed by the effect on the fabric store: + back into store (from cutting, count excess), − out (to supplier, count shortage)
  const intoStore = (r) => [RETURN_TO_STORE, ADJUST_EXCESS].includes(r.returnType);
  g.returns.forEach((r) => add(r, { date: r.returnDate, department: r.returnType === RETURN_TO_STORE ? 'Cutting' : 'Fabric Department', txType: [ADJUST_SHORT, ADJUST_EXCESS].includes(r.returnType) ? 'Fabric Stock Adjustment' : 'Fabric Return', module: 'fabricReturn',
    description: `${r.returnType} · ${r.reason} · ref ${r.referenceDoc}${r.rollNos ? ` · ${r.rollNos}` : ''}`, qty: intoStore(r) ? num(r.qty) : -num(r.qty), unit: r.unit, rate: r.rate, amount: r.amount }));
  g.debits.forEach((d) => add(d, { date: d.debitDate, department: 'Fabric Department', txType: 'Fabric Debit Note', module: 'fabricDebit',
    description: `${d.reason} · debited to ${d.debitTo === 'Supplier' ? d.supplierName || 'supplier' : d.debitTo === 'Department – accountability' ? d.debitParty : 'job'} · ${d.costEffect}${d.referenceDoc ? ` · ${d.referenceDoc}` : ''}`,
    qty: d.qty, unit: d.unit, rate: d.rate, amount: d.amount, costImpact: ['Accepted', 'Adjusted'].includes(d.status) ? d.costImpact : 0 }));
  // booking quantities not itemised by receipts / transfers / allocations (typed on the booking) – shown, never lost
  g.fabric.forEach((b) => {
    const itemisedIn = sum(g.receipts.filter((x) => String(x.booking) === String(b._id)), 'totalQty') + sum(transfersIn.filter((t) => String(t.toBooking) === String(b._id)), 'qty');
    const typedIn = r3(num(b.receivedQty) - itemisedIn);
    if (typedIn > 0.0005) add(b, { date: at(b, ['Received', 'Inspected', 'Approved']) || b.deliveryDate, department: 'Fabric Department', txType: 'Fabric Inward', module: 'fabricBooking', status: 'Booking entry', description: `Received on booking ${b.refNo} (supplier ${b.supplierName || '—'})`, qty: typedIn, unit: b.unit, rate: b.rate, amount: r2(typedIn * num(b.rate)), costImpact: typedIn * num(b.rate) });
    const allocated = sum(g.allocations.filter((x) => String(x.booking) === String(b._id)), 'totalQty');
    const typedOut = r3(num(b.issuedQty) - allocated);
    if (typedOut > 0.0005) add(b, { date: at(b, ['Issued']) || b.updatedAt, department: 'Fabric Department', txType: 'Fabric Issue', module: 'fabricBooking', status: 'Booking entry', description: `Issued to cutting on booking ${b.refNo}`, qty: typedOut, unit: b.unit, rate: b.rate, amount: r2(typedOut * num(b.rate)) });
    // fabric is consumed at cutting: dated by the job's last lay
    const lastLay = g.cutting.filter((c) => String(c.job) === String(b.job)).map((c) => c.entryDate).filter(Boolean).sort((a, b) => new Date(a) - new Date(b)).pop();
    if (num(b.usedQty) > 0) add(b, { date: lastLay || at(b, ['Fully Consumed', 'Consumed']) || b.updatedAt, department: 'Fabric Department', txType: 'Fabric Consumed', module: 'fabricBooking', description: `${b.refNo} consumed in production`, qty: b.usedQty, unit: b.unit, rate: b.rate, amount: r2(num(b.usedQty) * num(b.rate)) });
    if (b.status === 'Fabric Job Closed') add(b, { date: b.closedAt || at(b, ['Fabric Job Closed']), department: 'Fabric Department', txType: 'Fabric Job Closed', module: 'fabricBooking', description: `${b.refNo} closed – store balance ${r3(b.balanceQty)} ${b.unit}` });
  });

  // ---------- trims ----------
  g.trims.forEach((t) => {
    add(t, { date: t.bookingDate || at(t, ['Booked']) || t.createdAt, department: 'Factory Merchandising', txType: 'Trim Purchase', module: 'trimBooking', description: `${t.item} · ${t.description || ''} · supplier PO ${t.supplierPoNo || '—'}`, qty: t.bookingQty, unit: t.unit, rate: t.rate, amount: t.amount });
    if (num(t.receivedQty) > 0) add(t, { date: t.deliveryDate || at(t, ['Received']), department: 'Stores', txType: 'Trim Inward', module: 'trimBooking', description: `${t.item} received${num(t.issuedQty) ? ` · issued ${t.issuedQty}` : ''}`, qty: t.receivedQty, unit: t.unit, rate: t.rate, amount: t.actualAmount, costImpact: t.actualAmount });
  });

  // ---------- production, quality, finished goods ----------
  g.cutting.forEach((c) => add(c, { date: c.entryDate, department: 'Cutting', txType: 'Cutting', module: 'cutting', description: `Lay ${c.layNo || '—'} · ${c.plies || 0} plies · marker ${c.markerNo || '—'} · fabric used ${r3(c.fabricUsed)}${num(c.rejectQty) ? ` · reject ${c.rejectQty}` : ''}`, qty: c.cutQty, unit: 'pcs' }));
  g.sewing.forEach((s) => add(s, { date: s.entryDate, department: 'Sewing', txType: 'Sewing', module: 'sewing', description: `${s.line} · eff ${s.efficiencyPct}% · DHU ${s.dhu ?? '—'} · rejection ${s.rejection || 0}`, qty: s.actualQty, unit: 'pcs' }));
  g.finishing.forEach((f) => add(f, { date: f.entryDate, department: 'Finishing', txType: 'Finishing', module: 'finishing', description: `${f.process && f.process !== 'All' ? `${f.process} · ` : ''}Input ${f.inputQty} · passed ${f.passedQty} · alteration ${f.alteration || 0} · rework ${f.rework || 0} · rejection ${f.rejection || 0}${num(f.ironedQty) ? ` · ironed ${f.ironedQty}` : ''}${num(f.needleCheckedQty) ? ` · needle-checked ${f.needleCheckedQty}, metal found ${f.needleFailQty || 0}` : ''}`, qty: f.passedQty, unit: 'pcs' }));
  (g.hourly || []).forEach((h) => add(h, { date: h.entryDate, department: h.department, txType: 'Hourly Production', module: 'hourlyProduction', description: `${h.department}${h.line ? ` · ${h.line}` : ''} · ${h.shift} · ${(h.slots || []).length} hours · input ${h.inputQty} · completed ${h.completedQty} · rejected ${h.rejectedQty} · rework ${h.reworkQty}${num(h.downtimeMin) ? ` · downtime ${h.downtimeMin} min` : ''}`, qty: h.completedQty, unit: 'pcs' }));
  g.inspections.forEach((i) => add(i, { date: i.inspectionDate, department: 'Quality', txType: 'Quality Inspection', module: 'inspection', description: `${i.inspectionStage || i.inspectionType} · lot ${i.lotSize} · ${i.inspectionAgency || ''} · defects ${i.totalDefects ?? '—'} · AQL ${i.aqlResult || '—'}${i.passQty !== undefined && i.passQty !== null ? ` · passed ${i.passQty}, rework ${i.reworkQty || 0}, rejected ${i.rejectQty || 0}, held ${i.heldQty || 0}` : ''}`, qty: i.lotSize, unit: 'pcs' }));
  (g.reworks || []).forEach((r) => add(r, { date: r.issueDate, department: r.assignedDept || 'Quality', txType: 'Quality Issue / Rework', module: 'qcRework', description: `${r.inspectionStage} · ${r.defectType || ''} · failed ${r.failedQty} · reworked ${r.reworkedQty || 0} · passed on reinspection ${r.reinspPassedQty || 0} · rejected ${num(r.reinspRejectedQty) + num(r.scrapQty)} · released ${r.releasedQty || 0} · pending ${r.pendingQty || 0}${r.correctiveAction ? ` · CA: ${r.correctiveAction}` : ''}`, qty: r.failedQty, unit: 'pcs' }));
  g.packing.forEach((p) => add(p, { date: p.packingDate, department: 'Packing', txType: 'Packing → Finished Goods', module: 'packing', description: `${p.totalCartons} cartons · ${r3(p.totalCbm)} CBM`, qty: p.totalQty, unit: 'pcs' }));
  g.shipments.forEach((s) => {
    const j = jobOf.get(String(s.job));
    add(s, { date: s.actualShipDate || s.shipmentDate, department: 'Shipment', txType: 'Shipment → Finished Goods Out', module: 'shipment', description: `${s.mode} · ${s.vesselFlight || ''} · BL ${s.blAwbNo || '—'} · ${s.cartons || 0} ctns · export inv ${s.invoiceNo || '—'}`,
      qty: SHIPPED.includes(s.status) ? s.qty : 0, unit: 'pcs', rate: j?.unitPrice, amount: r2(num(s.qty) * num(j?.unitPrice)) });
  });
  // ---------- accounts ----------
  g.invoices.forEach((i) => add(i, { refNo: i.invoiceNo, date: i.invoiceDate, department: 'Accounts', txType: 'Invoice', module: 'invoice', description: `${i.qty} pcs · due ${i.dueDate ? new Date(i.dueDate).toISOString().slice(0, 10) : '—'} · outstanding ${r2(i.outstanding)}`, qty: i.qty, unit: 'pcs', rate: i.unitPrice, amount: i.totalAmount, revenueImpact: i.status === 'Draft' ? 0 : i.totalAmount }));
  g.payments.forEach((p) => add(p, { date: p.paymentDate, department: 'Accounts', txType: 'Payment', module: 'payment', description: `${p.mode} ${p.reference || ''} · bank charges ${p.bankCharges || 0}`, amount: p.amount }));
  g.expenses.forEach((e) => add(e, { date: e.expenseDate, department: 'Accounts', txType: 'Expense', module: 'expense', description: `${e.category} · ${e.description || ''} · ${e.vendor || ''} bill ${e.billNo || '—'}`, amount: e.amount, costImpact: financeLineOf(e.category) ? 0 : e.amount }));
  // accounts payable: supplier invoices, set-offs and payments (the payable – job cost is already recognised at receipt / expense)
  g.bills.forEach((b) => {
    add(b, { refNo: b.billNo, date: b.billDate, department: 'Accounts', txType: 'Supplier Bill', module: 'supplierBill', description: `${b.billType} · ${b.supplierName || ''} · PO ${b.poRef || '—'} · tax ${r2(b.taxAmount)}${num(b.debitNoteAdjusted) ? ` · debit notes set off ${r2(b.debitNoteAdjusted)} (${b.debitNoteRefs || ''})` : ''} · outstanding ${r2(b.outstanding)}`, qty: b.qty, unit: b.unit, rate: b.rate, amount: b.totalAmount, status: `${b.status} · ${b.paymentStatus}` });
    (b.payments || []).forEach((p, i) => add(b, { refNo: p.reference || `${b.billNo}/P${i + 1}`, date: p.date, department: 'Accounts', txType: 'Supplier Payment', module: 'supplierBill', description: `${p.mode || ''} to ${b.supplierName || 'supplier'} against ${b.billNo}`, amount: p.amount, status: 'Paid' }));
  });
  (g.factoryExpenses || []).forEach((e) => add(e, { date: e.expenseDate, department: QUALITY_EXPENSE_CATEGORIES.includes(e.category) ? 'Quality' : 'Accounts', txType: 'Factory Expense (job)', module: 'factoryExpense', description: `${e.category} · ${e.payee} bill ${e.referenceNo || '—'} · ${e.description || ''}`, amount: e.amount, costImpact: e.amount }));
  g.docs.forEach((d) => add(d, { date: d.createdAt, department: 'Shipment / Documentation', txType: 'Document', module: 'documents', description: `${d.docType} · ${d.title || ''} (v${d.currentVersion || 1})`, status: 'Uploaded' }));

  // ---------- per job: standard costs, reconciliation ----------
  const perJob = [];
  const leafGraphs = g.subJobs.length ? await Promise.all(g.subJobs.map((s) => loadJobGraph(s))) : [g];
  const mainOnly = g.subJobs.length ? [main] : [];
  for (const sg of leafGraphs) perJob.push(await reconcile(sg, rows, add, withMoney));
  for (const m of mainOnly) perJob.unshift(await reconcile({ ...g, job: m }, rows, add, withMoney, true));
  jobs.filter((j) => j.status === 'Closed').forEach((j) => add(j, { jobNo: j.jobNo, refNo: j.jobNo, date: j.closedAt, department: 'Admin', txType: 'Job Closed', module: 'orders', status: 'Closed', description: `Closed by ${j.closedByName || '—'} · ${j.closureRemarks || ''}` }));

  const seq = (t) => { const i = SEQ.indexOf(t); return i < 0 ? 99 : i; };
  rows.sort((a, b) => (new Date(a.date || 0) - new Date(b.date || 0)) || seq(a.txType) - seq(b.txType) || String(a.jobNo).localeCompare(String(b.jobNo)));
  rows.forEach((r, i) => { r.seq = i + 1; r.mainJobNo = main.jobNo; });
  if (!withMoney) rows.forEach((r) => { r.amount = null; r.costImpact = null; r.revenueImpact = null; r.rate = null; });
  const unitName = units.find((u) => u.code === main.businessUnit)?.name || main.businessUnit;
  const consolidated = perJob[0];
  return {
    generatedAt: new Date(), unit: main.businessUnit, unitName, isSampleData: !!main.isSampleData,
    main: { _id: main._id, jobNo: main.jobNo, orderNo: main.orderNo, buyerName: main.buyerName, styleNo: main.styleNo, poNo: main.poNo, jobType: main.jobType, status: main.status, closedAt: main.closedAt, closedByName: main.closedByName, orderQty: main.orderQty, unitPrice: main.unitPrice, currency: main.currency },
    subJobs: g.subJobs.map((s) => s.jobNo),
    jobs: perJob, rows,
    checksPassed: perJob.every((p) => p.checks.every((c) => c.ok)),
    consolidated,
  };
}

/** Everything still open on a job: unsettled debits, unaccepted returns, fabric / trims not received, unshipped goods, money owed. */
function openItems(g, q, withMoney) {
  const items = [];
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
  const push = (type, ref, detail, amount) => items.push({ type, ref, detail, ...(withMoney && amount !== undefined ? { amount: r2(amount) } : {}) });
  g.debits.filter((d) => d.status === 'Raised').forEach((d) => push('Unresolved fabric debit note', d.refNo, `${d.reason} – ${d.debitTo}`, d.amount));
  g.returns.filter((r) => r.status === 'Returned').forEach((r) => push('Fabric return not accepted', r.refNo, `${r.returnType} ${r.qty} ${r.unit}`, r.amount));
  g.allocations.filter((a) => a.status === 'Allocated').forEach((a) => push('Fabric reserved, not issued', a.refNo, `${a.totalRolls} roll(s), ${r3(a.totalQty)} ${a.unit} held for ${a.cuttingTable || 'cutting'}`));
  g.fabric.filter((b) => num(b.pendingReceipt) > 0.0005).forEach((b) => push('Fabric PO pending receipt', b.refNo, `${r3(b.pendingReceipt)} ${b.unit} of ${b.bookedQty} not received (PO ${b.supplierPoNo || '—'})`, num(b.pendingReceipt) * num(b.rate)));
  g.trims.filter((t) => num(t.bookingQty) - num(t.receivedQty) > 0).forEach((t) => push('Trim PO pending receipt', t.refNo, `${t.item}: ${num(t.bookingQty) - num(t.receivedQty)} ${t.unit} not received`));
  if (q.packed - q.shipped > 0) push('Finished goods not shipped', g.job.jobNo, `${q.packed - q.shipped} pcs packed, in the finished goods store`);
  g.invoices.filter((i) => num(i.outstanding) > 0.005).forEach((i) => push('Buyer payment pending', i.invoiceNo, `due ${day(i.dueDate)}`, i.outstanding));
  g.bills.filter((b) => num(b.outstanding) > 0.005).forEach((b) => push('Supplier bill outstanding', b.billNo, `${b.supplierName || ''} · ${b.billType} · due ${day(b.dueDate)}`, b.outstanding));
  g.shipments.filter((s) => s.status === 'Shipped').forEach((s) => push('Delivery not confirmed', s.refNo, `shipped ${day(s.actualShipDate)} – awaiting buyer receipt / proof of delivery`));
  return items;
}

/** Quantity and amount reconciliation of one job (a leaf job, or the main job consolidating its sub jobs). */
async function reconcile(g, rows, add, withMoney, isMain = false) {
  const j = g.job;
  const mine = (r) => (isMain ? true : r.jobNo === j.jobNo);
  const p = computeProfit(g);
  const lc = await computeStages(g);
  // a bucket without any actual cost is charged at standard – booked here so the ledger ties to the profit
  if (!isMain) p.heads.filter((h) => h.basis === 'standard' && num(h.actual) > 0).forEach((h) => add(null, {
    jobNo: j.jobNo, refNo: `STD-${h.key}`, date: j.closedAt || g.shipments.map((s) => s.actualShipDate || s.shipmentDate).filter(Boolean).sort((a, b) => new Date(a) - new Date(b)).pop() || g.packing.map((x) => x.packingDate).filter(Boolean).sort((a, b) => new Date(a) - new Date(b)).pop(),
    department: 'Accounts', txType: 'Standard Cost Applied', module: 'profit', status: 'Standard', description: `${h.label}: no actual cost booked – costed ${h.estimatedPerPc}/pc × ${p.producedQty} pcs`, amount: h.actual, costImpact: h.actual,
  }));
  // payroll / attendance labour and factory overhead allocated to the job – booked so the ledger ties to the profit
  if (!isMain) {
    const al = jobAllocation(g.alloc, j._id);
    const lastProd = [...(g.hourly || []).map((h) => h.entryDate), ...g.sewing.map((x) => x.entryDate)].filter(Boolean).sort((a, b) => new Date(a) - new Date(b)).pop() || j.closedAt;
    const lines = [
      ['Labour Allocated', 'ALLOC-LABOUR', al.labourActual + al.labourEstimated, al.labourEstimated, `Production labour from payroll / attendance by department: ${Object.entries(al.byDept).filter(([k]) => !['Checking', 'Quality Control', 'Quality Inspection'].includes(k)).map(([k, v]) => `${k} ${r2(v)}`).join(' · ')}`],
      ['Inspection Labour Allocated', 'ALLOC-QC', al.qualityLabourActual + al.qualityLabourEstimated, al.qualityLabourEstimated, 'Checking, end-line QC and inspection sections'],
      ['Factory Overhead Allocated', 'ALLOC-OH', al.overheadActual + al.overheadEstimated, al.overheadEstimated, 'Factory expenses and indirect labour, by sewing output share (normal-capacity absorption)'],
    ];
    lines.filter(([, , amt]) => num(amt) > 0.004).forEach(([txType, refNo, amt, est, description]) => add(null, {
      jobNo: j.jobNo, refNo, date: lastProd, department: 'Accounts', txType, module: 'factory', status: num(est) > 0.004 ? `Includes ${r2(est)} estimated` : 'Actual', description, amount: r2(amt), costImpact: amt,
    }));
  }
  const R = rows.filter(mine);
  const fab = (t) => R.filter((r) => r.txType === t);
  const received = r3(sum(fab('Fabric Inward').filter((r) => r.module !== 'fabricReceipt' || g.receipts.some((x) => String(x._id) === String(r.recordId) && x.booking)), 'qty') + sum(fab('Fabric Transfer In'), 'qty'));
  const issued = r3(sum(fab('Fabric Issue'), 'qty'));
  const returns = g.returns;
  const retStore = r3(sum(returns.filter((r) => r.returnType === RETURN_TO_STORE), 'qty'));
  const retSupplierBooking = r3(sum(returns.filter((r) => r.returnType === RETURN_TO_SUPPLIER && r.booking), 'qty'));
  const adjusted = r3(sum(returns.filter((r) => r.returnType === ADJUST_EXCESS), 'qty') - sum(returns.filter((r) => r.returnType === ADJUST_SHORT), 'qty'));
  const used = r3(sum(g.cutting, 'fabricUsed'));
  const q = {
    cut: sum(g.cutting, 'cutQty'), sewn: sum(g.sewing, 'actualQty'), finished: sum(g.finishing, 'passedQty'),
    packed: sum(g.packing.filter((x) => x.status !== 'Draft'), 'totalQty'), shipped: sum(g.shipments.filter((s) => SHIPPED.includes(s.status)), 'qty'),
    invoicedQty: sum(g.invoices.filter((i) => i.status !== 'Draft'), 'qty'),
  };
  const invoiced = r2(sum(g.invoices, 'totalAmount')); const paid = r2(sum(g.payments, 'amount'));
  const ledgerCost = r2(sum(R, 'costImpact')); const ledgerRevenue = r2(sum(R, 'revenueImpact'));
  const booking = {
    received: r3(sum(g.fabric, 'receivedQty')), issued: r3(sum(g.fabric, 'issuedQty')), reserved: r3(sum(g.fabric, 'reservedQty')), netIssued: r3(sum(g.fabric, 'issuedQty') - sum(g.fabric, 'returnedFromCuttingQty')),
    balance: r3(sum(g.fabric, 'balanceQty')), used: r3(sum(g.fabric, 'usedQty')),
  };
  const ck = (label, expected, actual, tol = 0.01) => ({ label, expected, actual, ok: Math.abs(num(expected) - num(actual)) <= tol });
  const le = (label, a, b) => ({ label, expected: `≤ ${b}`, actual: a, ok: num(a) <= num(b) + 0.0005 });
  const checks = [
    ck('Fabric received = inward + transfer-in transactions', booking.received, received, 0.002),
    ck('Fabric issued = issue transactions', booking.issued, issued, 0.002),
    ck('Fabric reserved = open reservation transactions', booking.reserved, r3(sum(fab('Fabric Reservation'), 'qty')), 0.002),
    ck('Fabric store balance = received − returned to supplier ± count adjustments − issued + returned from cutting', booking.balance, r3(received - retSupplierBooking + adjusted - issued + retStore), 0.002),
    le('Fabric used in cutting ≤ net issued', used, booking.netIssued),
    le('Sewn ≤ cut', q.sewn, q.cut), le('Finished ≤ sewn', q.finished, q.sewn), le('Packed (finished goods in) ≤ finished', q.packed, q.finished),
    le('Shipped (finished goods out) ≤ packed', q.shipped, q.packed), le('Shipped ≤ order qty', q.shipped, num(j.orderQty)),
    le('Invoiced qty ≤ shipped qty', q.invoicedQty, q.shipped),
    ...(withMoney ? [
      le('Payments ≤ invoiced', paid, invoiced),
      ck('Revenue = invoices', r2(p.revenue), ledgerRevenue || r2(q.shipped * num(j.unitPrice))),
      ck('Job cost = sum of cost transactions', r2(p.totalExpenses), ledgerCost),
      ck('Profit = revenue − cost', r2(p.actualProfit), r2(p.revenue - ledgerCost)),
    ] : []),
    ...(j.status === 'Closed' ? [{ label: 'No open closure conditions at closure', expected: 'none', actual: 'none', ok: true }] : [{ label: 'Closure readiness', expected: 'ready', actual: lc.readyToClose ? 'ready' : lc.blockers.join('; ') || 'open', ok: true, info: true }]),
  ];
  return {
    jobNo: j.jobNo, isMain, jobType: j.jobType, poNo: j.poNo, status: j.status, orderQty: num(j.orderQty), unitPrice: j.unitPrice, closedAt: j.closedAt, closedByName: j.closedByName,
    transactions: R.length,
    fabric: { unit: g.fabric[0]?.unit || g.forecasts[0]?.unit || '', booked: r3(sum(g.fabric, 'bookedQty')), forecastReceived: r3(sum(g.forecasts, 'receivedQty')), received, pendingReceipt: r3(sum(g.fabric, 'pendingReceipt')), returnedToSupplier: r3(sum(returns.filter((r) => r.returnType === RETURN_TO_SUPPLIER), 'qty')), adjusted, issued, returnedFromCutting: retStore, reserved: booking.reserved, netIssued: booking.netIssued, usedInCutting: used, consumed: booking.used, storeBalance: booking.balance },
    debits: { count: g.debits.length, recovery: r2(-sum(g.debits.filter((d) => ['Accepted', 'Adjusted'].includes(d.status) && num(d.costImpact) < 0), 'costImpact')), charges: r2(sum(g.debits.filter((d) => ['Accepted', 'Adjusted'].includes(d.status) && num(d.costImpact) > 0), 'costImpact')), open: g.debits.filter((d) => d.status === 'Raised').length },
    production: {
      ...q, finishedGoodsBalance: q.packed - q.shipped, balanceToShip: Math.max(num(j.orderQty) - q.shipped, 0),
      rejected: sum(g.cutting, 'rejectQty') + sum(g.sewing, 'rejection') + sum(g.finishing, 'rejection'),
      qcPassed: sum(g.inspections.filter((i) => ['Final', 'Re-inspection'].includes(i.inspectionType) && ['Passed', 'Final Approved'].includes(i.status)), 'lotSize'),
    },
    openItems: openItems(g, q, withMoney),
    ...(withMoney ? { accounts: { invoiced, received: paid, outstanding: r2(invoiced - paid), cost: ledgerCost, revenue: r2(p.revenue), profit: r2(p.actualProfit), marginPct: p.revenue ? round((p.actualProfit / p.revenue) * 100, 2) : 0, costBasis: p.costBasis } } : {}),
    checks,
  };
}
