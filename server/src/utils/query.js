/** Escape user input for safe use inside a RegExp. */
export const escapeRegex = (s = '') => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parse pagination / sort params with sane limits. */
export function pageParams(q) {
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 1000);
  let sort = { createdAt: -1 };
  if (q.sort && /^[-\w.]+$/.test(q.sort)) {
    const desc = q.sort.startsWith('-');
    sort = { [q.sort.replace(/^-/, '')]: desc ? -1 : 1 };
  }
  return { page, limit, skip: (page - 1) * limit, sort };
}
