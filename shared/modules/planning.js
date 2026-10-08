import { text, area, n, calc, date, sel, ref, table, bool, flow } from './dsl.js';
import { UNITS, DEFAULT_UNITS } from '../constants.js';
import { fabricRequirement, fabricBalance, trimRequirement, tnaRowState, dailyTarget, addWorkingDays, num, round, pct } from '../calc.js';
import { TRIM_ITEMS } from './commercial.js';

/* ------------------------------ T&A ------------------------------ */
export const tna = {
  key: 'tna', model: 'Tna', title: 'Time & Action', singular: 'T&A Calendar', group: 'Planning', icon: 'CalendarClock',
  department: 'Factory Merchandising', prefix: 'TNA', jobLinked: true, stage: 'tna', onePerJob: true,
  ...flow(['In Progress', 'Completed']), autoStatus: true, defaultStatus: 'In Progress',
  fields: [
    date('orderDate', 'Order Date', { section: 'Calendar' }),
    date('shipmentDate', 'Shipment Date', { list: true }),
    table('activities', 'Activities', [
      text('activity', 'Activity'), text('department', 'Department'),
      date('plannedDate', 'Planned'), date('actualDate', 'Actual'),
      text('responsible', 'Responsible'),
      sel('progress', 'Progress', ['Not Started', 'In Progress', 'Completed'], { default: 'Not Started' }),
      calc('delayDays', 'Delay'), calc('state', 'State', { type: 'text' }),
      text('remarks', 'Remarks'),
    ], { tna: true }),
    calc('totalActivities', 'Activities', { list: true }),
    calc('completedCount', 'Completed', { list: true }),
    calc('delayedCount', 'Delayed', { list: true }),
    calc('completionPct', 'Completion %', { list: true }),
  ],
  compute(d) {
    const activities = (d.activities || []).map((r) => {
      const actual = r.actualDate || (r.progress === 'Completed' ? new Date().toISOString().slice(0, 10) : null);
      const s = tnaRowState({ ...r, actualDate: actual });
      return { ...r, actualDate: actual, progress: actual ? 'Completed' : r.progress, delayDays: s.delayDays, state: s.state };
    });
    const completed = activities.filter((a) => a.state === 'completed').length;
    const delayed = activities.filter((a) => a.state === 'delayed').length;
    return {
      activities,
      totalActivities: activities.length,
      completedCount: completed,
      delayedCount: delayed,
      completionPct: pct(completed, activities.length, 0),
      status: activities.length && completed === activities.length ? 'Completed' : delayed ? 'Delayed' : 'In Progress',
    };
  },
};

/* ------------------------------ PP Meeting ------------------------------ */
const readiness = ['Pending', 'In Progress', 'Ready', 'Approved', 'Issue'];
export const ppMeeting = {
  key: 'ppMeeting', model: 'PpMeeting', title: 'PP Meetings', singular: 'PP Meeting', group: 'Planning', icon: 'Users',
  department: 'Factory Merchandising', prefix: 'PPM', jobLinked: true, stage: 'ppMeeting', pdf: 'ppMeeting',
  ...flow(['Scheduled', 'Held', 'Completed'], { Scheduled: ['Cancelled'] }), defaultStatus: 'Scheduled',
  fields: [
    date('meetingDate', 'Meeting Date', { required: true, list: true, section: 'Meeting' }),
    n('productionQty', 'Production Qty', { list: true }),
    text('attendees', 'Attendees', { span: 2 }),
    sel('fabricStatus', 'Fabric Status', readiness, { section: 'Readiness', list: true }),
    sel('trimStatus', 'Trim Status', readiness, { list: true }),
    sel('sampleApproval', 'Sample Approval', readiness),
    sel('measurementApproval', 'Measurement Approval', readiness),
    sel('patternStatus', 'Pattern Status', readiness),
    sel('markerStatus', 'Marker Status', readiness),
    area('machineRequirement', 'Machine Requirement', { section: 'Resources' }),
    n('manpowerRequirement', 'Manpower Requirement'),
    n('productionTarget', 'Production Target / day'),
    area('qualityRequirements', 'Quality Requirements', { section: 'Quality & Buyer' }),
    area('buyerComments', 'Buyer Comments'),
    area('risks', 'Risks / Issues'),
    table('actionItems', 'Action Items', [
      text('action', 'Action'), text('responsible', 'Responsible'), date('dueDate', 'Due Date'),
      sel('status', 'Status', ['Open', 'Done'], { default: 'Open' }),
    ], { section: 'Actions' }),
  ],
  prefill: (job) => ({ productionQty: job.orderQty }),
};

