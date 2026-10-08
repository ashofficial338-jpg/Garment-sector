import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { effectivePermissions, can, allowedUnits } from '../services/permissions.js';
import { unitContext, ALL_UNITS } from '../services/unitContext.js';

/**
 * Short-lived cache of authenticated users (with role) – saves two database round trips per request.
 * Cleared whenever a user, role or password changes (see clearUserCache).
 */
const USER_TTL_MS = 30000;
const userCache = new Map();
export function clearUserCache(userId) {
  if (userId) userCache.delete(String(userId)); else userCache.clear();
}
async function loadUser(id) {
  const hit = userCache.get(id);
  if (hit && hit.expires > Date.now()) return hit.user;
  const user = await User.findById(id).populate('role');
  if (user) userCache.set(id, { user, expires: Date.now() + USER_TTL_MS });
  if (userCache.size > 2000) userCache.delete(userCache.keys().next().value);
  return user;
}

/** Verifies the Bearer access token and attaches req.user + req.perms. */
export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw ApiError.unauthorized();
    let payload;
    try {
      payload = jwt.verify(token, env.accessSecret);
    } catch {
      throw ApiError.unauthorized('Session expired');
    }
    const user = await loadUser(String(payload.sub));
    if (!user || !user.isActive || user.isDeleted) throw ApiError.unauthorized('Account disabled');
    if (user.passwordChangedAt && payload.iat * 1000 < user.passwordChangedAt.getTime() - 1000) {
      throw ApiError.unauthorized('Password changed – please sign in again');
    }
    req.user = user;
    req.perms = effectivePermissions(user);
    req.units = allowedUnits(user);
    // the unit chosen at login travels in the access token; it must still be assigned to the user
    req.unit = req.units.includes(payload.unit) ? payload.unit : null;
    next();
  } catch (e) {
    next(e);
  }
}

/** Blocks everything except password change while a forced password change is pending. */
export function requirePasswordFresh(req, _res, next) {
  if (req.user?.mustChangePassword) return next(new ApiError(403, 'Password change required', { code: 'PASSWORD_CHANGE_REQUIRED' }));
  next();
}

/**
 * Every business request runs in the selected unit: queries and new records are scoped to it
 * (see services/unitContext.js). Without a selected unit the client must show "Select Unit".
 */
export function requireUnit(req, res, next) {
  if (!req.unit) return next(new ApiError(403, 'Select a unit to continue', { code: 'UNIT_REQUIRED' }));
  return unitContext(req.unit)(req, res, next);
}

/**
 * Report / dashboard / audit scope chosen by the user: current unit (default), another assigned unit,
 * or ALL (consolidated – only for users assigned to every unit). Returns a unit code or ALL_UNITS.
 */
export function readScope(req) {
  const want = String(req.query.unit || '').trim();
  if (!want || want === req.unit) return req.unit;
  if (want === 'ALL') {
    if (req.units.length < 2) throw ApiError.forbidden('Consolidated view needs access to both units');
    return ALL_UNITS;
  }
  if (!req.units.includes(want)) throw ApiError.forbidden(`No access to unit ${want}`);
  return want;
}

/** Run a read-only route in the scope requested with ?unit= (current unit, another assigned unit, or ALL). */
export function scopeFromQuery(req, res, next) {
  let scope;
  try { scope = readScope(req); } catch (e) { return next(e); }
  req.scope = scope;
  return unitContext(scope)(req, res, next);
}

/** Backend permission guard – never rely on the UI alone. */
export const permit = (moduleKey, action) => (req, _res, next) => {
  const key = typeof moduleKey === 'function' ? moduleKey(req) : moduleKey;
  if (can(req.perms, key, action)) return next();
  next(ApiError.forbidden(`Missing permission: ${key}.${action}`));
};

export const adminOnly = (req, _res, next) => (req.perms?.isAdmin ? next() : next(ApiError.forbidden('Administrator access required')));
