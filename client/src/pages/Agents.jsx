import { useState, useEffect } from 'react';
import { useAgentStore, socket } from '../store.js';
import { Bot, AlertTriangle, Clock, RefreshCw, Activity, Heart, ShieldAlert, Cpu, Terminal } from 'lucide-react';
import axios from 'axios';

const agentIcons = {
  market: Activity,
  technical: RefreshCw,
  sentiment: Heart,
  prediction: Cpu,
  fusion: Bot,
  risk: ShieldAlert,
  execution: Bot,
  portfolio: Bot,
  learning: Cpu,
  supervisor: ShieldAlert,
};

const statusColors = {
  running: '#30d158',
  idle: '#ff9f0a',
  error: '#ff453a',
  stopped: '#86868b',
};

const bgStatusColors = {
  running: 'rgba(48, 209, 88, 0.1)',
  idle: 'rgba(255, 159, 10, 0.1)',
  error: 'rgba(255, 69, 58, 0.1)',
  stopped: 'rgba(142, 142, 147, 0.1)',
};

const borderStatusColors = {
  running: 'rgba(48, 209, 88, 0.2)',
  idle: 'rgba(255, 159, 10, 0.2)',
  error: 'rgba(255, 69, 58, 0.2)',
  stopped: 'rgba(142, 142, 147, 0.2)',
};

