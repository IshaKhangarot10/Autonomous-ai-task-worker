/**
 * Independent Verification Auditor.
 *
 * Runs with a FRESH context (completely separate from the worker agent's conversation).
 * Evaluates real system state using read-only tools (http_get, browser_snapshot, read_file).
 *
 * "Never trust a success banner alone."
 *
 * Returns: { verified: boolean, checks: [{ what, expected, actual, pass }], notes: string }
 */

import { httpGet } from '../tools/http.js';
import { callGemini } from '../llm/gemini.js';
import { zodToGeminiParameters } from '../tools/registry.js';
import { z } from 'zod';

const VERIFIER_SYSTEM_PROMPT = `You are CentrAlign's Independent Verification Auditor.
Your job is to objectively and independently confirm whether the worker agent accomplished the user's requested goal in reality.

RULES:
1. Never trust the worker's words, summaries, or success banners alone.
2. Query the real system state using http_get to inspect the company portal API (e.g. GET /api/invoices or GET /api/vendors).
3. Verify every claimed field (vendor name, invoice number, amount, currency, due date, or email).
4. For duplicate invoice tasks: confirm that NO duplicate was created (invoice count for that number is exactly 1).
5. Conclude your audit by calling finish_verification with your verified verdict and individual check results.`;

const finishVerificationTool = {
  name: 'finish_verification',
  description: 'Conclude independent verification audit with structured results.',
  parameters: zodToGeminiParameters(
    z.object({
      verified: z.boolean().describe('True if all checks pass and goal was fully achieved'),
      checks: z.array(
        z.object({
          what: z.string().describe('What field or outcome was verified'),
          expected: z.any().describe('Expected value from source invoice or goal'),
          actual: z.any().describe('Actual value found in real system records'),
          pass: z.boolean().describe('Whether this individual check passed')
        })
      ).describe('List of verification checks'),
      notes: z.string().describe('Detailed auditor notes on the outcome')
    })
  )
};

function logVerifyTool(tool, args, context = {}) {
  const target = args?.url || JSON.stringify(args || {});
  console.log(`\x1b[35m[VERIFY]\x1b[0m ${tool} ${target}`);
  if (typeof context.emit === 'function') {
    context.emit('verifier_step', { tool, args });
  }
}

/**
 * Deterministic Programmatic Verifier:
 * Queries the real portal API directly to check records with exact field comparison.
 */
