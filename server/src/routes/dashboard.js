/** Company & department dashboards, KPIs and chart data. */
import express from 'express';
import { models } from '../modules/builder.js';
import { permit, scopeFromQuery } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { num, sum, round, pct } from '../../../shared/calc.js';
import { User } from '../models/User.js';
import { loadJobGraphs, computeProfit } from '../services/lifecycle.js';

const r = express.Router();
const live = { isDeleted: false };
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

r.get('/', permit('dashboard', 'view'), scopeFromQuery, asyncHandler(async (req, res) => {
  const now = new Date();
  const today = new Date(now.toDateString());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const in14 = new Date(today.getTime() + 14 * 86400000);
  const M = models;

  const [jobs, enquiries, costings, quotations, samples, fabric, trims, cutting, sewing, finishing, inspections, shipments, invoices, payments, expenses, tnas, lines, employees, userCount, specs, boms, patterns, markers] = await Promise.all([
    M.orders.find(live).lean(), M.enquiry.find(live).lean(), M.costing.find(live).lean(), M.quotation.find(live).lean(),
    M.sample.find(live).lean(), M.fabricBooking.find(live).lean(), M.trimBooking.find(live).lean(),
    M.cutting.find({ ...live, status: { $ne: 'Rejected' } }).lean(), M.sewing.find({ ...live, status: { $ne: 'Rejected' } }).lean(),
    M.finishing.find({ ...live, status: { $ne: 'Rejected' } }).lean(), M.inspection.find(live).lean(),
    M.shipment.find({ ...live, status: { $ne: 'Cancelled' } }).lean(), M.invoice.find({ ...live, status: { $ne: 'Cancelled' } }).lean(),
    M.payment.find(live).lean(), M.expense.find({ ...live, status: { $ne: 'Rejected' } }).lean(), M.tna.find(live).lean(),
    M.master.countDocuments({ ...live, masterType: 'Production Line' }), M.employee.find(live).lean(),
    User.countDocuments({ isDeleted: false }),
    M.techSpec.find(live).select('job status').lean(), M.bom.find(live).select('job status materialVariancePerPc lines.bookingRef').lean(),
    M.pattern.find(live).select('job status').lean(), M.marker.find(live).select('job status consumptionVariancePct').lean(),
  ]);

  // Jobs that carry production (exclude forecast parents with sub jobs to avoid double counting)
  const leaf = jobs.filter((j) => !(j.isForecast && num(j.subJobCount) > 0) && j.status !== 'Cancelled');
  const active = leaf.filter((j) => j.status !== 'Closed');
  const stageOf = (j) => j.currentStage || 'order';
  const delayedJobs = active.filter((j) => Object.values(j.stages || {}).includes('delayed'));
  const shippedByJob = {};
  shipments.filter((s) => ['Shipped', 'Delivered'].includes(s.status)).forEach((s) => { shippedByJob[s.job] = (shippedByJob[s.job] || 0) + num(s.qty); });

  const invoiced = sum(invoices, 'totalAmount');
  const received = sum(payments, 'amount');
  const outstanding = sum(invoices, 'outstanding');
  const overdueInv = invoices.filter((i) => num(i.outstanding) > 0 && i.dueDate && new Date(i.dueDate) < today);
  const expectedRevenue = sum(leaf, 'orderValue');
  const expectedProfit = sum(leaf, 'expectedProfit');

  // actual profit across jobs that have revenue
  let actualProfit = 0; let actualRevenue = 0; let actualCost = 0;
  const revenueJobs = leaf.filter((j) => invoices.some((i) => String(i.job) === String(j._id)) || shippedByJob[j._id]).slice(0, 300);
  for (const g of await loadJobGraphs(revenueJobs)) {
    const p = computeProfit(g);
    actualProfit += p.actualProfit; actualRevenue += p.revenue; actualCost += p.totalExpenses;
  }

  const summary = {
    activeJobs: active.length,
    ordersThisMonth: leaf.filter((j) => j.orderDate && new Date(j.orderDate) >= monthStart).length,
    pendingEnquiries: enquiries.filter((e) => ['Pending', 'Under Review'].includes(e.status)).length,
    pendingCosting: costings.filter((c) => ['Draft', 'Submitted', 'Under Review'].includes(c.status)).length,
    pendingApprovals: samples.filter((s) => ['Submitted', 'Buyer Review'].includes(s.status)).length
      + costings.filter((c) => ['Submitted', 'Under Review'].includes(c.status)).length
      + quotations.filter((q) => ['Sent', 'Under Review'].includes(q.status)).length
      + [...specs, ...boms, ...markers].filter((x) => x.status === 'Submitted').length
      + patterns.filter((p) => p.status === 'Pattern Ready').length,
    fabricPending: fabric.filter((f) => num(f.shortageQty) > 0 && f.status !== 'Fabric Job Closed').length,
    productionRunning: active.filter((j) => ['cutting', 'sewing', 'finishing', 'packing'].includes(stageOf(j))).length,
    delayedJobs: delayedJobs.length,
    shipmentDue: active.filter((j) => j.shipmentDate && new Date(j.shipmentDate) <= in14 && (shippedByJob[j._id] || 0) < num(j.orderQty)).length,
    paymentPending: invoices.filter((i) => num(i.outstanding) > 0).length,
    expectedRevenue: round(expectedRevenue), actualRevenue: round(actualRevenue),
    expectedProfit: round(expectedProfit), actualProfit: round(actualProfit),
    readyToClose: active.filter((j) => j.readyToClose).length,
    closedJobs: leaf.filter((j) => j.status === 'Closed').length,
  };

  // Pipeline
  const bucket = (j) => {
    if (j.status === 'Closed') return 'Closed';
    const s = stageOf(j);
    if (['order', 'spec', 'bom', 'tna', 'ppMeeting', 'cad', 'pattern', 'grading', 'marker', 'fabric', 'trims', 'sampling', 'approval'].includes(s)) return 'Order';
    if (['planning', 'cutting', 'sewing', 'finishing', 'packing', 'inspection'].includes(s)) return 'Production';
    if (['shipment', 'documentation'].includes(s)) return 'Shipment';
    return 'Payment';
  };
  const pipeline = [
    { stage: 'Enquiry', count: enquiries.filter((e) => ['Pending', 'Under Review'].includes(e.status)).length },
    { stage: 'Costing', count: enquiries.filter((e) => e.status === 'Costing').length + costings.filter((c) => !c.job && c.status !== 'Approved' && c.status !== 'Rejected').length },
    { stage: 'Quotation', count: quotations.filter((q) => ['Draft', 'Sent', 'Under Review', 'Approved', 'Revised'].includes(q.status)).length },
    ...['Order', 'Production', 'Shipment', 'Payment', 'Closed'].map((s) => ({ stage: s, count: leaf.filter((j) => bucket(j) === s).length })),
  ];

  // KPIs
  const decidedEnq = enquiries.filter((e) => ['Converted', 'Rejected', 'Cancelled'].includes(e.status));
  const tnaRows = tnas.flatMap((t) => t.activities || []);
  const apprRows = tnaRows.filter((a) => ['Approval', 'PP Sample', 'Fit Sample', 'Size Set', 'Proto Sample', 'Lab Dip'].includes(a.activity) && a.state === 'completed');
  const delayedActs = tnaRows.filter((a) => a.state === 'delayed');
  const fabReq = sum(fabric, 'requiredQty');
  const lastSewDay = sewing.map((s) => dayKey(s.entryDate)).sort().pop();
  const daySew = sewing.filter((s) => dayKey(s.entryDate) === lastSewDay);
  const earned = sum(sewing, (s) => num(s.actualQty) * num(s.sam));
  const avail = sum(sewing, (s) => num(s.operators) * num(s.workingMinutes));
  const dayEarned = sum(daySew, (s) => num(s.actualQty) * num(s.sam));
  const dayAvail = sum(daySew, (s) => num(s.operators) * num(s.workingMinutes));
  const activeLines = new Set(daySew.map((s) => s.line)).size;
  const totalLines = lines || new Set(sewing.map((s) => s.line)).size;
  const produced = sum(sewing, 'actualQty');
  const finals = inspections.filter((i) => ['Passed', 'Final Approved', 'Failed'].includes(i.status));
  const shippedRecs = shipments.filter((s) => ['Shipped', 'Delivered'].includes(s.status));
  const onTime = shippedRecs.filter((s) => !s.actualShipDate || !s.shipmentDate || new Date(s.actualShipDate) <= new Date(s.shipmentDate));
  const expenseTotal = sum(expenses, 'amount');

  const kpis = {
    merchandising: {
      orderConversionPct: pct(enquiries.filter((e) => e.status === 'Converted').length, decidedEnq.length || enquiries.length),
      onTimeApprovalPct: pct(apprRows.filter((a) => !num(a.delayDays)).length, apprRows.length),
      tnaDelayedActivities: delayedActs.length,
      avgTnaDelayDays: delayedActs.length ? round(sum(delayedActs, 'delayDays') / delayedActs.length, 1) : 0,
      orderStatus: Object.entries(leaf.reduce((m, j) => ({ ...m, [j.status]: (m[j.status] || 0) + 1 }), {})).map(([name, value]) => ({ name, value })),
    },
    fabric: {
      bookingPct: pct(sum(fabric, (f) => Math.min(num(f.bookedQty), num(f.requiredQty))), fabReq),
      inhousePct: pct(sum(fabric, (f) => Math.min(num(f.receivedQty), num(f.requiredQty))), fabReq),
      shortageQty: round(sum(fabric, 'shortageQty')),
      shortageBookings: fabric.filter((f) => num(f.shortageQty) > 0).length,
      wastagePct: pct(sum(cutting, (c) => Math.max(num(c.fabricIssued) - num(c.fabricUsed), 0)), sum(cutting, 'fabricIssued')),
      readyToClose: fabric.filter((f) => String(f.closureVerdict || '').startsWith('READY')).length,
      trimShortages: trims.filter((t) => num(t.shortageQty) > 0 && num(t.receivedQty) > 0).length,
    },
    preproduction: (() => {
      const openJobs = new Set(active.map((j) => String(j._id)));
      const mine = (rows) => rows.filter((x) => openJobs.has(String(x.job)));
      const liveMarkers = mine(markers).filter((m) => m.status !== 'Rejected');
      return {
        specApprovedPct: pct(new Set(mine(specs).filter((x) => x.status === 'Approved').map((x) => String(x.job))).size, active.length),
        bomApprovedPct: pct(new Set(mine(boms).filter((x) => x.status === 'Approved').map((x) => String(x.job))).size, active.length),
        patternsPending: mine(patterns).filter((p) => !['Graded', 'Released'].includes(p.status)).length,
        markersPending: liveMarkers.filter((m) => !['Approved', 'Issued to Cutting'].includes(m.status)).length,
        markerVariancePct: liveMarkers.length ? round(sum(liveMarkers, 'consumptionVariancePct') / liveMarkers.length, 2) : 0,
        unbookedBomLines: sum(mine(boms), (b) => (b.lines || []).filter((l) => !l.bookingRef).length),
      };
    })(),
    production: {
      lastDay: lastSewDay || null,
      dailyTarget: sum(daySew, 'targetQty'),
      actualProduction: sum(daySew, 'actualQty'),
      dayEfficiencyPct: dayAvail ? round((dayEarned / dayAvail) * 100) : 0,
      efficiencyPct: avail ? round((earned / avail) * 100) : 0,
      lineUtilizationPct: pct(activeLines, totalLines),
      wip: Math.max(sum(cutting, 'cutQty') - produced, 0),
      totalCut: sum(cutting, 'cutQty'), totalSewn: produced, totalFinished: sum(finishing, 'passedQty'),
    },
    quality: {
      dhu: pct(sum(sewing, 'defects'), sum(sewing, (s) => num(s.checkedQty) || num(s.actualQty))),
      aqlPassPct: pct(finals.filter((i) => i.status !== 'Failed').length, finals.length),
      rejectionPct: pct(sum(sewing, 'rejection') + sum(finishing, 'rejection'), produced),
      alterationPct: pct(sum(sewing, 'alteration') + sum(finishing, 'alteration'), produced),
      inspections: inspections.length, failed: inspections.filter((i) => i.status === 'Failed').length,
    },
    shipment: {
      onTimeShipmentPct: pct(onTime.length, shippedRecs.length),
      pendingShipments: shipments.filter((s) => !['Shipped', 'Delivered'].includes(s.status)).length,
      delayedShipments: active.filter((j) => j.shipmentDate && new Date(j.shipmentDate) < today && (shippedByJob[j._id] || 0) < num(j.orderQty)).length,
      shippedQty: sum(shippedRecs, 'qty'),
    },
    accounts: {
      receivable: round(invoiced), outstanding: round(outstanding), received: round(received),
      collectionPct: pct(received, invoiced),
      overdueInvoices: overdueInv.length, overdueAmount: round(sum(overdueInv, 'outstanding')),
    },
    finance: {
      revenue: round(actualRevenue), cost: round(actualCost), expenses: round(expenseTotal),
      expectedRevenue: round(expectedRevenue), expectedProfit: round(expectedProfit),
      actualProfit: round(actualProfit), profitPct: pct(actualProfit, actualRevenue),
    },
    hr: {
      employees: employees.filter((e) => e.status === 'Active').length,
      operators: employees.filter((e) => e.isOperator && e.status === 'Active').length,
      onLeave: employees.filter((e) => e.status === 'On Leave').length,
      avgAttendancePct: employees.length ? round(sum(employees, 'attendancePct') / employees.length, 1) : 0,
      users: userCount,
      byDepartment: Object.entries(employees.reduce((m, e) => ({ ...m, [e.department || 'Unassigned']: (m[e.department || 'Unassigned'] || 0) + 1 }), {})).map(([name, value]) => ({ name, value })),
    },
  };

  // Charts
  const months = [...Array(12)].map((_, i) => monthKey(new Date(now.getFullYear(), now.getMonth() - 11 + i, 15)));
  const monthly = months.map((m) => ({
    month: m,
    orders: round(sum(leaf.filter((j) => j.orderDate && monthKey(j.orderDate) === m), 'orderValue')),
    invoiced: round(sum(invoices.filter((i) => i.invoiceDate && monthKey(i.invoiceDate) === m), 'totalAmount')),
    collected: round(sum(payments.filter((p) => p.paymentDate && monthKey(p.paymentDate) === m), 'amount')),
  }));
  const days = [...Array(14)].map((_, i) => dayKey(new Date(today.getTime() - (13 - i) * 86400000)));
  const production = days.map((d) => {
    const rows = sewing.filter((s) => dayKey(s.entryDate) === d);
    const e = sum(rows, (s) => num(s.actualQty) * num(s.sam));
    const a = sum(rows, (s) => num(s.operators) * num(s.workingMinutes));
    return { day: d.slice(5), target: sum(rows, 'targetQty'), actual: sum(rows, 'actualQty'), cut: sum(cutting.filter((c) => dayKey(c.entryDate) === d), 'cutQty'), efficiency: a ? round((e / a) * 100, 1) : 0 };
  });
  const buyerMap = {};
  leaf.forEach((j) => { buyerMap[j.buyerName || '—'] = (buyerMap[j.buyerName || '—'] || 0) + num(j.orderValue); });
  const buyers = Object.entries(buyerMap).map(([name, value]) => ({ name, value: round(value) })).sort((a, b) => b.value - a.value).slice(0, 8);
  const lineMap = {};
  sewing.forEach((s) => {
    const l = (lineMap[s.line] ||= { line: s.line, earned: 0, avail: 0, actual: 0, target: 0 });
    l.earned += num(s.actualQty) * num(s.sam); l.avail += num(s.operators) * num(s.workingMinutes); l.actual += num(s.actualQty); l.target += num(s.targetQty);
  });
  const lineEff = Object.values(lineMap).map((l) => ({ line: l.line, efficiency: l.avail ? round((l.earned / l.avail) * 100, 1) : 0, actual: l.actual, target: l.target })).sort((a, b) => String(a.line).localeCompare(String(b.line)));
  const stageDist = Object.entries(active.reduce((m, j) => ({ ...m, [stageOf(j)]: (m[stageOf(j)] || 0) + 1 }), {})).map(([stage, count]) => ({ stage, count }));

  const jobRow = (j) => ({ _id: j._id, jobNo: j.jobNo, buyerName: j.buyerName, styleNo: j.styleNo, orderQty: j.orderQty, shipmentDate: j.shipmentDate, currentStage: j.currentStage, progressPct: j.progressPct, status: j.status, stages: j.stages, readyToClose: j.readyToClose });
  res.json({
    summary, pipeline, kpis,
    charts: { monthly, production, buyers, lineEff, stageDist },
    lists: {
      delayedJobs: delayedJobs.slice(0, 10).map(jobRow),
      upcomingShipments: active.filter((j) => j.shipmentDate).sort((a, b) => new Date(a.shipmentDate) - new Date(b.shipmentDate)).slice(0, 8).map(jobRow),
      readyToClose: active.filter((j) => j.readyToClose).map(jobRow),
      fabricShortages: fabric.filter((f) => num(f.shortageQty) > 0 && f.status !== 'Fabric Job Closed').slice(0, 10).map((f) => ({ _id: f._id, refNo: f.refNo, jobNo: f.jobNo, fabricType: f.fabricType, requiredQty: f.requiredQty, receivedQty: f.receivedQty, shortageQty: f.shortageQty, unit: f.unit, deliveryDate: f.deliveryDate })),
      overdueInvoices: overdueInv.slice(0, 10).map((i) => ({ _id: i._id, invoiceNo: i.invoiceNo, jobNo: i.jobNo, buyerName: i.buyerName, outstanding: i.outstanding, dueDate: i.dueDate, currency: i.currency })),
      recentJobs: [...leaf].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8).map(jobRow),
    },
  });
}));

export default r;
