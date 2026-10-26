/**
 * File tools for the agent.
 *
 * All operations are strictly sandboxed to the `sandbox/` directory.
 * Path traversal attempts (e.g. `../` or absolute paths outside sandbox)
 * are rejected before any filesystem call is made.
 */

import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

// Workspace root is two levels up from agent/src/tools/
const WORKSPACE_ROOT = path.resolve(process.cwd());
const SANDBOX_ROOT = path.resolve(WORKSPACE_ROOT, 'sandbox');
const MAX_READ_CHARS = 20000;

/**
 * Safely resolves and validates that a given path stays strictly inside sandbox/
 * Returns { ok: true, resolved, relative } or { ok: false, error }
 */
function resolveSandboxPath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    return {
      ok: false,
      error: {
        type: 'INVALID_PATH',
        message: 'A valid path string is required.',
        hint: 'Provide a path like "sandbox/inbox" or "sandbox/context/company.md".'
      }
    };
  }

  // Normalize path and resolve against workspace root
  const resolved = path.resolve(WORKSPACE_ROOT, inputPath);

  // Strict containment check: resolved path must start with SANDBOX_ROOT
  if (!resolved.startsWith(SANDBOX_ROOT)) {
    return {
      ok: false,
      error: {
        type: 'PATH_TRAVERSAL_BLOCKED',
        message: `Access denied. Path "${inputPath}" is outside the allowed sandbox.`,
        hint: 'The agent is only allowed to access files inside the sandbox/ directory.'
      }
    };
  }

  const relative = path.relative(WORKSPACE_ROOT, resolved).replace(/\\/g, '/');
  return { ok: true, resolved, relative };
}

/**
 * list_files: Lists files in a directory within sandbox/
 */
export async function listFiles({ dir = 'sandbox/inbox' } = {}) {
  const check = resolveSandboxPath(dir);
  if (!check.ok) return check;

  try {
    const entries = await readdir(check.resolved, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      // Ignore hidden files like .gitkeep or .DS_Store
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(check.resolved, entry.name);
      const fileStat = await stat(fullPath);
      const relativePath = path.relative(WORKSPACE_ROOT, fullPath).replace(/\\/g, '/');

      files.push({
        name: entry.name,
        path: relativePath,
        isDirectory: entry.isDirectory(),
        sizeBytes: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString()
      });
    }

    return {
      ok: true,
      data: {
        dir: check.relative,
        total: files.length,
        files: files.sort((a, b) => a.name.localeCompare(b.name))
      }
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        error: {
          type: 'DIR_NOT_FOUND',
          message: `Directory not found: "${dir}"`,
          hint: 'Use dir: "sandbox/inbox" or "sandbox/context" to view files.'
        }
      };
    }

    return {
      ok: false,
      error: {
        type: 'FILE_SYSTEM_ERROR',
        message: err.message,
        hint: 'Check that directory exists and is accessible.'
      }
    };
  }
}

/**
 * read_file: Reads text, markdown, or PDF files from sandbox/
 */
export async function readFileTool({ path: inputPath }) {
  const check = resolveSandboxPath(inputPath);
  if (!check.ok) return check;

  try {
    const ext = path.extname(check.resolved).toLowerCase();
    let text = '';
    let pages = undefined;

    if (ext === '.pdf') {
      const buffer = await readFile(check.resolved);
      const parser = new PDFParse(new Uint8Array(buffer));
      await parser.load();
      const info = await parser.getInfo();
      pages = info?.total || 1;
      const rawText = await parser.getText();
      text = typeof rawText === 'string' ? rawText : (rawText?.text || '');
      await parser.destroy();
    } else {
      text = await readFile(check.resolved, 'utf-8');
    }

    let truncated = false;
    if (text.length > MAX_READ_CHARS) {
      truncated = true;
      text = text.slice(0, MAX_READ_CHARS) +
        `\n\n[TRUNCATED: Content exceeded ${MAX_READ_CHARS} characters. Showing first ${MAX_READ_CHARS} of ${text.length} characters.]`;
    }

    return {
      ok: true,
      data: {
        path: check.relative,
        extension: ext,
        text,
        length: text.length,
        pages,
        truncated
      }
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        error: {
          type: 'FILE_NOT_FOUND',
          message: `File not found: "${inputPath}"`,
          hint: 'Use list_files({ dir: "sandbox/inbox" }) to see available files.'
        }
      };
    }

    return {
      ok: false,
      error: {
        type: 'FILE_READ_ERROR',
        message: err.message,
        hint: 'Ensure the file is readable and not corrupt.'
      }
    };
  }
}
