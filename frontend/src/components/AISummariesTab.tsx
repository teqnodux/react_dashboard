import { useState, useEffect } from 'react';
import { AISummaryResult, AISummaryResponse } from '../types/deal';

interface AISummariesTabProps {
  ticker: string;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formBadgeClass(formType: string): string {
  const normalized = formType.toLowerCase().replace(/[\/\s-]/g, '');
  if (normalized === '8k') return 'ais-badge-8k';
  if (normalized === 's4' || normalized === 's4a') return 'ais-badge-s4';
  if (normalized === '4' || normalized === 'form4') return 'ais-badge-form4';
  if (normalized === '144' || normalized === 'form144') return 'ais-badge-144';
  if (normalized.includes('sc13')) return 'ais-badge-sc13d';
  if (normalized.includes('def') || normalized.includes('proxy')) return 'ais-badge-proxy';
  if (normalized.includes('424')) return 'ais-badge-424';
  if (normalized.includes('10k') || normalized.includes('10q')) return 'ais-badge-10k';
  return 'ais-badge-default';
}

function renderL3Value(value: any, depth: number = 0): JSX.Element {
  if (value === null || value === undefined) return <span className="ais-l3-value">N/A</span>;

  if (typeof value === 'string') {
    return <span className="ais-l3-value">{value}</span>;
  }

  if (Array.isArray(value)) {
    return (
      <ul className="ais-l3-list">
        {value.map((item, i) => (
          <li key={i}>
            {typeof item === 'object' ? renderL3Value(item, depth + 1) : String(item)}
          </li>
        ))}
      </ul>
    );
  }

  if (typeof value === 'object') {
    return (
      <div className="ais-l3-nested">
        {Object.entries(value).map(([k, v]) => (
          <div key={k} className="ais-l3-field">
            <span className="ais-l3-label">{k.replace(/_/g, ' ')}</span>
            {renderL3Value(v, depth + 1)}
          </div>
        ))}
      </div>
    );
  }

  return <span className="ais-l3-value">{String(value)}</span>;
}

export default function AISummariesTab({ ticker }: AISummariesTabProps) {
  const [results, setResults] = useState<AISummaryResult[]>([]);
  const [company, setCompany] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedL2, setExpandedL2] = useState<Set<string>>(new Set());
  const [expandedL3, setExpandedL3] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!ticker) return;
    setLoading(true);
    setError(null);

    fetch(`http://localhost:8000/api/ai-summaries/${ticker}`)
      .then(res => {
        if (!res.ok) throw new Error(`Failed to fetch AI summaries`);
        return res.json();
      })
      .then((data: AISummaryResponse) => {
        const sorted = [...data.results].sort((a, b) =>
          new Date(b.date).getTime() - new Date(a.date).getTime()
        );
        setResults(sorted);
        setCompany(data.company);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [ticker]);

  const toggleL2 = (key: string) => {
    setExpandedL2(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        // Collapsing L2 auto-collapses L3
        setExpandedL3(prevL3 => {
          const nextL3 = new Set(prevL3);
          nextL3.delete(key);
          return nextL3;
        });
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleL3 = (key: string) => {
    setExpandedL3(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div className="ais-loading">
        <div className="ais-spinner"></div>
        <p>Loading AI summaries for {ticker}...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ais-error">
        <p>Failed to load AI summaries: {error}</p>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="ais-empty">
        <span className="ais-empty-icon">🤖</span>
        <h4>No AI Summaries Available</h4>
        <p>No AI-generated filing summaries found for {ticker}. Run the batch summarizer to generate them.</p>
      </div>
    );
  }

  return (
    <div className="ais-container">
      <div className="ais-header">
        <h4>AI Filing Summaries ({results.length})</h4>
        {company && <span className="ais-company">{company}</span>}
      </div>

      <div className="ais-filings-list">
        {results.map((filing) => {
          const key = `${filing.index}-${filing.date}`;
          const isL2Open = expandedL2.has(key);
          const isL3Open = expandedL3.has(key);
          const hasL2 = !!filing.summary.L2_brief;
          const hasL3 = filing.summary.L3_detailed && Object.keys(filing.summary.L3_detailed).length > 0;

          return (
            <div key={key} className={`ais-filing ${isL2Open ? 'expanded' : ''}`}>
              {/* L1 Row - Always visible */}
              <div
                className="ais-l1-row"
                onClick={() => hasL2 && toggleL2(key)}
                style={{ cursor: hasL2 ? 'pointer' : 'default' }}
              >
                <span className="ais-l1-date">{formatDate(filing.date)}</span>
                <span className={`ais-form-badge ${formBadgeClass(filing.form_type)}`}>
                  {filing.form_type}
                </span>
                <span className="ais-l1-headline">{filing.summary.L1_headline}</span>
                {hasL2 && (
                  <span className={`ais-chevron ${isL2Open ? 'open' : ''}`}>&#9656;</span>
                )}
              </div>

              {/* L2 Panel - Brief */}
              {isL2Open && hasL2 && (
                <div className="ais-l2-panel">
                  <p className="ais-l2-brief">{filing.summary.L2_brief}</p>

                  {filing.summary.items_reported && filing.summary.items_reported.length > 0 && (
                    <div className="ais-l2-items">
                      {filing.summary.items_reported.map((item, i) => (
                        <span key={i} className="ais-item-tag">{item}</span>
                      ))}
                    </div>
                  )}

                  <div className="ais-l2-actions">
                    {hasL3 && (
                      <button
                        className={`ais-l3-toggle ${isL3Open ? 'active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); toggleL3(key); }}
                      >
                        {isL3Open ? 'Hide Full Analysis' : 'Show Full Analysis'}
                      </button>
                    )}
                    {filing.url && (
                      <a
                        href={filing.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ais-sec-link"
                        onClick={(e) => e.stopPropagation()}
                      >
                        View on SEC.gov
                      </a>
                    )}
                  </div>

                  {/* L3 Panel - Full Analysis */}
                  {isL3Open && hasL3 && (
                    <div className="ais-l3-panel">
                      {Object.entries(filing.summary.L3_detailed).map(([sectionKey, sectionValue]) => (
                        <div key={sectionKey} className="ais-l3-section">
                          <h5 className="ais-l3-section-title">{sectionKey.replace(/_/g, ' ')}</h5>
                          {renderL3Value(sectionValue)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
