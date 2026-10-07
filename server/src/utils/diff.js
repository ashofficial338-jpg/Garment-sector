/** Shallow diff of business fields between two plain objects → [{ field, old, new }] */
const IGNORE = new Set(['_id', '__v', 'updatedAt', 'createdAt', 'updatedBy', 'statusHistory', 'closureChecks']);
const norm = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && v._bsontype === 'ObjectId') return String(v);
  if (typeof v === 'object') return JSON.stringify(v, (k, x) => (k === '_id' ? undefined : x));
  return v;
};
export function diffObjects(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes = [];
  for (const k of keys) {
    if (IGNORE.has(k)) continue;
    const a = norm(before[k]);
    const b = norm(after[k]);
    if (String(a) !== String(b)) changes.push({ field: k, old: before[k] ?? null, new: after[k] ?? null });
  }
  return changes;
}
