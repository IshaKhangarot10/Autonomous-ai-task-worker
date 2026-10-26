/**
 * Gemini LLM Client Wrapper.
 *
 * Uses the official `@google/genai` SDK with manual tool calling (no automatic
 * tool execution framework).
 *
 * Implements:
 * 1. Global client-side rate limiter shared across worker and verifier (GEMINI_RPM).
 * 2. Automatic RetryInfo.retryDelay detection on HTTP 429/500/503 errors (with 1-2s jitter).
 * 3. Exponential backoff fallback if no server retryDelay is provided (up to 6 attempts).
 * 4. Direct reading of function calls and text from parts to avoid SDK warnings.
 */

import { GoogleGenAI } from '@google/genai';

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const MAX_ATTEMPTS = 6;
const INITIAL_BACKOFF_MS = 1000;

let clientInstance = null;

// Module-level shared rate limiter state (shared across worker and verifier)
let lastCallTimestamp = 0;
let rateLimitQueue = Promise.resolve();

/**
 * Initializes and caches the GoogleGenAI client using GEMINI_API_KEY.
 */
export function getGeminiClient() {
  if (clientInstance) return clientInstance;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your-gemini-api-key-here') {
    throw new Error(
      'GEMINI_API_KEY is not configured or is using placeholder. Please set a valid key in .env or environment.'
    );
  }

  clientInstance = new GoogleGenAI({ apiKey });
  return clientInstance;
}

/**
 * Sleep helper for delays.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Enforces client-side rate limiting shared across worker and verifier.
 * GEMINI_RPM (default 5) enforces a minimum gap of 60000/GEMINI_RPM ms.
 * Prints "[rate-limit] waiting Xs" when it pauses.
 */
async function enforceRateLimit() {
  const geminiRpm = parseFloat(process.env.GEMINI_RPM || '5');
  const rpm = Number.isFinite(geminiRpm) && geminiRpm > 0 ? geminiRpm : 5;
  const minGapMs = Math.ceil(60000 / rpm);

  const waitPromise = rateLimitQueue.then(async () => {
    const now = Date.now();
    const elapsed = now - lastCallTimestamp;
    const waitMs = minGapMs - elapsed;

    if (waitMs > 0 && lastCallTimestamp > 0) {
      const waitSec = Math.ceil(waitMs / 1000);
      console.log(`[rate-limit] waiting ${waitSec}s`);
      await sleep(waitMs);
    }
    lastCallTimestamp = Date.now();
  });

  rateLimitQueue = waitPromise.catch(() => {});
  await waitPromise;
}

/**
 * Determines whether an error is transient (rate limit or server glitch) and retryable.
 * Supports HTTP 429, 500, 503, and related network/overload conditions.
 */
function isRetryableError(err) {
  const status = err.status || err.statusCode || 0;
  const msg = (err.message || '').toLowerCase();

  // 429 rate limit or quota exhaustion
  if (status === 429 || msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('quota')) {
    return true;
  }

  // 500, 503, and 5xx server errors
  if (status === 500 || status === 503 || (status >= 500 && status < 600)) {
    return true;
  }

  if (msg.includes('unavailable') || msg.includes('overloaded') || msg.includes('internal error')) {
    return true;
  }

  return false;
}

/**
 * Extracts server-provided RetryInfo.retryDelay from error details or JSON message.
 * Handles string durations (e.g. "27s"), numeric seconds, or google.protobuf.Duration objects.
 */
