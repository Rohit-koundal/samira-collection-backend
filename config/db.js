const dns = require('node:dns');
const mongoose = require('mongoose');

function usePublicDnsForAtlasSrv(uri = '') {
  if (!String(uri).startsWith('mongodb+srv://')) return;
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
  } catch {
    // Keep the OS resolver if Node refuses to change servers.
  }
}

async function connectDB() {
  try {
    mongoose.set('bufferCommands', false);
    if (!process.env.MONGO_URI) {
      console.warn('MONGO_URI missing. API started without database connection.');
      return;
    }
    usePublicDnsForAtlasSrv(process.env.MONGO_URI);
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 7000 });
    console.log('MongoDB connected');
  } catch (error) {
    console.error(`MongoDB connection failed: ${error.message}`);
    if (process.env.REQUIRE_DATABASE === 'true') {
      process.exit(1);
    }
    console.warn('API is still running without a database connection. Database-backed routes will return errors until MongoDB is reachable.');
  }
}

module.exports = connectDB;
