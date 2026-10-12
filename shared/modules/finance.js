import { text, area, n, calc, date, sel, ref, bool, table, flow } from './dsl.js';
import { CURRENCIES } from '../constants.js';
import { num, round } from '../calc.js';
import { EXPENSE_CATEGORIES } from '../costHeads.js';

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
    calc('balanceQty', 'Order Balance after this Shipment', { list: true }),
    n('netWeight', 'Net Weight (kg)'), n('grossWeight', 'Gross Weight (kg)'), n('cbm', 'CBM'),
    text('vesselFlight', 'Vessel / Flight', { section: 'Logistics' }), text('containerNo', 'Container No', { search: true }),
    text('blAwbNo', 'BL / AWB No', { list: true, search: true }), text('portOfLoading', 'Port of Loading'),
    text('destination', 'Destination', { list: true }), text('forwarder', 'Forwarder', { search: true }),
    date('etd', 'ETD'), date('eta', 'ETA'),
    date('deliveredDate', 'Delivered On', { section: 'Delivery confirmation' }), text('podRef', 'Proof of Delivery / Buyer Receipt Ref'),
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
// job cost heads + company-level finance lines (interest, tax, depreciation, amortization) – see shared/costHeads.js
export { EXPENSE_CATEGORIES };
export const expense = {
  key: 'expense', model: 'Expense', title: 'Expenses', singular: 'Expense', group: 'Shipping & Finance', icon: 'Coins',
  // job costs are booked against a Job No; company-level costs (interest, tax, depreciation…) have no job
  department: 'Accounts & Finance', prefix: 'EXP', jobLinked: 'optional',
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

/* ------------------------------ Supplier Bills (accounts payable) ------------------------------ */
/**
 * Supplier invoices for fabric, trims, services, freight and testing, with debit / credit notes set off and payments.
 * A bill is the PAYABLE, not an extra cost: the job cost is recognised when the goods are received (bookings, roll
 * receipts) or the service is booked (job expenses) – so bills never double count job cost.
 */
export const BILL_TYPES = ['Fabric', 'Trims / Accessories', 'Service – Washing / Printing / Embroidery', 'Freight / Logistics', 'Testing', 'Other'];
export const supplierBill = {
  key: 'supplierBill', model: 'SupplierBill', title: 'Supplier Bills (Payables)', singular: 'Supplier Bill', group: 'Shipping & Finance', icon: 'Wallet',
  department: 'Accounts & Finance', prefix: 'SB', jobLinked: 'optional', stage: 'accounts',
  ...flow(['Received', 'Verified', 'Approved'], { Received: ['Disputed'], Verified: ['Disputed'], Disputed: ['Verified'] }), defaultStatus: 'Received',
  fields: [
    ref('supplier', 'Supplier', 'Supplier', { required: true, section: 'Bill' }),
    text('billNo', 'Supplier Invoice No', { required: true, list: true, search: true }),
    date('billDate', 'Invoice Date', { required: true, list: true }), date('dueDate', 'Due Date', { list: true }),
    sel('billType', 'Bill Type', BILL_TYPES, { required: true, list: true, filter: true }),
    ref('fabricBooking', 'Fabric Booking', 'FabricBooking', { jobScoped: true }),
    text('poRef', 'Supplier PO / Booking Ref', { search: true }),
    text('description', 'Description'),
    n('qty', 'Qty', { section: 'Amount' }), text('unit', 'Unit'), n('rate', 'Rate'),
    calc('amount', 'Amount'), n('taxPct', 'Tax %', { max: 100 }), calc('taxAmount', 'Tax'), calc('totalAmount', 'Bill Total', { list: true }),
    n('debitNoteAdjusted', 'Debit / Credit Notes Set Off', { hint: 'Supplier debit notes settled by a credit note against this bill' }),
    text('debitNoteRefs', 'Debit / Credit Note Refs'),
    table('payments', 'Payments to Supplier', [date('date', 'Date'), sel('mode', 'Mode', ['Bank transfer', 'Cheque', 'LC', 'Cash']), text('reference', 'Reference'), n('amount', 'Amount')], { section: 'Payments' }),
    calc('paidAmount', 'Paid', { list: true }), calc('outstanding', 'Outstanding', { list: true }),
    calc('paymentStatus', 'Payment Status', { type: 'text', list: true }),
    area('remarks', 'Remarks'),
  ],
  compute(d) {
    const amount = round(num(d.qty) * num(d.rate));
    const taxAmount = round((amount * num(d.taxPct)) / 100);
    const totalAmount = round(amount + taxAmount);
    const paidAmount = round((d.payments || []).reduce((t, p) => t + num(p.amount), 0));
    const outstanding = round(totalAmount - num(d.debitNoteAdjusted) - paidAmount);
    return { amount, taxAmount, totalAmount, paidAmount, outstanding, paymentStatus: outstanding <= 0.005 ? 'Paid' : paidAmount > 0 || num(d.debitNoteAdjusted) > 0 ? 'Part paid' : 'Unpaid' };
  },
};
