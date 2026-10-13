import { text, area, n, calc, date, sel, ref, table, flow } from './dsl.js';
import { parseRatio, efficiency, dhu, packingTotals, aqlEvaluate, aqlSampleSize, AQL_LEVELS, num, round, pct, sum } from '../calc.js';
import { QC_STAGE_KEYS, INSPECTION_METHODS, PRODUCTION_DEPARTMENTS, DEFECT_CATEGORIES } from './factory.js';

/** Standard garment defect list for defect entry (also kept as a Defect Type master list). */
export const DEFECT_TYPES = ['Broken stitch', 'Skip stitch', 'Open seam', 'Uneven stitch', 'Puckering', 'Uneven hem', 'Stain / spot', 'Shade variation', 'Hole / fabric damage', 'Measurement out of tolerance', 'Wrong / missing label', 'Loose thread', 'Pressing / crease', 'Print / embroidery defect', 'Damaged component', 'Ironing defect (shine / burn)', 'Packing error', 'Fabric fault (slub / yarn)', 'Other'];
/** Default category of each standard defect (more Defect Type master values can be added freely). */
export const DEFECT_CATEGORY_OF = {
  'Broken stitch': 'Stitching', 'Skip stitch': 'Stitching', 'Open seam': 'Stitching', 'Uneven stitch': 'Stitching', Puckering: 'Stitching', 'Uneven hem': 'Stitching', 'Loose thread': 'Stitching',
  'Stain / spot': 'Fabric', 'Shade variation': 'Fabric', 'Hole / fabric damage': 'Fabric', 'Fabric fault (slub / yarn)': 'Fabric',
  'Measurement out of tolerance': 'Measurement', 'Damaged component': 'Component',
  'Pressing / crease': 'Finishing / Ironing', 'Ironing defect (shine / burn)': 'Finishing / Ironing',
  'Wrong / missing label': 'Packing & Labelling', 'Packing error': 'Packing & Labelling', 'Print / embroidery defect': 'Print / Embroidery',
};

const entryFlow = flow(['Submitted', 'Approved'], { Submitted: ['Rejected'], Rejected: ['Submitted'] });

/* ------------------------------ Cutting ------------------------------ */
export const cutting = {
  key: 'cutting', model: 'Cutting', title: 'Cutting', singular: 'Cutting Entry', group: 'Production', icon: 'Scissors',
  department: 'Cutting', prefix: 'CUT', jobLinked: true, stage: 'cutting', qtyField: 'cutQty',
  ...entryFlow, defaultStatus: 'Submitted',
  fields: [
    date('entryDate', 'Cutting Date', { required: true, list: true, section: 'Lay / Marker' }),
    ref('marker', 'Marker', 'Marker', { jobScoped: true, hint: 'An approved marker fills marker no, length, width, efficiency and ratio' }),
    text('layNo', 'Lay No', { list: true }), text('markerNo', 'Marker No'),
    n('markerLength', 'Marker Length'), n('markerWidth', 'Marker Width (inch)'), n('markerEfficiencyPct', 'Marker Efficiency %', { max: 100 }),
    text('color', 'Color', { list: true, filter: true }),
    text('ratio', 'Size Ratio (e.g. S:1, M:2, L:2)', { span: 2 }),
    n('plies', 'Plies'),
    calc('piecesPerPly', 'Garments / Ply'),
    n('manualCutQty', 'Cut Qty (if no ratio)'),
    calc('cutQty', 'Cutting Qty (pcs)', { list: true }),
    n('panelQty', 'Panel Qty', { section: 'Output' }), n('bundleQty', 'Bundle Qty'),
    n('recutQty', 'Recut Qty'), n('rejectQty', 'Reject Qty'),
    n('fabricIssued', 'Fabric Issued', { section: 'Fabric' }), n('fabricUsed', 'Fabric Used'),
    calc('fabricBalance', 'Fabric Balance'), calc('wastagePct', 'Cutting Wastage %', { list: true }),
    calc('consumptionActual', 'Actual Consumption / pc'),
    area('remarks', 'Remarks'),
  ],
  compute(d) {
    const r = parseRatio(d.ratio);
    const cutQty = r.total ? r.total * num(d.plies) : num(d.manualCutQty);
    return {
      piecesPerPly: r.total, cutQty,
      fabricBalance: round(num(d.fabricIssued) - num(d.fabricUsed), 3),
      wastagePct: pct(Math.max(num(d.fabricIssued) - num(d.fabricUsed), 0), d.fabricIssued),
      consumptionActual: cutQty ? round(num(d.fabricUsed) / cutQty, 4) : 0,
    };
  },
};

