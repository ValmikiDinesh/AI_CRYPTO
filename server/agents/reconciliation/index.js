import { SYSTEM_USER_ID } from '../../config/constants.js';
import BaseAgent from '../base/BaseAgent.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { getExchange, cancelAllOrders } from '../../services/exchangeService.js';
import Trade from '../../models/Trade.js';
import Portfolio from '../../models/Portfolio.js';

export default class ReconciliationAgent extends BaseAgent {
  constructor() {
    super('reconciliation');
    this.syncIntervalMs = 60000; // Sync every 60 seconds
    this.isSyncing = false;
  }

  async initialize() {
    this.logger.info('Initializing Portfolio Reconciliation Service...');
    
    // Start periodic sync
    setInterval(() => this.runSync(), this.syncIntervalMs);
  }

  async runSync() {
    if (this.isSyncing) return;
    this.isSyncing = true;
    try {
      await this.syncClosedTradesFromExchange();
      await this.syncAlienPositionsFromExchange();
      await this.syncMissingTriggersFromExchange();
      await this.cleanupGhostLocksFromExchange();

      // Live Balance Hard-Sync: Ensure totalBalance and availableBalance match exchange exactly
      try {
        const { fetchBalance } = await import('../../services/exchangeService.js');
        const liveBal = await fetchBalance(true);
        if (liveBal && liveBal.USDT) {
          const updatedPort = await Portfolio.findOneAndUpdate(
            { userId: SYSTEM_USER_ID },
            { $set: { 
                availableBalance: liveBal.USDT.free, 
                totalBalance: liveBal.USDT.total
              } 
            },
            { new: true }
          );
          
          // Broadcast the global sync to all active dynamic agents (Basket, Sweep, Scalp, Trailing)
          if (updatedPort) {
            const { publishEvent, CHANNELS } = await import('../../config/redis.js');
            await publishEvent(CHANNELS.PORTFOLIO_UPDATES, updatedPort.toObject ? updatedPort.toObject() : updatedPort);
          }
        }
      } catch (balErr) {
        this.logger.warn(`Failed to hard-sync live balance: ${balErr.message}`);
      }
      await this.syncQuantityMismatches();
      await this.cleanupStalePositions();
      await this.sweepGhostPositionsFromDatabase();
      await this.cleanupOrphanedExchangeOrders();
    } catch (err) {
      this.logger.error(`Reconciliation sync error: ${err.message}`);
    } finally {
      this.isSyncing = false;
    }
  }

