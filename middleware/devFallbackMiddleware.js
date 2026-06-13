const mongoose = require('mongoose');

const categories = [
  { _id: 'cat-sarees', id: 'cat-sarees', name: 'Sarees', slug: 'sarees', count: 128, description: 'Silk and festive drapes', isActive: true, displayOrder: 1 },
  { _id: 'cat-suits', id: 'cat-suits', name: 'Suits', slug: 'suits', count: 96, description: 'Under Rs. 999', isActive: true, displayOrder: 2 },
  { _id: 'cat-kurtis', id: 'cat-kurtis', name: 'Kurtis', slug: 'kurtis', count: 148, description: 'Daily wear edits', isActive: true, displayOrder: 3 },
  { _id: 'cat-dresses', id: 'cat-dresses', name: 'Dresses', slug: 'dresses', count: 72, description: 'Evening styles', isActive: true, displayOrder: 4 },
  { _id: 'cat-lehengas', id: 'cat-lehengas', name: 'Lehengas', slug: 'lehengas', count: 44, description: 'Wedding ready', isActive: true, displayOrder: 5 },
];

const products = Array.from({ length: 16 }, (_, index) => {
  const category = categories[index % categories.length];
  const price = 899 + (index % 6) * 350;
  const originalPrice = price + 700;
  return {
    _id: `dev-product-${index + 1}`,
    id: `dev-product-${index + 1}`,
    name: `${category.name} Premium Style ${index + 1}`,
    slug: `${category.slug}-premium-style-${index + 1}`,
    brand: 'Samira Collection',
    description: 'Premium Samira Collection fashion product for local development.',
    shortDescription: 'Premium fashion wear',
    category,
    categoryId: category._id,
    price,
    originalPrice,
    discountPercentage: Math.round(((originalPrice - price) / originalPrice) * 100),
    images: [],
    sizes: ['S', 'M', 'L', 'XL', 'Free Size'],
    colors: ['Wine', 'Blush', 'Gold'],
    fabric: ['Silk', 'Cotton', 'Georgette'][index % 3],
    occasion: ['Wedding', 'Festive', 'Daily Wear'][index % 3],
    stock: 8 + index,
    sku: `DEV-SC-${String(index + 1).padStart(4, '0')}`,
    tags: ['Samira', category.name],
    isFeatured: index % 3 === 0,
    isNewArrival: index % 4 === 0,
    isBestSeller: index % 5 === 0,
    isActive: true,
    rating: 4.5,
    numReviews: 12 + index,
    createdAt: new Date().toISOString(),
  };
});

const coupons = [
  { _id: 'coupon-fwdeors15', code: 'FWDEORS15', type: 'Percentage', discountValue: 15, minOrderAmount: 300, maxDiscountAmount: 150, expiryDate: '2027-12-31', isActive: true },
  { _id: 'coupon-samira10', code: 'SAMIRA10', type: 'Percentage', discountValue: 10, minOrderAmount: 799, maxDiscountAmount: 600, expiryDate: '2027-12-31', isActive: true },
  { _id: 'coupon-sale250', code: 'SALE250', type: 'Flat', discountValue: 250, minOrderAmount: 999, maxDiscountAmount: 250, expiryDate: '2027-12-31', isActive: true },
];

const settings = {
  storeName: 'Samira Collection',
  contactEmail: 'hello@samiracollection.com',
  contactPhone: '+91 98765 43210',
  whatsappNumber: '+91 98765 43210',
  address: 'Jaipur, Rajasthan',
  freeShippingMinAmount: 999,
  deliveryCharge: 99,
  returnPolicy: 'Return/exchange as per store policy.',
};

const banners = [];
const customers = [];
const orders = [];
const returns = [];
const reviews = [];
const addresses = [];
const wishlist = [];
const cart = { _id: 'dev-cart', items: [] };

