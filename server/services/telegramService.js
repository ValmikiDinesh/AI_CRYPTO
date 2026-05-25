import axios from 'axios';
import { logger } from '../utils/logger.js';

/**
 * Format price values nicely for notification layout.
 */
export const formatPrice = (priceVal) => {
  if (priceVal === undefined || priceVal === null) return '—';
  return priceVal >= 1 
    ? priceVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : priceVal.toFixed(6);
};

/**
 * Sends a HTML message to the configured Telegram chat/group.
 */
export const sendTelegramMessage = async (htmlText) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIdsEnv = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatIdsEnv) {
    logger.debug('Telegram bot credentials not configured — skipping notification');
    return;
  }

  const chatIds = chatIdsEnv.split(',').map((id) => id.trim()).filter(Boolean);

  for (const chatId of chatIds) {
    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      await axios.post(url, {
        chat_id: chatId,
        text: htmlText,
        parse_mode: 'HTML',
      });
      logger.info(`Telegram notification sent successfully to chat ${chatId}`);
    } catch (err) {
      logger.error(`Failed to send Telegram notification to ${chatId}: ${err.response?.data?.description || err.message}`);
    }
  }
};
