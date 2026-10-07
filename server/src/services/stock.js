/**
 * Stock engine for the knit fabric chain + trims.
 * Stock is derived from movements (never typed in), so every report always agrees with the documents:
 *   Yarn          = yarn inward              − yarn issued to knitting
 *   Grey fabric   = grey received (knitting) − grey issued to processing
 *   In-process    = output "In-process"      − issued again as "In-process" input
 *   Finished      = processing finished output + purchased/received in fabric store − issued to cutting
 *   Trims         = received − issued (trim bookings)
 */
import { models } from '../modules/builder.js';
import { num, round, pct } from '../../../shared/calc.js';

const key = (...parts) => parts.map((p) => String(p ?? '').trim().toLowerCase()).join('|');
const label = (v) => String(v ?? '').trim() || '—';
const r2 = (v) => round(v, 2);

function baseFilter(q = {}, dateField) {
  const f = { isDeleted: false, status: { $nin: ['Cancelled', 'Rejected'] } };
  if (q.job) f.$or = [{ jobNo: q.job }, { parentJobNo: q.job }];
  if (q.supplier) f.supplierName = new RegExp(String(q.supplier).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (dateField && (q.from || q.to)) {
    f[dateField] = {};
    if (q.from) f[dateField].$gte = new Date(q.from);
    if (q.to) { const t = new Date(q.to); t.setHours(23, 59, 59, 999); f[dateField].$lte = t; }
  }
  return f;
}

/** Group rows by a key function and fold values. */
function group(rows, keyFn, init, fold) {
  const map = new Map();
  rows.forEach((r) => {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, init(r));
    fold(map.get(k), r);
  });
  return [...map.values()];
}

/* ------------------------------ Yarn ------------------------------ */
export async function yarnStock(q) {
  const inward = await models.yarnReceipt.find(baseFilter(q, 'receiptDate')).lean();
  const issued = await models.knitting.find(baseFilter({ ...q, supplier: undefined }, 'programDate')).lean();
  const rows = group(
    [...inward.map((r) => ({ ...r, _t: 'in' })), ...issued.map((r) => ({ ...r, _t: 'out' }))],
    (r) => key(r.yarnCount, r.lotNo),
    (r) => ({ yarnCount: label(r.yarnCount), lotNo: label(r.lotNo), suppliers: new Set(), receivedKg: 0, issuedKg: 0, value: 0, rateKg: 0 }),
    (g, r) => {
      if (r._t === 'in') { g.receivedKg += num(r.qtyKg); g.value += num(r.amount); g.rateKg += num(r.qtyKg) * (num(r.ratePerKg) ? 1 : 0); if (r.supplierName) g.suppliers.add(r.supplierName); }
      else g.issuedKg += num(r.yarnIssuedKg);
    },
  ).map((g) => {
    const avgRate = g.rateKg ? g.value / g.rateKg : 0;
    const balance = g.receivedKg - g.issuedKg;
    return { yarnCount: g.yarnCount, lotNo: g.lotNo, company: [...g.suppliers].join(', ') || '—', receivedKg: r2(g.receivedKg), issuedKg: r2(g.issuedKg), balanceKg: r2(balance), avgRate: r2(avgRate), stockValue: r2(balance * avgRate) };
  });
  return {
    title: 'Yarn Stock (yarn-wise)',
    columns: [['yarnCount', 'Yarn Count / Type'], ['lotNo', 'Lot'], ['company', 'Supplier'], ['receivedKg', 'Received (kg)'], ['issuedKg', 'Issued to Knitting (kg)'], ['balanceKg', 'Balance (kg)'], ['avgRate', 'Avg Rate / kg'], ['stockValue', 'Stock Value']],
    rows: rows.sort((a, b) => a.yarnCount.localeCompare(b.yarnCount)),
    totals: ['receivedKg', 'issuedKg', 'balanceKg', 'stockValue'],
  };
}

