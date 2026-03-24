/**
 * RegulatoryMonitorTab — Master-file-only regulatory monitoring pipeline.
 *
 * Uses the 37-type master approval definitions exclusively. All approvals must
 * have a master_id. No open-ended extraction. Separate storage from legacy tab.
 */

import { useEffect, useState } from 'react';
import StatusProgression from './StatusProgression';
import DocumentSelector from './DocumentSelector';
import './RegulatoryMonitorTab.css';

// ── Types ──────────────────────────────────────────────────────────────────────

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

interface Approval {
  id:                    string;
  master_id?:            string;
  jurisdiction:          string | null;
  authority_short:       string;
  authority_full:        string;
  statute:               string | null;
  category:              string;
  status:                string;
  status_detail?:        string;
  filed_date:            string | null;
  cleared_date:          string | null;
  expected_filing_period?: string | null;
  conditions:            string | null;
  notes:                 string;
  source_doc:            string;
  source_doc_type:       string;
  first_seen_date:       string;
  status_history?:       StatusHistoryEntry[];
  conflicts?:            ConflictEntry[];
  tracker_fields?:       Record<string, any>;
  _deadline?:            DeadlineInfo;
}

interface ChangeEntry {
  type: string; approval_id: string; detail: string; from?: string; to?: string;
}

interface ChangeLogEntry {
  timestamp: string; source_doc: string; source_doc_type: string; changes: ChangeEntry[];
}

interface DealSummary {
  target?:                        string;
  acquirer?:                      string;
  deal_type?:                     string;
  offer_price_cash?:              number;
  stock_exchange_ratio?:          number;
  total_consideration?:           number;
  cvr_value?:                     number;
  expected_close?:                string;
  announce_date?:                 string;
  outside_date?:                  string;
  outside_date_extension?:        string;
  target_break_fee_mm?:           number;
  acquirer_reverse_break_fee_mm?: number;
  voting_threshold?:              string;
  financing_condition?:           string;
  go_shop_days?:                  number;
  go_shop_end_date?:              string;
  regulatory_approvals_required?: string[];
  regulatory_filing_deadlines?:   string;
}

interface DealEvent {
  doc_date:      string;
  source_doc:    string;
  event_type:    string;
  description:   string;
  excerpt?:      string | null;
  detected_at:   string;
}

interface ManagementCommentary {
  doc_date:    string;
  source_doc:  string;
  commentary:  string;
  detected_at: string;
}

interface MonitorData {
  deal_id:                string;
  last_updated:           string;
  approvals:              Approval[];
  documents_processed:    any[];
  documents_triaged?:     any[];
  change_log:             ChangeLogEntry[];
  deal_summary?:          DealSummary | null;
  deal_events?:           DealEvent[];
  expected_close?:        string;
  management_commentary?: ManagementCommentary[];
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
  'US Antitrust':                   'US ANTITRUST',
  'US National Security':           'US NATIONAL SECURITY',
  'US Federal — Sector':            'US FEDERAL — SECTOR',
  'US State':                       'US STATE',
  'International — Major':          'INTERNATIONAL — MAJOR',
  'International — National Security': 'INTERNATIONAL — NATIONAL SECURITY',
  'Sector-Specific':                'SECTOR-SPECIFIC',
  'Shareholder & Contractual':      'SHAREHOLDER & CONTRACTUAL',
};

const CATEGORY_ORDER = [
  'US Antitrust',
  'US National Security',
  'US Federal — Sector',
  'US State',
  'International — Major',
  'International — National Security',
  'Sector-Specific',
  'Shareholder & Contractual',
];

// ── Deal summary bar ─────────────────────────────────────────────────────────