/* ------------------------------ Fabric Booking ------------------------------ */
export const FABRIC_FLOW = ['Required', 'Booked', 'In Production', 'In Transit', 'Received', 'Inspected', 'Approved', 'Issued', 'Fully Consumed'];
export const fabricBooking = {
  key: 'fabricBooking', model: 'FabricBooking', title: 'Fabric Booking', singular: 'Fabric Booking', group: 'Materials', icon: 'Layers',
  department: 'Fabric Department', prefix: 'FB', jobLinked: true, stage: 'fabric',
  ...flow(FABRIC_FLOW), closeStatuses: ['Fabric Job Closed'], defaultStatus: 'Required',
  fields: [
    text('fabricType', 'Fabric Type', { required: true, list: true, search: true, section: 'Fabric' }),
    text('composition', 'Composition', { search: true }), n('gsm', 'GSM'), n('width', 'Width (inch)'),
    text('color', 'Color', { list: true }),
    sel('unit', 'Unit', ['KG', 'Meter', 'Yard'], { default: 'KG', list: true }),
    n('orderQty', 'Order Qty (pcs)', { section: 'Requirement' }),
    n('consumption', 'Consumption / pc'),
    n('wastagePct', 'Wastage %', { max: 100 }), n('cuttingWastagePct', 'Cutting Wastage %', { max: 100 }),
    n('shrinkagePct', 'Shrinkage %', { max: 100 }), n('relaxationPct', 'Relaxation %', { max: 100 }),
    n('dyeingLossPct', 'Dyeing Loss %', { max: 100 }), n('processLossPct', 'Process Loss %', { max: 100 }),
    calc('baseQty', 'Base Qty'), calc('totalLossPct', 'Total Loss %'),
    calc('requiredQty', 'Required Qty', { list: true }),
    ref('supplier', 'Supplier', 'Supplier', { section: 'Booking' }),
    text('supplierPoNo', 'Fabric PO No', { search: true }),
    date('bookingDate', 'Booking Date'), date('deliveryDate', 'Delivery Date', { list: true }),
    n('bookedQty', 'Booked Qty', { list: true }), n('rate', 'Rate / unit'),
    n('receivedQty', 'Received Qty', { section: 'Receipt / Inspection / Issue', list: true }),
    n('inspectedQty', 'Inspected Qty'), n('approvedQty', 'Approved Qty'),
    n('issuedQty', 'Issued to Cutting'), n('usedQty', 'Used / Consumed'),
    calc('bookingBalance', 'Booking Balance', { section: 'Balance' }), calc('pendingReceipt', 'Pending Receipt'),
    calc('balanceQty', 'Store Balance', { list: true }), calc('excessQty', 'Excess Qty'), calc('shortageQty', 'Shortage Qty', { list: true }),
    calc('rejectedQty', 'Rejected Qty'), calc('receivedPct', 'Received %'),
    calc('bookingValue', 'Booking Value'), calc('actualValue', 'Received Value'),
    calc('closureVerdict', 'Closure Verdict', { type: 'text', list: true }),
    area('remarks', 'Remarks'),
  ],
  prefill: (job) => ({
    fabricType: job.fabricType, composition: job.composition, gsm: job.gsm, width: job.width, color: job.fabricColor,
    unit: job.consumptionUnit || 'KG', orderQty: job.orderQty, consumption: job.consumption, wastagePct: job.wastagePct,
    cuttingWastagePct: job.cuttingWastagePct, shrinkagePct: job.shrinkagePct, relaxationPct: job.relaxationPct,
    dyeingLossPct: job.dyeingLossPct, processLossPct: job.processLossPct, rate: job.fabricRate,
  }),
  compute(d) {
    const req = fabricRequirement(d);
    const bal = fabricBalance({ ...d, requiredQty: req.requiredQty });
    return {
      baseQty: req.baseQty, totalLossPct: req.totalLossPct, requiredQty: req.requiredQty,
      bookingBalance: bal.bookingBalance, pendingReceipt: bal.pendingReceipt, balanceQty: bal.balanceQty,
      excessQty: bal.excessQty, shortageQty: bal.shortageQty, rejectedQty: bal.rejectedQty, receivedPct: bal.receivedPct,
      bookingValue: round(num(d.bookedQty) * num(d.rate)), actualValue: round(num(d.receivedQty) * num(d.rate)),
      closureVerdict: d.status === 'Fabric Job Closed' ? 'CLOSED' : bal.closureVerdict,
      closureChecks: bal.closureChecks,
    };
  },
};

