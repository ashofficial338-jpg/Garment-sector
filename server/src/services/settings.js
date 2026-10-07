import { Setting } from '../models/Setting.js';
import { LIFECYCLE_STAGES, REQUIRED_SHIPPING_DOCS } from '../../../shared/constants.js';
import { env } from '../config/env.js';

/** Default workflow configuration – editable by Admin in Settings → Workflow. */
export const DEFAULT_WORKFLOW = LIFECYCLE_STAGES.map((s) => ({
  key: s.key,
  label: s.label,
  department: s.department,
  responsibleUser: '',
  enabled: true,
  approvalRequired: ['costing', 'quotation', 'sampling', 'approval', 'planning', 'inspection'].includes(s.key),
  requiredDocuments: s.key === 'documentation' ? [...REQUIRED_SHIPPING_DOCS] : [],
  requiredForClosure: ['cutting', 'sewing', 'finishing', 'packing', 'inspection', 'shipment', 'documentation', 'accounts', 'payment'].includes(s.key),
  completionCondition: '',
}));

export const DEFAULTS = {
  jobNumber: { prefix: env.jobPrefix, digits: 5, includeYear: true, separator: '-' },
  subJob: { prefix: 'F', digits: 2 },
  tolerance: { shortShipPct: 3, overCutPct: 5, overShipPct: 0 },
  workflow: DEFAULT_WORKFLOW,
  notifications: { tnaDelay: true, fabricShortage: true, trimShortage: true, approvalPending: true, productionDelay: true, qualityFailure: true, shipmentDelay: true, paymentDue: true, paymentDueDays: 7, jobReadyToClose: true },
  company: { name: 'Garment ERP', address: '', phone: '', email: '', baseCurrency: 'USD' },
};

const cache = new Map();

export async function getSetting(key) {
  if (cache.has(key)) return cache.get(key);
  const doc = await Setting.findOne({ key }).lean();
  let value = doc?.value ?? DEFAULTS[key];
  if (key === 'workflow' && Array.isArray(value)) {
    // merge new default stages that might not be in a stored config
    const known = new Set(value.map((s) => s.key));
    value = [...value, ...DEFAULT_WORKFLOW.filter((s) => !known.has(s.key))];
  } else if (value && typeof value === 'object' && !Array.isArray(value) && DEFAULTS[key]) {
    value = { ...DEFAULTS[key], ...value };
  }
  cache.set(key, value);
  return value;
}

export async function setSetting(key, value, userId) {
  await Setting.findOneAndUpdate({ key }, { value, updatedBy: userId }, { upsert: true });
  cache.delete(key);
  return getSetting(key);
}

export async function getAllSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = await getSetting(k);
  return out;
}