function devFallback(req, res, next) {
  if (process.env.NODE_ENV === 'production' || mongoose.connection.readyState === 1) return next();

  const path = req.path;
  const method = req.method;

  if (path === '/admin/login') return next();

  if (method === 'GET' && path === '/products') return res.json(filterProducts(req.query));
  if (method === 'GET' && path.startsWith('/products/')) return sendProduct(req, res);
  if (method === 'GET' && path === '/categories') return res.json(categories);
  if (method === 'GET' && path === '/banners') return res.json(banners);
  if (method === 'GET' && path === '/settings') return res.json(settings);
  if (method === 'GET' && path === '/coupons') return res.json(coupons);
  if (method === 'POST' && path === '/coupons/apply') return applyCoupon(req, res);
  if (method === 'GET' && path.startsWith('/reviews/')) return res.json([]);
  if (path.startsWith('/reviews/')) return handlePublicReviews(req, res);

  if (path.startsWith('/cart')) return handleCart(req, res);
  if (path.startsWith('/wishlist')) return handleWishlist(req, res);
  if (path.startsWith('/user/addresses')) return handleAddresses(req, res);
  if (path.startsWith('/orders')) return handleOrders(req, res);
  if (path.startsWith('/payments')) return handlePayments(req, res);
  if (path.startsWith('/returns')) return handleReturns(req, res);

  if (method === 'GET' && path === '/admin/profile') return res.json(devUser('admin'));
  if (method === 'GET' && path === '/admin/dashboard/stats') {
    return res.json({ products: products.length, orders: orders.length, customers: customers.length, coupons: coupons.length, returns: returns.length, revenue: orders.reduce((sum, order) => sum + Number(order.finalAmount || 0), 0) });
  }
  if (method === 'GET' && path === '/admin/dashboard/recent-orders') return res.json(orders.slice(0, 8));
  if (method === 'GET' && path === '/admin/dashboard/low-stock') return res.json(products.filter((item) => item.stock <= 10).slice(0, 5));
  if (method === 'GET' && path === '/admin/reports/sales') return res.json({ labels: [], revenue: [], orders: [], totalRevenue: 0, totalOrders: orders.length });
  if (method === 'GET' && path === '/admin/reports/products') return res.json({ products: products.slice(0, 10), lowStock: products.filter((item) => item.stock <= 10) });

  if (method === 'GET' && path === '/admin/products') return res.json(products);
  if (method === 'GET' && path.startsWith('/admin/products/')) return sendProduct(req, res, true);
  if (path.startsWith('/admin/products')) return handleProducts(req, res);
  if (method === 'GET' && path === '/admin/categories') return res.json(categories);
  if (path.startsWith('/admin/categories')) return handleCategories(req, res);
  if (method === 'GET' && path === '/admin/coupons') return res.json(coupons);
  if (path.startsWith('/admin/coupons')) return handleCoupons(req, res);
  if (method === 'GET' && path === '/admin/banners') return res.json(banners);
  if (path.startsWith('/admin/banners')) return handleBanners(req, res);
  if (path.startsWith('/admin/orders')) return handleOrders(req, res, true);
  if (path.startsWith('/admin/reviews')) return handleReviews(req, res);
  if (path.startsWith('/admin/returns')) return handleReturns(req, res, true);
  if (path.startsWith('/admin/customers') || path.startsWith('/admin/users')) return handleCustomers(req, res);
  if (method === 'GET' && path === '/admin/settings') return res.json(settings);
  if (path.startsWith('/admin/settings')) return handleSettings(req, res);

  if (path === '/admin/uploads' || path.startsWith('/admin/uploads/')) return next();

  if (path.startsWith('/admin/')) {
    return res.status(503).json({
      message: 'Database is disconnected. This admin action is not available in local fallback mode.',
      code: 'DATABASE_UNAVAILABLE',
    });
  }

  next();
}

