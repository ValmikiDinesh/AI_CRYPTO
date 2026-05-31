import axios from 'axios';
import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';

/**
 * Sentiment Analysis Agent
 * - Fetches crypto news and social data.
 * - Scores sentiment (bullish/bearish/neutral).
 * - Uses simple keyword analysis as baseline; can be upgraded to LLM.
 */
export default class SentimentAgent extends BaseAgent {
  constructor() {
    super(AGENT_NAMES.SENTIMENT);
    this.sentimentCache = {};     // asset → latest sentiment
  }

  async execute() {
    try {
      // 1. Fetch latest general news articles once (e.g. 50 articles)
      const allArticles = await this.fetchGeneralNews();
      this.logger.debug(`Fetched ${allArticles.length} general articles for local filtering`);

      for (const asset of SUPPORTED_ASSETS) {
        try {
          const baseAsset = asset.replace('USDT', '').toLowerCase();

          // 2. Filter articles relevant to this specific asset locally
          const relevantArticles = this.filterArticlesForAsset(allArticles, baseAsset);
          
          // 3. Analyze sentiment locally
          const sentiment = this.analyzeSentiment(relevantArticles, baseAsset);

          const sentimentData = {
            asset,
            sentiment: sentiment.score,       // -1 to +1
            label: sentiment.label,           // bullish | bearish | neutral
            confidence: sentiment.confidence,
            sources: sentiment.sources,
            summary: sentiment.summary,
            articleCount: sentiment.articleCount,
          };

          this.sentimentCache[asset] = sentimentData;

          // Publish via Redis
          await publishEvent(CHANNELS.SENTIMENT_SIGNALS, sentimentData);

          this.logger.info(
            `${asset}: sentiment=${sentiment.label} (score=${sentiment.score.toFixed(2)}, confidence=${sentiment.confidence.toFixed(2)}, articles=${sentiment.articleCount})`
          );
        } catch (err) {
          this.logger.error(`Sentiment analysis for ${asset}: ${err.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`Sentiment agent execution error: ${err.message}`);
    }
  }

  async fetchGeneralNews() {
    try {
      const apiKey = process.env.CRYPTOCOMPARE_API_KEY;
      const headers = apiKey ? { Authorization: `Apikey ${apiKey}` } : {};
      // Fetch a larger pool of latest articles in a single call
      const url = 'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&limit=50';
      const response = await axios.get(url, { headers, timeout: 10_000 });
      return response.data?.Data || [];
    } catch (err) {
      this.logger.warn(`General news fetch failed: ${err.message}`);
      return [];
    }
  }

  filterArticlesForAsset(articles, baseAsset) {
    const searchTerms = [
      baseAsset,                            // e.g. "sol"
      this.getAssetNameFull(baseAsset),     // e.g. "solana"
    ].filter(Boolean);

    return articles.filter((article) => {
      const title = (article.title || '').toLowerCase();
      const body = (article.body || '').toLowerCase();
      
      // Parse categories and tags
      const categories = (article.categories || '').toLowerCase().split('|');
      const tags = (article.tags || '').toLowerCase().split('|');

      return searchTerms.some((term) => {
        // Match search term as a whole word to prevent substring leakage bugs (e.g., 'id' matching 'liquidity')
        const regex = new RegExp(`\\b${term}\\b`, 'i');
        return (
          regex.test(title) ||
          regex.test(body) ||
          categories.includes(term) ||
          tags.includes(term)
        );
      });
    });
  }

  getAssetNameFull(baseAsset) {
    const names = {
      btc: 'bitcoin',
      eth: 'ethereum',
      bnb: 'binance',
      sol: 'solana',
      xrp: 'ripple',
      doge: 'dogecoin',
      ada: 'cardano',
      link: 'chainlink',
      shib: 'shiba',
      pepe: 'pepe',
      wif: 'dogwifhat',
      floki: 'floki',
      bonk: 'bonk',
      avax: 'avalanche',
      dot: 'polkadot',
      pol: 'polygon',
      ltc: 'litecoin',
    };
    return names[baseAsset] || baseAsset;
  }

  analyzeSentiment(articles, baseAsset) {
    if (!articles.length) {
      return {
        score: 0,
        label: 'neutral',
        confidence: 0.3,
        sources: [],
        summary: 'No recent news available',
        articleCount: 0,
      };
    }

    // Keyword-based sentiment as baseline
    const bullishKeywords = [
      'bullish', 'surge', 'rally', 'breakout', 'moon', 'pump', 'buy',
      'adoption', 'partnership', 'upgrade', 'growth', 'institutional',
      'etf', 'approval', 'record high', 'ath', 'all-time high', 'gains',
    ];
    const bearishKeywords = [
      'bearish', 'crash', 'dump', 'selloff', 'sell-off', 'plunge', 'drop',
      'hack', 'ban', 'regulation', 'warning', 'fraud', 'scam', 'collapse',
      'fear', 'panic', 'liquidation', 'decline', 'risk',
    ];

    let totalScore = 0;
    const sources = [];

    for (const article of articles) {
      const text = `${article.title || ''} ${article.body || ''}`.toLowerCase();
      let articleScore = 0;

      for (const kw of bullishKeywords) {
        if (text.includes(kw)) articleScore += 1;
      }
      for (const kw of bearishKeywords) {
        if (text.includes(kw)) articleScore -= 1;
      }

      totalScore += articleScore;
      sources.push({
        title: article.title,
        source: article.source_info?.name || 'unknown',
        sentiment: articleScore > 0 ? 'bullish' : articleScore < 0 ? 'bearish' : 'neutral',
      });
    }

    const normalizedScore = Math.max(-1, Math.min(1, totalScore / (articles.length * 2)));
    const confidence = Math.min(0.9, 0.3 + articles.length * 0.03);

    let label = 'neutral';
    if (normalizedScore > 0.15) label = 'bullish';
    else if (normalizedScore < -0.15) label = 'bearish';

    return {
      score: normalizedScore,
      label,
      confidence,
      sources: sources.slice(0, 5),
      summary: `Analyzed ${articles.length} articles for ${baseAsset.toUpperCase()}: ${label} sentiment (score: ${normalizedScore.toFixed(2)})`,
      articleCount: articles.length,
    };
  }

  getSentiment(asset) {
    return this.sentimentCache[asset] || null;
  }
}
