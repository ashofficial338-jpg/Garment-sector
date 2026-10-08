/**
 * Garment calculation engine.
 * Pure functions shared by server (authoritative) and client (live preview).
 * All functions are defensive: missing inputs are treated as 0.
 */

export const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const round = (v, d = 2) => {
  const p = 10 ** d;
  return Math.round((num(v) + Number.EPSILON) * p) / p;
};
export const pct = (part, whole, d = 2) => (num(whole) ? round((num(part) / num(whole)) * 100, d) : 0);
export const sum = (arr, key) => (arr || []).reduce((t, r) => t + num(key ? (typeof key === 'function' ? key(r) : r?.[key]) : r), 0);

/* ------------------------------------------------------------------ */
/* Fabric                                                              */
/* ------------------------------------------------------------------ */

/**
 * Required fabric quantity.
 * Base = Order Qty × Consumption/pc. All loss percentages are applied additively on the base:
 * Required = Base × (1 + (wastage + cutting + shrinkage + relaxation + dyeing + process) / 100)
 * e.g. 10,000 pcs × 0.18 kg = 1,800 kg; 5 % wastage → 1,890 kg.
 */
export function fabricRequirement(i = {}) {
  const base = num(i.orderQty) * num(i.consumption);
  const lossPct = num(i.wastagePct) + num(i.cuttingWastagePct) + num(i.shrinkagePct)
    + num(i.relaxationPct) + num(i.dyeingLossPct) + num(i.processLossPct);
  const required = base * (1 + lossPct / 100);
  return { baseQty: round(base, 3), totalLossPct: round(lossPct, 3), lossQty: round(required - base, 3), requiredQty: round(required, 3) };
}

/** Marker based consumption: (marker length × width-factor) / pieces per marker. */
export function markerConsumption({ markerLength = 0, piecesPerMarker = 0 } = {}) {
  return num(piecesPerMarker) ? round(num(markerLength) / num(piecesPerMarker), 4) : 0;
}

/** Convert fabric meter ↔ kg using GSM and cuttable width (inches). */
export function metersToKg(meters, gsm, widthInch) {
  return round((num(meters) * num(widthInch) * 0.0254 * num(gsm)) / 1000, 3);
}
export function kgToMeters(kg, gsm, widthInch) {
  const d = num(widthInch) * 0.0254 * num(gsm);
  return d ? round((num(kg) * 1000) / d, 3) : 0;
}

/* ------------------------------------------------------------------ */
/* Pre-production: BOM, grading, marker                                */
/* ------------------------------------------------------------------ */

/** One BOM line: required qty for the order (incl. wastage) and its value. Fabric keeps decimals, trims round up. */
export function bomLine(l = {}, orderQty = 0) {
  const gross = num(orderQty) * num(l.consumptionPerPc) * (1 + num(l.wastagePct) / 100);
  const requiredQty = l.category === 'Fabric' ? round(gross, 3) : Math.ceil(gross - 1e-9);
  return {
    requiredQty,
    amount: round(requiredQty * num(l.rate), 2),
    costPerPc: round(num(l.consumptionPerPc) * (1 + num(l.wastagePct) / 100) * num(l.rate), 4),
  };
}

export function bomTotals(lines = [], orderQty = 0) {
  const rows = lines.map((l) => ({ ...l, ...bomLine(l, orderQty) }));
  const of = (cats) => rows.filter((r) => cats.includes(r.category));
  return {
    lines: rows,
    fabricCostPerPc: round(sum(of(['Fabric']), 'costPerPc'), 4),
    trimCostPerPc: round(sum(of(['Trim', 'Accessory', 'Packing']), 'costPerPc'), 4),
    materialCostPerPc: round(sum(rows, 'costPerPc'), 4),
    totalMaterialValue: round(sum(rows, 'amount'), 2),
    fabricLines: of(['Fabric']).length,
    trimLines: rows.length - of(['Fabric']).length,
  };
}

/** Graded measurement of one point of measure across sizes: base ± increment per size step from the base size. */
export function gradeRow(rule = {}, sizes = [], baseSize = '') {
  if (!sizes.length) return '';
  const baseIdx = Math.max(sizes.indexOf(baseSize), 0);
  return sizes.map((s, i) => `${s} ${round(num(rule.baseValue) + (i - baseIdx) * num(rule.gradeIncrement), 2)}`).join(' · ');
}

