/**
 * Pre-production chain: Specification → BOM → CAD / Pattern → Grading → Marker.
 * Every record is linked to the Job No; job data is pulled in (no re-entry) and each
 * stage feeds the next one (spec measurements → grade rules, BOM → bookings, marker → cutting).
 */
import { text, area, n, calc, date, sel, ref, table, tags, flow } from './dsl.js';
import { UNITS } from '../constants.js';
import { bomTotals, gradeRow, markerPlan, num, round } from '../calc.js';

const midSize = (sizes = []) => (sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : undefined);
const jobLossPct = (job) => ['wastagePct', 'cuttingWastagePct', 'shrinkagePct', 'relaxationPct', 'dyeingLossPct', 'processLossPct']
  .reduce((t, k) => t + num(job[k]), 0);

/* ------------------------------ Specification ------------------------------ */
export const techSpec = {
  key: 'techSpec', model: 'TechSpec', title: 'Specifications', singular: 'Tech Specification', group: 'Pre-Production', icon: 'FileCog',
  department: 'Head Office Merchandising', prefix: 'SPC', jobLinked: true, stage: 'spec',
  ...flow(['Draft', 'Submitted', 'Approved'], { Submitted: ['Rejected'], Rejected: ['Revised'], Approved: ['Revised'], Revised: ['Submitted'] }),
  defaultStatus: 'Draft',
  fields: [
    n('revision', 'Revision No', { list: true, section: 'Specification', default: 1 }),
    date('specDate', 'Spec Date', { list: true }),
    text('garmentType', 'Garment Type', { list: true }),
    text('fit', 'Fit / Silhouette'),
    text('baseSize', 'Base Size', { list: true }),
    tags('sizes', 'Size Range'),
    area('description', 'Style Description'),
    text('fabricType', 'Fabric', { section: 'Fabric & Colours', search: true }),
    text('composition', 'Composition'), n('gsm', 'GSM'),
    tags('colors', 'Colours'),
    area('construction', 'Construction Details', { section: 'Construction' }),
    area('stitching', 'Stitch / Seam Details'),
    area('embellishment', 'Print / Embroidery / Wash'),
    area('labelling', 'Labelling Instructions'),
    area('packingInstructions', 'Packing Instructions'),
    table('measurements', 'Measurement Chart (base size, cm)', [
      text('pom', 'Point of Measure'), text('howToMeasure', 'How to Measure'),
      n('baseValue', 'Base'), n('gradeIncrement', 'Grade / Size'), n('tolerance', 'Tol ±'),
    ], { section: 'Measurements' }),
    calc('pomCount', 'POMs', { list: true }),
    date('buyerApprovalDate', 'Buyer Approval Date', { section: 'Approval', list: true }),
    area('buyerComments', 'Buyer Comments'),
  ],
  prefill: (job) => ({
    garmentType: job.garmentType, sizes: job.sizes, baseSize: midSize(job.sizes), colors: job.colors,
    fabricType: job.fabricType, composition: job.composition, gsm: job.gsm,
  }),
  compute: (d) => ({ pomCount: (d.measurements || []).filter((m) => m.pom).length }),
};

