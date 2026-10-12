/**
 * Clear ALL business data – every transaction, buyer, supplier, master list, employee, document, notification,
 * stock movement and audit entry – and restart every number series (Unit-1 U1-1000, Unit-2 U2-3000).
 * Kept so the ERP stays usable: user accounts, sessions, roles & permissions, settings (units, workflow).
 * Default master lists (sizes, colours, units…) are re-created automatically on the next server start.
 *
 *   node src/scripts/clearData.js            dry run: counts what would be deleted
 *   node src/scripts/clearData.js --apply    full JSON backup to server/backups/, then delete
 */
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { connectDb } from '../config/db.js';

const KEEP = new Set(['users', 'sessions', 'roles', 'settings']);
const APPLY = process.argv.includes('--apply');
const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await connectDb();
  const db = mongoose.connection.db;
  const names = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
  const clear = names.filter((n) => !KEEP.has(n));
  const counts = {};
  for (const n of names) counts[n] = await db.collection(n).countDocuments();
  console.log(`Database: ${db.databaseName}`);
  console.log('Will delete:', clear.map((n) => `${n} ${counts[n]}`).join(', '));
  console.log('Will keep:  ', [...KEEP].filter((n) => names.includes(n)).map((n) => `${n} ${counts[n]}`).join(', '));
  if (!APPLY) { console.log('\nDry run only – re-run with --apply to back up and delete.'); await mongoose.disconnect(); return; }

  const dir = path.resolve(here, '../../backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `full-backup-before-clear-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const dump = {};
  for (const n of clear) dump[n] = await db.collection(n).find().toArray();
  fs.writeFileSync(file, JSON.stringify(dump));
  console.log(`\nBackup written: ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);

  for (const n of clear) await db.collection(n).deleteMany({});
  const left = {};
  for (const n of clear) left[n] = await db.collection(n).countDocuments();
  const notEmpty = Object.entries(left).filter(([, v]) => v);
  console.log(notEmpty.length ? `NOT EMPTY: ${JSON.stringify(left)}` : `Cleared ${clear.length} collections – all empty. Users, roles and settings kept.`);
  await mongoose.disconnect();
}

main().catch(async (e) => { console.error('FAILED:', e.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
