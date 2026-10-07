import { ACTIONS, SYSTEM_PERMISSION_MODULES } from '../../../shared/constants.js';
import { MODULE_LIST } from '../../../shared/modules/index.js';

/** All permission-bearing modules (business modules + system modules). */
export const PERMISSION_MODULES = [
  ...SYSTEM_PERMISSION_MODULES,
  ...MODULE_LIST.map((m) => ({ key: m.key, title: m.title, group: m.group })),
];

const toObj = (m) => (m instanceof Map ? Object.fromEntries(m) : m || {});

/** Compute the effective permission map for a populated user (role must be populated). */
export function effectivePermissions(user) {
  if (user?.role?.isAdmin) {
    return { isAdmin: true, map: Object.fromEntries(PERMISSION_MODULES.map((m) => [m.key, [...ACTIONS]])) };
  }
  const role = toObj(user?.role?.permissions);
  const extra = toObj(user?.permissions);
  const revoked = toObj(user?.revoked);
  const map = {};
  PERMISSION_MODULES.forEach(({ key }) => {
    const set = new Set([...(role[key] || []), ...(extra[key] || [])]);
    (revoked[key] || []).forEach((a) => set.delete(a));
    if (set.size) map[key] = [...set];
  });
  return { isAdmin: false, map };
}

export function can(perms, moduleKey, action) {
  if (!perms) return false;
  if (perms.isAdmin) return true;
  return (perms.map[moduleKey] || []).includes(action);
}
