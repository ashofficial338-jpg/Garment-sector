export const fmtNum = (v, d = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
export const fmtSmart = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v ?? '—';
  return Number.isInteger(n) ? fmtNum(n) : fmtNum(n, Math.abs(n) < 10 ? 4 : 2).replace(/0+$/, '').replace(/\.$/, '');
};
export const fmtMoney = (v, cur = 'USD', d = 2) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${cur ? `${cur} ` : ''}${fmtNum(n, d)}`;
};
export const fmtCompact = (v) => {
  const n = Number(v) || 0;
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
};
export const fmtDate = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
export const fmtDateTime = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const toInputDate = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
export const timeAgo = (v) => {
  const s = Math.floor((Date.now() - new Date(v)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
export const STAGE_LABEL = {
  enquiry: 'Enquiry', costing: 'Costing', quotation: 'Quotation', order: 'Order', spec: 'Spec', bom: 'BOM',
  cad: 'CAD', pattern: 'Pattern', grading: 'Grading', marker: 'Marker', tna: 'T&A', ppMeeting: 'PP Meeting',
  fabric: 'Fabric', trims: 'Trims', sampling: 'Sampling', approval: 'Approval', planning: 'Planning', cutting: 'Cutting',
  sewing: 'Sewing', finishing: 'Finishing', packing: 'Packing', inspection: 'Inspection', shipment: 'Shipment',
  documentation: 'Documentation', accounts: 'Accounts', payment: 'Payment', profit: 'Profit', closure: 'Closure',
};
