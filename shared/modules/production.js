import { text, area, n, calc, date, sel, table, flow } from './dsl.js';
import { parseRatio, efficiency, dhu, packingTotals, aqlEvaluate, aqlSampleSize, AQL_LEVELS, num, round, pct, sum } from '../calc.js';

const entryFlow = flow(['Submitted', 'Approved'], { Submitted: ['Rejected'], Rejected: ['Submitted'] });

/* ------------------------------ Cutting ------------------------------ */
export const cutting = {
  key: 'cutting', model: 'Cutting', title: 'Cutting', singular: 'Cutting Entry', group: 'Production', icon: 'Scissors',
  department: 'Cutting', prefix: 'CUT', jobLinked: true, stage: 'cutting', qtyField: 'cutQty',
  ...entryFlow, defaultStatus: 'Submitted',
  fields: [
    date('entryDate', 'Cutting Date', { required: true, list: true, section: 'Lay / Marker' }),
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
    sel('process', 'Process', ['Thread Trimming', 'Ironing', 'Washing', 'Checking', 'Folding', 'Tagging', 'All']),
    text('color', 'Color'),
    n('inputQty', 'Input Qty', { required: true, list: true }),
    n('passedQty', 'Passed Qty', { list: true }),
    n('alteration', 'Alteration'), n('rework', 'Rework'), n('rejection', 'Rejection', { list: true }),
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
    area('remarks', 'Remarks'),
  ],
  compute(d) {
    const t = packingTotals(d.rows || []);
    return { ...t, rows: t.rows };
  },
};

/* ------------------------------ Final Inspection ------------------------------ */
export const inspection = {
  key: 'inspection', model: 'Inspection', title: 'Final Inspection', singular: 'Inspection', group: 'Quality', icon: 'ShieldCheck',
  department: 'Quality', prefix: 'QC', jobLinked: true, stage: 'inspection',
  ...flow(['Pending', 'Inspection', 'Passed', 'Final Approved'], { Inspection: ['Failed'], Failed: ['Re-inspection'], 'Re-inspection': ['Passed', 'Failed'] }),
  defaultStatus: 'Pending',
  fields: [
    date('inspectionDate', 'Inspection Date', { required: true, list: true }),
    sel('inspectionType', 'Type', ['Inline', 'Mid-line', 'Pre-final', 'Final', 'Re-inspection'], { default: 'Final', list: true }),
    text('inspector', 'Inspector', { list: true }), text('inspectionAgency', 'Agency / Buyer QA'),
    n('lotSize', 'Lot Size (pcs)', { required: true }),
    sel('majorAql', 'Major AQL', AQL_LEVELS, { default: '2.5' }), sel('minorAql', 'Minor AQL', AQL_LEVELS, { default: '4.0' }),
    n('inspectionQty', 'Inspection Qty (blank = AQL sample)'),
    calc('sampleSize', 'AQL Sample Size'),
    n('criticalDefects', 'Critical Defects', { section: 'Defects' }), n('majorDefects', 'Major Defects'), n('minorDefects', 'Minor Defects'),
    calc('majorAccept', 'Major Ac'), calc('minorAccept', 'Minor Ac'),
    calc('totalDefects', 'Total Defects', { list: true }), calc('defectRate', 'Defect %'),
    n('passQty', 'Pass Qty'), n('failQty', 'Fail Qty'),
    calc('aqlResult', 'AQL Result', { type: 'text', list: true }),
    area('remarks', 'Remarks'),
  ],
  prefill: (job) => ({ lotSize: job.orderQty, sampleSize: aqlSampleSize(job.orderQty) }),
  compute: (d) => aqlEvaluate(d),
};
