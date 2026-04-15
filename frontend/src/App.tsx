import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import PipelineTable from './components/PipelineTable';
import DealDetail from './pages/DealDetail';
import PipelineTearsheet from './pages/PipelineTearsheet';
import AllDockets from './pages/AllDockets';
import AllRegulatory from './pages/AllRegulatory';
import AllActivity from './pages/AllActivity';
import RedditAnalysis from './pages/RedditAnalysis';
import SECFilings from './pages/SECFilings';
import UpcomingEvents from './pages/UpcomingEvents';
import './styles/GlobalVars.css';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<Navigate to="/tearsheet" replace />} />
            <Route path="/tearsheet" element={<PipelineTearsheet />} />
            <Route path="/pipeline" element={<PipelineTable />} />
            <Route path="/deal/:dealId" element={<DealDetail />} />
            <Route path="/all-dockets" element={<AllDockets />} />
            <Route path="/all-regulatory" element={<AllRegulatory />} />
            <Route path="/activity" element={<AllActivity />} />
            <Route path="/reddit" element={<RedditAnalysis />} />
            <Route path="/sec-filings" element={<SECFilings />} />
            <Route path="/upcoming" element={<UpcomingEvents />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;