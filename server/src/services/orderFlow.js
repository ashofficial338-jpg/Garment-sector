/**
 * Order flow automation:
 *   Order Confirmed → Job No → T&A → Fabric & Trim requirement → PP Meeting
 *   → Sampling tasks → Production plan draft → notifications.
 * Also handles quotation → order conversion, forecast sub jobs and change propagation.
 */
import { models } from '../modules/builder.js';
import { MODULES, applyCompute } from '../../../shared/modules/index.js';
import { generateTna, num, sum } from '../../../shared/calc.js';
import { nextJobNo, orderNoFromJobNo, nextSubJobCode, nextRefNo } from './numbering.js';
import { audit } from './audit.js';
import { notify } from './notify.js';
import { refreshJob } from './lifecycle.js';
import { ApiError } from '../utils/ApiError.js';

const jobLink = (job) => ({
  job: job._id, jobNo: job.jobNo, parentJob: job.parentJob || undefined,
  parentJobNo: job.parentJobNo || undefined,
  buyerName: job.buyerName, styleNo: job.styleNo, poNo: job.poNo,
});

async function createLinked(key, job, data, req) {
  const def = MODULES[key];
  const body = applyCompute(def, { status: def.defaultStatus, ...(def.prefill ? def.prefill(job) : {}), ...data });
  const doc = await models[key].create({
    ...body, ...jobLink(job),
    refNo: await nextRefNo(def.prefix),
    createdBy: req?.user?._id, createdByName: req?.user?.name || 'system',
  });
  return doc;
}

/** Generate every downstream record for a confirmed order (idempotent per module). */
export async function generateDownstream(job, req) {
  const created = [];
  const has = async (key, extra = {}) => models[key].exists({ job: job._id, isDeleted: false, ...extra });

  if (!(await has('tna'))) {
    created.push(await createLinked('tna', job, { orderDate: job.orderDate, shipmentDate: job.shipmentDate, activities: generateTna(job.orderDate, job.shipmentDate) }, req));
  }
  if (!(await has('fabricBooking')) && (job.fabricType || num(job.consumption) > 0)) {
    created.push(await createLinked('fabricBooking', job, {}, req));
  }
  if (!(await has('trimBooking'))) {
    for (const t of job.trims || []) {
      created.push(await createLinked('trimBooking', job, {
        item: t.item, description: t.description, unit: t.unit, consumptionPerPc: t.consumptionPerPc,
        wastagePct: t.wastagePct, rate: t.rate,
      }, req));
    }
  }
  if (!(await has('ppMeeting'))) {
    const d = new Date(job.orderDate || Date.now());
    const span = job.shipmentDate ? (new Date(job.shipmentDate) - d) * 0.06 : 5 * 86400000;
    created.push(await createLinked('ppMeeting', job, { meetingDate: new Date(d.getTime() + span) }, req));
  }
  if (!(await has('sample'))) {
    for (const sampleType of ['Proto Sample', 'Fit Sample', 'Size Set', 'PP Sample']) {
      created.push(await createLinked('sample', job, { sampleType }, req));
    }
  }
  if (!(await has('productionPlan'))) {
    created.push(await createLinked('productionPlan', job, { workingMinutes: 480, targetEfficiencyPct: 60 }, req));
  }

  await notify({
    type: 'INFO', severity: 'info', title: `New job ${job.jobNo} released`,
    message: `${job.buyerName || ''} · Style ${job.styleNo} · ${job.orderQty} pcs. T&A, fabric, trims, PP meeting, samples and production plan were generated.`,
    departments: ['Factory Merchandising', 'Fabric Department', 'Production', 'Costing Factory', 'Head Office Merchandising'],
    job, link: `/jobs/${job.jobNo}`,
  });
  return created;
}

async function buyerName(buyerId) {
  if (!buyerId) return undefined;
  const b = await models.buyer.findById(buyerId).lean();
  return b?.name;
}

