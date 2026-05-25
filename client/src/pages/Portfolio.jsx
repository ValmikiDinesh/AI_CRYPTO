import { useState, useEffect } from 'react';
import { usePortfolioStore } from '../store.js';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { Wallet, TrendingUp, TrendingDown, Target, PieChart as PieIcon, BarChart3, ChevronRight, Activity } from 'lucide-react';
import axios from 'axios';

const COLORS = ['#0071e3', '#ff9f0a', '#30d158', '#ff453a', '#bf5af2'];

export default function Portfolio() {
  const portfolio = usePortfolioStore((s) => s.portfolio);
  const [trades, setTrades] = useState([]);
  const [allTrades, setAllTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [activeTab, setActiveTab] = useState('overview'); // 'overview' | 'history'

  useEffect(() => {
    fetchTrades();
    fetchStats();
    fetchPerformance();
    fetchAllTrades();
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

  const fetchAllTrades = async () => {
    try {
      const res = await axios.get('/api/trades?limit=100');
      if (res.data.success) setAllTrades(res.data.data);
    } catch {}
  };

  const allocation = portfolio.allocation?.length > 0
    ? portfolio.allocation
    : [{ asset: 'USDT (Cash)', percentage: 100, value: portfolio.availableBalance }];

  return (
    <div className="page-layout">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-5 border-b border-[#2c2c2e]/60 pb-5">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#f5f5f7]">Portfolio</h2>
          <p className="text-[11px] text-[#86868b] mt-1 font-medium">
            Analyze asset allocation models, historic performance returns, and session statistics.
          </p>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-5">
        {[
          { 
            label: 'Net Balances', 
            value: portfolio.totalBalance !== undefined && portfolio.totalBalance !== null 
              ? `$${portfolio.totalBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}` 
              : '$1,000.00', 
            icon: Wallet, 
            color: '#86868b' 
          },
          { 
            label: 'Realized Return', 
            value: portfolio.totalPnl !== undefined && portfolio.totalPnl !== null 
              ? `${portfolio.totalPnl >= 0 ? '+' : ''}$${portfolio.totalPnl.toFixed(2)}` 
              : '$0.00', 
            icon: portfolio.totalPnl >= 0 ? TrendingUp : TrendingDown, 
            color: portfolio.totalPnl >= 0 ? '#30d158' : '#ff453a' 
          },
          { 
            label: 'Win Rate', 
            value: `${((portfolio.winRate || 0) * 100).toFixed(1)}%`, 
            icon: Target, 
            color: '#86868b' 
          },
          { 
            label: 'Open Exposure', 
            value: portfolio.openPositions || 0, 
            icon: Activity, 
            color: '#86868b' 
          },
          { 
            label: 'Margin Available', 
            value: portfolio.availableBalance !== undefined && portfolio.availableBalance !== null 
              ? `$${portfolio.availableBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}` 
              : '$1,000.00', 
            icon: Wallet, 
            color: '#86868b' 
          },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="glass-panel bg-[#1c1c1e] py-4 px-5 flex flex-col justify-between min-h-[112px] gap-3 relative overflow-hidden group">
            {/* Subtle top glare overlay */}
            <div className="absolute inset-0 bg-gradient-to-br from-white/[0.015] to-transparent pointer-events-none" />
            
            {/* Elegant side-accent color band */}
            <div className="absolute left-0 top-0 bottom-0 w-1 transition-all duration-300 group-hover:h-full" style={{ background: color, height: '30%' }} />
            <div className="flex items-start justify-between">
              <span className="text-[9px] font-bold text-[#86868b] uppercase tracking-widest font-mono">{label}</span>
              <div className="text-zinc-500">
                <Icon size={13} style={{ color }} />
              </div>
            </div>
            <div className="mt-4">
              <div className="text-lg font-bold text-[#f5f5f7] font-mono tracking-tight">{value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tab Switcher */}
      <div className="flex border-b border-[#2c2c2e]/60 pb-1 mb-6 gap-6 text-[10px] font-bold font-mono">
        <button
          onClick={() => setActiveTab('overview')}
          className={`pb-2 border-b-2 transition-all duration-300 cursor-pointer ${
            activeTab === 'overview'
              ? 'border-[#0071e3] text-[#f5f5f7]'
              : 'border-transparent text-[#86868b] hover:text-[#f5f5f7]'
          }`}
        >
          PERFORMANCE OVERVIEW
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`pb-2 border-b-2 transition-all duration-300 cursor-pointer ${
            activeTab === 'history'
              ? 'border-[#0071e3] text-[#f5f5f7]'
              : 'border-transparent text-[#86868b] hover:text-[#f5f5f7]'
          }`}
        >
          DETAILED TRANSACTION LEDGER
        </button>
      </div>

      {activeTab === 'overview' ? (
        <>
          {/* Charts Row */}
          <div className="grid-layout-2">
            {/* Allocation Pie Chart */}
            <div className="glass-panel bg-[#1c1c1e]">
              <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest flex items-center gap-2 border-b border-[#2c2c2e]/60 pb-3 font-mono mb-4">
                <PieIcon size={14} className="text-sky-400" />
                Asset Allocation Models
              </h3>
              <div className="flex flex-col items-center">
                <ResponsiveContainer width="100%" height={210}>
                  <PieChart>
                    <Pie
                      data={allocation}
                      dataKey="percentage"
                      nameKey="asset"
                      cx="50%"
                      cy="50%"
                      outerRadius={75}
                      innerRadius={55}
                      paddingAngle={4}
                      strokeWidth={0}
                    >
                      {allocation.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} className="outline-none" />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: '#000000', border: '1px solid #2c2c2e', borderRadius: '12px', color: '#f5f5f7', fontSize: 10 }}
                      itemStyle={{ color: '#f5f5f7', fontFamily: 'monospace' }}
                      formatter={(v) => `${v.toFixed(1)}%`}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap gap-4 justify-center mt-3">
                  {allocation.map((a, i) => (
                    <span key={i} className="flex items-center gap-2 text-[9px] font-bold text-[#86868b] uppercase tracking-widest font-mono">
                      <span className="w-2 h-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }}></span>
                      {a.asset} ({a.percentage?.toFixed(1)}%)
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Trade PnL Bar Chart */}
            <div className="glass-panel bg-[#1c1c1e]">
              <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest flex items-center gap-2 border-b border-[#2c2c2e]/60 pb-3 font-mono mb-4">
                <BarChart3 size={14} className="text-purple-400" />
                Returns History (Closed Trades)
              </h3>
              {trades.length > 0 ? (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={trades.map((t, i) => ({ name: `#${i + 1}`, pnl: t.pnl || 0 }))} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.02)" vertical={false} />
                    <XAxis dataKey="name" stroke="#86868b" fontSize={9} tickLine={false} className="font-mono" />
                    <YAxis stroke="#86868b" fontSize={9} tickLine={false} className="font-mono" />
                    <Tooltip
                      contentStyle={{ background: '#000000', border: '1px solid #2c2c2e', borderRadius: '12px', color: '#f5f5f7' }}
                      itemStyle={{ fontSize: '11px', fontWeight: 'bold', color: '#f5f5f7', fontFamily: 'monospace' }}
                    />
                    <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                      {trades.map((t, i) => (
                        <Cell key={i} fill={(t.pnl || 0) >= 0 ? '#30d158' : '#ff453a'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[240px] flex items-center justify-center text-xs text-zinc-500 font-extrabold uppercase tracking-widest font-mono animate-pulse">
                  NO TRANSACTION HISTORY LOGGED
                </div>
              )}
            </div>
          </div>

          {/* Trade Stats Table */}
          {stats && stats.totalTrades > 0 && (
            <div className="glass-panel bg-[#1c1c1e] !p-0">
              <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest border-b border-[#2c2c2e]/60 p-6 pb-3 font-mono mb-4">
                Session Performance Benchmarks
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-6 pt-0 text-xs">
                {[
                  { label: 'Total Orders Executed', value: stats.totalTrades },
                  { label: 'Winning Trades', value: stats.winners, color: '#30d158' },
                  { label: 'Losing Trades', value: stats.losers, color: '#ff453a' },
                  { label: 'Cumulative Net return', value: `$${stats.totalPnl?.toFixed(2)}`, color: stats.totalPnl >= 0 ? '#30d158' : '#ff453a' },
                  { label: 'Average Outcome PnL', value: `$${stats.avgPnl?.toFixed(2)}` },
                  { label: 'Peak Trade Profit', value: `$${stats.bestTrade?.toFixed(2)}`, color: '#30d158' },
                  { label: 'Max Drawdown Loss', value: `$${stats.worstTrade?.toFixed(2)}`, color: '#ff453a' },
                  { label: 'Average Signal Conf', value: `${(stats.avgConfidence * 100).toFixed(1)}%` },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-black p-4 rounded-2xl border border-[#2c2c2e]/55 relative overflow-hidden pl-5 group">
                    <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: color || '#86868b' }} />
                    <div className="text-[9px] font-bold text-[#86868b] uppercase tracking-widest font-mono mb-1">{label}</div>
                    <div className="text-lg font-bold font-mono" style={{ color: color || '#f5f5f7' }}>
                      {value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        /* Detailed Transaction Ledger */
        <div className="glass-panel overflow-hidden bg-[#1c1c1e] !p-0">
          <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest border-b border-[#2c2c2e]/60 p-6 pb-3 font-mono mb-4">
            Autonomous Transaction Ledger
          </h3>
          {allTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center h-44">
              <Activity size={20} className="text-zinc-600 mb-2" />
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest font-mono">
                NO TRANSACTIONS LOGGED ON SYSTEM
              </span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-black/35 border-b border-[#2c2c2e]/60 text-[#86868b] font-bold text-[9px] uppercase tracking-widest font-mono">
                    <th className="px-6 py-4">Execution Date</th>
                    <th className="px-6 py-4">Asset</th>
                    <th className="px-6 py-4">Action</th>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4 text-right">Entry Price</th>
                    <th className="px-6 py-4 text-right">Exit Price</th>
                    <th className="px-6 py-4 text-right">Quantity</th>
                    <th className="px-6 py-4 text-right">Realized Return</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2c2c2e]/40">
                  {allTrades.map((trade, i) => {
                    const price = trade.entryPrice;
                    const exit = trade.exitPrice;
                    return (
                      <tr key={i} className="hover:bg-zinc-800/10 transition-all duration-150 font-semibold text-zinc-300">
                        <td className="px-6 py-4 text-zinc-500 font-mono text-[10px]">
                          {new Date(trade.createdAt).toLocaleString()}
                        </td>
                        <td className="px-6 py-4 font-bold text-[#f5f5f7] font-mono">
                          {trade.asset?.replace('1000', '').replace('USDT', '')}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider border font-mono ${
                            trade.action === 'BUY'
                              ? 'bg-[#30d158]/10 border-[#30d158]/20 text-[#30d158]'
                              : 'bg-[#ff453a]/10 border-[#ff453a]/20 text-[#ff453a]'
                          }`}>
                            {trade.action}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider border font-mono ${
                            trade.status === 'open'
                              ? 'bg-sky-500/10 border-sky-500/20 text-sky-400'
                              : 'bg-zinc-900 border-zinc-700/60 text-zinc-400'
                          }`}>
                            {trade.status}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right text-[#f5f5f7] font-mono font-bold">
                          {price ? (price >= 1 ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${price.toFixed(6)}`) : '—'}
                        </td>
                        <td className="px-6 py-4 text-right text-[#f5f5f7] font-mono font-bold">
                          {exit ? (exit >= 1 ? `$${exit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${exit.toFixed(6)}`) : '—'}
                        </td>
                        <td className="px-6 py-4 text-right text-[#86868b] font-mono">
                          {trade.quantity?.toFixed(5) || '—'}
                        </td>
                        <td 
                          className="px-6 py-4 text-right font-bold font-mono"
                          style={{ color: trade.status === 'open' ? '#86868b' : ((trade.pnl || 0) >= 0 ? '#30d158' : '#ff453a') }}
                        >
                          {trade.status === 'open' ? 'ACTIVE' : `${(trade.pnl || 0) >= 0 ? '+' : ''}$${trade.pnl?.toFixed(2)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
