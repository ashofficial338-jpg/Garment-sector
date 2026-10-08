import mongoose from 'mongoose';
import { unitScoped } from '../services/unitContext.js';

/**
 * Dated inventory ledger for job materials (fabric store and trims / accessories / packing).
 * Bookings keep running totals (received, issued); every change is posted here as a dated movement,
 * so inventory can be valued at any date (opening / closing inventory, turnover, holding period).
 * Written only by services/stockLedger.js – never edited by users.
 */
const movementSchema = new mongoose.Schema({
  date: { type: Date, required: true, index: true },
  category: { type: String, required: true, index: true }, // Fabric | Trims | Accessories | Packing Materials
  direction: { type: String, enum: ['in', 'out'], required: true }, // in = received into store, out = issued to production
  qty: { type: Number, required: true }, // signed: corrections post negative quantities
  unit: String,
  rate: Number,
  value: { type: Number, required: true },
  item: String,
  module: { type: String, required: true }, // fabricBooking | trimBooking
  recordId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  refNo: String,
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', index: true },
  jobNo: { type: String, index: true },
  note: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
movementSchema.plugin(unitScoped);
export const StockMovement = mongoose.model('StockMovement', movementSchema);
