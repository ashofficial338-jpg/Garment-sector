import { Notification } from '../models/Notification.js';
import { logger } from '../utils/logger.js';

/**
 * Create a role-based notification. `dedupeKey` prevents repeating the same alert.
 * departments: list of department / role names that should see it (Admin always sees all).
 */
export async function notify({ type = 'INFO', title, message, severity = 'info', departments = [], users = [], job, module, recordId, link, dedupeKey, businessUnit }) {
  try {
    const doc = {
      type, title, message, severity, departments, users, module, recordId, link,
      job: job?._id || job, jobNo: job?.jobNo,
      // notifications belong to the job's unit (the scheduler runs outside any request unit)
      ...(businessUnit || job?.businessUnit ? { businessUnit: businessUnit || job.businessUnit } : {}),
    };
    if (dedupeKey) {
      await Notification.updateOne({ dedupeKey }, { $setOnInsert: { ...doc, dedupeKey } }, { upsert: true });
    } else {
      await Notification.create(doc);
    }
  } catch (e) {
    if (e.code !== 11000) logger.error('notify failed', e.message);
  }
}
