/**
 * Auth middleware for the portal.
 *
 * WHY session-based auth (not JWT):
 * - The agent interacts via a real browser, so cookies are natural.
 * - Session expiry chaos mode needs server-side session control.
 * - Simpler for a sandbox app — no token refresh logic needed.
 */

/**
 * Blocks unauthenticated requests to protected pages.
 * API routes and /login are excluded.
 */
export function requireAuth(req, res, next) {
  // Allow login page, API auth, and chaos configuration endpoints through.
  if (req.path === '/login' || req.path === '/logout' || req.path === '/admin/chaos' || req.path === '/api/chaos') {
    return next();
  }

  // Allow static assets if we ever add them.
  if (req.path.startsWith('/favicon')) {
    return next();
  }

  // Allow read-only API access without auth. The agent's verifier
  // and http_get tool query GET /api/* to independently check state.
  // Mutating API requests (POST, PATCH, DELETE) still require auth.
  if (req.path.startsWith('/api/') && req.method === 'GET') {
    return next();
  }

  if (!req.session?.user) {
    // For API requests, return 401 JSON.
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // For page requests, redirect to login.
    return res.redirect('/login');
  }

  next();
}
