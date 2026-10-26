/**
 * Reset the portal database back to seed state.
 *
 * This is just a convenience alias that re-runs the seed script.
 * The seed script already clears all data before inserting, so
 * calling it again restores the exact initial state.
 *
 * Run: npm run reset (or node portal/scripts/reset.js)
 *
 * WHY: Evals run this between tasks so each test starts from
 * the same known state.
 */

// Just re-run seed — it's idempotent (clears then inserts).
import './seed.js';

// Reset runtime chaos modes on running portal if active
try {
  await fetch('http://localhost:4000/api/chaos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modes: [] })
  });
} catch (_) {}

