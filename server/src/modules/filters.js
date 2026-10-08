import mongoose from 'mongoose';
import { escapeRegex } from '../utils/query.js';

/** First date field of a module (used for date range filtering). */
export const primaryDateField = (def) => def.fields.find((f) => f.type === 'date')?.name || 'createdAt';

/**
 * Build a Mongo filter from query params (shared by list, export and reports):
 *   q, job (Job No or id; includes sub jobs), status, from, to, dateField, createdBy, buyer, style, deleted, f_<field>
 */
export async function buildFilter(def, q = {}, { allowDeleted = false } = {}) {
  const filter = { isDeleted: allowDeleted && q.deleted === 'true' ? true : false };
  const and = [];

  if (q.q) {
    const rx = new RegExp(escapeRegex(String(q.q).trim()), 'i');
    const fields = ['refNo', ...(def.jobLinked ? ['jobNo', 'parentJobNo', 'buyerName', 'styleNo', 'poNo'] : []),
      ...(def.fields.some((f) => f.name === 'buyer') ? ['buyerName'] : []),
      ...(def.fields.some((f) => f.name === 'supplier') ? ['supplierName'] : []),
      ...def.fields.filter((f) => f.search && f.type !== 'table').map((f) => f.name)];
    and.push({ $or: [...new Set(fields)].map((f) => ({ [f]: rx })) });
  }

  if (q.job) {
    const key = String(q.job).trim();
    if (def.isJob) {
      and.push({ $or: [{ jobNo: key }, { parentJobNo: key }] });
    } else if (def.jobLinked) {
      const ors = [{ jobNo: key }, { parentJobNo: key }];
      if (mongoose.isValidObjectId(key)) ors.push({ job: key }, { parentJob: key });
      and.push({ $or: ors });
    }
  }

  if (q.status) filter.status = { $in: String(q.status).split(',') };
  if (q.createdBy && mongoose.isValidObjectId(q.createdBy)) filter.createdBy = q.createdBy;
  if (q.buyer) {
    const rx = new RegExp(escapeRegex(q.buyer), 'i');
    if (def.isJob || def.jobLinked || def.fields.some((f) => f.name === 'buyer')) and.push({ buyerName: rx });
  }
  if (q.style && (def.jobLinked || def.isJob || def.fields.some((f) => f.name === 'styleNo'))) and.push({ styleNo: new RegExp(escapeRegex(q.style), 'i') });
  if (q.department && def.department && q.department !== def.department) filter._id = null; // module belongs to another department

  const dateField = q.dateField && /^\w+$/.test(q.dateField) ? q.dateField : primaryDateField(def);
  if (q.from || q.to) {
    const r = {};
    if (q.from) r.$gte = new Date(q.from);
    if (q.to) { const t = new Date(q.to); t.setHours(23, 59, 59, 999); r.$lte = t; }
    filter[dateField] = r;
  }

  Object.entries(q).forEach(([k, v]) => {
    if (!k.startsWith('f_') || v === '' || v === undefined) return;
    const name = k.slice(2);
    const f = def.fields.find((x) => x.name === name);
    if (!f) return;
    if (f.type === 'select' || f.type === 'ref') filter[name] = { $in: String(v).split(',') };
    else if (f.type === 'boolean') filter[name] = v === 'true';
    else if (f.type === 'number') filter[name] = Number(v);
    else filter[name] = new RegExp(escapeRegex(v), 'i');
  });

  if (and.length) filter.$and = and;
  return filter;
}

/** Populate spec for reference fields (except Job which is denormalised). */
export function populateSpec(def) {
  return def.fields.filter((f) => f.type === 'ref')
    .map((f) => ({ path: f.name, select: 'refNo name jobNo styleNo invoiceNo totalAmount outstanding status sellingPrice orderQty patternNo markerNo revision' }));
}
