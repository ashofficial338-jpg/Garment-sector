import ExcelJS from 'exceljs';

const cell = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? x?.refNo || x?.name || '' : x)).join(', ');
  if (typeof v === 'object') return v.refNo || v.name || v.jobNo || v.invoiceNo || (v._id ? String(v._id) : JSON.stringify(v));
  return v;
};
const get = (row, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), row);

export function toCsv(columns, rows) {
  const esc = (v) => {
    const s = String(cell(v));
    // neutralise spreadsheet formula injection
    const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(get(r, c.key))).join(','))].join('\n');
}

export async function toXlsx(columns, rows, title = 'Report') {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Garment ERP';
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: Math.min(Math.max(c.label.length + 4, 12), 40) }));
  rows.forEach((r) => ws.addRow(Object.fromEntries(columns.map((c) => [c.key, cell(get(r, c.key))]))));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF312E81' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return wb.xlsx.writeBuffer();
}

export async function sendExport(res, format, columns, rows, name) {
  const file = `${name}-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'xlsx') {
    const buf = await toXlsx(columns, rows, name);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.xlsx"`);
    return res.send(Buffer.from(buf));
  }
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.csv"`);
    return res.send(`\uFEFF${toCsv(columns, rows)}`);
  }
  return res.json({ columns, rows });
}

/** Default export columns for a module definition. */
export function moduleColumns(def) {
  const base = [{ key: 'refNo', label: 'Ref No' }];
  if (def.jobLinked) base.push({ key: 'jobNo', label: 'Job No' }, { key: 'buyerName', label: 'Buyer' }, { key: 'styleNo', label: 'Style No' }, { key: 'poNo', label: 'PO No' });
  else if (def.fields.some((f) => f.name === 'buyer') && !def.isJob) base.push({ key: 'buyerName', label: 'Buyer' });
  if (def.isJob) base.push({ key: 'buyerName', label: 'Buyer' });
  def.fields.filter((f) => f.type !== 'table' && f.name !== 'jobNo').forEach((f) => base.push({ key: f.name, label: f.label }));
  base.push({ key: 'status', label: 'Status' }, { key: 'createdByName', label: 'Created By' }, { key: 'createdAt', label: 'Created At' });
  return base;
}
