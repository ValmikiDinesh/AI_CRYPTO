import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import { getExchange } from '../services/exchangeService.js';
import dotenv from 'dotenv';
dotenv.config();

// Usage: node scratch/force_close_trade_full.js <ASSET_BASE_OR_FULL>
// Example: node scratch/force_close_trade_full.js BOMEUSDT
// Example: node scratch/force_close_trade_full.js STGUSDT
async function run() {
  const args = process.argv.slice(2);
  let assetInput = args[0];

  if (!assetInput) {
    console.error("❌ Please specify the asset symbol (e.g. BOMEUSDT or STGUSDT)");
    process.exit(1);
  }

  // Normalize asset format to end with USDT
  if (!assetInput.endsWith('USDT')) {
    assetInput = assetInput + 'USDT';
  }
  const dbAsset = assetInput; // e.g. "BOMEUSDT"
  
  // Format to exchange symbol (e.g. "BOME/USDT:USDT" or "1000BONK/USDT:USDT")
  let exchangeSymbol = dbAsset.replace('USDT', '/USDT:USDT');
  if (dbAsset.startsWith('1000')) {
    // Already has 1000 prefix
  } else if (dbAsset === 'BONKUSDT' || dbAsset === 'SHIBUSDT' || dbAsset === 'PEPEUSDT' || dbAsset === 'FLOKIUSDT') {
    exchangeSymbol = '1000' + dbAsset.replace('USDT', '/USDT:USDT');
  }

  console.log(`=== STARTING FULL EMERGENCY CLOSE & CLEANUP FOR ${dbAsset} (${exchangeSymbol}) ===`);

  // 1. Initialize Exchange
  const exchange = getExchange();
  await exchange.loadMarkets();

  const market = exchange.market(exchangeSymbol);
  const maxMarketQty = market.limits?.market?.max || 100000;
  console.log(`Exchange limit info - Max Market Quantity: ${maxMarketQty}`);

  // 2. Cancel any open orders for this asset
  try {
    console.log(`🧹 Cancelling all open orders for ${exchangeSymbol} on exchange...`);
    await exchange.cancelAllOrders(exchangeSymbol);
    console.log(`✅ Cancelled all open orders on exchange.`);
  } catch (err) {
    console.log(`⚠️ Note: Cancel all orders result: ${err.message}`);
  }

  // 3. Fetch Active Positions from exchange
  let contractsToClose = 0;
  let positionSide = null;
  try {
    const positions = await exchange.fetchPositions([exchangeSymbol]);
    const activePos = positions.find(p => p.symbol === exchangeSymbol && parseFloat(p.contracts) > 0);
    if (activePos) {
      contractsToClose = parseFloat(activePos.contracts);
      positionSide = activePos.side; // 'long' or 'short'
      console.log(`Found active position on exchange: ${positionSide.toUpperCase()} of size ${contractsToClose} contracts.`);
    } else {
      console.log("No active position found on the exchange.");
    }
  } catch (err) {
    console.error(`❌ Failed to fetch positions: ${err.message}`);
  }

  // 4. Close the position on the exchange if it exists
  let exitPrice = 0;
  if (contractsToClose > 0 && positionSide) {
    try {
      const exitSide = positionSide === 'long' ? 'sell' : 'buy';
      let remaining = contractsToClose;
      let prices = [];
      
      while (remaining > 0) {
        const chunk = Math.min(remaining, maxMarketQty);
        console.log(`🚨 Placing offsetting ${exitSide.toUpperCase()} market order on Binance Demo to close ${chunk} contracts (Remaining: ${remaining - chunk})...`);
        const closeOrder = await exchange.createMarketOrder(exchangeSymbol, exitSide, chunk, undefined, { reduceOnly: true });
        const fillPrice = closeOrder.average || closeOrder.price || 0;
        if (fillPrice > 0) {
          prices.push(fillPrice);
        }
        remaining -= chunk;
      }
      
      exitPrice = prices.length > 0 ? (prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
      console.log(`✅ Successfully closed entire position on Binance! Average exit price: $${exitPrice}`);
    } catch (err) {
      console.error(`❌ Failed to place close order on exchange: ${err.message}`);
    }
  }

  // 5. Clean up MongoDB Database State
  await connectDB();
  
  const portfolio = await Portfolio.findOne({});
  if (portfolio) {
    const posIndex = portfolio.positions.findIndex(p => p.asset === dbAsset && p.status === 'open');
    if (posIndex !== -1) {
      const position = portfolio.positions[posIndex];
      position.status = 'closed';
      position.closedAt = new Date();
      
      if (exitPrice === 0) {
        try {
          const ticker = await exchange.fetchTicker(exchangeSymbol);
          exitPrice = ticker.last || ticker.close || position.entryPrice;
          console.log(`⚠️ Market order price was not returned. Used ticker price fallback: $${exitPrice}`);
        } catch (tickerErr) {
          exitPrice = position.entryPrice; // Fallback
        }
      }

      if (position.side === 'long') {
        position.realizedPnl = (exitPrice - position.entryPrice) * position.quantity;
      } else {
        position.realizedPnl = (position.entryPrice - exitPrice) * position.quantity;
      }
      position.unrealizedPnl = 0;
      
      const leverage = position.leverage || 5;
      const initialMargin = (position.entryPrice * position.quantity) / leverage;
      const returnValue = initialMargin + position.realizedPnl;
      
      portfolio.availableBalance += returnValue;
      
      // Remove or mark closed
      portfolio.positions.splice(posIndex, 1);
      console.log(`✅ Cleaned up portfolio position. Refunded margin + PnL: $${returnValue.toFixed(4)}`);
    } else {
      console.log(`⚠️ No active portfolio position found for ${dbAsset} in MongoDB.`);
    }
    
    // Recalculate portfolio metrics
    const openPositions = portfolio.positions.filter(p => p.status === 'open');
    const marginValue = openPositions.reduce((sum, p) => sum + ((p.entryPrice * p.quantity) / (p.leverage || 1) + p.unrealizedPnl), 0);
    
    // Clean up any negative availableBalance drift from ghost pending limit orders
    // Let's cancel all expired pending trades in MongoDB to free up balance
    const pendingTrades = await Trade.find({ asset: dbAsset, status: 'pending' });
    for (const pTrade of pendingTrades) {
      pTrade.status = 'cancelled';
      pTrade.metadata = { ...(pTrade.metadata || {}), cancelReason: 'Cleaned up during emergency force close' };
      await pTrade.save();
      const marginReserved = (pTrade.entryPrice * pTrade.quantity) / (pTrade.leverage || 3);
      portfolio.availableBalance += marginReserved;
      console.log(`✅ Cancelled pending Trade document for ${dbAsset} and refunded reserved margin $${marginReserved.toFixed(4)}`);
    }

    portfolio.totalBalance = portfolio.availableBalance + marginValue;
    await portfolio.save();
    console.log(`✅ Saved Portfolio. Available Balance: $${portfolio.availableBalance.toFixed(4)}, Total: $${portfolio.totalBalance.toFixed(4)}`);
  }

  const activeTrade = await Trade.findOne({ asset: dbAsset, status: 'open' });
  if (activeTrade) {
    activeTrade.status = 'closed';
    activeTrade.exitPrice = exitPrice > 0 ? exitPrice : activeTrade.entryPrice;
    activeTrade.closedAt = new Date();
    
    if (activeTrade.side === 'long') {
      activeTrade.pnl = (activeTrade.exitPrice - activeTrade.entryPrice) * activeTrade.quantity;
    } else {
      activeTrade.pnl = (activeTrade.entryPrice - activeTrade.exitPrice) * activeTrade.quantity;
    }
    activeTrade.metadata = { ...(activeTrade.metadata || {}), closeReason: 'Manually forced close via script' };
    await activeTrade.save();
    console.log(`✅ Cleaned up active Trade document.`);
  }

  await mongoose.connection.close();
  console.log("=== CLEANUP COMPLETE ===");
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close();
});