/* ------------------------------ Trim Booking ------------------------------ */
export const trimBooking = {
  key: 'trimBooking', model: 'TrimBooking', title: 'Trim Booking', singular: 'Trim Booking', group: 'Materials', icon: 'Scissors',
  department: 'Factory Merchandising', prefix: 'TB', jobLinked: true, stage: 'trims',
  ...flow(['Required', 'Booked', 'In Transit', 'Received', 'Issued', 'Consumed']), closeStatuses: ['Closed'], defaultStatus: 'Required',
  fields: [
    sel('item', 'Trim Item', TRIM_ITEMS, { required: true, list: true, filter: true, section: 'Trim' }),
    text('description', 'Description / Spec', { search: true, list: true }),
    sel('unit', 'Unit', UNITS, { default: 'Pcs' }),
    n('orderQty', 'Order Qty (pcs)', { section: 'Requirement' }),
    n('consumptionPerPc', 'Qty / pc', { required: true }),
    n('wastagePct', 'Wastage %', { max: 100 }),
    calc('requiredQty', 'Required Qty', { list: true }), calc('bookingQty', 'Booking Qty (incl. wastage)', { list: true }),
    ref('supplier', 'Supplier', 'Supplier', { section: 'Booking' }),
    text('supplierPoNo', 'Trim PO No'), date('deliveryDate', 'Delivery Date'),
    n('bookedQty', 'Booked Qty'), n('rate', 'Rate'),
    n('receivedQty', 'Received Qty', { section: 'Movement', list: true }), n('issuedQty', 'Issued Qty'), n('usedQty', 'Used Qty'),
    calc('pendingReceipt', 'Pending Receipt'), calc('balanceQty', 'Balance Qty'),
    calc('shortageQty', 'Shortage Qty', { list: true }), calc('excessQty', 'Excess Qty'),
    calc('amount', 'Booking Value'), calc('actualAmount', 'Received Value'),
    area('remarks', 'Remarks'),
  ],
  prefill: (job) => ({ orderQty: job.orderQty }),
  compute: (d) => trimRequirement(d),
};

/* ------------------------------ Sampling ------------------------------ */
export const SAMPLE_TYPES = ['Proto Sample', 'Fit Sample', 'Size Set', 'PP Sample', 'Photo Sample', 'Shipment Sample', 'Counter Sample', 'Lab Dip', 'Strike-off'];
export const sample = {
  key: 'sample', model: 'Sample', title: 'Sampling', singular: 'Sample', group: 'Planning', icon: 'Shirt',
  department: 'Factory Merchandising', prefix: 'SMP', jobLinked: true, stage: 'sampling',
  ...flow(['Pending', 'Submitted', 'Buyer Review', 'Approved', 'Final Approved'], { 'Buyer Review': ['Rejected'], Rejected: ['Revised'], Revised: ['Submitted'] }),
  defaultStatus: 'Pending',
  fields: [
    sel('sampleType', 'Sample Type', SAMPLE_TYPES, { required: true, list: true, filter: true }),
    date('sampleDate', 'Sample Date', { list: true }),
    text('color', 'Color'), text('size', 'Size'), n('qty', 'Qty'),
    date('sentDate', 'Sent Date', { list: true }), text('courierAwb', 'Courier / AWB'),
    date('buyerApprovalDate', 'Buyer Approval Date', { list: true }),
    n('revision', 'Revision No'),
    area('comments', 'Buyer Comments'),
  ],
};

