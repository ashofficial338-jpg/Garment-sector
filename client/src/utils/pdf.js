/** Professional PDF documents generated from the same job data (no re-typing). */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { fmtDate, fmtNum, fmtMoney } from './format.js';
import { api } from '../api.js';

const BRAND = [79, 70, 229];
const company = () => {
  try { return JSON.parse(sessionStorage.getItem('company') || 'null') || { name: 'StitchFlow Garments' }; } catch { return { name: 'StitchFlow Garments' }; }
};

function header(doc, title, sub) {
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(...BRAND); doc.rect(0, 0, w, 26, 'F');
  doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text(company().name || 'StitchFlow Garments', 14, 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  doc.text([company().address, company().phone, company().email].filter(Boolean).join('  ·  ') || 'Garment Manufacturing & Export', 14, 19);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  doc.text(title, w - 14, 12, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  if (sub) doc.text(sub, w - 14, 19, { align: 'right' });
  doc.setTextColor(20);
  return 34;
}

function footer(doc) {
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i += 1) {
    doc.setPage(i);
    const w = doc.internal.pageSize.getWidth(); const h = doc.internal.pageSize.getHeight();
    doc.setFontSize(8); doc.setTextColor(130);
    doc.text(`Generated ${new Date().toLocaleString()} · StitchFlow ERP`, 14, h - 8);
    doc.text(`Page ${i} of ${n}`, w - 14, h - 8, { align: 'right' });
  }
}

/** Key/value grid in two columns */
function kv(doc, y, pairs) {
  autoTable(doc, {
    startY: y, theme: 'plain', styles: { fontSize: 9, cellPadding: 1.6 },
    columnStyles: { 0: { fontStyle: 'bold', textColor: 90, cellWidth: 38 }, 2: { fontStyle: 'bold', textColor: 90, cellWidth: 38 } },
    body: pairs.reduce((rows, p, i) => { if (i % 2 === 0) rows.push([p[0], p[1] ?? '—']); else rows[rows.length - 1].push(p[0], p[1] ?? '—'); return rows; }, []),
  });
  return doc.lastAutoTable.finalY + 4;
}

const table = (doc, y, head, body, opts = {}) => {
  autoTable(doc, { startY: y, head: [head], body, theme: 'grid', headStyles: { fillColor: BRAND, fontSize: 8.5 }, styles: { fontSize: 8.5, cellPadding: 2 }, ...opts });
  return doc.lastAutoTable.finalY + 6;
};

function finish(doc, name, mode) {
  footer(doc);
  if (mode === 'blob') return doc.output('blob');
  doc.save(`${name}.pdf`);
  return null;
}

export function quotationPdf(q, mode) {
  const doc = new jsPDF();
  let y = header(doc, 'QUOTATION', `${q.refNo} · Version ${q.version || 1}`);
  y = kv(doc, y, [
    ['Buyer', q.buyerName || q.buyer?.name], ['Date', fmtDate(q.quoteDate)],
    ['Contact', q.buyerContact], ['Valid Until', fmtDate(q.validUntil)],
    ['Style No', q.styleNo], ['Product', q.product],
    ['Fabric', q.fabric], ['Composition', q.composition],
    ['GSM', q.gsm], ['Color', q.color], ['Size Range', q.sizeRange], ['Status', q.status],
  ]);
  y = table(doc, y, ['Style', 'Description', 'Qty (pcs)', `Price / pc (${q.currency})`, `Amount (${q.currency})`], [
    [q.styleNo, [q.product, q.fabric, q.composition].filter(Boolean).join(', '), fmtNum(q.orderQty), fmtNum(q.price, 2), fmtNum(q.quoteValue, 2)],
  ], { columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } } });
  y = kv(doc, y, [['Payment Terms', q.paymentTerms], ['Delivery Terms', q.deliveryTerms], ['Shipment Terms', q.shipmentTerms], ['Currency', q.currency]]);
  if (q.remarks) { doc.setFontSize(9); doc.text(doc.splitTextToSize(`Remarks: ${q.remarks}`, 180), 14, y + 2); y += 12; }
  doc.setFontSize(9); doc.setTextColor(90);
  doc.text('We thank you for the enquiry and look forward to your valued order.', 14, y + 8);
  doc.text('Authorised Signatory', 150, y + 30);
  return finish(doc, `Quotation-${q.refNo}-v${q.version || 1}`, mode);
}

export function packingListPdf(p, job, mode) {
  const doc = new jsPDF({ orientation: 'landscape' });
  let y = header(doc, 'PACKING LIST', `${p.refNo} · ${p.jobNo}`);
  y = kv(doc, y, [['Buyer', p.buyerName], ['Packing Date', fmtDate(p.packingDate)], ['Style', p.styleNo], ['PO No', p.poNo], ['Destination', job?.destination], ['Method', p.packingMethod]]);
  y = table(doc, y, ['Ctn From', 'Ctn To', 'Color', 'Size Ratio', 'Ctns', 'Pcs/Ctn', 'Qty', 'N.W/Ctn', 'G.W/Ctn', 'Dimension (cm)', 'CBM'],
    (p.rows || []).map((r) => [r.cartonFrom, r.cartonTo, r.color, r.ratio, r.cartons, r.pcsPerCarton, fmtNum(r.qty), r.netWtPerCarton, r.grossWtPerCarton, `${r.length}×${r.width}×${r.height}`, r.cbm]),
    { foot: [['', '', '', 'TOTAL', fmtNum(p.totalCartons), '', fmtNum(p.totalQty), '', '', '', p.totalCbm]], footStyles: { fillColor: [238, 240, 255], textColor: 20 } });
  kv(doc, y, [['Total Cartons', fmtNum(p.totalCartons)], ['Total Qty', `${fmtNum(p.totalQty)} pcs`], ['Net Weight', `${fmtNum(p.totalNetWeight, 2)} kg`], ['Gross Weight', `${fmtNum(p.totalGrossWeight, 2)} kg`], ['Total CBM', p.totalCbm]]);
  return finish(doc, `PackingList-${p.refNo}`, mode);
}

