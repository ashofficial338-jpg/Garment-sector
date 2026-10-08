/**
 * Garment cost heads – one mapping used by job profit, COGS, cost variance, inventory valuation and EBITDA.
 *
 *  costing   – cost-sheet components (per piece) that form the ESTIMATED cost of the head
 *  expense   – Job Expense categories booked against the head (ACTUAL cost)
 *  bucket    – the 7 summary buckets shown on Profit / Job 360 (unchanged); the costed standard is used
 *              for a whole bucket only when no actual cost at all is booked in it (never overstate profit)
 *  cogs      – part of cost of goods sold (freight and commercial costs are operating expenses)
 *  stage     – production stage at which the cost is incurred (for WIP valuation)
 */
export const COST_HEADS = [
  { key: 'fabric', label: 'Fabric', bucket: 'fabric', cogs: true, stage: 'material', costing: ['fabricCost'], expense: ['Fabric'] },
  { key: 'trims', label: 'Trims / Accessories', bucket: 'trims', cogs: true, stage: 'material', costing: ['trimCost', 'accessoriesCost'], expense: ['Trims', 'Accessories'] },
  { key: 'cadPattern', label: 'CAD / Pattern', bucket: 'production', cogs: true, stage: 'cut', costing: [], expense: ['CAD / Pattern'] },
  { key: 'cutting', label: 'Cutting', bucket: 'production', cogs: true, stage: 'cut', costing: ['cuttingCost'], expense: ['Cutting'] },
  { key: 'sewing', label: 'Sewing / CMT', bucket: 'production', cogs: true, stage: 'sew', costing: ['sewingCost'], expense: ['Sewing / CMT', 'Production'] },
  { key: 'finishing', label: 'Finishing', bucket: 'production', cogs: true, stage: 'finish', costing: ['finishingCost'], expense: ['Finishing'] },
  { key: 'washing', label: 'Washing / Dyeing', bucket: 'production', cogs: true, stage: 'finish', costing: ['washingCost', 'dyeingCost'], expense: ['Washing', 'Dyeing'] },
  { key: 'printing', label: 'Printing / Embroidery', bucket: 'production', cogs: true, stage: 'sew', costing: ['printingCost', 'embroideryCost'], expense: ['Printing', 'Embroidery'] },
  { key: 'packing', label: 'Packing', bucket: 'production', cogs: true, stage: 'finish', costing: ['packingCost'], expense: ['Packing'] },
  { key: 'quality', label: 'Quality / Inspection', bucket: 'other', cogs: true, stage: 'finish', costing: ['inspectionCost', 'testingCost'], expense: ['Inspection', 'Testing'] },
  { key: 'labour', label: 'Labour', bucket: 'labour', cogs: true, stage: 'sew', costing: ['labourCost'], expense: ['Labour'] },
  { key: 'overhead', label: 'Factory Overhead', bucket: 'overhead', cogs: true, stage: 'finish', costing: ['factoryOverhead'], expense: ['Overhead'] },
  { key: 'other', label: 'Other Costs', bucket: 'other', cogs: true, stage: 'finish', costing: ['otherExpenses'], expense: ['Other'] },
  { key: 'freight', label: 'Freight / Logistics', bucket: 'freight', cogs: false, stage: 'ship', costing: ['freightCost'], expense: ['Freight'] },
  { key: 'commercial', label: 'Commission / Finance / Admin', bucket: 'overhead', cogs: false, stage: 'ship', costing: ['commissionAmt', 'financeAmt', 'adminOverheadAmt'], expense: ['Commission', 'Admin Expense', 'Finance Charges'] },
];

/** Company-level finance lines below operating profit (EBITDA add-backs). */
export const FINANCE_LINES = [
  { key: 'interest', label: 'Interest', expense: ['Interest'] },
  { key: 'taxes', label: 'Taxes', expense: ['Tax'] },
  { key: 'depreciation', label: 'Depreciation', expense: ['Depreciation'] },
  { key: 'amortization', label: 'Amortization', expense: ['Amortization'] },
];

/** Summary buckets (existing Profit / Job 360 layout). */
export const COST_BUCKETS = ['fabric', 'trims', 'production', 'labour', 'overhead', 'freight', 'other'];

/** Every expense category, in display order (job-linked or company-level). */
export const EXPENSE_CATEGORIES = [...new Set([...COST_HEADS.flatMap((h) => h.expense), ...FINANCE_LINES.flatMap((l) => l.expense)])];

export const headOfExpense = (category) => COST_HEADS.find((h) => h.expense.includes(category));
export const financeLineOf = (category) => FINANCE_LINES.find((l) => l.expense.includes(category));

/** Trim booking items by inventory category (for inventory valuation and turnover). */
const PACKING_ITEMS = ['Polybag', 'Carton', 'Tissue Paper', 'Hanger', 'Sticker'];
const ACCESSORY_ITEMS = ['Button', 'Zipper', 'Elastic', 'Drawcord', 'Interlining', 'Tape', 'Rib'];
export const trimInventoryCategory = (item) => (PACKING_ITEMS.includes(item) ? 'Packing Materials' : ACCESSORY_ITEMS.includes(item) ? 'Accessories' : 'Trims');

export const INVENTORY_CATEGORIES = ['Yarn & Grey Fabric', 'Fabric', 'Trims', 'Accessories', 'Packing Materials', 'Work-in-Progress', 'Finished Goods'];
