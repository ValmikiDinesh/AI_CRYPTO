import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { sendTelegramMessage, formatPrice, escapeHtml } from '../../services/telegramService.js';
import { placeMarketOrder } from '../../services/exchangeService.js';
import Portfolio from '../../models/Portfolio.js';
import Trade from '../../models/Trade.js';

/**
 * Portfolio Management Agent
 * - Tracks portfolio performance, PnL, allocations, and exposure.
 * - Monitors open positions for stop-loss / take-profit.
 * - Dynamically rebalances portfolio allocation.
 */
export default class PortfolioAgent extends BaseAgent {
  constructor(marketAgent) {
    super(AGENT_NAMES.PORTFOLIO);
    this.marketAgent = marketAgent;
  }

  async execute() {
    const portfolios = await Portfolio.find({});

    for (const portfolio of portfolios) {
      try {
        await this.updatePositions(portfolio);
        await this.checkExits(portfolio);
        await this.updateMetrics(portfolio);
        await this.checkDailyDigest(portfolio);
        await this.publishUpdate(portfolio);
      } catch (err) {
        this.logger.error(`Portfolio update error: ${err.message}`);
      }
    }
  }

  /** Update current prices and unrealized PnL for all open positions. */
  async updatePositions(portfolio) {
    let totalUnrealizedPnl = 0;

    for (const position of portfolio.positions) {
      if (position.status !== 'open') continue;

      const currentPrice = this.marketAgent.getPrice(position.asset);
      if (!currentPrice) continue;

      position.currentPrice = currentPrice;

      if (position.side === 'long') {
        position.unrealizedPnl = (currentPrice - position.entryPrice) * position.quantity;
      } else {
        position.unrealizedPnl = (position.entryPrice - currentPrice) * position.quantity;
      }

      totalUnrealizedPnl += position.unrealizedPnl;
    }

    // Recalculate total balance using leverage-adjusted universal equity formula
    const marginValue = portfolio.positions
      .filter((p) => p.status === 'open')
      .reduce((sum, p) => sum + ((p.entryPrice * p.quantity) / (p.leverage || 1) + p.unrealizedPnl), 0);

    portfolio.totalBalance = portfolio.availableBalance + marginValue;

    // Update peak balance for drawdown tracking
    if (portfolio.totalBalance > portfolio.peakBalance) {
      portfolio.peakBalance = portfolio.totalBalance;
    }

    await portfolio.save();
  }

  async checkExits(portfolio) {
    const processedAssets = new Set();

    for (const position of portfolio.positions) {
      if (position.status !== 'open') continue;

      if (processedAssets.has(position.asset)) {
        this.logger.warn(`Duplicate open position found for ${position.asset} in exit loop — self-healing by marking it closed.`);
        position.status = 'closed';
        position.closedAt = new Date();
        continue;
      }

      processedAssets.add(position.asset);
      const currentPrice = this.marketAgent.getPrice(position.asset);
      if (!currentPrice) continue;

      let shouldClose = false;
      let reason = '';

      if (position.side === 'long') {
        if (position.stopLoss && currentPrice <= position.stopLoss) {
          shouldClose = true;
          reason = `Stop-loss triggered (${currentPrice} <= ${position.stopLoss})`;
        }
        if (position.takeProfit && currentPrice >= position.takeProfit) {
          shouldClose = true;
          reason = `Take-profit triggered (${currentPrice} >= ${position.takeProfit})`;
        }
      } else {
        if (position.stopLoss && currentPrice >= position.stopLoss) {
          shouldClose = true;
          reason = `Stop-loss triggered (${currentPrice} >= ${position.stopLoss})`;
        }
        if (position.takeProfit && currentPrice <= position.takeProfit) {
          shouldClose = true;
          reason = `Take-profit triggered (${currentPrice} <= ${position.takeProfit})`;
        }
      }

      if (shouldClose) {
        await this.closePosition(portfolio, position, currentPrice, reason);
      }
    }
  }

