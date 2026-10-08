/** Global search across Job No / Order No / PO / Buyer / Style / Fabric / Supplier / Status / Shipment. */
import express from 'express';
import { models } from '../modules/builder.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { escapeRegex } from '../utils/query.js';
import { can } from '../services/permissions.js';

const r = express.Router();

r.get('/', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const rx = new RegExp(escapeRegex(q), 'i');
  const live = { isDeleted: false };
  const out = [];
  const add = (type, module, rows, label, sub) => rows.forEach((x) => out.push({ type, module, _id: x._id, jobNo: x.jobNo, title: label(x), subtitle: sub(x), status: x.status }));
  const asDate = /^\d{4}-\d{2}-\d{2}$/.test(q) ? new Date(q) : null;

  if (can(req.perms, 'orders', 'view') || can(req.perms, 'jobs', 'view')) {
    const or = [{ jobNo: rx }, { orderNo: rx }, { poNo: rx }, { styleNo: rx }, { buyerName: rx }, { fabricType: rx }, { status: rx }, { destination: rx }, { product: rx }, { currentStage: rx }];
    if (asDate) or.push({ shipmentDate: asDate });
    add('Job', 'orders', await models.orders.find({ ...live, $or: or }).limit(15).lean(),
      (x) => `${x.jobNo} · ${x.styleNo}`, (x) => `${x.buyerName || ''} · PO ${x.poNo} · ${x.orderQty} pcs · ${x.currentStage || ''}`);
  }
  const extra = [
    ['enquiry', 'Enquiry', [{ styleNo: rx }, { buyerName: rx }, { product: rx }], (x) => `${x.refNo} · ${x.styleNo}`, (x) => x.buyerName],
    ['quotation', 'Quotation', [{ styleNo: rx }, { buyerName: rx }], (x) => `${x.refNo} v${x.version || 1} · ${x.styleNo}`, (x) => `${x.buyerName || ''} · ${x.price} ${x.currency}`],
    ['pattern', 'Pattern', [{ patternNo: rx }, { cadFileName: rx }, { patternMaker: rx }], (x) => `${x.refNo} · ${x.patternNo}`, (x) => `${x.jobNo} · ${x.patternType || ''} · rev ${x.revision || 1}`],
    ['marker', 'Marker', [{ markerNo: rx }, { ratio: rx }], (x) => `${x.refNo} · ${x.markerNo}`, (x) => `${x.jobNo} · ${x.consumptionPerPc} ${x.unit}/pc`],
    ['fabricBooking', 'Fabric', [{ fabricType: rx }, { supplierName: rx }, { supplierPoNo: rx }, { composition: rx }], (x) => `${x.refNo} · ${x.fabricType}`, (x) => `${x.jobNo} · ${x.supplierName || ''} · ${x.closureVerdict || ''}`],
    ['trimBooking', 'Trim', [{ supplierName: rx }, { description: rx }, { item: rx }], (x) => `${x.refNo} · ${x.item}`, (x) => `${x.jobNo} · ${x.supplierName || ''}`],
    ['shipment', 'Shipment', [{ blAwbNo: rx }, { invoiceNo: rx }, { containerNo: rx }, { forwarder: rx }, { vesselFlight: rx }], (x) => `${x.refNo} · ${x.invoiceNo || ''}`, (x) => `${x.jobNo} · ${x.mode} · BL ${x.blAwbNo || '-'}`],
    ['invoice', 'Invoice', [{ invoiceNo: rx }], (x) => `${x.invoiceNo}`, (x) => `${x.jobNo} · ${x.totalAmount} ${x.currency}`],
    ['supplier', 'Supplier', [{ name: rx }, { code: rx }, { supplierType: rx }], (x) => x.name, (x) => x.supplierType],
    ['buyer', 'Buyer', [{ name: rx }, { code: rx }], (x) => x.name, (x) => x.country],
  ];
  for (const [key, type, or, label, sub] of extra) {
    if (!can(req.perms, key, 'view')) continue;
    const ors = [...or, { refNo: rx }];
    if (models[key].schema.path('jobNo')) ors.push({ jobNo: rx });
    add(type, key, await models[key].find({ ...live, $or: ors }).limit(8).lean(), label, sub);
  }
  res.json({ results: out.slice(0, 60) });
}));

export default r;
