import React, { useState, useEffect } from 'react';
import { useMarketStore, useSignalStore, usePortfolioStore, socket } from '../store.js';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { CandlestickChart, TrendingUp, Shield, Info, ShoppingBag, XCircle, ChevronRight, Gauge, Check } from 'lucide-react';
import axios from 'axios';
const axiosActual = axios;

const CORE_ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT'];
const MEME_ASSETS = ['DOGEUSDT', '1000SHIBUSDT', '1000PEPEUSDT', 'WIFUSDT', '1000FLOKIUSDT', '1000BONKUSDT', 'BOMEUSDT', 'PEOPLEUSDT'];
const RECOMMENDED_ASSETS = ['AVAXUSDT', 'DOTUSDT', 'POLUSDT', 'LTCUSDT', 'PORTALUSDT', 'HEIUSDT', 'IDUSDT', 'LABUSDT', 'STGUSDT', 'EPICUSDT'];
const ASSETS = [...CORE_ASSETS, ...MEME_ASSETS, ...RECOMMENDED_ASSETS];

function MetricProgress({ label, value, isRisk = false }) {
  const pct = Math.min(Math.max((value || 0) * 100, 0), 100);
  const barColor = isRisk 
    ? (pct > 60 ? 'bg-[#ff453a]' : 'bg-[#30d158]') 
    : 'bg-[#0071e3]';
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs font-semibold">
        <span className="text-[#86868b] uppercase text-[9px] tracking-widest font-mono">{label}</span>
        <span className="text-[#f5f5f7] font-bold font-mono text-[10px]">{pct.toFixed(0)}%</span>
      </div>
      <div className="w-full bg-black rounded-full h-1.5 overflow-hidden border border-[#2c2c2e]/60">
        <div className={`h-full rounded-full transition-all duration-700 ${barColor}`} style={{ width: `${pct}%` }}></div>
      </div>
    </div>
  );
}

