/**
 * Fabric transfer engine: forecast fabric of a source job → production.
 *   • into a NEW sub job of the source main job (the sub job inherits the main job's order data and gets
 *     its own T&A, spec, BOM, fabric booking … – the transfer is the receipt of that booking), or
 *   • into the fabric booking of another job, in this unit or the other one (the user must have access to it).
 * The source forecast's allocated quantity and both sides of the stock ledger are updated, and the
 * transfer keeps the destination references so the chain stays traceable in both directions.
 */
import { models } from '../modules/builder.js';
import { MODULES, applyCompute } from '../../../shared/modules/index.js';
import { FABRIC_FLOW } from '../../../shared/modules/planning.js';
import { num, round, sum } from '../../../shared/calc.js';
import { ApiError } from '../utils/ApiError.js';
import { runWithUnit } from './unitContext.js';
import { createSubJobs } from './orderFlow.js';
import { syncLedger } from './stockLedger.js';
import { audit } from './audit.js';
import { notify } from './notify.js';
import { refreshJobSoon } from './lifecycle.js';

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** Destination job + fabric booking for a transfer to an existing job (may be in the other unit). */
export async function resolveDestination(t, req, sourceJob) {
  if (!req.units.includes(t.toUnit)) throw ApiError.forbidden(`You have no access to unit ${t.toUnit}`);
  return runWithUnit(t.toUnit, async () => {
    const job = await models.orders.findOne({ jobNo: String(t.toJobNo || '').trim(), isDeleted: false }).lean();
    if (!job) throw ApiError.badRequest(`Destination job ${t.toJobNo} not found in ${t.toUnit}`);
    if (String(job._id) === String(sourceJob._id)) throw ApiError.badRequest('Destination job is the source job');
    if (['Closed', 'Cancelled'].includes(job.status)) throw ApiError.badRequest(`Destination job ${job.jobNo} is ${job.status}`);
    const bookings = await models.fabricBooking.find({ job: job._id, isDeleted: false, status: { $ne: 'Fabric Job Closed' } }).lean();
    const booking = bookings.find((b) => same(b.fabricType, t.fabric?.split(' · ')[0])) || bookings[0];
    if (!booking) throw ApiError.badRequest(`Destination job ${job.jobNo} has no open fabric booking to receive the fabric`);
    return { job, booking };
  });
}

/** Re-total the forecast's allocated quantity from its completed transfers. */
export async function syncForecastAllocation(forecastId) {
  const f = await models.fabricForecast.findById(forecastId);
  if (!f) return null;
  f.transferredQty = round(sum(await models.fabricTransfer.find({ sourceForecast: f._id, isDeleted: false, status: 'Completed' }).lean(), 'qty'), 3);
  const next = applyCompute(MODULES.fabricForecast, f.toObject());
  MODULES.fabricForecast.fields.filter((x) => x.readOnly).forEach((x) => f.set(x.name, next[x.name]));
  if (num(f.transferredQty) > 0 && ['Forecast', 'Confirmed', 'Received'].includes(f.status) && num(f.balanceQty) <= 0) f.status = 'Allocated';
  await f.save();
  await syncLedger('fabricForecast', f.toObject());
  return f;
}

/** Post a transfer that has just been completed. */
export async function executeTransfer(transferId, req) {
  const t = await models.fabricTransfer.findById(transferId);
  if (!t || t.toBooking) return t; // already posted
  const source = await models.orders.findById(t.job).lean();
  let dest;
  if (t.createSubJob) {
    const forecast = await models.fabricForecast.findById(t.sourceForecast).lean();
    const pcs = num(t.subJobQty) || Math.floor(num(t.qty) / Math.max(num(forecast.consumption) * (1 + num(forecast.wastagePct) / 100), 1e-9));
    const [sub] = await createSubJobs(source._id, [{ orderQty: pcs, shipmentDate: t.subJobShipmentDate || source.shipmentDate, orderDate: t.transferDate }], req);
    const booking = await models.fabricBooking.findOne({ job: sub._id, isDeleted: false }).lean();
    if (!booking) throw ApiError.badRequest('Sub job was created without a fabric booking (no fabric on the main job)');
    dest = { job: sub.toObject ? sub.toObject() : sub, booking };
    t.toJobNo = dest.job.jobNo;
    t.subJobQty = pcs;
  } else {
    dest = await resolveDestination(t, req, source);
  }
  // receipt into the destination booking (in the destination unit)
  await runWithUnit(t.toUnit, async () => {
    const b = await models.fabricBooking.findById(dest.booking._id);
    b.receivedQty = round(num(b.receivedQty) + num(t.qty), 3);
    if (FABRIC_FLOW.indexOf(b.status) < FABRIC_FLOW.indexOf('Received')) {
      b.statusHistory.push({ from: b.status, to: 'Received', by: req.user._id, byName: req.user.name, reason: `Fabric transfer ${t.refNo}` });
      b.status = 'Received';
    }
    b.remarks = [b.remarks, `Received ${t.qty} ${t.unit} by transfer ${t.refNo} from ${source.jobNo} (${t.fromUnit})`].filter(Boolean).join('\n');
    const next = applyCompute(MODULES.fabricBooking, b.toObject());
    MODULES.fabricBooking.fields.filter((x) => x.readOnly).forEach((x) => b.set(x.name, next[x.name]));
    await b.save();
    await syncLedger('fabricBooking', b.toObject(), { date: t.transferDate });
    refreshJobSoon(dest.job._id);
  });
  t.toJob = dest.job._id; t.toBooking = dest.booking._id; t.destinationBooking = `${dest.booking.refNo} · ${dest.job.jobNo}`; t.completedAt = new Date();
  await t.save();
  await syncForecastAllocation(t.sourceForecast);
  await audit(req, { action: 'TRANSFER', module: 'fabricTransfer', record: t, message: `${req.user.name} transferred ${t.qty} ${t.unit} ${t.fabric} from ${source.jobNo} (${t.fromUnit}) to ${dest.job.jobNo} (${t.toUnit}) – ${t.reason}, ref ${t.referenceDoc}` });
  await notify({
    type: 'INFO', severity: 'info', title: `Fabric received by transfer: ${dest.job.jobNo}`,
    message: `${t.qty} ${t.unit} ${t.fabric} from ${source.jobNo} (${t.refNo}).`, departments: ['Fabric Department', 'Cutting', 'Production'],
    job: dest.job, module: 'fabricBooking', recordId: dest.booking._id, link: `/jobs/${dest.job.jobNo}`,
  });
  refreshJobSoon(source._id);
  return t;
}
