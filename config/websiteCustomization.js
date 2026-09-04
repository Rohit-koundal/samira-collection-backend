const SECTION_DEFAULTS = [
  { id: 'hero', label: 'Hero Section', visible: true, order: 10, heading: 'Where Tradition Meets Modern Grace', description: 'Premium ethnic wear for every celebration.', buttonText: 'Shop New Arrivals', buttonLink: '/products?newArrival=true', image: '', backgroundImage: '' },
  { id: 'services', label: 'Service Highlights', visible: true, order: 15, heading: 'Why Shop With Us', description: 'Shipping, returns and secure payment benefits.', buttonText: '', buttonLink: '', image: '', backgroundImage: '' },
  { id: 'categories', label: 'Featured Categories', visible: true, order: 20, heading: 'Shop by Category', description: 'Curated styles for every occasion.', buttonText: '', buttonLink: '', image: '', backgroundImage: '' },
  { id: 'promotional', label: 'Promotional Banners', visible: true, order: 30, heading: 'Featured Collections', description: '', buttonText: 'Shop Now', buttonLink: '/products', image: '', backgroundImage: '' },
  { id: 'featured', label: 'Featured Products', visible: true, order: 40, heading: 'Featured Products', description: 'A curated edit from the collection.', buttonText: 'View All', buttonLink: '/products?featured=true', image: '', backgroundImage: '' },
  { id: 'newArrivals', label: 'New Arrivals', visible: true, order: 50, heading: 'New Arrivals', description: 'Fresh styles added to the collection.', buttonText: 'View All', buttonLink: '/products?newArrival=true', image: '', backgroundImage: '' },
  { id: 'bestSellers', label: 'Best Sellers', visible: true, order: 60, heading: 'Best Sellers', description: 'Customer favourites from Samira Collection.', buttonText: 'View All', buttonLink: '/products?bestSeller=true', image: '', backgroundImage: '' },
  { id: 'ethnicSets', label: 'Ethnic Sets', visible: true, order: 64, heading: 'Complete Occasion-Ready Looks', description: 'Coordinated silhouettes for weddings, celebrations, and everyday elegance.', buttonText: 'View All', buttonLink: '/products?search=Set', image: '', backgroundImage: '' },
  { id: 'accessories', label: 'Accessories', visible: true, order: 66, heading: 'The Finishing Touch', description: 'Complete every look with thoughtfully selected accessories.', buttonText: 'View All', buttonLink: '/products?search=Accessory', image: '', backgroundImage: '' },
  { id: 'trending', label: 'Trending Products', visible: true, order: 70, heading: 'Trending Now', description: 'Styles customers are discovering now.', buttonText: 'View All', buttonLink: '/products?trending=true', image: '', backgroundImage: '' },
  { id: 'sale', label: 'Sale Banner', visible: true, order: 80, heading: 'Season Sale', description: 'Discover current offers across the collection.', buttonText: 'View Offers', buttonLink: '/products?discount=20', image: '', backgroundImage: '' },
  { id: 'reviews', label: 'Customer Reviews', visible: true, order: 90, heading: 'Loved by Our Customers', description: 'Real stories from the Samira community.', buttonText: '', buttonLink: '', image: '', backgroundImage: '' },
  { id: 'newsletter', label: 'Newsletter', visible: true, order: 100, heading: 'Join Samira Circle', description: 'Get early access to new drops, offers, and styling updates.', buttonText: 'Subscribe', buttonLink: '', image: '', backgroundImage: '' },
  { id: 'instagram', label: 'Instagram / Social', visible: true, order: 110, heading: 'Style Inspiration', description: 'Discover more from our latest collection.', buttonText: 'Explore', buttonLink: '/products', image: '', backgroundImage: '' },
];

