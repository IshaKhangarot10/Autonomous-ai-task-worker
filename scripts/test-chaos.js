/**
 * Test Suite for Phase 7: Chaos Modes & Error Recovery.
 *
 * Verifies that the portal's 5 failure injection modes function properly
 * and that generic browser automation tools recover successfully:
 * 1. flaky_submit: First submit fails with 500 / Service unavailable; second succeeds.
 * 2. slow_load: Page shows loading indicator for 3s; browserSnapshot automatically waits for form.
 * 3. renamed_fields: "Supplier", "Reference No.", "Payment Due By" are discovered via snapshot refs.
 * 4. popup: "What's New" modal covers the page; dismissed via ref click.
 * 5. session_expiry: Session expires; recovered via browser_login.
 *
 * Run: node scripts/test-chaos.js
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import {
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserType,
  browserSelect,
  browserLogin,
  closeStandaloneBrowser
} from '../agent/src/tools/browser.js';
import { setRuntimeChaos } from '../portal/middleware/chaos.js';

let portalProcess = null;

async function ensurePortalRunning() {
  try {
    const res = await fetch('http://localhost:4000/api/vendors', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log('✓ Portal is running on http://localhost:4000');
      return;
    }
  } catch (_) {}

  console.log('Starting portal server for chaos tests...');
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

/** Helper: toggle chaos modes in running portal via POST /api/chaos */
async function setPortalChaos(modes = []) {
  setRuntimeChaos(new Set(modes));

  try {
    const res = await fetch('http://localhost:4000/api/chaos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modes })
    });
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('Failed to set chaos:', err.message);
  }
}

