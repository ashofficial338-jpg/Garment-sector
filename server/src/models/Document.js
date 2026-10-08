import mongoose from 'mongoose';
import { unitScoped } from '../services/unitContext.js';

const versionSchema = new mongoose.Schema({
  version: Number,
  fileName: String,
  originalName: String,
  mimeType: String,
  size: Number,
  note: String,
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  uploadedByName: String,
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });

const documentSchema = new mongoose.Schema({
  refNo: { type: String, unique: true },
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', index: true },
  jobNo: { type: String, index: true },
  department: { type: String, index: true },
  docType: { type: String, required: true, index: true },
  title: { type: String, required: true },
  versions: [versionSchema],
  currentVersion: { type: Number, default: 1 },
  status: { type: String, default: 'Submitted' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: Date,
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdByName: String,
}, { timestamps: true });

documentSchema.plugin(unitScoped);
export const DocumentFile = mongoose.model('DocumentFile', documentSchema);
