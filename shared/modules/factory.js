/**
 * Factory operations – hourly production by department, production routing with quality gates,
 * quality checkpoints, rework & corrective action, attendance & labour, payroll and factory expenses.
 *
 * Quantity model (per job, per department in the job's route):
 *   input      pieces received from the previous department (or, for a gated department, released by QC)
 *   completed  good pieces handed on to the next department
 *   rejected   pieces scrapped at this department
 *   rework     pieces sent for repair inside the department (still WIP until completed or rejected)
 *   pending    WIP = opening + input − completed − rejected
 * Only Cutting creates new pieces; every later department moves the same pieces on, so nothing is counted twice.
 */
import { text, area, n, calc, date, sel, ref, bool, table, flow } from './dsl.js';
import { CURRENCIES } from '../constants.js';
import { num, round, pct, sum } from '../calc.js';

/* ------------------------------ Vocabulary ------------------------------ */
export const PRODUCTION_DEPARTMENTS = [
  'Cutting', 'Cutting Issue', 'Preparation', 'Assembly', 'Sewing and Stitching', 'Checking', 'Quality Control',
  'Thread Trimming and Alteration', 'Ironing and Finishing', 'Folding', 'Packing', 'Carton/Box Packing', 'Finished Goods Inward',
];
export const SHIFTS = ['General', 'Shift A', 'Shift B', 'Shift C'];
/** Labour sections: production departments plus inspection and indirect sections. */
export const QUALITY_SECTIONS = ['Checking', 'Quality Control', 'Quality Inspection'];
export const INDIRECT_SECTIONS = ['Maintenance', 'Stores', 'Administration'];
export const LABOUR_SECTIONS = [...PRODUCTION_DEPARTMENTS, 'Quality Inspection', ...INDIRECT_SECTIONS];

/**
 * Quality inspection stages. `dept` = the production department whose completed output is submitted to the stage
 * (lots are reconciled against it); `type` = legacy inspection type used by the lifecycle; `sampling` = audit
 * inspections of pieces still in process (no lot-quantity reconciliation).
 */
export const QC_STAGES = [
  { key: 'Fabric Inspection', type: 'Stage', dept: null, sampling: true },
  { key: 'Cutting Panel Inspection', type: 'Stage', dept: 'Cutting' },
  { key: 'Bundle Inspection', type: 'Stage', dept: 'Cutting Issue' },
  { key: 'Component Inspection', type: 'Stage', dept: 'Preparation' },
  { key: 'In-line Inspection', type: 'Inline', dept: 'Sewing and Stitching', sampling: true },
  { key: 'End-line Inspection', type: 'End-line', dept: 'Checking' },
  { key: 'Finishing Inspection', type: 'Stage', dept: 'Ironing and Finishing' },
  { key: 'Measurement Check', type: 'Stage', dept: null, sampling: true },
  { key: 'Final Garment Inspection', type: 'Final', dept: 'Ironing and Finishing' },
  { key: 'Packing & Carton Inspection', type: 'Stage', dept: 'Carton/Box Packing' },
  { key: 'Pre-shipment Inspection', type: 'Final', dept: 'Finished Goods Inward' },
  { key: 'Finished Goods Approval', type: 'Final', dept: 'Finished Goods Inward' },
];
export const QC_STAGE_KEYS = QC_STAGES.map((s) => s.key);
export const qcStage = (key) => QC_STAGES.find((s) => s.key === key);
/** Stage whose released (passed) quantity limits what may be shipped. */
export const SHIPMENT_GATE = 'Pre-shipment Inspection';

/** Default route = the full department flow; Final QC releases pieces to Folding. */
export const DEFAULT_ROUTE = PRODUCTION_DEPARTMENTS.map((department) => ({ department, gateStage: department === 'Folding' ? 'Final Garment Inspection' : '' }));

export const DEFECT_CATEGORIES = ['Stitching', 'Fabric', 'Measurement', 'Component', 'Finishing / Ironing', 'Packing & Labelling', 'Print / Embroidery', 'Other'];
export const SEVERITIES = ['Critical', 'Major', 'Minor'];
export const INSPECTION_METHODS = ['100% inspection', 'AQL sampling', 'Random sampling', 'Measurement check'];

/* ------------------------------ Hourly production ------------------------------ */
const sheetFlow = flow(['Submitted', 'Approved'], { Submitted: ['Rejected'], Rejected: ['Submitted'] });

