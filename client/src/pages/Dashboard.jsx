import React, { useState, useEffect, useRef } from 'react';
import { useMarketStore, useSignalStore, usePortfolioStore, useTradeStore } from '../store.js';
import { TrendingUp, TrendingDown, DollarSign, Activity, Target, BarChart3, Bot, Zap } from 'lucide-react';
import axios from 'axios';

const ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'DOGEUSDT'];

function formatPrice(price) {
  if (!price) return '—';
  return price >= 1
    ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${price.toFixed(6)}`;
}

function SignalBadge({ action }) {
  const styles = {
    BUY: { bg: 'rgba(14, 203, 129, 0.08)', border: 'rgba(14, 203, 129, 0.25)', color: '#0ecb81', dot: '#0ecb81' },
    SELL: { bg: 'rgba(246, 70, 93, 0.08)', border: 'rgba(246, 70, 93, 0.25)', color: '#f6465d', dot: '#f6465d' },
    HOLD: { bg: 'rgba(132, 142, 156, 0.05)', border: 'rgba(132, 142, 156, 0.2)', color: '#848e9c', dot: '#848e9c' },
  };
  const s = styles[action] || styles.HOLD;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border transition-all duration-200"
      style={{ background: s.bg, borderColor: s.border, color: s.color }}>
      <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: s.dot }} />
      {action}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, subValue, iconColor }) {
  return (
    <div className="glass-panel py-4 px-5 flex flex-col justify-between min-h-[112px] gap-3 relative overflow-hidden transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20 group">
      {/* Subtle top glare overlay */}
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.015] to-transparent pointer-events-none" />
      
      {/* Elegant side-accent color band */}
      <div className="absolute left-0 top-0 bottom-0 w-1 transition-all duration-300 group-hover:h-full" style={{ background: iconColor, height: '30%' }} />

      <div className="flex items-start justify-between">
        <span className="text-[10px] font-black text-[var(--color-text-secondary)] uppercase tracking-wider">{label}</span>
        <div className="p-1.5 rounded-md transition-all duration-300 group-hover:scale-110" style={{ background: `${iconColor}15` }}>
          <Icon size={14} style={{ color: iconColor }} />
        </div>
      </div>
      <div>
        <div className="text-xl font-extrabold text-[var(--color-text-primary)] font-mono tracking-tight">{value}</div>
        {subValue && <div className="text-[9px] text-[var(--color-text-secondary)] mt-1 font-semibold">{subValue}</div>}
      </div>
    </div>
  );
}

function LivePriceCard({ asset, price, signal, tech }) {
  const [tickDirection, setTickDirection] = useState(null); // 'up' | 'down' | null
  const prevPriceRef = useRef(price);

  useEffect(() => {
    if (price !== undefined && prevPriceRef.current !== undefined) {
      if (price > prevPriceRef.current) {
        setTickDirection('up');
        const timer = setTimeout(() => setTickDirection(null), 500);
        return () => clearTimeout(timer);
      } else if (price < prevPriceRef.current) {
        setTickDirection('down');
        const timer = setTimeout(() => setTickDirection(null), 500);
        return () => clearTimeout(timer);
      }
    }
    prevPriceRef.current = price;
  }, [price]);

  const priceColor = tickDirection === 'up'
    ? 'text-[var(--color-accent-green)] font-black scale-102 origin-left transition-all duration-100'
    : tickDirection === 'down'
      ? 'text-[var(--color-accent-red)] font-black scale-102 origin-left transition-all duration-100'
      : 'text-[var(--color-text-primary)]';

  const glowBorder = tickDirection === 'up'
    ? 'border-[var(--color-accent-green)]/40 shadow-md shadow-[var(--color-accent-green)]/5'
    : tickDirection === 'down'
      ? 'border-[var(--color-accent-red)]/40 shadow-md shadow-[var(--color-accent-red)]/5'
      : 'border-[var(--color-border)]';

  return (
    <div className={`glass-panel py-4 px-5 flex flex-col justify-between min-h-[128px] gap-3 relative overflow-hidden transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20 ${glowBorder}`}>
      {/* Decorative center light ray */}
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[#02c0f9]/20 to-transparent pointer-events-none" />

      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-1">
          <span className="text-sm font-black text-[var(--color-text-primary)]">{asset.replace('USDT', '')}</span>
          <span className="text-[8px] text-[var(--color-text-secondary)] font-bold uppercase tracking-wider">/ USDT</span>
        </div>
        {signal ? (
          <SignalBadge action={signal.action} />
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[8px] font-bold text-[var(--color-text-secondary)] uppercase bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
            <span className="w-1 h-1 rounded-full bg-[var(--color-text-secondary)]" />
            No Signal
          </span>
        )}
      </div>

      <div className={`text-2xl font-black font-mono tracking-tight my-2 ${priceColor}`}>
        {formatPrice(price)}
      </div>

      <div className="flex items-center justify-between text-[9px] text-[var(--color-text-secondary)] font-semibold border-t border-[var(--color-border)] pt-2.5">
        <span className="flex items-center gap-1">
          Regime: 
          <span className={`px-1.5 py-0.5 rounded-sm font-bold uppercase text-[8px] ${
            tech?.indicators?.regime === 'bullish' 
              ? 'bg-[var(--color-accent-green-dim)] text-[var(--color-accent-green)]' 
              : tech?.indicators?.regime === 'bearish' 
                ? 'bg-[var(--color-accent-red-dim)] text-[var(--color-accent-red)] font-bold' 
                : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)]'
          }`}>
            {tech?.indicators?.regime || 'ranging'}
          </span>
        </span>
        {signal?.confidence !== undefined && (
          <span className="font-mono bg-[var(--color-bg-secondary)] px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-primary)] text-[8px]">
            CONF: <span className="font-black">{(signal.confidence * 100).toFixed(0)}%</span>
          </span>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const prices = useMarketStore((s) => s.prices);
  const fusedSignals = useSignalStore((s) => s.fusedSignals);
  const technicalSignals = useSignalStore((s) => s.technicalSignals);
  const signalHistory = useSignalStore((s) => s.signalHistory);
  const portfolio = usePortfolioStore((s) => s.portfolio);
  const recentTrades = useTradeStore((s) => s.recentTrades);

  useEffect(() => {
    const fetchPortfolio = async () => {
      try {
        const res = await axios.get('/api/portfolio/performance');
        if (res.data.success) {
          usePortfolioStore.getState().setPortfolio(res.data.data);
        }
      } catch {}
    };
    fetchPortfolio();
  }, []);

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Elegant Header */}
      <div className="border-b border-[var(--color-border)] pb-4">
        <h2 className="text-base font-extrabold text-[var(--color-text-primary)] uppercase tracking-wide">Command Dashboard</h2>
        <p className="text-[11px] text-[var(--color-text-secondary)] font-semibold">
          Autonomous multi-agent system analyzing cryptomarkets in paper trading mode.
        </p>
      </div>

      {/* Portfolio Summary Card Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={DollarSign}
          label="Total Balance"
          value={`$${portfolio.totalBalance?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || '10,000.00'}`}
          subValue={`Available Capital: $${portfolio.availableBalance?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || '10,000.00'}`}
          iconColor="#02c0f9"
        />
        <StatCard
          icon={portfolio.totalPnl >= 0 ? TrendingUp : TrendingDown}
          label="Total Return PnL"
          value={`${portfolio.totalPnl >= 0 ? '+' : ''}$${portfolio.totalPnl?.toFixed(2) || '0.00'}`}
          subValue={`${portfolio.totalPnlPercent >= 0 ? '+' : ''}${portfolio.totalPnlPercent?.toFixed(2) || '0.00'}% Net Return`}
          iconColor={portfolio.totalPnl >= 0 ? '#0ecb81' : '#f6465d'}
        />
        <StatCard
          icon={Target}
          label="Win Rate"
          value={`${((portfolio.winRate || 0) * 100)?.toFixed(1) || '0.0'}%`}
          subValue={`${portfolio.openPositions || 0} active positions exposure`}
          iconColor="#8b5cf6"
        />
        <StatCard
          icon={Activity}
          label="Session PnL"
          value={`${portfolio.dailyPnl >= 0 ? '+' : ''}$${portfolio.dailyPnl?.toFixed(2) || '0.00'}`}
          subValue="Binance Futures testnet environment"
          iconColor="#f0b90b"
        />
      </div>

      {/* Live Market Prices + Signals Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Live Tickers */}
        <div className="lg:col-span-2 space-y-3">
          <h3 className="text-xs font-bold text-[var(--color-text-secondary)] uppercase tracking-widest flex items-center gap-2">
            <Zap size={12} className="text-[var(--color-accent-blue)]" />
            Live Market Prices
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {ASSETS.map((asset) => {
              const price = prices[asset];
              const signal = fusedSignals[asset];
              const tech = technicalSignals[asset];
              return (
                <LivePriceCard
                  key={asset}
                  asset={asset}
                  price={price}
                  signal={signal}
                  tech={tech}
                />
              );
            })}
          </div>
        </div>

        {/* Recent AI Signals */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-[var(--color-text-secondary)] uppercase tracking-widest flex items-center gap-2">
            <Bot size={12} className="text-purple-400" />
            Recent AI Signals
          </h3>
          <div className="glass-panel overflow-hidden min-h-[280px]">
            {signalHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-12 text-center h-full min-h-[280px]">
                <span className="text-[10px] text-[var(--color-text-secondary)] font-bold uppercase tracking-wider animate-pulse">
                  Waiting for signals...
                </span>
              </div>
            ) : (
              <div className="divide-y divide-[var(--color-border)] max-h-[280px] overflow-y-auto text-xs">
                {signalHistory.slice(0, 5).map((sig, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-3.5 hover:bg-[var(--color-bg-card-hover)] transition-colors group">
                    <div>
                      <span className="font-extrabold text-[var(--color-text-primary)] group-hover:text-[var(--color-accent-blue)] transition-colors">
                        {sig.asset?.replace('USDT', '')}
                      </span>
                      <span className="text-[9px] text-[var(--color-text-secondary)] ml-2.5 font-mono font-semibold">
                        {sig.timestamp ? new Date(sig.timestamp).toLocaleTimeString() : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <SignalBadge action={sig.action} />
                      <span className="font-bold text-[var(--color-text-primary)] font-mono">
                        {sig.confidence ? `${(sig.confidence * 100).toFixed(0)}%` : ''}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Autonomous Trade Ledger */}
      <div className="space-y-3">
        <h3 className="text-xs font-bold text-[var(--color-text-secondary)] uppercase tracking-widest flex items-center gap-2">
          <BarChart3 size={12} className="text-[var(--color-accent-blue)]" />
          Autonomous Trade Ledger
        </h3>
        <div className="glass-panel overflow-hidden">
          {recentTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center h-40">
              <span className="text-[10px] text-[var(--color-text-secondary)] font-bold uppercase tracking-wider">No trades executed in this session</span>
            </div>
          ) : (
            <div className="overflow-x-auto text-xs">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] text-[var(--color-text-secondary)] font-black text-[9px] uppercase tracking-wider">
                    <th className="px-6 py-3.5">Asset</th>
                    <th className="px-6 py-3.5">Action</th>
                    <th className="px-6 py-3.5 text-right">Price</th>
                    <th className="px-6 py-3.5 text-right">Qty</th>
                    <th className="px-6 py-3.5 text-right">Confidence</th>
                    <th className="px-6 py-3.5 text-right">PnL</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {recentTrades.slice(0, 5).map((trade, i) => (
                    <tr key={i} className="hover:bg-[var(--color-bg-card-hover)] transition-all duration-150">
                      <td className="px-6 py-3.5 font-black text-[var(--color-text-primary)]">
                        {trade.asset?.replace('USDT', '')}
                      </td>
                      <td className="px-6 py-3.5">
                        <SignalBadge action={trade.action} />
                      </td>
                      <td className="px-6 py-3.5 text-right text-[var(--color-text-primary)] font-mono font-semibold">
                        {formatPrice(trade.price)}
                      </td>
                      <td className="px-6 py-3.5 text-right text-[var(--color-text-secondary)] font-mono">
                        {trade.quantity?.toFixed(5) || '—'}
                      </td>
                      <td className="px-6 py-3.5 text-right font-black text-[var(--color-accent-blue)] font-mono">
                        {trade.confidence ? `${(trade.confidence * 100).toFixed(0)}%` : '—'}
                      </td>
                      <td className="px-6 py-3.5 text-right font-black font-mono"
                        style={{ color: (trade.pnl || 0) >= 0 ? 'var(--color-accent-green)' : 'var(--color-accent-red)' }}>
                        {trade.pnl != null ? `${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}` : 'Active'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
