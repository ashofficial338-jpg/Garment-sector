/** Users, roles & permissions, settings, audit trail, recycle bin. */
import express from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { Session } from '../models/Session.js';
import { AuditLog } from '../models/AuditLog.js';
import { permit, adminOnly, clearUserCache, scopeFromQuery } from '../middleware/auth.js';
import { runWithUnit, ALL_UNITS } from '../services/unitContext.js';
import { peekJobNo, setNextJobNo } from '../services/numbering.js';
import { DEFAULT_UNITS } from '../../../shared/constants.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex, pageParams } from '../utils/query.js';
import { audit } from '../services/audit.js';
import { diffObjects } from '../utils/diff.js';
import { PERMISSION_MODULES } from '../services/permissions.js';
import { ACTIONS } from '../../../shared/constants.js';
import { getAllSettings, setSetting, DEFAULTS } from '../services/settings.js';
import { PASSWORD_RULE, PASSWORD_HINT } from './auth.js';
import { MODULE_LIST } from '../../../shared/modules/index.js';
import { models } from '../modules/builder.js';
import { sendExport } from '../services/exporter.js';

const r = express.Router();

const cleanPerms = (p = {}) => {
  const out = {};
  Object.entries(p || {}).forEach(([k, acts]) => {
    if (!PERMISSION_MODULES.some((m) => m.key === k) || !Array.isArray(acts)) return;
    const valid = acts.filter((a) => ACTIONS.includes(a));
    if (valid.length) out[k] = [...new Set(valid)];
  });
  return out;
};

/**
 * Units a user may be given: Admin can assign any unit; other user managers only their own units.
 * Admin-role users always reach every unit, so their list is informational.
 */
function cleanUnits(req, units) {
  const valid = DEFAULT_UNITS.map((u) => u.code);
  const list = [...new Set((Array.isArray(units) ? units : []).filter((u) => valid.includes(u)))];
  const foreign = list.filter((u) => !req.units.includes(u));
  if (foreign.length) throw ApiError.forbidden(`You cannot assign unit ${foreign.join(', ')}`);
  return list;
}

/* ------------------------------ Users ------------------------------ */
r.get('/users', permit('users', 'view'), asyncHandler(async (req, res) => {
  const filter = { isDeleted: req.perms.isAdmin && req.query.deleted === 'true' };
  // Admin sees every user (optionally one unit); other user managers only users of their current unit
  if (!req.perms.isAdmin) filter.units = req.unit;
  else if (req.query.unit && req.query.unit !== 'ALL') filter.units = req.query.unit;
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { department: rx }];
  }
  if (req.query.department) filter.department = req.query.department;
  const rows = await User.find(filter).populate('role', 'name isAdmin').sort({ name: 1 }).lean();
  res.json({ rows: rows.map(({ passwordHash, ...u }) => u), total: rows.length });
}));

r.post('/users', permit('users', 'create'), asyncHandler(async (req, res) => {
  const { name, email, password, role, department, phone, permissions, revoked } = req.body;
  if (!name || !email || !role) throw ApiError.badRequest('Name, email and role are required');
  const units = cleanUnits(req, req.body.units ?? [req.unit]);
  if (!PASSWORD_RULE.test(String(password || ''))) throw ApiError.badRequest(PASSWORD_HINT);
  const roleDoc = await Role.findById(role);
  if (!roleDoc) throw ApiError.badRequest('Role not found');
  if (roleDoc.isAdmin && !req.perms.isAdmin) throw ApiError.forbidden('Only Admin can create admin users');
  if (!roleDoc.isAdmin && !units.length) throw ApiError.badRequest('Assign at least one unit');
  const user = await User.create({
    name, email, phone, role, units, department: department || roleDoc.department || roleDoc.name,
    passwordHash: await bcrypt.hash(String(password), 12),
    permissions: req.perms.isAdmin ? cleanPerms(permissions) : {},
    revoked: req.perms.isAdmin ? cleanPerms(revoked) : {},
    mustChangePassword: true, createdBy: req.user._id,
  });
  await audit(req, { action: 'CREATE', module: 'users', record: { _id: user._id, refNo: user.email }, message: `${req.user.name} created user ${user.email} (${roleDoc.name}, units ${units.join(', ') || 'all'})` });
  res.status(201).json(user);
}));

