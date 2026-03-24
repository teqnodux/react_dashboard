import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import DashboardNav from '../components/DashboardNav';
import '../styles/CrossDeal.css';
import { API_BASE_URL } from '../config';

interface DocketCase {
  deal_id: string;
  deal_name: string;
  entry_count: number;
  docket_number?: string;
  case_name?: string;
  jurisdiction?: string;
  status?: string;
  latest_entry_date?: string;
  high_relevance_count?: number;
  opposition_count?: number;
  support_count?: number;
}

interface DocketSummary {
  total_entries: number;
  total_deals_with_dockets: number;
  high_relevance: number;
  opposition_count: number;
  support_count: number;
  entries_by_deal: Array<{
    deal_id: string;
    deal_name: string;
    entry_count: number;
  }>;
}

export default function AllDockets() {
  const [docketCases, setDocketCases] = useState<DocketCase[]>([]);
  const [summary, setSummary] = useState<DocketSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [followedDockets, setFollowedDockets] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'following'>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');

  // Load followed dockets from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('followed_dockets');
    if (stored) {
      setFollowedDockets(new Set(JSON.parse(stored)));
    }
  }, []);

  useEffect(() => {
    fetchDockets();
  }, []);

  const fetchDockets = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/all-dockets`);
      const data = await response.json();

      // Transform entries into docket cases
      const casesMap = new Map<string, DocketCase>();

      data.entries.forEach((entry: any) => {
        if (!casesMap.has(entry.deal_id)) {
          casesMap.set(entry.deal_id, {
            deal_id: entry.deal_id,
            deal_name: entry.deal_name,
            entry_count: 0,
            latest_entry_date: entry.received_date,
            high_relevance_count: 0,
            opposition_count: 0,
            support_count: 0,
          });
        }

        const docketCase = casesMap.get(entry.deal_id)!;
        docketCase.entry_count++;

        if (entry.relevance_level === 'high') {
          docketCase.high_relevance_count = (docketCase.high_relevance_count || 0) + 1;
        }
        if (entry.position_on_deal === 'Oppose') {
          docketCase.opposition_count = (docketCase.opposition_count || 0) + 1;
        }
        if (entry.position_on_deal === 'Support') {
          docketCase.support_count = (docketCase.support_count || 0) + 1;
        }

        // Update latest date
        if (new Date(entry.received_date) > new Date(docketCase.latest_entry_date || '1970-01-01')) {
          docketCase.latest_entry_date = entry.received_date;
        }
      });

      setDocketCases(Array.from(casesMap.values()));
      setSummary(data.summary);
    } catch (error) {
      console.error('Error fetching dockets:', error);
    } finally {
      setLoading(false);
    }
  };

  const toggleFollow = (dealId: string) => {
    const newFollowed = new Set(followedDockets);
    if (newFollowed.has(dealId)) {
      newFollowed.delete(dealId);
    } else {
      newFollowed.add(dealId);
    }
    setFollowedDockets(newFollowed);
    localStorage.setItem('followed_dockets', JSON.stringify([...newFollowed]));
  };

  // Filter docket cases
  const filteredCases = docketCases.filter(docketCase => {
    if (filter === 'following' && !followedDockets.has(docketCase.deal_id)) return false;
    if (searchTerm && !docketCase.deal_name.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  // Sort by latest activity
  const sortedCases = [...filteredCases].sort((a, b) => {
    const dateA = a.latest_entry_date ? new Date(a.latest_entry_date).getTime() : 0;
    const dateB = b.latest_entry_date ? new Date(b.latest_entry_date).getTime() : 0;
    return dateB - dateA;
  });

  const formatDate = (dateStr: string | undefined): string => {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="dashboard">
      <DashboardNav />

      {loading && <div className="loading">Loading dockets...</div>}
      {!loading && (<>


      <div className="page-header">
        <div className="header-content">
          <h1>Dockets We're Following</h1>
          <p className="page-subtitle">Track regulatory dockets and court proceedings across deals</p>
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="summary-cards">
          <div className="summary-card">
            <div className="card-label">Total Dockets</div>
            <div className="card-value">{summary.total_deals_with_dockets}</div>
          </div>
          <div className="summary-card">
            <div className="card-label">Following</div>
            <div className="card-value">{followedDockets.size}</div>
          </div>
          <div className="summary-card">
            <div className="card-label">Total Entries</div>
            <div className="card-value">{summary.total_entries}</div>
          </div>
          <div className="summary-card highlight-red">
            <div className="card-label">High Relevance</div>
            <div className="card-value">{summary.high_relevance}</div>
          </div>
          <div className="summary-card highlight-red">
            <div className="card-label">Opposition Filings</div>
            <div className="card-value">{summary.opposition_count}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="filters-section">
        <div className="search-bar">
          <input
            type="text"
            placeholder="Search dockets..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
        </div>

        <div className="filter-groups">
          <div className="filter-group">
            <button
              className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              All Dockets
            </button>
            <button
              className={`filter-btn ${filter === 'following' ? 'active' : ''}`}
              onClick={() => setFilter('following')}
            >
              Following ({followedDockets.size})
            </button>
          </div>
        </div>
      </div>

      {/* Docket Cases List */}
      <div className="docket-cases-container">
        <div className="entries-count">{sortedCases.length} docket{sortedCases.length !== 1 ? 's' : ''}</div>
        <div className="docket-cases-list">
          {sortedCases.map((docketCase) => {
            const isFollowing = followedDockets.has(docketCase.deal_id);
            return (
              <div key={docketCase.deal_id} className="docket-case-card">
                <div className="case-header">
                  <div className="case-title-row">
                    <Link to={`/deal/${docketCase.deal_id}`} className="case-title">
                      {docketCase.deal_name}
                    </Link>
                    <button
                      className={`watch-btn ${isFollowing ? 'watching' : ''}`}
                      onClick={() => toggleFollow(docketCase.deal_id)}
                      title={isFollowing ? 'Unfollow this docket' : 'Follow this docket'}
                    >
                      {isFollowing ? '★' : '☆'}
                    </button>
                  </div>
                  {docketCase.docket_number && (
                    <div className="case-meta">
                      <span className="docket-number">{docketCase.docket_number}</span>
                    </div>
                  )}
                </div>

                <div className="case-stats">
                  <div className="stat-item">
                    <span className="stat-label">Total Entries</span>
                    <span className="stat-value">{docketCase.entry_count}</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">High Relevance</span>
                    <span className="stat-value highlight-red">{docketCase.high_relevance_count || 0}</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Opposition</span>
                    <span className="stat-value highlight-red">{docketCase.opposition_count || 0}</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Support</span>
                    <span className="stat-value highlight-green">{docketCase.support_count || 0}</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Latest Activity</span>
                    <span className="stat-value">{formatDate(docketCase.latest_entry_date)}</span>
                  </div>
                </div>

                <div className="case-actions">
                  <Link to={`/deal/${docketCase.deal_id}`} className="view-docket-btn">
                    View Full Docket →
                  </Link>
                </div>
              </div>
            );
          })}
        </div>

        {sortedCases.length === 0 && (
          <div className="no-entries">
            {filter === 'following'
              ? "You're not following any dockets yet. Click the ☆ to follow a docket."
              : 'No dockets found'}
          </div>
        )}
      </div>
      </>)}
    </div>
  );
}
