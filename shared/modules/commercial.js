import { text, area, n, calc, date, sel, ref, table, tags, bool, flow } from './dsl.js';
import { CURRENCIES, UNITS } from '../constants.js';
import { costSheet, fabricRequirement, round, num, sum, COST_COMPONENTS } from '../calc.js';

export const INCOTERMS = ['FOB', 'CIF', 'CFR', 'EXW', 'FCA', 'DDP', 'DAP', 'CPT'];
export const PAYMENT_TERMS = ['LC at sight', 'LC 30 days', 'LC 60 days', 'TT advance', 'TT 30 days', 'TT 60 days', 'DA 60 days', 'DP at sight', 'Open account'];
export const PO_STATUSES = ['PO Received', 'Awaiting PO'];
export const TRIM_ITEMS = ['Button', 'Zipper', 'Main Label', 'Care Label', 'Size Label', 'Hang Tag', 'Polybag', 'Carton', 'Thread', 'Elastic', 'Rib', 'Tape', 'Drawcord', 'Interlining', 'Sticker', 'Tissue Paper', 'Hanger', 'Other'];

const fabricSpec = [
  text('fabric', 'Fabric', { section: 'Product & Fabric', search: true }),
  text('composition', 'Composition'),
  n('gsm', 'GSM'),
  text('color', 'Color'),
  text('sizeRange', 'Size Range'),
];

/* ------------------------------ Enquiry ------------------------------ */
export const enquiry = {
  key: 'enquiry', model: 'Enquiry', title: 'Buyer Enquiries', singular: 'Enquiry', group: 'Merchandising', icon: 'MessageSquareText',
  department: 'Head Office Merchandising', prefix: 'ENQ', jobLinked: 'optional', stage: 'enquiry',
  ...flow(['Pending', 'Under Review', 'Costing', 'Quoted', 'Converted'], { 'Under Review': ['Rejected', 'Cancelled'], Costing: ['Cancelled'], Quoted: ['Rejected'] }),
  defaultStatus: 'Pending',
  fields: [
    date('enquiryDate', 'Enquiry Date', { required: true, list: true, section: 'Enquiry' }),
    ref('buyer', 'Buyer', 'Buyer', { required: true }),
    text('buyerContact', 'Buyer Contact'),
    text('styleNo', 'Style No', { required: true, list: true, search: true }),
    text('product', 'Product / Garment', { list: true, search: true }),
    text('garmentType', 'Garment Type'),
    ...fabricSpec,
    n('expectedQty', 'Expected Qty (pcs)', { list: true, section: 'Commercial' }),
    n('targetPrice', 'Target Price / pc'),
    sel('currency', 'Currency', CURRENCIES, { default: 'USD' }),
    date('requiredDelivery', 'Required Delivery'),
    area('remarks', 'Remarks'),
  ],
};

/* ------------------------------ Costing ------------------------------ */
const componentFields = COST_COMPONENTS.map(([k, l], i) => n(k, `${l} / pc`, i === 0 ? { section: 'Cost Components (per piece)' } : {}));