export function ppMeetingPdf(m, mode) {
  const doc = new jsPDF();
  let y = header(doc, 'PP MEETING REPORT', `${m.refNo} · ${m.jobNo}`);
  y = kv(doc, y, [['Job No', m.jobNo], ['Meeting Date', fmtDate(m.meetingDate)], ['Buyer', m.buyerName], ['Style No', m.styleNo], ['Production Qty', fmtNum(m.productionQty)], ['Target / day', fmtNum(m.productionTarget)], ['Manpower', m.manpowerRequirement], ['Status', m.status]]);
  y = table(doc, y, ['Readiness item', 'Status'], [['Fabric', m.fabricStatus], ['Trims', m.trimStatus], ['Sample approval', m.sampleApproval], ['Measurement approval', m.measurementApproval], ['Pattern', m.patternStatus], ['Marker', m.markerStatus]].map((r) => [r[0], r[1] || 'Pending']));
  [['Attendees', m.attendees], ['Machine requirement', m.machineRequirement], ['Quality requirements', m.qualityRequirements], ['Buyer comments', m.buyerComments], ['Risks / issues', m.risks]].forEach(([l, v]) => {
    if (!v) return;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.text(l, 14, y);
    doc.setFont('helvetica', 'normal'); const lines = doc.splitTextToSize(String(v), 180); doc.text(lines, 14, y + 5); y += 8 + lines.length * 4.5;
  });
  if (m.actionItems?.length) table(doc, y, ['#', 'Action', 'Responsible', 'Due', 'Status'], m.actionItems.map((a, i) => [i + 1, a.action, a.responsible, fmtDate(a.dueDate), a.status]));
  return finish(doc, `PPM-${m.jobNo}`, mode);
}

export function commercialInvoicePdf(inv, job, mode) {
  const doc = new jsPDF();
  let y = header(doc, 'COMMERCIAL INVOICE', `${inv.invoiceNo} · ${fmtDate(inv.invoiceDate)}`);
  y = kv(doc, y, [['Buyer', inv.buyerName], ['Job No', inv.jobNo], ['PO No', inv.poNo], ['Style', inv.styleNo], ['Terms', job?.deliveryTerms], ['Payment', job?.paymentTerms], ['Destination', job?.destination], ['Due Date', fmtDate(inv.dueDate)]]);
  y = table(doc, y, ['Description', 'Qty (pcs)', `Unit Price (${inv.currency})`, `Amount (${inv.currency})`], [
    [`${job?.product || 'Garments'} – Style ${inv.styleNo}${job?.composition ? `, ${job.composition}` : ''}`, fmtNum(inv.qty), fmtNum(inv.unitPrice, 2), fmtNum(inv.grossAmount, 2)],
    ...(inv.discount ? [['Less: discount / claims', '', '', `-${fmtNum(inv.discount, 2)}`]] : []),
    ...(inv.otherCharges ? [['Add: other charges', '', '', fmtNum(inv.otherCharges, 2)]] : []),
  ], { foot: [['TOTAL', fmtNum(inv.qty), '', fmtMoney(inv.totalAmount, inv.currency)]], footStyles: { fillColor: [238, 240, 255], textColor: 20 }, columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } } });
  doc.setFontSize(9); doc.setTextColor(90);
  doc.text('We certify that this invoice is true and correct and that the goods are of the stated origin.', 14, y + 4);
  doc.text('Authorised Signatory', 150, y + 26);
  return finish(doc, `Invoice-${inv.invoiceNo}`, mode);
}

/** Generic report table PDF */
export function reportPdf(title, columns, rows, filters = '') {
  const doc = new jsPDF({ orientation: columns.length > 7 ? 'landscape' : 'portrait' });
  const y = header(doc, title.toUpperCase(), filters || `${rows.length} rows`);
  const fmt = (v) => (v === null || v === undefined ? '' : v instanceof Date ? fmtDate(v) : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? fmtDate(v) : typeof v === 'number' ? fmtNum(v, Number.isInteger(v) ? 0 : 2) : typeof v === 'object' ? (v.refNo || v.name || '') : String(v));
  table(doc, y, columns.map((c) => c.label), rows.map((r) => columns.map((c) => fmt(c.key.split('.').reduce((o, k) => o?.[k], r)))), { styles: { fontSize: 7.5, cellPadding: 1.5 }, headStyles: { fillColor: BRAND, fontSize: 7.5 } });
  return finish(doc, title.replace(/\W+/g, '-'));
}

/** Generate a PDF and store it in Document Management against the job. */
export async function savePdfToDocuments(blob, { job, docType, title }) {
  const fd = new FormData();
  fd.append('job', job); fd.append('docType', docType); fd.append('title', title);
  fd.append('file', new File([blob], `${title.replace(/\W+/g, '-')}.pdf`, { type: 'application/pdf' }));
  return api.post('/documents', fd);
}
