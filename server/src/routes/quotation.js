/** Quotation version control: revise an existing quotation into a new version. */
import express from 'express';
import { models } from '../modules/builder.js';
import { MODULES, applyCompute } from '../../../shared/modules/index.js';
import { permit } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { audit } from '../services/audit.js';
import { nextRefNo } from '../services/numbering.js';

const r = express.Router();
const def = MODULES.quotation;

r.post('/:id/revise', permit('quotation', 'create'), asyncHandler(async (req, res) => {
  const q = await models.quotation.findById(req.params.id);
  if (!q || q.isDeleted) throw ApiError.notFound();
  if (['Converted'].includes(q.status)) throw ApiError.badRequest('A converted quotation cannot be revised');
  const group = q.quoteGroup || q.refNo;
  const latest = await models.quotation.findOne({ quoteGroup: group, isDeleted: false }).sort({ version: -1 }).lean();
  const version = Math.max(q.version || 1, latest?.version || 1) + 1;
  const base = Object.fromEntries(def.fields.map((f) => [f.name, q[f.name]]));
  const data = applyCompute(def, { ...base, quoteDate: new Date(), version });
  const next = await models.quotation.create({
    ...data, quoteGroup: group, status: 'Draft', buyerName: q.buyerName, job: q.job, jobNo: q.jobNo,
    refNo: await nextRefNo(def.prefix), createdBy: req.user._id, createdByName: req.user.name,
    statusHistory: [{ from: null, to: 'Draft', by: req.user._id, byName: req.user.name, reason: `Revision of ${q.refNo} v${q.version}` }],
  });
  const from = q.status;
  q.quoteGroup = group;
  q.status = 'Revised';
  q.supersededBy = next._id;
  q.statusHistory.push({ from, to: 'Revised', by: req.user._id, byName: req.user.name, reason: `Superseded by ${next.refNo} v${version}` });
  await q.save();
  await audit(req, { action: 'REVISE', module: 'quotation', record: next, message: `${req.user.name} revised ${q.refNo} → ${next.refNo} (v${version})` });
  res.status(201).json(next);
}));

r.get('/:id/versions', permit('quotation', 'view'), asyncHandler(async (req, res) => {
  const q = await models.quotation.findById(req.params.id).lean();
  if (!q) throw ApiError.notFound();
  const group = q.quoteGroup || q.refNo;
  const rows = await models.quotation.find({ $or: [{ quoteGroup: group }, { refNo: group }], isDeleted: false }).sort({ version: 1 }).select('refNo version price orderQty status quoteDate quoteValue').lean();
  res.json(rows);
}));

export default r;
