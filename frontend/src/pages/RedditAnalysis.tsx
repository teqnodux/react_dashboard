import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import '../styles/RedditAnalysis.css';
import api from '../services/api';

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
  analysis_type: string;
  used_research_brief: boolean;
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

export default function RedditAnalysis() {
  const [data, setData] = useState<RedditAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedTiers, setExpandedTiers] = useState<Set<number>>(new Set([1, 2, 3]));
  const [expandedConcepts, setExpandedConcepts] = useState<Set<string>>(new Set());
  const [expandedFindings, setExpandedFindings] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.get(`/api/reddit-analysis`)
      .then(res => {
        setData(res.data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load Reddit analysis:', err);
        setLoading(false);
      });
  }, []);

  const toggleTier = (tier: number) => {
    const newExpanded = new Set(expandedTiers);
    if (newExpanded.has(tier)) {
      newExpanded.delete(tier);
    } else {
      newExpanded.add(tier);
    }
    setExpandedTiers(newExpanded);
  };

  const toggleConcept = (concept: string) => {
    const newExpanded = new Set(expandedConcepts);
    if (newExpanded.has(concept)) {
      newExpanded.delete(concept);
    } else {
      newExpanded.add(concept);
    }
    setExpandedConcepts(newExpanded);
  };

  const toggleFinding = (id: string) => {
    const newExpanded = new Set(expandedFindings);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedFindings(newExpanded);
  };

  const getCategoryName = (category: string) => {
    const letter = category.split(' ')[0].replace('-', '').trim();
    const categoryMap: Record<string, { name: string; icon: string; color: string }> = {
      'A': { name: 'Next Bestness (Merging Parties)', icon: '🎯', color: '#dc2626' },
      'B': { name: 'Head-to-Head Competition', icon: '⚔️', color: '#dc2626' },
      'C': { name: 'Market Concentration', icon: '📊', color: '#dc2626' },
      'D': { name: 'Post-Merger Concerns', icon: '⚠️', color: '#dc2626' },
      'E': { name: 'Switching Costs', icon: '🔒', color: '#d97706' },
      'F': { name: 'Limited Alternatives', icon: '🔒', color: '#d97706' },
      'G': { name: 'Pricing & Negotiations', icon: '💰', color: '#d97706' },
      'H': { name: 'Customer Complaints', icon: '🔒', color: '#d97706' },
      'I': { name: 'Competitor Comparison', icon: '🔄', color: '#d97706' },
      'J': { name: 'Industry Insider', icon: '👤', color: '#2563eb' },
      'K': { name: 'Product Differentiation', icon: '🗺️', color: '#2563eb' },
      'L': { name: 'Entry Barriers', icon: '🗺️', color: '#2563eb' },
    };
    return categoryMap[letter] || { name: category, icon: '📌', color: '#666' };
  };

  const groupByCategory = (findings: RedditFinding[]) => {
    const grouped: Record<string, RedditFinding[]> = {};
    findings.forEach(finding => {
      const letter = finding.category.split(' ')[0].replace('-', '').trim();
      const categoryInfo = getCategoryName(finding.category);
      const key = categoryInfo.name;
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(finding);
    });
    return grouped;
  };

  const filterFindings = (findings: RedditFinding[]) => {
    if (!searchQuery) return findings;
    const query = searchQuery.toLowerCase();
    return findings.filter(f =>
      f.text.toLowerCase().includes(query) ||
      f.evidence_quote.toLowerCase().includes(query) ||
      f.why_it_matters.toLowerCase().includes(query) ||
      f.post_title.toLowerCase().includes(query)
    );
  };

  if (loading) {
    return (
      <div className="reddit-analysis">
        <div className="top-nav">
          <Link to="/pipeline" className="nav-tab">Pipeline</Link>
          <Link to="/activity" className="nav-tab">Activity Feed</Link>
          <Link to="/all-dockets" className="nav-tab">Dockets</Link>
          <Link to="/regulatory" className="nav-tab">Regulatory</Link>
          <Link to="/reddit" className="nav-tab active">Reddit Analysis</Link>
        </div>
        <div className="loading">Loading Reddit analysis...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="reddit-analysis">
        <div className="top-nav">
          <Link to="/pipeline" className="nav-tab">Pipeline</Link>
          <Link to="/activity" className="nav-tab">Activity Feed</Link>
          <Link to="/all-dockets" className="nav-tab">Dockets</Link>
          <Link to="/regulatory" className="nav-tab">Regulatory</Link>
          <Link to="/reddit" className="nav-tab active">Reddit Analysis</Link>
        </div>
        <div className="no-data">No Reddit analysis data available</div>
      </div>
    );
  }

  const tiers = [
    {
      key: 1,
      title: 'Regulatory Red Flags',
      desc: 'Evidence that could trigger regulatory scrutiny or support a challenge to the merger',
      findings: filterFindings(data.results.tier1_high_value),
      count: data.tier1_high_value,
      color: 'tier-red'
    },
    {
      key: 2,
      title: 'Deal Context',
      desc: 'Evidence about competitive dynamics, switching costs, and market alternatives',
      findings: filterFindings(data.results.tier2_medium_value),
      count: data.tier2_medium_value,
      color: 'tier-yellow'
    },
    {
      key: 3,
      title: 'Market Background',
      desc: 'Industry context and market definition evidence',
      findings: filterFindings(data.results.tier3_supporting),
      count: data.tier3_supporting,
      color: 'tier-blue'
    }
  ];

  return (
    <div className="reddit-analysis">
      {/* Top Navigation */}
      <div className="top-nav">
        <Link to="/pipeline" className="nav-tab">Pipeline</Link>
        <Link to="/activity" className="nav-tab">Activity Feed</Link>
        <Link to="/all-dockets" className="nav-tab">Dockets</Link>
        <Link to="/regulatory" className="nav-tab">Regulatory</Link>
        <Link to="/reddit" className="nav-tab active">Reddit Analysis</Link>
      </div>

      <div className="container">
        {/* Header */}
        <header className="reddit-header">
          <h1>Reddit Antitrust Analysis</h1>
          <div className="subtitle">{data.merger}</div>
        </header>

        {/* Stats */}
        <div className="stats">
          <div className="stat-card">
            <div className="number">{data.total_items.toLocaleString()}</div>
            <div className="label">Total Items</div>
          </div>
          <div className="stat-card">
            <div className="number">{data.filtered_items.toLocaleString()}</div>
            <div className="label">Filtered</div>
          </div>
          <div className="stat-card">
            <div className="number">{data.relevant_items}</div>
            <div className="label">Relevant</div>
          </div>
          <div className="stat-card">
            <div className="number">{data.tier1_high_value}</div>
            <div className="label">High Value</div>
          </div>
        </div>

        {/* Search */}
        <div className="search-bar">
          <input
            type="text"
            placeholder="Search findings..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Tiers */}
        {tiers.map(tier => {
          if (tier.count === 0) return null;

          const grouped = groupByCategory(tier.findings);

          return (
            <div key={tier.key} className={`tier-section ${tier.color}`}>
              <div className="tier-header" onClick={() => toggleTier(tier.key)}>
                <div className="tier-info">
                  <div className="tier-title">{tier.title} ({tier.count})</div>
                  <div className="tier-desc">{tier.desc}</div>
                </div>
                <span className="toggle">{expandedTiers.has(tier.key) ? '▼' : '▶'}</span>
              </div>

              {expandedTiers.has(tier.key) && (
                <div className="tier-content">
                  {Object.entries(grouped).map(([conceptName, conceptFindings]) => {
                    const categoryInfo = getCategoryName(conceptFindings[0].category);

                    return (
                      <div key={conceptName} className="concept-group">
                        <div className="concept-header" onClick={() => toggleConcept(conceptName)}>
                          <div className="concept-title">
                            <span className="icon">{categoryInfo.icon}</span>
                            <span className="name">{conceptName}</span>
                          </div>
                          <span className="count">{conceptFindings.length}</span>
                        </div>

                        {expandedConcepts.has(conceptName) && (
                          <div className="concept-items">
                            {conceptFindings.map((finding, idx) => {
                              const findingId = `${conceptName}-${idx}`;
                              const isExpanded = expandedFindings.has(findingId);

                              return (
                                <div key={idx} className={`finding-card ${tier.color}`}>
                                  <div className="finding-summary" onClick={() => toggleFinding(findingId)}>
                                    <div className="evidence-preview">
                                      "{finding.evidence_quote.substring(0, 150)}
                                      {finding.evidence_quote.length > 150 ? '...' : ''}"
                                    </div>
                                    <div className="finding-meta">
                                      <span className={`confidence ${finding.confidence}`}>
                                        {finding.confidence}
                                      </span>
                                      <span className="expand-icon">{isExpanded ? '▲' : '▼'}</span>
                                    </div>
                                  </div>

                                  {isExpanded && (
                                    <div className="finding-details">
                                      <div className="why-matters">
                                        <strong>Why It Matters:</strong> {finding.why_it_matters}
                                      </div>

                                      <div className="thread-context">
                                        <div className="context-label">Reddit Context:</div>
                                        <div className="reddit-thread">
                                          <div className="reddit-post">
                                            <div className="post-header">
                                              <span className="post-title">📝 {finding.post_title}</span>
                                              {finding.item_type === 'post' && (
                                                <span className="flagged-badge">⚑ FLAGGED POST</span>
                                              )}
                                            </div>
                                            {finding.item_type === 'comment' ? (
                                              <div className="comments-section">
                                                <div className="comment flagged">
                                                  <div className="comment-meta">
                                                    <span className="flagged-badge">⚑ FLAGGED COMMENT</span>
                                                  </div>
                                                  <div className="comment-body">{finding.text}</div>
                                                </div>
                                              </div>
                                            ) : (
                                              <div className="post-body">{finding.text}</div>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
