/**
 * Browser tools for the agent using Playwright.
 *
 * Implements:
 * - browser_navigate: Allowlisted origin navigation
 * - browser_snapshot: THE KEY TOOL. Injects data-agent-ref into visible interactive
 *                     elements, extracts labels, headings, error banners, and text.
 * - browser_click, browser_type, browser_select, browser_press: Interact by ref
 * - browser_screenshot: Saves screenshot artifact with label
 * - browser_login: Automates portal authentication using .env credentials
 *                  WITHOUT exposing the password to the LLM.
 */

import { chromium } from 'playwright';
import { mkdir } from 'fs/promises';
import path from 'path';

const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:4000';
const ALLOWED_ORIGINS = new Set([
  new URL(PORTAL_URL).origin,
  'http://localhost:4000',
  'http://127.0.0.1:4000'
]);

// Singleton browser/page for CLI / standalone testing when not provided in context
let standaloneBrowser = null;
let standalonePage = null;

/**
 * Gets the active Playwright page from context or launches a standalone instance.
 */
export async function getActivePage(context = {}) {
  if (context.page) {
    return context.page;
  }

  if (!standalonePage || standalonePage.isClosed()) {
    const headless = process.env.HEADLESS === 'true';
    standaloneBrowser = await chromium.launch({
      headless,
      slowMo: headless ? 0 : 50
    });
    const browserContext = await standaloneBrowser.newContext({
      viewport: { width: 1280, height: 800 }
    });
    standalonePage = await browserContext.newPage();
  }

  return standalonePage;
}

/**
 * Close standalone browser instance if open.
 */
export async function closeStandaloneBrowser() {
  if (standaloneBrowser) {
    try {
      await standaloneBrowser.close();
    } catch (_) {}
    standaloneBrowser = null;
    standalonePage = null;
  }
}

/**
 * Helper to compute "what changed" after a browser action.
 */
async function detectChange(page, beforeUrl, beforeTitle) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    // Small delay to allow any client-side state / animation to settle
    await page.waitForTimeout(300);

    const afterUrl = page.url();
    const afterTitle = await page.title();

    // Check for visible alerts or errors on the page
    const alerts = await page.evaluate(() => {
      const el = document.querySelector('.alert, [role="alert"], .error, .toast');
      return el && el.offsetWidth > 0 ? el.textContent.trim() : null;
    });

    const changes = [];
    if (beforeUrl !== afterUrl) {
      changes.push(`Navigated from ${beforeUrl} to ${afterUrl}`);
    }
    if (beforeTitle !== afterTitle) {
      changes.push(`Title changed to "${afterTitle}"`);
    }
    if (alerts) {
      changes.push(`Visible alert: "${alerts}"`);
    }

    return changes.length > 0 ? changes.join('; ') : 'Page DOM updated';
  } catch (_) {
    return 'Action completed';
  }
}

/**
 * browser_navigate: Navigate to a URL with strict origin allowlist validation.
 */
