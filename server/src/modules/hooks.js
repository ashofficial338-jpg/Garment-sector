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
import { guard } from './guards.js';
import * as factory from './factoryHooks.js';
import { notify } from '../services/notify.js';
import { getSetting } from '../services/settings.js';
import { num, sum, round, efficiency } from '../../../shared/calc.js';
import { applyCompute, MODULES } from '../../../shared/modules/index.js';
import { bomConsumptionFor, materialPerPcFromCosting } from '../../../shared/modules/preproduction.js';
import { BUYER_ORDER_DONE } from '../../../shared/modules/commercial.js';
import { RETURN_TO_STORE, RETURN_TO_SUPPLIER, ADJUST_SHORT, ADJUST_EXCESS } from '../../../shared/modules/planning.js';
import { yarnAvailable, stageAvailable } from '../services/stock.js';
import { completeTna, syncPpReadiness, PATTERN_DONE } from '../services/preproduction.js';
import { createBookingsFromBom } from '../services/orderFlow.js';
import { syncLedger } from '../services/stockLedger.js';
import { executeTransfer, resolveDestination } from '../services/fabricTransfer.js';
import { rollTotals, rollStock, syncBookingFromRolls, syncForecastFromReceipts, syncBomFromBooking } from '../services/fabricRolls.js';

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


/** Booking or main-job forecast a fabric return / debit note is against (exactly one, of this job); stamps fabric and unit. */
async function fabricSource(ctx) {
  const d = ctx.data;
  if (!!d.booking === !!d.forecast) throw ApiError.badRequest('Select either a fabric booking or a fabric forecast');
  const src = d.booking ? await models.fabricBooking.findById(d.booking).lean() : await models.fabricForecast.findById(d.forecast).lean();
  if (!src || src.isDeleted || String(src.job) !== String(ctx.job._id)) throw ApiError.badRequest('The booking / forecast belongs to a different job');
  Object.assign(d, { fabric: [src.fabricType, src.color].filter(Boolean).join(' · '), unit: src.unit });
  return src;
}

/** Forecast quantities are never shipped or invoiced: an advance job needs its actual buyer PO first. */
function requirePo(job, what) {
  if (job?.poStatus === 'Awaiting PO') throw ApiError.badRequest(`${job.jobNo} is an advance job awaiting the buyer PO – it cannot be ${what} until the actual PO is linked`);
}

