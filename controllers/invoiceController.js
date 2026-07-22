const PDFDocument = require('pdfkit');
const Order = require('../models/Order');
const { ensureInvoice } = require('../services/invoiceService');
const { assertObjectId } = require('../utils/requestValidation');

exports.getInvoice = async (req, res) => {
  const order = await loadOwnedOrder(req);
  const invoice = await ensureInvoice(order);
  return res.json(invoice);
};

exports.downloadInvoice = async (req, res) => {
  const order = await loadOwnedOrder(req);
  const invoice = await ensureInvoice(order);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `Invoice ${invoice.invoiceNumber}` } });
  doc.on('error', (error) => res.destroy(error));
  doc.pipe(res);
  renderInvoice(doc, invoice);
  doc.end();
};

async function loadOwnedOrder(req) {
  assertObjectId(req.params.orderId, 'order id');
  const order = await Order.findById(req.params.orderId).populate('user', 'name email phone');
  if (!order) {
    const error = new Error('Order not found');
    error.statusCode = 404;
    throw error;
  }
  if (!['admin', 'owner'].includes(req.user.role) && String(order.user?._id || order.user) !== String(req.user._id)) {
    const error = new Error('Not allowed to access this invoice');
    error.statusCode = 403;
    throw error;
  }
  return order;
}

function renderInvoice(doc, invoice) {
  doc.fontSize(20).text(invoice.seller.legalName || 'Samira Collection');
  doc.fontSize(10).text(invoice.seller.address || '');
  if (invoice.seller.gstin) doc.text(`GSTIN: ${invoice.seller.gstin}`);
  doc.moveDown().fontSize(16).text('TAX INVOICE', { align: 'right' });
  doc.fontSize(10).text(`Invoice: ${invoice.invoiceNumber}`, { align: 'right' });
  doc.text(`Issued: ${new Date(invoice.issuedAt).toLocaleDateString('en-IN')}`, { align: 'right' });
  doc.moveDown().fontSize(11).text('Bill / Ship To', { underline: true });
  const address = invoice.shippingAddress || {};
  doc.fontSize(10).text(invoice.customer.name || address.fullName || 'Customer');
  doc.text([address.houseNo || address.houseNumber, address.area, address.city, address.state, address.pincode].filter(Boolean).join(', '));
  doc.moveDown();
  doc.fontSize(9).text('Item', 42, doc.y, { width: 200 });
  doc.text('Qty', 250, doc.y - 10, { width: 40, align: 'right' });
  doc.text('Rate', 300, doc.y - 10, { width: 80, align: 'right' });
  doc.text('Total', 410, doc.y - 10, { width: 100, align: 'right' });
  doc.moveTo(42, doc.y + 3).lineTo(550, doc.y + 3).stroke();
  doc.moveDown();
  for (const line of invoice.lines) {
    const y = doc.y;
    doc.text([line.name, line.sku, [line.size, line.color].filter(Boolean).join(' / ')].filter(Boolean).join(' - '), 42, y, { width: 200 });
    doc.text(String(line.quantity), 250, y, { width: 40, align: 'right' });
    doc.text(formatMoney(line.unitPrice), 300, y, { width: 80, align: 'right' });
    doc.text(formatMoney(line.total), 410, y, { width: 100, align: 'right' });
    doc.moveDown(1.4);
  }
  doc.moveDown();
  const totals = [
    ['Line discount', -Number(invoice.totals.lineDiscount || 0)],
    ['Coupon discount', -Number(invoice.totals.couponDiscount || 0)],
    ['Shipping', invoice.totals.shippingCharge],
    ['Tax', invoice.totals.tax],
    ['Grand total', invoice.totals.grandTotal],
  ];
  for (const [label, amount] of totals) {
    doc.font(label === 'Grand total' ? 'Helvetica-Bold' : 'Helvetica')
      .text(label, 330, doc.y, { width: 100, align: 'right' })
      .text(formatMoney(amount), 440, doc.y - 10, { width: 90, align: 'right' });
  }
  doc.font('Helvetica').moveDown().fontSize(9)
    .text(`Payment: ${invoice.payment.method || ''} / ${invoice.payment.status || ''}`);
  if (invoice.payment.transactionId) doc.text(`Transaction: ${invoice.payment.transactionId}`);
  doc.moveDown(2).fontSize(8).fillColor('#555555')
    .text('This invoice is an immutable financial record. Refunds are recorded through credit notes.');
}

function formatMoney(value) {
  return `Rs. ${Number(value || 0).toFixed(2)}`;
}