export async function browserNavigate({ url }, context = {}) {
  if (!url || typeof url !== 'string') {
    return {
      ok: false,
      error: {
        type: 'INVALID_URL',
        message: 'A valid URL string is required.',
        hint: `Use full URL like "${PORTAL_URL}/invoices".`
      }
    };
  }

  let parsed;
  try {
    parsed = new URL(url, PORTAL_URL);
  } catch (err) {
    return {
      ok: false,
      error: {
        type: 'MALFORMED_URL',
        message: `Could not parse URL "${url}": ${err.message}`,
        hint: `Make sure the URL starts with http://`
      }
    };
  }

  if (!ALLOWED_ORIGINS.has(parsed.origin)) {
    return {
      ok: false,
      error: {
        type: 'ORIGIN_NOT_ALLOWED',
        message: `Navigation to origin "${parsed.origin}" is blocked.`,
        hint: `The agent may only browse allowlisted domains: ${Array.from(ALLOWED_ORIGINS).join(', ')}`
      }
    };
  }

  try {
    const page = await getActivePage(context);
    const beforeUrl = page.url();
    const beforeTitle = await page.title().catch(() => '');

    await page.goto(parsed.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    const whatChanged = await detectChange(page, beforeUrl, beforeTitle);

    return {
      ok: true,
      data: {
        url: page.url(),
        title: await page.title(),
        whatChanged
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        type: 'NAVIGATION_FAILED',
        message: err.message,
        hint: 'Check that the target server is running and accessible.'
      }
    };
  }
}

/**
 * browser_snapshot: THE KEY TOOL.
 * Injects sequential data-agent-ref attributes into all visible interactive elements,
 * extracts headings, form fields, buttons, links, current values, and active error/alert banners.
 */
export async function browserSnapshot(_, context = {}) {
  try {
    const page = await getActivePage(context);

    // Wait for any transient loading indicators to settle
    try {
      const loadingEl = page.locator('#loading-msg, .loading, [aria-busy="true"]').first();
      if (await loadingEl.isVisible().catch(() => false)) {
        await loadingEl.waitFor({ state: 'hidden', timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(200);
      }
    } catch (_) {}

    // Run snapshot script in browser context
    const snapshot = await page.evaluate(() => {
      // 1. Clear any prior agent refs
      document.querySelectorAll('[data-agent-ref]').forEach(el => {
        el.removeAttribute('data-agent-ref');
      });

      // Helper to check element visibility
      function isVisible(el) {
        if (!el) return false;
        if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
          return false;
        }
        return true;
      }

      // Helper to compute accessible label
      function getElementLabel(el) {
        // aria-label
        if (el.getAttribute('aria-label')) {
          return el.getAttribute('aria-label').trim();
        }

        // aria-labelledby
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const target = document.getElementById(labelledBy);
          if (target && target.textContent.trim()) {
            return target.textContent.trim();
          }
        }

        // Associated <label for="id">
        if (el.id) {
          const labelEl = document.querySelector(`label[for="${el.id}"]`);
          if (labelEl && labelEl.textContent.trim()) {
            return labelEl.textContent.trim();
          }
        }

        // Closest enclosing <label>
        const parentLabel = el.closest('label');
        if (parentLabel) {
          const clone = parentLabel.cloneNode(true);
          // remove child inputs to get just label text
          clone.querySelectorAll('input, select, textarea').forEach(n => n.remove());
          if (clone.textContent.trim()) {
            return clone.textContent.trim();
          }
        }

        // For buttons/links, inner text or value
        if (el.tagName === 'BUTTON' || el.tagName === 'A') {
          return el.textContent.trim();
        }

        if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) {
          return el.value || el.textContent.trim();
        }

        // Placeholder or title fallback
        return el.placeholder || el.title || '';
      }

      // 2. Headings
      const headings = [];
      document.querySelectorAll('h1, h2, h3').forEach(h => {
        if (isVisible(h) && h.textContent.trim()) {
          headings.push(`${h.tagName.toLowerCase()}: ${h.textContent.trim()}`);
        }
      });

      // 3. Alerts and errors
      const alerts = [];
      document.querySelectorAll('.alert, [role="alert"], .error, .toast, .banner, .modal, .modal-overlay, .modal-content, dialog').forEach(a => {
        if (isVisible(a) && a.textContent.trim()) {
          alerts.push(a.textContent.trim().replace(/\s+/g, ' '));
        }
      });

      // 4. Interactive elements
      const selector = [
        'button',
        'a[href]',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]'
      ].join(', ');

      const candidates = Array.from(document.querySelectorAll(selector));
      const elements = [];
      let refCounter = 1;

      for (const el of candidates) {
        if (!isVisible(el)) continue;

        const ref = refCounter++;
        el.setAttribute('data-agent-ref', String(ref));

        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type') || (tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : undefined);
        const label = getElementLabel(el);
        const name = el.getAttribute('name') || undefined;
        const placeholder = el.getAttribute('placeholder') || undefined;
        const required = el.hasAttribute('required');
        const disabled = el.hasAttribute('disabled');
        const readOnly = el.hasAttribute('readonly');

        // Extract value or text
        let value = undefined;
        let text = undefined;
        let options = undefined;

        if (tag === 'select') {
          options = Array.from(el.querySelectorAll('option')).map(opt => ({
            value: opt.value,
            label: opt.textContent.trim(),
            selected: opt.selected
          }));
          value = el.value;
        } else if (tag === 'input' || tag === 'textarea') {
          value = el.value;
        } else if (tag === 'button' || tag === 'a') {
          text = el.textContent.trim();
        }

        elements.push({
          ref,
          tag,
          type,
          label: label || undefined,
          text: text || undefined,
          name,
          value: value !== '' ? value : undefined,
          placeholder,
          required: required || undefined,
          disabled: disabled || undefined,
          readOnly: readOnly || undefined,
          options
        });
      }

      // 5. Brief page text summary (first 800 chars of visible main content)
      const mainEl = document.querySelector('main, #content, .content, body');
      const textContent = mainEl ? mainEl.innerText.replace(/\s+/g, ' ').trim() : '';
      const summary = textContent.slice(0, 800);

      return {
        title: document.title,
        url: window.location.href,
        headings,
        alerts,
        summary,
        elements
      };
    });

    return {
      ok: true,
      data: snapshot
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        type: 'SNAPSHOT_FAILED',
        message: err.message,
        hint: 'Ensure page is loaded before calling browser_snapshot.'
      }
    };
  }
}

