function wrapPaymentHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.statusCode
        || (error.razorpayAuthError ? 401 : error.razorpayError ? 500 : 400);
      res.status(status).json({ message: error.message || 'Payment request failed' });
    }
  };
}

module.exports = {
  wrapPaymentHandler,
};
