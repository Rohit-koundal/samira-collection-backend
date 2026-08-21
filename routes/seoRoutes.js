const router = require('express').Router();
const seo = require('../controllers/seoController');

router.get('/robots.txt', seo.robots);
router.get('/sitemap.xml', seo.sitemap);
router.get('/share/product/:slug', seo.productShare);

module.exports = router;
