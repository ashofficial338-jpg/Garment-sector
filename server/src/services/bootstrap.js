/** First-run bootstrap: default roles, initial administrator (from env), default master data. */
import bcrypt from 'bcryptjs';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { models } from '../modules/builder.js';
import { DEFAULT_ROLES } from '../data/defaultRoles.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { UNITS, CURRENCIES, DEPARTMENTS } from '../../../shared/constants.js';
import { PAYMENT_TERMS, INCOTERMS, TRIM_ITEMS } from '../../../shared/modules/commercial.js';

export async function ensureRoles() {
  for (const r of DEFAULT_ROLES) {
    const exists = await Role.findOne({ name: r.name });
    if (!exists) await Role.create(r);
    else if (r.isAdmin && !exists.isAdmin) { exists.isAdmin = true; exists.isSystem = true; await exists.save(); }
  }
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

export async function ensureMasters() {
  if (await models.master.exists({})) return;
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
  await models.master.insertMany(rows);
  logger.info(`Seeded ${rows.length} master data records`);
}

export async function bootstrap() {
  await ensureRoles();
  await ensureAdmin();
  await ensureMasters();
}
