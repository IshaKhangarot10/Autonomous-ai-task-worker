/**
 * Portal HTML page routes.
 *
 * Each route renders HTML using the layout() helper. Pages have proper
 * <label for="..."> associations, semantic HTML, and visible error
 * messages so the agent's browser_snapshot can discover form fields
 * and read validation errors.
 *
 * WHY server-rendered HTML instead of a SPA:
 * - The agent navigates pages and reads the DOM. Server-rendered HTML
 *   means the page is ready immediately — no JS hydration to wait for.
 * - Simpler to build, debug, and explain.
 */

import { Router } from 'express';
import { getModels } from '../models/index.js';
import { layout } from '../views/layout.js';
import { getRuntimeChaos, setRuntimeChaos } from '../middleware/chaos.js';

const router = Router();

// ── Login ──

router.get('/login', (req, res) => {
  const error = req.query.error || '';
  const html = layout('Login', `
    <div class="login-container">
      <h1>Login</h1>
      ${error ? `<div class="alert alert-error">${error}</div>` : ''}
      <form method="POST" action="/login">
        <div class="form-group">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" required placeholder="Enter username" autocomplete="username">
        </div>
        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required placeholder="Enter password" autocomplete="current-password">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:0.5rem">Log In</button>
      </form>
    </div>
  `);
  res.send(html);
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const { User } = await getModels();

  const user = await User.findOne({ username });
  if (!user || user.password !== password) {
    return res.redirect('/login?error=Invalid+username+or+password');
  }

  req.session.user = { id: user._id.toString(), username: user.username };
  req.session.save((err) => {
    if (err) console.error('[pages] session save error on login:', err);
    res.redirect('/invoices');
  });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// ── Invoices List ──

router.get('/invoices', async (req, res) => {
  const { Invoice } = await getModels();
  const search = req.query.search || '';

  let filter = {};
  if (search) {
    filter = {
      $or: [
        { vendor: { $regex: search, $options: 'i' } },
        { invoiceNumber: { $regex: search, $options: 'i' } },
      ],
    };
  }

  const invoices = await Invoice.find(filter).sort({ createdAt: -1 }).lean();

  const rows = invoices.map(inv => {
    const locale = (inv.currency || '').toUpperCase() === 'INR' ? 'en-IN' : 'en-US';
    const formattedAmount = Number(inv.amount).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `
    <tr>
      <td>${inv.vendor}</td>
      <td>${inv.invoiceNumber}</td>
      <td>${formattedAmount}</td>
      <td>${inv.currency}</td>
      <td>${new Date(inv.dueDate).toISOString().split('T')[0]}</td>
      <td><span class="badge badge-${inv.status}">${inv.status}</span></td>
      <td>${inv.notes || '—'}</td>
    </tr>
  `;
  }).join('');

  const html = layout('Invoices', `
    <h1>Invoices</h1>
    <div class="search-bar">
      <form method="GET" action="/invoices" style="display:flex;gap:0.5rem;width:100%">
        <input type="text" id="search" name="search" placeholder="Search by vendor or invoice number…" value="${search}">
        <button type="submit" class="btn btn-secondary">Search</button>
      </form>
      <a href="/invoices/new" class="btn btn-primary" style="white-space:nowrap">+ New Invoice</a>
    </div>
    ${invoices.length === 0
      ? '<div class="alert alert-info">No invoices found.</div>'
      : `<table>
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Invoice Number</th>
              <th>Amount</th>
              <th>Currency</th>
              <th>Due Date</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`
    }
  `, { user: req.session.user });

  res.send(html);
});

// ── New Invoice Form ──

router.get('/invoices/new', async (req, res) => {
  const { Vendor } = await getModels();
  const vendors = await Vendor.find().sort({ name: 1 }).lean();
  const error = req.query.error || '';
  const success = req.query.success || '';

  // ── Chaos: renamed_fields changes labels/ids ──
  const chaos = req.chaos || new Set();
  const labels = {
    vendor:        chaos.has('renamed_fields') ? 'Supplier'       : 'Vendor',
    invoiceNumber: chaos.has('renamed_fields') ? 'Reference No.'  : 'Invoice Number',
    amount:        'Amount',
    currency:      'Currency',
    dueDate:       chaos.has('renamed_fields') ? 'Payment Due By' : 'Due Date',
    notes:         'Notes',
  };
  const ids = {
    vendor:        chaos.has('renamed_fields') ? 'supplier'       : 'vendor',
    invoiceNumber: chaos.has('renamed_fields') ? 'referenceNo'    : 'invoiceNumber',
    amount:        'amount',
    currency:      'currency',
    dueDate:       chaos.has('renamed_fields') ? 'paymentDueBy'   : 'dueDate',
    notes:         'notes',
  };

  const vendorOptions = vendors.map(v =>
    `<option value="${v.name}">${v.name}</option>`
  ).join('');

  // ── Chaos: slow_load wraps the form in a delayed render ──
  const delay = chaos.has('slow_load') ? (3000 + Math.random() * 2000) : 0;

  // ── Chaos: popup shows a modal that must be dismissed ──
  const popupHtml = chaos.has('popup') ? `
    <div class="modal-overlay" id="whats-new-modal">
      <div class="modal-content">
        <h2>🎉 What's New</h2>
        <p>We've updated the invoice form with a streamlined layout. Enjoy the new experience!</p>
        <button class="btn btn-primary" id="dismiss-modal" onclick="document.getElementById('whats-new-modal').remove()">Got it!</button>
      </div>
    </div>
  ` : '';

  // ── Chaos: session_expiry destroys the session after first page load ──
  if (chaos.has('session_expiry')) {
    if (!req.session._sessionExpired) {
      req.session._sessionExpired = true;
      // Mark session for destruction on next request.
      req.session._willExpire = true;
    } else if (req.session._willExpire) {
      // Destroy session on the next request (the form submission).
      req.session.destroy(() => {});
      return res.redirect('/login');
    }
  } else {
    delete req.session._willExpire;
    delete req.session._sessionExpired;
  }

  const formHtml = `
    <form method="POST" action="/invoices/new" id="invoice-form">
      <div class="form-group">
        <label for="${ids.vendor}">${labels.vendor}</label>
        <select id="${ids.vendor}" name="vendor" required>
          <option value="">Select ${labels.vendor.toLowerCase()}…</option>
          ${vendorOptions}
        </select>
      </div>
      <div class="form-group">
        <label for="${ids.invoiceNumber}">${labels.invoiceNumber}</label>
        <input type="text" id="${ids.invoiceNumber}" name="invoiceNumber" required placeholder="e.g. INV-2045">
      </div>
      <div class="form-group">
        <label for="${ids.amount}">${labels.amount}</label>
        <input type="number" id="${ids.amount}" name="amount" required min="0.01" step="0.01" placeholder="0.00">
      </div>
      <div class="form-group">
        <label for="${ids.currency}">${labels.currency}</label>
        <select id="${ids.currency}" name="currency" required>
          <option value="">Select currency…</option>
          <option value="INR">INR</option>
          <option value="USD">USD</option>
        </select>
      </div>
      <div class="form-group">
        <label for="${ids.dueDate}">${labels.dueDate}</label>
        <input type="date" id="${ids.dueDate}" name="dueDate" required>
      </div>
      <div class="form-group">
        <label for="${ids.notes}">${labels.notes}</label>
        <textarea id="${ids.notes}" name="notes" rows="3" placeholder="Optional notes…"></textarea>
      </div>
      <button type="submit" class="btn btn-primary">Create Invoice</button>
    </form>
  `;

  const html = layout('New Invoice', `
    <h1>New Invoice</h1>
    ${error ? `<div class="alert alert-error" role="alert">${error}</div>` : ''}
    ${success ? `<div class="alert alert-success" role="alert">${success}</div>` : ''}
    ${delay > 0
      ? `<div id="loading-msg" class="alert alert-info">Loading form…</div>
         <div id="form-container" style="display:none">${formHtml}</div>
         <script>setTimeout(function(){
           document.getElementById('loading-msg').style.display='none';
           document.getElementById('form-container').style.display='block';
         }, ${Math.round(delay)});</script>`
      : formHtml
    }
    ${popupHtml}
  `, { user: req.session.user });

  res.send(html);
});

router.post('/invoices/new', async (req, res) => {
  const { Invoice, Vendor } = await getModels();
  const { vendor, invoiceNumber, amount, currency, dueDate, notes } = req.body;

  // ── Server validation ──
  const errors = [];
  if (!vendor) errors.push('Vendor is required');
  if (!invoiceNumber) errors.push('Invoice Number is required');
  if (!amount || Number(amount) <= 0) errors.push('Amount must be greater than 0');
  if (!currency || !['INR', 'USD'].includes(currency)) errors.push('Currency must be INR or USD');
  if (!dueDate) errors.push('Due Date is required');

  if (errors.length > 0) {
    return res.redirect(`/invoices/new?error=${encodeURIComponent(errors.join('; '))}`);
  }

  // Vendor existence check.
  const vendorDoc = await Vendor.findOne({ name: vendor });
  if (!vendorDoc) {
    return res.redirect(`/invoices/new?error=${encodeURIComponent(`Vendor "${vendor}" not found`)}`);
  }

  // Duplicate check.
  const existing = await Invoice.findOne({ invoiceNumber });
  if (existing) {
    return res.redirect(`/invoices/new?error=${encodeURIComponent(`Invoice number "${invoiceNumber}" already exists`)}`);
  }

  // ── Chaos: flaky_submit — first submission returns 500 ──
  if (req.chaos?.has('flaky_submit') && !req.session._flakyFired) {
    req.session._flakyFired = true;
    return res.redirect(`/invoices/new?error=${encodeURIComponent('Service temporarily unavailable. Please try again.')}`);
  }

  try {
    await Invoice.create({
      vendor,
      invoiceNumber,
      amount: Number(amount),
      currency,
      dueDate: new Date(dueDate),
      notes: notes || '',
    });

    return req.session.save((err) => {
      if (err) console.error('[pages] session save error on create invoice:', err);
      res.redirect('/invoices');
    });
  } catch (err) {
    console.error('[pages] POST /invoices/new error:', err);
    return res.redirect(`/invoices/new?error=${encodeURIComponent('An unexpected error occurred')}`);
  }
});

// ── Vendors List ──

router.get('/vendors', async (req, res) => {
  const { Vendor } = await getModels();
  const vendors = await Vendor.find().sort({ name: 1 }).lean();

  const rows = vendors.map(v => `
    <tr>
      <td>${v.name}</td>
      <td>${v.billingEmail}</td>
      <td>${v.address || '—'}</td>
      <td><a href="/vendors/${v._id}/edit" class="btn btn-secondary" style="padding:0.25rem 0.75rem;font-size:0.8rem">Edit</a></td>
    </tr>
  `).join('');

  const html = layout('Vendors', `
    <h1>Vendors</h1>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Billing Email</th>
          <th>Address</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `, { user: req.session.user });

  res.send(html);
});

// ── Vendor Edit ──

router.get('/vendors/:id/edit', async (req, res) => {
  const { Vendor } = await getModels();
  const vendor = await Vendor.findById(req.params.id).lean();
  if (!vendor) {
    return res.status(404).send(layout('Not Found', '<div class="alert alert-error">Vendor not found</div>', { user: req.session.user }));
  }

  const error = req.query.error || '';
  const success = req.query.success || '';

  const html = layout(`Edit ${vendor.name}`, `
    <h1>Edit Vendor: ${vendor.name}</h1>
    ${error ? `<div class="alert alert-error" role="alert">${error}</div>` : ''}
    ${success ? `<div class="alert alert-success" role="alert">${success}</div>` : ''}
    <form method="POST" action="/vendors/${vendor._id}/edit">
      <div class="form-group">
        <label for="name">Vendor Name</label>
        <input type="text" id="name" name="name" value="${vendor.name}" disabled>
      </div>
      <div class="form-group">
        <label for="billingEmail">Billing Email</label>
        <input type="email" id="billingEmail" name="billingEmail" value="${vendor.billingEmail}" required placeholder="vendor@example.com">
      </div>
      <div class="form-group">
        <label for="address">Address</label>
        <textarea id="address" name="address" rows="2" placeholder="Optional address…">${vendor.address || ''}</textarea>
      </div>
      <button type="submit" class="btn btn-primary">Save Changes</button>
      <a href="/vendors" class="btn btn-secondary" style="margin-left:0.5rem">Cancel</a>
    </form>
  `, { user: req.session.user });

  res.send(html);
});

router.post('/vendors/:id/edit', async (req, res) => {
  const { Vendor } = await getModels();
  const { billingEmail, address } = req.body;

  if (!billingEmail) {
    return res.redirect(`/vendors/${req.params.id}/edit?error=${encodeURIComponent('Billing Email is required')}`);
  }

  try {
    await Vendor.findByIdAndUpdate(req.params.id, {
      billingEmail,
      address: address || '',
    });
    return res.redirect(`/vendors/${req.params.id}/edit?success=${encodeURIComponent('Vendor updated successfully')}`);
  } catch (err) {
    console.error('[pages] POST /vendors/:id/edit error:', err);
    return res.redirect(`/vendors/${req.params.id}/edit?error=${encodeURIComponent('An unexpected error occurred')}`);
  }
});

// ── Admin: Chaos Toggle ──

router.get('/admin/chaos', (req, res) => {
  const ALL_MODES = ['flaky_submit', 'slow_load', 'renamed_fields', 'session_expiry', 'popup'];
  const active = getRuntimeChaos();

  const checkboxes = ALL_MODES.map(mode => `
    <div class="form-group" style="display:flex;align-items:center;gap:0.5rem">
      <input type="checkbox" id="chaos-${mode}" name="modes" value="${mode}" ${active.has(mode) ? 'checked' : ''}>
      <label for="chaos-${mode}" style="margin-bottom:0;font-weight:400">${mode}</label>
    </div>
  `).join('');

  const html = layout('Chaos Mode', `
    <h1>Chaos Mode Settings</h1>
    <div class="alert alert-info">Toggle failure modes to test agent resilience. Changes take effect immediately.</div>
    <form method="POST" action="/admin/chaos">
      ${checkboxes}
      <button type="submit" class="btn btn-primary" style="margin-top:1rem">Save</button>
    </form>
  `, { user: req.session.user });

  res.send(html);
});

router.post('/admin/chaos', (req, res) => {
  let modes = req.body.modes || [];
  // When only one checkbox is checked, Express gives a string, not an array.
  if (typeof modes === 'string') modes = [modes];
  setRuntimeChaos(new Set(modes));
  res.redirect('/admin/chaos');
});

// ── Root redirect ──
router.get('/', (req, res) => {
  res.redirect('/invoices');
});

export default router;
