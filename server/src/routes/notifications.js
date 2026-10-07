import express from 'express';
import mongoose from 'mongoose';
import { Notification } from '../models/Notification.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const r = express.Router();

/** Role-based visibility: Admin sees all; others see their department/role or direct notifications. */
const scope = (req) => {
  if (req.perms.isAdmin) return {};
  const groups = [req.user.department, req.user.role?.name, req.user.role?.department].filter(Boolean);
  return { $or: [{ departments: { $in: groups } }, { users: req.user._id }, { departments: { $size: 0 }, users: { $size: 0 } }] };
};

r.get('/', asyncHandler(async (req, res) => {
  const f = scope(req);
  if (req.query.unread === 'true') f.readBy = { $ne: req.user._id };
  if (req.query.type) f.type = req.query.type;
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  const [rows, unread] = await Promise.all([
    Notification.find(f).sort({ createdAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({ ...scope(req), readBy: { $ne: req.user._id } }),
  ]);
  res.json({ rows: rows.map((n) => ({ ...n, read: (n.readBy || []).some((u) => String(u) === String(req.user._id)), readBy: undefined })), unread });
}));

r.post('/read-all', asyncHandler(async (req, res) => {
  await Notification.updateMany({ ...scope(req), readBy: { $ne: req.user._id } }, { $addToSet: { readBy: req.user._id } });
  res.json({ ok: true });
}));

r.post('/:id/read', asyncHandler(async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await Notification.updateOne({ _id: req.params.id }, { $addToSet: { readBy: req.user._id } });
  res.json({ ok: true });
}));

export default r;
