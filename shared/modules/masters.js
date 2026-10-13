import { text, area, n, sel, bool, date, table, flow } from './dsl.js';
import { CURRENCIES, DEPARTMENTS } from '../constants.js';
import { LABOUR_SECTIONS } from './factory.js';

const active = flow(['Active', 'Inactive'], { Inactive: ['Active'] });

export const buyer = {
  key: 'buyer', model: 'Buyer', sharedAcrossUnits: true, title: 'Buyers', singular: 'Buyer', group: 'Master Data', icon: 'Building2',
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
    text('buyerGroup', 'Buyer Group', { filter: true }),
    sel('shippingTerms', 'Shipping Terms (Incoterm)', ['FOB', 'CIF', 'CFR', 'EXW', 'FCA', 'DDP', 'DAP', 'CPT'], { default: 'FOB' }),
    n('creditDays', 'Credit Days'), n('creditLimit', 'Credit Limit'),
    area('address', 'Billing Address', { section: 'Addresses' }),
    area('shippingAddress', 'Shipping / Delivery Address'),
    text('portOfDischarge', 'Port of Discharge'), text('notifyParty', 'Notify Party'),
    table('contacts', 'Buyer Contacts', [text('name', 'Name'), text('role', 'Role'), text('email', 'Email'), text('phone', 'Phone')], { section: 'Contacts' }),
  ],
};

export const supplier = {
  key: 'supplier', model: 'Supplier', sharedAcrossUnits: true, title: 'Suppliers', singular: 'Supplier', group: 'Master Data', icon: 'Truck',
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
  'Garment Type', 'Product Category', 'Style', 'Season', 'Buyer Group', 'Size', 'Color', 'Fabric', 'Fabric Composition', 'Trim', 'Accessory',
  'Operation', 'Machine', 'Process', 'Quality Parameter', 'Defect Type', 'Warehouse', 'Location', 'Cost Component', 'Currency', 'Tax Rate',
  'Unit', 'Payment Term', 'Shipment Term', 'Shipment Method', 'Expense Category', 'Costing Template', 'Country', 'Port', 'Department', 'Production Line', 'Floor', 'Wastage Rule',
  'Shift', 'Hourly Slot', 'Delay Reason',
];

export const master = {
  key: 'master', model: 'MasterData', sharedAcrossUnits: true, title: 'Master Data', singular: 'Master Record', group: 'Master Data', icon: 'Database',
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
    sel('section', 'Production Section (labour allocation)', LABOUR_SECTIONS, { list: true, filter: true, section: 'Wages & allocation' }),
    sel('employmentType', 'Employment Type', ['Permanent', 'Contract', 'Trainee'], { default: 'Permanent', filter: true }),
    text('contractor', 'Labour Contractor (contract labour)'),
    sel('wageType', 'Wage Type', ['Monthly salary', 'Daily wage'], { default: 'Monthly salary' }),
    n('monthlySalary', 'Monthly Salary'), n('dailyWage', 'Daily Wage'),
    n('standardDays', 'Standard Working Days / Month', { default: 26 }), n('standardHours', 'Standard Hours / Day', { default: 8 }),
    n('otRatePerHour', 'Overtime Rate / Hour'), n('employerContributionPct', 'Employer Contributions % (PF / ESI)', { max: 100 }),
    { name: 'hourlyRate', label: 'Standard Cost / Hour (excl. employer %)', type: 'number', readOnly: true, list: true },
  ],
  compute(d) {
    const w = Number(d.workingDays) || 0;
    const days = Number(d.standardDays) || 26; const hrs = Number(d.standardHours) || 8;
    const perDay = d.wageType === 'Daily wage' ? Number(d.dailyWage) || 0 : (Number(d.monthlySalary) || 0) / days;
    return { attendancePct: w ? Math.round(((Number(d.presentDays) || 0) / w) * 1000) / 10 : 0, hourlyRate: Math.round((perDay / hrs) * 10000) / 10000 };
  },
};
