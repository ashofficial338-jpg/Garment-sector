import express from 'express';
import { authenticate, requirePasswordFresh } from '../middleware/auth.js';
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
import { PERMISSION_MODULES } from '../services/permissions.js';
import { getSetting } from '../services/settings.js';

const api = express.Router();

api.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
api.use('/auth', authRoutes);

// Everything below requires a valid session and a non-temporary password
api.use(authenticate, requirePasswordFresh);
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
MODULE_LIST.forEach((def) => api.use(`/m/${def.key}`, crudRouter(def)));

export default api;
