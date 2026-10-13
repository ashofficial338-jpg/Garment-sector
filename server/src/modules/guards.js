import { ApiError } from '../utils/ApiError.js';

/**
 * Business-rule guard: blocks the save unless the user has `override` permission and gave a reason,
 * in which case the broken rule is collected in ctx.overrideUsed and audited as an OVERRIDE.
 */
export function guard(ctx, ok, message) {
  if (ok) return;
  if (ctx.override) { ctx.overrideUsed = (ctx.overrideUsed || []).concat(message); return; }
  throw ApiError.badRequest(`${message}. Requires authorised override with reason.`, { code: 'OVERRIDE_REQUIRED' });
}

/** The [start, end) range of a calendar day, for date fields stored as UTC midnight. */
export function dayRange(v) {
  const s = new Date(new Date(v).toISOString().slice(0, 10));
  return { $gte: s, $lt: new Date(s.getTime() + 86400000) };
}
export const isoDay = (v) => new Date(v).toISOString().slice(0, 10);
