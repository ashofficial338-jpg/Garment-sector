import mongoose from 'mongoose';

/** Refresh-token sessions (token stored hashed). Expired sessions are purged by a TTL index. */
const sessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  replacedBy: String,
  ip: String,
  userAgent: String,
  /** Business unit selected for this login session (carried across token refreshes) */
  unit: String,
}, { timestamps: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model('Session', sessionSchema);