/** Totals of an hourly sheet – shared by the form, the server and the consolidation reports. */
export function sheetTotals(slots = [], opening = 0) {
  const rows = (slots || []).map((s) => ({ ...s, achievementPct: num(s.target) ? pct(s.completedQty, s.target, 1) : 0 }));
  const t = (k) => sum(rows, k);
  const out = {
    slots: rows,
    inputQty: t('inputQty'), completedQty: t('completedQty'), rejectedQty: t('rejectedQty'), reworkQty: t('reworkQty'),
    targetQty: t('target'), downtimeMin: t('downtimeMin'), manHours: round(t('workingHours'), 2),
  };
  out.achievementPct = out.targetQty ? pct(out.completedQty, out.targetQty, 1) : 0;
  out.pendingQty = round(num(opening) + out.inputQty - out.completedQty - out.rejectedQty, 0);
  out.outputPerManHour = out.manHours ? round(out.completedQty / out.manHours, 2) : 0;
  return out;
}

export const hourlyProduction = {
  key: 'hourlyProduction', model: 'HourlyProduction', title: 'Hourly Production', singular: 'Hourly Production Sheet', group: 'Production', icon: 'AlarmClock',
  department: 'Production', prefix: 'HPS', jobLinked: true, editReasonStatuses: ['Approved'],
  ...sheetFlow, defaultStatus: 'Submitted',
  fields: [
    date('entryDate', 'Date', { required: true, list: true, filter: true, section: 'Sheet' }),
    sel('shift', 'Shift', SHIFTS, { default: 'General', list: true, filter: true }),
    sel('department', 'Department', PRODUCTION_DEPARTMENTS, { required: true, list: true, filter: true }),
    text('line', 'Production Line / Table', { list: true, filter: true }),
    text('operation', 'Operation'),
    text('supervisor', 'Supervisor'),
    text('color', 'Colour', { list: true, hint: 'Default for the hourly rows' }), text('size', 'Size'),
    n('operators', 'Operators / Team Size'), n('helpers', 'Helpers'),
    calc('openingQty', 'Opening Balance (WIP brought forward)', { hint: 'Calculated from this job and department’s earlier sheets' }),
    table('slots', 'Hourly Entries', [
      text('slot', 'Hour / Slot', { suggest: 'Hourly Slot' }), text('color', 'Colour'), text('size', 'Size'), n('target', 'Target'),
      n('inputQty', 'Input'), n('completedQty', 'Completed'), n('rejectedQty', 'Rejected'), n('reworkQty', 'Rework'),
      calc('achievementPct', 'Achv %'), n('downtimeMin', 'Downtime min'), text('delayReason', 'Delay Reason', { suggest: 'Delay Reason' }),
      text('team', 'Employees / Team'), n('workingHours', 'Man-hours'), text('remarks', 'Remarks'),
      calc('enteredBy', 'Entered By', { type: 'text' }), calc('enteredAt', 'Entered / Changed At', { type: 'text' }),
    ], { section: 'Hourly entries', hint: 'One row per hour. Rework pieces stay in this department until completed or rejected.' }),
    calc('inputQty', 'Input (day)', { section: 'Daily consolidation' }), calc('completedQty', 'Completed (day)', { list: true }),
    calc('rejectedQty', 'Rejected (day)', { list: true }), calc('reworkQty', 'Rework (day)'),
    calc('pendingQty', 'Pending / WIP carried forward', { list: true }),
    calc('targetQty', 'Target (day)'), calc('achievementPct', 'Achievement %', { list: true }),
    calc('downtimeMin', 'Downtime (min)'), calc('manHours', 'Man-hours'), calc('outputPerManHour', 'Output / Man-hour'),
    area('remarks', 'Remarks'),
  ],
  compute(d) {
    const t = sheetTotals(d.slots, d.openingQty);
    return { ...t };
  },
};

