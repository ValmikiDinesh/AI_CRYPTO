import React, { useState, useEffect } from 'react';
import { useMarketStore, useSignalStore, usePortfolioStore } from '../store.js';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { CandlestickChart, TrendingUp, Shield, Info, ShoppingBag, XCircle } from 'lucide-react';
import axios from 'axios';

const ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'DOGEUSDT'];

function MetricProgress({ label, value, isRisk = false }) {
  const pct = Math.min(Math.max((value || 0) * 100, 0), 100);
  const color = isRisk 
    ? (pct > 60 ? 'bg-[var(--color-accent-red)]' : 'bg-[var(--color-accent-green)]') 
    : 'bg-[var(--color-accent-blue)]';
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs font-semibold">
        <span className="text-[var(--color-text-secondary)] uppercase text-[9px] tracking-wider font-bold">{label}</span>
        <span className="text-[var(--color-text-primary)] font-extrabold font-mono text-[10px]">{pct.toFixed(0)}%</span>
      </div>
      <div className="w-full bg-[var(--color-bg-secondary)] rounded-full h-2 overflow-hidden border border-[var(--color-border)] p-[1px]">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }}></div>
      </div>
    </div>
  );
}

export default function Trading() {
  const [selectedAsset, setSelectedAsset] = useState('BTCUSDT');
  const [candles, setCandles] = useState([]);
  const [activePosition, setActivePosition] = useState(null);

  // Manual Quick Order State
  const [orderAction, setOrderAction] = useState('BUY');
  const [orderQuantity, setOrderQuantity] = useState(0.01);
  const [orderType, setOrderType] = useState('Market');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [orderFeedback, setOrderFeedback] = useState(null);

  const prices = useMarketStore((s) => s.prices);
  const fusedSignals = useSignalStore((s) => s.fusedSignals);
  const technicalSignals = useSignalStore((s) => s.technicalSignals);
  const sentimentSignals = useSignalStore((s) => s.sentimentSignals);
  const predictions = useSignalStore((s) => s.predictions);
  const portfolio = usePortfolioStore((s) => s.portfolio);

  const price = prices[selectedAsset];

  useEffect(() => {
    if (price && orderType === 'Market') {
      setLimitPrice(price.toString());
    }
  }, [price, orderType]);

  useEffect(() => {
    fetchCandles(selectedAsset);
  }, [selectedAsset]);

  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const res = await axios.get('/api/portfolio/positions');
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
      const res = await axios.get(`/api/market/candles/${asset}?limit=80`);
      if (res.data.success) {
        setCandles(
          res.data.data.map((c) => ({
            time: new Date(c.openTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            price: c.close,
            high: c.high,
            low: c.low,
            volume: c.volume,
          }))
        );
      }
    } catch {
      setCandles([]);
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
      const res = await axios.post('/api/trades/manual', {
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
      const res = await axios.post('/api/trades/manual-close', {
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

  const signal = fusedSignals[selectedAsset];
  const tech = technicalSignals[selectedAsset];
  const sent = sentimentSignals[selectedAsset];

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Ticker selector */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[var(--color-border)] pb-4">
        <div>
          <h2 className="text-base font-extrabold text-[var(--color-text-primary)] uppercase tracking-wide">Trading Desk</h2>
          <p className="text-[11px] text-[var(--color-text-secondary)] font-semibold">Stream market assets, AI predictions, and execute paper trades.</p>
        </div>

        <div className="flex flex-wrap gap-1">
          {ASSETS.map((asset) => (
            <button
              key={asset}
              onClick={() => setSelectedAsset(asset)}
              className={`px-3 py-1.5 rounded text-xs font-black transition-all cursor-pointer border ${
                selectedAsset === asset
                  ? 'bg-[var(--color-accent-blue)] border-[var(--color-accent-blue)] text-[var(--color-bg-primary)] shadow-sm'
                  : 'bg-[var(--color-bg-card)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-white hover:bg-[var(--color-bg-card-hover)]'
              }`}
            >
              {asset.replace('USDT', '')}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Main Chart */}
          <div className="glass-panel p-5 relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[#02c0f9]/20 to-transparent pointer-events-none" />
            <div className="flex items-center justify-between mb-4">
              <div>
                <span className="text-base font-extrabold text-[var(--color-text-primary)]">
                  {selectedAsset.replace('USDT', '')}/USDT
                </span>
                <span className="text-xl font-black text-[var(--color-accent-blue)] ml-4 font-mono">
                  {price ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                </span>
              </div>
              {signal && (
                <span className={`px-2.5 py-0.5 rounded text-[9px] font-black border uppercase tracking-wider ${
                  signal.action === 'BUY'
                    ? 'bg-[var(--color-accent-green-dim)] border-[var(--color-accent-green)]/35 text-[var(--color-accent-green)]'
                    : 'bg-[var(--color-accent-red-dim)] border-[var(--color-accent-red)]/35 text-[var(--color-accent-red)]'
                }`}>
                  AI: {signal.action}
                </span>
              )}
            </div>

            {candles.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <AreaChart data={candles} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                  <defs>
                    <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#02c0f9" stopOpacity={0.12} />
                      <stop offset="95%" stopColor="#02c0f9" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="time" stroke="var(--color-text-secondary)" fontSize={9} tickLine={false} />
                  <YAxis stroke="var(--color-text-secondary)" fontSize={9} tickLine={false} domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={{ background: '#12161a', border: '1px solid #2b313a', borderRadius: '6px', color: '#eaecef' }}
                    itemStyle={{ fontSize: '11px', color: '#eaecef' }}
                  />
                  <Area type="monotone" dataKey="price" stroke="#02c0f9" fillOpacity={1} fill="url(#chartGradient)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[320px] flex items-center justify-center text-xs text-[var(--color-text-secondary)] font-semibold uppercase tracking-wider animate-pulse">
                Loading candles...
              </div>
            )}
          </div>

          {/* Quick order entry and open positions */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Quick Order Form */}
            <div className="glass-panel p-5 space-y-4">
              <h3 className="text-xs font-bold text-[var(--color-text-primary)] uppercase tracking-widest flex items-center gap-1.5 border-b border-[var(--color-border)] pb-2">
                <ShoppingBag size={13} className="text-[var(--color-accent-blue)]" />
                Paper Trading Form
              </h3>

              <form onSubmit={handlePlaceOrder} className="space-y-3.5 text-xs">
                <div className="grid grid-cols-2 gap-1.5 p-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded">
                  <button
                    type="button"
                    onClick={() => setOrderAction('BUY')}
                    className={`py-1 rounded font-black text-xs transition-all cursor-pointer ${
                      orderAction === 'BUY' ? 'bg-[var(--color-accent-green)] text-[var(--color-bg-primary)] shadow-sm' : 'text-[var(--color-text-secondary)]'
                    }`}
                  >
                    BUY
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrderAction('SELL')}
                    className={`py-1 rounded font-black text-xs transition-all cursor-pointer ${
                      orderAction === 'SELL' ? 'bg-[var(--color-accent-red)] text-white shadow-sm' : 'text-[var(--color-text-secondary)]'
                    }`}
                  >
                    SELL
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[9px] text-[var(--color-text-secondary)] font-bold uppercase mb-1">Type</label>
                    <select
                      value={orderType}
                      onChange={(e) => setOrderType(e.target.value)}
                      className="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-white font-bold outline-none focus:border-[var(--color-accent-blue)] transition-colors text-xs"
                    >
                      <option>Market</option>
                      <option>Limit</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[9px] text-[var(--color-text-secondary)] font-bold uppercase mb-1">Qty</label>
                    <input
                      type="number"
                      step="0.001"
                      value={orderQuantity}
                      onChange={(e) => setOrderQuantity(parseFloat(e.target.value) || 0)}
                      className="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-white font-mono font-bold outline-none focus:border-[var(--color-accent-blue)] transition-colors"
                    />
                  </div>
                </div>

                {orderType === 'Limit' && (
                  <div>
                    <label className="block text-[9px] text-[var(--color-text-secondary)] font-bold uppercase mb-1">Limit Price</label>
                    <input
                      type="number"
                      step="0.01"
                      value={limitPrice}
                      onChange={(e) => setLimitPrice(e.target.value)}
                      className="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-white font-mono font-bold outline-none focus:border-[var(--color-accent-blue)] transition-colors"
                    />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[9px] text-[var(--color-text-secondary)] font-bold uppercase mb-1">Stop Loss (USD)</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="SL Price"
                      value={stopLoss}
                      onChange={(e) => setStopLoss(e.target.value)}
                      className="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-white font-mono outline-none focus:border-[var(--color-accent-blue)] transition-colors placeholder-[#474f57]"
                    />
                  </div>
                  <div>
                    <label className="block text-[9px] text-[var(--color-text-secondary)] font-bold uppercase mb-1">Take Profit (USD)</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="TP Price"
                      value={takeProfit}
                      onChange={(e) => setTakeProfit(e.target.value)}
                      className="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-white font-mono outline-none focus:border-[var(--color-accent-blue)] transition-colors placeholder-[#474f57]"
                    />
                  </div>
                </div>

                {orderFeedback && (
                  <div className={`p-2.5 rounded text-[10px] font-bold border ${
                    orderFeedback.type === 'success' 
                      ? 'bg-[var(--color-accent-green-dim)] border-[var(--color-accent-green)]/25 text-[var(--color-accent-green)]' 
                      : 'bg-[var(--color-accent-red-dim)] border-[var(--color-accent-red)]/25 text-[var(--color-accent-red)]'
                  }`}>
                    {orderFeedback.message}
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full py-2 bg-[var(--color-accent-blue)] text-[var(--color-bg-primary)] font-black rounded text-xs tracking-wider uppercase hover:opacity-90 transition-opacity cursor-pointer"
                >
                  Submit Order
                </button>
              </form>
            </div>

            {/* Active Position Info */}
            <div className="glass-panel p-5 space-y-4">
              <h3 className="text-xs font-bold text-[var(--color-text-primary)] uppercase tracking-widest flex items-center gap-1.5 border-b border-[var(--color-border)] pb-2">
                <Shield size={13} className="text-purple-400" />
                Active Position Exposure
              </h3>

              {activePosition ? (
                <div className="space-y-3.5 text-xs">
                  <div className="flex justify-between items-center bg-[var(--color-bg-secondary)] p-2.5 rounded border border-[var(--color-border)]">
                    <span className="text-[9px] text-[var(--color-text-secondary)] font-bold uppercase tracking-wider">Asset</span>
                    <span className="font-extrabold text-white">{activePosition.asset?.replace('USDT', '')}</span>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-[var(--color-bg-secondary)] p-2.5 rounded border border-[var(--color-border)]">
                      <span className="block text-[9px] text-[var(--color-text-secondary)] uppercase tracking-wider font-bold mb-0.5">Side</span>
                      <span className={`font-black uppercase text-[10px] ${activePosition.side === 'long' ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]'}`}>
                        {activePosition.side?.toUpperCase()}
                      </span>
                    </div>
                    <div className="bg-[var(--color-bg-secondary)] p-2.5 rounded border border-[var(--color-border)]">
                      <span className="block text-[9px] text-[var(--color-text-secondary)] uppercase tracking-wider font-bold mb-0.5">Entry</span>
                      <span className="font-bold text-white font-mono">${activePosition.entryPrice?.toLocaleString()}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-[var(--color-bg-secondary)] p-2.5 rounded border border-[var(--color-border)]">
                      <span className="block text-[9px] text-[var(--color-text-secondary)] uppercase tracking-wider font-bold mb-0.5">Qty</span>
                      <span className="font-bold text-[var(--color-text-primary)] font-mono">{activePosition.quantity?.toFixed(4)}</span>
                    </div>
                    <div className="bg-[var(--color-bg-secondary)] p-2.5 rounded border border-[var(--color-border)]">
                      <span className="block text-[9px] text-[var(--color-text-secondary)] uppercase tracking-wider font-bold mb-0.5">Unrealized PnL</span>
                      <span className={`font-black font-mono text-sm ${
                        activePosition.unrealizedPnl >= 0 ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]'
                      }`}>
                        {activePosition.unrealizedPnl >= 0 ? '+' : ''}${activePosition.unrealizedPnl?.toFixed(2)}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={handleClosePosition}
                    className="w-full py-2 bg-transparent text-[var(--color-accent-red)] border border-[var(--color-accent-red)]/20 hover:bg-[var(--color-accent-red)]/10 font-bold rounded text-xs uppercase cursor-pointer transition-colors"
                  >
                    Close Position
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center p-8 text-center h-44 text-[var(--color-text-secondary)]">
                  <span className="text-[10px] text-[var(--color-text-secondary)] font-bold uppercase tracking-wider">No Active Position</span>
                  <p className="text-[9px] text-[var(--color-text-secondary)] mt-1.5 max-w-[160px] leading-normal font-semibold">
                    Enter a mock trade manually or wait for the autonomous agents to buy or sell.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: AI Signal & Technical indicators */}
        <div className="space-y-6">
          {/* AI Decision with Progress Bars */}
          <div className="glass-panel p-5">
            <h3 className="text-xs font-bold text-[var(--color-text-primary)] uppercase tracking-wider mb-4 flex items-center gap-2 border-b border-[var(--color-border)] pb-2">
              <TrendingUp size={13} className="text-[var(--color-accent-blue)]" />
              AI Fusion Consensus
            </h3>

            {signal ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--color-text-secondary)] font-bold uppercase tracking-wider text-[9px]">Recommendation</span>
                  <span className={`font-black px-1.5 py-0.5 rounded text-[9px] tracking-wide uppercase border ${
                    signal.action === 'BUY' 
                      ? 'bg-[var(--color-accent-green-dim)] border-[var(--color-accent-green)]/35 text-[var(--color-accent-green)]' 
                      : signal.action === 'SELL' 
                        ? 'bg-[var(--color-accent-red-dim)] border-[var(--color-accent-red)]/35 text-[var(--color-accent-red)]' 
                        : 'bg-[var(--color-bg-secondary)] border-[var(--color-border)] text-[var(--color-text-secondary)]'
                  }`}>{signal.action}</span>
                </div>

                <div className="space-y-3 py-1">
                  <MetricProgress label="Confidence" value={signal.confidence} />
                  <MetricProgress label="Risk Index" value={signal.riskScore} isRisk={true} />
                </div>

                <div className="space-y-1.5 text-xs border-t border-[var(--color-border)] pt-3">
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-secondary)] font-bold uppercase text-[9px] tracking-wider">Stop Loss</span>
                    <span className="font-bold text-[var(--color-accent-red)] font-mono">${signal.stopLoss?.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-secondary)] font-bold uppercase text-[9px] tracking-wider">Take Profit</span>
                    <span className="font-bold text-[var(--color-accent-green)] font-mono">${signal.takeProfit?.toLocaleString()}</span>
                  </div>
                </div>

                {signal.reasoning && (
                  <div className="p-3 rounded-md text-[10px] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] leading-normal font-semibold relative overflow-hidden pl-4">
                    <div className="absolute top-0 left-0 bottom-0 w-0.5 bg-[var(--color-accent-blue)]" />
                    <Info size={11} className="inline mr-1.5 text-[var(--color-accent-blue)] align-[-2px]" />
                    {signal.reasoning}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-[var(--color-text-secondary)] py-6 text-center uppercase tracking-wider font-semibold animate-pulse">
                Pending AI consensus...
              </div>
            )}
          </div>

          {/* Technical indicators */}
          <div className="glass-panel p-5">
            <h3 className="text-xs font-bold text-[var(--color-text-primary)] uppercase tracking-wider mb-4 flex items-center gap-2 border-b border-[var(--color-border)] pb-2">
              <Shield size={13} className="text-purple-400" />
              Technical Signals
            </h3>

            {tech?.indicators ? (
              <div className="space-y-2.5 text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-[var(--color-text-secondary)] font-bold uppercase text-[9px]">RSI (14)</span>
                  <span className={`font-bold font-mono px-1.5 py-0.5 rounded text-[10px] ${
                    tech.indicators.rsi > 70 ? 'bg-[var(--color-accent-red-dim)] text-[var(--color-accent-red)]' :
                      tech.indicators.rsi < 30 ? 'bg-[var(--color-accent-green-dim)] text-[var(--color-accent-green)]' : 'text-[var(--color-text-primary)]'
                  }`}>{tech.indicators.rsi?.toFixed(1)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--color-text-secondary)] font-bold uppercase text-[9px]">MACD Histogram</span>
                  <span className={`font-bold font-mono ${tech.indicators.macd?.histogram > 0 ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]'}`}>
                    {tech.indicators.macd?.histogram > 0 ? '+' : ''}{tech.indicators.macd?.histogram?.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--color-text-secondary)] font-bold uppercase text-[9px]">Regime</span>
                  <span className="font-extrabold text-[var(--color-accent-blue)] uppercase text-[9px] tracking-wide">{tech.indicators.regime}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--color-text-secondary)] font-bold uppercase text-[9px]">Volume Ratio</span>
                  <span className="font-bold text-[var(--color-text-primary)] font-mono">{tech.indicators.volume?.ratio?.toFixed(2)}x</span>
                </div>
              </div>
            ) : (
              <div className="text-xs text-[var(--color-text-secondary)] py-4 text-center uppercase tracking-wider font-semibold animate-pulse">
                Buffering indicators...
              </div>
            )}
          </div>

          {/* Sentiment */}
          <div className="glass-panel p-5">
            <h3 className="text-xs font-bold text-[var(--color-text-primary)] uppercase tracking-wider mb-4 border-b border-[var(--color-border)] pb-2">
              Macro Sentiment
            </h3>

            {sent ? (
              <div className="space-y-2.5 text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-[var(--color-text-secondary)] font-bold uppercase text-[9px]">Label</span>
                  <span className={`font-extrabold uppercase text-[9px] tracking-wide px-1.5 py-0.5 rounded ${
                    sent.label === 'bullish' ? 'bg-[var(--color-accent-green-dim)] text-[var(--color-accent-green)]' :
                      sent.label === 'bearish' ? 'bg-[var(--color-accent-red-dim)] text-[var(--color-accent-red)]' : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]'
                  }`}>{sent.label}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--color-text-secondary)] font-bold uppercase text-[9px]">NLP Score</span>
                  <span className="font-bold text-[var(--color-text-primary)] font-mono">{sent.sentiment?.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--color-text-secondary)] font-bold uppercase text-[9px]">Articles analysed</span>
                  <span className="font-bold text-[var(--color-text-primary)] font-mono">{sent.articleCount}</span>
                </div>
              </div>
            ) : (
              <div className="text-xs text-[var(--color-text-secondary)] py-4 text-center uppercase tracking-wider font-semibold animate-pulse">
                Sentiment offline...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
