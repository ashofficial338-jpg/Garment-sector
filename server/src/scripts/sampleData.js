/**
 * Sample data tool – replaces old sample / test TRANSACTIONS with a fresh, realistic, fully connected
 * two-unit dataset, then validates it. Every record it creates is flagged `isSampleData` (shown as
 * "Sample / Test data" in the UI), so a later run removes exactly those records and nothing else.
 *
 *   node src/scripts/sampleData.js            dry run: classifies what is there and what would be removed
 *   node src/scripts/sampleData.js --apply    backup → remove sample transactions → build dataset → validate
 *   … --apply --include-unflagged             also remove transactions WITHOUT the sample flag – only after the
 *                                             dry run confirmed they are old sample / test data (e.g. from a
 *                                             version of this tool that did not flag its records)
 *
 * Never touched: users, sessions, roles & permissions, settings, buyers, suppliers, master data, employees,
 * the audit trail, and (without --include-unflagged) any unflagged transaction. Before removing anything,
 * all transactions are written to server/backups/*.json.
 *
 * The dataset is built through the real API (in-process, as the Admin user), so every hook, calculation,
 * stock-ledger posting, T&A update, audit entry, unit scope and closure rule is exercised exactly as in use.
 */
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';
import { connectDb } from '../config/db.js';
import { createApp } from '../app.js';
import { bootstrap } from '../services/bootstrap.js';
import { models } from '../modules/builder.js';
import { MODULE_LIST } from '../../../shared/modules/index.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { Counter } from '../models/Counter.js';
import { Notification } from '../models/Notification.js';
import { DocumentFile } from '../models/Document.js';
import { StockMovement } from '../models/StockMovement.js';
import { Setting } from '../models/Setting.js';
import { loadJobGraphs, computeProfit, computeStages } from '../services/lifecycle.js';
import { num, sum, round } from '../../../shared/calc.js';
import { TRACKING_LISTS } from '../../../shared/tracking.js';
import { RETURN_TO_STORE, RETURN_TO_SUPPLIER, ADJUST_SHORT, ADJUST_EXCESS } from '../../../shared/modules/planning.js';
import { fabricStockChain, ensureWorkforce, configureQuality, flowProduction, flowPackingList, preShipment, attendanceSheets, payrolls, factoryExpenses, negativeTests } from './sampleFactory.js';

const APPLY = process.argv.includes('--apply');
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(...a);

/* ============================== 1. Inspect & classify ============================== */
const KEEP_MODULES = MODULE_LIST.filter((d) => d.sharedAcrossUnits || d.key === 'employee').map((d) => d.key); // buyers, suppliers, master data, employees
const TX_MODULES = MODULE_LIST.filter((d) => !KEEP_MODULES.includes(d.key)).map((d) => d.key);
const TX_EXTRA = { notifications: Notification, documentfiles: DocumentFile, stockmovements: StockMovement };

const INCLUDE_UNFLAGGED = process.argv.includes('--include-unflagged');
const SAMPLE = { isSampleData: true };
const UNFLAGGED = { isSampleData: { $ne: true } };

async function inspect() {
  const counts = {}; const flagged = {}; const unflagged = {};
  for (const k of TX_MODULES) {
    counts[k] = await models[k].countDocuments();
    flagged[k] = await models[k].countDocuments(SAMPLE);
    unflagged[k] = counts[k] - flagged[k];
  }
  for (const [k, M] of Object.entries(TX_EXTRA)) counts[k] = await M.countDocuments();
  const keep = {
    users: await User.countDocuments(), roles: await Role.countDocuments(), settings: await Setting.countDocuments(),
    ...Object.fromEntries(await Promise.all(KEEP_MODULES.map(async (k) => [k, await models[k].countDocuments()]))),
  };
  const jobs = await models.orders.find().select('jobNo businessUnit buyerName styleNo status createdByName createdAt isSampleData').lean();
  return { counts, flagged, unflagged, keep, jobs };
}