async function runTests() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('        PHASE 7: CHAOS MODES & RECOVERY TEST SUITE            ');
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

  // Initial login
  await browserLogin({ site: 'portal' });

  // ─────────────────────────────────────────────────────────
  // 1. CHAOS: RENAMED FIELDS
  // ─────────────────────────────────────────────────────────
  console.log('── 1. Chaos: Renamed Fields (Supplier, Reference No., Payment Due By) ──');
  await setPortalChaos(['renamed_fields']);

  await browserNavigate({ url: 'http://localhost:4000/invoices/new' });
  const snapRenamed = await browserSnapshot({});
  assert(snapRenamed.ok, 'browser_snapshot captured renamed form');

  const supplierSelect = snapRenamed.data?.elements.find(el => el.label === 'Supplier' || el.label?.includes('Supplier'));
  const refNoInput = snapRenamed.data?.elements.find(el => el.label === 'Reference No.' || el.label?.includes('Reference No.'));
  const paymentDueInput = snapRenamed.data?.elements.find(el => el.label === 'Payment Due By' || el.label?.includes('Payment Due By'));

  assert(Boolean(supplierSelect), 'Field "Supplier" discovered via label association', `ref: ${supplierSelect?.ref}`);
  assert(Boolean(refNoInput), 'Field "Reference No." discovered via label association', `ref: ${refNoInput?.ref}`);
  assert(Boolean(paymentDueInput), 'Field "Payment Due By" discovered via label association', `ref: ${paymentDueInput?.ref}`);

  // Test that elements with renamed labels can be interacted with using their refs
  if (refNoInput) {
    const typeRes = await browserType({ ref: refNoInput.ref, text: 'CHAOS-REF-001' });
    assert(typeRes.ok, 'Typed into "Reference No." field using ref number');
  }

  // ─────────────────────────────────────────────────────────
  // 2. CHAOS: POPUP MODAL
  // ─────────────────────────────────────────────────────────
  console.log('\n── 2. Chaos: Popup Modal ("What\'s New" overlay) ──');
  await setPortalChaos(['popup']);

  await browserNavigate({ url: 'http://localhost:4000/invoices/new' });
  const snapPopup = await browserSnapshot({});
  assert(snapPopup.ok, 'browser_snapshot captured page with popup');

  const modalAlert = snapPopup.data?.alerts.find(a => a.includes("What's New"));
  assert(Boolean(modalAlert), 'Popup modal alert text detected in snapshot');

  const dismissBtn = snapPopup.data?.elements.find(el => el.text === 'Got it!' || el.label === 'Got it!');
  assert(Boolean(dismissBtn), 'Found "Got it!" modal dismissal button', `ref: ${dismissBtn?.ref}`);

  if (dismissBtn) {
    const clickRes = await browserClick({ ref: dismissBtn.ref });
    assert(clickRes.ok, 'Clicked "Got it!" button by ref to dismiss modal');

    const snapAfterDismiss = await browserSnapshot({});
    const modalAfter = snapAfterDismiss.data?.alerts.find(a => a.includes("What's New"));
    assert(!modalAfter, 'Modal successfully removed from page after dismissal');
  }

  // ─────────────────────────────────────────────────────────
  // 3. CHAOS: SLOW LOAD (3-5s delayed render)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 3. Chaos: Slow Load (form renders with 3-5s delay) ──');
  await setPortalChaos(['slow_load']);

  await browserNavigate({ url: 'http://localhost:4000/invoices/new' });
  // browserSnapshot has built-in waiting for #loading-msg to settle
  const snapSlow = await browserSnapshot({});
  assert(snapSlow.ok, 'browser_snapshot waited for slow load');

  const formElementPresent = snapSlow.data?.elements.some(el => el.tag === 'input' || el.tag === 'select');
  assert(formElementPresent, 'Form elements present in snapshot after loading settled');

  // ─────────────────────────────────────────────────────────
  // 4. CHAOS: FLAKY SUBMIT (first submit returns error alert, retry succeeds)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 4. Chaos: Flaky Submit (transient 500 error & recovery) ──');
  await setPortalChaos(['flaky_submit']);

  const testInvNum = `FLAKY-${Date.now().toString().slice(-4)}`;

  await browserNavigate({ url: 'http://localhost:4000/invoices/new' });
  let snapForm = await browserSnapshot({});

  const vSelect = snapForm.data?.elements.find(el => el.tag === 'select');
  const invInput = snapForm.data?.elements.find(el => el.name === 'invoiceNumber' || el.label?.includes('Invoice Number') || el.label?.includes('Reference'));
  const amtInput = snapForm.data?.elements.find(el => el.name === 'amount' || el.label?.includes('Amount'));
  const curSelect = snapForm.data?.elements.find(el => el.name === 'currency' || el.label?.includes('Currency'));
  const dueInput = snapForm.data?.elements.find(el => el.name === 'dueDate' || el.label?.includes('Due'));
  const subBtn = snapForm.data?.elements.find(el => el.tag === 'button' && (el.text?.includes('Create') || el.label?.includes('Create')));

  if (vSelect) await browserSelect({ ref: vSelect.ref, value: 'Globex Corporation' });
  if (invInput) await browserType({ ref: invInput.ref, text: testInvNum });
  if (amtInput) await browserType({ ref: amtInput.ref, text: '2400' });
  if (curSelect) await browserSelect({ ref: curSelect.ref, value: 'USD' });
  if (dueInput) await browserType({ ref: dueInput.ref, text: '2024-11-25' });

  // First submit: fails with flaky service error
  if (subBtn) {
    await browserClick({ ref: subBtn.ref });
    const snapErr = await browserSnapshot({});
    const errorVisible = snapErr.data?.alerts.some(a => a.toLowerCase().includes('temporarily unavailable') || a.toLowerCase().includes('try again'));
    assert(errorVisible, 'First submission failed with "Service temporarily unavailable" alert as expected');

    // Second submit: retry succeeds
    const retryBtn = snapErr.data?.elements.find(el => el.tag === 'button' && (el.text?.includes('Create') || el.label?.includes('Create')));
    if (retryBtn) {
      // Re-fill form if redirected
      const retryInv = snapErr.data?.elements.find(el => el.name === 'invoiceNumber' || el.label?.includes('Invoice Number') || el.label?.includes('Reference'));
      if (retryInv && !retryInv.value) {
        const retryV = snapErr.data?.elements.find(el => el.tag === 'select');
        const retryAmt = snapErr.data?.elements.find(el => el.name === 'amount' || el.label?.includes('Amount'));
        const retryCur = snapErr.data?.elements.find(el => el.name === 'currency' || el.label?.includes('Currency'));
        const retryDue = snapErr.data?.elements.find(el => el.name === 'dueDate' || el.label?.includes('Due'));
        if (retryV) await browserSelect({ ref: retryV.ref, value: 'Globex Corporation' });
        await browserType({ ref: retryInv.ref, text: testInvNum });
        if (retryAmt) await browserType({ ref: retryAmt.ref, text: '2400' });
        if (retryCur) await browserSelect({ ref: retryCur.ref, value: 'USD' });
        if (retryDue) await browserType({ ref: retryDue.ref, text: '2024-11-25' });
      }

      await browserClick({ ref: retryBtn.ref });
      const snapSuccess = await browserSnapshot({});
      const successVisible = snapSuccess.data?.alerts.some(a => a.toLowerCase().includes('created successfully'));
      assert(successVisible, 'Second submission (retry) succeeded with "created successfully" alert');
    }
  }

  // ─────────────────────────────────────────────────────────
  // 5. CHAOS: SESSION EXPIRY (redirects to /login, re-logins)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 5. Chaos: Session Expiry (redirect to /login & re-authentication) ──');
  await setPortalChaos(['session_expiry']);

  // Navigate to /invoices/new to trigger session expiry
  await browserNavigate({ url: 'http://localhost:4000/invoices/new' });
  // Second navigation triggers the expiry redirection to /login
  const navTrigger = await browserNavigate({ url: 'http://localhost:4000/invoices/new' });

  const isAtLogin = navTrigger.data?.url.includes('/login');
  assert(isAtLogin, 'Session expired and redirected user to /login');

  // Agent recovers by calling browser_login
  const reLoginRes = await browserLogin({ site: 'portal' });
  assert(reLoginRes.ok, 'browser_login re-authenticated successfully');
  assert(reLoginRes.data?.url.includes('/invoices'), 'Redirected back to invoices after recovery');

  // Reset chaos back to none
  await setPortalChaos([]);
  await closeStandaloneBrowser();

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
