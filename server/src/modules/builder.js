/**
 * Builds Mongoose models from the shared module registry.
 * Every module gets the same "envelope": refNo, job linkage, status engine fields,
 * soft-delete fields and ownership fields – so all records are traceable by Job No.
 */
import mongoose from 'mongoose';
import { MODULE_LIST } from '../../../shared/modules/index.js';

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

function fieldToSchema(f) {
  switch (f.type) {
    case 'number': return { type: Number, ...(f.default !== undefined ? { default: f.default } : {}) };
    case 'date': return { type: Date };
    case 'boolean': return { type: Boolean, default: false };
    case 'ref': return { type: ObjectId, ref: f.ref };
    case 'tags': return { type: [String], default: [] };
    case 'table': {
      const sub = {};
      f.fields.forEach((sf) => { sub[sf.name] = fieldToSchema(sf); });
      return { type: [new Schema(sub, { _id: true })], default: [] };
    }
    default: return { type: String, trim: true, ...(f.default !== undefined ? { default: f.default } : {}) };
  }
}

/** Extra server-only fields for specific modules */
const EXTENSIONS = {
  orders: {
    parentJob: { type: ObjectId, ref: 'Job', index: true },
    parentJobNo: { type: String, index: true },
    buyerName: String,
    subJobCode: String,
    enquiry: { type: ObjectId, ref: 'Enquiry' },
    costing: { type: ObjectId, ref: 'Costing' },
    quotation: { type: ObjectId, ref: 'Quotation' },
    stages: { type: Schema.Types.Mixed, default: {} },
    currentStage: String,
    progressPct: { type: Number, default: 0 },
    readyToClose: { type: Boolean, default: false },
    closureBlockers: [String],
    closedAt: Date,
    closedBy: { type: ObjectId, ref: 'User' },
    closureRemarks: String,
    expectedProfit: Number,
    expectedCost: Number,
    outstandingApproved: { type: Boolean, default: false },
    outstandingApprovedBy: { type: ObjectId, ref: 'User' },
  },
  quotation: { quoteGroup: { type: String, index: true }, supersededBy: { type: ObjectId, ref: 'Quotation' } },
  fabricBooking: { closedAt: Date, closedBy: { type: ObjectId, ref: 'User' }, readyToClose: Boolean },
};

export function buildSchema(def) {
  const shape = {
    refNo: { type: String },
    status: { type: String, default: def.defaultStatus, index: true },
    statusHistory: [{
      _id: false, from: String, to: String, at: { type: Date, default: Date.now },
      by: { type: ObjectId, ref: 'User' }, byName: String, reason: String, override: Boolean,
    }],
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: Date,
    deletedBy: { type: ObjectId, ref: 'User' },
    deleteReason: String,
    createdBy: { type: ObjectId, ref: 'User' },
    createdByName: String,
    updatedBy: { type: ObjectId, ref: 'User' },
  };

  if (def.jobLinked) {
    Object.assign(shape, {
      job: { type: ObjectId, ref: 'Job', index: !def.onePerJob, required: def.jobLinked === true },
      jobNo: { type: String, index: true },
      parentJob: { type: ObjectId, ref: 'Job', index: true },
      parentJobNo: { type: String, index: true },
      buyerName: String,
      styleNo: String,
      poNo: String,
    });
  }
  // buyer denormalisation for non-job modules that reference a buyer
  if (def.fields.some((f) => f.name === 'buyer')) shape.buyerName = String;
  if (def.fields.some((f) => f.name === 'supplier')) shape.supplierName = String;

  def.fields.forEach((f) => { shape[f.name] = fieldToSchema(f); });
  Object.assign(shape, EXTENSIONS[def.key] || {});

  const schema = new Schema(shape, { timestamps: true, strict: true, minimize: false });

  // Indexes for search / filter
  schema.index({ createdAt: -1 });
  def.fields.filter((f) => f.filter || f.search).forEach((f) => {
    if (f.type !== 'table' && !(def.isJob && f.name === 'jobNo')) schema.index({ [f.name]: 1 });
  });
  if (def.isJob) {
    schema.index({ jobNo: 1 }, { unique: true });
    schema.index({ buyer: 1, poNo: 1, styleNo: 1, isDeleted: 1, parentJob: 1 });
  } else {
    schema.index({ refNo: 1 }, { unique: true, sparse: true });
  }
  if (def.isJob) schema.index({ refNo: 1 });
  if (def.onePerJob) schema.index({ job: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
  return schema;
}

export const models = {};
export function buildModels() {
  MODULE_LIST.forEach((def) => {
    if (!models[def.key]) models[def.key] = mongoose.models[def.model] || mongoose.model(def.model, buildSchema(def));
  });
  return models;
}
buildModels();

export const modelFor = (key) => models[key];