/* ------------------------------ Bill of Materials ------------------------------ */
export const BOM_CATEGORIES = ['Fabric', 'Trim', 'Accessory', 'Packing'];
export const bom = {
  key: 'bom', model: 'Bom', title: 'Bill of Materials', singular: 'BOM', group: 'Pre-Production', icon: 'ListTree',
  department: 'Factory Merchandising', prefix: 'BOM', jobLinked: true, stage: 'bom', onePerJob: true,
  ...flow(['Draft', 'Submitted', 'Approved'], { Submitted: ['Rejected'], Rejected: ['Draft'], Approved: ['Revised'], Revised: ['Submitted'] }),
  defaultStatus: 'Draft',
  fields: [
    n('revision', 'Revision No', { list: true, section: 'BOM', default: 1 }),
    n('orderQty', 'Order Qty (pcs)', { list: true }),
    table('lines', 'Material Lines', [
      sel('category', 'Category', BOM_CATEGORIES, { default: 'Trim' }), text('item', 'Item / Fabric'), text('description', 'Spec'),
      text('color', 'Color'), sel('unit', 'Unit', UNITS, { default: 'Pcs' }), n('consumptionPerPc', 'Cons / pc'),
      n('wastagePct', 'Wastage %'), n('rate', 'Rate'),
      calc('requiredQty', 'Required'), calc('amount', 'Value'), calc('bookingRef', 'Booking', { type: 'text' }),
    ], { section: 'Materials', hint: 'Approving the BOM creates a fabric / trim booking for every line that has none' }),
    calc('fabricCostPerPc', 'Fabric Cost / pc', { section: 'Cost (per piece)' }),
    calc('trimCostPerPc', 'Trims & Accessories / pc'),
    calc('materialCostPerPc', 'Material Cost / pc', { list: true }),
    calc('costedMaterialPerPc', 'Costed Material / pc (from Costing)'),
    calc('materialVariancePerPc', 'Variance vs Costing / pc', { list: true }),
    calc('totalMaterialValue', 'Total Material Value', { list: true }),
    area('remarks', 'Remarks'),
  ],
  prefill: (job) => ({
    orderQty: job.orderQty,
    lines: [
      ...(job.fabricType || num(job.consumption) ? [{
        category: 'Fabric', item: job.fabricType, description: [job.composition, job.gsm ? `${job.gsm} GSM` : ''].filter(Boolean).join(' · '),
        color: job.fabricColor, unit: job.consumptionUnit || 'KG', consumptionPerPc: job.consumption, wastagePct: round(jobLossPct(job), 3), rate: job.fabricRate,
      }] : []),
      ...(job.trims || []).map((t) => ({ category: 'Trim', item: t.item, description: t.description, unit: t.unit, consumptionPerPc: t.consumptionPerPc, wastagePct: t.wastagePct, rate: t.rate })),
    ],
  }),
  compute(d) {
    const t = bomTotals(d.lines || [], d.orderQty);
    const costed = num(d.costedMaterialPerPc);
    return {
      lines: t.lines.map(({ costPerPc, ...l }) => l),
      fabricCostPerPc: t.fabricCostPerPc, trimCostPerPc: t.trimCostPerPc, materialCostPerPc: t.materialCostPerPc,
      totalMaterialValue: t.totalMaterialValue,
      materialVariancePerPc: costed ? round(t.materialCostPerPc - costed, 4) : 0,
    };
  },
};

/* ------------------------------ CAD / Pattern / Grading ------------------------------ */
export const PATTERN_FLOW = ['CAD Drafting', 'Pattern Ready', 'Pattern Approved', 'Graded', 'Released'];
export const pattern = {
  key: 'pattern', model: 'Pattern', title: 'CAD, Pattern & Grading', singular: 'Pattern', group: 'Pre-Production', icon: 'DraftingCompass',
  department: 'CAD / Pattern', prefix: 'PAT', jobLinked: true, stage: 'pattern',
  ...flow(PATTERN_FLOW, { 'Pattern Ready': ['Rejected'], Rejected: ['CAD Drafting'], Released: ['Revised'], Revised: ['CAD Drafting'] }),
  defaultStatus: 'CAD Drafting',
  fields: [
    ref('techSpec', 'Specification', 'TechSpec', { section: 'CAD', jobScoped: true, hint: 'Blank = latest spec of the job. Its measurement chart becomes the grade rules.' }),
    text('patternNo', 'Pattern No', { required: true, list: true, search: true }),
    n('revision', 'Revision No', { default: 1 }),
    sel('patternType', 'Pattern Type', ['Proto', 'Fit', 'Size Set', 'Production'], { default: 'Production', list: true, filter: true }),
    sel('cadSystem', 'CAD System', ['Gerber AccuMark', 'Lectra Modaris', 'Optitex', 'Tukatech', 'Audaces', 'Manual'], { list: true }),
    text('cadFileName', 'CAD File / Ref', { search: true }),
    text('patternMaker', 'Pattern Maker', { list: true }),
    date('cadStartDate', 'CAD Start Date'),
    date('approvalDate', 'Pattern Approval Date', { list: true }),
    n('pieceCount', 'Pattern Pieces', { section: 'Pattern' }),
    n('seamAllowanceMm', 'Seam Allowance (mm)'),
    n('shrinkageLengthPct', 'Shrinkage Allowance Length %', { max: 100 }),
    n('shrinkageWidthPct', 'Shrinkage Allowance Width %', { max: 100 }),
    text('baseSize', 'Base Size'),
    tags('sizes', 'Sizes to Grade'),
    table('gradeRules', 'Grade Rules', [
      text('pom', 'Point of Measure'), n('baseValue', 'Base'), n('gradeIncrement', 'Grade / Size'), n('tolerance', 'Tol ±'),
      calc('graded', 'Graded Measurements', { type: 'text' }),
    ], { section: 'Grading' }),
    calc('gradedSizes', 'Graded Sizes', { list: true }),
    area('remarks', 'Remarks'),
  ],
  prefill: (job) => ({ sizes: job.sizes, baseSize: midSize(job.sizes), shrinkageLengthPct: job.shrinkagePct }),
  compute(d) {
    const sizes = d.sizes || [];
    const rules = (d.gradeRules || []).map((r) => ({ ...r, graded: gradeRow(r, sizes, d.baseSize) }));
    return { gradeRules: rules, gradedSizes: rules.length ? sizes.length : 0 };
  },
};