function filterProducts(query) {
  let items = [...products];
  if (query.category) items = items.filter((item) => item.categoryId === query.category || item.category?.slug === query.category);
  if (query.size) items = items.filter((item) => item.sizes?.includes(query.size));
  if (query.color) items = items.filter((item) => item.colors?.includes(query.color));
  if (query.fabric) items = items.filter((item) => String(item.fabric || '').toLowerCase() === String(query.fabric).toLowerCase());
  if (query.occasion) items = items.filter((item) => String(item.occasion || '').toLowerCase() === String(query.occasion).toLowerCase());
  if (query.discount) items = items.filter((item) => Number(item.discountPercentage || 0) >= Number(query.discount));
  if (query.rating) items = items.filter((item) => Number(item.rating || 0) >= Number(query.rating));
  if (query.stock === 'in') items = items.filter((item) => Number(item.stock || 0) > 0);
  if (query.stock === 'out') items = items.filter((item) => Number(item.stock || 0) <= 0);
  if (query.minPrice) items = items.filter((item) => Number(item.price || 0) >= Number(query.minPrice));
  if (query.maxPrice) items = items.filter((item) => Number(item.price || 0) <= Number(query.maxPrice));
  if (query.newArrival === 'true') items = items.filter((item) => item.isNewArrival);
  if (query.bestSeller === 'true') items = items.filter((item) => item.isBestSeller);
  if (query.featured === 'true') items = items.filter((item) => item.isFeatured);
  if (query.search) {
    const term = String(query.search).toLowerCase();
    items = items.filter((item) => [item.name, item.brand, item.category?.name, item.fabric, item.occasion].filter(Boolean).join(' ').toLowerCase().includes(term));
  }
  if (query.sort === 'discount') items.sort((a, b) => Number(b.discountPercentage || 0) - Number(a.discountPercentage || 0));
  if (query.sort === 'priceLowHigh') items.sort((a, b) => a.price - b.price);
  if (query.sort === 'priceHighLow') items.sort((a, b) => b.price - a.price);
  if (query.sort === 'rating') items.sort((a, b) => b.rating - a.rating);
  return items;
}

function sendProduct(req, res) {
  const key = req.params[0] || req.path.split('/').pop();
  const product = products.find((item) => item._id === key || item.id === key || item.slug === key);
  if (!product) return res.status(404).json({ message: 'Product not found' });
  return res.json(product);
}

function applyCoupon(req, res) {
  const code = String(req.body.code || '').toUpperCase();
  const coupon = coupons.find((item) => item.code === code && item.isActive);
  if (!coupon || new Date(coupon.expiryDate) < new Date()) return res.status(400).json({ message: 'Invalid or expired coupon' });
  const amount = Number(req.body.cartTotal || req.body.amount || 0);
  if (amount < coupon.minOrderAmount) return res.status(400).json({ message: 'Minimum order amount not met' });
  const raw = coupon.type === 'Percentage' ? (amount * coupon.discountValue) / 100 : coupon.discountValue;
  const discountAmount = Math.min(raw, coupon.maxDiscountAmount || raw, amount);
  return res.json({ success: true, couponCode: coupon.code, discountAmount, discount: discountAmount, coupon, message: `${coupon.code} applied` });
}

