/**
 * Order & Job Tracking – New Orders, repeat / forecast orders, advance jobs, pending PO, unfinished jobs,
 * finished-but-not-shipped, shipment and closure lists (see shared/tracking.js).
 *
 * Built from the live records of the requested unit scope on every call: buyer orders, jobs and the
 * fabric bookings, production entries, inspections, packing, shipments, invoices and payments linked
 * to them. Quantities, stages and statuses are never taken from manually entered summaries.
 */
import { models } from '../modules/builder.js';
import { getSetting } from './settings.js';
import { loadJobGraphs, computeProfit } from './lifecycle.js';
import { num, sum, round } from '../../../shared/calc.js';
import { PENDING_STAGES, UNFINISHED_STAGES, TRACKING_LISTS } from '../../../shared/tracking.js';

const DAY = 86400000;
const today = () => new Date(new Date().toDateString());
const STAGE = Object.fromEntries(PENDING_STAGES.map((s) => [s.key, s]));
const SHIPPED = ['Shipped', 'Delivered'];
const STATE_LABEL = { done: 'Completed', active: 'In progress', delayed: 'Delayed', pending: 'Pending', na: 'N/A' };
const PRE_STAGES = ['order', 'spec', 'bom', 'cad', 'pattern', 'grading', 'marker', 'tna', 'ppMeeting', 'trims', 'sampling', 'approval', 'planning'];
const lastDate = (rows, field) => rows.map((r) => r[field]).filter(Boolean).map((d) => new Date(d)).sort((a, b) => b - a)[0] || null;

function delayOf(due, done) {
  if (done) return 'Completed';
  if (!due) return 'No date';
  const days = Math.round((today() - new Date(due)) / DAY);
  if (days > 0) return `Delayed ${days}d`;
  if (days >= -7) return `Due in ${-days}d`;
  return 'On time';
}

