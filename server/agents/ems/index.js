import { SYSTEM_USER_ID } from '../../config/constants.js';
import BaseAgent from '../base/BaseAgent.js';
import { subscribeToChannel, publishEvent, CHANNELS } from '../../config/redis.js';
import { placeMarketOrder, placeLimitOrder, fetchPositions, fetchBalance, cancelAllOrders } from '../../services/exchangeService.js';
import Trade from '../../models/Trade.js';
import Portfolio from '../../models/Portfolio.js';

export default class EmsAgent extends BaseAgent {
  constructor() {
    super('ems');
    this.maxRetries = 3;
    this.isProcessing = false;
    this.queue = [];
  }

  async initialize() {
    this.logger.info('Initializing Execution Management Service (EMS)...');
    await subscribeToChannel(CHANNELS.OMS_APPROVED_ORDERS, this.queueEntryOrder.bind(this));
    await subscribeToChannel(CHANNELS.EXIT_REQUESTS, this.queueExitOrder.bind(this));
    
    // Start queue processor
    setInterval(() => this.processQueue(), 100);
  }

  async queueEntryOrder(payload) {
    this.queue.push({ type: 'ENTRY', payload });
  }

  async queueExitOrder(payload) {
    // Exits take priority over entries
    this.queue.unshift({ type: 'EXIT', payload });
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    try {
      const task = this.queue.shift();
      if (task.type === 'ENTRY') {
        await this.executeEntry(task.payload);
      } else if (task.type === 'EXIT') {
        await this.executeExit(task.payload);
      }
    } catch (err) {
      this.logger.error(`EMS processQueue error: ${err.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  async executeEntry(payload) {
    const { tradeId, asset, side, quantity, limitEntryPrice, stopLoss, takeProfit, leverage } = payload;
    let trade = await Trade.findById(tradeId);
    if (!trade) {
      this.logger.error(`Trade ${tradeId} not found for entry execution`);
      return;
    }

    // STRICT IDEMPOTENCY LOCK: Prevent Double-Spend of duplicate Redis queue payloads
    if (trade.status !== 'oms_approved') {
      this.logger.warn(`EMS Idempotency Lock: Trade ${tradeId} has already been processed (status: ${trade.status}). Skipping duplicate execution.`);
      return;
    }

    let attempt = 0;
    let order = null;

    let portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    const entryOrderType = portfolio?.entryOrderType || 'market';

    while (attempt < this.maxRetries) {
      try {
        attempt++;
        const apiSide = side === 'long' ? 'buy' : 'sell';
        
        if (entryOrderType === 'market') {
          order = await placeMarketOrder(asset, apiSide, quantity, false, trade.leverage);
        } else {
          order = await placeLimitOrder(asset, apiSide, quantity, limitEntryPrice, false, trade.leverage);
        }
        break;
      } catch (err) {
        this.logger.warn(`EMS Order attempt ${attempt}/${this.maxRetries} failed: ${err.message}`);
        if (attempt >= this.maxRetries) {
          trade.status = 'failed';
          trade.metadata = { error: err.message, attempts: attempt };
          await trade.save();
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    let executionPrice = order?.average || order?.price || limitEntryPrice;
    let executionQuantity = order?.filled || order?.amount || quantity;

    try {
      const activePos = await fetchPositions(asset);
      if (activePos && activePos.length > 0 && activePos[0].entryPrice > 0) {
        executionPrice = activePos[0].entryPrice;
        executionQuantity = activePos[0].contracts || executionQuantity;
      }
    } catch (posErr) {
      this.logger.warn(`EMS could not verify exact exchange fill price for ${asset}: ${posErr.message}`);
    }

    // Absolute fallback: If executionPrice is still missing (e.g. market order and fetchPositions failed), aggressively fetch REST ticker
    if (!executionPrice || isNaN(executionPrice) || executionPrice <= 0) {
      let tickerSuccess = false;
      let tickerAttempt = 0;
      while (tickerAttempt < 3 && !tickerSuccess) {
        try {
          tickerAttempt++;
          const { fetchTicker } = await import('../../services/exchangeService.js');
          const ticker = await fetchTicker(asset);
          if (ticker && ticker.last > 0) {
             executionPrice = ticker.last;
             this.logger.info(`EMS: Rescued missing execution price for ${asset} using REST ticker fallback: $${executionPrice}`);
             tickerSuccess = true;
          } else {
             throw new Error("Cannot determine execution price from exchange ticker");
          }
        } catch (e) {
           this.logger.warn(`EMS Ticker fallback attempt ${tickerAttempt} failed for ${asset}: ${e.message}`);
           if (tickerAttempt < 3) await new Promise((r) => setTimeout(r, 1000 * tickerAttempt));
        }
      }
      
      if (!tickerSuccess) {
         this.logger.error(`FATAL: Missing execution price and ticker fallback exhausted for ${asset}. Aborting trade to prevent infinite bleed.`);
         trade.status = 'failed';
         trade.metadata = { error: "Execution price missing and fallback exhausted" };
         await trade.save();
         return;
      }
    }

    const futuresMakerFeeRate = 0.0002;
    let actualFee = order?.fee?.cost || (executionPrice * executionQuantity * futuresMakerFeeRate);
    const finalMarginRequired = (executionPrice * executionQuantity) / leverage;

    if (order?.status === 'open' || order?.status === 'pending' || executionQuantity === 0) {
      this.logger.info(`EMS: Limit Entry placed but unfilled for ${asset}. Awaiting exchange reconciliation...`);
      trade.status = 'oms_approved'; // Keep it pending
      trade.exchangeOrderId = order.id;
      trade.reasoning = 'Limit Entry placed but unfilled. Awaiting exchange reconciliation...';
      await trade.save();
      return; // EXIT EARLY! Do not push to Portfolio, do not emit ENTRY, prevent naked short!
    }

    trade.status = 'open';
    trade.entryPrice = executionPrice;
    trade.quantity = executionQuantity;
    trade.exchangeOrderId = order?.id;
    trade.executedAt = new Date(order?.timestamp || Date.now());
    trade.fees = actualFee;
    await trade.save();

    const newPos = {
      tradeId: trade._id.toString(),
      asset: trade.asset,
      side: trade.side,
      entryPrice: trade.entryPrice,
      quantity: trade.quantity,
      leverage: trade.leverage,
      unrealizedPnl: 0,
      realizedPnl: 0,
      fees: actualFee,
      stopLoss: stopLoss,
      takeProfit: takeProfit,
      exchangeOrderId: trade.exchangeOrderId,
      highestProfitMilestone: 0,
      openedAt: trade.executedAt,
      status: 'open',
      category: trade.category || 'other',
      trailingAtrMult: trade.metadata?.trailingAtrMult,
      entryAtr: trade.metadata?.entryAtr,
      activeStrategy: trade.metadata?.activeStrategy
    };

    // Prepare atomic update
    let updateQuery = {
      $push: { positions: newPos }
    };
    
    // Margin Cache Poisoning Fix: Deduct margin atomically instead of relying on a potentially stale API cache
    updateQuery.$inc = {
      availableBalance: -(finalMarginRequired + actualFee),
      totalBalance: -actualFee,
      totalPnl: -actualFee,
      dailyLossToday: -actualFee,
      totalTrades: 1
    };
    // Resilient dual-write: Retries portfolio push to prevent Orphaned Trade Deadlock
    let portUpdated = false;
    for (let i = 1; i <= 10; i++) {
      try {
        const portCheck = await Portfolio.findOne({ userId: SYSTEM_USER_ID, 'positions.tradeId': trade._id.toString() });
        if (portCheck) {
          this.logger.info(`Idempotency check: Position ${asset} already exists in portfolio. Skipping duplicate push/inc.`);
          portUpdated = true;
          break;
        }

        const portRes = await Portfolio.findOneAndUpdate({ userId: SYSTEM_USER_ID }, updateQuery);
        if (portRes) {
          portUpdated = true;
          break;
        }
      } catch (e) {
        this.logger.warn(`Failed to push position ${asset} to Portfolio (Attempt ${i}/10): ${e.message}`);
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i - 1))); // Exponential backoff
      }
    }

    if (!portUpdated) {
      this.logger.error(`CRITICAL: EMS permanently failed to push ${asset} to Portfolio! Trade ${trade._id} is orphaned.`);
    }

    this.logger.info(`EMS: Successfully entered ${side} position on ${asset} at ${executionPrice}`);

    if (trade.metadata?.autonomousAlert) {
      import('../../services/telegramService.js').then(({ sendTelegramMessage }) => {
        sendTelegramMessage(`🚨 **AI Risk Copilot Alert**\n**Asset:** ${asset}\n**Strategy:** ${trade.metadata.activeStrategy?.toUpperCase()}\n**Event:** ${trade.metadata.autonomousAlert}`);
      }).catch(() => {});
    }

    // Broadcast success so StopLoss/TakeProfit services can place trigger orders
    await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
      type: 'ENTRY',
      asset,
      side,
      quantity: executionQuantity,
      price: executionPrice,
      tradeId: trade._id,
      stopLoss,
      takeProfit,
      leverage: trade.leverage,
      trailingAtrMult: trade.metadata?.trailingAtrMult,
      entryAtr: trade.metadata?.entryAtr
    });
  }

  async executeExit(payload) {
    const { asset, side, quantity, reason, currentPrice } = payload;
    
    // STRICT PRE-FLIGHT LOCK: Verify the position is actually still open!
    // 🛡️ FIX: Atomic Database Locking to completely prevent Naked Short concurrency bugs.
    let activeTrade = await Trade.findOneAndUpdate(
      { asset, status: 'open' },
      { $set: { status: 'closing_in_progress' } },
      { new: true, sort: { createdAt: -1 } }
    );

    if (!activeTrade) {
      this.logger.warn(`EMS: Ignoring duplicate exit request for ${asset}. Position is already closed or locked by another agent.`);
      return;
    }

    let attempt = 0;
    let order = null;
    let successfullyClosed = false;

    try {
      let portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
    const exitOrderType = payload.forceMarket ? 'market' : (portfolio?.exitOrderType || 'market');
    const exitSide = side === 'long' ? 'sell' : 'buy';

    // Runway Clearance: Destroy any stale limit exits before placing a new one
    if (activeTrade.type !== 'paper') {
      try {
        const { cancelAllOrders } = await import('../../services/exchangeService.js');
        await cancelAllOrders(asset);
        this.logger.info(`EMS cleared existing open orders for ${asset} to prioritize new exit order.`);
      } catch (cancelErr) {
         this.logger.warn(`EMS failed to clear open orders for ${asset}: ${cancelErr.message}`);
      }
    }

    while (attempt < this.maxRetries) {
      try {
        attempt++;
        if (activeTrade.type === 'paper') {
          order = {
            id: `paper_exit_${Date.now()}`,
            status: 'closed',
            price: currentPrice,
            filled: quantity,
            average: currentPrice,
            fee: { cost: currentPrice * quantity * 0.005 }
          };
          await new Promise(r => setTimeout(r, 500));
        } else {
          if (exitOrderType === 'market') {
            order = await placeMarketOrder(asset, exitSide, quantity, true, activeTrade.leverage);
          } else {
            // Send Limit Order with current price as limit
            order = await placeLimitOrder(asset, exitSide, quantity, currentPrice, true, activeTrade.leverage);
          }
        }
        break;
      } catch (err) {
        this.logger.warn(`EMS Exit Order attempt ${attempt}/${this.maxRetries} failed for ${asset}: ${err.message}`);
        if (attempt >= this.maxRetries) {
          this.logger.error(`EMS failed to exit ${asset} after ${this.maxRetries} attempts`);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    this.logger.info(`EMS: Successfully exited ${side} position on ${asset}. Reason: ${reason}`);

    let trade = activeTrade;
    let isPartialFill = false;
    let currentFillPnl = 0;
    let currentFillFee = 0;
    let currentFillQty = 0;

    if (trade) {
      if (order?.status === 'open' || order?.status === 'pending') {
        this.logger.info(`EMS: Limit Exit placed but unfilled for ${asset}. Awaiting exchange reconciliation...`);
        trade.exchangeOrderId = order.id;
        trade.reasoning = `Limit Exit placed but unfilled. Awaiting exchange reconciliation...`;
        // 🛡️ FIX: Revert the lock so ReconciliationAgent can align it when it fills!
        trade.status = 'open';
        await trade.save();
        return; // EXIT EARLY! Let TrailingAgent retry or ReconciliationAgent sync later.
      }

      let exitPrice = order?.average || order?.price || currentPrice;

      // Absolute fallback: If exitPrice is still missing (e.g. market order response lacks average/price), aggressively fetch REST ticker
      if (!exitPrice || isNaN(exitPrice) || exitPrice <= 0) {
        let tickerSuccess = false;
        let tickerAttempt = 0;
        while (tickerAttempt < 3 && !tickerSuccess) {
          try {
            tickerAttempt++;
            const { fetchTicker } = await import('../../services/exchangeService.js');
            const ticker = await fetchTicker(asset);
            if (ticker && ticker.last > 0) {
               exitPrice = ticker.last;
               this.logger.info(`EMS: Rescued missing exit price for ${asset} using REST ticker fallback: $${exitPrice}`);
               tickerSuccess = true;
            }
          } catch (e) {
             this.logger.warn(`EMS Ticker fallback attempt ${tickerAttempt} failed for ${asset}: ${e.message}`);
             if (tickerAttempt < 3) await new Promise((r) => setTimeout(r, 1000 * tickerAttempt));
          }
        }
        
        // If we still can't find an exit price, fallback to entryPrice to prevent artificial 100% PNL spikes
        if (!exitPrice || isNaN(exitPrice) || exitPrice <= 0) {
          this.logger.error(`FATAL: Missing exit price and ticker fallback exhausted for ${asset}. Defaulting to entryPrice for zero PNL.`);
          exitPrice = trade.entryPrice; 
        }
      }

      currentFillQty = (order?.filled && order.filled > 0) ? order.filled : quantity;
      
      // Calculate Realized PnL strictly for the filled portion
      currentFillPnl = side === 'long' 
        ? (exitPrice - trade.entryPrice) * currentFillQty 
        : (trade.entryPrice - exitPrice) * currentFillQty;
      
      const futuresTakerFeeRate = 0.0005;
      currentFillFee = (exitPrice * currentFillQty) * futuresTakerFeeRate;

      const epsilon = 1e-8;
      if (trade.quantity - currentFillQty > epsilon) {
        isPartialFill = true;
        trade.quantity -= currentFillQty;
        trade.pnl = (trade.pnl || 0) + currentFillPnl;
        trade.fees = (trade.fees || 0) + currentFillFee;
        trade.reasoning = `${reason} (Partial Fill: ${currentFillQty})`;
        // 🛡️ FIX: Revert the lock for the remaining portion of the partial fill!
        trade.status = 'open';
        this.logger.info(`EMS: Partial Exit filled ${currentFillQty}. Remaining: ${trade.quantity} for ${asset}`);

        // 🛡️ Round 69: Immediate Resize Patch to prevent Naked Short Window
        try {
          const { cancelAllOrders, placeTriggerOrder } = await import('../../services/exchangeService.js');
          this.logger.info(`EMS: Instantly resizing native triggers for ${asset} to ${trade.quantity}...`);
          await cancelAllOrders(asset);
          
          const exitSide = side === 'long' ? 'sell' : 'buy';
          
          let virtualFlagsUpdated = false;
          if (trade.stopLoss && trade.stopLoss > 0 && !trade.hasVirtualStop) {
            try {
              await placeTriggerOrder(asset, exitSide, trade.quantity, trade.stopLoss, 'STOP_MARKET');
            } catch (slErr) {
              this.logger.error(`EMS failed to resize native Stop Loss for ${asset}. Activating Virtual Watchdog!`);
              trade.hasVirtualStop = true;
              virtualFlagsUpdated = true;
            }
          }
          
          if (trade.takeProfit && trade.takeProfit > 0 && !trade.hasVirtualTakeProfit) {
            try {
              await placeTriggerOrder(asset, exitSide, trade.quantity, trade.takeProfit, 'TAKE_PROFIT_MARKET');
            } catch (tpErr) {
              this.logger.error(`EMS failed to resize native Take Profit for ${asset}. Activating Virtual Watchdog!`);
              trade.hasVirtualTakeProfit = true;
              virtualFlagsUpdated = true;
            }
          }
          
          if (virtualFlagsUpdated) {
            await Portfolio.updateOne(
              { userId: SYSTEM_USER_ID, "positions.asset": asset, "positions.status": "open" },
              { $set: { 
                  "positions.$.hasVirtualStop": trade.hasVirtualStop || false,
                  "positions.$.hasVirtualTakeProfit": trade.hasVirtualTakeProfit || false
              }}
            );
            const updatedPortfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID }).lean();
            if (updatedPortfolio) {
              const { publishEvent, CHANNELS } = await import('../../config/redis.js');
              await publishEvent(CHANNELS.PORTFOLIO_UPDATES, updatedPortfolio);
            }
          }
        } catch (resizeErr) {
          this.logger.error(`EMS critical failure during immediate trigger resize for ${asset}: ${resizeErr.message}`);
        }
      } else {
        trade.status = 'closed';
        trade.exitPrice = exitPrice;
        trade.pnl = (trade.pnl || 0) + currentFillPnl;
        trade.fees = (trade.fees || 0) + currentFillFee;
        trade.pnlPercent = trade.entryPrice > 0 ? (trade.pnl / (trade.entryPrice * (trade.quantity + currentFillQty))) * 100 : 0;
        trade.closedAt = new Date();
        trade.reasoning = reason;
      }

      await trade.save();
    }

    // ONLY cancel native trigger orders (Stop Loss / Take Profit) if the position is fully closed
    if (!isPartialFill) {
      try {
        this.logger.info(`EMS: Cancelling all open trigger orders for ${asset}...`);
        await cancelAllOrders(asset);
      } catch (cancelErr) {
        this.logger.warn(`EMS failed to cancel native trigger orders for ${asset}: ${cancelErr.message}`);
      }
    }

    // Instantly update the position in Portfolio to prevent OMS duplicate blocking
    try {
      let updateQuery = {};

      if (trade && currentFillQty > 0) {
        let netPnl = currentFillPnl - currentFillFee;
        const marginRestored = (trade.entryPrice * currentFillQty) / (trade.leverage || 1);
        
        if (isPartialFill) {
          updateQuery.$inc = {
            "positions.$.quantity": -currentFillQty,
            "positions.$.realizedPnl": currentFillPnl,
            "positions.$.realizedFees": currentFillFee,
            totalPnl: netPnl,
            dailyLossToday: netPnl,
            availableBalance: marginRestored + netPnl,
            totalBalance: netPnl
          };
        } else {
          updateQuery.$pull = { positions: { asset: asset, status: 'open' } };
          updateQuery.$inc = {
            totalPnl: netPnl,
            dailyLossToday: netPnl,
            availableBalance: marginRestored + netPnl,
            totalBalance: netPnl
          };
          
          // 🛡️ FIX: Only count winning/losing trades when the ENTIRE position is closed to prevent Statistical Inflation
          const finalNetPnl = trade.pnl - trade.fees;
          if (finalNetPnl >= 0) {
            updateQuery.$inc.winningTrades = 1;
          } else {
            updateQuery.$inc.losingTrades = 1;
          }
        }
        
        let portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
        if (portfolio) {
          const newTotal = portfolio.totalBalance + netPnl;
          updateQuery.$max = { peakBalance: newTotal };
          
          // 🛡️ FIX: Recalculate and revive the dead Win Rate using exact DB values + current trade outcome
          if (!isPartialFill) {
            const finalNetPnl = trade.pnl - trade.fees;
            const newWinningTrades = portfolio.winningTrades + (finalNetPnl >= 0 ? 1 : 0);
            const newLosingTrades = portfolio.losingTrades + (finalNetPnl < 0 ? 1 : 0);
            const newTotalClosed = newWinningTrades + newLosingTrades;
            
            if (newTotalClosed > 0) {
              updateQuery.$set = { winRate: newWinningTrades / newTotalClosed };
            }
          }
        }
      }

      if (Object.keys(updateQuery).length > 0) {
        await Portfolio.findOneAndUpdate(
          { userId: SYSTEM_USER_ID, "positions.asset": asset, "positions.status": "open" },
          updateQuery
        );
      }
    } catch (portErr) {
      this.logger.error(`EMS failed to update portfolio for ${asset}: ${portErr.message}`);
    }

    if (payload.autonomousAlert) {
      import('../../services/telegramService.js').then(({ sendTelegramMessage }) => {
        sendTelegramMessage(payload.autonomousAlert);
      }).catch(() => {});
    }

    // Publish event so PortfolioReconciliationService knows to sync and remove from portfolio
    await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
      type: isPartialFill ? 'PARTIAL_EXIT' : 'EXIT',
      asset,
      quantity: currentFillQty,
      reason
    });
    
    successfullyClosed = true;

    } catch (criticalErr) {
      this.logger.error(`EMS: Critical unexpected error during executeExit for ${asset}: ${criticalErr.message}`);
    } finally {
      if (!successfullyClosed && activeTrade) {
        // Double check status from DB in case it was modified
        const currentTradeState = await Trade.findById(activeTrade._id);
        if (currentTradeState && currentTradeState.status === 'closing_in_progress') {
          this.logger.info(`EMS: Reverting ${asset} lock from closing_in_progress back to open due to failure.`);
          currentTradeState.status = 'open';
          await currentTradeState.save();
        }
      }
    }
  }

  async execute() {}
}
