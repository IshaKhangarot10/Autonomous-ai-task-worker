/**
 * Central Tool Registry for the Autonomous AI Task Worker.
 *
 * Each tool definition contains:
 * - name: unique tool name
 * - description: natural language description for LLM
 * - schema: Zod schema for input argument validation
 * - handler: async (args, context) => { ok, data?, error?: { type, message, hint } }
 * - risk: 'read' | 'write' (used by policy layer in Phase 6 for human approvals)
 *
 * Key guarantees:
 * 1. executeTool NEVER throws into the runtime loop. Any thrown exception is caught and
 *    returned as a structured { ok: false, error: ... } result.
 * 2. Arguments are strictly validated via Zod before invoking the handler.
 * 3. Every tool invocation has a timeout (default 30 seconds).
 * 4. Gemini function declarations are generated directly from the registry.
 */

import { z } from 'zod';
import { listFiles, readFileTool } from './files.js';
import {
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserType,
  browserSelect,
  browserPress,
  browserScreenshot,
  browserLogin
} from './browser.js';
import { httpGet } from './http.js';
import { askHuman } from './human.js';
import { updatePlan, remember, finish } from './memory.js';

/**
 * Registry map of all available tools.
 */
const TOOLS = new Map();

/**
 * Register a tool in the registry.
 */
export function registerTool(tool) {
  if (!tool.name || typeof tool.name !== 'string') {
    throw new Error('Tool must have a valid string name.');
  }
  if (!tool.description || typeof tool.description !== 'string') {
    throw new Error(`Tool "${tool.name}" must have a description.`);
  }
  if (!tool.schema) {
    throw new Error(`Tool "${tool.name}" must have a Zod schema.`);
  }
  if (typeof tool.handler !== 'function') {
    throw new Error(`Tool "${tool.name}" must have an executable handler function.`);
  }

  TOOLS.set(tool.name, {
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    handler: tool.handler,
    risk: tool.risk === 'write' ? 'write' : 'read',
    timeoutMs: tool.timeoutMs || 30000
  });
}

// ─────────────────────────────────────────────────────────────
// Tool Registrations
// ─────────────────────────────────────────────────────────────

// 1. Filesystem tools (read-only, sandboxed)
registerTool({
  name: 'list_files',
  description: 'List files in a directory within the sandbox (default: "sandbox/inbox"). Returns file names, sizes, and modified dates. Access outside sandbox/ is strictly blocked.',
  schema: z.object({
    dir: z.string().default('sandbox/inbox').describe('Directory path inside sandbox, e.g. "sandbox/inbox" or "sandbox/context"')
  }),
  handler: listFiles,
  risk: 'read'
});

registerTool({
  name: 'read_file',
  description: 'Read the contents of a file (.txt, .md, .pdf, .json) inside sandbox/. For PDF files, text is extracted automatically. Access outside sandbox/ is strictly blocked.',
  schema: z.object({
    path: z.string().describe('File path relative to workspace or sandbox, e.g. "sandbox/inbox/globex_original.txt" or "sandbox/inbox/acme-industries-oct.pdf"')
  }),
  handler: readFileTool,
  risk: 'read'
});

// 2. Browser tools (generic interaction via snapshot refs)
registerTool({
  name: 'browser_navigate',
  description: 'Navigate the browser to an allowlisted portal URL (e.g. http://localhost:4000/invoices). Navigation to non-allowlisted origins is blocked.',
  schema: z.object({
    url: z.string().describe('Full URL to navigate to within the allowlisted company portal')
  }),
  handler: browserNavigate,
  risk: 'read'
});

registerTool({
  name: 'browser_snapshot',
  description: 'THE KEY OBSERVATION TOOL. Returns current page URL, title, visible headings, text summary, active alerts/errors, and a numbered list of all VISIBLE interactive elements with their refs, labels, types, current values, and select options. You MUST call this to discover ref numbers before interacting.',
  schema: z.object({}),
  handler: browserSnapshot,
  risk: 'read'
});

registerTool({
  name: 'browser_click',
  description: 'Click a visible interactive element identified by its numeric ref from the latest browser_snapshot.',
  schema: z.object({
    ref: z.number().int().positive().describe('Numeric ref of the element from the latest browser_snapshot')
  }),
  handler: browserClick,
  risk: 'write'
});