const DEFAULT_WEBSITE_CONFIG = {
  schemaVersion: 2,
  branding: {
    websiteName: 'Samira Collection',
    tagline: 'Elegance for every celebration',
    logo: '',
    favicon: '',
  },
  colors: {
    primary: '#6d1f34',
    secondary: '#fff0f4',
    accent: '#b8914a',
    background: '#fffaf2',
    surface: '#ffffff',
    text: '#17161a',
    mutedText: '#6f6470',
  },
  header: {
    background: '#fffaf2',
    textColor: '#17161a',
    logoSize: 72,
    menuAlignment: 'left',
    sticky: true,
    announcementEnabled: true,
    announcementText: 'Free Shipping Above ₹999',
    announcementBackground: '#830b31',
    announcementTextColor: '#ffffff',
  },
  homepage: {
    sections: SECTION_DEFAULTS,
    featuredCategoryIds: [],
    categoryImages: [],
    sectionProductIds: {
      featured: [],
      newArrivals: [],
      bestSellers: [],
      trending: [],
      ethnicSets: [],
      accessories: [],
    },
  },
  typography: {
    headingFont: 'Playfair Display',
    bodyFont: 'Inter',
    headingScale: 1,
    bodyScale: 1,
    headingWeight: 700,
    bodyWeight: 400,
    buttonFont: 'Inter',
    buttonWeight: 700,
  },
  buttons: {
    background: '#6d1f34',
    textColor: '#ffffff',
    borderRadius: 8,
    style: 'solid',
    size: 'medium',
    hoverEffect: 'lift',
  },
  productCards: {
    layout: 'classic',
    imageRatio: '4/5',
    borderRadius: 12,
    shadow: 'soft',
    showTitle: true,
    showPrice: true,
    showDiscount: true,
    showRating: true,
    showWishlist: true,
    showAddToCart: true,
    quickView: false,
  },
  footer: {
    enabled: true,
    background: '#4b071b',
    textColor: '#ffffff',
    logo: '',
    description: 'Crafted with elegance, designed for you. Premium ethnic wear for every celebration.',
    showContact: true,
    showSocialLinks: true,
    showNewsletter: true,
    contactEmail: '',
    contactPhone: '',
    contactAddress: '',
    socialLinks: { instagram: '', facebook: '', youtube: '', pinterest: '' },
    menus: {
      shopping: [
        { label: 'New Arrivals', path: '/products?newArrival=true' },
        { label: 'Sarees', path: '/products?search=Saree' },
        { label: 'Suits', path: '/products?search=Suit' },
        { label: 'Accessories', path: '/products?search=Accessory' },
        { label: 'Sale', path: '/products?discount=20' },
      ],
      policies: [
        { label: 'Track Your Order', path: '/orders' },
        { label: 'Returns & Refunds', path: '/returns' },
        { label: 'Shipping Policy', path: '/shipping-policy' },
        { label: 'Contact Us', path: '/contact' },
      ],
      about: [
        { label: 'Our Story', path: '/our-story' },
        { label: 'Reviews', path: '/products?bestSeller=true' },
      ],
    },
    copyrightText: '© Samira Collection. All rights reserved.',
  },
  layout: {
    mode: 'full',
    maxWidth: 1520,
    sectionSpacing: 72,
    gridGap: 20,
    productsPerRow: { desktop: 4, tablet: 3, mobile: 2 },
  },
  theme: {
    preset: 'default',
  },
};

const PRESET_OVERRIDES = {
  default: {},
  premium: {
    colors: { primary: '#5d142c', secondary: '#f8ece8', accent: '#c79a55', background: '#fffaf5' },
    buttons: { borderRadius: 6, hoverEffect: 'lift' },
    productCards: { borderRadius: 14, shadow: 'elevated' },
    theme: { preset: 'premium' },
  },
  minimal: {
    colors: { primary: '#222222', secondary: '#f4f4f2', accent: '#77746d', background: '#ffffff' },
    typography: { headingFont: 'Inter', headingWeight: 600 },
    buttons: { borderRadius: 2, style: 'outline', hoverEffect: 'darken' },
    productCards: { borderRadius: 2, shadow: 'none', layout: 'minimal' },
    theme: { preset: 'minimal' },
  },
  festive: {
    colors: { primary: '#8d153a', secondary: '#fff0d8', accent: '#d6982f', background: '#fff9ee' },
    header: { announcementBackground: '#9b173f' },
    buttons: { borderRadius: 12, hoverEffect: 'glow' },
    theme: { preset: 'festive' },
  },
  sale: {
    colors: { primary: '#c51f3f', secondary: '#fff0f1', accent: '#ffb020', background: '#fff8f8' },
    header: { announcementBackground: '#c51f3f', announcementText: 'Sale is live — explore current offers' },
    productCards: { shadow: 'elevated' },
    theme: { preset: 'sale' },
  },
  wedding: {
    colors: { primary: '#681b36', secondary: '#f8e9e5', accent: '#b88a44', background: '#fffaf5' },
    typography: { headingFont: 'Playfair Display', headingScale: 1.08 },
    buttons: { borderRadius: 999, hoverEffect: 'glow' },
    theme: { preset: 'wedding' },
  },
};

