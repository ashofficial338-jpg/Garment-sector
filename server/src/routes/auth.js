import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { audit } from '../services/audit.js';
import { effectivePermissions } from '../services/permissions.js';

const r = express.Router();
const COOKIE = 'gerp_rt';
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

// keyed by client IP + email so users behind one office NAT don't block each other
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.email || '').toLowerCase()}`, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many login attempts, try again later' } });

export const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
export const PASSWORD_HINT = 'Password must be at least 8 characters with upper & lower case letters, a number and a symbol';

function signAccess(user) {
  return jwt.sign({ sub: String(user._id), role: String(user.role?._id || user.role) }, env.accessSecret, { expiresIn: env.accessTtl });
}

async function issueRefresh(req, res, user) {
  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + env.refreshTtlDays * 86400000);
  await Session.create({ user: user._id, tokenHash: hash(token), expiresAt, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.cookie(COOKIE, token, {
    httpOnly: true, secure: env.isProd, sameSite: 'strict', expires: expiresAt, path: '/api/auth',
  });
  return token;
}

export function userPayload(user) {
  const perms = effectivePermissions(user);
  return {
    _id: user._id, name: user.name, email: user.email, department: user.department,
    role: user.role ? { _id: user.role._id, name: user.role.name, isAdmin: user.role.isAdmin, dashboard: user.role.dashboard } : null,
    mustChangePassword: user.mustChangePassword, isAdmin: perms.isAdmin, permissions: perms.map,
  };
}

r.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  if (!email || !password) throw ApiError.badRequest('Email and password are required');
  const user = await User.findOne({ email, isDeleted: false }).select('+passwordHash').populate('role');
  const fail = () => ApiError.unauthorized('Invalid email or password');
  if (!user) throw fail();
  if (user.lockUntil && user.lockUntil > new Date()) throw new ApiError(423, `Account locked until ${user.lockUntil.toLocaleTimeString()}`);
  if (!user.isActive) throw ApiError.unauthorized('Account disabled – contact Admin');
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    user.failedLogins += 1;
    if (user.failedLogins >= 5) { user.lockUntil = new Date(Date.now() + 15 * 60000); user.failedLogins = 0; }
    await user.save();
    await audit({ user, ip: req.ip, headers: req.headers }, { action: 'LOGIN_FAILED', module: 'auth', message: `Failed login for ${email}` });
    throw fail();
  }
  user.failedLogins = 0; user.lockUntil = null; user.lastLoginAt = new Date(); user.lastLoginIp = req.ip;
  await user.save();
  await issueRefresh(req, res, user);
  await audit({ user, ip: req.ip, headers: req.headers }, { action: 'LOGIN', module: 'auth', message: `${user.name} signed in` });
  res.json({ accessToken: signAccess(user), user: userPayload(user) });
}));

r.post('/refresh', asyncHandler(async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (!token) throw ApiError.unauthorized('No session');
  const session = await Session.findOne({ tokenHash: hash(token) });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    // token reuse after rotation → revoke every session of that user
    if (session?.revokedAt) await Session.updateMany({ user: session.user, revokedAt: null }, { revokedAt: new Date() });
    res.clearCookie(COOKIE, { path: '/api/auth' });
    throw ApiError.unauthorized('Session expired');
  }
  const user = await User.findById(session.user).populate('role');
  if (!user || !user.isActive || user.isDeleted) throw ApiError.unauthorized('Account disabled');
  const next = await issueRefresh(req, res, user);
  session.revokedAt = new Date(); session.replacedBy = hash(next);
  await session.save();
  res.json({ accessToken: signAccess(user), user: userPayload(user) });
}));

r.post('/logout', asyncHandler(async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) await Session.updateOne({ tokenHash: hash(token) }, { revokedAt: new Date() });
  res.clearCookie(COOKIE, { path: '/api/auth' });
  res.json({ ok: true });
}));

r.get('/me', authenticate, (req, res) => res.json(userPayload(req.user)));

r.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id).select('+passwordHash').populate('role');
  if (!(await bcrypt.compare(String(currentPassword || ''), user.passwordHash))) throw ApiError.badRequest('Current password is incorrect');
  if (!PASSWORD_RULE.test(String(newPassword || ''))) throw ApiError.badRequest(PASSWORD_HINT);
  if (await bcrypt.compare(String(newPassword), user.passwordHash)) throw ApiError.badRequest('New password must differ from the current password');
  user.passwordHash = await bcrypt.hash(String(newPassword), 12);
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date();
  await user.save();
  await Session.updateMany({ user: user._id, revokedAt: null }, { revokedAt: new Date() });
  await issueRefresh(req, res, user);
  await audit(req, { action: 'PASSWORD_CHANGE', module: 'auth', message: `${user.name} changed password` });
  res.json({ accessToken: signAccess(user), user: userPayload(user) });
}));

export default r;
