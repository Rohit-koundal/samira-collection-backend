const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const slugify = require('../utils/slugify');
const { ApiError } = require('../utils/apiError');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const INCLUDED_ROOTS = ['src', 'public', 'backend', 'ai-video-worker', 'scripts'];
const INCLUDED_FILES = ['package.json', 'package-lock.json', 'postcss.config.js', 'tailwind.config.js', 'render.yaml'];
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.github', '.idea', '.vscode', '.cache', '.pytest_cache', '.venv', 'venv', '__pycache__',
  'node_modules', 'build', 'dist', 'coverage', 'uploads', 'tmp', '.tmp', 'logs', '.next', '.output',
]);
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const CLIENT_PROJECT_EXCLUDES = new Set([
  'src/pages/admin/MasterConfiguration.jsx',
  'src/pages/admin/MasterConfiguration.test.jsx',
  'src/pages/admin/PlatformStores.jsx',
  'src/pages/admin/ClientInstallations.jsx',
  'src/pages/seller/Subscription.jsx',
  'src/components/layout/MasterRoute.jsx',
  'src/components/layout/MasterRoute.test.jsx',
  'backend/controllers/masterController.js',
  'backend/routes/masterRoutes.js',
  'backend/services/projectGeneratorService.js',
  'backend/controllers/subscriptionController.js',
  'backend/models/SubscriptionPayment.js',
  'backend/services/subscriptionService.js',
  'backend/controllers/clientPlatformController.js',
  'backend/models/ClientInstallation.js',
  'backend/models/InstallationPayment.js',
  'backend/models/PlatformRelease.js',
  'backend/routes/platformControlRoutes.js',
  'backend/services/clientPlatformService.js',
  'backend/tests/masterOwner.unit.test.js',
  'backend/tests/applicationWorkflows.integration.test.js',
  'backend/tests/subscription.integration.test.js',
  'backend/tests/clientPlatform.unit.test.js',
  'backend/tests/clientPlatform.integration.test.js',
  'backend/tests/websiteCustomization.test.js',
]);

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeText(value, max) {
  return String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

function normalizeProject(input = {}, structure = {}) {
  const companyName = safeText(input.companyName, 80);
  const projectName = safeText(input.projectName || companyName, 80);
  const requestedSlug = safeText(input.projectSlug || projectName, 70);
  const projectSlug = slugify(requestedSlug).slice(0, 60);
  if (companyName.length < 2) throw new ApiError('VALIDATION_ERROR', 'Enter a company name with at least 2 characters');
  if (projectName.length < 2) throw new ApiError('VALIDATION_ERROR', 'Enter a project name with at least 2 characters');
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(projectSlug)) throw new ApiError('VALIDATION_ERROR', 'Use a project folder name with letters, numbers and hyphens');
  const industry = safeText(structure.industry || structure.id, 40).toLowerCase();
  if (!industry) throw new ApiError('VALIDATION_ERROR', 'Choose a business type');
  return {
    projectName,
    companyName,
    projectSlug,
    industry,
    industryName: safeText(structure.name, 80) || industry,
    includeAiWorker: input.includeAiWorker !== false,
  };
}

function isEnvironmentFile(name) {
  const lower = name.toLowerCase();
  return lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env') || lower.includes('.env.');
}

function shouldExclude(relativePath, includeAiWorker) {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (!includeAiWorker && parts[0] === 'ai-video-worker') return true;
  if (parts.some((part) => EXCLUDED_DIRECTORIES.has(part))) return true;
  const name = parts[parts.length - 1];
  if (isEnvironmentFile(name)) return true;
  if (/\.(?:log|pid|sqlite|sqlite3|db|tgz)$/i.test(name) || name === '.DS_Store') return true;
  if (/(?:credentials?|service[-_]?account)[^/]*\.json$/i.test(name)) return true;
  return false;
}

async function collectDirectory(directory, prefix, project, entries, counters) {
  let children;
  try {
    children = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return;
    throw error;
  }
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const relative = path.posix.join(prefix, child.name);
    if (shouldExclude(relative, project.includeAiWorker)) continue;
    const absolute = path.join(directory, child.name);
    if (child.isDirectory()) {
      await collectDirectory(absolute, relative, project, entries, counters);
      continue;
    }
    if (!child.isFile()) continue;
    const stat = await fs.promises.stat(absolute);
    if (stat.size > MAX_FILE_BYTES) throw new ApiError('PROJECT_TOO_LARGE', `${relative} is too large for a generated project`);
    counters.files += 1;
    counters.bytes += stat.size;
    if (counters.files > MAX_FILES || counters.bytes > MAX_TOTAL_BYTES) throw new ApiError('PROJECT_TOO_LARGE', 'The source project is too large to package safely');
    entries.push({ name: relative, data: await fs.promises.readFile(absolute), date: stat.mtime });
  }
}

