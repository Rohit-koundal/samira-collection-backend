const mongoose = require('mongoose');

async function connectDB() {
  try {
    mongoose.set('bufferCommands', false);
    if (!process.env.MONGO_URI) {
      console.warn('MONGO_URI missing. API started without database connection.');
      return;
    }
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 7000 });
    console.log('MongoDB connected');
  } catch (error) {
    console.error(`MongoDB connection failed: ${error.message}`);
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
    console.warn('API is still running in development mode. Database-backed routes will return errors until MongoDB is reachable.');
  }
}

module.exports = connectDB;
