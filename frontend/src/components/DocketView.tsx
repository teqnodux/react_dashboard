import { useState, useMemo } from 'react';
import '../styles/Docket.css';
import DocketQuery from './DocketQuery';

interface DocketEntry {
  entry_no: number;
  received_date: string;
  title: string;
  relevance_level: string;
  filer_role: string;
  filer_name: string;
  position_on_deal: string;
  entry_summary: string;
  key_arguments: string[];
  cumulative_impact: string;
  download_link: string;
  opposition_type?: string;
  intervenor_type?: string;
  key_excerpts?: string[];
  relief_requested?: string;
  legal_regulatory_significance?: string;
  proceeding_phase?: string;
  document_type?: string;
  deadline_date?: string;
  deadline_description?: string;
}

interface DocketStakeholder {
  name: string;
  role: string;
  filing_count: number;
  position: string;
  opposition_type: string;
  status: string;
  intervenor_type?: string;
}

interface ConditionRef {
  entry_no: number;
  date: string;
  filer: string;
}

interface DocketCondition {
  text: string;
  status: string;
  source: string;
  category?: string;
  opposition_type?: string;
  relief_type?: string;
  asked_in?: ConditionRef | null;
  resolved_in?: ConditionRef | null;
}

interface DocketViewProps {
  entries: DocketEntry[];
  stakeholders?: DocketStakeholder[];
  conditions?: DocketCondition[];
  metadata?: {
    docket_number?: string;
    case_name?: string;
    jurisdiction?: string;
    status?: string;
  };
  dealId?: string;
}

function classifyPosition(sh: DocketStakeholder): string {
  if (sh.status === 'settled') return 'settled';
  if (sh.position === 'Support') return 'in_favor';
  if (sh.position === 'Neutral' || sh.position === 'Procedural') return 'neutral';
  const opp = sh.opposition_type?.toLowerCase() || '';
  if (opp === 'ideological') return 'ideological_oppose';
  if (opp === 'outright') return 'outright_oppose';
  if (opp === 'conditional') return 'conditional_oppose';
  return 'outright_oppose';
}

const INTERVENOR_SUBGROUPS = [
  { key: 'competitor', label: 'Competitors' },
  { key: 'business_customer', label: 'Customers' },
  { key: 'consumer_advocate', label: 'Consumer Advocates' },
  { key: 'environmental', label: 'Environmental' },
  { key: 'agricultural', label: 'Agricultural' },
  { key: 'government', label: 'Government' },
  { key: 'special_interest', label: 'Special Interest' },
  { key: 'labor', label: 'Labor' },
  { key: 'retail_customer', label: 'Individuals' },
];

const POSITION_TIERS = [
  { key: 'in_favor', label: 'In Favor', tierColor: 'tier-green' },
  { key: 'settled', label: 'Settled', tierColor: 'tier-green' },
  { key: 'conditional_oppose', label: 'Conditional Opposition', tierColor: 'tier-yellow' },
  { key: 'outright_oppose', label: 'Outright Opposition', tierColor: 'tier-red' },
  { key: 'ideological_oppose', label: 'Ideological Opposition', tierColor: 'tier-red' },
  { key: 'neutral', label: 'Neutral / Procedural', tierColor: 'tier-muted' },
];

const COND_GROUPS = [
  { key: 'resolved', label: 'Resolved / Ordered', match: (c: DocketCondition) => c.status === 'required' },
  { key: 'settled', label: 'In Settlement', match: (c: DocketCondition) => c.status === 'pending' },
  { key: 'open', label: 'Open / Proposed', match: (c: DocketCondition) => c.status === 'proposed' && c.category !== 'demand' },
  { key: 'demand', label: 'Opposition Demands', match: (c: DocketCondition) => c.category === 'demand' || (c.status === 'proposed' && c.category === 'demand') },
];

