import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import DashboardNav from '../components/DashboardNav';
import '../styles/DealDetail.css';
import '../styles/CrossDeal.css';
import api from '../services/api';

interface UpcomingEvent {
  date: string;
  label: string;
  type: 'static' | 'deadline' | 'milestone';
  deal_id: string;
  deal_name: string;
  target: string;
  acquirer: string;
  target_ticker: string;
  ref?: string;
  calculation?: string;
}

const TYPE_COLORS: Record<string, string> = {
  'HSR Filing Deadline':       '#5ccfe6',
  'S-4 Filing Deadline':       '#5ccfe6',
  'Outside Date (Initial)':    '#f07178',
  'Outside Date (Extended)':   '#f07178',
  'Outside Date':              '#f07178',
  'Expected Close':            '#87d96c',
  'Merger Agreement Signed':   '#5ccfe6',
  'Boards Unanimously Approved': '#5ccfe6',
  'Confidentiality Agreement': 'rgba(92,207,230,0.5)',
};

function eventColor(event: UpcomingEvent): string {
  return TYPE_COLORS[event.label] || (event.type === 'deadline' ? '#ffcc66' : '#a8a8b3');
}

function daysUntil(dateStr: string): number {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

function bucket(dateStr: string): string {
  const d = daysUntil(dateStr);
  if (d <= 7)  return 'THIS WEEK';
  if (d <= 30) return 'NEXT 30 DAYS';
  if (d <= 90) return 'NEXT 90 DAYS';
  return 'LATER';
}

const BUCKET_ORDER = ['THIS WEEK', 'NEXT 30 DAYS', 'NEXT 90 DAYS', 'LATER'];

export default function UpcomingEvents() {
  const [events, setEvents] = useState<UpcomingEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'full' | 'watchlist'>('full');
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());

  useEffect(() => {
    const stored = localStorage.getItem('merger_arb_watchlist');
    if (stored) setWatchlist(new Set(JSON.parse(stored)));
  }, []);

  useEffect(() => {
    api.get(`/api/upcoming-events`)
      .then(res => { setEvents(res.data.events || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const visible = view === 'watchlist'
    ? events.filter(e => watchlist.has(e.deal_id))
    : events;

  // Group by bucket
  const grouped: Record<string, UpcomingEvent[]> = {};
  for (const e of visible) {
    const b = bucket(e.date);
    if (!grouped[b]) grouped[b] = [];
    grouped[b].push(e);
  }

  const formatDate = (s: string) =>
    new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="dashboard">
      <DashboardNav />

      <div className="page-header">
        <div className="header-content">
          <h1>Upcoming Events &amp; Triggers</h1>
          <p className="page-subtitle">Key dates across all deals — HSR, S-4, outside dates, closings</p>
        </div>
        <div className="upcoming-toggle">
          <button
            className={`view-toggle-btn ${view === 'full' ? 'active' : ''}`}
            onClick={() => setView('full')}
          >Full List</button>
          <button
            className={`view-toggle-btn ${view === 'watchlist' ? 'active' : ''}`}
            onClick={() => setView('watchlist')}
          >★ Watch List</button>
        </div>
      </div>

      {loading && <div className="loading">Loading upcoming events…</div>}

      {!loading && visible.length === 0 && (
        <div className="placeholder" style={{ margin: '40px auto' }}>
          <p>{view === 'watchlist' ? 'No watchlisted deals have upcoming events.' : 'No upcoming events found.'}</p>
          {view === 'watchlist' && <p className="muted">Star deals from the Tearsheet to add them to your watch list.</p>}
        </div>
      )}

      {!loading && BUCKET_ORDER.filter(b => grouped[b]?.length).map(b => (
        <div key={b} className="upcoming-bucket">
          <div className="upcoming-bucket-header">{b}</div>
          <table className="upcoming-table">
            <thead>
              <tr>
                <th>DATE</th>
                <th>DAYS</th>
                <th>EVENT</th>
                <th>DEAL</th>
                <th>TICKER</th>
                <th>REF</th>
              </tr>
            </thead>
            <tbody>
              {grouped[b].map((ev, i) => {
                const d = daysUntil(ev.date);
                const urgency = d <= 7 ? 'urgent' : d <= 30 ? 'soon' : '';
                return (
                  <tr key={i} className={`upcoming-row ${urgency}`}>
                    <td className="upcoming-date">{formatDate(ev.date)}</td>
                    <td className="upcoming-days">
                      <span className={`days-badge ${urgency}`}>
                        {d === 0 ? 'TODAY' : `${d}d`}
                      </span>
                    </td>
                    <td className="upcoming-label">
                      <span className="event-dot" style={{ background: eventColor(ev) }} />
                      {ev.label}
                      {ev.calculation && <span className="upcoming-calc"> · {ev.calculation}</span>}
                    </td>
                    <td className="upcoming-deal">
                      <Link to={`/deal/${ev.deal_id}`} className="deal-link">
                        {ev.target} / {ev.acquirer}
                      </Link>
                    </td>
                    <td className="upcoming-ticker">{ev.target_ticker || '—'}</td>
                    <td className="upcoming-ref">{ev.ref || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
