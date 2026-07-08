import { useState, useEffect } from 'react';
import axios from 'axios';
import { Settings as SettingsIcon, ShieldCheck, DollarSign, Percent, AlertCircle } from 'lucide-react';

export default function Settings() {
  const [baseTradingCapital, setBaseTradingCapital] = useState(100);
  const [basketProfitTargetPct, setBasketProfitTargetPct] = useState(10);
  const [sweepTargetProfitPct, setSweepTargetProfitPct] = useState(10);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await axios.get('/api/portfolio/performance');
        if (res.data.success && res.data.data) {
          setBaseTradingCapital(res.data.data.baseTradingCapital || 100);
          setBasketProfitTargetPct(res.data.data.basketProfitTargetPct || 10);
          setSweepTargetProfitPct(res.data.data.sweepTargetProfitPct || 10);
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

    try {
      const res = await axios.post('/api/portfolio/config', {
        baseTradingCapital: parseFloat(baseTradingCapital),
        basketProfitTargetPct: parseFloat(basketProfitTargetPct),
        sweepTargetProfitPct: parseFloat(sweepTargetProfitPct),
      });

      if (res.data.success) {
        setFeedback({ type: 'success', message: 'Settings successfully saved and applied to trading agents.' });
        if (res.data.data) {
          setBaseTradingCapital(res.data.data.baseTradingCapital);
          setBasketProfitTargetPct(res.data.data.basketProfitTargetPct);
          setSweepTargetProfitPct(res.data.data.sweepTargetProfitPct);
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
              Base trading allocation for demo paper-trading. (For live mode, this is dynamically fetched from the exchange wallet).
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
    </div>
  );
}
