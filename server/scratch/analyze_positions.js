import { getExchange } from '../services/exchangeService.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  console.log("=== Fetching Active Positions and Orders from Binance Futures ===");

  let exchange;
  try {
    exchange = getExchange();
    await exchange.loadMarkets();
  } catch (err) {
    console.error("❌ Failed to connect to exchange:", err.message);
    return;
  }

  // 1. Fetch active positions
  try {
    const positions = await exchange.fetchPositions();
    const activePositions = positions.filter((p) => parseFloat(p.contracts) > 0);
    
    console.log(`\nFound ${activePositions.length} active position(s):`);
    for (const pos of activePositions) {
      const asset = pos.symbol;
      const side = pos.side;
      const entryPrice = parseFloat(pos.entryPrice);
      const markPrice = parseFloat(pos.markPrice);
      const size = parseFloat(pos.contracts);
      const unrealizedPnl = parseFloat(pos.unrealizedPnl);

      console.log(`\n-----------------------------------------`);
      console.log(`Symbol: ${asset} | Side: ${side.toUpperCase()} | Size: ${size}`);
      console.log(`Entry Price: $${entryPrice} | Mark Price: $${markPrice}`);
      console.log(`Unrealized PnL: $${unrealizedPnl.toFixed(2)}`);

      // 2. Fetch open orders for this asset to locate SL and TP trigger prices
      try {
        const openOrders = await exchange.fetchOpenOrders(asset);
        console.log(`Open Orders on book: ${openOrders.length}`);
        
        for (const order of openOrders) {
          const type = order.type; // e.g. stop_market, limit
          const orderSide = order.side;
          const stopPrice = order.stopPrice || order.triggerPrice;
          const price = order.price;

          const percentDiff = entryPrice > 0 
            ? ((Math.abs(entryPrice - (stopPrice || price)) / entryPrice) * 100).toFixed(2)
            : '0.00';

          if (type.includes('stop') || type.includes('trigger')) {
            console.log(`  - TRIGGER ORDER: [${order.info?.origType || type}] Side: ${orderSide.toUpperCase()} | Trigger Price: $${stopPrice} (${percentDiff}% from entry)`);
          } else {
            console.log(`  - ORDER: [${type}] Side: ${orderSide.toUpperCase()} | Price: $${price} (${percentDiff}% from entry)`);
          }
        }
      } catch (orderErr) {
        console.log(`  ⚠️ Could not fetch open orders for ${asset}: ${orderErr.message}`);
      }
    }
  } catch (err) {
    console.error("❌ Failed to fetch positions:", err.message);
  }

  console.log("\n=========================================");
}

run().catch(console.error);