function handleProducts(req, res) {
  const id = routeId(req.path, '/admin/products');
  if (req.method === 'POST') {
    const product = createItem(products, {
      brand: 'Samira Collection',
      isActive: true,
      stock: 0,
      ...req.body,
    }, 'dev-product');
    product.slug = product.slug || slugify(product.name || product._id);
    return res.status(201).json(product);
  }
  if (['PUT', 'PATCH'].includes(req.method)) {
    const product = findItem(products, id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (req.path.endsWith('/status')) product.isActive = req.body.isActive;
    else if (req.path.endsWith('/stock')) product.stock = Number(req.body.stock || 0);
    else Object.assign(product, req.body);
    product.slug = product.slug || slugify(product.name || product._id);
    product.updatedAt = new Date().toISOString();
    return res.json(product);
  }
  if (req.method === 'DELETE') return deleteItem(products, id, res, 'Product');
  return res.status(405).json({ message: 'Method not allowed' });
}

function handleCategories(req, res) {
  const id = routeId(req.path, '/admin/categories');
  if (req.method === 'POST') return res.status(201).json(createItem(categories, { isActive: true, ...req.body, slug: req.body.slug || slugify(req.body.name) }, 'cat'));
  if (['PUT', 'PATCH'].includes(req.method)) return updateItem(categories, id, req.body, res, 'Category');
  if (req.method === 'DELETE') return deleteItem(categories, id, res, 'Category');
  return res.status(405).json({ message: 'Method not allowed' });
}

function handleCoupons(req, res) {
  const id = routeId(req.path, '/admin/coupons');
  if (req.method === 'POST') return res.status(201).json(createItem(coupons, { isActive: true, ...req.body, code: String(req.body.code || '').toUpperCase() }, 'coupon'));
  if (['PUT', 'PATCH'].includes(req.method)) return updateItem(coupons, id, { ...req.body, code: req.body.code ? String(req.body.code).toUpperCase() : undefined }, res, 'Coupon');
  if (req.method === 'DELETE') return deleteItem(coupons, id, res, 'Coupon');
  return res.status(405).json({ message: 'Method not allowed' });
}

function handleBanners(req, res) {
  const id = routeId(req.path, '/admin/banners');
  if (req.method === 'POST') return res.status(201).json(createItem(banners, { isActive: true, ...req.body }, 'banner'));
  if (['PUT', 'PATCH'].includes(req.method)) return updateItem(banners, id, req.body, res, 'Banner');
  if (req.method === 'DELETE') return deleteItem(banners, id, res, 'Banner');
  return res.status(405).json({ message: 'Method not allowed' });
}

function handleSettings(req, res) {
  if (req.method === 'GET') return res.json(settings);
  if (['PUT', 'PATCH'].includes(req.method)) {
    Object.assign(settings, req.body, { updatedAt: new Date().toISOString() });
    return res.json(settings);
  }
  return res.status(405).json({ message: 'Method not allowed' });
}

function handleCustomers(req, res) {
  if (req.method === 'GET') return res.json(customers);
  const id = routeId(req.path, req.path.startsWith('/admin/users') ? '/admin/users' : '/admin/customers');
  const customer = findItem(customers, id) || createItem(customers, { name: 'Dev Customer', phone: '9816978086', role: 'customer' }, 'dev-customer');
  if (req.path.endsWith('/block')) customer.isBlocked = Boolean(req.body.isBlocked);
  if (req.path.endsWith('/promote-admin')) {
    customer.role = 'admin';
    customer.availableModes = ['customer', 'admin'];
  }
  if (req.path.endsWith('/demote-admin')) {
    customer.role = 'customer';
    customer.availableModes = ['customer'];
  }
  return res.json(customer);
}

function handleReviews(req, res) {
  if (req.method === 'GET') return res.json(reviews);
  const id = routeId(req.path, '/admin/reviews');
  if (req.method === 'PATCH') return updateItem(reviews, id, { isVisible: req.body.isVisible }, res, 'Review');
  if (req.method === 'DELETE') return deleteItem(reviews, id, res, 'Review');
  return res.status(405).json({ message: 'Method not allowed' });
}

function handlePublicReviews(req, res) {
  const productId = routeId(req.path, '/reviews');
  if (req.method === 'POST') {
    const review = createItem(reviews, {
      product: productId,
      rating: Number(req.body.rating || 5),
      comment: req.body.comment || '',
      user: devUser('customer'),
      isVisible: true,
    }, 'review');
    return res.status(201).json(review);
  }
  return res.status(405).json({ message: 'Method not allowed' });
}

function handleCart(req, res) {
  if (req.method === 'GET') return res.json(cart);
  if (req.method === 'POST') {
    const item = { _id: `dev-cart-item-${Date.now()}`, quantity: 1, ...req.body };
    cart.items.push(item);
    return res.status(201).json(cart);
  }
  if (req.method === 'PUT') {
    const item = cart.items.find((entry) => String(entry._id) === routeId(req.path, '/cart'));
    if (item) item.quantity = Number(req.body.quantity || item.quantity || 1);
    return res.json(cart);
  }
  if (req.method === 'DELETE' && req.path === '/cart') {
    cart.items = [];
    return res.json({ message: 'Cart cleared' });
  }
  if (req.method === 'DELETE') {
    cart.items = cart.items.filter((entry) => String(entry._id) !== routeId(req.path, '/cart'));
    return res.json(cart);
  }
  return res.status(405).json({ message: 'Method not allowed' });
}

function handleWishlist(req, res) {
  if (req.method === 'GET') return res.json(wishlist);
  const productId = routeId(req.path, '/wishlist');
  if (req.method === 'POST') {
    if (productId && !wishlist.includes(productId)) wishlist.push(productId);
    return res.json(wishlist);
  }
  if (req.method === 'DELETE') {
    const index = wishlist.indexOf(productId);
    if (index >= 0) wishlist.splice(index, 1);
    return res.json(wishlist);
  }
  return res.status(405).json({ message: 'Method not allowed' });
}

function handleAddresses(req, res) {
  const id = routeId(req.path, '/user/addresses');
  if (req.method === 'GET') return res.json(addresses);
  if (req.method === 'POST') return res.status(201).json(pushAddress(req.body));
  if (req.method === 'PUT') {
    const address = findItem(addresses, id);
    if (!address) return res.status(404).json({ message: 'Address not found' });
    Object.assign(address, req.body);
    if (req.body.isDefault) setDefaultAddress(address._id);
    return res.json(addresses);
  }
  if (req.method === 'PATCH' && req.path.endsWith('/default')) {
    setDefaultAddress(id);
    return res.json(addresses);
  }
  if (req.method === 'DELETE') return deleteItem(addresses, id, res, 'Address', addresses);
  return res.status(405).json({ message: 'Method not allowed' });
}

function handleOrders(req, res, admin = false) {
  if (req.method === 'GET') {
    if (req.path.endsWith('/receipt')) return res.json(buildReceipt(findItem(orders, routeId(req.path, admin ? '/admin/orders' : '/orders'))));
    if (req.path === '/orders/my-orders' || req.path === '/admin/orders' || req.path === '/admin/orders/admin/all' || req.path === '/orders') return res.json(orders);
    const order = findItem(orders, routeId(req.path, admin ? '/admin/orders' : '/orders'));
    return order ? res.json(order) : res.status(404).json({ message: 'Order not found' });
  }
  if (req.method === 'POST' && (req.path === '/orders' || req.path === '/orders/cod')) {
    const order = createOrder(req.body);
    return res.status(201).json(order);
  }
  if (req.method === 'POST' && req.path.endsWith('/cancel')) return updateOrder(req, res, 'Cancelled');
  if (req.method === 'PUT' && req.path.endsWith('/status')) return updateOrder(req, res, req.body.orderStatus || req.body.status || 'Pending');
  if (req.method === 'PUT' && req.path.endsWith('/payment-status')) {
    const order = findItem(orders, routeId(req.path, admin ? '/admin/orders' : '/orders'));
    if (!order) return res.status(404).json({ message: 'Order not found' });
    order.paymentStatus = req.body.paymentStatus || 'Pending';
    return res.json(order);
  }
  return res.status(405).json({ message: 'Method not allowed' });
}

function handlePayments(req, res) {
  if (req.method === 'POST' && req.path === '/payments/create-order') {
    const amount = Number(req.body.amount || req.body.total || req.body.finalAmount || 0);
    return res.json({ razorpayOrderId: `rzp_dev_${Date.now()}`, amount: Math.round(amount * 100), currency: 'INR', keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_dev', mode: 'test' });
  }
  if (req.method === 'POST' && req.path === '/payments/verify') return res.json({ success: true, order: createOrder(req.body.orderPayload || req.body) });
  if (req.method === 'POST' && req.path === '/payments/failure') return res.status(202).json({ success: false, message: req.body.reason || 'Payment failed. Please retry or choose COD.' });
  return res.status(405).json({ message: 'Method not allowed' });
}

function handleReturns(req, res, admin = false) {
  if (req.method === 'GET') return res.json(returns);
  if (req.method === 'POST' && !admin) return res.status(201).json(createItem(returns, { status: 'Requested', ...req.body }, 'return'));
  if (req.method === 'PUT' && req.path.endsWith('/status')) return updateItem(returns, routeId(req.path, admin ? '/admin/returns' : '/returns'), { status: req.body.status || req.body.returnStatus || 'Requested' }, res, 'Return');
  return res.status(405).json({ message: 'Method not allowed' });
}

function createOrder(body) {
  const orderItems = Array.isArray(body.orderItems) ? body.orderItems : [];
  const totalMRP = orderItems.reduce((sum, item) => sum + Number(item.originalPrice || item.price || 0) * Number(item.quantity || 1), 0);
  const sellingTotal = orderItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0);
  const deliveryCharge = sellingTotal >= Number(settings.freeShippingMinAmount || 999) ? 0 : Number(settings.deliveryCharge || 99);
  return createItem(orders, {
    ...body,
    orderItems,
    paymentMethod: body.paymentMethod || 'COD',
    paymentProvider: body.paymentProvider || 'COD',
    paymentStatus: body.paymentStatus || 'Pending',
    orderStatus: body.orderStatus || 'Pending',
    totalMRP,
    productDiscount: Math.max(0, totalMRP - sellingTotal),
    couponDiscount: Number(body.coupon?.discountAmount || 0),
    deliveryCharge,
    codCharge: 0,
    finalAmount: Number(body.finalAmount || Math.max(0, sellingTotal - Number(body.coupon?.discountAmount || 0) + deliveryCharge)),
    statusTimeline: [{ status: 'Pending', date: new Date().toISOString(), note: 'Dev fallback order placed' }],
  }, 'dev-order');
}

function updateOrder(req, res, status) {
  const order = findItem(orders, routeId(req.path, req.path.startsWith('/admin/orders') ? '/admin/orders' : '/orders'));
  if (!order) return res.status(404).json({ message: 'Order not found' });
  order.orderStatus = status;
  order.statusTimeline = [...(order.statusTimeline || []), { status, date: new Date().toISOString(), note: req.body.note || 'Updated in dev fallback' }];
  return res.json(order);
}

function buildReceipt(order) {
  if (!order) return {};
  return {
    orderId: order._id,
    orderDate: order.createdAt,
    customer: devUser('customer'),
    shippingAddress: order.shippingAddress,
    items: order.orderItems,
    paymentMethod: order.paymentMethod,
    paymentProvider: order.paymentProvider,
    paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus,
    statusTimeline: order.statusTimeline,
    totalMRP: order.totalMRP,
    productDiscount: order.productDiscount,
    couponDiscount: order.couponDiscount,
    deliveryCharge: order.deliveryCharge,
    codCharge: order.codCharge,
    finalAmount: order.finalAmount,
    storeDetails: settings,
  };
}

function pushAddress(body) {
  const address = createItem(addresses, body, 'dev-address');
  if (body.isDefault || addresses.length === 1) setDefaultAddress(address._id);
  return addresses;
}

function setDefaultAddress(id) {
  addresses.forEach((address) => {
    address.isDefault = String(address._id) === String(id);
  });
}

function routeId(path, base) {
  const parts = path.slice(base.length).split('/').filter(Boolean).filter((part) => part !== 'admin' && !['create', 'status', 'stock', 'block', 'promote-admin', 'demote-admin', 'default', 'receipt', 'cancel', 'all'].includes(part));
  return parts[0];
}

function createItem(collection, data, prefix) {
  const id = data._id || data.id || `${prefix}-${Date.now()}`;
  const item = {
    _id: String(id),
    id: String(id),
    ...cleanUndefined(data),
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  collection.unshift(item);
  return item;
}

function updateItem(collection, id, data, res, label) {
  const item = findItem(collection, id);
  if (!item) return res.status(404).json({ message: `${label} not found` });
  Object.assign(item, cleanUndefined(data), { updatedAt: new Date().toISOString() });
  return res.json(item);
}

function deleteItem(collection, id, res, label) {
  const index = collection.findIndex((item) => String(item._id || item.id) === String(id));
  if (index < 0) return res.status(404).json({ message: `${label} not found` });
  collection.splice(index, 1);
  return res.json({ success: true, message: `${label} deleted` });
}

function findItem(collection, id) {
  return collection.find((item) => String(item._id || item.id || item.slug) === String(id) || String(item.slug) === String(id));
}

function cleanUndefined(data = {}) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function slugify(value = '') {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `dev-${Date.now()}`;
}

function devUser(role = 'customer') {
  return {
    _id: `offline-${role}`,
    id: `offline-${role}`,
    name: role === 'admin' ? 'Samira Admin' : 'Samira User',
    phone: '9816978086',
    role,
    activeMode: role,
    availableModes: role === 'admin' ? ['customer', 'admin'] : ['customer'],
    isPhoneVerified: true,
  };
}

module.exports = devFallback;
