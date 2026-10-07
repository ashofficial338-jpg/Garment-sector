import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { effectivePermissions, can } from '../services/permissions.js';

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
    const user = await User.findById(payload.sub).populate('role');
    if (!user || !user.isActive || user.isDeleted) throw ApiError.unauthorized('Account disabled');
    if (user.passwordChangedAt && payload.iat * 1000 < user.passwordChangedAt.getTime() - 1000) {
      throw ApiError.unauthorized('Password changed – please sign in again');
    }
    req.user = user;
    req.perms = effectivePermissions(user);
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

/** Backend permission guard – never rely on the UI alone. */
export const permit = (moduleKey, action) => (req, _res, next) => {
  const key = typeof moduleKey === 'function' ? moduleKey(req) : moduleKey;
  if (can(req.perms, key, action)) return next();
  next(ApiError.forbidden(`Missing permission: ${key}.${action}`));
};

export const adminOnly = (req, _res, next) => (req.perms?.isAdmin ? next() : next(ApiError.forbidden('Administrator access required')));