const PRESET_LABELS = {
  default: 'Default Theme',
  premium: 'Premium Theme',
  minimal: 'Minimal Theme',
  festive: 'Festive Theme',
  sale: 'Sale Theme',
  wedding: 'Wedding Theme',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeKnown(base, incoming) {
  if (Array.isArray(base)) return Array.isArray(incoming) ? clone(incoming) : clone(base);
  if (!base || typeof base !== 'object') {
    if (typeof base === 'boolean') return typeof incoming === 'boolean' ? incoming : base;
    if (typeof base === 'number') return Number.isFinite(Number(incoming)) ? Number(incoming) : base;
    return typeof incoming === 'string' || typeof incoming === 'number' ? String(incoming).slice(0, 5000) : base;
  }
  const source = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [key, mergeKnown(value, source[key])]));
}

function normalizeSections(sections) {
  const source = Array.isArray(sections) ? sections : [];
  const sourceMap = new Map(source.map((section) => [String(section?.id || ''), section]));
  return SECTION_DEFAULTS.map((fallback, index) => {
    const section = mergeKnown(fallback, sourceMap.get(fallback.id));
    section.id = fallback.id;
    section.label = fallback.label;
    section.visible = typeof section.visible === 'boolean' ? section.visible : true;
    section.order = Math.max(0, Math.min(1000, Number(section.order || (index + 1) * 10)));
    section.buttonLink = safeInternalPath(section.buttonLink);
    section.image = cleanText(section.image, 2000);
    section.backgroundImage = cleanText(section.backgroundImage, 2000);
    return section;
  }).sort((a, b) => a.order - b.order);
}

function validColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : fallback;
}

