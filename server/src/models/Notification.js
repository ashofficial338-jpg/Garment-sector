import mongoose from 'mongoose';
import { unitScoped } from '../services/unitContext.js';

const notificationSchema = new mongoose.Schema({
  type: { type: String, index: true }, // TNA_DELAY, FABRIC_SHORTAGE, TRIM_SHORTAGE, APPROVAL_PENDING, PRODUCTION_DELAY, QUALITY_FAIL, SHIPMENT_DELAY, PAYMENT_DUE, JOB_READY_TO_CLOSE, INFO
  title: { type: String, required: true },
  message: String,
  severity: { type: String, enum: ['info', 'success', 'warning', 'danger'], default: 'info' },
  departments: { type: [String], index: true }, // role-based targeting
  users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
  jobNo: String,
  module: String,
  recordId: mongoose.Schema.Types.ObjectId,
  link: String,
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  dedupeKey: { type: String, index: { unique: true, sparse: true } },
}, { timestamps: true });
notificationSchema.index({ createdAt: -1 });
notificationSchema.plugin(unitScoped);

export const Notification = mongoose.model('Notification', notificationSchema);
