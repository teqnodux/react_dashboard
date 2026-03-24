import { useState, useEffect } from 'react';
import '../styles/DealReddit.css';
import { API_BASE_URL } from '../config';

interface RedditFinding {
  relevant: boolean;
  tier: number;
  category: string;
  evidence_quote: string;
  why_it_matters: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  item_id: string;
  item_type: 'post' | 'comment';
  text: string;
  post_title: string;
}

interface RedditAnalysisData {
  merger: string;
  total_items: number;
  filtered_items: number;
  relevant_items: number;
  tier1_high_value: number;
  tier2_medium_value: number;
  tier3_supporting: number;
  results: {
    tier1_high_value: RedditFinding[];
    tier2_medium_value: RedditFinding[];
    tier3_supporting: RedditFinding[];
  };
}

interface DealRedditAnalysisProps {
  dealId: string;
}

export default function DealRedditAnalysis({ dealId }: DealRedditAnalysisProps) {
  const [data, setData] = useState<RedditAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFindings, setExpandedFindings] = useState<Set<string>>(new Set());
  const [filterTier, setFilterTier] = useState<number | 'all'>('all');

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/deals/${dealId}/reddit`)
      .then(res => {
        if (!res.ok) {
          throw new Error('No Reddit analysis available for this deal');
        }
        return res.json();
      })
      .then(data => {
        setData(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [dealId]);

  const toggleFinding = (id: string) => {
    const newExpanded = new Set(expandedFindings);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedFindings(newExpanded);
  };

  const getCategoryIcon = (category: string) => {
    const letter = category.split(' ')[0].replace('-', '').trim();
    const iconMap: Record<string, string> = {
      'A': '🎯', 'B': '⚔️', 'C': '📊', 'D': '⚠️',
      'E': '🔒', 'F': '🔒', 'G': '💰', 'H': '🔒',
      'I': '🔄', 'J': '👤', 'K': '🗺️', 'L': '🗺️'
    };
    return iconMap[letter] || '📌';
  };

  const getAllFindings = () => {
    if (!data) return [];
    const all = [
      ...data.results.tier1_high_value,
      ...data.results.tier2_medium_value,
      ...data.results.tier3_supporting
    ];
    if (filterTier === 'all') return all;
    return all.filter(f => f.tier === filterTier);
  };

  if (loading) {
    return <div className="deal-reddit-loading">Loading Reddit analysis...</div>;
  }

  if (error || !data) {
    return (
      <div className="deal-reddit-empty">
        <p>📭 No Reddit analysis available for this deal</p>
        <p className="muted">Reddit antitrust analysis helps identify competitive concerns from social media discussions.</p>
      </div>
    );
  }

  const findings = getAllFindings();

  return (
    <div className="deal-reddit-analysis">
      {/* Summary Stats */}
      <div className="reddit-summary">
        <div className="summary-stat">
          <span className="stat-value">{data.total_items.toLocaleString()}</span>
          <span className="stat-label">Posts/Comments Analyzed</span>
        </div>
        <div className="summary-stat">
          <span className="stat-value">{data.filtered_items.toLocaleString()}</span>
          <span className="stat-label">Keyword Filtered</span>
        </div>
        <div className="summary-stat highlight">
          <span className="stat-value">{data.relevant_items}</span>
          <span className="stat-label">Antitrust Relevant</span>
        </div>
      </div>

      {/* Tier Filter */}
      <div className="tier-filters">
        <button
          className={`tier-filter-btn ${filterTier === 'all' ? 'active' : ''}`}
          onClick={() => setFilterTier('all')}
        >
          All ({data.relevant_items})
        </button>
        <button
          className={`tier-filter-btn tier-red ${filterTier === 1 ? 'active' : ''}`}
          onClick={() => setFilterTier(1)}
        >
          🔴 High Value ({data.tier1_high_value})
        </button>
        <button
          className={`tier-filter-btn tier-yellow ${filterTier === 2 ? 'active' : ''}`}
          onClick={() => setFilterTier(2)}
        >
          🟡 Deal Context ({data.tier2_medium_value})
        </button>
        <button
          className={`tier-filter-btn tier-blue ${filterTier === 3 ? 'active' : ''}`}
          onClick={() => setFilterTier(3)}
        >
          🔵 Background ({data.tier3_supporting})
        </button>
      </div>

      {/* Findings List */}
      <div className="findings-list">
        {findings.map((finding, idx) => {
          const findingId = `finding-${idx}`;
          const isExpanded = expandedFindings.has(findingId);
          const tierClass = finding.tier === 1 ? 'tier-red' : finding.tier === 2 ? 'tier-yellow' : 'tier-blue';

          return (
            <div key={idx} className={`reddit-finding ${tierClass}`}>
              <div className="finding-header" onClick={() => toggleFinding(findingId)}>
                <div className="finding-icon">{getCategoryIcon(finding.category)}</div>
                <div className="finding-preview">
                  <div className="finding-category">{finding.category}</div>
                  <div className="finding-quote">"{finding.evidence_quote.substring(0, 120)}..."</div>
                </div>
                <span className={`confidence-badge ${finding.confidence}`}>{finding.confidence}</span>
                <span className="expand-icon">{isExpanded ? '▲' : '▼'}</span>
              </div>

              {isExpanded && (
                <div className="finding-details">
                  <div className="detail-section">
                    <h4>Full Evidence</h4>
                    <p className="evidence-text">"{finding.evidence_quote}"</p>
                  </div>

                  <div className="detail-section">
                    <h4>Why It Matters</h4>
                    <p>{finding.why_it_matters}</p>
                  </div>

                  <div className="detail-section">
                    <h4>Source</h4>
                    <div className="source-info">
                      <span className="source-type">{finding.item_type === 'post' ? '📝 Post' : '💬 Comment'}</span>
                      <span className="source-title">{finding.post_title}</span>
                    </div>
                    <div className="source-text">{finding.text.substring(0, 300)}...</div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {findings.length === 0 && (
        <div className="no-findings">No findings in this tier</div>
      )}
    </div>
  );
}
