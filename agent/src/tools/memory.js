/**
 * Memory, planning, and task completion tools.
 *
 * These tools do not touch external systems; they maintain the agent's
 * internal belief state, multi-step plan, and trigger verification on completion.
 */

/**
 * update_plan: Model maintains and updates its structured execution plan.
 */
export async function updatePlan({ steps = [] }, context = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return {
      ok: false,
      error: {
        type: 'INVALID_PLAN',
        message: 'Plan must be an array of step objects with id, description, and status.',
        hint: 'Example: [{ id: "1", description: "Read inbox files", status: "completed" }]'
      }
    };
  }

  // Normalize step statuses
  const validStatuses = new Set(['pending', 'in_progress', 'completed', 'blocked', 'skipped']);
  const normalizedSteps = steps.map((s, idx) => ({
    id: String(s.id || idx + 1),
    description: String(s.description || ''),
    status: validStatuses.has(s.status) ? s.status : 'pending'
  }));

  if (context.state) {
    context.state.plan = normalizedSteps;
  }

  if (typeof context.emit === 'function') {
    context.emit('plan_updated', { plan: normalizedSteps });
  }

  return {
    ok: true,
    data: {
      stepCount: normalizedSteps.length,
      plan: normalizedSteps
    }
  };
}

/**
 * remember: Store extracted facts (e.g. invoiceNumber, vendor, amount) in memory.
 * Facts in memory are summarized and injected into every subsequent model prompt.
 */
export async function remember({ key, value }, context = {}) {
  if (!key || typeof key !== 'string') {
    return {
      ok: false,
      error: {
        type: 'INVALID_MEMORY_KEY',
        message: 'A string key is required for remember.',
        hint: 'Use descriptive keys like "invoice_number", "due_date", "vendor_name".'
      }
    };
  }

  if (!context.state) {
    context.state = { memory: {}, plan: [] };
  }
  if (!context.state.memory) {
    context.state.memory = {};
  }

  context.state.memory[key] = value;

  if (typeof context.emit === 'function') {
    context.emit('memory_updated', { key, value, memory: context.state.memory });
  }

  return {
    ok: true,
    data: {
      key,
      value,
      totalFacts: Object.keys(context.state.memory).length
    }
  };
}

/**
 * finish: Signal task completion, blockage, or failure with evidence references.
 * Calling finish triggers the independent verification stage in the runtime loop.
 */
export async function finish({ status, summary, claimed_outcome = {}, evidence_refs = [] }, context = {}) {
  const validStatuses = new Set(['completed', 'blocked', 'failed']);
  if (!validStatuses.has(status)) {
    return {
      ok: false,
      error: {
        type: 'INVALID_STATUS',
        message: `Invalid finish status "${status}". Must be completed, blocked, or failed.`,
        hint: 'Use "completed" when outcome is achieved, "blocked" if waiting on external factors, "failed" if unrecoverable.'
      }
    };
  }

  if (!summary || typeof summary !== 'string') {
    return {
      ok: false,
      error: {
        type: 'MISSING_SUMMARY',
        message: 'A detailed summary of the final outcome is required.',
        hint: 'Explain what was done, what values were entered, and what evidence confirms it.'
      }
    };
  }

  if (context.state) {
    context.state.finished = true;
    context.state.finalStatus = status;
    context.state.finalSummary = summary;
    context.state.claimedOutcome = claimed_outcome;
    context.state.evidenceRefs = evidence_refs;
  }

  if (typeof context.emit === 'function') {
    context.emit('task_finished', {
      status,
      summary,
      claimedOutcome: claimed_outcome,
      evidenceRefs: evidence_refs
    });
  }

  return {
    ok: true,
    data: {
      status,
      summary,
      claimed_outcome,
      evidence_refs
    }
  };
}
