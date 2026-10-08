import { AuditLog } from '../models/AuditLog.js';
import { logger } from '../utils/logger.js';

/** Record an audit entry. Never throws – auditing must not break business flow. */
export async function audit(req, { action, module, record, changes = [], message, reason, jobNo }) {
  try {
    await AuditLog.create({
      user: req?.user?._id,
      userName: req?.user?.name || 'system',
      action,
      module,
      recordId: record?._id,
      refNo: record?.refNo || record?.jobNo,
      jobNo: jobNo || record?.jobNo,
      changes,
      message,
      reason,
      ip: req?.ip,
      ...(record?.businessUnit || req?.unit ? { businessUnit: record?.businessUnit || req.unit } : {}),
      userAgent: req?.headers?.['user-agent'],
    });
  } catch (e) {
    logger.error('audit failed', e.message);
  }
}

/** Human readable change sentence, e.g. "Admin changed Booked Qty from 10500 to 11000". */
export function describeChanges(userName, def, changes) {
  const label = (f) => def?.fields?.find((x) => x.name === f)?.label || f;
  const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? (v instanceof Date ? v.toISOString().slice(0, 10) : '[updated]') : v);
  return changes.slice(0, 6).map((c) => `${userName} changed ${label(c.field)} from ${fmt(c.old)} to ${fmt(c.new)}`).join('; ')
    + (changes.length > 6 ? ` (+${changes.length - 6} more)` : '');
}
