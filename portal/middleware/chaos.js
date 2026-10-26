/**
 * Chaos middleware — placeholder for Phase 7.
 *
 * This module will inject configurable failures into the portal
 * (flaky submits, slow loads, renamed fields, session expiry, popups)
 * to test the agent's error recovery.
 *
 * For now, it reads the active chaos modes from the environment
 * and stores them on req for routes to use.
 */

/**
 * Parse comma-separated chaos modes from env or runtime config.
 * Returns a Set of active mode strings.
 */
export function getActiveChaos() {
  const raw = (process.env.CHAOS || 'none').trim();
  if (!raw || raw.toLowerCase() === 'none') return new Set();
  const modes = raw.split(',').map(s => s.trim()).filter(s => s && s.toLowerCase() !== 'none');
  return new Set(modes);
}

// Runtime-mutable chaos modes (toggled via /admin/chaos).
let runtimeChaos = null;

export function setRuntimeChaos(modes) {
  if (modes === null) {
    runtimeChaos = null;
    return;
  }
  const modeArr = Array.from(modes).filter(s => s && String(s).trim().toLowerCase() !== 'none');
  runtimeChaos = new Set(modeArr);
}

export function resetRuntimeChaos() {
  runtimeChaos = null;
}

export function getRuntimeChaos() {
  if (runtimeChaos !== null) return runtimeChaos;
  return getActiveChaos();
}

/**
 * Middleware that attaches active chaos modes to the request.
 */
export function chaosMiddleware(req, res, next) {
  req.chaos = getRuntimeChaos();
  next();
}
