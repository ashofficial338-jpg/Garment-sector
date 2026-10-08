/**
 * Pre-production connectivity: Specification / BOM / Pattern / Marker progress is written back to
 * the T&A calendar (actual dates) and to the PP meeting readiness checklist, so nobody re-types it.
 */
import { models } from '../modules/builder.js';
import { MODULES, applyCompute } from '../../../shared/modules/index.js';

const PATTERN_DONE = ['Pattern Approved', 'Graded', 'Released'];

/** Stamp a T&A activity as completed today (only if it has no actual date yet). */
export async function completeTna(jobId, activity) {
  const tna = await models.tna.findOne({ job: jobId, isDeleted: false });
  const row = tna?.activities.find((a) => a.activity === activity);
  if (!row || row.actualDate) return;
  row.actualDate = new Date();
  row.progress = 'Completed';
  const next = applyCompute(MODULES.tna, tna.toObject());
  tna.set({ activities: next.activities, completedCount: next.completedCount, delayedCount: next.delayedCount, completionPct: next.completionPct, status: next.status });
  await tna.save();
}

/** PP meeting readiness (measurement / pattern / marker) derived from the actual records. */
export async function syncPpReadiness(jobId) {
  const live = { job: jobId, isDeleted: false };
  const [specs, patterns, markers] = await Promise.all([
    models.techSpec.find(live).select('status').lean(),
    models.pattern.find(live).select('status').lean(),
    models.marker.find(live).select('status').lean(),
  ]);
  const has = (rows, list) => rows.some((r) => list.includes(r.status));
  const state = (rows, done, ready) => {
    if (!rows.length) return undefined;
    if (has(rows, done)) return 'Approved';
    if (has(rows, ['Rejected'])) return 'Issue';
    if (has(rows, ready)) return 'Ready';
    return 'In Progress';
  };
  const set = {};
  const m = state(specs, ['Approved'], ['Submitted']);
  const p = state(patterns, PATTERN_DONE, ['Pattern Ready']);
  const k = state(markers, ['Approved', 'Issued to Cutting'], ['Submitted']);
  if (m) set.measurementApproval = m;
  if (p) set.patternStatus = p;
  if (k) set.markerStatus = k;
  if (Object.keys(set).length) await models.ppMeeting.updateMany({ ...live, status: 'Scheduled' }, { $set: set });
}

export { PATTERN_DONE };