/* ------------------------------ Production routing ------------------------------ */
export const productionRoute = {
  key: 'productionRoute', model: 'ProductionRoute', sharedAcrossUnits: true, title: 'Production Routing & Quality Gates', singular: 'Production Route', group: 'Production', icon: 'Workflow',
  department: 'Production', prefix: 'RTE', jobLinked: false,
  ...flow(['Active', 'Inactive'], { Inactive: ['Active'] }), defaultStatus: 'Active',
  fields: [
    text('name', 'Route Name', { required: true, list: true, search: true }),
    ref('buyer', 'Buyer (blank = all buyers)', 'Buyer', { list: true }),
    text('styleNo', 'Style No (blank = all styles)', { list: true, search: true }),
    text('garmentType', 'Garment Type (blank = all)'),
    table('steps', 'Department Sequence', [
      sel('department', 'Department', PRODUCTION_DEPARTMENTS),
      sel('gateStage', 'Quality Gate (inspection that must release pieces into this department)', QC_STAGE_KEYS),
    ], { hint: 'Departments in production order. A gate means only quality-approved pieces may enter the department.' }),
    bool('preShipmentRequired', 'Pre-shipment inspection must release goods before shipment', { default: true }),
    area('remarks', 'Remarks'),
  ],
};

/* ------------------------------ QC checkpoints ------------------------------ */
export const qcCheckpoint = {
  key: 'qcCheckpoint', model: 'QcCheckpoint', sharedAcrossUnits: true, title: 'QC Checkpoints', singular: 'QC Checkpoint Plan', group: 'Quality', icon: 'ListChecks',
  department: 'Quality', prefix: 'QCP', jobLinked: false,
  ...flow(['Active', 'Inactive'], { Inactive: ['Active'] }), defaultStatus: 'Active',
  fields: [
    text('name', 'Plan Name', { required: true, list: true, search: true }),
    sel('inspectionStage', 'Inspection Stage', QC_STAGE_KEYS, { required: true, list: true, filter: true }),
    ref('buyer', 'Buyer (blank = all)', 'Buyer', { list: true }),
    text('styleNo', 'Style No (blank = all)', { list: true }),
    sel('standard', 'Quality Standard', ['Buyer standard', 'ISO 2859-1 AQL', 'In-house standard'], { default: 'ISO 2859-1 AQL' }),
    sel('inspectionMethod', 'Method', INSPECTION_METHODS, { default: 'AQL sampling' }),
    sel('majorAql', 'Major AQL', ['0.65', '1.0', '1.5', '2.5', '4.0', '6.5'], { default: '2.5' }),
    sel('minorAql', 'Minor AQL', ['0.65', '1.0', '1.5', '2.5', '4.0', '6.5'], { default: '4.0' }),
    table('checkpoints', 'Checkpoints', [text('parameter', 'Checkpoint / Parameter'), text('specification', 'Specification'), text('tolerance', 'Tolerance'), text('method', 'How to check')]),
    area('remarks', 'Remarks'),
  ],
};

/* ------------------------------ Rework & corrective action ------------------------------ */
export function reworkTotals(d = {}) {
  const passed = num(d.reinspPassedQty); const rejected = num(d.reinspRejectedQty);
  const scrap = num(d.scrapQty); const released = num(d.releasedQty);
  return {
    reworkLabourCost: round(num(d.reworkMinutes) * num(d.labourRatePerMin), 2),
    reworkCost: round(num(d.reworkMinutes) * num(d.labourRatePerMin) + num(d.materialCost) + num(d.reinspectionCost), 2),
    acceptedQty: passed + released,
    totalRejectedQty: rejected + scrap,
    pendingQty: Math.max(num(d.failedQty) - passed - rejected - scrap - released, 0),
    awaitingReinspectionQty: Math.max(num(d.reworkedQty) - num(d.reinspectedQty), 0),
  };
}

