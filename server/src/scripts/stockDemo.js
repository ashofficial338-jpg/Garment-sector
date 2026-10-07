/**
 * Demo data for the fabric stock chain (yarn → knitting → processing → finished fabric).
 * Used by seedDemo.js (new databases) and seedStock.js (databases that already have demo jobs).
 */
import { models } from '../modules/builder.js';
import { MODULES, applyCompute } from '../../../shared/modules/index.js';
import { nextRefNo } from '../services/numbering.js';

const DAY = 86400000;
const d = (offset) => new Date(new Date().setHours(0, 0, 0, 0) + offset * DAY);

export async function seedStockDemo(req) {
  if (await models.yarnReceipt.exists({})) return false;

  const add = async (key, data, job) => {
    const def = MODULES[key];
    const body = applyCompute(def, { status: def.defaultStatus, ...data });
    return models[key].create({
      ...body,
      ...(job ? { job: job._id, jobNo: job.jobNo, parentJob: job.parentJob, parentJobNo: job.parentJobNo, buyerName: job.buyerName, styleNo: job.styleNo, poNo: job.poNo } : {}),
      supplierName: data.supplierName,
      refNo: await nextRefNo(def.prefix), createdBy: req.user._id, createdByName: req.user.name,
      statusHistory: [{ to: body.status, by: req.user._id, byName: req.user.name }],
    });
  };

  // Companies
  const companies = {};
  for (const [name, supplierType] of [
    ['Sri Ramakrishna Spinning Mills', 'Yarn'], ['KPR Mill Ltd', 'Yarn'],
    ['Tirupur Knit Fab', 'Knitting'], ['Sree Annapoorna Knitters', 'Knitting'],
    ['Royal Dyeing & Processing', 'Fabric Processing'], ['Vetri Compacting Works', 'Fabric Processing'],
  ]) {
    companies[name] = (await models.supplier.findOne({ name, isDeleted: false })) || await add('supplier', { name, supplierType, code: name.split(' ').map((w) => w[0]).join('').slice(0, 4), country: 'India', city: 'Tiruppur', leadTimeDays: 10, rating: 4, status: 'Active', supplierName: undefined });
  }
  const sup = (name) => ({ supplier: companies[name]._id, supplierName: name });
  const job = async (no) => models.orders.findOne({ jobNo: no, isDeleted: false }).lean();
  const j3 = await job('GAR-2026-00003');
  const j4 = await job('GAR-2026-00004');
  const j6f1 = await job('GAR-2026-00006-F01');

  // Yarn inward
  const yarn = [
    ['Sri Ramakrishna Spinning Mills', '30s Combed Cotton', 'L-3011', 4200, 262, -40],
    ['Sri Ramakrishna Spinning Mills', '30s Combed Cotton', 'L-3027', 2600, 265, -22],
    ['KPR Mill Ltd', '24s Combed Cotton', 'K-2408', 3800, 248, -35],
    ['KPR Mill Ltd', '20s Cotton/Poly 60:40', 'K-2015', 2500, 214, -18],
    ['Sri Ramakrishna Spinning Mills', '40s Modal', 'M-4002', 1200, 410, -12],
  ];
  for (const [co, count, lot, kg, rate, day] of yarn) {
    await add('yarnReceipt', { ...sup(co), receiptDate: d(day), yarnCount: count, composition: count.replace(/^\d+s /, ''), lotNo: lot, bags: Math.round(kg / 50), qtyKg: kg, ratePerKg: rate, invoiceNo: `INV/${lot}`, status: 'Approved' });
  }

  // Knitting programs (yarn issued → grey received)
  const knits = [
    [j3, 'Tirupur Knit Fab', '24s Combed Cotton', 'K-2408', 'Fleece', 300, 3600, 3510, 0, 16, 'Completed', -30],
    [j6f1, 'Sree Annapoorna Knitters', '30s Combed Cotton', 'L-3011', 'Single Jersey', 150, 2200, 2152, 6, 14, 'Completed', -25],
    [j6f1, 'Tirupur Knit Fab', '30s Combed Cotton', 'L-3027', 'Single Jersey', 150, 1800, 1100, 0, 14, 'In Knitting', -8],
    [j4, 'Sree Annapoorna Knitters', '40s Modal', 'M-4002', 'Modal Jersey', 150, 900, 640, 0, 22, 'In Knitting', -10],
    [null, 'Tirupur Knit Fab', '20s Cotton/Poly 60:40', 'K-2015', 'Pique', 220, 1500, 1462, 0, 18, 'Completed', -15],
  ];
  for (const [jb, co, count, lot, fabric, gsm, issued, grey, rej, rate, status, day] of knits) {
    await add('knitting', { ...sup(co), programDate: d(day), yarnCount: count, lotNo: lot, fabricType: fabric, gsm, dia: 72, gauge: '24G', yarnIssuedKg: issued, greyReceivedKg: grey, rejectedKg: rej, allowedLossPct: 3, ratePerKg: rate, status }, jb);
  }

  // Processing: dyeing (grey → in-process) then compacting (in-process → finished), and direct finished
  const procs = [
    [j3, 'Royal Dyeing & Processing', 'Dyeing', 'Grey Fabric', 'In-process Fabric', 'Fleece', 'Navy', 3500, 3240, 0, 95, 'Completed', -24],
    [j3, 'Vetri Compacting Works', 'Open Width Compacting', 'In-process Fabric', 'Finished Fabric', 'Fleece', 'Navy', 3240, 3180, 0, 9, 'Completed', -18],
    [j6f1, 'Royal Dyeing & Processing', 'Dyeing', 'Grey Fabric', 'In-process Fabric', 'Single Jersey', 'Navy', 2100, 1950, 0, 88, 'Received', -16],
    [j6f1, 'Vetri Compacting Works', 'Tubular Compacting', 'In-process Fabric', 'Finished Fabric', 'Single Jersey', 'Navy', 1200, 0, 0, 8, 'In Process', -4],
    [null, 'Royal Dyeing & Processing', 'Dyeing', 'Grey Fabric', 'Finished Fabric', 'Pique', 'White', 1400, 960, 0, 72, 'In Process', -6],
  ];
  for (const [jb, co, process, input, output, fabric, color, issued, received, rej, rate, status, day] of procs) {
    await add('fabricProcess', { ...sup(co), processDate: d(day), processType: process, inputStage: input, outputStage: output, fabricType: fabric, color, gsm: fabric === 'Fleece' ? 300 : fabric === 'Pique' ? 220 : 150, dia: 72, batchNo: `B-${Math.abs(day)}${color[0]}`, issuedKg: issued, receivedKg: received, rejectedKg: rej, allowedLossPct: process === 'Dyeing' ? 8 : 2, ratePerKg: rate, chargeBasis: 'Issued Kg', status }, jb);
  }
  return true;
}
