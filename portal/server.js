/**
 * Acme Finance Portal — Express server.
 *
 * This is the "company app" that the AI agent interacts with through
 * a browser. It has its own backend, database, and auth — completely
 * independent from the agent code.
 *
 * WHY Express (not Next.js for the portal):
 * - The portal is a simple server-rendered app. Express is minimal,
 *   has zero magic, and every line is explainable.
 * - Next.js is used for the dashboard (Phase 8) where React + SSR
 *   actually helps with the live updating UI.
 */

import 'dotenv/config';
import express from 'express';
import session from 'express-session';

import { requireAuth } from './middleware/auth.js';
import { chaosMiddleware } from './middleware/chaos.js';
import apiRoutes from './routes/api.js';
import pageRoutes from './routes/pages.js';

const app = express();

// ── Body parsing ──
// express.urlencoded for form submissions, express.json for API calls.
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Sessions ──
app.use(session({
  secret: process.env.PORTAL_SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60,   // 1 hour
    httpOnly: true,
    secure: false,             // no HTTPS in dev
  },
}));

// ── Middleware ──
app.use(chaosMiddleware);     // Attaches req.chaos (Set of active modes)
app.use(requireAuth);         // Redirects unauthenticated requests to /login

// ── Routes ──
app.use(apiRoutes);           // /api/invoices, /api/vendors
app.use(pageRoutes);          // /login, /invoices, /vendors, /admin/chaos

// ── Start ──
const PORT = process.env.PORTAL_PORT || 4000;
app.listen(PORT, () => {
  console.log(`[portal] Acme Finance Portal running at http://localhost:${PORT}`);
});
