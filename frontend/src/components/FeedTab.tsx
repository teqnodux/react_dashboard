import { useState, useEffect } from 'react';
import api from '../services/api';

interface FeedItem {
  id: string;
  timestamp: string;
  type: string;
  title: string;
  description: string;
  importance: string;
  source: string;
  status: string;
  link: string;
}

interface FeedSummary {
  total: number;
  by_type: Record<string, number>;
}

const TYPE_LABELS: Record<string, string> = {
  sec_filing: 'SEC Filing',
  regulatory: 'Regulatory',
  docket: 'Docket',
  press_release: 'Press Release',
};

const TYPE_ICONS: Record<string, string> = {
  sec_filing: '\u25A0',
  regulatory: '\u25C6',
  docket: '\u25B2',
  press_release: '\u25CF',
};

const TYPE_COLORS: Record<string, string> = {
  sec_filing: 'var(--accent-blue)',
  regulatory: 'var(--accent-yellow)',
  docket: 'var(--accent-red)',
  press_release: 'var(--accent-green)',
};

function relativeDate(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return `in ${Math.abs(diffDays)}d`;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return '1d ago';
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export default function FeedTab({ dealId }: { dealId: string }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [summary, setSummary] = useState<FeedSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [dateRange, setDateRange] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.get(`/api/deals/${dealId}/feed`)
      .then(res => {
        setItems(res.data.items || []);
        setSummary(res.data.summary || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [dealId]);

  if (loading) {
    return <div className="placeholder"><p>Loading feed...</p></div>;
  }

  if (items.length === 0) {
    return <div className="placeholder"><p>No activity for this deal yet.</p></div>;
  }

  // Filter
  const filtered = items.filter(item => {
    if (typeFilter !== 'all' && item.type !== typeFilter) return false;
    if (dateRange !== 'all') {
      const days = parseInt(dateRange);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      if (new Date(item.timestamp) < cutoff) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      if (!item.title.toLowerCase().includes(q) && !item.description.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // Get types that exist in data
  const availableTypes = summary ? Object.keys(summary.by_type) : [];

  return (
    <div className="feed-container">
      {/* Filters */}
      <div className="feed-filters">
        <div className="feed-type-pills">
          <button
            className={`feed-pill ${typeFilter === 'all' ? 'feed-pill-active' : ''}`}
            onClick={() => setTypeFilter('all')}
          >
            All ({summary?.total || 0})
          </button>
          {availableTypes.map(t => (
            <button
              key={t}
              className={`feed-pill ${typeFilter === t ? 'feed-pill-active' : ''}`}
              onClick={() => setTypeFilter(t)}
            >
              {TYPE_LABELS[t] || t} ({summary?.by_type[t] || 0})
            </button>
          ))}
        </div>
        <div className="feed-right-filters">
          <select
            className="feed-date-select"
            value={dateRange}
            onChange={e => setDateRange(e.target.value)}
          >
            <option value="7">Last 7d</option>
            <option value="30">Last 30d</option>
            <option value="90">Last 90d</option>
            <option value="365">Last year</option>
            <option value="all">All time</option>
          </select>
          <input
            className="feed-search"
            type="text"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Items */}
      <div className="feed-list">
        {filtered.length === 0 ? (
          <div className="feed-empty">No items match filters.</div>
        ) : (
          filtered.map(item => {
            const isOpen = expanded.has(item.id);
            return (
              <div
                key={item.id}
                className={`feed-item ${isOpen ? 'feed-item-expanded' : ''}`}
                onClick={() => setExpanded(prev => {
                  const next = new Set(prev);
                  next.has(item.id) ? next.delete(item.id) : next.add(item.id);
                  return next;
                })}
              >
                <span
                  className="feed-item-icon"
                  style={{ color: TYPE_COLORS[item.type] || 'var(--text-muted)' }}
                >
                  {TYPE_ICONS[item.type] || '\u25CF'}
                </span>
                <div className="feed-item-content">
                  <div className="feed-item-header">
                    <span className="feed-item-title">
                      {item.link ? (
                        <a href={item.link} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>{item.title}</a>
                      ) : item.title}
                    </span>
                    <span className="feed-type-badge" style={{ color: TYPE_COLORS[item.type] }}>
                      {TYPE_LABELS[item.type] || item.type}
                    </span>
                    {item.status && item.status !== 'completed' && (
                      <span className={`feed-status-badge feed-status-${item.status}`}>
                        {item.status.toUpperCase()}
                      </span>
                    )}
                  </div>
                  {isOpen && item.description && (
                    <div className="feed-item-detail">{item.description}</div>
                  )}
                  {item.source && (
                    <span className="feed-item-source">{item.source}</span>
                  )}
                </div>
                <div className="feed-item-date">
                  {formatDate(item.timestamp)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
