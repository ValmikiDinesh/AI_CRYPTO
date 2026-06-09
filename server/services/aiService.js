import axios from 'axios';
import { logger } from '../utils/logger.js';

/**
 * AI Service to handle external LLM calls (Gemini/OpenAI) with structured batch predictions.
 */
export async function generateBatchPredictions(assetsData) {
  const groqKey = process.env.GROQ_API_KEY;
  const groqModel = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  // Support single or multiple comma-separated keys
  const geminiKeysRaw = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '';
  const geminiKeys = geminiKeysRaw.split(',').map(k => k.trim()).filter(Boolean);
  const openaiKey = process.env.OPENAI_API_KEY;

  logger.info(`AI Service: Loaded Groq API key: ${groqKey ? 'present' : 'absent'}, ${geminiKeys.length} Gemini key(s), OpenAI key: ${openaiKey ? 'present' : 'absent'}`);

  if (!groqKey && geminiKeys.length === 0 && !openaiKey) {
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

    // 1. Try Groq if key is present (Primary AI)
    if (groqKey) {
      try {
        logger.info(`AI Service: Querying Groq (${groqModel}) for chunk ${index + 1}/${chunks.length} (${chunk.length} assets)`);
        const response = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model: groqModel,
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
              'Authorization': `Bearer ${groqKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 30_000
          }
        );

        const resultText = response.data?.choices?.[0]?.message?.content;
        if (!resultText) throw new Error('Empty content returned from Groq API');

        const parsed = JSON.parse(resultText);
        if (parsed && Array.isArray(parsed.predictions)) {
          parsed.predictions.forEach(p => p.sourceModel = 'ai_groq');
          allPredictions = allPredictions.concat(parsed.predictions);
          chunkSuccess = true;
        } else {
          throw new Error('Response did not contain the "predictions" array matching schema');
        }
      } catch (err) {
        const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        logger.warn(`AI Service: Groq API call failed for chunk ${index + 1}: ${errorDetail}`);
      }
    }

    // 2. Try Gemini if Groq was absent or failed (Secondary AI / Fallback)
    if (!chunkSuccess && geminiKeys.length > 0) {
      const currentGeminiKey = geminiKeys[index % geminiKeys.length];
      const geminiModels = ['gemini-3.1-flash-lite'];
      
      for (const modelName of geminiModels) {
        try {
          logger.info(`AI Service: Querying Google Gemini (${modelName}) for chunk ${index + 1}/${chunks.length} (${chunk.length} assets)`);
          const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${currentGeminiKey}`,
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
            parsed.predictions.forEach(p => p.sourceModel = 'ai_gemini');
            allPredictions = allPredictions.concat(parsed.predictions);
            chunkSuccess = true;
            break; // Success! Break out of the models loop
          } else {
            throw new Error('Response did not contain the "predictions" array matching schema');
          }
        } catch (err) {
          const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
          logger.warn(`AI Service: Gemini API call failed for model ${modelName} on chunk ${index + 1}: ${errorDetail}`);
        }
      }
    }

    // 3. Try OpenAI if Groq & Gemini failed or were absent (Tertiary AI / Fallback)
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
          parsed.predictions.forEach(p => p.sourceModel = 'ai_openai');
          allPredictions = allPredictions.concat(parsed.predictions);
          chunkSuccess = true;
        } else {
          throw new Error('Response did not contain the "predictions" array matching schema');
        }
      } catch (err) {
        logger.warn(`AI Service: OpenAI API call failed for chunk ${index + 1}: ${err.message}`);
      }
    }

    if (!chunkSuccess) {
      logger.warn(`AI Service: All AI prediction models failed for chunk ${index + 1}. Falling back to local model for this chunk.`);
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
