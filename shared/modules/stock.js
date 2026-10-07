/**
 * Knit fabric supply chain stock modules:
 *   Yarn Inward → Knitting (yarn issued, grey received) → Fabric Processing (dyeing, compacting…)
 *   → Finished fabric (received into the fabric store = Fabric Booking).
 * Every movement records the company (supplier / knitter / processor), kg and rate per kg.
 */
import { text, area, n, calc, date, sel, ref, flow } from './dsl.js';
import { num, round, pct } from '../calc.js';

export const PROCESS_TYPES = [
  'Dyeing', 'Compacting', 'Open Width Compacting', 'Tubular Compacting', 'Heat Setting', 'Washing', 'Bio Wash',
  'Peaching', 'Brushing', 'Raising', 'Mercerizing', 'Printing', 'Stentering', 'Calendering', 'Other',
];
export const FABRIC_STAGES = ['Grey Fabric', 'In-process Fabric', 'Finished Fabric'];

/* ------------------------------ Yarn inward ------------------------------ */
export const yarnReceipt = {
  key: 'yarnReceipt', model: 'YarnReceipt', title: 'Yarn Inward', singular: 'Yarn Receipt', group: 'Fabric Stock', icon: 'Package',
  department: 'Fabric Department', prefix: 'YRN', jobLinked: 'optional',
  ...flow(['Received', 'Inspected', 'Approved'], { Received: ['Rejected'], Inspected: ['Rejected'] }), defaultStatus: 'Received',
  fields: [
    date('receiptDate', 'Receipt Date', { required: true, list: true, section: 'Yarn' }),
    ref('supplier', 'Yarn Supplier (Company)', 'Supplier', { required: true }),
    text('yarnCount', 'Yarn Count / Type', { required: true, list: true, search: true, filter: false, hint: 'e.g. 30s Combed Cotton' }),
    text('composition', 'Composition', { search: true }),
    text('lotNo', 'Lot No', { list: true, search: true }),
    text('invoiceNo', 'Supplier Invoice / DC No', { search: true }),
    n('bags', 'Bags'),
    n('qtyKg', 'Quantity (kg)', { required: true, list: true }),
    n('ratePerKg', 'Rate / kg', { list: true }),
    calc('amount', 'Amount', { list: true }),
    area('remarks', 'Remarks'),
  ],
  compute: (d) => ({ amount: round(num(d.qtyKg) * num(d.ratePerKg)) }),
};

/* ------------------------------ Knitting ------------------------------ */
export const knitting = {
  key: 'knitting', model: 'KnittingProgram', title: 'Knitting', singular: 'Knitting Program', group: 'Fabric Stock', icon: 'Waypoints',
  department: 'Fabric Department', prefix: 'KNT', jobLinked: 'optional',
  ...flow(['Program', 'Yarn Issued', 'In Knitting', 'Completed'], { Program: ['Cancelled'] }), defaultStatus: 'Program',
  fields: [
    date('programDate', 'Program Date', { required: true, list: true, section: 'Program' }),
    ref('supplier', 'Knitting Company', 'Supplier', { required: true }),
    text('yarnCount', 'Yarn Count / Type', { required: true, search: true, hint: 'Same text as in Yarn Inward' }),
    text('lotNo', 'Yarn Lot No', { search: true }),
    text('fabricType', 'Fabric Type', { required: true, list: true, search: true }),
    n('gsm', 'GSM'), n('dia', 'Dia (inch)'), text('gauge', 'Machine Gauge'),
    n('yarnIssuedKg', 'Yarn Issued (kg)', { required: true, list: true, section: 'Quantity' }),
    n('greyReceivedKg', 'Grey Received (kg)', { list: true }),
    n('rejectedKg', 'Rejected / Returned Yarn (kg)'),
    n('allowedLossPct', 'Allowed Knitting Loss %', { default: 3, max: 100 }),
    calc('lossKg', 'Knitting Loss (kg)'), calc('lossPct', 'Loss %', { list: true }),
    calc('pendingKg', 'Pending at Knitter (kg)', { list: true }),
    n('ratePerKg', 'Knitting Rate / kg', { section: 'Charges', list: true }),
    calc('amount', 'Knitting Charges', { list: true }),
    area('remarks', 'Remarks'),
  ],
  compute(d) {
    const issued = num(d.yarnIssuedKg); const received = num(d.greyReceivedKg); const rejected = num(d.rejectedKg);
    const loss = Math.max(issued - received - rejected, 0);
    const done = d.status === 'Completed';
    const expected = issued * (1 - num(d.allowedLossPct) / 100) - rejected;
    return {
      // loss is only final once the program/order is completed; until then the difference is pending
      lossKg: round(done ? loss : 0, 2),
      lossPct: done ? pct(loss, issued) : 0,
      pendingKg: round(done ? 0 : Math.max(expected - received, 0), 2),
      amount: round(received * num(d.ratePerKg)),
    };
  },
};

