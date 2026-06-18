const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

const app = require('./app');
const connectDB = require('./config/db');
const { isR2Configured } = require('./services/r2Upload');
const { isCloudinaryConfigured } = require('./services/cloudinaryUpload');

async function startServer() {
  await connectDB();

  const PORT = process.env.SERVER_PORT || process.env.PORT || 5000;
  const persistentImageStorageConfigured = isR2Configured() || isCloudinaryConfigured();

  if (process.env.NODE_ENV === 'production' && !persistentImageStorageConfigured) {
    console.warn('Persistent image storage is not configured. Product uploads will be rejected until Cloudinary or R2 is connected.');
  }

  app.listen(PORT, () => console.log(`Backend API running on port ${PORT}`));
}

startServer();

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error.message);
});
