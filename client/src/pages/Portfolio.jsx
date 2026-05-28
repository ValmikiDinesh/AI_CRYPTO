import { useState, useEffect } from 'react';
import { usePortfolioStore } from '../store.js';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { Wallet, TrendingUp, TrendingDown, Target, PieChart as PieIcon, BarChart3, ChevronRight, Activity } from 'lucide-react';
import axios from 'axios';

const COLORS = ['#0071e3', '#ff9f0a', '#30d158', '#ff453a', '#bf5af2'];

const CORE_ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT'];
const MEME_ASSETS = ['DOGEUSDT', '1000SHIBUSDT', '1000PEPEUSDT', 'WIFUSDT', '1000FLOKIUSDT', '1000BONKUSDT', 'BOMEUSDT', 'PEOPLEUSDT'];
const RECOMMENDED_ASSETS = ['AVAXUSDT', 'DOTUSDT', 'POLUSDT', 'LTCUSDT'];

export default function Portfolio() {
  const portfolio = usePortfolioStore((s) => s.portfolio);
  const [trades, setTrades] = useState([]);
  const [allTrades, setAllTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [activeTab, setActiveTab] = useState('overview'); // 'overview' | 'history' | 'open' | 'closed'
  const [ledgerTab, setLedgerTab] = useState('all'); // 'all' | 'core' | 'meme' | 'recommended'
  const [openLedgerTab, setOpenLedgerTab] = useState('all'); // 'all' | 'core' | 'meme' | 'recommended'
  const [closedLedgerTab, setClosedLedgerTab] = useState('all'); // 'all' | 'core' | 'meme' | 'recommended'
  const [dateFilter, setDateFilter] = useState('all'); // 'all' | 'today' | 'yesterday' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'

  const filterByDate = (createdAt) => {
    if (dateFilter === 'all') return true;
    const tradeDate = new Date(createdAt);
    const now = new Date();
    
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const startOfTomorrow = new Date(startOfToday);
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

    if (dateFilter === 'today') {
      return tradeDate >= startOfToday && tradeDate < startOfTomorrow;
    }
    if (dateFilter === 'yesterday') {
      return tradeDate >= startOfYesterday && tradeDate < startOfToday;
    }
    if (dateFilter === 'weekly') {
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return tradeDate >= oneWeekAgo;
    }
    if (dateFilter === 'monthly') {
      const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return tradeDate >= oneMonthAgo;
    }
    if (dateFilter === 'quarterly') {
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      return tradeDate >= ninetyDaysAgo;
    }
    if (dateFilter === 'yearly') {
      const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      return tradeDate >= oneYearAgo;
    }
    return true;
  };

  const onlyOpenTrades = allTrades.filter((trade) => trade.status === 'open');
  const onlyClosedTrades = allTrades.filter((trade) => trade.status === 'closed');

  const filteredOpenTrades = onlyOpenTrades.filter((trade) => {
    if (openLedgerTab === 'all') return true;
    if (openLedgerTab === 'core') return CORE_ASSETS.includes(trade.asset);
    if (openLedgerTab === 'meme') return MEME_ASSETS.includes(trade.asset);
    if (openLedgerTab === 'recommended') return RECOMMENDED_ASSETS.includes(trade.asset);
    return true;
  });

  const filteredClosedTrades = onlyClosedTrades.filter((trade) => {
    if (!filterByDate(trade.createdAt)) return false;
    if (closedLedgerTab === 'all') return true;
    if (closedLedgerTab === 'core') return CORE_ASSETS.includes(trade.asset);
    if (closedLedgerTab === 'meme') return MEME_ASSETS.includes(trade.asset);
    if (closedLedgerTab === 'recommended') return RECOMMENDED_ASSETS.includes(trade.asset);
    return true;
  });

  const filteredTrades = allTrades.filter((trade) => {
    if (!filterByDate(trade.createdAt)) return false;
    if (ledgerTab === 'all') return true;
    if (ledgerTab === 'core') return CORE_ASSETS.includes(trade.asset);
    if (ledgerTab === 'meme') return MEME_ASSETS.includes(trade.asset);
    if (ledgerTab === 'recommended') return RECOMMENDED_ASSETS.includes(trade.asset);
    return true;
  });

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

  const dateFilteredClosed = onlyClosedTrades.filter((t) => filterByDate(t.createdAt));
  const dateFilteredFailed = allTrades.filter((t) => t.status === 'failed' && filterByDate(t.createdAt));

  const dynamicStats = (() => {
    const totalClosed = dateFilteredClosed.length;
    const totalFailed = dateFilteredFailed.length;
    const totalAttempts = totalClosed + totalFailed;

    if (totalClosed === 0) {
      return {
        totalTrades: totalAttempts,
        totalClosed: 0,
        totalPnl: 0,
        avgPnl: 0,
        winners: 0,
        losers: 0,
        failed: totalFailed,
        avgConfidence: 0,
        bestTrade: 0,
        worstTrade: 0,
      };
    }
    const pnls = dateFilteredClosed.map(t => t.pnl || 0);
    const totalPnl = pnls.reduce((sum, p) => sum + p, 0);
    const avgPnl = totalPnl / totalClosed;
    const winners = dateFilteredClosed.filter(t => (t.pnl || 0) > 0).length;
    const losers = dateFilteredClosed.filter(t => (t.pnl || 0) < 0).length;
    const confidences = dateFilteredClosed.map(t => t.confidence !== undefined && t.confidence !== null ? t.confidence : 0);
    const avgConfidence = confidences.reduce((sum, c) => sum + c, 0) / totalClosed;
    const bestTrade = Math.max(...pnls);
    const worstTrade = Math.min(...pnls);

    return {
      totalTrades: totalAttempts,
      totalClosed,
      totalPnl,
      avgPnl,
      winners,
      losers,
      failed: totalFailed,
      avgConfidence,
      bestTrade,
      worstTrade,
    };
  })();

  const categoryStats = (() => {
    const initCategory = () => ({
      winningPnLs: [],
      losingPnLs: [],
      maxProfit: 0,
      minProfit: 0,
      maxLoss: 0,
      minLoss: 0,
      totalPnl: 0,
    });
    
    const cats = {
      core: initCategory(),
      meme: initCategory(),
      recommended: initCategory(),
    };
    
    dateFilteredClosed.forEach(t => {
      const pnl = t.pnl || 0;
      let cat = null;
      if (CORE_ASSETS.includes(t.asset)) cat = cats.core;
      else if (MEME_ASSETS.includes(t.asset)) cat = cats.meme;
      else if (RECOMMENDED_ASSETS.includes(t.asset)) cat = cats.recommended;
      
      if (cat) {
        cat.totalPnl += pnl;
        if (pnl >= 0) {
          cat.winningPnLs.push(pnl);
        } else {
          cat.losingPnLs.push(pnl);
        }
      }
    });
    
    // Compute max/min for each category
    Object.keys(cats).forEach(key => {
      const c = cats[key];
      c.maxProfit = c.winningPnLs.length > 0 ? Math.max(...c.winningPnLs) : 0;
      c.minProfit = c.winningPnLs.length > 0 ? Math.min(...c.winningPnLs) : 0;
      c.maxLoss = c.losingPnLs.length > 0 ? Math.min(...c.losingPnLs) : 0;
      c.minLoss = c.losingPnLs.length > 0 ? Math.max(...c.losingPnLs) : 0;
    });
    
    return [
      { name: 'Core Crypto', maxProfit: cats.core.maxProfit, minProfit: cats.core.minProfit, maxLoss: Math.abs(cats.core.maxLoss), minLoss: Math.abs(cats.core.minLoss), totalPnl: cats.core.totalPnl },
      { name: 'Meme Coins', maxProfit: cats.meme.maxProfit, minProfit: cats.meme.minProfit, maxLoss: Math.abs(cats.meme.maxLoss), minLoss: Math.abs(cats.meme.minLoss), totalPnl: cats.meme.totalPnl },
      { name: 'Recommended', maxProfit: cats.recommended.maxProfit, minProfit: cats.recommended.minProfit, maxLoss: Math.abs(cats.recommended.maxLoss), minLoss: Math.abs(cats.recommended.minLoss), totalPnl: cats.recommended.totalPnl },
    ];
  })();

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
        
        {/* Date Filter Dropdown */}
        <div className="flex items-center gap-2.5">
          <span className="text-[10px] font-bold text-[#86868b] uppercase tracking-widest font-mono">Date Filter:</span>
          <div className="relative">
            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="appearance-none bg-[#1c1c1e] hover:bg-[#2c2c2e] text-[#f5f5f7] font-mono font-bold text-[10px] uppercase tracking-wider py-2 pl-4 pr-10 rounded-xl border border-[#2c2c2e]/80 transition-all duration-300 focus:outline-none focus:ring-1 focus:ring-[#0071e3]/50 focus:border-[#0071e3] shadow-lg cursor-pointer"
            >
              <option value="all">All Time</option>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="weekly">Weekly (Last 7d)</option>
              <option value="monthly">Monthly (Last 30d)</option>
              <option value="quarterly">Quarterly (Last 90d)</option>
              <option value="yearly">Yearly (Last 365d)</option>
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-[#86868b]">
              <svg className="fill-current h-3 w-3" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/>
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-5">
        {[
          { 
            label: 'Net Balances', 
            value: portfolio.totalBalance !== undefined && portfolio.totalBalance !== null 
              ? `$${portfolio.totalBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}` 
              : '$0.00', 
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
              : '$0.00', 
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
        <button
          onClick={() => setActiveTab('open')}
          className={`pb-2 border-b-2 transition-all duration-300 cursor-pointer ${
            activeTab === 'open'
              ? 'border-[#0071e3] text-[#f5f5f7]'
              : 'border-transparent text-[#86868b] hover:text-[#f5f5f7]'
          }`}
        >
          ALL OPEN TRADES
        </button>
        <button
          onClick={() => setActiveTab('closed')}
          className={`pb-2 border-b-2 transition-all duration-300 cursor-pointer ${
            activeTab === 'closed'
              ? 'border-[#0071e3] text-[#f5f5f7]'
              : 'border-transparent text-[#86868b] hover:text-[#f5f5f7]'
          }`}
        >
          ALL CLOSED TRADES
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
              {dateFilteredClosed.length > 0 ? (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={dateFilteredClosed.map((t, i) => ({ name: `#${i + 1}`, pnl: t.pnl || 0 }))} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.02)" vertical={false} />
                    <XAxis dataKey="name" stroke="#86868b" fontSize={9} tickLine={false} className="font-mono" />
                    <YAxis stroke="#86868b" fontSize={9} tickLine={false} className="font-mono" />
                    <Tooltip
                      contentStyle={{ background: '#000000', border: '1px solid #2c2c2e', borderRadius: '12px', color: '#f5f5f7' }}
                      itemStyle={{ fontSize: '11px', fontWeight: 'bold', color: '#f5f5f7', fontFamily: 'monospace' }}
                    />
                    <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                      {dateFilteredClosed.map((t, i) => (
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

          {/* Category Performance Analytics */}
          <div className="glass-panel bg-[#1c1c1e] mt-6">
            <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest flex items-center gap-2 border-b border-[#2c2c2e]/60 pb-3 font-mono mb-4">
              <BarChart3 size={14} className="text-sky-400" />
              Category Performance Analytics (Core vs Meme vs Recs)
            </h3>
            
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-center">
              {/* Chart */}
              <div className="lg:col-span-2">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={categoryStats} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.02)" vertical={false} />
                    <XAxis dataKey="name" stroke="#86868b" fontSize={10} tickLine={false} className="font-mono font-bold" />
                    <YAxis stroke="#86868b" fontSize={9} tickLine={false} className="font-mono" />
                    <Tooltip
                      contentStyle={{ background: '#000000', border: '1px solid #2c2c2e', borderRadius: '12px', color: '#f5f5f7' }}
                      itemStyle={{ fontSize: '11px', fontWeight: 'bold', color: '#f5f5f7', fontFamily: 'monospace' }}
                      formatter={(value) => `$${value.toFixed(2)}`}
                    />
                    <Bar dataKey="maxProfit" name="High Profit" fill="#30d158" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="minProfit" name="Low Profit" fill="rgba(48, 209, 88, 0.45)" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="maxLoss" name="High Loss" fill="#ff453a" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="minLoss" name="Low Loss" fill="rgba(255, 69, 58, 0.45)" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Data Breakdown Table */}
              <div className="space-y-4">
                {categoryStats.map((cat, i) => (
                  <div key={i} className="bg-black/40 p-4 rounded-2xl border border-[#2c2c2e]/55 pl-5 relative overflow-hidden group">
                    <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: cat.totalPnl >= 0 ? '#30d158' : '#ff453a' }} />
                    <div className="flex justify-between items-baseline mb-2">
                      <span className="font-bold text-[#f5f5f7] text-xs font-mono">{cat.name}</span>
                      <span className={`text-[10px] font-mono font-extrabold ${cat.totalPnl >= 0 ? 'text-[#30d158]' : 'text-[#ff453a]'}`}>
                        Net: {cat.totalPnl >= 0 ? '+' : ''}${cat.totalPnl.toFixed(2)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[9px] font-mono text-[#86868b] font-semibold">
                      <div className="flex flex-col">
                        <span>High Profit</span>
                        <span className="text-[#30d158] font-bold">+${cat.maxProfit.toFixed(2)}</span>
                      </div>
                      <div className="flex flex-col">
                        <span>Low Profit</span>
                        <span className="text-[#30d158]/70">+${cat.minProfit.toFixed(2)}</span>
                      </div>
                      <div className="flex flex-col mt-1">
                        <span>High Loss</span>
                        <span className="text-[#ff453a] font-bold">-${cat.maxLoss.toFixed(2)}</span>
                      </div>
                      <div className="flex flex-col mt-1">
                        <span>Low Loss</span>
                        <span className="text-[#ff453a]/70">-${cat.minLoss.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Trade Stats Table */}
          {portfolio && (
            <div className="glass-panel bg-[#1c1c1e] !p-0">
              <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest border-b border-[#2c2c2e]/60 p-6 pb-3 font-mono mb-4">
                Historical Performance Benchmarks
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-6 pt-0 text-xs">
                {(() => {
                  const totalClosedTrades = (portfolio.winningTrades || 0) + (portfolio.losingTrades || 0);
                  const avgOutcomePnL = totalClosedTrades > 0 ? (portfolio.totalPnl / totalClosedTrades) : 0;
                  const bestTradeProfit = stats?.bestTrade || 0;
                  const worstTradeLoss = stats?.worstTrade || 0;
                  const avgSignalConf = stats?.avgConfidence !== undefined ? stats.avgConfidence : 0.5;

                  return [
                    { label: 'Total Closed Trades', value: totalClosedTrades },
                    { label: 'Winning Trades', value: portfolio.winningTrades || 0, color: '#30d158' },
                    { label: 'Losing Trades', value: portfolio.losingTrades || 0, color: '#ff453a' },
                    { label: 'Win Rate', value: `${((portfolio.winRate || 0) * 100).toFixed(1)}%`, color: '#30d158' },
                    { label: 'Cumulative Net return', value: `$${portfolio.totalPnl?.toFixed(2)}`, color: portfolio.totalPnl >= 0 ? '#30d158' : '#ff453a' },
                    { label: 'Average Outcome PnL', value: `$${avgOutcomePnL.toFixed(2)}` },
                    { label: 'Peak Trade Profit', value: `$${bestTradeProfit.toFixed(2)}`, color: '#30d158' },
                    { label: 'Max Drawdown Loss', value: `$${worstTradeLoss.toFixed(2)}`, color: '#ff453a' },
                    { label: 'Average Signal Conf', value: `${(avgSignalConf * 100).toFixed(1)}%` },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="bg-black p-4 rounded-2xl border border-[#2c2c2e]/55 relative overflow-hidden pl-5 group">
                      <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: color || '#86868b' }} />
                      <div className="text-[9px] font-bold text-[#86868b] uppercase tracking-widest font-mono mb-1">{label}</div>
                      <div className="text-lg font-bold font-mono" style={{ color: color || '#f5f5f7' }}>
                        {value}
                      </div>
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}
        </>
      ) : activeTab === 'history' ? (
        /* Detailed Transaction Ledger */
        <div className="glass-panel overflow-hidden bg-[#1c1c1e] !p-0">
          <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-[#2c2c2e]/60 p-6 pb-4 mb-4 gap-4">
            <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest font-mono">
              Autonomous Transaction Ledger
            </h3>
            <div className="flex bg-black/40 p-0.5 rounded-lg border border-[#2c2c2e]/60 text-[9px] font-bold font-mono self-start md:self-auto">
              {[
                { id: 'all', label: 'All' },
                { id: 'core', label: 'Core Crypto' },
                { id: 'meme', label: 'Meme Coins' },
                { id: 'recommended', label: 'Recommended' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setLedgerTab(tab.id)}
                  className={`px-3 py-1.5 rounded-md transition-all duration-300 cursor-pointer ${
                    ledgerTab === tab.id
                      ? 'bg-[#0071e3] text-[#f5f5f7] shadow-md'
                      : 'text-[#86868b] hover:text-[#f5f5f7]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          {allTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center h-44">
              <Activity size={20} className="text-zinc-600 mb-2" />
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest font-mono">
                NO TRANSACTIONS LOGGED ON SYSTEM
              </span>
            </div>
          ) : filteredTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center h-44">
              <Activity size={20} className="text-zinc-600 mb-2" />
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest font-mono">
                NO TRANSACTIONS MATCHING CATEGORY
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
                    <th className="px-6 py-4 text-right">Stop Loss</th>
                    <th className="px-6 py-4 text-right">Target</th>
                    <th className="px-6 py-4 text-right">Exit Price</th>
                    <th className="px-6 py-4 text-right">Quantity</th>
                    <th className="px-6 py-4 text-right">Commission</th>
                    <th className="px-6 py-4 text-right">Realized Return</th>
                    <th className="px-6 py-4 text-right">Net Return</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2c2c2e]/40">
                  {filteredTrades.map((trade, i) => {
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
                          {price ? `$${price.toFixed(6)}` : '—'}
                        </td>
                        <td className="px-6 py-4 text-right text-[#ff453a] font-mono font-bold">
                          {trade.stopLoss ? `$${trade.stopLoss.toFixed(6)}` : '—'}
                        </td>
                        <td className="px-6 py-4 text-right text-[#30d158] font-mono font-bold">
                          {trade.takeProfit ? (trade.takeProfit >= 1 ? `$${trade.takeProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${trade.takeProfit.toFixed(6)}`) : '—'}
                        </td>
                        <td className="px-6 py-4 text-right text-[#f5f5f7] font-mono font-bold">
                          {exit ? `$${exit.toFixed(6)}` : '—'}
                        </td>
                        <td className="px-6 py-4 text-right text-[#86868b] font-mono">
                          {trade.quantity?.toFixed(5) || '—'}
                        </td>
                        <td className="px-6 py-4 text-right text-[#ff9f0a] font-mono font-bold">
                          {trade.fees !== undefined && trade.fees !== null 
                            ? `$${trade.fees.toFixed(4)}` 
                            : `$${(trade.entryPrice * trade.quantity * (trade.status === 'closed' ? 0.0010 : 0.0005)).toFixed(4)}`}
                        </td>
                        <td 
                          className="px-6 py-4 text-right font-bold font-mono"
                          style={{ 
                            color: trade.status === 'open' 
                              ? '#86868b' 
                              : trade.status === 'failed'
                                ? '#ff453a'
                                : ((trade.pnl || 0) >= 0 ? '#30d158' : '#ff453a') 
                          }}
                        >
                          {trade.status === 'open' 
                            ? 'ACTIVE' 
                            : trade.status === 'failed' 
                              ? 'FAILED' 
                              : `${(trade.pnl || 0) >= 0 ? '+' : ''}$${(trade.pnl || 0).toFixed(2)}`}
                        </td>
                        <td 
                          className="px-6 py-4 text-right font-bold font-mono"
                          style={{ 
                            color: trade.status === 'open' 
                              ? '#86868b' 
                              : trade.status === 'failed'
                                ? '#ff453a'
                                : (((trade.pnl || 0) - (trade.fees !== undefined && trade.fees !== null ? trade.fees : (trade.entryPrice * trade.quantity * (trade.status === 'closed' ? 0.0010 : 0.0005)))) >= 0 ? '#30d158' : '#ff453a') 
                          }}
                        >
                          {trade.status === 'open' 
                            ? 'ACTIVE' 
                            : trade.status === 'failed' 
                              ? 'FAILED' 
                              : (() => {
                                  const fees = trade.fees !== undefined && trade.fees !== null 
                                    ? trade.fees 
                                    : (trade.entryPrice * trade.quantity * (trade.status === 'closed' ? 0.0010 : 0.0005));
                                  const net = (trade.pnl || 0) - fees;
                                  return `${net >= 0 ? '+' : ''}$${net.toFixed(2)}`;
                                })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : activeTab === 'open' ? (
        /* Open Trades Ledger */
        <div className="glass-panel overflow-hidden bg-[#1c1c1e] !p-0">
          <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-[#2c2c2e]/60 p-6 pb-4 mb-4 gap-4">
            <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest font-mono">
              Active Open Positions
            </h3>
            <div className="flex bg-black/40 p-0.5 rounded-lg border border-[#2c2c2e]/60 text-[9px] font-bold font-mono self-start md:self-auto">
              {[
                { id: 'all', label: 'All' },
                { id: 'core', label: 'Core Crypto' },
                { id: 'meme', label: 'Meme Coins' },
                { id: 'recommended', label: 'Recommended' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setOpenLedgerTab(tab.id)}
                  className={`px-3 py-1.5 rounded-md transition-all duration-300 cursor-pointer ${
                    openLedgerTab === tab.id
                      ? 'bg-[#0071e3] text-[#f5f5f7] shadow-md'
                      : 'text-[#86868b] hover:text-[#f5f5f7]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          {onlyOpenTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center h-44">
              <Activity size={20} className="text-zinc-600 mb-2" />
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest font-mono">
                NO ACTIVE POSITIONS ON SYSTEM
              </span>
            </div>
          ) : filteredOpenTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center h-44">
              <Activity size={20} className="text-zinc-600 mb-2" />
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest font-mono">
                NO ACTIVE POSITIONS MATCHING CATEGORY
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
                    <th className="px-6 py-4 text-right">Entry Price</th>
                    <th className="px-6 py-4 text-right">Stop Loss</th>
                    <th className="px-6 py-4 text-right">Target</th>
                    <th className="px-6 py-4 text-right">Quantity</th>
                    <th className="px-6 py-4 text-right">Commission</th>
                    <th className="px-6 py-4 text-right">PnL Estimate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2c2c2e]/40">
                  {filteredOpenTrades.map((trade, i) => {
                    const price = trade.entryPrice;
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
                        <td className="px-6 py-4 text-right text-[#f5f5f7] font-mono font-bold">
                          {price ? `$${price.toFixed(6)}` : '—'}
                        </td>
                        <td className="px-6 py-4 text-right text-[#ff453a] font-mono font-bold">
                          {trade.stopLoss ? `$${trade.stopLoss.toFixed(6)}` : '—'}
                        </td>
                        <td className="px-6 py-4 text-right text-[#30d158] font-mono font-bold">
                          {trade.takeProfit ? (trade.takeProfit >= 1 ? `$${trade.takeProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${trade.takeProfit.toFixed(6)}`) : '—'}
                        </td>
                        <td className="px-6 py-4 text-right text-[#86868b] font-mono">
                          {trade.quantity?.toFixed(5) || '—'}
                        </td>
                        <td className="px-6 py-4 text-right text-[#ff9f0a] font-mono font-bold">
                          {trade.fees !== undefined && trade.fees !== null 
                            ? `$${trade.fees.toFixed(4)}` 
                            : `$${(trade.entryPrice * trade.quantity * 0.0005).toFixed(4)}`}
                        </td>
                        <td className="px-6 py-4 text-right font-bold font-mono text-[#86868b]">
                          ACTIVE
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        /* Closed Trades Ledger */
        <div className="glass-panel overflow-hidden bg-[#1c1c1e] !p-0">
          <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-[#2c2c2e]/60 p-6 pb-4 mb-4 gap-4">
            <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest font-mono">
              Historical Closed Trades
            </h3>
            <div className="flex bg-black/40 p-0.5 rounded-lg border border-[#2c2c2e]/60 text-[9px] font-bold font-mono self-start md:self-auto">
              {[
                { id: 'all', label: 'All' },
                { id: 'core', label: 'Core Crypto' },
                { id: 'meme', label: 'Meme Coins' },
                { id: 'recommended', label: 'Recommended' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setClosedLedgerTab(tab.id)}
                  className={`px-3 py-1.5 rounded-md transition-all duration-300 cursor-pointer ${
                    closedLedgerTab === tab.id
                      ? 'bg-[#0071e3] text-[#f5f5f7] shadow-md'
                      : 'text-[#86868b] hover:text-[#f5f5f7]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          {onlyClosedTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center h-44">
              <Activity size={20} className="text-zinc-600 mb-2" />
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest font-mono">
                NO CLOSED TRADES ON SYSTEM
              </span>
            </div>
          ) : filteredClosedTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center h-44">
              <Activity size={20} className="text-zinc-600 mb-2" />
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest font-mono">
                NO CLOSED TRADES MATCHING CATEGORY
              </span>
            </div>
          ) : (() => {
            const totalProfit = filteredClosedTrades
              .filter((t) => (t.pnl || 0) > 0)
              .reduce((sum, t) => sum + (t.pnl || 0), 0);

            const totalLoss = filteredClosedTrades
                              .filter((t) => (t.pnl || 0) < 0)
              .reduce((sum, t) => sum + (t.pnl || 0), 0);

            // Gross totals (signed sum of all closed PnLs)
            const totalGross = totalProfit + totalLoss; // totalLoss is negative, so adding it computes the correct gross return
            const totalCommission = filteredClosedTrades.reduce((sum, t) => sum + (t.fees || 0), 0);
            // Net return after all fees
            const totalNet = totalGross - totalCommission;

            return (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-black/35 border-b border-[#2c2c2e]/60 text-[#86868b] font-bold text-[9px] uppercase tracking-widest font-mono">
                      <th className="px-6 py-4">Execution Date</th>
                      <th className="px-6 py-4">Asset</th>
                      <th className="px-6 py-4">Action</th>
                      <th className="px-6 py-4 text-right">Entry Price</th>
                      <th className="px-6 py-4 text-right">Stop Loss</th>
                      <th className="px-6 py-4 text-right">Target</th>
                      <th className="px-6 py-4 text-right">Exit Price</th>
                      <th className="px-6 py-4 text-right">Quantity</th>
                      <th className="px-6 py-4 text-right">Commission</th>
                      <th className="px-6 py-4 text-right">Realized Return</th>
                      <th className="px-6 py-4 text-right">Net Return</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#2c2c2e]/40">
                    {filteredClosedTrades.map((trade, i) => {
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
                          <td className="px-6 py-4 text-right text-[#f5f5f7] font-mono font-bold">
                            {price ? `$${price.toFixed(6)}` : '—'}
                          </td>
                          <td className="px-6 py-4 text-right text-[#ff453a] font-mono font-bold">
                            {trade.stopLoss ? `$${trade.stopLoss.toFixed(6)}` : '—'}
                          </td>
                          <td className="px-6 py-4 text-right text-[#30d158] font-mono font-bold">
                            {trade.takeProfit ? (trade.takeProfit >= 1 ? `$${trade.takeProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${trade.takeProfit.toFixed(6)}`) : '—'}
                          </td>
                          <td className="px-6 py-4 text-right text-[#f5f5f7] font-mono font-bold">
                            {exit ? `$${exit.toFixed(6)}` : '—'}
                          </td>
                          <td className="px-6 py-4 text-right text-[#86868b] font-mono">
                            {trade.quantity?.toFixed(5) || '—'}
                          </td>
                          <td className="px-6 py-4 text-right text-[#ff9f0a] font-mono font-bold">
                            {trade.fees !== undefined && trade.fees !== null 
                              ? `$${trade.fees.toFixed(4)}` 
                              : `$${(trade.entryPrice * trade.quantity * 0.0010).toFixed(4)}`}
                          </td>
                          <td 
                            className="px-6 py-4 text-right font-bold font-mono"
                            style={{ color: (trade.pnl || 0) >= 0 ? '#30d158' : '#ff453a' }}
                          >
                            {`${(trade.pnl || 0) >= 0 ? '+' : ''}$${trade.pnl?.toFixed(2)}`}
                          </td>
                          <td 
                            className="px-6 py-4 text-right font-bold font-mono"
                            style={{ 
                              color: (((trade.pnl || 0) - (trade.fees !== undefined && trade.fees !== null ? trade.fees : (trade.entryPrice * trade.quantity * 0.0010))) >= 0 ? '#30d158' : '#ff453a') 
                            }}
                          >
                            {(() => {
                              const fees = trade.fees !== undefined && trade.fees !== null 
                                ? trade.fees 
                                : (trade.entryPrice * trade.quantity * 0.0010);
                              const net = (trade.pnl || 0) - fees;
                              return `${net >= 0 ? '+' : ''}$${net.toFixed(2)}`;
                            })()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="border-t border-[#2c2c2e] bg-black/45">
                    <tr className="align-middle">
                      <td colSpan={8} className="px-6 py-4 text-[#86868b] font-mono text-[10px] font-extrabold uppercase tracking-widest">
                        Totals ({filteredClosedTrades.length} Trades)
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="block text-[8px] text-[#86868b] uppercase tracking-wider font-mono">Commission</span>
                        <span className="text-[#ff9f0a] font-bold font-mono text-[11px] mt-0.5 block">
                          -${totalCommission.toFixed(4)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="block text-[8px] text-[#86868b] uppercase tracking-wider font-mono">Gross Return</span>
                        <span className={`font-bold font-mono text-[11px] mt-0.5 block ${totalGross >= 0 ? 'text-[#30d158]' : 'text-[#ff453a]'}`}>
                          {totalGross >= 0 ? '+' : ''}${totalGross.toFixed(2)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right bg-[#0071e3]/5 border-l border-[#2c2c2e]/60">
                        <span className="block text-[8px] text-[#86868b] uppercase tracking-wider font-mono">Net Return</span>
                        <span className={`font-bold font-mono text-[11px] mt-0.5 block ${totalNet >= 0 ? 'text-[#30d158]' : 'text-[#ff453a]'}`}>
                          {totalNet >= 0 ? '+' : ''}${totalNet.toFixed(2)}
                        </span>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
