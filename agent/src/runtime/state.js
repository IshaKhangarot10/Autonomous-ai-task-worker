/**
 * Runtime State Manager.
 *
 * Tracks plan, memory, step history, consecutive error counts, loop safety guards,
 * and context compaction (summarizing historical browser snapshots).
 */

export class AgentState {
  constructor({ runId, goal, maxSteps = 30 }) {
    this.runId = runId;
    this.goal = goal;
    this.maxSteps = maxSteps;

    this.stepIndex = 0;
    this.plan = [];
    this.memory = {};

    this.finished = false;
    this.finalStatus = null;
    this.finalSummary = '';
    this.claimedOutcome = {};
    this.evidenceRefs = [];

    // Loop reliability counters
    this.noProgressStreak = 0;
    this.consecutiveErrors = 0;
    this.recentActionSignatures = []; // tracks { sig, ok } to detect 3 repeated identical failures

    // Conversation message history for Gemini
    this.contents = [];
  }

  /**
   * Records a tool execution attempt to detect identical repeating failures.
   * Returns true if the exact same tool + args failed 3 times in a row.
   */
  recordActionAttempt(tool, args, isOk) {
    let cleanArgs;
    try {
      cleanArgs = JSON.stringify(args || {});
    } catch (_) {
      cleanArgs = '';
    }

    const sig = `${tool}:${cleanArgs}`;
    this.recentActionSignatures.push({ sig, isOk });

    if (!isOk) {
      this.consecutiveErrors++;
      // Check last 3 actions
      const last3 = this.recentActionSignatures.slice(-3);
      if (last3.length === 3 && last3.every(a => a.sig === sig && !a.isOk)) {
        return { isLoopStuck: true, tool };
      }
    } else {
      this.consecutiveErrors = 0;
    }

    return { isLoopStuck: false };
  }

  /**
   * Context compaction:
   * Keeps only the MOST RECENT browser_snapshot full result in history.
   * Replaces previous browser_snapshot responses with a compact one-line summary:
   * "[Snapshot taken of <url>: <title>]"
   * This prevents token bloat and keeps conversation fast and within limits.
   */
  compactSnapshotHistory() {
    let latestSnapshotFound = false;

    // Traverse contents from newest to oldest
    for (let i = this.contents.length - 1; i >= 0; i--) {
      const turn = this.contents[i];
      if (turn.role !== 'user' || !Array.isArray(turn.parts)) continue;

      for (let p = 0; p < turn.parts.length; p++) {
        const part = turn.parts[p];
        if (part.functionResponse && part.functionResponse.name === 'browser_snapshot') {
          if (!latestSnapshotFound) {
            // Keep the latest one in full
            latestSnapshotFound = true;
          } else {
            // Compact older snapshots to a brief summary
            const originalOutput = part.functionResponse.response?.output?.data || {};
            const url = originalOutput.url || 'page';
            const title = originalOutput.title || '';
            part.functionResponse.response = {
              output: {
                ok: true,
                data: `[Historical snapshot of ${url} (${title}) compacted. Use latest snapshot above for current elements.]`
              }
            };
          }
        }
      }
    }
  }

  /**
   * Returns a snapshot object of the current state for logging and UI.
   */
  toJSON() {
    return {
      runId: this.runId,
      goal: this.goal,
      stepIndex: this.stepIndex,
      finished: this.finished,
      finalStatus: this.finalStatus,
      finalSummary: this.finalSummary,
      plan: this.plan,
      memory: this.memory,
      claimedOutcome: this.claimedOutcome,
      evidenceRefs: this.evidenceRefs,
      consecutiveErrors: this.consecutiveErrors
    };
  }
}
