/**
 * Agent Server — Express API & Server-Sent Events (SSE).
 *
 * Exposes:
 * - POST /api/runs: Start a new autonomous task run
 * - GET  /api/runs: List historical runs from MongoDB
 * - GET  /api/runs/:runId: Get details and all steps for a run
 * - GET  /api/runs/:runId/events: Live SSE stream of steps, plan, memory, approvals, questions
 * - POST /api/runs/:runId/approve: Submit supervisor approval or rejection
 * - POST /api/runs/:runId/answer: Submit supervisor answer to clarification question
 * - GET  /artifacts/*: Static file access for screenshots and reports
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { runTask } from './runtime/loop.js';
import { getRunModel, getStepModel } from './db/models.js';

const app = express();
const PORT = process.env.AGENT_PORT || 4001;
const WORKSPACE_ROOT = path.resolve(process.cwd());
const ARTIFACTS_DIR = path.join(WORKSPACE_ROOT, 'sandbox', 'artifacts');

// ── Middlewares ──
app.use(express.json());

// CORS configuration for the Next.js dashboard
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Serve generated run screenshots and artifacts statically
app.use('/artifacts', express.static(ARTIFACTS_DIR));

// ── Active Runs Memory State ──
// Map<runId, { listeners: Set<res>, pendingApproval: fn, pendingQuestion: fn, state: Object }>
const activeRuns = new Map();

function getOrCreateActiveRun(runId) {
  if (!activeRuns.has(runId)) {
    activeRuns.set(runId, {
      listeners: new Set(),
      pendingApproval: null,
      pendingQuestion: null,
      state: null,
      steps: []
    });
  }
  return activeRuns.get(runId);
}

function broadcastEvent(runId, eventName, data) {
  const active = activeRuns.get(runId);
  if (!active) return;

  const payload = JSON.stringify({ type: eventName, runId, ...data });
  const message = `data: ${payload}\n\n`;

  active.listeners.forEach(res => {
    try {
      res.write(message);
    } catch (_) {}
  });
}

// ── Endpoints ──

/**
 * POST /api/runs
 * Start an autonomous task.
 */
app.post('/api/runs', async (req, res) => {
  const { goal, maxSteps } = req.body;
  if (!goal || typeof goal !== 'string') {
    return res.status(400).json({ error: 'Goal string is required' });
  }

  const runId = `run-${Date.now()}-${uuidv4().slice(0, 6)}`;
  const active = getOrCreateActiveRun(runId);

  res.status(202).json({
    ok: true,
    runId,
    goal,
    message: 'Task initiated successfully'
  });

  // Launch task execution in background
  runTask({
    goal,
    runId,
    maxSteps: maxSteps ? parseInt(maxSteps, 10) : undefined,
    onStep: eventPayload => {
      if (eventPayload.type === 'step') {
        active.steps.push(eventPayload.step);
        broadcastEvent(runId, 'step', {
          step: eventPayload.step,
          plan: eventPayload.plan,
          memory: eventPayload.memory
        });
      } else if (eventPayload.type === 'event') {
        broadcastEvent(runId, eventPayload.event, eventPayload.payload);
      }
    },
    policyApproval: async ({ tool, args, context }) => {
      // Auto-approve flag check
      if (process.env.AUTO_APPROVE === 'true') {
        return { approved: true, autoApproved: true };
      }

      // Check if tool mutates
      const isMutating = tool === 'browser_type' || tool === 'browser_select' || tool === 'browser_click';
      if (!isMutating) return { approved: true };

      // Pause and broadcast approval card to dashboard
      let screenshotPath = null;
      if (context.page) {
        try {
          const filename = `approval-${Date.now()}.png`;
          const fullPath = path.join(ARTIFACTS_DIR, runId, filename);
          await context.page.screenshot({ path: fullPath });
          screenshotPath = `/artifacts/${runId}/${filename}`;
        } catch (_) {}
      }

      broadcastEvent(runId, 'approval_required', {
        tool,
        args,
        screenshot: screenshotPath,
        description: `Supervisor approval required for write action: ${tool}`
      });

      return new Promise(resolve => {
        active.pendingApproval = resolve;
      });
    },
    askHuman: async (question, options) => {
      // Pause and broadcast question to dashboard
      broadcastEvent(runId, 'human_question', {
        question,
        options
      });

      return new Promise(resolve => {
        active.pendingQuestion = resolve;
      });
    }
  }).then(result => {
    broadcastEvent(runId, 'task_finished', {
      status: result.status,
      summary: result.summary,
      claimedOutcome: result.claimedOutcome,
      stepCount: result.stepCount,
      evidenceRefs: result.evidenceRefs
    });
  }).catch(err => {
    broadcastEvent(runId, 'task_finished', {
      status: 'failed',
      summary: err.message,
      stepCount: active.steps.length
    });
  });
});

