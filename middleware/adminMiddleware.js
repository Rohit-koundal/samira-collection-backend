function adminOnly(req, res, next) {
  if (req.user && req.user.role === 'admin' && req.user.activeMode === 'admin') return next();
  return res.status(403).json({ message: 'Admin access required' });
}

module.exports = { adminOnly };
