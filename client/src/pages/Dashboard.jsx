import React, { useState, useEffect, useRef } from 'react';
import { useMarketStore, useSignalStore, usePortfolioStore, useTradeStore, useCurrencyStore } from '../store.js';
import { TrendingUp, TrendingDown, DollarSign, Activity, Target, BarChart3, Bot, Zap, ArrowUpRight, ArrowDownRight, ShieldCheck, Star, Search } from 'lucide-react';
import axios from 'axios';

const CORE_ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT'];
const MEME_ASSETS = ['DOGEUSDT', '1000SHIBUSDT', '1000PEPEUSDT', 'WIFUSDT', '1000FLOKIUSDT', '1000BONKUSDT', 'BOMEUSDT', 'PEOPLEUSDT'];
const RECOMMENDED_ASSETS = ['AVAXUSDT', 'DOTUSDT', 'POLUSDT', 'LTCUSDT', 'PORTALUSDT', 'HEIUSDT', 'IDUSDT', 'LABUSDT', 'STGUSDT', 'EPICUSDT'];
const ASSETS = [...CORE_ASSETS, ...MEME_ASSETS, ...RECOMMENDED_ASSETS];

function formatPrice(price) {
  if (price === undefined || price === null) return '—';
  return price >= 1
    ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${price.toFixed(6)}`;
}

function SignalBadge({ action }) {
  const styles = {
    BUY: { bg: 'rgba(48, 209, 88, 0.1)', border: 'rgba(48, 209, 88, 0.2)', color: '#30d158' },
    SELL: { bg: 'rgba(255, 69, 58, 0.1)', border: 'rgba(255, 69, 58, 0.2)', color: '#ff453a' },
    HOLD: { bg: 'rgba(142, 142, 147, 0.1)', border: 'rgba(142, 142, 147, 0.2)', color: '#8e8e93' },
  };
  const s = styles[action] || styles.HOLD;
  return (
    <span 
      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border font-mono transition-all duration-300"
      style={{ 
        background: s.bg, 
        borderColor: s.border, 
        color: s.color,
      }}
    >
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
        <span className="text-[9px] font-bold text-[#86868b] uppercase tracking-widest font-mono">{label}</span>
        <div className="text-zinc-500 transition-all duration-300">
          <Icon size={14} style={{ color: iconColor }} />
        </div>
      </div>
      <div className="mt-4">
        <div className="text-2xl font-semibold text-[#f5f5f7] tracking-tight">{value}</div>
        {subValue && (
          <div className="text-[10px] text-zinc-400 mt-1.5 font-medium">
            {subValue}
          </div>
        )}
      </div>
    </div>
  );
}

function LivePriceCard({ asset }) {
  const price = useMarketStore((s) => s.prices[asset]);
  const signal = useSignalStore((s) => s.fusedSignals[asset]);
  const tech = useSignalStore((s) => s.technicalSignals[asset]);
  const [tickDirection, setTickDirection] = useState(null); // 'up' | 'down' | null
  const [flashClass, setFlashClass] = useState('');
  const prevPriceRef = useRef(price);

  useEffect(() => {
    if (price !== undefined && prevPriceRef.current !== undefined) {
      if (price > prevPriceRef.current) {
        setTickDirection('up');
        setFlashClass('flash-up');
        const timer = setTimeout(() => {
          setTickDirection(null);
          setFlashClass('');
        }, 1000);
        return () => clearTimeout(timer);
      } else if (price < prevPriceRef.current) {
        setTickDirection('down');
        setFlashClass('flash-down');
        const timer = setTimeout(() => {
          setTickDirection(null);
          setFlashClass('');
        }, 1000);
        return () => clearTimeout(timer);
      }
    }
    prevPriceRef.current = price;
  }, [price]);

  const priceColor = tickDirection === 'up'
    ? 'text-[#30d158] font-bold'
    : tickDirection === 'down'
      ? 'text-[#ff453a] font-bold'
      : 'text-[#f5f5f7]';

  return (
    <div className={`glass-panel transition-all duration-300 hover:shadow-lg ${flashClass}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-1">
          <span className="text-sm font-semibold tracking-tight text-[#f5f5f7]">{asset.replace('1000', '').replace('USDT', '')}</span>
          <span className="text-[9px] text-[#86868b] font-bold uppercase tracking-wider font-mono">/ USDT</span>
        </div>
        <SignalBadge action={signal?.action || tech?.action || 'HOLD'} />
      </div>

      <div className={`text-2xl font-bold font-mono tracking-tight my-4 transition-colors duration-300 ${priceColor}`}>
        {formatPrice(price)}
      </div>

      <div className="flex items-center justify-between text-[10px] text-[#86868b] font-semibold border-t border-[#2c2c2e]/60 pt-3">
        <span className="flex items-center gap-1.5">
          Regime: 
          <span className={`px-2 py-0.5 rounded-full text-[8px] font-bold uppercase font-mono tracking-wider ${
            tech?.indicators?.regime === 'bullish' 
              ? 'bg-[#30d158]/10 text-[#30d158] border border-[#30d158]/20' 
              : tech?.indicators?.regime === 'bearish' 
                ? 'bg-[#ff453a]/10 text-[#ff453a] border border-[#ff453a]/20' 
                : 'bg-zinc-900 text-zinc-300 border border-[#2c2c2e]/60'
          }`}>
            {tech?.indicators?.regime || 'ranging'}
          </span>
        </span>
        {signal?.confidence !== undefined && (
          <span className="font-mono text-zinc-400 text-[9px] font-bold">
            CONF: <span className="text-[#f5f5f7]">{(signal.confidence * 100).toFixed(0)}%</span>
          </span>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const signalHistory = useSignalStore((s) => s.signalHistory);
  const portfolio = usePortfolioStore((s) => s.portfolio);
  const recentTrades = useTradeStore((s) => s.recentTrades);
  const [activeTab, setActiveTab] = useState('core'); // 'core' | 'meme' | 'recommended'
  const [comparisonData, setComparisonData] = useState(null);

  const [assetCategories, setAssetCategories] = useState({
    core: CORE_ASSETS,
    meme: MEME_ASSETS,
    recommended: RECOMMENDED_ASSETS,
    all: ASSETS
  });

  const currency = useCurrencyStore((s) => s.currency);
  const rate = useCurrencyStore((s) => s.rate);

  const convertVal = (val) => {
    if (val === undefined || val === null) return 0;
    return currency === 'INR' ? val * rate : val;
  };

  const formatVal = (val, dec = 2) => {
    const converted = convertVal(val);
    const symbol = currency === 'INR' ? '₹' : '$';
    return `${symbol}${converted.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(20);

  const filteredAssets = (activeTab === 'core' 
    ? assetCategories.core 
    : activeTab === 'meme' 
      ? assetCategories.meme 
      : assetCategories.recommended).filter((a) => {
        if (!searchQuery.trim()) return true;
        return a.toLowerCase().includes(searchQuery.trim().toLowerCase());
      });

  const displayedAssets = filteredAssets.slice(0, visibleCount);

  const displayedSignals = signalHistory.filter((sig) => sig.source === 'fusion' && (assetCategories.all || ASSETS).includes(sig.asset));

  useEffect(() => {
    const fetchAssetCategories = async () => {
      try {
        const res = await axios.get('/api/market/asset-categories');
        if (res.data.success && res.data.data) {
          setAssetCategories(res.data.data);
        }
      } catch {}
    };
    const fetchPortfolio = async () => {
      try {
        const res = await axios.get('/api/portfolio');
        if (res.data.success && res.data.data) {
          usePortfolioStore.getState().setPortfolio(res.data.data);
        }
      } catch {}
      try {
        const resPerf = await axios.get('/api/portfolio/performance');
        if (resPerf.data.success && resPerf.data.data) {
          usePortfolioStore.getState().setPortfolio(resPerf.data.data);
        }
      } catch {}
    };
    const fetchSignals = async () => {
      try {
        const res = await axios.get('/api/trades/signals?source=fusion&limit=100');
        if (res.data.success) {
          useSignalStore.setState({ signalHistory: res.data.data });
        }
      } catch {}
    };
    const fetchPrices = async () => {
      try {
        const res = await axios.get('/api/market/prices');
        if (res.data.success) {
          // Merge server prices into market store without overwriting live WebSocket prices
          const currentPrices = useMarketStore.getState().prices;
          const serverPrices = res.data.data;
          const merged = { ...serverPrices, ...currentPrices };
          useMarketStore.setState({ prices: merged });
        }
      } catch {}
    };
    const fetchTrades = async () => {
      try {
        const res = await axios.get('/api/trades?limit=50');
        if (res.data.success) {
          useTradeStore.setState({ recentTrades: res.data.data });
        }
      } catch {}
    };
    const fetchComparison = async () => {
      try {
        const res = await axios.get('/api/trades/performance-comparison');
        if (res.data.success) {
          setComparisonData(res.data.data);
        }
      } catch {}
    };
    fetchAssetCategories();
    fetchPortfolio();
    fetchSignals();
    fetchPrices();
    fetchTrades();
    fetchComparison();

    const interval = setInterval(() => {
      fetchPortfolio();
      fetchPrices();
    }, 15000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="page-layout">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#2c2c2e]/60 pb-5">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#f5f5f7]">Overview</h2>
          <p className="text-[11px] text-[#86868b] mt-1 font-medium">
            System status monitoring multi-agent consensus metrics, signal updates, and live capital.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[9px] text-[#86868b] font-bold bg-[#1c1c1e] border border-[#2c2c2e]/40 rounded-full px-3 py-1 font-mono">
          <span className="w-1.5 h-1.5 rounded-full bg-[#30d158] animate-pulse" />
          <span className="text-[#30d158]">CoinSwitch Pro Live Engine</span>
        </div>
      </div>

      {/* Portfolio Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard
          icon={DollarSign}
          label="Live Total Balance"
          value={formatVal(portfolio.coinSwitchApiKey ? (portfolio.liveTotalBalance || portfolio.totalBalance) : 0)}
          subValue={`Margin Available: ${formatVal(portfolio.coinSwitchApiKey ? (portfolio.liveAvailableBalance || portfolio.availableBalance) : 0)}`}
          iconColor="#86868b"
        />
        <StatCard
          icon={Target}
          label="Target Anchor (Base Capital)"
          value={formatVal(portfolio.coinSwitchApiKey ? portfolio.baseTradingCapital : 0)}
          subValue="Frozen Goalpost Baseline"
          iconColor="#86868b"
        />
        <StatCard
          icon={portfolio.totalPnl >= 0 ? ArrowUpRight : ArrowDownRight}
          label="Total Return"
          value={`${portfolio.totalPnl >= 0 ? '+' : ''}${formatVal(portfolio.totalPnl)}`}
          subValue={`${portfolio.totalPnlPercent >= 0 ? '+' : ''}${portfolio.totalPnlPercent?.toFixed(2) || '0.00'}% Net Yield`}
          iconColor={portfolio.totalPnl >= 0 ? '#30d158' : '#ff453a'}
        />
        <StatCard
          icon={Target}
          label="Session Win Rate"
          value={`${((portfolio.winRate || 0) * 100)?.toFixed(1) || '0.0'}%`}
          subValue={`${portfolio.openPositions || 0} Open Exposure Positions`}
          iconColor="#86868b"
        />
        <StatCard
          icon={Activity}
          label="Daily Net PnL"
          value={`${portfolio.dailyPnl >= 0 ? '+' : ''}${formatVal(portfolio.dailyPnl)}`}
          subValue="Net value (After Fees)"
          iconColor="#86868b"
        />
      </div>

      {/* Strategy Performance Comparison */}
      {comparisonData && (
        <div className="space-y-3 mt-6">
          <h3 className="text-xs font-bold text-[#86868b] uppercase tracking-widest flex items-center gap-1.5 font-mono">
            <Bot size={13} className="text-purple-400" />
            Strategy Performance Comparison
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* AI System Card */}
            <div className="glass-panel py-4 px-5 flex flex-col justify-between min-h-[120px] gap-3 relative overflow-hidden transition-all duration-300 hover:shadow-lg group">
              <div className="absolute inset-0 bg-gradient-to-br from-purple-500/[0.03] to-transparent pointer-events-none" />
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-purple-500 h-[30%] group-hover:h-full transition-all duration-300" />
              <div className="flex items-start justify-between">
                <span className="text-[9px] font-bold text-[#86868b] uppercase tracking-widest font-mono">AI System (Groq / Gemini)</span>
                <Bot size={14} className="text-purple-400" />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <div>
                  <div className="text-[8px] text-zinc-500 font-mono uppercase font-bold">Trades</div>
                  <div className="text-base font-semibold text-zinc-200 mt-1 font-mono">{comparisonData.ai?.count || 0}</div>
                </div>
                <div>
                  <div className="text-[8px] text-zinc-500 font-mono uppercase font-bold">Win Rate</div>
                  <div className="text-base font-semibold text-zinc-200 mt-1 font-mono">
                    {comparisonData.ai?.count > 0 ? `${((comparisonData.ai.wins / comparisonData.ai.count) * 100).toFixed(1)}%` : '0.0%'}
                  </div>
                </div>
                <div>
                  <div className="text-[8px] text-zinc-500 font-mono uppercase font-bold">Net PnL</div>
                  <div className={`text-base font-bold mt-1 font-mono ${comparisonData.ai?.totalPnl >= 0 ? 'text-[#30d158]' : 'text-[#ff453a]'}`}>
                    {comparisonData.ai?.totalPnl >= 0 ? '+' : ''}{formatVal(comparisonData.ai?.totalPnl)}
                  </div>
                </div>
              </div>
            </div>

            {/* Local Fallback Card */}
            <div className="glass-panel py-4 px-5 flex flex-col justify-between min-h-[120px] gap-3 relative overflow-hidden transition-all duration-300 hover:shadow-lg group">
              <div className="absolute inset-0 bg-gradient-to-br from-amber-500/[0.03] to-transparent pointer-events-none" />
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber-500 h-[30%] group-hover:h-full transition-all duration-300" />
              <div className="flex items-start justify-between">
                <span className="text-[9px] font-bold text-[#86868b] uppercase tracking-widest font-mono">Local Fallback</span>
                <Zap size={14} className="text-amber-400" />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <div>
                  <div className="text-[8px] text-zinc-500 font-mono uppercase font-bold">Trades</div>
                  <div className="text-base font-semibold text-zinc-200 mt-1 font-mono">{comparisonData.fallback?.count || 0}</div>
                </div>
                <div>
                  <div className="text-[8px] text-zinc-500 font-mono uppercase font-bold">Win Rate</div>
                  <div className="text-base font-semibold text-zinc-200 mt-1 font-mono">
                    {comparisonData.fallback?.count > 0 ? `${((comparisonData.fallback.wins / comparisonData.fallback.count) * 100).toFixed(1)}%` : '0.0%'}
                  </div>
                </div>
                <div>
                  <div className="text-[8px] text-zinc-500 font-mono uppercase font-bold">Net PnL</div>
                  <div className={`text-base font-bold mt-1 font-mono ${comparisonData.fallback?.totalPnl >= 0 ? 'text-[#30d158]' : 'text-[#ff453a]'}`}>
                    {comparisonData.fallback?.totalPnl >= 0 ? '+' : ''}{formatVal(comparisonData.fallback?.totalPnl)}
                  </div>
                </div>
              </div>
            </div>

            {/* Unknown / Historical Card */}
            <div className="glass-panel py-4 px-5 flex flex-col justify-between min-h-[120px] gap-3 relative overflow-hidden transition-all duration-300 hover:shadow-lg group">
              <div className="absolute inset-0 bg-gradient-to-br from-zinc-500/[0.03] to-transparent pointer-events-none" />
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-zinc-500 h-[30%] group-hover:h-full transition-all duration-300" />
              <div className="flex items-start justify-between">
                <span className="text-[9px] font-bold text-[#86868b] uppercase tracking-widest font-mono">Historical / Unknown</span>
                <ShieldCheck size={14} className="text-zinc-400" />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <div>
                  <div className="text-[8px] text-zinc-500 font-mono uppercase font-bold">Trades</div>
                  <div className="text-base font-semibold text-zinc-200 mt-1 font-mono">{comparisonData.unknown?.count || 0}</div>
                </div>
                <div>
                  <div className="text-[8px] text-zinc-500 font-mono uppercase font-bold">Win Rate</div>
                  <div className="text-base font-semibold text-zinc-200 mt-1 font-mono">
                    {comparisonData.unknown?.count > 0 ? `${((comparisonData.unknown.wins / comparisonData.unknown.count) * 100).toFixed(1)}%` : '0.0%'}
                  </div>
                </div>
                <div>
                  <div className="text-[8px] text-zinc-500 font-mono uppercase font-bold">Net PnL</div>
                  <div className={`text-base font-bold mt-1 font-mono ${comparisonData.unknown?.totalPnl >= 0 ? 'text-[#30d158]' : 'text-[#ff453a]'}`}>
                    {comparisonData.unknown?.totalPnl >= 0 ? '+' : ''}{formatVal(comparisonData.unknown?.totalPnl)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Market Prices and Signals Grid */}
      <div className="grid-layout-3">
        {/* Tickers section */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-[#2c2c2e]/60 pb-3 mb-4 gap-3">
            <h3 className="text-xs font-bold text-[#86868b] uppercase tracking-widest flex items-center gap-1.5 font-mono">
              <Zap size={13} className="text-sky-400" />
              Live Market Prices ({filteredAssets.length})
            </h3>

            <div className="flex flex-wrap items-center gap-2">
              {/* Search Bar */}
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input 
                  type="text" 
                  placeholder="Search 568 coins..." 
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setVisibleCount(20); }}
                  className="bg-[#1c1c1e] border border-[#2c2c2e]/60 rounded-lg pl-7 pr-3 py-1 text-[10px] text-[#f5f5f7] font-mono focus:outline-none focus:border-sky-500/50 w-36 sm:w-44 placeholder:text-zinc-600"
                />
              </div>

              {/* Category Tab Selector */}
              <div className="flex bg-[#1c1c1e] p-0.5 rounded-lg border border-[#2c2c2e]/60 text-[9px] font-bold font-mono">
                <button 
                  onClick={() => { setActiveTab('core'); setVisibleCount(20); }}
                  className={`px-2.5 py-1 rounded-md transition-all duration-300 ${
                    activeTab === 'core' 
                      ? 'bg-[#0071e3] text-white shadow-md' 
                      : 'text-[#86868b] hover:text-[#f5f5f7]'
                  }`}
                >
                  Core
                </button>
                <button 
                  onClick={() => { setActiveTab('meme'); setVisibleCount(20); }}
                  className={`px-2.5 py-1 rounded-md transition-all duration-300 ${
                    activeTab === 'meme' 
                      ? 'bg-[#0071e3] text-white shadow-md' 
                      : 'text-[#86868b] hover:text-[#f5f5f7]'
                  }`}
                >
                  Memes
                </button>
                <button 
                  onClick={() => { setActiveTab('recommended'); setVisibleCount(20); }}
                  className={`px-2.5 py-1 rounded-md transition-all duration-300 ${
                    activeTab === 'recommended' 
                      ? 'bg-[#0071e3] text-white shadow-md' 
                      : 'text-[#86868b] hover:text-[#f5f5f7]'
                  }`}
                >
                  Recommended ({assetCategories.recommended?.length || 0})
                </button>
              </div>
            </div>
          </div>

          {/* Grid of Price Cards */}
          <div className="grid-layout-2">
            {displayedAssets.map((asset) => (
              <LivePriceCard
                key={asset}
                asset={asset}
              />
            ))}
          </div>

          {/* Load More Button */}
          {filteredAssets.length > visibleCount && (
            <button 
              onClick={() => setVisibleCount((prev) => prev + 20)}
              className="w-full py-2.5 bg-[#1c1c1e] hover:bg-zinc-800/40 border border-[#2c2c2e]/60 text-sky-400 font-mono text-[10px] font-bold rounded-xl transition-all duration-200 mt-3 cursor-pointer"
            >
              Load More Coins ({filteredAssets.length - visibleCount} Remaining)
            </button>
          )}
        </div>

        {/* Signals Feed */}
        <div className="space-y-4">
          <h3 className="text-xs font-bold text-[#86868b] uppercase tracking-widest flex items-center gap-1.5 font-mono mb-2">
            <Bot size={13} className="text-purple-400" />
            Recent AI Signals
          </h3>
          <div className="glass-panel min-h-[300px] flex flex-col justify-between bg-[#1c1c1e] !p-0">
            {displayedSignals.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-12 text-center my-auto">
                <span className="text-[10px] text-zinc-500 font-extrabold uppercase tracking-widest font-mono animate-pulse">
                  SYNCING PIPELINE...
                </span>
              </div>
            ) : (
              <div className="divide-y divide-[#2c2c2e]/60 max-h-[320px] overflow-y-auto pr-1">
                {displayedSignals.slice(0, 5).map((sig, i) => (
                  <div key={i} className="flex items-center justify-between px-5 py-4 hover:bg-zinc-800/20 transition-colors duration-200 group">
                    <div className="flex items-center gap-3">
                      <div className="w-1.5 h-1.5 rounded-full bg-sky-500" />
                      <div>
                        <span className="font-bold text-[#f5f5f7] font-mono">
                          {sig.asset?.replace('1000', '').replace('USDT', '')}
                        </span>
                        <span className="text-[9px] text-[#86868b] ml-3 font-mono font-medium">
                          {(sig.timestamp || sig.createdAt) ? new Date(sig.timestamp || sig.createdAt).toLocaleTimeString() : ''}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3.5">
                      <SignalBadge action={sig.action} />
                      <span className="font-bold text-[#f5f5f7] font-mono text-[10px] bg-black border border-[#2c2c2e]/40 px-2 py-0.5 rounded-full">
                        {sig.confidence ? `${(sig.confidence * 100).toFixed(0)}%` : '—'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="p-3 bg-black/45 border-t border-[#2c2c2e]/60 flex justify-center">
              <span className="text-[8px] font-bold text-[#86868b] uppercase tracking-widest font-mono">
                Consolidated Decision Pipeline
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Trade ledger table */}
      <div className="space-y-4">
        <h3 className="text-xs font-bold text-[#86868b] uppercase tracking-widest flex items-center gap-1.5 font-mono mb-2">
          <BarChart3 size={13} className="text-sky-400" />
          Autonomous Trade Ledger
        </h3>
        <div className="glass-panel overflow-hidden bg-[#1c1c1e] !p-0">
          {recentTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center h-44">
              <ShieldCheck size={20} className="text-zinc-600 mb-2" />
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest font-mono">
                NO TRADES EXECUTED IN CURRENT SESSION
              </span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-black/35 border-b border-[#2c2c2e]/60 text-[#86868b] font-bold text-[9px] uppercase tracking-widest font-mono">
                    <th className="px-6 py-4">Asset</th>
                    <th className="px-6 py-4">Action</th>
                    <th className="px-6 py-4 text-right">Execution Price</th>
                    <th className="px-6 py-4 text-right">Position Size</th>
                    <th className="px-6 py-4 text-right">Commission</th>
                    <th className="px-6 py-4 text-right">Confidence</th>
                    <th className="px-6 py-4 text-right">Realized Return</th>
                    <th className="px-6 py-4 text-right">Net Return</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2c2c2e]/40">
                  {recentTrades.slice(0, 5).map((trade, i) => (
                    <tr key={i} className="hover:bg-zinc-800/10 transition-all duration-150 font-semibold text-zinc-300">
                      <td className="px-6 py-4 font-bold text-[#f5f5f7] font-mono">
                        {trade.asset?.replace('1000', '').replace('USDT', '')}
                      </td>
                      <td className="px-6 py-4">
                        <SignalBadge action={trade.action} />
                      </td>
                      <td className="px-6 py-4 text-right text-[#f5f5f7] font-mono font-bold">
                        {formatPrice(trade.price || trade.entryPrice)}
                      </td>
                      <td className="px-6 py-4 text-right text-[#86868b] font-mono">
                        {trade.quantity?.toFixed(5) || '—'}
                      </td>
                      <td className="px-6 py-4 text-right text-[#ff9f0a] font-mono font-bold">
                        {(trade.fees && trade.fees > 0)
                          ? `$${trade.fees.toFixed(4)}` 
                          : `$${((trade.price || trade.entryPrice) * trade.quantity * (trade.status === 'closed' ? 0.0010 : 0.0005)).toFixed(4)}`}
                      </td>
                      <td className="px-6 py-4 text-right font-bold text-[#0071e3] font-mono">
                        {trade.confidence ? `${(trade.confidence * 100).toFixed(0)}%` : '—'}
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
                              : (((trade.pnl || 0) - ((trade.fees && trade.fees > 0) ? trade.fees : ((trade.price || trade.entryPrice) * trade.quantity * (trade.status === 'closed' ? 0.0010 : 0.0005)))) >= 0 ? '#30d158' : '#ff453a') 
                        }}
                      >
                        {trade.status === 'open' 
                          ? 'ACTIVE' 
                          : trade.status === 'failed' 
                            ? 'FAILED' 
                            : (() => {
                                const fees = (trade.fees && trade.fees > 0)
                                  ? trade.fees 
                                  : ((trade.price || trade.entryPrice) * trade.quantity * (trade.status === 'closed' ? 0.0010 : 0.0005));
                                const net = (trade.pnl || 0) - fees;
                                return `${net >= 0 ? '+' : ''}$${net.toFixed(2)}`;
                              })()}
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