export default function DocketView({ entries, stakeholders = [], conditions = [], metadata = {}, dealId }: DocketViewProps) {
  const [filter, setFilter] = useState<string>('all');
  const [relevanceFilter, setRelevanceFilter] = useState<string>('all');
  const [expandedEntry, setExpandedEntry] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedStakeholder, setSelectedStakeholder] = useState<string>('');
  const [expandedCondSource, setExpandedCondSource] = useState<Set<string>>(new Set());
  const [focusedEntryNo, setFocusedEntryNo] = useState<number | null>(null);
  const [showAllRetail, setShowAllRetail] = useState(false);
  const [positionView, setPositionView] = useState<'concise' | 'fulsome'>('concise');
  const [opposedSubfilter, setOpposedSubfilter] = useState<string>('all');
  const [supportSubfilter, setSupportSubfilter] = useState<string>('all');
  const [sidebarTab, setSidebarTab] = useState<'stakeholders' | 'conditions' | 'query'>('stakeholders');
  const [stakeholderFilter, setStakeholderFilter] = useState<'all' | 'commission' | 'parties' | 'opposed' | 'support' | 'neutral'>('all');
  const [conditionFilter, setConditionFilter] = useState<'all' | 'resolved' | 'settled' | 'open' | 'demand'>('all');

  const stats = {
    total: entries.length,
    high: entries.filter(e => e.relevance_level === 'high').length,
    medium: entries.filter(e => e.relevance_level === 'medium').length,
    support: entries.filter(e => e.position_on_deal === 'Support').length,
    oppose: entries.filter(e => e.position_on_deal === 'Oppose').length,
    neutral: entries.filter(e => e.position_on_deal === 'Neutral' || e.position_on_deal === 'Procedural').length,
  };

  const commissionStakeholders = useMemo(() =>
    stakeholders.filter(s => s.role === 'Commission').sort((a, b) => b.filing_count - a.filing_count),
    [stakeholders]);

  const partyStakeholders = useMemo(() =>
    stakeholders.filter(s => s.role === 'Party').sort((a, b) => b.filing_count - a.filing_count),
    [stakeholders]);

  const intervenors = useMemo(() =>
    stakeholders.filter(s => s.role !== 'Commission' && s.role !== 'Party'),
    [stakeholders]);

  const classified = useMemo(() => {
    const result: Record<string, DocketStakeholder[]> = {};
    for (const sh of intervenors) {
      const tier = classifyPosition(sh);
      if (!result[tier]) result[tier] = [];
      result[tier].push(sh);
    }
    for (const arr of Object.values(result)) arr.sort((a, b) => b.filing_count - a.filing_count);
    return result;
  }, [intervenors]);

  const conciseGroups = useMemo(() => ({
    opposed: [...(classified['outright_oppose'] || []), ...(classified['ideological_oppose'] || []), ...(classified['conditional_oppose'] || [])],
    settled: [...(classified['in_favor'] || []), ...(classified['settled'] || [])],
    neutral: classified['neutral'] || [],
  }), [classified]);

  const opposedBySubgroup = useMemo(() => {
    const groups: Record<string, DocketStakeholder[]> = {};
    for (const sh of conciseGroups.opposed) {
      const key = sh.intervenor_type || '_other';
      if (!groups[key]) groups[key] = [];
      groups[key].push(sh);
    }
    return groups;
  }, [conciseGroups.opposed]);

  const supportBySubgroup = useMemo(() => {
    const groups: Record<string, DocketStakeholder[]> = {};
    for (const sh of conciseGroups.settled) {
      const key = sh.intervenor_type || '_other';
      if (!groups[key]) groups[key] = [];
      groups[key].push(sh);
    }
    return groups;
  }, [conciseGroups.settled]);

  const conditionGroups = useMemo(() => {
    const result: Record<string, Record<string, DocketCondition[]>> = {};
    const assigned = new Set<number>();
    for (const group of COND_GROUPS) {
      result[group.key] = {};
      conditions.forEach((c, i) => {
        if (assigned.has(i)) return;
        if (group.match(c)) {
          assigned.add(i);
          const src = c.source || 'Unknown';
          if (!result[group.key][src]) result[group.key][src] = [];
          result[group.key][src].push(c);
        }
      });
    }
    return result;
  }, [conditions]);

  const condCounts = useMemo(() => ({
    resolved: conditions.filter(c => c.status === 'required').length,
    settled: conditions.filter(c => c.status === 'pending').length,
    open: conditions.filter(c => c.status === 'proposed' && c.category !== 'demand').length,
    demand: conditions.filter(c => c.category === 'demand').length,
  }), [conditions]);

  const sorted = useMemo(() =>
    [...entries].sort((a, b) => b.received_date.localeCompare(a.received_date) || b.entry_no - a.entry_no),
    [entries]);

  const filteredEntries = sorted.filter(entry => {
    if (focusedEntryNo !== null && entry.entry_no !== focusedEntryNo) return false;
    if (filter !== 'all' && entry.position_on_deal !== filter) return false;
    if (relevanceFilter !== 'all' && entry.relevance_level !== relevanceFilter) return false;
    if (selectedStakeholder && entry.filer_name !== selectedStakeholder) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const haystack = [entry.title, entry.entry_summary, entry.filer_name,
        ...(entry.key_arguments || []), ...(entry.key_excerpts || [])].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const formatDate = (dateStr: string): string =>
    new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });

  function toggleCondSource(src: string) {
    setExpandedCondSource(prev => { const next = new Set(prev); next.has(src) ? next.delete(src) : next.add(src); return next; });
  }

  function jumpToEntry(entryNo: number) {
    setFilter('all'); setRelevanceFilter('all'); setSelectedStakeholder(''); setSearchTerm('');
    setFocusedEntryNo(entryNo); setExpandedEntry(entryNo);
  }

  const RETAIL_THRESHOLD = 3;

  function renderStakeholderTable(shs: DocketStakeholder[], showType = false) {
    const retail = shs.filter(s => s.intervenor_type === 'retail_customer');
    const nonRetail = shs.filter(s => s.intervenor_type !== 'retail_customer');
    const showRetail = retail.length <= RETAIL_THRESHOLD || showAllRetail;
    return (
      <>
        <table className="stakeholders-table"><tbody>
          {nonRetail.map((sh, idx) => (
            <tr key={idx} className={`stakeholder-row ${selectedStakeholder === sh.name ? 'selected' : ''}`}
                onClick={() => setSelectedStakeholder(selectedStakeholder === sh.name ? '' : sh.name)}>
              <td className="stakeholder-name" title={sh.name}>{sh.name}</td>
              <td className="filing-count">{sh.filing_count}</td>
              {showType && sh.opposition_type && <td className={`opposition-tag opp-${sh.opposition_type}`}>{sh.opposition_type}</td>}
              {showType && !sh.opposition_type && <td />}
            </tr>
          ))}
        </tbody></table>
        {retail.length > 0 && (
          <div className="retail-block">
            {showRetail ? (
              <>
                <table className="stakeholders-table"><tbody>
                  {retail.map((sh, idx) => (
                    <tr key={idx} className={`stakeholder-row ${selectedStakeholder === sh.name ? 'selected' : ''}`}
                        onClick={() => setSelectedStakeholder(selectedStakeholder === sh.name ? '' : sh.name)}>
                      <td className="stakeholder-name" title={sh.name}>{sh.name}</td>
                      <td className="filing-count">{sh.filing_count}</td>
                    </tr>
                  ))}
                </tbody></table>
                {retail.length > RETAIL_THRESHOLD && <button className="retail-expand-btn" onClick={() => setShowAllRetail(false)}>Collapse individuals</button>}
              </>
            ) : (
              <div className="retail-summary">
                <span className="retail-summary-text">+ {retail.length} individual filers ({retail.reduce((s, r) => s + r.filing_count, 0)} filings)</span>
                <button className="retail-expand-btn" onClick={() => setShowAllRetail(true)}>Show</button>
              </div>
            )}
          </div>
        )}
      </>
    );
  }

  function renderRoleTable(shs: DocketStakeholder[]) {
    return (
      <table className="stakeholders-table"><tbody>
        {shs.map((sh, idx) => (
          <tr key={idx} className={`stakeholder-row ${selectedStakeholder === sh.name ? 'selected' : ''}`}
              onClick={() => setSelectedStakeholder(selectedStakeholder === sh.name ? '' : sh.name)}>
            <td className="stakeholder-name" title={sh.name}>{sh.name}</td>
            <td className="filing-count">{sh.filing_count}</td>
          </tr>
        ))}
      </tbody></table>
    );
  }

  return (
    <div className="docket-view">
      {metadata.docket_number && (
        <div className="docket-metadata">
          <div className="metadata-header">
            <h3>{metadata.case_name || 'Docket Details'}</h3>
            <div className="metadata-info">
              <span className="docket-number">{metadata.docket_number}</span>
              {metadata.jurisdiction && <span className="jurisdiction">{metadata.jurisdiction}</span>}
              {metadata.status && <span className={`status-badge ${metadata.status.toLowerCase()}`}>{metadata.status}</span>}
            </div>
          </div>
        </div>
      )}

      <div className="docket-summary">
        <div className="docket-card"><span className="card-label">Total</span><span className="card-value">{stats.total}</span></div>
        <div className="docket-card relevance-high"><span className="card-label">High</span><span className="card-value">{stats.high}</span></div>
        <div className="docket-card position-oppose"><span className="card-label">Oppose</span><span className="card-value">{stats.oppose}</span></div>
        <div className="docket-card position-support"><span className="card-label">Support</span><span className="card-value">{stats.support}</span></div>
      </div>

      <div className="position-bar-container">
        <div className="position-bar">
          {stats.oppose > 0 && <div className="bar-segment oppose" style={{ width: `${(stats.oppose / stats.total) * 100}%` }} />}
          {stats.support > 0 && <div className="bar-segment support" style={{ width: `${(stats.support / stats.total) * 100}%` }} />}
          {stats.neutral > 0 && <div className="bar-segment neutral" style={{ width: `${(stats.neutral / stats.total) * 100}%` }} />}
        </div>
        <div className="position-legend">
          <span className="legend-item oppose">{stats.oppose} Oppose</span>
          <span className="legend-item support">{stats.support} Support</span>
          <span className="legend-item neutral">{stats.neutral} Neutral</span>
        </div>
      </div>

      <div className="docket-layout">
        <div className="docket-main sidebar-card">
          <h3>Docket Filings ({filteredEntries.length}{selectedStakeholder ? ` of ${entries.length}` : ''})</h3>
          <div className="docket-controls">
            <input type="text" placeholder="Search filings, filers, arguments..." value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)} className="docket-search" />
            {focusedEntryNo !== null && (
              <button className="clear-filter-btn" onClick={() => { setFocusedEntryNo(null); setExpandedEntry(null); }}>
                Filing #{focusedEntryNo} &times;
              </button>
            )}
            {selectedStakeholder && (
              <button className="clear-filter-btn" onClick={() => setSelectedStakeholder('')}>{selectedStakeholder} &times;</button>
            )}
            <div className="filter-group">
              {['all', 'Support', 'Oppose', 'Neutral'].map(f => (
                <button key={f} className={`filter-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f}</button>
              ))}
            </div>
            <div className="filter-sep" />
            <div className="filter-group">
              {[['all','All'],['high','High'],['medium','Med'],['low','Low']].map(([val, label]) => (
                <button key={val} className={`filter-btn ${relevanceFilter === val ? 'active' : ''}`} onClick={() => setRelevanceFilter(val)}>{label}</button>
              ))}
            </div>
          </div>

          {selectedStakeholder && (
            <div className="stakeholder-filter-banner" onClick={() => setSelectedStakeholder('')}>
              Showing filings by: <strong>{selectedStakeholder}</strong> ({filteredEntries.length} of {entries.length}) — click to clear
            </div>
          )}

          <div className="docket-entries">
            {filteredEntries.map((entry) => {
              const isExpanded = expandedEntry === entry.entry_no;
              return (
                <div key={entry.entry_no} className={`docket-entry relevance-${entry.relevance_level}`}>
                  <div className="entry-header" onClick={() => setExpandedEntry(isExpanded ? null : entry.entry_no)}>
                    <div className="entry-meta">
                      <span className="entry-no">#{entry.entry_no}</span>
                      <span className="entry-date">{formatDate(entry.received_date)}</span>
                    </div>
                    <div className="entry-center">
                      <div className="entry-title">{entry.title}</div>
                      <div className="entry-filer"><span className="filer-role">{entry.filer_role}</span> {entry.filer_name}</div>
                    </div>
                    <div className="entry-badges">
                      <span className={`relevance-badge ${entry.relevance_level}`}>{entry.relevance_level}</span>
                      <span className={`position-badge ${entry.position_on_deal.toLowerCase()}`}>{entry.position_on_deal}</span>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="entry-details">
                      {(entry.document_type || entry.proceeding_phase || entry.deadline_date) && (
                        <div className="detail-meta-row">
                          {entry.document_type && <span className="detail-meta-tag">{entry.document_type}</span>}
                          {entry.proceeding_phase && <span className="detail-meta-tag">{entry.proceeding_phase}</span>}
                          {entry.deadline_date && (
                            <span className="detail-meta-tag deadline">
                              Deadline: {formatDate(entry.deadline_date)}{entry.deadline_description && ` — ${entry.deadline_description}`}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="detail-section"><h4>Summary</h4><p>{entry.entry_summary}</p></div>
                      {entry.legal_regulatory_significance && (
                        <div className="detail-section"><h4>Legal / Regulatory Significance</h4><p>{entry.legal_regulatory_significance}</p></div>
                      )}
                      {entry.relief_requested && (
                        <div className="detail-section"><h4>Relief Requested</h4><p>{entry.relief_requested}</p></div>
                      )}
                      {entry.key_arguments && entry.key_arguments.length > 0 && (
                        <div className="detail-section"><h4>Key Arguments</h4><ul>{entry.key_arguments.map((arg, idx) => <li key={idx}>{arg}</li>)}</ul></div>
                      )}
                      {entry.key_excerpts && entry.key_excerpts.length > 0 && (
                        <div className="detail-section"><h4>Key Excerpts</h4><ul>{entry.key_excerpts.map((exc, idx) => <li key={idx}>{exc}</li>)}</ul></div>
                      )}
                      {entry.download_link && (
                        <div className="detail-section">
                          <a href={entry.download_link} target="_blank" rel="noopener noreferrer"
                             style={{ fontSize: '10px', color: 'var(--accent-blue)' }} onClick={e => e.stopPropagation()}>
                            View Filing
                          </a>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {filteredEntries.length === 0 && <div className="no-entries">No entries match the selected filters</div>}
        </div>

        <div className="docket-sidebar">
          <div className="sidebar-tabs">
            <button className={`sidebar-tab ${sidebarTab === 'stakeholders' ? 'active' : ''}`} onClick={() => setSidebarTab('stakeholders')}>Stakeholders ({stakeholders.length})</button>
            <button className={`sidebar-tab ${sidebarTab === 'conditions' ? 'active' : ''}`} onClick={() => setSidebarTab('conditions')}>Conditions ({conditions.length})</button>
            <button className={`sidebar-tab ${sidebarTab === 'query' ? 'active' : ''}`} onClick={() => setSidebarTab('query')}>Query</button>
          </div>

          {sidebarTab === 'conditions' && conditions.length > 0 && (
            <div className="sidebar-card conditions-card">
              <div className="stakeholder-sub-filters">
                {[{key:'all',label:'All',count:conditions.length,color:'color-blue'},{key:'resolved',label:'Ordered',count:condCounts.resolved,color:'color-green'},
                  {key:'settled',label:'Settled',count:condCounts.settled,color:'color-blue'},{key:'open',label:'Open',count:condCounts.open,color:'color-yellow'},
                  {key:'demand',label:'Demands',count:condCounts.demand,color:'color-red'}].map(({key,label,count,color}) => count > 0 && (
                  <button key={key} className={`filter-btn ${conditionFilter === key ? `active ${color}` : ''}`}
                    onClick={() => setConditionFilter(key as typeof conditionFilter)}>{label} {count}</button>
                ))}
              </div>
              <div className="conditions-list">
                {COND_GROUPS.map(({ key, label }) => {
                  if (conditionFilter !== 'all' && conditionFilter !== key) return null;
                  const sources = conditionGroups[key];
                  if (!sources) return null;
                  const totalInGroup = Object.values(sources).reduce((s, arr) => s + arr.length, 0);
                  if (totalInGroup === 0) return null;
                  return (
                    <div key={key} className="cond-category-group">
                      <div className={`cond-category-label cond-cat-${key}`}>{label} ({totalInGroup})</div>
                      {Object.entries(sources).sort((a,b) => b[1].length - a[1].length).map(([source, conds]) => {
                        const srcKey = `${key}:${source}`;
                        const isOpen = expandedCondSource.has(srcKey);
                        return (
                          <div key={srcKey} className="cond-source-group">
                            <div className="cond-source-header" onClick={() => toggleCondSource(srcKey)}>
                              <span className="cond-source-chevron">{isOpen ? '▾' : '▸'}</span>
                              <span className="cond-source-name" title={source}>{source}</span>
                              <span className="cond-source-count">{conds.length}</span>
                            </div>
                            {isOpen && (
                              <div className="cond-source-items">
                                {conds.map((c, idx) => (
                                  <div key={idx} className="cond-item">
                                    <div className="cond-item-row">
                                      <span className={`cond-status-dot ${c.status}`} title={c.status} />
                                      <span className="cond-item-text">{c.text}</span>
                                    </div>
                                    <div className="cond-refs">
                                      {c.asked_in && <span className="cond-ref" onClick={() => jumpToEntry(c.asked_in!.entry_no)}>Asked #{c.asked_in.entry_no} ({formatDate(c.asked_in.date)})</span>}
                                      {c.resolved_in ? <span className="cond-ref cond-ref-resolved" onClick={() => jumpToEntry(c.resolved_in!.entry_no)}>Resolved #{c.resolved_in.entry_no}</span>
                                        : <span className="cond-ref cond-ref-open">Unresolved</span>}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {sidebarTab === 'stakeholders' && stakeholders.length > 0 && (
            <div className="sidebar-card stakeholders-card">
              <div className="stakeholder-sub-filters">
                {[{key:'all',label:'All',count:stakeholders.length,color:'color-blue'},{key:'commission',label:'Commission',count:commissionStakeholders.length,color:'color-blue'},
                  {key:'parties',label:'Parties',count:partyStakeholders.length,color:'color-blue'},{key:'opposed',label:'Opposed',count:conciseGroups.opposed.length,color:'color-red'},
                  {key:'support',label:'Support',count:conciseGroups.settled.length,color:'color-green'},{key:'neutral',label:'Neutral',count:conciseGroups.neutral.length,color:'color-muted'}
                ].map(({key,label,count,color}) => count > 0 && (
                  <button key={key} className={`filter-btn ${stakeholderFilter === key ? `active ${color}` : ''}`}
                    onClick={() => setStakeholderFilter(key as typeof stakeholderFilter)}>{label} {count}</button>
                ))}
              </div>

              {(stakeholderFilter === 'all' || stakeholderFilter === 'commission') && commissionStakeholders.length > 0 && (
                <div className="role-group"><div className="role-label">Commission</div>{renderRoleTable(commissionStakeholders)}</div>
              )}
              {(stakeholderFilter === 'all' || stakeholderFilter === 'parties') && partyStakeholders.length > 0 && (
                <div className="role-group"><div className="role-label">Parties</div>{renderRoleTable(partyStakeholders)}</div>
              )}

              {(stakeholderFilter === 'all' || stakeholderFilter === 'opposed') && conciseGroups.opposed.length > 0 && (
                <div className="role-group">
                  <div className="sidebar-header-row">
                    <span className="role-label">Opposed ({conciseGroups.opposed.length})</span>
                    <div className="view-toggle">
                      <button className={`view-toggle-btn ${positionView === 'concise' ? 'active' : ''}`} onClick={() => setPositionView('concise')}>concise</button>
                      <button className={`view-toggle-btn ${positionView === 'fulsome' ? 'active' : ''}`} onClick={() => setPositionView('fulsome')}>fulsome</button>
                    </div>
                  </div>
                  {positionView === 'concise' ? (
                    <>
                      <div className="opposed-subfilters">
                        <button className={`filter-btn ${opposedSubfilter === 'all' ? 'active color-red' : ''}`} onClick={() => setOpposedSubfilter('all')}>All {conciseGroups.opposed.length}</button>
                        {INTERVENOR_SUBGROUPS.map(({ key, label }) => {
                          const count = (opposedBySubgroup[key] || []).length;
                          if (count === 0) return null;
                          return <button key={key} className={`filter-btn ${opposedSubfilter === key ? 'active color-red' : ''}`} onClick={() => setOpposedSubfilter(key)}>{label} {count}</button>;
                        })}
                      </div>
                      {renderStakeholderTable(opposedSubfilter === 'all' ? conciseGroups.opposed : (opposedBySubgroup[opposedSubfilter] || []), true)}
                    </>
                  ) : (
                    POSITION_TIERS.filter(t => t.key.includes('oppose')).map(({ key, label, tierColor }) => {
                      const group = classified[key];
                      if (!group || group.length === 0) return null;
                      return <div key={key} className="position-tier"><div className={`tier-label ${tierColor}`}>{label} ({group.length})</div>{renderStakeholderTable(group, true)}</div>;
                    })
                  )}
                </div>
              )}

              {(stakeholderFilter === 'all' || stakeholderFilter === 'support') && conciseGroups.settled.length > 0 && (
                <div className="role-group">
                  <div className="role-label">In Favor / Settled ({conciseGroups.settled.length})</div>
                  <div className="opposed-subfilters">
                    <button className={`filter-btn ${supportSubfilter === 'all' ? 'active color-green' : ''}`} onClick={() => setSupportSubfilter('all')}>All {conciseGroups.settled.length}</button>
                    {INTERVENOR_SUBGROUPS.map(({ key, label }) => {
                      const count = (supportBySubgroup[key] || []).length;
                      if (count === 0) return null;
                      return <button key={key} className={`filter-btn ${supportSubfilter === key ? 'active color-green' : ''}`} onClick={() => setSupportSubfilter(key)}>{label} {count}</button>;
                    })}
                  </div>
                  {renderStakeholderTable(supportSubfilter === 'all' ? conciseGroups.settled : (supportBySubgroup[supportSubfilter] || []), true)}
                </div>
              )}

              {(stakeholderFilter === 'all' || stakeholderFilter === 'neutral') && conciseGroups.neutral.length > 0 && (
                <div className="role-group"><div className="role-label">Neutral ({conciseGroups.neutral.length})</div>{renderStakeholderTable(conciseGroups.neutral)}</div>
              )}
            </div>
          )}

          {sidebarTab === 'query' && dealId && <DocketQuery dealId={dealId} />}
          {sidebarTab === 'query' && !dealId && <div className="dq-unavailable">No deal ID available for query.</div>}
        </div>
      </div>
    </div>
  );
}