export const qcRework = {
  key: 'qcRework', model: 'QcRework', title: 'Rework & Corrective Action', singular: 'Quality Issue', group: 'Quality', icon: 'Wrench',
  department: 'Quality', prefix: 'QI', jobLinked: true, editReasonStatuses: ['Closed'],
  ...flow(['Open', 'On Hold', 'Assigned', 'In Rework', 'Reinspection', 'Closed'], { Open: ['Assigned'], Reinspection: ['In Rework'], 'On Hold': ['Closed'] }),
  defaultStatus: 'Open',
  fields: [
    ref('inspection', 'Failed Inspection', 'Inspection', { required: true, jobScoped: true, section: 'Failure', hint: 'The inspection whose rework / held quantity this issue resolves' }),
    calc('inspectionStage', 'Inspection Stage', { type: 'text', list: true }),
    date('issueDate', 'Issue Date', { required: true, list: true }),
    text('defectType', 'Defect', { list: true, suggest: 'Defect Type' }), sel('defectCategory', 'Defect Category', DEFECT_CATEGORIES, { filter: true }),
    text('defectCode', 'Defect Code'), sel('severity', 'Severity', SEVERITIES, { default: 'Major' }),
    n('failedQty', 'Failed / Held Qty', { required: true, list: true }),
    sel('assignedDept', 'Rework Assigned To', PRODUCTION_DEPARTMENTS, { list: true, filter: true, section: 'Rework' }),
    text('responsibleLine', 'Responsible Line'), text('responsibleTeam', 'Responsible Employee / Team'),
    date('reworkStartDate', 'Rework Start Date'), text('reworkStartTime', 'Start Time'),
    date('reworkEndDate', 'Rework Completion Date'), text('reworkEndTime', 'Completion Time'),
    n('reworkedQty', 'Reworked Qty'), n('scrapQty', 'Non-repairable / Scrapped'),
    n('reworkMinutes', 'Rework Labour (minutes)'), n('labourRatePerMin', 'Labour Cost / Minute'),
    n('materialCost', 'Additional Material Cost'), n('reinspectionCost', 'Reinspection Cost'),
    calc('reworkLabourCost', 'Rework Labour Cost'), calc('reworkCost', 'Rework Cost (in-house)', { list: true }),
    date('reinspectionDate', 'Reinspection Date', { section: 'Reinspection' }), text('reinspectedBy', 'Reinspected By'),
    n('reinspectedQty', 'Reinspected Qty'), n('reinspPassedQty', 'Passed on Reinspection'), n('reinspRejectedQty', 'Rejected on Reinspection'),
    calc('awaitingReinspectionQty', 'Reworked, Awaiting Reinspection'),
    n('releasedQty', 'Released without Rework (concession)', { section: 'Authorised release', hint: 'Needs Quality Release permission and a reason' }),
    text('releaseReason', 'Release Reason'), calc('releasedBy', 'Released By', { type: 'text' }),
    calc('acceptedQty', 'Accepted (reinspection pass + release)', { list: true }), calc('totalRejectedQty', 'Rejected + Scrapped'),
    calc('pendingQty', 'Still Pending', { list: true }),
    area('rootCause', 'Root Cause', { section: 'Corrective & preventive action' }), area('correctiveAction', 'Corrective Action'), area('preventiveAction', 'Preventive Action'),
    date('capaDueDate', 'CAPA Due Date', { list: true }), sel('capaStatus', 'CAPA Status', ['Open', 'In Progress', 'Implemented', 'Verified'], { default: 'Open', list: true, filter: true }),
    area('remarks', 'Remarks'),
  ],
  compute: (d) => reworkTotals(d),
};

/* ------------------------------ Attendance & labour ------------------------------ */
export const ATTENDANCE_STATUS = ['Present', 'Absent', 'Leave', 'Half Day', 'Weekly Off', 'Holiday'];
export function attendanceTotals(rows = []) {
  const out = (rows || []).map((r) => {
    const present = ['Present', 'Half Day'].includes(r.status);
    const hours = present ? num(r.hours) : 0;
    const ot = present ? num(r.otHours) : 0;
    const wageCost = round(hours * num(r.hourlyRate), 2);
    const otCost = round(ot * num(r.otRate), 2);
    const employerCost = round(((wageCost + otCost) * num(r.employerPct)) / 100, 2);
    return { ...r, hours: present ? r.hours : 0, otHours: present ? r.otHours : 0, wageCost, otCost, employerCost, totalCost: round(wageCost + otCost + employerCost + num(r.incentive), 2) };
  });
  const cnt = (s) => out.filter((r) => r.status === s).length;
  return {
    rows: out,
    headcount: out.length, presentCount: cnt('Present') + cnt('Half Day'), absentCount: cnt('Absent'), leaveCount: cnt('Leave'),
    totalHours: round(sum(out, (r) => (['Present', 'Half Day'].includes(r.status) ? num(r.hours) : 0)), 2),
    totalOtHours: round(sum(out, (r) => (['Present', 'Half Day'].includes(r.status) ? num(r.otHours) : 0)), 2),
    labourCost: round(sum(out, 'totalCost'), 2),
    absenteeismPct: out.length ? pct(cnt('Absent') + cnt('Leave'), out.filter((r) => !['Weekly Off', 'Holiday'].includes(r.status)).length || out.length, 1) : 0,
  };
}

