/**
 * Financial report pack – revenue, expenses, purchases, profit, cash, tax, inventory and outstanding balances
 * for a period, broken down by day / week / month / quarter / year and compared with the previous period.
 *
 * Revenue, COGS, operating expenses and the finance lines come from finance() (services/analytics.js), so the
 * figures here always equal the Management Analytics page; period buckets add up to the period totals.
 *   Expenses   = COGS + operating expenses + interest + taxes + depreciation + amortization
 *   Net profit = Revenue − Expenses
 *   Purchases  = supplier bills dated in the period (fabric, trims, services) – a cash / payables view,
 *                not added to expenses again (materials reach the P&L through COGS when goods are invoiced)
 */
import { models } from '../modules/builder.js';
import { finance, inventory, reportingPeriod } from './analytics.js';
import { FINANCE_LINES } from '../../../shared/costHeads.js';
import { num, round, sum, pct } from '../../../shared/calc.js';
import { ApiError } from '../utils/ApiError.js';

const DAY = 86400000;
const r2 = (v) => round(v, 2);
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const inPeriod = (d, p) => d && new Date(d) >= p.from && new Date(d) <= p.to;

export const GRAINS = { day: 'Daily', week: 'Weekly', month: 'Monthly', quarter: 'Quarterly', year: 'Yearly' };
const MAX_BUCKETS = 400;

/** Bucket key and label of a date for a grain (weeks start on Monday, UTC). */
function bucketOf(d, grain) {
  const t = new Date(d);
  const y = t.getUTCFullYear(); const m = t.getUTCMonth();
  if (grain === 'day') return isoDay(t);
  if (grain === 'week') { const mon = new Date(Date.UTC(y, m, t.getUTCDate() - ((t.getUTCDay() + 6) % 7))); return `W ${isoDay(mon)}`; }
  if (grain === 'month') return `${y}-${String(m + 1).padStart(2, '0')}`;
  if (grain === 'quarter') return `${y}-Q${Math.floor(m / 3) + 1}`;
  return String(y);
}
/** Every bucket of the period in order, so empty days / weeks / months still show as zero. */
function bucketKeys(period, grain) {
  const keys = [];
  const step = (grain === 'week' ? 7 : 1) * DAY;
  for (let t = period.from.getTime(); t <= period.to.getTime(); t += step) {
    const k = bucketOf(t, grain);
    if (keys[keys.length - 1] !== k) keys.push(k);
    if (keys.length > MAX_BUCKETS) throw ApiError.badRequest(`Too many ${GRAINS[grain].toLowerCase()} periods – choose a shorter date range or a larger grouping`);
  }
  const last = bucketOf(period.to, grain);
  if (keys[keys.length - 1] !== last) keys.push(last);
  return keys;
}

/** The same-length period immediately before the reporting period. */
function previousPeriod(p) {
  const len = p.to.getTime() + 1 - p.from.getTime();
  return reportingPeriod({ from: isoDay(p.from.getTime() - len), to: isoDay(p.from.getTime() - 1) });
}

const expensesOf = (f) => r2(f.cogs + f.operatingExpenses + sum(FINANCE_LINES, (l) => num(f[l.key])));
function headline(f, purchases) {
  const expenses = expensesOf(f);
  return { revenue: f.revenue, cogs: f.cogs, operatingExpenses: f.operatingExpenses, expenses, purchases: r2(purchases), grossProfit: f.grossProfit, netProfit: f.netProfit, netMarginPct: f.netMarginPct, grossMarginPct: f.grossMarginPct };
}
const change = (cur, prev) => ({ abs: r2(cur - prev), pct: prev ? round(((cur - prev) / Math.abs(prev)) * 100, 1) : null });

/** Days past due → aging bucket. */
function aging(due, at) {
  if (!due) return 'No due date';
  const days = Math.floor((at.getTime() - new Date(due).getTime()) / DAY);
  if (days <= 0) return 'Not due';
  if (days <= 30) return '1–30 days';
  if (days <= 60) return '31–60 days';
  if (days <= 90) return '61–90 days';
  return '90+ days';
}
const AGING = ['Not due', '1–30 days', '31–60 days', '61–90 days', '90+ days', 'No due date'];