  async syncQuantityMismatches() {
    try {
      const exchange = getExchange();
      if (exchange.isDemo) return;

      const livePositions = await exchange.fetchPositions();
      if (!livePositions || livePositions.length === 0) return;

      const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
      if (!portfolio) return;

      for (const pos of livePositions) {
        if (!pos.symbol || pos.contracts <= 0) continue;
        const normalizedSymbol = pos.symbol.split(':')[0].replace('/', '').toUpperCase();
        
        const openTrade = await Trade.findOne({ asset: normalizedSymbol, status: 'open' });
        if (openTrade && openTrade.quantity !== pos.contracts) {
          this.logger.warn(`⚠️ [RECONCILIATION] Quantity mismatch for ${normalizedSymbol}! DB: ${openTrade.quantity} | Live: ${pos.contracts}`);
          
          if (pos.contracts < openTrade.quantity) {
            // Prevent PnL destruction: Check if there are partially filled OPEN exit orders
            const allOpenOrders = await exchange.fetchOpenOrders(normalizedSymbol).catch(() => []);
            const hasPartialExit = allOpenOrders.some(o => o.filled > 0 && o.side !== openTrade.side);
            
            if (hasPartialExit) {
              this.logger.warn(`⏳ [RECONCILIATION] Partial Close detected, but an Exit Order is currently OPEN and partially filled. Deferring resize to prevent PnL destruction.`);
              continue; // Skip this asset, let syncClosedTradesFromExchange handle it when it finishes!
            }

            this.logger.info(`🧹 [RECONCILIATION] Partial Close detected. Resizing database position and recreating safety triggers...`);
            
            // 1. Update Database to match the new, smaller live quantity
            openTrade.quantity = pos.contracts;
            await openTrade.save();
            
            await Portfolio.updateOne(
              { userId: SYSTEM_USER_ID, "positions.asset": normalizedSymbol, "positions.status": "open" },
              { $set: { "positions.$.quantity": pos.contracts } }
            );

            // 2. Cancel all old oversized trigger limit orders on the exchange
            try {
              const { cancelAllOrders, placeTriggerOrder } = await import('../../services/exchangeService.js');
              await cancelAllOrders(normalizedSymbol);
              
              // 3. Re-issue perfectly sized trigger limit orders
              const exitSide = openTrade.side === 'long' ? 'sell' : 'buy';
              
              if (openTrade.stopLoss && openTrade.stopLoss > 0) {
                try {
                  await placeTriggerOrder(normalizedSymbol, exitSide, openTrade.quantity, openTrade.stopLoss, 'STOP_MARKET');
                  this.logger.info(`✅ Re-issued Stop Loss for ${normalizedSymbol} at resized quantity: ${openTrade.quantity}`);
                } catch (slErr) {
                  this.logger.error(`⚠️ Failed to re-issue native Stop Loss for ${normalizedSymbol}. Activating Virtual Watchdog!`);
                  await Trade.updateOne({ asset: normalizedSymbol, status: 'open' }, { $set: { hasVirtualStop: true } });
                  await Portfolio.updateOne(
                    { userId: SYSTEM_USER_ID, "positions.asset": normalizedSymbol, "positions.status": "open" },
                    { $set: { "positions.$.hasVirtualStop": true } }
                  );
                }
              }
              
              if (openTrade.takeProfit && openTrade.takeProfit > 0) {
                try {
                  await placeTriggerOrder(normalizedSymbol, exitSide, openTrade.quantity, openTrade.takeProfit, 'TAKE_PROFIT_MARKET');
                  this.logger.info(`✅ Re-issued Take Profit for ${normalizedSymbol} at resized quantity: ${openTrade.quantity}`);
                } catch (tpErr) {
                  this.logger.error(`⚠️ Failed to re-issue native Take Profit for ${normalizedSymbol}. Activating Virtual Watchdog!`);
                  await Trade.updateOne({ asset: normalizedSymbol, status: 'open' }, { $set: { hasVirtualTakeProfit: true } });
                  await Portfolio.updateOne(
                    { userId: SYSTEM_USER_ID, "positions.asset": normalizedSymbol, "positions.status": "open" },
                    { $set: { "positions.$.hasVirtualTakeProfit": true } }
                  );
                }
              }

              // Broadcast portfolio update so Virtual Watchdogs immediately sync the newly activated virtual triggers
              const updatedPortfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID }).lean();
              if (updatedPortfolio) {
                const { publishEvent, CHANNELS } = await import('../../config/redis.js');
                await publishEvent(CHANNELS.PORTFOLIO_UPDATES, updatedPortfolio);
              }
            } catch (err) {
              this.logger.error(`Failed during resized trigger re-issue flow for ${normalizedSymbol}: ${err.message}`);
            }
          } else if (pos.contracts > openTrade.quantity) {
            const addedQty = pos.contracts - openTrade.quantity;
            this.logger.info(`📈 [RECONCILIATION] Delayed Partial Entry Fill detected for ${normalizedSymbol}. Adding ${addedQty} to database position...`);

            // 1. Update Database to match the new, larger live quantity
            openTrade.quantity = pos.contracts;
            await openTrade.save();
            
            // Note: Since this was a delayed entry fill, we must ALSO charge the entry fee and deduct margin for the newly added quantity!
            const addedMargin = (openTrade.entryPrice * addedQty) / (openTrade.leverage || 1);
            const addedFee = (openTrade.entryPrice * addedQty) * 0.0002;

            await Portfolio.updateOne(
              { userId: SYSTEM_USER_ID, "positions.asset": normalizedSymbol, "positions.status": "open" },
              { 
                $set: { "positions.$.quantity": pos.contracts },
                $inc: { 
                  "positions.$.fees": addedFee,
                  availableBalance: -addedMargin - addedFee,
                  totalBalance: -addedFee,
                  dailyLossToday: -addedFee,
                  totalPnl: -addedFee
                }
              }
            );

            // 2. Cancel oversized trigger orders and re-issue larger triggers
            try {
              const { cancelAllOrders, placeTriggerOrder } = await import('../../services/exchangeService.js');
              await cancelAllOrders(normalizedSymbol);
              
              const exitSide = openTrade.side === 'long' ? 'sell' : 'buy';
              
              if (openTrade.stopLoss && openTrade.stopLoss > 0 && !openTrade.hasVirtualStop) {
                try {
                  await placeTriggerOrder(normalizedSymbol, exitSide, openTrade.quantity, openTrade.stopLoss, 'STOP_MARKET');
                } catch (slErr) {
                  this.logger.error(`⚠️ Failed to re-issue expanded Stop Loss for ${normalizedSymbol}. Activating Virtual Watchdog!`);
                  await Trade.updateOne({ asset: normalizedSymbol, status: 'open' }, { $set: { hasVirtualStop: true } });
                  await Portfolio.updateOne({ userId: SYSTEM_USER_ID, "positions.asset": normalizedSymbol, "positions.status": "open" }, { $set: { "positions.$.hasVirtualStop": true } });
                }
              }
              
              if (openTrade.takeProfit && openTrade.takeProfit > 0 && !openTrade.hasVirtualTakeProfit) {
                try {
                  await placeTriggerOrder(normalizedSymbol, exitSide, openTrade.quantity, openTrade.takeProfit, 'TAKE_PROFIT_MARKET');
                } catch (tpErr) {
                  this.logger.error(`⚠️ Failed to re-issue expanded Take Profit for ${normalizedSymbol}. Activating Virtual Watchdog!`);
                  await Trade.updateOne({ asset: normalizedSymbol, status: 'open' }, { $set: { hasVirtualTakeProfit: true } });
                  await Portfolio.updateOne({ userId: SYSTEM_USER_ID, "positions.asset": normalizedSymbol, "positions.status": "open" }, { $set: { "positions.$.hasVirtualTakeProfit": true } });
                }
              }
              
              const updatedPortfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID }).lean();
              if (updatedPortfolio) {
                const { publishEvent, CHANNELS } = await import('../../config/redis.js');
                await publishEvent(CHANNELS.PORTFOLIO_UPDATES, updatedPortfolio);
              }
            } catch (err) {
              this.logger.error(`Failed during expanded trigger re-issue flow for ${normalizedSymbol}: ${err.message}`);
            }
          }
        }
      }
    } catch (err) {
      this.logger.error(`Failed to sync quantity mismatches: ${err.message}`);
    }
  }

  parseOrderTimestamp(timestamp) {
    if (!timestamp) return new Date(0);
    if (typeof timestamp === 'number') {
      return timestamp < 1000000000000 ? new Date(timestamp * 1000) : new Date(timestamp);
    }
    const d = new Date(timestamp);
    return isNaN(d.getTime()) ? new Date(0) : d;
  }

  async syncClosedTradesFromExchange() {
    try {
      const exchange = getExchange();
      if (exchange.isDemo) return;

      const closedOrders = await exchange.fetchClosedOrders(undefined, undefined, 50);
      const executedOrders = (closedOrders || []).filter(o => (o.status === 'closed' || (o.status === 'canceled' && o.filled > 0)) && o.filled > 0);

      for (const order of executedOrders) {
        const asset = order.symbol.split(':')[0].replace('/', '').toUpperCase();

        const openTrade = await Trade.findOne({ asset, status: 'open' });
        
        // Ensure this closed order is an EXIT for the current open position
        const isExit = openTrade ? (openTrade.side === 'long' ? order.side === 'sell' : order.side === 'buy') : false;
        
        // Strict Temporal Validation: Ensure the closed order actually occurred AFTER this specific trade was opened
        const orderTime = this.parseOrderTimestamp(order.timestamp || order.raw?.updated_at || order.raw?.created_at).getTime();
        
        const tradeStartTime = (openTrade && (openTrade.executedAt || openTrade.createdAt)) ? (openTrade.executedAt || openTrade.createdAt).getTime() : 0;
        if (openTrade && isExit && orderTime > tradeStartTime) {
          if (openTrade.metadata && openTrade.metadata.processedOrderIds && openTrade.metadata.processedOrderIds.includes(order.id)) {
            continue;
          }
          
          this.logger.info(`🔄 [RECONCILIATION] Updating open position trade for ${asset} to closed via exchange order ${order.id}...`);
          
          // Market orders (like Native Stops) often have price=undefined but average=actual fill
          const exitPrice = order.average || order.price || openTrade.entryPrice;
          
          const rawPnl = order.realisedPnl || order.raw?.realised_pnl || 0;
          let rawFeeVal = parseFloat(order.executionFee || order.raw?.execution_fee || 0);
          
          let portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
          const usdToInr = portfolio?.usdToInrRate || 96.54;
          
          // CRITICAL FIX: CoinSwitch PRO charges and reports fees in INR!
          // We must convert the raw INR fee to USDT to prevent catastrophic artificial inflation of daily losses.
          if (rawFeeVal > 0) {
            rawFeeVal = rawFeeVal / usdToInr;
          }

          const feeUsdt = rawFeeVal || (exitPrice * order.filled * 0.0010);
          const finalPnl = (rawPnl !== 0) ? rawPnl : (
            openTrade.side === 'long'
              ? (exitPrice - openTrade.entryPrice) * order.filled
              : (openTrade.entryPrice - exitPrice) * order.filled
          );

          let netPnl = finalPnl - feeUsdt;

          const epsilon = 1e-8;
          if (openTrade.quantity - order.filled > epsilon) {
            this.logger.info(`🔄 [RECONCILIATION] Partial manual exit detected for ${asset}. Subtracting ${order.filled} from open quantity.`);
            openTrade.quantity -= order.filled;
            openTrade.pnl = (openTrade.pnl || 0) + finalPnl;
            openTrade.fees = (openTrade.fees || 0) + feeUsdt;
            if (!openTrade.metadata) openTrade.metadata = {};
            if (!openTrade.metadata.processedOrderIds) openTrade.metadata.processedOrderIds = [];
            openTrade.metadata.processedOrderIds.push(order.id);
            openTrade.markModified('metadata');
            await openTrade.save();
            
            if (portfolio) {
              const marginRestored = (openTrade.entryPrice * order.filled) / (openTrade.leverage || 1);
              let newTotal = portfolio.totalBalance + netPnl;
              
              let updateQuery = {
                $inc: { 
                  'positions.$.quantity': -order.filled, 
                  'positions.$.realizedPnl': finalPnl, 
                  'positions.$.fees': feeUsdt,
                  totalPnl: netPnl,
                  dailyLossToday: netPnl,
                  availableBalance: marginRestored + netPnl,
                  totalBalance: netPnl
                },
                $max: { peakBalance: newTotal }
              };

              // 🛡️ FIX: DO NOT increment winningTrades/losingTrades on Partial Exits to prevent Statistical Inflation
              // We just update PnL and balances.
              await Portfolio.updateOne(
                { userId: SYSTEM_USER_ID, 'positions.asset': asset, 'positions.status': 'open' },
                updateQuery
              );
            }
            
            // 🛡️ Round 91: Immediate Resize Patch to prevent Naked Short Window on Manual Partial Exits
            try {
              const { cancelAllOrders, placeTriggerOrder } = await import('../../services/exchangeService.js');
              this.logger.info(`🔄 [RECONCILIATION] Instantly resizing native triggers for ${asset} to new quantity: ${openTrade.quantity}...`);
              await cancelAllOrders(asset);
              
              const exitSide = openTrade.side === 'long' ? 'sell' : 'buy';
              
              let virtualFlagsUpdated = false;
              if (openTrade.stopLoss && openTrade.stopLoss > 0 && !openTrade.hasVirtualStop) {
                try {
                  await placeTriggerOrder(asset, exitSide, openTrade.quantity, openTrade.stopLoss, 'STOP_MARKET');
                } catch (slErr) {
                  this.logger.error(`ReconciliationAgent failed to resize native Stop Loss for ${asset}. Activating Virtual Watchdog!`);
                  openTrade.hasVirtualStop = true;
                  await openTrade.save();
                  await Portfolio.updateOne(
                    { userId: SYSTEM_USER_ID, "positions.asset": asset, "positions.status": "open" },
                    { $set: { "positions.$.hasVirtualStop": true } }
                  );
                  virtualFlagsUpdated = true;
                }
              }
              
              if (openTrade.takeProfit && openTrade.takeProfit > 0 && !openTrade.hasVirtualTakeProfit) {
                try {
                  await placeTriggerOrder(asset, exitSide, openTrade.quantity, openTrade.takeProfit, 'TAKE_PROFIT_MARKET');
                } catch (tpErr) {
                  this.logger.error(`ReconciliationAgent failed to resize native Take Profit for ${asset}. Activating Virtual Watchdog!`);
                  openTrade.hasVirtualTakeProfit = true;
                  await openTrade.save();
                  await Portfolio.updateOne(
                    { userId: SYSTEM_USER_ID, "positions.asset": asset, "positions.status": "open" },
                    { $set: { "positions.$.hasVirtualTakeProfit": true } }
                  );
                  virtualFlagsUpdated = true;
                }
              }
              
              if (virtualFlagsUpdated) {
                const updatedPortfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID }).lean();
                if (updatedPortfolio) {
                  const { publishEvent, CHANNELS } = await import('../../config/redis.js');
                  await publishEvent(CHANNELS.PORTFOLIO_UPDATES, updatedPortfolio);
                }
              }
            } catch (resizeErr) {
              this.logger.error(`ReconciliationAgent critical failure during immediate trigger resize for ${asset}: ${resizeErr.message}`);
            }

            await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
              type: 'PARTIAL_EXIT',
              asset,
              quantity: order.filled,
              reason: 'Partial Fill Reconciled'
            });
            
            continue;
          }

          openTrade.status = 'closed';
          openTrade.exitPrice = exitPrice;
          openTrade.pnl = (openTrade.pnl || 0) + finalPnl;
          openTrade.fees = (openTrade.fees || 0) + feeUsdt;
          openTrade.pnlPercent = openTrade.entryPrice > 0 ? (finalPnl / (openTrade.entryPrice * order.filled)) * 100 : 0;
          openTrade.closedAt = this.parseOrderTimestamp(order.timestamp || order.raw?.updated_at || order.raw?.created_at);
          openTrade.exchangeOrderId = openTrade.exchangeOrderId || order.id;
          openTrade.reasoning = order.raw?.order_type === 'STOP_MARKET' 
            ? 'Stop-Loss Triggered on Exchange' 
            : order.raw?.order_type === 'TAKE_PROFIT_MARKET' 
              ? 'Take-Profit Triggered on Exchange' 
              : 'Position Closed on Exchange';
          await openTrade.save();

          try {
            if (portfolio) {
              const marginRestored = (openTrade.entryPrice * order.filled) / (openTrade.leverage || 1);
              let newTotal = portfolio.totalBalance + netPnl;
              
              let updateQuery = {
                $pull: { positions: { asset: asset, status: 'open' } },
                $inc: {
                  totalPnl: netPnl,
                  dailyLossToday: netPnl,
                  availableBalance: marginRestored + netPnl,
                  totalBalance: netPnl
                },
                $max: { peakBalance: newTotal }
              };

              // 🛡️ FIX: Only count winning/losing trades when the ENTIRE position is closed to prevent Statistical Inflation
              const finalNetPnl = openTrade.pnl - openTrade.fees;
              if (finalNetPnl >= 0) {
                updateQuery.$inc.winningTrades = 1;
              } else {
                updateQuery.$inc.losingTrades = 1;
              }
              
              // 🛡️ FIX: Recalculate and revive the dead Win Rate using exact DB values + current trade outcome
              const newWinningTrades = portfolio.winningTrades + (finalNetPnl >= 0 ? 1 : 0);
              const newLosingTrades = portfolio.losingTrades + (finalNetPnl < 0 ? 1 : 0);
              const newTotalClosed = newWinningTrades + newLosingTrades;
              
              if (newTotalClosed > 0) {
                updateQuery.$set = { winRate: newWinningTrades / newTotalClosed };
              }

              await Portfolio.updateOne(
                { userId: SYSTEM_USER_ID, "positions.asset": asset, "positions.status": "open" },
                updateQuery
              );
            }
          } catch (portErr) {
            this.logger.error(`Reconciliation failed to remove ${asset} from portfolio: ${portErr.message}`);
          }

          // Cancel any lingering trigger orders for this manually closed position
          try {
            this.logger.info(`🧹 [RECONCILIATION] Cancelling orphaned native trigger orders for ${asset}...`);
            await cancelAllOrders(asset);
          } catch (cancelErr) {
            this.logger.warn(`Failed to clean up trigger orders for ${asset}: ${cancelErr.message}`);
          }

          await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
            type: 'EXIT',
            asset,
            reason: openTrade.reasoning
          });
          continue;
        }
      }
    } catch (err) {
      this.logger.error(`Failed to sync closed trades from exchange: ${err.message}`);
    }
  }

  async syncAlienPositionsFromExchange() {
    try {
      const exchange = getExchange();
      if (exchange.isDemo) return;

      const livePositions = await exchange.fetchPositions();
      if (!livePositions || livePositions.length === 0) return;

      const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
      if (!portfolio) return;

      const dbAssets = new Set((portfolio.positions || []).filter(p => p.status === 'open').map(p => p.asset));

      for (const pos of livePositions) {
        if (!pos.symbol || pos.contracts <= 0) continue;
        const normalizedSymbol = pos.symbol.split(':')[0].replace('/', '').toUpperCase();
        
        // If the exchange has a live position that the DB DOES NOT have (Alien Position)
        if (!dbAssets.has(normalizedSymbol)) {
          
          // 🛡️ FIX: Orphaned Trade Cloning Bug. Check if it's an AI Limit Order OR an orphaned OPEN trade!
          const pendingTrade = await Trade.findOne({ asset: normalizedSymbol, status: { $in: ['oms_approved', 'open'] } });
          
          if (pendingTrade) {
            this.logger.info(`✅ [RECONCILIATION] Pending Limit Order Filled! Activating ${normalizedSymbol}...`);
            pendingTrade.status = 'open';
            pendingTrade.entryPrice = pos.entryPrice;
            pendingTrade.quantity = pos.contracts;
            await pendingTrade.save();
            
            const marginRequired = (pos.entryPrice * pos.contracts) / (pendingTrade.leverage || 1);
            const estimatedFee = (pos.entryPrice * pos.contracts) * 0.0002;
            pendingTrade.fees = estimatedFee;
            await pendingTrade.save();

            await Portfolio.updateOne(
              { userId: SYSTEM_USER_ID },
              {
                $push: {
                  positions: {
                    tradeId: pendingTrade._id.toString(),
                    asset: normalizedSymbol,
                    side: pendingTrade.side,
                    entryPrice: pendingTrade.entryPrice,
                    quantity: pendingTrade.quantity,
                    leverage: pendingTrade.leverage,
                    unrealizedPnl: 0,
                    realizedPnl: 0,
                    fees: estimatedFee, // FIX: Estimated Opening Fee
                    stopLoss: pendingTrade.stopLoss,
                    takeProfit: pendingTrade.takeProfit,
                    exchangeOrderId: pendingTrade.exchangeOrderId,
                    highestProfitMilestone: 0,
                    status: 'open',
                    openedAt: new Date(),
                    category: pendingTrade.category || 'other',
                    activeStrategy: pendingTrade.metadata?.activeStrategy
                  }
                },
                $inc: {
                  availableBalance: -(marginRequired + estimatedFee),
                  totalBalance: -estimatedFee,
                  totalPnl: -estimatedFee,
                  dailyLossToday: -estimatedFee,
                  totalTrades: 1
                }
              }
            );
            
            await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
              type: 'ENTRY',
              asset: normalizedSymbol,
              side: pendingTrade.side,
              quantity: pos.contracts,
              price: pos.entryPrice,
              tradeId: pendingTrade._id,
              stopLoss: pendingTrade.stopLoss,
              takeProfit: pendingTrade.takeProfit,
              leverage: pendingTrade.leverage
            });
            continue;
          }

          this.logger.info(`👽 [RECONCILIATION] Alien Position Detected! Adopting unmanaged manual trade for ${normalizedSymbol} into Risk Engine...`);
          
          const newTrade = await Trade.create({
            userId: SYSTEM_USER_ID,
            action: pos.side === 'long' ? 'BUY' : 'SELL',
            asset: normalizedSymbol,
            status: 'open',
            side: pos.side === 'long' ? 'long' : 'short',
            entryPrice: pos.entryPrice,
            quantity: pos.contracts,
            leverage: pos.leverage || 1,
            exchangeOrderId: 'alien_adopted',
            reasoning: 'Alien Position Adopted from Exchange',
            type: 'live'
          });

          const marginRequired = (pos.entryPrice * pos.contracts) / (pos.leverage || 1);
          const estimatedFee = (pos.entryPrice * pos.contracts) * 0.0002;
          
          newTrade.fees = estimatedFee;
          await newTrade.save();

          await Portfolio.updateOne(
            { userId: SYSTEM_USER_ID },
            {
              $push: {
                positions: {
                  tradeId: newTrade._id.toString(),
                  asset: normalizedSymbol,
                  side: pos.side === 'long' ? 'long' : 'short',
                  entryPrice: pos.entryPrice,
                  quantity: pos.contracts,
                  leverage: pos.leverage || 1,
                  status: 'open',
                  openedAt: new Date(),
                  fees: estimatedFee,
                  category: 'other'
                }
              },
              $inc: {
                availableBalance: -(marginRequired + estimatedFee),
                totalBalance: -estimatedFee,
                totalPnl: -estimatedFee,
                dailyLossToday: -estimatedFee,
                totalTrades: 1
              }
            }
          );
          
          await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
            type: 'ENTRY',
            asset: normalizedSymbol,
            side: pos.side === 'long' ? 'long' : 'short',
            quantity: pos.contracts,
            price: pos.entryPrice,
            tradeId: newTrade._id
          });
          
          this.logger.info(`✅ [RECONCILIATION] Successfully adopted Alien Position ${pos.symbol}. Risk Management is now tracking it.`);
        } else {
          // The DB DOES have the position. Reconcile the EXACT quantity to detect partial fills / scale-ins.
          const dbPos = portfolio.positions.find(p => p.asset === normalizedSymbol && p.status === 'open');
          if (dbPos && Math.abs(dbPos.quantity - pos.contracts) > 0.001) {
            this.logger.warn(`🔍 [RECONCILIATION] Quantity Mismatch! DB: ${dbPos.quantity}, Exchange: ${pos.contracts}. Adjusting DB for ${normalizedSymbol}...`);
            
            const diff = dbPos.quantity - pos.contracts;
            
            // Update the MongoDB state explicitly
            const openTrade = await Trade.findOne({ asset: normalizedSymbol, status: 'open' });
            if (openTrade) {
              openTrade.quantity = pos.contracts;
              await openTrade.save();
            }
            
            await Portfolio.updateOne(
              { userId: SYSTEM_USER_ID, 'positions.asset': normalizedSymbol, 'positions.status': 'open' },
              { $set: { 'positions.$.quantity': pos.contracts } }
            );

            // If pos.contracts < dbPos.quantity, it means a partial exit occurred!
            if (diff > 0) {
              await publishEvent(CHANNELS.TRADE_EXECUTIONS, {
                type: 'PARTIAL_EXIT',
                asset: normalizedSymbol,
                quantity: diff
              });
              this.logger.info(`✅ [RECONCILIATION] Emitted PARTIAL_EXIT for ${normalizedSymbol} (Quantity shrunk by ${diff})`);
            } else {
              this.logger.info(`✅ [RECONCILIATION] Updated DB for ${normalizedSymbol} (Quantity grew by ${Math.abs(diff)})`);
            }
          }
        }
      }
    } catch (err) {
      this.logger.error(`Failed to sync alien positions from exchange: ${err.message}`);
    }
  }

  async cleanupStalePositions() {
    try {
      const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID }).lean();
      if (!portfolio || !portfolio.positions) return;

      const openAssets = portfolio.positions.filter(p => p.status === 'open').map(p => p.asset);
      if (openAssets.length === 0) return;

      const closedTrades = await Trade.find({ 
        asset: { $in: openAssets }, 
        status: 'closed' 
      }).sort({ closedAt: -1 }).lean();

      if (!closedTrades.length) return;

      const staleAssetsMap = new Map();
      for (const t of closedTrades) {
        if (!staleAssetsMap.has(t.asset)) {
          staleAssetsMap.set(t.asset, t);
        }
      }

      let cleanedCount = 0;
      for (const [asset, trade] of staleAssetsMap.entries()) {
        // Fix Double-Accounting Inflation Bug: Subtract already realized PnL/Fees from partial fills
        const dbPos = portfolio.positions.find(p => p.asset === asset && p.status === 'open');
        const alreadyRealizedPnl = dbPos ? (dbPos.realizedPnl || 0) : 0;
        const alreadyRealizedFees = dbPos ? (dbPos.realizedFees || 0) : 0;
        const openingFee = dbPos ? (dbPos.fees || 0) : 0;
        
        const uncreditedGrossPnl = (trade.pnl || 0) - alreadyRealizedPnl;
        const uncreditedClosingFee = (trade.fees || 0) - openingFee - alreadyRealizedFees;
        
        const netPnl = uncreditedGrossPnl - Math.max(0, uncreditedClosingFee);
        
        const marginRestored = (trade.entryPrice * trade.quantity) / (trade.leverage || 1);
        const updateQuery = {
          $pull: { positions: { asset: asset, status: 'open' } },
          $inc: {
            totalPnl: netPnl,
            dailyLossToday: netPnl,
            totalBalance: netPnl,
            availableBalance: marginRestored + netPnl,
            winningTrades: netPnl >= 0 ? 1 : 0,
            losingTrades: netPnl < 0 ? 1 : 0
          }
        };

        const result = await Portfolio.updateOne({ userId: SYSTEM_USER_ID, "positions.asset": asset, "positions.status": "open" }, updateQuery);
        if (result.modifiedCount > 0) {
          cleanedCount++;
          
          // 🛡️ FIX: Recalculate winRate
          const latestPort = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
          if (latestPort) {
             const newTotalClosed = (latestPort.winningTrades || 0) + (latestPort.losingTrades || 0);
             if (newTotalClosed > 0) {
                await Portfolio.updateOne(
                  { userId: SYSTEM_USER_ID }, 
                  { $set: { winRate: (latestPort.winningTrades || 0) / newTotalClosed } }
                );
             }
          }

          this.logger.info(`🔄 [RECONCILIATION] Cleaned up stale position ${asset} and tallied PnL: $${netPnl.toFixed(2)}`);
        }
      }

    } catch (err) {
      this.logger.error(`Failed to clean up stale positions: ${err.message}`);
    }
  }

  async syncMissingTriggersFromExchange() {
    try {
      const exchange = getExchange();


      const portfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID }).lean();
      if (!portfolio || !portfolio.positions || portfolio.positions.length === 0) return;

      const openPositions = portfolio.positions.filter(p => p.status === 'open');
      if (openPositions.length === 0) return;

      for (const pos of openPositions) {
        if (!pos.stopLoss && !pos.takeProfit) {
          try {
            const openOrders = await exchange.fetchOpenOrders(pos.asset).catch(() => []);
            const stopOrder = openOrders.find(o => o.type === 'stop_market' || o.raw?.order_type === 'STOP_MARKET');
            const tpOrder = openOrders.find(o => o.type === 'take_profit_market' || o.raw?.order_type === 'TAKE_PROFIT_MARKET');
            let updated = false;
            
            const openTrade = await Trade.findOne({ asset: pos.asset, status: 'open' });
            if (openTrade) {
              if (stopOrder && stopOrder.stopPrice > 0) {
                openTrade.stopLoss = stopOrder.stopPrice;
                pos.stopLoss = stopOrder.stopPrice;
                updated = true;
              }
              if (tpOrder && tpOrder.stopPrice > 0) {
                openTrade.takeProfit = tpOrder.stopPrice;
                pos.takeProfit = tpOrder.stopPrice;
                updated = true;
              }
              
              if (updated) {
                await openTrade.save();
                await Portfolio.updateOne(
                  { userId: SYSTEM_USER_ID, "positions.asset": pos.asset, "positions.status": "open" },
                  { $set: { "positions.$.stopLoss": pos.stopLoss, "positions.$.takeProfit": pos.takeProfit } }
                );
                this.logger.info(`✅ [RECONCILIATION] Adopted Exchange SL/TP triggers for ${pos.asset}`);
              }
            }
          } catch(e) {
            this.logger.warn(`Failed to adopt external triggers for ${pos.asset}: ${e.message}`);
          }
          if (!pos.stopLoss && !pos.takeProfit) continue;
        }
        
        try {
          const openOrders = await exchange.fetchOpenOrders(pos.asset);
          const { cancelOrder, placeTriggerOrder } = await import('../../services/exchangeService.js');
          const exitSide = pos.side === 'long' ? 'sell' : 'buy';
          let virtualFlagsUpdated = false;

          // Verify Stop Loss
          if (pos.stopLoss && pos.stopLoss > 0 && !pos.hasVirtualStop) {
            const stopMarketOrder = openOrders.find(o => o.type === 'stop_market' || o.raw?.order_type === 'STOP_MARKET');
            if (!stopMarketOrder || (stopMarketOrder.amount !== 0 && Math.abs(stopMarketOrder.amount - pos.quantity) > 1e-8)) {
              if (stopMarketOrder) {
                this.logger.warn(`🚨 [RECONCILIATION] Trigger Quantity Mismatch! Stop Loss for ${pos.asset} is ${stopMarketOrder.amount} but position is ${pos.quantity}. Canceling outdated trigger...`);
                await cancelOrder(stopMarketOrder.id, pos.asset);
              } else {
                this.logger.warn(`🚨 [RECONCILIATION] Naked Position Detected! Missing Stop Loss for ${pos.asset}. Re-issuing trigger directly...`);
              }
              
              // 🛡️ Round 94: DIRECT Trigger Re-issue to prevent Trailing Stop Amnesia (Mock ENTRY intercepts)
              try {
                await placeTriggerOrder(pos.asset, exitSide, pos.quantity, pos.stopLoss, 'STOP_MARKET');
              } catch (slErr) {
                this.logger.error(`ReconciliationAgent failed to re-issue native Stop Loss for ${pos.asset}. Activating Virtual Watchdog!`);
                pos.hasVirtualStop = true;
                await Trade.updateOne({ asset: pos.asset, status: 'open' }, { $set: { hasVirtualStop: true } });
                await Portfolio.updateOne(
                  { userId: SYSTEM_USER_ID, "positions.asset": pos.asset, "positions.status": "open" },
                  { $set: { "positions.$.hasVirtualStop": true } }
                );
                virtualFlagsUpdated = true;
              }
            }
          }

          // Verify Take Profit
          if (pos.takeProfit && pos.takeProfit > 0 && !pos.hasVirtualTakeProfit) {
            const tpMarketOrder = openOrders.find(o => o.type === 'take_profit_market' || o.raw?.order_type === 'TAKE_PROFIT_MARKET');
            if (!tpMarketOrder || (tpMarketOrder.amount !== 0 && Math.abs(tpMarketOrder.amount - pos.quantity) > 1e-8)) {
              if (tpMarketOrder) {
                this.logger.warn(`🚨 [RECONCILIATION] Trigger Quantity Mismatch! Take Profit for ${pos.asset} is ${tpMarketOrder.amount} but position is ${pos.quantity}. Canceling outdated trigger...`);
                await cancelOrder(tpMarketOrder.id, pos.asset);
              } else {
                this.logger.warn(`🚨 [RECONCILIATION] Naked Position Detected! Missing Take Profit for ${pos.asset}. Re-issuing trigger directly...`);
              }
              
              // 🛡️ Round 94: DIRECT Trigger Re-issue to prevent Trailing Stop Amnesia (Mock ENTRY intercepts)
              try {
                await placeTriggerOrder(pos.asset, exitSide, pos.quantity, pos.takeProfit, 'TAKE_PROFIT_MARKET');
              } catch (tpErr) {
                this.logger.error(`ReconciliationAgent failed to re-issue native Take Profit for ${pos.asset}. Activating Virtual Watchdog!`);
                pos.hasVirtualTakeProfit = true;
                await Trade.updateOne({ asset: pos.asset, status: 'open' }, { $set: { hasVirtualTakeProfit: true } });
                await Portfolio.updateOne(
                  { userId: SYSTEM_USER_ID, "positions.asset": pos.asset, "positions.status": "open" },
                  { $set: { "positions.$.hasVirtualTakeProfit": true } }
                );
                virtualFlagsUpdated = true;
              }
            }
          }
          
          if (virtualFlagsUpdated) {
            const updatedPortfolio = await Portfolio.findOne({ userId: SYSTEM_USER_ID }).lean();
            if (updatedPortfolio) {
              const { publishEvent, CHANNELS } = await import('../../config/redis.js');
              await publishEvent(CHANNELS.PORTFOLIO_UPDATES, updatedPortfolio);
            }
          }
        } catch (fetchErr) {
          this.logger.warn(`Failed to sync missing triggers for ${pos.asset}: ${fetchErr.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`Failed to execute trigger reconciliation: ${err.message}`);
    }
  }

  async cleanupGhostLocksFromExchange() {
    try {
      const exchange = getExchange();


      const pendingTrades = await Trade.find({ status: 'oms_approved', type: 'live' });
      if (!pendingTrades.length) return;

      const allOpenOrders = await exchange.fetchOpenOrders().catch(() => []);

      for (const trade of pendingTrades) {
        if (!trade.exchangeOrderId) continue;

        try {
          const orderAgeMs = Date.now() - new Date(trade.createdAt).getTime();
          if (orderAgeMs > 5 * 60 * 1000) {
            const order = allOpenOrders.find(o => o.id === trade.exchangeOrderId);
            
            if (order && order.filled > 0) {
              this.logger.warn(`🚨 [RECONCILIATION] Limit Order for ${trade.asset} pending > 5 mins but is PARTIALLY FILLED (${order.filled}). Promoting to OPEN!`);
              
              const marginRequired = (trade.entryPrice * order.filled) / (trade.leverage || 1);
              const feeUsdt = (trade.entryPrice * order.filled) * 0.0002; // Standard maker fee approximation

              trade.status = 'open';
              trade.quantity = order.filled;
              trade.fees = feeUsdt;
              trade.executedAt = new Date();
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
                realizedFees: 0,
                fees: feeUsdt,
                status: 'open'
              };

              const { default: Portfolio } = await import('../../models/Portfolio.js');
              await Portfolio.updateOne(
                { userId: 'system' },
                {
                  $push: { positions: newPos },
                  $inc: { 
                    availableBalance: -(marginRequired + feeUsdt),
                    totalBalance: -feeUsdt,
                    totalPnl: -feeUsdt,
                    dailyLossToday: -feeUsdt,
                    totalTrades: 1
                  }
                }
              );

              // Cancel remaining unfilled portion
              await exchange.cancelOrder(trade.exchangeOrderId, trade.asset);
              
            } else {
              this.logger.info(`🧹 [RECONCILIATION] Limit Order for ${trade.asset} pending > 5 mins. Canceling to free asset...`);
              await exchange.cancelOrder(trade.exchangeOrderId, trade.asset);
              trade.status = 'failed';
              trade.reasoning = 'Limit Order Expired / Auto-Cancelled after 5 minutes';
              await trade.save();
            }
          }
        } catch (err) {
          if (err.message.includes('No order found') || err.message.includes('Order does not exist') || err.message.includes('404')) {
            this.logger.warn(`🧹 [RECONCILIATION] Order ${trade.exchangeOrderId} for ${trade.asset} missing on exchange. Failing ghost lock.`);
            trade.status = 'failed';
            trade.reasoning = 'Ghost lock sweep (Missing on exchange)';
            await trade.save();
          } else {
            this.logger.warn(`Failed to verify pending limit order ${trade.exchangeOrderId}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      this.logger.error(`Failed to cleanup ghost limit locks: ${err.message}`);
    }
  }

  async sweepGhostPositionsFromDatabase() {
    try {
      const exchange = getExchange();

      // Fetch what the DB thinks is open or stuck in closing
      const openTrades = await Trade.find({ status: { $in: ['open', 'closing_in_progress'] } });
      if (openTrades.length === 0) return;

      // Fetch what is ACTUALLY open on the exchange
      const livePositions = await exchange.fetchPositions();
      if (!livePositions) return; // Prevent sweeping if API is down
      
      const liveAssets = livePositions.filter(p => p.contracts > 0).map(p => p.symbol.split(':')[0].replace('/', '').toUpperCase());

      for (const trade of openTrades) {
        if (!liveAssets.includes(trade.asset)) {
          this.logger.warn(`👻 [RECONCILIATION] Ghost Position Detected! ${trade.asset} is open in DB but missing on Exchange. Sweeping...`);
          
          trade.status = 'failed'; // Mark as failed instead of closed to prevent polluting win/loss statistics (likely old paper trades)
          trade.reasoning = 'Ghost Sweep: Position completely missing on live exchange';
          await trade.save();
          
          // Force remove from portfolio UI
          await Portfolio.updateOne(
            { userId: SYSTEM_USER_ID },
            { $pull: { positions: { asset: trade.asset } } }
          );
        }
      }
    } catch (err) {
      this.logger.error(`Failed to sweep ghost positions from database: ${err.message}`);
    }
  }

  async cleanupOrphanedExchangeOrders() {
    try {
      const exchange = getExchange();
      if (exchange.isDemo) return;
      const openOrders = await exchange.fetchOpenOrders();
      if (!openOrders || !openOrders.length) return;

      const livePositions = await exchange.fetchPositions();
      const liveAssets = (livePositions || []).filter(p => p.contracts > 0).map(p => p.symbol.split(':')[0].replace('/', '').toUpperCase());

      for (const order of openOrders) {
        const normalizedSymbol = order.symbol.split(':')[0].replace('/', '').toUpperCase();
        if (!liveAssets.includes(normalizedSymbol)) {
          this.logger.warn(`🧹 [RECONCILIATION] Orphaned Exchange Order Detected! Cancelling order ${order.id} for ${normalizedSymbol}...`);
          try {
            await exchange.cancelOrder(order.id, order.symbol);
            this.logger.info(`✅ Cancelled orphaned order ${order.id}`);
          } catch (cancelErr) {
            this.logger.error(`Failed to cancel orphaned order ${order.id}: ${cancelErr.message}`);
          }
        }
      }
    } catch (err) {
      this.logger.error(`Failed to cleanup orphaned exchange orders: ${err.message}`);
    }
  }

  async execute() {}
}
