/**
 * Excel workbook of the financial report pack (see financialReport.js) – one sheet per selected section.
 * Totals, profit, margin and tax columns are live Excel formulas over the data rows, so edits recalculate;
 * every sheet has a title block, a frozen header with filters, number formats and red highlighting of
 * negative profit / change. (ExcelJS cannot write native Excel charts – the charts are on the page and in the PDF.)
 */
import ExcelJS from 'exceljs';

export const SECTIONS = {
  summary: 'Dashboard Summary', sales: 'Revenue and Sales', expenses: 'Expenses', purchases: 'Purchases',
  performance: 'Styles and Buyers', inventory: 'Inventory and Stock', parties: 'Buyers and Suppliers',
  tax: 'Tax Report', pnl: 'Profit and Loss', transactions: 'Transaction History',
};

const HEAD = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF312E81' } } };
const TOTAL = { font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF0FF' } } };
const MONEY = '#,##0.00;[Red]-#,##0.00';
const QTY = '#,##0';
const PCT = '0.0%;[Red]-0.0%';
const RED = { font: { color: { argb: 'FFC0392B' } } };
// neutralise spreadsheet formula injection in text cells
const safe = (v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v);

/**
 * Adds a sheet: title block (rows 1–2), header (row 4), data rows, optional totals row.
 * col: { key, label, width?, fmt?: 'money'|'qty'|'pct', formula?: (row, L) => string, total?: true, negRed?: true }
 * L(key) gives the column letter of another column, for formulas.
 */
function addTable(wb, name, title, columns, rows, { meta, startRow = 4, totals = true } = {}) {
  const ws = wb.getWorksheet(name) || wb.addWorksheet(name);
  const letter = Object.fromEntries(columns.map((c, i) => [c.key, ws.getColumn(i + 1).letter]));
  const L = (k) => letter[k];
  if (startRow === 4) {
    ws.getCell('A1').value = title; ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value = meta; ws.getCell('A2').font = { color: { argb: 'FF6B7280' } };
  }
  const fmt = { money: MONEY, qty: QTY, pct: PCT };
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(col.width || 0, c.width || Math.min(Math.max(c.label.length + 4, 12), 42));
    const h = ws.getCell(startRow, i + 1); h.value = c.label; Object.assign(h, HEAD);
  });
  const first = startRow + 1;
  rows.forEach((row, ri) => {
    const r = first + ri;
    columns.forEach((c, i) => {
      const cell = ws.getCell(r, i + 1);
      cell.value = c.formula ? { formula: c.formula(r, L) } : safe(row[c.key] ?? '');
      if (c.fmt) cell.numFmt = fmt[c.fmt];
    });
  });
  const last = first + rows.length - 1;
  if (rows.length) {
    ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: last, column: columns.length } };
    columns.filter((c) => c.negRed).forEach((c) => ws.addConditionalFormatting({ ref: `${L(c.key)}${first}:${L(c.key)}${last}`, rules: [{ type: 'cellIs', operator: 'lessThan', formulae: [0], style: RED }] }));
  }
  if (totals && rows.length && columns.some((c) => c.total)) {
    const t = last + 1;
    ws.getCell(t, 1).value = 'TOTAL';
    columns.forEach((c, i) => {
      const cell = ws.getCell(t, i + 1);
      if (c.total === true) cell.value = { formula: `SUBTOTAL(9,${L(c.key)}${first}:${L(c.key)}${last})` };
      else if (typeof c.total === 'function') cell.value = { formula: c.total(t, L, first, last) };
      if (c.fmt) cell.numFmt = fmt[c.fmt];
      Object.assign(cell, TOTAL);
    });
  }
  if (startRow === 4) ws.views = [{ state: 'frozen', ySplit: startRow }];
  return { ws, first, last: rows.length ? last : first - 1, next: (rows.length ? last : first - 1) + (totals ? 3 : 2), L };
}

const money = (key, label, extra = {}) => ({ key, label, fmt: 'money', total: true, ...extra });
const margin = (num, den, label = 'Margin %') => ({ key: `${num}Pct`, label, fmt: 'pct', negRed: true, formula: (r, L) => `IF(${L(den)}${r}=0,"",${L(num)}${r}/${L(den)}${r})`, total: (t, L) => `IF(${L(den)}${t}=0,"",${L(num)}${t}/${L(den)}${t})` });