/**
 * Marker plan: garments per marker from the size ratio, planned cut qty from plies, and the
 * marker consumption per garment converted to the fabric unit (Meter / Yard / KG via GSM & width).
 */
export function markerPlan(d = {}) {
  const ratio = parseRatio(d.ratio);
  const garments = ratio.total;
  const lengthM = d.markerLengthUnit === 'Yard' ? num(d.markerLength) * 0.9144 : num(d.markerLength);
  const perMarker = d.unit === 'KG' ? metersToKg(lengthM, d.gsm, d.markerWidth) : d.unit === 'Yard' ? lengthM / 0.9144 : lengthM;
  const consumptionPerPc = garments ? round(perMarker / garments, 4) : 0;
  const plannedCutQty = garments * num(d.plannedPlies);
  const fabricRequired = round(perMarker * num(d.plannedPlies), 3);
  const bom = num(d.bomConsumption);
  return {
    garmentsPerMarker: garments,
    consumptionPerPc,
    plannedCutQty,
    fabricRequired,
    consumptionVariancePct: bom && consumptionPerPc ? round(((consumptionPerPc - bom) / bom) * 100, 2) : 0,
  };
}

/**
 * Fabric balance & closure readiness.
 * Returns booking/receipt/stock balances plus a closure verdict.
 */
export function fabricBalance(i = {}) {
  const required = num(i.requiredQty);
  const booked = num(i.bookedQty);
  const received = num(i.receivedQty);
  const inspected = num(i.inspectedQty);
  const approved = num(i.approvedQty);
  const issued = num(i.issuedQty);
  const used = num(i.usedQty);
  const out = {
    bookingBalance: round(Math.max(required - booked, 0), 3),
    pendingReceipt: round(Math.max(booked - received, 0), 3),
    balanceQty: round(received - issued, 3), // stock in store
    excessQty: round(Math.max(received - required, 0), 3),
    shortageQty: round(Math.max(required - received, 0), 3),
    rejectedQty: round(Math.max(inspected - approved, 0), 3),
    unusedIssued: round(Math.max(issued - used, 0), 3),
    receivedPct: pct(received, required),
    issuedPct: pct(issued, required),
  };
  const checks = [
    ['Required quantity booked', booked >= required && required > 0],
    ['Required quantity received', received >= required && required > 0],
    ['Inspection completed', inspected >= received && received > 0],
    ['Approved quantity covers requirement', approved >= required && required > 0],
    ['Issued / consumption completed', issued >= required || used >= required],
    ['No unresolved shortage', out.shortageQty <= 0],
  ];
  const blockers = checks.filter(([, ok]) => !ok).map(([l]) => l);
  out.closureChecks = checks.map(([label, ok]) => ({ label, ok }));
  out.readyToClose = blockers.length === 0;
  out.closureVerdict = out.readyToClose
    ? (out.balanceQty > 0 ? 'READY TO CLOSE / EXCESS BALANCE' : 'READY TO CLOSE')
    : 'OPEN';
  return out;
}

/* ------------------------------------------------------------------ */
/* Trims                                                               */
/* ------------------------------------------------------------------ */

/** Required = Order Qty × Qty/pc; Booking = ceil(Required × (1 + wastage%)). */
export function trimRequirement(i = {}) {
  const required = num(i.orderQty) * num(i.consumptionPerPc);
  const booking = Math.ceil(required * (1 + num(i.wastagePct) / 100) - 1e-9);
  const booked = num(i.bookedQty);
  const received = num(i.receivedQty);
  const issued = num(i.issuedQty);
  const used = num(i.usedQty);
  return {
    requiredQty: round(required, 3),
    bookingQty: booking,
    pendingReceipt: round(Math.max(booked - received, 0), 3),
    balanceQty: round(received - issued, 3),
    shortageQty: round(Math.max(booking - received, 0), 3),
    excessQty: round(Math.max(received - booking, 0), 3),
    unusedIssued: round(Math.max(issued - used, 0), 3),
    amount: round(booking * num(i.rate), 2),
    actualAmount: round(received * num(i.rate), 2),
  };
}

/* ------------------------------------------------------------------ */
/* Costing                                                             */
/* ------------------------------------------------------------------ */

