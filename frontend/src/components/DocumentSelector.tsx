/**
 * DocumentSelector — Document selection panel for the regulatory monitoring pipeline.
 *
 * Shows available documents for a deal. User selects which to process.
 * Replaces/extends the old "Process EDGAR Filing" panel.
 */

import { useEffect, useState } from 'react';
import './DocumentSelector.css';
import api from '../services/api';

// ── Types ────────────────────────────────────────────────────────────────────

interface AvailableDoc {
  url:               string | null;
  doc_type:          string;
  doc_date:          string | null;
  ticker:            string | null;
  description:       string;
  already_processed: boolean;
  source:            string;
  file_path?:        string;
}

interface MonitorResult {
  triage:           { relevant: boolean; reason: string; confidence: number };
  scoping:          { applicable_ids: string[]; newly_discovered: string[]; evidence: Record<string, string> } | null;
  monitor_results:  Array<{ master_id: string; new_status: string | null; status_evidence: string }>;
  merge_diff:       { status_changes: any[]; conflicts: any[]; new_approvals: string[]; no_change: string[] } | null;
  pipeline_status:  string;
}

interface Props {
  dealId:          string;
  onProcessed?:    () => void;
  endpointPrefix?: string; // "regulatory" (default) or "regulatory-monitor"
}

// ── Component ────────────────────────────────────────────────────────────────