/* ------------------------------ Marker ------------------------------ */
export const marker = {
  key: 'marker', model: 'Marker', title: 'Markers', singular: 'Marker', group: 'Pre-Production', icon: 'Ruler',
  department: 'CAD / Pattern', prefix: 'MKR', jobLinked: true, stage: 'marker',
  ...flow(['Draft', 'Submitted', 'Approved', 'Issued to Cutting'], { Submitted: ['Rejected'], Rejected: ['Draft'] }),
  defaultStatus: 'Draft',
  fields: [
    ref('pattern', 'Pattern', 'Pattern', { section: 'Marker', jobScoped: true }),
    text('markerNo', 'Marker No', { required: true, list: true, search: true }),
    sel('markerType', 'Marker Type', ['Production', 'Sample', 'Test'], { default: 'Production' }),
    text('color', 'Color', { list: true }),
    text('fabricType', 'Fabric', { search: true }),
    sel('unit', 'Fabric Unit', ['KG', 'Meter', 'Yard'], { default: 'KG' }),
    n('gsm', 'GSM'),
    n('markerWidth', 'Cuttable Width (inch)'),
    text('ratio', 'Size Ratio (e.g. S:1, M:2, L:2)', { required: true, span: 2 }),
    n('markerLength', 'Marker Length', { required: true }),
    sel('markerLengthUnit', 'Length Unit', ['Meter', 'Yard'], { default: 'Meter' }),
    n('markerEfficiencyPct', 'Marker Efficiency %', { max: 100, list: true }),
    n('plannedPlies', 'Planned Plies'),
    calc('garmentsPerMarker', 'Garments / Marker', { section: 'Consumption' }),
    calc('consumptionPerPc', 'Marker Consumption / pc', { list: true }),
    calc('bomConsumption', 'BOM Consumption / pc'),
    calc('consumptionVariancePct', 'Variance vs BOM %', { list: true }),
    calc('plannedCutQty', 'Planned Cut Qty'),
    calc('fabricRequired', 'Fabric for Planned Plies'),
    area('remarks', 'Remarks'),
  ],
  prefill: (job) => ({
    fabricType: job.fabricType, unit: job.consumptionUnit || 'KG', gsm: job.gsm, markerWidth: job.width,
    color: job.fabricColor, bomConsumption: job.consumption,
  }),
  compute: (d) => markerPlan(d),
};

/** BOM main fabric line consumption for a fabric type (used by markers). */
export function bomConsumptionFor(bomDoc, fabricType) {
  const fab = (bomDoc?.lines || []).filter((l) => l.category === 'Fabric');
  const hit = fab.find((l) => fabricType && String(l.item || '').toLowerCase() === String(fabricType).toLowerCase()) || fab[0];
  return hit ? num(hit.consumptionPerPc) : 0;
}

export const materialPerPcFromCosting = (c) => (c ? round(num(c.fabricCost) + num(c.trimCost) + num(c.accessoriesCost), 4) : 0);
