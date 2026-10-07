/**
 * Generic, permission-enforced CRUD router generated for every registry module.
 *
 *  GET    /                list (search, filter, sort, pagination)
 *  GET    /export          CSV / Excel export
 *  GET    /:id             single record (+ allowed transitions)
 *  POST   /                create
 *  PUT    /:id             update (audited diff)
 *  POST   /:id/status      status change (status engine, override with reason)
 *  DELETE /:id             soft delete (reason)
 *  POST   /:id/restore     restore (admin)
 */
import express from 'express';
import mongoose from 'mongoose';
import { models } from './builder.js';
import { hooks } from './hooks.js';
import { buildFilter, populateSpec } from './filters.js';
import { applyCompute, validateRecord, allowedTransitions } from '../../../shared/modules/index.js';
import { permit, adminOnly } from '../middleware/auth.js';
import { can } from '../services/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { pageParams } from '../utils/query.js';
import { diffObjects } from '../utils/diff.js';
import { audit, describeChanges } from '../services/audit.js';
import { nextRefNo } from '../services/numbering.js';
import { refreshJobSoon } from '../services/lifecycle.js';
import { sendExport, moduleColumns } from '../services/exporter.js';

const APPROVAL_STATUSES = ['Approved', 'Final Approved', 'Rejected', 'Verified', 'Reconciled', 'Passed', 'Failed'];
const LOCKED_STATUSES = ['Closed', 'Fabric Job Closed', 'Cancelled', 'Converted'];
const ENVELOPE = ['_id', 'refNo', 'status', 'statusHistory', 'isDeleted', 'deletedAt', 'deletedBy', 'deleteReason',
  'createdBy', 'createdByName', 'updatedBy', 'createdAt', 'updatedAt', 'jobNo', 'parentJob', 'parentJobNo',
  'buyerName', 'supplierName', 'styleNo_', '__v'];

/** Keep only editable business fields from the client payload. */
function sanitize(def, body) {
  const out = {};
  def.fields.forEach((f) => {
    if (f.readOnly || !(f.name in body)) return;
    let v = body[f.name];
    if (f.type === 'ref' && v && typeof v === 'object') v = v._id;
    if (f.type === 'ref' && v === '') v = null;
    if (f.type === 'number' && v !== null && v !== '' && v !== undefined) v = Number(v);
    if (f.type === 'number' && v === '') v = null;
    if (f.type === 'date' && v === '') v = null;
    if (f.type === 'table' && Array.isArray(v)) {
      v = v.map((row) => {
        const r = {};
        if (row?._id && mongoose.isValidObjectId(row._id)) r._id = row._id;
        f.fields.forEach((sf) => {
          let x = row?.[sf.name];
          if (sf.type === 'number' && x !== '' && x !== null && x !== undefined) x = Number(x);
          if ((sf.type === 'number' || sf.type === 'date') && x === '') x = null;
          if (!sf.readOnly || f.tna) r[sf.name] = x;
        });
        return r;
      });
    }
    out[f.name] = v;
  });
  return out;
}

async function resolveJob(def, body, existing) {
  if (!def.jobLinked) return null;
  const Job = models.orders;
  const key = body.job || body.jobNo || existing?.job;
  if (!key) {
    if (def.jobLinked === true) throw ApiError.badRequest('Job No is required');
    return null;
  }
  const job = mongoose.isValidObjectId(key) ? await Job.findById(key).lean() : await Job.findOne({ jobNo: String(key).trim() }).lean();
  if (!job || job.isDeleted) throw ApiError.badRequest(`Job ${key} not found`);
  return job;
}

async function denormalise(def, data, job) {
  const extra = {};
  if (job) Object.assign(extra, {
    job: job._id, jobNo: job.jobNo, parentJob: job.parentJob || null, parentJobNo: job.parentJobNo || null,
    buyerName: job.buyerName, styleNo: data.styleNo || job.styleNo, poNo: job.poNo,
  });
  if (data.buyer && def.fields.some((f) => f.name === 'buyer')) {
    const b = await models.buyer.findById(data.buyer).lean();
    extra.buyerName = b?.name;
  }
  if (data.supplier) {
    const s = await models.supplier.findById(data.supplier).lean();
    extra.supplierName = s?.name;
  }
  return extra;
}

function overrideAllowed(req, def) {
  const reason = req.body?._override?.reason?.trim();
  return reason && can(req.perms, def.key, 'override') ? reason : null;
}

