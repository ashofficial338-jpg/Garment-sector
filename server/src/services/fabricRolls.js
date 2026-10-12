/**
 * Roll-level fabric: receipts (lot / roll / 4-point) and allocations (roll-wise issue to cutting).
 * Once a booking has receipts, its received / inspected / approved quantities come from them, and once it has
 * allocations its issued quantity comes from them – so stock, cutting limits, closure and the BOM all follow
 * the rolls without re-typing. Forecast receipts drive the forecast's received quantity the same way.
 */
import { models } from '../modules/builder.js';
import { MODULES, applyCompute } from '../../../shared/modules/index.js';
import { num, round, sum } from '../../../shared/calc.js';
import { syncLedger } from './stockLedger.js';
import { runWithUnit, ALL_UNITS } from './unitContext.js';
import { FABRIC_FLOW, RETURN_TO_STORE, RETURN_TO_SUPPLIER, ADJUST_SHORT, ADJUST_EXCESS } from '../../../shared/modules/planning.js';

const live = { isDeleted: false, status: { $ne: 'Rejected' } };

/** Fabric received into a booking by completed transfers – the transfer record lives in the sending unit, so read across units. */
export const transfersInto = (bookingIds) => runWithUnit(ALL_UNITS, () => models.fabricTransfer.find({ toBooking: { $in: [].concat(bookingIds) }, isDeleted: false, status: 'Completed' }).lean());

/**
 * Quantities a booking's transactions dictate: receipts (rolls) plus transfers in → received / inspected / approved,
 * allocations → issued, fabric returns → returned to supplier / from cutting, supplier debit notes → recovery.
 * receipt / allocation are null when the booking has none (its typed quantities then stand).
 */
export async function rollTotals(bookingId) {
  const [receipts, allocations, transfers, returns, debits] = await Promise.all([
    models.fabricReceipt.find({ booking: bookingId, ...live }).lean(),
    models.fabricAllocation.find({ booking: bookingId, isDeleted: false, status: { $ne: 'Cancelled' } }).lean(),
    transfersInto(bookingId),
    models.fabricReturn.find({ booking: bookingId, isDeleted: false, status: { $ne: 'Cancelled' } }).lean(),
    models.fabricDebit.find({ booking: bookingId, isDeleted: false, debitTo: 'Supplier', status: { $in: ['Accepted', 'Adjusted'] } }).lean(),
  ]);
  const tin = round(sum(transfers, 'qty'), 3); // transferred fabric arrives inspected and approved
  return {
    // without roll receipts the booking's typed quantities stand (a completed transfer adds to them when it posts)
    receipt: receipts.length ? {
      receivedQty: round(sum(receipts, 'totalQty') + tin, 3),
      inspectedQty: round(sum(receipts.filter((r) => ['Inspected', 'Approved'].includes(r.status)), 'totalQty') + tin, 3),
      approvedQty: round(sum(receipts.filter((r) => r.status === 'Approved'), 'passedQty') + tin, 3),
    } : null,
    allocation: allocations.length ? { issuedQty: round(sum(allocations, 'totalQty'), 3) } : null,
    returns: {
      returnedToSupplierQty: round(sum(returns.filter((r) => r.returnType === RETURN_TO_SUPPLIER), 'qty'), 3),
      returnedFromCuttingQty: round(sum(returns.filter((r) => r.returnType === RETURN_TO_STORE), 'qty'), 3),
      adjustedQty: round(sum(returns.filter((r) => r.returnType === ADJUST_EXCESS), 'qty') - sum(returns.filter((r) => r.returnType === ADJUST_SHORT), 'qty'), 3),
      debitRecovery: round(sum(debits, 'amount'), 2),
    },
  };
}

/** Planned → required → issued → consumed → balance on the BOM line booked by this booking. */
export async function syncBomFromBooking(b) {
  if (!b?.job) return;
  const bom = await models.bom.findOne({ job: b.job, isDeleted: false });
  const line = bom?.lines.find((l) => l.bookingRef === b.refNo);
  if (!line) return;
  line.receivedQty = round(num(b.receivedQty), 3);
  line.issuedQty = round(num(b.issuedQty), 3);
  line.consumedQty = round(num(b.usedQty), 3);
  line.balanceQty = round(num(b.receivedQty) - num(b.issuedQty), 3);
  await bom.save();
}