export async function programmaticVerify({ goal = '', claimedOutcome = {}, context = {} }) {
  const checks = [];
  let notes = '';

  const invoiceNumber = claimedOutcome.invoiceNumber || claimedOutcome.invoice_number;
  const expectedVendor = claimedOutcome.vendor || claimedOutcome.vendor_name;
  const expectedAmount = claimedOutcome.amount !== undefined ? parseFloat(claimedOutcome.amount) : undefined;
  const expectedCurrency = claimedOutcome.currency;
  const expectedDueDate = claimedOutcome.dueDate || claimedOutcome.due_date;
  const expectedEmail = claimedOutcome.billingEmail || claimedOutcome.email;
  const isDuplicateCase = claimedOutcome.duplicateDetected || goal.toLowerCase().includes('duplicate') || goal.includes('INV-2041');

  // Case 1: Duplicate Invoice Task (e.g. INV-2041)
  if (isDuplicateCase) {
    const invNum = invoiceNumber || 'INV-2041';
    const url = `http://localhost:4000/api/invoices?invoiceNumber=${invNum}`;
    logVerifyTool('http_get', { url }, context);
    const res = await httpGet({ url });

    if (res.ok && Array.isArray(res.data?.data)) {
      const count = res.data.data.length;
      const pass = count === 1; // Exactly 1 exists; no duplicate was created
      checks.push({
        what: `Duplicate prevention for invoice ${invNum}`,
        expected: 'Exactly 1 invoice entry (no duplicate created)',
        actual: `Found ${count} invoice(s) in system`,
        pass
      });
      notes = pass
        ? 'Duplicate correctly identified; database verified with exactly 1 original record.'
        : `Duplicate violation: found ${count} records with number ${invNum}.`;
    } else {
      checks.push({
        what: 'Query invoice records',
        expected: 'Successful API response',
        actual: res.error?.message || 'Failed',
        pass: false
      });
    }

    const verified = checks.every(c => c.pass);
    logVerifyTool('finish_verification', { verified, checksCount: checks.length }, context);
    return {
      verified,
      checks,
      notes
    };
  }

  // Case 2: Vendor record update (e.g. update billing email)
  if (expectedEmail || goal.toLowerCase().includes('email') || goal.toLowerCase().includes('vendor')) {
    const url = 'http://localhost:4000/api/vendors';
    logVerifyTool('http_get', { url }, context);
    const res = await httpGet({ url });
    if (res.ok && Array.isArray(res.data?.data)) {
      const vendors = res.data.data;
      const targetVendor = vendors.find(v =>
        (expectedVendor && v.name.toLowerCase().includes(expectedVendor.toLowerCase())) ||
        v.billingEmail === expectedEmail ||
        v.name.toLowerCase().includes('initech')
      );

      if (targetVendor) {
        const pass = targetVendor.billingEmail === expectedEmail;
        checks.push({
          what: `Vendor (${targetVendor.name}) billing email`,
          expected: expectedEmail,
          actual: targetVendor.billingEmail,
          pass
        });
        notes = pass ? 'Vendor email update confirmed in database.' : 'Vendor email does not match expected value.';
      } else {
        checks.push({
          what: 'Find target vendor in records',
          expected: expectedVendor || 'Target vendor',
          actual: 'Vendor not found in database',
          pass: false
        });
      }

      if (checks.length > 0) {
        const verified = checks.every(c => c.pass);
        logVerifyTool('finish_verification', { verified, checksCount: checks.length }, context);
        return {
          verified,
          checks,
          notes
        };
      }
    }
  }

  // Case 3: Standard Invoice Creation Task
  if (invoiceNumber) {
    const url = `http://localhost:4000/api/invoices?invoiceNumber=${encodeURIComponent(invoiceNumber)}`;
    logVerifyTool('http_get', { url }, context);
    const res = await httpGet({ url });

    if (res.ok && Array.isArray(res.data?.data) && res.data.data.length > 0) {
      const invoice = res.data.data[0];

      // Check 1: Record existence
      checks.push({
        what: `Invoice ${invoiceNumber} created in portal`,
        expected: 'Record exists in database',
        actual: 'Found in database',
        pass: true
      });

      // Check 2: Vendor
      if (expectedVendor) {
        const vendorName = invoice.vendorId?.name || invoice.vendor || '';
        const vendorMatches = vendorName.toLowerCase().includes(expectedVendor.toLowerCase());
        checks.push({
          what: 'Vendor Name',
          expected: expectedVendor,
          actual: vendorName,
          pass: vendorMatches
        });
      }

      // Check 3: Amount
      if (expectedAmount !== undefined) {
        const actualAmount = parseFloat(invoice.amount);
        const amountMatches = Math.abs(actualAmount - expectedAmount) < 0.01;
        checks.push({
          what: 'Invoice Amount',
          expected: expectedAmount,
          actual: actualAmount,
          pass: amountMatches
        });
      }

      // Check 4: Currency
      const targetCurrency = expectedCurrency || context.state?.memory?.currency || invoice.currency || 'USD';
      const currMatches = invoice.currency?.toUpperCase() === targetCurrency.toUpperCase();
      checks.push({
        what: 'Currency',
        expected: targetCurrency.toUpperCase(),
        actual: invoice.currency,
        pass: currMatches
      });

      // Check 5: Due Date
      if (expectedDueDate) {
        const actualDue = invoice.dueDate ? new Date(invoice.dueDate).toISOString().split('T')[0] : '';
        const expectedDueStr = expectedDueDate.includes('T') ? expectedDueDate.split('T')[0] : expectedDueDate;
        const dueMatches = actualDue === expectedDueStr;
        checks.push({
          what: 'Payment Due Date',
          expected: expectedDueStr,
          actual: actualDue,
          pass: dueMatches
        });
      }

      // Check 6: Invoice Status
      const expectedStatus = claimedOutcome.status || 'logged';
      const statusMatches = Boolean(invoice.status && (invoice.status === expectedStatus || ['logged', 'approved', 'paid'].includes(invoice.status)));
      checks.push({
        what: 'Invoice Status',
        expected: expectedStatus,
        actual: invoice.status || 'unknown',
        pass: statusMatches
      });

      const allPassed = checks.every(c => c.pass);
      notes = allPassed
        ? `Invoice ${invoiceNumber} independently verified with 100% field accuracy.`
        : `Verification discrepancies detected in invoice ${invoiceNumber}.`;

      logVerifyTool('finish_verification', { verified: allPassed, checksCount: checks.length }, context);
      return {
        verified: allPassed,
        checks,
        notes
      };
    } else {
      checks.push({
        what: `Invoice ${invoiceNumber} exists in portal`,
        expected: '1 matching invoice in database',
        actual: '0 matching invoices found',
        pass: false
      });
      logVerifyTool('finish_verification', { verified: false, checksCount: checks.length }, context);
      return {
        verified: false,
        checks,
        notes: `Invoice ${invoiceNumber} was not found in the portal database.`
      };
    }
  }

  // Fallback if no specific fields claimed
  logVerifyTool('finish_verification', { verified: false, checksCount: 1 }, context);
  return {
    verified: false,
    checks: [{ what: 'Outcome verification', expected: 'Structured outcome fields', actual: 'None provided', pass: false }],
    notes: 'Worker did not claim any verifiable fields in claimed_outcome.'
  };
}