/* ------------------------------ Sewing ------------------------------ */
export const sewing = {
  key: 'sewing', model: 'Sewing', title: 'Sewing', singular: 'Sewing Entry', group: 'Production', icon: 'Spline',
  department: 'Sewing', prefix: 'SEW', jobLinked: true, stage: 'sewing', qtyField: 'actualQty',
  ...entryFlow, defaultStatus: 'Submitted',
  fields: [
    date('entryDate', 'Date', { required: true, list: true, section: 'Line' }),
    text('floor', 'Floor', { filter: true }), text('line', 'Line', { required: true, list: true, filter: true }),
    text('supervisor', 'Supervisor'), n('operators', 'Operators', { list: true }), n('helpers', 'Helpers'),
    n('sam', 'SAM (min)'), n('workingMinutes', 'Working Minutes', { default: 480 }),
    n('inputQty', 'Line Input (pcs)', { section: 'Production' }),
    n('targetQty', 'Day Target', { list: true }),
    table('hourly', 'Hourly Production', [text('hour', 'Hour'), n('target', 'Target'), n('output', 'Output')]),
    table('operatorOutput', 'Operator Production', [text('empCode', 'Emp Code'), text('operatorName', 'Operator'), text('operation', 'Operation'), n('smv', 'SMV'), n('pieces', 'Pieces'), calc('effPct', 'Eff %')]),
    n('manualOutput', 'Output (if no hourly)'),
    calc('actualQty', 'Actual Output', { list: true }),
    calc('variance', 'Target Variance'),
    calc('efficiencyPct', 'Efficiency %', { list: true }),
    n('checkedQty', 'Checked Qty', { section: 'Quality' }), n('defects', 'Defects Found'),
    n('alteration', 'Alteration'), n('rejection', 'Rejection'),
    calc('dhu', 'DHU %', { list: true }),
    calc('lineWip', 'Line WIP (input − output)'),
    area('remarks', 'Remarks'),
  ],
  compute(d) {
    const hourly = sum(d.hourly, 'output');
    const actual = hourly || num(d.manualOutput);
    return {
      actualQty: actual,
      operatorOutput: (d.operatorOutput || []).map((o) => ({ ...o, effPct: pct(num(o.pieces) * num(o.smv), d.workingMinutes || 480, 1) })),
      variance: actual - num(d.targetQty),
      efficiencyPct: efficiency({ output: actual, sam: d.sam, operators: d.operators, workingMinutes: d.workingMinutes }),
      dhu: dhu(d.defects, d.checkedQty || actual),
      lineWip: Math.max(num(d.inputQty) - actual, 0),
    };
  },
};

/* ------------------------------ Finishing ------------------------------ */
export const finishing = {
  key: 'finishing', model: 'Finishing', title: 'Finishing', singular: 'Finishing Entry', group: 'Production', icon: 'Sparkles',
  department: 'Finishing', prefix: 'FIN', jobLinked: true, stage: 'finishing', qtyField: 'passedQty',
  ...entryFlow, defaultStatus: 'Submitted',
  fields: [
    date('entryDate', 'Date', { required: true, list: true }),
    sel('process', 'Process', ['Thread Trimming', 'Washing / Processing', 'Ironing', 'Checking', 'Needle Detection', 'Folding', 'Tagging', 'Final Finishing', 'Finishing Inspection', 'All']),
    text('color', 'Color'),
    n('inputQty', 'Input Qty', { required: true, list: true }),
    n('passedQty', 'Passed Qty', { list: true }),
    n('alteration', 'Alteration'), n('rework', 'Rework'), n('rejection', 'Rejection', { list: true }),
    n('ironedQty', 'Ironed / Pressed', { section: 'Ironing & needle detection' }),
    n('needleCheckedQty', 'Passed through Needle Detector', { hint: 'When pieces go through the detector, only cleared pieces can pass' }),
    n('needleFailQty', 'Metal / Needle Detected (pulled out)', { hint: 'Pulled pieces are rejected or sent for rework' }),
    calc('outputQty', 'Output Qty'), calc('pendingQty', 'Pending Qty', { list: true }), calc('passRatePct', 'Pass Rate %'),
    area('remarks', 'Remarks'),
  ],
  compute: (d) => ({
    outputQty: num(d.passedQty) + num(d.rejection),
    pendingQty: Math.max(num(d.inputQty) - num(d.passedQty) - num(d.rejection), 0),
    passRatePct: pct(d.passedQty, d.inputQty),
  }),
};

