/**
 * Business units (Unit-1 / Unit-2): one ERP, separate operational data.
 *
 * Every request runs inside a unit context (AsyncLocalStorage). The `unitScoped` Mongoose plugin
 * reads it and transparently
 *   • adds `{ businessUnit }` to every query, update, count, distinct and aggregate, and
 *   • stamps `businessUnit` on every new document (`unit` is already used for units of measure),
 * so routes, hooks, background recalculations and services can never read or write another
 * unit's data. Consolidated (both-unit) reads run explicitly with `runWithUnit(ALL_UNITS, …)`.
 * Code running outside a request (bootstrap, scheduler, scripts) is unscoped and must pass units explicitly.
 */
import { AsyncLocalStorage } from 'async_hooks';

export const ALL_UNITS = '*';
const als = new AsyncLocalStorage();

export const currentUnit = () => als.getStore()?.unit;
// awaited inside the context, so a returned (lazy) Mongoose query still executes in this unit
export const runWithUnit = (unit, fn) => als.run({ unit }, async () => fn());

/** Express middleware: run the rest of the request inside the unit context. */
export const unitContext = (unit) => (_req, _res, next) => als.run({ unit }, next);

const QUERY_OPS = ['find', 'findOne', 'countDocuments', 'distinct', 'updateOne', 'updateMany', 'findOneAndUpdate',
  'findOneAndDelete', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany'];

export function unitScoped(schema) {
  schema.add({ businessUnit: { type: String, index: true } });
  const scoped = () => {
    const u = currentUnit();
    return u && u !== ALL_UNITS ? u : null;
  };
  function scopeQuery() {
    const u = scoped();
    if (u && this.getFilter().businessUnit === undefined) this.where({ businessUnit: u });
  }
  QUERY_OPS.forEach((op) => schema.pre(op, scopeQuery));
  schema.pre('aggregate', function scopeAggregate() {
    const u = scoped();
    if (u) this.pipeline().unshift({ $match: { businessUnit: u } });
  });
  schema.pre('validate', function stampUnit() {
    if (this.isNew && !this.businessUnit) {
      const u = scoped();
      if (u) this.businessUnit = u;
    }
  });
  schema.pre('insertMany', function stampMany(next, docs) {
    const u = scoped();
    if (u) (Array.isArray(docs) ? docs : [docs]).forEach((d) => { if (d && !d.businessUnit) d.businessUnit = u; });
    next();
  });
}
