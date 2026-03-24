import { Link, useLocation } from 'react-router-dom';
import { ReactNode } from 'react';

const NAV_TABS = [
  { path: '/tearsheet',      label: '📊 Tearsheet' },
  { path: '/pipeline',       label: '📋 List View' },
  { path: '/activity',       label: '📡 Activity Feed' },
  { path: '/all-dockets',    label: '📄 Dockets' },
  { path: '/all-regulatory', label: '🏛️ Regulatory' },
  { path: '/sec-filings',    label: '📑 SEC Filings' },
  { path: '/upcoming',       label: '📅 Upcoming' },
];

export default function DashboardNav({ children }: { children?: ReactNode }) {
  const location = useLocation();
  return (
    <nav className="top-nav">
      {NAV_TABS.map(tab => (
        <Link
          key={tab.path}
          to={tab.path}
          className={`nav-tab ${location.pathname === tab.path ? 'active' : ''}`}
        >
          {tab.label}
        </Link>
      ))}
      {children && <>
        <div style={{ flex: 1 }} />
        {children}
      </>}
    </nav>
  );
}
