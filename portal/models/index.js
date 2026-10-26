/**
 * Portal Mongoose models: Vendor, Invoice, User.
 *
 * These are defined on the `acme_portal` connection (not the default
 * mongoose connection) so they stay in the portal's database.
 *
 * WHY getModels() is async: it needs the DB connection to be established
 * first. We cache the compiled models so Mongoose doesn't complain
 * about recompiling on repeated calls.
 */

import mongoose from 'mongoose';
import { getPortalDb } from '../../shared/db.js';

const { Schema } = mongoose;

// ── Schemas ──

const vendorSchema = new Schema({
  name:         { type: String, required: true, unique: true },
  billingEmail: { type: String, required: true },
  address:      { type: String, default: '' },
}, { timestamps: true });

const invoiceSchema = new Schema({
  vendor:        { type: String, required: true },          // vendor name (denormalized for simplicity)
  invoiceNumber: { type: String, required: true, unique: true },
  amount:        { type: Number, required: true, min: 0.01 },
  currency:      { type: String, required: true, enum: ['INR', 'USD'] },
  dueDate:       { type: Date,   required: true },
  notes:         { type: String, default: '' },
  status:        { type: String, default: 'logged', enum: ['logged', 'approved', 'paid'] },
}, { timestamps: true });

const userSchema = new Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },   // plain text is fine for a sandbox
}, { timestamps: true });

// ── Cached models ──
let models = null;

export async function getModels() {
  if (models) return models;

  const db = await getPortalDb();

  models = {
    Vendor:  db.model('Vendor',  vendorSchema),
    Invoice: db.model('Invoice', invoiceSchema),
    User:    db.model('User',    userSchema),
  };

  return models;
}
