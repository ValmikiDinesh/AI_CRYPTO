import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { sendTelegramMessage, formatPrice } from '../../services/telegramService.js';
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

    // Recalculate total balance using universal equity formula: entryPrice * quantity + unrealizedPnl
    const positionValue = portfolio.positions
      .filter((p) => p.status === 'open')
      .reduce((sum, p) => sum + (p.entryPrice * p.quantity + p.unrealizedPnl), 0);

    portfolio.totalBalance = portfolio.availableBalance + positionValue;

    // Update peak balance for drawdown tracking
    if (portfolio.totalBalance > portfolio.peakBalance) {
      portfolio.peakBalance = portfolio.totalBalance;
    }

    await portfolio.save();
  }

  /** Check if any positions should be closed (stop-loss or take-profit). */
  async checkExits(portfolio) {
    for (const position of portfolio.positions) {
      if (position.status !== 'open') continue;

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
    const returnValue = (position.entryPrice * position.quantity) + position.realizedPnl - exitFee;
    portfolio.availableBalance += returnValue;
    portfolio.totalPnl += (position.realizedPnl - totalPositionFees);
    portfolio.dailyLossToday += Math.min(0, position.realizedPnl); // track losses

    if (position.realizedPnl >= 0) {
      portfolio.winningTrades += 1;
    } else {
      portfolio.losingTrades += 1;
    }

    if (portfolio.totalTrades > 0) {
      portfolio.winRate = portfolio.winningTrades / portfolio.totalTrades;
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
      `<b>Reason</b>: ${reason}`
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
    });
  }
}
