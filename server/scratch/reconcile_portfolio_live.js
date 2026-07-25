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
      portfolio.positions.push({
        asset,
        side: liveP.side,
        entryPrice: liveP.entryPrice,
        currentPrice: liveP.markPrice || liveP.entryPrice,
        quantity: liveP.contracts,
        leverage: liveP.leverage || 5,
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
        status: 'open',
        exchangeOrderId: 'synced_from_coinswitch'
      });
    } else {
      // Sync quantity and entry price
      existing.entryPrice = liveP.entryPrice;
      existing.quantity = liveP.contracts;
      existing.currentPrice = liveP.markPrice || existing.currentPrice;
    }
  }

  await portfolio.save();
  console.log('\n✅ RECONCILIATION COMPLETE! DB is 100% in sync with CoinSwitch Pro!');
  process.exit(0);
}

reconcileNow();
