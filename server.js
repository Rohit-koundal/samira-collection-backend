const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

const app = require('./app');
const connectDB = require('./config/db');
const { isR2Configured } = require('./services/r2Upload');
const { isCloudinaryConfigured } = require('./services/cloudinaryUpload');
const { assertProductionSecrets, getOtpMode, isProduction } = require('./config/env');

async function startServer() {
  try {
    assertProductionSecrets();
  } catch (error) {
    console.error(`Startup aborted: ${error.message}`);
    process.exit(1);
  }

  if (isProduction() && getOtpMode() === 'demo') {
    console.warn('OTP_MODE=demo is active in production. A fixed demo OTP is accepted. Set OTP_MODE=production once a real SMS provider is connected.');
  }

  await connectDB();

  const PORT = process.env.SERVER_PORT || process.env.PORT || 5000;
  const persistentImageStorageConfigured = isR2Configured() || isCloudinaryConfigured();

  if (isProduction() && !persistentImageStorageConfigured) {
    console.warn('Persistent image storage is not configured. Product uploads will be rejected until Cloudinary or R2 is connected.');
  }

  app.listen(PORT, () => console.log(`Backend API running on port ${PORT}`));
}

startServer();

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error.message);
});
