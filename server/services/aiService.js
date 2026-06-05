import axios from 'axios';
import { logger } from '../utils/logger.js';

/**
 * AI Service to handle external LLM calls (Gemini/OpenAI) with structured batch predictions.
 */
export async function generateBatchPredictions(assetsData) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!geminiKey && !openaiKey) {
    logger.debug('AI Service: No LLM keys (GEMINI_API_KEY or OPENAI_API_KEY) found. Falling back to local model.');
    return null;
  }

  const promptText = buildPrompt(assetsData);

  // 1. Try Gemini if key is present
  if (geminiKey) {
    try {
      logger.info(`AI Service: Querying Google Gemini (gemini-1.5-flash) for batch of ${assetsData.length} assets`);
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
        {
          contents: [
            {
              parts: [
                {
                  text: promptText
                }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: 'application/json'
          }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15_000 // 15s timeout
        }
      );

      const resultText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!resultText) {
        throw new Error('Empty content returned from Gemini API');
      }

      const parsed = JSON.parse(resultText);
      if (parsed && Array.isArray(parsed.predictions)) {
        return parsed.predictions;
      } else {
        throw new Error('Response did not contain the "predictions" array matching schema');
      }
    } catch (err) {
      logger.warn(`AI Service: Gemini API call failed: ${err.message}. ${openaiKey ? 'Attempting OpenAI fallback...' : 'Falling back to local statistical model.'}`);
    }
  }

  // 2. Try OpenAI if Gemini key was missing or request failed
  if (openaiKey) {
    try {
      logger.info(`AI Service: Querying OpenAI (gpt-4o-mini) for batch of ${assetsData.length} assets`);
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You are an advanced quantitative cryptocurrency trading assistant. Analyze the provided market data and return predictions in the requested JSON structure.'
            },
            {
              role: 'user',
              content: promptText
            }
          ],
          response_format: { type: 'json_object' }
        },
        {
          headers: {
            'Authorization': `Bearer ${openaiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 15_000 // 15s timeout
        }
      );

      const resultText = response.data?.choices?.[0]?.message?.content;
      if (!resultText) {
        throw new Error('Empty content returned from OpenAI API');
      }

      const parsed = JSON.parse(resultText);
      if (parsed && Array.isArray(parsed.predictions)) {
        return parsed.predictions;
      } else {
        throw new Error('Response did not contain the "predictions" array matching schema');
      }
    } catch (err) {
      logger.warn(`AI Service: OpenAI API call failed: ${err.message}. Falling back to local statistical model.`);
    }
  }

  return null;
}

/**
 * Builds a highly detailed prompt containing all technical and sentiment data for a batch of assets.
 */
function buildPrompt(assetsData) {
  let assetsSummary = assetsData.map(data => {
    const ind = data.indicators || {};
    const sent = data.sentiment || {};
    
    // Technical summaries
    const rsiStr = ind.rsi ? ind.rsi.toFixed(2) : 'N/A';
    const macdStr = ind.macd ? `Value: ${ind.macd.value?.toFixed(6) || '0'}, Signal: ${ind.macd.signal?.toFixed(6) || '0'}, Hist: ${ind.macd.histogram?.toFixed(6) || '0'}` : 'N/A';
    const emaStr = ind.ema ? `EMA9: ${ind.ema.ema9?.toFixed(6) || '0'}, EMA21: ${ind.ema.ema21?.toFixed(6) || '0'}, EMA50: ${ind.ema.ema50?.toFixed(6) || '0'}` : 'N/A';
    const bbStr = ind.bollingerBands ? `Upper: ${ind.bollingerBands.upper?.toFixed(6) || '0'}, Middle: ${ind.bollingerBands.middle?.toFixed(6) || '0'}, Lower: ${ind.bollingerBands.lower?.toFixed(6) || '0'}` : 'N/A';
    const atrStr = ind.atr ? ind.atr.toFixed(6) : 'N/A';
    const volumeStr = ind.volume ? `Current: ${ind.volume.current?.toFixed(1) || '0'}, Avg: ${ind.volume.average?.toFixed(1) || '0'}, Ratio: ${ind.volume.ratio?.toFixed(2) || '1'}` : 'N/A';
    const momStr = ind.momentum ? `1h: ${ind.momentum.priceChange1h?.toFixed(2) || '0'}%, 4h: ${ind.momentum.priceChange4h?.toFixed(2) || '0'}%` : 'N/A';
    const regime = ind.regime || 'ranging';

    // Sentiment summaries
    const sentimentLabel = sent.label || 'neutral';
    const sentimentScore = sent.sentiment !== undefined ? sent.sentiment.toFixed(2) : '0.00';
    const sentimentSummary = sent.summary || 'No recent news news details';
    const articles = Array.isArray(sent.sources) 
      ? sent.sources.slice(0, 3).map(s => `- [${s.sentiment}] ${s.title} (Source: ${s.source})`).join('\n')
      : 'No source articles available.';

    return `
### Asset: ${data.asset}
- **Current Price**: $${data.currentPrice}
- **Technical Indicators**:
  - Regime: ${regime}
  - RSI (14): ${rsiStr}
  - MACD (12, 26, 9): ${macdStr}
  - EMAs: ${emaStr}
  - Bollinger Bands: ${bbStr}
  - ATR (14): ${atrStr}
  - Volume details: ${volumeStr}
  - Price Momentum: ${momStr}
- **News Sentiment Details**:
  - Label: ${sentimentLabel} (Score: ${sentimentScore})
  - Summary: ${sentimentSummary}
  - Latest Headlines:
${articles}
`;
  }).join('\n---\n');

  return `You are an expert quantitative cryptocurrency trading agent. Analyze the following real-time technical and news sentiment data for a batch of assets, then provide buying/selling predictions.

For each asset, determine the market direction ('up', 'down', 'neutral'), confidence probability (between 0.0 and 1.0), reasoning, and recommended 'takeProfit' and 'stopLoss' prices. 
The recommended price targets must be highly realistic:
- For 'up' (BUY) direction: 'takeProfit' must be higher than currentPrice, and 'stopLoss' must be lower than currentPrice.
- For 'down' (SELL) direction: 'takeProfit' must be lower than currentPrice, and 'stopLoss' must be higher than currentPrice.
- For 'neutral' (HOLD) direction: 'takeProfit' and 'stopLoss' can be null.
- Base your targets on technical indicators like Bollinger Bands boundaries, ATR (volatility index), and support/resistance lines.

Return EXACTLY a JSON object with a "predictions" property containing an array of objects structured exactly as shown below:
{
  "predictions": [
    {
      "asset": "BTCUSDT",
      "direction": "up",
      "probability": 0.85,
      "takeProfit": 69200.00,
      "stopLoss": 66500.00,
      "reasoning": "Asset is in a strong uptrend regime with high volume confirmation and supportive news headlines."
    }
  ]
}

Data to analyze:
${assetsSummary}
`;
}

export default { generateBatchPredictions };