export default function Trading() {
  const [selectedAsset, setSelectedAsset] = useState('BTCUSDT');
  const [activePosition, setActivePosition] = useState(null);
  const [activeTab, setActiveTab] = useState('core'); // 'core' | 'meme' | 'recommended'

  const [assetCategories, setAssetCategories] = useState({
    core: CORE_ASSETS,
    meme: MEME_ASSETS,
    recommended: RECOMMENDED_ASSETS,
    all: ASSETS
  });

  useEffect(() => {
    const fetchAssetCategories = async () => {
      try {
        const res = await axiosActual.get('/api/market/asset-categories');
        if (res.data.success && res.data.data) {
          setAssetCategories(res.data.data);
        }
      } catch {}
    };
    fetchAssetCategories();
  }, []);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    if (tab === 'core') {
      setSelectedAsset('BTCUSDT');
    } else if (tab === 'meme') {
      setSelectedAsset('DOGEUSDT');
    } else {
      setSelectedAsset('AVAXUSDT');
    }
  };

  // Manual Quick Order State
  const [orderAction, setOrderAction] = useState('BUY');
  const [orderQuantity, setOrderQuantity] = useState(0.01);
  const [orderType, setOrderType] = useState('Market');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [orderFeedback, setOrderFeedback] = useState(null);

  const price = useMarketStore((s) => s.prices[selectedAsset]);
  const rawCandles = useMarketStore((s) => s.candles[selectedAsset]);
  const signal = useSignalStore((s) => s.fusedSignals[selectedAsset]);
  const tech = useSignalStore((s) => s.technicalSignals[selectedAsset]);
  const sent = useSignalStore((s) => s.sentimentSignals[selectedAsset]);
  const portfolio = usePortfolioStore((s) => s.portfolio);
  const [scalpInput, setScalpInput] = useState(portfolio?.minNetProfitTarget !== undefined ? portfolio.minNetProfitTarget : 0.25);
  const [trailingSlInput, setTrailingSlInput] = useState(portfolio?.trailingStopUsd !== undefined ? portfolio.trailingStopUsd : 0.40);

  useEffect(() => {
    if (portfolio?.minNetProfitTarget !== undefined) {
      setScalpInput(portfolio.minNetProfitTarget);
    }
    if (portfolio?.trailingStopUsd !== undefined) {
      setTrailingSlInput(portfolio.trailingStopUsd);
    }
  }, [portfolio?.minNetProfitTarget, portfolio?.trailingStopUsd]);

  const candles = (rawCandles || []).map((c) => ({
    time: new Date(c.openTime || c.timestamp || c.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    price: c.close,
    high: c.high,
    low: c.low,
    volume: c.volume,
  }));

  useEffect(() => {
    if (price && orderType === 'Market') {
      setLimitPrice(price.toString());
    }
  }, [price, orderType]);

  useEffect(() => {
    fetchCandles(selectedAsset);
    socket.emit('subscribe:asset', selectedAsset);
    return () => {
      socket.emit('unsubscribe:asset', selectedAsset);
    };
  }, [selectedAsset]);

  useEffect(() => {
    const fetchPortfolio = async () => {
      try {
        const res = await axiosActual.get('/api/portfolio');
        if (res.data.success) {
          usePortfolioStore.getState().setPortfolio(res.data.data);
        }
      } catch (err) {
        console.error("Failed to fetch initial portfolio state:", err);
      }
    };
    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const res = await axiosActual.get('/api/portfolio/positions');
        if (res.data.success) {
          const open = res.data.data.find((p) => p.asset === selectedAsset);
          setActivePosition(open || null);
        }
      } catch {
        setActivePosition(null);
      }
    };
    fetchPositions();
  }, [selectedAsset, portfolio]);

  const fetchCandles = async (asset) => {
    try {
      const res = await axiosActual.get(`/api/market/candles/${asset}?limit=80`);
      if (res.data.success) {
        useMarketStore.getState().setCandles(asset, res.data.data);
        if (res.data.data.length > 0) {
          const lastCandle = res.data.data[res.data.data.length - 1];
          useMarketStore.getState().setPrice(asset, lastCandle.close || lastCandle.price);
        }
      }
    } catch {
      useMarketStore.getState().setCandles(asset, []);
    }
  };

  const handlePlaceOrder = async (e) => {
    e.preventDefault();
    setOrderFeedback(null);
    const executionPrice = orderType === 'Market' ? price : parseFloat(limitPrice);

    if (!executionPrice) {
      setOrderFeedback({ type: 'error', message: 'Price stream not available' });
      return;
    }

    try {
      const res = await axiosActual.post('/api/trades/manual', {
        asset: selectedAsset,
        action: orderAction,
        entryPrice: executionPrice,
        quantity: parseFloat(orderQuantity),
        side: orderAction === 'BUY' ? 'long' : 'short',
        stopLoss: stopLoss ? parseFloat(stopLoss) : undefined,
        takeProfit: takeProfit ? parseFloat(takeProfit) : undefined,
      });

      if (res.data.success) {
        setOrderFeedback({ type: 'success', message: 'Order executed successfully' });
        usePortfolioStore.getState().setPortfolio(res.data.portfolio);
        setStopLoss('');
        setTakeProfit('');
      }
    } catch (err) {
      setOrderFeedback({ type: 'error', message: err.response?.data?.message || 'Execution failed' });
    }
  };

  const handleClosePosition = async () => {
    if (!price) return;
    try {
      const res = await axiosActual.post('/api/trades/manual-close', {
        asset: selectedAsset,
        exitPrice: price,
      });

      if (res.data.success) {
        setOrderFeedback({ type: 'success', message: 'Position closed successfully' });
        usePortfolioStore.getState().setPortfolio(res.data.portfolio);
        setActivePosition(null);
      }
    } catch (err) {
      setOrderFeedback({ type: 'error', message: err.response?.data?.message || 'Close failed' });
    }
  };

  const isAssetDisabled = portfolio?.manuallyDisabledAssets?.includes(selectedAsset) || false;
  const isAssetIgnored = portfolio?.autoIgnoredAssets?.includes(selectedAsset) || false;

  const handleToggleAsset = async () => {
    try {
      const res = await axiosActual.post('/api/portfolio/toggle-asset', {
        asset: selectedAsset,
        enabled: portfolio?.manuallyDisabledAssets?.includes(selectedAsset) ? true : false
      });
      if (res.data.success) {
        usePortfolioStore.getState().setPortfolio(res.data.data);
      }
    } catch (err) {
      console.error("Failed to toggle asset:", err);
    }
  };
  const entryOrderType = portfolio?.entryOrderType || 'market';
  const exitOrderType = portfolio?.exitOrderType || 'market';

  const handleToggleOrderType = async (typeField, value) => {
    try {
      const res = await axiosActual.put('/api/portfolio/config', {
        [typeField]: value
      });
      if (res.data.success) {
        usePortfolioStore.getState().setPortfolio(res.data.data);
      }
    } catch (err) {
      console.error(`Failed to update ${typeField}:`, err);
    }
  };

  return (
    <div className="page-layout">
      {/* Header & Order Type Settings Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#2c2c2e]/60 pb-5">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#f5f5f7]">Trading Desk</h2>
          <p className="text-[11px] text-[#86868b] mt-1 font-medium">
            Execute manual trades or configure automated agent overrides.
          </p>
        </div>

        {/* Order Type Controls */}
        <div className="flex flex-wrap items-center gap-4 bg-[#1c1c1e] p-2.5 rounded-xl border border-[#2c2c2e]/60">
          {/* Entry Order Type */}
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#86868b] uppercase tracking-widest font-bold font-mono">Entry Order:</span>
            <div className="flex bg-black p-0.5 rounded-lg border border-[#2c2c2e]/60 text-[9px] font-bold font-mono">
              <button
                onClick={() => handleToggleOrderType('entryOrderType', 'market')}
                className={`px-2.5 py-1 rounded cursor-pointer transition-all ${entryOrderType === 'market' ? 'bg-[#0071e3] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                MARKET
              </button>
              <button
                onClick={() => handleToggleOrderType('entryOrderType', 'limit')}
                className={`px-2.5 py-1 rounded cursor-pointer transition-all ${entryOrderType === 'limit' ? 'bg-[#0071e3] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                LIMIT
              </button>
            </div>
          </div>

          <div className="h-4 w-[1px] bg-[#2c2c2e]/80" />

          {/* Exit Order Type */}
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#86868b] uppercase tracking-widest font-bold font-mono">Exit Order:</span>
            <div className="flex bg-black p-0.5 rounded-lg border border-[#2c2c2e]/60 text-[9px] font-bold font-mono">
              <button
                onClick={() => handleToggleOrderType('exitOrderType', 'market')}
                className={`px-2.5 py-1 rounded cursor-pointer transition-all ${exitOrderType === 'market' ? 'bg-[#30d158] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                MARKET
              </button>
              <button
                onClick={() => handleToggleOrderType('exitOrderType', 'limit')}
                className={`px-2.5 py-1 rounded cursor-pointer transition-all ${exitOrderType === 'limit' ? 'bg-[#30d158] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                LIMIT
              </button>
            </div>
          </div>

          <div className="h-4 w-[1px] bg-[#2c2c2e]/80" />

          {/* Net Scalp Target ($ USDT) */}
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#bf5af2] uppercase tracking-widest font-bold font-mono">Scalp Target:</span>
            <div className="flex items-center bg-black p-0.5 rounded-lg border border-[#2c2c2e]/60 text-[9px] font-bold font-mono">
              <button
                onClick={() => { setScalpInput(0.10); handleToggleOrderType('minNetProfitTarget', 0.10); }}
                className={`px-2 py-1 rounded cursor-pointer transition-all ${portfolio?.minNetProfitTarget === 0.10 ? 'bg-[#bf5af2] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                $0.10
              </button>
              <button
                onClick={() => { setScalpInput(0.25); handleToggleOrderType('minNetProfitTarget', 0.25); }}
                className={`px-2 py-1 rounded cursor-pointer transition-all ${portfolio?.minNetProfitTarget === 0.25 ? 'bg-[#bf5af2] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                $0.25
              </button>
              <button
                onClick={() => { setScalpInput(0.50); handleToggleOrderType('minNetProfitTarget', 0.50); }}
                className={`px-2 py-1 rounded cursor-pointer transition-all ${portfolio?.minNetProfitTarget === 0.50 ? 'bg-[#bf5af2] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                $0.50
              </button>
              <div className="flex items-center gap-1 pl-1.5 pr-1 border-l border-[#2c2c2e]/80 ml-0.5">
                <span className="text-[#bf5af2] text-[10px] font-bold">$</span>
                <input
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.05"
                  value={scalpInput}
                  onChange={(e) => setScalpInput(e.target.value)}
                  onBlur={() => {
                    const val = parseFloat(scalpInput);
                    if (!isNaN(val) && val > 0) handleToggleOrderType('minNetProfitTarget', val);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = parseFloat(scalpInput);
                      if (!isNaN(val) && val > 0) handleToggleOrderType('minNetProfitTarget', val);
                    }
                  }}
                  className="w-12 bg-[#1c1c1e] text-white text-[10px] font-mono px-1 py-0.5 rounded border border-[#3a3a3c] focus:outline-none focus:border-[#bf5af2]"
                  placeholder="0.25"
                />
              </div>
            </div>
          </div>

          <div className="h-4 w-[1px] bg-[#2c2c2e]/80" />

          {/* Trailing Stop Loss ($ USDT) */}
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#ff453a] uppercase tracking-widest font-bold font-mono">Trailing SL:</span>
            <div className="flex items-center bg-black p-0.5 rounded-lg border border-[#2c2c2e]/60 text-[9px] font-bold font-mono">
              <button
                onClick={() => { setTrailingSlInput(0.10); handleToggleOrderType('trailingStopUsd', 0.10); }}
                className={`px-2 py-1 rounded cursor-pointer transition-all ${portfolio?.trailingStopUsd === 0.10 ? 'bg-[#ff453a] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                $0.10
              </button>
              <button
                onClick={() => { setTrailingSlInput(0.25); handleToggleOrderType('trailingStopUsd', 0.25); }}
                className={`px-2 py-1 rounded cursor-pointer transition-all ${portfolio?.trailingStopUsd === 0.25 ? 'bg-[#ff453a] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                $0.25
              </button>
              <button
                onClick={() => { setTrailingSlInput(0.40); handleToggleOrderType('trailingStopUsd', 0.40); }}
                className={`px-2 py-1 rounded cursor-pointer transition-all ${portfolio?.trailingStopUsd === 0.40 ? 'bg-[#ff453a] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                $0.40
              </button>
              <button
                onClick={() => { setTrailingSlInput(1.00); handleToggleOrderType('trailingStopUsd', 1.00); }}
                className={`px-2 py-1 rounded cursor-pointer transition-all ${portfolio?.trailingStopUsd === 1.00 ? 'bg-[#ff453a] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                $1.00
              </button>
              <div className="flex items-center gap-1 pl-1.5 pr-1 border-l border-[#2c2c2e]/80 ml-0.5">
                <span className="text-[#ff453a] text-[10px] font-bold">$</span>
                <input
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.05"
                  value={trailingSlInput}
                  onChange={(e) => setTrailingSlInput(e.target.value)}
                  onBlur={() => {
                    const val = parseFloat(trailingSlInput);
                    if (!isNaN(val) && val > 0) handleToggleOrderType('trailingStopUsd', val);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = parseFloat(trailingSlInput);
                      if (!isNaN(val) && val > 0) handleToggleOrderType('trailingStopUsd', val);
                    }
                  }}
                  className="w-12 bg-[#1c1c1e] text-white text-[10px] font-mono px-1 py-0.5 rounded border border-[#3a3a3c] focus:outline-none focus:border-[#ff453a]"
                  placeholder="0.40"
                />
              </div>
            </div>
          </div>

          <div className="h-4 w-[1px] bg-[#2c2c2e]/80" />

          {/* Explicit Save & Apply Button */}
          <button
            type="button"
            onClick={async () => {
              const scalpVal = parseFloat(scalpInput);
              const slVal = parseFloat(trailingSlInput);
              if (!isNaN(scalpVal) && scalpVal > 0) {
                await handleToggleOrderType('minNetProfitTarget', scalpVal);
              }
              if (!isNaN(slVal) && slVal > 0) {
                await handleToggleOrderType('trailingStopUsd', slVal);
              }
              setOrderFeedback({ type: 'success', message: 'Scalp Target & Trailing SL settings saved successfully!' });
              setTimeout(() => setOrderFeedback(null), 3000);
            }}
            className="flex items-center gap-1 px-3 py-1 bg-[#30d158] hover:bg-[#28b84c] text-black font-bold font-mono text-[9px] rounded-lg transition-all shadow-md active:scale-95 cursor-pointer ml-1"
          >
            <Check className="w-3 h-3" />
            SAVE & APPLY
          </button>
        </div>
      </div>

      {/* Asset Selection & Category Selector Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#2c2c2e]/60 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex bg-[#1c1c1e] p-0.5 rounded-lg border border-[#2c2c2e]/60 text-[9px] font-bold font-mono">
            <button 
              onClick={() => handleTabChange('core')}
              className={`px-3 py-1 rounded-md transition-all duration-300 ${
                activeTab === 'core' 
                  ? 'bg-[#0071e3] text-white shadow-md' 
                  : 'text-[#86868b] hover:text-[#f5f5f7]'
              }`}
            >
              Core Crypto
            </button>
            <button 
              onClick={() => handleTabChange('meme')}
              className={`px-3 py-1 rounded-md transition-all duration-300 ${
                activeTab === 'meme' 
                  ? 'bg-[#0071e3] text-white shadow-md' 
                  : 'text-[#86868b] hover:text-[#f5f5f7]'
              }`}
            >
              Meme Coins
            </button>
            <button 
              onClick={() => handleTabChange('recommended')}
              className={`px-3 py-1 rounded-md transition-all duration-300 ${
                activeTab === 'recommended' 
                  ? 'bg-[#0071e3] text-white shadow-md' 
                  : 'text-[#86868b] hover:text-[#f5f5f7]'
              }`}
            >
              Recommended ({assetCategories.recommended?.length || 0})
            </button>
          </div>

          {/* Asset List Buttons */}
          <div className="flex flex-wrap gap-1 p-1 bg-[#1c1c1e] border border-[#2c2c2e]/60 rounded-full max-h-[120px] overflow-y-auto">
            {(activeTab === 'core' 
              ? assetCategories.core 
              : activeTab === 'meme' 
                ? assetCategories.meme 
                : assetCategories.recommended).map((asset) => (
              <button
                key={asset}
                onClick={() => setSelectedAsset(asset)}
                className={`px-3 py-1 rounded-full text-xs font-bold transition-all duration-300 cursor-pointer font-mono ${
                  selectedAsset === asset
                    ? 'bg-[#f5f5f7] text-black shadow-sm'
                    : 'bg-transparent text-[#86868b] hover:text-[#f5f5f7]'
                }`}
              >
                {asset.replace('1000', '').replace('USDT', '')}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid-layout-3">
        {/* Left pane: Chart + Actions */}
        <div className="lg:col-span-2 space-y-6">
          {/* Main Chart */}
          <div className="glass-panel relative overflow-hidden bg-[#1c1c1e]">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <span className="text-base font-semibold tracking-tight text-[#f5f5f7] font-mono">
                  {selectedAsset.replace('1000', '').replace('USDT', '')}/USDT
                </span>
                <span className="text-2xl font-bold text-[#f5f5f7] mr-4 font-mono">
                  {price ? (price >= 1 ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${price.toFixed(6)}`) : '—'}
                </span>
                
                {/* Status Badge */}
                {isAssetIgnored ? (
                  <span className="px-2 py-0.5 rounded border border-amber-500/20 bg-amber-500/10 text-amber-500 text-[9px] font-bold uppercase tracking-wider font-mono">
                    ⚠️ Auto-Ignored
                  </span>
                ) : isAssetDisabled ? (
                  <span className="px-2 py-0.5 rounded border border-rose-500/20 bg-rose-500/10 text-rose-500 text-[9px] font-bold uppercase tracking-wider font-mono">
                    🔴 Disabled
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded border border-emerald-500/20 bg-emerald-500/10 text-emerald-500 text-[9px] font-bold uppercase tracking-wider font-mono">
                    🟢 Active
                  </span>
                )}

                {/* Toggle Switch */}
                <button
                  type="button"
                  onClick={handleToggleAsset}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    isAssetDisabled ? 'bg-zinc-700' : 'bg-[#30d158]'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      isAssetDisabled ? 'translate-x-0' : 'translate-x-4'
                    }`}
                  />
                </button>
              </div>
              {signal && (
                <span className={`px-3 py-1 rounded-full text-[9px] font-bold border uppercase tracking-wider font-mono ${
                  signal.action === 'BUY'
                    ? 'bg-[#30d158]/10 border-[#30d158]/20 text-[#30d158]'
                    : 'bg-[#ff453a]/10 border-[#ff453a]/20 text-[#ff453a]'
                }`}>
                  AI STRATEGY: {signal.action}
                </span>
              )}
            </div>

            {candles.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <AreaChart data={candles} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                  <defs>
                    <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0071e3" stopOpacity={0.12} />
                      <stop offset="95%" stopColor="#0071e3" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.02)" vertical={false} />
                  <XAxis dataKey="time" stroke="#86868b" fontSize={9} tickLine={false} className="font-mono" />
                  <YAxis stroke="#86868b" fontSize={9} tickLine={false} domain={['auto', 'auto']} className="font-mono" />
                  <Tooltip
                    contentStyle={{ background: '#000000', border: '1px solid #2c2c2e', borderRadius: '12px', color: '#f5f5f7' }}
                    itemStyle={{ fontSize: '11px', color: '#f5f5f7', fontFamily: 'monospace' }}
                  />
                  <Area type="monotone" dataKey="price" stroke="#0071e3" fillOpacity={1} fill="url(#chartGradient)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[320px] flex items-center justify-center text-xs text-zinc-500 font-extrabold uppercase tracking-widest font-mono animate-pulse">
                SYNCING FEED...
              </div>
            )}
          </div>

          {/* Quick order entry and open positions */}
          <div className="grid-layout-2">
            {/* Quick Order Form */}
            <div className="glass-panel bg-[#1c1c1e]">
              <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest flex items-center gap-2 border-b border-[#2c2c2e]/60 pb-3 font-mono mb-4">
                <ShoppingBag size={14} className="text-sky-400" />
                Execution Ticket
              </h3>

              <form onSubmit={handlePlaceOrder} className="space-y-4 text-xs">
                <div className="grid grid-cols-2 gap-1 p-0.5 bg-black border border-[#2c2c2e]/60 rounded-full">
                  <button
                    type="button"
                    onClick={() => setOrderAction('BUY')}
                    className={`py-1.5 rounded-full font-bold text-xs transition-all duration-300 cursor-pointer font-mono ${
                      orderAction === 'BUY' 
                        ? 'bg-[#30d158] text-black font-semibold' 
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    LONG / BUY
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrderAction('SELL')}
                    className={`py-1.5 rounded-full font-bold text-xs transition-all duration-300 cursor-pointer font-mono ${
                      orderAction === 'SELL' 
                        ? 'bg-[#ff453a] text-white font-semibold' 
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    SHORT / SELL
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[9px] text-[#86868b] font-bold uppercase tracking-widest font-mono mb-1.5">Type</label>
                    <select
                      value={orderType}
                      onChange={(e) => setOrderType(e.target.value)}
                      className="w-full bg-[#2c2c2e] border border-[#2c2c2e] rounded-xl px-3 py-2 text-[#f5f5f7] font-semibold outline-none focus:border-zinc-500 transition-colors text-xs cursor-pointer"
                    >
                      <option>Market</option>
                      <option>Limit</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[9px] text-[#86868b] font-bold uppercase tracking-widest font-mono mb-1.5">Quantity</label>
                    <input
                      type="number"
                      step="0.001"
                      value={orderQuantity}
                      onChange={(e) => setOrderQuantity(parseFloat(e.target.value) || 0)}
                      className="w-full bg-[#2c2c2e] border border-[#2c2c2e] rounded-xl px-3 py-2 text-[#f5f5f7] font-mono font-bold outline-none focus:border-zinc-500 transition-colors"
                    />
                  </div>
                </div>

                {orderType === 'Limit' && (
                  <div>
                    <label className="block text-[9px] text-[#86868b] font-bold uppercase tracking-widest font-mono mb-1.5">Limit Price</label>
                    <input
                      type="number"
                      step="0.01"
                      value={limitPrice}
                      onChange={(e) => setLimitPrice(e.target.value)}
                      className="w-full bg-[#2c2c2e] border border-[#2c2c2e] rounded-xl px-3 py-2 text-[#f5f5f7] font-mono font-bold outline-none focus:border-zinc-500 transition-colors"
                    />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[9px] text-[#86868b] font-bold uppercase tracking-widest font-mono mb-1.5">Stop Loss (SL)</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="SL Price"
                      value={stopLoss}
                      onChange={(e) => setStopLoss(e.target.value)}
                      className="w-full bg-[#2c2c2e] border border-[#2c2c2e] rounded-xl px-3 py-2 text-[#f5f5f7] font-mono outline-none focus:border-zinc-500 transition-colors placeholder-zinc-600"
                    />
                  </div>
                  <div>
                    <label className="block text-[9px] text-[#86868b] font-bold uppercase tracking-widest font-mono mb-1.5">Take Profit (TP)</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="TP Price"
                      value={takeProfit}
                      onChange={(e) => setTakeProfit(e.target.value)}
                      className="w-full bg-[#2c2c2e] border border-[#2c2c2e] rounded-xl px-3 py-2 text-[#f5f5f7] font-mono outline-none focus:border-zinc-500 transition-colors placeholder-zinc-600"
                    />
                  </div>
                </div>

                {orderFeedback && (
                  <div className={`p-3 rounded-xl text-[10px] font-bold border font-mono ${
                    orderFeedback.type === 'success' 
                      ? 'bg-[#30d158]/10 border-[#30d158]/20 text-[#30d158]' 
                      : 'bg-[#ff453a]/10 border-[#ff453a]/20 text-[#ff453a]'
                  }`}>
                    {orderFeedback.message}
                  </div>
                )}

                {portfolio?.tradingPaused && (
                  <div className="p-3 bg-red-950/20 border border-red-500/20 text-red-300 rounded-xl text-[10px] font-bold font-mono">
                    ⚠️ Trading is paused because the profit target has been met. Resume the bot from the Portfolio page.
                  </div>
                )}

                <button
                  type="submit"
                  disabled={portfolio?.tradingPaused}
                  className={`w-full py-2.5 text-xs font-bold rounded-full tracking-wider uppercase transition-all duration-300 shadow-sm mt-2 cursor-pointer ${
                    portfolio?.tradingPaused
                      ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed border border-[#2c2c2e]'
                      : 'bg-[#f5f5f7] hover:bg-[#e5e5ea] text-black hover:scale-[1.01]'
                  }`}
                >
                  {portfolio?.tradingPaused ? 'Trading Paused' : 'Submit Order'}
                </button>
              </form>
            </div>

            {/* Active Position Info */}
            <div className="glass-panel bg-[#1c1c1e]">
              <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest flex items-center gap-2 border-b border-[#2c2c2e]/60 pb-3 font-mono mb-4">
                <Shield size={14} className="text-purple-400" />
                Exposure
              </h3>

              {activePosition ? (
                <div className="space-y-4 text-xs">
                  <div className="flex justify-between items-center bg-black p-3 rounded-xl border border-[#2c2c2e]/40">
                    <span className="text-[9px] text-[#86868b] font-bold uppercase tracking-widest font-mono">Asset Pair</span>
                    <span className="font-bold text-[#f5f5f7] font-mono">{activePosition.asset?.replace('USDT', '')}/USDT</span>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-black p-3 rounded-xl border border-[#2c2c2e]/40">
                      <span className="block text-[9px] text-[#86868b] uppercase tracking-widest font-bold font-mono mb-1">Direction</span>
                      <span className={`font-black uppercase text-[10px] font-mono ${activePosition.side === 'long' ? 'text-[#30d158]' : 'text-[#ff453a]'}`}>
                        {activePosition.side?.toUpperCase()}
                      </span>
                    </div>
                    <div className="bg-black p-3 rounded-xl border border-[#2c2c2e]/40">
                      <span className="block text-[9px] text-[#86868b] uppercase tracking-widest font-bold font-mono mb-1">Entry Price</span>
                      <span className="font-bold text-[#f5f5f7] font-mono">
                        {activePosition.entryPrice ? (activePosition.entryPrice >= 1 ? `$${activePosition.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${activePosition.entryPrice.toFixed(6)}`) : '—'}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-black p-3 rounded-xl border border-[#2c2c2e]/40">
                      <span className="block text-[9px] text-[#86868b] uppercase tracking-widest font-bold font-mono mb-1">Position Qty</span>
                      <span className="font-bold text-zinc-300 font-mono">{activePosition.quantity?.toFixed(4)}</span>
                    </div>
                    <div className="bg-black p-3 rounded-xl border border-[#2c2c2e]/40">
                      <span className="block text-[9px] text-[#86868b] uppercase tracking-widest font-bold font-mono mb-1">Unrealized PnL</span>
                      <span className={`font-black font-mono text-sm ${
                        activePosition.unrealizedPnl >= 0 ? 'text-[#30d158]' : 'text-[#ff453a]'
                      }`}>
                        {activePosition.unrealizedPnl >= 0 ? '+' : ''}${activePosition.unrealizedPnl?.toFixed(2)}
                      </span>
                    </div>
                  </div>

                  <div className="flex justify-between items-center bg-black p-3 rounded-xl border border-[#2c2c2e]/40">
                    <span className="text-[9px] text-[#86868b] font-bold uppercase tracking-widest font-mono">Commission Paid (Taker 0.05%)</span>
                    <span className="font-bold text-[#ff9f0a] font-mono">
                      {activePosition.fees !== undefined && activePosition.fees !== null 
                        ? `$${activePosition.fees.toFixed(4)}` 
                        : `$${(activePosition.entryPrice * activePosition.quantity * 0.0005).toFixed(4)}`}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-black p-3 rounded-xl border border-[#2c2c2e]/40">
                      <span className="block text-[9px] text-[#86868b] uppercase tracking-widest font-bold font-mono mb-1">Stop Loss</span>
                      <span className="font-bold text-[#ff453a] font-mono">
                        {activePosition.stopLoss ? (activePosition.stopLoss >= 1 ? `$${activePosition.stopLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${activePosition.stopLoss.toFixed(6)}`) : '—'}
                      </span>
                    </div>
                    <div className="bg-black p-3 rounded-xl border border-[#2c2c2e]/40">
                      <span className="block text-[9px] text-[#86868b] uppercase tracking-widest font-bold font-mono mb-1">Take Profit</span>
                      <span className="font-bold text-[#30d158] font-mono">
                        {activePosition.takeProfit ? (activePosition.takeProfit >= 1 ? `$${activePosition.takeProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${activePosition.takeProfit.toFixed(6)}`) : '—'}
                      </span>
                    </div>
                  </div>

                  {/* Dynamic Profit Engine Info */}
                  {(activePosition.dynamicTrailingPct || activePosition.lockedMinProfit || activePosition.maxProfitReached) && (
                    <div className="bg-black/40 p-4 rounded-xl border border-[#2c2c2e]/60 space-y-3 mt-3">
                      <span className="block text-[9px] text-[#bf5af2] uppercase tracking-widest font-bold font-mono border-b border-[#2c2c2e]/40 pb-2">
                        Dynamic Recalculation Engine
                      </span>
                      
                      <div className="grid grid-cols-2 gap-3 text-[10px] font-mono leading-relaxed font-semibold">
                        <div>
                          <span className="block text-[8px] text-[#86868b] uppercase tracking-widest font-bold">Category</span>
                          <span className="text-[#f5f5f7] uppercase font-bold">{activePosition.category || 'other'}</span>
                        </div>
                        <div>
                          <span className="block text-[8px] text-[#86868b] uppercase tracking-widest font-bold">Dynamic Trailing</span>
                          <span className="text-[#bf5af2] font-bold">
                            {activePosition.dynamicTrailingPct ? `${(activePosition.dynamicTrailingPct * 100).toFixed(2)}%` : '—'}
                          </span>
                        </div>
                        <div className="mt-1">
                          <span className="block text-[8px] text-[#86868b] uppercase tracking-widest font-bold">Locked Profit</span>
                          <span className={activePosition.lockedMinProfit ? "text-[#30d158] font-bold" : "text-zinc-500 font-bold"}>
                            {activePosition.lockedMinProfit ? `$${activePosition.lockedMinProfit.toFixed(4)}` : 'No (Unprotected)'}
                          </span>
                        </div>
                        <div className="mt-1">
                          <span className="block text-[8px] text-[#86868b] uppercase tracking-widest font-bold">MFE (Peak PnL)</span>
                          <span className="text-[#30d158] font-bold">
                            {activePosition.maxProfitReached !== undefined ? `+$${activePosition.maxProfitReached.toFixed(2)}` : '—'}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}


                  <button
                    onClick={handleClosePosition}
                    className="w-full py-2.5 bg-transparent text-[#ff453a] border border-[#ff453a]/30 hover:border-[#ff453a]/50 hover:bg-[#ff453a]/10 font-bold rounded-full text-xs uppercase cursor-pointer transition-all duration-300 mt-2"
                  >
                    Liquidate Position
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center p-8 text-center h-full my-auto text-[#86868b]">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest font-mono">
                    NO EXPOSURE RECORDED
                  </span>
                  <p className="text-[9px] text-zinc-500 mt-2 max-w-[170px] leading-normal font-semibold">
                    Submit manual ticket or wait for auto agents.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right pane: AI and Indicators */}
        <div className="space-y-6">
          {/* AI Decision progress */}
          <div className="glass-panel bg-[#1c1c1e]">
            <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest flex items-center gap-2 border-b border-[#2c2c2e]/60 pb-3 font-mono mb-4">
              <TrendingUp size={14} className="text-sky-400" />
              Consensus Signal
            </h3>

            {signal ? (
              <div className="space-y-5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#86868b] font-bold uppercase tracking-widest text-[9px] font-mono">Recommendation</span>
                  <span className={`font-bold px-2.5 py-0.5 rounded-full text-[9px] tracking-widest uppercase border font-mono ${
                    signal.action === 'BUY' 
                      ? 'bg-[#30d158]/10 border-[#30d158]/20 text-[#30d158]' 
                      : signal.action === 'SELL' 
                        ? 'bg-[#ff453a]/10 border-[#ff453a]/20 text-[#ff453a]' 
                        : 'bg-zinc-900 border-zinc-800 text-zinc-400'
                  }`}>{signal.action}</span>
                </div>

                <div className="space-y-4 py-1">
                  <MetricProgress label="Signal Confidence" value={signal.confidence} />
                  <MetricProgress label="Volatility Risk Index" value={signal.riskScore} isRisk={true} />
                </div>

                <div className="space-y-2 text-xs border-t border-[#2c2c2e]/60 pt-4 font-semibold">
                  <div className="flex justify-between">
                    <span className="text-[#86868b] font-bold uppercase text-[9px] tracking-widest font-mono">Stop Loss Limit</span>
                    <span className="font-bold text-[#ff453a] font-mono">${signal.stopLoss?.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#86868b] font-bold uppercase text-[9px] tracking-widest font-mono">Target Take Profit</span>
                    <span className="font-bold text-[#30d158] font-mono">${signal.takeProfit?.toLocaleString()}</span>
                  </div>
                </div>

                {signal.reasoning && (
                  <div className="p-3.5 rounded-xl text-[10px] bg-black text-[#86868b] border border-[#2c2c2e]/65 leading-normal font-semibold relative overflow-hidden pl-5 mt-2">
                    <div className="absolute top-0 left-0 bottom-0 w-[2px] bg-[#0071e3]" />
                    <Info size={11} className="inline mr-2 text-[#0071e3] align-[-2px]" />
                    {signal.reasoning}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-zinc-500 py-8 text-center uppercase tracking-widest font-mono font-semibold animate-pulse">
                WAITING FOR PIPELINE SYNC...
              </div>
            )}
          </div>

          {/* Technical signals */}
          <div className="glass-panel bg-[#1c1c1e]">
            <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest flex items-center gap-2 border-b border-[#2c2c2e]/60 pb-3 font-mono mb-4">
              <Gauge size={14} className="text-purple-400" />
              Technical Indicators
            </h3>

            {tech?.indicators ? (
              <div className="space-y-3.5 text-xs">
                <div className="flex justify-between items-center font-semibold">
                  <span className="text-[#86868b] font-bold uppercase text-[9px] tracking-widest font-mono">RSI (14 Period)</span>
                  <span className={`font-bold font-mono px-2 py-0.5 rounded-full text-[10px] ${
                    tech.indicators.rsi > 70 ? 'bg-[#ff453a]/10 text-[#ff453a] border border-[#ff453a]/20' :
                      tech.indicators.rsi < 30 ? 'bg-[#30d158]/10 text-[#30d158] border border-[#30d158]/20' : 'bg-black border border-[#2c2c2e]/60 text-zinc-200'
                  }`}>{tech.indicators.rsi?.toFixed(1)}</span>
                </div>
                <div className="flex justify-between items-center font-semibold">
                  <span className="text-[#86868b] font-bold uppercase text-[9px] tracking-widest font-mono">MACD Delta Hist</span>
                  <span className={`font-bold font-mono ${tech.indicators.macd?.histogram > 0 ? 'text-[#30d158]' : 'text-[#ff453a]'}`}>
                    {tech.indicators.macd?.histogram > 0 ? '+' : ''}{tech.indicators.macd?.histogram?.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between items-center font-semibold">
                  <span className="text-[#86868b] font-bold uppercase text-[9px] tracking-widest font-mono">Regime Label</span>
                  <span className="font-bold text-[#f5f5f7] uppercase text-[9px] tracking-widest font-mono">{tech.indicators.regime}</span>
                </div>
                <div className="flex justify-between items-center font-semibold">
                  <span className="text-[#86868b] font-bold uppercase text-[9px] tracking-widest font-mono">Volume Ratio</span>
                  <span className="font-bold text-[#f5f5f7] font-mono">{tech.indicators.volume?.ratio?.toFixed(2)}x</span>
                </div>
              </div>
            ) : (
              <div className="text-xs text-zinc-500 py-6 text-center uppercase tracking-widest font-mono font-semibold animate-pulse">
                WAITING FOR STREAM...
              </div>
            )}
          </div>

          {/* Sentiment */}
          <div className="glass-panel bg-[#1c1c1e]">
            <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest flex items-center gap-2 border-b border-[#2c2c2e]/60 pb-3 font-mono mb-4">
              <ChevronRight size={14} className="text-sky-400" />
              Sentiment Analysis
            </h3>

            {sent ? (
              <div className="space-y-3.5 text-xs">
                <div className="flex justify-between items-center font-semibold">
                  <span className="text-[#86868b] font-bold uppercase text-[9px] tracking-widest font-mono">NLP Sentiment</span>
                  <span className={`font-bold uppercase text-[9px] tracking-widest px-2.5 py-0.5 rounded-full border ${
                    sent.label === 'bullish' ? 'bg-[#30d158]/10 text-[#30d158] border-[#30d158]/20' :
                      sent.label === 'bearish' ? 'bg-[#ff453a]/10 text-[#ff453a] border-[#ff453a]/20' : 'bg-black border border-[#2c2c2e]/60 text-[#86868b]'
                  }`}>{sent.label}</span>
                </div>
                <div className="flex justify-between items-center font-semibold">
                  <span className="text-[#86868b] font-bold uppercase text-[9px] tracking-widest font-mono">Normalized Score</span>
                  <span className="font-bold text-[#f5f5f7] font-mono">{sent.sentiment?.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center font-semibold">
                  <span className="text-[#86868b] font-bold uppercase text-[9px] tracking-widest font-mono">Articles Crawled</span>
                  <span className="font-bold text-[#f5f5f7] font-mono">{sent.articleCount}</span>
                </div>
              </div>
            ) : (
              <div className="text-xs text-zinc-500 py-6 text-center uppercase tracking-widest font-mono font-semibold animate-pulse">
                WAITING FOR SYNC...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