export const costing = {
  key: 'costing', model: 'Costing', title: 'Costing', singular: 'Cost Sheet', group: 'Merchandising', icon: 'Calculator',
  department: 'Costing Factory', prefix: 'CST', jobLinked: 'optional', stage: 'costing',
  ...flow(['Draft', 'Submitted', 'Under Review', 'Approved'], { 'Under Review': ['Rejected'], Rejected: ['Draft'] }),
  defaultStatus: 'Draft',
  fields: [
    ref('enquiry', 'Enquiry', 'Enquiry', { section: 'Reference' }),
    date('costingDate', 'Costing Date'),
    ref('buyer', 'Buyer', 'Buyer', { required: true }),
    text('styleNo', 'Style No', { required: true, list: true, search: true }),
    text('product', 'Product', { list: true }),
    n('orderQty', 'Order Qty (pcs)', { required: true, list: true }),
    sel('currency', 'Currency', CURRENCIES, { default: 'USD' }),
    n('fabricConsumption', 'Fabric Consumption / pc', { section: 'Fabric Cost' }),
    sel('fabricUnit', 'Fabric Unit', ['KG', 'Meter', 'Yard'], { default: 'KG' }),
    n('fabricRate', 'Fabric Rate / unit'),
    n('fabricWastagePct', 'Fabric Wastage %', { max: 100 }),
    calc('fabricCost', 'Fabric Cost / pc'),
    ...componentFields,
    n('commissionPct', 'Commission %', { section: 'Commercial %', max: 100 }),
    n('financeCostPct', 'Finance Cost %', { max: 100 }),
    n('adminOverheadPct', 'Admin Overhead %', { max: 100 }),
    n('profitMarginPct', 'Profit Margin % (markup)', { max: 500 }),
    n('quotedPrice', 'Quoted Price / pc (optional override)'),
    calc('cmCost', 'CM / pc', { section: 'Result' }), calc('cmtCost', 'CMT / pc'),
    calc('commissionAmt', 'Commission / pc'), calc('financeAmt', 'Finance / pc'), calc('adminOverheadAmt', 'Admin OH / pc'),
    calc('totalCostPerPc', 'Total Cost / pc', { list: true }), calc('costPerDozen', 'Cost / Dozen'),
    calc('sellingPrice', 'Selling (FOB) Price / pc', { list: true }), calc('fobPerDozen', 'FOB / Dozen'),
    calc('profitPerPc', 'Profit / pc'), calc('totalCost', 'Total Cost'),
    calc('totalSales', 'Total Sales Value'), calc('totalExpectedProfit', 'Total Expected Profit', { list: true }),
    calc('profitPct', 'Profit %', { list: true }),
    area('remarks', 'Remarks'),
  ],
  compute: (d) => costSheet(d),
};

/* ------------------------------ Quotation ------------------------------ */
export const quotation = {
  key: 'quotation', model: 'Quotation', title: 'Quotations', singular: 'Quotation', group: 'Merchandising', icon: 'FileSignature',
  department: 'Head Office Merchandising', prefix: 'QTN', jobLinked: 'optional', stage: 'quotation',
  ...flow(['Draft', 'Sent', 'Under Review', 'Approved', 'Converted'], { 'Under Review': ['Rejected', 'Revised'], Sent: ['Revised'], Rejected: ['Revised'] }),
  defaultStatus: 'Draft',
  pdf: 'quotation',
  fields: [
    ref('costing', 'Costing', 'Costing', { section: 'Reference', hint: 'Selecting a costing auto-fills style, quantity and price' }),
    ref('enquiry', 'Enquiry', 'Enquiry'),
    calc('version', 'Version', { list: true }),
    date('quoteDate', 'Quotation Date', { required: true, list: true }),
    ref('buyer', 'Buyer', 'Buyer', { required: true }),
    text('buyerContact', 'Buyer Contact'),
    text('styleNo', 'Style No', { required: true, list: true, search: true }),
    text('product', 'Product', { list: true }),
    ...fabricSpec,
    n('orderQty', 'Order Qty (pcs)', { required: true, list: true, section: 'Commercial' }),
    n('price', 'Price / pc', { required: true, list: true }),
    sel('currency', 'Currency', CURRENCIES, { default: 'USD', list: true }),
    calc('quoteValue', 'Quotation Value', { list: true }),
    sel('paymentTerms', 'Payment Terms', PAYMENT_TERMS),
    sel('deliveryTerms', 'Delivery Terms (Incoterm)', INCOTERMS, { default: 'FOB' }),
    text('shipmentTerms', 'Shipment Terms'),
    date('validUntil', 'Valid Until'),
    area('remarks', 'Remarks'),
  ],
  compute: (d) => ({ quoteValue: round(num(d.orderQty) * num(d.price)) }),
};