function oneOf(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function normalizeWebsiteConfig(input = {}) {
  const sourceVersion = Number(input?.schemaVersion || 0);
  const config = mergeKnown(DEFAULT_WEBSITE_CONFIG, input);
  if (sourceVersion < 2) config.header.sticky = true;
  config.schemaVersion = 2;
  config.branding.websiteName = cleanText(config.branding.websiteName, 120) || DEFAULT_WEBSITE_CONFIG.branding.websiteName;
  config.branding.tagline = cleanText(config.branding.tagline, 240);
  config.branding.logo = cleanText(config.branding.logo, 2000);
  config.branding.favicon = cleanText(config.branding.favicon, 2000);
  config.homepage.sections = normalizeSections(input?.homepage?.sections || config.homepage.sections);
  config.homepage.featuredCategoryIds = normalizeIds(config.homepage.featuredCategoryIds);
  Object.keys(config.homepage.sectionProductIds).forEach((key) => {
    config.homepage.sectionProductIds[key] = normalizeIds(config.homepage.sectionProductIds[key]);
  });
  config.homepage.categoryImages = (Array.isArray(config.homepage.categoryImages) ? config.homepage.categoryImages : [])
    .slice(0, 50)
    .map((item) => ({ categoryId: cleanText(item?.categoryId, 100), image: cleanText(item?.image, 2000) }))
    .filter((item) => item.categoryId && item.image);
  Object.keys(config.footer.socialLinks).forEach((key) => { config.footer.socialLinks[key] = safeExternalUrl(config.footer.socialLinks[key]); });
  Object.keys(config.footer.menus).forEach((key) => { config.footer.menus[key] = normalizeMenu(config.footer.menus[key]); });

  Object.keys(config.colors).forEach((key) => { config.colors[key] = validColor(config.colors[key], DEFAULT_WEBSITE_CONFIG.colors[key]); });
  for (const key of ['background', 'textColor', 'announcementBackground', 'announcementTextColor']) {
    config.header[key] = validColor(config.header[key], DEFAULT_WEBSITE_CONFIG.header[key]);
  }
  for (const key of ['background', 'textColor']) config.footer[key] = validColor(config.footer[key], DEFAULT_WEBSITE_CONFIG.footer[key]);
  for (const key of ['background', 'textColor']) config.buttons[key] = validColor(config.buttons[key], DEFAULT_WEBSITE_CONFIG.buttons[key]);

  config.header.logoSize = bounded(config.header.logoSize, 36, 140, DEFAULT_WEBSITE_CONFIG.header.logoSize);
  config.header.menuAlignment = oneOf(config.header.menuAlignment, ['left', 'center', 'right'], 'left');
  config.typography.headingFont = oneOf(config.typography.headingFont, ['Playfair Display', 'Inter', 'Georgia', 'Arial'], 'Playfair Display');
  config.typography.bodyFont = oneOf(config.typography.bodyFont, ['Inter', 'Figtree', 'Georgia', 'Arial'], 'Inter');
  config.typography.buttonFont = oneOf(config.typography.buttonFont, ['Inter', 'Figtree', 'Georgia', 'Arial'], 'Inter');
  config.typography.headingScale = bounded(config.typography.headingScale, 0.75, 1.5, 1);
  config.typography.bodyScale = bounded(config.typography.bodyScale, 0.8, 1.3, 1);
  config.typography.headingWeight = bounded(config.typography.headingWeight, 400, 900, 700);
  config.typography.bodyWeight = bounded(config.typography.bodyWeight, 300, 700, 400);
  config.typography.buttonWeight = bounded(config.typography.buttonWeight, 400, 900, 700);
  config.buttons.borderRadius = bounded(config.buttons.borderRadius, 0, 999, 8);
  config.buttons.style = oneOf(config.buttons.style, ['solid', 'outline', 'soft'], 'solid');
  config.buttons.size = oneOf(config.buttons.size, ['small', 'medium', 'large'], 'medium');
  config.buttons.hoverEffect = oneOf(config.buttons.hoverEffect, ['none', 'lift', 'darken', 'glow'], 'lift');
  config.productCards.layout = oneOf(config.productCards.layout, ['classic', 'minimal', 'compact'], 'classic');
  config.productCards.imageRatio = oneOf(config.productCards.imageRatio, ['1/1', '4/5', '3/4'], '4/5');
  config.productCards.borderRadius = bounded(config.productCards.borderRadius, 0, 32, 12);
  config.productCards.shadow = oneOf(config.productCards.shadow, ['none', 'soft', 'elevated'], 'soft');
  config.layout.mode = oneOf(config.layout.mode, ['full', 'boxed'], 'full');
  config.layout.maxWidth = bounded(config.layout.maxWidth, 960, 1920, 1520);
  config.layout.sectionSpacing = bounded(config.layout.sectionSpacing, 16, 160, 72);
  config.layout.gridGap = bounded(config.layout.gridGap, 4, 64, 20);
  config.layout.productsPerRow.desktop = bounded(config.layout.productsPerRow.desktop, 2, 6, 4);
  config.layout.productsPerRow.tablet = bounded(config.layout.productsPerRow.tablet, 2, 5, 3);
  config.layout.productsPerRow.mobile = bounded(config.layout.productsPerRow.mobile, 1, 3, 2);
  config.theme.preset = oneOf(config.theme.preset, Object.keys(PRESET_OVERRIDES), 'default');
  return config;
}

function cleanText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function normalizeIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, 100)).filter(Boolean))].slice(0, 100);
}

function safeExternalUrl(value) {
  const url = cleanText(value, 2000);
  return !url || /^https:\/\//i.test(url) ? url : '';
}

function safeInternalPath(value) {
  const path = cleanText(value, 500);
  return !path || /^\/(?!\/)/.test(path) ? path : '';
}

function normalizeMenu(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map((item) => ({
    label: cleanText(item?.label, 80),
    path: cleanText(item?.path, 500),
  })).filter((item) => item.label && /^\/(?!\/)/.test(item.path));
}

function buildPresetConfig(preset = 'default') {
  return normalizeWebsiteConfig(mergeKnown(DEFAULT_WEBSITE_CONFIG, PRESET_OVERRIDES[preset] || {}));
}

function getPresetList() {
  return Object.keys(PRESET_OVERRIDES).map((id) => ({ id, name: PRESET_LABELS[id], config: buildPresetConfig(id) }));
}

module.exports = {
  DEFAULT_WEBSITE_CONFIG,
  SECTION_DEFAULTS,
  buildPresetConfig,
  getPresetList,
  normalizeWebsiteConfig,
};
