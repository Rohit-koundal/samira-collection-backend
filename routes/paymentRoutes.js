const crypto = require('crypto');
const router = require('express').Router();
const Order = require('../models/Order');
const { protect } = require('../middleware/authMiddleware');
const orderController = require('../controllers/orderController');

router.use(protect);

router.post('/create-order', async (req, res) => {
  try {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) return res.status(503).json({ message: 'Razorpay is not configured. Use COD or add payment keys in .env.' });

    const { totals } = await orderController.prepareOrder(req.body.orderItems, req.body.coupon?.code);
    const razorpayOrderId = `rzp_ready_${Date.now()}`;
    res.json({ razorpayOrderId, amount: Math.round(totals.finalAmount * 100), currency: 'INR', keyId, mode: process.env.PAYMENT_GATEWAY_MODE || 'test' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.post('/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderPayload } = req.body;
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) return res.status(503).json({ message: 'Razorpay is not configured' });
    const expected = crypto.createHmac('sha256', secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ message: 'Payment verification failed' });

    const { items, totals } = await orderController.prepareOrder(orderPayload.orderItems, orderPayload.coupon?.code);
    let order = await Order.findOne({ razorpayOrderId: razorpay_order_id });
    if (!order) {
      order = await Order.create({
        ...orderPayload,
        orderItems: items,
        user: req.user._id,
        paymentMethod: orderPayload.paymentMethod || 'UPI',
        paymentProvider: 'Razorpay',
        paymentStatus: 'Paid',
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        ...totals,
        statusTimeline: [{ status: 'Pending', date: new Date(), note: 'Payment verified and order placed' }],
      });
      await orderController.reduceStock(items);
    }
    res.json({ success: true, order });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.post('/failure', async (req, res) => {
  res.status(202).json({ success: false, message: req.body.reason || 'Payment failed. Please retry or choose COD.' });
});

module.exports = router;