function replaceJson(buffer, update) {
  const parsed = JSON.parse(buffer.toString('utf8'));
  update(parsed);
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
}

function transformEntry(entry, project, structure) {
  const { name } = entry;
  if (name === 'package.json') return { ...entry, data: replaceJson(entry.data, (value) => { value.name = project.projectSlug; value.description = `${project.companyName} ${project.industryName} commerce application`; }) };
  if (name === 'package-lock.json') return { ...entry, data: replaceJson(entry.data, (value) => { value.name = project.projectSlug; if (value.packages?.['']) value.packages[''].name = project.projectSlug; }) };
  if (name === 'backend/package.json') return { ...entry, data: replaceJson(entry.data, (value) => { value.name = `${project.projectSlug}-backend`; value.description = `${project.companyName} backend API`; }) };
  if (name === 'backend/package-lock.json') return { ...entry, data: replaceJson(entry.data, (value) => { value.name = `${project.projectSlug}-backend`; if (value.packages?.['']) value.packages[''].name = `${project.projectSlug}-backend`; }) };
  if (name === 'public/manifest.json') return { ...entry, data: replaceJson(entry.data, (value) => {
    value.name = project.companyName;
    value.short_name = project.companyName.slice(0, 16);
    value.description = `Shop ${project.industryName.toLowerCase()} products, manage your bag and track orders with ${project.companyName}.`;
  }) };
  if (name === 'public/index.html') {
    const content = entry.data.toString('utf8')
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(project.companyName)}</title>`)
      .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(" \/>)/, `$1${escapeHtml(project.companyName.slice(0, 16))}$2`)
      .replace(/content="Ethnic wear, festive styles and everyday luxury from Samira Collection\."/, `content="${escapeHtml(project.industryName)} products from ${escapeHtml(project.companyName)}."`);
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'public/sw.js') {
    return { ...entry, data: Buffer.from(entry.data.toString('utf8').replaceAll('samira-phone-shell', `${project.projectSlug}-phone-shell`)) };
  }
  if (name === 'public/offline.html') {
    return { ...entry, data: Buffer.from(entry.data.toString('utf8').replace('<title>Store offline</title>', `<title>${escapeHtml(project.companyName)} is offline</title>`)) };
  }
  if (name === 'src/components/pwa/MobileAppCompanion.jsx') {
    return { ...entry, data: Buffer.from(entry.data.toString('utf8').replaceAll('samira_install_prompt_dismissed', `${project.projectSlug}_install_prompt_dismissed`)) };
  }
  if (name === 'src/App.jsx') {
    const content = entry.data.toString('utf8')
      .replace(/^import MasterRoute from .*\r?\n/m, '')
      .replace(/^const MasterConfiguration = .*\r?\n/m, '')
      .replace(/^const PlatformStores = .*\r?\n/m, '')
      .replace(/^const ClientInstallations = .*\r?\n/m, '')
      .replace(/^const SellerSubscription = .*\r?\n/m, '')
      .replace(/^\s*'\/seller\/subscription': SellerSubscription,\r?\n/m, '')
      .replace(/\nconst masterPages = \{[\s\S]*?\n\};\n/, '\n')
      .replace(/^\s*const isMaster = .*\r?\n/m, '')
      .replace(/const isAdmin = routePath\.startsWith\('\/admin'\) \|\| isMaster;/, "const isAdmin = routePath.startsWith('/admin');")
      .replace(/^\s*if \(isMaster\) return .*\r?\n/m, '')
      .replace('[isAdmin, isMaster, isHostStore, isSeller, logicalPath, routePath]', '[isAdmin, isHostStore, isSeller, logicalPath, routePath]')
      .replace("{isMaster || routePath === '/admin/customization' ? <MasterRoute>{page}</MasterRoute> : page}", '{page}');
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'src/components/seller/SellerLayout.jsx') {
    const content = entry.data.toString('utf8')
      .replace('ChevronRight, CreditCard, ', 'ChevronRight, ')
      .replace(/^\s*\['Plan & billing'.*\r?\n/m, '')
      .replace(/^\s*'Plan & billing': CreditCard,\r?\n/m, '')
      .replace(/<a href="\/seller\/subscription"[^>]*>View plans<\/a>/, '');
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'src/components/admin/AdminSidebar.jsx') {
    const content = entry.data.toString('utf8')
      .replace(', Store, ShieldCheck }', ', ShieldCheck }')
      .replace(/^import \{ useAuth \} from .*\r?\n/m, '')
      .replace(/^\s*\['Master configuration'.*\r?\n/m, '')
      .replace(/^\s*\['Store portfolio'.*\r?\n/m, '')
      .replace(/^\s*\['Client control'.*\r?\n/m, '')
      .replace(/^\s*const \{ user \} = useAuth\(\);\r?\n/m, '')
      .replace(/^\s*const master = .*\r?\n/m, '')
      .replace(/const items = useMemo\(\(\) => ADMIN_LINKS\.filter\([\s\S]*?\)\.map\(\(\[label, path\]\) => \(\{/, 'const items = useMemo(() => ADMIN_LINKS.map(([label, path]) => ({')
      .replace(/\}\)\), \[activeHref, master\]\);/, '})), [activeHref]);')
      .replace(/^\s*'Store portfolio': <Store .*\r?\n/m, '')
      .replace(/^\s*'Client control': <ShieldCheck .*\r?\n/m, '');
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'src/pages/admin/WebsiteCustomizer.jsx') {
    const content = entry.data.toString('utf8')
      .replace(' disabled={!!busy || !!issues.length || workspace.configurationLocked}', ' disabled={!!busy || !!issues.length}')
      .replace(/\n    \{workspace\.configurationLocked && <p className="admin-card[\s\S]*?<\/p>\}/, '')
      .replace(' disabled={!!busy || workspace.configurationLocked}', ' disabled={!!busy}');
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'src/config/websiteCustomization.js') {
    const escapedCompany = escapeSingleQuotedJs(project.companyName);
    const shortName = escapeSingleQuotedJs(project.companyName.split(/\s+/)[0]);
    const content = entry.data.toString('utf8')
      .replaceAll('Samira Collection', escapedCompany)
      .replaceAll('Samira community', `${shortName} community`)
      .replaceAll('Samira Circle', `${shortName} Circle`);
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'backend/services/storeService.js') {
    const content = entry.data.toString('utf8')
      .replace("const DEFAULT_STORE_SLUG = 'samira-collection';", `const DEFAULT_STORE_SLUG = '${project.projectSlug}';`)
      .replace("const DEFAULT_STORE_NAME = 'Samira Collection';", `const DEFAULT_STORE_NAME = ${JSON.stringify(project.companyName)};`)
      .replace("    industry: 'fashion',", `    industry: '${project.industry}',`);
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'backend/services/controlPlaneClient.js') {
    const content = entry.data.toString('utf8').replace('const MANAGED_CLIENT_BUILD = false;', 'const MANAGED_CLIENT_BUILD = true;');
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'backend/config/industryPresets.js') {
    const content = entry.data.toString('utf8').replace(
      'const DEFAULT_STRUCTURE = { ...INDUSTRY_PRESETS[0], clientPermissions:',
      `const DEFAULT_STRUCTURE = { ...${JSON.stringify(structure)}, clientPermissions:`,
    );
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'backend/config/corsOptions.js') {
    const content = entry.data.toString('utf8').replace('https://samira-collection.onrender.com', `https://${project.projectSlug}.onrender.com`);
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'backend/app.js') {
    const content = entry.data.toString('utf8')
      .replace(/^app\.use\('\/api\/platform'.*\r?\n/m, '')
      .replace(/^app\.use\('\/api\/master'.*\r?\n/m, '')
      .replace("require('./controllers/masterController').publicCatalog", "require('./controllers/catalogConfigurationController').publicCatalog")
      .replace("app.get('/', (req, res) => res.json({ message: 'Samira Collection API is running' }));", `app.get('/', (req, res) => res.json({ message: ${JSON.stringify(`${project.companyName} API is running`)} }));`);
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'backend/routes/websiteCustomizationRoutes.js') {
    const content = entry.data.toString('utf8')
      .replace(/^const \{ masterOnly \} = .*\r?\nrouter\.use\(masterOnly\);\r?\n/m, '')
      .replace(/const \{ readConfiguration \} = require\('\.\.\/services\/masterConfigurationService'\);[\s\S]*?next\(\);\n\}\);\n/, '')
      .replace("router.post('/themes/:id/publish', unlocked, customization.publishTheme);", "router.post('/themes/:id/publish', customization.publishTheme);")
      .replace("router.post('/themes/:id/activate', unlocked, customization.activateTheme);", "router.post('/themes/:id/activate', customization.activateTheme);");
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'backend/routes/storeRoutes.js') {
    const content = entry.data.toString('utf8')
      .replace(/^const rateLimit = .*\r?\n/m, '')
      .replace(/^const \{ masterOnly \} = .*\r?\n/m, '')
      .replace(/\nconst createLimiter = rateLimit\(\{[\s\S]*?\n\}\);\n/, '\n')
      .replace(/^router\.post\('\/', protect, masterOnly.*\r?\n/m, '');
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'backend/routes/sellerRoutes.js') {
    const content = entry.data.toString('utf8')
      .replace(/^const subscription = .*\r?\n/m, '')
      .replace('requireActiveStoreLicenseForWrites, requireProductCapacity, ', '')
      .replace(/^router\.(?:get|post)\('\/subscription.*\r?\n/gm, '')
      .replace(/^router\.use\(requireActiveStoreLicenseForWrites\);\r?\n/m, '')
      .replace(', requireProductCapacity, stripClientStoreId, product.createProduct', ', stripClientStoreId, product.createProduct');
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'backend/controllers/orderController.js') {
    const content = entry.data.toString('utf8')
      .replace(/^const \{ assertMonthlyOrderCapacity, assertStoreCanAcceptOrders \} = .*\r?\n/m, '')
      .replace(/^\s*assertStoreCanAcceptOrders\(req\.store\);\r?\n/gm, '')
      .replace(/^\s*await assertMonthlyOrderCapacity\(req\.store\);\r?\n/gm, '');
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'backend/controllers/paymentController.js') {
    const content = entry.data.toString('utf8')
      .replace(/^const \{ assertMonthlyOrderCapacity \} = .*\r?\n/m, '')
      .replace(/^\s*await assertMonthlyOrderCapacity\(req\.store\);\r?\n/gm, '')
      .replace(/\n\s*\/\/ CLIENT_PROJECT_REMOVE_SUBSCRIPTION_START[\s\S]*?\/\/ CLIENT_PROJECT_REMOVE_SUBSCRIPTION_END\r?\n/, '\n');
    return { ...entry, data: Buffer.from(content) };
  }
  if (name === 'render.yaml') {
    const content = entry.data.toString('utf8')
      .replaceAll('samira-collection-backend', `${project.projectSlug}-backend`)
      .replaceAll('samira-collection', project.projectSlug)
      .replaceAll('samira-reel-', `${project.projectSlug}-reel-`)
      .replace(/^\s*- key: CONTROL_PLANE_PUBLIC_URL\r?\n\s*(?:value:.*|sync:.*)\r?\n/gm, '')
      .replace(/^\s*- key: LICENSE_SIGNING_PRIVATE_KEY\r?\n\s*(?:value:.*|sync:.*)\r?\n/gm, '')
      .replace(/^\s*- key: PLATFORM_CREDENTIAL_ENCRYPTION_KEY\r?\n\s*(?:value:.*|sync:.*)\r?\n/gm, '')
      .replace(/^\s*- key: DEPLOY_HOOK_ALLOWED_HOSTS\r?\n\s*(?:value:.*|sync:.*)\r?\n/gm, '')
      .replace(/(\s+- key: LICENSE_SIGNING_PUBLIC_KEY\r?\n\s+sync: false\r?\n)/, `$1      - key: CONTROL_PLANE_URL\n        sync: false\n      - key: CLIENT_INSTALLATION_ID\n        sync: false\n      - key: CLIENT_LICENSE_KEY\n        sync: false\n`);
    return { ...entry, data: Buffer.from(content) };
  }
  return entry;
}

function escapeSingleQuotedJs(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function environmentExamples(project) {
  const database = project.projectSlug.replace(/-/g, '_');
  return [
    {
      name: '.env.example',
      data: Buffer.from([
        `REACT_APP_API_URL=http://localhost:5000/api`,
        `REACT_APP_DEFAULT_STORE_NAME=${JSON.stringify(project.companyName)}`,
        'REACT_APP_ENABLE_REEL_PRODUCT_IMPORT=false',
        'REACT_APP_RAZORPAY_KEY_ID=',
        'GENERATE_SOURCEMAP=false',
        'BROWSER=none',
        '',
      ].join('\n')),
    },
    {
      name: 'backend/.env.example',
      data: Buffer.from([
        'NODE_ENV=development',
        'SERVER_PORT=5000',
        `MONGO_URI=mongodb://127.0.0.1:27017/${database}`,
        `DEFAULT_STORE_NAME=${JSON.stringify(project.companyName)}`,
        `DEFAULT_STORE_SLUG=${project.projectSlug}`,
        `DEFAULT_INDUSTRY=${project.industry}`,
        'APP_VERSION=1.0.0',
        '# Managed access values are issued in client-installation.json when this package is generated.',
        'CONTROL_PLANE_URL=',
        'CLIENT_INSTALLATION_ID=',
        'CLIENT_LICENSE_KEY=',
        'LICENSE_SIGNING_PUBLIC_KEY=',
        'CONTROL_PLANE_TIMEOUT_MS=5000',
        'CLIENT_ORIGINS=http://localhost:3000',
        'FRONTEND_URL=http://localhost:3000',
        'JWT_SECRET=replace-with-a-long-random-secret',
        'JWT_REFRESH_SECRET=replace-with-a-different-long-random-secret',
        'ADMIN_PHONE_NUMBERS=',
        'OTP_MODE=demo',
        'DEMO_OTP=123456',
        'SMS_PROVIDER=mock',
        'SMS_ACCOUNT_SID=',
        'SMS_AUTH_TOKEN=',
        'SMS_SENDER_ID=',
        'GEMINI_API_KEY=',
        'RAZORPAY_KEY_ID=',
        'RAZORPAY_KEY_SECRET=',
        '# Select the active courier later in Settings > Orders & delivery.',
        '# Carrier credentials stay on this backend and are never put in the frontend.',
        'BLUEDART_MODE=sandbox',
        'BLUEDART_CLIENT_ID=',
        'BLUEDART_CLIENT_SECRET=',
        'BLUEDART_LOGIN_ID=',
        'BLUEDART_LICENCE_KEY=',
        'BLUEDART_CUSTOMER_CODE=',
        'BLUEDART_ORIGIN_AREA=',
        'BLUEDART_PRODUCT_CODE=',
        'BLUEDART_PACK_TYPE=',
        'BLUEDART_FEATURE=',
        'BLUEDART_LIVE_BOOKING_ENABLED=false',
        'BLUEDART_COD_ENABLED=false',
        'BLUEDART_REVERSE_ENABLED=false',
        'SHIPROCKET_EMAIL=',
        'SHIPROCKET_PASSWORD=',
        'SHIPROCKET_PICKUP_LOCATION=',
        'SHIPROCKET_FALLBACK_EMAIL=',
        'SHIPROCKET_LIVE_BOOKING_ENABLED=false',
        'SHIPROCKET_COD_ENABLED=false',
        'SHIPROCKET_REVERSE_ENABLED=false',
        'SHIPROCKET_SELECTION_STRATEGY=recommended',
        'DELHIVERY_MODE=sandbox',
        'DELHIVERY_TOKEN=',
        'DELHIVERY_CLIENT_NAME=',
        'DELHIVERY_WAREHOUSE_NAME=',
        'DELHIVERY_LIVE_BOOKING_ENABLED=false',
        'DELHIVERY_COD_ENABLED=false',
        'DELHIVERY_REVERSE_ENABLED=false',
        'DELHIVERY_SHIPPING_MODE=Surface',
        'XPRESSBEES_EMAIL=',
        'XPRESSBEES_PASSWORD=',
        'XPRESSBEES_WAREHOUSE_NAME=',
        'XPRESSBEES_LIVE_BOOKING_ENABLED=false',
        'XPRESSBEES_COD_ENABLED=false',
        'XPRESSBEES_REVERSE_ENABLED=false',
        'R2_ACCOUNT_ID=',
        'R2_ACCESS_KEY_ID=',
        'R2_SECRET_ACCESS_KEY=',
        'R2_BUCKET_NAME=',
        'R2_PUBLIC_URL=',
        'CLOUDINARY_CLOUD_NAME=',
        'CLOUDINARY_API_KEY=',
        'CLOUDINARY_API_SECRET=',
        '',
      ].join('\n')),
    },
  ];
}

function generatedReadme(project, structure, installation) {
  const managedSetup = installation ? `\n## Managed installation\n\nThis package has one unique, revocable installation identity. Open \`client-installation.json\`, copy its values into the **backend hosting environment**, and then permanently delete that file before committing or sharing the project. Never put \`CLIENT_LICENSE_KEY\` in the frontend. The admin **System & updates** screen shows subscription, limits, connection state and assigned updates without exposing that key.\n` : '';
  return Buffer.from(`# ${project.projectName}\n\nA standalone ${project.industryName} commerce project generated for **${project.companyName}**. It has its own source tree and must use its own database, storage and service credentials. Master Configuration, Store Portfolio and project-generation tools are intentionally absent from this client project.${managedSetup}\n## Start locally\n\n1. Extract this folder.\n2. Copy \`.env.example\` to \`.env\`.\n3. Copy \`backend/.env.example\` to \`backend/.env\`.\n4. Set a new MongoDB database URL and replace the JWT secrets.\n5. If present, transfer \`client-installation.json\` values to the backend environment and delete the file.\n6. Run \`npm install\` in this folder and in \`backend\`.\n7. Run \`npm run server\` in one terminal and \`npm start\` in another.\n\n## Phone app experience\n\nThe responsive storefront is also an installable Progressive Web App. It includes mobile navigation, product search and filters, product detail and sharing, bag, wishlist, address and payment checkout, orders and tracking, returns, profile, notifications, offline/update status, safe-area layout and home-screen shortcuts. The same backend remains the source of truth for identity, price, stock, coupons, payment and order state.\n\nThe default catalog uses **${structure.name}** with ${(structure.attributes || []).length} product fields and ${(structure.categoryDefinitions || []).length} category definitions. Update branding, owner phone, payment, media, SMS and shipping credentials in the new installation before deployment. Website Designer remains available to the project admin.\n\n## Security\n\nNo existing \`.env\` file, database record, upload, Git history, build output or dependency is copied from the source platform. The one-time installation credential is newly generated for this client and can be revoked independently. Production builds omit source maps, deployment headers restrict script sources and framing, private API responses are not cached, CORS accepts only configured origins, and sensitive actions are validated by the backend. Browser JavaScript is public by design, so never put secrets or authorization decisions in frontend code.\n`);
}

function installationFile(installation) {
  if (!installation) return null;
  return {
    name: 'client-installation.json',
    data: Buffer.from(`${JSON.stringify({
      notice: 'Sensitive one-time backend configuration. Transfer these values to the backend environment, then delete this file.',
      CONTROL_PLANE_URL: installation.controlPlaneUrl,
      CLIENT_INSTALLATION_ID: installation.installationId,
      CLIENT_LICENSE_KEY: installation.licenseKey,
      LICENSE_SIGNING_PUBLIC_KEY: installation.signingPublicKey,
      APP_VERSION: installation.appVersion,
    }, null, 2)}\n`),
  };
}

function catalogConfigurationController() {
  return Buffer.from(`const { asyncHandler } = require('../middleware/validate');\nconst { readConfiguration, publicStructure } = require('../services/masterConfigurationService');\n\nexports.publicCatalog = asyncHandler(async (req, res) => {\n  res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');\n  res.setHeader('Vary', 'Host, X-Store-Slug');\n  res.json(publicStructure(await readConfiguration(req.store?._id)));\n});\n`);
}

function cleanGitignore() {
  return Buffer.from(`# Dependencies and output\nnode_modules/\nbuild/\ndist/\ncoverage/\n.cache/\n.pytest_cache/\n__pycache__/\n.venv/\n\n# Runtime and private files\n.env\n.env.*\n!.env.example\n**/.env\n**/.env.*\n!**/.env.example\nclient-installation.json\nuploads/\n**/uploads/\ntmp/\n**/tmp/\n*.log\n*.pid\n\n# Editors and operating systems\n.vscode/\n.idea/\n.DS_Store\nThumbs.db\n`);
}

async function sourceEntries(project) {
  const entries = [];
  const counters = { files: 0, bytes: 0 };
  for (const root of INCLUDED_ROOTS) {
    if (shouldExclude(root, project.includeAiWorker)) continue;
    await collectDirectory(path.join(PROJECT_ROOT, root), root, project, entries, counters);
  }
  for (const name of INCLUDED_FILES) {
    const absolute = path.join(PROJECT_ROOT, name);
    try {
      const stat = await fs.promises.stat(absolute);
      entries.push({ name, data: await fs.promises.readFile(absolute), date: stat.mtime });
      counters.files += 1; counters.bytes += stat.size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!entries.some((entry) => entry.name === 'src/App.jsx') || !entries.some((entry) => entry.name === 'backend/app.js')) {
    throw new ApiError('PROJECT_TEMPLATE_UNAVAILABLE', 'The complete project source is not available on this server');
  }
  return { entries, counters };
}

function dosDateTime(date = new Date()) {
  const safe = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, safe.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((safe.getMonth() + 1) << 5) | safe.getDate(),
    time: (safe.getHours() << 11) | (safe.getMinutes() << 5) | Math.floor(safe.getSeconds() / 2),
  };
}

function makeZip(entries, rootFolder) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const filename = Buffer.from(`${rootFolder}/${entry.name.replace(/\\/g, '/')}`);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    const checksum = crc32(data);
    const stamp = dosDateTime(entry.date);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26); local.writeUInt16LE(0, 28);
    localParts.push(local, filename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12); central.writeUInt16LE(stamp.date, 14); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function previewProject(input, structure) {
  const project = normalizeProject(input, structure);
  const { entries, counters } = await sourceEntries(project);
  const packagedFiles = entries.filter((entry) => !CLIENT_PROJECT_EXCLUDES.has(entry.name)).length + 5;
  return {
    projectName: project.projectName,
    companyName: project.companyName,
    projectSlug: project.projectSlug,
    downloadName: `${project.projectSlug}.zip`,
    industry: project.industry,
    industryName: project.industryName,
    sourceFiles: packagedFiles,
    approximateSourceBytes: counters.bytes,
    includes: ['Frontend application', 'Backend API', 'Industry product schema', 'Responsive storefront and admin', 'Installable phone app with safe offline shell', 'Bag, wishlist, checkout, orders, returns, tracking and notifications', 'Signed subscription and update connector', 'Production security headers and server-side validation', ...(project.includeAiWorker ? ['AI video worker source'] : [])],
    excludes: ['Master Configuration, Store Portfolio and Client Control', 'Existing products and orders', 'Database records', 'Existing environment secrets', 'Uploaded media', 'Git history', 'Dependencies and build output'],
  };
}

async function generateProject(input, structure, options = {}) {
  const project = normalizeProject(input, structure);
  const installation = options.installation || null;
  const { entries } = await sourceEntries(project);
  const transformed = entries
    .filter((entry) => !CLIENT_PROJECT_EXCLUDES.has(entry.name))
    .filter((entry) => !['README.md', '.gitignore', '.env.example', 'backend/.env.example'].includes(entry.name))
    .map((entry) => transformEntry(entry, project, structure));
  const manifest = {
    format: 'standalone-commerce-project', version: 1, generatedAt: new Date().toISOString(),
    project: { name: project.projectName, folder: project.projectSlug, companyName: project.companyName },
    industry: { id: project.industry, name: project.industryName },
    features: {
      masterConfiguration: false,
      storePortfolio: false,
      projectGenerator: false,
      websiteDesigner: true,
      responsiveStorefront: true,
      installablePhoneApp: true,
      offlineAppShell: true,
      mobileNavigation: true,
      cartWishlistCheckout: true,
      ordersReturnsTracking: true,
      customerNotifications: true,
      sellerAndAdminMobileViews: true,
      backendTrustValidation: true,
      signedPlatformEntitlements: true,
      systemUpdateStatus: true,
    },
    dataIncluded: false, credentialsIncluded: Boolean(installation), managedInstallation: Boolean(installation),
  };
  transformed.push(
    { name: 'README.md', data: generatedReadme(project, structure, installation) },
    { name: '.gitignore', data: cleanGitignore() },
    ...environmentExamples(project),
    { name: 'backend/controllers/catalogConfigurationController.js', data: catalogConfigurationController() },
    { name: 'project-manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
  );
  const credentials = installationFile(installation);
  if (credentials) transformed.push(credentials);
  return { project, buffer: makeZip(transformed, project.projectSlug), files: transformed.length };
}

module.exports = { normalizeProject, previewProject, generateProject, makeZip, shouldExclude };
