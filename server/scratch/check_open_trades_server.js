import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Trade from '../models/Trade.js';

dotenv.config();

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB on Server.");

    const openTrades = await Trade.find({ status: 'open' });
    console.log(`\n--- OPEN TRADES (${openTrades.length}) ---`);
    openTrades.forEach(t => {
      const model = t.metadata?.sourceModel || 'none';
      const hasAiTargets = t.metadata?.usedAiTargets;
      const modelName = model === 'ai_groq' ? 'Groq AI' : model === 'ai_openai' ? 'OpenAI' : model.includes('ai_') ? 'Gemini' : 'Statistical';
      const strategy = hasAiTargets ? `${modelName} (AI-Decided Entry/SL/TP)` : `${modelName} (Regime pullback)`;
      
      console.log(`- Asset: ${t.asset}, Action: ${t.action}, Qty: ${t.quantity}, Entry: ${t.entryPrice}, Strategy: ${strategy}, CreatedAt: ${t.createdAt}`);
    });

  } catch (err) {
    console.error("Error:", err);
  } finally {
    await mongoose.disconnect();
  }
}

run();