export function crudRouter(def) {
  const r = express.Router();
  const Model = models[def.key];
  const H = hooks[def.key] || {};
  const pop = populateSpec(def);

  /* ------------------------------ LIST ------------------------------ */
  r.get('/', permit(def.key, 'view'), asyncHandler(async (req, res) => {
    const filter = await buildFilter(def, req.query, { allowDeleted: req.perms.isAdmin });
    const { page, limit, skip, sort } = pageParams(req.query);
    const [rows, total] = await Promise.all([
      Model.find(filter).sort(sort).skip(skip).limit(limit).populate(pop).lean(),
      Model.countDocuments(filter),
    ]);
    res.json({ rows, total, page, limit, pages: Math.ceil(total / limit) });
  }));

  /* ------------------------------ EXPORT ------------------------------ */
  r.get('/export', permit(def.key, 'export'), asyncHandler(async (req, res) => {
    const filter = await buildFilter(def, req.query, { allowDeleted: req.perms.isAdmin });
    const rows = await Model.find(filter).sort({ createdAt: -1 }).limit(20000).populate(pop).lean();
    await audit(req, { action: 'EXPORT', module: def.key, message: `Exported ${rows.length} ${def.title} rows (${req.query.format || 'json'})` });
    await sendExport(res, req.query.format, moduleColumns(def), rows, def.key);
  }));

  /* ------------------------------ READ ------------------------------ */
  r.get('/:id', permit(def.key, 'view'), asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound();
    const doc = await Model.findById(req.params.id).populate(pop).lean();
    if (!doc || (doc.isDeleted && !req.perms.isAdmin)) throw ApiError.notFound();
    res.json({ ...doc, _transitions: allowedTransitions(def, doc.status) });
  }));

  /* ------------------------------ CREATE ------------------------------ */
  r.post('/', permit(def.key, 'create'), asyncHandler(async (req, res) => {
    if (def.isJob) throw ApiError.badRequest('Use /api/jobs to confirm orders');
    const job = await resolveJob(def, req.body);
    const reason = overrideAllowed(req, def);
    if (job && ['Closed', 'Cancelled'].includes(job.status) && !reason) throw ApiError.badRequest(`Job ${job.jobNo} is ${job.status}. Override with reason required.`);
    if (def.onePerJob && job && await Model.exists({ job: job._id, isDeleted: false })) {
      throw ApiError.conflict(`${def.singular} already exists for ${job.jobNo}`);
    }
    const defaults = Object.fromEntries(def.fields.filter((f) => f.default !== undefined && !f.readOnly).map((f) => [f.name, f.default]));
    let data = { ...defaults, ...(def.prefill && job ? def.prefill(job) : {}), ...sanitize(def, req.body) };
    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
    data.status = def.defaultStatus;
    const ctx = { def, data, job, req, isCreate: true, override: !!reason };
    data = applyCompute(def, data); ctx.data = data;
    if (H.beforeSave) await H.beforeSave(ctx);
    data = applyCompute(def, ctx.data);
    const errors = validateRecord(def, data);
    if (Object.keys(errors).length) throw ApiError.badRequest('Validation failed', errors);

    const doc = await Model.create({
      ...data,
      ...(await denormalise(def, data, job)),
      refNo: await nextRefNo(def.prefix),
      createdBy: req.user._id, createdByName: req.user.name,
      statusHistory: [{ from: null, to: data.status, by: req.user._id, byName: req.user.name }],
    });
    await audit(req, { action: 'CREATE', module: def.key, record: doc, message: `${req.user.name} created ${def.singular} ${doc.refNo}` });
    if (ctx.overrideUsed) await audit(req, { action: 'OVERRIDE', module: def.key, record: doc, reason, message: ctx.overrideUsed.join('; ') });
    ctx.saved = doc.toObject();
    if (H.afterSave) await H.afterSave(ctx);
    if (job) refreshJobSoon(job._id);
    res.status(201).json(doc);
  }));

  /* ------------------------------ UPDATE ------------------------------ */
  r.put('/:id', permit(def.key, 'edit'), asyncHandler(async (req, res) => {
    if (def.isJob) throw ApiError.badRequest('Use /api/jobs/:id to edit orders');
    const doc = await Model.findById(req.params.id);
    if (!doc || doc.isDeleted) throw ApiError.notFound();
    const reason = overrideAllowed(req, def);
    if (LOCKED_STATUSES.includes(doc.status) && !reason) throw ApiError.badRequest(`${def.singular} is ${doc.status} and locked. Override with reason required.`);
    const before = doc.toObject();
    const job = await resolveJob(def, { job: before.job });
    let data = { ...before, ...sanitize(def, req.body) };
    const ctx = { def, data, existing: before, job, req, isCreate: false, override: !!reason };
    data = applyCompute(def, data); ctx.data = data;
    if (H.beforeSave) await H.beforeSave(ctx);
    data = applyCompute(def, ctx.data);
    if (!def.autoStatus) data.status = before.status;
    const errors = validateRecord(def, data);
    if (Object.keys(errors).length) throw ApiError.badRequest('Validation failed', errors);

    def.fields.forEach((f) => doc.set(f.name, data[f.name]));
    if (data.status !== before.status) {
      doc.status = data.status;
      doc.statusHistory.push({ from: before.status, to: data.status, by: req.user._id, byName: req.user.name, reason: 'Automatic (calculated)' });
    }
    Object.assign(doc, await denormalise(def, data, job));
    doc.updatedBy = req.user._id;
    await doc.save();
    const changes = diffObjects(before, doc.toObject());
    if (changes.length) {
      await audit(req, { action: 'UPDATE', module: def.key, record: doc, changes, message: describeChanges(req.user.name, def, changes) });
    }
    if (ctx.overrideUsed) await audit(req, { action: 'OVERRIDE', module: def.key, record: doc, reason, message: ctx.overrideUsed.join('; ') });
    ctx.saved = doc.toObject();
    if (H.afterSave) await H.afterSave(ctx);
    if (job) refreshJobSoon(job._id);
    res.json(doc);
  }));

  /* ------------------------------ STATUS ------------------------------ */
  r.post('/:id/status', permit(def.key, 'edit'), asyncHandler(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc || doc.isDeleted) throw ApiError.notFound();
    const to = String(req.body.status || '');
    const reasonText = String(req.body.reason || '').trim();
    const from = doc.status;
    if (to === from) return res.json(doc);
    const isClose = (def.closeStatuses || []).includes(to);
    const valid = def.statuses.includes(to) || isClose;
    if (!valid) throw ApiError.badRequest(`Invalid status "${to}"`);
    const normal = allowedTransitions(def, from).includes(to);
    let override = false;

    if (isClose) {
      if (!can(req.perms, def.key, 'close')) throw ApiError.forbidden('Close permission required');
      if (def.key === 'fabricBooking' && !String(doc.closureVerdict || '').startsWith('READY')) {
        if (!can(req.perms, def.key, 'override') || !reasonText) throw ApiError.badRequest('Fabric job is not ready to close. Override with reason required.', { code: 'OVERRIDE_REQUIRED' });
        override = true;
      }
    } else if (!normal) {
      if (!can(req.perms, def.key, 'override')) throw ApiError.forbidden(`Cannot move from "${from}" to "${to}" – stage skipping requires override permission`);
      if (!reasonText) throw ApiError.badRequest('A reason is mandatory for status override', { code: 'OVERRIDE_REQUIRED' });
      override = true;
    }
    if (APPROVAL_STATUSES.includes(to) && !can(req.perms, def.key, 'approve')) throw ApiError.forbidden('Approve permission required');

    doc.status = to;
    if (def.compute) {
      const next = applyCompute(def, doc.toObject());
      def.fields.filter((f) => f.readOnly).forEach((f) => doc.set(f.name, next[f.name]));
      if (def.autoStatus && next.status) doc.status = def.key === 'invoice' && ['Draft', 'Cancelled', 'Closed'].includes(to) ? to : next.status;
    }
    if (isClose && def.key === 'fabricBooking') { doc.closedAt = new Date(); doc.closedBy = req.user._id; doc.closureVerdict = 'CLOSED'; }
    doc.statusHistory.push({ from, to: doc.status, by: req.user._id, byName: req.user.name, reason: reasonText, override });
    doc.updatedBy = req.user._id;
    await doc.save();
    await audit(req, {
      action: override ? 'OVERRIDE' : isClose ? 'CLOSE' : 'STATUS', module: def.key, record: doc, reason: reasonText,
      changes: [{ field: 'status', old: from, new: doc.status }],
      message: `${req.user.name} changed status of ${doc.refNo} from ${from} to ${doc.status}${override ? ' (override)' : ''}`,
    });
    const ctx = { def, data: doc.toObject(), existing: { status: from }, req, saved: doc.toObject(), statusExplicit: true };
    if (def.jobLinked && doc.job) ctx.job = await models.orders.findById(doc.job).lean();
    if (H.afterSave && (ctx.job || !def.jobLinked)) await H.afterSave(ctx);
    if (doc.job) refreshJobSoon(doc.job);
    res.json(doc);
  }));

  /* ------------------------------ DELETE (soft) ------------------------------ */
  r.delete('/:id', permit(def.key, 'delete'), asyncHandler(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc || doc.isDeleted) throw ApiError.notFound();
    if (def.isJob) throw ApiError.badRequest('Use /api/jobs/:id to delete orders');
    if (LOCKED_STATUSES.includes(doc.status) && !req.perms.isAdmin) throw ApiError.forbidden('Closed records can only be deleted by Admin');
    doc.isDeleted = true; doc.deletedAt = new Date(); doc.deletedBy = req.user._id;
    doc.deleteReason = String(req.body?.reason || req.query.reason || '').slice(0, 500);
    await doc.save();
    await audit(req, { action: 'DELETE', module: def.key, record: doc, reason: doc.deleteReason, message: `${req.user.name} deleted ${def.singular} ${doc.refNo}` });
    if (H.afterDelete) await H.afterDelete(doc.toObject());
    if (doc.job) refreshJobSoon(doc.job);
    res.json({ ok: true });
  }));

  /* ------------------------------ RESTORE ------------------------------ */
  r.post('/:id/restore', adminOnly, asyncHandler(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc || !doc.isDeleted) throw ApiError.notFound('Deleted record not found');
    doc.isDeleted = false; doc.deletedAt = null; doc.deletedBy = null; doc.deleteReason = null;
    await doc.save();
    await audit(req, { action: 'RESTORE', module: def.key, record: doc, message: `${req.user.name} restored ${def.singular} ${doc.refNo}` });
    if (H.afterDelete) await H.afterDelete(doc.toObject());
    if (doc.job) refreshJobSoon(doc.job);
    res.json(doc);
  }));

  return r;
}
