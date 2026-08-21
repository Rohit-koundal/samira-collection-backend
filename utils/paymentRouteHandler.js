function wrapPaymentHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.statusCode
        || (error.razorpayAuthError ? 401 : error.razorpayError ? 500 : 400);
      res.status(status).json({
        success: false,
        code: error.errorCode || (error.razorpayError ? 'PAYMENT_FAILED' : 'REQUEST_FAILED'),
        message: error.message || 'Payment request failed',
      });
    }
  };
}

module.exports = {
  wrapPaymentHandler,
};
