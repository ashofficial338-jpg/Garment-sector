/** Lightweight lookups for pickers (minimal fields only). */
import express from 'express';
import mongoose from 'mongoose';
import { models } from '../modules/builder.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/query.js';

const r = express.Router();

const SOURCES = {
  Job: { model: 'orders', fields: 'jobNo styleNo buyerName poNo orderQty status parentJobNo isForecast', search: ['jobNo', 'styleNo', 'poNo', 'buyerName'], label: (x) => `${x.jobNo} · ${x.styleNo} · ${x.buyerName || ''}` },
  Buyer: { model: 'buyer', fields: 'name code country currency paymentTerms', search: ['name', 'code'], label: (x) => x.name },
  Supplier: { model: 'supplier', fields: 'name code supplierType', search: ['name', 'code', 'supplierType'], label: (x) => `${x.name}${x.supplierType ? ` (${x.supplierType})` : ''}` },
  Enquiry: { model: 'enquiry', fields: 'refNo styleNo buyerName status', search: ['refNo', 'styleNo', 'buyerName'], label: (x) => `${x.refNo} · ${x.styleNo} · ${x.buyerName || ''}` },
  Costing: { model: 'costing', fields: 'refNo styleNo buyerName status sellingPrice', search: ['refNo', 'styleNo', 'buyerName'], label: (x) => `${x.refNo} · ${x.styleNo} · ${x.status}` },
  Quotation: { model: 'quotation', fields: 'refNo styleNo buyerName version status', search: ['refNo', 'styleNo'], label: (x) => `${x.refNo} v${x.version} · ${x.styleNo}` },
  Invoice: { model: 'invoice', fields: 'refNo invoiceNo jobNo totalAmount outstanding currency', search: ['invoiceNo', 'jobNo'], label: (x) => `${x.invoiceNo} · ${x.jobNo} · O/S ${x.outstanding} ${x.currency}` },
  FabricBooking: { model: 'fabricBooking', fields: 'refNo jobNo fabricType color unit requiredQty receivedQty issuedQty status', search: ['refNo', 'jobNo', 'fabricType'], label: (x) => `${x.refNo} · ${x.fabricType} ${x.color || ''} · req ${x.requiredQty ?? 0} / rcvd ${x.receivedQty ?? 0} ${x.unit || ''}` },
  FabricForecast: { model: 'fabricForecast', fields: 'refNo jobNo fabricType color unit lotNo receivedQty transferredQty balanceQty status', search: ['refNo', 'jobNo', 'fabricType', 'lotNo'], label: (x) => `${x.refNo} · ${x.fabricType} ${x.color || ''} · lot ${x.lotNo || '—'} · available ${x.balanceQty ?? 0} ${x.unit || ''}` },
  TechSpec: { model: 'techSpec', fields: 'refNo jobNo revision status', search: ['refNo', 'jobNo'], label: (x) => `${x.refNo} rev ${x.revision || 1} · ${x.jobNo} · ${x.status}` },
  Pattern: { model: 'pattern', fields: 'refNo jobNo patternNo revision status', search: ['refNo', 'patternNo', 'jobNo'], label: (x) => `${x.patternNo} rev ${x.revision || 1} · ${x.jobNo} · ${x.status}` },
  Marker: { model: 'marker', fields: 'refNo jobNo markerNo ratio status', search: ['refNo', 'markerNo', 'jobNo'], label: (x) => `${x.markerNo} · ${x.ratio || ''} · ${x.status}` },
  FabricReturn: { model: 'fabricReturn', fields: 'refNo jobNo returnType qty unit rate status', search: ['refNo', 'jobNo'], label: (x) => `${x.refNo} · ${x.jobNo} · ${x.qty} ${x.unit || ''} · ${x.returnType}` },
  BuyerOrder: { model: 'buyerOrder', fields: 'refNo poNo styleNo buyerName orderQty orderType deliveryDate status jobNo', search: ['refNo', 'poNo', 'styleNo', 'buyerName'], label: (x) => `${x.poNo} · ${x.styleNo} · ${x.orderQty} pcs · ${x.buyerName || ''} (${x.refNo})` },
  Shipment: { model: 'shipment', fields: 'refNo invoiceNo jobNo qty status', search: ['refNo', 'invoiceNo', 'jobNo'], label: (x) => `${x.refNo} · ${x.jobNo} · ${x.qty} pcs` },
};

r.get('/master/:type', asyncHandler(async (req, res) => {
  const rows = await models.master.find({ isDeleted: false, status: 'Active', masterType: req.params.type }).select('name code value').sort({ name: 1 }).lean();
  res.json(rows);
}));

r.get('/users', asyncHandler(async (req, res) => {
  // people who work in the current unit (Admin-role users reach every unit)
  const adminRoles = await Role.find({ isAdmin: true }).select('_id').lean();
  const rows = await User.find({ isDeleted: false, isActive: true, $or: [{ units: req.unit }, { role: { $in: adminRoles.map((x) => x._id) } }] }).select('name department').sort({ name: 1 }).lean();
  res.json(rows.map((u) => ({ _id: u._id, label: `${u.name} (${u.department || '-'})` })));
}));

/* Full job snapshot used to prefill forms (no re-entry) */
r.get('/job/:key', asyncHandler(async (req, res) => {
  const key = req.params.key;
  const job = mongoose.isValidObjectId(key) ? await models.orders.findById(key).lean() : await models.orders.findOne({ jobNo: key }).lean();
  if (!job || job.isDeleted) throw ApiError.notFound('Job not found');
  const { statusHistory, ...rest } = job;
  res.json(rest);
}));

r.get('/:ref', asyncHandler(async (req, res) => {
  const src = SOURCES[req.params.ref];
  if (!src) throw ApiError.notFound('Unknown lookup');
  const f = { isDeleted: false };
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), 'i');
    f.$or = src.search.map((k) => ({ [k]: rx }));
  }
  if (req.query.job && src.model !== 'orders') f.jobNo = req.query.job;
  if (req.query.id && mongoose.isValidObjectId(req.query.id)) { delete f.$or; f._id = req.query.id; }
  if (req.params.ref === 'Job' && req.query.open === 'true') f.status = { $nin: ['Closed', 'Cancelled'] };
  if (req.params.ref === 'Job' && req.query.awaitingPo === 'true') f.poStatus = 'Awaiting PO';
  // buyer POs not yet on a job
  if (req.params.ref === 'BuyerOrder' && req.query.open === 'true') { f.status = { $in: ['Received', 'Under Review'] }; f.jobNo = { $in: [null, ''] }; }
  if (req.query.buyer && mongoose.isValidObjectId(req.query.buyer) && ['Job', 'BuyerOrder'].includes(req.params.ref)) f.buyer = req.query.buyer;
  const rows = await models[src.model].find(f).select(src.fields).sort({ createdAt: -1 }).limit(30).lean();
  res.json(rows.map((x) => ({ ...x, label: src.label(x) })));
}));

export default r;
