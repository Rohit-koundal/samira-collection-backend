class ShiprocketProvider {
  constructor(config) {
    this.name = 'shiprocket';
    this.config = config;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  state() {
    return { enabled: true, provider: this.name };
  }

  async authenticate() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const response = await this.request('/v1/external/auth/login', {
      method: 'POST',
      unauthenticated: true,
      body: { email: this.config.email, password: this.config.password },
    });
    if (!response.token) throw providerError('Shipping provider authentication failed');
    this.token = response.token;
    this.tokenExpiresAt = Date.now() + 8 * 24 * 60 * 60 * 1000;
    return this.token;
  }

  async checkServiceability({ pickupPincode, deliveryPincode, cod = false, weightKg = 0.5 }) {
    const params = new URLSearchParams({
      pickup_postcode: validatePincode(pickupPincode),
      delivery_postcode: validatePincode(deliveryPincode),
      cod: cod ? '1' : '0',
      weight: String(validateWeight(weightKg)),
    });
    const data = await this.request(`/v1/external/courier/serviceability/?${params}`);
    const couriers = Array.isArray(data?.data?.available_courier_companies) ? data.data.available_courier_companies : [];
    return {
      serviceable: couriers.length > 0,
      couriers: couriers.map((courier) => ({
        id: courier.courier_company_id,
        name: courier.courier_name,
        rate: Number(courier.rate || 0),
        estimatedDays: courier.estimated_delivery_days,
        cod: Boolean(courier.cod),
      })),
    };
  }

  async calculateRate(input) {
    return this.checkServiceability(input);
  }

  async createShipment(payload) {
    const required = ['order_id', 'order_date', 'pickup_location', 'billing_customer_name', 'billing_address',
      'billing_city', 'billing_pincode', 'billing_state', 'billing_country', 'billing_phone', 'order_items',
      'payment_method', 'sub_total', 'length', 'breadth', 'height', 'weight'];
    for (const field of required) {
      if (payload[field] === undefined || payload[field] === '') throw validationError(`Missing shipment field: ${field}`);
    }
    const data = await this.request('/v1/external/orders/create/adhoc', { method: 'POST', body: payload });
    if (!data?.shipment_id) throw providerError('Shipping provider did not create a shipment');
    return {
      provider: this.name,
      shipmentId: String(data.shipment_id),
      orderId: String(data.order_id || ''),
      status: data.status || 'NEW',
    };
  }

  async requestPickup(shipmentIds) {
    return this.request('/v1/external/courier/generate/pickup', {
      method: 'POST',
      body: { shipment_id: shipmentIds.map(Number) },
    });
  }

  async getTracking(awb) {
    if (!/^[a-z0-9-]{4,50}$/i.test(String(awb || ''))) throw validationError('Invalid AWB');
    return this.request(`/v1/external/courier/track/awb/${encodeURIComponent(awb)}`);
  }

  async getLabel(shipmentIds) {
    return this.request('/v1/external/courier/generate/label', {
      method: 'POST',
      body: { shipment_id: shipmentIds.map(Number) },
    });
  }

  async reportNdr(payload) {
    return this.request('/v1/external/ndr/action', { method: 'POST', body: payload });
  }

  async request(path, { method = 'GET', body, unauthenticated = false } = {}) {
    const token = unauthenticated ? null : await this.authenticate();
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw providerError('Shipping provider request failed', response.status);
    return data;
  }
}

function validatePincode(value) {
  const pincode = String(value || '').trim();
  if (!/^\d{6}$/.test(pincode)) throw validationError('A valid 6-digit pincode is required');
  return pincode;
}

function validateWeight(value) {
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100) throw validationError('Invalid shipment weight');
  return weight;
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'SHIPPING_VALIDATION_ERROR';
  return error;
}

function providerError(message, providerStatus) {
  const error = new Error(message);
  error.statusCode = 502;
  error.code = 'SHIPPING_PROVIDER_ERROR';
  error.providerStatus = providerStatus;
  return error;
}

module.exports = ShiprocketProvider;