/* ------------------------------ Knitting (company-wise) ------------------------------ */
export async function knittingReport(q) {
  const rows = await models.knitting.find(baseFilter(q, 'programDate')).lean();
  const out = group(rows, (r) => key(r.supplierName, r.fabricType),
    (r) => ({ company: label(r.supplierName), fabricType: label(r.fabricType), programs: 0, yarnIssuedKg: 0, greyReceivedKg: 0, rejectedKg: 0, lossKg: 0, pendingKg: 0, amount: 0 }),
    (g, r) => { g.programs += 1; g.yarnIssuedKg += num(r.yarnIssuedKg); g.greyReceivedKg += num(r.greyReceivedKg); g.rejectedKg += num(r.rejectedKg); g.lossKg += num(r.lossKg); g.pendingKg += num(r.pendingKg); g.amount += num(r.amount); })
    .map((g) => ({ ...Object.fromEntries(Object.entries(g).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])), lossPct: pct(g.lossKg, g.yarnIssuedKg), avgRate: g.greyReceivedKg ? r2(g.amount / g.greyReceivedKg) : 0 }));
  return {
    title: 'Knitting Report (company-wise)',
    columns: [['company', 'Knitting Company'], ['fabricType', 'Fabric'], ['programs', 'Programs'], ['yarnIssuedKg', 'Yarn Issued (kg)'], ['greyReceivedKg', 'Grey Received (kg)'], ['rejectedKg', 'Rejected (kg)'], ['lossKg', 'Loss (kg)'], ['lossPct', 'Loss %'], ['pendingKg', 'Pending (kg)'], ['avgRate', 'Rate / kg'], ['amount', 'Knitting Charges']],
    rows: out.sort((a, b) => a.company.localeCompare(b.company)),
    totals: ['programs', 'yarnIssuedKg', 'greyReceivedKg', 'rejectedKg', 'lossKg', 'pendingKg', 'amount'],
  };
}

/* ------------------------------ Grey fabric ------------------------------ */
export async function greyStock(q) {
  const knit = await models.knitting.find(baseFilter({ ...q, supplier: undefined }, 'programDate')).lean();
  const proc = await models.fabricProcess.find({ ...baseFilter({ ...q, supplier: undefined }, 'processDate'), inputStage: 'Grey Fabric' }).lean();
  const rows = group(
    [...knit.map((r) => ({ ...r, _t: 'in' })), ...proc.map((r) => ({ ...r, _t: 'out' }))],
    (r) => key(r.fabricType, r.gsm),
    (r) => ({ fabricType: label(r.fabricType), gsm: r.gsm || '—', knitters: new Set(), receivedKg: 0, issuedKg: 0, knitCost: 0 }),
    (g, r) => {
      if (r._t === 'in') { g.receivedKg += num(r.greyReceivedKg); g.knitCost += num(r.amount); if (r.supplierName) g.knitters.add(r.supplierName); }
      else g.issuedKg += num(r.issuedKg);
    },
  ).map((g) => ({ fabricType: g.fabricType, gsm: g.gsm, company: [...g.knitters].join(', ') || '—', receivedKg: r2(g.receivedKg), issuedKg: r2(g.issuedKg), balanceKg: r2(g.receivedKg - g.issuedKg), knitRate: g.receivedKg ? r2(g.knitCost / g.receivedKg) : 0 }));
  return {
    title: 'Grey Fabric Stock (grey-wise)',
    columns: [['fabricType', 'Fabric Type'], ['gsm', 'GSM'], ['company', 'Knitting Company'], ['receivedKg', 'Grey Received (kg)'], ['issuedKg', 'Issued to Processing (kg)'], ['balanceKg', 'Grey Balance (kg)'], ['knitRate', 'Knitting Rate / kg']],
    rows: rows.sort((a, b) => a.fabricType.localeCompare(b.fabricType)),
    totals: ['receivedKg', 'issuedKg', 'balanceKg'],
  };
}

/* ------------------------------ Processing (company & process-wise) ------------------------------ */
export async function processingReport(q) {
  const f = baseFilter(q, 'processDate');
  if (q.process) f.processType = q.process;
  const rows = await models.fabricProcess.find(f).lean();
  const out = group(rows, (r) => key(r.supplierName, r.processType),
    (r) => ({ company: label(r.supplierName), processType: r.processType, orders: 0, issuedKg: 0, receivedKg: 0, rejectedKg: 0, lossKg: 0, pendingKg: 0, amount: 0, basisKg: 0 }),
    (g, r) => {
      g.orders += 1; g.issuedKg += num(r.issuedKg); g.receivedKg += num(r.receivedKg); g.rejectedKg += num(r.rejectedKg);
      g.lossKg += num(r.lossKg); g.pendingKg += num(r.pendingKg); g.amount += num(r.amount);
      g.basisKg += r.chargeBasis === 'Received Kg' ? num(r.receivedKg) : num(r.issuedKg);
    })
    .map(({ basisKg, ...g }) => ({ ...Object.fromEntries(Object.entries(g).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])), lossPct: pct(g.lossKg, g.issuedKg), avgRate: basisKg ? r2(g.amount / basisKg) : 0 }));
  return {
    title: 'Processing Report (dyeing, compacting…)',
    columns: [['company', 'Processing Company'], ['processType', 'Process'], ['orders', 'Orders'], ['issuedKg', 'Issued (kg)'], ['receivedKg', 'Received (kg)'], ['rejectedKg', 'Rejected (kg)'], ['lossKg', 'Process Loss (kg)'], ['lossPct', 'Loss %'], ['pendingKg', 'Pending (kg)'], ['avgRate', 'Rate / kg'], ['amount', 'Process Charges']],
    rows: out.sort((a, b) => a.company.localeCompare(b.company) || a.processType.localeCompare(b.processType)),
    totals: ['orders', 'issuedKg', 'receivedKg', 'rejectedKg', 'lossKg', 'pendingKg', 'amount'],
  };
}

