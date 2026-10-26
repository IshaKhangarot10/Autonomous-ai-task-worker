/**
 * End-to-end Manual Test for Phase 4: Tools & Registry (WITHOUT LLM).
 *
 * Verifies every single tool directly:
 * 1. Registry & Schemas: 15 tools registered, Gemini declarations generated, validation errors caught.
 * 2. File Tools: list_files, read_file (.txt & .pdf), path traversal defense.
 * 3. Memory & Planning: update_plan, remember, finish state tracking.
 * 4. Human-in-the-Loop: ask_human with supervisor handler.
 * 5. HTTP Tool: http_get allowlist checks and portal API lookup.
 * 6. Browser Tools: Playwright navigation, snapshot (refs & accessibility), login, typing by ref, screenshot artifact, stale ref defense, origin allowlist.
 *
 * Run: node scripts/test-tools.js
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import {
  getAllTools,
  getTool,
  executeTool,
  getGeminiToolDeclarations
} from '../agent/src/tools/registry.js';
import { closeStandaloneBrowser } from '../agent/src/tools/browser.js';

let portalProcess = null;

/** Ensure portal server is running on port 4000 */
async function ensurePortalRunning() {
  try {
    const res = await fetch('http://localhost:4000/api/vendors', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log('✓ Portal is running on http://localhost:4000');
      return;
    }
  } catch (_) {}

  console.log('Starting portal server for test...');
  portalProcess = spawn('node portal/server.js', {
    stdio: 'ignore',
    shell: true
  });

  // Wait up to 10s for portal to start
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
  throw new Error('Could not connect to portal server on port 4000. Please start it with: npm run portal');
}

