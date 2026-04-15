import { useState, useEffect } from 'react';
import './MilestoneLog.css';
import api from '../services/api';

interface Observation {
  doc_date: string | null;
  source_type: string;
  source_label: string;
  status: string;
  value: string;
  excerpt: string;
}

interface Milestone {
  id: string;
  label: string;
  category: string;
  current_status: string | null;
  current_date: string | null;
  observations: Observation[];
}

interface MilestoneLogData {
  deal_id: string;
  milestones: Milestone[];
  generated_at: string;
}

interface Props {
  dealId: string;
}

interface SourceColumn {
  key: string;
  label: string;
  date: string | null;
  sortOrder: number;
}

function statusTextColor(status: string): string {
  const map: Record<string, string> = {
    identified: '#a9afba', due: '#ffcc66', pending: '#ffcc66', scheduled: '#ffcc66',
    initial: '#a9afba', updated: '#5ccfe6', filed: '#5ccfe6', under_review: '#ffa050',
    phase_2: '#ffa050', mailed: '#5ccfe6', effective: '#87d96c', cleared: '#87d96c',
    approved: '#87d96c', completed: '#87d96c', extended: '#ffa050', on_track: '#87d96c',
    delayed: '#f07178', set: '#5ccfe6',
  };
  return map[status] || '#a9afba';
}

function statusBadgeColor(status: string): { bg: string; fg: string } {
  const colors: Record<string, { bg: string; fg: string }> = {
    identified:   { bg: 'rgba(255,255,255,0.08)', fg: '#8a919a' },
    initial:      { bg: 'rgba(255,255,255,0.08)', fg: '#8a919a' },
    due:          { bg: 'rgba(255,204,102,0.15)', fg: '#ffcc66' },
    pending:      { bg: 'rgba(255,204,102,0.15)', fg: '#ffcc66' },
    scheduled:    { bg: 'rgba(255,204,102,0.15)', fg: '#ffcc66' },
    extended:     { bg: 'rgba(255,160,80,0.15)',  fg: '#ffa050' },
    under_review: { bg: 'rgba(255,160,80,0.15)',  fg: '#ffa050' },
    phase_2:      { bg: 'rgba(255,160,80,0.15)',  fg: '#ffa050' },
    updated:      { bg: 'rgba(92,207,230,0.15)',  fg: '#5ccfe6' },
    filed:        { bg: 'rgba(92,207,230,0.15)',  fg: '#5ccfe6' },
    mailed:       { bg: 'rgba(92,207,230,0.15)',  fg: '#5ccfe6' },
    set:          { bg: 'rgba(92,207,230,0.15)',  fg: '#5ccfe6' },
    effective:    { bg: 'rgba(135,217,108,0.15)', fg: '#87d96c' },
    cleared:      { bg: 'rgba(135,217,108,0.15)', fg: '#87d96c' },
    approved:     { bg: 'rgba(135,217,108,0.15)', fg: '#87d96c' },
    completed:    { bg: 'rgba(135,217,108,0.15)', fg: '#87d96c' },
    on_track:     { bg: 'rgba(135,217,108,0.15)', fg: '#87d96c' },
    delayed:      { bg: 'rgba(240,113,120,0.15)', fg: '#f07178' },
  };
  return colors[status] || { bg: 'rgba(255,255,255,0.08)', fg: '#8a919a' };
}

/** Priority order for source types — lower = first column. */
const SOURCE_ORDER: Record<string, number> = {
  press_release: 0,
  merger_agreement: 1,
  tracking: 2,
  sec_filing: 3,
  proxy_analysis: 4,
};

/** Build ordered source columns from all milestones' observations. */
function buildSourceColumns(milestones: Milestone[]): SourceColumn[] {
  const seen = new Map<string, { label: string; date: string | null; sourceType: string }>();
  for (const m of milestones) {
    for (const obs of m.observations) {
      if (!seen.has(obs.source_label)) {
        seen.set(obs.source_label, { label: obs.source_label, date: obs.doc_date, sourceType: obs.source_type });
      }
    }
  }
  return Array.from(seen.entries())
    .map(([key, v]) => ({
      key,
      label: v.label,
      date: v.date,
      sortOrder: SOURCE_ORDER[v.sourceType] ?? 10,
    }))
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return (a.date || '').localeCompare(b.date || '');
    });
}

/** Find the observation for a milestone from a given source. */
function findObs(milestone: Milestone, sourceKey: string): Observation | null {
  return milestone.observations.find(o => o.source_label === sourceKey) || null;
}

function formatDate(d: string | null): string {
  if (!d) return '';
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return d;
  return `${parseInt(m[2])}/${parseInt(m[3])}`;
}

/** Get the clean display text for a cell. */
function cellDisplay(obs: Observation): string {
  if (obs.value) {
    return obs.value.length > 60 ? obs.value.slice(0, 57) + '...' : obs.value;
  }
  return obs.status.replace('_', ' ');
}

