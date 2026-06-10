exports.getWishlist = async (req, res) => res.json(req.user.wishlist);
exports.addWishlist = async (req, res) => { req.user.wishlist.addToSet(req.params.productId); await req.user.save(); res.json(req.user.wishlist); };
exports.removeWishlist = async (req, res) => { req.user.wishlist.pull(req.params.productId); await req.user.save(); res.json(req.user.wishlist); };
