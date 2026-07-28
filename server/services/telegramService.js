import axios from 'axios';
import https from 'https';
import { logger } from '../utils/logger.js';

// Force IPv4 (family: 4) to bypass broken IPv6 routing/timeouts to api.telegram.org on cloud hosts
const httpsAgent = new https.Agent({
  family: 4,
  keepAlive: true
});

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
 * Escapes HTML special characters to prevent Telegram API parse errors.
 */
export const escapeHtml = (text) => {
  if (typeof text !== 'string') return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
};

/**
 * Sends a HTML message to the configured Telegram chat/group.
 */
export const sendTelegramMessage = async (htmlText, options = {}) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIdsEnv = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatIdsEnv) {
    logger.debug('Telegram bot credentials not configured — skipping notification');
    return [];
  }

  const chatIds = chatIdsEnv.split(',').map((id) => id.trim()).filter(Boolean);
  const sentMessages = [];

  // Fire-and-forget to prevent blocking callers (Agents & API routes)
  (async () => {
    for (const chatId of chatIds) {
      try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const res = await axios.post(url, {
          chat_id: chatId,
          text: htmlText,
          parse_mode: 'HTML',
        }, {
          httpsAgent,
          timeout: 10000
        });
        logger.info(`Telegram notification sent successfully to chat ${chatId}`);
        
        const messageId = res.data?.result?.message_id;
        if (messageId) {
          sentMessages.push({ chatId, messageId });
          
          if (options.pin) {
            try {
              const pinUrl = `https://api.telegram.org/bot${token}/pinChatMessage`;
              await axios.post(pinUrl, {
                chat_id: chatId,
                message_id: messageId,
                disable_notification: true,
              }, {
                httpsAgent,
                timeout: 10000
              });
              logger.info(`Telegram message ${messageId} pinned successfully in chat ${chatId}`);
            } catch (pinErr) {
              logger.error(`Failed to pin Telegram message in ${chatId}: ${pinErr.response?.data?.description || pinErr.message}`);
            }
          }
        }
      } catch (err) {
        logger.error(`Failed to send Telegram notification to ${chatId}: ${err.response?.data?.description || err.message}`);
      }
    }
  })().catch(err => logger.error(`Unhandled Telegram Error: ${err.message}`));

  return [];
};
