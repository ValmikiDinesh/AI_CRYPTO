import cron from 'node-cron';
import Trade from '../models/Trade.js';
import { sendTelegramMessage } from './telegramService.js';
import { logger } from '../utils/logger.js';

/**
 * Generate and send the daily performance report to Telegram.
 * Runs independently of the AI agents.
 */
export const generateDailyReport = async () => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Fetch all closed trades in the last 24 hours
    const trades = await Trade.find({
      status: 'closed',
      updatedAt: { $gte: oneDayAgo }
    });

    if (trades.length === 0) {
      logger.info('Daily Report: No trades closed in the last 24 hours.');
      return;
    }

    let netPnl = 0;
    let wins = 0;
    let losses = 0;
    
    let sniperTrades = 0;
    let sniperPnl = 0;
    let sniperWins = 0;

    let hftTrades = 0;
    let hftPnl = 0;
    let hftWins = 0;

    let trailingStops = 0;
    let hardStops = 0;

    let bestTrade = null;
    let worstTrade = null;

    for (const t of trades) {
      // Calculate exact realized PnL minus fees
      const pnl = (t.realizedPnl || 0) - (t.fees || 0);
      netPnl += pnl;

      if (pnl > 0) wins++;
      else losses++;

      // Track Best/Worst
      if (!bestTrade || pnl > bestTrade.pnl) bestTrade = { asset: t.asset, pnl };
      if (!worstTrade || pnl < worstTrade.pnl) worstTrade = { asset: t.asset, pnl };

      const modelName = t.metadata?.model || 'unknown';
      if (modelName.includes('scalping')) {
        hftTrades++;
        hftPnl += pnl;
        if (pnl > 0) hftWins++;
      } else {
        sniperTrades++;
        sniperPnl += pnl;
        if (pnl > 0) sniperWins++;
      }

      // Stop type tracking
      const exitReason = (t.reason || '').toLowerCase();
      if (exitReason.includes('trailing')) {
        trailingStops++;
      } else if (exitReason.includes('stop loss') || exitReason.includes('stop-loss') || exitReason.includes('sl ')) {
        hardStops++;
      }
    }

    const winRate = ((wins / trades.length) * 100).toFixed(0);
    const sniperWinRate = sniperTrades > 0 ? ((sniperWins / sniperTrades) * 100).toFixed(0) : 0;
    const hftWinRate = hftTrades > 0 ? ((hftWins / hftTrades) * 100).toFixed(0) : 0;

    // Format Message
    let message = `📊 *DAILY PERFORMANCE REPORT* 📊\n`;
    message += `📅 Date: ${now.toLocaleDateString()} ${now.toLocaleTimeString()}\n\n`;

    message += `💰 *Net Daily PnL:* ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}\n`;
    message += `📈 *Win Rate:* ${winRate}% (${wins} Wins / ${losses} Losses)\n`;
    message += `🔄 *Total Trades:* ${trades.length}\n\n`;

    message += `🔥 *Strategy Breakdown:*\n`;
    message += `- *Trend Sniper:* ${sniperTrades} Trades (${sniperPnl >= 0 ? '+' : ''}$${sniperPnl.toFixed(2)} PnL, ${sniperWinRate}% Win Rate)\n`;
    message += `- *HFT Scalping:* ${hftTrades} Trades (${hftPnl >= 0 ? '+' : ''}$${hftPnl.toFixed(2)} PnL, ${hftWinRate}% Win Rate)\n\n`;

    message += `🛡️ *Risk Engine Stats:*\n`;
    message += `- *Trailing Stop Wins:* ${trailingStops} trades\n`;
    message += `- *Hard Stop Losses:* ${hardStops} trades\n`;
    
    if (bestTrade) {
      message += `- *Best Trade:* ${bestTrade.asset} (+${bestTrade.pnl > 0 ? '$' : ''}${Math.abs(bestTrade.pnl).toFixed(2)})\n`;
    }
    if (worstTrade) {
      message += `- *Worst Trade:* ${worstTrade.asset} (-${worstTrade.pnl < 0 ? '$' : ''}${Math.abs(worstTrade.pnl).toFixed(2)})\n`;
    }

    // Broadcast
    await sendTelegramMessage(message);
    logger.info('✅ Daily Performance Report generated and sent to Telegram.');
    
  } catch (error) {
    logger.error(`Error generating Daily Report: ${error.message}`);
  }
};

/**
 * Initializes the CRON job scheduler for the daily report.
 * Called once during server startup.
 */
export const initReportingCron = () => {
  // Run at 23:59 every day server-time
  cron.schedule('59 23 * * *', () => {
    logger.info('Triggering Daily Performance Report (CRON)...');
    generateDailyReport();
  });
  logger.info('✅ Scheduled Daily Performance Report CRON (23:59).');
};
