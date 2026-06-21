import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const portfolios = await Portfolio.find({});
  console.log(`Found ${portfolios.length} Portfolio documents in database:`);
  console.log(JSON.stringify(portfolios, null, 2));
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close();
});
