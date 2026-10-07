/** Adds fabric stock demo data (yarn, knitting, processing) to a database that already has demo jobs.
 *   npm run seed:stock
 */
import mongoose from 'mongoose';
import { connectDb } from '../config/db.js';
import { bootstrap } from '../services/bootstrap.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { seedStockDemo } from './stockDemo.js';
import { logger } from '../utils/logger.js';

async function main() {
  await connectDb();
  await bootstrap();
  const admin = await User.findOne({ role: (await Role.findOne({ isAdmin: true }))._id });
  const done = await seedStockDemo({ user: admin });
  logger.info(done ? 'Fabric stock demo data created (yarn inward, knitting, processing)' : 'Stock data already exists – skipped');
}
main().catch((e) => { logger.error(e); process.exitCode = 1; }).finally(() => mongoose.disconnect());