/** One row per job with every tracked quantity and where the job is waiting. */
function jobRow(g, { target, workflow, unitName, withProfit, jobsByNo }) {
  const j = g.job;
  const qty = num(j.orderQty);
  const goal = qty * target;
  const reached = (v) => qty > 0 && v >= goal - 1e-9;
  const fabricUnit = g.fabric[0]?.unit || g.forecasts[0]?.unit || '';
  const required = sum(g.fabric, 'requiredQty');
  const booked = sum(g.fabric, 'bookedQty');
  const received = sum(g.fabric, 'receivedQty');
  const issued = sum(g.fabric, 'issuedQty');
  const cut = sum(g.cutting, 'cutQty');
  const sewn = sum(g.sewing, 'actualQty');
  const finished = sum(g.finishing, 'passedQty');
  const packs = g.packing.filter((p) => p.status !== 'Draft');
  const packed = sum(packs, 'totalQty');
  const cartons = sum(packs, 'totalCartons');
  const finals = g.inspections.filter((i) => ['Final', 'Re-inspection'].includes(i.inspectionType) || !i.inspectionType);
  const passed = finals.filter((i) => ['Passed', 'Final Approved'].includes(i.status));
  const qcApproved = Math.min(sum(passed, 'lotSize'), packed || sum(passed, 'lotSize'));
  const shippedRows = g.shipments.filter((s) => SHIPPED.includes(s.status));
  const shipped = sum(shippedRows, 'qty');
  const openShipments = g.shipments.filter((s) => !SHIPPED.includes(s.status));
  const invoices = g.invoices.filter((i) => i.status !== 'Cancelled');
  const invoicedQty = sum(invoices.filter((i) => i.status !== 'Draft'), 'qty');
  const invTotal = sum(invoices, 'totalAmount');
  const paid = sum(g.payments, 'amount');
  const st = j.stages || {};
  const closedOrCancelled = ['Closed', 'Cancelled'].includes(j.status);

  // fabric booking status from the bookings (or the forecast for a main job)
  let fabricStatus;
  if (!g.fabric.length) fabricStatus = g.forecasts.length ? `Forecast ${g.forecasts.map((f) => f.status).join(', ')}` : 'Not booked';
  else if (required > 0 && issued >= required * 0.999) fabricStatus = 'Issued';
  else if (required > 0 && received >= required * 0.999) fabricStatus = 'Received';
  else if (received > 0) fabricStatus = `Partly received (${Math.round((received / required) * 100)}%)`;
  else if (booked > 0) fabricStatus = 'Booked – not received';
  else fabricStatus = 'Not booked';

  // where the job waits now (production-flow order) and why
  let stage = null; let reason = '';
  if (j.status === 'Cancelled') stage = null;
  else if (j.status === 'Closed') stage = null;
  else if (j.poStatus === 'Awaiting PO') { stage = 'po'; reason = j.expectedOrderMonth ? `Advance job – buyer PO expected ${j.expectedOrderMonth}` : 'Advance job – buyer PO not received'; }
  else if (!reached(cut) && (!g.fabric.length || (required > 0 && received < required * 0.999))) {
    stage = 'fabric';
    reason = !g.fabric.length || booked <= 0 ? 'Fabric not booked' : `Received ${round(received, 1)} of ${round(required, 1)} ${fabricUnit}`;
  } else if (cut <= 0 && PRE_STAGES.includes(j.currentStage)) {
    stage = 'preproduction';
    const w = workflow.find((x) => x.key === j.currentStage);
    reason = `${w?.label || j.currentStage} pending`;
  } else if (!reached(cut)) { stage = 'cutting'; reason = `Cut ${cut} of ${qty}`; }
  else if (!reached(sewn)) { stage = 'sewing'; reason = `Sewn ${sewn} of ${qty}`; }
  else if (!reached(finished)) { stage = 'finishing'; reason = `Finished ${finished} of ${qty}`; }
  else if (!reached(packed)) { stage = 'packing'; reason = `Packed ${packed} of ${qty}`; }
  else if (!passed.length) { stage = 'quality'; reason = finals.length ? `Final inspection ${finals[finals.length - 1].status}` : 'Final inspection not done'; }
  else if (!reached(shipped)) {
    stage = 'shipment';
    reason = openShipments.length ? `Shipment ${openShipments.map((s) => s.status).join(', ')} – not shipped` : 'Shipment not booked';
  } else if (!invoices.length || invoicedQty < shipped) { stage = 'accounts'; reason = 'Invoice not raised for the shipped quantity'; }
  else if (invTotal - paid > 0.01 && !j.outstandingApproved) { stage = 'accounts'; reason = `Payment outstanding ${round(invTotal - paid)} ${j.currency || ''}`; }
  else { stage = 'closure'; reason = (j.closureBlockers || []).join('; ') || 'Ready to close'; }
  const w = stage === 'preproduction' ? workflow.find((x) => x.key === j.currentStage) : null;

  // why the job is held or blocked (explicit hold first, then quality, trims, fabric, approvals)
  let hold = null;
  if (j.status === 'On Hold') {
    const why = [...(j.statusHistory || [])].reverse().find((h) => h.to === 'On Hold')?.reason || 'On hold';
    const dept = /capacit|line|machine/i.test(why) ? 'Production' : /fabric/i.test(why) ? 'Fabric Department' : /trim|access/i.test(why) ? 'Factory Merchandising' : /quality|inspect/i.test(why) ? 'Quality' : /approv|sample/i.test(why) ? 'Head Office Merchandising' : 'Admin';
    hold = [`On hold – ${why}`, dept];
  } else {
    const lastInsp = [...g.inspections].sort((a, b) => new Date(a.inspectionDate) - new Date(b.inspectionDate)).pop();
    // pieces held by quality: open quality issues with a pending quantity (rework / reinspection not finished)
    const heldIssues = (g.reworks || []).filter((r) => r.status !== 'Closed' && num(r.pendingQty) > 0);
    if (heldIssues.length) hold = [`Quality – ${sum(heldIssues, 'pendingQty')} pcs on hold (${heldIssues.map((r) => `${r.refNo} ${r.inspectionStage}`).join(', ')}), rework / reinspection pending`, 'Quality'];
    else if (lastInsp?.status === 'Failed') hold = [`Quality – ${lastInsp.inspectionStage || lastInsp.inspectionType} inspection failed (${lastInsp.refNo}), re-inspection pending`, 'Quality'];
    else if (st.trims === 'delayed') hold = ['Trims shortage – booked trims overdue', 'Factory Merchandising'];
    else if (st.fabric === 'delayed') hold = ['Fabric shortage – booked fabric overdue', 'Fabric Department'];
    else if ([st.approval, st.sampling].includes('delayed')) hold = ['Approval pending – sample rejected / resubmission due', 'Head Office Merchandising'];
  }
  const lastPack = [...packs].sort((a, b) => new Date(a.packingDate) - new Date(b.packingDate)).pop();
  const fgLocation = lastPack ? [lastPack.warehouse, lastPack.location].filter(Boolean).join(' · ') || 'FG store' : '';
  const nextEtd = openShipments.map((s) => s.etd || s.shipmentDate).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0];
  const delayReason = !reached(packed) ? `Packing in progress (${packed} of ${qty})`
    : !passed.length ? 'Final inspection pending'
      : !openShipments.length ? 'Shipment not booked'
        : nextEtd && new Date(nextEtd) >= today() ? `Vessel / flight booked – ETD ${new Date(nextEtd).toISOString().slice(0, 10)}` : 'Booked shipment not yet sailed';
  const plannedShip = openShipments.map((s) => s.etd || s.shipmentDate).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] || j.shipmentDate;
  const fgSince = lastDate(packs, 'packingDate') || lastDate(g.finishing, 'entryDate');
  const p = withProfit ? computeProfit(g) : null;
  const prev = j.repeatOfJobNo ? jobsByNo.get(j.repeatOfJobNo) : null;
  return {
    _id: j._id, unit: j.businessUnit, unitName, jobNo: j.jobNo, mainJobNo: j.parentJobNo || j.jobNo, subJobNo: j.parentJob ? j.jobNo : '',
    isSub: !!j.parentJob, isMain: !!(j.isForecast && !j.parentJob && g.subJobs.length), jobType: j.jobType, isSampleData: !!j.isSampleData,
    buyerName: j.buyerName, styleNo: j.styleNo, garment: [j.product, j.garmentType].filter(Boolean).join(' · '), poNo: j.poNo || '—', poStatus: j.poStatus || 'PO Received',
    repeatOfJobNo: j.repeatOfJobNo || '', previousPoNo: prev?.poNo || '', previousQty: prev?.orderQty ?? null, expectedOrderMonth: j.expectedOrderMonth || '',
    orderQty: qty, forecastQty: num(j.forecastQty) || (j.poStatus === 'Awaiting PO' ? qty : 0), orderDate: j.orderDate, deliveryDate: j.deliveryDate || j.shipmentDate, shipmentDate: j.shipmentDate,
    status: j.status, currentStage: j.currentStage, progressPct: j.progressPct || 0, readyToClose: !!j.readyToClose, closedAt: j.closedAt,
    fabricUnit, fabricRequired: round(required, 2), fabricBooked: round(booked, 2), fabricReceived: round(received, 2), fabricIssued: round(issued, 2), fabricStatus,
    cutQty: cut, sewnQty: sewn, finishedQty: finished, qcApprovedQty: qcApproved, packedQty: packed, cartons, shippedQty: shipped,
    cuttingStatus: STATE_LABEL[st.cutting] || 'Pending', sewingStatus: STATE_LABEL[st.sewing] || 'Pending', finishingStatus: STATE_LABEL[st.finishing] || 'Pending', packingStatus: STATE_LABEL[st.packing] || 'Pending',
    pendingQty: Math.max(qty - packed, 0), balanceToShip: Math.max(qty - shipped, 0),
    productionDone: reached(finished), fullyPacked: reached(packed), fullyShipped: reached(shipped),
    packState: reached(packed) ? 'Fully packed' : packed > 0 ? `Partially packed (${Math.round((packed / qty) * 100)}%)` : 'Not packed',
    shipmentBooking: openShipments.length ? openShipments.map((s) => `${s.refNo} ${s.status}`).join(', ') : shipped > 0 ? 'Balance not booked' : 'Not booked',
    invoiceStatus: !invoices.length ? 'Not invoiced' : invoices.map((i) => i.status).join(', '),
    paymentStatus: !invTotal ? '—' : paid >= invTotal - 0.01 ? 'Fully paid' : paid > 0 ? `Part paid ${Math.round((paid / invTotal) * 100)}%` : 'Unpaid',
    plannedShipDate: plannedShip, lastShipDate: lastDate(shippedRows, 'actualShipDate') || lastDate(shippedRows, 'shipmentDate'),
    daysPendingShipment: fgSince && !reached(shipped) ? Math.max(Math.round((today() - fgSince) / DAY), 0) : null,
    delayStatus: closedOrCancelled ? j.status : delayOf(j.shipmentDate, reached(shipped)),
    pendingStage: stage, pendingStageLabel: stage ? (w ? `Pre-production: ${w.label}` : STAGE[stage].label) : j.status, pendingReason: reason,
    responsibleDept: stage ? (w?.department || STAGE[stage].department) : '',
    blockers: (j.closureBlockers || []).join('; '),
    holdReason: hold?.[0] || '', holdDept: hold?.[1] || '', fgLocation, delayReason,
    ...(p ? { cost: round(p.totalExpenses), revenue: round(p.revenue), profit: round(p.actualProfit), marginPct: p.revenue ? round((p.actualProfit / p.revenue) * 100, 1) : null } : {}),
  };
}

