const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

const { validateEnvironment } = require('./config/env');
validateEnvironment();

const app = require('./app');
const connectDB = require('./config/db');
const mongoose = require('mongoose');
const { getMediaStorageState } = require('./services/mediaStorage');
const { startReservationCleanup } = require('./services/inventoryService');

let httpServer;
let reservationCleanupTimer;
let shuttingDown = false;

async function startServer() {
  await connectDB();
  reservationCleanupTimer = startReservationCleanup();

  const PORT = process.env.SERVER_PORT || process.env.PORT || 5000;
  const media = getMediaStorageState();

  if (process.env.NODE_ENV !== 'production' && !media.configured) {
    console.warn(JSON.stringify({ level: 'warn', event: 'media_storage_not_configured' }));
  }

  httpServer = app.listen(PORT, () => console.log(JSON.stringify({
    level: 'info',
    event: 'server_started',
    port: Number(PORT),
    mediaProvider: media.provider,
  })));
  return httpServer;
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
  if (reservationCleanupTimer) clearInterval(reservationCleanupTimer);
  const forceTimer = setTimeout(() => process.exit(1), 10_000);
  forceTimer.unref();
  try {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    if (mongoose.connection.readyState !== 0) await mongoose.connection.close(false);
    clearTimeout(forceTimer);
    process.exit(exitCode);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'shutdown_failed', code: error.code || 'SHUTDOWN_FAILED' }));
    process.exit(1);
  }
}

startServer().catch((error) => {
  console.error(JSON.stringify({ level: 'error', event: 'startup_failed', code: error.code || 'STARTUP_FAILED' }));
  process.exit(1);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (error) => {
  console.error(JSON.stringify({ level: 'error', event: 'unhandled_rejection', code: error.code || 'UNHANDLED_REJECTION' }));
  shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  console.error(JSON.stringify({ level: 'error', event: 'uncaught_exception', code: error.code || 'UNCAUGHT_EXCEPTION' }));
  shutdown('uncaughtException', 1);
});

module.exports = { shutdown, startServer };
