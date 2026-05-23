import { useState, useEffect } from 'react';
import { usePortfolioStore } from '../store.js';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { Wallet, TrendingUp, TrendingDown, Target, PieChart as PieIcon, BarChart3 } from 'lucide-react';
import axios from 'axios';

const COLORS = ['#02c0f9', '#f0b90b', '#0ecb81', '#f6465d', '#8b5cf6'];

export default function Portfolio() {
  const portfolio = usePortfolioStore((s) => s.portfolio);
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    fetchTrades();
    fetchStats();
    fetchPerformance();
  }, []);

  const fetchPerformance = async () => {
    try {
      const res = await axios.get('/api/portfolio/performance');
      if (res.data.success) {
        usePortfolioStore.getState().setPortfolio(res.data.data);
      }
    } catch {}
  };

  const fetchTrades = async () => {
    try {
      const res = await axios.get('/api/trades?status=closed&limit=30');
      if (res.data.success) setTrades(res.data.data);
    } catch { /* silent */ }
  };

  const fetchStats = async () => {
    try {
      const res = await axios.get('/api/trades/stats');
      if (res.data.success) setStats(res.data.data);
    } catch { /* silent */ }
  };

  const allocation = portfolio.allocation?.length > 0
    ? portfolio.allocation
    : [{ asset: 'USDT (Cash)', percentage: 100, value: portfolio.availableBalance }];

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Header */}
      <div className="border-b border-[var(--color-border)] pb-4">
        <h2 className="text-base font-extrabold text-[var(--color-text-primary)] uppercase tracking-wide flex items-center gap-2">
          <Wallet size={16} className="text-[var(--color-accent-blue)]" />
          Portfolio Performance
        </h2>
        <p className="text-[11px] text-[var(--color-text-secondary)] font-semibold">Live balance breakdown, allocations, and trade stats auditing.</p>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { label: 'Total Balances', value: `$${portfolio.totalBalance?.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, icon: Wallet, color: '#02c0f9' },
          { label: 'Realized PnL', value: `${portfolio.totalPnl >= 0 ? '+' : ''}$${portfolio.totalPnl?.toFixed(2)}`, icon: portfolio.totalPnl >= 0 ? TrendingUp : TrendingDown, color: portfolio.totalPnl >= 0 ? '#0ecb81' : '#f6465d' },
          { label: 'Win Rate', value: `${((portfolio.winRate || 0) * 100).toFixed(1)}%`, icon: Target, color: '#f0b90b' },
          { label: 'Open Positions', value: portfolio.openPositions || 0, icon: BarChart3, color: '#02c0f9' },
          { label: 'Available cash', value: `$${portfolio.availableBalance?.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, icon: Wallet, color: '#f0b90b' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="glass-panel p-5 flex flex-col justify-between h-28 relative overflow-hidden group">
            {/* Subtle top glare overlay */}
            <div className="absolute inset-0 bg-gradient-to-br from-white/[0.015] to-transparent pointer-events-none" />
            
            {/* Elegant side-accent color band */}
            <div className="absolute left-0 top-0 bottom-0 w-1 transition-all duration-300 group-hover:h-full" style={{ background: color, height: '30%' }} />

            <div className="flex items-start justify-between">
              <span className="text-[10px] font-black text-[var(--color-text-secondary)] uppercase tracking-wider">{label}</span>
              <div className="p-1.5 rounded-md transition-all duration-300 group-hover:scale-110" style={{ background: `${color}15` }}>
                <Icon size={14} style={{ color }} />
              </div>
            </div>
            <div>
              <div className="text-xl font-extrabold text-[var(--color-text-primary)] font-mono tracking-tight">{value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Allocation Pie Chart */}
        <div className="glass-panel p-5">
          <h3 className="text-xs font-bold text-[var(--color-text-primary)] uppercase tracking-wider mb-4 flex items-center gap-2 border-b border-[var(--color-border)] pb-2">
            <PieIcon size={13} className="text-[var(--color-accent-blue)]" />
            Asset Allocation
          </h3>
          <div className="flex flex-col items-center">
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={allocation}
                  dataKey="percentage"
                  nameKey="asset"
                  cx="50%"
                  cy="50%"
                  outerRadius={75}
                  innerRadius={45}
                  paddingAngle={3}
                  strokeWidth={0}
                >
                  {allocation.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} className="outline-none" />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: '#12161a', border: '1px solid #2b313a', borderRadius: '6px', color: '#eaecef', fontSize: 10 }}
                  itemStyle={{ color: '#eaecef' }}
                  formatter={(v) => `${v.toFixed(1)}%`}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap gap-3 justify-center mt-2">
              {allocation.map((a, i) => (
                <span key={i} className="flex items-center gap-1.5 text-[9px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">
                  <span className="w-2 h-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }}></span>
                  {a.asset} ({a.percentage?.toFixed(1)}%)
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Trade PnL Bar Chart */}
        <div className="glass-panel p-5">
          <h3 className="text-xs font-bold text-[var(--color-text-primary)] uppercase tracking-wider mb-4 flex items-center gap-2 border-b border-[var(--color-border)] pb-2">
            <BarChart3 size={13} className="text-[var(--color-accent-yellow)]" />
            PnL returns history (Recent Closed)
          </h3>
          {trades.length > 0 ? (
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={trades.map((t, i) => ({ name: `#${i + 1}`, pnl: t.pnl || 0 }))} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="name" stroke="var(--color-text-secondary)" fontSize={9} tickLine={false} />
                <YAxis stroke="var(--color-text-secondary)" fontSize={9} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: '#12161a', border: '1px solid #2b313a', borderRadius: '6px', color: '#eaecef' }}
                  itemStyle={{ fontSize: '11px', fontWeight: 'bold', color: '#eaecef' }}
                />
                <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                  {trades.map((t, i) => (
                    <Cell key={i} fill={(t.pnl || 0) >= 0 ? 'var(--color-accent-green)' : 'var(--color-accent-red)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[230px] flex items-center justify-center text-xs text-[var(--color-text-secondary)] uppercase tracking-wider font-semibold">
              No closed trades logged
            </div>
          )}
        </div>
      </div>

      {/* Trade Stats Table */}
      {stats && stats.totalTrades > 0 && (
        <div className="glass-panel p-5">
          <h3 className="text-xs font-bold text-[var(--color-text-primary)] uppercase tracking-wider mb-4 border-b border-[var(--color-border)] pb-2">
            Session Performance Statistics
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-1 text-xs">
            {[
              { label: 'Total Trades', value: stats.totalTrades },
              { label: 'Winners', value: stats.winners, color: 'var(--color-accent-green)' },
              { label: 'Losers', value: stats.losers, color: 'var(--color-accent-red)' },
              { label: 'Total realized Return', value: `$${stats.totalPnl?.toFixed(2)}`, color: stats.totalPnl >= 0 ? 'var(--color-accent-green)' : 'var(--color-accent-red)' },
              { label: 'Avg Outcome PnL', value: `$${stats.avgPnl?.toFixed(2)}` },
              { label: 'Best Trade Profit', value: `$${stats.bestTrade?.toFixed(2)}`, color: 'var(--color-accent-green)' },
              { label: 'Worst Trade Loss', value: `$${stats.worstTrade?.toFixed(2)}`, color: 'var(--color-accent-red)' },
              { label: 'Avg Confidence', value: `${(stats.avgConfidence * 100).toFixed(1)}%` },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-[var(--color-bg-secondary)] p-3 rounded border border-[var(--color-border)] relative overflow-hidden pl-4">
                <div className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: color || 'var(--color-border-light)' }} />
                <div className="text-[9px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-0.5">{label}</div>
                <div className="text-base font-extrabold font-mono" style={{ color: color || 'var(--color-text-primary)' }}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