export default function MilestoneLog({ dealId }: Props) {
  const [data, setData] = useState<MilestoneLogData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  useEffect(() => {
    setLoading(true);
    api.get(`/api/deals/${dealId}/milestone-log`)
      .then(res => { setData(res.data); })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [dealId]);

  if (loading) return <div className="ml-loading">Loading milestone data...</div>;
  if (!data || data.milestones.length === 0) {
    return (
      <div className="ml-empty">
        <p>No milestone data found for this deal.</p>
        <p className="ml-hint">Milestones are populated from merger agreement, SEC filings, proxy analysis, and tracking data.</p>
      </div>
    );
  }

  const regulatory = data.milestones.filter(m => m.category === 'regulatory');
  const guidance   = data.milestones.filter(m => m.category === 'guidance');
  const columns    = buildSourceColumns(data.milestones);

  const cleared = data.milestones.filter(m => ['cleared', 'approved', 'completed', 'effective'].includes(m.current_status || '')).length;
  const filed   = data.milestones.filter(m => ['filed', 'mailed', 'under_review'].includes(m.current_status || '')).length;
  const pending = data.milestones.filter(m => ['identified', 'due', 'pending', 'scheduled', 'initial'].includes(m.current_status || '')).length;
  const total   = data.milestones.length;

  const colCount = columns.length + 2;

  return (
    <div className="ml-tab">
      <div className="ml-summary-bar">
        {cleared > 0 && <span className="ml-chip chip-green">{cleared} CLEARED</span>}
        {filed   > 0 && <span className="ml-chip chip-blue">{filed} FILED</span>}
        {pending > 0 && <span className="ml-chip chip-amber">{pending} PENDING</span>}
        <span className="ml-chip chip-muted">{total} MILESTONES</span>
      </div>

      <div className="ml-table-wrap">
        <table className="ml-table">
          <thead>
            <tr>
              <th className="ml-th ml-th-label">Milestone</th>
              {columns.map(col => (
                <th key={col.key} className="ml-th ml-th-source">
                  <div className="ml-th-source-label">{col.label}</div>
                  {col.date && <div className="ml-th-source-date">{formatDate(col.date)}</div>}
                </th>
              ))}
              <th className="ml-th ml-th-current">Current</th>
            </tr>
          </thead>
          <tbody>
            {regulatory.length > 0 && (
              <>
                <tr className="ml-cat-row">
                  <td colSpan={colCount} className="ml-cat-cell">Regulatory</td>
                </tr>
                {regulatory.map(m => (
                  <MilestoneRow
                    key={m.id}
                    milestone={m}
                    columns={columns}
                    colCount={colCount}
                    expanded={expandedIds.has(m.id)}
                    onToggle={toggleExpand}
                  />
                ))}
              </>
            )}
            {guidance.length > 0 && (
              <>
                <tr className="ml-cat-row">
                  <td colSpan={colCount} className="ml-cat-cell">Guidance</td>
                </tr>
                {guidance.map(m => (
                  <MilestoneRow
                    key={m.id}
                    milestone={m}
                    columns={columns}
                    colCount={colCount}
                    expanded={expandedIds.has(m.id)}
                    onToggle={toggleExpand}
                  />
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function MilestoneRow({ milestone: m, columns, colCount, expanded, onToggle }: {
  milestone: Milestone;
  columns: SourceColumn[];
  colCount: number;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const badgeColor = statusBadgeColor(m.current_status || 'identified');

  return (
    <>
      <tr className={`ml-row ${expanded ? 'ml-row-expanded' : ''}`} onClick={() => onToggle(m.id)}>
        <td className="ml-td ml-td-label">
          <span className="ml-expand-icon">{expanded ? '▾' : '▸'}</span>
          {m.label}
        </td>
        {columns.map(col => {
          const obs = findObs(m, col.key);
          if (!obs) {
            return <td key={col.key} className="ml-td ml-td-empty">&mdash;</td>;
          }
          return (
            <td key={col.key} className="ml-td ml-td-obs">
              <span className="ml-cell-text" style={{ color: statusTextColor(obs.status) }}>
                {cellDisplay(obs)}
              </span>
            </td>
          );
        })}
        <td className="ml-td ml-td-current">
          <span
            className="ml-current-badge"
            style={{ background: badgeColor.bg, color: badgeColor.fg }}
          >
            {(m.current_status || '\u2014').replace('_', ' ')}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr className="ml-detail-row">
          <td colSpan={colCount} className="ml-detail-cell">
            <div className="ml-detail-grid">
              {m.observations.map((obs, i) => (
                <div key={i} className="ml-detail-item">
                  <div className="ml-detail-header">
                    <span className="ml-detail-date">{obs.doc_date || '\u2014'}</span>
                    <span className="ml-detail-source">{obs.source_label}</span>
                    <span className="ml-detail-status" style={{ color: statusTextColor(obs.status) }}>
                      {obs.status.replace('_', ' ')}
                    </span>
                  </div>
                  {obs.value && <div className="ml-detail-value">{obs.value}</div>}
                  {obs.excerpt && obs.excerpt !== obs.value && (
                    <div className="ml-detail-excerpt">{obs.excerpt}</div>
                  )}
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
