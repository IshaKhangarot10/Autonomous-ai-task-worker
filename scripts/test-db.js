/**
 * Quick smoke test: connects to both databases, creates a document
 * in each, reads it back, then cleans up.
 *
 * Run with: node scripts/test-db.js
 */

import 'dotenv/config';
import { getPortalDb, getAgentDb, closeAll } from '../shared/db.js';
import { getModels as getPortalModels } from '../portal/models/index.js';
import { getModels as getAgentModels } from '../agent/src/db/models.js';

async function main() {
  console.log('Testing database connections...\n');

  // ── Portal DB ──
  const portalDb = await getPortalDb();
  console.log(`  Portal DB name: ${portalDb.name}`);

  const { Vendor, Invoice, User } = await getPortalModels();
  console.log(`  Portal models registered: Vendor, Invoice, User`);

  // Insert a test vendor, read it back, then delete it.
  const testVendor = await Vendor.create({ name: '__test_vendor__', billingEmail: 'test@test.com' });
  const found = await Vendor.findById(testVendor._id);
  console.log(`  Test vendor created and read back: ${found.name} ✓`);
  await Vendor.deleteOne({ _id: testVendor._id });
  console.log(`  Test vendor cleaned up ✓\n`);

  // ── Agent DB ──
  const agentDb = await getAgentDb();
  console.log(`  Agent DB name: ${agentDb.name}`);

  const { Run, Step } = await getAgentModels();
  console.log(`  Agent models registered: Run, Step`);

  // Insert a test run, read it back, then delete it.
  const testRun = await Run.create({ goal: '__test_goal__' });
  const foundRun = await Run.findById(testRun._id);
  console.log(`  Test run created and read back: ${foundRun.goal} ✓`);
  await Run.deleteOne({ _id: testRun._id });
  console.log(`  Test run cleaned up ✓\n`);

  // ── Verify they are separate databases ──
  const portalCollections = await portalDb.db.listCollections().toArray();
  const agentCollections = await agentDb.db.listCollections().toArray();
  console.log(`  Portal collections: ${portalCollections.map(c => c.name).join(', ') || '(empty after cleanup)'}`);
  console.log(`  Agent  collections: ${agentCollections.map(c => c.name).join(', ') || '(empty after cleanup)'}`);
  console.log(`  Databases are separate: ${portalDb.name !== agentDb.name ? '✓' : '✗'}\n`);

  await closeAll();
  console.log('All tests passed! ✓');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