export async function financialWorkbook(rep, { sections, company, scopeLabel, generatedBy }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = company?.name || 'Garment ERP';
  wb.created = new Date();
  const meta = `${company?.name || ''} · ${scopeLabel} · ${rep.period} · ${rep.grainLabel} · amounts in ${rep.currency} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}${generatedBy ? ` by ${generatedBy}` : ''}`;
  const want = (k) => sections.includes(k);
  const T = (k) => `${SECTIONS[k]} – ${rep.period}`;

  if (want('summary')) {
    const keys = [['revenue', 'Revenue'], ['cogs', 'Cost of goods sold'], ['grossProfit', 'Gross profit'], ['operatingExpenses', 'Operating expenses'], ['expenses', 'Total expenses'], ['netProfit', 'Net profit'], ['purchases', 'Purchases (supplier bills)']];
    const rows = keys.map(([k, label]) => ({ label, current: rep.headline[k], previous: rep.previousHeadline[k] }));
    const s = addTable(wb, SECTIONS.summary, T('summary'), [
      { key: 'label', label: 'Measure', width: 30 }, money('current', `This period (${rep.from} → ${rep.to})`, { total: false }), money('previous', `Previous period (${rep.previous})`, { total: false }),
      { key: 'change', label: 'Change', fmt: 'money', negRed: true, formula: (r, L) => `${L('current')}${r}-${L('previous')}${r}` },
      { key: 'changePct', label: 'Change %', fmt: 'pct', negRed: true, formula: (r, L) => `IF(${L('previous')}${r}=0,"",(${L('current')}${r}-${L('previous')}${r})/ABS(${L('previous')}${r}))` },
    ], rows, { meta, totals: false });
    // margins and balances as formulas over the rows above
    const at = (label) => s.first + keys.findIndex(([, l]) => l === label);
    const extra = [
      ['Gross margin %', `IF(B${at('Revenue')}=0,"",B${at('Gross profit')}/B${at('Revenue')})`, `IF(C${at('Revenue')}=0,"",C${at('Gross profit')}/C${at('Revenue')})`, PCT],
      ['Net margin %', `IF(B${at('Revenue')}=0,"",B${at('Net profit')}/B${at('Revenue')})`, `IF(C${at('Revenue')}=0,"",C${at('Net profit')}/C${at('Revenue')})`, PCT],
    ];
    let r = s.last + 1;
    extra.forEach(([label, f1, f2, nf]) => {
      s.ws.getCell(r, 1).value = label; s.ws.getCell(r, 2).value = { formula: f1 }; s.ws.getCell(r, 3).value = { formula: f2 };
      s.ws.getCell(r, 2).numFmt = nf; s.ws.getCell(r, 3).numFmt = nf; s.ws.getCell(r, 1).font = { bold: true }; r += 1;
    });
    r += 1;
    [['Buyer receivables (end of period)', rep.receivables.total], ['  of which overdue', rep.receivables.overdue], ['Supplier payables (end of period)', rep.payables.total], ['  of which overdue', rep.payables.overdue],
      ['Cash received from buyers', rep.cash.receipts], ['Cash paid to suppliers', rep.cash.supplierPayments], ['Net cash flow (receipts − supplier payments)', rep.cash.net],
      ['Inventory – closing value', rep.inventory.closing], ['Inventory – opening value', rep.inventory.opening]].forEach(([label, v]) => {
      s.ws.getCell(r, 1).value = label; s.ws.getCell(r, 2).value = v; s.ws.getCell(r, 2).numFmt = MONEY; r += 1;
    });
    if (rep.currencies?.length > 1) { r += 1; s.ws.getCell(r, 1).value = `Note: transactions in ${rep.currencies.join(', ')} are summed as recorded in ${rep.currency}.`; }
  }

  if (want('pnl')) {
    const s = addTable(wb, SECTIONS.pnl, `${rep.grainLabel} profit and loss – ${rep.period}`, [
      { key: 'period', label: rep.grainLabel.replace(/ly$/, '').replace('Dai', 'Day') }, money('revenue', 'Revenue'), money('cogs', 'COGS'), money('operatingExpenses', 'Operating expenses'), money('financeCosts', 'Interest, tax, D&A'),
      { key: 'expenses', label: 'Total expenses', fmt: 'money', formula: (r, L) => `${L('cogs')}${r}+${L('operatingExpenses')}${r}+${L('financeCosts')}${r}`, total: true },
      { key: 'grossProfit', label: 'Gross profit', fmt: 'money', negRed: true, formula: (r, L) => `${L('revenue')}${r}-${L('cogs')}${r}`, total: true },
      { key: 'netProfit', label: 'Net profit', fmt: 'money', negRed: true, formula: (r, L) => `${L('revenue')}${r}-${L('expenses')}${r}`, total: true },
      margin('netProfit', 'revenue', 'Net margin %'),
      { key: 'cumulative', label: 'Cumulative net profit', fmt: 'money', negRed: true, formula: (r, L) => `SUM(${L('netProfit')}$5:${L('netProfit')}${r})` },
    ], rep.series, { meta });
    // profit bridge for the whole period
    let r = s.next;
    s.ws.getCell(r, 1).value = 'Profit bridge (period)'; s.ws.getCell(r, 1).font = { bold: true, size: 12 }; r += 1;
    const b = rep.bridge;
    [['Revenue', b.revenue], ['− COGS', -b.cogs], ['= Gross profit', b.grossProfit], ['− Operating expenses', -b.operatingExpenses], ['= EBITDA', b.ebitda],
      ...rep.financeLines.map((l) => [`− ${l.label}`, -b[l.key]]), ['= Net profit', b.netProfit]].forEach(([label, v]) => {
      s.ws.getCell(r, 1).value = label; s.ws.getCell(r, 2).value = v; s.ws.getCell(r, 2).numFmt = MONEY;
      if (label.startsWith('=')) { s.ws.getCell(r, 1).font = { bold: true }; s.ws.getCell(r, 2).font = { bold: true }; }
      r += 1;
    });
  }

  if (want('sales')) {
    addTable(wb, SECTIONS.sales, T('sales'), [
      { key: 'date', label: 'Invoice Date' }, { key: 'invoiceNo', label: 'Invoice' }, { key: 'businessUnit', label: 'Unit' }, { key: 'jobNo', label: 'Job No' }, { key: 'buyerName', label: 'Buyer', width: 24 }, { key: 'styleNo', label: 'Style' },
      { key: 'qty', label: 'Qty (pcs)', fmt: 'qty', total: true }, money('revenue', 'Revenue'), money('cogs', 'COGS'),
      { key: 'gp', label: 'Gross profit', fmt: 'money', negRed: true, formula: (r, L) => `${L('revenue')}${r}-${L('cogs')}${r}`, total: true }, margin('gp', 'revenue', 'Gross margin %'),
      { key: 'cogsBasis', label: 'COGS basis', width: 18 },
    ], rep.sales, { meta });
  }

  if (want('expenses')) {
    const s = addTable(wb, SECTIONS.expenses, T('expenses'), [
      { key: 'date', label: 'Date' }, { key: 'refNo', label: 'Ref' }, { key: 'businessUnit', label: 'Unit' }, { key: 'line', label: 'P&L line', width: 30 }, { key: 'category', label: 'Category', width: 20 },
      { key: 'description', label: 'Description', width: 36 }, { key: 'jobNo', label: 'Job No' }, money('amount', 'Amount'),
    ], rep.expenses.rows, { meta });
    addTable(wb, SECTIONS.expenses, '', [{ key: 'category', label: 'Category (excl. job costs in COGS)', width: 20 }, money('amount', 'Amount')], rep.expenses.byCategory, { startRow: s.next });
  }

  if (want('purchases')) {
    const s = addTable(wb, SECTIONS.purchases, T('purchases'), [
      { key: 'date', label: 'Bill Date' }, { key: 'billNo', label: 'Supplier Invoice' }, { key: 'businessUnit', label: 'Unit' }, { key: 'supplierName', label: 'Supplier', width: 26 }, { key: 'billType', label: 'Type' }, { key: 'jobNo', label: 'Job No' },
      money('amount', 'Taxable amount'), { key: 'taxPct', label: 'Tax %', fmt: 'qty' },
      { key: 'taxAmount', label: 'Tax', fmt: 'money', formula: (r, L) => `ROUND(${L('amount')}${r}*${L('taxPct')}${r}/100,2)`, total: true },
      { key: 'totalAmount', label: 'Bill total', fmt: 'money', formula: (r, L) => `${L('amount')}${r}+${L('taxAmount')}${r}`, total: true },
      money('paidAmount', 'Paid'), money('outstanding', 'Outstanding'),
    ], rep.purchases.rows, { meta });
    addTable(wb, SECTIONS.purchases, '', [{ key: 'billType', label: 'Purchases by type' }, money('amount', 'Amount')], rep.purchases.byType, { startRow: s.next });
  }

  if (want('performance')) {
    const cols = (label) => [{ key: 'label', label, width: 36 }, { key: 'invoices', label: 'Invoices', fmt: 'qty', total: true }, { key: 'qty', label: 'Qty (pcs)', fmt: 'qty', total: true }, money('revenue', 'Revenue'), money('cogs', 'COGS'),
      { key: 'gp', label: 'Gross profit', fmt: 'money', negRed: true, formula: (r, L) => `${L('revenue')}${r}-${L('cogs')}${r}`, total: true }, margin('gp', 'revenue', 'Gross margin %')];
    let s = addTable(wb, SECTIONS.performance, `Top styles – ${rep.period}`, cols('Style'), rep.performance.styles, { meta });
    s = addTable(wb, SECTIONS.performance, '', cols('Garment type'), rep.performance.garmentTypes, { startRow: s.next });
    addTable(wb, SECTIONS.performance, '', cols('Buyer'), rep.performance.buyers, { startRow: s.next });
  }

  if (want('inventory')) {
    addTable(wb, SECTIONS.inventory, `Inventory valuation – ${rep.period}`, [
      { key: 'category', label: 'Category', width: 22 }, money('opening', 'Opening value'), money('closing', 'Closing value'),
      { key: 'average', label: 'Average', fmt: 'money', formula: (r, L) => `(${L('opening')}${r}+${L('closing')}${r})/2`, total: true },
      money('consumption', 'Consumption in period'),
      { key: 'itr', label: 'Turnover (x)', fmt: 'money', formula: (r, L) => `IF(${L('average')}${r}=0,"",${L('consumption')}${r}/${L('average')}${r})`, total: (t, L) => `IF(${L('average')}${t}=0,"",${L('consumption')}${t}/${L('average')}${t})` },
      { key: 'holdingDays', label: 'Holding days', fmt: 'qty' },
    ], rep.inventory.categories, { meta });
  }

  if (want('parties')) {
    const age = (label, party) => [{ key: 'date', label: 'Date' }, { key: label, label: label === 'invoiceNo' ? 'Invoice' : 'Supplier Invoice' }, { key: 'businessUnit', label: 'Unit' }, { key: party, label: party === 'buyerName' ? 'Buyer' : 'Supplier', width: 26 },
      { key: 'jobNo', label: 'Job No' }, { key: 'dueDate', label: 'Due' }, money('amount', 'Amount'), money(party === 'buyerName' ? 'received' : 'paid', party === 'buyerName' ? 'Received' : 'Paid'),
      // recorded balance: a supplier bill is also reduced by debit notes set off against it
      money('outstanding', 'Outstanding'), { key: 'aging', label: 'Aging' }];
    let s = addTable(wb, SECTIONS.parties, `Buyer receivables and supplier payables – at ${rep.to}`, age('invoiceNo', 'buyerName'), rep.receivables.rows, { meta });
    s = addTable(wb, SECTIONS.parties, '', age('billNo', 'supplierName'), rep.payables.rows, { startRow: s.next });
    s = addTable(wb, SECTIONS.parties, '', [{ key: 'name', label: 'Buyer', width: 26 }, money('outstanding', 'Receivable')], rep.receivables.byParty, { startRow: s.next });
    addTable(wb, SECTIONS.parties, '', [{ key: 'name', label: 'Supplier', width: 26 }, money('outstanding', 'Payable')], rep.payables.byParty, { startRow: s.next });
  }

  if (want('tax')) {
    const s = addTable(wb, SECTIONS.tax, `Tax summary – ${rep.period}`, [
      { key: 'taxPct', label: 'Input tax rate %', fmt: 'qty' }, { key: 'bills', label: 'Supplier bills', fmt: 'qty', total: true }, money('taxable', 'Taxable value'),
      money('tax', 'Input tax'),
    ], rep.tax.input, { meta });
    s.ws.getCell(s.next, 1).value = 'Output tax on sales invoices'; s.ws.getCell(s.next, 2).value = rep.tax.outputTotal; s.ws.getCell(s.next, 2).numFmt = MONEY;
    s.ws.getCell(s.next + 1, 1).value = rep.tax.note; s.ws.getCell(s.next + 1, 1).font = { italic: true, color: { argb: 'FF6B7280' } };
  }

  if (want('transactions')) {
    addTable(wb, SECTIONS.transactions, T('transactions'), [
      { key: 'date', label: 'Date' }, { key: 'type', label: 'Type', width: 28 }, { key: 'ref', label: 'Reference', width: 20 }, { key: 'party', label: 'Buyer / Supplier', width: 26 }, { key: 'jobNo', label: 'Job No' },
      // bills and the payments against them both appear, so the columns are not summed
      { key: 'moneyIn', label: 'In (invoiced / received)', fmt: 'money' }, { key: 'moneyOut', label: 'Out (billed / paid / expensed)', fmt: 'money' },
    ], rep.transactions, { meta, totals: false });
  }

  if (!wb.worksheets.length) wb.addWorksheet('Empty').getCell('A1').value = 'No sections selected';
  return wb.xlsx.writeBuffer();
}