/* ============================== 2. Backup & clean ============================== */
async function backupAndClean() {
  const dir = path.resolve(here, '../../backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `transactions-before-sample-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const dump = {};
  for (const k of TX_MODULES) dump[k] = await models[k].find().lean();
  for (const [k, M] of Object.entries(TX_EXTRA)) dump[k] = await M.find().lean();
  dump.counters = await Counter.find().lean();
  fs.writeFileSync(file, JSON.stringify(dump));
  log(`Backup written: ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);

  // only confirmed sample / test data: flagged records (plus unflagged ones when explicitly included)
  const which = INCLUDE_UNFLAGGED ? {} : SAMPLE;
  const jobs = dump.orders.filter((j) => INCLUDE_UNFLAGGED || j.isSampleData);
  const jobIds = jobs.map((j) => j._id); const jobNos = jobs.map((j) => j.jobNo);
  const removedDocs = INCLUDE_UNFLAGGED ? dump.documentfiles : dump.documentfiles.filter((d) => jobNos.includes(d.jobNo));
  for (const k of TX_MODULES) await models[k].deleteMany(which);
  // notifications, documents and stock-ledger lines belong to the removed jobs
  for (const M of Object.values(TX_EXTRA)) await M.deleteMany(INCLUDE_UNFLAGGED ? {} : { $or: [{ job: { $in: jobIds } }, { jobNo: { $in: jobNos } }] });
  // GridFS files that belonged to removed documents
  const fileIds = removedDocs.flatMap((d) => (d.versions || []).map((v) => v.fileName)).filter((id) => mongoose.isValidObjectId(id));
  if (fileIds.length) {
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
    for (const id of fileIds) await bucket.delete(new mongoose.Types.ObjectId(id)).catch(() => {});
  }
  const left = (await Promise.all(TX_MODULES.map((k) => models[k].countDocuments()))).reduce((a, b) => a + b, 0);
  if (!left) {
    // nothing operational left → transaction number series restart (U1-1000 / U2-3000); master-data series are kept
    const keepPrefixes = ['ref-BUY-', 'ref-SUP-', 'ref-EMP-', 'ref-MST-'];
    await Counter.deleteMany({ _id: { $not: new RegExp(`^(${keepPrefixes.join('|')})`) } });
  } else {
    // live records remain: their numbers stay issued, the series continue after the highest one
    log(`${left} live (unflagged) transaction(s) kept – job series continue after their numbers.`);
    await Counter.deleteMany({ $or: [{ _id: /^job-unit-/ }, { _id: { $in: jobNos.map((n) => `sub-${n}`) } }] });
  }
  log(`Sample / test transactions removed (${jobs.length} jobs). Masters, users, roles, settings and audit trail kept.`);
}

/* ============================== 3. API client (in-process, as Admin) ============================== */
let BASE; let ADMIN;
const tokens = {};
async function startApi() {
  const app = createApp({ rateLimit: false });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  BASE = `http://127.0.0.1:${server.address().port}/api`;
  const role = await Role.findOne({ isAdmin: true });
  ADMIN = await User.findOne({ role: role._id, isDeleted: false });
  if (!ADMIN) throw new Error('No Admin user – cannot build the dataset');
  for (const unit of ['U1', 'U2']) tokens[unit] = jwt.sign({ sub: String(ADMIN._id), role: String(role._id), unit }, env.accessSecret, { expiresIn: '2h' });
  return server;
}
async function call(unit, method, p, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(BASE + p, {
    method, headers: { Authorization: `Bearer ${tokens[unit]}`, ...(isForm ? {} : { 'Content-Type': 'application/json' }) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const txt = await res.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${data?.message || txt}${data?.details ? ` ${JSON.stringify(data.details)}` : ''}`);
  return data;
}
const U = (unit) => ({
  get: (p) => call(unit, 'GET', p), post: (p, b = {}) => call(unit, 'POST', p, b), put: (p, b) => call(unit, 'PUT', p, b),
  status: async (key, id, ...sts) => { let r; for (const s of sts) r = await call(unit, 'POST', `/m/${key}/${id}/status`, { status: s }); return r; },
});

/* ============================== 4. Realistic dataset ============================== */
const TODAY = new Date(new Date().toISOString().slice(0, 10));
const day = (n) => new Date(TODAY.getTime() + n * 86400000).toISOString().slice(0, 10);
const r2 = (v) => Math.round(v * 100) / 100;
/** First day of attendance / payroll / hourly production data (relative to today). */
const FACTORY_FROM = -46;
const PDF = (title) => new Blob([`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n% ${title}\ntrailer<</Root 1 0 R>>\n%%EOF`], { type: 'application/pdf' });

const BUYERS = [
  { name: 'Nordic Apparel AB', code: 'NOR', country: 'Sweden', currency: 'USD', paymentTerms: 'TT 30 days' },
  { name: 'Urban Threads Inc', code: 'UTI', country: 'USA', currency: 'USD', paymentTerms: 'LC 60 days' },
  { name: 'Maison Lumière', code: 'MLU', country: 'France', currency: 'USD', paymentTerms: 'TT 60 days' },
  { name: 'Kiwi Kids Ltd', code: 'KKL', country: 'Australia', currency: 'USD', paymentTerms: 'TT 30 days' },
  { name: 'Pacific Coast Apparel LLC', code: 'PCA', country: 'USA', currency: 'USD', paymentTerms: 'LC at sight' },
  { name: 'Bristol & Main Ltd', code: 'BML', country: 'United Kingdom', currency: 'USD', paymentTerms: 'TT 60 days' },
  { name: 'Sakura Lifestyle KK', code: 'SLK', country: 'Japan', currency: 'USD', paymentTerms: 'LC 60 days' },
  { name: 'Hamburg Outdoor GmbH', code: 'HOG', country: 'Germany', currency: 'USD', paymentTerms: 'TT 30 days' },
];
const SUPPLIERS = [
  { name: 'Pioneer Knit Fabrics', supplierType: 'Fabric' }, { name: 'KPR Mill Ltd', supplierType: 'Fabric' }, { name: 'Arvind Mills', supplierType: 'Fabric' },
  { name: 'Raymond Woven Fabrics', supplierType: 'Fabric' }, { name: 'YKK India', supplierType: 'Trims' }, { name: 'Avery Dennison', supplierType: 'Trims' },
  { name: 'Maersk Logistics', supplierType: 'Logistics' }, { name: 'SGS Testing', supplierType: 'Testing Lab' },
  { name: 'Bright Wash Industries', supplierType: 'Washing' }, { name: 'Colour Print Hub', supplierType: 'Printing' }, { name: 'Stitch Art Embroidery', supplierType: 'Embroidery' },
  { name: 'Coats Thread India', supplierType: 'Accessories' },
  { name: 'Sri Ramakrishna Spinning Mills', supplierType: 'Yarn' }, { name: 'Tirupur Knit Fab', supplierType: 'Knitting' },
  { name: 'Royal Dyeing & Processing', supplierType: 'Fabric Processing' }, { name: 'Vetri Compacting Works', supplierType: 'Fabric Processing' },
];
/** Buyer contacts (filled in only where a buyer has none). */
const CONTACTS = {
  'Nordic Apparel AB': [['Elin Berg', 'Senior Buyer'], ['Johan Lind', 'QA Manager']], 'Urban Threads Inc': [['Maria Lopez', 'Sourcing Director'], ['Kevin Shaw', 'Technical Designer']],
  'Maison Lumière': [['Claire Dubois', 'Buyer'], ['Luc Martin', 'Logistics']], 'Kiwi Kids Ltd': [['Aroha Smith', 'Product Manager']], 'Pacific Coast Apparel LLC': [['Dana Brooks', 'Merchandiser']],
  'Bristol & Main Ltd': [['Oliver Grant', 'Head of Menswear'], ['Priya Nair', 'Compliance']], 'Sakura Lifestyle KK': [['Yuki Tanaka', 'Buyer'], ['Ken Mori', 'QC']], 'Hamburg Outdoor GmbH': [['Lena Vogel', 'Category Buyer']],
};
const STYLES = ['NA-CT-501', 'KK-TS-14', 'ML-PQ-77', 'UT-HD-330', 'NA-LS-610', 'KK-SH-22', 'PCA-TK-08', 'UT-SW-215', 'BM-OX-140', 'SL-CH-205', 'HO-SH-415', 'BM-LT-118', 'SL-BL-090', 'HO-OS-220', 'UT-JG-410', 'SL-DR-301'];
const MASTER_SAMPLES = [
  ...STYLES.map((name) => ['Style', name]),
  ['Costing Template', 'Knit top – basic (fabric KG, CMT, 12% margin)'], ['Costing Template', 'Woven shirt (fabric metre, wash, 12% margin)'], ['Costing Template', 'Bottoms (fabric metre, zip, wash, 11% margin)'],
  ['Shipment Method', 'Sea – FCL'], ['Shipment Method', 'Sea – LCL'], ['Shipment Method', 'Air freight'], ['Shipment Method', 'Courier (samples)'],
  ['Expense Category', 'Sewing / CMT'], ['Expense Category', 'Washing'], ['Expense Category', 'Freight'], ['Expense Category', 'Testing'],
];
/** Sample employees per unit: [code suffix, name, department, designation, line, grade, operator] */
const EMPLOYEES = [
  ['001', 'R. Senthil Kumar', 'CAD / Pattern', 'Pattern Master', '', 'A', false], ['002', 'K. Lakshmi', 'Sewing', 'Line Supervisor', 'Line 1', 'A', false],
  ['003', 'V. Arun', 'Quality', 'QA Inspector', '', 'A', false], ['004', 'S. Kavitha', 'Sewing', 'Operator – side seam', 'Line 1', 'A', true],
  ['005', 'M. Revathi', 'Sewing', 'Operator – collar attach', 'Line 2', 'B', true], ['006', 'P. Murugan', 'Cutting', 'Cutting Master', 'Table 1', 'A', false],
  ['007', 'A. Selvi', 'Finishing', 'Ironing Operator', 'Finishing', 'B', true], ['008', 'D. Ramesh', 'Packing', 'Packing Supervisor', 'Packing', 'B', false],
  ['009', 'J. Anitha', 'Fabric Department', 'Fabric Store Keeper', 'Store', 'B', false], ['010', 'G. Prakash', 'Production', 'Production Manager', '', 'A', false],
];
const KNIT_TRIMS = [
  { item: 'Main Label', description: 'Woven damask main label', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 3, rate: 0.045 },
  { item: 'Care Label', description: 'Satin care label, 4 languages', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 3, rate: 0.018 },
  { item: 'Hang Tag', description: 'FSC board hang tag with string', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 2, rate: 0.032 },
  { item: 'Thread', description: 'Spun poly 40/2 (cone 5000 m)', consumptionPerPc: 0.04, unit: 'Cone', wastagePct: 5, rate: 1.35 },
  { item: 'Polybag', description: 'LDPE 40 micron self-seal', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 2, rate: 0.022 },
  { item: 'Carton', description: '5-ply export carton 60×40×30', consumptionPerPc: 0.025, unit: 'Carton', wastagePct: 2, rate: 1.1 },
];
const WOVEN_TRIMS = [
  { item: 'Button', description: '4-hole polyester 18L', consumptionPerPc: 9, unit: 'Pcs', wastagePct: 4, rate: 0.012 },
  { item: 'Main Label', description: 'Woven main label', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 3, rate: 0.05 },
  { item: 'Care Label', description: 'Printed satin care label', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 3, rate: 0.02 },
  { item: 'Interlining', description: 'Fusible collar & cuff interlining (m)', consumptionPerPc: 0.12, unit: 'Meter', wastagePct: 5, rate: 0.9 },
  { item: 'Polybag', description: 'LDPE 40 micron with warning print', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 2, rate: 0.025 },
  { item: 'Carton', description: '5-ply export carton', consumptionPerPc: 0.033, unit: 'Carton', wastagePct: 2, rate: 1.2 },
];
const BOTTOM_TRIMS = [
  { item: 'Zipper', description: 'YKK #4.5 brass fly zip', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 3, rate: 0.18 },
  { item: 'Button', description: 'Shank button 24L', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 3, rate: 0.06 },
  { item: 'Main Label', description: 'Woven waistband label', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 3, rate: 0.05 },
  { item: 'Polybag', description: 'LDPE 40 micron', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 2, rate: 0.024 },
  { item: 'Carton', description: '5-ply export carton', consumptionPerPc: 0.04, unit: 'Carton', wastagePct: 2, rate: 1.2 },
];
const SIZES_ADULT = ['S', 'M', 'L', 'XL']; const SIZES_KIDS = ['4Y', '6Y', '8Y', '10Y'];
const RATIO_ADULT = 'S:2,M:4,L:3,XL:1'; const RATIO_KIDS = '4Y:2,6Y:3,8Y:3,10Y:2';
const POMS = (base) => [
  { pom: 'Chest 1/2 (1" below armhole)', howToMeasure: 'Side to side', baseValue: base[0], gradeIncrement: 2.5, tolerance: 1 },
  { pom: 'Body length HPS', howToMeasure: 'High point shoulder to hem', baseValue: base[1], gradeIncrement: 1.5, tolerance: 1 },
  { pom: 'Sleeve length', howToMeasure: 'Shoulder point to cuff', baseValue: base[2], gradeIncrement: 0.75, tolerance: 0.5 },
  { pom: 'Neck width', howToMeasure: 'Seam to seam', baseValue: base[3], gradeIncrement: 0.5, tolerance: 0.5 },
];

/**
 * Jobs. stage = how far the job is taken:
 *   planning · fabricPending · cutting · sewing · quality · packing · readyToShip · shipped · accountsPending · closed
 * Forecast / continuous main jobs (forecast) get a fabric forecast, receipt and transfers that create sub jobs.
 */
const JOBS = {
  U1: [
    { key: 'U1-MAIN', buyer: 'Nordic Apparel AB', styleNo: 'NA-CT-501', product: "Men's Crew Neck Tee", garmentType: 'T-Shirt', poNo: 'NOR-PO-5120', destination: 'Gothenburg', price: 4.2, qty: 4000, forecast: true,
      fabric: { fabricType: '100% Cotton Single Jersey', composition: '100% Combed Cotton', gsm: 160, width: 60, color: 'Navy', unit: 'Meter', consumption: 1.2, wastagePct: 4, rate: 0.95 },
      trims: KNIT_TRIMS, sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [52, 71, 20, 18], sam: 6.8, orderDays: -100, shipDays: -5, closeMain: true,
      costing: { trimCost: 0.19, accessoriesCost: 0.03, cuttingCost: 0.06, sewingCost: 0.52, finishingCost: 0.1, packingCost: 0.07, labourCost: 0.05, factoryOverhead: 0.18, testingCost: 0.03, freightCost: 0.09, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 },
      // 5000 m received = 4700 m to the three call-offs + 300 m inter-unit transfer → fully allocated, forecast closes
      forecastPlan: { supplier: 'Pioneer Knit Fabrics', supplierPoNo: 'PKF/2026/0841', lotNo: 'LOT-SJ-NV-2291', received: 5000, receivedDays: -82 },
      subJobs: [
        { qty: 800, fabric: 1000, day: -80, ship: -40, ref: 'NOR-PO-5120 call-off 1', poNo: 'NOR-PO-5120-01', color: 'Navy', stage: 'closed' },
        { qty: 2000, fabric: 2500, day: -62, ship: -20, ref: 'NOR-PO-5120 call-off 2', poNo: 'NOR-PO-5120-02', color: 'Navy', stage: 'closed', flow: true },
        { qty: 960, fabric: 1200, day: -45, ship: -5, ref: 'NOR-PO-5120 call-off 3', poNo: 'NOR-PO-5120-03', color: 'Navy', stage: 'closed', flow: true },
      ] },
    { key: 'U1-KIDS-TEE', buyer: 'Kiwi Kids Ltd', styleNo: 'KK-TS-14', product: 'Kids Printed Crew Tee', garmentType: 'T-Shirt', poNo: 'KK-61820', destination: 'Sydney', price: 2.85, qty: 6000, stage: 'closed',
      fabric: { fabricType: 'Single Jersey 160 GSM', composition: '100% Cotton', gsm: 160, width: 66, color: 'Sky Blue', unit: 'KG', consumption: 0.14, wastagePct: 5, rate: 4.6 },
      trims: KNIT_TRIMS, sizes: SIZES_KIDS, ratio: RATIO_KIDS, poms: [36, 46, 13, 15], sam: 5.6, orderDays: -110, shipDays: -25,
      costing: { trimCost: 0.16, printingCost: 0.14, cuttingCost: 0.04, sewingCost: 0.38, finishingCost: 0.07, packingCost: 0.05, labourCost: 0.04, factoryOverhead: 0.12, testingCost: 0.03, freightCost: 0.07, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 11 },
      expenses: [['Printing', 0.14], ['Sewing / CMT', 0.37], ['Finishing', 0.07], ['Packing', 0.05]], payFull: true,
      claim: { amount: 114, reason: 'buyer claim – 40 pcs with print smudge found at destination, deducted at FOB 2.85' } },
    { key: 'U1-POLO', buyer: 'Maison Lumière', styleNo: 'ML-PQ-77', product: "Women's Pique Polo", garmentType: 'Polo Shirt', poNo: 'ML-2026-231', destination: 'Le Havre', price: 6.4, qty: 4500, stage: 'accountsPending',
      fabric: { fabricType: 'Cotton Pique 220 GSM', composition: '95% Cotton 5% Elastane', gsm: 220, width: 64, color: 'Ivory', unit: 'KG', consumption: 0.24, wastagePct: 5, rate: 5.2 },
      trims: [...KNIT_TRIMS, { item: 'Button', description: 'Pearl 2-hole 16L', consumptionPerPc: 3, unit: 'Pcs', wastagePct: 4, rate: 0.015 }], sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [48, 66, 18, 17], sam: 11.5, orderDays: -95, shipDays: -6,
      costing: { trimCost: 0.26, cuttingCost: 0.07, sewingCost: 0.95, finishingCost: 0.14, packingCost: 0.08, labourCost: 0.06, factoryOverhead: 0.22, testingCost: 0.04, freightCost: 0.12, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 13 },
      expenses: [['Sewing / CMT', 0.98], ['Finishing', 0.15], ['Packing', 0.08]], payPart: 0.4 },
    { key: 'U1-HOODIE', flow: true, countAdjust: { type: ADJUST_SHORT, qty: 2.4 }, buyer: 'Urban Threads Inc', styleNo: 'UT-HD-330', product: 'Unisex Pullover Hoodie', garmentType: 'Hoodie', poNo: 'UTI-91407', destination: 'Los Angeles', price: 11.8, qty: 3500, stage: 'partShipped',
      fabric: { fabricType: 'French Terry 300 GSM', composition: '80% Cotton 20% Polyester', gsm: 300, width: 72, color: 'Heather Grey', unit: 'KG', consumption: 0.62, wastagePct: 6, rate: 6.1 },
      trims: [...KNIT_TRIMS, { item: 'Drawcord', description: 'Flat cotton drawcord 140 cm with metal tips', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 3, rate: 0.11 }], sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [60, 72, 64, 20], sam: 17.5, orderDays: -70, shipDays: 12,
      costing: { trimCost: 0.31, cuttingCost: 0.12, sewingCost: 1.55, finishingCost: 0.2, washingCost: 0.25, packingCost: 0.1, labourCost: 0.09, factoryOverhead: 0.35, testingCost: 0.05, freightCost: 0.22, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
    { key: 'U1-HENLEY', flow: true, buyer: 'Nordic Apparel AB', styleNo: 'NA-LS-610', product: "Men's Long Sleeve Henley", garmentType: 'T-Shirt', poNo: 'NOR-PO-5188', destination: 'Gothenburg', price: 5.6, qty: 5200, stage: 'sewing',
      fabric: { fabricType: 'Waffle Knit 200 GSM', composition: '100% Cotton', gsm: 200, width: 68, color: 'Olive', unit: 'KG', consumption: 0.27, wastagePct: 5, rate: 5.4 },
      trims: [...KNIT_TRIMS, { item: 'Button', description: 'Horn-look 3-button placket 18L', consumptionPerPc: 3, unit: 'Pcs', wastagePct: 4, rate: 0.02 }], sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [53, 72, 64, 17], sam: 10.2, orderDays: -60, shipDays: 35,
      costing: { trimCost: 0.24, cuttingCost: 0.07, sewingCost: 0.82, finishingCost: 0.12, packingCost: 0.07, labourCost: 0.06, factoryOverhead: 0.2, testingCost: 0.04, freightCost: 0.1, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
    { key: 'U1-SHORTS', buyer: 'Kiwi Kids Ltd', styleNo: 'KK-SH-22', product: 'Kids Jersey Shorts', garmentType: 'Shorts', poNo: 'KK-62004', destination: 'Sydney', price: 2.1, qty: 8000, stage: 'fabricPending',
      fabric: { fabricType: 'Single Jersey 180 GSM', composition: '95% Cotton 5% Elastane', gsm: 180, width: 66, color: 'Coral', unit: 'KG', consumption: 0.11, wastagePct: 5, rate: 4.9 },
      trims: KNIT_TRIMS, sizes: SIZES_KIDS, ratio: RATIO_KIDS, poms: [28, 30, 0, 22], sam: 4.2, orderDays: -28, shipDays: 70,
      costing: { trimCost: 0.14, cuttingCost: 0.03, sewingCost: 0.29, finishingCost: 0.05, packingCost: 0.04, labourCost: 0.03, factoryOverhead: 0.09, testingCost: 0.02, freightCost: 0.05, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 11 } },
    { key: 'U1-TANK', hold: 'Approval – buyer fit sample comments awaited (neck rib width), bulk cutting not released', buyer: 'Pacific Coast Apparel LLC', styleNo: 'PCA-TK-08', product: "Women's Rib Tank Top", garmentType: 'T-Shirt', poNo: 'PCA-PO-30772', destination: 'Long Beach', price: 3.15, qty: 7000, stage: 'planning',
      fabric: { fabricType: '2x1 Rib 210 GSM', composition: '95% Cotton 5% Elastane', gsm: 210, width: 60, color: 'Black', unit: 'KG', consumption: 0.13, wastagePct: 5, rate: 5.6 },
      trims: KNIT_TRIMS, sizes: ['XS', 'S', 'M', 'L'], ratio: 'XS:2,S:3,M:3,L:2', poms: [42, 58, 0, 16], sam: 4.8, orderDays: -10, shipDays: 95,
      costing: { trimCost: 0.15, cuttingCost: 0.04, sewingCost: 0.33, finishingCost: 0.06, packingCost: 0.05, labourCost: 0.04, factoryOverhead: 0.11, testingCost: 0.03, freightCost: 0.06, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
    { key: 'U1-SWEAT', flow: true, qualityHold: true, buyer: 'Urban Threads Inc', styleNo: 'UT-SW-215', product: 'Crew Neck Sweatshirt', garmentType: 'Sweatshirt', poNo: 'UTI-91688', destination: 'Los Angeles', price: 9.2, qty: 3000, stage: 'packingPartial',
      fabric: { fabricType: 'Brushed Fleece 280 GSM', composition: '80% Cotton 20% Polyester', gsm: 280, width: 72, color: 'Charcoal', unit: 'KG', consumption: 0.52, wastagePct: 6, rate: 5.8 },
      trims: KNIT_TRIMS, sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [58, 70, 62, 19], sam: 14.5, orderDays: -65, shipDays: 9,
      costing: { trimCost: 0.22, cuttingCost: 0.1, sewingCost: 1.25, finishingCost: 0.16, packingCost: 0.09, labourCost: 0.08, factoryOverhead: 0.3, testingCost: 0.05, freightCost: 0.18, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
    // order → hourly production in every department → QC gates → finished goods → shipment → closure
    { key: 'U1-FLOW', flow: true, buyer: 'Maison Lumière', styleNo: 'ML-TS-120', product: "Women's Slub Jersey Tee", garmentType: 'T-Shirt', poNo: 'ML-2026-260', destination: 'Le Havre', price: 4.9, qty: 2400, stage: 'closed',
      fabric: { fabricType: 'Slub Single Jersey 150 GSM', composition: '100% Cotton', gsm: 150, width: 64, color: 'Ecru', unit: 'KG', consumption: 0.13, wastagePct: 5, rate: 4.8 },
      trims: KNIT_TRIMS, sizes: ['XS', 'S', 'M', 'L'], ratio: 'XS:2,S:3,M:3,L:2', poms: [44, 62, 16, 15], sam: 6.2, orderDays: -50, shipDays: -6, payFull: true,
      costing: { trimCost: 0.18, cuttingCost: 0.05, sewingCost: 0.5, finishingCost: 0.09, packingCost: 0.06, labourCost: 0.05, factoryOverhead: 0.16, testingCost: 0.03, freightCost: 0.08, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
  ],
  U2: [
    { key: 'U2-MAIN', flow: true, buyer: 'Bristol & Main Ltd', styleNo: 'BM-OX-140', product: "Men's Oxford Button-Down Shirt", garmentType: 'Shirt', poNo: 'BM-PO-77310', destination: 'Felixstowe', price: 8.9, qty: 6000, forecast: true,
      fabric: { fabricType: 'Cotton Oxford 40s', composition: '100% Cotton', gsm: 135, width: 58, color: 'Light Blue', unit: 'Meter', consumption: 1.6, wastagePct: 5, rate: 2.75 },
      trims: WOVEN_TRIMS, sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [56, 78, 64, 41], sam: 18.5, orderDays: -80, shipDays: 50,
      costing: { trimCost: 0.29, accessoriesCost: 0.11, cuttingCost: 0.1, sewingCost: 1.45, finishingCost: 0.2, washingCost: 0.18, packingCost: 0.09, labourCost: 0.08, factoryOverhead: 0.32, testingCost: 0.05, freightCost: 0.16, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 },
      forecastPlan: { supplier: 'Arvind Mills', supplierPoNo: 'AM/OX/26-1187', lotNo: 'OX-LB-5531', received: 10400, receivedDays: -58 },
      subJobs: [
        { qty: 3000, fabric: 5040, day: -56, ship: -8, ref: 'BM-PO-77310 drop 1', poNo: 'BM-PO-77310-D1', color: 'Light Blue', stage: 'readyToClose' },
        { qty: 2000, fabric: 3360, day: -25, ship: -2, ref: 'BM-PO-77310 drop 2', poNo: 'BM-PO-77310-D2', color: 'Light Blue', stage: 'partShipped' },
        { qty: 1000, fabric: 1700, day: -24, ship: 60, ref: 'BM-PO-77310 drop 3', poNo: 'BM-PO-77310-D3', color: 'Light Blue', stage: 'sewing' },
      ] },
    { key: 'U2-CHINO', buyer: 'Sakura Lifestyle KK', styleNo: 'SL-CH-205', product: "Women's Stretch Twill Chino", garmentType: 'Trouser', poNo: 'SLK-24-5582', destination: 'Yokohama', price: 9.4, qty: 4000, stage: 'closed',
      fabric: { fabricType: 'Stretch Cotton Twill 7 oz', composition: '98% Cotton 2% Elastane', gsm: 240, width: 57, color: 'Khaki', unit: 'Meter', consumption: 1.35, wastagePct: 5, rate: 3.4 },
      trims: BOTTOM_TRIMS, sizes: ['26', '28', '30', '32'], ratio: '26:2,28:3,30:3,32:2', poms: [36, 99, 0, 0], sam: 22, orderDays: -120, shipDays: -30,
      costing: { trimCost: 0.42, cuttingCost: 0.12, sewingCost: 1.7, finishingCost: 0.22, washingCost: 0.35, packingCost: 0.1, labourCost: 0.1, factoryOverhead: 0.38, testingCost: 0.06, freightCost: 0.2, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 11 },
      expenses: [['Sewing / CMT', 1.68], ['Washing', 0.36], ['Finishing', 0.22], ['Packing', 0.1]], payFull: true },
    { key: 'U2-POPLIN', countAdjust: { type: ADJUST_EXCESS, qty: 3.5 }, buyer: 'Hamburg Outdoor GmbH', styleNo: 'HO-SH-415', product: "Men's Poplin Short Sleeve Shirt", garmentType: 'Shirt', poNo: 'HOG-4410-26', destination: 'Hamburg', price: 7.1, qty: 3000, stage: 'shipped',
      fabric: { fabricType: 'Cotton Poplin 60s', composition: '100% Cotton', gsm: 110, width: 58, color: 'White', unit: 'Meter', consumption: 1.45, wastagePct: 5, rate: 2.4 },
      trims: WOVEN_TRIMS, sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [55, 76, 24, 40], sam: 16, orderDays: -85, shipDays: -4,
      costing: { trimCost: 0.27, accessoriesCost: 0.09, cuttingCost: 0.09, sewingCost: 1.25, finishingCost: 0.18, packingCost: 0.08, labourCost: 0.07, factoryOverhead: 0.28, testingCost: 0.05, freightCost: 0.15, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 },
      expenses: [['Sewing / CMT', 1.3], ['Finishing', 0.18]] },
    { key: 'U2-LOUNGE', flow: true, buyer: 'Bristol & Main Ltd', styleNo: 'BM-LT-118', product: "Men's Lounge Tee", garmentType: 'T-Shirt', poNo: 'BM-PO-77402', destination: 'Felixstowe', price: 4.6, qty: 2500, stage: 'cutting',
      fabric: { fabricType: '100% Cotton Single Jersey', composition: '100% Combed Cotton', gsm: 160, width: 60, color: 'Navy', unit: 'Meter', consumption: 1.2, wastagePct: 4, rate: 0.95 },
      trims: KNIT_TRIMS, sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [53, 72, 21, 18], sam: 7, orderDays: -45, shipDays: 40, partialFabric: 0.88,
      costing: { trimCost: 0.19, cuttingCost: 0.06, sewingCost: 0.55, finishingCost: 0.1, packingCost: 0.07, labourCost: 0.05, factoryOverhead: 0.18, testingCost: 0.03, freightCost: 0.1, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
    { key: 'U2-BLOUSE', hold: 'Trims – shell buttons rejected at incoming inspection, re-supply from YKK India awaited', buyer: 'Sakura Lifestyle KK', styleNo: 'SL-BL-090', product: "Women's Viscose Blouse", garmentType: 'Shirt', poNo: 'SLK-24-5671', destination: 'Yokohama', price: 8.2, qty: 3600, stage: 'fabricPending',
      fabric: { fabricType: 'Viscose Challis 120 GSM', composition: '100% Viscose', gsm: 120, width: 56, color: 'Dusty Rose', unit: 'Meter', consumption: 1.5, wastagePct: 6, rate: 2.9 },
      trims: WOVEN_TRIMS, sizes: ['XS', 'S', 'M', 'L'], ratio: 'XS:2,S:3,M:3,L:2', poms: [50, 64, 60, 36], sam: 19, orderDays: -30, shipDays: 75,
      costing: { trimCost: 0.26, cuttingCost: 0.11, sewingCost: 1.5, finishingCost: 0.2, packingCost: 0.09, labourCost: 0.08, factoryOverhead: 0.3, testingCost: 0.05, freightCost: 0.15, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
    { key: 'U2-FLANNEL', hold: 'Capacity – sewing lines 3 and 4 booked until next month', buyer: 'Hamburg Outdoor GmbH', styleNo: 'HO-OS-220', product: "Men's Flannel Overshirt", garmentType: 'Shirt', poNo: 'HOG-4488-26', destination: 'Hamburg', price: 14.5, qty: 2200, stage: 'planning',
      fabric: { fabricType: 'Brushed Cotton Flannel', composition: '100% Cotton', gsm: 190, width: 58, color: 'Red Check', unit: 'Meter', consumption: 1.9, wastagePct: 7, rate: 3.6 },
      trims: WOVEN_TRIMS, sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [60, 79, 66, 43], sam: 26, orderDays: -12, shipDays: 100,
      costing: { trimCost: 0.34, accessoriesCost: 0.12, cuttingCost: 0.14, sewingCost: 2.1, finishingCost: 0.26, washingCost: 0.2, packingCost: 0.11, labourCost: 0.11, factoryOverhead: 0.45, testingCost: 0.06, freightCost: 0.24, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 13 } },
    { key: 'U2-FLOW', flow: true, buyer: 'Hamburg Outdoor GmbH', styleNo: 'HO-PL-330', product: "Men's Pique Polo", garmentType: 'Polo Shirt', poNo: 'HOG-4460-26', destination: 'Hamburg', price: 6.8, qty: 1800, stage: 'closed',
      fabric: { fabricType: 'Cotton Pique 210 GSM', composition: '100% Cotton', gsm: 210, width: 64, color: 'Navy', unit: 'KG', consumption: 0.23, wastagePct: 5, rate: 5.1 },
      trims: [...KNIT_TRIMS, { item: 'Button', description: 'Navy 2-hole 16L', consumptionPerPc: 3, unit: 'Pcs', wastagePct: 4, rate: 0.015 }], sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [54, 72, 22, 18], sam: 10.5, orderDays: -46, shipDays: -4, payFull: true,
      costing: { trimCost: 0.25, cuttingCost: 0.07, sewingCost: 0.9, finishingCost: 0.13, packingCost: 0.08, labourCost: 0.06, factoryOverhead: 0.21, testingCost: 0.04, freightCost: 0.11, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
  ],
};

/**
 * Repeat buyers place the same style again: an ADVANCE job is opened from the new costing / quotation before
 * the buyer PO exists (PO Status "Awaiting PO" – not a confirmed order). Forecast advance jobs are split into
 * sub jobs; a call-off PO that has arrived is linked to its sub job through a New Order (buyer PO) record.
 */
const nextMonth = (n) => { const d = new Date(TODAY); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 7); };
const ADVANCE = {
  U1: [
    { key: 'U1-ADV-NOR', advance: true, forecast: true, repeatOf: 'U1-MAIN', buyer: 'Nordic Apparel AB', styleNo: 'NA-CT-501', product: "Men's Crew Neck Tee", garmentType: 'T-Shirt', destination: 'Gothenburg', price: 4.25, qty: 3600,
      expectedOrderMonth: nextMonth(1), fabricOf: 'U1-MAIN', orderDays: -6, shipDays: 75,
      subJobs: [
        { qty: 1200, ship: 45, stage: 'fabricPending', callOff: { poNo: 'NOR-PO-5302-01', orderDays: -3, color: 'Navy' } },
        { qty: 1200, ship: 75, stage: 'planning' },
        { qty: 1200, ship: 105 },
      ] },
  ],
  U2: [
    { key: 'U2-ADV-BM', advance: true, forecast: true, repeatOf: 'U2-MAIN', buyer: 'Bristol & Main Ltd', styleNo: 'BM-OX-140', product: "Men's Oxford Button-Down Shirt", garmentType: 'Shirt', destination: 'Felixstowe', price: 8.95, qty: 4800,
      expectedOrderMonth: nextMonth(1), fabricOf: 'U2-MAIN', orderDays: -5, shipDays: 90,
      // the first call-off PO has arrived (New Orders) but is not linked yet → "Orders awaiting job creation"
      subJobs: [{ qty: 2400, ship: 60, stage: 'planning', pendingPo: { poNo: 'BM-PO-78015-01', orderDays: -1, color: 'Light Blue' } }, { qty: 2400, ship: 95 }] },
    { key: 'U2-ADV-SLK', advance: true, repeatOf: 'U2-CHINO', buyer: 'Sakura Lifestyle KK', styleNo: 'SL-CH-205', product: "Women's Stretch Twill Chino", garmentType: 'Trouser', destination: 'Yokohama', price: 9.5, qty: 3000,
      expectedOrderMonth: nextMonth(2), fabricOf: 'U2-CHINO', orderDays: -4, shipDays: 110, stage: 'planning' },
  ],
};
/** Buyer POs received and not yet converted into jobs (New Orders / Orders awaiting job creation). */
const NEW_ORDERS = {
  U1: [
    { orderType: 'Repeat Order', repeatOf: 'U1-TANK', buyer: 'Pacific Coast Apparel LLC', poNo: 'PCA-PO-31206', styleNo: 'PCA-TK-08', product: "Women's Rib Tank Top", garmentType: 'T-Shirt', orderDays: -2, deliveryDays: 115, qty: 6500, unitPrice: 3.15, color: 'Black', sizeRatio: 'XS:2,S:3,M:3,L:2', destination: 'Long Beach' },
    { orderType: 'New Order', buyer: 'Urban Threads Inc', poNo: 'UTI-92011', styleNo: 'UT-JG-410', product: 'Fleece Jogger', garmentType: 'Trouser', orderDays: -1, deliveryDays: 120, qty: 4200, unitPrice: 9.6, color: 'Black', sizeRatio: RATIO_ADULT, destination: 'Los Angeles', review: true },
  ],
  U2: [
    { orderType: 'Repeat Order', repeatOf: 'U2-POPLIN', buyer: 'Hamburg Outdoor GmbH', poNo: 'HOG-4521-26', styleNo: 'HO-SH-415', product: "Men's Poplin Short Sleeve Shirt", garmentType: 'Shirt', orderDays: -3, deliveryDays: 105, qty: 3500, unitPrice: 7.1, color: 'White', sizeRatio: RATIO_ADULT, destination: 'Hamburg' },
    { orderType: 'New Order', buyer: 'Sakura Lifestyle KK', poNo: 'SLK-24-5802', styleNo: 'SL-DR-301', product: "Women's Shirt Dress", garmentType: 'Dress', orderDays: -1, deliveryDays: 125, qty: 2400, unitPrice: 12.4, color: 'Sage', sizeRatio: 'XS:2,S:3,M:3,L:2', destination: 'Yokohama', review: true },
  ],
};

const STAGES = ['planning', 'fabricPending', 'fabric', 'cutting', 'sewing', 'quality', 'packingPartial', 'packing', 'readyToShip', 'partShipped', 'shipped', 'accountsPending', 'readyToClose', 'closed'];
const reach = (target, s) => STAGES.indexOf(target) >= STAGES.indexOf(s);

/* --------------------------- commercial chain: enquiry → costing → quotation → order --------------------------- */
async function confirmOrder(api, spec, ids) {
  const f = spec.fabric;
  const enq = await api.post('/m/enquiry', { enquiryDate: day(spec.orderDays - 20), buyer: ids.buyers[spec.buyer], buyerContact: 'Sourcing team', styleNo: spec.styleNo, product: spec.product, garmentType: spec.garmentType, fabric: f.fabricType, composition: f.composition, gsm: f.gsm, color: f.color, sizeRange: spec.sizes.join(', '), expectedQty: spec.qty, targetPrice: spec.price, currency: 'USD', requiredDelivery: day(spec.shipDays) });
  await api.status('enquiry', enq._id, 'Under Review');
  // FOB price = the cost sheet's total cost + margin (the buyer's target price is only the enquiry's target)
  const cst = await api.post('/m/costing', { enquiry: enq._id, costingDate: day(spec.orderDays - 16), fabricConsumption: f.consumption, fabricUnit: f.unit, fabricRate: f.rate, fabricWastagePct: f.wastagePct, ...spec.costing });
  await api.status('costing', cst._id, 'Submitted', 'Under Review', 'Approved');
  const qtn = await api.post('/m/quotation', { costing: cst._id, quoteDate: day(spec.orderDays - 12), fabric: f.fabricType, composition: f.composition, gsm: f.gsm, color: f.color, sizeRange: spec.sizes.join(', '), paymentTerms: BUYERS.find((b) => b.name === spec.buyer).paymentTerms, deliveryTerms: 'FOB', validUntil: day(spec.orderDays + 30) });
  await api.status('quotation', qtn._id, 'Sent', 'Under Review', 'Approved');
  const ratio = spec.ratio.split(',').map((p) => { const [s, q] = p.split(':'); return [s, Number(q)]; });
  const per = spec.qty / ratio.reduce((t, [, q]) => t + q, 0);
  const order = {
    orderDate: day(spec.orderDays), shipmentDate: day(spec.shipDays), deliveryDate: day(spec.shipDays + 21), destination: spec.destination,
    orderQty: spec.qty, colors: [f.color], sizes: spec.sizes, sizeBreakdown: ratio.map(([size, q]) => ({ color: f.color, size, qty: Math.round(per * q) })),
    fabricType: f.fabricType, composition: f.composition, gsm: f.gsm, width: f.width, fabricColor: f.color, consumption: f.consumption, consumptionUnit: f.unit,
    wastagePct: f.wastagePct, fabricRate: f.rate, trims: spec.trims, specialInstructions: `${spec.product} – buyer ${spec.buyer}. Shade band approval before bulk cutting. [Sample / Test data]`,
    ...(spec.forecast ? { isForecast: true, forecastQty: spec.qty } : {}),
    ...(spec.repeatOfJobNo ? { repeatOfJobNo: spec.repeatOfJobNo } : {}),
  };
  // advance job for a repeat / forecast order: opened from the quotation before the buyer PO exists
  if (spec.advance) return api.post(`/jobs/from-quotation/${qtn._id}`, { ...order, poStatus: 'Awaiting PO', expectedOrderMonth: spec.expectedOrderMonth });
  // confirmed order: the buyer PO is registered (New Orders) and converted into the job
  const bo = await api.post('/m/buyerOrder', {
    orderType: spec.repeatOfJobNo ? 'Repeat Order' : 'New Order', buyer: ids.buyers[spec.buyer], poNo: spec.poNo, styleNo: spec.styleNo, product: spec.product, garmentType: spec.garmentType,
    orderDate: order.orderDate, deliveryDate: order.deliveryDate, shipmentDate: order.shipmentDate, orderQty: spec.qty, unitPrice: qtn.price, currency: 'USD',
    color: f.color, sizeRatio: spec.ratio, destination: spec.destination, quotation: qtn._id, repeatOfJobNo: spec.repeatOfJobNo, remarks: 'Sample / Test data',
  });
  await api.status('buyerOrder', bo._id, 'Under Review');
  return api.post(`/jobs/from-buyer-order/${bo._id}`, order);
}

/* --------------------------- fabric transactions (roll-wise) --------------------------- */
/**
 * Fabric inward in two supplier deliveries: rolls of ~25 kg / 100 m with 4-point inspection, plus one extra roll that
 * fails inspection. Returns the passed rolls (for issue) and the failed one (for the return to the supplier).
 */
async function fabricInward(api, jobNo, against, qty, f, lots, d0, counters) {
  const size = f.unit === 'KG' ? 25 : 100;
  const n = Math.max(1, Math.ceil(qty / size));
  const split = Math.ceil(n * 0.6);
  const rolls = Array.from({ length: n }, (_, i) => ({
    rollNo: `R${String(i + 1).padStart(3, '0')}`, lotNo: lots[i < split ? 0 : 1], shade: i < split ? 'A' : 'B', width: f.width, gsm: f.gsm,
    qty: i < n - 1 ? size : r2(qty - size * (n - 1)), points: 6 + ((i * 7) % 15), result: 'Pass',
  }));
  const bad = { rollNo: `R${String(n + 1).padStart(3, '0')}`, lotNo: lots[1], shade: 'B', width: f.width, gsm: f.gsm, qty: f.unit === 'KG' ? 18.5 : 64, points: f.unit === 'KG' ? 52 : 75, result: 'Fail' };
  for (const [i, part] of [rolls.slice(0, split), [...rolls.slice(split), bad]].entries()) {
    const rc = await api.post('/m/fabricReceipt', { job: jobNo, ...against, receiptDate: day(d0 + i * 3), supplierDc: `DC/${lots[i]}/${counters.dc++}`, vehicleNo: `TN 38 AB ${4100 + counters.dc}`, rolls: part, remarks: i ? `Roll ${bad.rollNo} failed 4-point inspection` : '' });
    await api.status('fabricReceipt', rc._id, 'Inspected', 'Approved');
  }
  return { passed: rolls.map((r) => ({ rollNo: r.rollNo, left: r.qty })), rejected: bad };
}

/** The failed roll goes back to the supplier; the fabric department raises a supplier debit note for it (+ return freight). */
async function rejectedRollBack(api, jobNo, against, bad, d0, settle, counters) {
  const ret = await api.post('/m/fabricReturn', { job: jobNo, ...against, returnType: RETURN_TO_SUPPLIER, returnDate: day(d0), referenceDoc: `RC/${jobNo}/${counters.dc++}`, rollNos: `${bad.rollNo} (lot ${bad.lotNo})`, qty: bad.qty, reason: 'Failed 4-point inspection – returned for credit' });
  await api.status('fabricReturn', ret._id, 'Accepted');
  const dn = await api.post('/m/fabricDebit', { job: jobNo, ...against, fabricReturn: ret._id, debitDate: day(d0 + 1), debitTo: 'Supplier', reason: 'Rejected fabric (4-point inspection)', otherCharges: 12.5, remarks: 'Roll value + return freight' });
  if (!settle) return { dn, setOff: 0 };
  await api.status('fabricDebit', dn._id, 'Accepted');
  if (settle === 'Adjusted') {
    await api.put(`/m/fabricDebit/${dn._id}`, { referenceDoc: `CN-${counters.dc++} (supplier credit note, adjusted against the fabric bill)` });
    await api.status('fabricDebit', dn._id, 'Adjusted');
  }
  return { dn, setOff: settle === 'Adjusted' ? dn.amount : 0 };
}

/**
 * Supplier bill (accounts payable) with debit notes set off and payments: pay 'full' / 'half' / null.
 * The payable only – the job cost is already recognised at receipt or as a job expense.
 */
async function supplierBill(api, jobNo, b, counters) {
  const bill = await api.post('/m/supplierBill', {
    job: jobNo || undefined, supplier: b.supplier, billNo: b.billNo, billDate: day(b.day), dueDate: day(b.day + (b.terms || 45)), billType: b.billType, fabricBooking: b.fabricBooking,
    poRef: b.poRef, description: b.description, qty: b.qty, unit: b.unit, rate: b.rate, taxPct: b.taxPct ?? 5, debitNoteAdjusted: b.setOff || 0, debitNoteRefs: b.setOffRefs || '', remarks: 'Sample / Test data',
  });
  const due = r2(bill.totalAmount - num(b.setOff));
  const amount = b.pay === 'full' ? due : b.pay === 'half' ? r2(due / 2) : 0;
  if (amount > 0) await api.put(`/m/supplierBill/${bill._id}`, { payments: [{ date: day(Math.min(b.day + (b.pay === 'full' ? 30 : 15), 0)), mode: 'Bank transfer', reference: `NEFT/${counters.bill++}`, amount }] });
  await api.status('supplierBill', bill._id, 'Verified', ...(amount > 0 ? ['Approved'] : []));
  return bill;
}

/** Issue fabric to cutting in two allocations, roll by roll (or by transfer lot), up to `qty`. */
async function issueRolls(api, jobNo, bookingId, rolls, qty, d0, counters) {
  const parts = [[], []];
  let need = r2(qty);
  for (const r of rolls) {
    if (need <= 0.0005) break;
    const take = r2(Math.min(r.left, need));
    if (take <= 0) continue;
    r.left = r2(r.left - take); need = r2(need - take);
    parts[r2(qty - need) > qty * 0.6 && parts[0].length ? 1 : 0].push({ rollNo: r.rollNo, qty: take });
  }
  for (const [i, part] of parts.entries()) {
    if (!part.length) continue;
    const a = await api.post('/m/fabricAllocation', { job: jobNo, booking: bookingId, allocationDate: day(d0 + i * 2), cuttingTable: `Table ${(counters.line % 4) + 1}`, rolls: part, remarks: `Issue slip IS-${counters.dc++}` });
    await api.status('fabricAllocation', a._id, 'Issued to Cutting');
  }
}

/* --------------------------- one job through the workflow up to its target stage --------------------------- */
async function runJob(api, unit, jobNo, spec, target, ids, counters) {
  const f = spec.fabric;
  let t = await api.get(`/jobs/track/${jobNo}`);
  const job = t.job;
  const qty = job.orderQty;
  // timeline: pre-production from the order / call-off date, production well before today, shipment after packing
  const start = spec.orderDays;
  const ps = Math.min(start + 26, -14);
  // specification
  const spc = await api.put(`/m/techSpec/${t.records.techSpec[0]._id}`, { specDate: day(start + 1), buyerApprovalDate: day(start + 4), fit: 'Regular fit', baseSize: spec.sizes[1], sizes: spec.sizes, description: `${spec.product}, ${f.composition}`, construction: 'Overlock 4-thread seams, coverstitch hems, taped shoulders', stitching: '12–14 SPI lockstitch, 4-thread overlock', labelling: 'Main label centre back neck, care label left side seam 10 cm above hem', packingInstructions: 'Single piece folded in polybag, solid colour assorted size cartons', measurements: spec.poms.filter((v) => v > 0).length ? POMS(spec.poms).filter((p) => p.baseValue > 0) : [] });
  if (target === 'planning') { await api.status('techSpec', spc._id, 'Submitted'); return; }
  await api.status('techSpec', spc._id, 'Submitted', 'Approved');
  // BOM
  const bom = t.records.bom[0];
  await api.put(`/m/bom/${bom._id}`, { bomDate: day(start + 2) });
  await api.status('bom', bom._id, 'Submitted', 'Approved');
  // CAD → pattern → grading → marker
  const pat = await api.post('/m/pattern', { job: jobNo, patternNo: `${spec.styleNo}-P1`, cadSystem: unit === 'U1' ? 'Gerber AccuMark' : 'Lectra Modaris', cadFileName: `${spec.styleNo}_prod_v1.zip`, patternMaker: unit === 'U1' ? 'R. Senthil Kumar' : 'M. Priya', pieceCount: 7, seamAllowanceMm: 10, cadStartDate: day(start), approvalDate: day(start + 6) });
  await api.status('pattern', pat._id, 'Pattern Ready', 'Pattern Approved', 'Graded');
  const pcsPerMarker = spec.ratio.split(',').reduce((a, p) => a + Number(p.split(':')[1]), 0);
  const markerLength = f.unit === 'KG' ? r2((f.consumption * 0.985 * pcsPerMarker * 1000) / (f.width * 0.0254 * f.gsm)) : r2(f.consumption * 0.985 * pcsPerMarker);
  const mk = await api.post('/m/marker', { job: jobNo, markerDate: day(start + 8), markerNo: `${spec.styleNo}-MK1`, ratio: spec.ratio, markerLength, markerLengthUnit: 'Meter', markerWidth: f.width, gsm: f.gsm, unit: f.unit, fabricType: f.fabricType, color: f.color, markerEfficiencyPct: 84 + (pcsPerMarker % 3), plannedPlies: Math.ceil(qty / pcsPerMarker) });
  await api.status('marker', mk._id, 'Submitted', 'Approved');
  // samples, PP meeting, plan
  for (const s of t.records.sample) await api.status('sample', s._id, 'Submitted', 'Buyer Review', 'Approved');
  await api.status('ppMeeting', t.records.ppMeeting[0]._id, 'Held');
  const plan = t.records.productionPlan[0];
  const operators = Math.max(18, Math.round(spec.sam * 3.2));
  const line = `Line ${(counters.line++ % 6) + 1}`;
  await api.put(`/m/productionPlan/${plan._id}`, { floor: 'Floor 1', line, operators, helpers: Math.round(operators / 4), machines: operators + 4, sam: spec.sam, workingMinutes: 480, targetEfficiencyPct: 62, plannedStart: day(ps) });
  await api.status('productionPlan', plan._id, 'Approved', 'Released');
  // fabric: purchase order → roll-wise inward with 4-point inspection → the failed roll back to the supplier with a
  // debit note. Sub jobs received theirs by transfer from the main job forecast (the transfer lot is issued like a roll).
  t = await api.get(`/jobs/track/${jobNo}`);
  const store = {}; // booking id → rolls / transfer lots with the quantity still in store
  const settle = reach(target, 'readyToClose') ? 'Adjusted' : reach(target, 'sewing') ? 'Accepted' : null;
  for (const fb of t.records.fabricBooking) {
    const full = await api.get(`/m/fabricBooking/${fb._id}`);
    const req = full.requiredQty;
    const byTransfer = full.receivedQty > 0;
    const received = byTransfer ? full.receivedQty : r2(req * (spec.partialFabric || 1.012));
    const body = { supplier: ids.suppliers[unit === 'U1' ? 'KPR Mill Ltd' : 'Raymond Woven Fabrics'], supplierPoNo: `${unit}-FPO-${jobNo.split('-').slice(1).join('')}`, bookingDate: day(start + 2), deliveryDate: day(start + 20), bookedQty: byTransfer ? received : Math.ceil(req), rate: f.rate };
    if (byTransfer) {
      await api.put(`/m/fabricBooking/${fb._id}`, { ...body, inspectedQty: received, approvedQty: received });
      await api.status('fabricBooking', fb._id, 'Inspected', 'Approved');
      store[fb._id] = t.records.fabricTransfer.filter((x) => x.toJobNo === jobNo && x.status === 'Completed').map((x) => ({ rollNo: x.refNo, left: x.qty }));
      continue;
    }
    await api.put(`/m/fabricBooking/${fb._id}`, body);
    await api.status('fabricBooking', fb._id, 'Booked', 'In Production');
    if (target === 'fabricPending') continue;
    await api.status('fabricBooking', fb._id, 'In Transit');
    const tag = jobNo.split('-').slice(1).join('');
    const inward = await fabricInward(api, jobNo, { booking: fb._id }, received, f, [`${unit}-L${tag}A`, `${unit}-L${tag}B`], start + 15, counters);
    store[fb._id] = inward.passed;
    const back = await rejectedRollBack(api, jobNo, { booking: fb._id }, inward.rejected, start + 21, settle, counters);
    await supplierBill(api, jobNo, { supplier: body.supplier, billNo: `${unit === 'U1' ? 'KPR' : 'RWF'}/INV/${jobNo.split('-').slice(1).join('')}`, day: start + 19, billType: 'Fabric', fabricBooking: fb._id, poRef: body.supplierPoNo,
      description: `${f.fabricType} ${f.color} – ${received} + rejected roll ${inward.rejected.qty} ${f.unit}`, qty: r2(received + inward.rejected.qty), unit: f.unit, rate: f.rate, setOff: back.setOff, setOffRefs: back.setOff ? back.dn.refNo : '',
      pay: settle === 'Adjusted' ? 'full' : settle ? 'half' : null }, counters);
  }
  const trimBills = {};
  for (const tb of t.records.trimBooking) {
    const full = await api.get(`/m/trimBooking/${tb._id}`);
    const trimSupplier = ['Button', 'Zipper'].includes(full.item) ? 'YKK India' : 'Avery Dennison';
    if (target !== 'fabricPending') (trimBills[trimSupplier] ||= []).push(full);
    const rcv = target === 'fabricPending' ? 0 : full.bookingQty;
    await api.put(`/m/trimBooking/${tb._id}`, { supplier: ids.suppliers[['Button', 'Zipper'].includes(full.item) ? 'YKK India' : 'Avery Dennison'], supplierPoNo: `${unit}-TPO-${jobNo.split('-').slice(1).join('')}`, bookingDate: day(start + 3), deliveryDate: day(start + 18), bookedQty: full.bookingQty, receivedQty: rcv, issuedQty: reach(target, 'cutting') ? rcv : 0, usedQty: reach(target, 'readyToClose') ? rcv : 0 });
    await api.status('trimBooking', tb._id, ...(target === 'fabricPending' ? ['Booked'] : ['Booked', 'In Transit', 'Received', ...(reach(target, 'cutting') ? ['Issued'] : [])]));
  }
  for (const [name, items] of Object.entries(trimBills)) {
    await supplierBill(api, jobNo, { supplier: ids.suppliers[name], billNo: `${name === 'YKK India' ? 'YKK' : 'AVD'}/${jobNo.split('-').slice(1).join('')}`, day: start + 18, billType: 'Trims / Accessories', poRef: `${unit}-TPO-${jobNo.split('-').slice(1).join('')}`,
      description: items.map((x) => `${x.item} ${x.bookingQty} ${x.unit}`).join(', '), qty: 1, unit: 'Lot', rate: r2(items.reduce((s, x) => s + num(x.bookingQty) * num(x.rate), 0)), taxPct: 12,
      pay: reach(target, 'readyToClose') ? 'full' : reach(target, 'sewing') ? 'half' : null }, counters);
  }
  if (target === 'fabricPending') return;
  // cutting (approved marker → lay data pulled), fabric issued to cutting
  const fabs = (await api.get(`/jobs/track/${jobNo}`)).records.fabricBooking;
  const main = await api.get(`/m/fabricBooking/${fabs[0]._id}`);
  const cutTarget = target === 'cutting' ? Math.round(qty * 0.55) : Math.round(qty * 1.015);
  const issue = r2(Math.min(main.approvedQty, cutTarget * f.consumption * (1 + f.wastagePct / 100)));
  // fabric issued roll-wise (or by transfer lot) to the cutting tables
  await issueRolls(api, jobNo, main._id, store[main._id] || [], issue, ps, counters);
  // lays of up to a third of the order; fabric used per lay in proportion, total always within the fabric issued
  const maxPlies = Math.ceil(qty / pcsPerMarker / 3) + 1;
  let cut = 0; let lay = 1; const lays = [];
  while (cut < cutTarget) {
    const plies = Math.min(Math.ceil((cutTarget - cut) / pcsPerMarker), maxPlies);
    const pcs = plies * pcsPerMarker;
    const used = r2((issue * 0.985 * pcs) / (Math.ceil(cutTarget / pcsPerMarker) * pcsPerMarker));
    await api.post('/m/cutting', { job: jobNo, entryDate: day(ps + lay), marker: mk._id, layNo: `L-${String(lay).padStart(2, '0')}`, plies, bundleQty: Math.ceil(pcs / 20), panelQty: pcs * 5, fabricIssued: r2(used * 1.012), fabricUsed: used, rejectQty: Math.round(pcs * 0.002) });
    lays.push({ day: ps + lay, pcs, reject: Math.round(pcs * 0.002) });
    cut += pcs; lay += 1;
  }
  const fc = { unit, jobNo, spec, target, lays, line, operators, day, log, flowLog: counters.flowLog, inspector: unit === 'U1' ? 'QA – V. Arun' : 'QA – D. Meena', counters, pcsPerMarker, r2 };
  if (spec.flow && target === 'cutting') await flowProduction(api, fc);
  if (target === 'cutting') {
    // the next lays' rolls are reserved on the cutting table: held in the store, issued when the lay is spread
    const next = (store[main._id] || []).filter((r) => r.left > 0.0005).slice(0, 3);
    if (next.length) {
      await api.post('/m/fabricAllocation', { job: jobNo, booking: main._id, allocationDate: day(Math.min(ps + lay, 0)), cuttingTable: `Table ${(counters.line % 4) + 1} – lays L-${String(lay).padStart(2, '0')} onward`, rolls: next.map((r) => ({ rollNo: r.rollNo, qty: r.left })), remarks: `Reservation RS-${counters.dc++} – issue when the lay is spread` });
    }
    return;
  }
  // unused end pieces back from cutting to the fabric store (never below the requirement), and the fabric
  // department's debits for the job: accountability for excess wastage / an additional re-processing charge
  const after = await api.get(`/m/fabricBooking/${main._id}`);
  const usedInCutting = r2(issue * 0.985);
  const back = r2(Math.min((issue - usedInCutting) * 0.5, after.netIssuedQty - after.requiredQty));
  if (back > 0.05) {
    const ret = await api.post('/m/fabricReturn', { job: jobNo, booking: main._id, returnType: RETURN_TO_STORE, returnDate: day(ps + lay), referenceDoc: `GP/CUT/${unit}/${counters.dc++}`, rollNos: 'End bits / short lengths after the final lay', qty: back, reason: 'Unused fabric returned after cutting completed' });
    await api.status('fabricReturn', ret._id, 'Accepted');
  }
  if (spec.countAdjust) {
    // physical stock count in the fabric store: difference posted as a stock adjustment
    const now = await api.get(`/m/fabricBooking/${main._id}`);
    const adjQty = r2(spec.countAdjust.type === ADJUST_SHORT ? Math.min(spec.countAdjust.qty, now.balanceQty) : spec.countAdjust.qty);
    if (adjQty > 0) {
      const adj = await api.post('/m/fabricReturn', { job: jobNo, booking: main._id, returnType: spec.countAdjust.type, returnDate: day(ps + lay + 1), referenceDoc: `CNT/${unit}/${counters.dc++}`, rollNos: 'Store count – end bits rack', qty: adjQty, reason: spec.countAdjust.type === ADJUST_SHORT ? 'Physical count below book stock (end-bit wastage)' : 'Physical count above book stock (roll length over-run)' });
      await api.status('fabricReturn', adj._id, 'Accepted');
    }
  }
  const kind = counters.debitKind++ % 3;
  if (kind < 2) {
    const dn = await api.post('/m/fabricDebit', kind === 0
      ? { job: jobNo, booking: main._id, debitDate: day(ps + lay), debitTo: 'Department – accountability', debitParty: 'Cutting', reason: 'Excess cutting wastage', qty: r2(issue * 0.004), remarks: 'End-loss above marker allowance on lays L-01/L-02 – recorded against Cutting' }
      : { job: jobNo, booking: main._id, debitDate: day(ps + lay), debitTo: 'Job – additional charge', reason: 'Re-processing / re-dyeing charges', qty: r2(issue * 0.06), rate: f.unit === 'KG' ? 0.42 : 0.08, remarks: 'Re-compacting of shrinkage-failed rolls before cutting' });
    await api.status('fabricDebit', dn._id, 'Accepted');
  }
  if (spec.flow) return flowTail(api, unit, jobNo, spec, target, ids, counters, fc, { qty, ps, f });
  // sewing – line output day by day at realistic efficiency
  const sewTarget = target === 'sewing' ? Math.round(cut * 0.45) : cut - Math.round(cut * 0.005);
  let sewn = 0; let d = ps + lay + 1;
  while (sewn < sewTarget) {
    const eff = 0.55 + ((d * 7) % 13) / 100;
    const out = Math.min(sewTarget - sewn, Math.round((operators * 480 * eff) / spec.sam));
    const checked = out; const defects = Math.round(out * (0.018 + ((d * 3) % 7) / 1000));
    await api.post('/m/sewing', { job: jobNo, entryDate: day(d), floor: 'Floor 1', line, supervisor: unit === 'U1' ? 'K. Lakshmi' : 'S. Fathima', operators, helpers: Math.round(operators / 4), sam: spec.sam, workingMinutes: 480, inputQty: out + 40, targetQty: Math.round((operators * 480 * 0.62) / spec.sam), manualOutput: out, checkedQty: checked, defects, alteration: Math.round(defects * 0.7), rejection: Math.round(out * 0.004),
      // operator-wise production of the key operations (sewing operators of the unit's workforce)
      operatorOutput: [['F009', 'Shoulder join', 0.6], ['F010', 'Side seam', 1.1], ['F011', 'Bottom hem', 0.8]].map(([code, operation, smv], i) => ({ empCode: `SMP-${unit}-${code}`, operatorName: `Operator ${code}`, operation, smv, pieces: Math.round((480 * (0.62 + i * 0.04)) / smv) })) });
    sewn += out; d += 1;
  }
  // QC: in-line (roving) inspection while the line runs, end-line inspection of the sewn output; the result
  // follows the AQL evaluation of the defects found
  const inspector = unit === 'U1' ? 'QA – V. Arun' : 'QA – D. Meena';
  const qc = async (type, dd, lotSize, defectLines) => {
    const r = await api.post('/m/inspection', { job: jobNo, inspectionDate: day(Math.min(dd, 0)), inspectionType: type, inspector, inspectionAgency: 'In-house QA', lotSize, defectLines });
    await api.status('inspection', r._id, 'Inspection', r.aqlResult === 'Passed' ? 'Passed' : 'Failed');
  };
  await qc('Inline', ps + lay + 2, Math.round(sewn / 2), [{ defectType: 'Broken stitch', severity: 'Major', location: 'Side seam', count: 1 }, { defectType: 'Open seam', severity: 'Major', location: 'Armhole', count: 1 }, { defectType: 'Loose thread', severity: 'Minor', location: 'Hem', count: 3 }, { defectType: 'Uneven hem', severity: 'Minor', location: 'Bottom hem', count: 2 }]);
  if (target === 'sewing') return;
  if (!spec.qualityHold) await qc('End-line', d - 1, sewn, [{ defectType: 'Skip stitch', severity: 'Major', location: 'Shoulder seam', count: 2 }, { defectType: 'Measurement out of tolerance', severity: 'Major', location: 'Body length', count: 1 }, { defectType: 'Loose thread', severity: 'Minor', location: 'Neck', count: 4 }, { defectType: 'Pressing / crease', severity: 'Minor', location: 'Front', count: 2 }]);
  // finishing in two batches: every piece ironed and passed through the needle detector; a detected piece is pulled and rejected
  const finIn = target === 'quality' ? Math.round(sewn * 0.6) : sewn;
  const rej = Math.round(finIn * 0.004);
  const firstIn = Math.round(finIn * 0.55); const firstRej = Math.round(rej * 0.55);
  for (const [i, [input, rj]] of [[firstIn, firstRej], [finIn - firstIn, rej - firstRej]].entries()) {
    const metal = i === 0 && rj > 0 && counters.needle++ % 2 === 0 ? 1 : 0;
    await api.post('/m/finishing', { job: jobNo, entryDate: day(d + i), process: 'All', color: f.color, inputQty: input, passedQty: input - rj, alteration: Math.round(input * 0.01), rework: Math.round(input * 0.006), rejection: rj,
      ironedQty: input, needleCheckedQty: input, needleFailQty: metal, remarks: metal ? 'Broken needle tip found by the detector – piece pulled and rejected; line needle log checked' : '' });
  }
  if (spec.qualityHold) {
    const el = await api.post('/m/inspection', { job: jobNo, inspectionDate: day(Math.min(d + 1, 0)), inspectionType: 'End-line', inspector: 'QA – V. Arun', inspectionAgency: 'In-house QA', lotSize: 315, majorDefects: 14, minorDefects: 19, remarks: 'Open seams at side panel – line stopped for re-training, re-inspection pending' });
    await api.status('inspection', el._id, 'Inspection', 'Failed');
  }
  if (target === 'quality') return;
  // packing – full cartons, never more than ordered
  const ppc = pcsPerMarker * 3;
  const fullCartons = Math.floor(Math.min(finIn - rej, qty) / ppc);
  const pack = async (from, to, dd) => {
    const p = await api.post('/m/packing', { job: jobNo, packingDate: day(dd), packingMethod: 'Solid Color Assorted Size', rows: [{ color: f.color, ratio: spec.ratio.split(',').map((x) => { const [s, q] = x.split(':'); return `${s}:${Number(q) * 3}`; }).join(','), cartonFrom: from, cartonTo: to, pcsPerCarton: ppc, netWtPerCarton: r2(ppc * (f.unit === 'KG' ? f.consumption : 0.2)), grossWtPerCarton: r2(ppc * (f.unit === 'KG' ? f.consumption : 0.2) + 1.1), length: 60, width: 40, height: 30 }],
      warehouse: `${unit === 'U1' ? 'Unit-1' : 'Unit-2'} Finished Goods Warehouse`, location: `Bay ${(counters.cont % 4) + 1} / Rack ${String.fromCharCode(65 + (from % 6))}`, barcodeRange: `SSCC 0089${unit === 'U1' ? 1 : 2}${String(counters.dc).padStart(5, '0')}${String(from).padStart(4, '0')}–${String(to).padStart(4, '0')}` });
    await api.status('packing', p._id, 'Packed', 'Verified');
    return p;
  };
  const finalInspection = async (lotSize, dd) => {
    const fin = await api.post('/m/inspection', { job: jobNo, inspectionDate: day(dd), inspectionType: 'Final', inspector: 'Buyer QA', inspectionAgency: `${spec.buyer} QA`, lotSize, majorDefects: 3, minorDefects: 6 });
    await api.status('inspection', fin._id, 'Inspection', 'Passed', 'Final Approved');
  };
  // finishing complete, packing still running (about 60 %) – finished goods partially packed, nothing shipped
  if (target === 'packingPartial') { await pack(1, Math.floor(fullCartons * 0.6), Math.min(d + 2, -1)); return; }
  if (target === 'partShipped') {
    // first lot packed, inspected and shipped; the balance packed afterwards and waiting for the next vessel
    const first = Math.floor(fullCartons * 0.55);
    const pk1 = await pack(1, first, Math.min(d + 2, -6));
    await finalInspection(pk1.totalQty, Math.min(d + 3, -5));
    const s1 = await api.post('/m/shipment', { job: jobNo, invoiceNo: `${unit}-EXP-${jobNo.split('-').slice(1).join('')}-1`, mode: 'Sea', shipmentDate: day(-3), vesselFlight: 'CMA CGM TIGRIS 0QF6', containerNo: `MSKU${7000000 + counters.cont++}`, portOfLoading: unit === 'U1' ? 'Tuticorin' : 'Chennai', forwarder: 'Maersk Logistics', etd: day(-3) });
    await api.put(`/m/shipment/${s1._id}`, { actualShipDate: day(-3), blAwbNo: `MAEU${240000000 + counters.cont * 17}`, eta: day(25) });
    await api.status('shipment', s1._id, 'Booked', 'Stuffed', 'Shipped');
    const inv = await api.post('/m/invoice', { job: jobNo, shipment: s1._id, invoiceDate: day(-2), dueDate: day(43), otherCharges: 0, discount: 0 });
    await api.status('invoice', inv._id, 'Issued');
    await api.post('/m/payment', { job: jobNo, invoice: inv._id, paymentDate: day(-1), amount: r2(inv.totalAmount * 0.3), mode: 'TT', reference: `TT-${counters.bill++}`, bankCharges: 20 });
    const pk2 = await pack(first + 1, fullCartons, -1);
    await finalInspection(pk2.totalQty, 0);
    // shipment planning: the balance lot is planned on the next sailing – planned, not shipped (finished goods stay in stock)
    await api.post('/m/shipment', { job: jobNo, invoiceNo: `${unit}-EXP-${jobNo.split('-').slice(1).join('')}-2`, mode: 'Sea', shipmentDate: day(spec.shipDays), portOfLoading: unit === 'U1' ? 'Tuticorin' : 'Chennai', forwarder: 'Maersk Logistics', etd: day(spec.shipDays), remarks: 'Balance lot – space requested on the next sailing' });
    return;
  }
  const pk = await pack(1, fullCartons, d + 2);
  await finalInspection(pk.totalQty, d + 3);
  if (target === 'packing') return;
  await shipAndClose(api, unit, jobNo, spec, target, ids, counters, { d, ps, explicit: null });
}

/**
 * Shipment → delivery → documents → invoice → expenses → supplier bills → payment → fabric closure → job closure.
 * `explicit` carries the shipped quantity / cartons for jobs on department flow (only quality-released full cartons ship).
 */
async function shipAndClose(api, unit, jobNo, spec, target, ids, counters, { d, ps, explicit }) {
  // shipment (pulls cartons / weights / CBM from packing)
  const shipDay = Math.min(d + 5, -1); // after packing & final inspection
  const shp = await api.post('/m/shipment', { job: jobNo, invoiceNo: `${unit}-EXP-${jobNo.split('-').slice(1).join('')}`, mode: 'Sea', shipmentDate: day(spec.shipDays), vesselFlight: unit === 'U1' ? 'MAERSK KENSINGTON 241W' : 'CMA CGM TIGRIS 0QF4', containerNo: `MSKU${7000000 + counters.cont++}`, portOfLoading: unit === 'U1' ? 'Tuticorin' : 'Chennai', forwarder: 'Maersk Logistics', etd: day(spec.shipDays), ...(explicit || {}) });
  if (target === 'readyToShip') { await api.status('shipment', shp._id, 'Booked'); return; }
  await api.put(`/m/shipment/${shp._id}`, { actualShipDate: day(shipDay), blAwbNo: `MAEU${240000000 + counters.cont * 17}`, eta: day(shipDay + 28) });
  await api.status('shipment', shp._id, 'Booked', 'Stuffed', 'Shipped');
  if (target === 'shipped') return;
  // buyer confirmed receipt (proof of delivery)
  await api.put(`/m/shipment/${shp._id}`, { deliveredDate: day(Math.min(shipDay + 20, 0)), podRef: `POD/${spec.destination.slice(0, 3).toUpperCase()}/${counters.cont * 31}` });
  await api.status('shipment', shp._id, 'Delivered');
  // documents, invoice, payment, expenses
  for (const docType of ['Commercial Invoice', 'Packing List', 'Bill of Lading (BL)']) {
    const fd = new FormData();
    fd.append('job', jobNo); fd.append('docType', docType); fd.append('title', `${docType} – ${jobNo}`);
    fd.append('file', PDF(`${docType} ${jobNo}`), `${docType.replace(/\W+/g, '_')}_${jobNo}.pdf`);
    await call(unit, 'POST', '/documents', fd);
  }
  const invDay = Math.min(shipDay + 1, 0);
  // a buyer claim is settled as a credit note deducted on the export invoice
  const inv = await api.post('/m/invoice', { job: jobNo, shipment: shp._id, invoiceDate: day(invDay), dueDate: day(shipDay + 46), otherCharges: 0, discount: spec.claim?.amount || 0, remarks: spec.claim ? `Credit note ${unit}-CN-${counters.bill++}: ${spec.claim.reason}` : '' });
  await api.status('invoice', inv._id, 'Issued');
  const SERVICE = { Printing: 'Colour Print Hub', Washing: 'Bright Wash Industries', Embroidery: 'Stitch Art Embroidery' };
  const booked = spec.expenses || [['Sewing / CMT', (spec.costing.sewingCost || 0.5) * 1.02], ['Finishing', spec.costing.finishingCost || 0.1]];
  // department-flow jobs: in-house labour is paid through payroll and allocated from attendance – book outside services only
  for (const [category, perPcCost] of spec.flow ? booked.filter(([c]) => SERVICE[c]) : booked) {
    await api.post('/m/expense', { job: jobNo, category, description: `${category} – ${jobNo}`, expenseDate: day(d), amount: r2(perPcCost * shp.qty), vendor: unit === 'U1' ? 'In-house production' : 'In-house production U2', billNo: `${unit}-${category.slice(0, 3).toUpperCase()}-${counters.bill++}` });
  }
  await api.post('/m/expense', { job: jobNo, category: 'Freight', description: `Ocean freight & CHA – ${shp.invoiceNo}`, expenseDate: day(shipDay), amount: r2(shp.qty * (spec.costing.freightCost || 0.1)), vendor: 'Maersk Logistics', billNo: `ML-${counters.bill++}` });
  await api.post('/m/expense', { job: jobNo, category: 'Testing', description: 'Bulk fabric & garment testing', expenseDate: day(ps - 2), amount: 185, vendor: 'SGS Testing', billNo: `SGS-${counters.bill++}` });
  // supplier bills (payables) for the outside services booked as job expenses above – same amounts, no extra cost
  const payServices = reach(target, 'readyToClose') ? 'full' : null;
  for (const [category, perPcCost] of (spec.expenses || []).filter(([c]) => SERVICE[c])) {
    await supplierBill(api, jobNo, { supplier: ids.suppliers[SERVICE[category]], billNo: `${SERVICE[category].split(' ').map((w) => w[0]).join('')}/${jobNo.split('-').slice(1).join('')}`, day: d, billType: 'Service – Washing / Printing / Embroidery', poRef: `${unit}-SPO-${counters.bill++}`, description: `${category} of ${shp.qty} pcs`, qty: shp.qty, unit: 'Pcs', rate: perPcCost, taxPct: 0, pay: payServices }, counters);
  }
  await supplierBill(api, jobNo, { supplier: ids.suppliers['Maersk Logistics'], billNo: `ML/FRT/${shp.invoiceNo}`, day: shipDay, billType: 'Freight / Logistics', poRef: shp.refNo, description: `Ocean freight & CHA ${shp.invoiceNo}`, qty: shp.qty, unit: 'Pcs', rate: spec.costing.freightCost || 0.1, taxPct: 0, terms: 30, pay: payServices }, counters);
  await supplierBill(api, jobNo, { supplier: ids.suppliers['SGS Testing'], billNo: `SGS/${jobNo}`, day: ps - 2, billType: 'Testing', poRef: 'Test request', description: 'Bulk fabric & garment testing', qty: 1, unit: 'Lot', rate: 185, taxPct: 0, terms: 30, pay: reach(target, 'accountsPending') ? 'full' : null }, counters);
  if (target === 'accountsPending') {
    if (spec.payPart) await api.post('/m/payment', { job: jobNo, invoice: inv._id, paymentDate: day(invDay), amount: r2(inv.totalAmount * spec.payPart), mode: 'TT', reference: `TT-${counters.bill++}`, bankCharges: 25 });
    return;
  }
  await api.post('/m/payment', { job: jobNo, invoice: inv._id, paymentDate: day(Math.max(invDay, Math.min(shipDay + 30, 0))), amount: inv.totalAmount, mode: 'TT', reference: `TT-${counters.bill++}`, bankCharges: 35 });
  // closure: consume fabric & trims, close fabric job, close the job (must be READY – no override)
  for (const fb of (await api.get(`/jobs/track/${jobNo}`)).records.fabricBooking) {
    // fabric issued and not returned is consumed; what came back from cutting stays in store as excess balance
    const full = await api.get(`/m/fabricBooking/${fb._id}`);
    await api.put(`/m/fabricBooking/${fb._id}`, { usedQty: full.netIssuedQty });
    await api.status('fabricBooking', fb._id, 'Fully Consumed');
    const after = await api.get(`/m/fabricBooking/${fb._id}`);
    if (String(after.closureVerdict).startsWith('READY')) await api.status('fabricBooking', fb._id, 'Fabric Job Closed');
  }
  const tr = await api.get(`/jobs/track/${jobNo}`);
  if (!tr.lifecycle.readyToClose) throw new Error(`${jobNo} not ready to close: ${tr.lifecycle.blockers.join('; ')}`);
  if (target === 'readyToClose') return; // every condition met – waiting for the closing sign-off
  await api.post(`/jobs/${tr.job._id}/close`, { remarks: 'All production, shipment, documents and payments complete' });
}

/**
 * Department-flow job after cutting: hourly sheets in every department (sewing and finishing daily entries are
 * consolidated from them), QC at each stage with rework, packing list = carton packing, pre-shipment release, shipment.
 */
async function flowTail(api, unit, jobNo, spec, target, ids, counters, fc, { qty, ps }) {
  const { S, lastDay } = await flowProduction(api, fc);
  if (['sewing', 'quality'].includes(target)) return;
  const d = lastDay + 1;
  if (target === 'packingPartial') {
    if (S['Carton/Box Packing'].out) await flowPackingList(api, fc, S, Math.min(d, 0));
    return;
  }
  const { ppc, fullCartons } = await flowPackingList(api, fc, S, Math.min(d, 0));
  const fg = S['Finished Goods Inward'].out;
  // only full cartons of the order ship; any surplus stays in finished goods
  const shipCartons = Math.min(fullCartons, Math.floor(qty / ppc));
  const shipQty = shipCartons * ppc;
  const ctx = { ...fc, day };
  if (target === 'partShipped') {
    const first = Math.floor(shipCartons * 0.55);
    await preShipment(api, ctx, first * ppc, Math.min(d + 1, -4));
    const s1 = await api.post('/m/shipment', { job: jobNo, invoiceNo: `${unit}-EXP-${jobNo.split('-').slice(1).join('')}-1`, mode: 'Sea', shipmentDate: day(-3), qty: first * ppc, cartons: first, vesselFlight: 'CMA CGM TIGRIS 0QF6', containerNo: `MSKU${7000000 + counters.cont++}`, portOfLoading: unit === 'U1' ? 'Tuticorin' : 'Chennai', forwarder: 'Maersk Logistics', etd: day(-3) });
    await api.put(`/m/shipment/${s1._id}`, { actualShipDate: day(-3), blAwbNo: `MAEU${240000000 + counters.cont * 17}`, eta: day(25) });
    await api.status('shipment', s1._id, 'Booked', 'Stuffed', 'Shipped');
    const inv = await api.post('/m/invoice', { job: jobNo, shipment: s1._id, invoiceDate: day(-2), dueDate: day(43), otherCharges: 0, discount: 0 });
    await api.status('invoice', inv._id, 'Issued');
    await api.post('/m/payment', { job: jobNo, invoice: inv._id, paymentDate: day(-1), amount: r2(inv.totalAmount * 0.3), mode: 'TT', reference: `TT-${counters.bill++}`, bankCharges: 20 });
    // the balance is released by pre-shipment inspection and planned on the next sailing
    await preShipment(api, ctx, fg - first * ppc, 0);
    const s2 = await api.post('/m/shipment', { job: jobNo, invoiceNo: `${unit}-EXP-${jobNo.split('-').slice(1).join('')}-2`, mode: 'Sea', shipmentDate: day(spec.shipDays), qty: shipQty - first * ppc, cartons: shipCartons - first, portOfLoading: unit === 'U1' ? 'Tuticorin' : 'Chennai', forwarder: 'Maersk Logistics', etd: day(spec.shipDays), remarks: 'Balance lot – space requested on the next sailing' });
    counters.plannedFlowShipment = { id: s2._id, jobNo };
    return;
  }
  await preShipment(api, ctx, fg, Math.min(d + 1, -2));
  if (target === 'packing') return;
  if (target === 'readyToShip') {
    const shp = await api.post('/m/shipment', { job: jobNo, invoiceNo: `${unit}-EXP-${jobNo.split('-').slice(1).join('')}`, mode: 'Sea', shipmentDate: day(spec.shipDays), qty: shipQty, cartons: shipCartons, vesselFlight: unit === 'U1' ? 'MAERSK KENSINGTON 241W' : 'CMA CGM TIGRIS 0QF4', containerNo: `MSKU${7000000 + counters.cont++}`, portOfLoading: unit === 'U1' ? 'Tuticorin' : 'Chennai', forwarder: 'Maersk Logistics', etd: day(spec.shipDays) });
    await api.status('shipment', shp._id, 'Booked');
    return;
  }
  counters.flowShipped = counters.flowShipped || [];
  counters.flowShipped.push({ jobNo, day: Math.min(d + 5, -1) });
  await shipAndClose(api, unit, jobNo, spec, target, ids, counters, { d: Math.min(d, -4), ps, explicit: { qty: shipQty, cartons: shipCartons } });
}

/* --------------------------- forecast main job: forecast → receipt → transfers → sub jobs --------------------------- */
async function runForecastJob(api, unit, job, spec, ids, counters, crossUnit) {
  const t = await api.get(`/jobs/track/${job.jobNo}`);
  const ff = t.records.fabricForecast[0];
  const plan = spec.forecastPlan;
  // bulk fabric purchased on the main job: roll-wise inward against the forecast, the failed roll back with a debit note
  await api.put(`/m/fabricForecast/${ff._id}`, { supplier: ids.suppliers[plan.supplier], supplierPoNo: plan.supplierPoNo, poDate: day(spec.orderDays + 1), requiredDate: day(spec.orderDays + 15), remarks: `Bulk ${spec.fabric.fabricType} for ${spec.poNo} call-offs` });
  await api.status('fabricForecast', ff._id, 'Confirmed');
  const inward = await fabricInward(api, job.jobNo, { forecast: ff._id }, plan.received, spec.fabric, [plan.lotNo, `${plan.lotNo}-2`], plan.receivedDays - 3, counters);
  await api.status('fabricForecast', ff._id, 'Received');
  const back = await rejectedRollBack(api, job.jobNo, { forecast: ff._id }, inward.rejected, plan.receivedDays + 1, 'Adjusted', counters);
  await supplierBill(api, job.jobNo, { supplier: ids.suppliers[plan.supplier], billNo: `${plan.supplierPoNo}/INV`, day: plan.receivedDays, billType: 'Fabric', poRef: plan.supplierPoNo,
    description: `Bulk ${spec.fabric.fabricType} ${spec.fabric.color} for call-offs (forecast ${ff.refNo})`, qty: r2(plan.received + inward.rejected.qty), unit: spec.fabric.unit, rate: spec.fabric.rate,
    setOff: back.setOff, setOffRefs: back.dn.refNo, pay: 'full' }, counters);
  const subs = [];
  for (const [n, s] of spec.subJobs.entries()) {
    const ft = await api.post('/m/fabricTransfer', { job: job.jobNo, sourceForecast: ff._id, qty: s.fabric, transferDate: day(s.day), toUnit: unit, createSubJob: true, subJobQty: s.qty, subJobShipmentDate: day(s.ship), reason: 'New production requirement', referenceDoc: s.ref, remarks: `Call-off ${n + 1} of ${spec.poNo}` });
    await api.status('fabricTransfer', ft._id, 'Approved', 'Completed');
    const done = await api.get(`/m/fabricTransfer/${ft._id}`);
    // the call-off's own PO, colour, size ratio and delivery (the transfer creates the sub job from the main job)
    const subJob = (await api.get(`/jobs/track/${done.toJobNo}`)).job;
    const ratio = spec.ratio.split(',').map((x) => { const [size, q] = x.split(':'); return [size, Number(q)]; });
    const per = s.qty / ratio.reduce((a, [, q]) => a + q, 0);
    await api.put(`/jobs/${subJob._id}`, {
      poNo: s.poNo, colors: [s.color], fabricColor: s.color, deliveryDate: day(s.ship + 21), sizes: spec.sizes,
      sizeBreakdown: ratio.map(([size, q]) => ({ color: s.color, size, qty: Math.round(per * q) })),
      _revisionReason: `Call-off PO ${s.poNo} received (${s.ref})`,
    });
    subs.push({ ...s, jobNo: done.toJobNo, transfer: done.refNo });
  }
  if (crossUnit) {
    const ft = await api.post('/m/fabricTransfer', { job: job.jobNo, sourceForecast: ff._id, qty: crossUnit.qty, transferDate: day(crossUnit.day), toUnit: crossUnit.toUnit, toJobNo: crossUnit.toJobNo, reason: 'Shortage cover', referenceDoc: crossUnit.ref, remarks: 'Same navy single jersey lot – covers cutting shortage in Unit-2' });
    await api.status('fabricTransfer', ft._id, 'Approved', 'Completed');
  }
  for (const s of subs) {
    const sub = { ...spec, orderDays: s.day, shipDays: s.ship, qty: s.qty, flow: s.flow ?? spec.flow };
    await runJob(api, unit, s.jobNo, sub, s.stage, ids, counters);
  }
  if (spec.closeMain) {
    // every call-off closed and the forecast fabric fully allocated → close the forecast, then the main job
    const fc = await api.get(`/m/fabricForecast/${ff._id}`);
    if (Math.abs(fc.balanceQty) > 0.001) throw new Error(`${job.jobNo}: forecast balance ${fc.balanceQty} ${fc.unit} left – cannot close`);
    await api.status('fabricForecast', ff._id, 'Allocated', 'Closed');
    const tr = await api.get(`/jobs/track/${job.jobNo}`);
    if (!tr.lifecycle.readyToClose) throw new Error(`${job.jobNo} not ready to close: ${tr.lifecycle.blockers.join('; ')}`);
    await api.post(`/jobs/${tr.job._id}/close`, { remarks: 'All call-off sub jobs closed, forecast fabric fully allocated' });
  }
  return subs;
}

/**
 * Sample department users (one per role / unit, one multi-unit) with a per-user grant and a revoke, to show
 * roles, unit scoping and permissions. They are created INACTIVE with a random password nobody knows, so
 * they cannot sign in until an Admin activates them and resets the password. Existing users are never changed.
 */
const SAMPLE_USERS = [
  ['Anjali Menon', 'Head Office Merchandising', ['U1']], ['Ravi Shankar', 'Fabric Department', ['U1']], ['Lakshmi Narayanan', 'Production', ['U1']],
  ['Vignesh Arun', 'Quality', ['U1'], { grant: { fabricReceipt: ['view'] } }], ['Divya Raman', 'Factory Merchandising', ['U2']], ['Sathish Kumar', 'Fabric Department', ['U2']],
  ['Meena Devi', 'Production', ['U2'], { revoke: { sewing: ['delete'] } }], ['Karthik Raja', 'Shipment / Documentation', ['U2']], ['Priya Venkatesh', 'Accounts & Finance', ['U1', 'U2']],
];
async function sampleUsers(api) {
  const roles = await api.get('/admin/roles');
  const have = new Set((await api.get('/admin/users')).rows.map((u) => u.email));
  let n = 0;
  for (const [name, roleName, units, extra = {}] of SAMPLE_USERS) {
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}@sample-users.stitchflow.test`;
    const role = (roles.rows || roles).find((r) => r.name === roleName);
    if (have.has(email) || !role) continue;
    const password = `Smp-${crypto.randomUUID()}-Aa1!`;
    const u = await api.post('/admin/users', { name: `${name} (sample)`, email, password, role: role._id, units, permissions: extra.grant, revoked: extra.revoke });
    await api.put(`/admin/users/${u._id}`, { isActive: false });
    n += 1;
  }
  if (n) log(`  ${n} sample users added (inactive – an Admin activates them and resets the password before use)`);
}

async function buildDataset() {
  const counters = { line: 0, cont: 1, bill: 1001, dc: 501, debitKind: 0, needle: 0 };
  const ids = { buyers: {}, suppliers: {}, createdMasters: { buyer: [], supplier: [], master: [], employee: [] } };
  const u1 = U('U1'); const u2 = U('U2');
  // masters (shared by both units): reuse existing, add missing realistic ones
  for (const b of BUYERS) {
    const found = (await u1.get(`/m/buyer?q=${encodeURIComponent(b.name)}`)).rows.find((x) => x.name === b.name);
    if (!found) ids.createdMasters.buyer.push((ids.buyers[b.name] = (await u1.post('/m/buyer', b))._id));
    else ids.buyers[b.name] = found._id;
    // buyer contacts only where the buyer has none (existing buyer data is never overwritten)
    const cur = await u1.get(`/m/buyer/${ids.buyers[b.name]}`);
    const contacts = (CONTACTS[b.name] || []).map(([name, role]) => ({ name, role, email: `${name.split(' ')[0].toLowerCase()}@${b.code.toLowerCase()}-sample.test`, phone: '' }));
    if (!(cur.contacts || []).length && contacts.length) await u1.put(`/m/buyer/${cur._id}`, { contacts, contactPerson: cur.contactPerson || contacts[0].name, email: cur.email || contacts[0].email });
  }
  for (const s of SUPPLIERS) {
    const found = (await u1.get(`/m/supplier?q=${encodeURIComponent(s.name)}`)).rows.find((x) => x.name === s.name);
    if (!found) ids.createdMasters.supplier.push((ids.suppliers[s.name] = (await u1.post('/m/supplier', s))._id));
    else ids.suppliers[s.name] = found._id;
  }
  // master data used by the dataset (styles, costing templates, shipment methods…) – added only when missing
  for (const [masterType, name] of MASTER_SAMPLES) {
    if ((await u1.get(`/m/master?q=${encodeURIComponent(name)}`)).rows.some((m) => m.masterType === masterType && m.name === name)) continue;
    ids.createdMasters.master.push((await u1.post('/m/master', { masterType, name, code: name.slice(0, 12).toUpperCase(), remarks: 'Sample / Test data' }))._id);
  }
  // sample employees per unit (codes SMP-U1-… / SMP-U2-…), added only when missing
  for (const unit of ['U1', 'U2']) {
    const api = unit === 'U1' ? u1 : u2;
    const have = new Set((await api.get('/m/employee?q=SMP-&limit=500')).rows.map((e) => e.empCode));
    for (const [n, name, department, designation, line, skillGrade, isOperator] of EMPLOYEES) {
      const empCode = `SMP-${unit}-${n}`;
      if (have.has(empCode)) continue;
      ids.createdMasters.employee.push((await api.post('/m/employee', { empCode, name: unit === 'U1' ? name : name.replace(/^(\w)\. /, 'T. '), department, designation, line, skillGrade, isOperator, joinDate: day(-900 + Number(n) * 37), workingDays: 26, presentDays: 23 + (Number(n) % 4) }))._id);
    }
  }
  await sampleUsers(u1);
  // factory set-up: routing & QC checkpoints (shared), the workforce of each unit
  await configureQuality(u1, ids);
  const staff = { U1: await ensureWorkforce(u1, 'U1', day, ids.createdMasters.employee), U2: await ensureWorkforce(u2, 'U2', day, ids.createdMasters.employee) };
  counters.flowLog = [];
  const created = { U1: [], U2: [] };
  // orders in each unit, in series order
  for (const unit of ['U1', 'U2']) {
    const api = unit === 'U1' ? u1 : u2;
    for (const spec of JOBS[unit]) {
      const job = await confirmOrder(api, spec, ids);
      created[unit].push({ spec, job });
      log(`  ${unit} ${job.jobNo}  ${spec.buyer} · ${spec.styleNo} · ${spec.qty} pcs${spec.forecast ? ' (main / continuous)' : ` → ${spec.stage}`}`);
    }
  }
  // Unit-2 regular jobs first (the cross-unit transfer needs the Unit-2 lounge tee job)
  for (const { spec, job } of created.U2.filter((x) => !x.spec.forecast)) await runJob(u2, 'U2', job.jobNo, spec, spec.stage, ids, counters);
  for (const { spec, job } of created.U2.filter((x) => x.spec.hold)) await u2.post(`/jobs/${job._id}/status`, { status: 'On Hold', reason: spec.hold });
  const u2Lounge = created.U2.find((x) => x.spec.key === 'U2-LOUNGE').job.jobNo;
  for (const { spec, job } of created.U1.filter((x) => !x.spec.forecast)) await runJob(u1, 'U1', job.jobNo, spec, spec.stage, ids, counters);
  for (const { spec, job } of created.U1.filter((x) => x.spec.hold)) await u1.post(`/jobs/${job._id}/status`, { status: 'On Hold', reason: spec.hold });
  const main1 = created.U1.find((x) => x.spec.forecast);
  const subs1 = await runForecastJob(u1, 'U1', main1.job, main1.spec, ids, counters, { qty: 300, day: -20, toUnit: 'U2', toJobNo: u2Lounge, ref: 'IUT/2026/014 inter-unit transfer note' });
  const main2 = created.U2.find((x) => x.spec.forecast);
  const subs2 = await runForecastJob(u2, 'U2', main2.job, main2.spec, ids, counters);
  // repeat buyers: advance jobs for next month's orders, opened before the buyer PO exists
  const jobNoOf = (unit, key) => created[unit].find((x) => x.spec.key === key)?.job.jobNo;
  const advance = { U1: [], U2: [] };
  for (const unit of ['U1', 'U2']) {
    const api = unit === 'U1' ? u1 : u2;
    for (const adv of ADVANCE[unit]) {
      // same style, fabric, trims and costing basis as the previous order (its own new quotation)
      const OWN = ['key', 'poNo', 'stage', 'forecast', 'forecastPlan', 'subJobs', 'closeMain', 'expenses', 'payFull', 'payPart', 'partialFabric', 'hold', 'claim'];
      const base = Object.fromEntries(Object.entries(JOBS[unit].find((s) => s.key === adv.fabricOf)).filter(([k]) => !OWN.includes(k)));
      const spec = { ...base, ...adv, repeatOfJobNo: jobNoOf(unit, adv.repeatOf) };
      const job = await confirmOrder(api, spec, ids);
      log(`  ${unit} ${job.jobNo}  ${spec.buyer} · ${spec.styleNo} · forecast ${spec.qty} pcs – ADVANCE job, repeat of ${spec.repeatOfJobNo}, awaiting PO (expected ${spec.expectedOrderMonth})`);
      advance[unit].push({ spec, job });
    }
  }
  for (const unit of ['U1', 'U2']) {
    const api = unit === 'U1' ? u1 : u2;
    for (const { spec, job } of advance[unit]) {
      const ratio = spec.ratio.split(',').map((x) => { const [size, q] = x.split(':'); return [size, Number(q)]; });
      const breakdown = (qty, color) => ratio.map(([size, q]) => ({ color, size, qty: Math.round((qty * q) / ratio.reduce((t, [, w]) => t + w, 0)) }));
      if (!spec.subJobs) { await runJob(api, unit, job.jobNo, spec, spec.stage, ids, counters); continue; }
      // bulk fabric forecast confirmed with the mill for the coming call-offs
      const ff = (await api.get(`/jobs/track/${job.jobNo}`)).records.fabricForecast[0];
      await api.put(`/m/fabricForecast/${ff._id}`, { supplier: ids.suppliers[unit === 'U1' ? 'Pioneer Knit Fabrics' : 'Arvind Mills'], supplierPoNo: `${unit}/FC/${spec.expectedOrderMonth}`, poDate: day(spec.orderDays + 1), requiredDate: day(spec.orderDays + 25), remarks: `Forecast fabric for ${spec.buyer} ${spec.expectedOrderMonth} call-offs (advance job)` });
      await api.status('fabricForecast', ff._id, 'Confirmed');
      const subs = await api.post(`/jobs/${job._id}/subjobs`, { subJobs: spec.subJobs.map((s) => ({ orderQty: s.qty, orderDate: day(spec.orderDays), shipmentDate: day(s.ship), deliveryDate: day(s.ship + 21), colors: [spec.fabric.color], sizeBreakdown: breakdown(s.qty, spec.fabric.color) })) });
      for (const [i, s] of spec.subJobs.entries()) {
        const sub = subs[i];
        const po = s.callOff || s.pendingPo;
        if (po) {
          const bo = await api.post('/m/buyerOrder', {
            orderType: 'Forecast Call-off', buyer: ids.buyers[spec.buyer], poNo: po.poNo, styleNo: spec.styleNo, product: spec.product, garmentType: spec.garmentType,
            orderDate: day(po.orderDays), deliveryDate: day(s.ship + 21), shipmentDate: day(s.ship), orderQty: s.qty, unitPrice: spec.price, currency: 'USD',
            color: po.color, sizeRatio: spec.ratio, destination: spec.destination, repeatOfJobNo: spec.repeatOfJobNo, remarks: `Call-off for advance job ${job.jobNo} – Sample / Test data`,
          });
          if (s.callOff) await api.post(`/jobs/${sub._id}/link-po`, { buyerOrder: bo._id });
        }
        log(`      ${sub.jobNo} ${s.qty} pcs${s.callOff ? ` – actual PO ${s.callOff.poNo} linked` : s.pendingPo ? ` – PO ${s.pendingPo.poNo} received, not linked yet` : ' – awaiting PO'}`);
        if (s.stage) await runJob(api, unit, sub.jobNo, { ...spec, orderDays: spec.orderDays, shipDays: s.ship, qty: s.qty }, s.stage, ids, counters);
      }
    }
  }
  // order amendment: the buyer raised the quantity and moved the delivery (an order revision with its reason)
  const shorts = created.U1.find((x) => x.spec.key === 'U1-SHORTS').job;
  await u1.put(`/jobs/${shorts._id}`, {
    orderQty: 8400, shipmentDate: day(77), deliveryDate: day(98),
    sizeBreakdown: [['4Y', 1680], ['6Y', 2520], ['8Y', 2520], ['10Y', 1680]].map(([size, qty]) => ({ color: 'Coral', size, qty })),
    _revisionReason: 'Buyer amendment KK-62004 A1: +400 pcs, delivery moved one week (Sample / Test data)',
  });
  log(`  U1 ${shorts.jobNo} amended: 8000 → 8400 pcs, delivery +7 days (order revision)`);
  // cancellations: an order cancelled by the buyer after confirmation, and a PO cancelled before a job was opened
  for (const [unit, api, baseKey, over, why] of [
    ['U1', u1, 'U1-TANK', { styleNo: 'PCA-CR-12', product: "Women's Cropped Tee", poNo: 'PCA-PO-30811', qty: 3000, orderDays: -16, shipDays: 70 }, 'Buyer cancelled the style – collection dropped (cancellation letter PCA/CXL/118)'],
    ['U2', u2, 'U2-FLANNEL', { styleNo: 'HO-OS-221', product: "Men's Flannel Shirt Jacket", poNo: 'HOG-4491-26', qty: 1500, orderDays: -14, shipDays: 90 }, 'Buyer cancelled before production – line merged into HO-OS-220 (mail 02-Oct)'],
  ]) {
    const { key, stage, hold, ...base } = JOBS[unit].find((x) => x.key === baseKey);
    const job = await confirmOrder(api, { ...base, ...over }, ids);
    await api.post(`/jobs/${job._id}/status`, { status: 'Cancelled', reason: why });
    log(`  ${unit} ${job.jobNo}  ${base.buyer} · ${over.styleNo} – CANCELLED (${why.split(' – ')[0]})`);
  }
  const cxl = await u2.post('/m/buyerOrder', { orderType: 'New Order', buyer: ids.buyers['Sakura Lifestyle KK'], poNo: 'SLK-24-5799', styleNo: 'SL-SK-120', product: "Women's Pleated Skirt", garmentType: 'Skirt', orderDate: day(-6), deliveryDate: day(110), shipmentDate: day(89), orderQty: 1800, unitPrice: 11.2, currency: 'USD', color: 'Navy', sizeRatio: 'XS:2,S:3,M:3,L:2', destination: 'Yokohama', remarks: 'Sample / Test data' });
  await u2.post(`/m/buyerOrder/${cxl._id}/status`, { status: 'Cancelled', reason: 'Buyer withdrew the PO before costing was agreed' });
  log(`  U2 Buyer PO ${cxl.poNo} received and cancelled before job creation`);
  // buyer POs received today / this week and not yet converted into jobs
  for (const unit of ['U1', 'U2']) {
    const api = unit === 'U1' ? u1 : u2;
    for (const o of NEW_ORDERS[unit]) {
      const bo = await api.post('/m/buyerOrder', {
        orderType: o.orderType, buyer: ids.buyers[o.buyer], poNo: o.poNo, styleNo: o.styleNo, product: o.product, garmentType: o.garmentType,
        orderDate: day(o.orderDays), deliveryDate: day(o.deliveryDays), shipmentDate: day(o.deliveryDays - 21), orderQty: o.qty, unitPrice: o.unitPrice, currency: 'USD',
        color: o.color, sizeRatio: o.sizeRatio, destination: o.destination, repeatOfJobNo: o.repeatOf ? jobNoOf(unit, o.repeatOf) : undefined, remarks: 'Sample / Test data',
      });
      if (o.review) await api.status('buyerOrder', bo._id, 'Under Review');
      log(`  ${unit} New order ${bo.refNo}  ${o.buyer} PO ${o.poNo} · ${o.styleNo} · ${o.qty} pcs (${o.orderType}) – awaiting job creation`);
    }
  }
  // in-house fabric stock chain per unit: yarn inward → knitting (grey) → dyeing / compacting (finished fabric)
  for (const [unit, api] of [['U1', u1], ['U2', u2]]) {
    const n = await fabricStockChain(api, unit, ids, day, {
      knit: unit === 'U1' ? created.U1.find((x) => x.spec.key === 'U1-HENLEY').job.jobNo : created.U2.find((x) => x.spec.key === 'U2-LOUNGE').job.jobNo,
      next: unit === 'U1' ? created.U1.find((x) => x.spec.key === 'U1-SHORTS').job.jobNo : null,
    });
    log(`  ${unit} fabric stock chain: ${n} yarn / knitting / processing records`);
  }
  // HR: daily attendance for the production window, payroll for every month that has ended; factory expenses
  log('  Attendance, payroll and factory expenses…');
  const factory = { attendance: 0, payrolls: [], expenses: [] };
  for (const unit of ['U1', 'U2']) {
    const api = unit === 'U1' ? u1 : u2;
    factory.attendance += await attendanceSheets(api, unit, staff[unit], counters.flowLog, FACTORY_FROM, day, counters);
    factory.payrolls.push(...await payrolls(api, unit, FACTORY_FROM, day, TODAY));
    // third-party pre-shipment inspection of an open job (a closed job takes no new costs), outsourced repair of held goods
    const inspected = unit === 'U1' ? created.U1.find((x) => x.spec.key === 'U1-HOODIE')?.job.jobNo : subs2[1]?.jobNo;
    const held = unit === 'U1' ? created.U1.find((x) => x.spec.key === 'U1-SWEAT')?.job.jobNo : null;
    factory.expenses.push(...await factoryExpenses(api, unit, day, TODAY, { inspected: inspected ? { jobNo: inspected, day: -5 } : null, repaired: held ? { jobNo: held, day: -3 } : null }));
  }
  log(`    ${factory.attendance} attendance sheets, ${factory.payrolls.length} payroll runs, ${factory.expenses.length} factory expenses`);
  // the rules must refuse wrong entries
  const henley = created.U1.find((x) => x.spec.key === 'U1-HENLEY').job.jobNo;
  const anySheet = (await u1.get(`/m/hourlyProduction?status=Approved&job=${henley}&limit=1`)).rows[0];
  const att = (await u1.get('/m/attendance?limit=1')).rows[0];
  const pay = factory.payrolls.find((x) => x.businessUnit === 'U1');
  const exp = factory.expenses.find((x) => x.businessUnit === 'U1' && x.referenceNo);
  const sweat = created.U1.find((x) => x.spec.key === 'U1-SWEAT')?.job.jobNo;
  let holdShipment = null;
  if (sweat) holdShipment = (await u1.post('/m/shipment', { job: sweat, invoiceNo: `U1-EXP-HOLD-TEST`, mode: 'Sea', shipmentDate: day(9), qty: 3000, remarks: 'Planned – blocked until quality releases the goods (Sample / Test data)' }))._id;
  factory.negative = await negativeTests(u1, {
    jobNo: anySheet?.jobNo, sheet: anySheet, day, payroll: pay, expense: exp, attendance: att, heldJob: advance.U1.find((x) => x.spec.subJobs)?.job.jobNo,
    labourExpense: pay ? { jobNo: created.U1.find((x) => x.spec.key === 'U1-HENLEY').job.jobNo, date: `${pay.period}-15` } : null, holdShipment,
  });
  factory.negative.forEach((t) => log(`    ${t.ok ? 'OK  ' : 'FAIL'} ${t.test}${t.ok ? '' : ` – ${t.got}`}`));
  // company-level finance lines for EBITDA (per unit, last 3 months)
  for (const [unit, api, scale] of [['U1', u1, 1], ['U2', u2, 0.8]]) {
    for (const m of [-60, -30, -2]) {
      for (const [category, amount, vendor] of [['Admin Expense', 1250, 'Office & admin'], ['Interest', 420, 'Bank – working capital loan'], ['Tax', 380, 'Advance tax'], ['Depreciation', 210, 'Office equipment & vehicle depreciation'], ['Amortization', 120, 'CAD software licence']]) {
        await api.post('/m/expense', { category, description: `${category} – ${unit} monthly`, expenseDate: day(m), amount: r2(amount * scale), vendor, billNo: `${unit}-GL-${counters.bill++}` });
      }
    }
  }
  return { created, subs1, subs2, advance, createdMasters: ids.createdMasters, factory };
}

/** Flag everything this run created as Sample / Test data (masters it added too – they are never removed). */
async function markSample(startedAt, createdMasters) {
  let n = 0;
  for (const k of TX_MODULES) n += (await models[k].updateMany({ createdAt: { $gte: startedAt }, isSampleData: { $ne: true } }, { $set: SAMPLE })).modifiedCount;
  for (const [k, list] of Object.entries(createdMasters)) if (list.length) await models[k].updateMany({ _id: { $in: list } }, { $set: SAMPLE });
  // the dataset is built in one run "today": give its order revisions and shipping documents the business dates
  // they belong to (the call-off PO date / the shipment), so the job history reads in real order
  for (const j of await models.orders.find({ createdAt: { $gte: startedAt }, 'revisions.0': { $exists: true } }).lean()) {
    const bo = await models.buyerOrder.findOne({ job: j._id, isDeleted: false }).lean();
    await models.orders.collection.updateOne({ _id: j._id }, { $set: { 'revisions.$[].at': bo?.orderDate || j.orderDate } });
  }
  for (const d of await DocumentFile.find({ createdAt: { $gte: startedAt } }).lean()) {
    const s = await models.shipment.findOne({ job: d.job, isDeleted: false, status: 'Shipped' }).sort({ actualShipDate: -1 }).lean();
    if (s?.actualShipDate) await DocumentFile.collection.updateOne({ _id: d._id }, { $set: { createdAt: new Date(s.actualShipDate.getTime() + 86400000), uploadedAt: new Date(s.actualShipDate.getTime() + 86400000) } });
  }
  log(`Flagged ${n} new transaction records (and ${Object.values(createdMasters).flat().length} new master / employee records) as Sample / Test data.`);
}

/* ============================== 5. Validation ============================== */
async function validate(keepBefore, startedAt) {
  const issues = [];
  const jobs = await models.orders.find({ isDeleted: false }).lean();
  const byId = new Map(jobs.map((j) => [String(j._id), j]));
  const dup = jobs.map((j) => j.jobNo).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) issues.push(`Duplicate job numbers: ${dup.join(', ')}`);
  jobs.forEach((j) => {
    const series = j.businessUnit === 'U1' ? /^U1-1\d{3}(-S\d{2})?$/ : /^U2-3\d{3}(-S\d{2})?$/;
    if (!series.test(j.jobNo)) issues.push(`Job ${j.jobNo} (${j.businessUnit}) outside its unit series`);
    if (!j.buyer || !j.orderNo || (!j.poNo && j.poStatus !== 'Awaiting PO') || !j.styleNo) issues.push(`Job ${j.jobNo} missing buyer / order / PO / style`);
    if (j.parentJob) {
      const p = byId.get(String(j.parentJob));
      if (!p || !j.jobNo.startsWith(`${p.jobNo}-S`) || p.businessUnit !== j.businessUnit) issues.push(`Sub job ${j.jobNo} has a wrong main job`);
    }
  });
  // every transaction (job-linked or company-level) carries its unit
  for (const k of TX_MODULES) {
    const n = await models[k].countDocuments({ businessUnit: { $nin: ['U1', 'U2'] } });
    if (n) issues.push(`${n} ${k} record(s) without a valid Unit ID`);
  }
  for (const [k, M] of Object.entries({ stockmovements: StockMovement, documentfiles: DocumentFile })) {
    const n = await M.countDocuments({ businessUnit: { $nin: ['U1', 'U2'] } });
    if (n) issues.push(`${n} ${k} record(s) without a valid Unit ID`);
  }
  const subNos = jobs.filter((j) => j.parentJob).map((j) => j.jobNo);
  if (new Set(subNos).size !== subNos.length) issues.push('Duplicate sub job numbers');
  let checked = 0;
  for (const def of MODULE_LIST.filter((d) => d.jobLinked)) {
    const rows = await models[def.key].find({ isDeleted: false }).lean();
    for (const r of rows) {
      checked += 1;
      if (!r.job) { if (def.jobLinked === true) issues.push(`${def.key} ${r.refNo} has no job`); continue; }
      const j = byId.get(String(r.job));
      if (!j) issues.push(`Orphan ${def.key} ${r.refNo} → missing job`);
      else if (j.businessUnit !== r.businessUnit) issues.push(`${def.key} ${r.refNo} unit ${r.businessUnit} ≠ job ${j.jobNo} unit ${j.businessUnit}`);
      else if (r.jobNo !== j.jobNo) issues.push(`${def.key} ${r.refNo} job no ${r.jobNo} ≠ ${j.jobNo}`);
      for (const f of def.fields.filter((x) => x.type === 'ref' && r[x.name])) {
        const target = MODULE_LIST.find((m) => m.model === f.ref)?.key || (f.ref === 'Job' ? 'orders' : null);
        if (target && !(await models[target].exists({ _id: r[f.name] }))) issues.push(`${def.key} ${r.refNo}.${f.name} → broken reference`);
      }
    }
  }
  for (const t of await models.fabricTransfer.find({ isDeleted: false }).lean()) {
    const f = await models.fabricForecast.findById(t.sourceForecast).lean();
    if (!f || String(f.job) !== String(t.job)) issues.push(`Transfer ${t.refNo}: source forecast not on the source job`);
    if (t.status === 'Completed') {
      const dest = byId.get(String(t.toJob));
      if (!dest) issues.push(`Transfer ${t.refNo}: destination job missing`);
      else if (t.createSubJob && String(dest.parentJob) !== String(t.job)) issues.push(`Transfer ${t.refNo}: sub job ${dest.jobNo} not under ${t.jobNo}`);
      else if (dest.businessUnit !== t.toUnit) issues.push(`Transfer ${t.refNo}: destination unit mismatch`);
    }
  }
  for (const s of await models.shipment.find({ isDeleted: false }).lean()) if (!(await models.packing.exists({ job: s.job, isDeleted: false }))) issues.push(`Shipment ${s.refNo} without packing`);
  for (const i of await models.invoice.find({ isDeleted: false }).lean()) {
    const s = i.shipment && await models.shipment.findById(i.shipment).lean();
    if (!s || String(s.job) !== String(i.job)) issues.push(`Invoice ${i.invoiceNo} not linked to its job's shipment`);
  }
  for (const p of await models.payment.find({ isDeleted: false }).lean()) {
    const i = await models.invoice.findById(p.invoice).lean();
    if (!i || String(i.job) !== String(p.job)) issues.push(`Payment ${p.refNo} invoice / job mismatch`);
  }
  for (const c of await models.cutting.find({ isDeleted: false }).lean()) if (!(await models.fabricBooking.exists({ job: c.job, issuedQty: { $gt: 0 } }))) issues.push(`Cutting ${c.refNo} without fabric issued to its job`);
  const graphs = await loadJobGraphs(jobs);
  const profits = [];
  for (const g of graphs) {
    const p = computeProfit(g);
    profits.push({ jobNo: g.job.jobNo, p });
    if (g.job.status === 'Closed') {
      const lc = await computeStages({ ...g, job: { ...g.job, status: 'In Progress' } });
      if (lc.blockers.length) issues.push(`Closed job ${g.job.jobNo} has open conditions: ${lc.blockers.join('; ')}`);
    }
  }
  // buyer POs (New Orders): converted / linked ones point at a job of the same unit, buyer and PO
  for (const b of await models.buyerOrder.find({ isDeleted: false }).lean()) {
    const j = b.jobNo && jobs.find((x) => x.jobNo === b.jobNo);
    if (['Job Created', 'Linked to Job'].includes(b.status)) {
      if (!j) issues.push(`Buyer order ${b.refNo} (${b.status}) → job ${b.jobNo} missing`);
      else if (j.businessUnit !== b.businessUnit || String(j.buyer) !== String(b.buyer) || j.poNo !== b.poNo) issues.push(`Buyer order ${b.refNo} PO ${b.poNo} ≠ job ${j.jobNo} (unit / buyer / PO)`);
    } else if (b.jobNo) issues.push(`Buyer order ${b.refNo} is ${b.status} but carries job ${b.jobNo}`);
  }
  // forecast quantities are never shipped, invoiced or closed as confirmed orders
  for (const j of jobs.filter((x) => x.poStatus === 'Awaiting PO')) {
    if (j.poNo && !j.parentJob) issues.push(`Advance job ${j.jobNo} carries a PO No while awaiting its PO`);
    if (await models.shipment.exists({ job: j._id, isDeleted: false })) issues.push(`Advance job ${j.jobNo} (awaiting PO) has a shipment`);
    if (await models.invoice.exists({ job: j._id, isDeleted: false })) issues.push(`Advance job ${j.jobNo} (awaiting PO) has an invoice`);
    if (j.status === 'Closed') issues.push(`Advance job ${j.jobNo} closed without a PO`);
  }
  // quantities reconcile along the chain, and accounts with the shipments
  for (const g of graphs.filter((x) => !x.subJobs.length)) {
    const q = { cut: sum(g.cutting, 'cutQty'), sewn: sum(g.sewing, 'actualQty'), fin: sum(g.finishing, 'passedQty'), packed: sum(g.packing, 'totalQty'), shipped: sum(g.shipments.filter((s) => ['Shipped', 'Delivered'].includes(s.status)), 'qty') };
    if (q.sewn > q.cut || q.fin > q.sewn || q.packed > q.fin || q.shipped > q.packed) issues.push(`${g.job.jobNo}: quantities out of order ${JSON.stringify(q)}`);
    if (q.shipped > num(g.job.orderQty)) issues.push(`${g.job.jobNo}: shipped ${q.shipped} > ordered ${g.job.orderQty}`);
    const invQty = sum(g.invoices, 'qty');
    if (invQty > q.shipped) issues.push(`${g.job.jobNo}: invoiced ${invQty} pcs > shipped ${q.shipped}`);
    for (const i of g.invoices) {
      const paid = sum(g.payments.filter((p) => String(p.invoice) === String(i._id)), 'amount');
      if (paid > num(i.totalAmount) + 0.01) issues.push(`${g.job.jobNo}: invoice ${i.invoiceNo} paid ${paid} > ${i.totalAmount}`);
      if (Math.abs(num(i.outstanding) - (num(i.totalAmount) - paid)) > 0.01) issues.push(`${g.job.jobNo}: invoice ${i.invoiceNo} outstanding ${i.outstanding} ≠ ${round(num(i.totalAmount) - paid)}`);
    }
    const p = computeProfit(g);
    if (Math.abs(p.revenue - (sum(g.invoices, 'totalAmount') || q.shipped * num(g.job.unitPrice))) > 0.01) issues.push(`${g.job.jobNo}: profit revenue ${p.revenue} ≠ invoices`);
  }
  // payables: bill arithmetic, set-offs tie to adjusted supplier debit notes, deliveries carry their confirmation
  for (const b of await models.supplierBill.find({ isDeleted: false }).lean()) {
    if (Math.abs(num(b.outstanding) - (num(b.totalAmount) - num(b.debitNoteAdjusted) - num(b.paidAmount))) > 0.01 || num(b.outstanding) < -0.01) issues.push(`Supplier bill ${b.billNo}: outstanding ${b.outstanding} does not reconcile`);
    if (num(b.debitNoteAdjusted) > 0) {
      const dn = await models.fabricDebit.findOne({ refNo: b.debitNoteRefs, isDeleted: false }).lean();
      if (!dn || dn.status !== 'Adjusted' || Math.abs(num(dn.amount) - num(b.debitNoteAdjusted)) > 0.01) issues.push(`Supplier bill ${b.billNo}: set-off ${b.debitNoteAdjusted} ≠ adjusted debit note ${b.debitNoteRefs}`);
    }
  }
  for (const s of await models.shipment.find({ isDeleted: false, status: 'Delivered' }).lean()) if (!s.deliveredDate || !s.podRef) issues.push(`Shipment ${s.refNo} delivered without date / proof of delivery`);
  // everything this run created is marked as Sample / Test data
  if (startedAt) {
    for (const k of TX_MODULES) {
      const n = await models[k].countDocuments({ createdAt: { $gte: startedAt }, isSampleData: { $ne: true } });
      if (n) issues.push(`${n} new ${k} record(s) not flagged as sample data`);
    }
  }
  const keepAfter = { users: await User.countDocuments(), roles: await Role.countDocuments(), master: await models.master.countDocuments(), employee: await models.employee.countDocuments() };
  ['users', 'roles', 'master', 'employee'].forEach((k) => { if (keepAfter[k] < keepBefore[k]) issues.push(`${k} reduced from ${keepBefore[k]} to ${keepAfter[k]}`); });
  return { issues, checked, profits };
}

/* ============================== 6. API checks: unit dashboards, reports, analytics, Job 360 ============================== */
async function apiChecks() {
  const issues = []; const out = {};
  const PREFIX = { U1: 'U1-', U2: 'U2-' };
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const rowsOf = (r) => (Array.isArray(r) ? r : r.rows || []);
  const period = `from=${day(-180)}&to=${day(0)}`;
  const seenAll = {};
  for (const unit of ['U1', 'U2']) {
    const api = U(unit); const other = unit === 'U1' ? 'U2' : 'U1';
    // unit dashboard: only this unit's jobs, counts match the database
    const dash = await api.get('/dashboard');
    const listed = Object.values(dash.lists).flat().map((x) => x?.jobNo).filter(Boolean);
    const leak = listed.filter((n) => !n.startsWith(PREFIX[unit]));
    if (leak.length) issues.push(`${unit} dashboard lists other-unit jobs: ${[...new Set(leak)].join(', ')}`);
    const dbJobs = await models.orders.find({ businessUnit: unit, isDeleted: false }).lean();
    const dbActive = dbJobs.filter((j) => !(j.isForecast && Number(j.subJobCount) > 0) && !['Closed', 'Cancelled'].includes(j.status)).length;
    if (dash.summary.activeJobs !== dbActive) issues.push(`${unit} dashboard active jobs ${dash.summary.activeJobs} ≠ database ${dbActive}`);
    // reports: unit-scoped, and the job filter narrows to one job
    for (const key of ['job-closure', 'accounts', 'sales']) {
      const rows = rowsOf(await api.get(`/reports/${key}`));
      const bad = rows.filter((x) => x.jobNo && !x.jobNo.startsWith(PREFIX[unit]));
      if (bad.length) issues.push(`${unit} report ${key} shows ${bad.length} other-unit row(s)`);
      if (!rows.length) issues.push(`${unit} report ${key} is empty`);
    }
    const oneJob = unit === 'U1' ? 'U1-1001' : 'U2-3001';
    const byJob = rowsOf(await api.get(`/reports/sales?job=${oneJob}`));
    if (!byJob.length || byJob.some((x) => x.jobNo !== oneJob)) issues.push(`${unit} sales report filter jobNo=${oneJob} returned ${byJob.map((x) => x.jobNo).join(', ') || 'nothing'}`);
    // management analytics on the new data
    const a = await api.get(`/analytics/summary?${period}`);
    const fin = a.finance; const inv = a.inventory;
    ['revenue', 'cogs', 'grossProfit', 'ebitda', 'netProfit'].forEach((k) => { if (!finite(fin[k])) issues.push(`${unit} analytics ${k} = ${fin[k]}`); });
    if (!(fin.revenue > 0)) issues.push(`${unit} analytics revenue is 0`);
    if (!finite(inv.itr)) issues.push(`${unit} ITR = ${inv.itr}`);
    if (inv.holdingDays !== null && !finite(inv.holdingDays)) issues.push(`${unit} holding days = ${inv.holdingDays}`);
    if (!finite(a.roi.roiPct)) issues.push(`${unit} ROI = ${a.roi.roiPct}`);
    // main job dashboard: all sub jobs with their own figures; main closes only after every sub job
    const mainNo = unit === 'U1' ? 'U1-1000' : 'U2-3000';
    const m = await api.get(`/jobs/track/${mainNo}`);
    if (m.subJobSummary.length !== 3) issues.push(`${mainNo} shows ${m.subJobSummary.length} sub jobs, expected 3`);
    m.subJobSummary.forEach((x, i) => { if (x.jobNo !== `${mainNo}-S${String(i + 1).padStart(2, '0')}`) issues.push(`${mainNo} sub job ${i + 1} numbered ${x.jobNo}`); });
    const subsClosed = m.subJobSummary.every((x) => x.status === 'Closed');
    if ((m.job.status === 'Closed') !== subsClosed) issues.push(`${mainNo} is ${m.job.status} while all sub jobs closed = ${subsClosed}`);
    if (!subsClosed && !m.lifecycle.blockers.some((b) => b.includes('Sub job'))) issues.push(`${mainNo}: open sub jobs do not block main job closure`);
    if (m.subJobSummary.some((x) => x.status === 'Closed' && !(x.shippedQty > 0 && x.revenue > 0))) issues.push(`${mainNo}: a closed sub job has no shipment / revenue`);
    // the other unit's jobs cannot be opened from this unit
    const foreign = other === 'U1' ? 'U1-1000' : 'U2-3000';
    const peek = await fetch(`${BASE}/jobs/track/${foreign}`, { headers: { Authorization: `Bearer ${tokens[unit]}` } });
    if (peek.ok) issues.push(`${unit} can open ${foreign} of ${other}`);
    // order & job tracking: unit-only rows, counts = lists, quantities reconcile with the database
    const t = await api.get('/tracking');
    const allRows = [...Object.values(t.lists).flat(), ...t.mainJobs];
    const foreignRows = allRows.filter((x) => x.unit !== unit || (x.jobNo && !x.jobNo.startsWith(PREFIX[unit])));
    if (foreignRows.length) issues.push(`${unit} tracking shows ${foreignRows.length} other-unit row(s)`);
    TRACKING_LISTS.forEach((l) => { if (t.counts[l.key] !== t.lists[l.key].length) issues.push(`${unit} tracking ${l.key} count ${t.counts[l.key]} ≠ ${t.lists[l.key].length} rows`); });
    const tol = 1 - 3 / 100;
    const dbGraphs = await loadJobGraphs(dbJobs.filter((j) => !(j.isForecast && Number(j.subJobCount) > 0)));
    const shippedOf = (g) => sum(g.shipments.filter((s) => ['Shipped', 'Delivered'].includes(s.status)), 'qty');
    for (const g of dbGraphs) {
      const j = g.job; const qty = num(j.orderQty);
      const shipped = shippedOf(g); const finished = sum(g.finishing, 'passedQty'); const packed = sum(g.packing.filter((p) => p.status !== 'Draft'), 'totalQty');
      const row = t.lists.unfinished.concat(t.lists.finishedPendingShipment, t.lists.partiallyShipped, t.lists.fullyShipped, t.lists.closedSubJobs, t.lists.subJobsReadyForClosure, t.lists.pendingPo).find((x) => x.jobNo === j.jobNo);
      if (row && (row.shippedQty !== shipped || row.balanceToShip !== Math.max(qty - shipped, 0) || row.packedQty !== packed || row.pendingQty !== Math.max(qty - packed, 0))) issues.push(`${j.jobNo}: tracking quantities ≠ transactions (shipped ${row.shippedQty}/${shipped}, packed ${row.packedQty}/${packed})`);
      const fgPending = !['Closed', 'Cancelled'].includes(j.status) && j.poStatus !== 'Awaiting PO' && finished >= qty * tol && shipped < qty * tol;
      const inFg = t.lists.finishedPendingShipment.some((x) => x.jobNo === j.jobNo);
      if (fgPending !== inFg) issues.push(`${j.jobNo}: finished-not-shipped list ${inFg ? 'includes' : 'misses'} it (finished ${finished}, shipped ${shipped} of ${qty})`);
      if (shipped >= qty * tol && !t.lists.fullyShipped.some((x) => x.jobNo === j.jobNo)) issues.push(`${j.jobNo}: fully shipped but not in the fully shipped list`);
      if (shipped > 0 && shipped < qty * tol && !t.lists.partiallyShipped.some((x) => x.jobNo === j.jobNo)) issues.push(`${j.jobNo}: partially shipped but not listed`);
    }
    if (t.lists.finishedPendingShipment.some((x) => x.fullyShipped)) issues.push(`${unit}: a fully shipped job is listed as pending shipment`);
    if (t.lists.finishedPendingShipment.some((x) => x.packedQty > 0 && (!x.fgLocation || !x.delayReason))) issues.push(`${unit}: finished goods pending shipment without warehouse location / delay reason`);
    if (t.lists.onHold.some((x) => !x.holdReason || !x.responsibleDept)) issues.push(`${unit}: a held job has no reason / responsible department`);
    if (t.lists.advanceAwaitingPo.some((x) => x.poStatus !== 'Awaiting PO')) issues.push(`${unit}: a PO-backed job is listed as awaiting PO`);
    if (t.lists.awaitingJob.some((x) => x.jobNo)) issues.push(`${unit}: an order with a job is listed as awaiting job creation`);
    if (t.counts.newOrders !== await models.buyerOrder.countDocuments({ businessUnit: unit, isDeleted: false })) issues.push(`${unit}: new orders count ≠ buyer orders`);
    // forecast quantities are not confirmed orders: dashboard order value only counts PO-backed jobs
    const confirmedValue = round(sum(dbJobs.filter((j) => !(j.isForecast && Number(j.subJobCount) > 0) && j.status !== 'Cancelled' && j.poStatus !== 'Awaiting PO'), 'orderValue'));
    if (Math.abs(dash.summary.expectedRevenue - confirmedValue) > 1) issues.push(`${unit} dashboard expected revenue ${dash.summary.expectedRevenue} ≠ PO-backed order value ${confirmedValue}`);
    // filters: buyer, main job (incl. sub jobs), stage
    const someBuyer = t.lists.unfinished[0]?.buyerName;
    if (someBuyer) {
      const fb = await api.get(`/tracking?buyer=${encodeURIComponent(someBuyer)}`);
      if (Object.values(fb.lists).flat().some((x) => x.buyerName !== someBuyer)) issues.push(`${unit} tracking buyer filter leaks other buyers`);
    }
    const fm = await api.get(`/tracking?jobNo=${mainNo}`);
    if (!fm.mainJobs.length && !fm.lists.closedSubJobs.length && !fm.lists.unfinished.length) issues.push(`${unit} tracking job filter ${mainNo} returned nothing`);
    if (Object.values(fm.lists).flat().some((x) => x.jobNo && (x.mainJobNo || x.jobNo.split('-').slice(0, 2).join('-')) !== mainNo && x.repeatOfJobNo !== mainNo)) issues.push(`${unit} tracking job filter ${mainNo} returned other jobs`);
    const fs2 = await api.get('/tracking?stage=fabric');
    if (fs2.lists.unfinished.some((x) => x.pendingStage !== 'fabric')) issues.push(`${unit} tracking stage filter returned other stages`);
    const xl = await fetch(`${BASE}/tracking/export?list=finishedPendingShipment&format=xlsx`, { headers: { Authorization: `Bearer ${tokens[unit]}` } });
    if (!xl.ok || !String(xl.headers.get('content-type')).includes('spreadsheet')) issues.push(`${unit} tracking Excel export failed (${xl.status})`);
    // an advance job cannot be shipped before its PO
    const adv = t.lists.advanceAwaitingPo.find((x) => !x.isMain);
    if (adv) {
      const blocked = await fetch(`${BASE}/m/shipment`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[unit]}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ job: adv.jobNo, mode: 'Sea', qty: 10, shipmentDate: day(30) }) });
      if (blocked.ok) issues.push(`${unit}: shipment accepted on advance job ${adv.jobNo} awaiting PO`);
    }
    // Job Closure Report: every main job (with its sub jobs) reconciles, and every transaction is in a report
    const seen = {};
    for (const mj of dbJobs.filter((j) => !j.parentJob)) {
      const cr = await api.get(`/jobs/${mj.jobNo}/closure-report`);
      if (!cr.checksPassed) issues.push(`${mj.jobNo} closure report: ${cr.jobs.flatMap((x) => x.checks.filter((c) => !c.ok && !c.info).map((c) => `${x.jobNo} ${c.label} (${c.expected} vs ${c.actual})`)).join('; ')}`);
      cr.subJobs.filter((s) => !cr.rows.some((r) => r.jobNo === s)).forEach((s) => issues.push(`${mj.jobNo} closure report has no rows for sub job ${s}`));
      if (cr.rows.some((r) => !String(r.jobNo).startsWith(mj.jobNo))) issues.push(`${mj.jobNo} closure report lists another job's transactions`);
      cr.rows.forEach((r) => { if (r.recordId) { (seen[r.module] ||= new Set()).add(String(r.recordId)); (seenAll[r.module] ||= new Set()).add(String(r.recordId)); } });
      if (mj.jobNo === mainNo) out[`${unit} ${mainNo} closure report`] = `${cr.rows.length} transactions; ${cr.jobs.map((x) => `${x.jobNo}: ${x.transactions} tx, fabric rcvd ${x.fabric.received} / issued ${x.fabric.issued} / ret ${x.fabric.returnedFromCutting + x.fabric.returnedToSupplier} / bal ${x.fabric.storeBalance}, shipped ${x.production.shipped}, cost ${x.accounts?.cost} revenue ${x.accounts?.revenue} profit ${x.accounts?.profit}, debit notes ${x.debits.count}`).join(' | ')}`;
    }
    for (const k of ['fabricForecast', 'fabricBooking', 'fabricReceipt', 'fabricAllocation', 'fabricReturn', 'fabricDebit', 'fabricTransfer', 'trimBooking', 'supplierBill', 'expense', 'cutting', 'sewing', 'finishing', 'inspection', 'packing', 'shipment', 'invoice', 'payment']) {
      const ids = (await models[k].find({ businessUnit: unit, isDeleted: false }).select('_id job').lean()).filter((x) => x.job).map((x) => String(x._id));
      // a transfer to the other unit appears in the receiving job's report (checked across both units below)
      const missing = ids.filter((id) => !seen[k]?.has(id) && k !== 'fabricTransfer');
      if (missing.length) issues.push(`${unit}: ${missing.length} ${k} transaction(s) missing from the job closure reports`);
    }
    out[`${unit} tracking`] =Object.entries(t.counts).map(([k, n]) => `${k} ${n}`).join(', ');
    out[unit] = {
      activeJobs: dash.summary.activeJobs, revenue: fin.revenue, cogs: fin.cogs, ebitda: fin.ebitda, ebitdaMarginPct: fin.ebitdaMarginPct,
      netProfit: fin.netProfit, itr: inv.itr, holdingDays: inv.holdingDays, roiPct: a.roi.roiPct,
      [mainNo]: `${m.job.status}; ${m.subJobSummary.map((x) => `${x.jobNo} ${x.status} shipped ${x.shippedQty}/${x.orderQty} profit ${x.profit ?? '-'}`).join('; ')}`,
    };
  }
  const transfers = await models.fabricTransfer.find({ isDeleted: false, status: 'Completed' }).select('_id refNo').lean();
  const lostTransfers = transfers.filter((t) => !seenAll.fabricTransfer?.has(String(t._id)));
  if (lostTransfers.length) issues.push(`Fabric transfers missing from every job closure report: ${lostTransfers.map((t) => t.refNo).join(', ')}`);
  // consolidated = Unit-1 + Unit-2
  const all = await U('U1').get(`/analytics/summary?unit=ALL&${period}`);
  if (Math.abs(all.finance.revenue - out.U1.revenue - out.U2.revenue) > 1) issues.push(`Consolidated revenue ${all.finance.revenue} ≠ U1 ${out.U1.revenue} + U2 ${out.U2.revenue}`);
  out.ALL = { revenue: all.finance.revenue, ebitda: all.finance.ebitda };
  // consolidated tracking = Unit-1 + Unit-2, and every one of the 15 lists has sample rows to test with
  const tAll = await U('U1').get('/tracking?unit=ALL');
  const t1 = await U('U1').get('/tracking'); const t2 = await U('U2').get('/tracking');
  TRACKING_LISTS.forEach((l) => {
    if (tAll.counts[l.key] !== t1.counts[l.key] + t2.counts[l.key]) issues.push(`Consolidated ${l.key} ${tAll.counts[l.key]} ≠ U1 ${t1.counts[l.key]} + U2 ${t2.counts[l.key]}`);
    if (!tAll.counts[l.key]) issues.push(`Tracking list "${l.title}" has no sample rows`);
  });
  if (!tAll.mainJobs.length) issues.push('Main Job dashboard is empty');
  // Report Center versions of the tracking lists filter by unit / buyer / PO / job
  const rep = await U('U2').get('/reports/finished-not-shipped');
  if (!rep.rows.length || rep.rows.some((x) => !x.jobNo.startsWith('U2-'))) issues.push('Report finished-not-shipped (U2) empty or mixed units');
  const repPo = await U('U2').get('/reports/pending-po-unfinished?po=BM-PO');
  if (repPo.rows.some((x) => !String(x.poNo).includes('BM-PO'))) issues.push('Report PO filter returned other POs');
  return { issues, out };
}

