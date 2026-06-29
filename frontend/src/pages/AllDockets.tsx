import { useState, useEffect, useMemo } from 'react';
import DashboardNav from '../components/DashboardNav';
import DocketView from '../components/DocketView';
import BusyLoader from '../components/BusyLoader';
import api from '../services/api';
import { useCachedFetch } from '../context/DashboardCacheContext';
import '../styles/CrossDeal.css';

/** Lightweight per-docket summary — returned by /api/all-dockets. */
interface DocketSummary {
  deal_id: string;
  /** docket_dashboard._id (MongoDB) or deal_id (static). Unique per docket. */
  docket_id: string;
  deal_name: string;
  target_ticker: string;
  acquirer_ticker: string;
  metadata: {
    docket_number?: string;
    case_name?: string;
    jurisdiction?: string;
    status?: string;
  };
  entry_count: number;
  high_relevance_count: number;
  opposition_count: number;
  support_count: number;
  latest_entry_date?: string;
}

/** Full per-docket payload — returned by /api/all-dockets/{docket_id}. */
interface DocketDetail {
  docket_id: string;
  deal_id: string;
  metadata: DocketSummary['metadata'];
  entries: any[];
  stakeholders: any[];
  conditions: any[];
}

export default function AllDockets() {
  const [activeDealGroup, setActiveDealGroup] = useState<string>('');
  const [activeSubTab, setActiveSubTab] = useState<string>('');

  // ── Stage 1 — lightweight list (counts + metadata only) ─────────────────
  const { data: summaryData, loading: summaryLoading } = useCachedFetch<{ deals: DocketSummary[] }>({
    cacheKey: 'all-dockets-summary',
    paramsKey: '',
    fetcher: () => api.get('/api/all-dockets').then(r => r.data),
  });
  const summaries: DocketSummary[] = summaryData?.deals ?? [];

  const dealGroups = useMemo(() => {
    const groups = new Map<string, DocketSummary[]>();
    for (const d of summaries) {
      const key = `${d.target_ticker}/${d.acquirer_ticker}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(d);
    }
    return groups;
  }, [summaries]);

  // Default selection on first load
  useEffect(() => {
    if (summaries.length > 0 && !activeDealGroup) {
      const firstKey = Array.from(dealGroups.keys())[0];
      setActiveDealGroup(firstKey);
      setActiveSubTab(dealGroups.get(firstKey)![0].docket_id);
    }
  }, [summaries, dealGroups, activeDealGroup]);

  const handleGroupClick = (groupKey: string) => {
    setActiveDealGroup(groupKey);
    const groupDeals = dealGroups.get(groupKey);
    if (groupDeals && groupDeals.length > 0) setActiveSubTab(groupDeals[0].docket_id);
  };

  const activeGroupDeals = dealGroups.get(activeDealGroup) || [];
  const activeSummary =
    activeGroupDeals.find(d => d.docket_id === activeSubTab) || activeGroupDeals[0] || null;
  const activeDocketId = activeSummary?.docket_id ?? '';

  // ── Stage 2 — full detail for the active docket only (cached per docket_id) ─
  const { data: detailData, loading: detailLoading } = useCachedFetch<DocketDetail>({
    cacheKey: 'docket-detail',
    paramsKey: activeDocketId,
    fetcher: () => api.get(`/api/all-dockets/${activeDocketId}`).then(r => r.data),
    enabled: Boolean(activeDocketId),
  });

  return (
    <div className="dashboard">
      <DashboardNav />
      {summaryLoading && <BusyLoader label="Loading dockets" size="lg" />}
      {!summaryLoading && (
        <>
          <div className="page-header">
            <div className="header-content"><h1>Regulatory Dockets</h1></div>
          </div>

          {/* Deal group tabs — render as soon as summary loads */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0', borderBottom: '2px solid #333', padding: '0 1rem' }}>
            {Array.from(dealGroups.entries()).map(([groupKey, groupDeals]) => {
              const isActive = activeDealGroup === groupKey;
              const totalEntries = groupDeals.reduce((sum, d) => sum + d.entry_count, 0);
              return (
                <button key={groupKey} onClick={() => handleGroupClick(groupKey)} style={{
                  padding: '0.6rem 1rem', background: isActive ? '#1a1a2e' : 'transparent',
                  color: isActive ? '#fff' : '#888', border: 'none',
                  borderBottom: isActive ? '2px solid #4a9eff' : '2px solid transparent',
                  cursor: 'pointer', fontSize: '0.9rem', fontWeight: isActive ? 600 : 400,
                  whiteSpace: 'nowrap', transition: 'all 0.15s ease', marginBottom: '-2px', letterSpacing: '0.02em',
                }}>
                  {groupKey}
                  <span style={{ marginLeft: '0.4rem', fontSize: '0.7rem', color: isActive ? '#666' : '#555' }}>{totalEntries}</span>
                </button>
              );
            })}
          </div>

          {/* Jurisdiction sub-tabs (when a deal has multiple dockets) */}
          {activeGroupDeals.length > 1 && (
            <div style={{ display: 'flex', gap: '0', borderBottom: '1px solid #2a2a3a', padding: '0 1rem', background: '#111122' }}>
              {activeGroupDeals.map((deal) => {
                const isActive = activeSubTab === deal.docket_id;
                const label = deal.metadata.jurisdiction || deal.metadata.docket_number || deal.deal_id;
                return (
                  <button key={deal.docket_id} onClick={() => setActiveSubTab(deal.docket_id)} style={{
                    padding: '0.5rem 0.9rem', background: 'transparent',
                    color: isActive ? '#4a9eff' : '#777', border: 'none',
                    borderBottom: isActive ? '2px solid #4a9eff' : '2px solid transparent',
                    cursor: 'pointer', fontSize: '0.78rem', fontWeight: isActive ? 600 : 400,
                    whiteSpace: 'nowrap', transition: 'all 0.15s ease', marginBottom: '-1px',
                  }}>
                    {label}
                    <span style={{ marginLeft: '0.3rem', fontSize: '0.65rem', color: '#555' }}>({deal.entry_count})</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Active docket — detail fetched on demand. While it loads, show a
              localized spinner so the tab strip stays visible. */}
          {activeSummary && (
            <div className="docket-tab-content">
              {(!detailData || detailLoading) ? (
                <BusyLoader
                  label={`Loading ${activeSummary.metadata.jurisdiction || 'docket'}`}
                  size="md"
                />
              ) : (
                <DocketView
                  key={activeDocketId}
                  entries={detailData.entries}
                  stakeholders={detailData.stakeholders}
                  conditions={detailData.conditions}
                  metadata={detailData.metadata}
                  dealId={detailData.deal_id}
                />
              )}
            </div>
          )}

          {summaries.length === 0 && (
            <div className="no-entries" style={{ textAlign: 'center', padding: '3rem' }}>
              No dockets found. Run docket extraction to populate this page.
            </div>
          )}
        </>
      )}
    </div>
  );
}