/** Group sales rows by a key into revenue / COGS / gross profit, best first. */
function groupSales(sales, keyOf, labelOf = keyOf) {
  const m = new Map();
  sales.forEach((s) => {
    const k = keyOf(s) || '—';
    const g = m.get(k) || { key: k, label: labelOf(s) || '—', qty: 0, revenue: 0, cogs: 0, invoices: 0 };
    g.qty += s.qty; g.revenue += s.revenue; g.cogs += s.cogs; g.invoices += 1;
    m.set(k, g);
  });
  return [...m.values()].map((g) => ({ ...g, qty: r2(g.qty), revenue: r2(g.revenue), cogs: r2(g.cogs), grossProfit: r2(g.revenue - g.cogs), marginPct: pct(g.revenue - g.cogs, g.revenue) }))
    .sort((a, b) => b.revenue - a.revenue);
}

export async function financialReport(ctx, grain = 'month') {
  if (!GRAINS[grain]) throw ApiError.badRequest(`Unknown grouping ${grain}`);
  const { period } = ctx;
  const keys = bucketKeys(period, grain);
  const prevPeriod = previousPeriod(period);
  // finance() reads only the period, jobs and currency from the context – the previous period reuses the loaded jobs
  const [fin, prevFin, inv, bills, payments, allInvoices] = await Promise.all([
    finance(ctx), finance({ ...ctx, period: prevPeriod, memo: {} }), inventory(ctx),
    models.supplierBill.find({ isDeleted: false, status: { $nin: ['Cancelled', 'Rejected'] } }).lean(),
    models.payment.find({ isDeleted: false, paymentDate: { $gte: period.from, $lte: period.to } }).lean(),
    models.invoice.find({ isDeleted: false, status: { $nin: ['Draft', 'Cancelled'] } }).lean(),
  ]);
  const jobOf = (id) => ctx.byJob.get(String(id))?.g.job;

  /* ---------- period series ---------- */
  const series = new Map(keys.map((k) => [k, { period: k, revenue: 0, cogs: 0, operatingExpenses: 0, financeCosts: 0, purchases: 0, receipts: 0, supplierPayments: 0 }]));
  const put = (d, field, v) => { const b = series.get(bucketOf(d, grain)); if (b) b[field] += num(v); };
  fin.sources.sales.forEach((s) => { put(s.invoiceDate, 'revenue', s.revenue); put(s.invoiceDate, 'cogs', s.cogs); });
  fin.sources.opex.forEach((e) => put(e.date, 'operatingExpenses', e.amount));
  FINANCE_LINES.forEach((l) => fin.sources[l.key].forEach((e) => put(e.date, 'financeCosts', e.amount)));
  const periodBills = bills.filter((b) => inPeriod(b.billDate, period));
  periodBills.forEach((b) => put(b.billDate, 'purchases', b.totalAmount));
  payments.forEach((p) => put(p.paymentDate, 'receipts', p.amount));
  const supplierPaid = bills.flatMap((b) => (b.payments || []).filter((p) => inPeriod(p.date, period)).map((p) => ({ ...p, bill: b })));
  supplierPaid.forEach((p) => put(p.date, 'supplierPayments', p.amount));
  let cumulative = 0;
  const rows = [...series.values()].map((b) => {
    const expenses = b.cogs + b.operatingExpenses + b.financeCosts;
    const netProfit = b.revenue - expenses;
    cumulative += netProfit;
    return {
      period: b.period, revenue: r2(b.revenue), cogs: r2(b.cogs), operatingExpenses: r2(b.operatingExpenses), financeCosts: r2(b.financeCosts),
      expenses: r2(expenses), grossProfit: r2(b.revenue - b.cogs), netProfit: r2(netProfit), netMarginPct: pct(netProfit, b.revenue), cumulativeProfit: r2(cumulative),
      purchases: r2(b.purchases), receipts: r2(b.receipts), supplierPayments: r2(b.supplierPayments), netCashFlow: r2(b.receipts - b.supplierPayments),
    };
  });

  /* ---------- headline with previous-period comparison ---------- */
  const prevBills = bills.filter((b) => inPeriod(b.billDate, prevPeriod));
  const current = headline(fin, sum(periodBills, 'totalAmount'));
  const previous = headline(prevFin, sum(prevBills, 'totalAmount'));
  const comparison = Object.fromEntries(Object.keys(current).map((k) => [k, change(current[k], previous[k])]));

  /* ---------- styles / garment types / buyers (what the factory sells) ---------- */
  const sales = fin.sources.sales.map((s) => ({ ...s, garmentType: jobOf(s.job)?.garmentType, product: jobOf(s.job)?.product }));
  const performance = {
    styles: groupSales(sales, (s) => s.styleNo, (s) => [s.styleNo, s.product].filter(Boolean).join(' – ')),
    garmentTypes: groupSales(sales, (s) => s.garmentType),
    buyers: groupSales(sales, (s) => s.buyerName),
  };

  /* ---------- expenses by category ---------- */
  const expenseRows = [
    ...fin.sources.opex.map((e) => ({ ...e, line: 'Operating expense' })),
    ...FINANCE_LINES.flatMap((l) => fin.sources[l.key].map((e) => ({ ...e, line: l.label }))),
    ...fin.sources.absorbed.map((e) => ({ ...e, line: 'Job cost (in COGS when invoiced)' })),
  ].map((e) => ({ refNo: e.refNo, date: isoDay(e.date), line: e.line, category: e.category, description: e.description, jobNo: e.jobNo || '', businessUnit: e.businessUnit, amount: e.amount }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const byCategory = new Map();
  expenseRows.filter((e) => !e.line.startsWith('Job cost')).forEach((e) => byCategory.set(e.category, r2((byCategory.get(e.category) || 0) + e.amount)));

  /* ---------- purchases & tax (input tax on supplier bills; export invoices carry no tax) ---------- */
  const purchaseRows = periodBills.map((b) => ({
    billNo: b.billNo, date: isoDay(b.billDate), supplierName: b.supplierName || '', billType: b.billType, jobNo: b.jobNo || '', businessUnit: b.businessUnit,
    amount: r2(b.amount), taxPct: num(b.taxPct), taxAmount: r2(b.taxAmount), totalAmount: r2(b.totalAmount), paidAmount: r2(b.paidAmount), outstanding: r2(b.outstanding),
  })).sort((a, b) => a.date.localeCompare(b.date));
  const taxMap = new Map();
  purchaseRows.forEach((b) => {
    const t = taxMap.get(b.taxPct) || { taxPct: b.taxPct, bills: 0, taxable: 0, tax: 0 };
    t.bills += 1; t.taxable += b.amount; t.tax += b.taxAmount; taxMap.set(b.taxPct, t);
  });
  const tax = {
    input: [...taxMap.values()].map((t) => ({ ...t, taxable: r2(t.taxable), tax: r2(t.tax) })).sort((a, b) => a.taxPct - b.taxPct),
    inputTotal: r2(sum(purchaseRows, 'taxAmount')),
    outputTotal: 0,
    note: 'Export invoices are recorded without tax (zero-rated); input tax is taken from supplier bills.',
  };

  /* ---------- receivables & payables at the end of the period ---------- */
  const at = period.to;
  const receivables = allInvoices.filter((i) => new Date(i.invoiceDate) <= at && num(i.outstanding) > 0.005).map((i) => ({
    invoiceNo: i.invoiceNo, date: isoDay(i.invoiceDate), dueDate: i.dueDate ? isoDay(i.dueDate) : '', buyerName: i.buyerName || '', jobNo: i.jobNo || '', businessUnit: i.businessUnit,
    amount: r2(i.totalAmount), received: r2(i.receivedAmount), outstanding: r2(i.outstanding), aging: aging(i.dueDate, at),
  }));
  const payables = bills.filter((b) => new Date(b.billDate) <= at && num(b.outstanding) > 0.005).map((b) => ({
    billNo: b.billNo, date: isoDay(b.billDate), dueDate: b.dueDate ? isoDay(b.dueDate) : '', supplierName: b.supplierName || '', jobNo: b.jobNo || '', businessUnit: b.businessUnit,
    amount: r2(b.totalAmount), paid: r2(b.paidAmount), outstanding: r2(b.outstanding), aging: aging(b.dueDate, at),
  }));
  const agingOf = (list) => AGING.map((bucket) => ({ bucket, amount: r2(sum(list.filter((x) => x.aging === bucket), 'outstanding')), count: list.filter((x) => x.aging === bucket).length })).filter((a) => a.count);
  const parties = (list, key) => {
    const m = new Map();
    list.forEach((x) => m.set(x[key] || '—', r2((m.get(x[key] || '—') || 0) + x.outstanding)));
    return [...m.entries()].map(([name, outstanding]) => ({ name, outstanding })).sort((a, b) => b.outstanding - a.outstanding);
  };

  /* ---------- transaction history ---------- */
  const transactions = [
    ...fin.sources.sales.map((s) => ({ date: isoDay(s.invoiceDate), type: 'Sales invoice', ref: s.invoiceNo, party: s.buyerName || '', jobNo: s.jobNo || '', moneyIn: s.revenue, moneyOut: 0 })),
    ...payments.map((p) => ({ date: isoDay(p.paymentDate), type: 'Buyer receipt', ref: p.reference || p.refNo, party: p.buyerName || '', jobNo: p.jobNo || '', moneyIn: r2(p.amount), moneyOut: 0 })),
    ...purchaseRows.map((b) => ({ date: b.date, type: `Supplier bill – ${b.billType}`, ref: b.billNo, party: b.supplierName, jobNo: b.jobNo, moneyIn: 0, moneyOut: b.totalAmount })),
    ...supplierPaid.map((p) => ({ date: isoDay(p.date), type: 'Supplier payment', ref: p.reference || p.bill.billNo, party: p.bill.supplierName || '', jobNo: p.bill.jobNo || '', moneyIn: 0, moneyOut: r2(p.amount) })),
    ...expenseRows.map((e) => ({ date: e.date, type: `Expense – ${e.category}`, ref: e.refNo, party: '', jobNo: e.jobNo, moneyIn: 0, moneyOut: e.amount })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const empty = !fin.sources.sales.length && !purchaseRows.length && !expenseRows.length && !payments.length;
  return {
    period: period.label, from: isoDay(period.from), to: isoDay(period.to), previous: prevPeriod.label, grain, grainLabel: GRAINS[grain],
    currency: ctx.currency, currencies: fin.currencies, empty,
    headline: current, previousHeadline: previous, comparison,
    bridge: { revenue: fin.revenue, cogs: fin.cogs, grossProfit: fin.grossProfit, operatingExpenses: fin.operatingExpenses, ...Object.fromEntries(FINANCE_LINES.map((l) => [l.key, fin[l.key]])), ebitda: fin.ebitda, netProfit: fin.netProfit },
    financeLines: FINANCE_LINES.map((l) => ({ key: l.key, label: l.label })),
    series: rows,
    performance,
    expenses: { rows: expenseRows, byCategory: [...byCategory.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount) },
    purchases: { rows: purchaseRows, total: r2(sum(purchaseRows, 'totalAmount')), byType: Object.entries(purchaseRows.reduce((m, b) => ({ ...m, [b.billType]: r2((m[b.billType] || 0) + b.totalAmount) }), {})).map(([billType, amount]) => ({ billType, amount })) },
    sales: fin.sources.sales.map((s) => ({ invoiceNo: s.invoiceNo, date: isoDay(s.invoiceDate), jobNo: s.jobNo, buyerName: s.buyerName, styleNo: s.styleNo, businessUnit: s.businessUnit, qty: s.qty, revenue: s.revenue, cogs: s.cogs, cogsBasis: s.cogsBasis })),
    tax,
    cash: { receipts: r2(sum(payments, 'amount')), supplierPayments: r2(sum(supplierPaid, 'amount')), net: r2(sum(payments, 'amount') - sum(supplierPaid, 'amount')) },
    receivables: { total: r2(sum(receivables, 'outstanding')), overdue: r2(sum(receivables.filter((x) => !['Not due', 'No due date'].includes(x.aging)), 'outstanding')), aging: agingOf(receivables), byParty: parties(receivables, 'buyerName'), rows: receivables },
    payables: { total: r2(sum(payables, 'outstanding')), overdue: r2(sum(payables.filter((x) => !['Not due', 'No due date'].includes(x.aging)), 'outstanding')), aging: agingOf(payables), byParty: parties(payables, 'supplierName'), rows: payables },
    inventory: { opening: inv.opening, closing: inv.closing, itr: inv.itr, holdingDays: inv.holdingDays, categories: inv.categories.map(({ category, opening, closing, average, consumption, itr, holdingDays }) => ({ category, opening, closing, average, consumption, itr, holdingDays })) },
    transactions,
  };
}
