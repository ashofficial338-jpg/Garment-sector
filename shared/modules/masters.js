import { text, area, n, sel, bool, date, flow } from './dsl.js';
import { CURRENCIES, DEPARTMENTS } from '../constants.js';

const active = flow(['Active', 'Inactive'], { Inactive: ['Active'] });

export const buyer = {
  key: 'buyer', model: 'Buyer', title: 'Buyers', singular: 'Buyer', group: 'Master Data', icon: 'Building2',
  department: 'Head Office Merchandising', prefix: 'BUY', jobLinked: false, ...active, defaultStatus: 'Active',
  fields: [
    text('name', 'Buyer Name', { required: true, list: true, search: true }),
    text('code', 'Buyer Code', { list: true, search: true }),
    text('country', 'Country', { list: true, filter: true }),
    text('contactPerson', 'Contact Person', { list: true }),
    text('email', 'Email'), text('phone', 'Phone'),
    sel('currency', 'Default Currency', CURRENCIES, { default: 'USD' }),
    text('paymentTerms', 'Payment Terms'), text('agent', 'Buying Agent'),
    n('commissionPct', 'Commission %', { max: 100 }),
    area('address', 'Address'),
  ],
};

export const supplier = {
  key: 'supplier', model: 'Supplier', title: 'Suppliers', singular: 'Supplier', group: 'Master Data', icon: 'Truck',
  department: 'Fabric Department', prefix: 'SUP', jobLinked: false, ...active, defaultStatus: 'Active',
  fields: [
    text('name', 'Supplier Name', { required: true, list: true, search: true }),
    text('code', 'Supplier Code', { list: true, search: true }),
    sel('supplierType', 'Supplier Type', ['Fabric', 'Yarn', 'Knitting', 'Fabric Processing', 'Trims', 'Accessories', 'Washing', 'Printing', 'Embroidery', 'Dyeing', 'Logistics', 'Testing Lab', 'Other'], { list: true, filter: true, required: true }),
    text('contactPerson', 'Contact Person'), text('email', 'Email'), text('phone', 'Phone', { list: true }),
    text('country', 'Country', { list: true }),
    n('leadTimeDays', 'Lead Time (days)'), n('rating', 'Rating (1-5)', { max: 5 }),
    area('address', 'Address'),
  ],
};

export const MASTER_TYPES = [
  'Garment Type', 'Product Category', 'Size', 'Color', 'Fabric', 'Trim', 'Operation', 'Machine',
  'Cost Component', 'Currency', 'Unit', 'Payment Term', 'Shipment Term', 'Country', 'Department',
  'Production Line', 'Floor', 'Wastage Rule',
];

export const master = {
  key: 'master', model: 'MasterData', title: 'Master Data', singular: 'Master Record', group: 'Master Data', icon: 'Database',
  department: 'Admin', prefix: 'MST', jobLinked: false, ...active, defaultStatus: 'Active',
  fields: [
    sel('masterType', 'Master Type', MASTER_TYPES, { required: true, list: true, filter: true }),
    text('code', 'Code', { list: true, search: true }),
    text('name', 'Name', { required: true, list: true, search: true }),
    n('value', 'Value / Rate / %', { list: true, min: undefined }),
    text('unit', 'Unit'),
    area('description', 'Description'),
  ],
};

export const employee = {
  key: 'employee', model: 'Employee', title: 'Employees', singular: 'Employee', group: 'HR', icon: 'IdCard',
  department: 'HR', prefix: 'EMP', jobLinked: false,
  ...flow(['Active', 'On Leave', 'Resigned'], { 'On Leave': ['Active'] }), defaultStatus: 'Active',
  fields: [
    text('empCode', 'Employee Code', { required: true, list: true, search: true }),
    text('name', 'Name', { required: true, list: true, search: true }),
    sel('department', 'Department', DEPARTMENTS, { list: true, filter: true }),
    text('designation', 'Designation', { list: true }),
    text('line', 'Line / Section'), sel('skillGrade', 'Skill Grade', ['A', 'B', 'C', 'Helper', 'Trainee']),
    date('joinDate', 'Joining Date'), text('phone', 'Phone'),
    n('presentDays', 'Present Days (month)'), n('workingDays', 'Working Days (month)'),
    { name: 'attendancePct', label: 'Attendance %', type: 'number', readOnly: true, list: true },
    bool('isOperator', 'Machine Operator'),
  ],
  compute(d) {
    const w = Number(d.workingDays) || 0;
    return { attendancePct: w ? Math.round(((Number(d.presentDays) || 0) / w) * 1000) / 10 : 0 };
  },
};
