const dotenv = require('dotenv');
const connectDB = require('../config/db');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const Banner = require('../models/Banner');
const Order = require('../models/Order');
const Review = require('../models/Review');
const Settings = require('../models/Settings');
const slugify = require('../utils/slugify');

dotenv.config();

async function seed() {
  await connectDB();
  await Promise.all([User.deleteMany(), Category.deleteMany(), Product.deleteMany(), Coupon.deleteMany(), Banner.deleteMany(), Order.deleteMany(), Review.deleteMany(), Settings.deleteMany()]);

  const users = await Promise.all([
    { name: 'Admin', email: 'admin@samiracollection.com', phone: '9999999999', password: 'Admin@123', role: 'admin' },
    { name: 'Demo Customer', email: 'customer@test.com', phone: '9876543210', password: 'Customer@123', role: 'customer' },
    { name: 'Anaya Sharma', email: 'anaya@example.com', phone: '9811122233', password: 'Customer@123', role: 'customer' },
    { name: 'Mira Kapoor', email: 'mira@example.com', phone: '9900011112', password: 'Customer@123', role: 'customer' },
  ].map((user) => User.create(user)));

  const categoryNames = ['Sarees', 'Suits', 'Kurtis', 'Dresses', 'Lehengas', 'Gowns', 'Dupatta Collection', 'Festive Wear'];
  const categories = await Category.insertMany(categoryNames.map((name, index) => ({ name, slug: slugify(name), description: `${name} collection`, displayOrder: index + 1 })));

  const products = await Product.insertMany(Array.from({ length: 30 }, (_, index) => {
    const category = categories[index % categories.length];
    const price = 899 + (index % 8) * 430;
    const originalPrice = price + 800;
    return {
      name: `${category.name} Premium Style ${index + 1}`,
      slug: slugify(`${category.name} Premium Style ${index + 1}`),
      description: 'Premium Samira Collection fashion product.',
      category: category._id,
      subCategory: index % 2 ? 'Festive Wear' : 'Daily Wear',
      price,
      originalPrice,
      discountPercentage: Math.round(((originalPrice - price) / originalPrice) * 100),
      images: [{ url: '/uploads/placeholder.jpg' }],
      sizes: ['S', 'M', 'L', 'XL', 'Free Size'],
      colors: ['Wine', 'Blush', 'Gold'],
      fabric: ['Silk', 'Cotton', 'Georgette'][index % 3],
      occasion: ['Wedding', 'Festive', 'Daily Wear'][index % 3],
      stock: 3 + index,
      sku: `SC-${String(index + 1).padStart(4, '0')}`,
      tags: ['Samira', category.name],
      isFeatured: index % 3 === 0,
      isNewArrival: index % 4 === 0,
      isBestSeller: index % 5 === 0,
      isActive: true,
    };
  }));

  await Coupon.insertMany(['SAMIRA10', 'FESTIVE20', 'NEWUSER15', 'FREESHIP', 'SALE250'].map((code, index) => ({ code, type: index === 3 ? 'Flat' : 'Percentage', discountValue: index === 3 ? 99 : 10 + index * 5, minOrderAmount: 799, maxDiscountAmount: 600, expiryDate: new Date('2027-12-31'), isActive: true })));
  await Banner.insertMany(['Hero', 'Offer', 'Category', 'Offer', 'Hero'].map((type, index) => ({ title: `Samira Banner ${index + 1}`, subtitle: 'Premium fashion offer', type, isActive: true, displayOrder: index + 1 })));
  await Order.insertMany(Array.from({ length: 10 }, (_, index) => ({
    user: users[1 + (index % 3)]._id,
    orderItems: [{ product: products[index]._id, name: products[index].name, quantity: 1, price: products[index].price }],
    shippingAddress: { fullName: users[1].name, city: 'Jaipur', pincode: '302001' },
    paymentMethod: index % 2 ? 'COD' : 'UPI',
    paymentStatus: index % 2 ? 'Pending' : 'Paid',
    orderStatus: ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Delivered'][index % 5],
    totalMRP: products[index].originalPrice,
    discount: products[index].originalPrice - products[index].price,
    deliveryCharge: 0,
    finalAmount: products[index].price,
  })));
  await Review.insertMany(products.slice(0, 10).map((product) => ({ user: users[1]._id, product: product._id, rating: 5, comment: 'Great quality and finishing.', isVisible: true })));
  await Settings.create({ contactEmail: 'hello@samiracollection.com', contactPhone: '+91 98765 43210', whatsappNumber: '+91 98765 43210' });

  console.log('Samira Collection seed data created');
  process.exit();
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
