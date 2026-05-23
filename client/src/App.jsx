import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Trading from './pages/Trading.jsx';
import Portfolio from './pages/Portfolio.jsx';
import Agents from './pages/Agents.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="trading" element={<Trading />} />
          <Route path="portfolio" element={<Portfolio />} />
          <Route path="agents" element={<Agents />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