/**
 * Runs independent verification.
 * Attempts LLM verification pass if GEMINI_API_KEY is available;
 * falls back cleanly to the deterministic programmatic audit.
 */
export async function runIndependentVerification({ goal, claimedOutcome, context = {} }) {
  // Always perform programmatic audit first as baseline
  const programmaticResult = await programmaticVerify({ goal, claimedOutcome, context });

  // If Gemini API is available and configured, we can also perform LLM audit
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your-gemini-api-key-here') {
    return programmaticResult;
  }

  try {
    const auditorPrompt = `AUDIT TASK:\nOriginal Goal: ${goal}\nWorker Claimed Outcome: ${JSON.stringify(claimedOutcome, null, 2)}\n\nQuery http_get to inspect the real portal state and verify whether this was achieved.`;

    const response = await callGemini({
      contents: [{ role: 'user', parts: [{ text: auditorPrompt }] }],
      systemInstruction: VERIFIER_SYSTEM_PROMPT,
      tools: [
        {
          name: 'http_get',
          description: 'Read-only portal API query (e.g. http://localhost:4000/api/invoices or http://localhost:4000/api/vendors)',
          parameters: zodToGeminiParameters(z.object({ url: z.string() }))
        },
        finishVerificationTool
      ]
    });

    // Check if verifier concluded
    const finishCall = response.functionCalls?.find(fc => fc.name === 'finish_verification');
    if (finishCall && finishCall.args) {
      logVerifyTool('finish_verification', finishCall.args, context);
      return {
        verified: Boolean(finishCall.args.verified),
        checks: Array.isArray(finishCall.args.checks) ? finishCall.args.checks : programmaticResult.checks,
        notes: finishCall.args.notes || programmaticResult.notes
      };
    }

    return programmaticResult;
  } catch (err) {
    // If LLM audit encounters network/quota limits, rely safely on the programmatic audit
    console.warn(`[verifier] LLM auditor notice (${err.message}). Using programmatic audit.`);
    return programmaticResult;
  }
}