/* ------------------------------ Buyer Order register (New Orders) ------------------------------ */
/**
 * Every buyer PO as it is received, before (and after) it becomes a job. "Create Job" converts it
 * (through its approved quotation when there is one); "Link to Job" attaches it to an advance /
 * forecast job that was opened before the PO arrived. The assigned Job No is set only by those actions.
 */
export const BUYER_ORDER_TYPES = ['New Order', 'Repeat Order', 'Forecast Call-off'];
/** Set only by the Create Job / Link to Job actions – never by a manual status change. */
export const BUYER_ORDER_DONE = ['Job Created', 'Linked to Job'];
const buyerOrderFlow = flow(['Received', 'Under Review'], { Received: ['Cancelled'], 'Under Review': ['Cancelled'] });
export const buyerOrder = {
  key: 'buyerOrder', model: 'BuyerOrder', title: 'New Orders (Buyer POs)', singular: 'Buyer Order', group: 'Merchandising', icon: 'Inbox',
  department: 'Head Office Merchandising', prefix: 'BPO', jobLinked: false, stage: 'order',
  statuses: [...buyerOrderFlow.statuses, ...BUYER_ORDER_DONE], transitions: buyerOrderFlow.transitions,
  defaultStatus: 'Received',
  fields: [
    sel('orderType', 'Order Type', BUYER_ORDER_TYPES, { default: 'New Order', list: true, filter: true, section: 'Order' }),
    ref('buyer', 'Buyer', 'Buyer', { required: true }),
    text('poNo', 'Buyer PO No', { required: true, list: true, search: true }),
    text('styleNo', 'Style No', { required: true, list: true, search: true }),
    text('product', 'Product / Garment', { list: true }),
    text('garmentType', 'Garment Type'),
    date('orderDate', 'PO Date', { required: true, list: true }),
    date('deliveryDate', 'Delivery Date', { required: true, list: true }),
    date('shipmentDate', 'Ex-factory / Shipment Date'),
    n('orderQty', 'Order Qty (pcs)', { required: true, list: true }),
    n('unitPrice', 'Unit Price'),
    sel('currency', 'Currency', CURRENCIES, { default: 'USD' }),
    calc('orderValue', 'Order Value'),
    text('color', 'Color(s)'), text('sizeRatio', 'Size Ratio', { hint: 'e.g. S:2,M:4,L:3,XL:1' }),
    text('destination', 'Destination'),
    ref('quotation', 'Approved Quotation', 'Quotation', { section: 'Job', hint: 'Create Job pulls style, fabric and costing from this quotation' }),
    text('repeatOfJobNo', 'Repeat of Job No', { hint: 'Previous job for a repeat order' }),
    calc('jobNo', 'Assigned Job No', { type: 'text', list: true, search: true }),
    calc('jobCreation', 'Job Creation Status', { type: 'text', list: true }),
    area('remarks', 'Remarks'),
  ],
  compute: (d) => ({
    orderValue: round(num(d.orderQty) * num(d.unitPrice)),
    jobCreation: d.jobNo ? (d.status === 'Linked to Job' ? `Linked to advance job ${d.jobNo}` : `Job ${d.jobNo} created`) : d.status === 'Cancelled' ? 'Cancelled' : 'Awaiting job creation',
  }),
};