export const COST_COMPONENTS = [
  ['dyeingCost', 'Dyeing'], ['printingCost', 'Printing'], ['embroideryCost', 'Embroidery'],
  ['trimCost', 'Trims'], ['accessoriesCost', 'Accessories'], ['washingCost', 'Washing'],
  ['cuttingCost', 'Cutting'], ['sewingCost', 'Sewing'], ['finishingCost', 'Finishing'],
  ['packingCost', 'Packing'], ['labourCost', 'Labour'], ['factoryOverhead', 'Factory Overhead'],
  ['inspectionCost', 'Inspection'], ['testingCost', 'Testing'], ['freightCost', 'Freight'],
  ['otherExpenses', 'Other Expenses'],
];

/**
 * Garment cost sheet (all component values are per piece).
 * CM  = cutting + sewing + finishing + labour + factory overhead
 * CMT = CM + trims + accessories
 * Subtotal = fabric + all components
 * Commission / finance / admin overhead are % on subtotal.
 * Selling (FOB) price = quoted price if provided, else total cost × (1 + margin%).
 */
export function costSheet(i = {}) {
  const fabricCost = round(num(i.fabricConsumption) * (1 + num(i.fabricWastagePct) / 100) * num(i.fabricRate), 4);
  const comp = COST_COMPONENTS.reduce((t, [k]) => t + num(i[k]), 0);
  const subtotal = fabricCost + comp;
  const commission = (subtotal * num(i.commissionPct)) / 100;
  const finance = (subtotal * num(i.financeCostPct)) / 100;
  const adminOh = (subtotal * num(i.adminOverheadPct)) / 100;
  const totalCostPerPc = subtotal + commission + finance + adminOh;
  const cm = num(i.cuttingCost) + num(i.sewingCost) + num(i.finishingCost) + num(i.labourCost) + num(i.factoryOverhead);
  const cmt = cm + num(i.trimCost) + num(i.accessoriesCost);
  const selling = num(i.quotedPrice) > 0 ? num(i.quotedPrice) : totalCostPerPc * (1 + num(i.profitMarginPct) / 100);
  const profitPerPc = selling - totalCostPerPc;
  const qty = num(i.orderQty);
  return {
    fabricCost: round(fabricCost, 4),
    commissionAmt: round(commission, 4),
    financeAmt: round(finance, 4),
    adminOverheadAmt: round(adminOh, 4),
    cmCost: round(cm, 4),
    cmtCost: round(cmt, 4),
    totalCostPerPc: round(totalCostPerPc, 4),
    costPerDozen: round(totalCostPerPc * 12, 2),
    sellingPrice: round(selling, 4),
    fobPrice: round(selling, 4),
    fobPerDozen: round(selling * 12, 2),
    profitPerPc: round(profitPerPc, 4),
    totalCost: round(totalCostPerPc * qty, 2),
    totalSales: round(selling * qty, 2),
    totalExpectedProfit: round(profitPerPc * qty, 2),
    profitPct: pct(profitPerPc, selling),
  };
}

/* ------------------------------------------------------------------ */
/* Production                                                          */
/* ------------------------------------------------------------------ */

/** Efficiency % = (Output × SAM) / (Operators × Working minutes) × 100 */
export function efficiency({ output = 0, sam = 0, operators = 0, workingMinutes = 0 } = {}) {
  const avail = num(operators) * num(workingMinutes);
  return avail ? round(((num(output) * num(sam)) / avail) * 100, 2) : 0;
}

/** Daily target at a target efficiency. */
export function dailyTarget({ operators = 0, workingMinutes = 480, sam = 0, targetEfficiencyPct = 60 } = {}) {
  return num(sam) ? Math.floor((num(operators) * num(workingMinutes) * num(targetEfficiencyPct)) / 100 / num(sam)) : 0;
}