  /** Close a position and update portfolio. */
  async closePosition(portfolio, position, closePrice, reason) {
    // Check if there is an active automated trade on Binance to close
    try {
      const activeTrade = await Trade.findOne({ asset: position.asset, status: 'open' });
      if (activeTrade && activeTrade.exchangeOrderId && (activeTrade.exchange === 'binance_testnet' || activeTrade.exchange === 'binance')) {
        const exitSide = position.side === 'long' ? 'sell' : 'buy';
        this.logger.info(`🚨 [EXCHANGE EXIT TRIGGERED] Placing offsetting ${exitSide.toUpperCase()} order on Binance Demo for ${position.asset} (${position.quantity} units)`);
        await placeMarketOrder(position.asset, exitSide, position.quantity);
      }
    } catch (err) {
      this.logger.error(`❌ [EXCHANGE EXIT FAILED] Failed to place offsetting close order on Binance Demo for ${position.asset}: ${err.message}`);
    }

    position.status = 'closed';
    position.closedAt = new Date();
    position.realizedPnl = position.unrealizedPnl;
    position.unrealizedPnl = 0;

    const futuresFeeRate = 0.0005; // 0.05% Taker Fee
    const exitValue = closePrice * position.quantity;
    const exitFee = exitValue * futuresFeeRate;
    const totalPositionFees = (position.fees || 0) + exitFee;
    position.fees = totalPositionFees;

    // Return funds (collateral + realized PnL - exit fee) to available balance
    const returnValue = ((position.entryPrice * position.quantity) / (position.leverage || 1)) + position.realizedPnl - exitFee;
    portfolio.availableBalance += returnValue;
    portfolio.totalPnl += (position.realizedPnl - totalPositionFees);
    portfolio.dailyLossToday += position.realizedPnl; // track net daily PnL

    if (position.realizedPnl >= 0) {
      portfolio.winningTrades += 1;
    } else {
      portfolio.losingTrades += 1;
    }

    const totalClosed = (portfolio.winningTrades || 0) + (portfolio.losingTrades || 0);
    portfolio.winRate = totalClosed > 0 ? portfolio.winningTrades / totalClosed : 0;

    // Recalculate total balance using leverage-adjusted universal equity formula
    const marginValue = portfolio.positions
      .filter((p) => p.status === 'open')
      .reduce((sum, p) => sum + ((p.entryPrice * p.quantity) / (p.leverage || 1) + p.unrealizedPnl), 0);
    portfolio.totalBalance = portfolio.availableBalance + marginValue;

    if (portfolio.totalBalance > portfolio.peakBalance) {
      portfolio.peakBalance = portfolio.totalBalance;
    }

    await portfolio.save();

    // Update corresponding trade record
    await Trade.findOneAndUpdate(
      { asset: position.asset, status: 'open' },
      {
        status: 'closed',
        exitPrice: closePrice,
        pnl: position.realizedPnl,
        fees: totalPositionFees,
        closedAt: new Date(),
        metadata: { closeReason: reason },
      }
    );

    this.logger.info(
      `Position closed: ${position.asset} ${position.side} — PnL: ${position.realizedPnl.toFixed(2)} — ${reason}`
    );

    // Notify Telegram
    await sendTelegramMessage(
      `✅ <b>Position Closed! [Auto]</b>\n` +
      `<b>Asset</b>: ${position.asset.replace('USDT', '')}/USDT\n` +
      `<b>Side</b>: ${position.side.toUpperCase()}\n` +
      `<b>Entry Price</b>: $${formatPrice(position.entryPrice)}\n` +
      `<b>Exit Price</b>: $${formatPrice(closePrice)}\n` +
      `<b>Quantity</b>: ${position.quantity.toFixed(5)}\n` +
      `<b>Gross Realized PnL</b>: ${position.realizedPnl >= 0 ? '+' : ''}$${position.realizedPnl.toFixed(2)}\n` +
      `<b>Commission Paid</b>: $${totalPositionFees.toFixed(4)}\n` +
      `<b>Net PnL (After Fees)</b>: ${(position.realizedPnl - totalPositionFees) >= 0 ? '+' : ''}$${(position.realizedPnl - totalPositionFees).toFixed(2)}\n` +
      `<b>Reason</b>: ${escapeHtml(reason)}`
    );

    await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
      asset: position.asset,
      action: 'CLOSE',
      price: closePrice,
      pnl: position.realizedPnl,
      reason,
    });
  }

  /** Update aggregate portfolio metrics. */
  async updateMetrics(portfolio) {
    // Allocation breakdown
    const openPositions = portfolio.positions.filter((p) => p.status === 'open');
    const totalValue = openPositions.reduce((sum, p) => sum + p.currentPrice * p.quantity, 0);

    portfolio.allocationBreakdown = openPositions.map((p) => ({
      asset: p.asset,
      percentage: totalValue > 0 ? ((p.currentPrice * p.quantity) / totalValue) * 100 : 0,
      value: p.currentPrice * p.quantity,
    }));

    portfolio.totalPnlPercent = portfolio.totalBalance > 0
      ? ((portfolio.totalBalance - 1000) / 1000) * 100  // vs initial capital
      : 0;

    await portfolio.save();
  }

  /** Check if it is a new day and we should send the daily digest report. */
  async checkDailyDigest(portfolio) {
    const todayStr = new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"

    if (!portfolio.lastDailyDigestDate) {
      portfolio.lastDailyDigestDate = todayStr;
      await portfolio.save();
    } else if (portfolio.lastDailyDigestDate !== todayStr) {
      const targetDateStr = portfolio.lastDailyDigestDate;
      
      try {
        await this.sendDailyDigest(portfolio, targetDateStr);
      } catch (err) {
        this.logger.error(`Failed to send daily digest for ${targetDateStr}: ${err.message}`);
      }

      portfolio.lastDailyDigestDate = todayStr;
      portfolio.dailyLossToday = 0; // Reset daily PnL for the new day
      await portfolio.save();
    }
  }

  /** Compute and send the detailed daily trading performance digest via Telegram. */
  async sendDailyDigest(portfolio, dateStr) {
    const startOfDay = new Date(dateStr);
    const endOfDay = new Date(dateStr);
    endOfDay.setDate(endOfDay.getDate() + 1);

    const closedTradesToday = await Trade.find({
      status: 'closed',
      closedAt: { $gte: startOfDay, $lt: endOfDay },
    });

    const count = closedTradesToday.length;

    if (count === 0) {
      await sendTelegramMessage(
        `📊 <b>Daily Trading Digest [${dateStr}]</b>\n` +
        `--------------------------------\n` +
        `No positions were closed today.\n\n` +
        `🏦 <b>Net Balance</b>: $${formatPrice(portfolio.totalBalance)}\n` +
        `💵 <b>Margin Available</b>: $${formatPrice(portfolio.availableBalance)}`,
        { pin: true }
      );
      return;
    }

    const winningTrades = closedTradesToday.filter((t) => (t.pnl || 0) >= 0);
    const losingTrades = closedTradesToday.filter((t) => (t.pnl || 0) < 0);

    const totalCommissions = closedTradesToday.reduce((sum, t) => sum + (t.fees || 0), 0);
    const grossProfit = winningTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const grossLoss = losingTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const netPnL = grossProfit + grossLoss - totalCommissions;

    const winRate = (winningTrades.length / count) * 100;

    const message = 
      `📊 <b>Daily Trading Digest [${dateStr}]</b>\n` +
      `--------------------------------\n` +
      `<b>Total Closed Trades</b>: ${count}\n` +
      `  📈 Winning Trades: ${winningTrades.length}\n` +
      `  📉 Losing Trades: ${losingTrades.length}\n` +
      `  🎯 Win Rate: ${winRate.toFixed(1)}%\n\n` +
      `<b>Financial Breakdown</b>:\n` +
      `  💰 Gross Profit: +$${grossProfit.toFixed(2)}\n` +
      `  💸 Gross Loss: -$${Math.abs(grossLoss).toFixed(2)}\n` +
      `  🏷️ Commissions Paid: -$${totalCommissions.toFixed(4)}\n` +
      `  📊 <b>Net Daily PnL</b>: ${netPnL >= 0 ? '🟢 +' : '🔴 '}$${netPnL.toFixed(2)}\n\n` +
      `<b>Portfolio State</b>:\n` +
      `  🏦 Net Balance: $${formatPrice(portfolio.totalBalance)}\n` +
      `  💵 Margin Available: $${formatPrice(portfolio.availableBalance)}`;

    await sendTelegramMessage(message, { pin: true });
  }

  /** Publish portfolio update to frontend. */
  async publishUpdate(portfolio) {
    await publishEvent(CHANNELS.PORTFOLIO_UPDATES, {
      totalBalance: portfolio.totalBalance,
      availableBalance: portfolio.availableBalance,
      totalPnl: portfolio.totalPnl,
      totalPnlPercent: portfolio.totalPnlPercent,
      dailyPnl: portfolio.dailyLossToday,
      winRate: portfolio.winRate,
      openPositions: portfolio.positions.filter((p) => p.status === 'open').length,
      allocation: portfolio.allocationBreakdown,
      winningTrades: portfolio.winningTrades,
      losingTrades: portfolio.losingTrades,
      totalTrades: portfolio.totalTrades,
    });
  }
}
