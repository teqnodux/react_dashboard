import { useState } from 'react';
import '../styles/MAEReview.css';

interface ClauseData {
  id: string;
  text: string;
  zone: 'typical' | 'atypical' | 'outlier';
  category: string;
  cluster_name: string;
  ratio: number;
  risk_analysis?: {
    explanation?: string;
    risk_level?: string;
    investigation_priority?: string;
    red_flags?: string[];
  };
  compliance?: {
    cybersecurity?: string;
    tariffs?: string;
    countries?: string[];
    disclosure?: string;
  };
}

interface MAEReviewProps {
  dealName: string;
  clauses: ClauseData[];
}

export default function MAEReview({ dealName, clauses }: MAEReviewProps) {
  const [filter, setFilter] = useState<string>('all');
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  // Calculate metrics
  const total = clauses.length;
  const outliers = clauses.filter(c => c.zone === 'outlier').length;
  const atypical = clauses.filter(c => c.zone === 'atypical').length;

  // Filter clauses
  const filteredClauses = filter === 'all'
    ? clauses
    : clauses.filter(c => c.zone === filter);

  const toggleDetail = (index: number) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedRows(newExpanded);
  };

  const exportData = () => {
    const dataStr = JSON.stringify({ clauses }, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${dealName}_mae_analysis.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getComplianceFlags = (compliance?: ClauseData['compliance']) => {
    if (!compliance) return [];
    const flags = [];
    if (compliance.cybersecurity === 'Yes') flags.push('Cybersecurity');
    if (compliance.tariffs === 'Yes') flags.push('Tariffs');
    if (compliance.countries && compliance.countries.length > 0) flags.push('Countries');
    if (compliance.disclosure === 'Yes') flags.push('Disclosure');
    return flags;
  };

  return (
    <div className="mae-review">
      {/* Alert Bar */}
      <div className="alert-bar">
        <span className="deal-name">{dealName}</span>
        {outliers > 0 && (
          <span className="alert-flag outliers">
            ⚠️ {outliers} OUTLIER{outliers > 1 ? 'S' : ''}
          </span>
        )}
        {atypical > 0 && (
          <span className="alert-flag atypical">
            🟡 {atypical} ATYPICAL
          </span>
        )}
        {outliers === 0 && atypical === 0 && (
          <span className="alert-flag no-flags">✓ NO FLAGS</span>
        )}
      </div>

      {/* Clause Analysis Table */}
      <div className="table-section">
        <div className="section-header">CLAUSE ANALYSIS ({total})</div>
        <div className="filters">
          <button
            className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All ({total})
          </button>
          <button
            className={`filter-btn ${filter === 'typical' ? 'active' : ''}`}
            onClick={() => setFilter('typical')}
          >
            🟢 Typical
          </button>
          <button
            className={`filter-btn ${filter === 'atypical' ? 'active' : ''}`}
            onClick={() => setFilter('atypical')}
          >
            🟡 Atypical
          </button>
          <button
            className={`filter-btn ${filter === 'outlier' ? 'active' : ''}`}
            onClick={() => setFilter('outlier')}
          >
            🔴 Outliers
          </button>
          <button className="export-btn" onClick={exportData}>
            📥 Export
          </button>
        </div>

        <table>
          <thead>
            <tr>
              <th>Clause</th>
              <th>Zone</th>
              <th>Category</th>
              <th>Cluster Match</th>
              <th>Flag</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredClauses.map((clause, index) => {
              const isFlagged = clause.zone === 'outlier' || clause.zone === 'atypical';
              const isExpanded = expandedRows.has(index);
              const compFlags = getComplianceFlags(clause.compliance);

              return (
                <>
                  <tr
                    key={index}
                    className={
                      clause.zone === 'outlier'
                        ? 'row-flagged'
                        : clause.zone === 'atypical'
                        ? 'row-atypical'
                        : 'row-typical'
                    }
                  >
                    <td><strong>{clause.id}</strong></td>
                    <td>
                      <span className={`zone-badge zone-${clause.zone}`}>
                        {clause.zone.toUpperCase()}
                      </span>
                    </td>
                    <td>
                      {clause.category.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </td>
                    <td>{clause.cluster_name}</td>
                    <td>{compFlags.join(', ') || '-'}</td>
                    <td>
                      <button className="expand-btn" onClick={() => toggleDetail(index)}>
                        {isExpanded ? 'Hide' : 'Details'}
                      </button>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className={
                      clause.zone === 'outlier'
                        ? 'row-flagged'
                        : clause.zone === 'atypical'
                        ? 'row-atypical'
                        : 'row-typical'
                    }>
                      <td colSpan={6}>
                        <div className="clause-detail">
                          {/* Full Text */}
                          <div className="detail-section">
                            <h4>Full Text</h4>
                            <p className="full-text">{clause.text}</p>
                          </div>

                          {/* Risk Analysis */}
                          {clause.risk_analysis ? (
                            <>
                              <div className="detail-section">
                                <h4>⚠️ Why Flagged</h4>
                                <p>{clause.risk_analysis.explanation || 'Unusual provision detected'}</p>
                              </div>
                              <div className="detail-section">
                                <h4>Risk Assessment</h4>
                                <p><strong>Level:</strong> {clause.risk_analysis.risk_level?.toUpperCase() || 'N/A'}</p>
                                <p><strong>Priority:</strong> {clause.risk_analysis.investigation_priority?.toUpperCase() || 'N/A'}</p>
                                {clause.risk_analysis.red_flags && clause.risk_analysis.red_flags.length > 0 && (
                                  <>
                                    <h4 style={{ marginTop: '12px' }}>Red Flags</h4>
                                    <div className="red-flags">
                                      {clause.risk_analysis.red_flags.map((flag, i) => (
                                        <span key={i} className="red-flag">✗ {flag}</span>
                                      ))}
                                    </div>
                                  </>
                                )}
                              </div>
                            </>
                          ) : isFlagged ? (
                            <div className="detail-section">
                              <h4>⚠️ Why Flagged</h4>
                              <p>
                                Distance ratio {clause.ratio.toFixed(2)} - differs significantly from typical cluster: {clause.cluster_name}
                              </p>
                            </div>
                          ) : null}

                          {/* Compliance */}
                          {clause.compliance && (
                            <div className="detail-section">
                              <h4>Compliance Checks</h4>
                              <p>🔐 Cybersecurity: {clause.compliance.cybersecurity || 'No'}</p>
                              <p>📦 Tariffs/Trade: {clause.compliance.tariffs || 'No'}</p>
                              <p>🌍 Countries: {
                                clause.compliance.countries && clause.compliance.countries.length > 0
                                  ? clause.compliance.countries.join(', ')
                                  : 'None'
                              }</p>
                              <p>📄 Disclosure Schedules: {clause.compliance.disclosure || 'No'}</p>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>

        {filteredClauses.length === 0 && (
          <div className="no-clauses">No clauses match the selected filter</div>
        )}
      </div>
    </div>
  );
}