function formatUptime(ms) {
  if (!ms) return '—';
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export default function Agents() {
  const agents = useAgentStore((s) => s.agents);
  const emergencyStop = useAgentStore((s) => s.emergencyStop);
  const riskEvents = useAgentStore((s) => s.riskEvents);
  const ensemble = useAgentStore((s) => s.ensemble);
  const [logs, setLogs] = useState([]);
  const [activeTab, setActiveTab] = useState('all');
  const [nodeFeedback, setNodeFeedback] = useState(null);
  const [restartingNodes, setRestartingNodes] = useState({});

  useEffect(() => {
    fetchHealth();
    
    const handleAgentLog = (logData) => {
      setLogs((prev) => {
        // Prepend new log
        const updated = [logData, ...prev];
        // Keep max 500 logs
        return updated.slice(0, 500);
      });
    };

    socket.on('agent:log', handleAgentLog);

    return () => {
      socket.off('agent:log', handleAgentLog);
    };
  }, []);

  const fetchHealth = async () => {
    try {
      const res = await axios.get('/api/agents/health');
      if (res.data.success) {
        useAgentStore.getState().setAgentHealth(res.data.data);
      }
    } catch {}
  };

  // Kept for backward compatibility if needed, but not polled.
  const fetchLogs = async () => {
    try {
      const levelQuery = activeTab !== 'all' ? `&level=${activeTab}` : '';
      const res = await axios.get(`/api/agents/logs?limit=40${levelQuery}`);
      if (res.data.success) setLogs(res.data.data);
    } catch { /* silent */ }
  };

  const handleResume = async () => {
    try {
      await axios.post('/api/agents/resume');
      setNodeFeedback({ type: 'success', message: 'Engine resume dispatched successfully.' });
      setTimeout(() => setNodeFeedback(null), 3000);
    } catch (err) {
      console.error('Resume failed:', err);
    }
  };

  const handleRestartNode = async (nodeName) => {
    setNodeFeedback(null);
    setRestartingNodes(prev => ({ ...prev, [nodeName]: true }));
    try {
      const res = await axios.post(`/api/agents/restart/${nodeName}`);
      if (res.data.success) {
        setNodeFeedback({ type: 'success', message: `Agent [${nodeName.toUpperCase()}] restarted successfully.` });
        setTimeout(() => setNodeFeedback(null), 3000);
        fetchLogs();
      }
    } catch (err) {
      setNodeFeedback({ type: 'error', message: err.response?.data?.message || 'Restart node failed' });
      setTimeout(() => setNodeFeedback(null), 3000);
    } finally {
      setRestartingNodes(prev => ({ ...prev, [nodeName]: false }));
    }
  };

  const agentList = Object.entries(agents);

  return (
    <div className="page-layout">
      {/* Header control */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5 border-b border-[#2c2c2e]/60 pb-5">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#f5f5f7]">AI Sub-Agent Nodes</h2>
          <p className="text-[11px] text-[#86868b] mt-1 font-medium">
            Monitor cluster health status diagnostics, uptime records, and control local node processes.
          </p>
        </div>

        {emergencyStop && (
          <button
            onClick={handleResume}
            className="px-4 py-1.5 rounded-full text-xs font-bold bg-[#30d158] hover:bg-[#28b54c] text-black cursor-pointer transition-colors duration-300"
          >
            Resume All Nodes
          </button>
        )}
      </div>

      {nodeFeedback && (
        <div className={`p-3.5 rounded-xl text-xs font-bold border font-mono ${
          nodeFeedback.type === 'success' 
            ? 'bg-[#30d158]/10 border-[#30d158]/20 text-[#30d158]' 
            : 'bg-[#ff453a]/10 border-[#ff453a]/20 text-[#ff453a]'
        }`}>
          {nodeFeedback.message}
        </div>
      )}

      {/* Cluster Node Grid */}
      <div className="grid-layout-3">
        {agentList.length === 0 ? (
          <div className="col-span-full glass-panel p-12 text-center text-xs text-zinc-500 uppercase tracking-widest font-mono font-semibold animate-pulse">
            CONNECTING TO DIAGNOSTICS GATEWAY...
          </div>
        ) : (
          agentList.map(([name, health]) => {
            const Icon = agentIcons[name] || Bot;
            const status = health.status || 'stopped';
            const isRestarting = restartingNodes[name];
            return (
              <div key={name} className="glass-panel bg-[#1c1c1e] py-4 px-5 flex flex-col justify-between min-h-[144px] gap-3 group">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl flex items-center justify-center bg-black border border-[#2c2c2e]/60 shadow-inner">
                      <Icon size={14} style={{ color: statusColors[status] }} />
                    </div>
                    <span className="text-xs font-bold text-slate-200 uppercase tracking-wider font-mono capitalize">{name} Node</span>
                  </div>
                  <div 
                    className="flex items-center gap-1.5 text-[9px] font-bold font-mono uppercase px-2.5 py-0.5 rounded-full border" 
                    style={{ 
                      background: bgStatusColors[status] || 'rgba(0,0,0,0.2)', 
                      borderColor: borderStatusColors[status] || 'rgba(255,255,255,0.05)', 
                      color: statusColors[status] 
                    }}
                  >
                    <div className="w-1.5 h-1.5 rounded-full animate-pulse-soft" style={{ background: statusColors[status] }} />
                    <span>{status}</span>
                  </div>
                </div>

                <div className="my-3 space-y-1.5 text-xs text-[#86868b] font-semibold font-mono">
                  <div className="flex justify-between">
                    <span className="text-zinc-500 text-[10px] tracking-wider uppercase">Cycles Completed</span>
                    <span className="font-bold text-slate-200">{health.cycleCount || 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500 text-[10px] tracking-wider uppercase">Uptime</span>
                    <span className="font-bold text-slate-200">{formatUptime(health.uptime)}</span>
                  </div>
                </div>

                {/* Dynamic Ensemble Weight & Accuracy meters */}
                {ensemble && ensemble[name] && (
                  <div className="border-t border-[#2c2c2e]/40 pt-3 pb-1 mt-1 space-y-2.5 text-[9px] font-mono font-bold">
                    <div className="space-y-1">
                      <div className="flex justify-between items-center text-zinc-500 uppercase tracking-widest">
                        <span>Active Influence</span>
                        <span className="text-[#0071e3]">{(ensemble[name].weight * 100).toFixed(0)}%</span>
                      </div>
                      <div className="w-full bg-black/60 rounded-full h-1.5 border border-[#2c2c2e]/30 overflow-hidden">
                        <div 
                          className="h-full bg-gradient-to-r from-sky-500 to-[#0071e3] rounded-full transition-all duration-500" 
                          style={{ width: `${ensemble[name].weight * 100}%` }}
                        />
                      </div>
                    </div>
                    <div className="flex justify-between items-center text-zinc-500 uppercase tracking-widest">
                      <span>PnL Accuracy Meter</span>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full border bg-[#30d158]/10 border-[#30d158]/20 text-[#30d158]">
                        {(ensemble[name].accuracy * 100).toFixed(1)}% Acc
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between border-t border-black pt-3 text-[9px] font-bold uppercase tracking-wider font-mono">
                  <span className="text-zinc-600">Core Management</span>
                  <button
                    onClick={() => handleRestartNode(name)}
                    disabled={isRestarting}
                    className="px-3 py-1 border border-[#2c2c2e]/55 hover:border-[#2c2c2e]/80 text-[#0071e3] hover:text-[#0071e3]/80 bg-black rounded-full cursor-pointer transition-colors flex items-center gap-1"
                  >
                    {isRestarting ? (
                      <span>Restarting...</span>
                    ) : (
                      <span>Restart Core</span>
                    )}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Diagnostics grid */}
      <div className="grid-layout-2">
        {/* Risk Audit events */}
        <div className="glass-panel bg-[#1c1c1e]">
          <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest flex items-center gap-2 border-b border-[#2c2c2e]/60 pb-3 font-mono mb-4">
            <ShieldAlert size={14} className="text-amber-500" />
            Security & Risk Log
          </h3>
          {riskEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center h-full my-auto text-zinc-500">
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest font-mono">
                NO ANOMALIES DETECTED IN SESSION
              </span>
            </div>
          ) : (
            <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
              {riskEvents.map((event, i) => (
                <div key={i} className="flex items-start gap-3 p-3 rounded-xl border border-[#2c2c2e]/60 bg-black relative overflow-hidden pl-4">
                  <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#ff9f0a]" />
                  <AlertTriangle size={13} className="flex-shrink-0 text-[#ff9f0a] mt-0.5" />
                  <div className="text-[10px] font-semibold">
                    <span className="font-bold text-slate-200 uppercase tracking-wider block font-mono">{event.type?.replace(/_/g, ' ')}</span>
                    <span className="text-zinc-400 mt-1 block font-medium leading-relaxed">{event.message}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Live Network Log stream */}
        <div className="glass-panel bg-[#1c1c1e]">
          <div className="flex items-center justify-between border-b border-[#2c2c2e]/60 pb-3 mb-4">
            <h3 className="text-xs font-bold text-[#f5f5f7] uppercase tracking-widest flex items-center gap-2 font-mono">
              <Terminal size={14} className="text-sky-400" />
              macOS shell terminal
            </h3>

            {/* Filter Tabs */}
            <div className="flex gap-1 p-0.5 bg-black border border-[#2c2c2e]/60 rounded-full">
              {['all', 'info', 'warn', 'error'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-2.5 py-0.5 rounded-full text-[8px] font-bold uppercase transition-colors cursor-pointer font-mono ${
                    activeTab === tab
                      ? 'bg-[#f5f5f7] text-black font-semibold'
                      : 'bg-transparent text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>

          {logs.length === 0 ? (
            <div className="text-xs text-center py-12 uppercase text-zinc-500 font-extrabold tracking-widest font-mono animate-pulse">
              SYNCING LOG BUFFER...
            </div>
          ) : (() => {
            const filteredLogs = activeTab === 'all' ? logs : logs.filter(l => l.level?.toLowerCase() === activeTab);
            if (filteredLogs.length === 0) {
              return (
                <div className="text-xs text-center py-12 uppercase text-zinc-500 font-extrabold tracking-widest font-mono">
                  NO LOGS MATCHING LEVEL
                </div>
              );
            }
            return (
              <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1 font-mono text-[9px] bg-black border border-[#2c2c2e]/60 rounded-xl p-3 leading-relaxed">
                {filteredLogs.map((log, i) => (
                  <div key={i} className="flex items-start gap-2 p-1 rounded hover:bg-zinc-800/10 transition-colors">
                    <span 
                      className="font-bold uppercase tracking-widest flex-shrink-0"
                      style={{
                        color: log.level === 'error' ? '#ff453a' : log.level === 'warn' ? '#ff9f0a' : '#86868b',
                      }}
                    >
                      [{log.level}]
                    </span>
                    <span className="font-bold text-purple-400 flex-shrink-0">
                      [{log.agent}]
                    </span>
                    <span className="text-zinc-400 break-all font-medium">{log.message}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
