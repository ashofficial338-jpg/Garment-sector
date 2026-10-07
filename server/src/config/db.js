import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * Database name to use when the connection string has none.
 * Atlas "Connect" strings look like mongodb+srv://user:pass@host/?appName=…  (no database) –
 * the driver would then silently use a database called "test".
 */
const DEFAULT_DB = process.env.MONGO_DB_NAME || 'garment_erp';

export function dbNameFromUri(uri) {
  const m = String(uri).match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

export async function connectDb() {
  mongoose.set('strictQuery', true);
  const explicit = dbNameFromUri(env.mongoUri);
  const options = { autoIndex: true, ...(explicit ? {} : { dbName: DEFAULT_DB }) };
  await mongoose.connect(env.mongoUri, options);
  logger.info(`MongoDB connected: ${mongoose.connection.name}${explicit ? '' : ' (no database in MONGO_URI – using default)'}`);
}
