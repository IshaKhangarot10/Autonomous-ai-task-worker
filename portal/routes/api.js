/**
 * Portal REST API routes.
 *
 * These are the endpoints the agent's verifier and http_get tool use
 * to check system state independently of the browser.
 *
 * WHY separate API routes from page routes:
 * - API returns JSON, pages return HTML — different concerns.
 * - The agent uses both: browser for interaction, API for verification.
 * - Keeps each file focused and small.
 */

import { Router } from 'express';
import { getModels } from '../models/index.js';
import { getRuntimeChaos, setRuntimeChaos } from '../middleware/chaos.js';

const router = Router();
let flakyFired = false;

// ── Invoices ──

/**
 * GET /api/invoices
 * Query params: invoiceNumber, vendor (both optional, for filtering).
 */
router.get('/api/invoices', async (req, res) => {
  try {
    const { Invoice } = await getModels();
    const filter = {};

    if (req.query.invoiceNumber) {
      filter.invoiceNumber = req.query.invoiceNumber;
    }
    if (req.query.vendor) {
      // Case-insensitive partial match so the agent doesn't need exact casing.
      filter.vendor = { $regex: req.query.vendor, $options: 'i' };
    }

    const invoices = await Invoice.find(filter).sort({ createdAt: -1 }).lean();
    res.json(invoices);
  } catch (err) {
    console.error('[api] GET /api/invoices error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/invoices
 * Creates a new invoice. Validates required fields and rejects duplicates.
 */
router.post('/api/invoices', async (req, res) => {
  try {
    const { Invoice, Vendor } = await getModels();
    const { vendor, invoiceNumber, amount, currency, dueDate, notes } = req.body;

    // ── Validation ──
    const errors = [];
    if (!vendor) errors.push('Vendor is required');
    if (!invoiceNumber) errors.push('Invoice Number is required');
    if (!amount || Number(amount) <= 0) errors.push('Amount must be greater than 0');
    if (!currency || !['INR', 'USD'].includes(currency)) errors.push('Currency must be INR or USD');
    if (!dueDate) errors.push('Due Date is required');

    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    // ── Vendor existence check ──
    const vendorDoc = await Vendor.findOne({ name: vendor });
    if (!vendorDoc) {
      return res.status(400).json({ error: `Vendor "${vendor}" not found` });
    }

    // ── Duplicate check ──
    const existing = await Invoice.findOne({ invoiceNumber });
    if (existing) {
      return res.status(409).json({
        error: `Invoice number "${invoiceNumber}" already exists`,
        existing: existing.toObject(),
      });
    }

    // ── Chaos: flaky_submit ──
    // First POST attempt fails with 500. Tracked so the retry succeeds.
    if (req.chaos?.has('flaky_submit') && !flakyFired && !req.session?._flakyFired) {
      flakyFired = true;
      if (req.session) req.session._flakyFired = true;
      return res.status(500).json({ error: 'Service temporarily unavailable' });
    }

    const invoice = await Invoice.create({
      vendor,
      invoiceNumber,
      amount: Number(amount),
      currency,
      dueDate: new Date(dueDate),
      notes: notes || '',
    });

    res.status(201).json(invoice.toObject());
  } catch (err) {
    console.error('[api] POST /api/invoices error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/invoices/:id
 * Partial update (e.g. status change).
 */
router.patch('/api/invoices/:id', async (req, res) => {
  try {
    const { Invoice } = await getModels();
    const invoice = await Invoice.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    res.json(invoice.toObject());
  } catch (err) {
    console.error('[api] PATCH /api/invoices/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Vendors ──

/**
 * GET /api/vendors
 * Returns all vendors.
 */
router.get('/api/vendors', async (req, res) => {
  try {
    const { Vendor } = await getModels();
    const vendors = await Vendor.find().sort({ name: 1 }).lean();
    res.json(vendors);
  } catch (err) {
    console.error('[api] GET /api/vendors error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/vendors/:id
 * Partial update (e.g. billing email change).
 */
router.patch('/api/vendors/:id', async (req, res) => {
  try {
    const { Vendor } = await getModels();
    const vendor = await Vendor.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    res.json(vendor.toObject());
  } catch (err) {
    console.error('[api] PATCH /api/vendors/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// ── Chaos API ──
router.get('/api/chaos', (req, res) => {
  res.json({ modes: Array.from(getRuntimeChaos()) });
});

router.post('/api/chaos', (req, res) => {
  const modes = req.body.modes || [];
  flakyFired = false;
  const modeArr = (Array.isArray(modes) ? modes : [modes]).filter(m => m && String(m).trim().toLowerCase() !== 'none');
  setRuntimeChaos(new Set(modeArr));
  res.json({ ok: true, modes: Array.from(getRuntimeChaos()) });
});

export default router;