/* ------------------------------ In-process fabric ------------------------------ */
export async function inProcessStock(q) {
  const rows = await models.fabricProcess.find(baseFilter({ ...q, supplier: undefined }, 'processDate')).lean();
  const out = group(rows.filter((r) => r.outputStage === 'In-process Fabric' || r.inputStage === 'In-process Fabric'),
    (r) => key(r.fabricType, r.color),
    (r) => ({ fabricType: label(r.fabricType), color: label(r.color), producedKg: 0, issuedKg: 0, lastProcess: '' }),
    (g, r) => {
      if (r.outputStage === 'In-process Fabric') { g.producedKg += num(r.receivedKg); g.lastProcess = r.processType; }
      if (r.inputStage === 'In-process Fabric') g.issuedKg += num(r.issuedKg);
    })
    .map((g) => ({ ...g, producedKg: r2(g.producedKg), issuedKg: r2(g.issuedKg), balanceKg: r2(g.producedKg - g.issuedKg) }));
  return {
    title: 'In-process Fabric Stock (between processes)',
    columns: [['fabricType', 'Fabric Type'], ['color', 'Color'], ['lastProcess', 'Last Process'], ['producedKg', 'Received from Process (kg)'], ['issuedKg', 'Issued to Next Process (kg)'], ['balanceKg', 'Balance (kg)']],
    rows: out, totals: ['producedKg', 'issuedKg', 'balanceKg'],
  };
}

/* ------------------------------ Finished fabric ------------------------------ */
export async function finishedStock(q) {
  const proc = await models.fabricProcess.find({ ...baseFilter(q, 'processDate'), outputStage: 'Finished Fabric' }).lean();
  const store = await models.fabricBooking.find({ isDeleted: false, ...(q.job ? { $or: [{ jobNo: q.job }, { parentJobNo: q.job }] } : {}) }).lean();
  const out = group(
    [...proc.map((r) => ({ ...r, _t: 'proc' })), ...store.map((r) => ({ ...r, _t: 'store' }))],
    (r) => key(r.fabricType, r.color),
    (r) => ({ fabricType: label(r.fabricType), color: label(r.color), processors: new Set(), processedKg: 0, processCost: 0, storeReceivedKg: 0, issuedKg: 0, requiredKg: 0 }),
    (g, r) => {
      if (r._t === 'proc') { g.processedKg += num(r.receivedKg); g.processCost += num(r.amount); if (r.supplierName) g.processors.add(r.supplierName); }
      else { g.storeReceivedKg += num(r.receivedQty); g.issuedKg += num(r.issuedQty); g.requiredKg += num(r.requiredQty); }
    },
  ).map((g) => {
    const inward = Math.max(g.processedKg, g.storeReceivedKg); // processed fabric is what the store receives – avoid double counting
    return {
      fabricType: g.fabricType, color: g.color, company: [...g.processors].join(', ') || '—',
      requiredKg: r2(g.requiredKg), processedKg: r2(g.processedKg), storeReceivedKg: r2(g.storeReceivedKg),
      issuedKg: r2(g.issuedKg), balanceKg: r2(inward - g.issuedKg),
      processRate: g.processedKg ? r2(g.processCost / g.processedKg) : 0,
    };
  });
  return {
    title: 'Finished Fabric Stock',
    columns: [['fabricType', 'Fabric Type'], ['color', 'Color'], ['company', 'Processing Company'], ['requiredKg', 'Required (kg)'], ['processedKg', 'From Processing (kg)'], ['storeReceivedKg', 'Received in Store (kg)'], ['issuedKg', 'Issued to Cutting (kg)'], ['balanceKg', 'Balance (kg)'], ['processRate', 'Process Cost / kg']],
    rows: out.sort((a, b) => a.fabricType.localeCompare(b.fabricType)),
    totals: ['requiredKg', 'processedKg', 'storeReceivedKg', 'issuedKg', 'balanceKg'],
  };
}

