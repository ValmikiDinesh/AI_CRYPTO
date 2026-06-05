import '../config/env.js';
import PredictionAgent from '../agents/prediction/index.js';
import FusionAgent from '../agents/fusion/index.js';
import { ACTIONS, RISK } from '../config/constants.js';

// Setup mock dependencies
const mockMarketAgent = {
  getCandles: (asset) => {
    // Generate 30 mock candles
    const candles = [];
    let basePrice = 100;
    for (let i = 0; i < 30; i++) {
      basePrice += (Math.random() - 0.48) * 2; // slight uptrend
      candles.push({
        open: basePrice - 0.5,
        high: basePrice + 1.0,
        low: basePrice - 1.0,
        close: basePrice,
        volume: 1000 + Math.random() * 500
      });
    }
    return candles;
  },
  getPrice: (asset) => 100
};

const mockSentimentAgent = {
  getSentiment: (asset) => ({
    label: 'bullish',
    sentiment: 0.45,
    summary: 'Mock bullish market news for testing.'
  })
};

const mockTechnicalAgent = {
  getLastSignal: (asset) => ({
    action: 'BUY',
    confidence: 0.65,
    indicators: {
      rsi: 58,
      macd: { value: 0.1, signal: 0.05, histogram: 0.05 },
      ema: { ema9: 101, ema21: 100, ema50: 98 },
      bollingerBands: { upper: 103, middle: 100, lower: 97 },
      atr: 2.0,
      volume: { current: 1200, average: 1000, ratio: 1.2 },
      momentum: { priceChange1h: 1.1, priceChange4h: 3.2 },
      regime: 'trending_up'
    }
  })
};

async function runTest() {
  console.log('--- STARTING UPGRADED PREDICTIONS TEST ---');

  const predictionAgent = new PredictionAgent(mockMarketAgent, mockSentimentAgent, mockTechnicalAgent);
  const fusionAgent = new FusionAgent(mockTechnicalAgent, mockSentimentAgent, predictionAgent, mockMarketAgent);

  const asset = 'BTCUSDT';
  const candles = mockMarketAgent.getCandles(asset);

  // Temporarily set MIN_CONFIDENCE_THRESHOLD low for testing BUY action
  RISK.MIN_CONFIDENCE_THRESHOLD = 0.30;
  
  console.log('\n1. Testing Local Fallback Prediction (trending_up regime):');
  const indicatorsTrendUp = mockTechnicalAgent.getLastSignal(asset).indicators;
  const predTrendUp = predictionAgent.predictLocalFallback(asset, candles, indicatorsTrendUp);
  console.log('Result:', JSON.stringify(predTrendUp, null, 2));

  console.log('\n2. Testing Local Fallback Prediction (ranging regime with oversold RSI):');
  const indicatorsRangingOversold = {
    regime: 'ranging',
    rsi: 28,
    volume: { ratio: 0.8 },
    currentPrice: 100,
    atr: 1.5
  };
  const predRangingOversold = predictionAgent.predictLocalFallback(asset, candles, indicatorsRangingOversold);
  console.log('Result:', JSON.stringify(predRangingOversold, null, 2));

  console.log('\n3. Testing Local Fallback Prediction (ranging regime with overbought RSI):');
  const indicatorsRangingOverbought = {
    regime: 'ranging',
    rsi: 72,
    volume: { ratio: 0.9 },
    currentPrice: 100,
    atr: 1.5
  };
  const predRangingOverbought = predictionAgent.predictLocalFallback(asset, candles, indicatorsRangingOverbought);
  console.log('Result:', JSON.stringify(predRangingOverbought, null, 2));

  console.log('\n4. Testing Fusion Agent target calculation with fallbacks (volatile regime):');
  const mockVolatileTechnical = {
    action: 'BUY',
    confidence: 0.70,
    indicators: { regime: 'volatile', atr: 3.0 }
  };
  // Test with no AI predictions
  const fusedSignalVolatile = fusionAgent.fuseSignals(asset, 100, mockVolatileTechnical, mockSentimentAgent.getSentiment(asset), null);
  console.log('Volatile Regime TP/SL (Expected multiplier: SL=4.5x, TP=9.0x):');
  console.log(`Action: ${fusedSignalVolatile.action} | Entry: 100 | SL: ${fusedSignalVolatile.stopLoss} | TP: ${fusedSignalVolatile.takeProfit}`);

  console.log('\n5. Testing Fusion Agent target calculation (ranging regime):');
  const mockRangingTechnical = {
    action: 'BUY',
    confidence: 0.62,
    indicators: { regime: 'ranging', atr: 2.0 }
  };
  const fusedSignalRanging = fusionAgent.fuseSignals(asset, 100, mockRangingTechnical, mockSentimentAgent.getSentiment(asset), null);
  console.log('Ranging Regime TP/SL (Expected multiplier: SL=2.0x, TP=4.0x):');
  console.log(`Action: ${fusedSignalRanging.action} | Entry: 100 | SL: ${fusedSignalRanging.stopLoss} | TP: ${fusedSignalRanging.takeProfit}`);

  console.log('\n6. Testing Fusion Agent using valid AI Recommended Targets:');
  const mockAiPrediction = {
    model: 'ai_gemini',
    direction: 'up',
    probability: 0.82,
    metadata: {
      takeProfit: 115.50,
      stopLoss: 92.20,
      reasoning: 'AI expects breakout above major resistance level.'
    }
  };
  const fusedSignalWithAi = fusionAgent.fuseSignals(asset, 100, mockRangingTechnical, mockSentimentAgent.getSentiment(asset), mockAiPrediction);
  console.log('Fused Signal with AI Targets (Expected SL=92.20, TP=115.50):');
  console.log(`Action: ${fusedSignalWithAi.action} | SL: ${fusedSignalWithAi.stopLoss} | TP: ${fusedSignalWithAi.takeProfit}`);
  console.log(`Reasoning: ${fusedSignalWithAi.reasoning}`);

  console.log('\n7. Testing Fusion Agent with logical failure in AI Targets (e.g., BUY with SL > Entry):');
  const mockBadAiPrediction = {
    model: 'ai_gemini',
    direction: 'up',
    probability: 0.82,
    metadata: {
      takeProfit: 95.00, // lower than current price for BUY
      stopLoss: 105.00,  // higher than current price for BUY
      reasoning: 'Bad targets'
    }
  };
  const fusedSignalBadAi = fusionAgent.fuseSignals(asset, 100, mockRangingTechnical, mockSentimentAgent.getSentiment(asset), mockBadAiPrediction);
  console.log('Fused Signal with Bad AI Targets (Expected fallback to Ranging multiplier: SL=96, TP=108):');
  console.log(`Action: ${fusedSignalBadAi.action} | SL: ${fusedSignalBadAi.stopLoss} | TP: ${fusedSignalBadAi.takeProfit}`);

  console.log('\n--- TESTS COMPLETED ---');
}

runTest().catch(console.error);
