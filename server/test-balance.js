import mongoose from 'mongoose';
import { config } from 'dotenv';
import Portfolio from './models/Portfolio.js';
import { fetchBalance, getExchange } from './services/exchangeService.js';

config({ path: './.env' });

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");
  
  const port = await Portfolio.findOne({ userId: 'system' });
  console.log("CoinSwitch API Key:", port?.coinSwitchApiKey ? "Set" : "Not Set");
  console.log("CoinSwitch API Secret:", port?.coinSwitchApiSecret ? "Set" : "Not Set");
  
  try {
    const bal = await fetchBalance(true);
    console.log("Fetch Balance Result:", JSON.stringify(bal));
  } catch (e) {
    console.error("Error fetching balance:", e);
  }
  process.exit(0);
}
run();