/** Recalculate a booking from its rolls, then its stock ledger and BOM line. */
export async function syncBookingFromRolls(bookingId, date) {
  const b = await models.fabricBooking.findById(bookingId);
  if (!b) return null;
  const t = await rollTotals(b._id);
  if (t.receipt) b.set(t.receipt);
  if (t.allocation) b.issuedQty = t.allocation.issuedQty;
  b.set(t.returns);
  // the booking status follows its rolls forward (never backwards)
  const reachedStatus = num(b.issuedQty) > 0 ? 'Issued' : num(b.approvedQty) > 0 ? 'Approved' : num(b.inspectedQty) > 0 ? 'Inspected' : num(b.receivedQty) > 0 ? 'Received' : null;
  if (reachedStatus && FABRIC_FLOW.indexOf(b.status) >= 0 && FABRIC_FLOW.indexOf(b.status) < FABRIC_FLOW.indexOf(reachedStatus)) {
    b.statusHistory.push({ from: b.status, to: reachedStatus, reason: 'Fabric receipt / allocation (rolls)' });
    b.status = reachedStatus;
  }
  const next = applyCompute(MODULES.fabricBooking, b.toObject());
  MODULES.fabricBooking.fields.filter((f) => f.readOnly).forEach((f) => b.set(f.name, next[f.name]));
  await b.save();
  await syncLedger('fabricBooking', b.toObject(), { date });
  await syncBomFromBooking(b.toObject());
  return b;
}

/** Forecast received quantity and lot from its receipts. */
export async function syncForecastFromReceipts(forecastId, date) {
  const f = await models.fabricForecast.findById(forecastId);
  if (!f) return null;
  const receipts = await models.fabricReceipt.find({ forecast: f._id, ...live }).sort({ receiptDate: 1 }).lean();
  if (!receipts.length) return f;
  f.receivedQty = round(sum(receipts.filter((r) => r.status === 'Approved'), 'passedQty'), 3);
  f.receivedDate = receipts.at(-1).receiptDate;
  f.lotNo = [...new Set(receipts.flatMap((r) => (r.rolls || []).map((x) => x.lotNo)).filter(Boolean))].join(', ') || f.lotNo;
  const next = applyCompute(MODULES.fabricForecast, f.toObject());
  MODULES.fabricForecast.fields.filter((x) => x.readOnly).forEach((x) => f.set(x.name, next[x.name]));
  await f.save();
  await syncLedger('fabricForecast', f.toObject(), { date });
  return f;
}

/** Passed rolls of a booking's approved receipts and what is already allocated from each (excluding one allocation). */
export async function rollStock(bookingId, excludeAllocationId) {
  const receipts = await models.fabricReceipt.find({ booking: bookingId, isDeleted: false, status: 'Approved' }).lean();
  const allocs = await models.fabricAllocation.find({ booking: bookingId, isDeleted: false, status: { $ne: 'Cancelled' }, _id: { $ne: excludeAllocationId } }).lean();
  const used = {};
  allocs.forEach((a) => (a.rolls || []).forEach((r) => { used[r.rollNo] = (used[r.rollNo] || 0) + num(r.qty); }));
  const rolls = new Map();
  receipts.forEach((rc) => (rc.rolls || []).filter((r) => r.result !== 'Fail').forEach((r) => {
    rolls.set(String(r.rollNo).trim(), { rollNo: r.rollNo, lotNo: r.lotNo, qty: num(r.qty), allocated: used[r.rollNo] || 0, receipt: rc.refNo });
  }));
  // fabric received by transfer is issued by its transfer lot (roll no = transfer ref)
  (await transfersInto(bookingId)).forEach((t) => {
    rolls.set(t.refNo, { rollNo: t.refNo, lotNo: t.lotNo, qty: num(t.qty), allocated: used[t.refNo] || 0, receipt: t.refNo });
  });
  return rolls;
}
