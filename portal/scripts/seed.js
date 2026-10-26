/**
 * Seed the portal database with initial data.
 *
 * Creates:
 * - 1 demo user (demo / demo123)
 * - 5 vendors (including two "Acme" variants for ambiguity testing)
 * - 3 existing invoices (one duplicates an inbox file to test duplicate detection)
 *
 * Run: npm run seed (or node portal/scripts/seed.js)
 *
 * WHY a separate seed script (not auto-seed on server start):
 * - Explicit control: you seed once, then the data persists.
 * - Evals call reset.js between runs to restore this exact state.
 * - Avoids race conditions when multiple services start concurrently.
 */

import 'dotenv/config';
import { getModels } from '../models/index.js';
import { closeAll } from '../../shared/db.js';

const VENDORS = [
  { name: 'Globex Corporation',  billingEmail: 'billing@globex.example',      address: '123 Innovation Drive, Springfield' },
  { name: 'Initech',            billingEmail: 'ap@initech.example',           address: '4120 Freidrich Lane, Austin TX' },
  { name: 'Acme Industries',    billingEmail: 'invoices@acmeindustries.example', address: '500 Industrial Blvd, Chicago IL' },
  { name: 'Acme Supplies',      billingEmail: 'accounts@acmesupplies.example',  address: '12 Commerce St, Dallas TX' },
  { name: 'Wayne Enterprises',  billingEmail: 'finance@wayne.example',       address: '1 Wayne Tower, Gotham City' },
];

const INVOICES = [
  {
    vendor: 'Globex Corporation',
    invoiceNumber: 'GLX-2024-0042',
    amount: 58750.00,
    currency: 'USD',
    dueDate: new Date('2024-08-15'),
    notes: 'Q2 consulting services',
    status: 'paid',
  },
  {
    vendor: 'Wayne Enterprises',
    invoiceNumber: 'WE-INV-1001',
    amount: 235000.00,
    currency: 'USD',
    dueDate: new Date('2024-09-30'),
    notes: 'Security system upgrade',
    status: 'approved',
  },
  {
    // This invoice has the same number as one of the inbox files.
    // The agent must detect this duplicate and report it, not create it again.
    vendor: 'Initech',
    invoiceNumber: 'INV-2041',
    amount: 42000.00,
    currency: 'INR',
    dueDate: new Date('2024-10-01'),
    notes: 'Already logged from email',
    status: 'logged',
  },
];

const USER = {
  username: process.env.PORTAL_USER || 'demo',
  password: process.env.PORTAL_PASS || 'demo123',
};

async function seed() {
  console.log('[seed] Starting...');

  const { Vendor, Invoice, User } = await getModels();

  // Clear existing data.
  await Promise.all([
    Vendor.deleteMany({}),
    Invoice.deleteMany({}),
    User.deleteMany({}),
  ]);
  console.log('[seed] Cleared existing data');

  // Insert vendors.
  await Vendor.insertMany(VENDORS);
  console.log(`[seed] Created ${VENDORS.length} vendors`);

  // Insert invoices.
  await Invoice.insertMany(INVOICES);
  console.log(`[seed] Created ${INVOICES.length} invoices`);

  // Insert user.
  await User.create(USER);
  console.log(`[seed] Created user: ${USER.username}`);

  await closeAll();
  console.log('[seed] Done ✓');
}

seed().catch(err => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
