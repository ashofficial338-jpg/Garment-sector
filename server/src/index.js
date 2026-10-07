import mongoose from 'mongoose';
import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import { createApp } from './app.js';
import { bootstrap } from './services/bootstrap.js';
import { startScheduler } from './services/scheduler.js';
import { logger } from './utils/logger.js';
import './modules/builder.js';

async function main() {
  await connectDb();
  await bootstrap();
  const app = createApp();
  const server = app.listen(env.port, () => logger.info(`Garment ERP API listening on http://localhost:${env.port}`));
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      logger.error(`Port ${env.port} is already in use – another API instance is probably running. Stop it (or change PORT in server/.env) and try again.`);
      process.exit(1);
    }
    throw e;
  });
  const timer = process.env.DISABLE_SCHEDULER !== 'true' ? startScheduler(30) : null;

  // Graceful shutdown (Render / containers send SIGTERM on deploy)
  const shutdown = (sig) => {
    logger.info(`${sig} received – shutting down`);
    clearInterval(timer);
    server.close(() => mongoose.disconnect().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  logger.error('Fatal startup error', e);
  process.exit(1);
});
