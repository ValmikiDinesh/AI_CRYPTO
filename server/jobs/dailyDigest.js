import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { sendTelegramMessage } from '../services/telegramService.js';
import Trade from '../models/Trade.js';
import Portfolio from '../models/Portfolio.js';
import { SYSTEM_USER_ID } from '../config/constants.js';

export const scheduleDailyDigest = () => {
  // Run at 00:00 IST (Indian Standard Time) every day
  cron.schedule('0 0 * * *', async () => {
    try {
      logger.info('Running Telegram Daily Digest Job (00:00 IST)');
      await generateAndSendDigest();
    } catch (error) {
      logger.error(`Daily Digest Job failed: ${error.message}`);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });
};

async function generateAndSendDigest() {
  const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID }) || await Portfolio.findOne({});
  if (!portfolio) {
    logger.warn('No portfolio found for daily digest');
    return;
  }

  // Calculate the start and end of the previous day in IST
  const now = new Date();
  
  // Calculate 24 hours ago
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // We find all closed trades in the last 24 hours
  const closedTrades = await Trade.find({
    status: 'closed',
    closedAt: { $gte: yesterday, $lte: now }
  }).lean();

  let dailyPnl = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let totalFees = 0;

  closedTrades.forEach(trade => {
    const pnl = trade.pnl || 0;
    const fees = trade.fees || 0;
    dailyPnl += (pnl - fees);
    totalFees += fees;
    if (pnl > 0) winningTrades++;
    else if (pnl < 0) losingTrades++;
  });

  const totalTrades = winningTrades + losingTrades;
  const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(2) : 0;
  const emoji = dailyPnl >= 0 ? '🟢' : '🔴';

  // Identify top performer
  let topPerformer = null;
  if (closedTrades.length > 0) {
    topPerformer = closedTrades.reduce((max, trade) => (trade.pnl > max.pnl ? trade : max), closedTrades[0]);
  }

  const htmlMessage = `
📊 <b>CryptoAI Daily Performance Digest</b>
<i>Generated at 00:00 IST</i>

<b>Overview (Last 24h)</b>
${emoji} <b>Net PnL:</b> $${dailyPnl.toFixed(2)}
📈 <b>Win Rate:</b> ${winRate}%
🔄 <b>Trades Executed:</b> ${totalTrades} (${winningTrades} W / ${losingTrades} L)
📉 <b>Total Fees Paid:</b> $${totalFees.toFixed(2)}

<b>Top Performer:</b>
${topPerformer ? `💎 ${topPerformer.asset} (${topPerformer.side.toUpperCase()}) -> +$${topPerformer.pnl.toFixed(2)}` : 'None'}

<b>Account Status:</b>
💰 <b>Current Balance:</b> $${(portfolio.totalBalance || 0).toFixed(2)}
💸 <b>Available Margin:</b> $${(portfolio.availableBalance || 0).toFixed(2)}

<i>Note: The daily maximum drawdown tracker has been reset for the new trading session.</i>
`;

  await sendTelegramMessage(htmlMessage);
  
  // Reset daily drawdown
  if (portfolio) {
    portfolio.dailyPnl = 0;
    // We could reset peak balance here if we strictly track daily peaks
    portfolio.lastDailyDigestDate = now.toISOString();
    await portfolio.save();
    logger.info('Daily drawdown trackers reset.');
  }
}
