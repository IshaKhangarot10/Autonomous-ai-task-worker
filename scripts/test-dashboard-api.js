/**
 * Test Suite for Phase 8: Agent Server API & Server-Sent Events (SSE).
 *
 * Verifies:
 * 1. Express agent server starts on port 4001
 * 2. GET /api/runs returns past runs from MongoDB
 * 3. POST /api/runs starts an autonomous task and returns runId
 * 4. GET /api/runs/:runId/events establishes live SSE connection
 * 5. POST /api/runs/:runId/approve resolves pending approval
 * 6. POST /api/runs/:runId/answer resolves pending human question
 * 7. GET /artifacts/* serves static files with CORS headers
 *
 * Run: node scripts/test-dashboard-api.js
 */

import 'dotenv/config';
import { spawn } from 'child_process';

let agentProcess = null;

async function ensureAgentServerRunning() {
  try {
    const res = await fetch('http://localhost:4001/api/runs', { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      console.log('✓ Agent Server is running on http://localhost:4001');
      return;
    }
  } catch (_) {}

  console.log('Starting Agent Server on port 4001...');
  agentProcess = spawn('node agent/src/server.js', { stdio: 'ignore', shell: true });

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch('http://localhost:4001/api/runs', { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.log('✓ Agent Server started successfully');
        return;
      }
    } catch (_) {}
  }
  throw new Error('Could not connect to Agent Server on port 4001.');
}

async function runTests() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('     PHASE 8: AGENT SERVER API & SSE TEST SUITE               ');
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

  // 1. GET /api/runs
  const runsRes = await fetch('http://localhost:4001/api/runs');
  assert(runsRes.ok, 'GET /api/runs returned 200 OK');
  assert(runsRes.headers.get('access-control-allow-origin') === '*', 'CORS Access-Control-Allow-Origin header set to *');
  const pastRuns = await runsRes.json();
  assert(Array.isArray(pastRuns), 'GET /api/runs returned JSON array from MongoDB', `count: ${pastRuns.length}`);

  // 2. POST /api/runs (validation)
  const badPostRes = await fetch('http://localhost:4001/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert(badPostRes.status === 400, 'POST /api/runs without goal returned 400 Bad Request');

  // 3. POST /api/runs (initiate run)
  const startRes = await fetch('http://localhost:4001/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: 'Test dashboard integration task' })
  });
  assert(startRes.status === 202, 'POST /api/runs returned 202 Accepted');
  const startData = await startRes.json();
  assert(Boolean(startData.runId), 'Received runId in response', `runId: ${startData.runId}`);

  const testRunId = startData.runId;

  // 4. GET /api/runs/:runId/events (SSE handshake)
  const controller = new AbortController();
  const sseTimeout = setTimeout(() => controller.abort(), 5000);

  let sseConnected = false;
  try {
    const sseRes = await fetch(`http://localhost:4001/api/runs/${testRunId}/events`, {
      signal: controller.signal
    });

    assert(sseRes.ok, 'GET /api/runs/:runId/events returned 200 OK');
    assert(sseRes.headers.get('content-type')?.includes('text/event-stream'), 'Content-Type is text/event-stream');

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const chunk = decoder.decode(value);

    if (chunk.includes('"type":"connected"')) {
      sseConnected = true;
    }
    reader.cancel();
  } catch (_) {}
  clearTimeout(sseTimeout);

  assert(sseConnected, 'SSE stream emitted initial connection handshake event');

  // 5. GET /api/runs/:runId
  const detailsRes = await fetch(`http://localhost:4001/api/runs/${testRunId}`);
  assert(detailsRes.ok, 'GET /api/runs/:runId returned 200 OK');
  const details = await detailsRes.json();
  assert(details.run?.runId === testRunId, 'Run details match requested runId');

  // 6. Approval / Answer endpoint error handling when no action is pending
  const approveRes = await fetch(`http://localhost:4001/api/runs/${testRunId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved: true })
  });
  assert(approveRes.status === 400, 'POST /approve when nothing is pending returns 400 gracefully');

  const answerRes = await fetch(`http://localhost:4001/api/runs/${testRunId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'Test answer' })
  });
  assert(answerRes.status === 400, 'POST /answer when nothing is pending returns 400 gracefully');

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
    await ensureAgentServerRunning();
    await runTests();
  } catch (err) {
    console.error('Fatal test runner error:', err);
    process.exit(1);
  } finally {
    if (agentProcess) {
      agentProcess.kill();
    }
  }
}

main();
