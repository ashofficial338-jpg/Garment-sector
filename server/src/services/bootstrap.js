/** First-run bootstrap: default roles, initial administrator (from env), default master data. */
import bcrypt from 'bcryptjs';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { models } from '../modules/builder.js';
import { DEFAULT_ROLES } from '../data/defaultRoles.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { UNITS, CURRENCIES, DEPARTMENTS } from '../../../shared/constants.js';
import { MODULE_LIST } from '../../../shared/modules/index.js';
import { Notification } from '../models/Notification.js';
import { AuditLog } from '../models/AuditLog.js';
import { DocumentFile } from '../models/Document.js';
import { backfillLedger } from './stockLedger.js';
import { PAYMENT_TERMS, INCOTERMS, TRIM_ITEMS } from '../../../shared/modules/commercial.js';
import { DEFECT_TYPES } from '../../../shared/modules/production.js';

export async function ensureRoles() {
  const existing = new Map((await Role.find({ name: { $in: DEFAULT_ROLES.map((r) => r.name) } })).map((d) => [d.name, d]));
  await Promise.all(DEFAULT_ROLES.map(async (r) => {
    const exists = existing.get(r.name);
    if (!exists) { await Role.create(r); return; }
    if (r.isAdmin && !exists.isAdmin) { exists.isAdmin = true; exists.isSystem = true; }
    // New modules added in later releases: grant their default permissions, but never touch
    // modules the role already has an entry for (keeps Admin's customisations).
    let changed = false;
    Object.entries(r.permissions || {}).forEach(([mod, acts]) => {
      if (!exists.permissions.has(mod)) { exists.permissions.set(mod, acts); changed = true; }
    });
    if (changed || exists.isModified()) await exists.save();
  }));
}

export async function ensureAdmin() {
  const adminRole = await Role.findOne({ isAdmin: true });
  const anyAdmin = await User.exists({ role: adminRole._id, isDeleted: false });
  if (anyAdmin) return;
  const { email, password, name } = env.admin;
  if (!email || !password) {
    logger.warn('No administrator exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set – skipping admin bootstrap');
    return;
  }
  await User.create({
    name, email: email.toLowerCase(), role: adminRole._id, department: 'Admin',
    passwordHash: await bcrypt.hash(password, 12), mustChangePassword: true,
  });
  logger.info(`Initial administrator created for ${email} (password change required on first login)`);
}

