const { asyncHandler } = require('../middleware/validate');
const service = require('../services/clientPlatformService');

function credentials(req) {
  return {
    installationId: req.get('x-installation-id'),
    secret: req.get('x-license-key'),
  };
}

exports.validate = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await service.validateInstallation({ ...credentials(req), appVersion: req.body?.appVersion, protocolVersion: req.body?.protocolVersion, telemetry: req.body?.telemetry, ip: req.ip }));
});

exports.checkout = asyncHandler(async (req, res) => {
  const installation = await service.authenticateInstallation(credentials(req).installationId, credentials(req).secret);
  res.json(await service.createCheckout({ installation, input: req.body || {} }));
});

exports.verify = asyncHandler(async (req, res) => {
  const installation = await service.authenticateInstallation(credentials(req).installationId, credentials(req).secret);
  const result = await service.verifyCheckout({ installation, input: req.body || {} });
  res.json({ success: true, status: result.installation.status });
});
