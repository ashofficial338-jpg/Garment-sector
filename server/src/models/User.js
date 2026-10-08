import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', required: true },
  department: { type: String, index: true },
  /** Business units this user may work in (Admin: all units) */
  units: { type: [String], default: undefined },
  phone: String,
  /** Extra per-user permissions on top of the role: { moduleKey: ['view','edit',...] } */
  permissions: { type: Map, of: [String], default: {} },
  /** Permissions explicitly removed from this user even if the role grants them */
  revoked: { type: Map, of: [String], default: {} },
  mustChangePassword: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  lastLoginAt: Date,
  lastLoginIp: String,
  failedLogins: { type: Number, default: 0 },
  lockUntil: Date,
  passwordChangedAt: Date,
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: Date,
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

userSchema.set('toJSON', {
  transform: (_d, r) => { delete r.passwordHash; delete r.__v; return r; },
});

export const User = mongoose.model('User', userSchema);