/* ------------------------------ Packing ------------------------------ */
export const packing = {
  key: 'packing', model: 'Packing', title: 'Packing', singular: 'Packing List', group: 'Production', icon: 'PackageCheck',
  department: 'Packing', prefix: 'PKG', jobLinked: true, stage: 'packing', qtyField: 'totalQty', pdf: 'packingList',
  ...flow(['Draft', 'Packed', 'Verified']), defaultStatus: 'Draft',
  fields: [
    date('packingDate', 'Packing Date', { required: true, list: true }),
    n('plannedQty', 'Planned Pack Qty (packing plan)'), n('plannedCartons', 'Planned Cartons'),
    sel('packingMethod', 'Packing Method', ['Solid Color Solid Size', 'Solid Color Assorted Size', 'Assorted Color Assorted Size']),
    table('rows', 'Carton Details', [
      text('color', 'Color'), text('ratio', 'Size Ratio'), n('cartonFrom', 'Ctn From'), n('cartonTo', 'Ctn To'),
      n('pcsPerCarton', 'Pcs/Ctn'), n('netWtPerCarton', 'N.W/Ctn'), n('grossWtPerCarton', 'G.W/Ctn'),
      n('length', 'L cm'), n('width', 'W cm'), n('height', 'H cm'),
      calc('cartons', 'Ctns'), calc('qty', 'Qty'), calc('cbm', 'CBM'),
    ]),
    calc('totalCartons', 'Total Cartons', { list: true }), calc('totalQty', 'Total Qty', { list: true }),
    calc('totalNetWeight', 'Net Weight (kg)'), calc('totalGrossWeight', 'Gross Weight (kg)', { list: true }),
    calc('totalCbm', 'CBM', { list: true }),
    calc('balanceToPack', 'Balance to Pack (vs plan)'),
    text('warehouse', 'Finished Goods Warehouse', { section: 'Finished goods inward' }), text('location', 'FG Location / Rack', { list: true }),
    text('barcodeRange', 'Carton Barcode / SSCC Range'),
    area('remarks', 'Remarks'),
  ],
  prefill: (job) => ({ plannedQty: job.orderQty }),
  compute(d) {
    const t = packingTotals(d.rows || []);
    return { ...t, rows: t.rows, balanceToPack: num(d.plannedQty) ? Math.max(num(d.plannedQty) - t.totalQty, 0) : 0 };
  },
};

/* ------------------------------ Quality inspections ------------------------------ */
/**
 * Every QC inspection: stage, lot and disposition. The lot (pieces submitted) is split into
 * passed + rework (repairable) + rejected (non-repairable) + held (decision pending) – these must add up to the lot.
 * Reworked and held pieces only count as accepted after a Rework & Corrective Action record passes them on reinspection
 * (or an authorised release).
 */
