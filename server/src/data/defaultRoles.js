/** Default department roles. Admin can edit any of these from Roles & Permissions. */
const V = ['view'];
const VE = ['view', 'export', 'reports'];
const W = ['view', 'create', 'edit', 'export', 'reports'];
const WA = [...W, 'approve'];
const FULL = [...WA, 'delete', 'close'];

const base = { dashboard: V, jobs: V, reports: ['view', 'export'], documents: ['view', 'create'], buyer: V, supplier: V, master: V, orders: V };

const merchandisingHO = {
  ...base, enquiry: FULL, costing: VE, quotation: FULL, orders: WA, tna: VE, ppMeeting: VE, sample: WA,
  fabricBooking: V, trimBooking: V, productionPlan: V, inspection: V, shipment: V, invoice: V, buyer: W, documents: W,
};

export const DEFAULT_ROLES = [
  { name: 'Admin', department: 'Admin', isAdmin: true, isSystem: true, description: 'Complete access to everything', dashboard: 'admin', permissions: {} },
  { name: 'Head Office Merchandising', department: 'Head Office Merchandising', dashboard: 'merchandising', description: 'Buyer, quotation, order, approval & shipment overview', permissions: merchandisingHO },
  {
    name: 'Factory Merchandising', department: 'Factory Merchandising', dashboard: 'merchandising', description: 'Orders, T&A, PP meeting, trims, sampling, production follow-up',
    permissions: { ...base, enquiry: V, quotation: V, orders: ['view', 'edit', 'export'], tna: WA, ppMeeting: WA, trimBooking: WA, sample: WA, fabricBooking: V, productionPlan: V, cutting: V, sewing: V, finishing: V, packing: V, inspection: V, shipment: V, documents: W },
  },
  { name: 'Costing Factory', department: 'Costing Factory', dashboard: 'costing', description: 'Cost sheets, quotations, margins', permissions: { ...base, enquiry: V, costing: FULL, quotation: W, master: W } },
  { name: 'Fabric Department', department: 'Fabric Department', dashboard: 'fabric', description: 'Fabric booking, receipt, issue, balance & closure', permissions: { ...base, fabricBooking: [...FULL], supplier: W, cutting: V, tna: V } },
  {
    name: 'Accounts & Finance', department: 'Accounts & Finance', dashboard: 'accounts', description: 'Invoices, payments, expenses, profit',
    permissions: { ...base, jobs: ['view', 'approve'], invoice: FULL, payment: FULL, expense: FULL, shipment: V, costing: V, fabricBooking: V, trimBooking: V, profit: VE, documents: W },
  },
  { name: 'Data Entry', department: 'Data Entry', dashboard: 'production', description: 'Production data entry', permissions: { ...base, cutting: ['view', 'create', 'edit'], sewing: ['view', 'create', 'edit'], finishing: ['view', 'create', 'edit'], packing: ['view', 'create', 'edit'] } },
  { name: 'HR', department: 'HR', dashboard: 'hr', description: 'Employees & attendance', permissions: { dashboard: V, employee: FULL, users: V, reports: ['view', 'export'] } },
  {
    name: 'Production', department: 'Production', dashboard: 'production', description: 'Plans, targets, output, efficiency',
    permissions: { ...base, productionPlan: FULL, cutting: WA, sewing: WA, finishing: WA, packing: V, tna: V, fabricBooking: V, trimBooking: V, inspection: V, employee: V },
  },
  { name: 'Cutting', department: 'Cutting', dashboard: 'production', description: 'Cutting entries', permissions: { ...base, cutting: WA, fabricBooking: V, productionPlan: V } },
  { name: 'Sewing', department: 'Sewing', dashboard: 'production', description: 'Sewing line output', permissions: { ...base, sewing: WA, cutting: V, productionPlan: V } },
  { name: 'Finishing', department: 'Finishing', dashboard: 'production', description: 'Finishing output', permissions: { ...base, finishing: WA, sewing: V } },
  { name: 'Packing', department: 'Packing', dashboard: 'production', description: 'Packing lists', permissions: { ...base, packing: WA, finishing: V, shipment: V } },
  { name: 'Quality', department: 'Quality', dashboard: 'quality', description: 'Inspection, defects, AQL', permissions: { ...base, inspection: FULL, sewing: V, finishing: V, packing: V, sample: V, documents: W } },
  {
    name: 'Shipment / Documentation', department: 'Shipment / Documentation', dashboard: 'shipment', description: 'Shipments & buyer documents',
    permissions: { ...base, shipment: FULL, packing: V, inspection: V, invoice: ['view', 'create', 'edit', 'export'], documents: [...W, 'delete'] },
  },
];
