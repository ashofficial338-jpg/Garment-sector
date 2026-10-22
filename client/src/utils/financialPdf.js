/**
 * Financial report pack as a PDF – summary cards, charts and tables for the selected sections, built from the
 * /api/analytics/financial response (the same figures as the page and the Excel workbook).
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { BRAND, header, footer } from './pdf.js';
import { fmtNum, fmtCompact } from './format.js';

export const SECTION_LABELS = {
  summary: 'Dashboard summary', pnl: 'Profit and loss', sales: 'Revenue and sales', expenses: 'Expenses', purchases: 'Purchases',
  performance: 'Styles and buyers', inventory: 'Inventory and stock', parties: 'Buyers and suppliers', tax: 'Tax report', transactions: 'Transaction history',
};
const AMBER = [217, 119, 6]; const GREEN = [22, 163, 74]; const RED = [220, 38, 38]; const MUTED = [110, 116, 128];
const m = (v) => fmtNum(Number(v) || 0, 2); // no "-0.00"
const pctTxt = (v) => (v === null || v === undefined ? '—' : `${fmtNum(v, 1)}%`);
const FOOT = { fillColor: [238, 240, 255], textColor: 20, fontStyle: 'bold' };
const total = (rows, k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
// the built-in PDF fonts only cover WinAnsi – arrows (→) and the minus sign (−) would print as garbage
const plain = (v) => (typeof v === 'string' ? v.replace(/\u2192/g, 'to').replace(/\u2212/g, '-')
  : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);

export function financialPdf(report, { sections, scopeLabel, generatedBy }) {
  const d = plain(report);
  const doc = new jsPDF({ orientation: 'landscape' });
  const W = doc.internal.pageSize.getWidth(); const H = doc.internal.pageSize.getHeight();
  let y = header(doc, 'FINANCIAL REPORT', plain(scopeLabel));
  doc.setFontSize(8.5); doc.setTextColor(...MUTED);
  doc.text(`Period ${d.period} · ${d.grainLabel} · compared with ${d.previous} · amounts in ${d.currency} · generated ${new Date().toLocaleString()}${generatedBy ? ` by ${generatedBy}` : ''}`, 14, y);
  doc.setTextColor(20);
  y += 6;

  const space = (need) => { if (y + need > H - 16) { doc.addPage(); y = 16; } };
  const title = (text) => {
    space(18);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...BRAND); doc.text(text, 14, y + 4);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(20); y += 8;
  };
  const tbl = (head, body, { didParseCell, ...opts } = {}) => {
    if (!body.length) { doc.setFontSize(9); doc.setTextColor(...MUTED); doc.text('No records in this period.', 14, y + 3); doc.setTextColor(20); y += 9; return; }
    autoTable(doc, {
      startY: y, head: [head], body, theme: 'grid', margin: { left: 14, right: 14, top: 16 },
      headStyles: { fillColor: BRAND, fontSize: 7.5 }, styles: { fontSize: 7.5, cellPadding: 1.6 }, footStyles: FOOT, ...opts,
      // red text for negative money
      didParseCell: (c) => {
        if (c.section === 'body' && typeof c.cell.raw === 'string' && /^-\d/.test(c.cell.raw)) c.cell.styles.textColor = RED;
        if (c.section === 'foot' && opts.columnStyles?.[c.column.index]?.halign) c.cell.styles.halign = opts.columnStyles[c.column.index].halign;
        didParseCell?.(c);
      },
    });
    y = doc.lastAutoTable.finalY + 7;
  };
  const right = (from, to) => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [from + i, { halign: 'right' }]));
  const want = (k) => sections.includes(k);

  if (want('summary')) {
    title(SECTION_LABELS.summary);
    const h = d.headline; const c = d.comparison;
    const cards = [
      ['Revenue', h.revenue, c.revenue, false], ['Expenses', h.expenses, c.expenses, true], ['Purchases', h.purchases, c.purchases, true],
      ['Net profit', h.netProfit, c.netProfit, false], ['Net margin', null, null, false, `${fmtNum(h.netMarginPct, 1)}%`], ['Receivables', d.receivables.total, null, false],
    ];
    const gap = 4; const cw = (W - 28 - gap * (cards.length - 1)) / cards.length;
    cards.forEach(([label, value, ch, invert, text], i) => {
      const x = 14 + i * (cw + gap);
      doc.setFillColor(245, 246, 255); doc.setDrawColor(224, 227, 245); doc.roundedRect(x, y, cw, 22, 2, 2, 'FD');
      doc.setFontSize(7.5); doc.setTextColor(...MUTED); doc.text(label.toUpperCase(), x + 3, y + 5.5);
      doc.setFontSize(12.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(value < 0 ? RED[0] : 20, value < 0 ? RED[1] : 20, value < 0 ? RED[2] : 20);
      doc.text(text || fmtCompact(value), x + 3, y + 13);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
      if (ch && ch.pct !== null) {
        const good = invert ? ch.abs < 0 : ch.abs > 0;
        doc.setTextColor(...(ch.abs === 0 ? MUTED : good ? GREEN : RED));
        doc.text(`${ch.abs >= 0 ? '+' : '-'}${fmtNum(Math.abs(ch.pct), 1)}% vs previous`, x + 3, y + 18.5);
      } else if (label === 'Receivables') { doc.setTextColor(...MUTED); doc.text(`${fmtCompact(d.receivables.overdue)} overdue`, x + 3, y + 18.5); }
      doc.setTextColor(20);
    });
    y += 28;
    space(78);
    chart(doc, 14, y, W - 28, 70, d.series, `Revenue vs expenses and net profit (${d.grainLabel.toLowerCase()})`);
    y += 77;
    const b = d.bridge;
    tbl(['Profit bridge', `Amount (${d.currency})`], [
      ['Revenue', m(b.revenue)], ['- Cost of goods sold', m(-b.cogs)], ['= Gross profit', m(b.grossProfit)], ['- Operating expenses', m(-b.operatingExpenses)], ['= EBITDA', m(b.ebitda)],
      ...d.financeLines.map((l) => [`- ${l.label}`, m(-b[l.key])]), ['= Net profit', m(b.netProfit)],
    ], { tableWidth: 120, columnStyles: { 1: { halign: 'right' } }, didParseCell: (c) => { if (c.section === 'body' && String(c.row.raw[0]).startsWith('=')) c.cell.styles.fontStyle = 'bold'; } });
    tbl(['Cash and balances', `Amount (${d.currency})`], [
      ['Received from buyers', m(d.cash.receipts)], ['Paid to suppliers', m(d.cash.supplierPayments)], ['Net cash flow', m(d.cash.net)],
      ['Buyer receivables (end of period)', m(d.receivables.total)], ['Supplier payables (end of period)', m(d.payables.total)],
      ['Inventory – opening', m(d.inventory.opening)], ['Inventory – closing', m(d.inventory.closing)],
    ], { tableWidth: 120, columnStyles: { 1: { halign: 'right' } } });
  }

  if (want('pnl')) {
    title(`${d.grainLabel} ${SECTION_LABELS.pnl.toLowerCase()}`);
    tbl(['Period', 'Revenue', 'COGS', 'Operating exp.', 'Interest, tax, D&A', 'Expenses', 'Net profit', 'Margin', 'Cumulative', 'Purchases', 'Net cash'],
      d.series.map((r) => [r.period, m(r.revenue), m(r.cogs), m(r.operatingExpenses), m(r.financeCosts), m(r.expenses), m(r.netProfit), r.revenue ? pctTxt(r.netMarginPct) : '—', m(r.cumulativeProfit), m(r.purchases), m(r.netCashFlow)]),
      { columnStyles: right(1, 10), foot: [['Total', m(d.headline.revenue), m(d.headline.cogs), m(d.headline.operatingExpenses), m(d.headline.expenses - d.headline.cogs - d.headline.operatingExpenses), m(d.headline.expenses), m(d.headline.netProfit), pctTxt(d.headline.netMarginPct), '', m(d.headline.purchases), m(d.cash.net)]] });
  }

  if (want('sales')) {
    title(SECTION_LABELS.sales);
    tbl(['Date', 'Invoice', 'Unit', 'Job No', 'Buyer', 'Style', 'Qty', 'Revenue', 'COGS', 'Gross profit', 'Margin'],
      d.sales.map((s) => [s.date, s.invoiceNo, s.businessUnit, s.jobNo, s.buyerName, s.styleNo, fmtNum(s.qty), m(s.revenue), m(s.cogs), m(s.revenue - s.cogs), s.revenue ? pctTxt(((s.revenue - s.cogs) / s.revenue) * 100) : '—']),
      { columnStyles: right(6, 10), foot: [['Total', '', '', '', '', '', fmtNum(total(d.sales, 'qty')), m(total(d.sales, 'revenue')), m(total(d.sales, 'cogs')), m(total(d.sales, 'revenue') - total(d.sales, 'cogs')), '']] });
  }

  if (want('expenses')) {
    title(SECTION_LABELS.expenses);
    tbl(['Category (excluding job costs carried in COGS)', `Amount (${d.currency})`], d.expenses.byCategory.map((x) => [x.category, m(x.amount)]),
      { tableWidth: 140, columnStyles: { 1: { halign: 'right' } }, foot: [['Total', m(total(d.expenses.byCategory, 'amount'))]] });
    tbl(['Date', 'Ref', 'Unit', 'P&L line', 'Category', 'Description', 'Job No', 'Amount'],
      d.expenses.rows.map((e) => [e.date, e.refNo, e.businessUnit, e.line, e.category, e.description, e.jobNo, m(e.amount)]), { columnStyles: right(7, 7) });
  }

  if (want('purchases')) {
    title(SECTION_LABELS.purchases);
    const p = d.purchases.rows;
    tbl(['Date', 'Supplier invoice', 'Unit', 'Supplier', 'Type', 'Job No', 'Taxable', 'Tax %', 'Tax', 'Total', 'Paid', 'Outstanding'],
      p.map((b) => [b.date, b.billNo, b.businessUnit, b.supplierName, b.billType, b.jobNo, m(b.amount), fmtNum(b.taxPct, 1), m(b.taxAmount), m(b.totalAmount), m(b.paidAmount), m(b.outstanding)]),
      { columnStyles: right(6, 11), foot: [['Total', '', '', '', '', '', m(total(p, 'amount')), '', m(total(p, 'taxAmount')), m(total(p, 'totalAmount')), m(total(p, 'paidAmount')), m(total(p, 'outstanding'))]] });
  }

  if (want('performance')) {
    title(SECTION_LABELS.performance);
    const top = d.performance.styles.slice(0, 10);
    if (top.length) { space(14 + top.length * 7); hbar(doc, 14, y, W - 28, top); y += 10 + top.length * 7; }
    const grp = (name, rows) => tbl([name, 'Invoices', 'Qty', 'Revenue', 'COGS', 'Gross profit', 'Margin'],
      rows.map((r) => [r.label, fmtNum(r.invoices), fmtNum(r.qty), m(r.revenue), m(r.cogs), m(r.grossProfit), pctTxt(r.marginPct)]), { columnStyles: right(1, 6) });
    grp('Style', d.performance.styles); grp('Garment type', d.performance.garmentTypes); grp('Buyer', d.performance.buyers);
  }

  if (want('inventory')) {
    title(SECTION_LABELS.inventory);
    tbl(['Category', 'Opening', 'Closing', 'Average', 'Consumption', 'Turnover', 'Holding days'],
      d.inventory.categories.map((x) => [x.category, m(x.opening), m(x.closing), m(x.average), m(x.consumption), x.itr === null ? 'n/a' : `${fmtNum(x.itr, 2)}x`, x.holdingDays ?? 'n/a']),
      { columnStyles: right(1, 6), foot: [['Total', m(d.inventory.opening), m(d.inventory.closing), '', '', d.inventory.itr === null ? 'n/a' : `${fmtNum(d.inventory.itr, 2)}x`, d.inventory.holdingDays ?? 'n/a']] });
  }

  if (want('parties')) {
    title(`${SECTION_LABELS.parties} – balances at ${d.to}`);
    const buckets = [...new Set([...d.receivables.aging, ...d.payables.aging].map((a) => a.bucket))];
    tbl(['Aging', 'Receivable', 'Payable'], buckets.map((b) => [b, m(d.receivables.aging.find((a) => a.bucket === b)?.amount || 0), m(d.payables.aging.find((a) => a.bucket === b)?.amount || 0)]),
      { tableWidth: 140, columnStyles: right(1, 2), foot: [['Total', m(d.receivables.total), m(d.payables.total)]] });
    tbl(['Invoice', 'Date', 'Due', 'Buyer', 'Job No', 'Amount', 'Received', 'Outstanding', 'Aging'],
      d.receivables.rows.map((r) => [r.invoiceNo, r.date, r.dueDate, r.buyerName, r.jobNo, m(r.amount), m(r.received), m(r.outstanding), r.aging]), { columnStyles: right(5, 7) });
    tbl(['Supplier invoice', 'Date', 'Due', 'Supplier', 'Job No', 'Amount', 'Paid', 'Outstanding', 'Aging'],
      d.payables.rows.map((r) => [r.billNo, r.date, r.dueDate, r.supplierName, r.jobNo, m(r.amount), m(r.paid), m(r.outstanding), r.aging]), { columnStyles: right(5, 7) });
  }

  if (want('tax')) {
    title(SECTION_LABELS.tax);
    tbl(['Input tax rate', 'Supplier bills', 'Taxable value', 'Input tax'], d.tax.input.map((t) => [`${fmtNum(t.taxPct, 1)}%`, fmtNum(t.bills), m(t.taxable), m(t.tax)]),
      { tableWidth: 160, columnStyles: right(1, 3), foot: [['Total', fmtNum(total(d.tax.input, 'bills')), m(total(d.tax.input, 'taxable')), m(d.tax.inputTotal)]] });
    space(8); doc.setFontSize(8.5); doc.setTextColor(...MUTED); doc.text(`Output tax on sales invoices: ${m(d.tax.outputTotal)}. ${d.tax.note}`, 14, y); doc.setTextColor(20); y += 8;
  }

  if (want('transactions')) {
    title(SECTION_LABELS.transactions);
    tbl(['Date', 'Type', 'Reference', 'Buyer / Supplier', 'Job No', 'In', 'Out'],
      d.transactions.map((t) => [t.date, t.type, t.ref, t.party, t.jobNo, t.moneyIn ? m(t.moneyIn) : '', t.moneyOut ? m(t.moneyOut) : '']), { columnStyles: right(5, 6) });
  }

  footer(doc);
  return doc.output('blob');
}

/** Revenue and expense bars per period with a net profit line, drawn with PDF primitives. */
function chart(doc, x, y, w, h, series, caption) {
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.text(caption, x, y + 3); doc.setFont('helvetica', 'normal');
  const top = y + 8; const left = x + 16; const plotW = w - 18; const plotH = h - 20;
  const vals = series.flatMap((r) => [r.revenue, r.expenses, r.netProfit]);
  const max = Math.max(0, ...vals); const min = Math.min(0, ...vals);
  const span = max - min || 1;
  const Y = (v) => top + plotH - ((v - min) / span) * plotH;
  doc.setDrawColor(225); doc.setLineWidth(0.2); doc.setFontSize(6.5); doc.setTextColor(...MUTED);
  for (let i = 0; i <= 4; i += 1) {
    const v = min + (span * i) / 4;
    doc.line(left, Y(v), left + plotW, Y(v)); doc.text(fmtCompact(v), left - 2, Y(v) + 1, { align: 'right' });
  }
  doc.setDrawColor(150); doc.line(left, Y(0), left + plotW, Y(0));
  const n = series.length || 1; const slot = plotW / n; const bw = Math.min(6, slot * 0.35);
  const every = Math.ceil(n / 16);
  series.forEach((r, i) => {
    const cx = left + slot * i + slot / 2;
    [[r.revenue, BRAND, -bw], [r.expenses, AMBER, 0]].forEach(([v, col, off]) => {
      if (!v) return;
      doc.setFillColor(...col); doc.rect(cx + off, Math.min(Y(v), Y(0)), bw, Math.abs(Y(v) - Y(0)), 'F');
    });
    if (i % every === 0) doc.text(String(r.period).replace(/^W /, ''), cx, top + plotH + 4, { align: 'center' });
  });
  doc.setDrawColor(...GREEN); doc.setLineWidth(0.6);
  series.forEach((r, i) => { if (i) doc.line(left + slot * (i - 0.5), Y(series[i - 1].netProfit), left + slot * (i + 0.5), Y(r.netProfit)); });
  doc.setLineWidth(0.2);
  // legend
  const ly = top + plotH + 9;
  [[BRAND, 'Revenue'], [AMBER, 'Expenses'], [GREEN, 'Net profit']].forEach(([col, label], i) => {
    doc.setFillColor(...col); doc.rect(left + i * 32, ly - 2.2, 3, 3, 'F'); doc.setTextColor(60); doc.text(label, left + i * 32 + 4.5, ly);
  });
  doc.setTextColor(20);
}

/** Horizontal revenue bars for the top styles. */
function hbar(doc, x, y, w, rows) {
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.text('Top styles by revenue', x, y + 3); doc.setFont('helvetica', 'normal');
  const max = Math.max(...rows.map((r) => r.revenue), 1); const labelW = 40; const barW = w - labelW - 30;
  rows.forEach((r, i) => {
    const ry = y + 8 + i * 7;
    doc.setFontSize(7.5); doc.setTextColor(60); doc.text(String(r.key).slice(0, 22), x, ry + 3);
    doc.setFillColor(...BRAND); doc.rect(x + labelW, ry, Math.max(0.5, (Math.max(r.revenue, 0) / max) * barW), 4, 'F');
    doc.text(fmtCompact(r.revenue), x + labelW + (Math.max(r.revenue, 0) / max) * barW + 2, ry + 3);
  });
  doc.setTextColor(20);
}