export const attendance = {
  key: 'attendance', model: 'Attendance', title: 'Attendance & Labour', singular: 'Daily Attendance Sheet', group: 'HR', icon: 'CalendarCheck',
  department: 'HR', prefix: 'ATT', jobLinked: false, editReasonStatuses: ['Approved'],
  ...flow(['Submitted', 'Approved'], { Submitted: ['Rejected'], Rejected: ['Submitted'] }), defaultStatus: 'Submitted',
  fields: [
    date('attendanceDate', 'Date', { required: true, list: true, filter: true }),
    sel('shift', 'Shift', SHIFTS, { default: 'General', list: true }),
    sel('section', 'Department / Section', LABOUR_SECTIONS, { required: true, list: true, filter: true }),
    text('line', 'Line / Table', { list: true }),
    table('rows', 'Employees', [
      text('empCode', 'Emp Code'), calc('name', 'Name', { type: 'text' }), sel('status', 'Status', ATTENDANCE_STATUS, { default: 'Present' }),
      n('hours', 'Hours', { default: 8 }), n('otHours', 'Approved OT Hours'), n('incentive', 'Approved Incentive'),
      text('jobNo', 'Job No worked on', { hint: 'Main or sub job – direct allocation' }),
      calc('hourlyRate', 'Rate / hr'), calc('otRate', 'OT / hr'), calc('employerPct', 'Employer %'),
      calc('wageCost', 'Wages'), calc('otCost', 'OT'), calc('employerCost', 'Employer'), calc('totalCost', 'Cost'),
    ], { hint: 'Rates come from the employee master. Costs here are ESTIMATED; posted payroll is the actual cost.' }),
    calc('headcount', 'Headcount', { section: 'Totals' }), calc('presentCount', 'Present', { list: true }), calc('absentCount', 'Absent', { list: true }), calc('leaveCount', 'Leave'),
    calc('absenteeismPct', 'Absenteeism %'), calc('totalHours', 'Hours', { list: true }), calc('totalOtHours', 'OT Hours', { list: true }),
    calc('labourCost', 'Estimated Labour Cost', { list: true }),
    area('remarks', 'Remarks'),
  ],
  compute(d) {
    const t = attendanceTotals(d.rows);
    return t;
  },
};

/* ------------------------------ Payroll ------------------------------ */
export function payrollTotals(lines = []) {
  const out = (lines || []).map((l) => {
    const gross = round(num(l.basicWages) + num(l.otAmount) + num(l.incentive), 2);
    return { ...l, grossPay: gross, totalCost: round(gross + num(l.employerContribution), 2), netPay: round(gross - num(l.deductions), 2) };
  });
  return {
    lines: out, headcount: out.length,
    totalGross: round(sum(out, 'grossPay'), 2), totalEmployer: round(sum(out, 'employerContribution'), 2),
    totalDeductions: round(sum(out, 'deductions'), 2), totalNet: round(sum(out, 'netPay'), 2), totalCost: round(sum(out, 'totalCost'), 2),
  };
}

export const payroll = {
  key: 'payroll', model: 'Payroll', title: 'Payroll (Salaries & Wages)', singular: 'Payroll Run', group: 'HR', icon: 'Banknote',
  department: 'HR', prefix: 'PRL', jobLinked: false, editReasonStatuses: ['Approved', 'Paid'],
  ...flow(['Draft', 'Approved', 'Paid'], { Draft: ['Cancelled'] }), defaultStatus: 'Draft',
  fields: [
    text('period', 'Payroll Month (YYYY-MM)', { required: true, list: true, filter: true, hint: 'Leave the lines empty to build them from the month’s attendance' }),
    sel('payrollType', 'Payroll Type', ['Employees (salary & wages)', 'Contract labour'], { default: 'Employees (salary & wages)', list: true }),
    text('contractor', 'Labour Contractor (contract labour)'),
    date('paymentDate', 'Payment Date', { list: true }),
    table('lines', 'Payroll Lines', [
      text('empCode', 'Emp Code'), text('name', 'Name'), sel('section', 'Section', LABOUR_SECTIONS),
      n('daysWorked', 'Days'), n('hoursWorked', 'Hours'), n('otHours', 'OT Hours'),
      n('basicWages', 'Salary / Wages'), n('otAmount', 'OT Amount'), n('incentive', 'Incentive'),
      n('employerContribution', 'Employer Contributions'), n('deductions', 'Deductions'),
      calc('grossPay', 'Gross'), calc('netPay', 'Net Pay'), calc('totalCost', 'Cost to Company'),
    ]),
    calc('headcount', 'Employees', { section: 'Totals', list: true }), calc('totalGross', 'Gross Pay', { list: true }), calc('totalEmployer', 'Employer Contributions'),
    calc('totalDeductions', 'Deductions'), calc('totalNet', 'Net Pay'), calc('totalCost', 'Payroll Cost (actual)', { list: true }),
    area('remarks', 'Remarks'),
  ],
  compute: (d) => payrollTotals(d.lines),
};

