import { Counter, nextSeq } from '../models/Counter.js';
import { getSetting } from './settings.js';
import { currentUnit, ALL_UNITS } from './unitContext.js';

const pad = (n, d) => String(n).padStart(d, '0');
const unitKey = (code) => `job-unit-${code}`;

/** The unit a new job belongs to: explicit, else the request's unit, else Unit-1. */
export function resolveUnit(explicit) {
  const u = explicit || currentUnit();
  return u && u !== ALL_UNITS ? u : 'U1';
}

export async function unitConfig(code) {
  const units = await getSetting('units');
  const cfg = units.find((u) => u.code === code);
  if (!cfg) throw new Error(`Unknown unit ${code}`);
  return cfg;
}

/**
 * Unique, unit-specific Job No: Unit-1 → U1-1000, U1-1001…; Unit-2 → U2-3000, U2-3001…
 * The two series use separate counters, so they can never share or mix numbers.
 */
export async function nextJobNo(unit) {
  const cfg = await unitConfig(unit);
  const key = unitKey(cfg.code);
  // first use of the series starts at the unit's start number
  await Counter.updateOne({ _id: key }, { $setOnInsert: { seq: Number(cfg.start) - 1 } }, { upsert: true });
  const seq = await nextSeq(key);
  return `${cfg.prefix}-${seq}`;
}

/** Next number the series will issue (for Admin display). */
export async function peekJobNo(unit) {
  const cfg = await unitConfig(unit);
  const c = await Counter.findById(unitKey(cfg.code)).lean();
  return Math.max(c ? c.seq + 1 : Number(cfg.start), Number(cfg.start));
}

/** Admin: move a series forward (never backwards, so issued numbers are never reused). */
export async function setNextJobNo(unit, next) {
  const current = await peekJobNo(unit);
  if (!(Number.isInteger(next) && next >= current)) throw new Error(`Next number must be a whole number ≥ ${current}`);
  await Counter.updateOne({ _id: unitKey(unit) }, { $set: { seq: next - 1 } }, { upsert: true });
  return next;
}

/** Order No mirrors the job sequence: U1-1000 → U1-ORD-1000 (legacy GAR-2026-00001 → ORD-2026-00001). */
export const orderNoFromJobNo = (jobNo) => (/^[A-Z]+\d+-\d+$/.test(jobNo) ? jobNo.replace('-', '-ORD-') : jobNo.replace(/^[A-Z]+/, 'ORD'));

/** Sub job code for forecast orders: U1-1000-F01 */
export async function nextSubJobCode(parentJobNo) {
  const f = await getSetting('subJob');
  const seq = await nextSeq(`sub-${parentJobNo}`);
  return `${parentJobNo}-${f.prefix}${pad(seq, f.digits || 2)}`;
}

/** Reference numbers for module records: FB-2026-00001 (unique across units; the record carries its unit) */
export async function nextRefNo(prefix, date = new Date()) {
  const year = new Date(date).getFullYear();
  const seq = await nextSeq(`ref-${prefix}-${year}`);
  return `${prefix}-${year}-${pad(seq, 5)}`;
}