function extractRetryDelayMs(err) {
  try {
    let details = err?.details || err?.errorDetails || err?.statusDetails;

    if (!details && typeof err?.message === 'string') {
      try {
        const parsed = JSON.parse(err.message);
        details = parsed?.error?.details || parsed?.details;
      } catch (_) {}
    }

    if (Array.isArray(details)) {
      for (const item of details) {
        if (item && (item['@type']?.includes('RetryInfo') || item.retryDelay)) {
          const delay = item.retryDelay;
          if (typeof delay === 'string') {
            const match = delay.match(/^([0-9.]+)\s*s$/i);
            if (match) {
              return Math.ceil(parseFloat(match[1]) * 1000);
            }
          } else if (typeof delay === 'number') {
            return Math.ceil(delay * 1000);
          } else if (typeof delay === 'object' && delay !== null) {
            const secs = parseFloat(delay.seconds || 0);
            const nanos = parseFloat(delay.nanos || 0);
            return Math.ceil((secs * 1000) + (nanos / 1e6));
          }
        }
      }
    }

    // Regex fallback in raw message
    if (typeof err?.message === 'string') {
      const match = err.message.match(/retryDelay["']?\s*:\s*["']([0-9.]+)s["']/i) ||
                    err.message.match(/retry\s+in\s+([0-9.]+)\s*s/i) ||
                    err.message.match(/retryDelay["']?\s*:\s*\{\s*["']seconds["']?\s*:\s*([0-9]+)/i);
      if (match) {
        return Math.ceil(parseFloat(match[1]) * 1000);
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Calls Gemini models.generateContent with rate-limiting and retry logic.
 *
 * @param {Object} options
 * @param {Array} options.contents - Full message history in Gemini format
 * @param {string} options.systemInstruction - System prompt for the agent
 * @param {Array} options.tools - Array of Gemini function declarations
 * @param {string} [options.model] - Override model name
 * @param {number} [options.temperature=0.1] - Low temperature for deterministic tool execution
 *
 * @returns {Promise<{ text: string, functionCalls: Array<{ name: string, args: Object }>, rawParts: Array }>}
 */
export async function callGemini({
  contents,
  systemInstruction,
  tools = [],
  model = DEFAULT_MODEL,
  temperature = 0.1
}) {
  const client = getGeminiClient();

  let attempt = 0;
  let backoffMs = INITIAL_BACKOFF_MS;

  while (true) {
    attempt++;
    try {
      // 1. Enforce client-side rate limit (GEMINI_RPM)
      await enforceRateLimit();

      const config = {
        temperature,
        systemInstruction
      };

      if (tools && tools.length > 0) {
        config.tools = [{ functionDeclarations: tools }];
        config.toolConfig = {
          functionCallingConfig: {
            mode: 'AUTO'
          }
        };
      }

      const response = await client.models.generateContent({
        model,
        contents,
        config
      });

      // 2. Extract function calls and text directly from candidate parts
      // DO NOT access response.text when function calls are present, to prevent the SDK warning
      // "there are non-text parts functionCall in the response".
      const candidate = response.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const functionCalls = [];
      const textParts = [];

      for (const part of parts) {
        if (part.functionCall) {
          functionCalls.push({
            name: part.functionCall.name,
            args: part.functionCall.args || {}
          });
        }
        if (typeof part.text === 'string' && part.text) {
          textParts.push(part.text);
        }
      }

      const text = textParts.join('\n');

      return {
        text,
        functionCalls,
        rawParts: parts
      };
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && isRetryableError(err)) {
        // Read server's RetryInfo.retryDelay if present
        const serverDelayMs = extractRetryDelayMs(err);
        const jitterMs = 1000 + Math.floor(Math.random() * 1000); // 1-2s jitter

        let waitMs;
        if (serverDelayMs !== null && serverDelayMs > 0) {
          waitMs = serverDelayMs + jitterMs;
          console.warn(`[gemini] Server requested retryDelay of ${(serverDelayMs / 1000).toFixed(1)}s. Waiting ${(waitMs / 1000).toFixed(1)}s (with jitter) before attempt ${attempt + 1}/${MAX_ATTEMPTS}...`);
        } else {
          waitMs = backoffMs + jitterMs;
          console.warn(`[gemini] Transient error (${err.status || err.message?.slice(0, 80)}). Exponential backoff ${(waitMs / 1000).toFixed(1)}s before attempt ${attempt + 1}/${MAX_ATTEMPTS}...`);
          backoffMs *= 2;
        }

        await sleep(waitMs);
        continue;
      }

      // Re-throw non-retryable error or after retries exhausted
      throw err;
    }
  }
}
