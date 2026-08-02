import { useState } from 'react';
import axios from 'axios';
import { useAuthStore } from '../store.js';
import { ShieldCheck, Lock, Mail, User, AlertCircle, ChevronRight, Activity } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function Login() {
  const [isRegistering, setIsRegistering] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isRegistering) {
        const res = await axios.post('/api/auth/register', { username, email, password });
        if (res.data.success) {
          login(res.data.token, res.data.user);
          navigate('/');
        }
      } else {
        const res = await axios.post('/api/auth/login', { email, password });
        if (res.data.success) {
          login(res.data.token, res.data.user);
          navigate('/');
        }
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Authentication failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6 text-[#f5f5f7]">
      {/* Dynamic Background Elements */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-sky-500/5 blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-purple-500/5 blur-[120px]" />
      </div>

      <div className="w-full max-w-md relative z-10">
        {/* Brand Header */}
        <div className="flex flex-col items-center mb-8 space-y-3">
          <div className="w-14 h-14 rounded-2xl bg-[#1c1c1e] border border-[#2c2c2e]/60 flex items-center justify-center shadow-2xl">
            <Activity className="w-7 h-7 text-sky-400" />
          </div>
          <h1 className="text-xl font-black tracking-widest text-[#f5f5f7] uppercase font-mono mt-4">
            CRYPTO // <span className="text-sky-400">AI</span>
          </h1>
          <p className="text-xs text-zinc-500 font-mono tracking-widest uppercase">Autonomous Agent Gateway</p>
        </div>

        {/* Form Container */}
        <div className="bg-[#1c1c1e]/80 backdrop-blur-xl border border-[#2c2c2e]/60 rounded-3xl p-8 shadow-2xl">
          <h2 className="text-lg font-bold mb-6 text-white font-mono flex items-center gap-2">
            <Lock className="w-5 h-5 text-zinc-400" />
            {isRegistering ? 'Initialize Identity' : 'Secure Authorization'}
          </h2>

          {error && (
            <div className="mb-6 bg-rose-500/10 border border-rose-500/20 text-rose-400 p-4 rounded-xl text-xs font-mono flex items-center gap-3">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {isRegistering && (
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono">Operative Alias</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <User className="w-4 h-4 text-zinc-500" />
                  </div>
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full bg-black/50 border border-[#3a3a3c] rounded-xl pl-11 pr-4 py-3.5 text-sm text-white focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-all font-mono"
                    placeholder="Enter username"
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono">System Email</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Mail className="w-4 h-4 text-zinc-500" />
                </div>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-black/50 border border-[#3a3a3c] rounded-xl pl-11 pr-4 py-3.5 text-sm text-white focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-all font-mono"
                  placeholder="admin@crypto.ai"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono">Passphrase</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <ShieldCheck className="w-4 h-4 text-zinc-500" />
                </div>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-black/50 border border-[#3a3a3c] rounded-xl pl-11 pr-4 py-3.5 text-sm text-white focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-all font-mono"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-sky-500 hover:bg-sky-600 text-white font-mono text-xs font-bold px-6 py-4 rounded-xl transition duration-200 cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2 mt-6 shadow-[0_0_20px_rgba(14,165,233,0.3)] hover:shadow-[0_0_25px_rgba(14,165,233,0.5)]"
            >
              {loading ? 'Authenticating...' : (isRegistering ? 'Create Authorization' : 'Enter Dashboard')}
              {!loading && <ChevronRight className="w-4 h-4" />}
            </button>
          </form>

          <div className="mt-8 text-center">
            <button
              type="button"
              onClick={() => {
                setIsRegistering(!isRegistering);
                setError('');
              }}
              className="text-[10px] text-zinc-500 hover:text-sky-400 transition-colors uppercase tracking-widest font-mono cursor-pointer"
            >
              {isRegistering ? 'Existing Operative? Authenticate' : 'New Installation? Register Admin'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
