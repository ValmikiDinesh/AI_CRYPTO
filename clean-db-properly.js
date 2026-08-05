import dotenv from 'dotenv';
dotenv.config();
import connectDB from './server/config/db.js';
import mongoose from 'mongoose';
import Portfolio from './server/models/Portfolio.js';

async function run() {
  await connectDB();
  
  // 1. Save the best profile (the one with the API keys)
  const allPorts = await Portfolio.find({});
  const bestPort = allPorts.find(p => p.coinSwitchApiKey) || allPorts[0];
  
  const savedData = {
    userId: 'system',
    activeStrategy: bestPort.activeStrategy || 'hft_scalping',
    coinSwitchApiKey: bestPort.coinSwitchApiKey || '',
    coinSwitchApiSecret: bestPort.coinSwitchApiSecret || '',
    totalBalance: 30,
    availableBalance: 30,
    positions: [],
    tradingPaused: false,
    isSquaringOff: false
  };

  // 2. Delete ALL portfolios
  console.log('Deleting all portfolios...');
  await Portfolio.deleteMany({});
  
  // 3. Drop indexes to fix the broken unique index
  console.log('Dropping indexes...');
  try {
    await Portfolio.collection.dropIndexes();
  } catch (e) {
    console.log('No indexes to drop or error dropping:', e.message);
  }
  
  // 4. Create the ONE true system profile
  console.log('Creating one true system profile...');
  await Portfolio.create(savedData);
  
  // 5. Re-create the unique index!
  console.log('Re-creating unique index...');
  await Portfolio.syncIndexes();
  
  console.log('Done cleaning DB!');
  process.exit(0);
}

run();