export const inspection = {
  key: 'inspection', model: 'Inspection', title: 'QC Inspections', singular: 'Inspection', group: 'Quality', icon: 'ShieldCheck',
  department: 'Quality', prefix: 'QC', jobLinked: true, stage: 'inspection', editReasonStatuses: ['Passed', 'Final Approved', 'Failed'],
  ...flow(['Pending', 'Inspection', 'Passed', 'Final Approved'], { Inspection: ['Failed'], Failed: ['Re-inspection'], 'Re-inspection': ['Passed', 'Failed'] }),
  defaultStatus: 'Pending',
  fields: [
    date('inspectionDate', 'Inspection Date', { required: true, list: true, section: 'Inspection' }),
    text('inspectionTime', 'Time'),
    sel('inspectionStage', 'Inspection Stage', QC_STAGE_KEYS, { list: true, filter: true, hint: 'Checkpoints configured for this stage, buyer and style are loaded automatically' }),
    sel('inspectionType', 'Type', ['Inline', 'End-line', 'Mid-line', 'Pre-final', 'Final', 'Re-inspection', 'Stage'], { default: 'Final', list: true }),
    sel('inspectionMethod', 'Inspection Method', INSPECTION_METHODS),
    sel('department', 'Inspected at Department', PRODUCTION_DEPARTMENTS, { filter: true }),
    text('line', 'Line / Table', { filter: true }),
    text('color', 'Colour'), text('size', 'Size'), text('bundleNo', 'Batch / Bundle No'),
    text('inspector', 'Inspector', { list: true, filter: true }), text('inspectionAgency', 'Agency / Buyer QA'),
    n('lotSize', 'Lot Qty Submitted (pcs)', { required: true, list: true }),
    sel('majorAql', 'Major AQL', AQL_LEVELS, { default: '2.5' }), sel('minorAql', 'Minor AQL', AQL_LEVELS, { default: '4.0' }),
    n('inspectionQty', 'Sample / Qty Inspected (blank = AQL sample)'),
    calc('sampleSize', 'AQL Sample Size'),
    table('checklist', 'Checkpoints', [text('parameter', 'Checkpoint'), text('specification', 'Specification'), text('tolerance', 'Tolerance'), sel('result', 'Result', ['Pass', 'Fail', 'N/A']), text('remark', 'Remark')], { section: 'Checkpoints' }),
    table('defectLines', 'Defect Entry', [
      text('defectType', 'Defect', { suggest: 'Defect Type' }), sel('defectCategory', 'Category', DEFECT_CATEGORIES), text('defectCode', 'Code'),
      sel('severity', 'Severity', ['Critical', 'Major', 'Minor'], { default: 'Minor' }), text('location', 'Operation / Location'),
      sel('responsibleDept', 'Responsible Dept', PRODUCTION_DEPARTMENTS), text('responsibleLine', 'Line / Team'), n('count', 'Count'),
    ], { section: 'Defects', hint: 'When defects are entered here, the critical / major / minor totals are calculated from them' }),
    n('criticalDefects', 'Critical Defects'), n('majorDefects', 'Major Defects'), n('minorDefects', 'Minor Defects'),
    calc('majorAccept', 'Major Ac'), calc('minorAccept', 'Minor Ac'),
    calc('totalDefects', 'Total Defects', { list: true }), calc('defectRate', 'Defect %'),
    calc('aqlResult', 'AQL Result', { type: 'text', list: true }),
    n('passQty', 'Passed', { section: 'Lot disposition', hint: 'Passed + rework + rejected + held = lot. Left blank, a passed lot is fully passed and a failed lot fully held.' }),
    n('reworkQty', 'Rework (repairable)'), n('rejectQty', 'Rejected (non-repairable)'), n('heldQty', 'Held (decision pending)'),
    calc('failQty', 'Failed (rework + rejected)', { list: true }),
    calc('unaccountedQty', 'Not dispositioned'),
    calc('firstPassYieldPct', 'First Pass Yield %', { list: true }),
    sel('responsibleDept', 'Responsible Production Department', PRODUCTION_DEPARTMENTS, { section: 'Follow-up' }),
    area('correctiveAction', 'Corrective Action'),
    text('documentRef', 'Photo / Document Reference'),
    date('reinspectionDue', 'Reinspection Due'),
    area('remarks', 'Remarks'),
  ],
  prefill: (job) => ({ lotSize: job.orderQty, sampleSize: aqlSampleSize(job.orderQty) }),
  compute(d) {
    const lines = (d.defectLines || []).filter((l) => num(l.count) > 0);
    const sev = (s) => sum(lines.filter((l) => l.severity === s), 'count');
    const totals = lines.length ? { criticalDefects: sev('Critical'), majorDefects: sev('Major'), minorDefects: sev('Minor') } : {};
    const disp = ['passQty', 'reworkQty', 'rejectQty', 'heldQty'];
    const given = disp.some((k) => d[k] !== null && d[k] !== undefined && d[k] !== '');
    return {
      ...totals, ...aqlEvaluate({ ...d, ...totals }),
      failQty: num(d.reworkQty) + num(d.rejectQty),
      unaccountedQty: given ? num(d.lotSize) - disp.reduce((t, k) => t + num(d[k]), 0) : null,
      firstPassYieldPct: given && num(d.lotSize) ? pct(d.passQty, d.lotSize) : null,
    };
  },
};