/** Add working days (skipping Sundays). */
export function addWorkingDays(start, days) {
  if (!start) return null;
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  let left = Math.max(Math.ceil(num(days)) - 1, 0);
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

/** Defects per hundred units */
export const dhu = (defects, checked) => (num(checked) ? round((num(defects) / num(checked)) * 100, 2) : 0);

export const daysBetween = (a, b) => {
  if (!a || !b) return 0;
  const ms = new Date(b).setHours(0, 0, 0, 0) - new Date(a).setHours(0, 0, 0, 0);
  return Math.round(ms / 86400000);
};

/* ------------------------------------------------------------------ */
/* Packing                                                             */
/* ------------------------------------------------------------------ */

/** Parse a ratio string like "S:2, M:4, L:4" → { total, parts } */
export function parseRatio(str = '') {
  // "S:2", "XL=1" or "XXL x 3" – split on the LAST separator so sizes containing "X" are safe
  const parts = String(str || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean).map((p) => {
    const m = p.match(/^(.*?)\s*(?::|=|\s[x×]\s)\s*(\d+(?:\.\d+)?)\s*$/i);
    return m ? { size: m[1].trim(), qty: num(m[2]) } : { size: p, qty: 0 };
  });
  return { parts, total: sum(parts, 'qty') };
}

export function packingRow(r = {}) {
  const cartons = num(r.cartonTo) >= num(r.cartonFrom) && num(r.cartonFrom) > 0 ? num(r.cartonTo) - num(r.cartonFrom) + 1 : num(r.cartons);
  const ratio = parseRatio(r.ratio);
  const pcsPerCarton = num(r.pcsPerCarton) || ratio.total;
  return {
    cartons,
    pcsPerCarton,
    qty: cartons * pcsPerCarton,
    netWeight: round(cartons * num(r.netWtPerCarton), 2),
    grossWeight: round(cartons * num(r.grossWtPerCarton), 2),
    cbm: round((num(r.length) * num(r.width) * num(r.height) * cartons) / 1e6, 3),
  };
}

export function packingTotals(rows = []) {
  const calc = rows.map((r) => ({ ...r, ...packingRow(r) }));
  return {
    rows: calc,
    totalCartons: sum(calc, 'cartons'),
    totalQty: sum(calc, 'qty'),
    totalNetWeight: round(sum(calc, 'netWeight'), 2),
    totalGrossWeight: round(sum(calc, 'grossWeight'), 2),
    totalCbm: round(sum(calc, 'cbm'), 3),
  };
}

/* ------------------------------------------------------------------ */
/* Quality – AQL (ISO 2859-1 / ANSI Z1.4, General Inspection Level II, */
/* single sampling, normal inspection)                                 */
/* ------------------------------------------------------------------ */

const AQL_LOTS = [
  [8, 2], [15, 3], [25, 5], [50, 8], [90, 13], [150, 20], [280, 32], [500, 50], [1200, 80],
  [3200, 125], [10000, 200], [35000, 315], [150000, 500], [500000, 800], [Infinity, 1250],
];
const AQL_ACCEPT = {
  '1.0': { 2: 0, 3: 0, 5: 0, 8: 0, 13: 0, 20: 0, 32: 1, 50: 1, 80: 2, 125: 3, 200: 5, 315: 7, 500: 10, 800: 14, 1250: 21 },
  '1.5': { 2: 0, 3: 0, 5: 0, 8: 0, 13: 0, 20: 1, 32: 1, 50: 2, 80: 3, 125: 5, 200: 7, 315: 10, 500: 14, 800: 21, 1250: 21 },
  '2.5': { 2: 0, 3: 0, 5: 0, 8: 0, 13: 1, 20: 1, 32: 2, 50: 3, 80: 5, 125: 7, 200: 10, 315: 14, 500: 21, 800: 21, 1250: 21 },
  '4.0': { 2: 0, 3: 0, 5: 0, 8: 1, 13: 1, 20: 2, 32: 3, 50: 5, 80: 7, 125: 10, 200: 14, 315: 21, 500: 21, 800: 21, 1250: 21 },
  '6.5': { 2: 0, 3: 0, 5: 1, 8: 1, 13: 2, 20: 3, 32: 5, 50: 7, 80: 10, 125: 14, 200: 21, 315: 21, 500: 21, 800: 21, 1250: 21 },
};
export const AQL_LEVELS = Object.keys(AQL_ACCEPT);

export function aqlSampleSize(lotSize) {
  const n = num(lotSize);
  if (n <= 1) return n;
  return AQL_LOTS.find(([max]) => n <= max)[1];
}

export function aqlEvaluate(i = {}) {
  const sample = num(i.inspectionQty) || aqlSampleSize(i.lotSize);
  const sampleKey = AQL_LOTS.map(([, s]) => s).reduce((best, s) => (s <= sample ? s : best), 2);
  const majorAc = AQL_ACCEPT[i.majorAql || '2.5']?.[sampleKey] ?? 0;
  const minorAc = AQL_ACCEPT[i.minorAql || '4.0']?.[sampleKey] ?? 0;
  const critical = num(i.criticalDefects);
  const major = num(i.majorDefects);
  const minor = num(i.minorDefects);
  const pass = critical === 0 && major <= majorAc && minor <= minorAc;
  return {
    sampleSize: sample,
    majorAccept: majorAc,
    majorReject: majorAc + 1,
    minorAccept: minorAc,
    minorReject: minorAc + 1,
    totalDefects: critical + major + minor,
    defectRate: pct(critical + major + minor, sample),
    aqlResult: sample ? (pass ? 'Passed' : 'Failed') : '',
  };
}

/* ------------------------------------------------------------------ */
/* Profit                                                              */
/* ------------------------------------------------------------------ */

/**
 * Actual profit = Order value − fabric − trims − production − labour − overhead − freight − other
 */
export function profitAnalysis(i = {}) {
  const revenue = num(i.revenue);
  const costs = {
    fabric: num(i.fabricCost), trims: num(i.trimCost), production: num(i.productionCost),
    labour: num(i.labourCost), overhead: num(i.overheadCost), freight: num(i.freightCost), other: num(i.otherCost),
  };
  const totalExpenses = Object.values(costs).reduce((a, b) => a + b, 0);
  const actualProfit = revenue - totalExpenses;
  const expectedProfit = num(i.expectedProfit);
  const expectedCost = num(i.expectedCost);
  return {
    revenue: round(revenue),
    costs: Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, round(v)])),
    totalExpenses: round(totalExpenses),
    actualProfit: round(actualProfit),
    expectedProfit: round(expectedProfit),
    profitVariance: round(actualProfit - expectedProfit),
    costVariance: round(totalExpenses - expectedCost),
    profitPct: pct(actualProfit, revenue),
    expectedProfitPct: pct(expectedProfit, num(i.expectedRevenue)),
  };
}

