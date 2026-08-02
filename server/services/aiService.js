import axios from 'axios';
import { logger } from '../utils/logger.js';

/**
 * AI Service to handle external LLM calls (Gemini/OpenAI) with structured batch predictions.
 */
export async function generateBatchPredictions(assetsData, portfolioConfig = null) {
  // Determine API Keys from portfolio config OR fallback to env
  const keys = {
    gemini: portfolioConfig?.aiApiKeys?.gemini?.length > 0 ? portfolioConfig.aiApiKeys.gemini : (process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),
    groq: portfolioConfig?.aiApiKeys?.groq?.length > 0 ? portfolioConfig.aiApiKeys.groq : [process.env.GROQ_API_KEY].filter(Boolean),
    openai: portfolioConfig?.aiApiKeys?.openai?.length > 0 ? portfolioConfig.aiApiKeys.openai : [process.env.OPENAI_API_KEY].filter(Boolean),
  };

  const groqModel = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  
  // Determine sequence from portfolio config OR fallback to default
  const sequence = portfolioConfig?.aiLlmSequence?.length > 0 ? portfolioConfig.aiLlmSequence : ['groq', 'gemini', 'openai'];

  logger.info(`AI Service Gateway: Sequence [${sequence.join(' -> ')}]. Keys: Gemini(${keys.gemini.length}), Groq(${keys.groq.length}), OpenAI(${keys.openai.length})`);

  if (keys.groq.length === 0 && keys.gemini.length === 0 && keys.openai.length === 0) {
    logger.debug('AI Service: No LLM keys found. Falling back to local model.');
    return null;
  }

  // Chunk the assets into batches
  const CHUNK_SIZE = Math.ceil(assetsData.length / 3);
  const chunks = [];
  for (let i = 0; i < assetsData.length; i += CHUNK_SIZE) {
    chunks.push(assetsData.slice(i, i + CHUNK_SIZE));
  }

  let allPredictions = [];

  // Process chunks sequentially
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const promptText = buildPrompt(chunk);
    let chunkSuccess = false;

    // Execute the Fallback Sequence defined by the user
    for (const provider of sequence) {
      if (chunkSuccess) break;

      const providerKeys = keys[provider] || [];
      if (providerKeys.length === 0) continue; // Skip if no keys for this provider
      
      // Load balance: Rotate key based on chunk index
      const activeKey = providerKeys[index % providerKeys.length];

      try {
        if (provider === 'groq') {
          logger.info(`AI Gateway: Querying Groq (${groqModel}) for chunk ${index + 1}/${chunks.length}`);
          const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
              model: groqModel,
              messages: [
                { role: 'system', content: 'You are an advanced quantitative cryptocurrency trading assistant. Analyze the provided market data and return predictions in the requested JSON structure.' },
                { role: 'user', content: promptText }
              ],
              response_format: { type: 'json_object' }
            },
            { headers: { 'Authorization': `Bearer ${activeKey}`, 'Content-Type': 'application/json' }, timeout: 30_000 }
          );

          const resultText = response.data?.choices?.[0]?.message?.content;
          const parsed = JSON.parse(resultText);
          if (parsed && Array.isArray(parsed.predictions)) {
            parsed.predictions.forEach(p => p.sourceModel = 'ai_groq');
            allPredictions = allPredictions.concat(parsed.predictions);
            chunkSuccess = true;
          }

        } else if (provider === 'gemini') {
          const modelName = 'gemini-3.1-flash-lite';
          logger.info(`AI Gateway: Querying Google Gemini (${modelName}) for chunk ${index + 1}/${chunks.length}`);
          const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${activeKey}`,
            {
              contents: [{ parts: [{ text: promptText }] }],
              generationConfig: { responseMimeType: 'application/json' }
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 30_000 }
          );

          const resultText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
          const parsed = JSON.parse(resultText);
          if (parsed && Array.isArray(parsed.predictions)) {
            parsed.predictions.forEach(p => p.sourceModel = 'ai_gemini');
            allPredictions = allPredictions.concat(parsed.predictions);
            chunkSuccess = true;
          }

        } else if (provider === 'openai') {
          logger.info(`AI Gateway: Querying OpenAI (gpt-4o-mini) for chunk ${index + 1}/${chunks.length}`);
          const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
              model: 'gpt-4o-mini',
              messages: [
                { role: 'system', content: 'You are an advanced quantitative cryptocurrency trading assistant. Analyze the provided market data and return predictions in the requested JSON structure.' },
                { role: 'user', content: promptText }
              ],
              response_format: { type: 'json_object' }
            },
            { headers: { 'Authorization': `Bearer ${activeKey}`, 'Content-Type': 'application/json' }, timeout: 30_000 }
          );

          const resultText = response.data?.choices?.[0]?.message?.content;
          const parsed = JSON.parse(resultText);
          if (parsed && Array.isArray(parsed.predictions)) {
            parsed.predictions.forEach(p => p.sourceModel = 'ai_openai');
            allPredictions = allPredictions.concat(parsed.predictions);
            chunkSuccess = true;
          }
        }
      } catch (err) {
        const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        logger.warn(`AI Gateway: ${provider.toUpperCase()} API call failed for chunk ${index + 1}: ${errorDetail}. Falling back to next provider.`);
      }
    }

    if (!chunkSuccess) {
      logger.warn(`AI Gateway: ALL configured LLMs failed for chunk ${index + 1}. Safely delegating chunk to Local Math Model.`);
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

For each asset, output: direction ('up', 'down', or 'hold'), confidence probability (0.0 to 1.0), reasoning, and recommended 'limitEntryPrice', 'takeProfit', and 'stopLoss' prices. 
The recommended price targets must be highly realistic:
- For 'up' (BUY) direction: 'limitEntryPrice' must be at a discount (strictly less than currentPrice), 'takeProfit' must be higher than limitEntryPrice, and 'stopLoss' must be lower than limitEntryPrice.
- For 'down' (SELL) direction: 'limitEntryPrice' must be at a premium (strictly greater than currentPrice), 'takeProfit' must be lower than limitEntryPrice, and 'stopLoss' must be higher than limitEntryPrice.
- For 'hold' (NEUTRAL) direction: set limitEntryPrice, takeProfit, and stopLoss to the currentPrice.
- Base your targets on technical indicators like Bollinger Bands boundaries, EMA levels, and ATR (volatility index).

Return EXACTLY a JSON object with a "predictions" property containing an array of objects structured exactly as shown below:
{
  "predictions": [
    {
      "asset": "BTCUSDT",
      "direction": "up",
      "probability": 0.85,
      "limitEntryPrice": 67800.00,
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
