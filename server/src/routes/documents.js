/** Document management: upload, versions, preview/download, soft delete/restore – linked to Job. */
import express from 'express';
import mongoose from 'mongoose';
import { DocumentFile } from '../models/Document.js';
import { models } from '../modules/builder.js';
import { upload } from '../middleware/upload.js';
import { saveFile, openFile, fileExists, removeFile } from '../services/fileStore.js';
import { permit, adminOnly } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex, pageParams } from '../utils/query.js';
import { audit } from '../services/audit.js';
import { nextRefNo } from '../services/numbering.js';
import { refreshJobSoon } from '../services/lifecycle.js';
import { DOCUMENT_TYPES } from '../../../shared/constants.js';

const r = express.Router();

const store = (req) => saveFile(req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype, metadata: { uploadedBy: String(req.user._id) } });

r.get('/', permit('documents', 'view'), asyncHandler(async (req, res) => {
  const f = { isDeleted: req.perms.isAdmin && req.query.deleted === 'true' };
  if (req.query.job) f.$or = [{ jobNo: req.query.job }, ...(mongoose.isValidObjectId(req.query.job) ? [{ job: req.query.job }] : [])];
  if (req.query.docType) f.docType = req.query.docType;
  if (req.query.department) f.department = req.query.department;
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), 'i');
    f.$and = [{ $or: [{ title: rx }, { jobNo: rx }, { refNo: rx }, { docType: rx }] }];
  }
  const { page, limit, skip, sort } = pageParams(req.query);
  const [rows, total] = await Promise.all([DocumentFile.find(f).sort(sort).skip(skip).limit(limit).lean(), DocumentFile.countDocuments(f)]);
  res.json({ rows, total, page, limit, pages: Math.ceil(total / limit) });
}));

r.post('/', permit('documents', 'create'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('File is required');
  let fileId;
  let doc;
  try {
    const { job: jobKey, docType, title, department, note } = req.body;
    if (!DOCUMENT_TYPES.includes(docType)) throw ApiError.badRequest('Invalid document type');
    let job = null;
    if (jobKey) {
      job = mongoose.isValidObjectId(jobKey) ? await models.orders.findById(jobKey).lean() : await models.orders.findOne({ jobNo: jobKey }).lean();
      if (!job) throw ApiError.badRequest('Job not found');
    }
    fileId = await store(req);
    doc = await DocumentFile.create({
      refNo: await nextRefNo('DOC'), job: job?._id, jobNo: job?.jobNo,
      department: department || req.user.department, docType, title: title || req.file.originalname,
      versions: [{ version: 1, fileName: fileId, originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, note, uploadedBy: req.user._id, uploadedByName: req.user.name }],
      currentVersion: 1, createdBy: req.user._id, createdByName: req.user.name,
    });
    await audit(req, { action: 'UPLOAD', module: 'documents', record: doc, jobNo: doc.jobNo, message: `${req.user.name} uploaded ${docType} "${doc.title}"` });
    if (job) refreshJobSoon(job._id);
    res.status(201).json(doc);
  } catch (e) {
    if (fileId && !doc) await removeFile(fileId); // orphaned upload only
    throw e;
  }
}));

/* Replace → new version (history kept) */
r.post('/:id/versions', permit('documents', 'edit'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('File is required');
  const doc = await DocumentFile.findById(req.params.id);
  if (!doc || doc.isDeleted) throw ApiError.notFound();
  const version = doc.currentVersion + 1;
  const fileId = await store(req);
  doc.versions.push({ version, fileName: fileId, originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, note: req.body.note, uploadedBy: req.user._id, uploadedByName: req.user.name });
  doc.currentVersion = version;
  await doc.save();
  await audit(req, { action: 'VERSION', module: 'documents', record: doc, changes: [{ field: 'version', old: version - 1, new: version }], message: `${req.user.name} uploaded version ${version} of "${doc.title}"` });
  res.json(doc);
}));

r.get('/:id/file', permit('documents', 'view'), asyncHandler(async (req, res) => {
  const doc = await DocumentFile.findById(req.params.id).lean();
  if (!doc || (doc.isDeleted && !req.perms.isAdmin)) throw ApiError.notFound();
  const v = Number(req.query.version) || doc.currentVersion;
  const ver = doc.versions.find((x) => x.version === v);
  if (!ver) throw ApiError.notFound('Version not found');
  if (!(await fileExists(ver.fileName))) throw ApiError.notFound('File missing on server');
  res.setHeader('Content-Type', ver.mimeType || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const disp = req.query.download === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disp}; filename="${encodeURIComponent(ver.originalName)}"`);
  openFile(ver.fileName).on('error', () => res.destroy()).pipe(res);
}));

r.delete('/:id', permit('documents', 'delete'), asyncHandler(async (req, res) => {
  const doc = await DocumentFile.findById(req.params.id);
  if (!doc || doc.isDeleted) throw ApiError.notFound();
  doc.isDeleted = true; doc.deletedAt = new Date(); doc.deletedBy = req.user._id;
  await doc.save();
  await audit(req, { action: 'DELETE', module: 'documents', record: doc, reason: req.body?.reason, message: `${req.user.name} deleted document "${doc.title}"` });
  if (doc.job) refreshJobSoon(doc.job);
  res.json({ ok: true });
}));

r.post('/:id/restore', adminOnly, asyncHandler(async (req, res) => {
  const doc = await DocumentFile.findByIdAndUpdate(req.params.id, { isDeleted: false, deletedAt: null }, { new: true });
  if (!doc) throw ApiError.notFound();
  await audit(req, { action: 'RESTORE', module: 'documents', record: doc, message: `${req.user.name} restored document "${doc.title}"` });
  if (doc.job) refreshJobSoon(doc.job);
  res.json(doc);
}));

export default r;
