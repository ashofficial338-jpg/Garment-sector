/**
 * Module registry – the single source of truth for every business module.
 * The server builds Mongoose models, validation, CRUD routes and reports from it;
 * the client builds forms, tables and live calculations from it.
 */
import * as masters from './masters.js';
import * as commercial from './commercial.js';
import * as planning from './planning.js';
import * as production from './production.js';
import * as finance from './finance.js';
import * as stock from './stock.js';
import * as preproduction from './preproduction.js';

const ordered = [
  commercial.enquiry, commercial.costing, commercial.quotation, commercial.orders,
  preproduction.techSpec, preproduction.bom, preproduction.pattern, preproduction.marker,
  planning.tna, planning.ppMeeting, planning.fabricForecast, planning.fabricBooking, planning.fabricTransfer, planning.trimBooking,
  stock.yarnReceipt, stock.knitting, stock.fabricProcess, planning.sample, planning.productionPlan,
  production.cutting, production.sewing, production.finishing, production.packing, production.inspection,
  finance.shipment, finance.invoice, finance.payment, finance.expense,
  masters.buyer, masters.supplier, masters.master, masters.employee,
];

export const MODULES = Object.fromEntries(ordered.map((m) => [m.key, m]));
export const MODULE_LIST = ordered;
export const getModule = (key) => MODULES[key];
export const moduleByModel = (model) => ordered.find((m) => m.model === model);

/** Run a module's compute() and merge the result (computed fields always win). */
export function applyCompute(def, doc) {
  if (!def?.compute) return { ...doc };
  const out = def.compute({ ...doc }) || {};
  return { ...doc, ...out };
}

/** Field level validation shared by client & server. Returns { field: message }. */
export function validateRecord(def, doc) {
  const errors = {};
  const check = (f, v, path) => {
    if (f.readOnly) return;
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (f.required && empty) { errors[path] = `${f.label} is required`; return; }
    if (empty) return;
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) errors[path] = `${f.label} must be a number`;
      else if (f.min !== undefined && n < f.min) errors[path] = `${f.label} cannot be negative`;
      else if (f.max !== undefined && n > f.max) errors[path] = `${f.label} cannot exceed ${f.max}`;
    }
    if (f.type === 'date' && Number.isNaN(new Date(v).getTime())) errors[path] = `${f.label} is not a valid date`;
    if (f.type === 'select' && f.options && !f.options.includes(v)) errors[path] = `${f.label} has an invalid value`;
    if (f.type === 'table' && Array.isArray(v)) {
      v.forEach((row, i) => f.fields.forEach((sf) => check(sf, row?.[sf.name], `${path}.${i}.${sf.name}`)));
    }
  };
  def.fields.forEach((f) => check(f, doc[f.name], f.name));
  return errors;
}

/** Which statuses a user may move to from `current` without override. */
export function allowedTransitions(def, current) {
  return def.transitions?.[current] || [];
}

export { masters, commercial, planning, production, finance, stock, preproduction };
