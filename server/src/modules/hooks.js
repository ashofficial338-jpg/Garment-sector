/**
 * Server-side business rules per module (error prevention + data flow).
 *
 * beforeSave(ctx) – may mutate ctx.data, must throw ApiError to block.
 * afterSave(ctx)  – side effects (sync, notifications).
 *
 * ctx = { def, data, existing, job, req, isCreate, override }
 *   override = true when the user has `override` permission AND supplied a reason.
 */
import { models } from './builder.js';
import { ApiError } from '../utils/ApiError.js';
import { notify } from '../services/notify.js';
import { getSetting } from '../services/settings.js';
import { num, sum, round, efficiency } from '../../../shared/calc.js';

const others = async (key, ctx, extra = {}) => models[key].find({
  job: ctx.job._id, isDeleted: false, _id: { $ne: ctx.existing?._id }, ...extra,
}).lean();

function guard(ctx, ok, message) {
  if (ok) return;
  if (ctx.override) { ctx.overrideUsed = (ctx.overrideUsed || []).concat(message); return; }
  throw ApiError.badRequest(`${message}. Requires authorised override with reason.`, { code: 'OVERRIDE_REQUIRED' });
}

export const hooks = {
  /* ---------------- Commercial ---------------- */
  quotation: {
    async beforeSave(ctx) {
      const d = ctx.data;
      if (ctx.isCreate && d.costing) {
        const c = await models.costing.findById(d.costing).lean();
        if (c) {
          // pull costing data – no re-entry
          ['buyer', 'styleNo', 'product', 'orderQty', 'currency'].forEach((k) => { if (!d[k] && c[k] !== undefined) d[k] = c[k]; });
          if (!num(d.price)) d.price = c.sellingPrice;
          if (!d.enquiry && c.enquiry) d.enquiry = c.enquiry;
        }
      }
      if (ctx.isCreate && !d.version) d.version = 1;
    },
  },
  costing: {
    async beforeSave(ctx) {
      const d = ctx.data;
      if (ctx.isCreate && d.enquiry) {
        const e = await models.enquiry.findById(d.enquiry).lean();
        if (e) {
          if (!d.buyer) d.buyer = e.buyer;
          if (!d.styleNo) d.styleNo = e.styleNo;
          if (!d.product) d.product = e.product;
          if (!num(d.orderQty)) d.orderQty = e.expectedQty;
        }
      }
    },
    async afterSave(ctx) {
      if (ctx.isCreate && ctx.data.enquiry) {
        await models.enquiry.updateOne({ _id: ctx.data.enquiry, status: { $in: ['Pending', 'Under Review'] } }, { $set: { status: 'Costing' } });
      }
    },
  },

  /* ---------------- Materials ---------------- */
  fabricBooking: {
    async beforeSave(ctx) {
      const d = ctx.data;
      guard(ctx, num(d.approvedQty) <= num(d.inspectedQty) || !num(d.inspectedQty), 'Approved quantity cannot exceed inspected quantity');
      guard(ctx, num(d.inspectedQty) <= num(d.receivedQty), 'Inspected quantity cannot exceed received quantity');
      const available = num(d.approvedQty) || num(d.receivedQty);
      guard(ctx, num(d.issuedQty) <= available, `Issued quantity (${d.issuedQty}) exceeds available fabric (${available})`);
      guard(ctx, num(d.usedQty) <= num(d.issuedQty) || !num(d.usedQty), 'Used quantity cannot exceed issued quantity');
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      const settings = await getSetting('notifications');
      if (settings.fabricShortage && num(d.shortageQty) > 0 && num(d.receivedQty) > 0) {
        await notify({
          type: 'FABRIC_SHORTAGE', severity: 'warning', title: `Fabric shortage ${d.jobNo}`,
          message: `${d.fabricType} ${d.color || ''}: shortage ${d.shortageQty} ${d.unit} (required ${d.requiredQty}, received ${d.receivedQty}).`,
          departments: ['Fabric Department', 'Factory Merchandising'], job: ctx.job, module: 'fabricBooking', recordId: d._id,
          link: `/m/fabricBooking/${d._id}`, dedupeKey: `fab-short-${d._id}-${d.receivedQty}`,
        });
      }
      const ready = d.closureVerdict?.startsWith('READY');
      if (ready && !ctx.existing?.closureVerdict?.startsWith('READY')) {
        await notify({
          type: 'FABRIC_READY_TO_CLOSE', severity: 'success', title: `Fabric job ready to close: ${d.refNo}`,
          message: `${d.jobNo} · ${d.fabricType}: ${d.closureVerdict}. Balance ${d.balanceQty} ${d.unit}.`,
          departments: ['Fabric Department', 'Admin'], job: ctx.job, module: 'fabricBooking', recordId: d._id,
          link: `/m/fabricBooking/${d._id}`, dedupeKey: `fab-ready-${d._id}`,
        });
      }
    },
  },
  trimBooking: {
    async beforeSave(ctx) {
      const d = ctx.data;
      guard(ctx, num(d.issuedQty) <= num(d.receivedQty), 'Issued trim quantity exceeds received quantity');
      guard(ctx, num(d.usedQty) <= num(d.issuedQty) || !num(d.usedQty), 'Used trim quantity exceeds issued quantity');
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      const s = await getSetting('notifications');
      if (s.trimShortage && num(d.shortageQty) > 0 && num(d.receivedQty) > 0) {
        await notify({
          type: 'TRIM_SHORTAGE', severity: 'warning', title: `Trim shortage ${d.jobNo}: ${d.item}`,
          message: `Short by ${d.shortageQty} ${d.unit} (booking ${d.bookingQty}, received ${d.receivedQty}).`,
          departments: ['Factory Merchandising', 'Production'], job: ctx.job, module: 'trimBooking', recordId: d._id,
          dedupeKey: `trim-short-${d._id}-${d.receivedQty}`,
        });
      }
    },
  },
  sample: {
    async afterSave(ctx) {
      const d = ctx.saved;
      if (d.status === 'Buyer Review' && ctx.existing?.status !== 'Buyer Review') {
        await notify({ type: 'APPROVAL_PENDING', severity: 'info', title: `Approval pending: ${d.sampleType} ${d.jobNo}`, message: 'Sample is waiting for buyer review.', departments: ['Head Office Merchandising', 'Factory Merchandising'], job: ctx.job, module: 'sample', recordId: d._id, dedupeKey: `smp-review-${d._id}-${d.revision || 0}` });
      }
      if (d.status === 'Rejected' && ctx.existing?.status !== 'Rejected') {
        await notify({ type: 'APPROVAL_PENDING', severity: 'danger', title: `Sample rejected: ${d.sampleType} ${d.jobNo}`, message: d.comments || 'Revise and resubmit.', departments: ['Factory Merchandising'], job: ctx.job, module: 'sample', recordId: d._id });
      }
    },
  },

  /* ---------------- Production ---------------- */
  cutting: {
    async beforeSave(ctx) {
      const tol = await getSetting('tolerance');
      const prev = sum(await others('cutting', ctx, { status: { $ne: 'Rejected' } }), 'cutQty');
      const limit = num(ctx.job.orderQty) * (1 + num(tol.overCutPct) / 100);
      guard(ctx, prev + num(ctx.data.cutQty) <= limit, `Cumulative cutting (${prev + num(ctx.data.cutQty)}) exceeds order quantity + ${tol.overCutPct}% (${Math.floor(limit)})`);
      // fabric availability
      const fabricIssued = sum(await models.fabricBooking.find({ job: ctx.job._id, isDeleted: false }).lean(), 'issuedQty');
      const fabricUsedPrev = sum(await others('cutting', ctx), 'fabricUsed');
      if (fabricIssued > 0) guard(ctx, fabricUsedPrev + num(ctx.data.fabricUsed) <= fabricIssued, `Fabric used in cutting (${round(fabricUsedPrev + num(ctx.data.fabricUsed))}) exceeds fabric issued (${fabricIssued})`);
    },
  },
  sewing: {
    async beforeSave(ctx) {
      const cut = sum(await models.cutting.find({ job: ctx.job._id, isDeleted: false, status: { $ne: 'Rejected' } }).lean(), 'cutQty');
      const prev = sum(await others('sewing', ctx, { status: { $ne: 'Rejected' } }), 'actualQty');
      guard(ctx, prev + num(ctx.data.actualQty) <= cut, `Sewing output (${prev + num(ctx.data.actualQty)}) exceeds cut quantity (${cut})`);
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      const s = await getSetting('notifications');
      if (s.productionDelay && num(d.targetQty) > 0 && num(d.actualQty) < num(d.targetQty) * 0.8) {
        await notify({ type: 'PRODUCTION_DELAY', severity: 'warning', title: `Line ${d.line} below target – ${d.jobNo}`, message: `Output ${d.actualQty} vs target ${d.targetQty} (${d.efficiencyPct}% eff).`, departments: ['Production', 'Sewing'], job: ctx.job, module: 'sewing', recordId: d._id, dedupeKey: `sew-low-${d._id}` });
      }
      await syncProductionPlan(ctx.job);
    },
  },
  finishing: {
    async beforeSave(ctx) {
      const d = ctx.data;
      guard(ctx, num(d.passedQty) + num(d.rejection) <= num(d.inputQty), 'Passed + rejected cannot exceed finishing input');
      const sewn = sum(await models.sewing.find({ job: ctx.job._id, isDeleted: false, status: { $ne: 'Rejected' } }).lean(), 'actualQty');
      const prev = sum(await others('finishing', ctx, { status: { $ne: 'Rejected' } }), 'inputQty');
      guard(ctx, prev + num(d.inputQty) <= sewn, `Finishing input (${prev + num(d.inputQty)}) exceeds sewing output (${sewn})`);
    },
  },
  packing: {
    async beforeSave(ctx) {
      const finished = sum(await models.finishing.find({ job: ctx.job._id, isDeleted: false, status: { $ne: 'Rejected' } }).lean(), 'passedQty');
      const prev = sum(await others('packing', ctx), 'totalQty');
      guard(ctx, prev + num(ctx.data.totalQty) <= finished, `Packed quantity (${prev + num(ctx.data.totalQty)}) exceeds finished passed quantity (${finished})`);
    },
  },
  inspection: {
    async beforeSave(ctx) {
      const d = ctx.data;
      // AQL result drives the status when the inspector records defects
      if (d.aqlResult && ['Inspection', 'Re-inspection'].includes(d.status) && !ctx.statusExplicit) {
        d.status = d.aqlResult === 'Passed' ? 'Passed' : 'Failed';
      }
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      const s = await getSetting('notifications');
      if (s.qualityFailure && d.status === 'Failed' && ctx.existing?.status !== 'Failed') {
        await notify({ type: 'QUALITY_FAIL', severity: 'danger', title: `Inspection FAILED – ${d.jobNo}`, message: `Critical ${d.criticalDefects || 0}, major ${d.majorDefects || 0}, minor ${d.minorDefects || 0}. Re-inspection required.`, departments: ['Quality', 'Production', 'Factory Merchandising'], job: ctx.job, module: 'inspection', recordId: d._id });
      }
    },
  },

  /* ---------------- Shipping & finance ---------------- */
  shipment: {
    async beforeSave(ctx) {
      const d = ctx.data;
      if (ctx.isCreate && !num(d.qty)) {
        // pull packing data automatically
        const packs = await models.packing.find({ job: ctx.job._id, isDeleted: false }).lean();
        const shipped = sum(await others('shipment', ctx, { status: { $ne: 'Cancelled' } }), 'qty');
        d.qty = Math.max(sum(packs, 'totalQty') - shipped, 0);
        d.cartons = d.cartons || sum(packs, 'totalCartons');
        d.netWeight = d.netWeight || round(sum(packs, 'totalNetWeight'));
        d.grossWeight = d.grossWeight || round(sum(packs, 'totalGrossWeight'));
        d.cbm = d.cbm || round(sum(packs, 'totalCbm'), 3);
        d.destination = d.destination || ctx.job.destination;
        if (!d.shipmentDate) d.shipmentDate = ctx.job.shipmentDate;
      }
      const tol = await getSetting('tolerance');
      const prev = sum(await others('shipment', ctx, { status: { $ne: 'Cancelled' } }), 'qty');
      const limit = num(ctx.job.orderQty) * (1 + num(tol.overShipPct) / 100);
      guard(ctx, prev + num(d.qty) <= limit, `Shipment quantity (${prev + num(d.qty)}) exceeds order quantity (${ctx.job.orderQty})`);
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      if (d.status === 'Shipped' && ctx.existing?.status !== 'Shipped') {
        await notify({ type: 'INFO', severity: 'success', title: `Shipped: ${d.jobNo}`, message: `${d.qty} pcs / ${d.cartons || 0} ctns via ${d.mode} ${d.vesselFlight || ''}. Raise invoice & documents.`, departments: ['Accounts & Finance', 'Shipment / Documentation', 'Head Office Merchandising'], job: ctx.job, module: 'shipment', recordId: d._id });
      }
    },
  },
  invoice: {
    async beforeSave(ctx) {
      const d = ctx.data;
      if (ctx.isCreate && d.shipment && !num(d.qty)) {
        const s = await models.shipment.findById(d.shipment).lean();
        if (s) { d.qty = s.qty; if (!d.invoiceNo) d.invoiceNo = s.invoiceNo; }
      }
      if (ctx.isCreate) d.receivedAmount = 0;
      else d.receivedAmount = ctx.existing.receivedAmount; // only payments may change it
      if (ctx.isCreate) {
        const dup = await models.invoice.exists({ invoiceNo: d.invoiceNo, isDeleted: false });
        if (dup) throw ApiError.conflict(`Invoice No ${d.invoiceNo} already exists`);
      }
    },
  },
  payment: {
    async beforeSave(ctx) {
      const d = ctx.data;
      const inv = await models.invoice.findById(d.invoice).lean();
      if (!inv || inv.isDeleted) throw ApiError.badRequest('Invoice not found');
      if (String(inv.job) !== String(ctx.job._id)) throw ApiError.badRequest('Invoice belongs to a different job');
      const paidOthers = sum(await models.payment.find({ invoice: inv._id, isDeleted: false, _id: { $ne: ctx.existing?._id } }).lean(), 'amount');
      const outstanding = round(num(inv.totalAmount) - paidOthers);
      if (!inv.allowOverpayment) guard(ctx, num(d.amount) <= outstanding + 0.005, `Payment ${d.amount} exceeds invoice outstanding ${outstanding}`);
      if (!d.currency) d.currency = inv.currency;
    },
    async afterSave(ctx) { await syncInvoice(ctx.saved.invoice); if (ctx.existing?.invoice && String(ctx.existing.invoice) !== String(ctx.saved.invoice)) await syncInvoice(ctx.existing.invoice); },
    async afterDelete(rec) { await syncInvoice(rec.invoice); },
  },
};