/* ------------------------------ Factory expenses ------------------------------ */
export const FACTORY_EXPENSE_CATEGORIES = [
  'Electricity & Power', 'Water', 'Rent', 'Building Maintenance', 'Machinery Maintenance & Repairs', 'Fuel & Generator',
  'Transportation & Logistics', 'Canteen & Employee Welfare', 'Cleaning & Housekeeping', 'Security', 'Office & Administration',
  'Production Consumables', 'QC Materials & Testing', 'Outsourced Rework / Repair', 'Outsourced Inspection', 'Depreciation', 'Other Factory Overhead',
];
/** Quality-related factory expense categories (cost of quality). */
export const QUALITY_EXPENSE_CATEGORIES = ['QC Materials & Testing', 'Outsourced Rework / Repair', 'Outsourced Inspection'];

export const factoryExpense = {
  key: 'factoryExpense', model: 'FactoryExpense', title: 'Factory Expenses', singular: 'Factory Expense', group: 'Factory Costs', icon: 'Factory',
  department: 'Accounts & Finance', prefix: 'FEX', jobLinked: 'optional', editReasonStatuses: ['Approved'],
  ...flow(['Pending', 'Approved'], { Pending: ['Rejected'], Rejected: ['Pending'] }), defaultStatus: 'Pending',
  fields: [
    date('expenseDate', 'Date', { required: true, list: true, filter: true, section: 'Expense' }),
    sel('category', 'Expense Category', FACTORY_EXPENSE_CATEGORIES, { required: true, list: true, filter: true }),
    sel('department', 'Department', ['Common', ...LABOUR_SECTIONS], { default: 'Common', filter: true }),
    text('payee', 'Supplier / Payee', { required: true, list: true, search: true }),
    text('referenceNo', 'Bill / Reference No', { list: true, search: true }),
    text('description', 'Description', { search: true }),
    n('amount', 'Amount', { required: true, list: true }),
    sel('currency', 'Currency', CURRENCIES, { default: 'USD' }),
    sel('paymentStatus', 'Payment Status', ['Unpaid', 'Part paid', 'Paid'], { default: 'Unpaid', list: true, filter: true }),
    n('paidAmount', 'Paid Amount'), date('paymentDate', 'Payment Date'),
    text('documentRef', 'Supporting Document Ref'),
    bool('recurring', 'Recurring / monthly bill', { section: 'Recurring & sharing' }),
    text('period', 'Bill Period (YYYY-MM)', { hint: 'Required for recurring bills – one bill per payee, category and month' }),
    sel('sharing', 'Allocation', ['This unit only', 'Shared – Unit-1 & Unit-2'], { default: 'This unit only', list: true }),
    n('sharePctU1', 'Unit-1 Share % (shared bills)', { max: 100, default: 50 }),
    calc('shareU1', 'Unit-1 Amount'), calc('shareU2', 'Unit-2 Amount'),
    area('remarks', 'Remarks'),
  ],
  compute(d) {
    const shared = d.sharing === 'Shared – Unit-1 & Unit-2';
    const p1 = shared ? Math.min(Math.max(num(d.sharePctU1), 0), 100) : null;
    return {
      shareU1: shared ? round((num(d.amount) * p1) / 100, 2) : null,
      shareU2: shared ? round(num(d.amount) - round((num(d.amount) * p1) / 100, 2), 2) : null,
      paidAmount: d.paymentStatus === 'Paid' && !num(d.paidAmount) ? num(d.amount) : d.paidAmount,
    };
  },
};