/**
 * GET /api/runs
 * Fetch past runs list from MongoDB.
 */
app.get('/api/runs', async (req, res) => {
  try {
    const RunModel = await getRunModel();
    const runs = await RunModel.find().sort({ startedAt: -1 }).limit(25).lean();
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/runs/:runId
 * Fetch full run details and steps.
 */
app.get('/api/runs/:runId', async (req, res) => {
  const { runId } = req.params;
  try {
    const RunModel = await getRunModel();
    const StepModel = await getStepModel();

    const run = await RunModel.findOne({ runId }).lean();
    const steps = await StepModel.find({ runId }).sort({ index: 1 }).lean();

    if (!run) {
      // If run is currently in memory
      const active = activeRuns.get(runId);
      if (active) {
        return res.json({
          run: { runId, status: 'running' },
          steps: active.steps
        });
      }
      return res.status(404).json({ error: 'Run not found' });
    }

    res.json({ run, steps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/runs/:runId/events
 * Server-Sent Events (SSE) live stream.
 */
app.get('/api/runs/:runId/events', (req, res) => {
  const { runId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const active = getOrCreateActiveRun(runId);
  active.listeners.add(res);

  // Send initial connection handshake
  res.write(`data: ${JSON.stringify({ type: 'connected', runId })}\n\n`);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch (_) {}
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    active.listeners.delete(res);
  });
});

/**
 * POST /api/runs/:runId/approve
 * Human supervisor decision on pending mutating action.
 */
app.post('/api/runs/:runId/approve', (req, res) => {
  const { runId } = req.params;
  const { approved = true, reason } = req.body;

  const active = activeRuns.get(runId);
  if (!active || !active.pendingApproval) {
    return res.status(400).json({ error: 'No action pending approval for this run' });
  }

  const resolver = active.pendingApproval;
  active.pendingApproval = null;

  resolver({ approved: Boolean(approved), reason: reason || (approved ? 'Approved' : 'Rejected') });

  broadcastEvent(runId, 'approval_resolved', { approved, reason });
  res.json({ ok: true, approved });
});

/**
 * POST /api/runs/:runId/answer
 * Human supervisor response to clarification question.
 */
app.post('/api/runs/:runId/answer', (req, res) => {
  const { runId } = req.params;
  const { answer } = req.body;

  if (!answer) {
    return res.status(400).json({ error: 'Answer is required' });
  }

  const active = activeRuns.get(runId);
  if (!active || !active.pendingQuestion) {
    return res.status(400).json({ error: 'No question pending clarification for this run' });
  }

  const resolver = active.pendingQuestion;
  active.pendingQuestion = null;

  resolver(String(answer));

  broadcastEvent(runId, 'question_answered', { answer });
  res.json({ ok: true, answer });
});

// ── Start Agent Server ──
app.listen(PORT, () => {
  console.log(`[agent] CentrAlign Agent Server running on http://localhost:${PORT}`);
  console.log(`[agent] Artifacts statically hosted at http://localhost:${PORT}/artifacts`);
});

export default app;
