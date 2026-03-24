import { Fragment, useEffect, useState } from 'react';
import './RegulatoryTab.css';
import StatusProgression from './StatusProgression';
import DocumentSelector from './DocumentSelector';
import { API_BASE_URL } from '../config';

// ── Types ──────────────────────────────────────────────────────────────────────

interface LinkedDoc {
  doc_type:  string;
  doc_date:  string | null;
  doc_url:   string | null;
  summary:   string;
  L1:        string | null;
  L2:        string | null;
  L3:        Record<string, any> | null;
}

interface DeadlineInfo {
  days_in_status?:      number;
  days_until_outside?:  number;
  days_in_review?:      number;
  days_to_clear?:       number;
  is_overdue?:          boolean;
  overdue_days?:        number;
  overdue_reason?:      string;
  expected_decision_by?: string;
}

interface StatusHistoryEntry {
  status:          string;
  status_legacy:   string;
  date:            string | null;
  source_doc:      string;
  source_doc_type: string;
  source_url:      string | null;
  excerpt:         string | null;
  detected_at:     string;
}

interface ConflictEntry {
  id:                string;
  detected_at:       string;
  current_status:    string;
  conflicting_claim: string;
  source_doc:        string;
  source_url:        string | null;
  excerpt:           string | null;
  resolved:          boolean;
  resolution:        string | null;
  resolved_at:       string | null;
}

interface MasterApproval {
  id:   string;
  name: string;
  monitoring: {
    status_states:    string[];
    key_questions:    string[];
    typical_timeline: string;
    closing_trigger:  string;
  };
}

interface RegulatoryApproval {
  id:                    string;
  master_id?:            string;
  jurisdiction:          string | null;
  authority_short:       string;
  authority_full:        string;
  statute:               string | null;
  category:              string;
  status:                string;
  status_detail?:        string;
  filing_key:            string;
  filed_date:            string | null;
  cleared_date:          string | null;
  expected_filing_period: string | null;
  conditions:            string | null;
  notes:                 string;
  source_doc:            string;
  source_doc_type:       string;
  source_doc_url:        string | null;
  first_seen_date:       string;
  linked_docs?:          LinkedDoc[];
  _deadline?:            DeadlineInfo;
  status_history?:       StatusHistoryEntry[];
  conflicts?:            ConflictEntry[];
  tracker_fields?:       Record<string, any>;
}

interface ChangeEntry {
  type:        string;
  approval_id: string;
  detail:      string;
  from?:       string;
  to?:         string;
}

interface ChangeLogEntry {
  timestamp:       string;
  source_doc:      string;
  source_doc_type: string;
  changes:         ChangeEntry[];
}

interface DocumentProcessed {
  doc_type:        string;
  doc_date:        string | null;
  doc_url:         string | null;
  processed_at:    string;
  approvals_found: number;
  additions:       string[];
  status_changes:  string[];
}

