import { useState, useEffect } from 'react';
import axios from 'axios';
import { Settings as SettingsIcon, ShieldCheck, DollarSign, Percent, AlertCircle, Zap } from 'lucide-react';
import { usePortfolioStore, useCurrencyStore } from '../store.js';

const CORE_ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT'];
const MEME_ASSETS = ['DOGEUSDT', '1000SHIBUSDT', '1000PEPEUSDT', 'WIFUSDT', '1000FLOKIUSDT', '1000BONKUSDT', 'BOMEUSDT', 'PEOPLEUSDT'];
const RECOMMENDED_ASSETS = ['AVAXUSDT', 'DOTUSDT', 'POLUSDT', 'LTCUSDT', 'PORTALUSDT', 'HEIUSDT', 'IDUSDT', 'LABUSDT', 'STGUSDT', 'EPICUSDT'];

function AssetColumn({ title, assets, disabledAssets, onToggle }) {
  return (
    <div className="bg-[#2c2c2e]/30 border border-[#2c2c2e]/50 rounded-xl p-4 space-y-3">
      <h3 className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest font-mono border-b border-[#2c2c2e]/60 pb-2">
        {title}
      </h3>
      <div className="divide-y divide-[#2c2c2e]/30 max-h-[300px] overflow-y-auto pr-1 space-y-1.5 pt-1">
        {assets.map((asset) => {
          const isDisabled = disabledAssets.includes(asset);
          const cleanName = asset.replace('1000', '').replace('USDT', '');
          return (
            <div key={asset} className="flex items-center justify-between py-1.5 hover:bg-zinc-800/10 transition duration-150 rounded px-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold text-zinc-200">{cleanName}</span>
                <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded font-mono uppercase tracking-wider ${
                  isDisabled 
                    ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' 
                    : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                }`}>
                  {isDisabled ? 'Off' : 'On'}
                </span>
              </div>
              
              <button
                type="button"
                onClick={() => onToggle(asset, isDisabled)}
                className={`relative inline-flex h-4.5 w-8 flex-shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  isDisabled ? 'bg-zinc-700' : 'bg-[#30d158]'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    isDisabled ? 'translate-x-0.5' : 'translate-x-3.5'
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Settings() {
  const [baseTradingCapital, setBaseTradingCapital] = useState(100);
  const [basketProfitTargetPct, setBasketProfitTargetPct] = useState(10);
  const [sweepTargetProfitPct, setSweepTargetProfitPct] = useState(10);
  const [trailingStopUsd, setTrailingStopUsd] = useState('');
  const [coinSwitchApiKey, setCoinSwitchApiKey] = useState('');
  const [coinSwitchApiSecret, setCoinSwitchApiSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const storeRate = useCurrencyStore((s) => s.rate);
  const setStoreRate = useCurrencyStore((s) => s.setRate);
  const [rateInput, setRateInput] = useState(storeRate);

  const portfolio = usePortfolioStore((s) => s.portfolio);
  const manuallyDisabledAssets = portfolio?.manuallyDisabledAssets || [];

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await axios.get('/api/portfolio');
        if (res.data.success && res.data.data) {
          usePortfolioStore.getState().setPortfolio(res.data.data);
          setBaseTradingCapital(res.data.data.baseTradingCapital || 100);
          setBasketProfitTargetPct(res.data.data.basketProfitTargetPct || 10);
          setSweepTargetProfitPct(res.data.data.sweepTargetProfitPct || 10);
          setTrailingStopUsd((res.data.data.trailingStopUsd && res.data.data.trailingStopUsd > 0) ? res.data.data.trailingStopUsd : '');
          setCoinSwitchApiKey(res.data.data.coinSwitchApiKey || '');
          setCoinSwitchApiSecret(res.data.data.coinSwitchApiSecret || '');
          if (res.data.data.usdToInrRate) {
            setRateInput(res.data.data.usdToInrRate);
            setStoreRate(res.data.data.usdToInrRate);
          }
        }
      } catch (err) {
        console.error('Failed to load portfolio settings:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchConfig();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);

    const parsedRate = parseFloat(rateInput || '96.54');
    setStoreRate(parsedRate);

    try {
        const parsedTrailing = parseFloat(trailingStopUsd);
        const res = await axios.post('/api/portfolio/config', {
          baseTradingCapital: parseFloat(baseTradingCapital),
          basketProfitTargetPct: parseFloat(basketProfitTargetPct),
          sweepTargetProfitPct: parseFloat(sweepTargetProfitPct),
          trailingStopUsd: (!isNaN(parsedTrailing) && parsedTrailing > 0) ? parsedTrailing : null,
          usdToInrRate: parsedRate,
          coinSwitchApiKey,
          coinSwitchApiSecret,
        });

        if (res.data.success) {
          setFeedback({ type: 'success', message: 'Settings successfully saved and applied to trading agents.' });
          if (res.data.data) {
            usePortfolioStore.getState().setPortfolio(res.data.data);
            setBaseTradingCapital(res.data.data.baseTradingCapital);
            setBasketProfitTargetPct(res.data.data.basketProfitTargetPct);
            setSweepTargetProfitPct(res.data.data.sweepTargetProfitPct);
            setTrailingStopUsd((res.data.data.trailingStopUsd && res.data.data.trailingStopUsd > 0) ? res.data.data.trailingStopUsd : '');
          setCoinSwitchApiKey(res.data.data.coinSwitchApiKey || '');
          setCoinSwitchApiSecret(res.data.data.coinSwitchApiSecret || '');
        }
      } else {
        setFeedback({ type: 'error', message: res.data.message || 'Failed to update settings.' });
      }
    } catch (err) {
      console.error('Save failed:', err);
      setFeedback({ type: 'error', message: err.response?.data?.message || 'Error occurred while saving configurations.' });
    } finally {
      setSaving(false);
      setTimeout(() => setFeedback(null), 5000);
    }
  };

  const handleToggleAsset = async (asset, isCurrentlyDisabled) => {
    try {
      const res = await axios.post('/api/portfolio/toggle-asset', {
        asset,
        enabled: isCurrentlyDisabled ? true : false
      });
      if (res.data.success) {
        usePortfolioStore.getState().setPortfolio(res.data.data);
      }
    } catch (err) {
      console.error("Failed to toggle asset:", err);
    }
  };

  if (loading) {
    return (
      <div className="flex h-[400px] items-center justify-center">
        <div className="text-zinc-400 font-mono animate-pulse">Loading dashboard configurations...</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-[#2c2c2e]/60 pb-5">
        <SettingsIcon className="w-6 h-6 text-sky-400" />
        <div>
          <h1 className="text-xl font-bold text-[#f5f5f7]">Dashboard Settings</h1>
          <p className="text-xs text-zinc-400">Configure parameters for active trading nodes & capital control</p>
        </div>
      </div>

      {feedback && (
        <div className={`p-4 rounded-xl border flex items-center gap-3 text-sm font-mono ${
          feedback.type === 'success' 
            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' 
            : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
        }`}>
          {feedback.type === 'success' ? <ShieldCheck className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
          <span>{feedback.message}</span>
        </div>
      )}

      {/* Main Settings Form */}
      <form onSubmit={handleSubmit} className="bg-[#1c1c1e] border border-[#2c2c2e]/60 rounded-2xl overflow-hidden p-6 space-y-6 shadow-xl">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Base Capital Option */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center gap-2">
              <DollarSign className="w-3.5 h-3.5 text-zinc-500" />
              Total Base Capital ($)
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Base trading allocation dynamically synchronized with your live CoinSwitch Pro exchange wallet.
            </p>
            <div className="relative">
              <input
                type="number"
                min="10"
                max="1000000"
                step="1"
                required
                value={baseTradingCapital}
                onChange={(e) => setBaseTradingCapital(e.target.value)}
                className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500 font-mono"
                placeholder="e.g. 100"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-zinc-500">USD</span>
            </div>
          </div>

          {/* Sweep Target Profit Percentage */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center gap-2">
              <Percent className="w-3.5 h-3.5 text-zinc-500" />
              Sweep Target Profit (%)
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Trigger threshold for profit sweeping. Squares off all trades and sweeps profit when total net balance (capital + unrealized PnL) reaches this percentage.
            </p>
            <div className="relative">
              <input
                type="number"
                min="1"
                max="100"
                step="0.5"
                required
                value={sweepTargetProfitPct}
                onChange={(e) => setSweepTargetProfitPct(e.target.value)}
                className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500 font-mono"
                placeholder="e.g. 10"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-zinc-500">%</span>
            </div>
          </div>

          {/* Basket Profit Target Percentage */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center gap-2">
              <Percent className="w-3.5 h-3.5 text-zinc-500" />
              Basket Profit Target (%)
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Trigger threshold for combined open trades PnL. Squares off all trades when the net PnL of all open trades alone reaches this percentage of capital.
            </p>
            <div className="relative">
              <input
                type="number"
                min="1"
                max="100"
                step="0.5"
                required
                value={basketProfitTargetPct}
                onChange={(e) => setBasketProfitTargetPct(e.target.value)}
                className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500 font-mono"
                placeholder="e.g. 10"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-zinc-500">%</span>
            </div>
          </div>

          {/* Trailing Stop Loss ($ USDT) */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center gap-2">
              <DollarSign className="w-3.5 h-3.5 text-rose-400" />
              Trailing Stop Loss ($ USDT)
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Risk floor trailing distance in USD (e.g. 1 = $1.00, 2 = $2.00, 0.10 = $0.10). Automatically closes trades if net loss reaches this amount.
            </p>
            <div className="relative">
              <input
                type="number"
                min="0"
                max="100"
                step="0.05"
                value={trailingStopUsd}
                onChange={(e) => setTrailingStopUsd(e.target.value)}
                className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-rose-500 font-mono"
                placeholder="OFF (disabled)"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-zinc-500">USD ($)</span>
            </div>
          </div>
        </div>

        {/* Currency Display Settings */}
        <div className="border-t border-[#2c2c2e]/60 pt-6 space-y-4">
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-sky-400" />
            <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wider font-mono">
              Currency Display Settings
            </h3>
          </div>
          <p className="text-[11px] text-zinc-500 max-w-2xl leading-relaxed">
            Customize the USD to INR conversion exchange rate. This rate is used to display all portfolio values, profits, and margins in Indian Rupees when the INR display toggle is active.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono">
                USD to INR Conversion Rate
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="1"
                  max="1000"
                  step="0.01"
                  required
                  value={rateInput}
                  onChange={(e) => setRateInput(e.target.value)}
                  className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500 font-mono"
                  placeholder="e.g. 96.29"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-zinc-500">₹ / $</span>
              </div>
            </div>
          </div>
        </div>

        {/* CoinSwitch Pro API Credentials */}
        <div className="border-t border-[#2c2c2e]/60 pt-6 space-y-4">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-sky-400 animate-pulse" />
            <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wider font-mono">
              CoinSwitch Pro API Credentials
            </h3>
          </div>
          <p className="text-[11px] text-zinc-500 max-w-2xl leading-relaxed">
            Enter your hex-encoded public API Key and Secret Key generated from your CoinSwitch Pro Profile to connect live exchange trading.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono">
                CoinSwitch API Key
              </label>
              <input
                type="text"
                value={coinSwitchApiKey}
                onChange={(e) => setCoinSwitchApiKey(e.target.value)}
                className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500 font-mono"
                placeholder="Hex-encoded API Key"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono">
                CoinSwitch API Secret
              </label>
              <input
                type="password"
                value={coinSwitchApiSecret}
                onChange={(e) => setCoinSwitchApiSecret(e.target.value)}
                className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500 font-mono"
                placeholder="Hex-encoded Secret Key"
              />
            </div>
          </div>
        </div>

        {/* Action Button */}
        <div className="border-t border-[#2c2c2e]/60 pt-6 flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="bg-sky-500 hover:bg-sky-600 text-white font-mono text-xs font-bold px-6 py-3 rounded-xl transition duration-200 cursor-pointer disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? 'Saving Configurations...' : 'Save and Apply Settings'}
          </button>
        </div>
      </form>

      {/* Coin Switch Activation Console */}
      <div className="bg-[#1c1c1e] border border-[#2c2c2e]/60 rounded-2xl overflow-hidden p-6 space-y-6 shadow-xl">
        <div>
          <h2 className="text-lg font-bold text-[#f5f5f7] flex items-center gap-2">
            <Zap className="w-5 h-5 text-sky-400 animate-pulse" />
            Asset Activation Console (Coin Switch)
          </h2>
          <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
            Directly toggle which assets the trading bot is allowed to trade. Disabling an asset blocks the risk agent from opening any new positions for it.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <AssetColumn 
            title="Core Crypto" 
            assets={CORE_ASSETS} 
            disabledAssets={manuallyDisabledAssets} 
            onToggle={handleToggleAsset} 
          />

          <AssetColumn 
            title="Meme Coins" 
            assets={MEME_ASSETS} 
            disabledAssets={manuallyDisabledAssets} 
            onToggle={handleToggleAsset} 
          />

          <AssetColumn 
            title="Recommended Assets" 
            assets={RECOMMENDED_ASSETS} 
            disabledAssets={manuallyDisabledAssets} 
            onToggle={handleToggleAsset} 
          />
        </div>
      </div>
    </div>
  );
}
