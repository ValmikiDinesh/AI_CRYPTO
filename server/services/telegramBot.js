import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../utils/logger.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import { publishEvent, CHANNELS } from '../config/redis.js';

let bot = null;

export const initializeTelegramBot = async () => {
  let token = process.env.TELEGRAM_BOT_TOKEN;
  let chatIdsEnv = process.env.TELEGRAM_CHAT_ID;

  try {
    const { SYSTEM_USER_ID } = await import('../config/constants.js');
    const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID }) || await Portfolio.findOne({});
    if (portfolio && portfolio.telegramBotToken && portfolio.telegramChatId) {
      token = portfolio.telegramBotToken;
      chatIdsEnv = portfolio.telegramChatId;
    }
  } catch (err) {
    logger.warn('Failed to fetch Telegram credentials from DB for interactive bot');
  }

  if (!token || !chatIdsEnv) {
    logger.debug('Telegram bot credentials not configured — skipping interactive bot');
    return;
  }

  const allowedChatIds = chatIdsEnv.split(',').map((id) => id.trim()).filter(Boolean);

  try {
    bot = new TelegramBot(token, { polling: true });
    logger.info('Telegram Interactive Bot successfully started with polling.');
  } catch (err) {
    logger.error(`Failed to start Telegram Bot: ${err.message}`);
    return;
  }

  // Middleware to authorize users
  const isAuthorized = (chatId) => allowedChatIds.includes(chatId.toString());

  // Command: /status
  bot.onText(/^\/status/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    try {
      const portfolio = await Portfolio.findOne({ userId: 'system' }).lean();
      if (!portfolio) {
        return bot.sendMessage(chatId, '❌ No active portfolio found.');
      }
      
      const text = `📊 *System Status*\n\n` +
        `*Total Balance:* $${portfolio.totalBalance?.toFixed(2) || '0.00'}\n` +
        `*Available Margin:* $${portfolio.availableBalance?.toFixed(2) || '0.00'}\n` +
        `*Daily Net PnL:* $${portfolio.dailyLossToday?.toFixed(2) || '0.00'}\n` +
        `*Trading Paused:* ${portfolio.tradingPaused ? '🔴 YES' : '🟢 NO'}\n` +
        `*Max Daily Trades:* ${portfolio.maxDailyTrades || 'N/A'}`;
      
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, `⚠️ Error: ${err.message}`);
    }
  });

  // Command: /open
  bot.onText(/^\/open/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    try {
      const portfolio = await Portfolio.findOne({ userId: 'system' }).lean();
      if (!portfolio || !portfolio.positions || portfolio.positions.length === 0) {
        return bot.sendMessage(chatId, '📉 No open positions.');
      }

      const openPos = portfolio.positions.filter(p => p.status === 'open');
      if (openPos.length === 0) {
        return bot.sendMessage(chatId, '📉 No open positions.');
      }

      let text = `📂 *Open Positions (${openPos.length})*\n\n`;
      for (const pos of openPos) {
        text += `*${pos.asset}* (${pos.side.toUpperCase()})\n` +
          `Qty: ${pos.quantity} @ $${pos.entryPrice}\n` +
          `Highest PnL: $${pos.highestProfitMilestone?.toFixed(2) || '0.00'}\n\n`;
      }
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, `⚠️ Error: ${err.message}`);
    }
  });

  // Command: /performance
  bot.onText(/^\/performance/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    try {
      const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
      const startOfToday = new Date(`${todayStr}T00:00:00.000+05:30`);
      
      const trades = await Trade.find({
        createdAt: { $gte: startOfToday },
        status: 'closed'
      }).lean();

      let wins = 0;
      let losses = 0;
      let totalPnl = 0;

      for (const t of trades) {
        if (t.pnl > 0) wins++;
        else if (t.pnl < 0) losses++;
        totalPnl += (t.pnl || 0);
      }

      const winRate = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 0;

      const text = `🏆 *Performance Today (IST)*\n\n` +
        `*Trades Closed:* ${trades.length}\n` +
        `*Win Rate:* ${winRate}%\n` +
        `*Wins/Losses:* ${wins}W / ${losses}L\n` +
        `*Net PnL:* $${totalPnl.toFixed(2)}`;
      
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, `⚠️ Error: ${err.message}`);
    }
  });

  // Command: /pause
  bot.onText(/^\/pause/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    try {
      await Portfolio.updateOne({ userId: 'system' }, { $set: { tradingPaused: true } });
      bot.sendMessage(chatId, '🛑 *Trading Paused.*\nThe bot will stop taking new trades, but will continue to manage existing open positions.', { parse_mode: 'Markdown' });
      publishEvent(CHANNELS.PORTFOLIO_UPDATES, { tradingPaused: true });
    } catch (err) {
      bot.sendMessage(chatId, `⚠️ Error: ${err.message}`);
    }
  });

  // Command: /resume
  bot.onText(/^\/resume/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    try {
      await Portfolio.updateOne({ userId: 'system' }, { $set: { tradingPaused: false } });
      bot.sendMessage(chatId, '🟢 *Trading Resumed.*\nThe bot is now fully active.', { parse_mode: 'Markdown' });
      publishEvent(CHANNELS.PORTFOLIO_UPDATES, { tradingPaused: false });
    } catch (err) {
      bot.sendMessage(chatId, `⚠️ Error: ${err.message}`);
    }
  });

  // Command: /panic
  bot.onText(/^\/panic/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    try {
      // 1. Pause trading immediately
      await Portfolio.updateOne({ userId: 'system' }, { $set: { tradingPaused: true, isSquaringOff: true } });
      bot.sendMessage(chatId, '🚨 *PANIC INITIATED*\nSystem paused. Liquidating all open positions immediately!', { parse_mode: 'Markdown' });
      
      // 2. Fetch all open positions
      const portfolio = await Portfolio.findOne({ userId: 'system' }).lean();
      if (portfolio && portfolio.positions) {
        const openPos = portfolio.positions.filter(p => p.status === 'open');
        for (const pos of openPos) {
          await publishEvent(CHANNELS.EXIT_REQUESTS, {
            asset: pos.asset,
            side: pos.side,
            quantity: pos.quantity,
            currentPrice: pos.currentPrice || pos.entryPrice,
            forceMarket: true,
            reason: '🚨 MANUAL TELEGRAM PANIC'
          });
        }
      }
    } catch (err) {
      bot.sendMessage(chatId, `⚠️ Error: ${err.message}`);
    }
  });

  // Command: /setdaily
  bot.onText(/^\/setdaily (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    const newLimit = parseInt(match[1], 10);
    if (isNaN(newLimit) || newLimit < 0) {
      return bot.sendMessage(chatId, '❌ Invalid number.');
    }

    try {
      await Portfolio.updateOne({ userId: 'system' }, { $set: { maxDailyTrades: newLimit } });
      bot.sendMessage(chatId, `✅ *Max Daily Trades* updated to ${newLimit}.`, { parse_mode: 'Markdown' });
      publishEvent(CHANNELS.PORTFOLIO_UPDATES, { maxDailyTrades: newLimit });
    } catch (err) {
      bot.sendMessage(chatId, `⚠️ Error: ${err.message}`);
    }
  });
};
