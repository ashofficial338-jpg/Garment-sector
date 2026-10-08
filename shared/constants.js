/**
 * Shared constants used by both the API server and the React client.
 * Pure ESM, no dependencies.
 */

/** Standardised status vocabulary (status engine). */
export const STANDARD_STATUSES = [
  'Draft', 'Pending', 'In Progress', 'Submitted', 'Under Review', 'Approved',
  'Rejected', 'Delayed', 'Completed', 'Ready to Close', 'Closed', 'Cancelled',
];

/** Permission actions an admin can grant per module. */
export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'close', 'override', 'reports'];

/** Default departments (also used as role names for seeded roles). */
export const DEPARTMENTS = [
  'Admin', 'Fabric Department', 'Accounts & Finance', 'Costing Factory', 'Factory Merchandising',
  'Data Entry', 'Head Office Merchandising', 'HR', 'Production', 'Cutting', 'Sewing',
  'Finishing', 'Packing', 'Quality', 'Shipment / Documentation', 'CAD / Pattern',
];

/**
 * Business units – one ERP, separate operational data and job number series.
 * Admin can rename units and move a series forward in Settings → Units & job numbering.
 */
export const DEFAULT_UNITS = [
  { code: 'U1', name: 'Unit-1', prefix: 'U1', start: 1000 },
  { code: 'U2', name: 'Unit-2', prefix: 'U2', start: 3000 },
];

/** Units of measure */
export const UNITS = ['KG', 'Meter', 'Yard', 'Pcs', 'Dozen', 'Gross', 'Set', 'Roll', 'Cone', 'Carton'];
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'BDT', 'CNY', 'JPY', 'AUD', 'CAD'];

/**
 * Order lifecycle stages shown in the Job Control Tower.
 * `module` = registry key whose records drive the stage (null = derived).
 */
export const LIFECYCLE_STAGES = [
  { key: 'enquiry', label: 'Buyer Enquiry', module: 'enquiry', department: 'Head Office Merchandising' },
  { key: 'costing', label: 'Costing', module: 'costing', department: 'Costing Factory' },
  { key: 'quotation', label: 'Quotation', module: 'quotation', department: 'Head Office Merchandising' },
  { key: 'order', label: 'Order Confirmation', module: 'orders', department: 'Head Office Merchandising' },
  { key: 'spec', label: 'Specification', module: 'techSpec', department: 'Head Office Merchandising' },
  { key: 'bom', label: 'Bill of Materials', module: 'bom', department: 'Factory Merchandising' },
  { key: 'tna', label: 'T&A', module: 'tna', department: 'Factory Merchandising' },
  { key: 'ppMeeting', label: 'PP Meeting', module: 'ppMeeting', department: 'Factory Merchandising' },
  { key: 'cad', label: 'CAD', module: 'pattern', department: 'CAD / Pattern' },
  { key: 'pattern', label: 'Pattern', module: 'pattern', department: 'CAD / Pattern' },
  { key: 'grading', label: 'Grading', module: 'pattern', department: 'CAD / Pattern' },
  { key: 'marker', label: 'Marker', module: 'marker', department: 'CAD / Pattern' },
  { key: 'fabric', label: 'Fabric Booking', module: 'fabricBooking', department: 'Fabric Department' },
  { key: 'trims', label: 'Trim Booking', module: 'trimBooking', department: 'Factory Merchandising' },
  { key: 'sampling', label: 'Sampling', module: 'sample', department: 'Factory Merchandising' },
  { key: 'approval', label: 'Approval', module: 'sample', department: 'Head Office Merchandising' },
  { key: 'planning', label: 'Production Planning', module: 'productionPlan', department: 'Production' },
  { key: 'cutting', label: 'Cutting', module: 'cutting', department: 'Cutting' },
  { key: 'sewing', label: 'Sewing', module: 'sewing', department: 'Sewing' },
  { key: 'finishing', label: 'Finishing', module: 'finishing', department: 'Finishing' },
  { key: 'packing', label: 'Packing', module: 'packing', department: 'Packing' },
  { key: 'inspection', label: 'Final Inspection', module: 'inspection', department: 'Quality' },
  { key: 'shipment', label: 'Shipment', module: 'shipment', department: 'Shipment / Documentation' },
  { key: 'documentation', label: 'Buyer Documentation', module: 'documents', department: 'Shipment / Documentation' },
  { key: 'accounts', label: 'Accounts / Finance', module: 'invoice', department: 'Accounts & Finance' },
  { key: 'payment', label: 'Payment', module: 'payment', department: 'Accounts & Finance' },
  { key: 'profit', label: 'Profit Analysis', module: null, department: 'Accounts & Finance' },
  { key: 'closure', label: 'Job Closure', module: null, department: 'Admin' },
];

/** Stage states */
export const STAGE_STATE = { DONE: 'done', ACTIVE: 'active', DELAYED: 'delayed', PENDING: 'pending', NA: 'na' };

/** Document types for buyer documentation */
export const DOCUMENT_TYPES = [
  'Commercial Invoice', 'Packing List', 'Certificate of Origin', 'Inspection Certificate',
  'Test Report', 'Bill of Lading (BL)', 'Air Waybill (AWB)', 'Shipping Bill', 'Export Declaration',
  'Purchase Order', 'Tech Pack', 'Approval Comments', 'Lab Dip Approval', 'Other',
];

/** Documents that must exist before documentation stage counts as complete (default rule). */
export const REQUIRED_SHIPPING_DOCS = ['Commercial Invoice', 'Packing List'];

/** Modules that are not record registries but still need permissions. */
export const SYSTEM_PERMISSION_MODULES = [
  { key: 'dashboard', title: 'Dashboard' },
  { key: 'jobs', title: 'Job Control / Closure' },
  { key: 'documents', title: 'Documents' },
  { key: 'reports', title: 'Report Center' },
  { key: 'users', title: 'Users' },
  { key: 'roles', title: 'Roles & Permissions' },
  { key: 'settings', title: 'System Settings / Workflow' },
  { key: 'audit', title: 'Audit Trail' },
  { key: 'profit', title: 'Profit Analysis' },
  { key: 'stock', title: 'Stock Reports' },
  { key: 'analytics', title: 'Management Analytics (ROI, ITR, EBITDA, drill-down)' },
];