/** Default master lists – any master type that has no values yet gets its defaults (existing values are never touched). */
export async function ensureMasters() {
  const rows = [];
  // one running sequence for all seeded masters → unique refNo regardless of type names
  const add = (masterType, list, extra = () => ({})) => list.forEach((name) => rows.push({ masterType, name, code: String(name).slice(0, 12).toUpperCase(), refNo: `MST-${String(rows.length + 1).padStart(4, '0')}`, status: 'Active', ...extra(name) }));
  add('Size', ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL']);
  add('Color', ['White', 'Black', 'Navy', 'Grey Melange', 'Red', 'Royal Blue', 'Olive', 'Heather']);
  add('Garment Type', ['T-Shirt', 'Polo Shirt', 'Sweatshirt', 'Hoodie', 'Jogger', 'Shorts', 'Dress', 'Shirt', 'Trouser', 'Jacket']);
  add('Product Category', ['Knits', 'Wovens', 'Denim', 'Sweaters', 'Activewear', 'Kidswear', 'Innerwear']);
  add('Fabric', ['Single Jersey', 'Pique', 'Fleece', 'French Terry', 'Interlock', 'Rib 1x1', 'Poplin', 'Twill', 'Denim 12oz']);
  add('Trim', TRIM_ITEMS);
  add('Unit', UNITS);
  add('Currency', CURRENCIES);
  add('Payment Term', PAYMENT_TERMS);
  add('Shipment Term', INCOTERMS);
  add('Department', DEPARTMENTS);
  add('Operation', ['Shoulder join', 'Neck rib attach', 'Sleeve attach', 'Side seam', 'Bottom hem', 'Sleeve hem', 'Label attach']);
  add('Machine', ['Single Needle Lockstitch', 'Overlock 4T', 'Flatlock', 'Bartack', 'Button hole', 'Button stitch', 'Feed-off-arm']);
  add('Production Line', ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5', 'Line 6']);
  add('Floor', ['Floor 1', 'Floor 2']);
  add('Country', ['USA', 'United Kingdom', 'Germany', 'France', 'Spain', 'Netherlands', 'Japan', 'Australia', 'Canada', 'India', 'Bangladesh']);
  add('Wastage Rule', ['Knit fabric wastage', 'Woven fabric wastage', 'Trim wastage'], (n) => ({ value: n.startsWith('Knit') ? 5 : n.startsWith('Woven') ? 3 : 2, unit: '%' }));
  add('Cost Component', ['Fabric', 'Trims', 'CM', 'Washing', 'Printing', 'Embroidery', 'Testing', 'Freight', 'Commission', 'Overhead']);
  add('Season', ['Spring / Summer', 'Autumn / Winter', 'Holiday', 'Resort', 'Core / Basic']);
  add('Buyer Group', ['Europe', 'North America', 'UK', 'Asia Pacific', 'Domestic']);
  add('Fabric Composition', ['100% Cotton', '95% Cotton 5% Elastane', '60% Cotton 40% Polyester', '100% Polyester', '100% Viscose', '98% Cotton 2% Elastane']);
  add('Accessory', ['Button', 'Zipper', 'Elastic', 'Drawcord', 'Interlining', 'Shoulder Tape', 'Eyelet', 'Rivet']);
  add('Process', ['Knitting', 'Dyeing', 'Compacting', 'Printing', 'Embroidery', 'Garment Wash', 'Ironing', 'Thread Trimming']);
  add('Quality Parameter', ['Measurement within tolerance', 'Shade as approved', 'Seam strength', 'Colour fastness', 'Shrinkage', 'Pilling', 'Spirality', 'GSM']);
  add('Defect Type', DEFECT_TYPES);
  add('Warehouse', ['Main Fabric Store', 'Trims Store', 'Finished Goods Warehouse', 'Cut Panel Store']);
  add('Location', ['Rack A', 'Rack B', 'Rack C', 'Bulk Floor', 'Quarantine']);
  add('Tax Rate', ['GST 5%', 'GST 12%', 'GST 18%', 'Zero-rated export'], (n) => ({ value: Number((n.match(/\d+/) || [0])[0]), unit: '%' }));
  add('Port', ['Tuticorin', 'Chennai', 'Nhava Sheva', 'Mundra', 'Kolkata', 'Gothenburg', 'Felixstowe', 'Hamburg', 'Rotterdam', 'Los Angeles', 'Yokohama', 'Sydney']);
  const have = new Set(await models.master.distinct('masterType'));
  const fresh = rows.filter((r) => !have.has(r.masterType)).map((r) => ({ ...r, refNo: `MST-${r.masterType.replace(/\W+/g, '').slice(0, 6).toUpperCase()}-${r.refNo.slice(4)}` }));
  if (!fresh.length) return;
  await models.master.insertMany(fresh);
  logger.info(`Seeded ${fresh.length} master data records (${[...new Set(fresh.map((r) => r.masterType))].join(', ')})`);
}

/**
 * Two-unit upgrade: data created before units existed belongs to Unit-1 (its job numbers are kept),
 * and existing non-admin users keep working in Unit-1 until Admin assigns more units.
 */
export async function ensureUnits() {
  const missing = { businessUnit: { $exists: false } };
  const targets = [...MODULE_LIST.filter((d) => !d.sharedAcrossUnits).map((d) => models[d.key]), Notification, AuditLog, DocumentFile];
  // One round-trip per collection, all in parallel (sequential calls made startup take ~15 s on a remote DB)
  const [users, ...results] = await Promise.all([
    User.updateMany({ units: { $exists: false } }, { $set: { units: ['U1'] } }),
    ...targets.map((M) => M.updateMany(missing, { $set: { businessUnit: 'U1' } })),
  ]);
  const moved = results.reduce((n, r) => n + r.modifiedCount, 0);
  if (moved || users.modifiedCount) logger.info(`Units: ${moved} existing records and ${users.modifiedCount} users assigned to Unit-1`);
}

export async function bootstrap() {
  await ensureRoles();
  await ensureUnits();
  const posted = await backfillLedger();
  if (posted) logger.info(`Stock ledger: ${posted} opening movements posted from existing bookings`);
  await ensureAdmin();
  await ensureMasters();
}
