import { useState, useEffect, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { Deal, DealsResponse, DealCategory, Pagination } from '../types/deal';
import DashboardNav from './DashboardNav';
import '../styles/CrossDeal.css';
import '../styles/Pipeline.css';
import api from '../services/api';
import { usePermissions } from '../hooks/usePermissions';

// Category ordering (matches Python CATEGORY_ORDER)
const CATEGORY_ORDER: DealCategory[] = [
  "Mkt Perceived as Low-risk / Near-Term Timing",
  "Mkt Perceived as Low-risk / Mid-to-Long-Term Timing",
  "Mkt Perceived as Higher-risk",
  "Fluctuating Consideration / CVRs / Hard to Borrow",
  "LBOs",
  "Bank Deals",
  "Proposed / Non-definitive",
];

export default function PipelineTable() {
  const { allowedDealIds } = usePermissions();
  const [dealsData, setDealsData] = useState<DealsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'watchlist'>('watchlist');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;
  const [quotesMap, setQuotesMap] = useState<Record<string, any>>({});
  const [quotesLoading, setQuotesLoading] = useState(false);

  // Load watchlist from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('merger_arb_watchlist');
    if (stored) {
      setWatchlist(new Set(JSON.parse(stored)));
    }
  }, []);

  // Debounce search — wait 500ms after user stops typing, then reset page + fire search
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setDebouncedSearch(searchTerm);
    }, 750);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Fetch deals from API (re-runs when page or debounced search changes)
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(PAGE_SIZE),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(allowedDealIds !== 'all' ? { ids: allowedDealIds.join(',') } : {}),
    });
    api.get(`/api/deals?${params}`, { signal: controller.signal })
      .then(res => {
        setDealsData(res.data);
        setLoading(false);
      })
      .catch(err => {
        if (err.name !== 'AbortError' && err.code !== 'ERR_CANCELED') {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [page, debouncedSearch, allowedDealIds]);

  // After deals load, fetch all quotes in parallel via batch endpoint
  useEffect(() => {
    if (!dealsData?.deals?.length) return;
    const tickers = [...new Set([
      ...dealsData.deals.map(d => d.target_ticker).filter(Boolean),
      ...dealsData.deals.filter(d => d.deal_type !== 'cash' && d.acquirer_ticker).map(d => d.acquirer_ticker),
    ])];
    if (!tickers.length) return;
    setQuotesLoading(true);
    api.get(`/api/quotes/batch?tickers=${tickers.join(',')}`)
      .then(res => { setQuotesMap(res.data); setQuotesLoading(false); })
      .catch(() => setQuotesLoading(false));
  }, [dealsData]);

  // Spread helpers using live prices from batch
  const getLivePrice = (deal: any): number | null =>
    quotesMap[deal.target_ticker]?.current_price || null;

  const getGrossSpreadDollars = (deal: any): number => {
    const p = getLivePrice(deal);
    return p !== null ? deal.offer_price - p : deal.gross_spread_dollars;
  };

  const getGrossSpreadPct = (deal: any): number => {
    const p = getLivePrice(deal);
    if (p === null || p === 0) return deal.gross_spread_pct;
    return (getGrossSpreadDollars(deal) / p) * 100;
  };

  const getNetSpreadDollars = (deal: any): number => {
    const p = getLivePrice(deal);
    if (p === null) return deal.net_spread_dollars;
    const borrowCost = p * deal.borrow_rate_annual * (deal.days_to_close / 365);
    return getGrossSpreadDollars(deal) - borrowCost + deal.dividend_expected;
  };

  const getNetSpreadPct = (deal: any): number => {
    const p = getLivePrice(deal);
    if (p === null || p === 0) return deal.net_spread_pct;
    return (getNetSpreadDollars(deal) / p) * 100;
  };

  const toggleWatch = (dealId: string) => {
    const newWatchlist = new Set(watchlist);
    if (newWatchlist.has(dealId)) {
      newWatchlist.delete(dealId);
    } else {
      newWatchlist.add(dealId);
    }
    setWatchlist(newWatchlist);
    localStorage.setItem('merger_arb_watchlist', JSON.stringify([...newWatchlist]));
  };

  const refreshPrices = async () => {
    setRefreshing(true);
    try {
      const { data: result } = await api.post(`/api/refresh-prices`);
      const { data: dealsData } = await api.get(`/api/deals?page=${page}&page_size=${PAGE_SIZE}`);
      setDealsData(dealsData);
      alert(`Successfully updated ${result.updated_count} of ${result.total_deals} deals`);
    } catch (err) {
      alert(`Error refreshing prices: ${err}`);
    } finally {
      setRefreshing(false);
    }
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const getStatusClass = (status: string): string => {
    const classes: Record<string, string> = {
      pending: 'status-pending',
      regulatory_review: 'status-review',
      shareholder_vote: 'status-vote',
      closing: 'status-closing',
      at_risk: 'status-risk',
      completed: 'status-completed',
    };
    return classes[status] || 'status-pending';
  };

  const getStatusLabel = (status: string): string => {
    const labels: Record<string, string> = {
      pending: 'Pending',
      regulatory_review: 'Reg Review',
      shareholder_vote: 'Shareholder Vote',
      closing: 'Closing',
      at_risk: 'At Risk',
      completed: 'Completed',
    };
    return labels[status] || status;
  };

  const getSpreadClass = (pct: number, isNet: boolean = false): string => {
    const threshold = isNet ? 2 : 3;
    if (pct < threshold) return 'spread-tight';
    if (pct < (isNet ? 6 : 8)) return 'spread-mid';
    return 'spread-wide';
  };

  // Filter deals (search is handled server-side)
  const filterDeals = (deals: Deal[]): Deal[] => {
    return deals.filter(deal => {
      if (filter === 'watchlist' && !watchlist.has(deal.id)) {
        return false;
      }
      return true;
    });
  };

  // Group deals by category
  const groupByCategory = (deals: Deal[]) => {
    const grouped: Record<string, Deal[]> = {};
    for (const category of CATEGORY_ORDER) {
      grouped[category] = [];
    }
    
    deals.forEach(deal => {
      if (grouped[deal.category]) {
        grouped[deal.category].push(deal);
      }
    });

    return grouped;
  };

  if (loading) {
    return (
      <div className="dashboard">
        <DashboardNav />
        <div className="loading">Loading deals...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard">
        <DashboardNav />
        <div className="error">Error: {error}</div>
      </div>
    );
  }

  if (!dealsData) return null;

  const filteredDeals = filterDeals(dealsData.deals);
  const groupedDeals = groupByCategory(filteredDeals);
  const summary = dealsData.summary;

  return (
    <div className="dashboard">
      <DashboardNav />

      {/* Standard Header */}
      <div className="page-header">
        <div className="header-content">
          <h1>Deal Pipeline</h1>
          <p className="page-subtitle">Active merger arbitrage positions</p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="summary-cards">
        <div className="summary-card">
          <div className="card-label">Total Deals</div>
          <div className="card-value">{summary.total_deals}</div>
        </div>
        <div className="summary-card">
          <div className="card-label">Total Value</div>
          <div className="card-value">${summary.total_value_bn.toFixed(0)}B</div>
        </div>
        <div className="summary-card highlight-yellow">
          <div className="card-label">Avg Spread</div>
          <div className="card-value">{summary.avg_gross_spread.toFixed(1)}%</div>
        </div>
        <div className="summary-card highlight-red">
          <div className="card-label">At Risk</div>
          <div className="card-value">{summary.at_risk_count}</div>
        </div>
      </div>

      {/* Filter Bar — Watchlist / All Deals toggle (matches Tearsheet) */}
      <div className="filter-bar" style={{padding: '0 var(--space-lg)', marginBottom: 'var(--space-sm)'}}>
        <div className="filter-tabs">
          <button
            className={`filter-btn ${filter === 'watchlist' ? 'active' : ''}`}
            onClick={() => setFilter('watchlist')}
          >
            Watchlist ({watchlist.size})
          </button>
          <button
            className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All Deals ({dealsData?.pagination?.total_deals || 0})
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="filters-section">
        <div className="filter-row">
          <div className="search-bar">
            <input
              type="text"
              placeholder="Search deals..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="search-input"
            />
          </div>
          <div className="filter-group">
            <button
              className="refresh-btn"
              onClick={refreshPrices}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing...' : 'Refresh Prices'}
            </button>
          </div>
        </div>
      </div>

      {/* Deals Table */}
      <div className="table-container">
        <table className="deals-table">
          <thead>
            <tr>
              <th className="col-watch"></th>
              <th>Target</th>
              <th>Acquirer</th>
              <th>Current</th>
              <th>Offer</th>
              <th>Gross Spread</th>
              <th>Net Spread</th>
              <th>Est. Close</th>
              <th>Status</th>
              <th>Next Milestone</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORY_ORDER.map(category => {
              const categoryDeals = groupedDeals[category];
              if (categoryDeals.length === 0) return null;

              return (
                <Fragment key={category}>
                  <tr className="category-row">
                    <td colSpan={10} className="category-cell">{category}</td>
                  </tr>
                  {categoryDeals.map(deal => (
                    <tr key={deal.id} className="deal-row">
                      <td 
                        className="cell-watch"
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          toggleWatch(deal.id);
                        }}
                      >
                        <span className={`watch-star ${watchlist.has(deal.id) ? 'watched' : ''}`}>
                          {watchlist.has(deal.id) ? '★' : '☆'}
                        </span>
                      </td>
                      <td className="cell-target">
                        <Link to={`/deal/${deal.id}`} className="deal-link">
                          <div className="company-primary">{deal.target}</div>
                          <div className="company-ticker">{deal.target_ticker}</div>
                        </Link>
                      </td>
                      <td className="cell-acquirer">
                        <Link to={`/deal/${deal.id}`} className="deal-link">
                          <div className="company-primary">{deal.acquirer}</div>
                          <div className="company-ticker">{deal.acquirer_ticker}</div>
                        </Link>
                      </td>
                      <td className="cell-price">
                        <Link to={`/deal/${deal.id}`} className="deal-link">
                          {getLivePrice(deal) !== null
                            ? `$${getLivePrice(deal)!.toFixed(2)}`
                            : quotesLoading ? '…' : `$${deal.current_price.toFixed(2)}`}
                        </Link>
                      </td>
                      <td className="cell-offer">
                        <Link to={`/deal/${deal.id}`} className="deal-link">
                          <div>${deal.offer_price.toFixed(2)}</div>
                          {deal.stock_ratio > 0 && (
                            <div className="company-ticker" style={{ fontSize: '9px' }}>
                              {deal.cash_per_share > 0 ? `$${deal.cash_per_share.toFixed(0)}+` : ''}{deal.stock_ratio}x {deal.acquirer_ticker}
                            </div>
                          )}
                        </Link>
                      </td>
                      <td className={`cell-spread ${getSpreadClass(getGrossSpreadPct(deal))}`}>
                        <Link to={`/deal/${deal.id}`} className="deal-link">
                          <div className="spread-dollars">${getGrossSpreadDollars(deal).toFixed(2)}</div>
                          <div className="spread-pct">{getGrossSpreadPct(deal).toFixed(1)}%</div>
                        </Link>
                      </td>
                      <td className={`cell-spread ${getSpreadClass(getNetSpreadPct(deal), true)}`}>
                        <Link to={`/deal/${deal.id}`} className="deal-link">
                          <div className="spread-dollars">${getNetSpreadDollars(deal).toFixed(2)}</div>
                          <div className="spread-pct">{getNetSpreadPct(deal).toFixed(1)}%</div>
                        </Link>
                      </td>
                      <td className="cell-close-date">
                        <Link to={`/deal/${deal.id}`} className="deal-link">
                          {formatDate(deal.expected_close)}
                        </Link>
                      </td>
                      <td className="cell-status">
                        <Link to={`/deal/${deal.id}`} className="deal-link">
                          <span className={`status-badge ${getStatusClass(deal.status)}`}>
                            {getStatusLabel(deal.status)}
                          </span>
                        </Link>
                      </td>
                      <td className="cell-milestone">
                        <Link to={`/deal/${deal.id}`} className="deal-link">
                          <div className="milestone-text">{deal.next_milestone}</div>
                          <div className="milestone-date">{formatDate(deal.next_milestone_date)}</div>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination Controls */}
      {dealsData?.pagination && (
        <div className="pagination-bar">
          <button
            className="pagination-btn"
            onClick={() => setPage(p => p - 1)}
            disabled={!dealsData.pagination.has_prev}
          >
            ← Prev
          </button>
          <span className="pagination-info">
            Page {dealsData.pagination.page} of {dealsData.pagination.total_pages}
            &nbsp;·&nbsp;
            {dealsData.pagination.total_deals} total deals
          </span>
          <button
            className="pagination-btn"
            onClick={() => setPage(p => p + 1)}
            disabled={!dealsData.pagination.has_next}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}