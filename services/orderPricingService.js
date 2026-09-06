const Product = require('../models/Product');
const { ApiError } = require('../utils/apiError');
const { getPrimaryImageUrl } = require('../utils/imageUtils');
const couponService = require('./couponService');
const {
  availableStock,
  hasManagedVariants,
  requireVariant,
  variantId,
  variantImage,
  variantSku,
  variantUnitMrp,
  variantUnitPrice,
} = require('./variantService');
const { isRazorpayConfigured } = require('./razorpayService');
const {
  assertPaymentMethodAllowed,
  getStoreSettings,
  resolveCodCharge,
  resolveDeliveryCharge,
  resolvePrepaidDiscount,
} = require('./paymentSettingsService');
const { requireObjectId, requireQuantity } = require('../utils/validators');
const { andFilter, defaultStoreFilter } = require('./storeService');

/**
 * Authoritative order pricing.
 *
 * The client sends product ids, quantities and the chosen options only.
 * Prices, discounts, delivery, COD fee and the grand total are always read
 * from the database and recomputed here, so a tampered payload cannot change
 * what the customer is charged.
 */

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeMethod(paymentMethod) {
  const method = String(paymentMethod || 'COD').toUpperCase();
  return method === 'RAZORPAY' ? 'UPI' : method;
}

async function loadOrderItems(orderItems, { tenantFilter = {} } = {}) {
  if (!Array.isArray(orderItems) || !orderItems.length) {
    throw new ApiError('VALIDATION_ERROR', 'Your bag is empty');
  }
  if (orderItems.length > 50) {
    throw new ApiError('VALIDATION_ERROR', 'An order cannot contain more than 50 line items');
  }

  const items = [];
  let totalMRP = 0;
  let sellingTotal = 0;

  for (const raw of orderItems) {
    const productId = requireObjectId(raw.product || raw.productId, 'product');
    const quantity = requireQuantity(raw.quantity ?? 1, 'quantity');

    const product = await Product.findOne(andFilter({ _id: productId }, tenantFilter));
    if (!product) throw new ApiError('NOT_FOUND', `${raw.name || 'A product'} is no longer available`);
    if (product.isActive === false || product.isArchived) throw new ApiError('OUT_OF_STOCK', `${product.name} is no longer available`);

    const variant = requireVariant(product, {
      variantId: raw.variantId,
      size: raw.size,
      color: raw.color,
    });
    const stock = availableStock(product, {
      variantId: variant ? variantId(variant) : raw.variantId,
      size: variant?.size || raw.size,
      color: variant?.color || raw.color,
    });
    if (stock < quantity) {
      throw new ApiError(
        'OUT_OF_STOCK',
        hasManagedVariants(product)
          ? `${product.name} has only ${stock} left for ${variant?.size || raw.size || 'that size'} / ${variant?.color || raw.color || 'that colour'}`
          : `${product.name} has only ${stock} left in stock`,
      );
    }

    const unitPrice = variant ? variantUnitPrice(product, variant) : Number(product.price || 0);
    const unitMRP = variant ? variantUnitMrp(product, variant) : Number(product.originalPrice || product.price || 0);
    totalMRP += unitMRP * quantity;
    sellingTotal += unitPrice * quantity;

    items.push({
      product: product._id,
      name: product.name,
      productName: product.name,
      sku: variant ? variantSku(product, variant) : product.sku,
      image: variant ? variantImage(product, variant) : getPrimaryImageUrl(product.images),
      size: variant?.size || raw.size || '',
      color: variant?.color || raw.color || '',
      variantId: variant ? variantId(variant) : (raw.variantId ? String(raw.variantId) : ''),
      quantity,
      price: unitPrice,
      originalPrice: unitMRP,
      discount: round(unitMRP - unitPrice),
      tax: 0,
      lineTotal: round(unitPrice * quantity),
      category: product.category,
      storeId: product.storeId || null,
    });
  }

  const storeKeys = new Set(items.map((item) => String(item.storeId || '')));
  if (storeKeys.size > 1) {
    throw new ApiError('VALIDATION_ERROR', 'Items from different stores cannot be checked out together');
  }

  return { items, totalMRP: round(totalMRP), sellingTotal: round(sellingTotal) };
}

