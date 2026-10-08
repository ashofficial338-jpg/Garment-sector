/**
 * Management analytics – every figure is calculated here from database records (never in the browser):
 *
 *   Finance    Revenue (issued invoices in the period) → COGS (invoiced qty × the job's cost of goods per piece)
 *              → operating expenses → EBITDA → interest, taxes, depreciation, amortization → Net profit
 *   Inventory  value at any date by category (stock ledger, yarn / grey chain, WIP and finished goods from dated
 *              production entries) → opening / closing / average → ITR = COGS ÷ average inventory,
 *              holding days = closing inventory ÷ daily consumption
 *   ROI        jobs invoiced in the period grouped by product / style / buyer / job / PO / colour / order / unit
 *   Variance   estimated (costing) vs actual cost per garment cost head, per job, quality / rejection loss
 *   Operations fabric, production and shipment performance per job
 *
 * All queries run in the request's unit scope (one unit, or both units consolidated – see unitContext.js),
 * and every row carries its Job No so it can be traced back to source transactions.
 */
import { models } from '../modules/builder.js';
import { StockMovement } from '../models/StockMovement.js';
import { loadJobGraphs, computeProfit } from './lifecycle.js';
import { getSetting } from './settings.js';
import { COST_HEADS, FINANCE_LINES, INVENTORY_CATEGORIES, headOfExpense, financeLineOf } from '../../../shared/costHeads.js';
import { num, round, sum, pct } from '../../../shared/calc.js';
import { ApiError } from '../utils/ApiError.js';

