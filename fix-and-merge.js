import dotenv from 'dotenv';
dotenv.config();
import connectDB from './server/config/db.js';
import Portfolio from './server/models/Portfolio.js';

async function run() {
  await connectDB();
  const allSystems = await Portfolio.find({ userId: 'system' });
  const old = await Portfolio.findOne({ userId: '000000000000000000000000' });
  
  if (allSystems.length === 0) {
    console.log("No system portfolios found!");
    process.exit(1);
  }

  // Keep the first one, delete the rest
  const mainSystem = allSystems[0];
  const toDelete = allSystems.slice(1).map(p => p._id);
  
  if (toDelete.length > 0) {
    await Portfolio.deleteMany({ _id: { $in: toDelete } });
    console.log(`Deleted ${toDelete.length} duplicate system portfolios.`);
  }

  // Restore settings from old 000000000000000000000000 profile if it exists
  if (old) {
    mainSystem.coinSwitchApiKey = old.coinSwitchApiKey || mainSystem.coinSwitchApiKey;
    mainSystem.coinSwitchApiSecret = old.coinSwitchApiSecret || mainSystem.coinSwitchApiSecret;
    mainSystem.activeStrategy = old.activeStrategy || mainSystem.activeStrategy;
    mainSystem.strategySettings = old.strategySettings || mainSystem.strategySettings;
    
    // Copy any other important settings that might have been lost
    mainSystem.telegramBotToken = old.telegramBotToken || mainSystem.telegramBotToken;
    mainSystem.telegramChatId = old.telegramChatId || mainSystem.telegramChatId;
    mainSystem.baseTradingCapital = old.baseTradingCapital || mainSystem.baseTradingCapital;
    mainSystem.sweepTargetProfitPct = old.sweepTargetProfitPct || mainSystem.sweepTargetProfitPct;
    
    await mainSystem.save();
    console.log(`Restored API keys and ${mainSystem.activeStrategy} strategy to main system profile.`);
  } else {
    console.log("Old 000000000000000000000000 profile not found, nothing to restore.");
  }
  
  process.exit(0);
}
run();
