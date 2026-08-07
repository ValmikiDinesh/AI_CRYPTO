import { useState, useEffect } from 'react';
import axios from 'axios';
import { Settings as SettingsIcon, ShieldCheck, DollarSign, Percent, AlertCircle, Zap, Target, Activity } from 'lucide-react';
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
  const [maxDailyLossPct, setMaxDailyLossPct] = useState(20);
  const [maxDailyTrades, setMaxDailyTrades] = useState(1000);
  const [defaultLeverage, setDefaultLeverage] = useState(1);
  const [basketProfitTargetPct, setBasketProfitTargetPct] = useState(10);
  const [sweepTargetProfitPct, setSweepTargetProfitPct] = useState('');
  const [entryOrderType, setEntryOrderType] = useState('market');
  const [exitOrderType, setExitOrderType] = useState('market');
  const [enableDynamicScalp, setEnableDynamicScalp] = useState(false);
  const [fixedScalpTargetUsd, setFixedScalpTargetUsd] = useState('');
  const [enableTrailingStop, setEnableTrailingStop] = useState(true);
  const [enableTrailingFloor, setEnableTrailingFloor] = useState(true);
  const [minMarginFloor, setMinMarginFloor] = useState('5.0');
  const [trailingStopUsd, setTrailingStopUsd] = useState('');
  const [trailingStopMinFloorUsd, setTrailingStopMinFloorUsd] = useState('');
  const [coinSwitchApiKey, setCoinSwitchApiKey] = useState('');
  const [coinSwitchApiSecret, setCoinSwitchApiSecret] = useState('');
  
  // Telegram Integration State
  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  
  // AI Config State
  const [enableAILlmPredictions, setEnableAILlmPredictions] = useState(false);
  const [aiLlmSequence, setAiLlmSequence] = useState(['gemini', 'groq', 'openai']);
  const [geminiKeys, setGeminiKeys] = useState('');
  const [groqKeys, setGroqKeys] = useState('');
  const [openaiKeys, setOpenaiKeys] = useState('');

  // Strategy Engine State
  const [activeStrategy, setActiveStrategy] = useState('trend_sniper');
  const [strategySettings, setStrategySettings] = useState({
    trend_sniper: { confidenceThreshold: '', stopLossAtr: '', takeProfitAtr: '' },
    hft_scalping: { confidenceThreshold: '', stopLossAtr: '', takeProfitAtr: '' }
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  
  // Dirty state tracking
  const [initialConfig, setInitialConfig] = useState(null);
  const [isDirty, setIsDirty] = useState(false);

  const storeRate = useCurrencyStore((s) => s.rate);
  const setStoreRate = useCurrencyStore((s) => s.setRate);
  const [rateInput, setRateInput] = useState('96.54');

  const getCurrentStateSnapshot = () => JSON.stringify({
    baseTradingCapital, maxDailyLossPct, maxDailyTrades, basketProfitTargetPct,
    sweepTargetProfitPct, entryOrderType, exitOrderType, enableDynamicScalp, fixedScalpTargetUsd, enableTrailingStop, enableTrailingFloor,
    minMarginFloor, trailingStopUsd, trailingStopMinFloorUsd, coinSwitchApiKey,
    coinSwitchApiSecret, telegramBotToken, telegramChatId, enableAILlmPredictions, aiLlmSequence, geminiKeys,
    groqKeys, openaiKeys, activeStrategy, strategySettings, rateInput
  });

  useEffect(() => {
    if (initialConfig && initialConfig !== getCurrentStateSnapshot()) {
      setIsDirty(true);
    } else {
      setIsDirty(false);
    }
  }, [baseTradingCapital, maxDailyLossPct, maxDailyTrades, defaultLeverage, basketProfitTargetPct, sweepTargetProfitPct, entryOrderType, exitOrderType, enableDynamicScalp, fixedScalpTargetUsd, enableTrailingStop, enableTrailingFloor, minMarginFloor, trailingStopUsd, trailingStopMinFloorUsd, coinSwitchApiKey, coinSwitchApiSecret, telegramBotToken, telegramChatId, enableAILlmPredictions, aiLlmSequence, geminiKeys, groqKeys, openaiKeys, activeStrategy, strategySettings, rateInput]);

  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const portfolio = usePortfolioStore((s) => s.portfolio);
  const manuallyDisabledAssets = portfolio?.manuallyDisabledAssets || [];

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await axios.get('/api/portfolio');
        if (res.data.success && res.data.data) {
          const portfolio = res.data.data;
          usePortfolioStore.getState().setPortfolio(portfolio);
          setBaseTradingCapital(portfolio.baseTradingCapital || 100);
          setMaxDailyLossPct(portfolio.maxDailyLossPct || 20);
          setMaxDailyTrades(portfolio.maxDailyTrades !== undefined ? portfolio.maxDailyTrades : 1000);
          setDefaultLeverage(portfolio.defaultLeverage || 1);
          setBasketProfitTargetPct(portfolio.basketProfitTargetPct || 10);
          setSweepTargetProfitPct(portfolio.sweepTargetProfitPct || 10);
          setMinMarginFloor(portfolio.minMarginFloor !== undefined ? portfolio.minMarginFloor : 5.0);
          setTrailingStopUsd((portfolio.trailingStopUsd && portfolio.trailingStopUsd > 0) ? portfolio.trailingStopUsd : '');
          setTrailingStopMinFloorUsd(portfolio.trailingStopMinFloorUsd || '0.10');
          setEntryOrderType(portfolio.entryOrderType || 'market');
          setExitOrderType(portfolio.exitOrderType || 'market');
          setEnableDynamicScalp(portfolio.enableDynamicScalp || false);
          setFixedScalpTargetUsd(portfolio.fixedScalpTargetUsd || '');
          setEnableTrailingStop(portfolio.enableTrailingStop !== undefined ? portfolio.enableTrailingStop : true);
          setEnableTrailingFloor(portfolio.enableTrailingFloor !== undefined ? portfolio.enableTrailingFloor : true);
          setCoinSwitchApiKey(portfolio.coinSwitchApiKey || '');
          setCoinSwitchApiSecret(portfolio.coinSwitchApiSecret || '');
          setTelegramBotToken(portfolio.telegramBotToken || '');
          setTelegramChatId(portfolio.telegramChatId || '');
          
          setEnableAILlmPredictions(portfolio.enableAILlmPredictions || false);
          if (portfolio.aiLlmSequence) setAiLlmSequence(portfolio.aiLlmSequence);
          if (portfolio.aiApiKeys) {
            setGeminiKeys((portfolio.aiApiKeys.gemini || []).join(','));
            setGroqKeys((portfolio.aiApiKeys.groq || []).join(','));
            setOpenaiKeys((portfolio.aiApiKeys.openai || []).join(','));
          }

          if (portfolio.activeStrategy) setActiveStrategy(portfolio.activeStrategy);
          if (portfolio.strategySettings) {
            setStrategySettings({
              trend_sniper: {
                confidenceThreshold: portfolio.strategySettings.trend_sniper?.confidenceThreshold ?? '',
                stopLossAtr: portfolio.strategySettings.trend_sniper?.stopLossAtr ?? '',
                takeProfitAtr: portfolio.strategySettings.trend_sniper?.takeProfitAtr ?? ''
              },
              hft_scalping: {
                confidenceThreshold: portfolio.strategySettings.hft_scalping?.confidenceThreshold ?? '',
                stopLossAtr: portfolio.strategySettings.hft_scalping?.stopLossAtr ?? '',
                takeProfitAtr: portfolio.strategySettings.hft_scalping?.takeProfitAtr ?? ''
              }
            });
          }

          if (portfolio.usdToInrRate) {
            setRateInput(portfolio.usdToInrRate);
            setStoreRate(portfolio.usdToInrRate);
          }
        }
      } catch (err) {
        console.error('Failed to load portfolio settings:', err);
      } finally {
        setLoading(false);
        setTimeout(() => {
          setInitialConfig(getCurrentStateSnapshot());
        }, 100);
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
          baseTradingCapital: Number(baseTradingCapital),
          maxDailyLossPct: Number(maxDailyLossPct),
          maxDailyTrades: Number(maxDailyTrades),
          defaultLeverage: Number(defaultLeverage),
          basketProfitTargetPct: Number(basketProfitTargetPct),
          sweepTargetProfitPct: Number(sweepTargetProfitPct),
          entryOrderType,
          exitOrderType,
          enableDynamicScalp,
          fixedScalpTargetUsd: fixedScalpTargetUsd === '' ? 0 : parseFloat(fixedScalpTargetUsd),
          enableTrailingStop,
          enableTrailingFloor,
          minMarginFloor: parseFloat(minMarginFloor) || 5.0,
          trailingStopUsd: (!isNaN(parsedTrailing) && parsedTrailing > 0) ? parsedTrailing : null,
          trailingStopMinFloorUsd: parseFloat(trailingStopMinFloorUsd),
          usdToInrRate: parsedRate,
          coinSwitchApiKey,
          coinSwitchApiSecret,
          telegramBotToken,
          telegramChatId,
          enableAILlmPredictions,
          aiLlmSequence,
          aiApiKeys: {
            gemini: geminiKeys.split(',').map(k => k.trim()).filter(Boolean),
            groq: groqKeys.split(',').map(k => k.trim()).filter(Boolean),
            openai: openaiKeys.split(',').map(k => k.trim()).filter(Boolean),
          },
          activeStrategy,
          strategySettings
        });

        if (res.data.success) {
          setFeedback({ type: 'success', message: 'Settings successfully saved and applied to trading agents.' });
          if (res.data.data) {
            usePortfolioStore.getState().setPortfolio(res.data.data);
            setBaseTradingCapital(res.data.data.baseTradingCapital);
            setDefaultLeverage(res.data.data.defaultLeverage || 1);
            setBasketProfitTargetPct(res.data.data.basketProfitTargetPct);
            setSweepTargetProfitPct(res.data.data.sweepTargetProfitPct);
            setEntryOrderType(res.data.data.entryOrderType || 'market');
            setExitOrderType(res.data.data.exitOrderType || 'market');
            setEnableDynamicScalp(res.data.data.enableDynamicScalp || false);
            setFixedScalpTargetUsd(res.data.data.fixedScalpTargetUsd || '');
            setEnableTrailingStop(res.data.data.enableTrailingStop !== undefined ? res.data.data.enableTrailingStop : true);
            setEnableTrailingFloor(res.data.data.enableTrailingFloor !== undefined ? res.data.data.enableTrailingFloor : true);
            setMinMarginFloor(res.data.data.minMarginFloor !== undefined ? res.data.data.minMarginFloor : 5.0);
            setTrailingStopUsd((res.data.data.trailingStopUsd && res.data.data.trailingStopUsd > 0) ? res.data.data.trailingStopUsd : '');
            setTrailingStopMinFloorUsd(res.data.data.trailingStopMinFloorUsd || '0.10');
            setCoinSwitchApiKey(res.data.data.coinSwitchApiKey || '');
            setCoinSwitchApiSecret(res.data.data.coinSwitchApiSecret || '');
            
            setEnableAILlmPredictions(res.data.data.enableAILlmPredictions || false);
            if (res.data.data.aiLlmSequence) setAiLlmSequence(res.data.data.aiLlmSequence);
            if (res.data.data.aiApiKeys) {
              setGeminiKeys((res.data.data.aiApiKeys.gemini || []).join(','));
              setGroqKeys((res.data.data.aiApiKeys.groq || []).join(','));
              setOpenaiKeys((res.data.data.aiApiKeys.openai || []).join(','));
            }
            if (res.data.data.activeStrategy) setActiveStrategy(res.data.data.activeStrategy);
            if (res.data.data.strategySettings) {
              setStrategySettings({
                trend_sniper: {
                  confidenceThreshold: res.data.data.strategySettings.trend_sniper?.confidenceThreshold ?? '',
                  stopLossAtr: res.data.data.strategySettings.trend_sniper?.stopLossAtr ?? '',
                  takeProfitAtr: res.data.data.strategySettings.trend_sniper?.takeProfitAtr ?? ''
                },
                hft_scalping: {
                  confidenceThreshold: res.data.data.strategySettings.hft_scalping?.confidenceThreshold ?? '',
                  stopLossAtr: res.data.data.strategySettings.hft_scalping?.stopLossAtr ?? '',
                  takeProfitAtr: res.data.data.strategySettings.hft_scalping?.takeProfitAtr ?? ''
                }
              });
            }
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
      setInitialConfig(getCurrentStateSnapshot());
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
        {/* Order Type Controls */}
        <div className="flex flex-wrap items-center gap-4 bg-[#2c2c2e]/30 p-3 rounded-xl border border-[#2c2c2e]/60 mb-6">
          {/* Entry Order Type */}
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#86868b] uppercase tracking-widest font-bold font-mono">Entry Order:</span>
            <div className="flex bg-black p-0.5 rounded-lg border border-[#2c2c2e]/60 text-[9px] font-bold font-mono">
              <button
                type="button"
                onClick={() => setEntryOrderType('market')}
                className={`px-2.5 py-1 rounded cursor-pointer transition-all ${entryOrderType === 'market' ? 'bg-[#0071e3] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                MARKET
              </button>
              <button
                type="button"
                onClick={() => setEntryOrderType('limit')}
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
                type="button"
                onClick={() => setExitOrderType('market')}
                className={`px-2.5 py-1 rounded cursor-pointer transition-all ${exitOrderType === 'market' ? 'bg-[#30d158] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                MARKET
              </button>
              <button
                type="button"
                onClick={() => setExitOrderType('limit')}
                className={`px-2.5 py-1 rounded cursor-pointer transition-all ${exitOrderType === 'limit' ? 'bg-[#30d158] text-white shadow' : 'text-[#86868b] hover:text-white'}`}
              >
                LIMIT
              </button>
            </div>
          </div>

          <div className="h-4 w-[1px] bg-[#2c2c2e]/80" />

          {/* Net Scalp Target ($ USDT) */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Target className="w-3.5 h-3.5 text-[#bf5af2]" />
                Dynamic HFT Scalping
              </span>
              <button
                type="button"
                onClick={() => setEnableDynamicScalp(!enableDynamicScalp)}
                className={`w-10 h-5 rounded-full transition-colors relative focus:outline-none ${enableDynamicScalp ? 'bg-[#bf5af2]' : 'bg-[#3a3a3c]'}`}
              >
                <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-0.5 transition-transform ${enableDynamicScalp ? 'left-6' : 'left-1'}`} />
              </button>
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              If enabled, HFT Scalping trades will instantly auto-close exactly at 1.0x ATR pure profit. Trend Sniper trades are completely ignored.
            </p>
            {enableDynamicScalp && (
              <div className="bg-[#1c1c1e] p-4 rounded-xl border border-white/5 space-y-2 mt-4 transition-all duration-300">
                <label className="text-xs font-semibold text-white/50 tracking-wider">FIXED SCALP TARGET ($ USDT)</label>
                <div className="flex items-center">
                  <span className="text-white/40 mr-2">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="e.g. 0.10"
                    value={fixedScalpTargetUsd}
                    onChange={(e) => setFixedScalpTargetUsd(e.target.value)}
                    className="w-full bg-transparent text-sm text-white font-medium border-b border-white/10 pb-1 focus:border-[#bf5af2] focus:outline-none transition-colors"
                  />
                </div>
                <p className="text-[10px] text-white/40 leading-relaxed mt-1">
                  Optional: If set > 0, the bot will override the Dynamic ATR target and force-close the trade exactly when this net USD profit is reached.
                </p>
              </div>
            )}
          </div>

          <div className="h-4 w-[1px] bg-[#2c2c2e]/80" />

          {/* Autonomous Trailing Stop Master Switch */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center justify-between">
              <span className="flex items-center gap-2">
                <ShieldCheck className="w-3.5 h-3.5 text-[#30d158]" />
                Autonomous Trailing Stop
              </span>
              <button
                type="button"
                onClick={() => setEnableTrailingStop(!enableTrailingStop)}
                className={`w-10 h-5 rounded-full transition-colors relative focus:outline-none ${enableTrailingStop ? 'bg-[#30d158]' : 'bg-[#3a3a3c]'}`}
              >
                <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-0.5 transition-transform ${enableTrailingStop ? 'left-6' : 'left-1'}`} />
              </button>
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Dynamically trails peak profit using ATR. The trailing cushion is mathematically sized for each asset's volatility.
            </p>
          </div>

          <div className="h-4 w-[1px] bg-[#2c2c2e]/80" />

          {/* Wake Up Floor Master Switch */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Target className="w-3.5 h-3.5 text-[#ff9f0a]" />
                Minimum Wake-Up Floor
              </span>
              <button
                type="button"
                onClick={() => setEnableTrailingFloor(!enableTrailingFloor)}
                className={`w-10 h-5 rounded-full transition-colors relative focus:outline-none ${enableTrailingFloor ? 'bg-[#ff9f0a]' : 'bg-[#3a3a3c]'}`}
              >
                <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-0.5 transition-transform ${enableTrailingFloor ? 'left-6' : 'left-1'}`} />
              </button>
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              If enabled, trailing stop remains inactive until reaching 1.0x ATR profit. If disabled, it activates on the very first cent of profit!
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Base Capital Option */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center gap-2">
              <DollarSign className="w-3.5 h-3.5 text-zinc-500" />
              Target Anchor (Base Capital)
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Target Anchor (Base Capital) — The frozen baseline used to calculate automated Sweep and Basket square-off targets. Does not track live PnL.
            </p>
            <div className="relative">
              <input
                type="number"
                min="10"
                max="1000000"
                step="any"
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
          
          {/* Advanced AI Gateway Configuration */}
          <div className="col-span-full space-y-4 border border-[#2c2c2e]/60 p-5 rounded-2xl bg-black/40 mt-6">
            <div className="flex items-center justify-between border-b border-[#2c2c2e]/60 pb-3">
              <div>
                <h3 className="text-sm font-bold text-sky-400 uppercase tracking-wider font-mono flex items-center gap-2">
                  <Zap className="w-4 h-4" />
                  Advanced AI Gateway Configuration
                </h3>
                <p className="text-[11px] text-zinc-500 mt-1">
                  When enabled, the system queries advanced LLMs for deep analysis. When disabled, it uses the high-speed Local Math Model (Primary Default).
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEnableAILlmPredictions(!enableAILlmPredictions)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  enableAILlmPredictions ? 'bg-[#30d158]' : 'bg-zinc-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    enableAILlmPredictions ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {enableAILlmPredictions && (
              <div className="space-y-5 pt-2 animate-in fade-in zoom-in-95 duration-200">
                {/* Sequence Config */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono">LLM Fallback Sequence (Top to Bottom)</label>
                  <p className="text-[11px] text-zinc-500">The AI Service will query Rank 1 first. If it fails, it instantly falls back to Rank 2, then Rank 3.</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {[0, 1, 2].map(index => (
                      <div key={`rank-${index}`} className="flex flex-col gap-1">
                        <span className="text-[10px] text-sky-400 font-mono">Rank {index + 1}</span>
                        <select
                          value={aiLlmSequence[index] || ''}
                          onChange={(e) => {
                            const newSeq = [...aiLlmSequence];
                            newSeq[index] = e.target.value;
                            setAiLlmSequence(newSeq);
                          }}
                          className="bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-500 font-mono appearance-none"
                        >
                          <option value="gemini">Gemini (Google)</option>
                          <option value="groq">Groq (Llama-3.3)</option>
                          <option value="openai">OpenAI (GPT-4o)</option>
                        </select>
                      </div>
                    ))}
                  </div>
                </div>

                {/* API Keys */}
                <div className="space-y-4 pt-3 border-t border-[#2c2c2e]/60">
                  <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono">LLM API Keys (Load Balancing)</label>
                  <p className="text-[11px] text-zinc-500 -mt-1">Add multiple keys separated by commas. The system will actively rotate through them to bypass rate limits.</p>
                  
                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-1">
                      <span className="text-[10px] text-zinc-300 font-mono">Gemini API Keys (Comma-separated)</span>
                      <input
                        type="text"
                        value={geminiKeys}
                        onChange={(e) => setGeminiKeys(e.target.value)}
                        className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
                        placeholder="AIzaSy..., AIzaSy..."
                      />
                    </div>
                    <div className="space-y-1">
                      <span className="text-[10px] text-zinc-300 font-mono">Groq API Keys (Comma-separated)</span>
                      <input
                        type="text"
                        value={groqKeys}
                        onChange={(e) => setGroqKeys(e.target.value)}
                        className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
                        placeholder="gsk_..., gsk_..."
                      />
                    </div>
                    <div className="space-y-1">
                      <span className="text-[10px] text-zinc-300 font-mono">OpenAI API Keys (Comma-separated)</span>
                      <input
                        type="text"
                        value={openaiKeys}
                        onChange={(e) => setOpenaiKeys(e.target.value)}
                        className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
                        placeholder="sk-proj..., sk-proj..."
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Trading Strategy Engine */}
          <div className="md:col-span-3 bg-[#2c2c2e]/20 border border-[#2c2c2e]/50 p-6 rounded-2xl mb-2">
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-sm font-bold text-white font-mono flex items-center gap-2">
                  <Zap className="w-4 h-4 text-purple-400" />
                  Trading Strategy Engine
                </h3>
                <p className="text-xs text-zinc-400 mt-1">Select the active mathematical behavior model for the AI.</p>
              </div>
              
              <div className="space-y-4">
                <div className="space-y-1">
                  <span className="text-[10px] text-zinc-300 font-mono uppercase">Active Strategy</span>
                  <select
                    value={activeStrategy}
                    onChange={(e) => setActiveStrategy(e.target.value)}
                    className="w-full bg-[#1c1c1e] border border-[#3a3a3c] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500 font-mono appearance-none"
                  >
                    <option value="trend_sniper">🎯 Trend Sniper (High Accuracy, Low Frequency, Ranging Avoidance)</option>
                    <option value="hft_scalping">⚡ HFT Scalping (High Frequency, Mean Reversion, Fee Protected)</option>
                  </select>
                </div>
                
                <div className="flex flex-col gap-4 pt-2 border-t border-[#3a3a3c]/50">
                  <div className="space-y-1">
                    <span className="text-[10px] text-zinc-300 font-mono uppercase">Confidence Threshold</span>
                    <input
                      type="number"
                      step="0.01"
                      value={strategySettings[activeStrategy]?.confidenceThreshold || ''}
                      onChange={(e) => {
                        setStrategySettings({
                          ...strategySettings,
                          [activeStrategy]: { ...strategySettings[activeStrategy], confidenceThreshold: e.target.value }
                        });
                      }}
                      className="w-full bg-[#1c1c1e] border border-[#3a3a3c] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500 font-mono"
                      placeholder={activeStrategy === 'trend_sniper' ? 'e.g. 0.75' : 'e.g. 0.60'}
                    />
                    <p className="text-[9px] text-zinc-500 font-mono mt-1">
                      💡 Suggestion: {activeStrategy === 'trend_sniper' ? '0.75 - 0.85 (High strictness)' : '0.60 - 0.65 (High volume)'}
                    </p>
                    <p className="text-[10px] text-zinc-400 font-mono mt-2 bg-black/20 p-2 rounded border border-zinc-800">
                      🤖 <b>Risk Copilot Active:</b> The AI is dynamically calculating optimal Stop-Loss and Take-Profit ATR multipliers independently for every single asset in real-time based on live market volatility.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Max Daily Loss Percentage */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center gap-2">
              <ShieldCheck className="w-3.5 h-3.5 text-zinc-500" />
              Max Daily Loss Limit (%)
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Hard system shutdown threshold. If daily floating losses reach this percentage of your starting capital, the system immediately closes all trades to protect your account.
            </p>
            <div className="relative">
              <input
                type="number"
                min="1"
                max="100"
                step="0.5"
                required
                value={maxDailyLossPct}
                onChange={(e) => setMaxDailyLossPct(e.target.value)}
                className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500 font-mono"
                placeholder="e.g. 20"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-zinc-500">%</span>
            </div>
          </div>

          {/* Default Leverage */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center gap-2">
              <Zap className="w-3.5 h-3.5 text-zinc-500" />
              Default Leverage
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Global leverage multiplier applied to all executed trades.
            </p>
            <div className="relative">
              <input
                type="number"
                min="1"
                max="125"
                step="1"
                required
                value={defaultLeverage}
                onChange={(e) => setDefaultLeverage(e.target.value)}
                className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500 font-mono"
                placeholder="e.g. 5"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-zinc-500">x</span>
            </div>
          </div>

          {/* Max Daily Trades Limit */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center gap-2">
              <ShieldCheck className="w-3.5 h-3.5 text-zinc-500" />
              Max Daily Trades Limit
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Circuit breaker to prevent overtrading. If the bot executes this many trades in a single day (IST), all further trading signals will be permanently rejected until midnight.
            </p>
            <div className="relative">
              <input
                type="number"
                min="1"
                max="10000"
                step="1"
                required
                value={maxDailyTrades}
                onChange={(e) => setMaxDailyTrades(e.target.value)}
                className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500 font-mono"
                placeholder="e.g. 1000"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-zinc-500">trades</span>
            </div>
          </div>

          {/* Minimum Margin Floor ($) */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono flex items-center gap-2">
              <DollarSign className="w-3.5 h-3.5 text-zinc-500" />
              Minimum Margin Floor ($)
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              The absolute minimum order margin (in USDT) allowed per trade. If the AI requests a smaller size, it will be inflated to this amount to meet exchange minimums.
            </p>
            <div className="relative">
              <input
                type="number"
                min="0.1"
                max="1000"
                step="any"
                required
                value={minMarginFloor}
                onChange={(e) => setMinMarginFloor(e.target.value)}
                className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500 font-mono"
                placeholder="e.g. 5.0"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-zinc-500">USDT</span>
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
                  step="any"
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

        {/* Telegram Notifications */}
        <div className="border-t border-[#2c2c2e]/60 pt-6 space-y-4">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-sky-400" />
            <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wider font-mono">
              Telegram Notification Hub
            </h3>
          </div>
          <p className="text-[11px] text-zinc-500 max-w-2xl leading-relaxed">
            Receive live, instant alerts when the AI opens positions, sweeps profits, or executes emergency stops directly to your Telegram chat.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono">
                Telegram Bot Token
              </label>
              <input
                type="password"
                value={telegramBotToken}
                onChange={(e) => setTelegramBotToken(e.target.value)}
                className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500 font-mono"
                placeholder="e.g. 1234567890:AAH..."
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono">
                Telegram Chat ID
              </label>
              <input
                type="text"
                value={telegramChatId}
                onChange={(e) => setTelegramChatId(e.target.value)}
                className="w-full bg-[#2c2c2e]/50 border border-[#3a3a3c] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500 font-mono"
                placeholder="e.g. 987654321"
              />
            </div>
          </div>
        </div>

        {/* Action Button */}
        <div className="border-t border-[#2c2c2e]/60 pt-6 flex justify-end items-center gap-4">
          {isDirty && (
            <div className="flex items-center gap-2 text-rose-500 bg-rose-500/10 px-3 py-2 rounded-xl border border-rose-500/20 animate-pulse">
              <AlertCircle size={14} />
              <span className="text-[10px] font-black tracking-widest uppercase font-mono">Unsaved Changes</span>
            </div>
          )}
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