function fmtMoney(n: number | undefined): string {
  if (n == null) return '—';
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}B`;
  return `$${n}M`;
}

function DealSummaryBar({ s }: { s: DealSummary }) {
  const considerationParts: string[] = [];
  if (s.offer_price_cash) considerationParts.push(`$${s.offer_price_cash} cash`);
  if (s.stock_exchange_ratio) considerationParts.push(`${s.stock_exchange_ratio}x stock`);
  if (s.deal_type) considerationParts.push(s.deal_type.replace('+', '/'));

  return (
    <div className="rm-deal-summary">
      <div className="rm-deal-row">
        {considerationParts.length > 0 && (
          <div className="rm-deal-item">
            <span className="rm-deal-label">Consideration</span>
            <span className="rm-deal-val">{considerationParts.join(' · ')}</span>
          </div>
        )}
        {s.expected_close && (
          <div className="rm-deal-item">
            <span className="rm-deal-label">Exp. Close</span>
            <span className="rm-deal-val rm-deal-highlight">{s.expected_close}</span>
          </div>
        )}
        {s.outside_date && (
          <div className="rm-deal-item">
            <span className="rm-deal-label">Outside Date</span>
            <span className="rm-deal-val">{fmtDate(s.outside_date)}{s.outside_date_extension ? ` (ext. ${fmtDate(s.outside_date_extension)})` : ''}</span>
          </div>
        )}
        {s.announce_date && (
          <div className="rm-deal-item">
            <span className="rm-deal-label">Announced</span>
            <span className="rm-deal-val">{fmtDate(s.announce_date)}</span>
          </div>
        )}
      </div>
      <div className="rm-deal-row">
        {s.target_break_fee_mm != null && (
          <div className="rm-deal-item">
            <span className="rm-deal-label">Target Break Fee</span>
            <span className="rm-deal-val">{fmtMoney(s.target_break_fee_mm)}</span>
          </div>
        )}
        {s.acquirer_reverse_break_fee_mm != null && (
          <div className="rm-deal-item">
            <span className="rm-deal-label">Reverse Break Fee</span>
            <span className="rm-deal-val">{fmtMoney(s.acquirer_reverse_break_fee_mm)}</span>
          </div>
        )}
        {s.financing_condition && (
          <div className="rm-deal-item">
            <span className="rm-deal-label">Financing</span>
            <span className="rm-deal-val">{s.financing_condition.length > 60 ? s.financing_condition.slice(0, 60) + '…' : s.financing_condition}</span>
          </div>
        )}
        {s.go_shop_days != null && (
          <div className="rm-deal-item">
            <span className="rm-deal-label">Go-Shop</span>
            <span className="rm-deal-val">{s.go_shop_days} days{s.go_shop_end_date ? ` (ends ${fmtDate(s.go_shop_end_date)})` : ''}</span>
          </div>
        )}
        {s.voting_threshold && (
          <div className="rm-deal-item">
            <span className="rm-deal-label">Vote Required</span>
            <span className="rm-deal-val">{s.voting_threshold.length > 50 ? s.voting_threshold.slice(0, 50) + '…' : s.voting_threshold}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

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
  const label = statusDetail || status.replace(/_/g, ' ').toUpperCase();
  return <span className={`rm-badge ${cls}`} title={statusDetail || ''}>{label}</span>;
}

// ── Approval card ─────────────────────────────────────────────────────────────

function ApprovalCard({
  approval,
  masterDef,
  expanded,
  onToggle,
}: {
  approval: Approval;
  masterDef?: MasterApproval | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const history = approval.status_history || [];
  const unresolvedConflicts = (approval.conflicts || []).filter(c => !c.resolved);
  const [historyOpen, setHistoryOpen] = useState(false);
  const dl = approval._deadline;

  return (
    <div className={`rm-card rm-card-${approval.status}`}>
      {/* Progression bar */}
      {masterDef && masterDef.monitoring?.status_states?.length > 0 && (
        <div className="rm-card-progression">
          <StatusProgression
            states={masterDef.monitoring.status_states}
            currentStatus={approval.status_detail || approval.status}
            statusHistory={history}
          />
        </div>
      )}

      {/* Card header — always visible */}
      <div className="rm-card-header" onClick={onToggle}>
        <div className="rm-card-title">
          <span className="rm-card-authority">{approval.authority_short}</span>
          {approval.jurisdiction && <span className="rm-card-jurisdiction">{approval.jurisdiction}</span>}
          {unresolvedConflicts.length > 0 && (
            <span className="rm-conflict-icon" title="Conflicting information detected">&#9888;</span>
          )}
        </div>
        <div className="rm-card-right">
          <StatusBadge status={approval.status} statusDetail={approval.status_detail} />
          <span className="rm-card-expand">{expanded ? '▼' : '▶'}</span>
        </div>
      </div>

      {/* Card summary row */}
      <div className="rm-card-summary">
        <span className="rm-card-dates">
          {approval.filed_date && <>Filed: {fmtDate(approval.filed_date)}</>}
          {approval.filed_date && approval.cleared_date && <> · </>}
          {approval.cleared_date && <>Cleared: {fmtDate(approval.cleared_date)}</>}
          {!approval.filed_date && !approval.cleared_date && approval.expected_filing_period && (
            <>Expected: {approval.expected_filing_period}</>
          )}
        </span>
        {dl && dl.days_in_review != null && !approval.cleared_date && (
          <span className="rm-card-days">Day {dl.days_in_review}</span>
        )}
        {dl && dl.days_to_clear != null && (
          <span className="rm-card-days rm-card-days-cleared">{dl.days_to_clear}d to clear</span>
        )}
      </div>

      {/* Source trail — which docs contributed */}
      <div className="rm-card-sources">
        {(() => {
          const seen = new Set<string>();
          const tags: { label: string; isConflict: boolean }[] = [];
          for (const h of history) {
            const key = `${h.source_doc_type}|${h.date || ''}`;
            if (!seen.has(key)) {
              seen.add(key);
              tags.push({ label: `${h.source_doc_type} ${h.date ? fmtDate(h.date) : ''}`.trim(), isConflict: false });
            }
          }
          for (const c of unresolvedConflicts) {
            const key = `conflict|${c.source_doc}`;
            if (!seen.has(key)) {
              seen.add(key);
              tags.push({ label: c.source_doc, isConflict: true });
            }
          }
          return tags.map((t, i) => (
            <span key={i} className={`rm-source-tag ${t.isConflict ? 'conflict-source' : ''}`}>{t.label}</span>
          ));
        })()}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="rm-card-detail">
          {/* Conflict banner */}
          {unresolvedConflicts.length > 0 && (
            <div className="rm-conflict-banner">
              <div className="rm-conflict-banner-hdr">
                &#9888; {unresolvedConflicts.length} Conflict{unresolvedConflicts.length > 1 ? 's' : ''} Detected
              </div>
              {unresolvedConflicts.map(c => (
                <div key={c.id} className="rm-conflict-item">
                  <span>Current: <strong>{c.current_status}</strong> — Doc says: <strong>{c.conflicting_claim}</strong></span>
                  <div className="rm-conflict-source">
                    {c.source_doc} {c.excerpt && <span className="rm-conflict-excerpt">"{c.excerpt.slice(0, 120)}..."</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Notes */}
          {approval.notes && (
            <div className="rm-detail-section">
              <div className="rm-detail-label">Notes</div>
              <div className="rm-detail-text">{approval.notes}</div>
            </div>
          )}

          {/* Conditions */}
          {approval.conditions && (
            <div className="rm-detail-section">
              <div className="rm-detail-label">Conditions</div>
              <div className="rm-detail-text">{approval.conditions}</div>
            </div>
          )}

          {/* Tracker fields */}
          {approval.tracker_fields && Object.keys(approval.tracker_fields).length > 0 && (
            <div className="rm-detail-section">
              <div className="rm-detail-label">Key Dates</div>
              <div className="rm-tracker-grid">
                {Object.entries(approval.tracker_fields).map(([k, v]) => (
                  <div key={k} className="rm-tracker-item">
                    <span className="rm-tracker-key">{k.replace(/_/g, ' ')}</span>
                    <span className="rm-tracker-val">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Deadline info */}
          {dl && dl.is_overdue && (
            <div className="rm-detail-section rm-overdue">
              <span className="rm-overdue-text">
                {dl.overdue_days}d overdue — {dl.overdue_reason}
              </span>
            </div>
          )}

          {/* Status history */}
          {history.length > 1 && (
            <div className="rm-detail-section">
              <button className="rm-history-toggle" onClick={() => setHistoryOpen(o => !o)}>
                Status History ({history.length}) {historyOpen ? '▲' : '▼'}
              </button>
              {historyOpen && (
                <div className="rm-history-list">
                  {[...history].reverse().map((h, i) => (
                    <div key={i} className="rm-history-entry">
                      <span className="rm-history-status">{h.status}</span>
                      <span className="rm-history-date">{h.date ? fmtDate(h.date) : '—'}</span>
                      <span className="rm-history-source">{h.source_doc}</span>
                      {h.excerpt && <div className="rm-history-excerpt">"{h.excerpt.slice(0, 150)}"</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  dealId:           string;
  dealName?:        string;
  onProcessed?:     () => void;
}

export default function RegulatoryMonitorTab({ dealId, dealName, onProcessed }: Props) {
  const [data, setData]             = useState<MonitorData | null>(null);
  const [loading, setLoading]       = useState(true);
  const [masterDefs, setMasterDefs] = useState<Record<string, MasterApproval>>({});
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [catFilter, setCatFilter]   = useState<string>('all');
  const [logOpen, setLogOpen]       = useState(false);
  const [eventsOpen, setEventsOpen] = useState(true);
  const [processOpen, setProcessOpen] = useState(true);

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
    fetch(`http://localhost:8000/api/deals/${dealId}/regulatory-monitor`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setData(await r.json());
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [dealId]);

  useEffect(() => {
    fetch('http://localhost:8000/api/regulatory/master-approvals')
      .then(async r => {
        if (!r.ok) return;
        const d = await r.json();
        const map: Record<string, MasterApproval> = {};
        for (const ap of d.approvals || []) map[ap.id] = ap;
        setMasterDefs(map);
      })
      .catch(() => {});
  }, []);

  if (loading) return <div className="rm-loading">Loading regulatory monitor…</div>;

  // Filter to master-mapped approvals only
  const approvals = (data?.approvals || []).filter(a => a.master_id);

  // Empty state
  if (!data || approvals.length === 0) {
    return (
      <div className="rm-tab">
        <div className="rm-header">
          <div className="rm-header-title">Deal Monitor</div>
          {dealName && <div className="rm-header-deal">{dealName}</div>}
        </div>
        <div className="rm-empty">
          <p>No regulatory approvals tracked yet.</p>
          <p className="rm-hint">Process documents below to identify and track regulatory approvals.</p>
        </div>
        <DocumentSelector
          dealId={dealId}
          endpointPrefix="regulatory-monitor"
          onProcessed={() => { load(); onProcessed?.(); }}
        />
      </div>
    );
  }

  // Summary counts
  const cleared = approvals.filter(a => a.status === 'cleared' || a.status === 'cleared_with_conditions').length;
  const filed   = approvals.filter(a => a.status === 'filed' || a.status === 'under_review').length;
  const phase2  = approvals.filter(a => a.status === 'phase2').length;
  const pending = approvals.filter(a => a.status === 'pending' || a.status === 'filing_intent').length;
  const blocked = approvals.filter(a => a.status === 'blocked').length;
  const total   = approvals.filter(a => a.status !== 'not_required').length;
  const conflicts = approvals.reduce((n, a) => n + (a.conflicts || []).filter(c => !c.resolved).length, 0);

  const categories = CATEGORY_ORDER.filter(cat => approvals.some(a => a.category === cat));
  const filtered = catFilter === 'all' ? approvals : approvals.filter(a => a.category === catFilter);

  return (
    <div className="rm-tab">
      {/* Header */}
      <div className="rm-header">
        <div className="rm-header-title">Deal Monitor</div>
        {dealName && <div className="rm-header-deal">{dealName}</div>}
        <div className="rm-updated">Updated {fmtDate(data.last_updated)}</div>
      </div>

      {/* Deal summary */}
      {data.deal_summary && <DealSummaryBar s={data.deal_summary} />}

      {/* Summary chips */}
      <div className="rm-summary-bar">
        {cleared  > 0 && <span className="rm-chip chip-green">{cleared} CLEARED</span>}
        {filed    > 0 && <span className="rm-chip chip-blue">{filed} FILED</span>}
        {phase2   > 0 && <span className="rm-chip chip-orange">{phase2} PHASE 2</span>}
        {pending  > 0 && <span className="rm-chip chip-yellow">{pending} PENDING</span>}
        {blocked  > 0 && <span className="rm-chip chip-red">{blocked} BLOCKED</span>}
        {conflicts > 0 && <span className="rm-chip chip-red">{conflicts} CONFLICT{conflicts > 1 ? 'S' : ''}</span>}
        <span className="rm-chip chip-muted">{total} TOTAL</span>
      </div>

      {/* Category filter */}
      {categories.length > 1 && (
        <div className="rm-filters">
          <button className={`rm-filter-btn ${catFilter === 'all' ? 'active' : ''}`} onClick={() => setCatFilter('all')}>All</button>
          {categories.map(cat => (
            <button key={cat} className={`rm-filter-btn ${catFilter === cat ? 'active' : ''}`} onClick={() => setCatFilter(cat)}>
              {CATEGORY_LABELS[cat] || cat}
            </button>
          ))}
        </div>
      )}

      {/* Approval cards grouped by category */}
      {(catFilter === 'all' ? categories : [catFilter]).map(cat => {
        const rows = filtered.filter(a => a.category === cat);
        if (rows.length === 0) return null;
        return (
          <div key={cat} className="rm-section">
            <div className="rm-section-hdr">{CATEGORY_LABELS[cat] || cat.toUpperCase()}</div>
            {rows.map(a => (
              <ApprovalCard
                key={a.id}
                approval={a}
                masterDef={a.master_id ? masterDefs[a.master_id] : null}
                expanded={expandedIds.has(a.id)}
                onToggle={() => toggleExpand(a.id)}
              />
            ))}
          </div>
        );
      })}

      {/* Deal timeline / events */}
      {(data.deal_events?.length || 0) > 0 && (
        <div className="rm-section">
          <button className="rm-section-hdr rm-toggle-hdr" onClick={() => setEventsOpen(o => !o)}>
            Deal Timeline
            <span className="rm-section-note">
              {data.deal_events!.length} event{data.deal_events!.length !== 1 ? 's' : ''}
              {data.expected_close ? ` · Exp. close: ${data.expected_close}` : ''}
            </span>
            <span className="rm-toggle-arrow">{eventsOpen ? '▲' : '▼'}</span>
          </button>
          {eventsOpen && (
            <div className="rm-events-list">
              {/* Management commentary (most recent) */}
              {data.management_commentary && data.management_commentary.length > 0 && (
                <div className="rm-mgmt-commentary">
                  <div className="rm-detail-label">Latest Management Commentary</div>
                  <div className="rm-mgmt-quote">
                    "{data.management_commentary[data.management_commentary.length - 1].commentary}"
                    <span className="rm-mgmt-source">
                      — {data.management_commentary[data.management_commentary.length - 1].source_doc}
                    </span>
                  </div>
                </div>
              )}
              {/* Event entries */}
              {[...(data.deal_events || [])].reverse().map((ev, i) => (
                <div key={i} className={`rm-event-entry rm-event-${ev.event_type}`}>
                  <span className="rm-event-date">{fmtDate(ev.doc_date)}</span>
                  <span className={`rm-event-type rm-etype-${ev.event_type}`}>
                    {ev.event_type.replace(/_/g, ' ')}
                  </span>
                  <span className="rm-event-desc">{ev.description}</span>
                  <span className="rm-event-source">{ev.source_doc}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Change log */}
      {data.change_log.length > 0 && (
        <div className="rm-section">
          <button className="rm-section-hdr rm-toggle-hdr" onClick={() => setLogOpen(o => !o)}>
            Change Log
            <span className="rm-section-note">
              {data.documents_processed.length} document{data.documents_processed.length !== 1 ? 's' : ''} processed
            </span>
            <span className="rm-toggle-arrow">{logOpen ? '▲' : '▼'}</span>
          </button>
          {logOpen && (
            <div className="rm-change-log">
              {[...data.change_log].reverse().map((entry, i) => (
                <div key={i} className="rm-log-entry">
                  <div className="rm-log-header">
                    <span className="rm-log-doc">{entry.source_doc}</span>
                    <span className="rm-log-ts">{fmtTs(entry.timestamp)}</span>
                  </div>
                  <ul className="rm-log-changes">
                    {entry.changes.map((c, j) => (
                      <li key={j} className={`rm-log-change change-${c.type}`}>
                        {c.type === 'added' && <span className="change-icon">+</span>}
                        {c.type === 'status_change' && <span className="change-icon">↻</span>}
                        {c.type === 'date_update' && <span className="change-icon">D</span>}
                        {c.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Document processing panel */}
      <div className="rm-section">
        <button className="rm-section-hdr rm-toggle-hdr" onClick={() => setProcessOpen(o => !o)}>
          Process Documents
          <span className="rm-section-note">Select documents to analyze</span>
          <span className="rm-toggle-arrow">{processOpen ? '▲' : '▼'}</span>
        </button>
        {processOpen && (
          <DocumentSelector
            dealId={dealId}
            endpointPrefix="regulatory-monitor"
            onProcessed={() => { load(); onProcessed?.(); }}
          />
        )}
      </div>
    </div>
  );
}
