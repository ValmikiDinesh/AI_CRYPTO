import dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: './server/.env' });
dotenv.config({ path: '../.env' });
import connectDB from '../config/db.js';
import Portfolio from '../models/Portfolio.js';
import Trade from '../models/Trade.js';
import { fetchPositions, fetchBalance } from '../services/exchangeService.js';

async function reconcileNow() {
  await connectDB();
  const portfolio = await Portfolio.findOne();
  if (!portfolio) {
    console.log('No portfolio found');
    process.exit(1);
  }

  const livePositions = await fetchPositions();
  const liveBalance = await fetchBalance();

  console.log('=== LIVE BALANCE ===', liveBalance);
  console.log('=== LIVE POSITIONS COUNT ===', livePositions.length);

  // 1. Sync Live USDT Balances
  if (liveBalance && liveBalance.USDT) {
    portfolio.totalBalance = liveBalance.USDT.total;
    portfolio.availableBalance = liveBalance.USDT.free;
    portfolio.baseTradingCapital = liveBalance.USDT.total;
    portfolio.peakBalance = Math.max(portfolio.peakBalance || 0, liveBalance.USDT.total);
    console.log(`Synced balance: Total = $${portfolio.totalBalance.toFixed(2)}, Free = $${portfolio.availableBalance.toFixed(2)}`);
  }

  const liveSymbolMap = new Map();
  livePositions.forEach(p => {
    const asset = p.symbol.split(':')[0].replace('/', '').toUpperCase();
    liveSymbolMap.set(asset, p);
  });

  // 2. Mark phantom DB positions as closed
  for (const pos of portfolio.positions) {
    if (pos && pos.status === 'open') {
      if (!liveSymbolMap.has(pos.asset)) {
        console.log(`Closing phantom DB position: ${pos.asset}`);
        pos.status = 'closed';
        pos.closedAt = new Date();
        const activeTrade = await Trade.findOne({ asset: pos.asset, status: 'open' });
        if (activeTrade) {
          activeTrade.status = 'closed';
          activeTrade.closedAt = new Date();
          await activeTrade.save();
        }
      }
    }
  }

  // 3. Import missing live positions from CoinSwitch Pro into DB
  for (const liveP of livePositions) {
    const asset = liveP.symbol.split(':')[0].replace('/', '').toUpperCase();
    let existing = portfolio.positions.find(p => p && p.asset === asset && p.status === 'open');
    if (!existing) {
      console.log(`Importing live position from CoinSwitch: ${asset}`);
      const minTarget = portfolio.minNetProfitTarget !== undefined ? portfolio.minNetProfitTarget : 0.25;
      const totalFeeEst = liveP.entryPrice * liveP.contracts * 0.001;
      const priceDeltaTarget = liveP.contracts > 0 ? ((minTarget + totalFeeEst) / liveP.contracts) : (liveP.entryPrice * 0.02);
      const priceDeltaRisk = liveP.contracts > 0 ? ((0.40 + totalFeeEst) / liveP.contracts) : (liveP.entryPrice * 0.03);

      const calculatedStopLoss = liveP.side === 'long' ? Math.max(0.000001, liveP.entryPrice - priceDeltaRisk) : liveP.entryPrice + priceDeltaRisk;
      const calculatedTakeProfit = liveP.side === 'long' ? liveP.entryPrice + priceDeltaTarget : Math.max(0.000001, liveP.entryPrice - priceDeltaTarget);

      portfolio.positions.push({
        asset,
        side: liveP.side,
        entryPrice: liveP.entryPrice,
        currentPrice: liveP.markPrice || liveP.entryPrice,
        quantity: liveP.contracts,
        leverage: liveP.leverage || 5,
        stopLoss: calculatedStopLoss,
        takeProfit: calculatedTakeProfit,
        openedAt: new Date(),
        status: 'open',
        fees: (liveP.entryPrice * liveP.contracts * 0.0005)
      });
      await Trade.create({
        userId: portfolio.userId,
        asset,
        action: liveP.side === 'long' ? 'BUY' : 'SELL',
        side: liveP.side,
        entryPrice: liveP.entryPrice,
        quantity: liveP.contracts,
        leverage: liveP.leverage || 5,
        stopLoss: calculatedStopLoss,
        takeProfit: calculatedTakeProfit,
        status: 'open',
        exchangeOrderId: 'synced_from_coinswitch'
      });

      try {
        await sendTelegramMessage(
          `🔔 <b>Live Position Synced from CoinSwitch!</b>\n` +
          `<b>Asset</b>: ${asset.replace('USDT', '')}/USDT\n` +
          `<b>Action</b>: ${liveP.side.toUpperCase()} (${liveP.leverage || 5}x)\n` +
          `<b>Entry Price</b>: $${liveP.entryPrice}\n` +
          `<b>Quantity</b>: ${liveP.contracts}\n` +
          `<b>Stop Loss</b>: $${calculatedStopLoss.toFixed(4)}\n` +
          `<b>Target</b>: $${calculatedTakeProfit.toFixed(4)}\n` +
          `<b>Status</b>: Active & Monitored for Net Scalp Target ($0.25+)`
        );
      } catch (tErr) {}
    } else {
      // Sync quantity and entry price
      console.log(`Syncing entryPrice for existing position ${asset}: ${existing.entryPrice} -> ${liveP.entryPrice}`);
      existing.entryPrice = liveP.entryPrice;
      existing.quantity = liveP.contracts;
      existing.currentPrice = liveP.markPrice || existing.currentPrice;

      const activeTrade = await Trade.findOne({ asset, status: 'open' });
      if (activeTrade) {
        activeTrade.entryPrice = liveP.entryPrice;
        activeTrade.quantity = liveP.contracts;
        await activeTrade.save();
      }
    }
  }

  await portfolio.save();
  console.log('\n✅ RECONCILIATION COMPLETE! DB is 100% in sync with CoinSwitch Pro!');
  process.exit(0);
}

reconcileNow();
