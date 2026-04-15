import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import DashboardNav from '../components/DashboardNav';
import '../styles/CrossDeal.css';
import api from '../services/api';

interface RegulatoryEvent {
  agency: string;
  event: string;
  event_date: string | null;
  status: string;
  notes: string;
  deal_id: string;
  deal_name: string;
}

interface RegulatorySummary {
  total_events: number;
  total_deals: number;
  pending_approvals: number;
  completed_approvals: number;
  events_by_agency: Array<{
    agency: string;
    count: number;
  }>;
  events_by_deal: Array<{
    deal_id: string;
    deal_name: string;
    event_count: number;
    pending_count: number;
  }>;
}

export default function AllRegulatory() {
  const [events, setEvents] = useState<RegulatoryEvent[]>([]);
  const [summary, setSummary] = useState<RegulatorySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [agencyFilter, setAgencyFilter] = useState<string>('all');
  const [dealFilter, setDealFilter] = useState<string>('all');

  useEffect(() => {
    fetchRegulatory();
  }, []);

  const fetchRegulatory = async () => {
    try {
      const { data } = await api.get(`/api/all-regulatory`);
      setEvents(data.events);
      setSummary(data.summary);
    } catch (error) {
      console.error('Error fetching regulatory events:', error);
    } finally {
      setLoading(false);
    }
  };

  // Filter events
  const filteredEvents = events.filter(event => {
    if (statusFilter !== 'all' && event.status !== statusFilter) return false;
    if (agencyFilter !== 'all' && event.agency !== agencyFilter) return false;
    if (dealFilter !== 'all' && event.deal_id !== dealFilter) return false;
    return true;
  });

  // Sort by date (most recent first, nulls last)
  const sortedEvents = [...filteredEvents].sort((a, b) => {
    if (!a.event_date) return 1;
    if (!b.event_date) return -1;
    return new Date(b.event_date).getTime() - new Date(a.event_date).getTime();
  });

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return 'TBD';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'completed': return 'status-completed';
      case 'pending': return 'status-pending';
      case 'not_required': return 'status-not-required';
      default: return '';
    }
  };

  return (
    <div className="dashboard">
      <DashboardNav />

      {loading && <div className="loading">Loading regulatory events...</div>}
      {!loading && (<>

      <div className="page-header">
        <div className="header-content">
          <h1>All Regulatory Events</h1>
          <p className="page-subtitle">Cross-deal regulatory timeline and approval tracking</p>
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="summary-cards">
          <div className="summary-card">
            <div className="card-label">Total Events</div>
            <div className="card-value">{summary.total_events}</div>
          </div>
          <div className="summary-card">
            <div className="card-label">Deals Tracked</div>
            <div className="card-value">{summary.total_deals}</div>
          </div>
          <div className="summary-card highlight-yellow">
            <div className="card-label">Pending Approvals</div>
            <div className="card-value">{summary.pending_approvals}</div>
          </div>
          <div className="summary-card highlight-green">
            <div className="card-label">Completed</div>
            <div className="card-value">{summary.completed_approvals}</div>
          </div>
        </div>
      )}

      {/* Agency Breakdown */}
      {summary && summary.events_by_agency.length > 0 && (
        <div className="agency-breakdown">
          <h3>Events by Agency</h3>
          <div className="agency-list">
            {summary.events_by_agency.map(item => (
              <div key={item.agency} className="agency-item">
                <span className="agency-name">{item.agency}</span>
                <span className="agency-count">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="filters-section">
        <div className="filter-groups">
          <div className="filter-group">
            <label>Deal:</label>
            <select value={dealFilter} onChange={(e) => setDealFilter(e.target.value)} className="filter-select">
              <option value="all">All Deals</option>
              {summary?.events_by_deal.map(deal => (
                <option key={deal.deal_id} value={deal.deal_id}>
                  {deal.deal_name} ({deal.event_count} events, {deal.pending_count} pending)
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label>Agency:</label>
            <select value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} className="filter-select">
              <option value="all">All Agencies</option>
              {summary?.events_by_agency.map(item => (
                <option key={item.agency} value={item.agency}>
                  {item.agency} ({item.count})
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label>Status:</label>
            <button className={`filter-btn ${statusFilter === 'all' ? 'active' : ''}`} onClick={() => setStatusFilter('all')}>All</button>
            <button className={`filter-btn ${statusFilter === 'pending' ? 'active' : ''}`} onClick={() => setStatusFilter('pending')}>Pending</button>
            <button className={`filter-btn ${statusFilter === 'completed' ? 'active' : ''}`} onClick={() => setStatusFilter('completed')}>Completed</button>
            <button className={`filter-btn ${statusFilter === 'not_required' ? 'active' : ''}`} onClick={() => setStatusFilter('not_required')}>Not Required</button>
          </div>
        </div>
      </div>

      {/* Events Timeline */}
      <div className="events-container">
        <div className="events-count">{filteredEvents.length} events</div>
        <div className="regulatory-table">
          <table>
            <thead>
              <tr>
                <th>Deal</th>
                <th>Agency</th>
                <th>Event</th>
                <th>Date</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {sortedEvents.map((event, idx) => (
                <tr key={idx} className={getStatusColor(event.status)}>
                  <td>
                    <Link to={`/deal/${event.deal_id}`} className="deal-link">
                      {event.deal_name}
                    </Link>
                  </td>
                  <td className="agency-cell">{event.agency}</td>
                  <td className="event-cell">{event.event}</td>
                  <td className="date-cell">{formatDate(event.event_date)}</td>
                  <td>
                    <span className={`status-badge ${event.status}`}>
                      {event.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="notes-cell">{event.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filteredEvents.length === 0 && (
          <div className="no-entries">No events match the selected filters</div>
        )}
      </div>
      </>)}
    </div>
  );
}