async function runTests() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('        PHASE 4: TOOLS & REGISTRY TEST SUITE                  ');
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
  // 1. REGISTRY & GEMINI SCHEMA GENERATION
  // ─────────────────────────────────────────────────────────
  console.log('── 1. Registry & Tool Declarations ──');
  const allTools = getAllTools();
  assert(allTools.length === 15, 'All 15 tools registered', `found ${allTools.length}`);

  const geminiDecls = getGeminiToolDeclarations();
  assert(geminiDecls.length === 15, 'Gemini declarations generated for all tools');

  const snapshotDecl = geminiDecls.find(d => d.name === 'browser_snapshot');
  assert(snapshotDecl && snapshotDecl.parameters.type === 'OBJECT', 'browser_snapshot has OBJECT parameters');

  const typeDecl = geminiDecls.find(d => d.name === 'browser_type');
  assert(typeDecl && typeDecl.parameters.properties.ref.type === 'NUMBER', 'browser_type ref is NUMBER');
  assert(typeDecl && typeDecl.parameters.required.includes('ref'), 'browser_type requires ref');

  // Unknown tool
  const unknownRes = await executeTool('nonexistent_tool', {});
  assert(!unknownRes.ok && unknownRes.error?.type === 'UNKNOWN_TOOL', 'Unknown tool handled gracefully');

  // Validation failure (missing required argument)
  const badArgsRes = await executeTool('read_file', {});
  assert(!badArgsRes.ok && badArgsRes.error?.type === 'VALIDATION_ERROR', 'Missing required args caught by Zod');

  // ─────────────────────────────────────────────────────────
  // 2. FILESYSTEM TOOLS (SANDBOX CONFINED)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 2. Filesystem Tools ──');

  // list_files
  const listRes = await executeTool('list_files', { dir: 'sandbox/inbox' });
  assert(listRes.ok, 'list_files succeeded');
  assert(listRes.data?.total >= 6, 'list_files found inbox files', `total: ${listRes.data?.total}`);

  // read_file (.txt)
  const readTxtRes = await executeTool('read_file', { path: 'sandbox/inbox/globex_original.txt' });
  assert(readTxtRes.ok, 'read_file on .txt succeeded');
  assert(readTxtRes.data?.text.includes('GLX-2024-0112'), 'Globex text has invoice number GLX-2024-0112');
  assert(readTxtRes.data?.text.includes('October 20, 2024'), 'Globex text contains October date');

  // read_file (.pdf)
  const readPdfRes = await executeTool('read_file', { path: 'sandbox/inbox/acme-industries-oct.pdf' });
  assert(readPdfRes.ok, 'read_file on .pdf succeeded');
  assert(readPdfRes.data?.text.includes('AI-2024-0891'), 'PDF parsed and extracted invoice number AI-2024-0891');
  assert(readPdfRes.data?.text.includes('5,200.00'), 'PDF parsed and extracted amount $5,200.00');

  // Path traversal defense
  const traversalRes1 = await executeTool('read_file', { path: '../../package.json' });
  assert(!traversalRes1.ok && traversalRes1.error?.type === 'PATH_TRAVERSAL_BLOCKED', 'Path traversal blocked on read_file (../../)');

  const traversalRes2 = await executeTool('list_files', { dir: '../../' });
  assert(!traversalRes2.ok && traversalRes2.error?.type === 'PATH_TRAVERSAL_BLOCKED', 'Path traversal blocked on list_files (../../)');

  // ─────────────────────────────────────────────────────────
  // 3. MEMORY, PLANNING, AND FINISH TOOLS
  // ─────────────────────────────────────────────────────────
  console.log('\n── 3. Memory & Planning Tools ──');

  const testState = { memory: {}, plan: [], finished: false };
  const mockContext = { state: testState, runId: 'manual-test' };

  // update_plan
  const planRes = await executeTool('update_plan', {
    steps: [
      { id: '1', description: 'Inspect inbox files', status: 'completed' },
      { id: '2', description: 'Log invoice to portal', status: 'in_progress' }
    ]
  }, mockContext);
  assert(planRes.ok, 'update_plan succeeded');
  assert(testState.plan.length === 2, 'State plan updated', `steps: ${testState.plan.length}`);
  assert(testState.plan[0].status === 'completed', 'Step 1 marked completed');

  // remember
  const remRes = await executeTool('remember', {
    key: 'latest_invoice_number',
    value: 'GLX-2024-0112'
  }, mockContext);
  assert(remRes.ok, 'remember succeeded');
  assert(testState.memory.latest_invoice_number === 'GLX-2024-0112', 'State memory retained fact');

  // finish
  const finishRes = await executeTool('finish', {
    status: 'completed',
    summary: 'Successfully entered latest Globex invoice.',
    claimed_outcome: { invoiceNumber: 'GLX-2024-0112', amount: 4850 },
    evidence_refs: ['sandbox/artifacts/manual-test/screenshot-1.png']
  }, mockContext);
  assert(finishRes.ok, 'finish succeeded');
  assert(testState.finished === true, 'State finished flag set');
  assert(testState.claimedOutcome?.invoiceNumber === 'GLX-2024-0112', 'Claimed outcome stored in state');

  // ─────────────────────────────────────────────────────────
  // 4. HUMAN-IN-THE-LOOP TOOL
  // ─────────────────────────────────────────────────────────
  console.log('\n── 4. Human-in-the-Loop Tool ──');

  let supervisorAsked = false;
  const humanContext = {
    askHuman: async (question, options) => {
      supervisorAsked = true;
      return options ? options[0] : 'Supervisor confirmed';
    }
  };

  const humanRes = await executeTool('ask_human', {
    question: 'Multiple Acme vendors found. Which one should be selected?',
    options: ['Acme Supplies Inc.', 'Acme Industries']
  }, humanContext);
  assert(humanRes.ok, 'ask_human succeeded');
  assert(supervisorAsked, 'askHuman context handler was invoked');
  assert(humanRes.data?.answer === 'Acme Supplies Inc.', 'Supervisor answer returned');

  // ─────────────────────────────────────────────────────────
  // 5. HTTP TOOL (ALLOWLISTED)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 5. HTTP Tool ──');

  // Allowlisted portal query
  const httpRes = await executeTool('http_get', { url: 'http://localhost:4000/api/vendors' });
  assert(httpRes.ok, 'http_get to portal API succeeded');
  assert(Array.isArray(httpRes.data?.data) && httpRes.data.data.length >= 4, 'http_get retrieved vendors list', `${httpRes.data?.data?.length} vendors`);

  // Origin blocked
  const blockedHttpRes = await executeTool('http_get', { url: 'https://evil.example.com/api' });
  assert(!blockedHttpRes.ok && blockedHttpRes.error?.type === 'ORIGIN_NOT_ALLOWED', 'Non-allowlisted HTTP origin blocked');

  // ─────────────────────────────────────────────────────────
  // 6. BROWSER AUTOMATION (PLAYWRIGHT)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 6. Browser Automation Tools ──');

  // Blocked origin navigation
  const blockedNav = await executeTool('browser_navigate', { url: 'https://attacker.example.com' });
  assert(!blockedNav.ok && blockedNav.error?.type === 'ORIGIN_NOT_ALLOWED', 'Browser navigation to non-allowlisted origin blocked');

  // Navigate to login
  const navRes = await executeTool('browser_navigate', { url: 'http://localhost:4000/login' });
  assert(navRes.ok, 'browser_navigate to login page succeeded');

  // Snapshot on login page
  const snap1 = await executeTool('browser_snapshot', {});
  assert(snap1.ok, 'browser_snapshot succeeded');
  assert(snap1.data?.title.includes('Login'), 'Page title indicates Login');
  assert(snap1.data?.elements.length >= 3, 'Found interactive elements on login page', `count: ${snap1.data?.elements.length}`);

  // Test browser_login (runtime fills credentials without exposing password to agent)
  const loginRes = await executeTool('browser_login', { site: 'portal' });
  assert(loginRes.ok, 'browser_login succeeded');
  assert(loginRes.data?.url.includes('/invoices'), 'Redirected to invoices dashboard');

  // Snapshot on invoices page
  const snap2 = await executeTool('browser_snapshot', {});
  assert(snap2.ok, 'browser_snapshot on invoices page succeeded');
  const newInvoiceBtn = snap2.data?.elements.find(el => el.text?.includes('New Invoice') || el.label?.includes('New Invoice'));
  assert(Boolean(newInvoiceBtn), 'Found "New Invoice" button in snapshot');

  // Navigate to new invoice form
  await executeTool('browser_navigate', { url: 'http://localhost:4000/invoices/new' });
  const formSnap = await executeTool('browser_snapshot', {});
  assert(formSnap.ok, 'browser_snapshot on new invoice form succeeded');

  // Check form element refs
  const vendorSelect = formSnap.data?.elements.find(el => el.tag === 'select');
  const invNumberInput = formSnap.data?.elements.find(el => el.label?.includes('Invoice Number') || el.name === 'invoiceNumber');
  const amountInput = formSnap.data?.elements.find(el => el.label?.includes('Amount') || el.name === 'amount');
  assert(Boolean(vendorSelect), 'Vendor dropdown found by snapshot');
  assert(Boolean(invNumberInput), 'Invoice Number input found by snapshot');
  assert(Boolean(amountInput), 'Amount input found by snapshot');

  // Interact using refs discovered in snapshot (NO hardcoded CSS selectors!)
  if (invNumberInput) {
    const typeRes = await executeTool('browser_type', {
      ref: invNumberInput.ref,
      text: 'TEST-INV-9999'
    });
    assert(typeRes.ok, 'browser_type entered invoice number using ref');
  }

  // Stale ref test: interaction with non-existent ref must return STALE_REF
  const staleRes = await executeTool('browser_click', { ref: 99999 });
  assert(!staleRes.ok && staleRes.error?.type === 'STALE_REF', 'Stale ref properly detected and reported');

  // Screenshot capture
  const screenshotRes = await executeTool('browser_screenshot', { label: 'form_filled' }, mockContext);
  assert(screenshotRes.ok, 'browser_screenshot captured artifact');
  assert(screenshotRes.data?.path.includes('screenshot-'), 'Screenshot path saved in sandbox/artifacts');

  // Close browser
  await closeStandaloneBrowser();
  console.log('✓ Browser closed cleanly');

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