/* ------------------------------ Fabric processing ------------------------------ */
export const fabricProcess = {
  key: 'fabricProcess', model: 'FabricProcess', title: 'Fabric Processing', singular: 'Process Order', group: 'Fabric Stock', icon: 'Droplets',
  department: 'Fabric Department', prefix: 'PRC', jobLinked: 'optional',
  ...flow(['Issued', 'In Process', 'Received', 'Completed'], { Issued: ['Cancelled'] }), defaultStatus: 'Issued',
  fields: [
    date('processDate', 'Issue Date', { required: true, list: true, section: 'Process' }),
    ref('supplier', 'Processing Company', 'Supplier', { required: true }),
    sel('processType', 'Process', PROCESS_TYPES, { required: true, list: true, filter: true }),
    sel('inputStage', 'Input Fabric', FABRIC_STAGES.slice(0, 2), { default: 'Grey Fabric', required: true }),
    sel('outputStage', 'Output Fabric', FABRIC_STAGES.slice(1), { default: 'Finished Fabric', required: true, filter: true }),
    text('fabricType', 'Fabric Type', { required: true, list: true, search: true }),
    text('color', 'Color', { list: true, search: true }),
    n('gsm', 'GSM'), n('dia', 'Dia (inch)'),
    text('batchNo', 'Batch / Lot No', { search: true }),
    n('issuedKg', 'Issued (kg)', { required: true, list: true, section: 'Quantity' }),
    n('receivedKg', 'Received (kg)', { list: true }),
    n('rejectedKg', 'Rejected (kg)'),
    n('allowedLossPct', 'Allowed Process Loss %', { default: 8, max: 100 }),
    calc('lossKg', 'Process Loss (kg)'), calc('lossPct', 'Loss %', { list: true }),
    calc('pendingKg', 'Pending at Processor (kg)', { list: true }),
    n('ratePerKg', 'Process Rate / kg', { section: 'Charges', list: true }),
    sel('chargeBasis', 'Charge On', ['Issued Kg', 'Received Kg'], { default: 'Issued Kg' }),
    calc('amount', 'Process Charges', { list: true }),
    area('remarks', 'Remarks'),
  ],
  compute(d) {
    const issued = num(d.issuedKg); const received = num(d.receivedKg); const rejected = num(d.rejectedKg);
    const loss = Math.max(issued - received - rejected, 0);
    const done = d.status === 'Completed';
    const expected = issued * (1 - num(d.allowedLossPct) / 100) - rejected;
    return {
      // loss is only final once the program/order is completed; until then the difference is pending
      lossKg: round(done ? loss : 0, 2),
      lossPct: done ? pct(loss, issued) : 0,
      pendingKg: round(done ? 0 : Math.max(expected - received, 0), 2),
      amount: round((d.chargeBasis === 'Received Kg' ? received : issued) * num(d.ratePerKg)),
    };
  },
};
