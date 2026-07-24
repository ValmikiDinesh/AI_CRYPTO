import express from 'express';
import MarketData from '../models/MarketData.js';
import { SUPPORTED_ASSETS, CORE_ASSETS, MEME_ASSETS, RECOMMENDED_ASSETS } from '../config/constants.js';

const router = express.Router();

let marketAgentRef = null;

export const setMarketAgentRef = (agent) => {
  marketAgentRef = agent;
};

// GET /api/market/prices — current prices for all assets
router.get('/prices', (req, res) => {
  const prices = {};
  for (const asset of SUPPORTED_ASSETS) {
    prices[asset] = marketAgentRef?.getPrice(asset) || 0;
  }
  res.json({ success: true, data: prices });
});

// GET /api/market/candles/:asset — recent candle data
router.get('/candles/:asset', async (req, res, next) => {
  try {
    const { asset } = req.params;
    const { limit = 100 } = req.query;

    // Try in-memory first
    if (marketAgentRef) {
      const candles = marketAgentRef.getCandles(asset);
      if (candles?.length) {
        return res.json({ success: true, data: candles.slice(-parseInt(limit)) });
      }
    }

    // Fallback to MongoDB
    const candles = await MarketData.find({ asset })
      .sort({ openTime: -1 })
      .limit(parseInt(limit));

    res.json({ success: true, data: candles.reverse() });
  } catch (err) {
    next(err);
  }
});

// GET /api/market/assets — list of supported assets
router.get('/assets', (req, res) => {
  res.json({ success: true, data: SUPPORTED_ASSETS });
});

// GET /api/market/asset-categories — asset lists by category
router.get('/asset-categories', (req, res) => {
  res.json({
    success: true,
    data: {
      core: CORE_ASSETS,
      meme: MEME_ASSETS,
      recommended: RECOMMENDED_ASSETS,
      all: SUPPORTED_ASSETS
    }
  });
});

export default router;
