/**
 * Tiny field DSL used by every module definition.
 *
 * Field shape:
 *  { name, label, type, required, options, ref, min, max, readOnly, list, filter, search,
 *    section, span, unit, fields (for type 'table'), default }
 *
 * types: text | textarea | number | date | select | boolean | ref | table | tags
 *  - ref    → ObjectId reference (ref: 'Buyer' | 'Supplier' | 'User' | 'Job')
 *  - table  → array of sub-documents described by `fields`
 *  - readOnly fields are calculated by the module's `compute()` and never trusted from the client.
 */
export const text = (name, label, o = {}) => ({ name, label, type: 'text', ...o });
export const area = (name, label, o = {}) => ({ name, label, type: 'textarea', span: 2, ...o });
export const n = (name, label, o = {}) => ({ name, label, type: 'number', min: 0, ...o });
export const calc = (name, label, o = {}) => ({ name, label, type: 'number', readOnly: true, ...o });
export const date = (name, label, o = {}) => ({ name, label, type: 'date', ...o });
export const sel = (name, label, options, o = {}) => ({ name, label, type: 'select', options, ...o });
export const bool = (name, label, o = {}) => ({ name, label, type: 'boolean', ...o });
export const ref = (name, label, refModel, o = {}) => ({ name, label, type: 'ref', ref: refModel, ...o });
export const table = (name, label, fields, o = {}) => ({ name, label, type: 'table', fields, span: 2, ...o });
export const tags = (name, label, o = {}) => ({ name, label, type: 'tags', ...o });

/** Sequential status flow helper → { statuses, transitions } */
export function flow(seq, branches = {}) {
  const transitions = {};
  seq.forEach((s, i) => {
    transitions[s] = [...new Set([...(seq[i + 1] ? [seq[i + 1]] : []), ...(branches[s] || [])])];
  });
  Object.entries(branches).forEach(([s, to]) => {
    transitions[s] = [...new Set([...(transitions[s] || []), ...to])];
  });
  const statuses = [...new Set([...seq, ...Object.values(branches).flat()])];
  return { statuses, transitions };
}
