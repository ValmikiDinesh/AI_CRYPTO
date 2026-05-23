import { useState, useEffect } from 'react';
import { useAgentStore } from '../store.js';
import { Bot, AlertTriangle, Clock, RefreshCw, Activity, Heart, ShieldAlert, Cpu } from 'lucide-react';
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
  running: 'var(--color-accent-green)',
  idle: 'var(--color-accent-yellow)',
  error: 'var(--color-accent-red)',
  stopped: 'var(--color-text-secondary)',
};

const bgStatusColors = {
  running: 'var(--color-accent-green-dim)',
  idle: 'var(--color-accent-yellow-dim)',
  error: 'var(--color-accent-red-dim)',
  stopped: 'var(--color-bg-secondary)',
};

const borderStatusColors = {
  running: 'rgba(14, 203, 129, 0.25)',
  idle: 'rgba(240, 185, 11, 0.25)',
  error: 'rgba(246, 70, 93, 0.25)',
  stopped: 'var(--color-border)',
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
  const [logs, setLogs] = useState([]);
  const [activeTab, setActiveTab] = useState('all');
  const [nodeFeedback, setNodeFeedback] = useState(null);

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [activeTab]);

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
    }
  };

  const agentList = Object.entries(agents);

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Header control */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--color-border)] pb-4">
        <div>
          <h2 className="text-base font-extrabold text-[var(--color-text-primary)] uppercase tracking-wide flex items-center gap-2">
            <Bot size={16} className="text-[var(--color-accent-blue)]" />
            AI Sub-Agent Nodes
          </h2>
          <p className="text-[11px] text-[var(--color-text-secondary)] font-semibold">Cluster health diagnostics, run status, and node control terminals.</p>
        </div>

        {emergencyStop && (
          <button
            onClick={handleResume}
            className="px-3.5 py-1.5 rounded text-xs font-bold bg-[var(--color-accent-green)] text-[var(--color-bg-primary)] hover:opacity-90 cursor-pointer shadow-sm shadow-[var(--color-accent-green)]/10 transition-opacity"
          >
            Resume All Agents
          </button>
        )}
      </div>

      {nodeFeedback && (
        <div className={`p-2.5 rounded text-xs font-bold border ${
          nodeFeedback.type === 'success' 
            ? 'bg-[var(--color-accent-green-dim)] border-[var(--color-accent-green)] text-[var(--color-accent-green)]' 
            : 'bg-[var(--color-accent-red-dim)] border-[var(--color-accent-red)] text-[var(--color-accent-red)]'
        }`}>
          {nodeFeedback.message}
        </div>
      )}

      {/* Cluster Node Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agentList.length === 0 ? (
          <div className="col-span-full glass-panel p-10 text-center text-xs text-[var(--color-text-secondary)] uppercase tracking-widest font-semibold animate-pulse">
            Connecting to AI node manager gateway...
          </div>
        ) : (
          agentList.map(([name, health]) => {
            const Icon = agentIcons[name] || Bot;
            const status = health.status || 'stopped';
            return (
              <div key={name} className="glass-panel p-4 flex flex-col justify-between h-36">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded flex items-center justify-center bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                      <Icon size={12} style={{ color: statusColors[status] }} />
                    </div>
                    <span className="text-xs font-extrabold text-[var(--color-text-primary)] capitalize">{name} Node</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[9px] font-bold font-mono capitalize px-2 py-0.5 rounded border" 
                    style={{ background: bgStatusColors[status] || 'var(--color-bg-secondary)', borderColor: borderStatusColors[status] || 'var(--color-border)', color: statusColors[status] }}>
                    <div className="w-1.5 h-1.5 rounded-full" style={{ background: statusColors[status] }} />
                    <span>{status}</span>
                  </div>
                </div>

                <div className="my-2.5 space-y-1 text-xs text-[var(--color-text-secondary)]">
                  <div className="flex justify-between">
                    <span>Cycles Completed</span>
                    <span className="font-bold text-[var(--color-text-primary)] font-mono">{health.cycleCount || 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Uptime</span>
                    <span className="font-bold text-[var(--color-text-primary)] font-mono">{formatUptime(health.uptime)}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-2 text-[9px] font-bold uppercase tracking-wider">
                  <span className="text-[var(--color-text-muted)]">Node Management</span>
                  <button
                    onClick={() => handleRestartNode(name)}
                    className="px-2 py-0.5 border border-[var(--color-border)] hover:border-[var(--color-border-light)] text-[var(--color-accent-blue)] bg-[var(--color-bg-secondary)] rounded cursor-pointer transition-colors hover:text-white"
                  >
                    Restart Node
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Audit diagnostics grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Risk Audit events */}
        <div className="glass-panel p-5 space-y-3">
          <h3 className="text-xs font-bold text-[var(--color-text-primary)] uppercase tracking-wider flex items-center gap-2 border-b border-[var(--color-border)] pb-2">
            <ShieldAlert size={13} className="text-[var(--color-accent-yellow)]" />
            Security & Risk Events
          </h3>
          {riskEvents.length === 0 ? (
            <div className="text-xs text-center py-8 uppercase text-[var(--color-text-secondary)] font-semibold tracking-wider">
              No anomalies reported in this session
            </div>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {riskEvents.map((event, i) => (
                <div key={i} className="flex items-start gap-2.5 p-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                  <AlertTriangle size={12} className="flex-shrink-0 text-[var(--color-accent-yellow)]" style={{ marginTop: 1 }} />
                  <div className="text-[10px]">
                    <span className="font-bold text-[var(--color-text-primary)] uppercase block">{event.type?.replace(/_/g, ' ')}</span>
                    <span className="text-[var(--color-text-secondary)] mt-0.5 block font-semibold">{event.message}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Live Network Log stream */}
        <div className="glass-panel p-5 space-y-3">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
            <h3 className="text-xs font-bold text-[var(--color-text-primary)] uppercase tracking-wider flex items-center gap-2">
              <Clock size={13} className="text-[var(--color-accent-blue)]" />
              Cluster Log Stream
            </h3>

            {/* Filter Tabs */}
            <div className="flex gap-0.5">
              {['all', 'info', 'warn', 'error'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-1.5 py-0.5 rounded text-[8px] font-bold uppercase border transition-colors cursor-pointer ${
                    activeTab === tab
                      ? 'bg-[var(--color-accent-blue)] border-[var(--color-accent-blue)] text-[var(--color-bg-primary)]'
                      : 'bg-[var(--color-bg-secondary)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-white hover:border-[var(--color-border-light)]'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>

          {logs.length === 0 ? (
            <div className="text-xs text-center py-8 uppercase text-[var(--color-text-secondary)] font-semibold tracking-wider animate-pulse">
              Buffering live server reports...
            </div>
          ) : (
            <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1 font-mono text-[9px] leading-relaxed">
              {logs.map((log, i) => (
                <div key={i} className="flex items-start gap-2 p-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                  <span className="font-bold uppercase tracking-wider flex-shrink-0"
                    style={{
                      color: log.level === 'error' ? 'var(--color-accent-red)' : log.level === 'warn' ? 'var(--color-accent-yellow)' : 'var(--color-text-secondary)',
                    }}>
                    [{log.level}]
                  </span>
                  <span className="font-bold text-[var(--color-accent-blue)] flex-shrink-0">
                    [{log.agent}]
                  </span>
                  <span className="text-[var(--color-text-secondary)] break-all font-semibold">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