/** Create a confirmed order / job. */
export async function createJob(data, req, { skipDownstream = false } = {}) {
  const def = MODULES.orders;
  if (data.poNo && data.buyer && !data.parentJob) {
    const dup = await models.orders.exists({ buyer: data.buyer, poNo: data.poNo, styleNo: data.styleNo, isDeleted: false, parentJob: null });
    if (dup) throw ApiError.conflict(`PO ${data.poNo} / Style ${data.styleNo} already exists for this buyer`);
  }
  const jobNo = data.jobNo || await nextJobNo(data.orderDate);
  const body = applyCompute(def, { ...data, status: 'Confirmed' });
  const job = await models.orders.create({
    ...body,
    jobNo, orderNo: orderNoFromJobNo(jobNo), refNo: jobNo,
    buyerName: await buyerName(data.buyer),
    createdBy: req?.user?._id, createdByName: req?.user?.name || 'system',
    statusHistory: [{ from: null, to: 'Confirmed', by: req?.user?._id, byName: req?.user?.name, reason: 'Order confirmed' }],
  });
  await audit(req, { action: 'CREATE', module: 'orders', record: job, message: `Order confirmed – Job ${jobNo} generated` });
  if (!skipDownstream && !job.isForecast) await generateDownstream(job.toObject(), req);
  await refreshJob(job._id);
  return job;
}

/** Quotation (Approved) → Confirmed Order. No data re-entry: everything is pulled. */
export async function convertQuotation(quotationId, extra, req) {
  const q = await models.quotation.findById(quotationId).lean();
  if (!q || q.isDeleted) throw ApiError.notFound('Quotation not found');
  if (q.status !== 'Approved') throw ApiError.badRequest('Only an Approved quotation can be converted to an order');
  const costing = q.costing ? await models.costing.findById(q.costing).lean() : null;
  const enquiry = q.enquiry ? await models.enquiry.findById(q.enquiry).lean() : null;
  if (!extra.poNo) throw ApiError.badRequest('PO No is required to confirm the order');
  if (!extra.shipmentDate) throw ApiError.badRequest('Shipment date is required to confirm the order');

  const job = await createJob({
    buyer: q.buyer, buyerContact: q.buyerContact, styleNo: q.styleNo, product: q.product, garmentType: enquiry?.garmentType,
    orderDate: extra.orderDate || new Date(), orderQty: extra.orderQty || q.orderQty, unitPrice: q.price, currency: q.currency,
    paymentTerms: q.paymentTerms, deliveryTerms: q.deliveryTerms, colors: q.color ? q.color.split(/[,/]/).map((s) => s.trim()) : [],
    sizes: q.sizeRange ? q.sizeRange.split(/[,/-]/).map((s) => s.trim()).filter(Boolean) : [],
    fabricType: q.fabric, composition: q.composition, gsm: q.gsm,
    consumption: costing?.fabricConsumption, consumptionUnit: costing?.fabricUnit, wastagePct: costing?.fabricWastagePct, fabricRate: costing?.fabricRate,
    enquiry: q.enquiry, costing: q.costing, quotation: q._id,
    ...extra,
  }, req);

  await models.quotation.updateOne({ _id: q._id }, { $set: { status: 'Converted', ...jobLink(job) }, $push: { statusHistory: { from: q.status, to: 'Converted', by: req.user._id, byName: req.user.name, reason: `Converted to ${job.jobNo}` } } });
  if (q.costing) await models.costing.updateOne({ _id: q.costing }, { $set: jobLink(job) });
  if (q.enquiry) await models.enquiry.updateOne({ _id: q.enquiry }, { $set: { status: 'Converted', ...jobLink(job) } });
  await refreshJob(job._id);
  return job;
}

/** Forecast / continuous orders: split a main job into sub jobs (Admin only – enforced by route). */
export async function createSubJobs(mainId, parts, req) {
  const main = await models.orders.findById(mainId).lean();
  if (!main || main.isDeleted) throw ApiError.notFound('Main job not found');
  if (main.parentJob) throw ApiError.badRequest('A sub job cannot have sub jobs');
  if (!main.isForecast) throw ApiError.badRequest('Mark the job as a Forecast / Continuous order first');
  if (!Array.isArray(parts) || !parts.length) throw ApiError.badRequest('Provide at least one sub job');
  parts.forEach((p) => { if (!(num(p.orderQty) > 0)) throw ApiError.badRequest('Sub job quantity must be greater than 0'); });

  const existing = await models.orders.find({ parentJob: main._id, isDeleted: false }).lean();
  const total = sum(existing, 'orderQty') + sum(parts, 'orderQty');
  if (num(main.forecastQty) > 0 && total > num(main.forecastQty) && !req.body?._override?.reason) {
    throw ApiError.badRequest(`Sub job total (${total}) exceeds forecast quantity (${main.forecastQty}). Admin override with reason required.`);
  }

  const created = [];
  for (const p of parts) {
    const jobNo = await nextSubJobCode(main.jobNo);
    const { _id, createdAt, updatedAt, stages, statusHistory, refNo, orderNo, ...base } = main;
    const sub = await createJob({
      ...base, ...p, jobNo, parentJob: main._id, parentJobNo: main.jobNo, subJobCode: jobNo.split('-').pop(),
      isForecast: false, forecastQty: 0, sizeBreakdown: p.sizeBreakdown || [],
      orderDate: p.orderDate || new Date(), shipmentDate: p.shipmentDate || main.shipmentDate,
    }, req);
    created.push(sub);
  }
  await models.orders.updateOne({ _id: main._id }, { $set: { subJobCount: existing.length + created.length, orderQty: total } });
  await audit(req, { action: 'SUBJOB', module: 'orders', record: main, message: `Created sub jobs ${created.map((c) => `${c.jobNo} (${c.orderQty})`).join(', ')}`, reason: req.body?._override?.reason });
  await refreshJob(main._id);
  return created;
}

