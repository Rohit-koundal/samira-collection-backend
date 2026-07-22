function wrapPaymentHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = Number(error.statusCode)
        || (error.razorpayAuthError ? 502 : error.razorpayError ? 502 : 500);
      const exposeMessage = Number(error.statusCode) >= 400 && Number(error.statusCode) < 500;
      res.status(status).json({
        message: exposeMessage ? error.message : 'Payment request failed',
        code: error.code || 'PAYMENT_REQUEST_FAILED',
      });
    }
  };
}

module.exports = {
  wrapPaymentHandler,
};
