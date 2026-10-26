/**
 * Unit tests for eval runner checks:
 * 1. Fatal error or 0 steps -> marked FAIL regardless of DB check.
 * 2. Task 3 (duplicate) -> passes ONLY IF agent ran (>0 steps), called finish, and explicitly reports invoice already exists.
 * 3. Task 5 -> passes ONLY IF ask_human was actually called.
 */

import { verifyTaskOutcome } from '../agent/evals/run-evals.js';

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✕ ${name}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n--- Testing Requirement 1: Fatal Error or 0 Steps Must FAIL ---');

  // Req 1 test 1: null result
  const res1 = await verifyTaskOutcome({ id: 'task_1', expected: { type: 'invoice', invoiceNumber: 'GLX-2024-0112' } }, null);
  assert(res1.passed === false, 'null result fails immediately');

  // Req 1 test 2: stepCount = 0
  const res2 = await verifyTaskOutcome(
    { id: 'task_3', expected: { type: 'duplicate', invoiceNumber: 'INV-2041' } },
    { stepCount: 0, status: 'completed', summary: 'Invoice INV-2041 already exists' }
  );
  assert(res2.passed === false, 'Task 3 with 0 steps fails even if DB has record and summary mentions duplicate');

  // Req 1 test 3: runtime fatal error
  const res3 = await verifyTaskOutcome(
    { id: 'task_3', expected: { type: 'duplicate', invoiceNumber: 'INV-2041' } },
    { stepCount: 2, status: 'failed', summary: 'Runtime execution exception: Playwright crashed' }
  );
  assert(res3.passed === false, 'Fatal runtime error fails even if DB has record');

  // Req 1 test 4: status = failed on invoice task
  const res4 = await verifyTaskOutcome(
    { id: 'task_1', expected: { type: 'invoice', invoiceNumber: 'GLX-2024-0112' } },
    { stepCount: 15, status: 'failed', summary: 'Reached maximum step limit' }
  );
  assert(res4.passed === false, 'Task 1 with status failed fails');

  console.log('\n--- Testing Requirement 2: Task 3 (Duplicate) Strict Conditions ---');

  // Req 2 test 1: Valid duplicate detection with finish and explicit report
  // (Assuming portal has 1 record for INV-2041 from seed)
  const res5 = await verifyTaskOutcome(
    { id: 'task_3', expected: { type: 'duplicate', invoiceNumber: 'INV-2041' } },
    { stepCount: 4, status: 'completed', summary: 'Found that invoice INV-2041 already exists in portal records; avoided duplicate creation.' },
    { wasHumanAsked: false, finishCalled: true }
  );
  assert(res5.passed === true, 'Task 3 passes when steps > 0, finish called, and summary reports invoice already exists');

  // Req 2 test 2: Finish was NOT called
  const res6 = await verifyTaskOutcome(
    { id: 'task_3', expected: { type: 'duplicate', invoiceNumber: 'INV-2041' } },
    { stepCount: 4, status: 'running', summary: 'Invoice INV-2041 already exists' },
    { wasHumanAsked: false, finishCalled: false }
  );
  assert(res6.passed === false, 'Task 3 fails if finish was not called');

  // Req 2 test 3: Summary did NOT report that invoice already exists
  const res7 = await verifyTaskOutcome(
    { id: 'task_3', expected: { type: 'duplicate', invoiceNumber: 'INV-2041' } },
    { stepCount: 4, status: 'completed', summary: 'Done with invoice processing.' },
    { wasHumanAsked: false, finishCalled: true }
  );
  assert(res7.passed === false, 'Task 3 fails if summary does not explicitly report duplicate / already exists');

  // Req 2 test 4: Summary reports duplicate with "already logged"
  const res8 = await verifyTaskOutcome(
    { id: 'task_3', expected: { type: 'duplicate', invoiceNumber: 'INV-2041' } },
    { stepCount: 3, status: 'completed', summary: 'Invoice INV-2041 has already been logged in the portal.' },
    { wasHumanAsked: false, finishCalled: true }
  );
  assert(res8.passed === true, 'Task 3 passes with "already been logged" in summary');

  console.log('\n--- Testing Requirement 3: Task 5 Requires ask_human ---');

  // Req 3 test 1: Task 5 without ask_human fails
  const res9 = await verifyTaskOutcome(
    { id: 'task_5', expected: { type: 'invoice', invoiceNumber: 'AS-Q3-2024-044', mustAskHuman: true } },
    { stepCount: 5, status: 'completed', summary: 'Created invoice' },
    { wasHumanAsked: false, finishCalled: true }
  );
  assert(res9.passed === false, 'Task 5 fails when ask_human was NOT called');
  assert(res9.reason.includes('ask_human'), 'Task 5 failure reason explicitly mentions ask_human');

  // Req 3 test 2: Task 5 with ask_human called (DB check will fail if record not in DB, but human check passed)
  const res10 = await verifyTaskOutcome(
    { id: 'task_5', expected: { type: 'invoice', invoiceNumber: 'AS-Q3-2024-044', mustAskHuman: true } },
    { stepCount: 5, status: 'completed', summary: 'Created invoice after asking supervisor' },
    { wasHumanAsked: true, finishCalled: true }
  );
  // res10 will either fail because AS-Q3-2024-044 is not in DB or pass if it is. It should NOT fail on ask_human!
  assert(!res10.reason.includes('ask_human was not called'), 'Task 5 with wasHumanAsked=true does not fail on ask_human requirement');

  console.log(`\nEval check tests completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal in test runner:', err);
  process.exit(1);
});
