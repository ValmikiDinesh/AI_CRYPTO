import '../config/env.js';
import connectDB from '../config/db.js';
import mongoose from 'mongoose';
import VolatilityHistory from '../models/VolatilityHistory.js';
import { SUPPORTED_ASSETS } from '../config/constants.js';
import { fetchCandles } from '../services/exchangeService.js';
import { computeIndicators } from '../services/indicatorService.js';


async function run() {
  console.log('🚀 Connecting to MongoDB...');
  await connectDB();
  console.log('✅ Connected.');

  console.log(`📊 Bootstrapping 60 days of daily volatility history for ${SUPPORTED_ASSETS.length} assets...`);

  let successCount = 0;
  let errorCount = 0;

  for (const asset of SUPPORTED_ASSETS) {
    try {
      console.log(`🔄 Seeding volatility data for ${asset}...`);
      
      // 1. Fetch 60 daily candles from exchange (REST)
      const dailyCandles = await fetchCandles(asset, '1d', 60);
      if (!dailyCandles || dailyCandles.length === 0) {
        console.warn(`⚠️ No daily candle data returned for ${asset}`);
        continue;
      }

      // 2. Fetch 5m candles to calculate initial ATR baseline
      const raw5mCandles = await fetchCandles(asset, '5m', 100);
      let baselineAtr = 0;
      if (raw5mCandles && raw5mCandles.length >= 30) {
        const indicators = computeIndicators(raw5mCandles);
        baselineAtr = indicators && !indicators.error ? indicators.atr : 0;
      }

      const operations = [];

      for (const candle of dailyCandles) {
        const openTime = new Date(candle.openTime || candle.timestamp);
        const dayOfWeek = openTime.getDay(); // 0 = Sunday, 6 = Saturday

        const high = candle.high || candle.close || 0;
        const low = candle.low || candle.close || 0;
        const close = candle.close || 0;

        const range = high - low;
        const rangePct = close > 0 ? (range / close) * 100 : 0;

        operations.push({
          updateOne: {
            filter: { asset, date: openTime },
            update: {
              $set: {
                asset,
                date: openTime,
                dayOfWeek,
                highPrice: high,
                lowPrice: low,
                closePrice: close,
                dailyRange: range,
                dailyRangePct: rangePct,
                avgATR: baselineAtr, // seed with baseline ATR
                volume: candle.volume || 0,
              }
            },
            upsert: true
          }
        });
      }

      if (operations.length > 0) {
        await VolatilityHistory.bulkWrite(operations);
        console.log(`✅ Bulk wrote ${operations.length} volatility records for ${asset}`);
        successCount++;
      }

    } catch (err) {
      console.error(`❌ Error bootstrapping volatility history for ${asset}: ${err.message}`);
      errorCount++;
    }

    // Wait a brief moment to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n🎉 Volatility history bootstrap completed!`);
  console.log(`- Success: ${successCount}/${SUPPORTED_ASSETS.length} assets`);
  console.log(`- Errors: ${errorCount} assets`);

  console.log('🔌 Closing database connection...');
  await mongoose.connection.close();
  console.log('👋 Done.');
}

run().catch(console.error);
