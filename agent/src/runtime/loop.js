/**
 * Autonomous AI Task Worker — Core Runtime Loop.
 *
 * Implements: Goal -> Understand -> Plan -> Execute -> Observe -> Adapt -> Verify -> Complete
 *
 * Manual loop without external frameworks:
 * - Direct Gemini API orchestration
 * - Reliability rules: repeated failure detection, error streak safety cutoffs
 * - Context compaction of historical DOM snapshots
 * - Independent verification integration (Phase 6)
 * - Artifact reporting (report.md, report.json)
 * - Mongoose persistence for Runs and Steps
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { callGemini } from '../llm/gemini.js';
import { getGeminiToolDeclarations, executeTool } from '../tools/registry.js';
import { WORKER_SYSTEM_PROMPT, buildInitialPrompt, buildStateContext } from './prompts.js';
import { AgentState } from './state.js';
import { getRunModel, getStepModel } from '../db/models.js';
import { checkPolicyApproval } from './policy.js';
import { runIndependentVerification } from './verifier.js';

const WORKSPACE_ROOT = path.resolve(process.cwd());
const MAX_STEPS_DEFAULT = parseInt(process.env.MAX_STEPS || '30', 10);
const MAX_RUN_TIME_MS = parseInt(process.env.MAX_RUN_TIME_MS || '300000', 10); // 5 mins

/**
 * Helper to infer execution phase for UI and step logging.
 */
function inferPhase(toolName, state) {
  if (toolName === 'update_plan') return 'plan';
  if (toolName === 'finish') return 'complete';
  if (toolName === 'browser_snapshot' || toolName === 'list_files') return 'observe';
  if (toolName === 'read_file' && state.stepIndex <= 3) return 'understand';
  if (toolName === 'http_get' && state.plan.some(s => s.status === 'completed')) return 'verify';
  if (state.consecutiveErrors > 0) return 'adapt';
  return 'execute';
}

/**
 * Redacts potential credentials or huge blobs from argument logs.
 */
function sanitizeArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const sanitized = { ...args };
  if (sanitized.password) sanitized.password = '***REDACTED***';
  return sanitized;
}

/**
 * Discovers available context files in sandbox/context/ for initial prompt.
 */
async function getAvailableContextFiles() {
  const contextDir = path.join(WORKSPACE_ROOT, 'sandbox', 'context');
  try {
    const files = await readdir(contextDir);
    return files.filter(f => !f.startsWith('.')).map(f => `sandbox/context/${f}`);
  } catch (_) {
    return [];
  }
}

/**
 * Writes markdown and JSON run reports to sandbox/artifacts/<runId>/
 */
async function generateRunReports({ state, steps, runDoc, artifactsDir }) {
  await mkdir(artifactsDir, { recursive: true });

  const durationSec = ((Date.now() - runDoc.startedAt.getTime()) / 1000).toFixed(1);

  // 1. report.json
  const reportData = {
    runId: state.runId,
    goal: state.goal,
    status: state.finalStatus || 'unknown',
    summary: state.finalSummary,
    durationSeconds: parseFloat(durationSec),
    stepCount: steps.length,
    plan: state.plan,
    memory: state.memory,
    claimedOutcome: state.claimedOutcome,
    evidenceRefs: state.evidenceRefs,
    steps: steps.map(s => ({
      index: s.index,
      phase: s.phase,
      tool: s.tool,
      args: s.args,
      summary: s.resultSummary,
      durationMs: s.durationMs,
      screenshot: s.screenshot
    }))
  };

  await writeFile(
    path.join(artifactsDir, 'report.json'),
    JSON.stringify(reportData, null, 2),
    'utf-8'
  );

  // 2. report.md
  let md = `# CentrAlign Autonomous Task Worker — Run Report\n\n`;
  md += `**Run ID:** \`${state.runId}\`  \n`;
  md += `**Status:** **${(state.finalStatus || 'UNKNOWN').toUpperCase()}**  \n`;
  md += `**Duration:** ${durationSec}s | **Steps Taken:** ${steps.length} / ${state.maxSteps}  \n`;
  md += `**Goal:** ${state.goal}\n\n`;

  md += `## Outcome Summary\n\n${state.finalSummary || 'No summary provided.'}\n\n`;

  if (state.claimedOutcome && Object.keys(state.claimedOutcome).length > 0) {
    md += `## Claimed Outcome\n\n\`\`\`json\n${JSON.stringify(state.claimedOutcome, null, 2)}\n\`\`\`\n\n`;
  }

  if (state.plan && state.plan.length > 0) {
    md += `## Execution Plan\n\n`;
    state.plan.forEach(step => {
      const icon = step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '▶' : '○';
      md += `- [${icon}] **${step.id}. ${step.description}** (${step.status})\n`;
    });
    md += `\n`;
  }

  if (state.memory && Object.keys(state.memory).length > 0) {
    md += `## Extracted Facts (Memory)\n\n`;
    for (const [key, val] of Object.entries(state.memory)) {
      md += `- **${key}**: \`${JSON.stringify(val)}\`\n`;
    }
    md += `\n`;
  }

  md += `## Steps Timeline\n\n`;
  md += `| # | Phase | Tool | Duration | Result Summary |\n`;
  md += `|---|---|---|---|---|\n`;
  steps.forEach(s => {
    md += `| ${s.index} | \`${s.phase}\` | **${s.tool}** | ${s.durationMs}ms | ${s.resultSummary.replace(/\|/g, '-')} |\n`;
  });
  md += `\n`;

  if (state.evidenceRefs && state.evidenceRefs.length > 0) {
    md += `## Evidence Artifacts\n\n`;
    state.evidenceRefs.forEach(ref => {
      md += `- \`${ref}\`\n`;
    });
    md += `\n`;
  }

  await writeFile(path.join(artifactsDir, 'report.md'), md, 'utf-8');
}

