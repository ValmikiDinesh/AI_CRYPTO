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
  constructor(marketAgent, riskAgent) {
    super(AGENT_NAMES.PORTFOLIO);
    this.marketAgent = marketAgent;
    this.riskAgent = riskAgent;
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
    let activeExchangePositions = [];
    let fetchedExchangeSuccessfully = false;

    // 1. Fetch all active positions from Binance in a single call to prevent timeouts and rate-limiting
    try {
      const { fetchPositions } = await import('../../services/exchangeService.js');
      activeExchangePositions = await fetchPositions();
      fetchedExchangeSuccessfully = true;
    } catch (err) {
      this.logger.warn(`🔄 [RECONCILIATION] Failed to fetch active positions from Binance: ${err.message}. Falling back to local price updates.`);
    }

    // Create a map of active exchange positions for fast lookup (asset -> CCXT position)
    const exchangePositionMap = new Map();
    if (fetchedExchangeSuccessfully) {
      activeExchangePositions.forEach((p) => {
        // Map CCXT symbol (e.g. "BOME/USDT:USDT") to asset name (e.g. "BOMEUSDT")
        const asset = p.symbol.split(':')[0].replace('/', '');
        exchangePositionMap.set(asset, p);
      });
    }

    // 2. Loop through all database open positions and reconcile them
    for (const position of portfolio.positions) {
      if (position.status !== 'open') continue;

      let currentPrice = this.marketAgent.getPrice(position.asset);
      if (!currentPrice && fetchedExchangeSuccessfully) {
        const exchangePos = exchangePositionMap.get(position.asset);
        if (exchangePos) {
          currentPrice = exchangePos.markPrice || exchangePos.entryPrice || 0;
        } else {
          currentPrice = position.currentPrice || position.entryPrice || 0;
        }
      }

      if (!currentPrice) continue;

      let isNativelyClosed = false;
      let closePrice = currentPrice;
      let closeReason = 'Exchange-side trigger';

      if (fetchedExchangeSuccessfully) {
        const exchangePos = exchangePositionMap.get(position.asset);
        
        // If the position is open in DB but does not exist on Binance, it has been natively closed!
        if (!exchangePos) {
          const positionAgeMs = Date.now() - new Date(position.openedAt).getTime();
          const MIN_RECONCILIATION_AGE_MS = 30000; // 30 seconds

          // Check if this is a real exchange trade (not mock/simulated) and is old enough to reconcile
          const activeTrade = await Trade.findOne({ asset: position.asset, status: 'open' });
          if (activeTrade && positionAgeMs >= MIN_RECONCILIATION_AGE_MS) {
            isNativelyClosed = true;
            this.logger.warn(`🔄 [RECONCILIATION] Open position for ${position.asset} is no longer active on Binance. Syncing closure locally.`);

            // Try to fetch the last closed trade fill price from Binance history
            try {
              const { getExchange } = await import('../../services/exchangeService.js');
              const exchange = getExchange();
              const trades = await exchange.fetchMyTrades(position.asset, undefined, 5);
              if (trades.length > 0) {
                const lastTrade = trades[trades.length - 1];
                closePrice = lastTrade.price;
                closeReason = `Binance trigger executed (Exit price: $${lastTrade.price})`;
              }
            } catch (historyErr) {
              this.logger.debug(`Could not retrieve trade fill price from Binance history for ${position.asset}: ${historyErr.message}`);
            }
          }
        } else {
          // Position exists in both DB and Binance. Sync entry price and contracts just in case of slight drift.
          position.entryPrice = exchangePos.entryPrice || position.entryPrice;
          position.quantity = exchangePos.contracts || position.quantity;
          position.currentPrice = exchangePos.markPrice || currentPrice;

          // Also sync corresponding open Trade record quantity and entryPrice to avoid DB-exchange drift
          try {
            const activeTrade = await Trade.findOne({ asset: position.asset, status: 'open' });
            if (activeTrade) {
              let changed = false;
              if (activeTrade.quantity !== position.quantity) {
                activeTrade.quantity = position.quantity;
                changed = true;
              }
              if (activeTrade.entryPrice !== position.entryPrice) {
                activeTrade.entryPrice = position.entryPrice;
                changed = true;
              }
              if (changed) {
                await activeTrade.save();
              }
            }
          } catch (tradeSyncErr) {
            this.logger.error(`Failed to sync Trade quantity/entryPrice for ${position.asset}: ${tradeSyncErr.message}`);
          }
        }
      }

      if (isNativelyClosed) {
        await this.closePosition(portfolio, position, closePrice, closeReason, true);
        continue;
      }

      // Local PnL update (fallback/default behavior)
      position.currentPrice = currentPrice;

      if (position.side === 'long') {
        position.unrealizedPnl = (currentPrice - position.entryPrice) * position.quantity;
      } else {
        position.unrealizedPnl = (position.entryPrice - currentPrice) * position.quantity;
      }



      totalUnrealizedPnl += position.unrealizedPnl;
    }

    // 3. Binance-to-Database Sync (Import active positions found on Binance but missing in DB)
    if (fetchedExchangeSuccessfully) {
      for (const exchangePos of activeExchangePositions) {
        const asset = exchangePos.symbol.split(':')[0].replace('/', '');
        const dbPosition = portfolio.positions.find((p) => p.asset === asset && p.status === 'open');

        if (!dbPosition) {
          this.logger.info(`🔄 [RECONCILIATION] Active position for ${asset} found on Binance but not in DB. Importing...`);

          const side = exchangePos.side; // 'long' or 'short'
          const entryPrice = exchangePos.entryPrice;
          const quantity = exchangePos.contracts;
          const leverage = exchangePos.initialMarginPercentage > 0 ? Math.round(1 / exchangePos.initialMarginPercentage) : 3;
          const currentPrice = exchangePos.markPrice || entryPrice;
          const unrealizedPnl = exchangePos.unrealizedPnl || 0;

          // Find a corresponding pending or open Trade document in the DB
          let activeTrade = await Trade.findOne({ asset, status: { $in: ['open', 'pending'] } }).sort({ createdAt: -1 });
          let stopLossOrderId = null;

          if (activeTrade && activeTrade.status === 'pending') {
            activeTrade.status = 'open';
            activeTrade.entryPrice = entryPrice;
            activeTrade.quantity = quantity;
            activeTrade.executedAt = new Date(exchangePos.timestamp || Date.now());
            await activeTrade.save();

            if (this.riskAgent) {
              this.riskAgent.incrementDailyTradeCount();
            }

            // Place stop-loss and take-profit trigger orders on the exchange for newly filled limit order
            if (activeTrade.exchangeOrderId && !activeTrade.exchangeOrderId.startsWith('mock_')) {
              try {
                const { getExchange } = await import('../../services/exchangeService.js');
                const exchange = getExchange();
                await exchange.loadMarkets();
                const oppositeSide = activeTrade.action === 'BUY' ? 'sell' : 'buy';
                
                const formattedAmount = parseFloat(exchange.amountToPrecision(asset, quantity));
                
                if (activeTrade.stopLoss) {
                  const formattedStopLoss = parseFloat(exchange.priceToPrecision(asset, activeTrade.stopLoss));
                  const slOrderResult = await exchange.createOrder(
                    asset,
                    'stop_market',
                    oppositeSide,
                    formattedAmount,
                    undefined,
                    {
                      stopPrice: formattedStopLoss,
                      reduceOnly: true
                    }
                  );
                  stopLossOrderId = slOrderResult?.id;
                  this.logger.info(`✅ [NATIVE STOP-LOSS PLACED] stopPrice=${formattedStopLoss} id=${stopLossOrderId} on Binance Demo for filled limit order`);
                }
                
                if (activeTrade.takeProfit) {
                  const formattedTakeProfit = parseFloat(exchange.priceToPrecision(asset, activeTrade.takeProfit));
                  await exchange.createOrder(
                    asset,
                    'take_profit_market',
                    oppositeSide,
                    formattedAmount,
                    undefined,
                    {
                      stopPrice: formattedTakeProfit,
                      reduceOnly: true
                    }
                  );
                  this.logger.info(`✅ [NATIVE TAKE-PROFIT PLACED] takeProfitPrice=${formattedTakeProfit} on Binance Demo for filled limit order`);
                }
              } catch (triggerErr) {
                this.logger.error(`❌ [NATIVE TRIGGERS PLACEMENT FAILED] Failed to place stop/target orders on Binance Demo: ${triggerErr.message}`);
              }
            }

            // Send fill notification to Telegram
            await sendTelegramMessage(
              `⚡️ <b>Limit Order Filled! [Open]</b>\n` +
              `<b>Asset</b>: ${asset.replace('USDT', '')}/USDT\n` +
              `<b>Action</b>: ${activeTrade.action} (${activeTrade.action === 'BUY' ? 'LONG' : 'SHORT'})\n` +
              `<b>Fill Price</b>: $${formatPrice(entryPrice)}\n` +
              `<b>Quantity</b>: ${quantity.toFixed(5)}\n` +
              `<b>Stop Loss</b>: ${activeTrade.stopLoss ? '$' + formatPrice(activeTrade.stopLoss) : '—'}\n` +
              `<b>Target</b>: ${activeTrade.takeProfit ? '$' + formatPrice(activeTrade.takeProfit) : '—'}`
            );
          }

          const calculatedStopLoss = (activeTrade && activeTrade.stopLoss) ? activeTrade.stopLoss : (side === 'long' ? entryPrice * 0.95 : entryPrice * 1.05);
          const calculatedTakeProfit = (activeTrade && activeTrade.takeProfit) ? activeTrade.takeProfit : (side === 'long' ? entryPrice * 1.10 : entryPrice * 0.90);

          // Add to portfolio positions array
          portfolio.positions.push({
            asset,
            side,
            entryPrice,
            currentPrice,
            quantity,
            leverage,
            unrealizedPnl,
            status: 'open',
            openedAt: new Date(exchangePos.timestamp || Date.now()),
            fees: activeTrade ? (activeTrade.fees || 0) : 0,
            stopLoss: calculatedStopLoss,
            takeProfit: calculatedTakeProfit,
            stopLossOrderId,
          });

          if (!activeTrade) {
            await Trade.create({
              userId: portfolio.userId || null,
              asset,
              action: side === 'long' ? 'BUY' : 'SELL',
              type: 'paper',
              side,
              entryPrice,
              quantity,
              positionSize: ((entryPrice * quantity) / portfolio.totalBalance) * 100,
              leverage,
              stopLoss: calculatedStopLoss,
              takeProfit: calculatedTakeProfit,
              confidence: 1.0,
              riskScore: 0.5,
              reasoning: 'Imported via Binance reconciliation sync',
              status: 'open',
              executedAt: new Date(exchangePos.timestamp || Date.now()),
              exchange: 'binance_testnet',
            });
            this.logger.info(`✅ [RECONCILIATION] Created matching Trade record for ${asset} (${side.toUpperCase()}) with fallback targets (SL: ${calculatedStopLoss}, TP: ${calculatedTakeProfit})`);
          }
        }
      }
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
      let currentPrice = this.marketAgent.getPrice(position.asset);
      if (!currentPrice) {
        currentPrice = position.currentPrice || 0;
      }
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
        await this.closePosition(portfolio, position, currentPrice, reason, false);
      }
    }
  }

  /** Close a position and update portfolio. */
  async closePosition(portfolio, position, closePrice, reason, isReconciliation = false) {
    let actualClosePrice = closePrice;
    let actualFees = 0;

    // Only place an offsetting close order on the exchange if this is NOT a reconciliation sync
    if (!isReconciliation) {
      try {
        const activeTrade = await Trade.findOne({ asset: position.asset, status: 'open' });
        if (activeTrade && activeTrade.exchangeOrderId && !activeTrade.exchangeOrderId.startsWith('mock_')) {
          const exitSide = position.side === 'long' ? 'sell' : 'buy';
          
          // Fetch fresh position size directly from the exchange to ensure we close the full current position
          let closeQty = position.quantity;
          try {
            const { fetchPositions } = await import('../../services/exchangeService.js');
            const activePos = await fetchPositions(position.asset);
            if (activePos && activePos.length > 0) {
              closeQty = activePos[0].contracts || position.quantity;
            }
          } catch (fetchErr) {
            this.logger.warn(`Failed to fetch fresh position size before exit, falling back to local quantity: ${fetchErr.message}`);
          }

          this.logger.info(`🚨 [EXCHANGE EXIT TRIGGERED] Placing offsetting ${exitSide.toUpperCase()} order on Binance Demo for ${position.asset} (${closeQty} units)`);
          
          // Await close order and retrieve actual executed parameters from response
          const closeOrder = await placeMarketOrder(position.asset, exitSide, closeQty);
          
          actualClosePrice = closeOrder.average || closeOrder.price || closePrice;
          if (closeOrder.fee && closeOrder.fee.cost) {
            actualFees = closeOrder.fee.cost;
          }
        }
      } catch (err) {
        this.logger.error(`❌ [EXCHANGE EXIT FAILED] Failed to place offsetting close order on Binance Demo for ${position.asset}: ${err.message}. Aborting position closure.`);
        // Abort local closure so that the position stays open and we retry in the next cycle
        return;
      }
    }

    // Exchange order cleanup: cancel any remaining Stop-Loss or Take-Profit orders for this asset
    try {
      const activeTrade = await Trade.findOne({ asset: position.asset, status: 'open' });
      if (activeTrade && activeTrade.exchangeOrderId && !activeTrade.exchangeOrderId.startsWith('mock_')) {
        const { getExchange } = await import('../../services/exchangeService.js');
        const exchange = getExchange();
        await exchange.cancelAllOrders(position.asset);
        this.logger.info(`🧹 [ORDER CLEANUP] Successfully cancelled all remaining pending trigger orders for ${position.asset} on Binance`);
      }
    } catch (cleanErr) {
      this.logger.debug(`Failed to clean up remaining triggers for ${position.asset}: ${cleanErr.message}`);
    }

    position.status = 'closed';
    position.closedAt = new Date();

    // Calculate final realized PnL using actual exit price instead of stale unrealized value
    let realizedPnl = 0;
    if (position.side === 'long') {
      realizedPnl = (actualClosePrice - position.entryPrice) * position.quantity;
    } else {
      realizedPnl = (position.entryPrice - actualClosePrice) * position.quantity;
    }
    position.realizedPnl = realizedPnl;
    position.unrealizedPnl = 0;

    const futuresFeeRate = 0.0005; // 0.05% Taker Fee
    const exitValue = actualClosePrice * position.quantity;
    const exitFee = actualFees > 0 ? actualFees : (exitValue * futuresFeeRate);
    const totalPositionFees = (position.fees || 0) + exitFee;
    position.fees = totalPositionFees;

    // Return funds (collateral + realized PnL - exit fee) to available balance
    const returnValue = ((position.entryPrice * position.quantity) / (position.leverage || 1)) + position.realizedPnl - exitFee;
    portfolio.availableBalance += returnValue;
    portfolio.totalPnl += (position.realizedPnl - totalPositionFees);
    portfolio.dailyLossToday += (position.realizedPnl - totalPositionFees); // track net daily PnL (after fees)

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

    // Calculate trade performance percentage (ROE)
    const initialMargin = (position.entryPrice * position.quantity) / (position.leverage || 1);
    const pnlPercent = initialMargin > 0 ? (position.realizedPnl / initialMargin) * 100 : 0;

    // Update corresponding trade record
    const activeTrade = await Trade.findOne({ asset: position.asset, status: 'open' });
    if (activeTrade) {
      activeTrade.status = 'closed';
      activeTrade.exitPrice = actualClosePrice;
      activeTrade.pnl = position.realizedPnl;
      activeTrade.pnlPercent = pnlPercent;
      activeTrade.fees = totalPositionFees;
      activeTrade.closedAt = new Date();
      activeTrade.metadata = { ...(activeTrade.metadata || {}), closeReason: reason };
      activeTrade.markModified('metadata');
      await activeTrade.save();
    }

    const model = activeTrade?.metadata?.sourceModel || 'none';
    const strategy = model === 'ai_groq' ? 'Groq AI' : model === 'ai_openai' ? 'OpenAI (AI)' : model.includes('ai_') ? 'Google Gemini (AI)' : (model.includes('fallback') || model.includes('statistical')) ? 'Local Statistical (Fallback)' : 'Ensemble';

    this.logger.info(
      `Position closed: ${position.asset} ${position.side} — PnL: ${position.realizedPnl.toFixed(2)} — ${reason}`
    );

    // Notify Telegram
    await sendTelegramMessage(
      `✅ <b>Position Closed! [Auto]</b>\n` +
      `<b>Asset</b>: ${position.asset.replace('USDT', '')}/USDT\n` +
      `<b>Side</b>: ${position.side.toUpperCase()}\n` +
      `<b>Strategy</b>: ${strategy}\n` +
      `<b>Entry Price</b>: $${formatPrice(position.entryPrice)}\n` +
      `<b>Exit Price</b>: $${formatPrice(actualClosePrice)}\n` +
      `<b>Quantity</b>: ${position.quantity.toFixed(5)}\n` +
      `<b>Gross Realized PnL</b>: ${position.realizedPnl >= 0 ? '+' : ''}$${position.realizedPnl.toFixed(2)}\n` +
      `<b>Commission Paid</b>: $${totalPositionFees.toFixed(4)}\n` +
      `<b>Net PnL (After Fees)</b>: ${(position.realizedPnl - totalPositionFees) >= 0 ? '+' : ''}$${(position.realizedPnl - totalPositionFees).toFixed(2)}\n` +
      `<b>Reason</b>: ${escapeHtml(reason)}`
    );

    await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
      asset: position.asset,
      action: 'CLOSE',
      price: actualClosePrice,
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

    try {
      // 1. Calculate true closed PnL and trade counters from Trade collection (source of truth)
      const closedTrades = await Trade.find({ status: 'closed' });
      let trueTotalPnl = 0;
      let winners = 0;
      let losers = 0;

      closedTrades.forEach(t => {
        const netReturn = (t.pnl || 0) - (t.fees || 0);
        trueTotalPnl += netReturn;
        if (netReturn >= 0) {
          winners++;
        } else {
          losers++;
        }
      });

      const totalClosed = closedTrades.length;

      // 2. Calculate true available balance
      let trueAvailable = 1000 + trueTotalPnl;
      let openExposure = 0;
      let openUnrealized = 0;

      openPositions.forEach(p => {
        const leverage = p.leverage && p.leverage > 1 ? p.leverage : 10;
        const exposure = p.entryPrice * p.quantity;
        const margin = exposure / leverage;
        const entryFee = p.fees || 0;

        trueAvailable -= (margin + entryFee);
        openExposure += margin;
        openUnrealized += p.unrealizedPnl;
      });

      // Deduct margin and fees for pending limit orders
      let pendingMargin = 0;
      const pendingTrades = await Trade.find({ status: 'pending' });
      pendingTrades.forEach(t => {
        const leverage = t.leverage && t.leverage > 1 ? t.leverage : 3;
        const exposure = t.entryPrice * t.quantity;
        const margin = exposure / leverage;
        const entryFee = t.fees || 0;
        trueAvailable -= (margin + entryFee);
        pendingMargin += (margin + entryFee);
      });

      // 3. Calculate true total balance (Net Worth)
      const trueTotalBalance = trueAvailable + pendingMargin + openExposure + openUnrealized;

      portfolio.totalPnl = trueTotalPnl;
      portfolio.availableBalance = trueAvailable;
      portfolio.totalBalance = trueTotalBalance;

      portfolio.winningTrades = winners;
      portfolio.losingTrades = losers;
      portfolio.totalTrades = totalClosed + openPositions.length;
      portfolio.winRate = totalClosed > 0 ? winners / totalClosed : 0;

      if (trueTotalBalance > portfolio.peakBalance) {
        portfolio.peakBalance = trueTotalBalance;
      }
    } catch (dbErr) {
      this.logger.error(`Error during self-healing portfolio metrics recalculation: ${dbErr.message}`);
    }

    portfolio.totalPnlPercent = portfolio.totalBalance > 0
      ? ((portfolio.totalBalance - 1000) / 1000) * 100  // vs initial capital
      : 0;

    // Recalculate dailyLossToday dynamically from Trade collection (source of truth for today's closed trades in IST)
    try {
      const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0]; // "YYYY-MM-DD" in IST
      const startOfToday = new Date(`${todayStr}T00:00:00.000+05:30`);
      const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

      const closedTradesToday = await Trade.find({
        status: 'closed',
        closedAt: { $gte: startOfToday, $lt: endOfToday },
      });

      const totalCommissions = closedTradesToday.reduce((sum, t) => sum + (t.fees || 0), 0);
      const grossProfit = closedTradesToday.reduce((sum, t) => sum + (t.pnl || 0), 0);
      portfolio.dailyLossToday = grossProfit - totalCommissions;
    } catch (err) {
      this.logger.error(`Failed to dynamically recalculate dailyLossToday: ${err.message}`);
    }

    await portfolio.save();
  }

  /** Check if it is a new day and we should send the daily digest report. */
  async checkDailyDigest(portfolio) {
    const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0]; // "YYYY-MM-DD" in IST

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
    const startOfDay = new Date(`${dateStr}T00:00:00.000+05:30`);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const closedTradesToday = await Trade.find({
      status: 'closed',
      closedAt: { $gte: startOfDay, $lt: endOfDay },
    });

    const count = closedTradesToday.length;

    if (count === 0) {
      await sendTelegramMessage(
        `📊 <b>Daily Trading Digest [${dateStr}] (IST)</b>\n` +
        `--------------------------------\n` +
        `No positions were closed today.\n\n` +
        `🏦 <b>Net Balance</b>: $${formatPrice(portfolio.totalBalance)}\n` +
        `💵 <b>Margin Available</b>: $${formatPrice(portfolio.availableBalance)}`,
        { pin: true }
      );
      return;
    }

    const winningTrades = closedTradesToday.filter((t) => (t.pnl || 0) - (t.fees || 0) >= 0);
    const losingTrades = closedTradesToday.filter((t) => (t.pnl || 0) - (t.fees || 0) < 0);

    const totalCommissions = closedTradesToday.reduce((sum, t) => sum + (t.fees || 0), 0);
    const grossProfit = closedTradesToday.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const netPnL = grossProfit - totalCommissions;

    const winRate = (winningTrades.length / count) * 100;

    const message = 
      `📊 <b>Daily Trading Digest [${dateStr}] (IST)</b>\n` +
      `--------------------------------\n` +
      `<b>Total Closed Trades</b>: ${count}\n` +
      `  📈 Winning Trades: ${winningTrades.length}\n` +
      `  📉 Losing Trades: ${losingTrades.length}\n` +
      `  🎯 Win Rate: ${winRate.toFixed(1)}%\n\n` +
      `<b>Financial Breakdown</b>:\n` +
      `  💰 Gross Profit: +$${grossProfit.toFixed(2)}\n` +
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
