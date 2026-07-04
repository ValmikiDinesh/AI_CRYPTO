import { checkAssetLiquidity } from '../services/exchangeService.js';
import connectDB from '../config/db.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await connectDB();
  
  console.log("Checking liquidity for HEIUSDT (Short position needs asks):");
  const heiLiquid = await checkAssetLiquidity('HEIUSDT', 'short');
  console.log("-> HEIUSDT short liquid:", heiLiquid);

  console.log("\nChecking liquidity for LINKUSDT (Long position needs bids):");
  const linkLiquid = await checkAssetLiquidity('LINKUSDT', 'long');
  console.log("-> LINKUSDT long liquid:", linkLiquid);

  console.log("\nChecking liquidity for XRPUSDT (Short position needs asks):");
  const xrpLiquid = await checkAssetLiquidity('XRPUSDT', 'short');
  console.log("-> XRPUSDT short liquid:", xrpLiquid);

  console.log("\nChecking liquidity for BTCUSDT (Long position needs bids):");
  const btcLiquid = await checkAssetLiquidity('BTCUSDT', 'long');
  console.log("-> BTCUSDT long liquid:", btcLiquid);

  await mongoose.connection.close();
}

run().catch(console.error);