/**
 * Propagate changes made at the order level to dependent processes.
 * Records still in early status are updated automatically; later ones are flagged.
 * Returns an impact list shown to the user.
 */
export async function propagateJobChanges(job, changes, req) {
  const changed = new Set(changes.map((c) => c.field));
  const impact = [];
  const fabricFields = ['orderQty', 'consumption', 'wastagePct', 'cuttingWastagePct', 'shrinkagePct', 'relaxationPct', 'dyeingLossPct', 'processLossPct', 'fabricType', 'composition', 'gsm', 'width', 'fabricColor', 'fabricRate', 'consumptionUnit'];
  const touches = (fields) => fields.some((f) => changed.has(f));
  const link = { buyerName: job.buyerName, styleNo: job.styleNo, poNo: job.poNo };

  // keep denormalised identifiers in sync everywhere
  if (touches(['styleNo', 'poNo', 'buyer'])) {
    for (const def of Object.values(MODULES).filter((m) => m.jobLinked)) {
      await models[def.key].updateMany({ job: job._id }, { $set: link });
    }
    impact.push({ module: 'All linked modules', action: 'Style / PO / Buyer references updated' });
  }

  const resync = async (key, fields, earlyStatuses) => {
    if (!touches(fields)) return;
    const def = MODULES[key];
    const recs = await models[key].find({ job: job._id, isDeleted: false });
    for (const r of recs) {
      if (earlyStatuses.includes(r.status)) {
        const before = r.toObject();
        const patch = def.prefill(job);
        const next = applyCompute(def, { ...before, ...patch });
        def.fields.filter((f) => f.readOnly || patch[f.name] !== undefined).forEach((f) => { r.set(f.name, next[f.name]); });
        r.updatedBy = req.user._id;
        await r.save();
        impact.push({ module: def.title, refNo: r.refNo, action: 'Recalculated automatically' });
      } else {
        impact.push({ module: def.title, refNo: r.refNo, action: `Review required (status: ${r.status})`, warning: true });
        await notify({
          type: 'INFO', severity: 'warning', title: `Order change impacts ${def.title} ${r.refNo}`,
          message: `${job.jobNo}: ${[...changed].join(', ')} changed after ${def.singular} reached "${r.status}". Please review.`,
          departments: [def.department], job, module: key, recordId: r._id, link: `/m/${key}?job=${job.jobNo}`,
        });
      }
    }
  };
  await resync('fabricBooking', fabricFields, ['Required', 'Booked']);
  await resync('trimBooking', ['orderQty'], ['Required', 'Booked']);
  await resync('productionPlan', ['orderQty'], ['Draft']);
  await resync('ppMeeting', ['orderQty'], ['Scheduled']);

  if (touches(['shipmentDate'])) {
    const tna = await models.tna.findOne({ job: job._id, isDeleted: false });
    if (tna) {
      tna.shipmentDate = job.shipmentDate;
      const ship = tna.activities.find((a) => a.activity === 'Shipment');
      if (ship && !ship.actualDate) ship.plannedDate = job.shipmentDate;
      const next = applyCompute(MODULES.tna, tna.toObject());
      tna.set({ activities: next.activities, delayedCount: next.delayedCount, completionPct: next.completionPct });
      await tna.save();
      impact.push({ module: 'T&A', refNo: tna.refNo, action: 'Shipment milestone moved – check other activities', warning: true });
    }
  }
  return impact;
}
