import mongoose from 'mongoose';

const auditSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  userName: String,
  action: { type: String, required: true, index: true }, // CREATE, UPDATE, DELETE, RESTORE, STATUS, LOGIN, CLOSE, OVERRIDE...
  module: { type: String, index: true },
  recordId: { type: mongoose.Schema.Types.ObjectId, index: true },
  refNo: String,
  jobNo: { type: String, index: true },
  changes: [{ _id: false, field: String, old: mongoose.Schema.Types.Mixed, new: mongoose.Schema.Types.Mixed }],
  message: String,
  reason: String,
  ip: String,
  userAgent: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
auditSchema.index({ createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditSchema);
