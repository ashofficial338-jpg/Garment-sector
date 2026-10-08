/**
 * Server-side business rules per module (error prevention + data flow).
 *
 * beforeSave(ctx)   – may mutate ctx.data, must throw ApiError to block.
 * beforeStatus(ctx) – stage gate for a status change (ctx.doc, ctx.to); throw / guard() to block.
 * afterSave(ctx)    – side effects (sync, notifications).
 *
 * ctx = { def, data, existing, job, req, isCreate, override }
 *   override = true when the user has `override` permission AND supplied a reason.
 */
import { models } from './builder.js';
import { ApiError } from '../utils/ApiError.js';
import { notify } from '../services/notify.js';
import { getSetting } from '../services/settings.js';
import { num, sum, round, efficiency } from '../../../shared/calc.js';
import { applyCompute, MODULES } from '../../../shared/modules/index.js';
import { bomConsumptionFor, materialPerPcFromCosting } from '../../../shared/modules/preproduction.js';
import { yarnAvailable, stageAvailable } from '../services/stock.js';
import { completeTna, syncPpReadiness, PATTERN_DONE } from '../services/preproduction.js';
import { createBookingsFromBom } from '../services/orderFlow.js';

/** True when a save / status change moved the record into `status` (not already there). */
const reached = (ctx, status) => ctx.saved?.status === status && ctx.existing?.status !== status;

