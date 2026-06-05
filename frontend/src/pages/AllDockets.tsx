import { useState, useEffect, useMemo } from 'react';
import DashboardNav from '../components/DashboardNav';
import DocketView from '../components/DocketView';
import api from '../services/api';
import '../styles/CrossDeal.css';

interface DocketDeal {
  deal_id: string;
  deal_name: string;
  target_ticker: string;
  acquirer_ticker: string;
  metadata: {
    docket_number?: string;
    case_name?: string;
    jurisdiction?: string;
    status?: string;
  };
  entries: any[];
  stakeholders: any[];
  conditions: any[];
  entry_count: number;
  high_relevance_count: number;
  opposition_count: number;
  support_count: number;
  latest_entry_date?: string;
}

export default function AllDockets() {
  const [deals, setDeals] = useState<DocketDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeDealGroup, setActiveDealGroup] = useState<string>('');
  const [activeSubTab, setActiveSubTab] = useState<string>('');

  useEffect(() => { fetchDockets(); }, []);

  const fetchDockets = async () => {
    try {
      const { data } = await api.get('/api/all-dockets');
      setDeals(data.deals || []);
    } catch (error) {
      console.error('Error fetching dockets:', error);
    } finally {
      setLoading(false);
    }
  };

  const dealGroups = useMemo(() => {
    const groups = new Map<string, DocketDeal[]>();
    for (const deal of deals) {
      const key = `${deal.target_ticker}/${deal.acquirer_ticker}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(deal);
    }
    return groups;
  }, [deals]);

  useEffect(() => {
    if (deals.length > 0 && !activeDealGroup) {
      const firstKey = Array.from(dealGroups.keys())[0];
      setActiveDealGroup(firstKey);
      setActiveSubTab(dealGroups.get(firstKey)![0].deal_id);
    }
  }, [deals, dealGroups]);

  const handleGroupClick = (groupKey: string) => {
    setActiveDealGroup(groupKey);
    const groupDeals = dealGroups.get(groupKey);
    if (groupDeals && groupDeals.length > 0) setActiveSubTab(groupDeals[0].deal_id);
  };

  const activeDeal = deals.find(d => d.deal_id === activeSubTab);
  const activeGroupDeals = dealGroups.get(activeDealGroup) || [];

  return (
    <div className="dashboard">
      <DashboardNav />
      {loading && <div className="loading">Loading dockets...</div>}
      {!loading && (
        <>
          <div className="page-header">
            <div className="header-content"><h1>Regulatory Dockets</h1></div>
          </div>

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

          {activeGroupDeals.length > 1 && (
            <div style={{ display: 'flex', gap: '0', borderBottom: '1px solid #2a2a3a', padding: '0 1rem', background: '#111122' }}>
              {activeGroupDeals.map((deal) => {
                const isActive = activeSubTab === deal.deal_id;
                const label = deal.metadata.jurisdiction || deal.metadata.docket_number || deal.deal_id;
                return (
                  <button key={deal.deal_id} onClick={() => setActiveSubTab(deal.deal_id)} style={{
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

          {activeDeal && (
            <div className="docket-tab-content">
              <DocketView
                entries={activeDeal.entries}
                stakeholders={activeDeal.stakeholders}
                conditions={activeDeal.conditions}
                metadata={activeDeal.metadata}
                dealId={activeDeal.deal_id}
              />
            </div>
          )}

          {deals.length === 0 && (
            <div className="no-entries" style={{ textAlign: 'center', padding: '3rem' }}>
              No dockets found. Run docket extraction to populate this page.
            </div>
          )}
        </>
      )}
    </div>
  );
}
