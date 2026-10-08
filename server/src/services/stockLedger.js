/**
 * Posts fabric / trim booking quantity changes to the dated stock ledger (models/StockMovement.js).
 * syncLedger() is idempotent: it compares the booking's current received / issued quantities with what the
 * ledger already holds for it and posts only the difference – safe to call after any save, status change,
 * delete or restore, and to back-fill existing records.
 */
import { models } from '../modules/builder.js';
import { StockMovement } from '../models/StockMovement.js';
import { trimInventoryCategory } from '../../../shared/costHeads.js';
import { num, round } from '../../../shared/calc.js';

const SOURCES = {
  fabricBooking: { category: () => 'Fabric', item: (r) => [r.fabricType, r.color].filter(Boolean).join(' · '), rate: (r) => num(r.rate), in: 'receivedQty', out: 'issuedQty' },
  trimBooking: { category: (r) => trimInventoryCategory(r.item), item: (r) => [r.item, r.description].filter(Boolean).join(' · '), rate: (r) => num(r.rate), in: 'receivedQty', out: 'issuedQty' },
  // bulk forecast fabric: received against the forecast, out when transferred to a job / sub job
  fabricForecast: { category: () => 'Fabric', item: (r) => [r.fabricType, r.color, r.lotNo].filter(Boolean).join(' · '), rate: (r) => num(r.rate), in: 'receivedQty', out: 'transferredQty' },
};

/** When a booking reached a status (from its history), used to date back-filled movements. */
const reachedAt = (rec, statuses) => rec.statusHistory?.find((h) => statuses.includes(h.to))?.at;

export async function syncLedger(module, recOrId, { date, deleted = false } = {}) {
  const src = SOURCES[module];
  if (!src || !recOrId) return [];
  const rec = recOrId._id ? recOrId : await models[module].findById(recOrId).lean();
  if (!rec) return [];
  const posted = await StockMovement.find({ recordId: rec._id, businessUnit: rec.businessUnit }).lean();
  const held = (dir) => posted.filter((m) => m.direction === dir).reduce((t, m) => t + num(m.qty), 0);
  const gone = deleted || rec.isDeleted;
  const target = { in: gone ? 0 : num(rec[src.in]), out: gone ? 0 : num(rec[src.out]) };
  const out = [];
  for (const dir of ['in', 'out']) {
    const delta = round(target[dir] - held(dir), 4);
    if (!delta) continue;
    const when = date || (dir === 'in' && rec.receivedDate) || (posted.length ? new Date() : (dir === 'in' ? reachedAt(rec, ['Received', 'Inspected', 'Approved']) : reachedAt(rec, ['Issued', 'Consumed', 'Fully Consumed', 'Allocated'])) || rec.updatedAt || new Date());
    out.push({
      date: when, category: src.category(rec), direction: dir, qty: delta, unit: rec.unit, rate: src.rate(rec),
      value: round(delta * src.rate(rec), 2), item: src.item(rec), module, recordId: rec._id, refNo: rec.refNo,
      job: rec.job, jobNo: rec.jobNo, businessUnit: rec.businessUnit,
      note: gone ? 'Record deleted – reversed' : posted.length ? 'Quantity change' : 'Opening balance',
    });
  }
  if (out.length) await StockMovement.insertMany(out);
  return out;
}

/** One-time back-fill for bookings that existed before the ledger (runs at startup, outside any unit). */
export async function backfillLedger() {
  let n = 0;
  for (const module of Object.keys(SOURCES)) {
    const done = new Set((await StockMovement.distinct('recordId', { module })).map(String));
    const { in: inF, out: outF } = SOURCES[module];
    const recs = await models[module].find({ $or: [{ [inF]: { $gt: 0 } }, { [outF]: { $gt: 0 } }] }).lean();
    for (const r of recs) if (!done.has(String(r._id))) n += (await syncLedger(module, r)).length;
  }
  return n;
}
