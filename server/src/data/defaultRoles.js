/** Default department roles. Admin can edit any of these from Roles & Permissions. */
const V = ['view'];
const VE = ['view', 'export', 'reports'];
const W = ['view', 'create', 'edit', 'export', 'reports'];
const WA = [...W, 'approve'];
const FULL = [...WA, 'delete', 'close'];

const base = { dashboard: V, jobs: V, reports: ['view', 'export'], documents: ['view', 'create'], buyer: V, supplier: V, master: V, orders: V };

// Pre-production chain (Spec → BOM → CAD/Pattern/Grading → Marker): everybody downstream can read it
const preView = { techSpec: V, bom: V, pattern: V, marker: V };
// department hourly production entry + rework they are assigned
const floor = { hourlyProduction: W, qcRework: ['view', 'edit'], productionRoute: V, factoryReports: V };

const merchandisingHO = {
  ...base, enquiry: FULL, costing: VE, quotation: FULL, buyerOrder: FULL, orders: WA, techSpec: FULL, bom: VE, pattern: V, marker: V, tna: VE, ppMeeting: VE, sample: WA,
  fabricBooking: V, trimBooking: V, productionPlan: V, inspection: V, shipment: V, invoice: V, buyer: W, documents: W,
};

export const DEFAULT_ROLES = [
  { name: 'Admin', department: 'Admin', isAdmin: true, isSystem: true, description: 'Complete access to everything', dashboard: 'admin', permissions: {} },
  { name: 'Head Office Merchandising', department: 'Head Office Merchandising', dashboard: 'merchandising', description: 'Buyer, quotation, order, approval & shipment overview', permissions: merchandisingHO },
  {
    name: 'Factory Merchandising', department: 'Factory Merchandising', dashboard: 'merchandising', description: 'Orders, T&A, PP meeting, trims, sampling, production follow-up',
    permissions: { ...base, enquiry: V, quotation: V, buyerOrder: V, orders: ['view', 'edit', 'export'], techSpec: WA, bom: FULL, pattern: V, marker: V, fabricForecast: VE, fabricTransfer: V, tna: WA, ppMeeting: WA, trimBooking: WA, sample: WA, fabricBooking: V, yarnReceipt: V, knitting: V, fabricProcess: V, stock: VE, productionPlan: V, cutting: V, sewing: V, finishing: V, packing: V, inspection: V, shipment: V, documents: W, hourlyProduction: V, qcRework: V, factoryReports: VE },
  },
  { name: 'Costing Factory', department: 'Costing Factory', dashboard: 'costing', description: 'Cost sheets, quotations, margins', permissions: { ...base, enquiry: V, costing: FULL, quotation: W, master: W, bom: V, marker: V } },
  { name: 'Fabric Department', department: 'Fabric Department', dashboard: 'fabric', description: 'Fabric booking, receipt, issue, balance & closure', permissions: { ...base, bom: V, marker: V, fabricForecast: FULL, fabricTransfer: FULL, fabricReceipt: FULL, fabricAllocation: FULL, fabricReturn: FULL, fabricDebit: FULL, supplierBill: V, fabricBooking: [...FULL], yarnReceipt: FULL, knitting: FULL, fabricProcess: FULL, stock: VE, supplier: W, cutting: V, tna: V } },
  {
    name: 'Accounts & Finance', department: 'Accounts & Finance', dashboard: 'accounts', description: 'Invoices, payments, expenses, profit',
    permissions: { ...base, jobs: ['view', 'approve'], bom: V, fabricForecast: V, fabricTransfer: V, fabricReturn: V, fabricDebit: ['view', 'edit', 'export', 'reports'], invoice: FULL, payment: FULL, expense: FULL, supplierBill: FULL, shipment: V, costing: V, fabricBooking: V, trimBooking: V, yarnReceipt: V, knitting: V, fabricProcess: V, stock: VE, profit: VE, documents: W, factoryExpense: FULL, payroll: ['view', 'edit', 'approve', 'export', 'reports'], attendance: V, employee: V, pnl: VE, factoryReports: VE },
  },
  { name: 'Data Entry', department: 'Data Entry', dashboard: 'production', description: 'Production data entry', permissions: { ...base, cutting: ['view', 'create', 'edit'], sewing: ['view', 'create', 'edit'], finishing: ['view', 'create', 'edit'], packing: ['view', 'create', 'edit'], hourlyProduction: ['view', 'create', 'edit'], attendance: ['view', 'create', 'edit'], inspection: V } },
  { name: 'HR', department: 'HR', dashboard: 'hr', description: 'Employees & attendance', permissions: { dashboard: V, employee: FULL, users: V, reports: ['view', 'export'], attendance: FULL, payroll: [...WA, 'delete'], factoryReports: V } },
  {
    name: 'Production', department: 'Production', dashboard: 'production', description: 'Plans, targets, output, efficiency',
    permissions: { ...base, ...preView, fabricForecast: V, fabricTransfer: V, fabricReceipt: V, fabricAllocation: V, stock: VE, productionPlan: FULL, cutting: WA, sewing: WA, finishing: WA, packing: V, tna: V, fabricBooking: V, trimBooking: V, inspection: V, employee: V, hourlyProduction: [...WA, 'delete'], productionRoute: FULL, qcRework: ['view', 'edit'], attendance: V, factoryReports: VE },
  },
  { name: 'Cutting', department: 'Cutting', dashboard: 'production', description: 'Cutting entries', permissions: { ...base, ...floor, cutting: WA, fabricBooking: V, fabricTransfer: V, fabricAllocation: V, fabricReceipt: V, fabricReturn: W, fabricDebit: V, productionPlan: V, pattern: V, marker: V } },
  { name: 'Sewing', department: 'Sewing', dashboard: 'production', description: 'Sewing line output', permissions: { ...base, ...floor, sewing: WA, cutting: V, productionPlan: V } },
  { name: 'Finishing', department: 'Finishing', dashboard: 'production', description: 'Finishing output', permissions: { ...base, ...floor, finishing: WA, sewing: V } },
  { name: 'Packing', department: 'Packing', dashboard: 'production', description: 'Packing lists', permissions: { ...base, ...floor, packing: WA, finishing: V, shipment: V } },
  { name: 'Quality', department: 'Quality', dashboard: 'quality', description: 'Inspection, defects, AQL', permissions: { ...base, techSpec: V, inspection: FULL, sewing: V, finishing: V, packing: V, sample: V, documents: W, qcRework: FULL, qcCheckpoint: FULL, qualityRelease: ['view', 'approve'], hourlyProduction: V, productionRoute: V, factoryReports: VE, shipment: V } },
  {
    name: 'Shipment / Documentation', department: 'Shipment / Documentation', dashboard: 'shipment', description: 'Shipments & buyer documents',
    permissions: { ...base, shipment: FULL, packing: V, inspection: V, invoice: ['view', 'create', 'edit', 'export'], documents: [...W, 'delete'] },
  },
  {
    name: 'CAD / Pattern', department: 'CAD / Pattern', dashboard: 'preproduction', description: 'CAD, pattern making, grading and markers',
    permissions: { ...base, techSpec: V, bom: V, pattern: FULL, marker: FULL, fabricBooking: V, cutting: V, sample: V, tna: V, documents: W },
  },
];
