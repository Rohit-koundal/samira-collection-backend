class DisabledShippingProvider {
  constructor(reason = 'Shipping provider is not configured') {
    this.name = 'disabled';
    this.reason = reason;
  }

  state() {
    return { enabled: false, provider: null, reason: this.reason };
  }

  unavailable() {
    const error = new Error(this.reason);
    error.statusCode = 503;
    error.code = 'SHIPPING_NOT_CONFIGURED';
    throw error;
  }

  checkServiceability() { return this.unavailable(); }
  calculateRate() { return this.unavailable(); }
  createShipment() { return this.unavailable(); }
  requestPickup() { return this.unavailable(); }
  getTracking() { return this.unavailable(); }
  getLabel() { return this.unavailable(); }
  reportNdr() { return this.unavailable(); }
}

module.exports = DisabledShippingProvider;