r.put('/users/:id', permit('users', 'edit'), asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).populate('role');
  if (!user || user.isDeleted) throw ApiError.notFound();
  if (!req.perms.isAdmin && !(user.units || []).includes(req.unit)) throw ApiError.forbidden('User belongs to another unit');
  const before = { name: user.name, email: user.email, role: String(user.role?._id), department: user.department, units: (user.units || []).join(', '), isActive: user.isActive, permissions: Object.fromEntries(user.permissions), revoked: Object.fromEntries(user.revoked) };
  const { name, email, role, department, phone, isActive, permissions, revoked } = req.body;
  if (role && String(role) !== String(user.role?._id)) {
    const roleDoc = await Role.findById(role);
    if (!roleDoc) throw ApiError.badRequest('Role not found');
    if ((roleDoc.isAdmin || user.role?.isAdmin) && !req.perms.isAdmin) throw ApiError.forbidden('Only Admin can change admin roles');
    user.role = roleDoc._id;
  }
  if (String(user._id) === String(req.user._id) && isActive === false) throw ApiError.badRequest('You cannot disable your own account');
  if (name !== undefined) user.name = name;
  if (email !== undefined) user.email = email;
  if (department !== undefined) user.department = department;
  if (phone !== undefined) user.phone = phone;
  if (isActive !== undefined) user.isActive = !!isActive;
  if (req.body.units !== undefined) {
    // a non-admin manager can only add / remove their own units; other assignments are kept
    const keep = (user.units || []).filter((u) => !req.units.includes(u));
    user.units = [...new Set([...keep, ...cleanUnits(req, req.body.units)])];
    if (!user.units.length && !user.role?.isAdmin) throw ApiError.badRequest('Assign at least one unit');
  }
  if (req.perms.isAdmin && permissions !== undefined) user.permissions = cleanPerms(permissions);
  if (req.perms.isAdmin && revoked !== undefined) user.revoked = cleanPerms(revoked);
  await user.save();
  const after = { name: user.name, email: user.email, role: String(user.role?._id || user.role), department: user.department, units: (user.units || []).join(', '), isActive: user.isActive, permissions: Object.fromEntries(user.permissions), revoked: Object.fromEntries(user.revoked) };
  const changes = diffObjects(before, after);
  if (!user.isActive) await Session.updateMany({ user: user._id, revokedAt: null }, { revokedAt: new Date() });
  clearUserCache(user._id);
  await audit(req, { action: 'UPDATE', module: 'users', record: { _id: user._id, refNo: user.email }, changes, message: `${req.user.name} updated user ${user.email}` });
  res.json(user);
}));

r.post('/users/:id/reset-password', permit('users', 'edit'), asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).populate('role');
  if (!user) throw ApiError.notFound();
  if (user.role?.isAdmin && !req.perms.isAdmin) throw ApiError.forbidden();
  if (!PASSWORD_RULE.test(String(req.body.password || ''))) throw ApiError.badRequest(PASSWORD_HINT);
  user.passwordHash = await bcrypt.hash(String(req.body.password), 12);
  user.mustChangePassword = true; user.passwordChangedAt = new Date(); user.lockUntil = null; user.failedLogins = 0;
  await user.save();
  clearUserCache(user._id);
  await Session.updateMany({ user: user._id, revokedAt: null }, { revokedAt: new Date() });
  await audit(req, { action: 'PASSWORD_RESET', module: 'users', record: { _id: user._id, refNo: user.email }, message: `${req.user.name} reset password for ${user.email}` });
  res.json({ ok: true });
}));

r.delete('/users/:id', permit('users', 'delete'), asyncHandler(async (req, res) => {
  if (String(req.params.id) === String(req.user._id)) throw ApiError.badRequest('You cannot delete your own account');
  const user = await User.findById(req.params.id).populate('role');
  if (!user || user.isDeleted) throw ApiError.notFound();
  if (user.role?.isAdmin && !req.perms.isAdmin) throw ApiError.forbidden();
  user.isDeleted = true; user.isActive = false; user.deletedAt = new Date(); user.deletedBy = req.user._id;
  await user.save();
  clearUserCache(user._id);
  await Session.updateMany({ user: user._id, revokedAt: null }, { revokedAt: new Date() });
  await audit(req, { action: 'DELETE', module: 'users', record: { _id: user._id, refNo: user.email }, message: `${req.user.name} deleted user ${user.email}` });
  res.json({ ok: true });
}));

