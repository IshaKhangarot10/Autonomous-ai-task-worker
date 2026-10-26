/**
 * HTML layout helper.
 *
 * WHY template literals instead of a template engine:
 * - Zero dependencies, easy to understand in an interview.
 * - The portal is a simple internal app — we don't need partials,
 *   inheritance, or other template engine features.
 * - Every page calls layout() with a title and body HTML string.
 */

/**
 * Wraps page content in a full HTML document with nav and styles.
 * @param {string} title - Page title
 * @param {string} body  - Inner HTML for <main>
 * @param {object} opts  - { user } — the logged-in user, if any
 */
export function layout(title, body, opts = {}) {
  const { user } = opts;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Acme Finance Portal</title>
  <style>
    /* ── Reset & Base ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f7fa;
      color: #1a1a2e;
      line-height: 1.6;
    }

    /* ── Nav ── */
    nav {
      background: #1a1a2e;
      color: #fff;
      padding: 0.75rem 1.5rem;
      display: flex;
      align-items: center;
      gap: 2rem;
    }
    nav .brand { font-weight: 700; font-size: 1.1rem; }
    nav a { color: #a0aec0; text-decoration: none; font-size: 0.9rem; }
    nav a:hover { color: #fff; }
    nav .spacer { flex: 1; }

    /* ── Main ── */
    main {
      max-width: 960px;
      margin: 2rem auto;
      padding: 0 1.5rem;
    }
    h1 { margin-bottom: 1.5rem; font-size: 1.5rem; }

    /* ── Forms ── */
    .form-group { margin-bottom: 1rem; }
    .form-group label {
      display: block;
      margin-bottom: 0.25rem;
      font-weight: 600;
      font-size: 0.9rem;
    }
    .form-group input,
    .form-group select,
    .form-group textarea {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1px solid #cbd5e0;
      border-radius: 6px;
      font-size: 0.95rem;
      background: #fff;
    }
    .form-group input:focus,
    .form-group select:focus,
    .form-group textarea:focus {
      outline: none;
      border-color: #4a6cf7;
      box-shadow: 0 0 0 3px rgba(74,108,247,0.1);
    }

    /* ── Buttons ── */
    .btn {
      display: inline-block;
      padding: 0.5rem 1.25rem;
      border: none;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
    }
    .btn-primary { background: #4a6cf7; color: #fff; }
    .btn-primary:hover { background: #3b5de7; }
    .btn-secondary { background: #e2e8f0; color: #1a1a2e; }
    .btn-secondary:hover { background: #cbd5e0; }

    /* ── Table ── */
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #edf2f7; font-size: 0.9rem; }
    th { background: #f7fafc; font-weight: 600; color: #4a5568; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }

    /* ── Alerts ── */
    .alert { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.9rem; }
    .alert-error { background: #fed7d7; color: #c53030; border: 1px solid #feb2b2; }
    .alert-success { background: #c6f6d5; color: #276749; border: 1px solid #9ae6b4; }
    .alert-info { background: #bee3f8; color: #2a4365; border: 1px solid #90cdf4; }

    /* ── Login ── */
    .login-container {
      max-width: 400px;
      margin: 4rem auto;
      background: #fff;
      padding: 2rem;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
    }

    /* ── Search ── */
    .search-bar {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }
    .search-bar input { flex: 1; }

    /* ── Status badge ── */
    .badge {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-logged { background: #bee3f8; color: #2a4365; }
    .badge-approved { background: #c6f6d5; color: #276749; }
    .badge-paid { background: #e2e8f0; color: #4a5568; }

    /* ── Modal (for chaos popup) ── */
    .modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
    }
    .modal-content {
      background: #fff; padding: 2rem; border-radius: 12px;
      max-width: 450px; width: 90%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.2);
    }
    .modal-content h2 { margin-bottom: 1rem; }
    .modal-content p { margin-bottom: 1.5rem; color: #4a5568; }
  </style>
</head>
<body>
  ${user ? `
  <nav>
    <span class="brand">Acme Finance Portal</span>
    <a href="/invoices">Invoices</a>
    <a href="/invoices/new">New Invoice</a>
    <a href="/vendors">Vendors</a>
    <span class="spacer"></span>
    <span style="font-size:0.85rem;color:#a0aec0">Logged in as ${user.username}</span>
    <a href="/logout">Logout</a>
  </nav>
  ` : ''}
  <main>
    ${body}
  </main>
</body>
</html>`;
}
