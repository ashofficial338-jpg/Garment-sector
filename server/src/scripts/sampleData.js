/**
 * Sample data tool – replaces old sample / demo TRANSACTIONS with a fresh, realistic, fully connected
 * two-unit dataset, then validates it.
 *
 *   node src/scripts/sampleData.js            dry run: shows what is there and what would be removed
 *   node src/scripts/sampleData.js --apply    backup → remove transactions → build dataset → validate
 *
 * Never touched: users, sessions, roles & permissions, settings, buyers, suppliers, master data, employees,
 * the audit trail. Before removing anything the transactions are written to server/backups/*.json.
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

const APPLY = process.argv.includes('--apply');
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(...a);

/* ============================== 1. Inspect & classify ============================== */
const KEEP_MODULES = MODULE_LIST.filter((d) => d.sharedAcrossUnits || d.key === 'employee').map((d) => d.key); // buyers, suppliers, master data, employees
const TX_MODULES = MODULE_LIST.filter((d) => !KEEP_MODULES.includes(d.key)).map((d) => d.key);
const TX_EXTRA = { notifications: Notification, documentfiles: DocumentFile, stockmovements: StockMovement };

async function inspect() {
  const counts = {};
  for (const k of TX_MODULES) counts[k] = await models[k].countDocuments();
  for (const [k, M] of Object.entries(TX_EXTRA)) counts[k] = await M.countDocuments();
  const keep = {
    users: await User.countDocuments(), roles: await Role.countDocuments(), settings: await Setting.countDocuments(),
    ...Object.fromEntries(await Promise.all(KEEP_MODULES.map(async (k) => [k, await models[k].countDocuments()]))),
  };
  const jobs = await models.orders.find().select('jobNo businessUnit buyerName styleNo status createdByName createdAt').lean();
  return { counts, keep, jobs };
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

  for (const k of TX_MODULES) await models[k].deleteMany({});
  for (const M of Object.values(TX_EXTRA)) await M.deleteMany({});
  // GridFS files that belonged to removed documents
  const fileIds = dump.documentfiles.flatMap((d) => (d.versions || []).map((v) => v.fileName)).filter((id) => mongoose.isValidObjectId(id));
  if (fileIds.length) {
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
    for (const id of fileIds) await bucket.delete(new mongoose.Types.ObjectId(id)).catch(() => {});
  }
  // transaction number series restart (job series U1-1000 / U2-3000); master-data series are kept
  const keepPrefixes = ['ref-BUY-', 'ref-SUP-', 'ref-EMP-', 'ref-MST-'];
  await Counter.deleteMany({ _id: { $not: new RegExp(`^(${keepPrefixes.join('|')})`) } });
  log('Old sample transactions removed (masters, users, roles, settings and audit trail kept).');
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
  { name: 'Maersk Logistics', supplierType: 'Logistics' }, { name: 'SGS Testing', supplierType: 'Testing' },
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
      trims: KNIT_TRIMS, sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [52, 71, 20, 18], sam: 6.8, orderDays: -75, shipDays: 60,
      costing: { trimCost: 0.19, accessoriesCost: 0.03, cuttingCost: 0.06, sewingCost: 0.52, finishingCost: 0.1, packingCost: 0.07, labourCost: 0.05, factoryOverhead: 0.18, testingCost: 0.03, freightCost: 0.09, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 },
      forecastPlan: { supplier: 'Pioneer Knit Fabrics', supplierPoNo: 'PKF/2026/0841', lotNo: 'LOT-SJ-NV-2291', received: 5200, receivedDays: -55 },
      subJobs: [
        { qty: 800, fabric: 1000, day: -54, ship: -12, ref: 'NOR-PO-5120 call-off 1', stage: 'closed' },
        { qty: 2000, fabric: 2500, day: -30, ship: 20, ref: 'NOR-PO-5120 call-off 2', stage: 'sewing' },
        { qty: 960, fabric: 1200, day: -6, ship: 55, ref: 'NOR-PO-5120 call-off 3', stage: 'planning' },
      ] },
    { key: 'U1-KIDS-TEE', buyer: 'Kiwi Kids Ltd', styleNo: 'KK-TS-14', product: 'Kids Printed Crew Tee', garmentType: 'T-Shirt', poNo: 'KK-61820', destination: 'Sydney', price: 2.85, qty: 6000, stage: 'closed',
      fabric: { fabricType: 'Single Jersey 160 GSM', composition: '100% Cotton', gsm: 160, width: 66, color: 'Sky Blue', unit: 'KG', consumption: 0.14, wastagePct: 5, rate: 4.6 },
      trims: KNIT_TRIMS, sizes: SIZES_KIDS, ratio: RATIO_KIDS, poms: [36, 46, 13, 15], sam: 5.6, orderDays: -110, shipDays: -25,
      costing: { trimCost: 0.16, printingCost: 0.14, cuttingCost: 0.04, sewingCost: 0.38, finishingCost: 0.07, packingCost: 0.05, labourCost: 0.04, factoryOverhead: 0.12, testingCost: 0.03, freightCost: 0.07, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 11 },
      expenses: [['Printing', 0.14], ['Sewing / CMT', 0.37], ['Finishing', 0.07], ['Packing', 0.05]], payFull: true },
    { key: 'U1-POLO', buyer: 'Maison Lumière', styleNo: 'ML-PQ-77', product: "Women's Pique Polo", garmentType: 'Polo Shirt', poNo: 'ML-2026-231', destination: 'Le Havre', price: 6.4, qty: 4500, stage: 'accountsPending',
      fabric: { fabricType: 'Cotton Pique 220 GSM', composition: '95% Cotton 5% Elastane', gsm: 220, width: 64, color: 'Ivory', unit: 'KG', consumption: 0.24, wastagePct: 5, rate: 5.2 },
      trims: [...KNIT_TRIMS, { item: 'Button', description: 'Pearl 2-hole 16L', consumptionPerPc: 3, unit: 'Pcs', wastagePct: 4, rate: 0.015 }], sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [48, 66, 18, 17], sam: 11.5, orderDays: -95, shipDays: -6,
      costing: { trimCost: 0.26, cuttingCost: 0.07, sewingCost: 0.95, finishingCost: 0.14, packingCost: 0.08, labourCost: 0.06, factoryOverhead: 0.22, testingCost: 0.04, freightCost: 0.12, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 13 },
      expenses: [['Sewing / CMT', 0.98], ['Finishing', 0.15], ['Packing', 0.08]], payPart: 0.4 },
    { key: 'U1-HOODIE', buyer: 'Urban Threads Inc', styleNo: 'UT-HD-330', product: 'Unisex Pullover Hoodie', garmentType: 'Hoodie', poNo: 'UTI-91407', destination: 'Los Angeles', price: 11.8, qty: 3500, stage: 'readyToShip',
      fabric: { fabricType: 'French Terry 300 GSM', composition: '80% Cotton 20% Polyester', gsm: 300, width: 72, color: 'Heather Grey', unit: 'KG', consumption: 0.62, wastagePct: 6, rate: 6.1 },
      trims: [...KNIT_TRIMS, { item: 'Drawcord', description: 'Flat cotton drawcord 140 cm with metal tips', consumptionPerPc: 1, unit: 'Pcs', wastagePct: 3, rate: 0.11 }], sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [60, 72, 64, 20], sam: 17.5, orderDays: -70, shipDays: 12,
      costing: { trimCost: 0.31, cuttingCost: 0.12, sewingCost: 1.55, finishingCost: 0.2, washingCost: 0.25, packingCost: 0.1, labourCost: 0.09, factoryOverhead: 0.35, testingCost: 0.05, freightCost: 0.22, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
    { key: 'U1-HENLEY', buyer: 'Nordic Apparel AB', styleNo: 'NA-LS-610', product: "Men's Long Sleeve Henley", garmentType: 'T-Shirt', poNo: 'NOR-PO-5188', destination: 'Gothenburg', price: 5.6, qty: 5200, stage: 'sewing',
      fabric: { fabricType: 'Waffle Knit 200 GSM', composition: '100% Cotton', gsm: 200, width: 68, color: 'Olive', unit: 'KG', consumption: 0.27, wastagePct: 5, rate: 5.4 },
      trims: [...KNIT_TRIMS, { item: 'Button', description: 'Horn-look 3-button placket 18L', consumptionPerPc: 3, unit: 'Pcs', wastagePct: 4, rate: 0.02 }], sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [53, 72, 64, 17], sam: 10.2, orderDays: -60, shipDays: 35,
      costing: { trimCost: 0.24, cuttingCost: 0.07, sewingCost: 0.82, finishingCost: 0.12, packingCost: 0.07, labourCost: 0.06, factoryOverhead: 0.2, testingCost: 0.04, freightCost: 0.1, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
    { key: 'U1-SHORTS', buyer: 'Kiwi Kids Ltd', styleNo: 'KK-SH-22', product: 'Kids Jersey Shorts', garmentType: 'Shorts', poNo: 'KK-62004', destination: 'Sydney', price: 2.1, qty: 8000, stage: 'fabricPending',
      fabric: { fabricType: 'Single Jersey 180 GSM', composition: '95% Cotton 5% Elastane', gsm: 180, width: 66, color: 'Coral', unit: 'KG', consumption: 0.11, wastagePct: 5, rate: 4.9 },
      trims: KNIT_TRIMS, sizes: SIZES_KIDS, ratio: RATIO_KIDS, poms: [28, 30, 0, 22], sam: 4.2, orderDays: -28, shipDays: 70,
      costing: { trimCost: 0.14, cuttingCost: 0.03, sewingCost: 0.29, finishingCost: 0.05, packingCost: 0.04, labourCost: 0.03, factoryOverhead: 0.09, testingCost: 0.02, freightCost: 0.05, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 11 } },
    { key: 'U1-TANK', buyer: 'Pacific Coast Apparel LLC', styleNo: 'PCA-TK-08', product: "Women's Rib Tank Top", garmentType: 'T-Shirt', poNo: 'PCA-PO-30772', destination: 'Long Beach', price: 3.15, qty: 7000, stage: 'planning',
      fabric: { fabricType: '2x1 Rib 210 GSM', composition: '95% Cotton 5% Elastane', gsm: 210, width: 60, color: 'Black', unit: 'KG', consumption: 0.13, wastagePct: 5, rate: 5.6 },
      trims: KNIT_TRIMS, sizes: ['XS', 'S', 'M', 'L'], ratio: 'XS:2,S:3,M:3,L:2', poms: [42, 58, 0, 16], sam: 4.8, orderDays: -10, shipDays: 95,
      costing: { trimCost: 0.15, cuttingCost: 0.04, sewingCost: 0.33, finishingCost: 0.06, packingCost: 0.05, labourCost: 0.04, factoryOverhead: 0.11, testingCost: 0.03, freightCost: 0.06, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
  ],
  U2: [
    { key: 'U2-MAIN', buyer: 'Bristol & Main Ltd', styleNo: 'BM-OX-140', product: "Men's Oxford Button-Down Shirt", garmentType: 'Shirt', poNo: 'BM-PO-77310', destination: 'Felixstowe', price: 8.9, qty: 6000, forecast: true,
      fabric: { fabricType: 'Cotton Oxford 40s', composition: '100% Cotton', gsm: 135, width: 58, color: 'Light Blue', unit: 'Meter', consumption: 1.6, wastagePct: 5, rate: 2.75 },
      trims: WOVEN_TRIMS, sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [56, 78, 64, 41], sam: 18.5, orderDays: -80, shipDays: 50,
      costing: { trimCost: 0.29, accessoriesCost: 0.11, cuttingCost: 0.1, sewingCost: 1.45, finishingCost: 0.2, washingCost: 0.18, packingCost: 0.09, labourCost: 0.08, factoryOverhead: 0.32, testingCost: 0.05, freightCost: 0.16, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 },
      forecastPlan: { supplier: 'Arvind Mills', supplierPoNo: 'AM/OX/26-1187', lotNo: 'OX-LB-5531', received: 10000, receivedDays: -58 },
      subJobs: [
        { qty: 3000, fabric: 5040, day: -56, ship: -8, ref: 'BM-PO-77310 drop 1', stage: 'closed' },
        { qty: 2000, fabric: 3360, day: -25, ship: 18, ref: 'BM-PO-77310 drop 2', stage: 'quality' },
      ] },
    { key: 'U2-CHINO', buyer: 'Sakura Lifestyle KK', styleNo: 'SL-CH-205', product: "Women's Stretch Twill Chino", garmentType: 'Trouser', poNo: 'SLK-24-5582', destination: 'Yokohama', price: 9.4, qty: 4000, stage: 'closed',
      fabric: { fabricType: 'Stretch Cotton Twill 7 oz', composition: '98% Cotton 2% Elastane', gsm: 240, width: 57, color: 'Khaki', unit: 'Meter', consumption: 1.35, wastagePct: 5, rate: 3.4 },
      trims: BOTTOM_TRIMS, sizes: ['26', '28', '30', '32'], ratio: '26:2,28:3,30:3,32:2', poms: [36, 99, 0, 0], sam: 22, orderDays: -120, shipDays: -30,
      costing: { trimCost: 0.42, cuttingCost: 0.12, sewingCost: 1.7, finishingCost: 0.22, washingCost: 0.35, packingCost: 0.1, labourCost: 0.1, factoryOverhead: 0.38, testingCost: 0.06, freightCost: 0.2, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 11 },
      expenses: [['Sewing / CMT', 1.68], ['Washing', 0.36], ['Finishing', 0.22], ['Packing', 0.1]], payFull: true },
    { key: 'U2-POPLIN', buyer: 'Hamburg Outdoor GmbH', styleNo: 'HO-SH-415', product: "Men's Poplin Short Sleeve Shirt", garmentType: 'Shirt', poNo: 'HOG-4410-26', destination: 'Hamburg', price: 7.1, qty: 3000, stage: 'shipped',
      fabric: { fabricType: 'Cotton Poplin 60s', composition: '100% Cotton', gsm: 110, width: 58, color: 'White', unit: 'Meter', consumption: 1.45, wastagePct: 5, rate: 2.4 },
      trims: WOVEN_TRIMS, sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [55, 76, 24, 40], sam: 16, orderDays: -85, shipDays: -4,
      costing: { trimCost: 0.27, accessoriesCost: 0.09, cuttingCost: 0.09, sewingCost: 1.25, finishingCost: 0.18, packingCost: 0.08, labourCost: 0.07, factoryOverhead: 0.28, testingCost: 0.05, freightCost: 0.15, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 },
      expenses: [['Sewing / CMT', 1.3], ['Finishing', 0.18]] },
    { key: 'U2-LOUNGE', buyer: 'Bristol & Main Ltd', styleNo: 'BM-LT-118', product: "Men's Lounge Tee", garmentType: 'T-Shirt', poNo: 'BM-PO-77402', destination: 'Felixstowe', price: 4.6, qty: 2500, stage: 'cutting',
      fabric: { fabricType: '100% Cotton Single Jersey', composition: '100% Combed Cotton', gsm: 160, width: 60, color: 'Navy', unit: 'Meter', consumption: 1.2, wastagePct: 4, rate: 0.95 },
      trims: KNIT_TRIMS, sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [53, 72, 21, 18], sam: 7, orderDays: -45, shipDays: 40, partialFabric: 0.88,
      costing: { trimCost: 0.19, cuttingCost: 0.06, sewingCost: 0.55, finishingCost: 0.1, packingCost: 0.07, labourCost: 0.05, factoryOverhead: 0.18, testingCost: 0.03, freightCost: 0.1, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
    { key: 'U2-BLOUSE', buyer: 'Sakura Lifestyle KK', styleNo: 'SL-BL-090', product: "Women's Viscose Blouse", garmentType: 'Shirt', poNo: 'SLK-24-5671', destination: 'Yokohama', price: 8.2, qty: 3600, stage: 'fabricPending',
      fabric: { fabricType: 'Viscose Challis 120 GSM', composition: '100% Viscose', gsm: 120, width: 56, color: 'Dusty Rose', unit: 'Meter', consumption: 1.5, wastagePct: 6, rate: 2.9 },
      trims: WOVEN_TRIMS, sizes: ['XS', 'S', 'M', 'L'], ratio: 'XS:2,S:3,M:3,L:2', poms: [50, 64, 60, 36], sam: 19, orderDays: -30, shipDays: 75,
      costing: { trimCost: 0.26, cuttingCost: 0.11, sewingCost: 1.5, finishingCost: 0.2, packingCost: 0.09, labourCost: 0.08, factoryOverhead: 0.3, testingCost: 0.05, freightCost: 0.15, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 12 } },
    { key: 'U2-FLANNEL', buyer: 'Hamburg Outdoor GmbH', styleNo: 'HO-OS-220', product: "Men's Flannel Overshirt", garmentType: 'Shirt', poNo: 'HOG-4488-26', destination: 'Hamburg', price: 14.5, qty: 2200, stage: 'planning',
      fabric: { fabricType: 'Brushed Cotton Flannel', composition: '100% Cotton', gsm: 190, width: 58, color: 'Red Check', unit: 'Meter', consumption: 1.9, wastagePct: 7, rate: 3.6 },
      trims: WOVEN_TRIMS, sizes: SIZES_ADULT, ratio: RATIO_ADULT, poms: [60, 79, 66, 43], sam: 26, orderDays: -12, shipDays: 100,
      costing: { trimCost: 0.34, accessoriesCost: 0.12, cuttingCost: 0.14, sewingCost: 2.1, finishingCost: 0.26, washingCost: 0.2, packingCost: 0.11, labourCost: 0.11, factoryOverhead: 0.45, testingCost: 0.06, freightCost: 0.24, commissionPct: 3, financeCostPct: 1, adminOverheadPct: 2, profitMarginPct: 13 } },
  ],
};

const STAGES = ['planning', 'fabricPending', 'fabric', 'cutting', 'sewing', 'quality', 'packing', 'readyToShip', 'shipped', 'accountsPending', 'closed'];
const reach = (target, s) => STAGES.indexOf(target) >= STAGES.indexOf(s);

/* --------------------------- commercial chain: enquiry → costing → quotation → order --------------------------- */
async function confirmOrder(api, spec, ids) {
  const f = spec.fabric;
  const enq = await api.post('/m/enquiry', { enquiryDate: day(spec.orderDays - 20), buyer: ids.buyers[spec.buyer], buyerContact: 'Sourcing team', styleNo: spec.styleNo, product: spec.product, garmentType: spec.garmentType, fabric: f.fabricType, composition: f.composition, gsm: f.gsm, color: f.color, sizeRange: spec.sizes.join(', '), expectedQty: spec.qty, targetPrice: spec.price, currency: 'USD', requiredDelivery: day(spec.shipDays) });
  await api.status('enquiry', enq._id, 'Under Review');
  // FOB price = the cost sheet's total cost + margin (the buyer's target price is only the enquiry's target)
  const cst = await api.post('/m/costing', { enquiry: enq._id, fabricConsumption: f.consumption, fabricUnit: f.unit, fabricRate: f.rate, fabricWastagePct: f.wastagePct, ...spec.costing });
  await api.status('costing', cst._id, 'Submitted', 'Under Review', 'Approved');
  const qtn = await api.post('/m/quotation', { costing: cst._id, quoteDate: day(spec.orderDays - 12), fabric: f.fabricType, composition: f.composition, gsm: f.gsm, color: f.color, sizeRange: spec.sizes.join(', '), paymentTerms: BUYERS.find((b) => b.name === spec.buyer).paymentTerms, deliveryTerms: 'FOB', validUntil: day(spec.orderDays + 30) });
  await api.status('quotation', qtn._id, 'Sent', 'Under Review', 'Approved');
  const per = Math.round(spec.qty / 10);
  const ratio = spec.ratio.split(',').map((p) => { const [s, q] = p.split(':'); return [s, Number(q)]; });
  const job = await api.post(`/jobs/from-quotation/${qtn._id}`, {
    poNo: spec.poNo, orderDate: day(spec.orderDays), shipmentDate: day(spec.shipDays), deliveryDate: day(spec.shipDays + 21), destination: spec.destination,
    orderQty: spec.qty, colors: [f.color], sizes: spec.sizes, sizeBreakdown: ratio.map(([size, q]) => ({ color: f.color, size, qty: per * q })),
    fabricType: f.fabricType, composition: f.composition, gsm: f.gsm, width: f.width, fabricColor: f.color, consumption: f.consumption, consumptionUnit: f.unit,
    wastagePct: f.wastagePct, fabricRate: f.rate, trims: spec.trims, specialInstructions: `${spec.product} – buyer ${spec.buyer}. Shade band approval before bulk cutting.`,
    ...(spec.forecast ? { isForecast: true, forecastQty: spec.qty } : {}),
  });
  return job;
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
  const spc = await api.put(`/m/techSpec/${t.records.techSpec[0]._id}`, { fit: 'Regular fit', baseSize: spec.sizes[1], sizes: spec.sizes, description: `${spec.product}, ${f.composition}`, construction: 'Overlock 4-thread seams, coverstitch hems, taped shoulders', stitching: '12–14 SPI lockstitch, 4-thread overlock', labelling: 'Main label centre back neck, care label left side seam 10 cm above hem', packingInstructions: 'Single piece folded in polybag, solid colour assorted size cartons', measurements: spec.poms.filter((v) => v > 0).length ? POMS(spec.poms).filter((p) => p.baseValue > 0) : [] });
  if (target === 'planning') { await api.status('techSpec', spc._id, 'Submitted'); return; }
  await api.status('techSpec', spc._id, 'Submitted', 'Approved');
  // BOM
  const bom = t.records.bom[0];
  await api.status('bom', bom._id, 'Submitted', 'Approved');
  // CAD → pattern → grading → marker
  const pat = await api.post('/m/pattern', { job: jobNo, patternNo: `${spec.styleNo}-P1`, cadSystem: unit === 'U1' ? 'Gerber AccuMark' : 'Lectra Modaris', cadFileName: `${spec.styleNo}_prod_v1.zip`, patternMaker: unit === 'U1' ? 'R. Senthil Kumar' : 'M. Priya', pieceCount: 7, seamAllowanceMm: 10, cadStartDate: day(start) });
  await api.status('pattern', pat._id, 'Pattern Ready', 'Pattern Approved', 'Graded');
  const pcsPerMarker = spec.ratio.split(',').reduce((a, p) => a + Number(p.split(':')[1]), 0);
  const markerLength = f.unit === 'KG' ? r2((f.consumption * 0.985 * pcsPerMarker * 1000) / (f.width * 0.0254 * f.gsm)) : r2(f.consumption * 0.985 * pcsPerMarker);
  const mk = await api.post('/m/marker', { job: jobNo, markerNo: `${spec.styleNo}-MK1`, ratio: spec.ratio, markerLength, markerLengthUnit: 'Meter', markerWidth: f.width, gsm: f.gsm, unit: f.unit, fabricType: f.fabricType, color: f.color, markerEfficiencyPct: 84 + (pcsPerMarker % 3), plannedPlies: Math.ceil(qty / pcsPerMarker) });
  await api.status('marker', mk._id, 'Submitted', 'Approved');
  // samples, PP meeting, plan
  for (const s of t.records.sample) await api.status('sample', s._id, 'Submitted', 'Buyer Review', 'Approved');
  await api.status('ppMeeting', t.records.ppMeeting[0]._id, 'Held');
  const plan = t.records.productionPlan[0];
  const operators = Math.max(18, Math.round(spec.sam * 3.2));
  const line = `Line ${(counters.line++ % 6) + 1}`;
  await api.put(`/m/productionPlan/${plan._id}`, { floor: 'Floor 1', line, operators, helpers: Math.round(operators / 4), machines: operators + 4, sam: spec.sam, workingMinutes: 480, targetEfficiencyPct: 62, plannedStart: day(ps) });
  await api.status('productionPlan', plan._id, 'Approved', 'Released');
  // fabric booking (sub jobs already received theirs by transfer)
  t = await api.get(`/jobs/track/${jobNo}`);
  for (const fb of t.records.fabricBooking) {
    const full = await api.get(`/m/fabricBooking/${fb._id}`);
    const req = full.requiredQty;
    const byTransfer = full.receivedQty > 0;
    const received = byTransfer ? full.receivedQty : target === 'fabricPending' ? 0 : r2(req * (spec.partialFabric || 1.012));
    const body = { supplier: ids.suppliers[unit === 'U1' ? 'KPR Mill Ltd' : 'Raymond Woven Fabrics'], supplierPoNo: `${unit}-FPO-${jobNo.split('-').slice(1).join('')}`, bookingDate: day(start + 2), deliveryDate: day(start + 20), bookedQty: byTransfer ? received : Math.ceil(req), rate: f.rate };
    if (target === 'fabricPending') { await api.put(`/m/fabricBooking/${fb._id}`, body); await api.status('fabricBooking', fb._id, 'Booked', 'In Production'); continue; }
    // a few metres / kg rejected at 4-point inspection, never below the requirement
    await api.put(`/m/fabricBooking/${fb._id}`, { ...body, receivedQty: received, inspectedQty: received, approvedQty: r2(Math.min(received, Math.max(req, received * 0.996))) });
    await api.status('fabricBooking', fb._id, ...(byTransfer ? ['Inspected', 'Approved'] : ['Booked', 'In Production', 'In Transit', 'Received', 'Inspected', 'Approved']));
  }
  for (const tb of t.records.trimBooking) {
    const full = await api.get(`/m/trimBooking/${tb._id}`);
    const rcv = target === 'fabricPending' ? 0 : full.bookingQty;
    await api.put(`/m/trimBooking/${tb._id}`, { supplier: ids.suppliers[['Button', 'Zipper'].includes(full.item) ? 'YKK India' : 'Avery Dennison'], supplierPoNo: `${unit}-TPO-${jobNo.split('-').slice(1).join('')}`, deliveryDate: day(start + 18), bookedQty: full.bookingQty, receivedQty: rcv, issuedQty: reach(target, 'cutting') ? rcv : 0, usedQty: target === 'closed' ? rcv : 0 });
    await api.status('trimBooking', tb._id, ...(target === 'fabricPending' ? ['Booked'] : ['Booked', 'In Transit', 'Received', ...(reach(target, 'cutting') ? ['Issued'] : [])]));
  }
  if (target === 'fabricPending') return;
  // cutting (approved marker → lay data pulled), fabric issued to cutting
  const fabs = (await api.get(`/jobs/track/${jobNo}`)).records.fabricBooking;
  const main = await api.get(`/m/fabricBooking/${fabs[0]._id}`);
  const cutTarget = target === 'cutting' ? Math.round(qty * 0.55) : Math.round(qty * 1.015);
  const issue = r2(Math.min(main.approvedQty, cutTarget * f.consumption * (1 + f.wastagePct / 100)));
  await api.put(`/m/fabricBooking/${main._id}`, { issuedQty: issue });
  await api.status('fabricBooking', main._id, 'Issued');
  // lays of up to a third of the order; fabric used per lay in proportion, total always within the fabric issued
  const maxPlies = Math.ceil(qty / pcsPerMarker / 3) + 1;
  let cut = 0; let lay = 1;
  while (cut < cutTarget) {
    const plies = Math.min(Math.ceil((cutTarget - cut) / pcsPerMarker), maxPlies);
    const pcs = plies * pcsPerMarker;
    const used = r2((issue * 0.985 * pcs) / (Math.ceil(cutTarget / pcsPerMarker) * pcsPerMarker));
    await api.post('/m/cutting', { job: jobNo, entryDate: day(ps + lay), marker: mk._id, layNo: `L-${String(lay).padStart(2, '0')}`, plies, bundleQty: Math.ceil(pcs / 20), panelQty: pcs * 5, fabricIssued: r2(used * 1.012), fabricUsed: used, rejectQty: Math.round(pcs * 0.002) });
    cut += pcs; lay += 1;
  }
  if (target === 'cutting') return;
  // sewing – line output day by day at realistic efficiency
  const sewTarget = target === 'sewing' ? Math.round(cut * 0.45) : cut - Math.round(cut * 0.005);
  let sewn = 0; let d = ps + lay + 1;
  while (sewn < sewTarget) {
    const eff = 0.55 + ((d * 7) % 13) / 100;
    const out = Math.min(sewTarget - sewn, Math.round((operators * 480 * eff) / spec.sam));
    const checked = out; const defects = Math.round(out * (0.018 + ((d * 3) % 7) / 1000));
    await api.post('/m/sewing', { job: jobNo, entryDate: day(d), floor: 'Floor 1', line, supervisor: unit === 'U1' ? 'K. Lakshmi' : 'S. Fathima', operators, helpers: Math.round(operators / 4), sam: spec.sam, workingMinutes: 480, inputQty: out + 40, targetQty: Math.round((operators * 480 * 0.62) / spec.sam), manualOutput: out, checkedQty: checked, defects, alteration: Math.round(defects * 0.7), rejection: Math.round(out * 0.004) });
    sewn += out; d += 1;
  }
  if (target === 'sewing') return;
  // finishing + inline quality
  const finIn = target === 'quality' ? Math.round(sewn * 0.6) : sewn;
  const rej = Math.round(finIn * 0.004);
  await api.post('/m/finishing', { job: jobNo, entryDate: day(d + 1), process: 'All', color: f.color, inputQty: finIn, passedQty: finIn - rej, alteration: Math.round(finIn * 0.01), rework: Math.round(finIn * 0.006), rejection: rej });
  const inl = await api.post('/m/inspection', { job: jobNo, inspectionDate: day(d), inspectionType: 'Inline', inspector: unit === 'U1' ? 'QA – V. Arun' : 'QA – D. Meena', inspectionAgency: 'In-house QA', lotSize: Math.round(sewn / 2), majorDefects: 2, minorDefects: 5 });
  await api.status('inspection', inl._id, 'Inspection');
  if (target === 'quality') return;
  // packing – full cartons, never more than ordered
  const ppc = pcsPerMarker * 3;
  const cartons = Math.floor(Math.min(finIn - rej, qty) / ppc);
  const pk = await api.post('/m/packing', { job: jobNo, packingDate: day(d + 2), packingMethod: 'Solid Color Assorted Size', rows: [{ color: f.color, ratio: spec.ratio.split(',').map((p) => { const [s, q] = p.split(':'); return `${s}:${Number(q) * 3}`; }).join(','), cartonFrom: 1, cartonTo: cartons, pcsPerCarton: ppc, netWtPerCarton: r2(ppc * (f.unit === 'KG' ? f.consumption : 0.2)), grossWtPerCarton: r2(ppc * (f.unit === 'KG' ? f.consumption : 0.2) + 1.1), length: 60, width: 40, height: 30 }] });
  await api.status('packing', pk._id, 'Packed', 'Verified');
  const fin = await api.post('/m/inspection', { job: jobNo, inspectionDate: day(d + 3), inspectionType: 'Final', inspector: 'Buyer QA', inspectionAgency: `${spec.buyer} QA`, lotSize: pk.totalQty, majorDefects: 3, minorDefects: 6 });
  await api.status('inspection', fin._id, 'Inspection', 'Passed', 'Final Approved');
  if (target === 'packing') return;
  // shipment (pulls cartons / weights / CBM from packing)
  const shipDay = Math.min(d + 5, -1); // after packing & final inspection
  const shp = await api.post('/m/shipment', { job: jobNo, invoiceNo: `${unit}-EXP-${jobNo.split('-').slice(1).join('')}`, mode: 'Sea', shipmentDate: day(spec.shipDays), vesselFlight: unit === 'U1' ? 'MAERSK KENSINGTON 241W' : 'CMA CGM TIGRIS 0QF4', containerNo: `MSKU${7000000 + counters.cont++}`, portOfLoading: unit === 'U1' ? 'Tuticorin' : 'Chennai', forwarder: 'Maersk Logistics', etd: day(spec.shipDays) });
  if (target === 'readyToShip') { await api.status('shipment', shp._id, 'Booked'); return; }
  await api.put(`/m/shipment/${shp._id}`, { actualShipDate: day(shipDay), blAwbNo: `MAEU${240000000 + counters.cont * 17}`, eta: day(shipDay + 28) });
  await api.status('shipment', shp._id, 'Booked', 'Stuffed', 'Shipped');
  if (target === 'shipped') return;
  // documents, invoice, payment, expenses
  for (const docType of ['Commercial Invoice', 'Packing List', 'Bill of Lading (BL)']) {
    const fd = new FormData();
    fd.append('job', jobNo); fd.append('docType', docType); fd.append('title', `${docType} – ${jobNo}`);
    fd.append('file', PDF(`${docType} ${jobNo}`), `${docType.replace(/\W+/g, '_')}_${jobNo}.pdf`);
    await call(unit, 'POST', '/documents', fd);
  }
  const invDay = Math.min(shipDay + 1, 0);
  const inv = await api.post('/m/invoice', { job: jobNo, shipment: shp._id, invoiceDate: day(invDay), dueDate: day(shipDay + 46), otherCharges: 0, discount: 0 });
  await api.status('invoice', inv._id, 'Issued');
  for (const [category, perPcCost] of spec.expenses || [['Sewing / CMT', (spec.costing.sewingCost || 0.5) * 1.02], ['Finishing', spec.costing.finishingCost || 0.1]]) {
    await api.post('/m/expense', { job: jobNo, category, description: `${category} – ${jobNo}`, expenseDate: day(d), amount: r2(perPcCost * shp.qty), vendor: unit === 'U1' ? 'In-house production' : 'In-house production U2', billNo: `${unit}-${category.slice(0, 3).toUpperCase()}-${counters.bill++}` });
  }
  await api.post('/m/expense', { job: jobNo, category: 'Freight', description: `Ocean freight & CHA – ${shp.invoiceNo}`, expenseDate: day(shipDay), amount: r2(shp.qty * (spec.costing.freightCost || 0.1)), vendor: 'Maersk Logistics', billNo: `ML-${counters.bill++}` });
  await api.post('/m/expense', { job: jobNo, category: 'Testing', description: 'Bulk fabric & garment testing', expenseDate: day(ps - 2), amount: 185, vendor: 'SGS Testing', billNo: `SGS-${counters.bill++}` });
  if (target === 'accountsPending') {
    if (spec.payPart) await api.post('/m/payment', { job: jobNo, invoice: inv._id, paymentDate: day(invDay), amount: r2(inv.totalAmount * spec.payPart), mode: 'TT', reference: `TT-${counters.bill++}`, bankCharges: 25 });
    return;
  }
  await api.post('/m/payment', { job: jobNo, invoice: inv._id, paymentDate: day(Math.max(invDay, Math.min(shipDay + 30, 0))), amount: inv.totalAmount, mode: 'TT', reference: `TT-${counters.bill++}`, bankCharges: 35 });
  // closure: consume fabric & trims, close fabric job, close the job (must be READY – no override)
  for (const fb of (await api.get(`/jobs/track/${jobNo}`)).records.fabricBooking) {
    const full = await api.get(`/m/fabricBooking/${fb._id}`);
    await api.put(`/m/fabricBooking/${fb._id}`, { issuedQty: full.approvedQty, usedQty: full.approvedQty });
    await api.status('fabricBooking', fb._id, 'Fully Consumed');
    const after = await api.get(`/m/fabricBooking/${fb._id}`);
    if (String(after.closureVerdict).startsWith('READY')) await api.status('fabricBooking', fb._id, 'Fabric Job Closed');
  }
  const tr = await api.get(`/jobs/track/${jobNo}`);
  if (!tr.lifecycle.readyToClose) throw new Error(`${jobNo} not ready to close: ${tr.lifecycle.blockers.join('; ')}`);
  await api.post(`/jobs/${tr.job._id}/close`, { remarks: 'All production, shipment, documents and payments complete' });
}

/* --------------------------- forecast main job: forecast → receipt → transfers → sub jobs --------------------------- */
async function runForecastJob(api, unit, job, spec, ids, counters, crossUnit) {
  const t = await api.get(`/jobs/track/${job.jobNo}`);
  const ff = t.records.fabricForecast[0];
  const plan = spec.forecastPlan;
  await api.put(`/m/fabricForecast/${ff._id}`, { supplier: ids.suppliers[plan.supplier], supplierPoNo: plan.supplierPoNo, lotNo: plan.lotNo, requiredDate: day(spec.orderDays + 15), receivedQty: plan.received, receivedDate: day(plan.receivedDays), remarks: `Bulk ${spec.fabric.fabricType} for ${spec.poNo} call-offs` });
  await api.status('fabricForecast', ff._id, 'Confirmed', 'Received');
  const subs = [];
  for (const [n, s] of spec.subJobs.entries()) {
    const ft = await api.post('/m/fabricTransfer', { job: job.jobNo, sourceForecast: ff._id, qty: s.fabric, transferDate: day(s.day), toUnit: unit, createSubJob: true, subJobQty: s.qty, subJobShipmentDate: day(s.ship), reason: 'New production requirement', referenceDoc: s.ref, remarks: `Call-off ${n + 1} of ${spec.poNo}` });
    await api.status('fabricTransfer', ft._id, 'Approved', 'Completed');
    const done = await api.get(`/m/fabricTransfer/${ft._id}`);
    subs.push({ ...s, jobNo: done.toJobNo, transfer: done.refNo });
  }
  if (crossUnit) {
    const ft = await api.post('/m/fabricTransfer', { job: job.jobNo, sourceForecast: ff._id, qty: crossUnit.qty, transferDate: day(crossUnit.day), toUnit: crossUnit.toUnit, toJobNo: crossUnit.toJobNo, reason: 'Shortage cover', referenceDoc: crossUnit.ref, remarks: 'Same navy single jersey lot – covers cutting shortage in Unit-2' });
    await api.status('fabricTransfer', ft._id, 'Approved', 'Completed');
  }
  for (const s of subs) {
    const sub = { ...spec, orderDays: s.day, shipDays: s.ship, qty: s.qty };
    await runJob(api, unit, s.jobNo, sub, s.stage, ids, counters);
  }
  return subs;
}

async function buildDataset() {
  const counters = { line: 0, cont: 1, bill: 1001 };
  const ids = { buyers: {}, suppliers: {} };
  const u1 = U('U1'); const u2 = U('U2');
  // masters (shared by both units): reuse existing, add missing realistic ones
  for (const b of BUYERS) {
    const found = (await u1.get(`/m/buyer?q=${encodeURIComponent(b.name)}`)).rows.find((x) => x.name === b.name);
    ids.buyers[b.name] = found?._id || (await u1.post('/m/buyer', b))._id;
  }
  for (const s of SUPPLIERS) {
    const found = (await u1.get(`/m/supplier?q=${encodeURIComponent(s.name)}`)).rows.find((x) => x.name === s.name);
    ids.suppliers[s.name] = found?._id || (await u1.post('/m/supplier', s))._id;
  }
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
  const u2Lounge = created.U2.find((x) => x.spec.key === 'U2-LOUNGE').job.jobNo;
  for (const { spec, job } of created.U1.filter((x) => !x.spec.forecast)) await runJob(u1, 'U1', job.jobNo, spec, spec.stage, ids, counters);
  const main1 = created.U1.find((x) => x.spec.forecast);
  const subs1 = await runForecastJob(u1, 'U1', main1.job, main1.spec, ids, counters, { qty: 300, day: -20, toUnit: 'U2', toJobNo: u2Lounge, ref: 'IUT/2026/014 inter-unit transfer note' });
  const main2 = created.U2.find((x) => x.spec.forecast);
  const subs2 = await runForecastJob(u2, 'U2', main2.job, main2.spec, ids, counters);
  // company-level finance lines for EBITDA (per unit, last 3 months)
  for (const [unit, api, scale] of [['U1', u1, 1], ['U2', u2, 0.8]]) {
    for (const m of [-60, -30, -2]) {
      for (const [category, amount, vendor] of [['Admin Expense', 3800, 'Office & admin'], ['Interest', 1150, 'Bank – working capital loan'], ['Tax', 900, 'Advance tax'], ['Depreciation', 2400, 'Machinery depreciation'], ['Amortization', 350, 'CAD software licence']]) {
        await api.post('/m/expense', { category, description: `${category} – ${unit} monthly`, expenseDate: day(m), amount: r2(amount * scale), vendor, billNo: `${unit}-GL-${counters.bill++}` });
      }
    }
  }
  return { created, subs1, subs2 };
}

/* ============================== 5. Validation ============================== */
async function validate(keepBefore) {
  const issues = [];
  const jobs = await models.orders.find({ isDeleted: false }).lean();
  const byId = new Map(jobs.map((j) => [String(j._id), j]));
  const dup = jobs.map((j) => j.jobNo).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) issues.push(`Duplicate job numbers: ${dup.join(', ')}`);
  jobs.forEach((j) => {
    const series = j.businessUnit === 'U1' ? /^U1-1\d{3}(-S\d{2})?$/ : /^U2-3\d{3}(-S\d{2})?$/;
    if (!series.test(j.jobNo)) issues.push(`Job ${j.jobNo} (${j.businessUnit}) outside its unit series`);
    if (!j.buyer || !j.orderNo || !j.poNo || !j.styleNo) issues.push(`Job ${j.jobNo} missing buyer / order / PO / style`);
    if (j.parentJob) {
      const p = byId.get(String(j.parentJob));
      if (!p || !j.jobNo.startsWith(`${p.jobNo}-S`) || p.businessUnit !== j.businessUnit) issues.push(`Sub job ${j.jobNo} has a wrong main job`);
    }
  });
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
  const keepAfter = { users: await User.countDocuments(), roles: await Role.countDocuments(), master: await models.master.countDocuments(), employee: await models.employee.countDocuments() };
  ['users', 'roles', 'master', 'employee'].forEach((k) => { if (keepAfter[k] < keepBefore[k]) issues.push(`${k} reduced from ${keepBefore[k]} to ${keepAfter[k]}`); });
  return { issues, checked, profits };
}

/* ============================== main ============================== */
async function main() {
  await connectDb();
  await bootstrap();
  const before = await inspect();
  log(`\nDatabase: ${mongoose.connection.db.databaseName}`);
  log('Transactions (to be replaced):', Object.entries(before.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none');
  log('Kept untouched:', Object.entries(before.keep).map(([k, n]) => `${k} ${n}`).join(', '));
  log('Existing jobs:', before.jobs.map((j) => `${j.jobNo}(${j.businessUnit})`).join(' ') || 'none');
  if (!APPLY) { log('\nDry run only – re-run with --apply to back up, clean and build the sample dataset.'); await mongoose.disconnect(); return; }

  await backupAndClean();
  const server = await startApi();
  log('\nBuilding sample dataset through the API…');
  const { created } = await buildDataset();
  server.close();

  log('\nValidating…');
  const v = await validate(before.keep);
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
  log(v.issues.length ? `\nVALIDATION ISSUES (${v.issues.length}):\n  ${v.issues.join('\n  ')}` : '\nVALIDATION: all checks passed – no duplicates, cross-unit leaks, orphans or broken references.');
  void created;
  await mongoose.disconnect();
  if (v.issues.length) process.exitCode = 1;
}

main().catch(async (e) => { console.error('\nFAILED:', e.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
