/**
 * Shared database connections for the project.
 *
 * WHY two databases:
 * - `acme_portal` holds the mock company data (invoices, vendors, users).
 *   The portal app reads/writes here, and the agent's verifier queries it.
 * - `agent_runs` holds the agent's own run logs, steps, and reports.
 *   This separation means the agent's bookkeeping never pollutes the
 *   "real" company database.
 *
 * Both databases live on the same MongoDB server (MONGODB_URI).
 * Mongoose's `createConnection` lets us open named connections to
 * different databases on the same server without conflicts.
 */

import mongoose from 'mongoose';

// Cache connections so multiple imports don't create duplicates.
let portalConn = null;
let agentConn = null;

/**
 * Returns a Mongoose connection to the `acme_portal` database.
 * Creates the connection on the first call, reuses it after that.
 */
export async function getPortalDb() {
  if (portalConn) return portalConn;

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  portalConn = mongoose.createConnection(`${uri}/acme_portal`);

  // Wait for the connection to be ready before returning.
  await portalConn.asPromise();
  console.log('[db] Connected to acme_portal');
  return portalConn;
}

/**
 * Returns a Mongoose connection to the `agent_runs` database.
 */
export async function getAgentDb() {
  if (agentConn) return agentConn;

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  agentConn = mongoose.createConnection(`${uri}/agent_runs`);

  await agentConn.asPromise();
  console.log('[db] Connected to agent_runs');
  return agentConn;
}

/**
 * Closes both database connections. Called during graceful shutdown.
 */
export async function closeAll() {
  const promises = [];
  if (portalConn) promises.push(portalConn.close());
  if (agentConn) promises.push(agentConn.close());
  await Promise.all(promises);
  portalConn = null;
  agentConn = null;
  console.log('[db] All connections closed');
}
