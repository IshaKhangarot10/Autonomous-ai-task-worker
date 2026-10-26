/**
 * HTTP tools for the agent.
 *
 * Strictly read-only and allowlisted to the company portal API.
 * The agent can query endpoints like /api/vendors or /api/invoices
 * to verify system state or look up records.
 */

const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:4000';
const ALLOWED_ORIGINS = new Set([
  new URL(PORTAL_URL).origin,
  'http://localhost:4000',
  'http://127.0.0.1:4000'
]);

/**
 * http_get: Perform an HTTP GET request to the allowlisted portal API.
 */
export async function httpGet({ url: targetUrl }) {
  if (!targetUrl || typeof targetUrl !== 'string') {
    return {
      ok: false,
      error: {
        type: 'INVALID_URL',
        message: 'A valid URL string is required.',
        hint: 'Provide a full URL such as "http://localhost:4000/api/vendors".'
      }
    };
  }

  // Parse and validate URL
  let parsed;
  try {
    parsed = new URL(targetUrl, PORTAL_URL);
  } catch (err) {
    return {
      ok: false,
      error: {
        type: 'MALFORMED_URL',
        message: `Could not parse URL "${targetUrl}": ${err.message}`,
        hint: 'Ensure URL includes http:// protocol or relative path to portal.'
      }
    };
  }

  // Check allowlist
  if (!ALLOWED_ORIGINS.has(parsed.origin)) {
    return {
      ok: false,
      error: {
        type: 'ORIGIN_NOT_ALLOWED',
        message: `Origin "${parsed.origin}" is not in the allowlist.`,
        hint: `HTTP requests are only permitted to the company portal at ${PORTAL_URL}`
      }
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(parsed.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*'
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    let body;

    if (contentType.includes('application/json')) {
      body = await res.json();
    } else {
      body = await res.text();
    }

    if (!res.ok) {
      return {
        ok: false,
        error: {
          type: 'HTTP_STATUS_ERROR',
          message: `HTTP GET ${parsed.pathname} returned status ${res.status} (${res.statusText})`,
          hint: typeof body === 'object' && body.error ? body.error : 'Check the endpoint path and query parameters.'
        },
        data: {
          status: res.status,
          body
        }
      };
    }

    return {
      ok: true,
      data: {
        status: res.status,
        url: parsed.toString(),
        data: body
      }
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return {
        ok: false,
        error: {
          type: 'HTTP_TIMEOUT',
          message: `Request to ${targetUrl} timed out after 10000ms.`,
          hint: 'The portal server might be busy or slow to respond.'
        }
      };
    }

    return {
      ok: false,
      error: {
        type: 'HTTP_REQUEST_FAILED',
        message: err.message,
        hint: 'Ensure the portal server is running on http://localhost:4000.'
      }
    };
  }
}
