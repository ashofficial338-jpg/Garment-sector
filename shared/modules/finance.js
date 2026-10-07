import { text, area, n, calc, date, sel, ref, bool, flow } from './dsl.js';
import { CURRENCIES } from '../constants.js';
import { num, round } from '../calc.js';

/* ------------------------------ Shipment ------------------------------ */
export const shipment = {
  key: 'shipment', model: 'Shipment', title: 'Shipments', singular: 'Shipment', group: 'Shipping & Finance', icon: 'Ship',
  department: 'Shipment / Documentation', prefix: 'SHP', jobLinked: true, stage: 'shipment', qtyField: 'qty',
  ...flow(['Planned', 'Booked', 'Stuffed', 'Shipped', 'Delivered'], { Planned: ['Cancelled'] }), defaultStatus: 'Planned',
  fields: [
    text('invoiceNo', 'Invoice No', { list: true, search: true, section: 'Shipment' }),
    sel('mode', 'Mode', ['Sea', 'Air', 'Road', 'Courier', 'Sea-Air'], { default: 'Sea', list: true }),
    date('shipmentDate', 'Planned Ship Date', { required: true, list: true }),
    date('actualShipDate', 'Actual Ship Date'),
    n('cartons', 'Cartons', { section: 'Quantity (auto-pulled from Packing)' }), n('qty', 'Ship Qty (pcs)', { required: true, list: true }),
    n('netWeight', 'Net Weight (kg)'), n('grossWeight', 'Gross Weight (kg)'), n('cbm', 'CBM'),
    text('vesselFlight', 'Vessel / Flight', { section: 'Logistics' }), text('containerNo', 'Container No', { search: true }),
    text('blAwbNo', 'BL / AWB No', { list: true, search: true }), text('portOfLoading', 'Port of Loading'),
    text('destination', 'Destination', { list: true }), text('forwarder', 'Forwarder', { search: true }),
    date('etd', 'ETD'), date('eta', 'ETA'),
    area('remarks', 'Remarks'),
  ],
};

/* ------------------------------ Invoice / Accounts ------------------------------ */
export const invoice = {
  key: 'invoice', model: 'Invoice', title: 'Invoices / Accounts', singular: 'Invoice', group: 'Shipping & Finance', icon: 'ReceiptText',
  department: 'Accounts & Finance', prefix: 'INV', jobLinked: true, stage: 'accounts', pdf: 'commercialInvoice',
  ...flow(['Draft', 'Issued', 'Partial', 'Fully Paid', 'Closed'], { Issued: ['Fully Paid', 'Cancelled'], Draft: ['Cancelled'] }),
  defaultStatus: 'Draft', autoStatus: true,
  fields: [
    text('invoiceNo', 'Invoice No', { required: true, list: true, search: true, section: 'Invoice' }),
    date('invoiceDate', 'Invoice Date', { required: true, list: true }),
    ref('shipment', 'Shipment', 'Shipment'),
    n('qty', 'Invoice Qty (pcs)', { required: true }),
    n('unitPrice', 'Unit Price', { required: true }),
    sel('currency', 'Currency', CURRENCIES, { default: 'USD', list: true }),
    calc('grossAmount', 'Gross Amount'),
    n('discount', 'Discount / Claims'), n('otherCharges', 'Other Charges'),
    calc('totalAmount', 'Invoice Amount', { list: true }),
    date('dueDate', 'Payment Due Date', { list: true }),
    calc('receivedAmount', 'Received', { section: 'Collection', list: true }),
    calc('outstanding', 'Outstanding', { list: true }),
    bool('allowOverpayment', 'Allow payment above invoice amount'),
    area('remarks', 'Remarks'),
  ],
  prefill: (job) => ({ unitPrice: job.unitPrice, currency: job.currency }),
  compute(d) {
    const gross = round(num(d.qty) * num(d.unitPrice));
    const total = round(gross - num(d.discount) + num(d.otherCharges));
    const received = num(d.receivedAmount);
    const out = { grossAmount: gross, totalAmount: total, outstanding: round(total - received) };
    if (d.status && !['Draft', 'Cancelled', 'Closed'].includes(d.status)) {
      out.status = received <= 0 ? 'Issued' : received + 0.005 < total ? 'Partial' : 'Fully Paid';
    }
    return out;
  },
};

/* ------------------------------ Payment ------------------------------ */
export const payment = {
  key: 'payment', model: 'Payment', title: 'Payments', singular: 'Payment', group: 'Shipping & Finance', icon: 'Wallet',
  department: 'Accounts & Finance', prefix: 'PAY', jobLinked: true, stage: 'payment',
  ...flow(['Received', 'Reconciled']), defaultStatus: 'Received',
  fields: [
    ref('invoice', 'Invoice', 'Invoice', { required: true }),
    date('paymentDate', 'Payment Date', { required: true, list: true }),
    n('amount', 'Amount', { required: true, list: true }),
    sel('currency', 'Currency', CURRENCIES, { default: 'USD', list: true }),
    sel('mode', 'Mode', ['TT', 'LC', 'Cheque', 'Bank Transfer', 'Cash', 'Adjustment'], { default: 'TT', list: true }),
    text('reference', 'Bank Ref / LC No', { search: true, list: true }),
    bool('isAdvance', 'Advance Payment'),
    n('bankCharges', 'Bank Charges'),
    area('remarks', 'Remarks'),
  ],
};

/* ------------------------------ Expenses ------------------------------ */
export const EXPENSE_CATEGORIES = ['Fabric', 'Trims', 'Production', 'Labour', 'Overhead', 'Freight', 'Testing', 'Commission', 'Washing', 'Printing', 'Embroidery', 'Other'];
export const expense = {
  key: 'expense', model: 'Expense', title: 'Job Expenses', singular: 'Expense', group: 'Shipping & Finance', icon: 'Coins',
  department: 'Accounts & Finance', prefix: 'EXP', jobLinked: true,
  ...flow(['Pending', 'Approved'], { Pending: ['Rejected'] }), defaultStatus: 'Pending',
  fields: [
    sel('category', 'Category', EXPENSE_CATEGORIES, { required: true, list: true, filter: true }),
    text('description', 'Description', { list: true, search: true }),
    date('expenseDate', 'Date', { required: true, list: true }),
    n('amount', 'Amount', { required: true, list: true }),
    sel('currency', 'Currency', CURRENCIES, { default: 'USD' }),
    text('vendor', 'Vendor / Payee', { search: true }),
    text('billNo', 'Bill No'),
    area('remarks', 'Remarks'),
  ],
};