interface RegulatoryData {
  deal_id:              string;
  last_updated:         string;
  approvals:            RegulatoryApproval[];
  documents_processed:  DocumentProcessed[];
  change_log:           ChangeLogEntry[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(s: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTs(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const CATEGORY_LABELS: Record<string, string> = {
  antitrust:         'ANTITRUST',
  foreign_investment: 'FOREIGN INVESTMENT',
  sector_specific:   'SECTOR-SPECIFIC',
  other:             'OTHER',
};

const CATEGORY_ORDER = ['antitrust', 'foreign_investment', 'sector_specific', 'other'];

const DOC_TYPE_COLORS: Record<string, string> = {
  '6K': '#5ccfe6',
  '8K': '#5ccfe6',
  'proxy': '#ffcc66',
  'PREM14A': '#ffcc66',
  'DEFM14A': '#ffcc66',
  'press_release': '#87d96c',
  'dma_extract': '#c3a6ff',
  'summary': '#b0bec5',
};

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ status, statusDetail }: { status: string; statusDetail?: string }) {
  const map: Record<string, string> = {
    cleared:                 'badge-green',
    cleared_with_conditions: 'badge-green',
    filed:                   'badge-blue',
    under_review:            'badge-blue',
    filing_intent:           'badge-yellow',
    pending:                 'badge-yellow',
    phase2:                  'badge-orange',
    blocked:                 'badge-red',
    withdrawn:               'badge-muted',
    not_required:            'badge-muted',
  };
  const cls = map[status] || 'badge-muted';
  const labels: Record<string, string> = {
    cleared:                 'CLEARED',
    cleared_with_conditions: 'CLEARED*',
    filed:                   'FILED',
    under_review:            'REVIEW',
    filing_intent:           'INTENT',
    pending:                 'PENDING',
    phase2:                  'PHASE 2',
    blocked:                 'BLOCKED',
    withdrawn:               'WITHDRAWN',
    not_required:            'N/A',
  };
  const displayText = statusDetail || labels[status] || status.toUpperCase();
  return (
    <span className={`reg-badge ${cls}`} title={statusDetail || ''}>
      {displayText.length > 18 ? (labels[status] || status.toUpperCase()) : displayText}
    </span>
  );
}

// ── Deadline cell ──────────────────────────────────────────────────────────────

function DeadlineCell({ approval }: { approval: RegulatoryApproval }) {
  const dl = approval._deadline;
  if (!dl) return <td className="reg-deadline-cell"><span className="reg-muted">—</span></td>;

  const status = approval.status;

  // Cleared — show how many days it took
  if ((status === 'cleared' || status === 'cleared_with_conditions') && dl.days_to_clear != null) {
    return (
      <td className="reg-deadline-cell">
        <span className="deadline-cleared">{dl.days_to_clear}d</span>
      </td>
    );
  }

  // Overdue
  if (dl.is_overdue && dl.overdue_days != null) {
    return (
      <td className="reg-deadline-cell">
        <span className="deadline-overdue">{dl.overdue_days}d overdue</span>
      </td>
    );
  }

  // In review
  if (dl.days_in_review != null) {
    return (
      <td className="reg-deadline-cell">
        <span className="deadline-review">Day {dl.days_in_review}</span>
      </td>
    );
  }

  // Pending — days since first seen
  if (dl.days_in_status != null && (status === 'pending' || status === 'filing_intent')) {
    return (
      <td className="reg-deadline-cell">
        <span className="deadline-pending">{dl.days_in_status}d</span>
      </td>
    );
  }

  return <td className="reg-deadline-cell"><span className="reg-muted">—</span></td>;
}

// ── Linked doc card ────────────────────────────────────────────────────────────

function LinkedDocCard({ doc }: { doc: LinkedDoc }) {
  const [l3Open, setL3Open] = useState(false);
  const badgeColor = DOC_TYPE_COLORS[doc.doc_type] || '#b0bec5';

  return (
    <div className="linked-doc">
      <div className="linked-doc-header">
        <span className="linked-doc-badge" style={{ borderColor: badgeColor, color: badgeColor }}>
          {doc.doc_type.toUpperCase()}
        </span>
        <span className="linked-doc-date">{fmtDate(doc.doc_date)}</span>
        {doc.doc_url && (
          <a href={doc.doc_url} target="_blank" rel="noopener noreferrer" className="linked-doc-link">
            View Source
          </a>
        )}
      </div>

      {doc.L1 && <div className="linked-doc-l1">{doc.L1}</div>}
      {doc.L2 && <div className="linked-doc-l2">{doc.L2}</div>}
      {!doc.L1 && !doc.L2 && doc.summary && <div className="linked-doc-l2">{doc.summary}</div>}

      {doc.L3 && typeof doc.L3 === 'object' && Object.keys(doc.L3).length > 0 && (
        <>
          <button className="linked-doc-l3-toggle" onClick={() => setL3Open(o => !o)}>
            {l3Open ? '▼ Hide Details' : '▶ Full Details'}
          </button>
          {l3Open && (
            <div className="linked-doc-l3">
              {Object.entries(doc.L3).map(([key, val]) => {
                if (!val) return null;
                const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                return (
                  <div key={key} className="l3-field">
                    <span className="l3-label">{label}:</span>
                    <span className="l3-value">
                      {Array.isArray(val) ? val.join('; ') : String(val)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Approval detail panel ──────────────────────────────────────────────────────

function ApprovalDetail({ approval, masterDef }: { approval: RegulatoryApproval; masterDef?: MasterApproval | null }) {
  const dl = approval._deadline;
  const docs = approval.linked_docs || [];
  const history = approval.status_history || [];
  const unresolvedConflicts = (approval.conflicts || []).filter(c => !c.resolved);
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="approval-detail">
      {/* Status progression bar */}
      {masterDef && masterDef.monitoring?.status_states?.length > 0 && (
        <div className="approval-detail-section">
          <StatusProgression
            states={masterDef.monitoring.status_states}
            currentStatus={approval.status_detail || approval.status}
            statusHistory={history}
          />
        </div>
      )}

      {/* Conflict banner */}
      {unresolvedConflicts.length > 0 && (
        <div className="approval-detail-section conflict-banner">
          <div className="conflict-banner-header">
            <span className="conflict-icon">&#9888;</span>
            {unresolvedConflicts.length} Conflicting Information Detected
          </div>
          {unresolvedConflicts.map(c => (
            <div key={c.id} className="conflict-item">
              <div className="conflict-detail">
                Current: <strong>{c.current_status}</strong> &mdash; Document says: <strong>{c.conflicting_claim}</strong>
              </div>
              <div className="conflict-source">
                Source: {c.source_doc} {c.excerpt && <span className="conflict-excerpt">"{c.excerpt.slice(0, 100)}..."</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Source documents */}
      {docs.length > 0 && (
        <div className="approval-detail-section">
          <div className="approval-detail-label">Source Documents</div>
          <div className="linked-docs-list">
            {docs.map((doc, i) => (
              <LinkedDocCard key={i} doc={doc} />
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      {approval.notes && (
        <div className="approval-detail-section">
          <div className="approval-detail-label">Notes</div>
          <div className="approval-detail-text">{approval.notes}</div>
        </div>
      )}

      {/* Deadline status */}
      {dl && (
        <div className="approval-detail-section">
          <div className="approval-detail-label">Deadline Status</div>
          <div className="deadline-detail-grid">
            {approval.filed_date && (
              <div className="deadline-detail-item">
                <span className="deadline-detail-key">Filed:</span>
                <span className="deadline-detail-val">{fmtDate(approval.filed_date)}</span>
              </div>
            )}
            {dl.days_in_review != null && (
              <div className="deadline-detail-item">
                <span className="deadline-detail-key">In review:</span>
                <span className="deadline-detail-val">Day {dl.days_in_review}</span>
              </div>
            )}
            {dl.days_to_clear != null && (
              <div className="deadline-detail-item">
                <span className="deadline-detail-key">Cleared in:</span>
                <span className="deadline-detail-val deadline-cleared">{dl.days_to_clear} days</span>
              </div>
            )}
            {dl.expected_decision_by && (
              <div className="deadline-detail-item">
                <span className="deadline-detail-key">Expected by:</span>
                <span className="deadline-detail-val">{fmtDate(dl.expected_decision_by)}</span>
              </div>
            )}
            {dl.is_overdue && dl.overdue_reason && (
              <div className="deadline-detail-item deadline-detail-overdue">
                <span className="deadline-detail-key">Overdue:</span>
                <span className="deadline-detail-val">{dl.overdue_days}d — {dl.overdue_reason}</span>
              </div>
            )}
            {dl.days_until_outside != null && (
              <div className="deadline-detail-item">
                <span className="deadline-detail-key">Outside date:</span>
                <span className="deadline-detail-val">{dl.days_until_outside} days away</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Conditions */}
      {approval.conditions && (
        <div className="approval-detail-section">
          <div className="approval-detail-label">Conditions</div>
          <div className="approval-detail-text">{approval.conditions}</div>
        </div>
      )}

      {/* Status History Timeline */}
      {history.length > 1 && (
        <div className="approval-detail-section">
          <button className="approval-history-toggle" onClick={() => setHistoryOpen(o => !o)}>
            Status History ({history.length} entries) {historyOpen ? '▲' : '▼'}
          </button>
          {historyOpen && (
            <div className="approval-history-list">
              {[...history].reverse().map((h, i) => (
                <div key={i} className="history-entry">
                  <span className="history-status">{h.status}</span>
                  <span className="history-date">{h.date ? fmtDate(h.date) : '—'}</span>
                  <span className="history-source">{h.source_doc}</span>
                  {h.excerpt && <div className="history-excerpt">"{h.excerpt.slice(0, 150)}"</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props { dealId: string; onProcessed?: () => void; }

export default function RegulatoryTab({ dealId, onProcessed }: Props) {
  const [data,        setData]        = useState<RegulatoryData | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [catFilter,   setCatFilter]   = useState<string>('all');
  const [logOpen,     setLogOpen]     = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [masterDefs,  setMasterDefs]  = useState<Record<string, MasterApproval>>({});

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const load = () => {
    setLoading(true);
    fetch(`${API_BASE_URL}/api/deals/${dealId}/regulatory`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setData(await r.json());
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [dealId]);

  // Fetch master approval definitions (once)
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/regulatory/master-approvals`)
      .then(async r => {
        if (!r.ok) return;
        const d = await r.json();
        const map: Record<string, MasterApproval> = {};
        for (const ap of d.approvals || []) {
          map[ap.id] = ap;
        }
        setMasterDefs(map);
      })
      .catch(() => {});
  }, []);

  if (loading) return <div className="reg-loading">Loading regulatory data…</div>;

  if (!data || data.approvals.length === 0) {
    return (
      <div className="reg-empty">
        <p>No regulatory data found for this deal.</p>
        <p className="reg-hint">Regulatory data is auto-seeded when a DMA Timeline is generated, or process a document below.</p>
        <DocumentSelector dealId={dealId} onProcessed={() => { load(); onProcessed?.(); }} />
      </div>
    );
  }

  // First document in processed list = the "initial" document
  const initialDocDate = data.documents_processed[0]?.processed_at?.slice(0, 10);
  const isNew = (a: RegulatoryApproval) => a.first_seen_date > (initialDocDate || '');

  // Summary counts
  const cleared  = data.approvals.filter(a => a.status === 'cleared' || a.status === 'cleared_with_conditions').length;
  const filed    = data.approvals.filter(a => a.status === 'filed' || a.status === 'under_review').length;
  const phase2   = data.approvals.filter(a => a.status === 'phase2').length;
  const pending  = data.approvals.filter(a => a.status === 'pending' || a.status === 'filing_intent').length;
  const blocked  = data.approvals.filter(a => a.status === 'blocked').length;
  const total    = data.approvals.filter(a => a.status !== 'not_required').length;
  const overdue  = data.approvals.filter(a => a._deadline?.is_overdue).length;

  const categories = CATEGORY_ORDER.filter(cat => data.approvals.some(a => a.category === cat));

  const filteredApprovals = catFilter === 'all'
    ? data.approvals
    : data.approvals.filter(a => a.category === catFilter);

  return (
    <div className="reg-tab">

      {/* ── Summary chips ── */}
      <div className="reg-summary-bar">
        {cleared  > 0 && <span className="reg-chip chip-green">{cleared} CLEARED</span>}
        {filed    > 0 && <span className="reg-chip chip-blue">{filed} FILED</span>}
        {phase2   > 0 && <span className="reg-chip chip-orange">{phase2} PHASE 2</span>}
        {pending  > 0 && <span className="reg-chip chip-yellow">{pending} PENDING</span>}
        {blocked  > 0 && <span className="reg-chip chip-red">{blocked} BLOCKED</span>}
        {overdue  > 0 && <span className="reg-chip chip-red">{overdue} OVERDUE</span>}
        <span className="reg-chip chip-muted">{total} TOTAL</span>
        <span className="reg-updated">Updated {fmtDate(data.last_updated)}</span>
      </div>

      {/* ── Category filter ── */}
      {categories.length > 1 && (
        <div className="reg-filters">
          <button className={`reg-filter-btn ${catFilter === 'all' ? 'active' : ''}`} onClick={() => setCatFilter('all')}>
            All
          </button>
          {categories.map(cat => (
            <button key={cat}
              className={`reg-filter-btn ${catFilter === cat ? 'active' : ''}`}
              onClick={() => setCatFilter(cat)}
            >
              {CATEGORY_LABELS[cat] || cat}
            </button>
          ))}
        </div>
      )}

      {/* ── Approvals table grouped by category ── */}
      {(catFilter === 'all' ? categories : [catFilter]).map(cat => {
        const rows = filteredApprovals.filter(a => a.category === cat);
        if (rows.length === 0) return null;
        return (
          <div key={cat} className="reg-section">
            <div className="reg-section-hdr">{CATEGORY_LABELS[cat] || cat.toUpperCase()}</div>
            <table className="reg-table">
              <thead>
                <tr>
                  <th>Jurisdiction</th>
                  <th>Authority</th>
                  <th>Statute</th>
                  <th>Status</th>
                  <th>Filed / Expected</th>
                  <th>Cleared</th>
                  <th>Days</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(a => {
                  const isExpanded = expandedIds.has(a.id);
                  const hasDetail = (a.linked_docs && a.linked_docs.length > 0) || a.notes || a._deadline || a.master_id || (a.status_history && a.status_history.length > 1) || (a.conflicts && a.conflicts.length > 0);
                  return (
                    <Fragment key={a.id}>
                      <tr
                        className={`reg-row reg-row-${a.status} ${hasDetail ? 'reg-row-expandable' : ''} ${isExpanded ? 'reg-row-expanded' : ''}`}
                        onClick={() => hasDetail && toggleExpand(a.id)}
                      >
                        <td>{a.jurisdiction || '—'}</td>
                        <td>
                          <span className="reg-auth-short">
                            {hasDetail && <span className="reg-expand-arrow">{isExpanded ? '▼' : '▶'}</span>}
                            {a.authority_short}
                          </span>
                          {a.authority_full && a.authority_full !== a.authority_short && (
                            <span className="reg-auth-full">{a.authority_full}</span>
                          )}
                        </td>
                        <td className="reg-statute">{a.statute || '—'}</td>
                        <td>
                          <StatusBadge status={a.status} statusDetail={a.status_detail} />
                          {a.conditions && <span className="reg-conditions" title={a.conditions}>*</span>}
                          {a.conflicts && a.conflicts.some(c => !c.resolved) && (
                            <span className="reg-conflict-icon" title="Conflicting information detected">&#9888;</span>
                          )}
                        </td>
                        <td className="reg-date-cell">
                          {a.filed_date
                            ? <span className="reg-date-filed">{fmtDate(a.filed_date)}</span>
                            : a.expected_filing_period
                              ? <span className="reg-date-expected">{a.expected_filing_period}</span>
                              : <span className="reg-muted">—</span>
                          }
                        </td>
                        <td className="reg-date-cell">
                          {a.cleared_date
                            ? <span className="reg-date-cleared">{fmtDate(a.cleared_date)}</span>
                            : <span className="reg-muted">—</span>
                          }
                        </td>
                        <DeadlineCell approval={a} />
                        <td className="reg-source-cell">
                          <span className="reg-source-doc">{a.source_doc_type.toUpperCase()}</span>
                          {(a.linked_docs?.length || 0) > 1 && (
                            <span className="reg-source-count">+{(a.linked_docs!.length) - 1}</span>
                          )}
                          {isNew(a) && <span className="reg-new-badge">NEW</span>}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="reg-detail-row">
                          <td colSpan={8}>
                            <ApprovalDetail
                              approval={a}
                              masterDef={a.master_id ? masterDefs[a.master_id] : null}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      {/* ── Change log ── */}
      <div className="reg-section">
        <button className="reg-section-hdr reg-toggle-hdr" onClick={() => setLogOpen(o => !o)}>
          Change Log
          <span className="reg-section-note">
            {data.documents_processed.length} document{data.documents_processed.length !== 1 ? 's' : ''} processed
          </span>
          <span className="reg-toggle-arrow">{logOpen ? '▲' : '▼'}</span>
        </button>
        {logOpen && (
          <div className="reg-change-log">
            {[...data.change_log].reverse().map((entry, i) => (
              <div key={i} className="reg-log-entry">
                <div className="reg-log-header">
                  <span className="reg-log-doc">{entry.source_doc}</span>
                  <span className="reg-log-ts">{fmtTs(entry.timestamp)}</span>
                </div>
                <ul className="reg-log-changes">
                  {entry.changes.map((c, j) => (
                    <li key={j} className={`reg-log-change change-${c.type}`}>
                      {c.type === 'added'         && <span className="change-icon">+</span>}
                      {c.type === 'status_change' && <span className="change-icon">↻</span>}
                      {c.type === 'date_update'   && <span className="change-icon">D</span>}
                      {c.type === 'manual_update' && <span className="change-icon">E</span>}
                      {c.detail}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Document monitoring pipeline ── */}
      <div className="reg-section">
        <button className="reg-section-hdr reg-toggle-hdr" onClick={() => setProcessOpen(o => !o)}>
          Process Documents
          <span className="reg-section-note">Select documents to analyze for regulatory updates</span>
          <span className="reg-toggle-arrow">{processOpen ? '▲' : '▼'}</span>
        </button>
        {processOpen && (
          <DocumentSelector dealId={dealId} onProcessed={() => { load(); onProcessed?.(); }} />
        )}
      </div>

    </div>
  );
}

