import mongoose from 'mongoose';

const roleSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  department: String,
  description: String,
  /** Full access – bypasses all permission checks */
  isAdmin: { type: Boolean, default: false },
  /** System roles cannot be deleted */
  isSystem: { type: Boolean, default: false },
  /** { moduleKey: ['view','create','edit','delete','approve','export','close','override','reports'] } */
  permissions: { type: Map, of: [String], default: {} },
  /** Department dashboard to land on */
  dashboard: String,
}, { timestamps: true });

export const Role = mongoose.model('Role', roleSchema);
