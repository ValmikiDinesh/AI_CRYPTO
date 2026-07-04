import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  const portfolio = await Portfolio.findOne({});
  
  console.log("Original Portfolio state:");
  console.log("- manuallyDisabledAssets:", portfolio.manuallyDisabledAssets);
  console.log("- autoIgnoredAssets:", portfolio.autoIgnoredAssets);
  console.log("- isSquaringOff:", portfolio.isSquaringOff);
  
  console.log("\nSimulating manual disable of LINKUSDT...");
  if (!portfolio.manuallyDisabledAssets) {
    portfolio.manuallyDisabledAssets = [];
  }
  if (!portfolio.manuallyDisabledAssets.includes('LINKUSDT')) {
    portfolio.manuallyDisabledAssets.push('LINKUSDT');
  }
  
  await portfolio.save();
  
  console.log("\nUpdated Portfolio state:");
  console.log("- manuallyDisabledAssets:", portfolio.manuallyDisabledAssets);
  console.log("- autoIgnoredAssets:", portfolio.autoIgnoredAssets);
  console.log("- isSquaringOff:", portfolio.isSquaringOff);
  
  await mongoose.connection.close();
}

run().catch(console.error);