/**
 * Runs an autonomous task end-to-end.
 *
 * @param {Object} options
 * @param {string} options.goal - The natural language instruction from the user
 * @param {string} [options.runId] - Unique ID for this run (defaults to generated UUID)
 * @param {number} [options.maxSteps] - Max allowable steps
 * @param {Function} [options.onStep] - Callback fired on each step (for CLI or SSE streaming)
 * @param {Function} [options.askHuman] - Interactive human callback for ask_human tool
 * @param {Function} [options.policyApproval] - Approval hook for mutating actions (Phase 6)
 * @param {Function} [options.runVerifier] - Independent verification pass (Phase 6)
 *
 * @returns {Promise<Object>} Final run result
 */
export async function runTask({
  goal,
  runId = `run-${Date.now()}-${uuidv4().slice(0, 6)}`,
  maxSteps = MAX_STEPS_DEFAULT,
  onStep = null,
  askHuman = null,
  policyApproval = checkPolicyApproval,
  runVerifier = runIndependentVerification
}) {
  const startTime = Date.now();
  const artifactsDir = path.join(WORKSPACE_ROOT, 'sandbox', 'artifacts', runId);
  await mkdir(artifactsDir, { recursive: true });

  const state = new AgentState({ runId, goal, maxSteps });

  // 1. Initialize MongoDB Run document
  let RunModel, StepModel;
  let runDoc = null;
  try {
    RunModel = await getRunModel();
    StepModel = await getStepModel();
    runDoc = await RunModel.create({
      runId,
      goal,
      status: 'running',
      startedAt: new Date()
    });
  } catch (err) {
    console.warn(`[runtime] MongoDB logging notice: ${err.message}`);
    runDoc = { startedAt: new Date() };
  }

  // 2. Launch persistent Playwright browser for this run
  const headless = process.env.HEADLESS === 'true';
  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : 50
  });
  const browserContext = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await browserContext.newPage();

  // Execution context shared across all tools in this run
  const context = {
    page,
    runId,
    state,
    askHuman,
    emit: (event, payload) => {
      if (onStep) onStep({ type: 'event', event, payload, runId });
    }
  };

  const steps = [];
  let lastVerifierResult = null;
  const geminiTools = getGeminiToolDeclarations();
  const availableFiles = await getAvailableContextFiles();

  // 3. Prepare initial user message
  const initialUserPrompt = buildInitialPrompt({ goal, availableFiles });
  state.contents.push({
    role: 'user',
    parts: [{ text: initialUserPrompt }]
  });

  try {
    // 4. Main Autonomous Loop
    while (state.stepIndex < state.maxSteps && !state.finished) {
      // Check time budget
      if (Date.now() - startTime > MAX_RUN_TIME_MS) {
        state.finished = true;
        state.finalStatus = 'failed';
        state.finalSummary = `Run exceeded maximum time budget of ${MAX_RUN_TIME_MS / 1000}s.`;
        break;
      }

      // Check consecutive error limit
      if (state.consecutiveErrors >= 5) {
        state.finished = true;
        state.finalStatus = 'failed';
        state.finalSummary = 'Terminated: 5 consecutive tool execution errors without progress.';
        break;
      }

      // Context compaction: compress historical browser snapshots
      state.compactSnapshotHistory();

      // Dynamic memory and plan status injected before call
      const statePrefix = buildStateContext(state);
      const systemInstruction = statePrefix
        ? `${WORKER_SYSTEM_PROMPT}\n\nCURRENT WORKING STATE:\n${statePrefix}`
        : WORKER_SYSTEM_PROMPT;

      // Call Gemini LLM
      const response = await callGemini({
        contents: state.contents,
        systemInstruction,
        tools: geminiTools
      });

      // Handle text-only response (no tool call)
      if (!response.functionCalls || response.functionCalls.length === 0) {
        state.noProgressStreak++;
        state.contents.push({
          role: 'model',
          parts: [{ text: response.text || '(empty response)' }]
        });

        if (state.noProgressStreak >= 3) {
          state.finished = true;
          state.finalStatus = 'failed';
          state.finalSummary = 'Terminated: Model made 3 consecutive text responses without calling any action tool.';
          break;
        }

        // Nudge model to take action
        state.contents.push({
          role: 'user',
          parts: [{ text: 'Please continue by selecting a tool to execute your plan, or call finish if you have completed the task.' }]
        });
        continue;
      }

      // Reset no-progress streak on tool call
      state.noProgressStreak = 0;

      // Record model response in conversation history
      state.contents.push({
        role: 'model',
        parts: response.rawParts
      });

      // Process each function call in this turn
      const functionResponseParts = [];

      for (const fc of response.functionCalls) {
        state.stepIndex++;
        const stepIndex = state.stepIndex;
        const toolName = fc.name;
        const toolArgs = fc.args || {};
        const phase = inferPhase(toolName, state);
        const stepStart = Date.now();

        // Policy approval check for mutating/sensitive actions (Phase 6 hook)
        if (typeof policyApproval === 'function') {
          const approval = await policyApproval({ tool: toolName, args: toolArgs, context });
          if (!approval.approved) {
            const rejectedResult = {
              ok: false,
              error: {
                type: 'POLICY_REJECTED',
                message: `Action rejected by policy or supervisor: ${approval.reason || 'Not approved'}`,
                hint: 'Adjust your approach or request approval with different parameters.'
              }
            };
            functionResponseParts.push({
              functionResponse: {
                name: toolName,
                response: { output: rejectedResult }
              }
            });
            continue;
          }
        }

        // Execute tool safely
        const result = await executeTool(toolName, toolArgs, context);
        const durationMs = Date.now() - stepStart;
        const isOk = Boolean(result.ok);

        // Check for stuck loop (same tool + same args failing 3 times)
        const loopCheck = state.recordActionAttempt(toolName, toolArgs, isOk);

        // Summary generation for this step
        let resultSummary = '';
        if (isOk) {
          if (toolName === 'browser_snapshot') {
            resultSummary = `Observed page: "${result.data?.title || ''}" (${result.data?.elements?.length || 0} interactive elements)`;
          } else if (toolName === 'browser_navigate') {
            resultSummary = `Navigated to ${result.data?.url || ''}: ${result.data?.whatChanged || 'OK'}`;
          } else if (toolName === 'read_file') {
            resultSummary = `Read ${result.data?.path} (${result.data?.length} chars)`;
          } else if (toolName === 'remember') {
            resultSummary = `Remembered fact: ${result.data?.key}`;
          } else if (toolName === 'update_plan') {
            resultSummary = `Updated plan: ${result.data?.stepCount} steps`;
          } else if (toolName === 'finish') {
            resultSummary = `Signaled finish (${result.data?.status}): ${result.data?.summary}`;
          } else {
            resultSummary = result.data?.whatChanged || 'Tool executed successfully';
          }
        } else {
          resultSummary = `Error [${result.error?.type}]: ${result.error?.message}`;
        }

        let screenshotPath = null;
        if (toolName === 'browser_screenshot' && result.ok) {
          screenshotPath = result.data?.path;
        }

        const stepRecord = {
          runId,
          index: stepIndex,
          phase,
          tool: toolName,
          args: sanitizeArgs(toolArgs),
          resultSummary,
          result,
          screenshot: screenshotPath,
          durationMs,
          createdAt: new Date()
        };

        steps.push(stepRecord);

        // Save Step to MongoDB
        if (StepModel) {
          try {
            await StepModel.create(stepRecord);
          } catch (_) {}
        }

        // Notify caller (CLI or SSE dashboard)
        if (onStep) {
          onStep({
            type: 'step',
            step: stepRecord,
            plan: state.plan,
            memory: state.memory
          });
        }

        // If loop is stuck on identical failures, inject recovery guidance
        let finalToolResult = result;
        if (loopCheck.isLoopStuck) {
          finalToolResult = {
            ok: false,
            error: {
              type: 'APPROACH_FAILED_REPEATEDLY',
              message: `This exact action (${toolName}) has failed 3 times in a row. This approach is not working.`,
              hint: 'Stop repeating this command. Check page state with browser_snapshot, try an alternative method, or ask the human supervisor with ask_human.'
            }
          };
        }

        functionResponseParts.push({
          functionResponse: {
            name: toolName,
            response: { output: finalToolResult }
          }
        });

        // If finish tool was called and claimed completion
        if (toolName === 'finish' && isOk && toolArgs.status === 'completed') {
          // Independent verification pass (Phase 6 integration)
          if (typeof runVerifier === 'function') {
            const verifierResult = await runVerifier({
              goal,
              claimedOutcome: toolArgs.claimed_outcome,
              context
            });

            lastVerifierResult = verifierResult;
            if (runDoc) runDoc.verification = verifierResult;

            if (!verifierResult.verified) {
              // Verification failed: feed findings back to model to adapt
              state.finished = false;
              functionResponseParts[functionResponseParts.length - 1].functionResponse.response.output = {
                ok: false,
                error: {
                  type: 'VERIFICATION_FAILED',
                  message: `Independent verification check failed: ${verifierResult.notes || 'Outcome mismatch'}`,
                  hint: 'Address the verification discrepancies and ensure the record is correctly entered.'
                },
                checks: verifierResult.checks
              };
            }
          }
        }
      }

      // Add tool results as user turn to conversation history
      state.contents.push({
        role: 'user',
        parts: functionResponseParts
      });
    }

    // Default status if max steps reached without finish
    if (!state.finished) {
      state.finalStatus = 'failed';
      state.finalSummary = `Reached maximum step limit (${state.maxSteps}) without completing the task.`;
    }

    // FINAL OUTCOME may be COMPLETED only if verified === true
    if (state.finalStatus === 'completed') {
      if (!lastVerifierResult || !lastVerifierResult.verified) {
        state.finalStatus = 'failed';
        state.finalSummary = `${state.finalSummary || ''} (Outcome not verified by independent auditor)`.trim();
      }
    }
  } catch (err) {
    state.finalStatus = 'failed';
    state.finalSummary = `Runtime execution exception: ${err.message}`;
    console.error('[runtime] Fatal error during loop:', err);
  } finally {
    // Clean up browser
    await browser.close().catch(() => {});

    // Update MongoDB Run record
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - runDoc.startedAt.getTime();

    if (RunModel && runDoc._id) {
      try {
        await RunModel.findByIdAndUpdate(runDoc._id, {
          status: state.finalStatus,
          summary: state.finalSummary,
          plan: state.plan,
          memory: state.memory,
          claimedOutcome: state.claimedOutcome,
          stepCount: steps.length,
          errorCount: state.consecutiveErrors,
          finishedAt,
          durationMs
        });
      } catch (_) {}
    }

    // Write final run report artifacts
    await generateRunReports({ state, steps, runDoc, artifactsDir });
  }

  return {
    runId: state.runId,
    status: state.finalStatus,
    summary: state.finalSummary,
    stepCount: steps.length,
    plan: state.plan,
    memory: state.memory,
    claimedOutcome: state.claimedOutcome,
    evidenceRefs: state.evidenceRefs,
    artifactsDir,
    verified: Boolean(lastVerifierResult?.verified),
    verification: lastVerifierResult
  };
}
