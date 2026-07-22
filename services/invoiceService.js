const Invoice = require('../models/Invoice');
const InvoiceCounter = require('../models/InvoiceCounter');
const Settings = require('../models/Settings');

async function ensureInvoice(order) {
  const existing = await Invoice.findOne({ order: order._id });
  if (existing) return existing;
  if (order.orderStatus === 'Cancelled') {
    const error = new Error('An invoice cannot be issued for a cancelled order');
    error.statusCode = 409;
    error.code = 'INVOICE_NOT_ELIGIBLE';
    throw error;
  }
  const settings = await Settings.findOne().lean() || {};
  const year = new Date().getUTCFullYear();
  const counter = await InvoiceCounter.findOneAndUpdate(
    { year },
    { $inc: { sequence: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  const prefix = String(settings.invoicePrefix || process.env.INVOICE_PREFIX || 'SC').replace(/[^A-Z0-9-]/gi, '').toUpperCase().slice(0, 12) || 'SC';
  const invoiceNumber = `${prefix}-${year}-${String(counter.sequence).padStart(6, '0')}`;
  const snapshot = buildInvoiceSnapshot(order, settings, invoiceNumber);
  try {
    return await Invoice.create(snapshot);
  } catch (error) {
    if (error.code === 11000) {
      const raced = await Invoice.findOne({ order: order._id });
      if (raced) return raced;
    }
    throw error;
  }
}

function buildInvoiceSnapshot(order, settings, invoiceNumber) {
  const customer = order.user && typeof order.user === 'object' ? order.user : {};
  const lines = (order.orderItems || []).map((item) => {
    const quantity = Number(item.quantity || 1);
    const unitPrice = money(item.price);
    const originalPrice = money(item.originalPrice || item.price);
    const lineDiscount = money(Math.max(0, originalPrice - unitPrice) * quantity);
    const taxRate = Math.max(0, Number(item.taxRate || 0));
    const taxableAmount = money(unitPrice * quantity);
    const taxAmount = money(item.taxAmount || 0);
    return {
      product: item.product,
      name: item.name,
      sku: item.sku,
      hsn: item.hsn,
      size: item.size,
      color: item.color,
      quantity,
      unitPrice,
      originalPrice,
      lineDiscount,
      taxableAmount,
      taxRate,
      taxAmount,
      total: money(taxableAmount + taxAmount),
    };
  });
  const tax = money(order.taxAmount || lines.reduce((sum, line) => sum + line.taxAmount, 0));
  const destinationState = String(order.shippingAddress?.state || '').trim().toLowerCase();
  const sellerState = String(settings.sellerState || '').trim().toLowerCase();
  const intraState = sellerState && destinationState && sellerState === destinationState;
  return {
    invoiceNumber,
    order: order._id,
    seller: {
      legalName: settings.sellerLegalName || settings.storeName || 'Samira Collection',
      address: settings.sellerAddress || settings.address || '',
      state: settings.sellerState || '',
      gstin: settings.gstin || '',
    },
    customer: { name: customer.name, email: customer.email, phone: customer.phone },
    billingAddress: order.billingAddress || order.shippingAddress,
    shippingAddress: order.shippingAddress,
    lines,
    totals: {
      subtotal: money(lines.reduce((sum, line) => sum + line.originalPrice * line.quantity, 0)),
      lineDiscount: money(order.productDiscount || lines.reduce((sum, line) => sum + line.lineDiscount, 0)),
      couponDiscount: money(order.couponDiscount),
      shippingCharge: money(Number(order.deliveryCharge || 0) + Number(order.codCharge || 0)),
      tax,
      grandTotal: money(order.finalAmount),
    },
    taxBreakdown: {
      cgst: intraState ? money(tax / 2) : 0,
      sgst: intraState ? money(tax / 2) : 0,
      igst: intraState ? 0 : tax,
    },
    payment: {
      method: order.paymentMethod,
      status: order.paymentStatus,
      transactionId: order.razorpayPaymentId || order.paymentTransactionId,
    },
  };
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

module.exports = { buildInvoiceSnapshot, ensureInvoice };