/* ------------------------------ Trims ------------------------------ */
export async function trimStock(q) {
  const f = { isDeleted: false };
  if (q.job) f.$or = [{ jobNo: q.job }, { parentJobNo: q.job }];
  if (q.supplier) f.supplierName = baseFilter(q).supplierName;
  const rows = await models.trimBooking.find(f).lean();
  const out = group(rows, (r) => key(r.item, r.description, r.supplierName, r.unit),
    (r) => ({ item: r.item, description: label(r.description), company: label(r.supplierName), unit: r.unit || 'Pcs', bookingQty: 0, receivedQty: 0, issuedQty: 0, value: 0 }),
    (g, r) => { g.bookingQty += num(r.bookingQty); g.receivedQty += num(r.receivedQty); g.issuedQty += num(r.issuedQty); g.value += num(r.receivedQty) * num(r.rate); })
    .map((g) => ({ ...g, balanceQty: r2(g.receivedQty - g.issuedQty), pendingQty: r2(Math.max(g.bookingQty - g.receivedQty, 0)), rate: g.receivedQty ? round(g.value / g.receivedQty, 4) : 0, stockValue: r2(((g.receivedQty - g.issuedQty) * g.value) / (g.receivedQty || 1)) }));
  return {
    title: 'Trims Stock',
    columns: [['item', 'Item'], ['description', 'Description'], ['company', 'Supplier'], ['unit', 'Unit'], ['bookingQty', 'Booked'], ['receivedQty', 'Received'], ['issuedQty', 'Issued'], ['balanceQty', 'Balance'], ['pendingQty', 'Pending Receipt'], ['rate', 'Rate'], ['stockValue', 'Stock Value']],
    rows: out.sort((a, b) => a.item.localeCompare(b.item)),
    totals: ['bookingQty', 'receivedQty', 'issuedQty', 'balanceQty', 'pendingQty', 'stockValue'],
  };
}

export const STOCK_REPORTS = {
  yarn: yarnStock, knitting: knittingReport, grey: greyStock, processing: processingReport,
  inprocess: inProcessStock, finished: finishedStock, trims: trimStock,
};

/** Available balance helpers used by the issue guards. */
export async function yarnAvailable(yarnCount, lotNo, excludeId) {
  const k = key(yarnCount, lotNo || '');
  const inward = (await models.yarnReceipt.find({ isDeleted: false, status: { $ne: 'Rejected' } }).lean()).filter((r) => key(r.yarnCount, lotNo ? r.lotNo : '') === k);
  const out = (await models.knitting.find({ isDeleted: false, status: { $ne: 'Cancelled' }, _id: { $ne: excludeId } }).lean()).filter((r) => key(r.yarnCount, lotNo ? r.lotNo : '') === k);
  return r2(inward.reduce((s, r) => s + num(r.qtyKg), 0) - out.reduce((s, r) => s + num(r.yarnIssuedKg), 0));
}

export async function stageAvailable(stage, fabricType, color, excludeId) {
  const ft = key(fabricType);
  const procs = (await models.fabricProcess.find({ isDeleted: false, status: { $ne: 'Cancelled' }, _id: { $ne: excludeId } }).lean()).filter((r) => key(r.fabricType) === ft);
  if (stage === 'Grey Fabric') {
    const knit = (await models.knitting.find({ isDeleted: false, status: { $ne: 'Cancelled' } }).lean()).filter((r) => key(r.fabricType) === ft);
    return r2(knit.reduce((s, r) => s + num(r.greyReceivedKg), 0) - procs.filter((r) => r.inputStage === 'Grey Fabric').reduce((s, r) => s + num(r.issuedKg), 0));
  }
  const sameColor = (r) => !color || key(r.color) === key(color);
  return r2(procs.filter((r) => r.outputStage === 'In-process Fabric' && sameColor(r)).reduce((s, r) => s + num(r.receivedKg), 0)
    - procs.filter((r) => r.inputStage === 'In-process Fabric' && sameColor(r)).reduce((s, r) => s + num(r.issuedKg), 0));
}
