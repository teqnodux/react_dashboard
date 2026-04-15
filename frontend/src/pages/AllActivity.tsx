import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import DashboardNav from '../components/DashboardNav';
import '../styles/Activity.css';
import '../styles/CrossDeal.css';
import api from '../services/api';

interface Activity {
  id: string;
  timestamp: string;
  type: string; // 'filing', 'regulatory', 'docket', 'milestone', 'press_release', 'financial'
  deal_id: string;
  deal_name: string;
  title: string;
  description: string;
  importance: string; // 'high', 'medium', 'low'
  source?: string;
  link?: string;
  status?: string;
}

interface ActivitySummary {
  total_activities: number;
  last_7_days: number;
  by_type: Record<string, number>;
  most_active_deals: Array<{
    deal_id: string;
    deal_name: string;
    activity_count: number;
  }>;
  upcoming_events: number;
}

export default function AllActivity() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [loading, setLoading] = useState(true);

  // Filters
  const [dateRange, setDateRange] = useState<string>('7'); // days
  const [dealScope, setDealScope] = useState<'watchlist' | 'all'>('watchlist');
  const [dealFilter, setDealFilter] = useState<string>('all');
  const [typeFilters, setTypeFilters] = useState<Set<string>>(new Set(['all']));
  const [importanceFilter, setImportanceFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');

  // Load watchlist from localStorage
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  useEffect(() => {
    const stored = localStorage.getItem('merger_arb_watchlist');
    if (stored) {
      try { setWatchlist(new Set(JSON.parse(stored))); } catch { /* ignore */ }
    }
  }, []);

  useEffect(() => {
    fetchActivities();
  }, []);

  const fetchActivities = async () => {
    try {
      const { data } = await api.get(`/api/all-activity`);
      setActivities(data.activities);
      setSummary(data.summary);
    } catch (error) {
      console.error('Error fetching activities:', error);
    } finally {
      setLoading(false);
    }
  };

  // Filter activities
  const filteredActivities = activities.filter(activity => {
    // Date range filter
    const activityDate = new Date(activity.timestamp);
    const daysAgo = parseInt(dateRange);
    if (daysAgo > 0) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysAgo);
      if (activityDate < cutoffDate) return false;
    }

    // Watchlist scope filter
    if (dealScope === 'watchlist' && watchlist.size > 0 && !watchlist.has(activity.deal_id)) return false;

    // Deal filter
    if (dealFilter !== 'all' && activity.deal_id !== dealFilter) return false;

    // Type filter
    if (!typeFilters.has('all') && !typeFilters.has(activity.type)) return false;

    // Importance filter
    if (importanceFilter !== 'all' && activity.importance !== importanceFilter) return false;

    // Search filter
    if (searchTerm && !activity.title.toLowerCase().includes(searchTerm.toLowerCase()) &&
        !activity.description.toLowerCase().includes(searchTerm.toLowerCase())) return false;

    return true;
  });

  // Sort by timestamp (most recent first)
  const sortedActivities = [...filteredActivities].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const toggleTypeFilter = (type: string) => {
    const newFilters = new Set(typeFilters);

    if (type === 'all') {
      newFilters.clear();
      newFilters.add('all');
    } else {
      newFilters.delete('all');
      if (newFilters.has(type)) {
        newFilters.delete(type);
      } else {
        newFilters.add(type);
      }
      if (newFilters.size === 0) {
        newFilters.add('all');
      }
    }

    setTypeFilters(newFilters);
  };

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffHours < 1) {
      const diffMins = Math.floor(diffMs / (1000 * 60));
      return `${diffMins}m ago`;
    } else if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  };

  const formatFullDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getTypeIcon = (type: string): string => {
    const icons: Record<string, string> = {
      'filing': '📄',
      'regulatory': '🏛️',
      'docket': '⚖️',
      'milestone': '📊',
      'press_release': '📰',
      'financial': '💰'
    };
    return icons[type] || '📌';
  };

  const getTypeLabel = (type: string): string => {
    const labels: Record<string, string> = {
      'filing': 'SEC Filing',
      'regulatory': 'Regulatory',
      'docket': 'Docket Entry',
      'milestone': 'Milestone',
      'press_release': 'Press Release',
      'financial': 'Financial'
    };
    return labels[type] || type;
  };

  if (loading) {
    return (
      <div className="dashboard">
        <DashboardNav />
        <div className="loading">Loading activity feed...</div>
      </div>
    );
  }

  // Get unique deals for filter dropdown
  const uniqueDeals = Array.from(new Set(activities.map(a => a.deal_id)))
    .map(id => {
      const activity = activities.find(a => a.deal_id === id);
      return { id, name: activity?.deal_name || '' };
    });

  return (
    <div className="dashboard">
      <DashboardNav />

      <div className="page-header">
        <div className="header-content">
          <h1>Activity Feed</h1>
          <p className="page-subtitle">Real-time stream of all events across your portfolio</p>
        </div>
      </div>

      {/* Summary Stats */}
      {summary && (
        <div className="activity-summary">
          <div className="summary-card">
            <div className="card-label">Last 7 Days</div>
            <div className="card-value">{summary.last_7_days}</div>
            <div className="card-subtext">activities</div>
          </div>
          <div className="summary-card">
            <div className="card-label">Total Tracked</div>
            <div className="card-value">{summary.total_activities}</div>
            <div className="card-subtext">all time</div>
          </div>
          <div className="summary-card">
            <div className="card-label">Upcoming Events</div>
            <div className="card-value">{summary.upcoming_events}</div>
            <div className="card-subtext">next 7 days</div>
          </div>

          {/* Activity by Type */}
          <div className="summary-card wide">
            <div className="card-label">Activity Breakdown</div>
            <div className="type-breakdown">
              {Object.entries(summary.by_type).map(([type, count]) => (
                <div key={type} className="type-stat">
                  <span className="type-icon">{getTypeIcon(type)}</span>
                  <span className="type-count">{count}</span>
                  <span className="type-name">{getTypeLabel(type)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Watchlist / All Deals Toggle */}
      <div className="filter-bar" style={{padding: '0 var(--space-lg)', marginBottom: 'var(--space-sm)'}}>
        <div className="filter-tabs">
          <button
            className={`filter-btn ${dealScope === 'watchlist' ? 'active' : ''}`}
            onClick={() => setDealScope('watchlist')}
          >
            Watchlist ({watchlist.size})
          </button>
          <button
            className={`filter-btn ${dealScope === 'all' ? 'active' : ''}`}
            onClick={() => setDealScope('all')}
          >
            All Deals ({activities.length > 0 ? new Set(activities.map(a => a.deal_id)).size : 0})
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="filters-section">
        <div className="filter-row">
          <div className="search-bar">
            <input
              type="text"
              placeholder="Search activities..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="search-input"
            />
          </div>

          <div className="filter-group">
            <label>Date Range:</label>
            <select value={dateRange} onChange={(e) => setDateRange(e.target.value)} className="filter-select">
              <option value="1">Last 24 hours</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="0">All time</option>
            </select>
          </div>

          <div className="filter-group">
            <label>Deal:</label>
            <select value={dealFilter} onChange={(e) => setDealFilter(e.target.value)} className="filter-select">
              <option value="all">All Deals</option>
              {uniqueDeals.map(deal => (
                <option key={deal.id} value={deal.id}>{deal.name}</option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label>Importance:</label>
            <select value={importanceFilter} onChange={(e) => setImportanceFilter(e.target.value)} className="filter-select">
              <option value="all">All</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>

        {/* Type Filters */}
        <div className="filter-row">
          <label>Activity Type:</label>
          <div className="type-filters">
            <button
              className={`type-filter-btn ${typeFilters.has('all') ? 'active' : ''}`}
              onClick={() => toggleTypeFilter('all')}
            >
              All
            </button>
            <button
              className={`type-filter-btn ${typeFilters.has('filing') ? 'active' : ''}`}
              onClick={() => toggleTypeFilter('filing')}
            >
              📄 Filings
            </button>
            <button
              className={`type-filter-btn ${typeFilters.has('regulatory') ? 'active' : ''}`}
              onClick={() => toggleTypeFilter('regulatory')}
            >
              🏛️ Regulatory
            </button>
            <button
              className={`type-filter-btn ${typeFilters.has('docket') ? 'active' : ''}`}
              onClick={() => toggleTypeFilter('docket')}
            >
              ⚖️ Dockets
            </button>
            <button
              className={`type-filter-btn ${typeFilters.has('milestone') ? 'active' : ''}`}
              onClick={() => toggleTypeFilter('milestone')}
            >
              📊 Milestones
            </button>
            <button
              className={`type-filter-btn ${typeFilters.has('press_release') ? 'active' : ''}`}
              onClick={() => toggleTypeFilter('press_release')}
            >
              📰 Press
            </button>
            <button
              className={`type-filter-btn ${typeFilters.has('financial') ? 'active' : ''}`}
              onClick={() => toggleTypeFilter('financial')}
            >
              💰 Financial
            </button>
          </div>
        </div>
      </div>

      {/* Activity Stream */}
      <div className="activity-container">
        <div className="activity-count">{sortedActivities.length} activities</div>
        <div className="activity-stream">
          {sortedActivities.map((activity) => (
            <div key={activity.id} className={`activity-item importance-${activity.importance} type-${activity.type}`}>
              <div className="activity-icon">{getTypeIcon(activity.type)}</div>
              <div className="activity-content">
                <div className="activity-header">
                  <Link to={`/deal/${activity.deal_id}`} className="deal-tag">
                    {activity.deal_name}
                  </Link>
                  <span className="activity-type-badge">{getTypeLabel(activity.type)}</span>
                  <span className={`importance-badge ${activity.importance}`}>{activity.importance}</span>
                  <span className="activity-time" title={formatFullDate(activity.timestamp)}>
                    {formatDate(activity.timestamp)}
                  </span>
                </div>
                <div className="activity-title">{activity.title}</div>
                <div className="activity-description">{activity.description}</div>
                {activity.source && (
                  <div className="activity-meta">
                    <span className="activity-source">Source: {activity.source}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {sortedActivities.length === 0 && (
          <div className="no-activities">No activities match the selected filters</div>
        )}
      </div>
    </div>
  );
}