export const hooks = {
  /* ---------------- Commercial ---------------- */
  buyerOrder: {
    async beforeSave(ctx) {
      const d = ctx.data;
      if (ctx.existing?.jobNo) throw ApiError.badRequest(`Buyer PO is on job ${ctx.existing.jobNo} – change the order on the job (it is revision-tracked there)`);
      const dup = await models.buyerOrder.exists({ _id: { $ne: ctx.existing?._id }, buyer: d.buyer, poNo: d.poNo, styleNo: d.styleNo, isDeleted: false, status: { $ne: 'Cancelled' } });
      if (dup) throw ApiError.conflict(`Buyer PO ${d.poNo} / style ${d.styleNo} is already registered`);
      if (d.quotation) {
        const q = await models.quotation.findById(d.quotation).lean();
        if (!q || String(q.buyer) !== String(d.buyer)) throw ApiError.badRequest('The quotation belongs to a different buyer');
      }
    },
    async beforeStatus(ctx) {
      if (BUYER_ORDER_DONE.includes(ctx.to)) throw ApiError.badRequest(`"${ctx.to}" is set by the Create Job / Link to Job actions`);
      if (ctx.doc.jobNo) throw ApiError.badRequest(`Buyer PO is already on job ${ctx.doc.jobNo}`);
    },
  },
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
      const keep = (l, k) => prev.get(String(l._id))?.[k] ?? null;
      d.lines = (d.lines || []).map((l) => ({ ...l, ...Object.fromEntries(['bookingRef', 'receivedQty', 'issuedQty', 'consumedQty', 'balanceQty'].map((k) => [k, keep(l, k)])) }));
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

  /* ---------------- Fabric forecast & transfer ---------------- */
  fabricForecast: {
    async beforeSave(ctx) {
      const d = ctx.data;
      if (ctx.job.parentJob) throw ApiError.badRequest('Fabric is forecast on the main job – sub jobs receive it by transfer');
      guard(ctx, num(d.receivedQty) + 0.0005 >= num(ctx.existing?.transferredQty), `Received quantity cannot be below what was already transferred (${ctx.existing?.transferredQty})`);
    },
    async afterSave(ctx) { await syncLedger('fabricForecast', ctx.saved); },
    async afterDelete(rec) { await syncLedger('fabricForecast', rec); },
  },
  fabricTransfer: {
    async beforeSave(ctx) {
      const d = ctx.data;
      if (ctx.existing && ['Completed', 'Cancelled'].includes(ctx.existing.status)) throw ApiError.badRequest(`Transfer is ${ctx.existing.status} and cannot be edited`);
      const f = await models.fabricForecast.findById(d.sourceForecast).lean();
      if (!f || f.isDeleted || String(f.job) !== String(ctx.job._id)) throw ApiError.badRequest('Select a fabric forecast of the source job');
      Object.assign(d, { fabric: [f.fabricType, f.color].filter(Boolean).join(' · '), lotNo: f.lotNo || '', unit: f.unit, fromUnit: ctx.job.businessUnit });
      if (!(num(d.qty) > 0)) throw ApiError.badRequest('Transfer quantity must be greater than 0');
      const pending = num(f.receivedQty) - num(f.transferredQty);
      guard(ctx, num(d.qty) <= pending + 0.0005, `Transfer ${d.qty} ${f.unit} exceeds received forecast fabric available (${round(pending, 3)} ${f.unit})`);
      if (d.createSubJob) {
        if (!ctx.job.isForecast || ctx.job.parentJob) throw ApiError.badRequest('A new sub job can only be created from a forecast / continuous main job');
        d.toUnit = ctx.job.businessUnit; d.toJobNo = '';
      } else {
        if (!d.toJobNo) throw ApiError.badRequest('Destination Job No is required (or tick "Create a new Sub-Job")');
        await resolveDestination(d, ctx.req, ctx.job);
      }
    },
    async beforeStatus(ctx) {
      if (ctx.to !== 'Completed') return;
      if (ctx.doc.createSubJob && !ctx.req.perms.isAdmin) throw ApiError.forbidden('Only Admin can create sub jobs (complete this transfer as Admin)');
      const f = await models.fabricForecast.findById(ctx.doc.sourceForecast).lean();
      const pending = num(f?.receivedQty) - num(f?.transferredQty);
      guard(ctx, num(ctx.doc.qty) <= pending + 0.0005, `Only ${round(pending, 3)} ${f?.unit || ''} of received forecast fabric is still available`);
    },
    async afterSave(ctx) {
      if (reached(ctx, 'Completed')) await executeTransfer(ctx.saved._id, ctx.req);
    },
  },

  /* ---------------- Fabric receipt (lot / roll / 4-point) and allocation (roll-wise issue) ---------------- */
  fabricReceipt: {
    async beforeSave(ctx) {
      const d = ctx.data;
      if (!!d.booking === !!d.forecast) throw ApiError.badRequest('Select either a fabric booking or a fabric forecast');
      const src = d.booking ? await models.fabricBooking.findById(d.booking).lean() : await models.fabricForecast.findById(d.forecast).lean();
      if (!src || src.isDeleted || String(src.job) !== String(ctx.job._id)) throw ApiError.badRequest('The booking / forecast belongs to a different job');
      Object.assign(d, { fabric: [src.fabricType, src.color].filter(Boolean).join(' · '), unit: src.unit });
      const rolls = (d.rolls || []).filter((r) => r.rollNo || num(r.qty));
      if (!rolls.length) throw ApiError.badRequest('Enter at least one roll');
      if (rolls.some((r) => !r.rollNo || !(num(r.qty) > 0))) throw ApiError.badRequest('Every roll needs a roll no and a quantity');
      const nos = rolls.map((r) => String(r.rollNo).trim());
      const dupIn = nos.filter((x, i) => nos.indexOf(x) !== i);
      if (dupIn.length) throw ApiError.badRequest(`Roll ${dupIn[0]} entered twice`);
      const others = await models.fabricReceipt.find({ [d.booking ? 'booking' : 'forecast']: src._id, isDeleted: false, _id: { $ne: ctx.existing?._id } }).lean();
      const taken = new Set(others.flatMap((o) => (o.rolls || []).map((r) => String(r.rollNo).trim())));
      const dup = nos.find((x) => taken.has(x));
      if (dup) throw ApiError.conflict(`Roll ${dup} is already received for this ${d.booking ? 'booking' : 'forecast'}`);
      d.rolls = rolls;
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      if (d.booking) await syncBookingFromRolls(d.booking, d.receiptDate); else await syncForecastFromReceipts(d.forecast, d.receiptDate);
    },
    async afterDelete(rec) { if (rec.booking) await syncBookingFromRolls(rec.booking); else await syncForecastFromReceipts(rec.forecast); },
  },
  fabricAllocation: {
    async beforeSave(ctx) {
      const d = ctx.data;
      const b = await models.fabricBooking.findById(d.booking).lean();
      if (!b || b.isDeleted || String(b.job) !== String(ctx.job._id)) throw ApiError.badRequest('The fabric booking belongs to a different job');
      Object.assign(d, { fabric: [b.fabricType, b.color].filter(Boolean).join(' · '), unit: b.unit });
      const stock = await rollStock(b._id, ctx.existing?._id);
      if (!stock.size) throw ApiError.badRequest(`No approved fabric receipt (passed rolls) for ${b.refNo} yet`);
      const rolls = (d.rolls || []).filter((r) => r.rollNo || num(r.qty));
      if (!rolls.length) throw ApiError.badRequest('Allocate at least one roll');
      d.rolls = rolls.map((r) => {
        const s = stock.get(String(r.rollNo).trim());
        if (!s) throw ApiError.badRequest(`Roll ${r.rollNo} is not a passed roll of ${b.refNo}`);
        guard(ctx, num(r.qty) > 0 && s.allocated + num(r.qty) <= s.qty + 0.0005, `Roll ${r.rollNo}: ${num(r.qty)} requested, ${round(s.qty - s.allocated, 3)} ${b.unit} left on the roll`);
        return { ...r, lotNo: s.lotNo };
      });
    },
    async afterSave(ctx) { await syncBookingFromRolls(ctx.saved.booking, ctx.saved.allocationDate); },
    async afterDelete(rec) { await syncBookingFromRolls(rec.booking); },
  },

  /* ---------------- Fabric returns and debit notes (Fabric Department) ---------------- */
  fabricReturn: {
    async beforeSave(ctx) {
      const d = ctx.data;
      const src = await fabricSource(ctx);
      if (!d.rate) d.rate = src.rate;
      if (!(num(d.qty) > 0)) throw ApiError.badRequest('Return quantity must be greater than 0');
      const others = sum(await models.fabricReturn.find({ [d.booking ? 'booking' : 'forecast']: src._id, returnType: d.returnType, isDeleted: false, status: { $ne: 'Cancelled' }, _id: { $ne: ctx.existing?._id } }).lean(), 'qty');
      if ([ADJUST_SHORT, ADJUST_EXCESS].includes(d.returnType)) {
        if (!d.booking) throw ApiError.badRequest('A stock adjustment is against the job fabric booking');
        if (d.returnType === ADJUST_SHORT) guard(ctx, num(d.qty) <= num(src.balanceQty) + (ctx.existing?.returnType === ADJUST_SHORT ? num(ctx.existing.qty) : 0) + 0.0005, `Shortage ${d.qty} ${src.unit} exceeds the store balance (${src.balanceQty} ${src.unit})`);
      } else if (d.returnType === RETURN_TO_STORE) {
        // only fabric issued to cutting and not used in cutting can come back
        if (!d.booking) throw ApiError.badRequest('A return from cutting is against the job fabric booking');
        const usedInCutting = sum(await models.cutting.find({ job: ctx.job._id, isDeleted: false, status: { $ne: 'Rejected' } }).lean(), 'fabricUsed');
        const unused = num(src.issuedQty) - others - usedInCutting;
        guard(ctx, num(d.qty) <= unused + 0.0005, `Return ${d.qty} ${src.unit} exceeds fabric issued and not used in cutting (${round(unused, 3)} ${src.unit})`);
      } else {
        // to the supplier: rejected rolls first, then store stock (forecast: rejected rolls only)
        const receipts = await models.fabricReceipt.find({ [d.booking ? 'booking' : 'forecast']: src._id, isDeleted: false }).lean();
        const rejected = sum(receipts, 'rejectedQty');
        const available = d.booking ? num(src.balanceQty) + (ctx.existing?.returnType === RETURN_TO_SUPPLIER ? num(ctx.existing.qty) : 0) : rejected - others;
        guard(ctx, num(d.qty) <= available + 0.0005, `Return ${d.qty} ${src.unit} exceeds ${d.booking ? 'fabric in store' : 'rejected forecast rolls'} (${round(available, 3)} ${src.unit})`);
      }
      ctx.data = applyCompute(MODULES.fabricReturn, d);
    },
    async afterSave(ctx) { if (ctx.saved.booking) await syncBookingFromRolls(ctx.saved.booking, ctx.saved.returnDate); },
    async afterDelete(rec) { if (rec.booking) await syncBookingFromRolls(rec.booking); },
  },
  fabricDebit: {
    async beforeSave(ctx) {
      const d = ctx.data;
      if (d.fabricReturn) {
        const r = await models.fabricReturn.findById(d.fabricReturn).lean();
        if (!r || r.isDeleted || String(r.job) !== String(ctx.job._id)) throw ApiError.badRequest('The fabric return belongs to a different job');
        if (!d.booking && !d.forecast) Object.assign(d, r.booking ? { booking: r.booking } : { forecast: r.forecast });
        if (!num(d.qty)) d.qty = r.qty;
        if (!num(d.rate)) d.rate = r.rate;
      }
      const src = await fabricSource(ctx);
      if (!num(d.rate)) d.rate = src.rate;
      if (!d.supplier && src.supplier) d.supplier = src.supplier;
      if (d.debitTo === 'Supplier' && !d.supplier) throw ApiError.badRequest('Select the supplier the debit note is raised on');
      if (d.debitTo === 'Department – accountability' && !d.debitParty) throw ApiError.badRequest('Enter the department the debit is raised on');
      ctx.data = applyCompute(MODULES.fabricDebit, d);
      if (!(num(ctx.data.amount) > 0)) throw ApiError.badRequest('Debit amount must be greater than 0');
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      if (d.booking) await syncBookingFromRolls(d.booking, d.debitDate);
      if (ctx.isCreate) {
        await notify({
          type: 'INFO', severity: 'info', title: `Fabric debit note ${d.refNo} – ${d.jobNo}`,
          message: `${d.reason}: ${d.amount} debited to ${d.debitTo === 'Supplier' ? d.supplierName || 'supplier' : d.debitTo === 'Department – accountability' ? d.debitParty : 'the job'} (${d.costEffect}).`,
          departments: ['Fabric Department', 'Accounts & Finance', 'Factory Merchandising'], job: ctx.job, module: 'fabricDebit', recordId: d._id, link: `/m/fabricDebit/${d._id}`,
        });
      }
    },
    async afterDelete(rec) { if (rec.booking) await syncBookingFromRolls(rec.booking); },
  },

  supplierBill: {
    async beforeSave(ctx) {
      const d = ctx.data;
      const dup = await models.supplierBill.exists({ _id: { $ne: ctx.existing?._id }, supplier: d.supplier, billNo: d.billNo, isDeleted: false });
      if (dup) throw ApiError.conflict(`Supplier invoice ${d.billNo} is already entered for this supplier`);
      if (d.fabricBooking && !d.poRef) d.poRef = (await models.fabricBooking.findById(d.fabricBooking).lean())?.supplierPoNo;
      guard(ctx, num(d.paidAmount) + num(d.debitNoteAdjusted) <= num(d.totalAmount) + 0.005, `Payments ${d.paidAmount} + set-off ${num(d.debitNoteAdjusted)} exceed the bill total ${d.totalAmount}`);
    },
  },

  /* ---------------- Materials ---------------- */
  fabricBooking: {
    async afterDelete(rec) { await syncLedger('fabricBooking', rec); },
    async beforeSave(ctx) {
      const d = ctx.data;
      // quantities driven by roll-level receipts / allocations are not typed over
      if (ctx.existing) {
        const t = await rollTotals(ctx.existing._id);
        if (t.receipt) Object.assign(d, t.receipt);
        if (t.allocation) d.issuedQty = t.allocation.issuedQty;
        Object.assign(d, t.returns);
        ctx.data = applyCompute(MODULES.fabricBooking, d);
      }
      guard(ctx, num(d.approvedQty) <= num(d.inspectedQty) || !num(d.inspectedQty), 'Approved quantity cannot exceed inspected quantity');
      guard(ctx, num(d.inspectedQty) <= num(d.receivedQty), 'Inspected quantity cannot exceed received quantity');
      const available = num(d.approvedQty) || num(d.receivedQty);
      guard(ctx, num(d.issuedQty) <= available, `Issued quantity (${d.issuedQty}) exceeds available fabric (${available})`);
      guard(ctx, num(d.usedQty) <= num(d.netIssuedQty ?? d.issuedQty) + 0.0005 || !num(d.usedQty), `Used quantity (${d.usedQty}) cannot exceed net issued quantity (${d.netIssuedQty ?? d.issuedQty})`);
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      await syncLedger('fabricBooking', d); // dated receipt / issue movements for inventory valuation
      await syncBomFromBooking(d);
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
    async afterDelete(rec) { await syncLedger('trimBooking', rec); },
    async beforeSave(ctx) {
      const d = ctx.data;
      guard(ctx, num(d.issuedQty) <= num(d.receivedQty), 'Issued trim quantity exceeds received quantity');
      guard(ctx, num(d.usedQty) <= num(d.issuedQty) || !num(d.usedQty), 'Used trim quantity exceeds issued quantity');
    },
    async afterSave(ctx) {
      const d = ctx.saved;
      await syncLedger('trimBooking', d);
      await syncBomFromBooking(d);
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
      const fabricIssued = round(sum((await models.fabricBooking.find({ job: ctx.job._id, isDeleted: false }).lean()).map((b) => ({ q: num(b.issuedQty) - num(b.returnedFromCuttingQty) })), 'q'), 3);
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
      factory.lockConsolidated(ctx, 'Sewing entry');
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
      factory.lockConsolidated(ctx, 'Finishing entry');
      const d = ctx.data;
      guard(ctx, num(d.passedQty) + num(d.rejection) <= num(d.inputQty), 'Passed + rejected cannot exceed finishing input');
      guard(ctx, num(d.ironedQty) <= num(d.inputQty) && num(d.needleCheckedQty) <= num(d.inputQty), 'Ironed / needle-checked quantity cannot exceed finishing input');
      guard(ctx, num(d.needleFailQty) <= num(d.needleCheckedQty), 'Metal-detected pieces cannot exceed the pieces checked');
      guard(ctx, num(d.needleFailQty) <= num(d.rejection) + num(d.rework), 'Metal-detected pieces must be rejected or sent for rework');
      if (num(d.needleCheckedQty) > 0) guard(ctx, num(d.passedQty) <= num(d.needleCheckedQty) - num(d.needleFailQty), `Only needle-detector cleared pieces can pass (${num(d.needleCheckedQty) - num(d.needleFailQty)} cleared)`);
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
      await factory.inspectionRules(ctx);
    },
    beforeStatus: (gate) => factory.inspectionStatusRules(gate),
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
    beforeStatus: (gate) => factory.shipmentStatusRules(gate),
    async beforeSave(ctx) {
      const d = ctx.data;
      requirePo(ctx.job, 'shipped');
      if (ctx.isCreate && !num(d.qty)) {
        // pull packing data automatically
        // what is packed and not yet on an earlier shipment (quantity, cartons, weights and volume alike)
        const packs = await models.packing.find({ job: ctx.job._id, isDeleted: false }).lean();
        const earlier = await others('shipment', ctx, { status: { $ne: 'Cancelled' } });
        const left = (pf, sf, dp = 2) => Math.max(round(sum(packs, pf) - sum(earlier, sf), dp), 0);
        d.qty = left('totalQty', 'qty', 0);
        d.cartons = d.cartons || left('totalCartons', 'cartons', 0);
        d.netWeight = d.netWeight || left('totalNetWeight', 'netWeight');
        d.grossWeight = d.grossWeight || left('totalGrossWeight', 'grossWeight');
        d.cbm = d.cbm || left('totalCbm', 'cbm', 3);
        d.destination = d.destination || ctx.job.destination;
        if (!d.shipmentDate) d.shipmentDate = ctx.job.shipmentDate;
      }
      const tol = await getSetting('tolerance');
      const prev = sum(await others('shipment', ctx, { status: { $ne: 'Cancelled' } }), 'qty');
      const limit = num(ctx.job.orderQty) * (1 + num(tol.overShipPct) / 100);
      guard(ctx, prev + num(d.qty) <= limit, `Shipment quantity (${prev + num(d.qty)}) exceeds order quantity (${ctx.job.orderQty})`);
      d.balanceQty = Math.max(num(ctx.job.orderQty) - prev - num(d.qty), 0);
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
      requirePo(ctx.job, 'invoiced');
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
  expense: { beforeSave: (ctx) => factory.expenseRules(ctx) },

  /* ---------------- Factory operations (see factoryHooks.js) ---------------- */
  hourlyProduction: factory.hourlyProduction,
  qcRework: factory.qcRework,
  attendance: factory.attendance,
  payroll: factory.payroll,
  factoryExpense: factory.factoryExpense,
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
