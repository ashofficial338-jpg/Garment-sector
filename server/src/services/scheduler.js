/**
 * Periodic alert scanner (role-based notifications):
 * delayed T&A, fabric/trim delivery overdue, approvals pending, shipment due/delayed, payment due/overdue.
 * Also refreshes lifecycle state of open jobs so delays show up even without user activity.
 */
import { models } from '../modules/builder.js';
import { notify } from './notify.js';
import { refreshJob } from './lifecycle.js';
import { getSetting } from './settings.js';
import { logger } from '../utils/logger.js';
import { num } from '../../../shared/calc.js';
import { MODULES, applyCompute } from '../../../shared/modules/index.js';

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);

export async function scanAlerts() {
  const s = await getSetting('notifications');
  const today = new Date(new Date().toDateString());
  const live = { isDeleted: false };
  const openJobs = await models.orders.find({ ...live, status: { $nin: ['Closed', 'Cancelled'] } }).lean();
  const jobById = Object.fromEntries(openJobs.map((j) => [String(j._id), j]));

  // T&A: recompute delays and alert
  const tnas = await models.tna.find({ ...live, job: { $in: openJobs.map((j) => j._id) } });
  for (const t of tnas) {
    const next = applyCompute(MODULES.tna, t.toObject());
    t.set({ activities: next.activities, delayedCount: next.delayedCount, completedCount: next.completedCount, completionPct: next.completionPct, status: next.status });
    await t.save();
    if (!s.tnaDelay) continue;
    for (const a of next.activities.filter((x) => x.state === 'delayed')) {
      await notify({
        type: 'TNA_DELAY', severity: 'warning', title: `T&A delayed: ${a.activity} – ${t.jobNo}`,
        message: `Planned ${iso(a.plannedDate)}, delayed ${a.delayDays} day(s). Responsible: ${a.responsible || a.department || '-'}.`,
        departments: [a.department || 'Factory Merchandising', 'Factory Merchandising'], job: jobById[String(t.job)], module: 'tna', recordId: t._id,
        link: `/m/tna/${t._id}`, dedupeKey: `tna-${t._id}-${a.activity}-${iso(today)}`,
      });
    }
  }

  // Fabric / trim delivery overdue
  if (s.fabricShortage) {
    const fabs = await models.fabricBooking.find({ ...live, shortageQty: { $gt: 0 }, deliveryDate: { $lt: today }, status: { $ne: 'Fabric Job Closed' } }).lean();
    for (const f of fabs) {
      await notify({ type: 'FABRIC_SHORTAGE', severity: 'danger', title: `Fabric delivery overdue – ${f.jobNo}`, message: `${f.fabricType}: ${f.shortageQty} ${f.unit} pending since ${iso(f.deliveryDate)} (${f.supplierName || 'supplier'}).`, departments: ['Fabric Department', 'Factory Merchandising'], job: jobById[String(f.job)], module: 'fabricBooking', recordId: f._id, link: `/m/fabricBooking/${f._id}`, dedupeKey: `fab-overdue-${f._id}-${iso(today)}` });
    }
  }
  if (s.trimShortage) {
    const trims = await models.trimBooking.find({ ...live, shortageQty: { $gt: 0 }, deliveryDate: { $lt: today }, status: { $nin: ['Closed', 'Consumed'] } }).lean();
    for (const t of trims) {
      await notify({ type: 'TRIM_SHORTAGE', severity: 'warning', title: `Trim delivery overdue – ${t.jobNo}: ${t.item}`, message: `${t.shortageQty} ${t.unit} pending since ${iso(t.deliveryDate)}.`, departments: ['Factory Merchandising'], job: jobById[String(t.job)], module: 'trimBooking', recordId: t._id, dedupeKey: `trim-overdue-${t._id}-${iso(today)}` });
    }
  }

  // Approvals pending > 3 days
  if (s.approvalPending) {
    const old = new Date(today.getTime() - 3 * DAY);
    const samples = await models.sample.find({ ...live, status: { $in: ['Submitted', 'Buyer Review'] }, updatedAt: { $lt: old } }).lean();
    for (const x of samples) {
      await notify({ type: 'APPROVAL_PENDING', severity: 'warning', title: `Approval pending > 3 days: ${x.sampleType} ${x.jobNo}`, message: `Status ${x.status} since ${iso(x.updatedAt)}.`, departments: ['Head Office Merchandising', 'Factory Merchandising'], module: 'sample', recordId: x._id, job: jobById[String(x.job)], dedupeKey: `appr-${x._id}-${iso(today)}` });
    }
    const costings = await models.costing.find({ ...live, status: { $in: ['Submitted', 'Under Review'] }, updatedAt: { $lt: old } }).lean();
    for (const x of costings) {
      await notify({ type: 'APPROVAL_PENDING', severity: 'info', title: `Costing approval pending: ${x.refNo}`, message: `${x.styleNo} – ${x.status}.`, departments: ['Costing Factory', 'Admin'], module: 'costing', recordId: x._id, businessUnit: x.businessUnit, dedupeKey: `appr-${x._id}-${iso(today)}` });
    }
  }

  // Shipment due within 7 days / delayed
  if (s.shipmentDelay) {
    for (const j of openJobs.filter((x) => x.shipmentDate && !(x.isForecast && num(x.subJobCount) > 0))) {
      const days = Math.round((new Date(j.shipmentDate) - today) / DAY);
      if (j.stages?.shipment === 'done') continue;
      if (days < 0) {
        await notify({ type: 'SHIPMENT_DELAY', severity: 'danger', title: `Shipment delayed – ${j.jobNo}`, message: `Planned ${iso(j.shipmentDate)} (${-days} day(s) late). Current stage: ${j.currentStage}.`, departments: ['Shipment / Documentation', 'Head Office Merchandising', 'Production'], job: j, link: `/jobs/${j.jobNo}`, dedupeKey: `ship-late-${j._id}-${iso(today)}` });
      } else if (days <= 7) {
        await notify({ type: 'SHIPMENT_DELAY', severity: 'info', title: `Shipment due in ${days} day(s) – ${j.jobNo}`, message: `Ship date ${iso(j.shipmentDate)}. Current stage: ${j.currentStage}.`, departments: ['Shipment / Documentation', 'Production'], job: j, link: `/jobs/${j.jobNo}`, dedupeKey: `ship-due-${j._id}-${iso(j.shipmentDate)}` });
      }
    }
  }

  // Payment due / overdue
  if (s.paymentDue) {
    const soon = new Date(today.getTime() + num(s.paymentDueDays || 7) * DAY);
    const invs = await models.invoice.find({ ...live, outstanding: { $gt: 0 }, dueDate: { $lte: soon }, status: { $nin: ['Draft', 'Cancelled', 'Closed'] } }).lean();
    for (const i of invs) {
      const late = new Date(i.dueDate) < today;
      await notify({ type: 'PAYMENT_DUE', severity: late ? 'danger' : 'warning', title: `${late ? 'Payment overdue' : 'Payment due'} – ${i.invoiceNo}`, message: `${i.jobNo} · ${i.buyerName || ''}: outstanding ${i.outstanding} ${i.currency}, due ${iso(i.dueDate)}.`, departments: ['Accounts & Finance'], module: 'invoice', recordId: i._id, job: jobById[String(i.job)], dedupeKey: `pay-${i._id}-${late ? iso(today) : 'due'}` });
    }
  }

  for (const j of openJobs) await refreshJob(j._id, { notifyReady: s.jobReadyToClose });
}

export function startScheduler(intervalMin = 30) {
  const run = () => scanAlerts().catch((e) => logger.error('alert scan failed', e));
  setTimeout(run, 5000);
  return setInterval(run, intervalMin * 60000);
}
