import BaseAgent from '../base/BaseAgent.js';
import { AGENT_NAMES, SUPPORTED_ASSETS, SYSTEM_USER_ID } from '../../config/constants.js';
import { publishEvent, CHANNELS } from '../../config/redis.js';
import { sendTelegramMessage, formatPrice, escapeHtml } from '../../services/telegramService.js';
import { placeMarketOrder, placeLimitOrder, cancelOrder, cancelAllOrders, getExchange, checkAssetLiquidity, fetchBalance } from '../../services/exchangeService.js';
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

/** Helper function to interleave square-off execution: High Profit, High Loss, Next High Profit, Next High Loss... */
function sortInterleavedSquareOff(positions) {
  if (!positions || !Array.isArray(positions)) return [];

  const winners = positions
    .filter(p => p && (p.unrealizedPnl || 0) >= 0)
    .sort((a, b) => (b.unrealizedPnl || 0) - (a.unrealizedPnl || 0)); // Highest profit first

  const losers = positions
    .filter(p => p && (p.unrealizedPnl || 0) < 0)
    .sort((a, b) => (a.unrealizedPnl || 0) - (b.unrealizedPnl || 0)); // Worst loss first

  const ordered = [];
  let w = 0, l = 0;
  while (w < winners.length || l < losers.length) {
    if (w < winners.length) {
      ordered.push(winners[w++]);
    }
    if (l < losers.length) {
      ordered.push(losers[l++]);
    }
  }
  return ordered;
}

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
    this.notifiedSyncErrors = new Set();
    this._activeExitLocks = new Set();
  }

  async initialize() {
    await super.initialize();

    // Link WebSocket price stream for sub-50ms realtime exits
    try {
      const { coinswitchWs } = await import('../../services/coinswitchWsService.js');
      coinswitchWs.onPriceUpdate((asset, price) => {
        this.evaluateRealtimeExit(asset, price);
      });
      this.logger.info('⚡ Linked CoinSwitch WebSocket price stream to PortfolioAgent for sub-50ms realtime exits');
    } catch (wsErr) {
      this.logger.warn(`Failed to link WebSocket price stream to PortfolioAgent: ${wsErr.message}`);
    }

    // Kick off the fast background exchange sync loop (runs every 5s, fully non-blocking)
    this._runBackgroundSync();
    this._bgSyncInterval = setInterval(() => this._runBackgroundSync(), 5000);
  }

  /** Fire-and-forget background sync: runs exchange API calls outside the main 2s cycle */
  async _runBackgroundSync() {
    try {
      const portfolios = await Portfolio.find({});
      for (const portfolio of portfolios) {
        // 1. Fetch all live positions from exchange (one call, all symbols)
        try {
          const { fetchPositions } = await import('../../services/exchangeService.js');
          const livePositions = await fetchPositions();
          this._cachedExchangePositions = livePositions || [];
          this._exchangePositionsFetchedAt = Date.now();
          this._fetchedExchangeSuccessfully = true;
        } catch (e) {
          this.logger.debug(`[BG SYNC] fetchPositions failed: ${e.message}`);
          this._fetchedExchangeSuccessfully = false;
        }

        // 2. Fetch live balance
        if (process.env.TRADING_MODE === 'live') {
          try {
            const { fetchBalance } = await import('../../services/exchangeService.js');
            const liveBal = await fetchBalance();
            if (liveBal && liveBal.USDT) {
              this._cachedLiveBalance = { total: liveBal.USDT.total, free: liveBal.USDT.free };
            }
          } catch (e) {
            this.logger.debug(`[BG SYNC] fetchBalance failed: ${e.message}`);
          }
        }

        // 3. SL/TP trigger order sync (sequential per position, throttled internally)
        const openPositions = (portfolio.positions || []).filter(p => p && p.status === 'open');
        for (const position of openPositions) {
          if (!this._lastTriggerSync) this._lastTriggerSync = {};
          // Already synced within the last 60s — skip
          if (Date.now() - (this._lastTriggerSync[position.asset] || 0) < 60000) continue;
          this._lastTriggerSync[position.asset] = Date.now();
          try {
            const { getExchange } = await import('../../services/exchangeService.js');
            const exchange = getExchange();
            const symbol = `${position.asset.replace('USDT', '')}/USDT:USDT`;
            const openOrders = await exchange.fetchOpenOrders(symbol, undefined, undefined, { 'trigger': true });
            if (!this._cachedTriggerOrders) this._cachedTriggerOrders = {};
            this._cachedTriggerOrders[position.asset] = { orders: openOrders, ts: Date.now() };
            this.logger.info(`🔍 [TRIGGER SYNC] ${symbol}: fetched ${openOrders.length} open trigger orders`);
          } catch (e) {
            this.logger.debug(`[BG SYNC] fetchOpenOrders for ${position.asset} failed: ${e.message}`);
          }
        }

        // 4. Sync closed trades from exchange (every 5 seconds)
        if (!this._lastClosedSync || Date.now() - this._lastClosedSync > 5000) {
          this._lastClosedSync = Date.now();
          try {
            await this.syncClosedTradesFromExchange();
          } catch (e) {
            this.logger.debug(`[BG SYNC] syncClosedTrades failed: ${e.message}`);
          }
        }
      }
    } catch (bgErr) {
      this.logger.debug(`[BG SYNC] background sync cycle error: ${bgErr.message}`);
    }
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

    // 1. Use background-synced exchange positions (never await exchange API here — keeps cycle < 50ms)
    const activeExchangePositions = this._cachedExchangePositions || [];
    const fetchedExchangeSuccessfully = this._fetchedExchangeSuccessfully || false;

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

      // Ensure live WebSocket ticker subscription for active open position
      try {
        coinswitchWs.subscribe(position.asset);
      } catch (subErr) {}

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

      // Fixed Stop-Loss Mode: Stop-Loss remains fixed at initial entry level to give trades full room to hit targets.



      let isNativelyClosed = false;
      let closePrice = currentPrice;
      let closeReason = 'Exchange Native Trigger';

      if (fetchedExchangeSuccessfully) {
        const exchangePos = exchangePositionMap.get(position.asset);
        
        // If the position is open in DB but does not exist on CoinSwitch Pro, it has been natively closed!
        if (!exchangePos) {
          const positionAgeMs = Date.now() - new Date(position.openedAt || Date.now()).getTime();
          const MIN_RECONCILIATION_AGE_MS = 3000; // 3 seconds

          // Check if position is old enough to reconcile (to prevent racing with order placement)
          if (positionAgeMs >= MIN_RECONCILIATION_AGE_MS) {
            isNativelyClosed = true;
            this.logger.warn(`🔄 [RECONCILIATION] Open position for ${position.asset} is no longer active on CoinSwitch Pro. Syncing closure locally.`);

            // Try to fetch the last closed trade fill price from exchange history
            try {
              const { getExchange } = await import('../../services/exchangeService.js');
              const exchange = getExchange();
              const symbol = `${position.asset.replace('USDT', '')}/USDT:USDT`;
              const trades = await exchange.fetchMyTrades(symbol, undefined, 5);
              if (trades?.length > 0) {
                const lastTrade = trades[trades.length - 1];
                if (lastTrade.price && lastTrade.price > 0) {
                  closePrice = lastTrade.price;
                }
              }
            } catch (historyErr) {
              this.logger.debug(`Could not retrieve trade fill price from exchange history for ${position.asset}: ${historyErr.message}`);
            }

            // Dynamically determine whether this native exchange closure was a Stop-Loss, Take-Profit, or Manual Close
            const isLoss = position.side === 'long' ? (closePrice < position.entryPrice) : (closePrice > position.entryPrice);
            closeReason = isLoss
              ? `Closed Manually / Native SL Triggered on Exchange (${position.side.toUpperCase()} @ $${formatPrice(position.entryPrice)} vs Exit $${formatPrice(closePrice)})`
              : `Closed Manually / Native TP Triggered on Exchange (${position.side.toUpperCase()} @ $${formatPrice(position.entryPrice)} vs Exit $${formatPrice(closePrice)})`;
          }
        } else {
          // Position exists in both DB and Exchange. Always sync exact entry price and contracts.
          if (exchangePos.entryPrice && exchangePos.entryPrice > 0) {
            position.entryPrice = exchangePos.entryPrice;
          }
          if (exchangePos.contracts && exchangePos.contracts > 0) {
            position.quantity = exchangePos.contracts;
          }
          if (exchangePos.markPrice && exchangePos.markPrice > 0) {
            position.currentPrice = exchangePos.markPrice;
          }

          // Also sync corresponding open Trade record quantity and entryPrice to avoid DB-exchange drift
          try {
            const activeTrade = await Trade.findOne({ asset: position.asset, status: 'open' });
            if (activeTrade) {
              let changed = false;
              if (position.entryPrice > 0 && activeTrade.entryPrice !== position.entryPrice) {
                activeTrade.entryPrice = position.entryPrice;
                changed = true;
              }
              if (position.quantity > 0 && activeTrade.quantity !== position.quantity) {
                activeTrade.quantity = position.quantity;
                changed = true;
              }
              if (changed) {
                await activeTrade.save();
              }
            }
          } catch (tradeSyncErr) {
            this.logger.error(`Failed to sync Trade quantity/entryPrice for ${position.asset}: ${tradeSyncErr.message}`);
          }
          // SL/TP trigger order sync is handled by _runBackgroundSync() — not here
        }
      }

      if (isNativelyClosed) {
        await this.closePosition(portfolio, position, closePrice, closeReason, true);
        continue;
      }

      totalUnrealizedPnl += position.unrealizedPnl;
    }

    // 2b. Reverse Reconciliation: Import missing active exchange positions from CoinSwitch Pro into DB
    if (fetchedExchangeSuccessfully && activeExchangePositions.length > 0) {
      for (const p of activeExchangePositions) {
        const asset = p.symbol ? p.symbol.split(':')[0].replace('/', '') : '';
        if (!asset || p.contracts <= 0) continue;

        const existingInDb = portfolio.positions.find((pos) => pos && pos.asset === asset && pos.status === 'open');
        if (!existingInDb) {
          this.logger.info(`📥 [RECONCILIATION] Found active position for ${asset} on CoinSwitch Pro missing in local DB. Importing immediately!`);

          const side = (p.side || 'long').toLowerCase();
          const entryPrice = p.entryPrice || p.markPrice || 0;
          const quantity = p.contracts || p.amount || 0;
          const leverage = p.leverage || portfolio.defaultLeverage || 5;
          const minTarget = portfolio.minNetProfitTarget !== undefined ? portfolio.minNetProfitTarget : 0.25;
          const totalFeeEst = entryPrice * quantity * 0.001;
          const priceDeltaTarget = quantity > 0 ? ((minTarget + totalFeeEst) / quantity) : (entryPrice * 0.02);
          const priceDeltaRisk = quantity > 0 ? ((0.40 + totalFeeEst) / quantity) : (entryPrice * 0.03);

          const stopLoss = side === 'long' ? Math.max(0.000001, entryPrice - priceDeltaRisk) : entryPrice + priceDeltaRisk;
          const takeProfit = side === 'long' ? entryPrice + priceDeltaTarget : Math.max(0.000001, entryPrice - priceDeltaTarget);

          portfolio.positions.push({
            asset,
            side,
            entryPrice,
            currentPrice: p.markPrice || entryPrice,
            quantity,
            leverage,
            status: 'open',
            openedAt: new Date(),
            stopLoss,
            takeProfit,
            unrealizedPnl: p.unrealizedPnl || 0
          });

          try {
            await Trade.create({
              asset,
              side,
              type: 'MARKET',
              entryPrice,
              quantity,
              leverage,
              status: 'open',
              openedAt: new Date(),
              stopLoss,
              takeProfit
            });
          } catch (tradeErr) {
            this.logger.debug(`Could not create Trade record for reconciled ${asset}: ${tradeErr.message}`);
          }

          try {
            coinswitchWs.subscribe(asset);
          } catch (subErr) {}
        }
      }
    }

    // 3. Position Deduplication & Binance-to-Database Sync
    const seenOpenAssets = new Set();
    for (let i = portfolio.positions.length - 1; i >= 0; i--) {
      const pos = portfolio.positions[i];
      if (pos && pos.status === 'open') {
        if (seenOpenAssets.has(pos.asset)) {
          this.logger.warn(`🧹 [DEDUPLICATION] Marking duplicate open position for ${pos.asset} as closed`);
          pos.status = 'closed';
          pos.closedAt = new Date();
        } else {
          seenOpenAssets.add(pos.asset);
        }
      }
    }

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
                  this.logger.info(`✅ [NATIVE STOP-LOSS PLACED] stopPrice=${formattedStopLoss} id=${stopLossOrderId} on ${exchange.isDemo ? 'CoinSwitch Pro (Demo)' : 'CoinSwitch Pro'} for filled limit order`);
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
                  this.logger.info(`✅ [NATIVE TAKE-PROFIT PLACED] takeProfitPrice=${formattedTakeProfit} on ${exchange.isDemo ? 'CoinSwitch Pro (Demo)' : 'CoinSwitch Pro'} for filled limit order`);
                }
              } catch (triggerErr) {
                this.logger.error(`❌ [NATIVE TRIGGERS PLACEMENT FAILED] Failed to place stop/target orders on ${exchange.isDemo ? 'CoinSwitch Pro (Demo)' : 'CoinSwitch Pro'}: ${triggerErr.message}`);
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

          const minTarget = portfolio.minNetProfitTarget !== undefined ? portfolio.minNetProfitTarget : 0.25;
          const totalFeeEst = entryPrice * quantity * 0.001; // 0.1% total round-trip fee estimate
          const priceDeltaTarget = quantity > 0 ? ((minTarget + totalFeeEst) / quantity) : (entryPrice * 0.02);
          const priceDeltaRisk = quantity > 0 ? ((0.40 + totalFeeEst) / quantity) : (entryPrice * 0.03);

          const calculatedStopLoss = (activeTrade && activeTrade.stopLoss) 
            ? activeTrade.stopLoss 
            : (side === 'long' ? Math.max(0.000001, entryPrice - priceDeltaRisk) : entryPrice + priceDeltaRisk);
            
          const calculatedTakeProfit = (activeTrade && activeTrade.takeProfit) 
            ? activeTrade.takeProfit 
            : (side === 'long' ? entryPrice + priceDeltaTarget : Math.max(0.000001, entryPrice - priceDeltaTarget));

          let dynamicTrailingPct = undefined;
          const category = getCategoryForAsset(asset);

          const estimatedEntryFee = entryPrice * quantity * 0.0005;

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
            fees: (activeTrade && activeTrade.fees > 0) ? activeTrade.fees : estimatedEntryFee,
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
              fees: estimatedEntryFee,
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
            
            try {
              await sendTelegramMessage(
                `🔔 <b>Live Position Synced!</b>\n` +
                `<b>Asset</b>: ${asset.replace('USDT', '')}/USDT\n` +
                `<b>Action</b>: ${side === 'long' ? 'BUY (LONG)' : 'SELL (SHORT)'}\n` +
                `<b>Entry Price</b>: $${formatPrice(entryPrice)}\n` +
                `<b>Quantity</b>: ${quantity}\n` +
                `<b>Stop Loss</b>: $${formatPrice(calculatedStopLoss)}\n` +
                `<b>Target</b>: $${formatPrice(calculatedTakeProfit)}\n` +
                `<b>Status</b>: Active & Monitored for Net Scalp Target ($0.25+)`
              );
            } catch (tErr) {}
          }
        }
      }
    }

      // Stale DB trade cleanup uses cached exchange positions (already fast, O(n) over DB only)
      try {
        const liveSymbols = new Set(activeExchangePositions.map(p => p.symbol.split(':')[0].replace('/', '').toUpperCase()));
        const dbOpenTrades = await Trade.find({ status: 'open' });
        for (const trade of dbOpenTrades) {
          const cleanAsset = trade.asset.replace('/', '').replace(':USDT', '').toUpperCase();
          const ageMs = Date.now() - new Date(trade.executedAt || trade.createdAt || Date.now()).getTime();
          if (!liveSymbols.has(cleanAsset) && ageMs > 15000) {
            this.logger.info(`🔄 [RECONCILIATION] Closing stale DB Trade document for ${trade.asset} (ID: ${trade._id}) as it is no longer active on CoinSwitch Pro`);
            trade.status = 'closed';
            trade.closedAt = new Date();
            trade.exitReason = 'CoinSwitch exchange sync cleanup';
            await trade.save();
          }
        }
      } catch (tradeSyncErr) {
        this.logger.error(`Failed to reconcile DB Trade documents with exchange positions: ${tradeSyncErr.message}`);
      }
      // Note: syncClosedTradesFromExchange() runs in _runBackgroundSync() — not here

    // Recalculate total balance from background-cached live balance (no API call here)
    if (process.env.TRADING_MODE === 'live') {
      if (this._cachedLiveBalance) {
        portfolio.totalBalance = this._cachedLiveBalance.total;
        portfolio.availableBalance = this._cachedLiveBalance.free;
        portfolio.baseTradingCapital = this._cachedLiveBalance.total;
      }
    } else {
      const marginValue = portfolio.positions
        .filter((p) => p && p.status === 'open')
        .reduce((sum, p) => sum + ((p.entryPrice * p.quantity) / (p.leverage || 1) + p.unrealizedPnl), 0);

      portfolio.totalBalance = portfolio.availableBalance + marginValue;
    }

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

    // Instant Liquidity Check for active open positions (avoids network latency during exit checks)
    const liquidPositions = activeOpenPositions;
    const illiquidPositions = [];

    // Sort liquid positions by absolute unrealized PnL descending
    liquidPositions.sort((a, b) => Math.abs(b.unrealizedPnl || 0) - Math.abs(a.unrealizedPnl || 0));



    // ─── Phase 3: Dynamic Global Basket Profit (GBP) ───
    const baseCap = portfolio.baseTradingCapital || 100;
    const targetPct = portfolio.basketProfitTargetPct !== undefined ? portfolio.basketProfitTargetPct : 10;
    let basketTarget = baseCap * (targetPct / 100);


    if (portfolio.isSquaringOff) {
      if (liquidPositions.length === 0) {
        portfolio.isSquaringOff = false;
        await portfolio.save();
        this.logger.info(`[BASKET EXIT] All liquid positions closed successfully. Resetting square-off cooldown.`);
        await sendTelegramMessage(`🔄 <b>Basket Profit Reset</b>\nAll liquid positions successfully closed. Cooldown ended, fresh trades can now begin!`);
      } else {
        this.logger.info(`[BASKET EXIT] Square-off active. Closing remaining ${liquidPositions.length} liquid positions.`);
        const interleavedActive = sortInterleavedSquareOff(liquidPositions);
        for (const position of interleavedActive) {
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

    if (liquidPositions.length > 0 && totalNetUnrealizedPnl >= basketTarget) {
      this.logger.info(`[BASKET EXIT] Total liquid net unrealized profit reached $${totalNetUnrealizedPnl.toFixed(2)} after fees (>= $${basketTarget.toFixed(2)}). Triggering square-off!`);
      portfolio.isSquaringOff = true;
      await portfolio.save();

      const closedResults = [];
      const interleavedTrigger = sortInterleavedSquareOff(liquidPositions);
      for (const position of interleavedTrigger) {
        let currentPrice = this.marketAgent.getPrice(position.asset) || position.currentPrice || 0;
        const res = await this.closePosition(portfolio, position, currentPrice, `Basket Take Profit reached (+$${basketTarget.toFixed(2)} net target)`, false);
        if (res && res.success) {
          closedResults.push(res);
        }
      }

      const totalActualNetPnL = closedResults.reduce((sum, r) => sum + (r.netPnl || 0), 0);
      const usdToInr = portfolio.usdToInrRate || 96.54;
      const netPnlInr = totalActualNetPnL * usdToInr;

      const totalBalanceUsdt = portfolio.totalBalance || ((portfolio.baseTradingCapital || 100) + totalActualNetPnL);
      const totalBalanceInr = totalBalanceUsdt * usdToInr;

      await sendTelegramMessage(
        `🎯 <b>BASKET PROFIT TARGET ACHIEVED!</b>\n\n` +
        `• <b>Closed Positions</b>: ${closedResults.length} trades squared off\n` +
        `• <b>Net Realized Profit</b>: +$${totalActualNetPnL.toFixed(2)} USDT (+₹${netPnlInr.toFixed(2)} INR)\n` +
        `• <b>Total Account Balance</b>: $${totalBalanceUsdt.toFixed(2)} USDT (₹${totalBalanceInr.toFixed(2)} INR)\n` +
        `• <b>Exact Net Amount Received</b>: +$${totalActualNetPnL.toFixed(2)} USDT (+₹${netPnlInr.toFixed(2)} INR)\n\n` +
        `All active liquid positions have been closed and secured.`
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

      // Evaluate Net Scalp Target ($0.25+) during periodic checkExits loop as well
      await this.evaluateRealtimeExit(position.asset, currentPrice);



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
        if ((process.env.TRADING_MODE === 'live' || process.env.BINANCE_TESTNET_API_KEY) && (!activeTrade || !activeTrade.exchangeOrderId || !activeTrade.exchangeOrderId.startsWith('mock_'))) {
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

          const exitOrderType = portfolio.exitOrderType || 'market';
          this.logger.info(`🚨 [EXCHANGE EXIT TRIGGERED] Placing offsetting ${exitSide.toUpperCase()} (${exitOrderType.toUpperCase()}) order on Exchange for ${position.asset} (${closeQty} units)`);
          
          // Await close order and retrieve actual executed parameters from response
          const closeOrder = exitOrderType === 'market' 
            ? await placeMarketOrder(position.asset, exitSide, closeQty)
            : await placeLimitOrder(position.asset, exitSide, closeQty, closePrice);
          
          actualClosePrice = closeOrder.average || closeOrder.price || closePrice;
          if (closeOrder.fee && closeOrder.fee.cost) {
            actualFees = closeOrder.fee.cost;
          }
        }
      } catch (err) {
        this.logger.error(`❌ [EXCHANGE EXIT FAILED] Failed to place offsetting close order on Exchange for ${position.asset}: ${err.message}. Initiating auto-ignore with limit order fallback.`);
        
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
          this.logger.info(`🚨 [AUTO-IGNORE FALLBACK] Placing Limit ${exitSide.toUpperCase()} order on ${exchange.isDemo ? 'CoinSwitch Pro (Demo)' : 'CoinSwitch Pro'} for ${position.asset} at $${limitPrice}`);
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

    // Return funds to available balance
    if (process.env.TRADING_MODE === 'live') {
      try {
        const { fetchBalance } = await import('../../services/exchangeService.js');
        const liveBal = await fetchBalance();
        if (liveBal && liveBal.USDT) {
          portfolio.availableBalance = liveBal.USDT.free;
          portfolio.totalBalance = liveBal.USDT.total;
        }
      } catch (balErr) {
        this.logger.warn(`Failed to fetch live balance on closePosition: ${balErr.message}`);
      }
    } else {
      const returnValue = ((position.entryPrice * position.quantity) / (position.leverage || 1)) + position.realizedPnl - exitFee;
      portfolio.availableBalance += returnValue;
    }
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

      let openExposure = 0;
      let openUnrealized = 0;
      openPositions.forEach(p => {
        const leverage = p.leverage && p.leverage > 1 ? p.leverage : 10;
        const exposure = p.entryPrice * p.quantity;
        openExposure += (exposure / leverage);
        openUnrealized += p.unrealizedPnl;
      });

      let pendingMargin = 0;
      const pendingTrades = await Trade.find({ status: 'pending' });
      pendingTrades.forEach(t => {
        const leverage = t.leverage && t.leverage > 1 ? t.leverage : 3;
        const exposure = t.entryPrice * t.quantity;
        pendingMargin += ((exposure / leverage) + (t.fees || 0));
      });

      if (process.env.TRADING_MODE === 'live') {
        try {
          const bal = await fetchBalance();
          if (bal && bal.USDT) {
            portfolio.availableBalance = bal.USDT.free;
            portfolio.totalBalance = bal.USDT.total;
          }
        } catch (balErr) {
          this.logger.error(`Error fetching live exchange balance in updateMetrics: ${balErr.message}`);
        }
      } else {
        let baseCap = portfolio.baseTradingCapital || 100;
        let trueAvailable = baseCap + trueTotalPnl - (portfolio.walletBalance || 0);

        openPositions.forEach(p => {
          const leverage = p.leverage && p.leverage > 1 ? p.leverage : 10;
          const exposure = p.entryPrice * p.quantity;
          const margin = exposure / leverage;
          const entryFee = p.fees || 0;
          trueAvailable -= (margin + entryFee);
        });

        pendingTrades.forEach(t => {
          const leverage = t.leverage && t.leverage > 1 ? t.leverage : 3;
          const exposure = t.entryPrice * t.quantity;
          const margin = exposure / leverage;
          const entryFee = t.fees || 0;
          trueAvailable -= (margin + entryFee);
        });

        portfolio.availableBalance = trueAvailable;
        portfolio.totalBalance = trueAvailable + pendingMargin + openExposure + openUnrealized;
      }

      portfolio.totalPnl = trueTotalPnl;

      portfolio.winningTrades = winners;
      portfolio.losingTrades = losers;
      portfolio.totalTrades = totalClosed + openPositions.length;
      portfolio.winRate = totalClosed > 0 ? winners / totalClosed : 0;

      if (portfolio.totalBalance > portfolio.peakBalance) {
        portfolio.peakBalance = portfolio.totalBalance;
      }
    } catch (dbErr) {
      this.logger.error(`Error during self-healing portfolio metrics recalculation: ${dbErr.message}`);
    }

    const baseCapMetric = portfolio.baseTradingCapital || 100;
    portfolio.totalPnlPercent = portfolio.totalBalance > 0
      ? ((portfolio.totalBalance - baseCapMetric) / baseCapMetric) * 100  // vs initial capital
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
      targetProfitThreshold: portfolio.targetProfitThreshold || 110,
      baseTradingCapital: portfolio.baseTradingCapital || 100,
      basketProfitTargetPct: portfolio.basketProfitTargetPct || 10,
      manuallyDisabledAssets: portfolio.manuallyDisabledAssets || [],
      autoIgnoredAssets: portfolio.autoIgnoredAssets || [],
      dynamicTargets: {
        gbp: { 
          enabled: false,
          target: 0, 
          currentProgress: 0, 
          progressPct: 0 
        },
        cbp: {
          enabled: false,
          core: { target: 0, currentProgress: 0, progressPct: 0 },
          meme: { target: 0, currentProgress: 0, progressPct: 0 },
          recommended: { target: 0, currentProgress: 0, progressPct: 0 }
        }
      }
    });
  }


  async checkProfitTarget(portfolio) {
    const baseCap = portfolio.baseTradingCapital || 100;
    const sweepPct = portfolio.sweepTargetProfitPct !== undefined ? portfolio.sweepTargetProfitPct : 10;
    
    const sweepTarget = baseCap * (1 + sweepPct / 100);
    
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
    const liquidTotalBalance = process.env.TRADING_MODE === 'live'
      ? portfolio.totalBalance
      : portfolio.availableBalance + liquidOpenExposure + liquidOpenUnrealized - estimatedCloseFees;

    const isSweepTargetMet = liquidTotalBalance >= sweepTarget;

    if (isSweepTargetMet && !portfolio.tradingPaused) {
      const triggerReason = `[SWEEP TARGET MET] Liquid net worth reached $${liquidTotalBalance.toFixed(2)} (Target: $${sweepTarget.toFixed(2)})`;
      
      this.logger.warn(`🚨 ${triggerReason}. Initiating automatic square-off...`);
      
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
 
      // Sort liquid positions using interleaved priority: Highest Profit, Highest Loss, Next Highest Profit, Next Highest Loss...
      const interleavedPositionsToClose = sortInterleavedSquareOff(liquidPositionsToClose);
 
      for (const position of interleavedPositionsToClose) {
        try {
          let currentPrice = this.marketAgent.getPrice(position.asset) || position.currentPrice || position.entryPrice || 0;
          await this.closePosition(portfolio, position, currentPrice, `Sweep Target Met (Auto-Squareoff)`, false);
        } catch (closeErr) {
          this.logger.error(`Failed to close position for ${position.asset} during square-off: ${closeErr.message}`);
        }
      }
 
      // Recalculate true balance after liquid positions have been closed
      const marginValue = portfolio.positions
        .filter((p) => p && p.status === 'open')
        .reduce((sum, p) => sum + ((p.entryPrice * p.quantity) / (p.leverage || 1) + p.unrealizedPnl), 0);
      const postCloseTotalBalance = portfolio.availableBalance + marginValue;
 
      const excessProfit = postCloseTotalBalance - baseCap;
      
      if (excessProfit > 0) {
        portfolio.walletBalance = (portfolio.walletBalance || 0) + excessProfit;
        portfolio.totalBalance = baseCap;
        portfolio.availableBalance = baseCap - marginValue;
        portfolio.peakBalance = baseCap;
        
        this.logger.info(`💰 [PROFIT SWEEP] Swept $${excessProfit.toFixed(2)} of excess profit to the secure wallet. New wallet balance: ${portfolio.walletBalance.toFixed(2)}`);
        
        const usdToInr = portfolio.usdToInrRate || 96.54;
        const totalNetWorthUsdt = baseCap + excessProfit;
        const totalNetWorthInr = totalNetWorthUsdt * usdToInr;
        const excessProfitInr = excessProfit * usdToInr;

        await sendTelegramMessage(
          `🎯 <b>PROFIT SWEEP TARGET ACHIEVED!</b>\n\n` +
          `• <b>Liquid Net Worth</b>: $${totalNetWorthUsdt.toFixed(2)} USDT (₹${totalNetWorthInr.toFixed(2)} INR)\n` +
          `• <b>Exact Profit Swept</b>: +$${excessProfit.toFixed(2)} USDT (+₹${excessProfitInr.toFixed(2)} INR)\n` +
          `• <b>Total Vault Balance</b>: $${portfolio.walletBalance.toFixed(2)} USDT (₹${(portfolio.walletBalance * usdToInr).toFixed(2)} INR)\n` +
          `• <b>Status</b>: All positions squared off & trading bot paused.\n\n` +
          `<i>Resume trading anytime from your dashboard.</i>`
        );
      } else {
        this.logger.warn(`[PROFIT SWEEP] Net worth is not above base capital after closing liquid positions. No sweep performed.`);
      }
      await portfolio.save();
    }
  }

  /** Sync closed trades and fill history directly from CoinSwitch Pro exchange */
  async syncClosedTradesFromExchange() {
    try {
      const { getExchange } = await import('../../services/exchangeService.js');
      const exchange = getExchange();
      if (exchange.isDemo) return;

      const closedOrders = await exchange.fetchClosedOrders(undefined, undefined, 50);
      const executedOrders = (closedOrders || []).filter(o => o.status === 'closed' && o.filled > 0);

      for (const order of executedOrders) {
        const asset = order.symbol.split(':')[0].replace('/', '').toUpperCase();

        const existingTrade = await Trade.findOne({
          $or: [
            { exchangeOrderId: order.id },
            { asset, status: 'closed', exitPrice: order.price }
          ]
        });

        if (!existingTrade && order.reduceOnly) {
          this.logger.info(`🔄 [CLOSED TRADES SYNC] Syncing closed order ${order.id} for ${asset} from CoinSwitch Pro...`);
          
          const realizedPnl = order.realisedPnl || 0;
          const feeUsdt = (order.executionFee || 0) / 96.56;

          await Trade.create({
            userId: SYSTEM_USER_ID,
            asset,
            action: order.side === 'buy' ? 'BUY' : 'SELL',
            side: order.side === 'buy' ? 'short' : 'long',
            entryPrice: order.price,
            exitPrice: order.price,
            quantity: order.filled,
            realizedPnl,
            pnlPercentage: (order.price > 0 && order.filled > 0) ? (realizedPnl / (order.price * order.filled)) * 100 : 0,
            status: 'closed',
            exitReason: order.raw?.order_type === 'STOP_MARKET' 
              ? 'Native Stop-Loss Triggered on Exchange' 
              : order.raw?.order_type === 'TAKE_PROFIT_MARKET' 
                ? 'Native Take-Profit Triggered on Exchange' 
                : 'Closed Manually on CoinSwitch Pro',
            closedAt: new Date(order.timestamp || Date.now()),
            fees: feeUsdt
          });
        }
      }
    } catch (err) {
      this.logger.error(`Failed to sync closed trades from CoinSwitch Pro: ${err.message}`);
    }
  }

  /** Sub-50ms event-driven realtime exit evaluator triggered on live WebSocket price ticks */
  async evaluateRealtimeExit(asset, currentPrice) {
    if (!currentPrice || currentPrice <= 0) return;
    if (!this._cachedPortfolio || Date.now() - (this._lastPortfolioCacheTime || 0) > 3000) {
      let pDoc = await Portfolio.findOne({ userId: SYSTEM_USER_ID });
      if (!pDoc) pDoc = await Portfolio.findOne({});
      this._cachedPortfolio = pDoc;
      this._lastPortfolioCacheTime = Date.now();
    }
    const portfolio = this._cachedPortfolio;
    if (!portfolio || !portfolio.positions) return;

    const cleanAsset = asset ? asset.replace('/', '').replace('_', '').toUpperCase() : '';
    const position = portfolio.positions.find(p => p && p.asset && (p.asset.replace('/', '').replace('_', '').toUpperCase() === cleanAsset) && p.status === 'open');
    if (!position || this._activeExitLocks?.has(position.asset)) return;

    const entryPrice = position.entryPrice;
    const quantity = position.quantity;
    const side = position.side;
    const openFee = position.fees || (entryPrice * quantity * 0.0005);
    const closeFee = currentPrice * quantity * 0.0005;

    let grossPnl = 0;
    if (side === 'long') {
      grossPnl = (currentPrice - entryPrice) * quantity;
    } else {
      grossPnl = (entryPrice - currentPrice) * quantity;
    }

    const netPnl = grossPnl - openFee - closeFee;
    position.currentPrice = currentPrice;
    position.unrealizedPnl = netPnl;

    // Broadcast live portfolio update to Redis / Socket.io for active open position (throttled to 250ms per asset)
    const now = Date.now();
    if (!this._lastWsBroadcastMap) this._lastWsBroadcastMap = {};
    if (!this._lastWsBroadcastMap[asset] || (now - this._lastWsBroadcastMap[asset]) >= 250) {
      this._lastWsBroadcastMap[asset] = now;
      try {
        publishEvent(CHANNELS.PORTFOLIO_UPDATES, portfolio);
      } catch (pErr) {}
    }

    // Track peak net PnL for trailing stop
    if (!position.highestNetPnl || netPnl > position.highestNetPnl) {
      position.highestNetPnl = netPnl;
    }

    let shouldClose = false;
    let reason = '';

    const minTarget = portfolio.minNetProfitTarget !== undefined ? portfolio.minNetProfitTarget : 0.25;
    const riskFloorUsd = portfolio.trailingStopUsd !== undefined ? portfolio.trailingStopUsd : 0.40;

    // 1. Dynamic Net PnL Scalp Exit & Minimum Floor Trailing Stop ($0.10+ / $0.25+ Floor, configurable)
    if (position.highestNetPnl >= minTarget) {
      // Minimum floor is ALWAYS minTarget (never locks in less than minTarget)
      const trailingStep = Math.min(0.10, minTarget * 0.5);
      const lockedInFloor = Math.max(minTarget, position.highestNetPnl - trailingStep);
      if (netPnl <= lockedInFloor) {
        shouldClose = true;
        reason = `Net Scalp Target/Trailing Floor Reached (+$${lockedInFloor.toFixed(2)} Net PnL)`;
      }
    } else if (netPnl >= minTarget) {
      shouldClose = true;
      reason = `Net Scalp Target Reached (+$${netPnl.toFixed(2)} Net)`;
    } else if (netPnl <= -riskFloorUsd) { // Configurable Trailing Stop Loss / Risk Floor ($ USDT)
      shouldClose = true;
      reason = `Stop-Loss Risk Floor Triggered (-$${Math.abs(netPnl).toFixed(2)} Net PnL)`;
    }

    if (shouldClose) {
      if (!this._activeExitLocks) this._activeExitLocks = new Set();
      this._activeExitLocks.add(asset);
      try {
        this.logger.info(`⚡ [WEBSOCKET SUB-50MS EXIT] ${asset} ${side.toUpperCase()} triggered: ${reason}`);
        await this.closePosition(portfolio, position, currentPrice, reason, false);
        this._cachedPortfolio = null; // Invalidate cache after closing
      } finally {
        this._activeExitLocks.delete(asset);
      }
    }
  }
}