/* ============================== 7. Workflow rules: closure, stock ledger, reservations, QC, revenue buckets ============================== */
async function workflowChecks() {
  const issues = []; const out = {};
  const raw = async (unit, method, p, body) => {
    const res = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${tokens[unit]}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const jobs = await models.orders.find({ isDeleted: false }).lean();
  // open transactions prevent closure: a job with money / fabric / sub jobs open is refused without an override reason
  const refusals = [];
  for (const j of jobs.filter((x) => !['Closed', 'Cancelled'].includes(x.status) && !x.readyToClose)) {
    const r = await raw(j.businessUnit, 'POST', `/jobs/${j._id}/close`, { remarks: 'validation – must be refused' });
    const after = await models.orders.findById(j._id).lean();
    if (r.status !== 400 || r.body?.details?.code !== 'OVERRIDE_REQUIRED' || after.status === 'Closed') issues.push(`${j.jobNo}: closing with open items returned ${r.status} (${after.status}) – expected a refusal`);
    else refusals.push(`${j.jobNo}: ${(r.body.details.blockers || []).slice(0, 2).join('; ')}`);
  }
  for (const [mainNo, hint] of [['U2-3000', 'Sub job'], ['U1-1002', 'Payment']]) {
    const j = jobs.find((x) => x.jobNo === mainNo);
    if (j && !refusals.some((x) => x.startsWith(`${mainNo}:`) && x.includes(hint))) issues.push(`${mainNo}: closure refusal does not name "${hint}" (${refusals.find((x) => x.startsWith(`${mainNo}:`)) || 'not refused'})`);
  }
  out['Closure refused while open'] = `${refusals.length} jobs, e.g. ${refusals.filter((x) => /^(U1-1002|U2-3000|U2-3003):/.test(x)).join(' | ')}`;
  // the dated stock ledger reconciles with every booking / forecast: in − out = store balance
  const led = await StockMovement.aggregate([{ $match: { module: { $in: ['fabricBooking', 'fabricForecast'] } } }, { $group: { _id: { r: '$recordId', d: '$direction' }, q: { $sum: '$qty' } } }]);
  const ledger = (id, dir) => num(led.find((x) => String(x._id.r) === String(id) && x._id.d === dir)?.q);
  let ledgerRows = 0;
  for (const b of await models.fabricBooking.find({ isDeleted: false }).lean()) {
    ledgerRows += 1;
    if (Math.abs(ledger(b._id, 'in') - num(b.netReceivedQty)) > 0.002 || Math.abs(ledger(b._id, 'out') - num(b.netIssuedQty)) > 0.002 || Math.abs(ledger(b._id, 'in') - ledger(b._id, 'out') - num(b.balanceQty)) > 0.002) {
      issues.push(`Stock ledger ${b.refNo} (${b.jobNo}): in ${round(ledger(b._id, 'in'), 3)} / out ${round(ledger(b._id, 'out'), 3)} ≠ net received ${b.netReceivedQty} / net issued ${b.netIssuedQty} / balance ${b.balanceQty}`);
    }
    // reservations are held, not issued
    const allocs = await models.fabricAllocation.find({ booking: b._id, isDeleted: false, status: { $ne: 'Cancelled' } }).lean();
    const reserved = round(sum(allocs.filter((a) => a.status === 'Allocated'), 'totalQty'), 3);
    if (Math.abs(num(b.reservedQty) - reserved) > 0.002) issues.push(`${b.refNo}: reserved ${b.reservedQty} ≠ open reservations ${reserved}`);
    if (allocs.length && Math.abs(num(b.issuedQty) - sum(allocs.filter((a) => a.status === 'Issued to Cutting'), 'totalQty')) > 0.002) issues.push(`${b.refNo}: issued ${b.issuedQty} ≠ allocations issued to cutting`);
    if (num(b.freeQty) < -0.002) issues.push(`${b.refNo}: reservations exceed the store balance (free ${b.freeQty})`);
  }
  for (const f of await models.fabricForecast.find({ isDeleted: false }).lean()) {
    ledgerRows += 1;
    if (Math.abs(ledger(f._id, 'in') - ledger(f._id, 'out') - num(f.balanceQty)) > 0.002) issues.push(`Stock ledger ${f.refNo} (${f.jobNo}): in − out ${round(ledger(f._id, 'in') - ledger(f._id, 'out'), 3)} ≠ forecast balance ${f.balanceQty}`);
  }
  out['Stock ledger reconciled'] = `${ledgerRows} fabric bookings / forecasts`;
  const reservations = await models.fabricAllocation.find({ isDeleted: false, status: 'Allocated' }).lean();
  if (!reservations.length) issues.push('No open fabric reservation in the sample data');
  for (const a of reservations) {
    const j = jobs.find((x) => String(x._id) === String(a.job));
    const t = await U(j.businessUnit).get(`/jobs/track/${j.jobNo}`);
    if (!t.lifecycle.blockers.some((x) => x.includes(a.refNo))) issues.push(`${j.jobNo}: open reservation ${a.refNo} does not block closure`);
    const cr = await U(j.businessUnit).get(`/jobs/${j.jobNo}/closure-report`);
    if (!cr.rows.some((r) => r.txType === 'Fabric Reservation' && String(r.recordId) === String(a._id))) issues.push(`${j.jobNo}: reservation ${a.refNo} missing from the closure report`);
    if (!cr.jobs.some((x) => x.openItems.some((o) => o.ref === a.refNo))) issues.push(`${j.jobNo}: reservation ${a.refNo} not listed as an open item`);
  }
  out['Fabric reservations'] = reservations.map((a) => `${a.refNo} ${a.jobNo} ${a.totalQty} ${a.unit}`).join(', ');
  // finishing: ironing and needle detection on every piece; detected pieces never pass
  const fin = await models.finishing.find({ isDeleted: false }).lean();
  fin.forEach((f) => {
    if (num(f.needleFailQty) > num(f.rejection) + num(f.rework) || (num(f.needleCheckedQty) && num(f.passedQty) > num(f.needleCheckedQty) - num(f.needleFailQty))) issues.push(`Finishing ${f.refNo}: a metal-detected piece passed`);
  });
  if (!fin.some((f) => num(f.needleFailQty) > 0)) issues.push('No needle-detection finding in the sample data');
  out['Needle detection'] = `${sum(fin, 'needleCheckedQty')} pcs checked, ${sum(fin, 'needleFailQty')} pulled; ironed ${sum(fin, 'ironedQty')}`;
  // QC: every job past sewing has in-line, end-line and (once packed) final inspection records
  for (const j of jobs) {
    const ins = await models.inspection.find({ job: j._id, isDeleted: false }).lean();
    const sewn = await models.sewing.exists({ job: j._id, isDeleted: false });
    const finished = await models.finishing.exists({ job: j._id, isDeleted: false });
    const packed = await models.packing.exists({ job: j._id, isDeleted: false, status: { $ne: 'Draft' } });
    const has = (t) => ins.some((i) => i.inspectionType === t);
    if (sewn && !has('Inline')) issues.push(`${j.jobNo}: sewing without in-line inspection`);
    if (finished && !has('End-line')) issues.push(`${j.jobNo}: finishing without end-line inspection`);
    if (await models.shipment.exists({ job: j._id, isDeleted: false, status: { $in: ['Shipped', 'Delivered'] } }) && !ins.some((i) => i.inspectionType === 'Final' && ['Passed', 'Final Approved'].includes(i.status))) issues.push(`${j.jobNo}: shipped without a passed final inspection`);
    void packed;
  }
  // shipment planning: a planned shipment is not a shipment – its goods stay in finished goods pending shipment
  const planned = await models.shipment.find({ isDeleted: false, status: 'Planned' }).lean();
  if (!planned.length) issues.push('No planned shipment in the sample data');
  for (const s of planned) {
    const t = await U(s.businessUnit).get('/tracking');
    const row = t.lists.finishedPendingShipment.find((x) => x.jobNo === s.jobNo);
    const shipped = sum(await models.shipment.find({ job: s.job, isDeleted: false, status: { $in: ['Shipped', 'Delivered'] } }).lean(), 'qty');
    if (!row || row.shippedQty !== shipped) issues.push(`${s.jobNo}: planned shipment ${s.refNo} counted as shipped or missing from finished goods pending shipment`);
    const before = await models.shipment.findOne({ job: s.job, isDeleted: false, _id: { $ne: s._id } }).lean();
    if (before && num(s.cartons) + num(before.cartons) > sum(await models.packing.find({ job: s.job, isDeleted: false }).lean(), 'totalCartons')) issues.push(`${s.jobNo}: shipments carry more cartons than were packed`);
  }
  out['Planned shipments'] = planned.map((s) => `${s.refNo} ${s.jobNo} ${s.qty} pcs ETD ${new Date(s.etd || s.shipmentDate).toISOString().slice(0, 10)}`).join(', ');
  // forecast value, confirmed order value, invoiced revenue and received payments are separate figures
  for (const unit of ['U1', 'U2']) {
    const d = await U(unit).get('/dashboard');
    const leaf = jobs.filter((j) => j.businessUnit === unit && !(j.isForecast && num(j.subJobCount) > 0) && j.status !== 'Cancelled');
    const fv = round(sum(leaf.filter((j) => j.poStatus === 'Awaiting PO'), 'orderValue'));
    const cv = round(sum(leaf.filter((j) => j.poStatus !== 'Awaiting PO'), 'orderValue'));
    const invs = await models.invoice.find({ businessUnit: unit, isDeleted: false }).lean();
    const pays = await models.payment.find({ businessUnit: unit, isDeleted: false }).lean();
    if (Math.abs(d.summary.forecastValue - fv) > 1) issues.push(`${unit}: forecast value ${d.summary.forecastValue} ≠ advance jobs ${fv}`);
    if (Math.abs(d.summary.expectedRevenue - cv) > 1) issues.push(`${unit}: confirmed order value ${d.summary.expectedRevenue} ≠ PO-backed jobs ${cv}`);
    if (Math.abs(d.kpis.accounts.receivable - round(sum(invs, 'totalAmount'))) > 1) issues.push(`${unit}: invoiced ${d.kpis.accounts.receivable} ≠ invoices`);
    if (Math.abs(d.kpis.accounts.received - round(sum(pays, 'amount'))) > 1) issues.push(`${unit}: received ${d.kpis.accounts.received} ≠ payments`);
    if (d.kpis.accounts.received > d.kpis.accounts.receivable + 0.01) issues.push(`${unit}: received more than invoiced`);
    out[`${unit} revenue buckets`] = `forecast ${d.summary.forecastValue} | confirmed orders ${d.summary.expectedRevenue} | invoiced ${d.kpis.accounts.receivable} | received ${d.kpis.accounts.received} | outstanding ${d.kpis.accounts.outstanding}`;
  }
  // buyer claims reduce the invoice (credit note) and therefore revenue – never paid in excess
  const claims = await models.invoice.find({ isDeleted: false, discount: { $gt: 0 } }).lean();
  if (!claims.length) issues.push('No buyer claim / credit note in the sample data');
  claims.forEach((i) => { if (Math.abs(num(i.totalAmount) - (num(i.grossAmount) - num(i.discount) + num(i.otherCharges))) > 0.01) issues.push(`Invoice ${i.invoiceNo}: claim not deducted`); });
  // holds carry a reason and the responsible department (fabric, trims, quality, approval, capacity)
  const held = [];
  for (const unit of ['U1', 'U2']) held.push(...(await U(unit).get('/tracking')).lists.onHold.map((x) => `${x.jobNo} → ${x.responsibleDept}`));
  ['Quality', 'Factory Merchandising', 'Head Office Merchandising', 'Production'].forEach((dept) => { if (!held.some((h) => h.endsWith(dept))) issues.push(`No held job for ${dept}`); });
  out['Held / blocked jobs'] = held.join(', ');
  // sample users: inactive, scoped to units, role-based, with a per-user grant and a revoke
  const su = await User.find({ email: /@sample-users\.stitchflow\.test$/ }).lean();
  if (su.length !== SAMPLE_USERS.length) issues.push(`Sample users ${su.length} ≠ ${SAMPLE_USERS.length}`);
  if (su.some((u) => u.isActive)) issues.push('An active sample user exists – sample users must stay inactive');
  out['Sample users'] = `${su.length} (inactive), units ${[...new Set(su.flatMap((u) => u.units || []))].join('/')}`;
  return { issues, out };
}

/* ============================== main ============================== */
async function main() {
  await connectDb();
  await bootstrap();
  const before = await inspect();
  log(`\nDatabase: ${mongoose.connection.db.databaseName}`);
  const list = (o) => Object.entries(o).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  log('Sample / test transactions (flagged – removed):', list(before.flagged));
  log(`Unflagged transactions (${INCLUDE_UNFLAGGED ? 'REMOVED – --include-unflagged' : 'kept'}):`, list(before.unflagged));
  log('Notifications / documents / stock ledger:', list(Object.fromEntries(Object.keys(TX_EXTRA).map((k) => [k, before.counts[k]]))));
  log('Kept untouched:', list(before.keep));
  const by = (rows) => [...new Set(rows.map((j) => `${j.createdByName || '?'} ${j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 16) : ''}`.slice(0, 32)))].slice(0, 6).join(' | ');
  log('Existing jobs:', before.jobs.map((j) => `${j.jobNo}(${j.businessUnit}${j.isSampleData ? ', sample' : ''})`).join(' ') || 'none');
  if (before.jobs.some((j) => !j.isSampleData)) log('Unflagged jobs created by / at:', by(before.jobs.filter((j) => !j.isSampleData)));
  if (!APPLY) { log('\nDry run only – re-run with --apply to back up, clean and build the sample dataset.'); await mongoose.disconnect(); return; }

  await backupAndClean();
  const server = await startApi();
  log('\nBuilding sample dataset through the API…');
  const startedAt = new Date(Date.now() - 1000);
  const { created, createdMasters, factory } = await buildDataset();
  await markSample(startedAt, createdMasters);
  log('\nChecking unit dashboards, reports, analytics and main job pages through the API…');
  const apiResult = await apiChecks();
  const wf = await workflowChecks();
  apiResult.issues.push(...wf.issues); Object.assign(apiResult.out, wf.out);
  // factory operations: the guards refused every wrong entry, and every reconciliation holds in each unit and combined
  factory.negative.filter((t) => !t.ok).forEach((t) => apiResult.issues.push(`Guard not enforced: ${t.test} (${t.got})`));
  for (const unit of ['U1', 'U2', 'ALL']) {
    const r = await U(unit === 'ALL' ? 'U1' : unit).get(`/factory/integrity${unit === 'ALL' ? '?unit=ALL' : ''}`);
    r.checks.filter((c) => c.status !== 'PASS').forEach((c) => apiResult.issues.push(`${unit} integrity: ${c.title} – ${JSON.stringify(c.items.slice(0, 3))}`));
    apiResult.out[`${unit} integrity checks`] = `${r.passed} passed, ${r.failed} failed`;
  }
  for (const key of ['production', 'wip', 'quality', 'fg', 'hr', 'expenses', 'copq', 'pnl']) await U('U1').get(`/factory/report/${key}?unit=ALL&from=${day(FACTORY_FROM)}`);
  apiResult.out['Factory data'] = `${factory.attendance} attendance sheets, ${factory.payrolls.length} payroll runs, ${factory.expenses.length} factory expenses, ${factory.negative.filter((t) => t.ok).length}/${factory.negative.length} guard tests refused`;
  server.close();

  log('\nValidating…');
  const v = await validate(before.keep, startedAt);
  const jobs = await models.orders.find({ isDeleted: false }).lean();
  const cnt = (q) => jobs.filter(q).length;
  const n = async (k, q = {}) => models[k].countDocuments({ isDeleted: false, ...q });
  const summary = {
    'Unit-1 main jobs': cnt((j) => j.businessUnit === 'U1' && !j.parentJob), 'Unit-1 sub jobs': cnt((j) => j.businessUnit === 'U1' && j.parentJob),
    'Unit-2 main jobs': cnt((j) => j.businessUnit === 'U2' && !j.parentJob), 'Unit-2 sub jobs': cnt((j) => j.businessUnit === 'U2' && j.parentJob),
    'Buyers used': new Set(jobs.map((j) => j.buyerName)).size, 'Orders (confirmed from quotations)': cnt((j) => !j.parentJob),
    'Fabric forecasts': await n('fabricForecast'), 'Fabric transfers': await n('fabricTransfer'), 'Fabric bookings': await n('fabricBooking'),
    'Production entries (cutting / sewing / finishing / packing)': `${await n('cutting')} / ${await n('sewing')} / ${await n('finishing')} / ${await n('packing')}`,
    Inspections: await n('inspection'), Shipments: await n('shipment'),
    'Accounts (invoices / payments / expenses)': `${await n('invoice')} / ${await n('payment')} / ${await n('expense')}`,
    'Closed jobs': jobs.filter((j) => j.status === 'Closed').map((j) => j.jobNo).join(', '),
    'Records checked for job / unit / reference integrity': v.checked,
  };
  log('\nSUMMARY'); Object.entries(summary).forEach(([k, val]) => log(`  ${k}: ${val}`));
  log('\nJOBS');
  for (const j of jobs.sort((a, b) => a.jobNo.localeCompare(b.jobNo))) {
    const p = v.profits.find((x) => x.jobNo === j.jobNo)?.p;
    log(`  ${j.jobNo.padEnd(12)} ${j.businessUnit} ${String(j.status).padEnd(15)} stage ${String(j.currentStage).padEnd(13)} ${j.buyerName} · ${j.styleNo} · ${j.orderQty} pcs${p?.revenue ? ` · revenue ${p.revenue} profit ${p.actualProfit} ROI ${p.roiPct}%` : ''}`);
  }
  log('\nUNIT CHECKS'); Object.entries(apiResult.out).forEach(([k, val]) => log(`  ${k}: ${JSON.stringify(val)}`));
  v.issues.push(...apiResult.issues);
  log(v.issues.length ? `\nVALIDATION ISSUES (${v.issues.length}):\n  ${v.issues.join('\n  ')}` : '\nVALIDATION: all checks passed – no duplicates, cross-unit leaks, orphans or broken references.');
  void created;
  await mongoose.disconnect();
  if (v.issues.length) process.exitCode = 1;
}

main().catch(async (e) => { console.error('\nFAILED:', e.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
