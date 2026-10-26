/**
 * Test Suite for Phase 6: Policy Layer & Independent Verifier.
 *
 * Verifies:
 * 1. Policy layer: mutation detection, secret redaction, supervisor approval flow, and AUTO_APPROVE mode.
 * 2. Independent verifier: real API query, field-by-field verification (vendor, amount, currency, due date),
 *    discrepancy detection, and duplicate invoice verification.
 *
 * Run: node scripts/test-policy-verifier.js
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import {
  isMutatingAction,
  redactSecrets,
  extractCurrentFormValues,
  checkPolicyApproval
} from '../agent/src/runtime/policy.js';
import { programmaticVerify } from '../agent/src/runtime/verifier.js';

let portalProcess = null;

async function ensurePortalRunning() {
  try {
    const res = await fetch('http://localhost:4000/api/vendors', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log('✓ Portal is running on http://localhost:4000');
      return;
    }
  } catch (_) {}

  console.log('Starting portal server for verification tests...');
  portalProcess = spawn('node portal/server.js', { stdio: 'ignore', shell: true });

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch('http://localhost:4000/api/vendors', { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.log('✓ Portal started successfully');
        return;
      }
    } catch (_) {}
  }
  throw new Error('Could not connect to portal server on port 4000.');
}

async function runTests() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('       PHASE 6: POLICY & VERIFIER TEST SUITE                  ');
  console.log('══════════════════════════════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✓ ${testName} ${details ? '(' + details + ')' : ''}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName} ${details ? '- ' + details : ''}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────
  // 1. POLICY LAYER: MUTATION DETECTION & REDACTION
  // ─────────────────────────────────────────────────────────
  console.log('── 1. Policy Layer: Mutation Detection & Secret Redaction ──');

  // Redaction
  const dirtyObj = {
    username: 'demo',
    password: 'superSecretPassword123',
    nested: { apiKey: 'mock-test-key-12345', token: 'secretToken' }
  };
  const cleaned = redactSecrets(dirtyObj);
  assert(cleaned.password === '***REDACTED***', 'Password redacted in logs');
  assert(cleaned.nested.apiKey === '***REDACTED***', 'Nested apiKey redacted');
  assert(cleaned.nested.token === '***REDACTED***', 'Nested token redacted');
  assert(cleaned.username === 'demo', 'Non-secret fields preserved');

  // Mutation detection on tools
  const typeMutates = await isMutatingAction({ tool: 'browser_type', args: { ref: 1, text: 'test' } });
  assert(typeMutates === true, 'browser_type flagged as mutating action');

  const selectMutates = await isMutatingAction({ tool: 'browser_select', args: { ref: 1, value: 'val' } });
  assert(selectMutates === true, 'browser_select flagged as mutating action');

  const snapshotMutates = await isMutatingAction({ tool: 'browser_snapshot', args: {} });
  assert(snapshotMutates === false, 'browser_snapshot is read-only (not mutating)');

  const httpGetMutates = await isMutatingAction({ tool: 'http_get', args: {} });
  assert(httpGetMutates === false, 'http_get is read-only (not mutating)');

  // ─────────────────────────────────────────────────────────
  // 2. POLICY APPROVAL FLOW (AUTO-APPROVE & SUPERVISOR REVIEW)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 2. Policy Approval Flow ──');

  // Auto-approve mode
  process.env.AUTO_APPROVE = 'true';
  const autoApproveRes = await checkPolicyApproval({
    tool: 'browser_type',
    args: { ref: 2, text: 'INV-100' },
    context: {}
  });
  assert(autoApproveRes.approved === true && autoApproveRes.autoApproved === true, 'AUTO_APPROVE=true automatically passes');

  // Supervisor review (Approve)
  process.env.AUTO_APPROVE = 'false';
  let supervisorPromptReceived = null;
  const mockContextApprove = {
    runId: 'test-policy-run',
    askHuman: async question => {
      supervisorPromptReceived = question;
      return 'Approve';
    }
  };

  const approvedRes = await checkPolicyApproval({
    tool: 'browser_type',
    args: { ref: 2, text: 'INV-100' },
    context: mockContextApprove
  });
  assert(approvedRes.approved === true, 'Supervisor approval accepted');
  assert(supervisorPromptReceived?.includes('browser_type'), 'Supervisor received action details');

  // Supervisor review (Reject with comment)
  const mockContextReject = {
    runId: 'test-policy-run',
    askHuman: async () => 'Reject: incorrect invoice number'
  };

  const rejectedRes = await checkPolicyApproval({
    tool: 'browser_type',
    args: { ref: 2, text: 'INV-100' },
    context: mockContextReject
  });
  assert(rejectedRes.approved === false, 'Supervisor rejection enforced in code');
  assert(rejectedRes.reason.includes('incorrect invoice number'), 'Supervisor rejection comment captured');

  // ─────────────────────────────────────────────────────────
  // 3. INDEPENDENT VERIFIER: REAL SYSTEM STATE AUDIT
  // ─────────────────────────────────────────────────────────
  console.log('\n── 3. Independent Verifier: Field-by-Field Audit ──');

  // Fetch an existing invoice from seed data to test verification
  const seedInvoicesRes = await fetch('http://localhost:4000/api/invoices');
  const seedInvoices = await seedInvoicesRes.json();
  const sampleInvoice = seedInvoices[0];

  assert(Boolean(sampleInvoice), 'Found seed invoice in portal for verification test');

  // Success Case: exact matching invoice
  const successfulClaim = {
    invoiceNumber: sampleInvoice.invoiceNumber,
    vendor: sampleInvoice.vendorId?.name || 'Globex Corporation',
    amount: sampleInvoice.amount,
    currency: sampleInvoice.currency,
    dueDate: new Date(sampleInvoice.dueDate).toISOString().split('T')[0]
  };

  const verifierSuccess = await programmaticVerify({
    goal: 'Enter invoice into portal',
    claimedOutcome: successfulClaim
  });

  assert(verifierSuccess.verified === true, 'Verifier marked genuine record as VERIFIED');
  assert(verifierSuccess.checks.length >= 4, 'Ran all field checks (record, vendor, amount, currency, due date)', `checks: ${verifierSuccess.checks.length}`);
  assert(verifierSuccess.checks.every(c => c.pass), 'Every individual field check passed');

  // Discrepancy Case: amount mismatch
  const mismatchedClaim = {
    ...successfulClaim,
    amount: sampleInvoice.amount + 500 // wrong amount!
  };

  const verifierAmountFail = await programmaticVerify({
    goal: 'Enter invoice into portal',
    claimedOutcome: mismatchedClaim
  });

  assert(verifierAmountFail.verified === false, 'Verifier rejected record with wrong amount');
  const amountCheck = verifierAmountFail.checks.find(c => c.what === 'Invoice Amount');
  assert(amountCheck && amountCheck.pass === false, 'Amount check explicitly marked as failed');

  // Non-existent invoice test
  const fakeClaim = {
    invoiceNumber: 'NON-EXISTENT-INV-999999',
    vendor: 'Globex Corporation',
    amount: 1000
  };
  const verifierNotFound = await programmaticVerify({
    goal: 'Enter invoice into portal',
    claimedOutcome: fakeClaim
  });
  assert(verifierNotFound.verified === false, 'Verifier rejected non-existent invoice');

  // ─────────────────────────────────────────────────────────
  // 4. DUPLICATE INVOICE VERIFICATION (TASK 3)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 4. Duplicate Invoice Audit ──');

  // Test INV-2041 duplicate check (should exist exactly once)
  const dupAudit = await programmaticVerify({
    goal: 'Log the invoice in the inbox with number INV-2041',
    claimedOutcome: {
      invoiceNumber: 'INV-2041',
      duplicateDetected: true
    }
  });

  assert(dupAudit.verified === true, 'Duplicate audit passed: exactly 1 invoice exists (no duplicate created)');
  assert(dupAudit.checks[0].pass === true, 'Duplicate check passed');

  // ─────────────────────────────────────────────────────────
  // 5. VENDOR EMAIL UPDATE VERIFICATION (TASK 4)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 5. Vendor Email Update Audit ──');

  const vendorAudit = await programmaticVerify({
    goal: 'Update Initech billing email to accounts@initech.example',
    claimedOutcome: {
      vendor: 'Initech',
      billingEmail: 'billing@initech.example' // Current seed email
    }
  });

  assert(vendorAudit.checks.some(c => c.what.includes('billing email')), 'Vendor email check executed against API');

  // ─────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('══════════════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
}

async function main() {
  try {
    await ensurePortalRunning();
    await runTests();
  } catch (err) {
    console.error('Fatal test runner error:', err);
    process.exit(1);
  } finally {
    if (portalProcess) {
      portalProcess.kill();
    }
  }
}

main();