/* ------------------------------ Production Planning ------------------------------ */
export const productionPlan = {
  key: 'productionPlan', model: 'ProductionPlan', title: 'Production Planning', singular: 'Production Plan', group: 'Production', icon: 'GanttChartSquare',
  department: 'Production', prefix: 'PLN', jobLinked: true, stage: 'planning',
  ...flow(['Draft', 'Approved', 'Released', 'Running', 'Completed'], { Draft: ['Cancelled'] }), defaultStatus: 'Draft',
  fields: [
    n('productionQty', 'Production Qty', { required: true, list: true, section: 'Plan' }),
    text('floor', 'Floor', { list: true, filter: true }), text('line', 'Line', { list: true, filter: true }),
    n('machines', 'Machine Capacity (machines)'), n('operators', 'Manpower (operators)'), n('helpers', 'Helpers'),
    n('sam', 'SAM (min)'), n('workingMinutes', 'Working Minutes / day', { default: 480 }),
    n('targetEfficiencyPct', 'Target Efficiency %', { default: 60, max: 100 }),
    calc('dailyTarget', 'Daily Target (pcs)', { list: true }), calc('plannedDays', 'Planned Days'),
    date('plannedStart', 'Planned Start', { list: true, section: 'Schedule' }), calc('plannedEnd', 'Planned End', { type: 'date', list: true }),
    date('actualStart', 'Actual Start'), date('actualEnd', 'Actual End'),
    calc('actualProduction', 'Actual Production (from Sewing)', { section: 'Progress', list: true }),
    calc('actualEfficiency', 'Actual Avg Efficiency %'),
    calc('wip', 'WIP (cut − sewn)'), calc('achievementPct', 'Achievement %', { list: true }),
  ],
  prefill: (job) => ({ productionQty: job.orderQty }),
  compute(d) {
    const dt = dailyTarget(d);
    const days = dt ? Math.ceil(num(d.productionQty) / dt) : 0;
    return {
      dailyTarget: dt, plannedDays: days,
      plannedEnd: d.plannedStart && days ? addWorkingDays(d.plannedStart, days) : null,
      achievementPct: pct(d.actualProduction, d.productionQty, 1),
    };
  },
};

/* ------------------------------ Fabric Forecast (main / continuous jobs) ------------------------------ */
/**
 * Bulk fabric forecast against a main (forecast / continuous) job, before or alongside its sub jobs.
 * Fabric received against the forecast is allocated to production by Fabric Transfers
 * (into a job's fabric booking, or into a new sub job), so the chain stays traceable:
 *   Job → Fabric Forecast → receipt → Fabric Transfer → (sub) job fabric booking → cutting.
 */