/**
 * Helper to find an element by its data-agent-ref.
 * Returns locator or throws STALE_REF error.
 */
async function getElementByRef(page, ref) {
  const locator = page.locator(`[data-agent-ref="${ref}"]`);
  const count = await locator.count();
  if (count === 0) {
    return {
      ok: false,
      error: {
        type: 'STALE_REF',
        message: `Interactive element with ref #${ref} was not found on the page.`,
        hint: 'The DOM has changed. Call browser_snapshot to retrieve fresh element references.'
      }
    };
  }

  // Ensure element is visible
  const isVisible = await locator.first().isVisible().catch(() => false);
  if (!isVisible) {
    return {
      ok: false,
      error: {
        type: 'ELEMENT_NOT_VISIBLE',
        message: `Element #${ref} is currently hidden or detached from the view.`,
        hint: 'Call browser_snapshot to check current visible elements.'
      }
    };
  }

  return { ok: true, locator: locator.first() };
}

/**
 * browser_click: Click an interactive element by ref number.
 */
export async function browserClick({ ref }, context = {}) {
  try {
    const page = await getActivePage(context);
    const target = await getElementByRef(page, ref);
    if (!target.ok) return target;

    const beforeUrl = page.url();
    const beforeTitle = await page.title().catch(() => '');

    await target.locator.click({ timeout: 5000 });

    const whatChanged = await detectChange(page, beforeUrl, beforeTitle);

    return {
      ok: true,
      data: {
        action: 'clicked',
        ref,
        url: page.url(),
        whatChanged
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        type: 'CLICK_FAILED',
        message: err.message,
        hint: 'Check if element is obscured by a modal or disabled. Run browser_snapshot.'
      }
    };
  }
}

/**
 * browser_type: Fill an input or textarea by ref number.
 */
export async function browserType({ ref, text, clear = true }, context = {}) {
  try {
    const page = await getActivePage(context);
    const target = await getElementByRef(page, ref);
    if (!target.ok) return target;

    const beforeUrl = page.url();
    const beforeTitle = await page.title().catch(() => '');

    if (clear) {
      await target.locator.fill(String(text), { timeout: 5000 });
    } else {
      await target.locator.pressSequentially(String(text), { timeout: 5000 });
    }

    const whatChanged = await detectChange(page, beforeUrl, beforeTitle);

    return {
      ok: true,
      data: {
        action: 'typed',
        ref,
        value: text,
        whatChanged
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        type: 'TYPE_FAILED',
        message: err.message,
        hint: 'Ensure target element is an input, textarea, or editable element.'
      }
    };
  }
}

