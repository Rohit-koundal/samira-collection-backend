const router = require('express').Router();
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

router.get('/', (req, res) => res.json(req.user.addresses || []));

router.post('/', async (req, res) => {
  const error = validateAddress(req.body);
  if (error) return res.status(400).json({ message: error });
  if (req.body.isDefault || !req.user.addresses.length) req.user.addresses.forEach((address) => { address.isDefault = false; });
  req.user.addresses.push(normalizeAddress(req.body, req.body.isDefault || !req.user.addresses.length));
  await req.user.save();
  res.status(201).json(req.user.addresses);
});

router.put('/:addressId', async (req, res) => {
  const error = validateAddress(req.body);
  if (error) return res.status(400).json({ message: error });
  const address = req.user.addresses.id(req.params.addressId);
  if (!address) return res.status(404).json({ message: 'Address not found' });
  if (req.body.isDefault) req.user.addresses.forEach((item) => { item.isDefault = false; });
  Object.assign(address, normalizeAddress(req.body, req.body.isDefault));
  await req.user.save();
  res.json(req.user.addresses);
});

router.delete('/:addressId', async (req, res) => {
  const address = req.user.addresses.id(req.params.addressId);
  if (!address) return res.status(404).json({ message: 'Address not found' });
  address.deleteOne();
  if (req.user.addresses.length && !req.user.addresses.some((item) => item.isDefault)) req.user.addresses[0].isDefault = true;
  await req.user.save();
  res.json(req.user.addresses);
});

router.patch('/:addressId/default', async (req, res) => {
  const address = req.user.addresses.id(req.params.addressId);
  if (!address) return res.status(404).json({ message: 'Address not found' });
  req.user.addresses.forEach((item) => { item.isDefault = String(item._id) === String(address._id); });
  await req.user.save();
  res.json(req.user.addresses);
});

function normalizeAddress(data, isDefault = false) {
  return {
    fullName: data.fullName,
    mobile: data.mobile || data.phone,
    phone: data.phone || data.mobile,
    alternateMobile: data.alternateMobile,
    pincode: data.pincode,
    state: data.state,
    city: data.city,
    houseNo: data.houseNo || data.houseNumber,
    houseNumber: data.houseNumber || data.houseNo,
    area: data.area,
    landmark: data.landmark,
    addressType: data.addressType || 'Home',
    isDefault,
  };
}

function validateAddress(data) {
  if (!data.fullName) return 'Full name is required';
  const mobile = data.mobile || data.phone;
  if (!/^[6-9]\d{9}$/.test(String(mobile || ''))) return 'Valid 10-digit mobile number is required';
  if (!/^\d{6}$/.test(String(data.pincode || ''))) return 'Valid 6-digit pincode is required';
  if (!data.state) return 'State is required';
  if (!data.city) return 'City is required';
  if (!data.houseNo && !data.houseNumber) return 'House/building is required';
  if (!data.area) return 'Area/colony is required';
  return '';
}

module.exports = router;