export const fabricForecast = {
  key: 'fabricForecast', model: 'FabricForecast', title: 'Fabric Forecast', singular: 'Fabric Forecast', group: 'Materials', icon: 'CalendarRange',
  department: 'Fabric Department', prefix: 'FF', jobLinked: true, stage: 'fabric',
  ...flow(['Forecast', 'Confirmed', 'Received', 'Allocated', 'Closed'], { Forecast: ['Cancelled'] }), defaultStatus: 'Forecast',
  fields: [
    text('fabricType', 'Fabric', { required: true, list: true, search: true, section: 'Fabric' }),
    text('composition', 'Composition', { search: true }), n('gsm', 'GSM'), n('width', 'Width (inch)'),
    text('color', 'Color', { list: true }),
    sel('unit', 'Unit', ['KG', 'Meter', 'Yard'], { default: 'Meter', list: true }),
    n('garmentQty', 'Forecast Garment Qty (pcs)', { section: 'Forecast' }),
    n('consumption', 'Consumption / pc'),
    n('wastagePct', 'Wastage / Loss %', { max: 100 }),
    calc('forecastQty', 'Fabric Forecast Qty', { list: true }),
    date('requiredDate', 'Required Date', { required: true, list: true }),
    ref('supplier', 'Mill / Supplier', 'Supplier', { section: 'Purchase & Receipt' }),
    text('supplierPoNo', 'Fabric PO No', { search: true }),
    text('lotNo', 'Lot / Batch No', { search: true, list: true }),
    n('rate', 'Rate / unit'),
    n('receivedQty', 'Received Qty', { list: true }), date('receivedDate', 'Received Date'),
    calc('transferredQty', 'Allocated / Transferred', { section: 'Allocation', list: true }),
    calc('balanceQty', 'Available Balance', { list: true }),
    calc('pendingReceipt', 'Pending Receipt'), calc('excessQty', 'Excess over Forecast'),
    calc('forecastValue', 'Forecast Value'), calc('receivedValue', 'Received Value'),
    area('remarks', 'Remarks'),
  ],
  prefill: (job) => ({
    fabricType: job.fabricType, composition: job.composition, gsm: job.gsm, width: job.width, color: job.fabricColor,
    unit: job.consumptionUnit || 'Meter', garmentQty: num(job.forecastQty) || job.orderQty, consumption: job.consumption,
    wastagePct: ['wastagePct', 'cuttingWastagePct', 'shrinkagePct', 'relaxationPct', 'dyeingLossPct', 'processLossPct'].reduce((t, k) => t + num(job[k]), 0),
    rate: job.fabricRate, requiredDate: job.orderDate,
  }),
  compute(d) {
    const fq = round(num(d.garmentQty) * num(d.consumption) * (1 + num(d.wastagePct) / 100), 3);
    const rcv = num(d.receivedQty); const out = num(d.transferredQty);
    return {
      forecastQty: fq, balanceQty: round(rcv - out, 3),
      pendingReceipt: round(Math.max(fq - rcv, 0), 3), excessQty: round(Math.max(rcv - fq, 0), 3),
      forecastValue: round(fq * num(d.rate)), receivedValue: round(rcv * num(d.rate)),
    };
  },
};

/* ------------------------------ Fabric Transfer ------------------------------ */
export const TRANSFER_REASONS = ['New production requirement', 'Excess fabric re-use', 'Shortage cover', 'Re-allocation between jobs', 'Sample / development', 'Other'];
/**
 * Moves forecast fabric from the source job to production: into another job's fabric booking
 * (same or other unit) or into a NEW sub job of the source main job. Completing the transfer posts it.
 */
export const fabricTransfer = {
  key: 'fabricTransfer', model: 'FabricTransfer', title: 'Fabric Transfer', singular: 'Fabric Transfer', group: 'Materials', icon: 'ArrowRightLeft',
  department: 'Fabric Department', prefix: 'FT', jobLinked: true, stage: 'fabric',
  ...flow(['Requested', 'Approved', 'Completed'], { Requested: ['Cancelled'], Approved: ['Cancelled'] }), defaultStatus: 'Requested',
  fields: [
    ref('sourceForecast', 'Source Fabric Forecast', 'FabricForecast', { required: true, jobScoped: true, section: 'Source', hint: 'Fabric received against the source job forecast' }),
    calc('fromUnit', 'Source Unit', { type: 'text' }),
    calc('fabric', 'Source Fabric', { type: 'text', list: true }),
    calc('lotNo', 'Lot / Batch', { type: 'text' }),
    n('qty', 'Transfer Qty', { required: true, list: true }),
    calc('unit', 'Unit', { type: 'text' }),
    date('transferDate', 'Transfer Date', { required: true, list: true }),
    sel('toUnit', 'Destination Unit', DEFAULT_UNITS.map((u) => u.code), { required: true, section: 'Destination', list: true }),
    bool('createSubJob', 'Create a new Sub-Job of the source main job for this fabric'),
    text('toJobNo', 'Destination Job No', { list: true, search: true, hint: 'Leave blank when a new sub job is created' }),
    n('subJobQty', 'Sub-Job Garment Qty (blank = qty ÷ consumption)'),
    date('subJobShipmentDate', 'Sub-Job Shipment Date'),
    calc('destinationBooking', 'Received into Fabric Booking', { type: 'text' }),
    sel('reason', 'Reason', TRANSFER_REASONS, { required: true, section: 'Reference' }),
    text('referenceDoc', 'Reference Document', { required: true, search: true }),
    area('remarks', 'Remarks'),
  ],
};