/**
 * Builds the priced order draft used by COD checkout, Razorpay order
 * creation, payment verification and the checkout quote endpoint.
 */
async function buildOrderDraft({ orderItems, couponCode, paymentMethod, settings, userId, shippingAddress, tenantFilter } = {}) {
  const storeSettings = settings || await getStoreSettings();
  const method = normalizeMethod(paymentMethod);
  const { items, totalMRP, sellingTotal } = await loadOrderItems(orderItems, { tenantFilter });

  let coupon = null;
  let couponDiscount = 0;
  if (couponCode) {
    // A checkout can originate from the main storefront or a seller domain.
    // When no request tenant was resolved, derive it from the authoritative
    // product rows while continuing to support legacy coupons without storeId.
    const couponTenantFilter = tenantFilter || (items[0]?.storeId ? defaultStoreFilter(items[0].storeId) : {});
    const priced = await couponService.validateAndPrice({
      code: couponCode,
      cartTotal: sellingTotal,
      paymentMethod: method,
      items,
      userId,
      tenantFilter: couponTenantFilter,
    });
    coupon = priced.coupon;
    couponDiscount = priced.discountAmount;
  }

  const productDiscount = round(Math.max(0, totalMRP - sellingTotal));
  const deliveryCharge = resolveDeliveryCharge(sellingTotal, storeSettings);
  const prepaidDiscount = resolvePrepaidDiscount(method, sellingTotal - couponDiscount, storeSettings);
  const platformFee = items.length ? Math.max(0, Number(storeSettings.platformFee ?? 23)) : 0;
  const taxRate = Math.max(0, Number(storeSettings.gstRate ?? 5));
  const taxableAmount = Math.max(0, sellingTotal - couponDiscount);
  const taxAmount = taxRate > 0 ? round((taxableAmount * taxRate) / (100 + taxRate)) : 0;
  if (taxAmount > 0 && taxableAmount > 0) {
    let allocatedTax = 0;
    let allocatedSales = 0;
    items.forEach((item, index) => {
      // Allocate the discounted tax by the original line weights. Using the
      // discounted subtotal as the denominator overstates every invoice row.
      allocatedSales += Number(item.lineTotal || 0);
      const cumulativeTax = index === items.length - 1
        ? taxAmount
        : round((allocatedSales / sellingTotal) * taxAmount);
      item.tax = round(cumulativeTax - allocatedTax);
      allocatedTax = cumulativeTax;
    });
  }
  const payableBeforeCod = round(Math.max(0, sellingTotal - couponDiscount - prepaidDiscount + deliveryCharge + platformFee));

  await assertPaymentMethodAllowed(method, storeSettings, {
    razorpayConfigured: isRazorpayConfigured(),
    orderAmount: payableBeforeCod,
    pincode: shippingAddress?.pincode,
    userId,
  });

  const codCharge = resolveCodCharge(method, storeSettings);
  const finalAmount = round(payableBeforeCod + codCharge);

  return {
    items,
    paymentMethod: method,
    settings: storeSettings,
    storeId: items[0]?.storeId || null,
    totals: {
      totalMRP,
      productDiscount,
      couponDiscount,
      prepaidDiscount,
      discount: round(productDiscount + couponDiscount + prepaidDiscount),
      deliveryCharge,
      codCharge,
      platformFee,
      taxAmount,
      taxRate,
      finalAmount,
      coupon: coupon ? { code: coupon.code, discountAmount: couponDiscount } : undefined,
    },
  };
}

module.exports = { buildOrderDraft, loadOrderItems, normalizeMethod };
