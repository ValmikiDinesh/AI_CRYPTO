import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Trading from './pages/Trading.jsx';
import Portfolio from './pages/Portfolio.jsx';
import Agents from './pages/Agents.jsx';
import Settings from './pages/Settings.jsx';
import Login from './pages/Login.jsx';
import { useAuthStore } from './store.js';

// Guard wrapper
function ProtectedRoute({ children }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        
        <Route 
          path="/" 
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="trading" element={<Trading />} />
          <Route path="portfolio" element={<Portfolio />} />
          <Route path="agents" element={<Agents />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
