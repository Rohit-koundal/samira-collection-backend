const { ApiError } = require('../utils/apiError');

function providerFor(name) {
  if (name === 'bluedart') return require('./blueDartProvider');
  throw new ApiError('SHIPPING_UNAVAILABLE', 'This delivery provider is not connected.', { statusCode: 503 });
}

function getShippingProvider(name) {
  if (name === 'bluedart') return providerFor(name).readiness();
  const shiprocket = Boolean(String(process.env.SHIPROCKET_EMAIL || '').trim() && String(process.env.SHIPROCKET_PASSWORD || '').trim());
  const delhivery = Boolean(String(process.env.DELHIVERY_TOKEN || '').trim());

  if (shiprocket || delhivery) {
    return {
      name: shiprocket ? 'shiprocket' : 'delhivery',
      liveBooking: false,
      trackingLookup: false,
      note: 'Courier credentials are present, but live AWB booking is not enabled. Paste the real tracking number from your courier dashboard. This app never invents AWBs.',
    };
  }

  return {
    name: 'manual',
    liveBooking: false,
    trackingLookup: false,
    note: 'Shipping is manual. Book the parcel with your courier, then paste the real AWB here. Fake tracking numbers are never generated.',
  };
}

function assertLiveBookingDisabled() {
  throw new ApiError(
    'SERVICE_UNAVAILABLE',
    'Live courier booking is not enabled. Enter a real AWB from your courier dashboard.',
  );
}

module.exports = {
  providerFor,
  assertLiveBookingDisabled,
  getShippingProvider,
};