r.post('/users/:id/restore', adminOnly, asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { isDeleted: false, isActive: true, deletedAt: null }, { new: true });
  if (!user) throw ApiError.notFound();
  clearUserCache(user._id);
  await audit(req, { action: 'RESTORE', module: 'users', record: { _id: user._id, refNo: user.email }, message: `${req.user.name} restored user ${user.email}` });
  res.json(user);
}));

/* ------------------------------ Roles ------------------------------ */
r.get('/roles', permit('roles', 'view'), asyncHandler(async (_req, res) => {
  const roles = await Role.find().sort({ isAdmin: -1, name: 1 }).lean();
  const counts = await User.aggregate([{ $match: { isDeleted: false } }, { $group: { _id: '$role', n: { $sum: 1 } } }]);
  const map = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  res.json({ rows: roles.map((x) => ({ ...x, users: map[String(x._id)] || 0 })), modules: PERMISSION_MODULES, actions: ACTIONS });
}));

r.post('/roles', adminOnly, asyncHandler(async (req, res) => {
  const { name, department, description, permissions, dashboard } = req.body;
  if (!name) throw ApiError.badRequest('Role name is required');
  const role = await Role.create({ name, department, description, dashboard, permissions: cleanPerms(permissions) });
  await audit(req, { action: 'CREATE', module: 'roles', record: { _id: role._id, refNo: role.name }, message: `${req.user.name} created role ${role.name}` });
  res.status(201).json(role);
}));

r.put('/roles/:id', adminOnly, asyncHandler(async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) throw ApiError.notFound();
  if (role.isAdmin) throw ApiError.badRequest('The Admin role always has full access and cannot be edited');
  const before = { name: role.name, description: role.description, permissions: Object.fromEntries(role.permissions) };
  ['name', 'department', 'description', 'dashboard'].forEach((k) => { if (req.body[k] !== undefined) role[k] = req.body[k]; });
  if (req.body.permissions) role.permissions = cleanPerms(req.body.permissions);
  await role.save();
  clearUserCache(); // role permissions changed for everyone holding it
  const after = { name: role.name, description: role.description, permissions: Object.fromEntries(role.permissions) };
  await audit(req, { action: 'UPDATE', module: 'roles', record: { _id: role._id, refNo: role.name }, changes: diffObjects(before, after), message: `${req.user.name} updated permissions of role ${role.name}` });
  res.json(role);
}));

r.delete('/roles/:id', adminOnly, asyncHandler(async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) throw ApiError.notFound();
  if (role.isSystem) throw ApiError.badRequest('System roles cannot be deleted');
  if (await User.exists({ role: role._id, isDeleted: false })) throw ApiError.badRequest('Role is assigned to users');
  await role.deleteOne();
  clearUserCache();
  await audit(req, { action: 'DELETE', module: 'roles', record: { _id: role._id, refNo: role.name }, message: `${req.user.name} deleted role ${role.name}` });
  res.json({ ok: true });
}));

/* ------------------------------ Settings / workflow ------------------------------ */
r.get('/settings', permit('settings', 'view'), asyncHandler(async (_req, res) => res.json(await getAllSettings())));

r.put('/settings/:key', adminOnly, asyncHandler(async (req, res) => {
  const { key } = req.params;
  if (!(key in DEFAULTS)) throw ApiError.badRequest('Unknown setting');
  if (key === 'units') throw ApiError.badRequest('Use Units & job numbering to change units');
  const before = (await getAllSettings())[key];
  const value = await setSetting(key, req.body.value, req.user._id);
  await audit(req, { action: 'SETTINGS', module: 'settings', changes: [{ field: key, old: before, new: value }], message: `${req.user.name} updated ${key} settings` });
  res.json(value);
}));

/* ------------------------------ Units & job number series (Admin) ------------------------------ */
r.get('/units', permit('settings', 'view'), asyncHandler(async (_req, res) => {
  const units = await getAllSettings().then((s) => s.units);
  const rows = await runWithUnit(ALL_UNITS, () => Promise.all(units.map(async (u) => ({
    ...u,
    nextJobNo: await peekJobNo(u.code),
    jobs: await models.orders.countDocuments({ businessUnit: u.code, isDeleted: false, parentJob: null }),
    openJobs: await models.orders.countDocuments({ businessUnit: u.code, isDeleted: false, parentJob: null, status: { $nin: ['Closed', 'Cancelled'] } }),
    users: await User.countDocuments({ isDeleted: false, units: u.code }),
  }))));
  res.json({ rows });
}));

