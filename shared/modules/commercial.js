import { text, area, n, calc, date, sel, ref, table, tags, bool, flow } from './dsl.js';
import { CURRENCIES, UNITS } from '../constants.js';
import { costSheet, fabricRequirement, round, num, sum, COST_COMPONENTS } from '../calc.js';

export const INCOTERMS = ['FOB', 'CIF', 'CFR', 'EXW', 'FCA', 'DDP', 'DAP', 'CPT'];
export const PAYMENT_TERMS = ['LC at sight', 'LC 30 days', 'LC 60 days', 'TT advance', 'TT 30 days', 'TT 60 days', 'DA 60 days', 'DP at sight', 'Open account'];
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
    ref('buyer', 'Buyer', 'Buyer', { required: true }),
    text('buyerContact', 'Buyer Contact'),
    text('poNo', 'PO No', { required: true, list: true, search: true }),
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