/* ------------------------------ Order / Job ------------------------------ */
export const orders = {
  key: 'orders', model: 'Job', title: 'Orders / Jobs', singular: 'Order', group: 'Merchandising', icon: 'ClipboardCheck',
  department: 'Head Office Merchandising', prefix: 'ORD', jobLinked: false, stage: 'order', isJob: true,
  ...flow(['Confirmed', 'In Progress', 'Ready to Close'], { Confirmed: ['On Hold', 'Cancelled'], 'In Progress': ['On Hold'], 'On Hold': ['In Progress', 'Cancelled'] }),
  closeStatuses: ['Closed'],
  defaultStatus: 'Confirmed',
  fields: [
    calc('jobNo', 'Job No', { type: 'text', list: true, search: true, section: 'Order' }),
    calc('orderNo', 'Order No', { type: 'text', search: true }),
    calc('jobType', 'Job Type', { type: 'text', list: true }),
    calc('revision', 'Order Revision'),
    ref('buyer', 'Buyer', 'Buyer', { required: true }),
    text('buyerContact', 'Buyer Contact'),
    // advance (forecast) jobs are opened before the buyer's PO exists: PO No is required once the PO is received
    sel('poStatus', 'PO Status', PO_STATUSES, { default: 'PO Received', list: true, filter: true }),
    text('poNo', 'PO No', { required: true, requiredIf: (d) => d.poStatus !== 'Awaiting PO', list: true, search: true }),
    text('styleNo', 'Style No', { required: true, list: true, search: true }),
    text('product', 'Product / Garment', { list: true }),
    text('garmentType', 'Garment Type'),
    date('orderDate', 'Order Date', { required: true }),
    n('orderQty', 'Order Qty (pcs)', { required: true, list: true }),
    n('unitPrice', 'Unit Price', { required: true }),
    sel('currency', 'Currency', CURRENCIES, { default: 'USD' }),
    calc('orderValue', 'Order Value', { list: true }),
    tags('colors', 'Colors'), tags('sizes', 'Sizes'),
    table('sizeBreakdown', 'Color / Size Breakdown', [text('color', 'Color'), text('size', 'Size'), n('qty', 'Qty')]),
    date('deliveryDate', 'Delivery Date', { section: 'Delivery & Terms' }),
    date('shipmentDate', 'Shipment Date', { required: true, list: true }),
    sel('paymentTerms', 'Payment Terms', PAYMENT_TERMS),
    sel('deliveryTerms', 'Delivery Terms', INCOTERMS, { default: 'FOB' }),
    text('destination', 'Destination', { list: true, filter: true }),
    text('fabricType', 'Fabric Type', { section: 'Fabric Details', search: true }),
    text('composition', 'Composition'), n('gsm', 'GSM'), n('width', 'Width (inch)'), text('fabricColor', 'Fabric Color'),
    n('consumption', 'Consumption / pc'), sel('consumptionUnit', 'Unit', ['KG', 'Meter', 'Yard'], { default: 'KG' }),
    n('wastagePct', 'Fabric Wastage %', { max: 100 }), n('cuttingWastagePct', 'Cutting Wastage %', { max: 100 }),
    n('shrinkagePct', 'Shrinkage %', { max: 100 }), n('relaxationPct', 'Relaxation %', { max: 100 }),
    n('dyeingLossPct', 'Dyeing Loss %', { max: 100 }), n('processLossPct', 'Process Loss %', { max: 100 }),
    n('fabricRate', 'Fabric Rate / unit'),
    calc('requiredFabricQty', 'Required Fabric Qty'),
    table('trims', 'Trim Details', [
      sel('item', 'Item', TRIM_ITEMS), text('description', 'Description'), n('consumptionPerPc', 'Qty / pc'),
      sel('unit', 'Unit', UNITS, { default: 'Pcs' }), n('wastagePct', 'Wastage %'), n('rate', 'Rate'),
    ], { section: 'Trims' }),
    bool('isForecast', 'Forecast / Continuous Order', { section: 'Forecast' }),
    n('forecastQty', 'Forecast Qty (pcs)'),
    text('expectedOrderMonth', 'Expected Next Order Month', { hint: 'YYYY-MM – repeat / forecast orders' }),
    text('repeatOfJobNo', 'Repeat of Job No', { hint: 'Previous job of this buyer / style' }),
    calc('subJobCount', 'Sub Jobs'),
    area('specialInstructions', 'Special Instructions', { section: 'Notes' }),
  ],
  compute(d) {
    const fr = fabricRequirement({ ...d, orderQty: d.orderQty });
    const bd = sum(d.sizeBreakdown, 'qty');
    return {
      orderValue: round(num(d.orderQty) * num(d.unitPrice)),
      requiredFabricQty: fr.requiredQty,
      ...(bd && !num(d.orderQty) ? { orderQty: bd } : {}),
    };
  },
};
