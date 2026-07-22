const DisabledShippingProvider = require('./shipping/providers/disabledProvider');
const ShiprocketProvider = require('./shipping/providers/shiprocketProvider');

let provider;

function getShippingProvider() {
  if (provider) return provider;
  const selected = String(process.env.SHIPPING_PROVIDER || 'disabled').toLowerCase();
  if (selected === 'shiprocket') {
    if (!process.env.SHIPROCKET_EMAIL || !process.env.SHIPROCKET_PASSWORD) {
      provider = new DisabledShippingProvider('Shiprocket credentials are not configured');
    } else {
      provider = new ShiprocketProvider({
        email: process.env.SHIPROCKET_EMAIL,
        password: process.env.SHIPROCKET_PASSWORD,
        baseUrl: process.env.SHIPROCKET_BASE_URL || 'https://apiv2.shiprocket.in',
      });
    }
  } else if (selected === 'disabled' || !selected) {
    provider = new DisabledShippingProvider();
  } else {
    provider = new DisabledShippingProvider('Configured shipping provider is not supported');
  }
  return provider;
}

function getShippingState() {
  return getShippingProvider().state();
}

module.exports = {
  calculateRate: (input) => getShippingProvider().calculateRate(input),
  checkServiceability: (input) => getShippingProvider().checkServiceability(input),
  createShipment: (input) => getShippingProvider().createShipment(input),
  getLabel: (input) => getShippingProvider().getLabel(input),
  getShippingState,
  getTracking: (input) => getShippingProvider().getTracking(input),
  reportNdr: (input) => getShippingProvider().reportNdr(input),
  requestPickup: (input) => getShippingProvider().requestPickup(input),
};
