const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const SHIPMENT_STATUSES = ['READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED'];

const shipmentSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
  courierName: String,
  trackingNumber: String,
  trackingUrl: String,
  awb: String,
  status: { type: String, enum: SHIPMENT_STATUSES, default: 'READY_TO_SHIP' },
  events: [{
    status: String,
    note: String,
    date: { type: Date, default: Date.now },
  }],
  provider: { type: String, default: 'manual' },
  providerRef: String,
}, { timestamps: true });

shipmentSchema.plugin(storeIdPlugin);
shipmentSchema.index({ storeId: 1, awb: 1 }, { sparse: true });
shipmentSchema.index({ storeId: 1, createdAt: -1 });

module.exports = mongoose.model('Shipment', shipmentSchema);
module.exports.SHIPMENT_STATUSES = SHIPMENT_STATUSES;