/** Same document number twice within one job is a data-entry error. */
async function uniqueInJob(ctx, key, field, label) {
  const v = ctx.data[field];
  if (!v) return;
  const dup = await models[key].exists({ job: ctx.job._id, isDeleted: false, [field]: v, revision: ctx.data.revision, _id: { $ne: ctx.existing?._id } });
  if (dup) throw ApiError.conflict(`${label} ${v} (rev ${ctx.data.revision || 1}) already exists for ${ctx.job.jobNo}`);
}

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

  /* ---------------- Pre-production: Spec → BOM → CAD / Pattern → Grading → Marker ---------------- */
  techSpec: {
    async beforeStatus(ctx) {
      if (['Submitted', 'Approved'].includes(ctx.to)) guard(ctx, (ctx.doc.measurements || []).some((m) => m.pom), 'Measurement chart is empty');
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      if (reached(ctx, 'Approved')) {
        if (!d.buyerApprovalDate) await models.techSpec.updateOne({ _id: d._id }, { $set: { buyerApprovalDate: new Date() } });
        await completeTna(d.job, 'Tech Spec Approval');
        await notify({ type: 'INFO', severity: 'success', title: `Specification approved – ${d.jobNo}`, message: `${d.refNo} rev ${d.revision || 1} approved. Pattern making can start from its measurement chart.`, departments: ['CAD / Pattern', 'Factory Merchandising'], job: ctx.job, module: 'techSpec', recordId: d._id, link: `/m/techSpec/${d._id}` });
      }
      await syncPpReadiness(d.job);
    },
  },
  bom: {
    async beforeSave(ctx) {
      const d = ctx.data;
      if (!num(d.orderQty)) d.orderQty = ctx.job.orderQty;
      // booking links are system-maintained: keep them across edits, and never orphan a booking
      const prev = new Map((ctx.existing?.lines || []).map((l) => [String(l._id), l]));
      d.lines = (d.lines || []).map((l) => ({ ...l, bookingRef: prev.get(String(l._id))?.bookingRef || null }));
      const kept = new Set(d.lines.map((l) => String(l._id)));
      const dropped = [...prev.values()].filter((l) => l.bookingRef && !kept.has(String(l._id)));
      guard(ctx, !dropped.length, `Line(s) ${dropped.map((l) => `${l.item} (${l.bookingRef})`).join(', ')} already have bookings – cancel the booking instead of deleting the line`);
      if (ctx.isCreate && !num(d.costedMaterialPerPc) && ctx.job.costing) {
        d.costedMaterialPerPc = materialPerPcFromCosting(await models.costing.findById(ctx.job.costing).lean());
      }
    },
    async beforeStatus(ctx) {
      if (!['Submitted', 'Approved'].includes(ctx.to)) return;
      const lines = ctx.doc.lines || [];
      guard(ctx, lines.length > 0, 'BOM has no material lines');
      const bad = lines.filter((l) => !l.item || !(num(l.consumptionPerPc) > 0));
      guard(ctx, !bad.length, `${bad.length} BOM line(s) without item or consumption`);
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      if (d.status === 'Approved') await createBookingsFromBom(d._id, ctx.req);
      if (reached(ctx, 'Approved')) await completeTna(d.job, 'BOM Approval');
    },
  },
  pattern: {
    async beforeSave(ctx) {
      const d = ctx.data;
      await uniqueInJob(ctx, 'pattern', 'patternNo', 'Pattern');
      let spec = d.techSpec ? await models.techSpec.findById(d.techSpec).lean() : null;
      if (!spec) {
        const specs = await models.techSpec.find({ job: ctx.job._id, isDeleted: false }).sort({ revision: -1, createdAt: -1 }).lean();
        spec = specs.find((x) => x.status === 'Approved') || specs[0];
      }
      if (!spec) return;
      if (String(spec.job) !== String(ctx.job._id)) throw ApiError.badRequest('Specification belongs to a different job');
      d.techSpec = spec._id;
      // the spec's measurement chart is the grading source – no re-entry
      if (!(d.gradeRules || []).length) d.gradeRules = (spec.measurements || []).map(({ pom, baseValue, gradeIncrement, tolerance }) => ({ pom, baseValue, gradeIncrement, tolerance }));
      if (!(d.sizes || []).length) d.sizes = spec.sizes;
      if (!d.baseSize) d.baseSize = spec.baseSize;
    },
    async beforeStatus(ctx) {
      if (ctx.to === 'Pattern Approved') {
        const ok = await models.techSpec.exists({ job: ctx.doc.job, isDeleted: false, status: 'Approved' });
        guard(ctx, ok, 'Specification is not approved yet');
      }
      if (ctx.to === 'Graded') guard(ctx, (ctx.doc.gradeRules || []).length && (ctx.doc.sizes || []).length, 'Grade rules and sizes are required before grading is complete');
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      if (reached(ctx, 'Pattern Approved')) {
        if (!d.approvalDate) await models.pattern.updateOne({ _id: d._id }, { $set: { approvalDate: new Date() } });
        await completeTna(d.job, 'Pattern Approval');
      }
      if (reached(ctx, 'Graded')) {
        await completeTna(d.job, 'Grading');
        await notify({ type: 'INFO', severity: 'info', title: `Pattern graded – ${d.jobNo}`, message: `${d.patternNo} graded for ${(d.sizes || []).join(', ')}. Ready for marker making.`, departments: ['CAD / Pattern', 'Cutting'], job: ctx.job, module: 'pattern', recordId: d._id, link: `/m/pattern/${d._id}` });
      }
      await syncPpReadiness(d.job);
    },
  },
  marker: {
    async beforeSave(ctx) {
      const d = ctx.data;
      await uniqueInJob(ctx, 'marker', 'markerNo', 'Marker');
      if (d.pattern) {
        const p = await models.pattern.findById(d.pattern).lean();
        if (!p || String(p.job) !== String(ctx.job._id)) throw ApiError.badRequest('Pattern belongs to a different job');
      } else {
        const p = await models.pattern.findOne({ job: ctx.job._id, isDeleted: false, status: { $in: PATTERN_DONE } }).sort({ createdAt: -1 }).lean();
        if (p) d.pattern = p._id;
      }
      // marker consumption is checked against the BOM (or the order when no BOM line matches)
      const bom = await models.bom.findOne({ job: ctx.job._id, isDeleted: false }).lean();
      d.bomConsumption = bomConsumptionFor(bom, d.fabricType) || num(ctx.job.consumption);
    },
    async beforeStatus(ctx) {
      if (ctx.to !== 'Approved') return;
      const p = ctx.doc.pattern ? await models.pattern.findById(ctx.doc.pattern).lean() : null;
      guard(ctx, p && ['Graded', 'Released'].includes(p.status), 'Marker needs a graded pattern before approval');
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      if (reached(ctx, 'Approved')) await completeTna(d.job, 'Marker Ready');
      if (Math.abs(num(d.consumptionVariancePct)) > 3 && num(d.consumptionPerPc) > 0) {
        await notify({
          type: 'INFO', severity: num(d.consumptionVariancePct) > 0 ? 'warning' : 'info', title: `Marker consumption ${num(d.consumptionVariancePct) > 0 ? 'above' : 'below'} BOM – ${d.jobNo}`,
          message: `${d.markerNo}: ${d.consumptionPerPc} ${d.unit}/pc vs BOM ${d.bomConsumption} (${d.consumptionVariancePct > 0 ? '+' : ''}${d.consumptionVariancePct}%). Review fabric booking and costing.`,
          departments: ['Fabric Department', 'Costing Factory', 'Factory Merchandising'], job: ctx.job, module: 'marker', recordId: d._id,
          link: `/m/marker/${d._id}`, dedupeKey: `mkr-var-${d._id}-${d.consumptionPerPc}`,
        });
      }
      await syncPpReadiness(d.job);
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
  /* ---------------- Fabric stock chain ---------------- */
  knitting: {
    async beforeSave(ctx) {
      const d = ctx.data;
      const available = await yarnAvailable(d.yarnCount, d.lotNo, ctx.existing?._id);
      guard(ctx, num(d.yarnIssuedKg) <= available + 0.001, `Yarn issued (${num(d.yarnIssuedKg)} kg) exceeds yarn stock for "${d.yarnCount}"${d.lotNo ? ` lot ${d.lotNo}` : ''} (${available} kg available)`);
      guard(ctx, num(d.greyReceivedKg) + num(d.rejectedKg) <= num(d.yarnIssuedKg) + 0.001, 'Grey received + rejected cannot exceed yarn issued');
    },
  },
  fabricProcess: {
    async beforeSave(ctx) {
      const d = ctx.data;
      if (d.inputStage === d.outputStage && d.inputStage === 'Finished Fabric') throw ApiError.badRequest('Input and output stage cannot both be Finished Fabric');
      const available = await stageAvailable(d.inputStage, d.fabricType, d.color, ctx.existing?._id);
      guard(ctx, num(d.issuedKg) <= available + 0.001, `Issued ${num(d.issuedKg)} kg exceeds ${d.inputStage.toLowerCase()} stock for "${d.fabricType}" (${available} kg available)`);
      guard(ctx, num(d.receivedKg) + num(d.rejectedKg) <= num(d.issuedKg) + 0.001, 'Received + rejected cannot exceed issued quantity');
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
      if (ctx.data.marker) {
        // the approved marker is the source for lay data – no re-entry
        const m = await models.marker.findById(ctx.data.marker).lean();
        if (!m || m.isDeleted || String(m.job) !== String(ctx.job._id)) throw ApiError.badRequest('Marker belongs to a different job');
        guard(ctx, ['Approved', 'Issued to Cutting'].includes(m.status), `Marker ${m.markerNo} is not approved (${m.status})`);
        Object.assign(ctx.data, { markerNo: m.markerNo, markerLength: m.markerLength, markerWidth: m.markerWidth, markerEfficiencyPct: m.markerEfficiencyPct });
        if (!ctx.data.ratio) ctx.data.ratio = m.ratio;
        if (!ctx.data.color) ctx.data.color = m.color;
        ctx.data = applyCompute(MODULES.cutting, ctx.data);
      }
      const tol = await getSetting('tolerance');
      const prev = sum(await others('cutting', ctx, { status: { $ne: 'Rejected' } }), 'cutQty');
      const limit = num(ctx.job.orderQty) * (1 + num(tol.overCutPct) / 100);
      guard(ctx, prev + num(ctx.data.cutQty) <= limit, `Cumulative cutting (${prev + num(ctx.data.cutQty)}) exceeds order quantity + ${tol.overCutPct}% (${Math.floor(limit)})`);
      // fabric availability
      const fabricIssued = sum(await models.fabricBooking.find({ job: ctx.job._id, isDeleted: false }).lean(), 'issuedQty');
      const fabricUsedPrev = sum(await others('cutting', ctx), 'fabricUsed');
      if (fabricIssued > 0) guard(ctx, fabricUsedPrev + num(ctx.data.fabricUsed) <= fabricIssued, `Fabric used in cutting (${round(fabricUsedPrev + num(ctx.data.fabricUsed))}) exceeds fabric issued (${fabricIssued})`);
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      if (!d.marker || d.status === 'Rejected') return;
      const m = await models.marker.findById(d.marker);
      if (m?.status === 'Approved') {
        m.statusHistory.push({ from: 'Approved', to: 'Issued to Cutting', by: ctx.req.user?._id, byName: ctx.req.user?.name, reason: `Used by cutting ${d.refNo}` });
        m.status = 'Issued to Cutting';
        await m.save();
      }
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