registerTool({
  name: 'browser_type',
  description: 'Enter text into an input field or textarea identified by its ref from browser_snapshot. By default clears existing content.',
  schema: z.object({
    ref: z.number().int().positive().describe('Numeric ref of the input or textarea element'),
    text: z.string().describe('Text to enter into the field'),
    clear: z.boolean().default(true).describe('Whether to clear current input before typing')
  }),
  handler: browserType,
  risk: 'write'
});

registerTool({
  name: 'browser_select',
  description: 'Select an option in a <select> dropdown element identified by its ref from browser_snapshot.',
  schema: z.object({
    ref: z.number().int().positive().describe('Numeric ref of the select element'),
    value: z.string().describe('The option value or option text to select')
  }),
  handler: browserSelect,
  risk: 'write'
});

registerTool({
  name: 'browser_press',
  description: 'Press a keyboard key in the browser (e.g. "Enter", "Escape", "Tab").',
  schema: z.object({
    key: z.string().describe('Key to press, e.g. "Enter", "Escape", "Tab"')
  }),
  handler: browserPress,
  risk: 'write'
});

registerTool({
  name: 'browser_screenshot',
  description: 'Capture a browser screenshot and save it to sandbox/artifacts/<runId>/ as evidence. Returns the saved file path.',
  schema: z.object({
    label: z.string().default('evidence').describe('Short label describing the screenshot purpose')
  }),
  handler: browserScreenshot,
  risk: 'read'
});

registerTool({
  name: 'browser_login',
  description: 'Automates portal login using credentials managed securely by the runtime environment. The agent never sees or handles the password.',
  schema: z.object({
    site: z.string().default('portal').describe('Site identifier, default "portal"')
  }),
  handler: browserLogin,
  risk: 'read'
});

// 3. HTTP tool (read-only, allowlisted to portal API)
registerTool({
  name: 'http_get',
  description: 'Perform a read-only HTTP GET request to the company portal API (e.g. "http://localhost:4000/api/vendors" or "http://localhost:4000/api/invoices") to inspect system records or verify outcomes.',
  schema: z.object({
    url: z.string().describe('Full API URL to query')
  }),
  handler: httpGet,
  risk: 'read'
});

// 4. Human-in-the-loop tool
registerTool({
  name: 'ask_human',
  description: 'Ask a clarifying question to the human supervisor when encountering ambiguity (e.g. multiple matching vendors or invoices) or missing required information. Never guess.',
  schema: z.object({
    question: z.string().describe('The question to ask the user, explaining the ambiguity or missing data'),
    options: z.array(z.string()).optional().describe('Optional list of choices for the user')
  }),
  handler: askHuman,
  risk: 'read',
  timeoutMs: 120000
});

// 5. Memory and planning tools
registerTool({
  name: 'update_plan',
  description: 'Update the structured execution plan. Helps track progress through complex tasks and displays progress in the dashboard.',
  schema: z.object({
    steps: z.array(z.object({
      id: z.string().describe('Step identifier, e.g. "1", "2"'),
      description: z.string().describe('Step description'),
      status: z.enum(['pending', 'in_progress', 'completed', 'blocked', 'skipped']).describe('Current status of the step')
    })).describe('List of steps in the plan')
  }),
  handler: updatePlan,
  risk: 'read'
});

registerTool({
  name: 'remember',
  description: 'Store a discovered fact in memory (e.g. invoiceNumber, vendor, amount, dueDate). Facts in memory are summarized and presented in every subsequent turn.',
  schema: z.object({
    key: z.string().describe('Memory key (e.g. "invoice_number", "vendor", "due_date")'),
    value: z.any().describe('Value to remember')
  }),
  handler: remember,
  risk: 'read'
});

registerTool({
  name: 'finish',
  description: 'Signal that the task has reached completion (completed, blocked, or failed) with a summary and evidence references. Triggers independent verification.',
  schema: z.object({
    status: z.enum(['completed', 'blocked', 'failed']).describe('Completion status'),
    summary: z.string().describe('Detailed explanation of the final outcome'),
    claimed_outcome: z.record(z.any()).optional().describe('Structured claims to verify (e.g. { invoiceNumber: "GLX-2024-0112", amount: 4850, vendor: "Globex Corporation" })'),
    evidence_refs: z.array(z.string()).optional().describe('References to evidence (e.g. screenshot paths, invoice numbers)')
  }),
  handler: finish,
  risk: 'read'
});

