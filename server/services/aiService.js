import axios from 'axios';
import { logger } from '../utils/logger.js';

/**
 * AI Service to handle external LLM calls (Gemini/OpenAI) with structured batch predictions.
 */
export async function generateBatchPredictions(assetsData) {
  // Support single or multiple comma-separated keys
  const geminiKeysRaw = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '';
  const geminiKeys = geminiKeysRaw.split(',').map(k => k.trim()).filter(Boolean);
  const openaiKey = process.env.OPENAI_API_KEY;

  logger.info(`AI Service: Loaded ${geminiKeys.length} Gemini API key(s) from .env: ${geminiKeys.map(k => k.substring(0, 6) + '...').join(', ')}`);

  if (geminiKeys.length === 0 && !openaiKey) {
    logger.debug('AI Service: No LLM keys found. Falling back to local model.');
    return null;
  }

  // Chunk the assets into exactly 3 batches to spread load across the 3 Gemini API keys
  const totalChunks = 3;
  const CHUNK_SIZE = Math.ceil(assetsData.length / totalChunks);
  const chunks = [];
  for (let i = 0; i < assetsData.length; i += CHUNK_SIZE) {
    chunks.push(assetsData.slice(i, i + CHUNK_SIZE));
  }

  let allPredictions = [];

  // Process chunks sequentially to respect API rate limits
  for (const [index, chunk] of chunks.entries()) {
    // Add a 2-second delay between chunks to prevent burst rate limits (429)
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const promptText = buildPrompt(chunk);
    let chunkSuccess = false;
    
    // Pick the next Gemini key in a round-robin fashion
    const currentGeminiKey = geminiKeys.length > 0 ? geminiKeys[index % geminiKeys.length] : null;

    // 1. Try Gemini if key is present
    if (currentGeminiKey) {
      try {
        logger.info(`AI Service: Querying Google Gemini (gemini-2.5-flash) for chunk ${index + 1}/${chunks.length} (${chunk.length} assets)`);
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${currentGeminiKey}`,
          {
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: { responseMimeType: 'application/json' }
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 30_000 }
        );

        const resultText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!resultText) throw new Error('Empty content returned from Gemini API');

        const parsed = JSON.parse(resultText);
        if (parsed && Array.isArray(parsed.predictions)) {
          allPredictions = allPredictions.concat(parsed.predictions);
          chunkSuccess = true;
        } else {
          throw new Error('Response did not contain the "predictions" array matching schema');
        }
      } catch (err) {
        const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        logger.warn(`AI Service: Gemini API call failed for chunk ${index + 1}: ${errorDetail}. ${openaiKey ? 'Attempting OpenAI fallback...' : 'Falling back to local model for this chunk.'}`);
      }
    }

    // 2. Try OpenAI if Gemini key was missing or request failed
    if (!chunkSuccess && openaiKey) {
      try {
        logger.info(`AI Service: Querying OpenAI (gpt-4o-mini) for chunk ${index + 1}/${chunks.length} (${chunk.length} assets)`);
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: 'You are an advanced quantitative cryptocurrency trading assistant. Analyze the provided market data and return predictions in the requested JSON structure.'
              },
              { role: 'user', content: promptText }
            ],
            response_format: { type: 'json_object' }
          },
          {
            headers: {
              'Authorization': `Bearer ${openaiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 30_000
          }
        );

        const resultText = response.data?.choices?.[0]?.message?.content;
        if (!resultText) throw new Error('Empty content returned from OpenAI API');

        const parsed = JSON.parse(resultText);
        if (parsed && Array.isArray(parsed.predictions)) {
          allPredictions = allPredictions.concat(parsed.predictions);
          chunkSuccess = true;
        } else {
          throw new Error('Response did not contain the "predictions" array matching schema');
        }
      } catch (err) {
        logger.warn(`AI Service: OpenAI API call failed for chunk ${index + 1}: ${err.message}. Falling back to local model for this chunk.`);
      }
    }
  }

  // Return all successfully fetched predictions.
  // Missing predictions will gracefully trigger the local fallback in PredictionAgent.
  return allPredictions.length > 0 ? allPredictions : null;
}

/**
 * Builds a highly detailed prompt containing all technical and sentiment data for a batch of assets.
 */
function buildPrompt(assetsData) {
  let assetsSummary = assetsData.map(data => {
    const ind = data.indicators || {};
    const sent = data.sentiment || {};
    
    // Technical summaries (compressed representation)
    const rsiStr = ind.rsi ? ind.rsi.toFixed(1) : 'N/A';
    const macdStr = ind.macd ? `${ind.macd.value?.toFixed(5) || '0'}/${ind.macd.signal?.toFixed(5) || '0'}/${ind.macd.histogram?.toFixed(5) || '0'}` : 'N/A';
    const emaStr = ind.ema ? `9:${ind.ema.ema9?.toFixed(2) || '0'},21:${ind.ema.ema21?.toFixed(2) || '0'},50:${ind.ema.ema50?.toFixed(2) || '0'}` : 'N/A';
    const bbStr = ind.bollingerBands ? `U:${ind.bollingerBands.upper?.toFixed(2) || '0'},M:${ind.bollingerBands.middle?.toFixed(2) || '0'},L:${ind.bollingerBands.lower?.toFixed(2) || '0'}` : 'N/A';
    const atrStr = ind.atr ? ind.atr.toFixed(4) : 'N/A';
    const volRatio = ind.volume?.ratio ? ind.volume.ratio.toFixed(2) : '1.0';
    const momStr = ind.momentum ? `1h:${ind.momentum.priceChange1h?.toFixed(1) || '0'}%,4h:${ind.momentum.priceChange4h?.toFixed(1) || '0'}%` : 'N/A';
    const regime = ind.regime || 'ranging';

    // Sentiment summaries (compressed representation)
    const sentLabel = sent.label || 'neutral';
    const sentScore = sent.sentiment !== undefined ? sent.sentiment.toFixed(2) : '0.00';
    const sentSummary = sent.summary ? sent.summary.substring(0, 80).replace(/\n/g, ' ') : 'No recent news';

    return `${data.asset} | Price: $${data.currentPrice} | Regime: ${regime} | RSI: ${rsiStr} | MACD: ${macdStr} | EMA: ${emaStr} | BB: ${bbStr} | ATR: ${atrStr} | VolRatio: ${volRatio} | Mom: ${momStr} | Sent: ${sentLabel}(${sentScore}) - ${sentSummary}`;
  }).join('\n');

  return `You are an expert quantitative cryptocurrency trading agent. Analyze the following real-time technical and news sentiment summaries, then provide predictions for EVERY asset.

To make the response extremely fast and save generation time:
- Keep the "reasoning" string very short, under 15 words.
- You must output exactly one prediction object for EVERY asset in the provided list.
- For neutral setups, output direction 'hold'.

For each asset, output: direction ('up', 'down', or 'hold'), confidence probability (0.0 to 1.0), reasoning, and recommended 'takeProfit' and 'stopLoss' prices. 
The recommended price targets must be highly realistic:
- For 'up' (BUY) direction: 'takeProfit' must be higher than currentPrice, and 'stopLoss' must be lower than currentPrice.
- For 'down' (SELL) direction: 'takeProfit' must be lower than currentPrice, and 'stopLoss' must be higher than currentPrice.
- For 'hold' (NEUTRAL) direction: set takeProfit and stopLoss to the currentPrice.
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
      "reasoning": "EMA crossover and positive news sentiment."
    }
  ]
}

Data to analyze:
${assetsSummary}
`;
}

export default { generateBatchPredictions };