export default function DocumentSelector({ dealId, onProcessed, endpointPrefix = 'regulatory' }: Props) {
  const [docs, setDocs]             = useState<AvailableDoc[]>([]);
  const [loading, setLoading]       = useState(true);
  const [selected, setSelected]     = useState<Set<number>>(new Set());
  const [filter, setFilter]         = useState<string>('all');
  const [processing, setProcessing] = useState(false);
  const [results, setResults]       = useState<Map<number, MonitorResult>>(new Map());
  const [errors, setErrors]         = useState<Map<number, string>>(new Map());
  const [showProcessed, setShowProcessed] = useState(false);

  // Manual URL input
  const [manualUrl, setManualUrl]   = useState('');
  const [manualDate, setManualDate] = useState('');
  const [manualType, setManualType] = useState('');

  const loadDocs = () => {
    setLoading(true);
    api.get(`/api/deals/${dealId}/${endpointPrefix}/available-documents`)
      .then(res => {
        setDocs(res.data.documents || []);
      })
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadDocs(); }, [dealId]);

  const toggleSelect = (idx: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const selectAll = () => {
    const unprocessed = docs
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => !d.already_processed);
    setSelected(new Set(unprocessed.map(({ i }) => i)));
  };

  const processSelected = async () => {
    if (selected.size === 0) return;
    setProcessing(true);
    setResults(new Map());
    setErrors(new Map());

    const newResults = new Map<number, MonitorResult>();
    const newErrors = new Map<number, string>();

    // Process in chronological order by doc_date
    const sortedIdxs = Array.from(selected).sort((a, b) => {
      const dateA = docs[a]?.doc_date || '9999';
      const dateB = docs[b]?.doc_date || '9999';
      return dateA.localeCompare(dateB);
    });
    for (const idx of sortedIdxs) {
      const doc = docs[idx];
      try {
        const { data: result } = await api.post(`/api/deals/${dealId}/${endpointPrefix}/monitor`, {
          doc_url: doc.url,
          doc_type: doc.doc_type,
          doc_date: doc.doc_date || undefined,
          file_path: (doc as any).file_path || undefined,
        });
        newResults.set(idx, result);
        setResults(new Map(newResults));
      } catch (e: any) {
        newErrors.set(idx, e.message || 'Failed');
        setErrors(new Map(newErrors));
      }
    }

    setProcessing(false);
    setSelected(new Set());
    loadDocs();
    if (onProcessed) onProcessed();
  };

  const processManual = async () => {
    if (!manualUrl) return;
    setProcessing(true);
    try {
      const { data: result } = await api.post(`/api/deals/${dealId}/${endpointPrefix}/monitor`, {
        doc_url: manualUrl,
        doc_type: manualType || 'filing',
        doc_date: manualDate || undefined,
      });
      setResults(new Map([[999, result]]));
      setManualUrl('');
      setManualDate('');
      setManualType('');
      loadDocs();
      if (onProcessed) onProcessed();
    } catch (e: any) {
      setErrors(new Map([[999, e.message || 'Failed']]));
    } finally {
      setProcessing(false);
    }
  };

  // Filter docs
  const filteredDocs = docs.filter(d => {
    if (!showProcessed && d.already_processed) return false;
    if (filter === 'all') return true;
    return d.source === filter;
  });

  const unprocessedCount = docs.filter(d => !d.already_processed).length;
  const sources = [...new Set(docs.map(d => d.source))];

  if (loading) return <div className="docselector-loading">Loading available documents...</div>;

  return (
    <div className="docselector">
      {/* Header */}
      <div className="docselector-header">
        <div className="docselector-title">Process Documents</div>
        <div className="docselector-subtitle">
          {unprocessedCount} unprocessed of {docs.length} available
        </div>
      </div>

      {/* Filter row */}
      <div className="docselector-filters">
        <button className={`ds-filter ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          All ({docs.filter(d => !d.already_processed || showProcessed).length})
        </button>
        {sources.map(s => (
          <button key={s} className={`ds-filter ${filter === s ? 'active' : ''}`} onClick={() => setFilter(s)}>
            {s.replace('_', ' ')}
          </button>
        ))}
        <label className="ds-show-processed">
          <input type="checkbox" checked={showProcessed} onChange={e => setShowProcessed(e.target.checked)} />
          Show processed
        </label>
      </div>

      {/* Document list */}
      <div className="docselector-list">
        {filteredDocs.length === 0 && (
          <div className="ds-empty">No documents to show</div>
        )}
        {filteredDocs.map((doc, _i) => {
          const realIdx = docs.indexOf(doc);
          const isSelected = selected.has(realIdx);
          const result = results.get(realIdx);
          const error = errors.get(realIdx);

          return (
            <div
              key={realIdx}
              className={`ds-doc ${doc.already_processed ? 'ds-processed' : ''} ${isSelected ? 'ds-selected' : ''}`}
              onClick={() => !doc.already_processed && toggleSelect(realIdx)}
            >
              <div className="ds-doc-left">
                {!doc.already_processed && (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(realIdx)}
                    onClick={e => e.stopPropagation()}
                    className="ds-checkbox"
                  />
                )}
                {doc.already_processed && <span className="ds-check-done">&#10003;</span>}
                <span className="ds-doc-type">{doc.doc_type}</span>
                <span className="ds-doc-date">{doc.doc_date || '—'}</span>
                {doc.ticker && <span className="ds-doc-ticker">{doc.ticker}</span>}
              </div>
              <div className="ds-doc-desc">{doc.description || ''}</div>

              {/* Result indicator */}
              {result && (
                <div className={`ds-result ds-result-${result.pipeline_status}`}>
                  {result.pipeline_status === 'irrelevant' && (
                    <span>NOT RELEVANT — {result.triage?.reason}</span>
                  )}
                  {result.pipeline_status === 'completed' && result.merge_diff && (
                    <span>
                      {result.merge_diff.status_changes.length > 0 &&
                        `${result.merge_diff.status_changes.length} status change(s) `}
                      {result.merge_diff.new_approvals.length > 0 &&
                        `+${result.merge_diff.new_approvals.length} new `}
                      {result.merge_diff.conflicts.length > 0 &&
                        `${result.merge_diff.conflicts.length} conflict(s) `}
                      {result.merge_diff.status_changes.length === 0 &&
                       result.merge_diff.new_approvals.length === 0 &&
                       result.merge_diff.conflicts.length === 0 &&
                        'No changes'}
                    </span>
                  )}
                  {result.pipeline_status === 'no_approvals_found' && (
                    <span>No approval info found</span>
                  )}
                </div>
              )}
              {error && <div className="ds-result ds-result-error">{error}</div>}
            </div>
          );
        })}
      </div>

      {/* Action buttons */}
      <div className="docselector-actions">
        {unprocessedCount > 0 && (
          <>
            <button className="ds-select-all" onClick={selectAll}>
              Select All Unprocessed
            </button>
            <button
              className="ds-process-btn"
              onClick={processSelected}
              disabled={processing || selected.size === 0}
            >
              {processing ? 'Processing...' : `Process Selected (${selected.size})`}
            </button>
          </>
        )}
      </div>

      {/* Manual URL input */}
      <div className="docselector-manual">
        <div className="ds-manual-label">Or paste an EDGAR URL:</div>
        <div className="ds-manual-row">
          <input
            className="ds-manual-url"
            type="text"
            placeholder="https://www.sec.gov/Archives/..."
            value={manualUrl}
            onChange={e => setManualUrl(e.target.value)}
          />
          <input
            className="ds-manual-date"
            type="date"
            value={manualDate}
            onChange={e => setManualDate(e.target.value)}
          />
          <select
            className="ds-manual-type"
            value={manualType}
            onChange={e => setManualType(e.target.value)}
          >
            <option value="">Auto-detect</option>
            <option value="8-K">8-K</option>
            <option value="PREM14A">PREM14A</option>
            <option value="DEFM14A">DEFM14A</option>
            <option value="S-4">S-4</option>
            <option value="6-K">6-K</option>
            <option value="press_release">Press Release</option>
          </select>
          <button
            className="ds-manual-btn"
            onClick={processManual}
            disabled={processing || !manualUrl}
          >
            {processing ? 'Processing...' : 'Process'}
          </button>
        </div>
      </div>

      {/* Results for manual URL */}
      {results.has(999) && (
        <div className="docselector-manual-result">
          <ResultSummary result={results.get(999)!} />
        </div>
      )}
      {errors.has(999) && (
        <div className="ds-result ds-result-error">{errors.get(999)}</div>
      )}
    </div>
  );
}

function ResultSummary({ result }: { result: MonitorResult }) {
  const diff = result.merge_diff;
  if (!diff) return null;

  return (
    <div className="ds-result-summary">
      {diff.status_changes.length > 0 && (
        <div className="ds-result-section">
          <div className="ds-result-label">Status Changes:</div>
          {diff.status_changes.map((sc: any, i: number) => (
            <div key={i} className="ds-result-change">
              {sc.id}: <span className="ds-from">{sc.from}</span> → <span className="ds-to">{sc.to}</span>
              {sc.type === 'jump' && <span className="ds-jump-badge">JUMP</span>}
            </div>
          ))}
        </div>
      )}
      {diff.new_approvals.length > 0 && (
        <div className="ds-result-section">
          <div className="ds-result-label">New Approvals:</div>
          <div className="ds-result-change">{diff.new_approvals.join(', ')}</div>
        </div>
      )}
      {diff.conflicts.length > 0 && (
        <div className="ds-result-section ds-result-conflicts">
          <div className="ds-result-label">Conflicts Detected:</div>
          {diff.conflicts.map((c: any, i: number) => (
            <div key={i} className="ds-result-conflict">
              {c.approval_id}: Current "{c.current_status}" vs. document says "{c.conflicting_claim}"
            </div>
          ))}
        </div>
      )}
      {diff.status_changes.length === 0 && diff.new_approvals.length === 0 && diff.conflicts.length === 0 && (
        <div className="ds-result-nochange">No changes detected</div>
      )}
    </div>
  );
}
