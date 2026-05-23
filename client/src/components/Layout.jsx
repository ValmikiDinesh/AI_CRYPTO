import { NavLink, Outlet } from 'react-router-dom';
import { useMarketStore, useAgentStore } from '../store.js';
import { LayoutDashboard, CandlestickChart, Wallet, Bot, Play, Pause } from 'lucide-react';
import axios from 'axios';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/trading', icon: CandlestickChart, label: 'Trading Desk' },
  { to: '/portfolio', icon: Wallet, label: 'Portfolio' },
  { to: '/agents', icon: Bot, label: 'AI Agents' },
];

export default function Layout() {
  const connected = useMarketStore((s) => s.connected);
  const emergencyStop = useAgentStore((s) => s.emergencyStop);

  const toggleTradingState = async () => {
    if (emergencyStop) {
      try {
        await axios.post('/api/agents/resume');
      } catch (err) {
        console.error('Failed to resume trading:', err);
      }
    } else {
      if (confirm('⚠️ Pause all autonomous trading agents? Active positions will remain monitored but no new trades will execute.')) {
        try {
          await axios.post('/api/agents/emergency-stop', { reason: 'Manual pause from controller' });
        } catch (err) {
          console.error('Failed to pause trading:', err);
        }
      }
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#0b0e11] text-[#eaecef]">
      {/* Sidebar Navigation */}
      <aside className="w-56 flex-shrink-0 flex flex-col bg-[#12161a] border-r border-[#2b313a]">
        {/* Brand Header */}
        <div className="h-14 flex items-center gap-2 px-5 border-b border-[#2b313a]">
          <span className="text-sm font-black text-white tracking-wide uppercase">
            🤖 Crypto<span className="text-[#02c0f9]">AI</span>
          </span>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#02c0f9]/10 border border-[#02c0f9]/20 text-[#02c0f9] font-bold uppercase">
            Paper
          </span>
        </div>

        {/* Navigation list */}
        <nav className="flex-1 py-4 px-3 flex flex-col gap-1 overflow-y-auto">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-xs font-bold transition-all ${
                  isActive ? 'nav-active' : 'text-[#848e9c] nav-inactive'
                }`
              }
            >
              <Icon size={14} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Deployment Info Card */}
        <div className="m-3 p-3 rounded-md bg-[#181a20] border border-[#2b313a] text-[10px] text-[#848e9c] leading-relaxed">
          <span className="block font-bold text-[#eaecef] uppercase tracking-wider text-[9px] mb-1">System Deploy</span>
          <p>
            AI agents run automatically on startup and execute paper orders on the Binance Testnet.
          </p>
        </div>

        {/* Server status indicator */}
        <div className="px-5 py-3 border-t border-[#2b313a] bg-[#0b0e11]">
          <div className="flex items-center gap-2 text-[10px] uppercase font-bold tracking-wider">
            {connected ? (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-[#0ecb81]" />
                <span className="text-[#0ecb81]">Server Connected</span>
              </>
            ) : (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-[#f6465d] animate-pulse" />
                <span className="text-[#f6465d]">Server Offline</span>
              </>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content Viewport */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="h-14 flex items-center justify-between px-6 flex-shrink-0 bg-[#12161a] border-b border-[#2b313a]">
          <div>
            <h1 className="text-xs font-bold text-[#eaecef] uppercase tracking-wider">
              Autonomous Trading Console
            </h1>
            <p className="text-[9px] text-[#848e9c] font-bold uppercase mt-0.5">
              10-Agent Paper Trading Cluster
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Status light */}
            <div className={`flex items-center gap-2 px-2.5 py-1 rounded border text-[10px] font-bold ${
              emergencyStop 
                ? 'bg-[#f6465d]/10 border-[#f6465d]/20 text-[#f6465d]' 
                : 'bg-[#0ecb81]/10 border-[#0ecb81]/20 text-[#0ecb81]'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full ${emergencyStop ? 'bg-[#f6465d]' : 'bg-[#0ecb81]'}`} />
              <span className="uppercase tracking-wider">
                {emergencyStop ? 'Trading: Paused' : 'Trading: Active'}
              </span>
            </div>

            {/* Toggle Action button */}
            <button
              onClick={toggleTradingState}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] font-bold transition-all cursor-pointer border shadow-sm ${
                emergencyStop
                  ? 'bg-[#02c0f9] hover:bg-[#00aeef] text-[#0b0e11] border-[#02c0f9]'
                  : 'bg-transparent text-[#f6465d] border-[#f6465d]/20 hover:bg-[#f6465d]/10'
              }`}
            >
              {emergencyStop ? (
                <>
                  <Play size={10} className="fill-current" />
                  <span>Start Auto-Trading</span>
                </>
              ) : (
                <>
                  <Pause size={10} className="fill-current" />
                  <span>Pause Auto-Trading</span>
                </>
              )}
            </button>
          </div>
        </header>

        {/* Dynamic Outlet */}
        <main className="flex-1 overflow-auto p-6 bg-[#0b0e11]" style={{ scrollBehavior: 'smooth' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
