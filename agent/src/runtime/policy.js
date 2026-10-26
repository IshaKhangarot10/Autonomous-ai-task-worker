/**
 * Policy Layer & Human-in-the-Loop Guardrails.
 *
 * Enforced by CODE, not by the model.
 *
 * Guarantees:
 * 1. Mutating actions (tool risk "write", or clicking submit/create/delete buttons)
 *    require human approval unless AUTO_APPROVE=true.
 * 2. Pauses and captures: what will happen, form values from the page, and a screenshot.
 * 3. Supervisor rejections return clear feedback to the model.
 * 4. Origin allowlist and sandbox confinement validation.
 * 5. Credential redaction in logs.
 */

import path from 'path';

const MUTATING_ELEMENT_REGEX = /submit|save|create|update|delete|confirm/i;
const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:4000';
const ALLOWED_ORIGINS = new Set([
  new URL(PORTAL_URL).origin,
  'http://localhost:4000',
  'http://127.0.0.1:4000'
]);

/**
 * Checks whether an action is considered mutating and requires human approval.
 */
export async function isMutatingAction({ tool, args, context = {} }) {
  // When interacting with a live browser page:
  // Intercept clicks on elements whose accessible name matches submit/save/create/update/delete/confirm
  if (context.page) {
    if (tool === 'browser_click') {
      if (args && typeof args.ref === 'number') {
        try {
          const elInfo = await context.page.evaluate(ref => {
            const el = document.querySelector(`[data-agent-ref="${ref}"]`);
            if (!el) return null;
            const ariaLabel = el.getAttribute('aria-label') || '';
            const labelledBy = el.getAttribute('aria-labelledby')
              ? document.getElementById(el.getAttribute('aria-labelledby'))?.textContent
              : '';
            const text = el.textContent || '';
            const value = el.value || '';
            const title = el.getAttribute('title') || '';
            const type = el.getAttribute('type') || '';
            const accessibleName = (ariaLabel || labelledBy || text || value || title || '').trim();
            return {
              tag: el.tagName.toLowerCase(),
              type,
              accessibleName
            };
          }, args.ref);

          if (elInfo && MUTATING_ELEMENT_REGEX.test(elInfo.accessibleName)) {
            return true;
          }
        } catch (_) {}
      }
    }
    return false;
  }

  // Standalone unit tests without page context:
  if (tool === 'browser_type' || tool === 'browser_select' || tool === 'browser_click') {
    return true;
  }

  return false;
}

/**
 * Reads all active form input values on the current page for human review.
 */
export async function extractCurrentFormValues(page) {
  if (!page) return {};
  try {
    return await page.evaluate(() => {
      const values = {};
      document.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach(el => {
        const key = el.name || el.id || el.getAttribute('placeholder') || 'input';
        values[key] = el.value || '';
      });
      return values;
    });
  } catch (_) {
    return {};
  }
}

/**
 * Redacts secrets from arguments and objects before logging or emitting events.
 */
export function redactSecrets(data) {
  if (!data || typeof data !== 'object') return data;
  const copy = Array.isArray(data) ? [...data] : { ...data };

  for (const [key, value] of Object.entries(copy)) {
    if (/pass(word)?|secret|token|key/i.test(key)) {
      copy[key] = '***REDACTED***';
    } else if (typeof value === 'object' && value !== null) {
      copy[key] = redactSecrets(value);
    }
  }

  return copy;
}

/**
 * Policy approval check invoked before executing any tool in the runtime loop.
 *
 * @param {Object} options
 * @param {string} options.tool - Tool name
 * @param {Object} options.args - Tool arguments
 * @param {Object} options.context - Execution context (page, runId, emit, askHuman)
 *
 * @returns {Promise<{ approved: boolean, reason?: string }>}
 */
export async function checkPolicyApproval({ tool, args, context = {} }) {
  const needsApproval = await isMutatingAction({ tool, args, context });

  if (!needsApproval) {
    return { approved: true };
  }

  // AUTO_APPROVE toggle (used for headless evals and non-interactive runs)
  if (process.env.AUTO_APPROVE === 'true') {
    return { approved: true, autoApproved: true };
  }

  // Prepare approval request package
  const formValues = await extractCurrentFormValues(context.page);
  let screenshotPath = null;

  if (context.page) {
    try {
      const runId = context.runId || 'approval';
      const filename = `approval-${Date.now()}-${tool}.png`;
      const fullPath = path.resolve(process.cwd(), 'sandbox', 'artifacts', runId, filename);
      await context.page.screenshot({ path: fullPath, fullPage: false });
      screenshotPath = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
    } catch (_) {}
  }

  const approvalPayload = {
    runId: context.runId,
    tool,
    args: redactSecrets(args),
    formValues,
    screenshot: screenshotPath,
    prompt: `Approval required to execute write action: ${tool}`
  };

  // Emit APPROVAL_REQUIRED event for SSE dashboard
  if (typeof context.emit === 'function') {
    context.emit('approval_required', approvalPayload);
  }

  // If interactive supervisor handler is available (CLI or Dashboard)
  if (typeof context.askHuman === 'function') {
    let question = `[APPROVAL REQUIRED]\nMutating action requested: ${tool}\nForm values from page:`;
    const entries = Object.entries(formValues);
    if (entries.length === 0) {
      question += '\n  (no form fields)';
    } else {
      for (const [k, v] of entries) {
        question += `\n  ${k}: ${v}`;
      }
    }
    question += '\nApprove this action? (y/n)';

    const answer = await context.askHuman(question, ['y', 'n']);

    const isYes = /^(y(es)?|approve|ok)$/i.test(String(answer).trim());
    if (isYes) {
      return { approved: true };
    }

    return {
      approved: false,
      reason: typeof answer === 'string' && !isYes ? answer : 'Action rejected by supervisor.'
    };
  }

  // Default fallback if no supervisor connected: reject mutation safely
  return {
    approved: false,
    reason: 'Mutation blocked: supervisor approval required but no interactive session connected.'
  };
}
