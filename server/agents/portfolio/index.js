import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { sendTelegramMessage, formatPrice, escapeHtml } from '../../services/telegramService.js';
import { placeMarketOrder, cancelOrder, cancelAllOrders, getExchange, checkAssetLiquidity } from '../../services/exchangeService.js';
import Portfolio from '../../models/Portfolio.js';
import Trade from '../../models/Trade.js';
import { computeIndicators } from '../../services/indicatorService.js';
import {
  getCategoryForAsset,
  calculateNetPnl,
  calculateNetPnlForPositions,
  calculateDynamicTrailingPct,
  calculateMinProfitLockPrice,
  shouldLockProfit,
  getUpdatedStopLoss,
  calculateCategoryBP,
  calculateGlobalBP
} from '../../services/recalculationEngine.js';

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
      if (!position || position.status !== 'open') continue;

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

      position.currentPrice = currentPrice;
      if (position.side === 'long') {
        position.unrealizedPnl = (currentPrice - position.entryPrice) * position.quantity;
      } else {
        position.unrealizedPnl = (position.entryPrice - currentPrice) * position.quantity;
      }

      // Phase 1: Dynamic TP calculations (run before sync logic so SL updates are sent in this cycle)
      const isDynamicAssetTp = process.env.DYNAMIC_ASSET_TP_ENABLED === 'true';
      if (isDynamicAssetTp) {
        // Set category if missing
        if (!position.category) {
          position.category = getCategoryForAsset(position.asset);
        }

        const netPnl = calculateNetPnl(position);

        // 1. MFE/MAE tracking
        if (netPnl > (position.maxProfitReached || 0)) {
          position.maxProfitReached = netPnl;
        }
        if (netPnl < (position.maxDrawdownReached || 0)) {
          position.maxDrawdownReached = netPnl;
        }

        const candles = this.marketAgent.getCandles(position.asset);
        const indicators = candles && candles.length >= 30 ? computeIndicators(candles) : null;
        const atr = indicators && !indicators.error ? indicators.atr : null;

        if (atr) {
          // 2. Minimum Profit Lock (SL moved to profit/breakeven)
          if (shouldLockProfit(position)) {
            const lockPrice = calculateMinProfitLockPrice(position.entryPrice, position.side, atr, parseFloat(process.env.DYNAMIC_TP_MIN_PROFIT_LOCK_PCT) || 0.003);
            if (lockPrice) {
              position.stopLoss = lockPrice;
              position.lockedMinProfit = lockPrice;
              this.logger.info(`[DYNAMIC TP] Locked minimum profit for ${position.asset} at $${lockPrice.toFixed(4)}. Stop Loss moved to secure gains.`);
            }
          }

          // 3. Dynamic Trailing Stop
          const dynamicTrailingPct = calculateDynamicTrailingPct(position.asset, atr, currentPrice);
          position.dynamicTrailingPct = dynamicTrailingPct;
          
          const newStopLoss = getUpdatedStopLoss(position, currentPrice, dynamicTrailingPct);
          if (newStopLoss && newStopLoss !== position.stopLoss) {
            position.stopLoss = newStopLoss;
            this.logger.info(`[DYNAMIC TP] Trailed Stop Loss for ${position.asset} to $${newStopLoss.toFixed(4)} based on dynamic trailing %: ${(dynamicTrailingPct * 100).toFixed(2)}%`);
          }
        }
      }

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

          // Reconcile and synchronize Stop-Loss and Take-Profit trigger orders on the exchange
          try {
            const exchange = getExchange();
            const symbol = `${position.asset.replace('USDT', '')}/USDT:USDT`;
            
            // Fetch open trigger orders for this symbol from the exchange
            const openOrders = await exchange.fetchOpenOrders(symbol, undefined, undefined, { 'trigger': true });
            const exitSide = position.side === 'long' ? 'sell' : 'buy';
            
            // Filter trigger orders matching the exit side
            const triggerOrders = openOrders.filter(o => o.side === exitSide);
            
            const existingSLOrders = [];
            const existingTPOrders = [];
            
            triggerOrders.forEach(o => {
              const triggerPrice = parseFloat(o.stopPrice || o.triggerPrice || (o.info && o.info.stopPrice) || 0);
              if (triggerPrice <= 0) return;
              
              if (position.side === 'long') {
                if (triggerPrice < position.entryPrice) {
                  existingSLOrders.push(o);
                } else {
                  existingTPOrders.push(o);
                }
              } else {
                if (triggerPrice > position.entryPrice) {
                  existingSLOrders.push(o);
                } else {
                  existingTPOrders.push(o);
                }
              }
            });

            this.logger.info(`🔍 [TRIGGER SYNC debug] ${symbol}: found ${existingSLOrders.length} SL orders and ${existingTPOrders.length} TP orders among ${openOrders.length} fetched open trigger orders`);

            // 1. Reconcile Stop Loss
            if (position.stopLoss) {
              const formattedStopLoss = parseFloat(exchange.priceToPrecision(symbol, position.stopLoss));
              
              const matchingSLOrders = [];
              const mismatchingSLOrders = [];
              
              existingSLOrders.forEach(o => {
                const triggerPrice = parseFloat(o.stopPrice || o.triggerPrice || (o.info && o.info.stopPrice) || 0);
                if (formattedStopLoss > 0 && Math.abs(triggerPrice - formattedStopLoss) / formattedStopLoss < 0.0001) {
                  matchingSLOrders.push(o);
                } else {
                  mismatchingSLOrders.push(o);
                }
              });
              
              // Cancel any mismatching stop-loss orders
              for (const o of mismatchingSLOrders) {
                try {
                  this.logger.info(`🔄 [SL SYNC] Cancelling mismatching stop-loss order ${o.id} for ${position.asset} (Price: ${o.stopPrice || o.triggerPrice} vs DB: ${formattedStopLoss})`);
                  await exchange.cancelOrder(o.id, symbol, { trigger: true });
                } catch (cancelErr) {
                  if (cancelErr.name === 'OrderNotFound' || cancelErr.message.includes('Unknown order') || cancelErr.message.includes('-2011')) {
                    this.logger.debug(`[SL SYNC] Stop-loss order ${o.id} for ${position.asset} was already filled or cancelled on exchange.`);
                  } else {
                    throw cancelErr;
                  }
                }
              }
              
              // Calculate total matching quantity
              const totalMatchingQty = matchingSLOrders.reduce((sum, o) => sum + parseFloat(o.amount || 0), 0);
              
              // If matching qty is less than position qty, place the missing amount
              const remainingQty = position.quantity - totalMatchingQty;
              if (remainingQty > 0.0001) {
                this.logger.info(`🔄 [SL SYNC] Stop Loss missing/insufficient for ${position.asset}. Placing trigger order for remaining qty: ${remainingQty}`);
                
                const market = exchange.market(symbol);
                const marketLotSize = market.info?.filters?.find(f => f.filterType === 'MARKET_LOT_SIZE');
                const maxQty = marketLotSize ? parseFloat(marketLotSize.maxQty) : null;
                
                let quantityToPlace = remainingQty;
                while (quantityToPlace > 0) {
                  const chunk = maxQty ? Math.min(quantityToPlace, maxQty) : quantityToPlace;
                  const formattedChunk = parseFloat(exchange.amountToPrecision(symbol, chunk));
                  if (formattedChunk <= 0) break;
                  
                  try {
                    const slOrderResult = await exchange.createOrder(
                      symbol,
                      'stop_market',
                      exitSide,
                      formattedChunk,
                      undefined,
                      {
                        stopPrice: formattedStopLoss,
                        reduceOnly: true
                      }
                    );
                    this.logger.info(`✅ [SL SYNC PLACED] stopPrice=${formattedStopLoss} size=${formattedChunk} id=${slOrderResult.id} on Binance Demo`);
                  } catch (orderErr) {
                    if (orderErr.message.includes('-4045') || orderErr.message.includes('max stop') || orderErr.name === 'OperationRejected') {
                      this.logger.warn(`⚠️ [SL SYNC REJECTED] Reach max stop order limit (10) for ${symbol} on Binance Futures. Skipping remaining chunk placement.`);
                      break;
                    } else {
                      throw orderErr;
                    }
                  }
                  quantityToPlace -= chunk;
                }
              }
            } else {
              // DB has no stopLoss, cancel any existing stop-loss orders
              for (const o of existingSLOrders) {
                try {
                  this.logger.info(`🔄 [SL SYNC] DB has no Stop Loss. Cancelling existing stop-loss order ${o.id} for ${position.asset}`);
                  await exchange.cancelOrder(o.id, symbol, { trigger: true });
                } catch (cancelErr) {
                  if (cancelErr.name === 'OrderNotFound' || cancelErr.message.includes('Unknown order') || cancelErr.message.includes('-2011')) {
                    this.logger.debug(`[SL SYNC] Stop-loss order ${o.id} for ${position.asset} was already filled or cancelled on exchange.`);
                  } else {
                    throw cancelErr;
                  }
                }
              }
            }
            
            // 2. Reconcile Take Profit
            if (position.takeProfit) {
              const formattedTakeProfit = parseFloat(exchange.priceToPrecision(symbol, position.takeProfit));
              
              const matchingTPOrders = [];
              const mismatchingTPOrders = [];
              
              existingTPOrders.forEach(o => {
                const triggerPrice = parseFloat(o.stopPrice || o.triggerPrice || (o.info && o.info.stopPrice) || 0);
                if (formattedTakeProfit > 0 && Math.abs(triggerPrice - formattedTakeProfit) / formattedTakeProfit < 0.0001) {
                  matchingTPOrders.push(o);
                } else {
                  mismatchingTPOrders.push(o);
                }
              });
              
              // Cancel any mismatching take-profit orders
              for (const o of mismatchingTPOrders) {
                try {
                  this.logger.info(`🔄 [TP SYNC] Cancelling mismatching take-profit order ${o.id} for ${position.asset} (Price: ${o.stopPrice || o.triggerPrice} vs DB: ${formattedTakeProfit})`);
                  await exchange.cancelOrder(o.id, symbol, { trigger: true });
                } catch (cancelErr) {
                  if (cancelErr.name === 'OrderNotFound' || cancelErr.message.includes('Unknown order') || cancelErr.message.includes('-2011')) {
                    this.logger.debug(`[TP SYNC] Take-profit order ${o.id} for ${position.asset} was already filled or cancelled on exchange.`);
                  } else {
                    throw cancelErr;
                  }
                }
              }
              
              // Calculate total matching quantity
              const totalMatchingQty = matchingTPOrders.reduce((sum, o) => sum + parseFloat(o.amount || 0), 0);
              
              // If matching qty is less than position qty, place the missing amount
              const remainingQty = position.quantity - totalMatchingQty;
              if (remainingQty > 0.0001) {
                this.logger.info(`🔄 [TP SYNC] Take Profit missing/insufficient for ${position.asset}. Placing trigger order for remaining qty: ${remainingQty}`);
                
                const market = exchange.market(symbol);
                const marketLotSize = market.info?.filters?.find(f => f.filterType === 'MARKET_LOT_SIZE');
                const maxQty = marketLotSize ? parseFloat(marketLotSize.maxQty) : null;
                
                let quantityToPlace = remainingQty;
                while (quantityToPlace > 0) {
                  const chunk = maxQty ? Math.min(quantityToPlace, maxQty) : quantityToPlace;
                  const formattedChunk = parseFloat(exchange.amountToPrecision(symbol, chunk));
                  if (formattedChunk <= 0) break;
                  
                  try {
                    const tpOrderResult = await exchange.createOrder(
                      symbol,
                      'take_profit_market',
                      exitSide,
                      formattedChunk,
                      undefined,
                      {
                        stopPrice: formattedTakeProfit,
                        reduceOnly: true
                      }
                    );
                    this.logger.info(`✅ [TP SYNC PLACED] takeProfitPrice=${formattedTakeProfit} size=${formattedChunk} id=${tpOrderResult.id} on Binance Demo`);
                  } catch (orderErr) {
                    if (orderErr.message.includes('-4045') || orderErr.message.includes('max stop') || orderErr.name === 'OperationRejected') {
                      this.logger.warn(`⚠️ [TP SYNC REJECTED] Reach max stop order limit (10) for ${symbol} on Binance Futures. Skipping remaining chunk placement.`);
                      break;
                    } else {
                      throw orderErr;
                    }
                  }
                  quantityToPlace -= chunk;
                }
              }
            } else {
              // DB has no takeProfit, cancel any existing take-profit orders
              for (const o of existingTPOrders) {
                try {
                  this.logger.info(`🔄 [TP SYNC] DB has no Take Profit. Cancelling existing take-profit order ${o.id} for ${position.asset}`);
                  await exchange.cancelOrder(o.id, symbol, { trigger: true });
                } catch (cancelErr) {
                  if (cancelErr.name === 'OrderNotFound' || cancelErr.message.includes('Unknown order') || cancelErr.message.includes('-2011')) {
                    this.logger.debug(`[TP SYNC] Take-profit order ${o.id} for ${position.asset} was already filled or cancelled on exchange.`);
                  } else {
                    throw cancelErr;
                  }
                }
              }
            }
          } catch (syncErr) {
            this.logger.error(`❌ [TRIGGER SYNC FAILED] Failed to reconcile trigger orders for ${position.asset}: ${syncErr.stack || syncErr.message}`);
          }
        }
      }

      if (isNativelyClosed) {
        await this.closePosition(portfolio, position, closePrice, closeReason, true);
        continue;
      }

      totalUnrealizedPnl += position.unrealizedPnl;
    }

    // 3. Binance-to-Database Sync (Import active positions found on Binance but missing in DB)
    if (fetchedExchangeSuccessfully) {
      for (const exchangePos of activeExchangePositions) {
        const asset = exchangePos.symbol.split(':')[0].replace('/', '');

        // Skip assets not supported by this bot instance
        if (!SUPPORTED_ASSETS.includes(asset)) {
          continue;
        }

        // Skip assets manually disabled or auto-ignored (unless already tracked in DB as open)
        const manuallyDisabled = portfolio.manuallyDisabledAssets || [];
        const autoIgnored = portfolio.autoIgnoredAssets || [];
        if (manuallyDisabled.includes(asset) || autoIgnored.includes(asset)) {
          continue;
        }

        const dbPosition = portfolio.positions.find((p) => p && p.asset === asset && p.status === 'open');

        if (!dbPosition) {
          this.logger.info(`🔄 [RECONCILIATION] Active position for ${asset} found on Binance but not in DB. Importing...`);

          const side = exchangePos.side; // 'long' or 'short'
          const entryPrice = exchangePos.entryPrice;
          const quantity = exchangePos.contracts;

          // Explicit validation of required position fields before import to prevent Mongoose validation failures
          if (!side || !['long', 'short'].includes(side) || typeof entryPrice !== 'number' || isNaN(entryPrice) || entryPrice <= 0 || typeof quantity !== 'number' || isNaN(quantity) || quantity <= 0) {
            this.logger.error(`❌ [RECONCILIATION] Invalid position data received from Binance for ${asset}: side=${side}, entryPrice=${entryPrice}, quantity=${quantity}. Skipping import to prevent DB corruption.`);
            continue;
          }

          let leverage = exchangePos.leverage || (exchangePos.initialMarginPercentage > 0 ? Math.round(1 / exchangePos.initialMarginPercentage) : 3);
          const currentPrice = exchangePos.markPrice || entryPrice;
          const unrealizedPnl = exchangePos.unrealizedPnl || 0;

          // Find a corresponding pending or open Trade document in the DB
          let activeTrade = await Trade.findOne({ asset, status: { $in: ['open', 'pending'] } }).sort({ createdAt: -1 });
          
          if (activeTrade && activeTrade.leverage > 0) {
            leverage = activeTrade.leverage;
          }

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

          const isDynamicAssetTp = process.env.DYNAMIC_ASSET_TP_ENABLED === 'true';
          let dynamicTrailingPct = undefined;
          const category = getCategoryForAsset(asset);
          if (isDynamicAssetTp) {
            const candles = this.marketAgent.getCandles(asset);
            const indicators = candles && candles.length >= 30 ? computeIndicators(candles) : null;
            const atr = indicators && !indicators.error ? indicators.atr : null;
            if (atr) {
              dynamicTrailingPct = calculateDynamicTrailingPct(asset, atr, entryPrice);
            }
          }

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
            // Dynamic Profit Engine fields
            dynamicTrailingPct,
            category,
            maxProfitReached: 0,
            maxDrawdownReached: 0,
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
      .filter((p) => p && p.status === 'open')
      .reduce((sum, p) => sum + ((p.entryPrice * p.quantity) / (p.leverage || 1) + p.unrealizedPnl), 0);

    portfolio.totalBalance = portfolio.availableBalance + marginValue;

    // Update peak balance for drawdown tracking
    if (portfolio.totalBalance > portfolio.peakBalance) {
      portfolio.peakBalance = portfolio.totalBalance;
    }

    await portfolio.save();
  }

  async checkExits(portfolio) {
    const manuallyDisabled = portfolio.manuallyDisabledAssets || [];
    const autoIgnored = portfolio.autoIgnoredAssets || [];

    // All active open positions (not manually disabled)
    const activeOpenPositions = portfolio.positions.filter(
      (p) => p && p.status === 'open' && !manuallyDisabled.includes(p.asset)
    );

    // Dynamic Liquidity Check
    const liquidPositions = [];
    const illiquidPositions = [];

    await Promise.all(
      activeOpenPositions.map(async (pos) => {
        const isLiquid = await checkAssetLiquidity(pos.asset, pos.side);
        if (isLiquid) {
          liquidPositions.push(pos);
        } else {
          illiquidPositions.push(pos);
        }
      })
    );

    // Sort liquid positions by absolute unrealized PnL descending
    liquidPositions.sort((a, b) => Math.abs(b.unrealizedPnl || 0) - Math.abs(a.unrealizedPnl || 0));

    // ─── Phase 2: Dynamic Category Basket Profit (CBP) ───
    const isDynamicCbp = process.env.DYNAMIC_CBP_ENABLED === 'true';
    if (isDynamicCbp && !portfolio.isSquaringOff) {
      const categories = ['core', 'meme', 'recommended'];
      for (const cat of categories) {
        // Filter open liquid positions belonging to this category
        const catPositions = liquidPositions.filter(p => {
          const pCat = p.category || getCategoryForAsset(p.asset);
          return pCat === cat;
        });

        if (catPositions.length > 0) {
          // Dynamic category target calculation (fallback to 3.0% daily range for multiplier = 1.0)
          const categoryTarget = calculateCategoryBP(cat, catPositions, 3.0);
          const categoryNetPnl = calculateNetPnlForPositions(catPositions);

          if (categoryNetPnl >= categoryTarget) {
            this.logger.info(`[CATEGORY CBP EXIT] ${cat.toUpperCase()} category net unrealized profit reached $${categoryNetPnl.toFixed(2)} (>= $${categoryTarget.toFixed(2)} target). Squaring off category...`);
            
            const closedResults = [];
            for (const position of catPositions) {
              let currentPrice = this.marketAgent.getPrice(position.asset) || position.currentPrice || 0;
              const res = await this.closePosition(portfolio, position, currentPrice, `${cat.toUpperCase()} Category CBP target reached (+$${categoryTarget.toFixed(2)} target)`, false);
              if (res && res.success) {
                closedResults.push(res);
              }
            }

            if (closedResults.length > 0) {
              const totalActualNetCatPnL = closedResults.reduce((sum, r) => sum + r.netPnl, 0);
              await sendTelegramMessage(
                `🎯 <b>Category Target Achieved! [${cat.toUpperCase()}]</b>\n\n` +
                `• Category: <b>${cat.toUpperCase()}</b>\n` +
                `• Net Profit: <b>+$${totalActualNetCatPnL.toFixed(2)} Net</b> (Target: $${categoryTarget.toFixed(2)})\n` +
                `• Closed positions: ${closedResults.length}`
              );
            }
            return; // Exit checkExits to refresh in the next 30s cycle
          }
        }
      }
    }

    // ─── Phase 3: Dynamic Global Basket Profit (GBP) ───
    let basketTarget = parseFloat(process.env.BASKET_PROFIT_TARGET) || 20;
    const isDynamicGbp = process.env.DYNAMIC_GBP_ENABLED === 'true';
    if (isDynamicGbp) {
      const btcPrice = this.marketAgent.getPrice('BTCUSDT') || 0;
      // Regime SMA detector (fallback btcPrice so multiplier = 1.0)
      basketTarget = calculateGlobalBP(liquidPositions, btcPrice, btcPrice, null);
    }

    if (portfolio.isSquaringOff) {
      if (liquidPositions.length === 0) {
        portfolio.isSquaringOff = false;
        await portfolio.save();
        this.logger.info(`[BASKET EXIT] All liquid positions closed successfully. Resetting square-off cooldown.`);
        await sendTelegramMessage(`🔄 <b>Basket Profit Reset</b>\nAll liquid positions successfully closed. Cooldown ended, fresh trades can now begin!`);
      } else {
        this.logger.info(`[BASKET EXIT] Square-off active. Closing remaining ${liquidPositions.length} liquid positions.`);
        for (const position of liquidPositions) {
          let currentPrice = this.marketAgent.getPrice(position.asset) || position.currentPrice || 0;
          await this.closePosition(portfolio, position, currentPrice, `Basket Square-Off Active (+$${basketTarget.toFixed(2)} target reached)`, false);
        }
      }
      return;
    }

    const totalNetUnrealizedPnl = liquidPositions.reduce((sum, p) => {
      const openFee = p.fees || (p.entryPrice * p.quantity * 0.0005);
      const curPrice = p.currentPrice || p.entryPrice || 0;
      const closeFee = curPrice * p.quantity * 0.0005;
      const netPnl = (p.unrealizedPnl || 0) - openFee - closeFee;
      return sum + netPnl;
    }, 0);

    if (totalNetUnrealizedPnl >= basketTarget) {
      this.logger.info(`[BASKET EXIT] Total liquid net unrealized profit reached $${totalNetUnrealizedPnl.toFixed(2)} after fees (>= $${basketTarget.toFixed(2)}). Triggering square-off!`);
      portfolio.isSquaringOff = true;
      await portfolio.save();

      const closedResults = [];
      for (const position of liquidPositions) {
        let currentPrice = this.marketAgent.getPrice(position.asset) || position.currentPrice || 0;
        const res = await this.closePosition(portfolio, position, currentPrice, `Basket Take Profit reached (+$${basketTarget.toFixed(2)} net target)`, false);
        if (res && res.success) {
          closedResults.push(res);
        }
      }

      const totalActualNetPnL = closedResults.reduce((sum, r) => sum + r.netPnl, 0);

      await sendTelegramMessage(
        `🎯 <b>Basket Take-Profit Reached! [+$${totalActualNetPnL.toFixed(2)} Net]</b>\n` +
        `Total liquid net profit after fees reached $${totalActualNetPnL.toFixed(2)}. Pausing new trades and squared off all ${closedResults.length} liquid positions.`
      );
      return;
    }

    // ──────────────────────────────────────────────────────────────────────

    const processedAssets = new Set();

    for (const position of portfolio.positions) {
      if (!position || position.status !== 'open') continue;
      if (manuallyDisabled.includes(position.asset) || autoIgnored.includes(position.asset)) continue;

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
        if (process.env.BINANCE_TESTNET_API_KEY && (!activeTrade || !activeTrade.exchangeOrderId || !activeTrade.exchangeOrderId.startsWith('mock_'))) {
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
        this.logger.error(`❌ [EXCHANGE EXIT FAILED] Failed to place offsetting close order on Binance Demo for ${position.asset}: ${err.message}. Initiating auto-ignore with limit order fallback.`);
        
        try {
          const exchange = getExchange();
          const symbol = position.asset.endsWith('USDT') ? `${position.asset.replace('USDT', '')}/USDT:USDT` : position.asset;
          
          // 1. Cancel trigger orders to unlock
          try {
            await cancelAllOrders(position.asset);
            this.logger.info(`🧹 [AUTO-IGNORE CLEANUP] Cancelled open trigger orders for ${position.asset}`);
          } catch (cancelErr) {
            this.logger.warn(`Failed to clean up trigger orders during auto-ignore: ${cancelErr.message}`);
          }

          // 2. Fetch ticker last price
          let ticker = await exchange.fetchTicker(symbol);
          const limitPrice = ticker.last || closePrice;

          // 3. Place Limit Order
          const exitSide = position.side === 'long' ? 'sell' : 'buy';
          this.logger.info(`🚨 [AUTO-IGNORE FALLBACK] Placing Limit ${exitSide.toUpperCase()} order on Binance Demo for ${position.asset} at $${limitPrice}`);
          const limitOrder = await exchange.createOrder(symbol, 'limit', exitSide, position.quantity, limitPrice, { reduceOnly: true });
          this.logger.info(`✅ [AUTO-IGNORE LIMIT PLACED] Order ID: ${limitOrder.id}, status: ${limitOrder.status}`);

          // 4. Add to autoIgnoredAssets in Portfolio
          if (!portfolio.autoIgnoredAssets) {
            portfolio.autoIgnoredAssets = [];
          }
          if (!portfolio.autoIgnoredAssets.includes(position.asset)) {
            portfolio.autoIgnoredAssets.push(position.asset);
            await portfolio.save();
          }

          // 5. Send Telegram alert
          await sendTelegramMessage(
            `⚠️ <b>Market Exit Failed! [Auto-Ignored]</b>\n` +
            `• Market order failed for <b>${position.asset.replace('USDT', '')}/USDT</b>: ${err.message.substring(0, 120)}...\n` +
            `• Automatically placed <b>Limit Close Order</b> at $${limitPrice.toFixed(4)}\n` +
            `• Bot has <b>auto-ignored</b> this asset to unblock all other trading.`
          );
        } catch (fallbackErr) {
          this.logger.error(`❌ [AUTO-IGNORE FALLBACK FAILED] Failed to place limit fallback for ${position.asset}: ${fallbackErr.message}`);
        }
        
        // Abort local closure so that the position stays open and we check it on exchange fill
        return { success: false };
      }
    }

    // Exchange order cleanup: cancel entry limit orders and any remaining triggers for this asset
    try {
      const activeTrade = await Trade.findOne({ asset: position.asset, status: 'open' });
      if (activeTrade && activeTrade.exchangeOrderId && !activeTrade.exchangeOrderId.startsWith('mock_')) {
        // Cancel the entry limit order explicitly first to confirm cancellation from Binance
        try {
          await cancelOrder(position.asset, activeTrade.exchangeOrderId);
          this.logger.info(`🧹 [ORDER CLEANUP] Cancelled remaining unfilled portion of entry limit order ${activeTrade.exchangeOrderId} for ${position.asset}`);
        } catch (orderErr) {
          this.logger.debug(`Entry limit order ${activeTrade.exchangeOrderId} for ${position.asset} was already fully filled or cancelled: ${orderErr.message}`);
        }

        // Cancel all remaining open orders (triggers/SL/TP) for this asset
        await cancelAllOrders(position.asset);
        this.logger.info(`🧹 [ORDER CLEANUP] Successfully cancelled all remaining pending trigger orders for ${position.asset} on Binance`);
      }
    } catch (cleanErr) {
      this.logger.debug(`Failed to clean up remaining orders for ${position.asset}: ${cleanErr.message}`);
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
      .filter((p) => p && p.status === 'open')
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

    // Auto-Ignored cleanup
    if (portfolio.autoIgnoredAssets && portfolio.autoIgnoredAssets.includes(position.asset)) {
      portfolio.autoIgnoredAssets = portfolio.autoIgnoredAssets.filter(a => a !== position.asset);
      await portfolio.save();
      await sendTelegramMessage(
        `✅ <b>Asset Re-Enabled!</b>\n` +
        `The auto-ignored position for <b>${position.asset.replace('USDT', '')}/USDT</b> has successfully closed on Binance. Re-enabling the asset for normal trading.`
      );
    }

    return {
      success: true,
      realizedPnl: position.realizedPnl,
      fees: totalPositionFees,
      netPnl: position.realizedPnl - totalPositionFees
    };
  }

  /** Update aggregate portfolio metrics. */
  async updateMetrics(portfolio) {
    // Allocation breakdown
    const openPositions = portfolio.positions.filter((p) => p && p.status === 'open');
    const totalValue = openPositions.reduce((sum, p) => sum + p.currentPrice * p.quantity, 0);

    portfolio.allocationBreakdown = openPositions.map((p) => ({
      asset: p.asset,
      percentage: totalValue > 0 ? ((p.currentPrice * p.quantity) / totalValue) * 100 : 0,
      value: p.currentPrice * p.quantity,
    }));

    try {
      // 1. Calculate true closed PnL and trade counters from Trade collection (source of truth)
      const filter = { status: 'closed' };
      if (process.env.DASHBOARD_RESET_TIMESTAMP) {
        filter.createdAt = { $gte: new Date(process.env.DASHBOARD_RESET_TIMESTAMP) };
      }
      const closedTrades = await Trade.find(filter);
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
      let trueAvailable = (portfolio.baseTradingCapital || 1000) + trueTotalPnl - (portfolio.walletBalance || 0);
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

    const baseCap = portfolio.baseTradingCapital || 1000;
    portfolio.totalPnlPercent = portfolio.totalBalance > 0
      ? ((portfolio.totalBalance - baseCap) / baseCap) * 100  // vs initial capital
      : 0;

    // Recalculate dailyLossToday dynamically from Trade collection (source of truth for today's closed trades in IST)
    try {
      const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0]; // "YYYY-MM-DD" in IST
      const startOfToday = new Date(`${todayStr}T00:00:00.000+05:30`);
      const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

      const filter = {
        status: 'closed',
        closedAt: { $gte: startOfToday, $lt: endOfToday },
      };

      if (process.env.DASHBOARD_RESET_TIMESTAMP) {
        const resetDate = new Date(process.env.DASHBOARD_RESET_TIMESTAMP);
        if (resetDate > startOfToday) {
          filter.closedAt.$gte = resetDate;
        }
      }

      const closedTradesToday = await Trade.find(filter);

      const totalCommissions = closedTradesToday.reduce((sum, t) => sum + (t.fees || 0), 0);
      const grossProfit = closedTradesToday.reduce((sum, t) => sum + (t.pnl || 0), 0);
      portfolio.dailyLossToday = grossProfit - totalCommissions;
    } catch (err) {
      this.logger.error(`Failed to dynamically recalculate dailyLossToday: ${err.message}`);
    }

    await this.checkProfitTarget(portfolio);
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
    const openPositions = portfolio.positions.filter((p) => p && p.status === 'open');
    
    // Group open positions by category for progress updates
    const corePositions = openPositions.filter(p => (p.category || getCategoryForAsset(p.asset)) === 'core');
    const memePositions = openPositions.filter(p => (p.category || getCategoryForAsset(p.asset)) === 'meme');
    const recPositions = openPositions.filter(p => (p.category || getCategoryForAsset(p.asset)) === 'recommended');

    const coreTarget = calculateCategoryBP('core', corePositions, 3.0);
    const memeTarget = calculateCategoryBP('meme', memePositions, 3.0);
    const recTarget = calculateCategoryBP('recommended', recPositions, 3.0);

    const coreNetPnl = calculateNetPnlForPositions(corePositions);
    const memeNetPnl = calculateNetPnlForPositions(memePositions);
    const recNetPnl = calculateNetPnlForPositions(recPositions);

    const btcPrice = this.marketAgent.getPrice('BTCUSDT') || 0;
    const gbpTarget = calculateGlobalBP(openPositions, btcPrice, btcPrice, null);
    const gbpNetPnl = calculateNetPnlForPositions(openPositions);

    await publishEvent(CHANNELS.PORTFOLIO_UPDATES, {
      totalBalance: portfolio.totalBalance,
      availableBalance: portfolio.availableBalance,
      totalPnl: portfolio.totalPnl,
      totalPnlPercent: portfolio.totalPnlPercent,
      dailyPnl: portfolio.dailyLossToday,
      winRate: portfolio.winRate,
      openPositions: openPositions.length,
      allocation: portfolio.allocationBreakdown,
      winningTrades: portfolio.winningTrades,
      losingTrades: portfolio.losingTrades,
      totalTrades: portfolio.totalTrades,
      walletBalance: portfolio.walletBalance || 0,
      tradingPaused: portfolio.tradingPaused || false,
      targetProfitThreshold: portfolio.targetProfitThreshold || 1100,
      baseTradingCapital: portfolio.baseTradingCapital || 1000,
      manuallyDisabledAssets: portfolio.manuallyDisabledAssets || [],
      autoIgnoredAssets: portfolio.autoIgnoredAssets || [],
      dynamicTargets: {
        gbp: { 
          enabled: process.env.DYNAMIC_GBP_ENABLED === 'true',
          target: gbpTarget, 
          currentProgress: gbpNetPnl, 
          progressPct: gbpTarget > 0 ? (gbpNetPnl / gbpTarget) * 100 : 0 
        },
        cbp: {
          enabled: process.env.DYNAMIC_CBP_ENABLED === 'true',
          core: { 
            target: coreTarget, 
            currentProgress: coreNetPnl, 
            progressPct: coreTarget > 0 ? (coreNetPnl / coreTarget) * 100 : 0 
          },
          meme: { 
            target: memeTarget, 
            currentProgress: memeNetPnl, 
            progressPct: memeTarget > 0 ? (memeNetPnl / memeTarget) * 100 : 0 
          },
          recommended: { 
            target: recTarget, 
            currentProgress: recNetPnl, 
            progressPct: recTarget > 0 ? (recNetPnl / recTarget) * 100 : 0 
          },
        }
      }
    });
  }


  async checkProfitTarget(portfolio) {
    const target = portfolio.targetProfitThreshold || 1100;
    
    // Calculate liquid total balance (excluding illiquid positions P&L)
    const openPositions = portfolio.positions.filter(p => p && p.status === 'open');
    let liquidOpenExposure = 0;
    let liquidOpenUnrealized = 0;
    let estimatedCloseFees = 0;
    const liquidPositions = [];
    
    for (const pos of openPositions) {
      const isLiquid = await checkAssetLiquidity(pos.asset, pos.side);
      if (isLiquid) {
        liquidPositions.push(pos);
        const leverage = pos.leverage && pos.leverage > 1 ? pos.leverage : 10;
        const exposure = pos.entryPrice * pos.quantity;
        const margin = exposure / leverage;
        liquidOpenExposure += margin;
        liquidOpenUnrealized += pos.unrealizedPnl;
        const curPrice = pos.currentPrice || pos.entryPrice || 0;
        estimatedCloseFees += curPrice * pos.quantity * 0.0005; // 0.05% estimated closing fee
      }
    }
    
    // Liquid total balance = availableBalance + liquid margin + liquid unrealized - estimated closing fees
    const liquidTotalBalance = portfolio.availableBalance + liquidOpenExposure + liquidOpenUnrealized - estimatedCloseFees;
    
    if (liquidTotalBalance >= target && !portfolio.tradingPaused) {
      this.logger.warn(`🚨 [PROFIT TARGET MET] Liquid net worth has reached $${liquidTotalBalance.toFixed(2)} (Target: $${target}). Initiating automatic square-off...`);
      
      portfolio.tradingPaused = true;
      await portfolio.save();

      // Only close liquid positions!
      this.logger.info(`🚨 Closing all active liquid positions on Binance...`);
      const liquidPositionsToClose = [];
      for (const position of openPositions) {
        const isLiquid = await checkAssetLiquidity(position.asset, position.side);
        if (isLiquid) {
          liquidPositionsToClose.push(position);
        } else {
          this.logger.info(`ℹ️ Skipping square-off close for illiquid position: ${position.asset}`);
        }
      }

      // Sort liquid positions by absolute unrealized PnL descending
      liquidPositionsToClose.sort((a, b) => Math.abs(b.unrealizedPnl || 0) - Math.abs(a.unrealizedPnl || 0));

      for (const position of liquidPositionsToClose) {
        try {
          let currentPrice = this.marketAgent.getPrice(position.asset) || position.currentPrice || position.entryPrice || 0;
          await this.closePosition(portfolio, position, currentPrice, 'Profit Target Met (Auto-Squareoff)', false);
        } catch (closeErr) {
          this.logger.error(`Failed to close position for ${position.asset} during square-off: ${closeErr.message}`);
        }
      }

      const baseCap = portfolio.baseTradingCapital || 1000;
      // Recalculate true balance after liquid positions have been closed
      const marginValue = portfolio.positions
        .filter((p) => p && p.status === 'open')
        .reduce((sum, p) => sum + ((p.entryPrice * p.quantity) / (p.leverage || 1) + p.unrealizedPnl), 0);
      const postCloseTotalBalance = portfolio.availableBalance + marginValue;

      const excessProfit = postCloseTotalBalance - baseCap;
      
      if (excessProfit > 0) {
        portfolio.walletBalance = (portfolio.walletBalance || 0) + excessProfit;
        portfolio.totalBalance = baseCap;
        portfolio.availableBalance = baseCap;
        portfolio.peakBalance = baseCap;
        
        this.logger.info(`💰 [PROFIT SWEEP] Swept $${excessProfit.toFixed(2)} of excess profit to the secure wallet. New wallet balance: ${portfolio.walletBalance.toFixed(2)}`);
        
        await sendTelegramMessage(
          `🎯 <b>Profit Target Achieved!</b>\n\n` +
          `• Net Worth reached: $${(baseCap + excessProfit).toFixed(2)} (Target: $${target.toFixed(2)})\n` +
          `• Swept Profit to Local Vault: $${excessProfit.toFixed(2)}\n` +
          `• Total Vault Balance: $${portfolio.walletBalance.toFixed(2)}\n` +
          `• Trading bot has been <b>PAUSED</b> and all liquid positions squared off.\n\n` +
          `Please restart the bot manually from the dashboard when ready.`
        );
      } else {
        this.logger.warn(`[PROFIT SWEEP] Net worth is not above base capital after closing liquid positions. No sweep performed.`);
      }
      await portfolio.save();
    }
  }
}