/** Recalculate an invoice's received / outstanding / status from its payments. */
export async function syncInvoice(invoiceId) {
  const inv = await models.invoice.findById(invoiceId);
  if (!inv) return;
  const received = round(sum(await models.payment.find({ invoice: inv._id, isDeleted: false }).lean(), 'amount'));
  inv.receivedAmount = received;
  inv.outstanding = round(num(inv.totalAmount) - received);
  if (!['Draft', 'Cancelled', 'Closed'].includes(inv.status)) {
    inv.status = received <= 0 ? 'Issued' : received + 0.005 < num(inv.totalAmount) ? 'Partial' : 'Fully Paid';
  }
  await inv.save();
}

/** Production plan actuals are fed by sewing / cutting entries. */
export async function syncProductionPlan(job) {
  const sew = await models.sewing.find({ job: job._id, isDeleted: false, status: { $ne: 'Rejected' } }).lean();
  const cut = sum(await models.cutting.find({ job: job._id, isDeleted: false, status: { $ne: 'Rejected' } }).lean(), 'cutQty');
  const actual = sum(sew, 'actualQty');
  const mins = sum(sew, (s) => num(s.operators) * num(s.workingMinutes));
  const earned = sum(sew, (s) => num(s.actualQty) * num(s.sam));
  const eff = mins ? round((earned / mins) * 100) : 0;
  const plans = await models.productionPlan.find({ job: job._id, isDeleted: false });
  for (const p of plans) {
    p.actualProduction = actual;
    p.actualEfficiency = eff || efficiency({});
    p.wip = Math.max(cut - actual, 0);
    p.achievementPct = num(p.productionQty) ? round((actual / num(p.productionQty)) * 100, 1) : 0;
    if (!p.actualStart && sew.length) p.actualStart = sew.map((s) => s.entryDate).sort()[0];
    if (actual >= num(p.productionQty) && !p.actualEnd) p.actualEnd = new Date();
    if (['Approved', 'Released'].includes(p.status) && actual > 0) p.status = 'Running';
    await p.save();
  }
}