// ─────────────────────────────────────────────────────────────
// Registry Access and Execution
// ─────────────────────────────────────────────────────────────

/**
 * Get a tool definition by name.
 */
export function getTool(name) {
  return TOOLS.get(name) || null;
}

/**
 * Get all registered tools as an array.
 */
export function getAllTools() {
  return Array.from(TOOLS.values());
}

/**
 * Execute a tool safely:
 * 1. Checks tool existence
 * 2. Validates arguments using Zod schema
 * 3. Enforces execution timeout
 * 4. Catches unhandled errors — never throws into the caller
 */
export async function executeTool(name, rawArgs = {}, context = {}) {
  const tool = TOOLS.get(name);
  if (!tool) {
    return {
      ok: false,
      error: {
        type: 'UNKNOWN_TOOL',
        message: `Unknown tool "${name}".`,
        hint: `Available tools: ${Array.from(TOOLS.keys()).join(', ')}`
      }
    };
  }

  // 1. Validate arguments with Zod
  const validation = tool.schema.safeParse(rawArgs);
  if (!validation.success) {
    const errorDetails = validation.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join(', ');
    return {
      ok: false,
      error: {
        type: 'VALIDATION_ERROR',
        message: `Invalid arguments for tool "${name}": ${errorDetails}`,
        hint: `Check the parameter requirements for ${name}.`
      }
    };
  }

  const validatedArgs = validation.data;

  // 2. Execute with timeout
  try {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Tool "${name}" timed out after ${tool.timeoutMs}ms.`));
      }, tool.timeoutMs);
    });

    const executionPromise = tool.handler(validatedArgs, context);

    const result = await Promise.race([executionPromise, timeoutPromise]);
    clearTimeout(timeoutId);

    // Normalize output: ensure { ok, ... }
    if (result && typeof result === 'object' && 'ok' in result) {
      return result;
    }

    return {
      ok: true,
      data: result
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        type: err.message.includes('timed out') ? 'TOOL_TIMEOUT' : 'TOOL_EXECUTION_ERROR',
        message: err.message,
        hint: 'Unexpected failure during tool execution.'
      }
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Gemini Schema Generation
// ─────────────────────────────────────────────────────────────

/**
 * Unwraps Zod modifiers (optional, default, nullable, effects, pipe, refinement)
 * at any depth, tracking optionality, nullability, and descriptions.
 */
function unwrapZod(schema) {
  let curr = schema;
  let isOptional = false;
  let isNullable = false;
  let description = curr?.description;

  while (curr && curr._def) {
    if (curr.description && !description) {
      description = curr.description;
    }

    const typeName = curr._def.type || curr._def.typeName || curr.constructor?.name || '';

    if (typeName === 'optional' || typeName === 'ZodOptional') {
      isOptional = true;
      curr = curr._def.innerType || (typeof curr.unwrap === 'function' ? curr.unwrap() : null);
    } else if (typeName === 'default' || typeName === 'ZodDefault') {
      isOptional = true;
      curr = curr._def.innerType || (typeof curr.removeDefault === 'function' ? curr.removeDefault() : null);
    } else if (typeName === 'nullable' || typeName === 'ZodNullable') {
      isNullable = true;
      curr = curr._def.innerType || (typeof curr.unwrap === 'function' ? curr.unwrap() : null);
    } else if (typeName === 'effects' || typeName === 'ZodEffects') {
      curr = curr._def.schema;
    } else if (typeName === 'pipe' || typeName === 'ZodPipe') {
      curr = curr._def.in;
    } else if (typeName === 'refinement' || typeName === 'ZodRefinement') {
      curr = curr._def.innerType || curr._def.schema;
    } else if (typeName === 'catch' || typeName === 'ZodCatch') {
      isOptional = true;
      curr = curr._def.innerType;
    } else {
      break;
    }
  }

  if (curr?.description && !description) {
    description = curr.description;
  }

  if (typeof curr?.isOptional === 'function' && curr.isOptional()) {
    isOptional = true;
  }
  if (typeof curr?.isNullable === 'function' && curr.isNullable()) {
    isNullable = true;
  }

  return {
    inner: curr,
    isOptional,
    isNullable,
    description
  };
}

/**
 * Recursively converts a Zod schema into Gemini function declaration format.
 * Builds a clean NEW plain object with only: type, description, properties,
 * required, items, enum, nullable. Never spreads or copies Zod internals.
 */
function zodSchemaToGemini(zodType) {
  if (!zodType) {
    return { type: 'OBJECT' };
  }

  const { inner, isNullable, description } = unwrapZod(zodType);

  const out = {};
  const typeName = inner?._def?.type || inner?._def?.typeName || inner?.constructor?.name || '';

  if (typeName === 'string' || typeName === 'ZodString') {
    out.type = 'STRING';
  } else if (typeName === 'number' || typeName === 'ZodNumber') {
    out.type = 'NUMBER';
  } else if (typeName === 'boolean' || typeName === 'ZodBoolean') {
    out.type = 'BOOLEAN';
  } else if (typeName === 'enum' || typeName === 'ZodEnum') {
    out.type = 'STRING';
    let enumValues = [];
    if (Array.isArray(inner.options)) {
      enumValues = inner.options.map(String);
    } else if (Array.isArray(inner._def?.values)) {
      enumValues = inner._def.values.map(String);
    } else if (inner._def?.entries && typeof inner._def.entries === 'object') {
      enumValues = Object.values(inner._def.entries).map(String);
    } else if (inner.enum && typeof inner.enum === 'object') {
      enumValues = Object.values(inner.enum).map(String);
    }
    out.enum = enumValues;
  } else if (typeName === 'literal' || typeName === 'ZodLiteral') {
    let litVal;
    if (inner.value !== undefined) {
      litVal = inner.value;
    } else if (inner._def?.value !== undefined) {
      litVal = inner._def.value;
    } else if (Array.isArray(inner._def?.values) && inner._def.values.length > 0) {
      litVal = inner._def.values[0];
    }

    if (typeof litVal === 'number') {
      out.type = 'NUMBER';
    } else if (typeof litVal === 'boolean') {
      out.type = 'BOOLEAN';
    } else {
      out.type = 'STRING';
    }
    if (litVal !== undefined) {
      out.enum = [String(litVal)];
    }
  } else if (typeName === 'array' || typeName === 'ZodArray') {
    out.type = 'ARRAY';
    const elementSchema = inner._def?.element || inner.element || inner._def?.type;
    out.items = zodSchemaToGemini(elementSchema);
  } else if (typeName === 'object' || typeName === 'ZodObject') {
    out.type = 'OBJECT';
    const rawShape = typeof inner.shape === 'function' ? inner.shape() : (inner.shape || inner._def?.shape || {});
    const properties = {};
    const required = [];

    for (const [key, propSchema] of Object.entries(rawShape)) {
      properties[key] = zodSchemaToGemini(propSchema);

      const unwrappedProp = unwrapZod(propSchema);
      if (!unwrappedProp.isOptional) {
        required.push(key);
      }
    }

    out.properties = properties;
    if (required.length > 0) {
      out.required = required;
    }
  } else {
    // Fallback for record, any, unknown, etc.
    out.type = 'OBJECT';
  }

  if (description) {
    out.description = description;
  }

  if (isNullable) {
    out.nullable = true;
  }

  return out;
}

/**
 * Converts a full ZodObject schema into Gemini function declaration parameters.
 */
export function zodToGeminiParameters(zodObjectSchema) {
  const schema = zodSchemaToGemini(zodObjectSchema);
  if (schema.type !== 'OBJECT') {
    return {
      type: 'OBJECT',
      properties: {}
    };
  }
  if (!schema.properties) {
    schema.properties = {};
  }
  return schema;
}

/**
 * Returns Gemini functionDeclarations array for all registered tools.
 * Ready to pass into `tools: [{ functionDeclarations: [...] }]`
 */
export function getGeminiToolDeclarations() {
  return Array.from(TOOLS.values()).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: zodToGeminiParameters(tool.schema)
  }));
}