const forecastStatus = (r, subs) => {
  if (r.status === 'Closed') return 'Closed';
  if (r.status === 'Cancelled') return 'Cancelled';
  if (r.poStatus === 'Awaiting PO' && !subs.length) return 'Forecast – awaiting PO';
  if (!subs.length) return 'PO received';
  const confirmed = subs.filter((s) => s.poStatus !== 'Awaiting PO').length;
  return confirmed === subs.length ? 'All call-offs confirmed' : `${confirmed} of ${subs.length} call-offs confirmed`;
};

/**
 * @param {object} q  filters: buyer, jobNo, poNo, status, stage, from, to (delivery date)
 * @param {object} o  { withProfit }
 */
export async function buildTracking(q = {}, { withProfit = false } = {}) {
  const [jobs, buyerOrders, units, workflow, tol] = await Promise.all([
    models.orders.find({ isDeleted: false }).lean(),
    models.buyerOrder.find({ isDeleted: false }).sort({ orderDate: -1, createdAt: -1 }).lean(),
    getSetting('units'), getSetting('workflow'), getSetting('tolerance'),
  ]);
  const unitName = (code) => units.find((u) => u.code === code)?.name || code;
  const target = 1 - num(tol.shortShipPct) / 100;
  const jobsByNo = new Map(jobs.map((j) => [j.jobNo, j]));
  const graphs = await loadJobGraphs(jobs);
  const rows = graphs.map((g) => jobRow(g, { target, workflow, unitName: unitName(g.job.businessUnit), withProfit, jobsByNo }));
  const subsOf = (jobNo) => rows.filter((r) => r.isSub && r.mainJobNo === jobNo);

  // forecast view of a job: previous job, forecast qty, sub jobs, forecast / PO status
  const forecastRow = (r) => {
    const subs = subsOf(r.jobNo);
    const awaiting = subs.filter((s) => s.poStatus === 'Awaiting PO').length;
    return {
      ...r, kind: 'forecast',
      forecastQty: r.isMain ? Math.max(num(jobsByNo.get(r.jobNo)?.forecastQty), r.orderQty) : r.forecastQty || r.orderQty,
      subJobs: subs.map((s) => `${s.jobNo} (${s.orderQty}${s.poStatus === 'Awaiting PO' ? ', no PO' : `, ${s.poNo}`})`).join('; ') || (r.isSub ? `Sub job of ${r.mainJobNo}` : '—'),
      forecastStatus: r.isSub ? (r.poStatus === 'Awaiting PO' ? 'Call-off – awaiting PO' : 'Call-off confirmed') : forecastStatus(r, subs),
      poStatusText: subs.length ? (awaiting ? `${subs.length - awaiting} of ${subs.length} sub jobs PO-backed` : 'All sub jobs PO-backed') : r.poStatus === 'Awaiting PO' ? 'Awaiting PO' : `Received – ${r.poNo}`,
    };
  };
  const orderRow = (b) => ({
    _id: b._id, kind: 'order', source: 'order', unit: b.businessUnit, unitName: unitName(b.businessUnit), refNo: b.refNo, buyerName: b.buyerName, poNo: b.poNo, styleNo: b.styleNo,
    garment: [b.product, b.garmentType].filter(Boolean).join(' · '), orderType: b.orderType || 'New Order', orderQty: num(b.orderQty), orderDate: b.orderDate,
    deliveryDate: b.deliveryDate, status: b.status, jobCreation: b.jobCreation || (b.jobNo ? `Job ${b.jobNo}` : b.status === 'Cancelled' ? 'Cancelled' : 'Awaiting job creation'),
    jobNo: b.jobNo || '', repeatOfJobNo: b.repeatOfJobNo || '', isSampleData: !!b.isSampleData,
  });
  // a repeat buyer PO not yet on a job, shown in the repeat / forecast format
  const repeatPoRow = (b) => {
    const prev = b.repeatOfJobNo ? jobsByNo.get(b.repeatOfJobNo) : null;
    return {
      ...orderRow(b), kind: 'forecast', previousPoNo: prev?.poNo || '', previousQty: prev?.orderQty ?? null, expectedOrderMonth: b.orderDate ? new Date(b.orderDate).toISOString().slice(0, 7) : '',
      forecastQty: num(b.orderQty), jobNo: '', subJobs: '—', forecastStatus: `Repeat PO ${b.status}`, poStatusText: `Received – ${b.poNo} (awaiting job)`,
    };
  };

  // ---------- filters ----------
  const has = (v, s) => !s || String(v || '').toLowerCase().includes(String(s).toLowerCase());
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(`${q.to}T23:59:59`) : null;
  const pass = (r) => has(r.buyerName, q.buyer)
    && (!q.jobNo || has(r.jobNo, q.jobNo) || has(r.mainJobNo, q.jobNo) || has(r.repeatOfJobNo, q.jobNo))
    && (!q.poNo || has(r.poNo, q.poNo)) && (!q.status || r.status === q.status)
    && (!q.stage || r.pendingStage === q.stage)
    && (!from || (r.deliveryDate && new Date(r.deliveryDate) >= from)) && (!to || (r.deliveryDate && new Date(r.deliveryDate) <= to));

  const live = rows.filter((r) => r.status !== 'Cancelled');
  const [fabricPos, trimPos] = await Promise.all([
    models.fabricBooking.find({ isDeleted: false, bookedQty: { $gt: 0 }, status: { $nin: ['Fabric Job Closed', 'Cancelled'] } }).lean(),
    models.trimBooking.find({ isDeleted: false, status: { $in: ['Booked', 'In Transit'] } }).lean(),
  ]);
  const jobRowOf = new Map(rows.map((r) => [r.jobNo, r]));
  const poRow = (b, poType, item, ordered) => {
    const j = jobRowOf.get(b.jobNo);
    const pending = Math.max(round(num(ordered) - num(b.receivedQty), 3), 0);
    return {
      _id: b._id, kind: 'po', unit: b.businessUnit, unitName: unitName(b.businessUnit), jobNo: b.jobNo, mainJobNo: j?.mainJobNo || b.jobNo, buyerName: b.buyerName, poNo: b.poNo,
      refNo: b.refNo, poType, item, supplierName: b.supplierName || '—', supplierPoNo: b.supplierPoNo || '—', bookedQty: num(ordered), receivedQty: num(b.receivedQty), pendingQty: pending,
      uom: b.unit, dueDate: b.deliveryDate, deliveryDate: b.deliveryDate, delayStatus: delayOf(b.deliveryDate, pending <= 0), status: b.status,
      responsibleDept: poType === 'Fabric' ? 'Fabric Department' : 'Factory Merchandising', isSampleData: !!b.isSampleData, module: poType === 'Fabric' ? 'fabricBooking' : 'trimBooking',
    };
  };
  const poRows = [
    ...fabricPos.filter((b) => num(b.bookedQty) - num(b.receivedQty) > 0.0005).map((b) => poRow(b, 'Fabric', [b.fabricType, b.color].filter(Boolean).join(' · '), b.bookedQty)),
    ...trimPos.filter((t) => num(t.bookingQty) - num(t.receivedQty) > 0).map((t) => poRow(t, 'Trims', [t.item, t.description].filter(Boolean).join(' · '), t.bookingQty)),
  ].sort((a, b) => new Date(a.dueDate || 0) - new Date(b.dueDate || 0));
  const leaf = live.filter((r) => !r.isMain);
  const open = leaf.filter((r) => r.status !== 'Closed');
  const mains = live.filter((r) => r.isMain || (!r.isSub && subsOf(r.jobNo).length));
  const forecastJobs = live.filter((r) => !r.isSub && (r.isMain || jobsByNo.get(r.jobNo)?.isForecast || r.poStatus === 'Awaiting PO'));
  const mainRow = (r) => {
    const subs = subsOf(r.jobNo);
    const f = forecastRow(r);
    return {
      ...r, kind: 'main', subCount: subs.length, subClosed: subs.filter((s) => s.status === 'Closed').length,
      packedQty: sum(subs, 'packedQty'), shippedQty: sum(subs, 'shippedQty'), balanceToShip: Math.max(r.orderQty - sum(subs, 'shippedQty'), 0),
      poStatusText: f.poStatusText, forecastStatus: f.forecastStatus,
      subs: subs.map((s) => ({ _id: s._id, jobNo: s.jobNo, poNo: s.poNo, poStatus: s.poStatus, orderQty: s.orderQty, cutQty: s.cutQty, sewnQty: s.sewnQty, packedQty: s.packedQty, shippedQty: s.shippedQty, balanceToShip: s.balanceToShip, progressPct: s.progressPct, pendingStageLabel: s.pendingStageLabel, status: s.status, deliveryDate: s.deliveryDate, cost: s.cost, revenue: s.revenue, profit: s.profit })),
    };
  };

  const all = {
    newOrders: buyerOrders.map(orderRow),
    awaitingJob: buyerOrders.filter((b) => !b.jobNo && ['Received', 'Under Review'].includes(b.status)).map(orderRow),
    repeatOrders: [
      ...live.filter((r) => r.repeatOfJobNo && !r.isSub).map(forecastRow),
      ...buyerOrders.filter((b) => b.orderType === 'Repeat Order' && !b.jobNo && b.status !== 'Cancelled').map(repeatPoRow),
    ],
    forecastOrders: forecastJobs.map(forecastRow),
    advanceAwaitingPo: live.filter((r) => r.poStatus === 'Awaiting PO' && r.status !== 'Closed').map(forecastRow),
    pendingPo: open.filter((r) => r.pendingStage === 'po'),
    awaitingFabric: open.filter((r) => r.pendingStage === 'fabric'),
    underProduction: open.filter((r) => r.cutQty > 0 && ['cutting', 'sewing', 'finishing', 'packing', 'quality'].includes(r.pendingStage)),
    unfinished: open.filter((r) => UNFINISHED_STAGES.includes(r.pendingStage)),
    finishedPendingShipment: open.filter((r) => r.poStatus !== 'Awaiting PO' && r.productionDone && !r.fullyShipped),
    partiallyShipped: leaf.filter((r) => r.shippedQty > 0 && !r.fullyShipped),
    fullyShipped: leaf.filter((r) => r.fullyShipped),
    subJobsReadyForClosure: leaf.filter((r) => r.isSub && r.status !== 'Closed' && r.readyToClose),
    closedSubJobs: leaf.filter((r) => r.isSub && r.status === 'Closed'),
    mainJobsPendingClosure: mains.filter((r) => r.status !== 'Closed').map(mainRow),
    poPendingReceipt: poRows,
    notStarted: open.filter((r) => r.poStatus !== 'Awaiting PO' && r.cutQty <= 0),
    onHold: open.filter((r) => r.holdReason).map((r) => ({ ...r, responsibleDept: r.holdDept })),
    overdue: open.filter((r) => !r.fullyShipped && r.shipmentDate && new Date(r.shipmentDate) <= new Date(today().getTime() + 14 * DAY)),
    awaitingClosure: open.filter((r) => r.productionDone && (r.fullyPacked || r.fullyShipped) && ['quality', 'shipment', 'accounts', 'closure'].includes(r.pendingStage)),
  };
  // buyer POs filter on the same fields; for the stage filter they count as "awaiting PO / job" only
  const keep = (r) => (r.source === 'order' ? (!q.stage || q.stage === 'po') && pass({ ...r, pendingStage: q.stage }) : pass(r));
  const lists = Object.fromEntries(TRACKING_LISTS.map((l) => [l.key, all[l.key].filter(keep)]));
  // fully packed first, then partially packed – the UI shows them as two groups
  lists.finishedPendingShipment.sort((a, b) => Number(b.fullyPacked) - Number(a.fullyPacked) || (b.daysPendingShipment || 0) - (a.daysPendingShipment || 0));

  const mainJobs = mains.map(mainRow).filter(pass);
  const counts = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length]));
  return {
    generatedAt: new Date(), counts, lists, mainJobs,
    totals: {
      confirmedQty: sum(leaf.filter((r) => r.poStatus !== 'Awaiting PO'), 'orderQty'),
      forecastQty: sum(leaf.filter((r) => r.poStatus === 'Awaiting PO' && r.status !== 'Closed'), 'orderQty'),
      shippedQty: sum(leaf, 'shippedQty'),
      pendingShipmentQty: sum(lists.finishedPendingShipment, 'balanceToShip'),
    },
    buyers: [...new Set([...rows.map((r) => r.buyerName), ...buyerOrders.map((b) => b.buyerName)].filter(Boolean))].sort(),
    stages: PENDING_STAGES.map(({ key, label }) => ({ key, label })),
  };
}