/**
 * browser_select: Select an option in a <select> element by ref and value/label.
 */
export async function browserSelect({ ref, value }, context = {}) {
  try {
    const page = await getActivePage(context);
    const target = await getElementByRef(page, ref);
    if (!target.ok) return target;

    const beforeUrl = page.url();
    const beforeTitle = await page.title().catch(() => '');

    await target.locator.selectOption(value, { timeout: 5000 });

    const whatChanged = await detectChange(page, beforeUrl, beforeTitle);

    return {
      ok: true,
      data: {
        action: 'selected',
        ref,
        selectedValue: value,
        whatChanged
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        type: 'SELECT_FAILED',
        message: err.message,
        hint: 'Verify the option value matches one of the options listed in browser_snapshot.'
      }
    };
  }
}

/**
 * browser_press: Press a keyboard key (e.g. "Enter", "Escape", "Tab").
 */
export async function browserPress({ key }, context = {}) {
  try {
    const page = await getActivePage(context);
    const beforeUrl = page.url();
    const beforeTitle = await page.title().catch(() => '');

    await page.keyboard.press(key);

    const whatChanged = await detectChange(page, beforeUrl, beforeTitle);

    return {
      ok: true,
      data: {
        action: 'key_press',
        key,
        whatChanged
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        type: 'KEY_PRESS_FAILED',
        message: err.message,
        hint: 'Provide standard key names like "Enter", "Escape", "Tab".'
      }
    };
  }
}

/**
 * browser_screenshot: Captures a screenshot and saves it as an artifact.
 */
export async function browserScreenshot({ label = 'snapshot' }, context = {}) {
  try {
    const page = await getActivePage(context);
    const runId = context.runId || 'manual-test';
    const artifactsDir = path.resolve(process.cwd(), 'sandbox', 'artifacts', runId);

    await mkdir(artifactsDir, { recursive: true });

    const filename = `screenshot-${Date.now()}-${label.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
    const fullPath = path.join(artifactsDir, filename);

    await page.screenshot({ path: fullPath, fullPage: false });

    const relativePath = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');

    return {
      ok: true,
      data: {
        path: relativePath,
        label,
        url: page.url()
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        type: 'SCREENSHOT_FAILED',
        message: err.message,
        hint: 'Failed to capture screenshot.'
      }
    };
  }
}

/**
 * browser_login: Automates portal login using credentials from .env.
 * The model NEVER sees or receives the password in its prompt or response.
 */
export async function browserLogin({ site = 'portal' }, context = {}) {
  try {
    const page = await getActivePage(context);
    const targetUrl = `${PORTAL_URL}/login`;

    // 1. Navigate to login page
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const user = process.env.PORTAL_USER || 'demo';
    const pass = process.env.PORTAL_PASS || 'demo123';

    // 2. Fill login form
    // Look for standard username and password fields
    const usernameInput = page.locator('input[name="username"], input[id="username"], input[type="text"]').first();
    const passwordInput = page.locator('input[name="password"], input[id="password"], input[type="password"]').first();
    const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();

    await usernameInput.fill(user, { timeout: 5000 });
    await passwordInput.fill(pass, { timeout: 5000 });

    // 3. Submit and wait for redirection
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
      submitBtn.click()
    ]);

    await page.waitForTimeout(500);

    const currentUrl = page.url();
    const title = await page.title();

    if (currentUrl.includes('/login')) {
      const errorText = await page.evaluate(() => {
        const err = document.querySelector('.alert-error, .error, [role="alert"]');
        return err ? err.textContent.trim() : 'Login failed';
      });

      return {
        ok: false,
        error: {
          type: 'AUTH_FAILED',
          message: `Portal login failed: ${errorText}`,
          hint: 'Verify credentials configured in .env'
        }
      };
    }

    return {
      ok: true,
      data: {
        site,
        user,
        status: 'authenticated',
        url: currentUrl,
        title
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        type: 'LOGIN_FAILED',
        message: err.message,
        hint: 'Ensure portal server is running at PORTAL_URL.'
      }
    };
  }
}