/* ------------------------------------------------------------------ */
/* T&A                                                                 */
/* ------------------------------------------------------------------ */

/** Default T&A template. `pos` = relative position between order date (0) and shipment date (1). */
export const TNA_TEMPLATE = [
  ['Order Confirmation', 0, 'Head Office Merchandising'],
  ['Tech Spec Approval', 0.03, 'Head Office Merchandising'],
  ['BOM Approval', 0.05, 'Factory Merchandising'],
  ['PP Meeting', 0.06, 'Factory Merchandising'],
  ['Fabric Booking', 0.08, 'Fabric Department'],
  ['Trim Booking', 0.1, 'Factory Merchandising'],
  ['Lab Dip', 0.12, 'Fabric Department'],
  ['Strike-off', 0.15, 'Factory Merchandising'],
  ['Proto Sample', 0.18, 'Factory Merchandising'],
  ['Pattern Approval', 0.22, 'CAD / Pattern'],
  ['Fit Sample', 0.25, 'Factory Merchandising'],
  ['Fabric In-house', 0.4, 'Fabric Department'],
  ['Trim In-house', 0.42, 'Factory Merchandising'],
  ['Grading', 0.44, 'CAD / Pattern'],
  ['Size Set', 0.45, 'Factory Merchandising'],
  ['PP Sample', 0.5, 'Factory Merchandising'],
  ['Approval', 0.55, 'Head Office Merchandising'],
  ['Marker Ready', 0.58, 'CAD / Pattern'],
  ['Cutting Start', 0.6, 'Cutting'],
  ['Sewing Start', 0.65, 'Sewing'],
  ['Finishing Start', 0.8, 'Finishing'],
  ['Packing', 0.88, 'Packing'],
  ['Inspection', 0.95, 'Quality'],
  ['Shipment', 1, 'Shipment / Documentation'],
];

export function generateTna(orderDate, shipmentDate) {
  const start = new Date(orderDate || Date.now());
  const end = new Date(shipmentDate || start.getTime() + 90 * 86400000);
  const span = Math.max(end - start, 0);
  return TNA_TEMPLATE.map(([activity, pos, department]) => ({
    activity,
    department,
    plannedDate: new Date(start.getTime() + span * pos).toISOString().slice(0, 10),
    actualDate: null,
    responsible: '',
    progress: 'Not Started',
    remarks: '',
  }));
}

/** Evaluate a single T&A row → { delayDays, state: completed|inProgress|delayed|notStarted } */
export function tnaRowState(r = {}, today = new Date()) {
  if (r.actualDate) {
    const delay = Math.max(daysBetween(r.plannedDate, r.actualDate), 0);
    return { delayDays: delay, state: 'completed' };
  }
  const overdue = r.plannedDate ? daysBetween(r.plannedDate, today) : 0;
  if (overdue > 0) return { delayDays: overdue, state: 'delayed' };
  if (r.progress === 'In Progress') return { delayDays: 0, state: 'inProgress' };
  return { delayDays: 0, state: 'notStarted' };
}
