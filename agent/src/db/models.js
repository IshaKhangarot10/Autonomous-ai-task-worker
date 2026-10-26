/**
 * Mongoose Models for Agent Runs and Steps.
 *
 * Stored in the `agent_runs` database (isolated from the `acme_portal` company database).
 */

import mongoose from 'mongoose';
import { getAgentDb } from '../../../shared/db.js';

const StepSchema = new mongoose.Schema({
  runId: { type: String, required: true, index: true },
  index: { type: Number, required: true },
  phase: {
    type: String,
    enum: ['understand', 'plan', 'execute', 'observe', 'adapt', 'verify', 'complete'],
    default: 'execute'
  },
  tool: { type: String, required: true },
  args: { type: mongoose.Schema.Types.Mixed, default: {} },
  resultSummary: { type: String, default: '' },
  result: { type: mongoose.Schema.Types.Mixed, default: {} },
  screenshot: { type: String, default: null },
  durationMs: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const RunSchema = new mongoose.Schema({
  runId: { type: String, required: true, unique: true, index: true },
  goal: { type: String, required: true },
  status: {
    type: String,
    enum: ['running', 'completed', 'blocked', 'failed'],
    default: 'running'
  },
  plan: [
    {
      id: String,
      description: String,
      status: {
        type: String,
        enum: ['pending', 'in_progress', 'completed', 'blocked', 'skipped'],
        default: 'pending'
      }
    }
  ],
  memory: { type: mongoose.Schema.Types.Mixed, default: {} },
  claimedOutcome: { type: mongoose.Schema.Types.Mixed, default: {} },
  verification: { type: mongoose.Schema.Types.Mixed, default: null },
  summary: { type: String, default: '' },
  stepCount: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
  startedAt: { type: Date, default: Date.now },
  finishedAt: { type: Date, default: null },
  durationMs: { type: Number, default: 0 }
});

/**
 * Get or register the Run model on the agent_runs connection.
 */
export async function getRunModel() {
  const db = await getAgentDb();
  if (db.models.Run) return db.models.Run;
  return db.model('Run', RunSchema);
}

/**
 * Get or register the Step model on the agent_runs connection.
 */
export async function getStepModel() {
  const db = await getAgentDb();
  if (db.models.Step) return db.models.Step;
  return db.model('Step', StepSchema);
}
