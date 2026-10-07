import mongoose from 'mongoose';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { env } from './config/env.js';
import api from './routes/index.js';
import { notFound, errorHandler } from './middleware/error.js';

/** Strip Mongo operator keys ($…, dotted keys) from user input (NoSQL injection guard). */
function sanitizeInput(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) {
    if (k.startsWith('$') || k.includes('.')) delete obj[k];
    else sanitizeInput(obj[k]);
  }
  return obj;
}

export function createApp() {
  const app = express();
  // Number of reverse proxies in front of the app (Render = 1; Vercel rewrite → Render = 2)
  app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: env.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use((req, _res, next) => { sanitizeInput(req.body); sanitizeInput(req.query); next(); });
  app.use(morgan(env.isProd ? 'combined' : 'dev'));

  // Short health path (alias of /api/health) for hosting health checks / uptime monitors
  app.get('/health', (_req, res) => {
    const db = mongoose.connection.readyState === 1;
    res.status(db ? 200 : 503).json({ status: db ? 'OK' : 'DEGRADED', db: db ? 'connected' : 'disconnected', time: new Date().toISOString() });
  });

  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));
  app.use('/api', api);
  app.use('/api', notFound);

  // Serve the built React client in production
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    // API-only deployment (e.g. Render, frontend on Vercel): friendly landing response
    app.get('/', (_req, res) => res.json({ service: 'Garment ERP API', status: 'running', health: '/api/health' }));
  }
  app.use(errorHandler);
  return app;
}