const DAY = 86400000;
const r2 = (v) => round(v, 2);
const ratio = (a, b, d = 2) => (num(b) > 0 ? round(num(a) / num(b), d) : null); // null = not computable (no division by zero)
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const asDay = (v, end) => {
  const s = String(v || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw ApiError.badRequest(`Invalid date ${v}`);
  return new Date(`${s}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
};

/** Reporting period from ?from=&to= (YYYY-MM-DD). Default: the last 12 months up to today. */
export function reportingPeriod(q = {}) {
  const to = asDay(q.to || isoDay(Date.now()), true);
  const from = q.from ? asDay(q.from) : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 11, 1));
  if (from > to) throw ApiError.badRequest('From date is after To date');
  return { from, to, openingAt: new Date(from.getTime() - 1), days: Math.round((to.getTime() + 1 - from.getTime()) / DAY), label: `${isoDay(from)} → ${isoDay(to)}` };
}

const inPeriod = (d, p) => d && new Date(d) >= p.from && new Date(d) <= p.to;
const upTo = (d, at) => d && new Date(d) <= at;
const jobRef = (j) => ({ job: j._id, jobNo: j.jobNo, buyerName: j.buyerName, styleNo: j.styleNo, poNo: j.poNo, businessUnit: j.businessUnit });

/**
 * Per-request context: reporting period, leaf jobs (forecast main jobs are carried by their sub jobs),
 * their record graphs and profit – loaded once and shared by every calculation.
 */
export async function analyticsContext(q) {
  const period = reportingPeriod(q);
  const all = await models.orders.find({ isDeleted: false }).lean();
  const jobs = all.filter((j) => !(j.isForecast && num(j.subJobCount) > 0));
  const graphs = await loadJobGraphs(jobs);
  const byJob = new Map(graphs.map((g) => [String(g.job._id), { g, p: computeProfit(g) }]));
  const company = await getSetting('company');
  return { q, period, jobs, byJob, currency: company.baseCurrency || 'USD', memo: {} };
}

const memo = (ctx, key, fn) => (ctx.memo[key] ||= fn());

/* ================================ Finance: Revenue → COGS → EBITDA → Net profit ================================ */
export function finance(ctx) {
  return memo(ctx, 'finance', async () => {
    const { period } = ctx;
    const invoices = await models.invoice.find({ isDeleted: false, status: { $nin: ['Draft', 'Cancelled'] }, invoiceDate: { $gte: period.from, $lte: period.to } }).lean();
    const sales = invoices.map((inv) => {
      const x = ctx.byJob.get(String(inv.job));
      const perPc = x ? (x.p.cogsPerPc || x.p.estimatedCogsPerPc) : 0;
      return {
        _id: inv._id, invoiceNo: inv.invoiceNo, invoiceDate: inv.invoiceDate, ...jobRef(x?.g.job || inv), currency: inv.currency,
        qty: num(inv.qty), revenue: r2(inv.totalAmount), cogsPerPc: round(perPc, 4), cogs: r2(num(inv.qty) * perPc),
        cogsBasis: x ? (x.p.cogsPerPc ? 'actual job cost' : 'costed estimate') : 'no job cost',
      };
    });
    const expenses = await models.expense.find({ isDeleted: false, status: { $ne: 'Rejected' }, expenseDate: { $gte: period.from, $lte: period.to } }).lean();
    const lines = { opex: [], absorbed: [], ...Object.fromEntries(FINANCE_LINES.map((l) => [l.key, []])) };
    expenses.forEach((e) => {
      const row = { _id: e._id, refNo: e.refNo, date: e.expenseDate, category: e.category, description: e.description, amount: r2(e.amount), jobNo: e.jobNo || '', job: e.job, businessUnit: e.businessUnit };
      const fin = financeLineOf(e.category);
      const head = headOfExpense(e.category);
      if (fin) lines[fin.key].push(row);
      else if (head?.cogs && e.job) lines.absorbed.push({ ...row, note: 'In job cost of goods (COGS when invoiced)' });
      else lines.opex.push({ ...row, note: head?.cogs ? 'Production cost not linked to a job' : `${head?.label || 'Other'} – operating expense` });
    });
    const revenue = r2(sum(sales, 'revenue'));
    const cogs = r2(sum(sales, 'cogs'));
    const opex = r2(sum(lines.opex, 'amount'));
    const fin = Object.fromEntries(FINANCE_LINES.map((l) => [l.key, r2(sum(lines[l.key], 'amount'))]));
    const ebitda = r2(revenue - cogs - opex);
    const netProfit = r2(ebitda - fin.interest - fin.taxes - fin.depreciation - fin.amortization);
    const currencies = [...new Set([...invoices.map((i) => i.currency), ...expenses.map((e) => e.currency)].filter(Boolean))];
    return {
      period: period.label, currency: ctx.currency, currencies,
      revenue, cogs, grossProfit: r2(revenue - cogs), grossMarginPct: pct(revenue - cogs, revenue),
      operatingExpenses: opex, ebitda, ebitdaMarginPct: pct(ebitda, revenue), ...fin, netProfit, netMarginPct: pct(netProfit, revenue),
      // EBITDA = Net Profit + Interest + Taxes + Depreciation + Amortization (identical by construction)
      ebitdaCheck: r2(netProfit + fin.interest + fin.taxes + fin.depreciation + fin.amortization),
      sources: { sales, ...lines },
    };
  });
}

/* ================================ Inventory valuation at a date ================================ */
/** Per-piece cost of a job at each production stage (WIP / finished goods valuation). */
function stageCosts({ g, p }) {
  const est = Object.fromEntries(p.heads.map((h) => [h.key, h.estimatedPerPc]));
  const of = (stage) => COST_HEADS.filter((h) => h.cogs && h.stage === stage).reduce((t, h) => t + num(est[h.key]), 0);
  const material = of('material') || num(g.boms?.[0]?.materialCostPerPc);
  const cut = material + of('cut');
  const sew = cut + of('sew');
  const fg = num(p.cogsPerPc) || sew + of('finish');
  return { material, cut, sew, fg };
}

async function chainInventory() {
  const live = { isDeleted: false, status: { $nin: ['Rejected', 'Cancelled'] } };
  const [yarn, knit, proc] = await Promise.all([models.yarnReceipt.find(live).lean(), models.knitting.find(live).lean(), models.fabricProcess.find(live).lean()]);
  const yarnRate = ratio(sum(yarn, 'amount'), sum(yarn.filter((y) => num(y.ratePerKg)), 'qtyKg'), 4) || 0;
  const greyRate = yarnRate + (ratio(sum(knit, 'amount'), sum(knit, 'greyReceivedKg'), 4) || 0);
  return {
    yarnRate, greyRate,
    at(at) {
      const yarnKg = sum(yarn.filter((y) => upTo(y.receiptDate, at)), 'qtyKg') - sum(knit.filter((k) => upTo(k.programDate, at)), 'yarnIssuedKg');
      const greyKg = sum(knit.filter((k) => upTo(k.programDate, at)), 'greyReceivedKg') - sum(proc.filter((x) => x.inputStage === 'Grey Fabric' && upTo(x.processDate, at)), 'issuedKg');
      const inProcKg = sum(proc.filter((x) => x.outputStage === 'In-process Fabric' && upTo(x.processDate, at)), 'receivedKg') - sum(proc.filter((x) => x.inputStage === 'In-process Fabric' && upTo(x.processDate, at)), 'issuedKg');
      return { yarnKg: r2(yarnKg), greyKg: r2(greyKg + inProcKg), value: r2(yarnKg * yarnRate + (greyKg + inProcKg) * greyRate) };
    },
    // finished fabric leaving the chain for the fabric store in the period
    consumed: (p) => r2(sum(proc.filter((x) => x.outputStage === 'Finished Fabric' && inPeriod(x.processDate, p)), 'issuedKg') * greyRate),
  };
}

function jobStock(x, at) {
  const { g } = x;
  const ok = (r) => r.status !== 'Rejected';
  const cut = sum(g.cutting.filter((r) => ok(r) && upTo(r.entryDate, at)), 'cutQty');
  const sewn = sum(g.sewing.filter((r) => ok(r) && upTo(r.entryDate, at)), 'actualQty');
  const finIn = sum(g.finishing.filter((r) => ok(r) && upTo(r.entryDate, at)), 'inputQty');
  const finPass = sum(g.finishing.filter((r) => ok(r) && upTo(r.entryDate, at)), 'passedQty');
  const shipped = sum(g.shipments.filter((s) => ['Shipped', 'Delivered'].includes(s.status) && upTo(s.actualShipDate || s.shipmentDate, at)), 'qty');
  const c = stageCosts(x);
  const wipCut = Math.max(cut - sewn, 0); const wipSew = Math.max(sewn - finIn, 0); const fg = Math.max(finPass - shipped, 0);
  return { ...jobRef(g.job), wipCut, wipSew, wipValue: r2(wipCut * c.cut + wipSew * c.sew), fgQty: fg, fgValue: r2(fg * c.fg), cutCostPc: round(c.cut, 4), sewCostPc: round(c.sew, 4), fgCostPc: round(c.fg, 4) };
}

/** Inventory value by category at a point in time, with the rows behind each figure. */
export async function inventoryAt(ctx, at, movements, chain) {
  const ledger = movements.filter((m) => upTo(m.date, at));
  const byRecord = new Map();
  ledger.forEach((m) => {
    const k = String(m.recordId);
    const r = byRecord.get(k) || byRecord.set(k, { module: m.module, recordId: m.recordId, refNo: m.refNo, jobNo: m.jobNo, item: m.item, category: m.category, unit: m.unit, rate: m.rate, qty: 0, value: 0 }).get(k);
    r.qty += (m.direction === 'in' ? 1 : -1) * num(m.qty); r.value += (m.direction === 'in' ? 1 : -1) * num(m.value);
  });
  const materials = [...byRecord.values()].map((r) => ({ ...r, qty: r2(r.qty), value: r2(r.value) })).filter((r) => r.qty || r.value);
  const jobs = [...ctx.byJob.values()].map((x) => jobStock(x, at)).filter((j) => j.wipValue || j.fgValue);
  const yarn = chain.at(at);
  const categories = {
    'Yarn & Grey Fabric': yarn.value,
    ...Object.fromEntries(['Fabric', 'Trims', 'Accessories', 'Packing Materials'].map((c) => [c, r2(sum(materials.filter((m) => m.category === c), 'value'))])),
    'Work-in-Progress': r2(sum(jobs, 'wipValue')),
    'Finished Goods': r2(sum(jobs, 'fgValue')),
  };
  return { at: isoDay(at), total: r2(Object.values(categories).reduce((a, b) => a + b, 0)), categories, materials, jobs, yarn };
}

/** Opening / closing / average inventory, ITR and holding days – per category and overall. */
export function inventory(ctx) {
  return memo(ctx, 'inventory', async () => {
    const { period } = ctx;
    const [movements, chain, fin] = await Promise.all([StockMovement.find({ date: { $lte: period.to } }).sort({ date: 1 }).lean(), chainInventory(), finance(ctx)]);
    const [opening, closing] = await Promise.all([inventoryAt(ctx, period.openingAt, movements, chain), inventoryAt(ctx, period.to, movements, chain)]);
    const outIn = (cat) => r2(sum(movements.filter((m) => m.category === cat && m.direction === 'out' && inPeriod(m.date, period)), 'value'));
    // goods completed in the period, at finished-goods cost (consumption basis for WIP)
    const completed = r2(sum([...ctx.byJob.values()].map((x) => sum(x.g.finishing.filter((r) => r.status !== 'Rejected' && inPeriod(r.entryDate, period)), 'passedQty') * stageCosts(x).fg)));
    const basis = {
      'Yarn & Grey Fabric': [chain.consumed(period), 'Yarn / grey issued for finished fabric'],
      Fabric: [outIn('Fabric'), 'Fabric issued to cutting'],
      Trims: [outIn('Trims'), 'Trims issued to production'],
      Accessories: [outIn('Accessories'), 'Accessories issued to production'],
      'Packing Materials': [outIn('Packing Materials'), 'Packing materials issued'],
      'Work-in-Progress': [completed, 'Cost of goods completed (finishing passed)'],
      'Finished Goods': [fin.cogs, 'COGS (invoiced goods)'],
    };
    const row = (category, open, close, [consumption, basisLabel]) => {
      const average = r2((open + close) / 2);
      const daily = consumption > 0 ? consumption / period.days : 0;
      return {
        category, opening: r2(open), closing: r2(close), average, consumption: r2(consumption), basis: basisLabel,
        itr: ratio(consumption, average), dailyConsumption: r2(daily), holdingDays: daily > 0 ? Math.round(close / daily) : null,
      };
    };
    const categories = INVENTORY_CATEGORIES.map((c) => row(c, opening.categories[c], closing.categories[c], basis[c]));
    const overall = row('Total inventory', opening.total, closing.total, [fin.cogs, 'COGS (invoiced goods)']);
    return {
      period: period.label, days: period.days, currency: ctx.currency, cogs: fin.cogs,
      ...overall, categories,
      holdingDaysByType: {
        fabric: categories.find((c) => c.category === 'Fabric').holdingDays,
        trims: holdingOf(categories, ['Trims', 'Accessories', 'Packing Materials']),
        wip: categories.find((c) => c.category === 'Work-in-Progress').holdingDays,
        finishedGoods: categories.find((c) => c.category === 'Finished Goods').holdingDays,
        overall: overall.holdingDays,
      },
      openingDetail: opening, closingDetail: closing,
      movements: movements.filter((m) => inPeriod(m.date, period)).map((m) => ({ ...m, date: isoDay(m.date) })),
    };
  });
}
function holdingOf(rows, cats) {
  const sel = rows.filter((r) => cats.includes(r.category));
  const daily = sum(sel, 'dailyConsumption');
  return daily > 0 ? Math.round(sum(sel, 'closing') / daily) : null;
}

/* ================================ Product / Style ROI ================================ */
export const ROI_DIMENSIONS = {
  product: ['Product / Garment', (j) => j.product || j.garmentType || '—'],
  style: ['Style', (j) => j.styleNo || '—'],
  buyer: ['Buyer', (j) => j.buyerName || '—'],
  job: ['Job No', (j) => j.jobNo],
  po: ['PO', (j) => j.poNo || '—'],
  order: ['Order No', (j) => j.orderNo || j.jobNo],
  color: ['Colour', null],
  unit: ['Unit', (j) => j.businessUnit || '—'],
};

/** Colour shares of a job: colour/size breakdown, else the colour list, else the fabric colour. */
function colorShares(j) {
  const bd = (j.sizeBreakdown || []).filter((r) => r.color && num(r.qty) > 0);
  if (bd.length) {
    const tot = sum(bd, 'qty');
    const m = {}; bd.forEach((r) => { m[r.color] = (m[r.color] || 0) + num(r.qty) / tot; });
    return Object.entries(m);
  }
  const list = (j.colors || []).filter(Boolean);
  if (list.length) return list.map((c) => [c, 1 / list.length]);
  return [[j.fabricColor || '—', 1]];
}

export function roi(ctx, by = 'style') {
  return memo(ctx, `roi-${by}`, async () => {
    const dim = ROI_DIMENSIONS[by];
    if (!dim) throw ApiError.badRequest(`Unknown ROI dimension ${by}`);
    const fin = await finance(ctx);
    const invoicedJobs = new Set(fin.sources.sales.map((s) => String(s.job)));
    const jobs = [...ctx.byJob.values()].filter((x) => invoicedJobs.has(String(x.g.job._id)) && x.g.job.status !== 'Cancelled');
    const groups = new Map();
    const add = (key, x, share) => {
      const gr = groups.get(key) || groups.set(key, { key, revenue: 0, cost: 0, profit: 0, shippedQty: 0, orderQty: 0, jobs: [] }).get(key);
      gr.revenue += x.p.revenue * share; gr.cost += x.p.totalExpenses * share; gr.profit += x.p.actualProfit * share;
      gr.shippedQty += x.p.shippedQty * share; gr.orderQty += num(x.g.job.orderQty) * share;
      gr.jobs.push({ ...jobRef(x.g.job), share: round(share, 4), revenue: r2(x.p.revenue * share), cost: r2(x.p.totalExpenses * share), profit: r2(x.p.actualProfit * share), roiPct: x.p.roiPct });
    };
    jobs.forEach((x) => (by === 'color' ? colorShares(x.g.job).forEach(([c, s]) => add(c, x, s)) : add(dim[1](x.g.job), x, 1)));
    const rows = [...groups.values()].map((gr) => ({
      ...gr, revenue: r2(gr.revenue), cost: r2(gr.cost), profit: r2(gr.profit), shippedQty: Math.round(gr.shippedQty), orderQty: Math.round(gr.orderQty),
      roiPct: gr.cost > 0 ? r2((gr.profit / gr.cost) * 100) : null, marginPct: pct(gr.profit, gr.revenue),
    })).sort((a, b) => (b.roiPct ?? -Infinity) - (a.roiPct ?? -Infinity));
    const tot = { revenue: r2(sum(rows, 'revenue')), cost: r2(sum(rows, 'cost')), profit: r2(sum(rows, 'profit')) };
    return { by, label: dim[0], period: fin.period, currency: ctx.currency, ...tot, roiPct: tot.cost > 0 ? r2((tot.profit / tot.cost) * 100) : null, marginPct: pct(tot.profit, tot.revenue), rows };
  });
}

/* ================================ Cost variance & job profitability ================================ */
/** Jobs active in the period: ordered by its end and not closed before it started. */
const activeJobs = (ctx) => [...ctx.byJob.values()].filter(({ g: { job } }) => job.status !== 'Cancelled'
  && (!job.orderDate || new Date(job.orderDate) <= ctx.period.to) && !(job.status === 'Closed' && job.closedAt && new Date(job.closedAt) < ctx.period.from));

export function variance(ctx) {
  return memo(ctx, 'variance', async () => {
    const list = activeJobs(ctx);
    const heads = COST_HEADS.map((h) => {
      const est = r2(sum(list, (x) => x.p.heads.find((y) => y.key === h.key).estimated));
      const act = r2(sum(list, (x) => x.p.heads.find((y) => y.key === h.key).actual));
      return { key: h.key, label: h.label, estimated: est, actual: act, variance: r2(act - est), variancePct: est ? pct(act - est, est) : null };
    });
    const jobs = list.map(({ g, p }) => {
      const rejected = sum(g.sewing, 'rejection') + sum(g.finishing, 'rejection');
      const perPc = p.cogsPerPc || p.estimatedCogsPerPc;
      return {
        ...jobRef(g.job), orderQty: num(g.job.orderQty), shippedQty: p.shippedQty, salesValue: p.revenue,
        estimatedCost: p.expectedCost, actualCost: p.totalExpenses, costVariance: r2(p.totalExpenses - p.expectedCost),
        estimatedProfit: p.expectedProfit, actualProfit: p.actualProfit, profitVariance: p.profitVariance, roiPct: p.roiPct,
        rejectedQty: rejected, reworkQty: sum(g.finishing, 'rework') + sum(g.finishing, 'alteration') + sum(g.sewing, 'alteration'),
        rejectionLoss: r2(rejected * perPc), status: g.job.status,
        heads: p.heads.map(({ key, estimated, actual, variance: v, basis }) => ({ key, estimated, actual, variance: v, basis })),
      };
    });
    return {
      period: ctx.period.label, currency: ctx.currency, heads, jobs,
      estimated: r2(sum(heads, 'estimated')), actual: r2(sum(heads, 'actual')), variance: r2(sum(heads, 'variance')),
      qualityLoss: { rejectedQty: sum(jobs, 'rejectedQty'), reworkQty: sum(jobs, 'reworkQty'), value: r2(sum(jobs, 'rejectionLoss')) },
    };
  });
}

/* ================================ Fabric / production / shipment performance ================================ */
export function operations(ctx) {
  return memo(ctx, 'operations', async () => {
    const today = new Date();
    const rows = activeJobs(ctx).map(({ g, p }) => {
      const job = g.job;
      const ok = (r) => r.status !== 'Rejected';
      const cut = sum(g.cutting.filter(ok), 'cutQty'); const sewn = sum(g.sewing.filter(ok), 'actualQty');
      const finished = sum(g.finishing.filter(ok), 'passedQty'); const packed = sum(g.packing, 'totalQty');
      const planned = sum(g.plans, 'productionQty') || num(job.orderQty);
      const earned = sum(g.sewing.filter(ok), (s) => num(s.actualQty) * num(s.sam)); const avail = sum(g.sewing.filter(ok), (s) => num(s.operators) * num(s.workingMinutes));
      const planEnd = g.plans.map((x) => x.plannedEnd).filter(Boolean).sort().pop();
      const shipped = g.shipments.filter((s) => ['Shipped', 'Delivered'].includes(s.status));
      const shippedQty = sum(shipped, 'qty');
      const lastShip = shipped.map((s) => s.actualShipDate || s.shipmentDate).filter(Boolean).sort().pop();
      const shipDelay = job.shipmentDate ? Math.round(((lastShip ? new Date(lastShip) : (shippedQty < num(job.orderQty) ? today : new Date(job.shipmentDate))) - new Date(job.shipmentDate)) / DAY) : 0;
      const fabricHead = p.heads.find((h) => h.key === 'fabric');
      return {
        ...jobRef(job), orderQty: num(job.orderQty), unit: g.fabric[0]?.unit || '',
        fabric: {
          booked: r2(sum(g.fabric, 'bookedQty')), received: r2(sum(g.fabric, 'receivedQty')), issued: r2(sum(g.fabric, 'issuedQty')), consumed: r2(sum(g.fabric, 'usedQty')),
          balance: r2(sum(g.fabric, 'balanceQty')), wastage: r2(sum(g.cutting, (c) => Math.max(num(c.fabricIssued) - num(c.fabricUsed), 0))),
          shortage: r2(sum(g.fabric, 'shortageQty')), excess: r2(sum(g.fabric, 'excessQty')), costVariance: fabricHead.variance,
        },
        production: {
          planned, cut, produced: sewn, finished, achievementPct: pct(sewn, planned, 1), efficiencyPct: avail ? r2((earned / avail) * 100) : 0,
          wip: Math.max(cut - sewn, 0), rejection: sum(g.sewing, 'rejection') + sum(g.finishing, 'rejection'), rework: sum(g.finishing, 'rework') + sum(g.finishing, 'alteration'),
          delayDays: planEnd && sewn < planned && new Date(planEnd) < today ? Math.round((today - new Date(planEnd)) / DAY) : 0,
        },
        shipment: {
          packed, inspected: sum(g.inspections.filter((i) => ['Passed', 'Final Approved'].includes(i.status)), 'lotSize'), shipped: shippedQty,
          balance: Math.max(num(job.orderQty) - shippedQty, 0), onTime: shippedQty > 0 ? shipDelay <= 0 : null,
          delayDays: Math.max(shipDelay, 0), shipDate: job.shipmentDate, value: r2(shippedQty * num(job.unitPrice)),
        },
      };
    });
    const lines = {};
    activeJobs(ctx).forEach(({ g }) => g.sewing.filter((s) => s.status !== 'Rejected').forEach((s) => {
      const l = (lines[s.line || '—'] ||= { line: s.line || '—', earned: 0, avail: 0, output: 0, target: 0 });
      l.earned += num(s.actualQty) * num(s.sam); l.avail += num(s.operators) * num(s.workingMinutes); l.output += num(s.actualQty); l.target += num(s.targetQty);
    }));
    const shippedJobs = rows.filter((r) => r.shipment.onTime !== null);
    const S = (f) => sum(rows, f);
    return {
      period: ctx.period.label, rows,
      fabric: Object.fromEntries(['booked', 'received', 'issued', 'consumed', 'balance', 'wastage', 'shortage', 'excess', 'costVariance'].map((k) => [k, r2(S((r) => r.fabric[k]))])),
      production: { planned: S((r) => r.production.planned), produced: S((r) => r.production.produced), achievementPct: pct(S((r) => r.production.produced), S((r) => r.production.planned), 1), wip: S((r) => r.production.wip), rejection: S((r) => r.production.rejection), rework: S((r) => r.production.rework), delayedJobs: rows.filter((r) => r.production.delayDays > 0).length },
      shipment: { orderQty: S('orderQty'), packed: S((r) => r.shipment.packed), inspected: S((r) => r.shipment.inspected), shipped: S((r) => r.shipment.shipped), balance: S((r) => r.shipment.balance), value: r2(S((r) => r.shipment.value)), onTimePct: shippedJobs.length ? pct(shippedJobs.filter((r) => r.shipment.onTime).length, shippedJobs.length, 1) : null, delayedJobs: rows.filter((r) => r.shipment.delayDays > 0).length },
      lines: Object.values(lines).map((l) => ({ line: l.line, output: l.output, target: l.target, efficiencyPct: l.avail ? r2((l.earned / l.avail) * 100) : 0 })).sort((a, b) => String(a.line).localeCompare(String(b.line))),
    };
  });
}

/** Headline figures for the dashboard (each one drills down to its analytics section). */
export async function summary(ctx) {
  const [fin, inv, styleRoi, productRoi, vari] = await Promise.all([finance(ctx), inventory(ctx), roi(ctx, 'style'), roi(ctx, 'product'), variance(ctx)]);
  const strip = ({ openingDetail, closingDetail, movements, categories, ...rest }) => ({ ...rest, categories: categories.map(({ category, itr, holdingDays, closing: c }) => ({ category, itr, holdingDays, closing: c })) });
  return {
    period: fin.period, currency: ctx.currency, currencies: fin.currencies,
    finance: { revenue: fin.revenue, cogs: fin.cogs, grossProfit: fin.grossProfit, operatingExpenses: fin.operatingExpenses, ebitda: fin.ebitda, ebitdaMarginPct: fin.ebitdaMarginPct, netProfit: fin.netProfit, netMarginPct: fin.netMarginPct },
    inventory: strip(inv),
    roi: { roiPct: styleRoi.roiPct, profit: styleRoi.profit, cost: styleRoi.cost, topStyle: styleRoi.rows[0] || null, topProduct: productRoi.rows[0] || null, styles: styleRoi.rows.length },
    variance: { estimated: vari.estimated, actual: vari.actual, variance: vari.variance, qualityLoss: vari.qualityLoss.value },
  };
}
