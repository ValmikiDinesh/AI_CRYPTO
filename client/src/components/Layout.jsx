import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useMarketStore, useAgentStore } from '../store.js';
import { LayoutDashboard, CandlestickChart, Wallet, Bot, Play, Pause, Activity, ShieldAlert, Cpu, Menu, X } from 'lucide-react';
import axios from 'axios';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Overview' },
  { to: '/trading', icon: CandlestickChart, label: 'Trading Desk' },
  { to: '/portfolio', icon: Wallet, label: 'Portfolio' },
  { to: '/agents', icon: Bot, label: 'AI Agent Nodes' },
];

export default function Layout() {
  const connected = useMarketStore((s) => s.connected);
  const emergencyStop = useAgentStore((s) => s.emergencyStop);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
    <div className="app-container">
      {/* Mobile Sidebar Backdrop overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden cursor-pointer"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar Navigation */}
      <aside className={`sidebar-container ${sidebarOpen ? 'open' : ''}`}>
        {/* Brand Header */}
        <div className="h-16 flex items-center justify-between px-6 border-b border-[#2c2c2e]/60">
          <div className="flex items-center gap-2">
            <span className="text-xs font-black tracking-widest text-[#f5f5f7] uppercase font-mono">
              CRYPTO // <span className="text-sky-400">AI</span>
            </span>
          </div>
          
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden text-zinc-400 hover:text-white cursor-pointer p-1"
          >
            <X size={14} />
          </button>
          
          <span className="hidden lg:inline-block text-[8px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 font-extrabold uppercase tracking-widest font-mono scale-90">
            PAPER
          </span>
        </div>

        {/* Navigation list */}
        <nav className="flex-1 py-6 px-4 flex flex-col gap-1 overflow-y-auto">
          <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest px-3.5 mb-2 block font-mono">
            Console
          </span>
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold tracking-tight transition-all duration-350 cursor-pointer ${
                  isActive 
                    ? 'nav-active shadow-sm' 
                    : 'text-[#86868b] nav-inactive'
                }`
              }
            >
              <Icon size={14} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Deployment Info Card */}
        <div className="m-4 p-4 rounded-2xl bg-[#1c1c1e] border border-[#2c2c2e]/40 backdrop-blur-sm text-[10px] text-zinc-400 leading-normal font-semibold">
          <span className="flex items-center gap-1.5 font-bold text-[#f5f5f7] uppercase tracking-widest text-[8px] mb-1.5 font-mono">
            <ShieldAlert size={10} className="text-sky-400" />
            Cluster
          </span>
          <p className="text-[10px] text-zinc-400 font-medium leading-relaxed">
            AI agents run automatically on startup executing paper orders.
          </p>
        </div>

        {/* Server status indicator */}
        <div className="px-6 py-4 border-t border-[#2c2c2e]/60">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest font-mono">
              Gateway
            </span>
            <div className="flex items-center gap-1.5 text-[9px] uppercase font-extrabold tracking-widest font-mono">
              {connected ? (
                <>
                  <div className="w-1.5 h-1.5 rounded-full bg-[#30d158]" />
                  <span className="text-[#30d158]">ONLINE</span>
                </>
              ) : (
                <>
                  <div className="w-1.5 h-1.5 rounded-full bg-[#ff453a] animate-pulse" />
                  <span className="text-[#ff453a]">OFFLINE</span>
                </>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Viewport */}
      <div className="main-viewport">
        {/* Top Header frosted glass */}
        <header className="header-container">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800/40 cursor-pointer"
            >
              <Menu size={16} />
            </button>
            <h1 className="text-xs font-black text-[#f5f5f7] uppercase tracking-widest font-mono flex items-center gap-1.5">
              <Activity size={12} className="text-sky-400" />
              Engine Command Center
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {/* Status pill */}
            <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-[9px] font-extrabold font-mono tracking-widest transition-all duration-300 ${
              emergencyStop 
                ? 'bg-[#ff453a]/10 border-[#ff453a]/20 text-[#ff453a]' 
                : 'bg-[#30d158]/10 border-[#30d158]/20 text-[#30d158]'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full ${emergencyStop ? 'bg-[#ff453a] animate-pulse' : 'bg-[#30d158]'}`} />
              <span>{emergencyStop ? 'PAUSED' : 'ACTIVE'}</span>
            </div>

            {/* Toggle Action button */}
            <button
              onClick={toggleTradingState}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[10px] font-black tracking-widest uppercase transition-all duration-350 cursor-pointer border shadow-sm font-mono ${
                emergencyStop
                  ? 'bg-[#f5f5f7] hover:bg-[#e5e5ea] text-black border-white'
                  : 'bg-transparent text-[#ff453a] border-[#ff453a]/30 hover:bg-[#ff453a]/10 hover:border-[#ff453a]/50'
              }`}
            >
              {emergencyStop ? (
                <>
                  <Play size={10} className="fill-current" />
                  <span>Resume</span>
                </>
              ) : (
                <>
                  <Pause size={10} className="fill-current" />
                  <span>Pause</span>
                </>
              )}
            </button>
          </div>
        </header>

        {/* Dynamic Outlet */}
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
