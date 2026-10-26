/**
 * Test script for Gemini Tool Declarations.
 *
 * Requirements:
 * (a) Prints every generated function declaration as JSON.
 * (b) Fails if any key anywhere starts with "_" or any enum is not an array of strings.
 * (c) Makes ONE real Gemini call with all tools attached and the prompt "Reply with the word OK" and prints the HTTP result.
 */

import 'dotenv/config';
import { getGeminiToolDeclarations } from '../agent/src/tools/registry.js';
import { callGemini } from '../agent/src/llm/gemini.js';

/**
 * Recursively validates that:
 * 1. No key anywhere starts with "_"
 * 2. Every "enum" property is an array of strings
 */
function validateDeclaration(obj, path = '') {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    obj.forEach((item, index) => validateDeclaration(item, `${path}[${index}]`));
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;

    // Fail if key starts with "_"
    if (key.startsWith('_')) {
      throw new Error(`Validation Error: Forbidden key "${key}" found at "${currentPath}"`);
    }

    // Fail if enum is not an array of strings
    if (key === 'enum') {
      if (!Array.isArray(value)) {
        throw new Error(
          `Validation Error: "enum" at "${currentPath}" must be an array of strings, got ${typeof value}: ${JSON.stringify(value)}`
        );
      }
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string') {
          throw new Error(
            `Validation Error: "enum" item at "${currentPath}[${i}]" must be a string, got ${typeof value[i]}: ${JSON.stringify(value[i])}`
          );
        }
      }
    }

    validateDeclaration(value, currentPath);
  }
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('          GEMINI TOOL DECLARATIONS VALIDATION & LIVE TEST             ');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  const declarations = getGeminiToolDeclarations();
  console.log(`Generated ${declarations.length} tool declarations from registry.\n`);

  // ── (a) Print every generated function declaration as JSON ──
  console.log('─── (a) Generated Function Declarations (JSON) ───\n');
  declarations.forEach((decl, index) => {
    console.log(`[${index}] Tool: ${decl.name}`);
    console.log(JSON.stringify(decl, null, 2));
    console.log('');
  });

  // ── (b) Validate schemas: fail on "_" keys or non-string-array enums ──
  console.log('─── (b) Validating Schemas for Leaked Internals and Enums ───\n');
  let validationPassed = true;
  for (let i = 0; i < declarations.length; i++) {
    const decl = declarations[i];
    try {
      validateDeclaration(decl, `declarations[${i}][${decl.name}]`);
      console.log(`  ✓ Tool [${i}] "${decl.name}": Validated clean (no "_" keys, enums are string arrays)`);
    } catch (err) {
      console.error(`  ✕ Tool [${i}] "${decl.name}": ${err.message}`);
      validationPassed = false;
    }
  }

  if (!validationPassed) {
    console.error('\n❌ Declaration validation failed! Stopping before Gemini call.');
    process.exit(1);
  }
  console.log('\n✓ All 15 declarations passed schema validation.\n');

  // ── (c) Make ONE real Gemini call with all tools attached ──
  console.log('─── (c) Real Gemini Call with All Tools Attached ───\n');
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

  if (!apiKey || apiKey === 'your-gemini-api-key-here') {
    throw new Error('GEMINI_API_KEY is not set in environment or .env');
  }

  console.log(`Endpoint: https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
  console.log(`Attached Tools: ${declarations.length} function declarations`);
  console.log(`User Prompt: "Reply with the word OK"\n`);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const startTime = Date.now();

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Reply with the word OK' }]
        }
      ],
      tools: [
        {
          functionDeclarations: declarations
        }
      ]
    })
  });

  const durationMs = Date.now() - startTime;
  const statusCode = response.status;
  const statusText = response.statusText;
  const responseBody = await response.json();

  console.log(`HTTP Status: ${statusCode} ${statusText} (${durationMs}ms)`);
  console.log('HTTP Response Body:');
  console.log(JSON.stringify(responseBody, null, 2));

  if (statusCode === 200) {
    const replyText = responseBody.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log(`\n✓ SUCCESS! Real Gemini API returned 200 OK.`);
    console.log(`Model Reply: "${replyText?.trim()}"\n`);
  } else {
    console.error(`\n✕ FAILURE! Gemini API rejected declarations with status ${statusCode}.`);
    process.exit(1);
  }

  // Also test with SDK callGemini wrapper
  console.log('Testing SDK callGemini() wrapper with all tools attached...');
  const sdkRes = await callGemini({
    contents: [{ role: 'user', parts: [{ text: 'Reply with the word OK' }] }],
    tools: declarations,
    model
  });
  console.log(`SDK callGemini() Result: "${sdkRes.text.trim()}" (functions called: ${sdkRes.functionCalls.length})\n`);
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('              ALL DECLARATION TESTS PASSED SUCCESSFULLY               ');
  console.log('══════════════════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('\nFatal error running test-declarations.js:', err);
  process.exit(1);
});
