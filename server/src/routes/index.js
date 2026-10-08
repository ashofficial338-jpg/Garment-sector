import express from 'express';
import mongoose from 'mongoose';
import { authenticate, requirePasswordFresh, requireUnit } from '../middleware/auth.js';
import { MODULE_LIST } from '../../../shared/modules/index.js';
import { crudRouter } from '../modules/crudRouter.js';
import authRoutes from './auth.js';
import adminRoutes from './admin.js';
import jobRoutes from './jobs.js';
import dashboardRoutes from './dashboard.js';
import notificationRoutes from './notifications.js';
import documentRoutes from './documents.js';
import searchRoutes from './search.js';
import reportRoutes from './reports.js';
import lookupRoutes from './lookup.js';
import quotationRoutes from './quotation.js';
import stockRoutes from './stock.js';
import analyticsRoutes from './analytics.js';
import { PERMISSION_MODULES } from '../services/permissions.js';
import { getSetting } from '../services/settings.js';

const api = express.Router();

// Health check for Render / uptime monitors – fails when the database is unreachable
api.get('/health', (_req, res) => {
  const db = mongoose.connection.readyState === 1;
  res.status(db ? 200 : 503).json({ ok: db, db: db ? 'connected' : 'disconnected', time: new Date().toISOString() });
});
api.use('/auth', authRoutes);

// Everything below requires a valid session, a non-temporary password and a selected unit,
// and runs scoped to that unit's data
api.use(authenticate, requirePasswordFresh, requireUnit);
api.get('/meta/permission-modules', (_req, res) => res.json(PERMISSION_MODULES));
api.get('/meta/company', async (_req, res, next) => { try { res.json(await getSetting('company')); } catch (e) { next(e); } });
api.use('/admin', adminRoutes);
api.use('/jobs', jobRoutes);
api.use('/dashboard', dashboardRoutes);
api.use('/notifications', notificationRoutes);
api.use('/documents', documentRoutes);
api.use('/search', searchRoutes);
api.use('/reports', reportRoutes);
api.use('/lookup', lookupRoutes);
api.use('/quotations', quotationRoutes);
api.use('/stock', stockRoutes);
api.use('/analytics', analyticsRoutes);
MODULE_LIST.forEach((def) => api.use(`/m/${def.key}`, crudRouter(def)));

export default api;
