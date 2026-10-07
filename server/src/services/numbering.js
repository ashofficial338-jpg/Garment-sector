import { nextSeq } from '../models/Counter.js';
import { getSetting } from './settings.js';

const pad = (n, d) => String(n).padStart(d, '0');

/** Unique Job No, e.g. GAR-2026-00001 (format configurable by Admin). */
export async function nextJobNo(date = new Date()) {
  const f = await getSetting('jobNumber');
  const year = new Date(date).getFullYear();
  const key = `job-${f.prefix}-${f.includeYear ? year : 'all'}`;
  const seq = await nextSeq(key);
  return [f.prefix, f.includeYear ? year : null, pad(seq, f.digits || 5)].filter(Boolean).join(f.separator || '-');
}

/** Order No mirrors the job sequence: ORD-2026-00001 */
export const orderNoFromJobNo = (jobNo) => jobNo.replace(/^[A-Z]+/, 'ORD');

/** Sub job code for forecast orders: GAR-2026-00100-F01 */
export async function nextSubJobCode(parentJobNo) {
  const f = await getSetting('subJob');
  const seq = await nextSeq(`sub-${parentJobNo}`);
  return `${parentJobNo}-${f.prefix}${pad(seq, f.digits || 2)}`;
}

/** Reference numbers for module records: FB-2026-00001 */
export async function nextRefNo(prefix, date = new Date()) {
  const year = new Date(date).getFullYear();
  const seq = await nextSeq(`ref-${prefix}-${year}`);
  return `${prefix}-${year}-${pad(seq, 5)}`;
}