r.put('/units/:code', adminOnly, asyncHandler(async (req, res) => {
  const units = (await getAllSettings()).units;
  const unit = units.find((u) => u.code === req.params.code);
  if (!unit) throw ApiError.notFound('Unknown unit');
  const name = String(req.body.name ?? unit.name).trim();
  if (!name) throw ApiError.badRequest('Unit name is required');
  if (units.some((u) => u.code !== unit.code && u.name.toLowerCase() === name.toLowerCase())) throw ApiError.conflict('Another unit has this name');
  const changes = [];
  if (name !== unit.name) changes.push({ field: 'name', old: unit.name, new: name });
  if (req.body.nextJobNo !== undefined && req.body.nextJobNo !== '') {
    const before = await peekJobNo(unit.code);
    const next = Number(req.body.nextJobNo);
    try { await setNextJobNo(unit.code, next); } catch (e) { throw ApiError.badRequest(e.message); }
    if (next !== before) changes.push({ field: 'nextJobNo', old: `${unit.prefix}-${before}`, new: `${unit.prefix}-${next}` });
  }
  await setSetting('units', units.map((u) => (u.code === unit.code ? { ...u, name } : u)), req.user._id);
  clearUserCache();
  if (changes.length) await audit(req, { action: 'SETTINGS', module: 'settings', changes, message: `${req.user.name} updated ${unit.code} (${changes.map((c) => `${c.field} ${c.old} → ${c.new}`).join('; ')})` });
  res.json({ ok: true });
}));

/* ------------------------------ Audit trail ------------------------------ */
r.get('/audit', permit('audit', 'view'), scopeFromQuery, asyncHandler(async (req, res) => {
  const f = {};
  if (req.query.module) f.module = req.query.module;
  if (req.query.action) f.action = req.query.action;
  if (req.query.jobNo) f.jobNo = req.query.jobNo;
  if (req.query.recordId && mongoose.isValidObjectId(req.query.recordId)) f.recordId = req.query.recordId;
  if (req.query.user && mongoose.isValidObjectId(req.query.user)) f.user = req.query.user;
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), 'i');
    f.$or = [{ message: rx }, { refNo: rx }, { jobNo: rx }, { userName: rx }];
  }
  if (req.query.from || req.query.to) {
    f.createdAt = {};
    if (req.query.from) f.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) { const t = new Date(req.query.to); t.setHours(23, 59, 59, 999); f.createdAt.$lte = t; }
  }
  if (req.query.format) {
    if (!req.perms.isAdmin && !(req.perms.map.audit || []).includes('export')) throw ApiError.forbidden();
    const rows = await AuditLog.find(f).sort({ createdAt: -1 }).limit(20000).lean();
    return sendExport(res, req.query.format, [
      { key: 'createdAt', label: 'Date/Time' }, { key: 'userName', label: 'User' }, { key: 'action', label: 'Action' },
      { key: 'module', label: 'Module' }, { key: 'jobNo', label: 'Job No' }, { key: 'refNo', label: 'Ref' },
      { key: 'message', label: 'Message' }, { key: 'reason', label: 'Reason' }, { key: 'ip', label: 'IP' },
    ], rows.map((x) => ({ ...x, createdAt: new Date(x.createdAt).toISOString().replace('T', ' ').slice(0, 19) })), 'audit-trail');
  }
  const { page, limit, skip } = pageParams(req.query);
  const [rows, total] = await Promise.all([AuditLog.find(f).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), AuditLog.countDocuments(f)]);
  res.json({ rows, total, page, limit, pages: Math.ceil(total / limit) });
}));

/* ------------------------------ Recycle bin ------------------------------ */
r.get('/recycle-bin', adminOnly, asyncHandler(async (_req, res) => {
  const out = [];
  for (const def of MODULE_LIST) {
    const rows = await models[def.key].find({ isDeleted: true }).sort({ deletedAt: -1 }).limit(200).lean();
    rows.forEach((x) => out.push({ module: def.key, moduleTitle: def.title, _id: x._id, refNo: x.refNo || x.jobNo, jobNo: x.jobNo, deletedAt: x.deletedAt, deleteReason: x.deleteReason, label: x.styleNo || x.name || x.fabricType || x.sampleType || '' }));
  }
  out.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
  res.json({ rows: out });
}));

export default r;
