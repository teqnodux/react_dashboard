import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Deal } from '../types/deal';
import DashboardNav from '../components/DashboardNav';
import TearsheetTooltip from '../components/TearsheetTooltip';
import '../styles/DealDetail.css';
import '../styles/CrossDeal.css';
import api from '../services/api';
import { usePermissions } from '../hooks/usePermissions';

export default function PipelineTearsheet() {
  const { allowedDealIds } = usePermissions();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<{ total_deals: number; total_pages: number; has_next: boolean; has_prev: boolean } | null>(null);
  const PAGE_SIZE = 20;
  const [expandedColumnGroups, setExpandedColumnGroups] = useState<Set<string>>(new Set());
  const [quotesMap, setQuotesMap] = useState<Record<string, any>>({});  // ticker → quote
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [quotesTimestamp, setQuotesTimestamp] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'watchlist'>('watchlist');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [sortColumn, setSortColumn] = useState<string>('gross_spread_pct');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [selectedRowIndex, setSelectedRowIndex] = useState<number>(-1);

  // Quick filters
  const [dealTypeFilter, setDealTypeFilter] = useState<string>('all');
  const [spreadRangeFilter, setSpreadRangeFilter] = useState<string>('all');
  const [timingFilter, setTimingFilter] = useState<string>('all');
  const [selectedDeals, setSelectedDeals] = useState<Set<string>>(new Set());
  const [expandedCalculations, setExpandedCalculations] = useState<Set<string>>(new Set());

  // Column visibility
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [showColumnSettings, setShowColumnSettings] = useState<boolean>(false);
  const [columnOrder, setColumnOrder] = useState<string[]>([
    'target', 'acquirer', 'consideration', 'trading', 'gross', 'net', 'timing', 'downsides'
  ]);

  // Custom views
  interface CustomView {
    name: string;
    filters: {
      statusFilter?: string;
      agencyFilter?: string;
      dealFilter?: string;
      dealTypeFilter: string;
      spreadRangeFilter: string;
      timingFilter: string;
      searchTerm: string;
    };
    sorting: {
      sortColumn: string;
      sortDirection: 'asc' | 'desc';
    };
    hiddenColumns: string[];
    expandedColumns: string[];
  }

  const [savedViews, setSavedViews] = useState<CustomView[]>([]);
  const [showSaveViewModal, setShowSaveViewModal] = useState<boolean>(false);
  const [newViewName, setNewViewName] = useState<string>('');
  const [showViewsDropdown, setShowViewsDropdown] = useState<boolean>(false);

  // Deal comparison
  const [compareMode, setCompareMode] = useState<boolean>(false);
  const [compareDeals, setCompareDeals] = useState<Set<string>>(new Set());
  const [showComparison, setShowComparison] = useState<boolean>(false);

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
        setDeals(res.data.deals);
        setPagination(res.data.pagination);
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

  const toggleColumnGroup = (groupName: string) => {
    const newExpanded = new Set(expandedColumnGroups);
    if (newExpanded.has(groupName)) {
      newExpanded.delete(groupName);
    } else {
      newExpanded.add(groupName);
    }
    setExpandedColumnGroups(newExpanded);
  };

  const fetchLiveQuotes = async () => {
    if (!deals.length) return;
    const tickers = [...new Set([
      ...deals.map(d => d.target_ticker).filter(Boolean),
      ...deals.filter(d => d.deal_type !== 'cash' && d.acquirer_ticker).map(d => d.acquirer_ticker),
    ])];
    if (!tickers.length) return;
    setQuotesLoading(true);
    try {
      const { data } = await api.get(`/api/quotes/batch?tickers=${tickers.join(',')}`);
      setQuotesMap(data);
      setQuotesTimestamp(Date.now());
    } catch (err) {
      console.error('Error fetching batch quotes:', err);
    }
    setQuotesLoading(false);
  };

  // Auto-fetch quotes after deals load
  useEffect(() => {
    if (deals.length) fetchLiveQuotes();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deals]);

  const getTimeSinceUpdate = (): string => {
    if (!quotesTimestamp) return '';
    const seconds = Math.floor((Date.now() - quotesTimestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  };

  // Spread helpers using live prices
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

  const getAnnualizedGross = (deal: any): number =>
    (getGrossSpreadPct(deal) / deal.days_to_close) * 365;

  const getAnnualizedNet = (deal: any): number =>
    (getNetSpreadPct(deal) / deal.days_to_close) * 365;

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

  // Category ordering
  const CATEGORY_ORDER = [
    "Mkt Perceived as Low-risk / Near-Term Timing",
    "Mkt Perceived as Low-risk / Mid-to-Long-Term Timing",
    "Mkt Perceived as Higher-risk",
    "Fluctuating Consideration / CVRs / Hard to Borrow",
    "LBOs",
    "Bank Deals",
    "Proposed / Non-definitive",
  ];

  // Filter deals
  const filteredDeals = deals.filter(deal => {
    // Watchlist filter
    if (filter === 'watchlist' && !watchlist.has(deal.id)) {
      return false;
    }

    // Deal type filter
    if (dealTypeFilter !== 'all' && deal.deal_type !== dealTypeFilter) {
      return false;
    }

    // Spread range filter
    if (spreadRangeFilter !== 'all') {
      const spread = deal.gross_spread_pct;
      if (spreadRangeFilter === 'tight' && spread >= 3) return false;
      if (spreadRangeFilter === 'mid' && (spread < 3 || spread >= 8)) return false;
      if (spreadRangeFilter === 'wide' && spread < 8) return false;
    }

    // Timing filter
    if (timingFilter !== 'all') {
      const daysToClose = deal.days_to_close;
      if (timingFilter === 'near' && daysToClose > 90) return false;
      if (timingFilter === 'mid' && (daysToClose <= 90 || daysToClose > 180)) return false;
      if (timingFilter === 'long' && daysToClose <= 180) return false;
    }

    return true;
  });

  // Sort deals
  const sortedDeals = [...filteredDeals].sort((a, b) => {
    // Watchlist items always come first
    const aWatch = watchlist.has(a.id) ? 0 : 1;
    const bWatch = watchlist.has(b.id) ? 0 : 1;
    if (aWatch !== bWatch) return aWatch - bWatch;

    let aVal: any = a[sortColumn as keyof Deal];
    let bVal: any = b[sortColumn as keyof Deal];

    // Handle date sorting
    if (sortColumn === 'expected_close' || sortColumn === 'announce_date') {
      aVal = new Date(aVal as string).getTime();
      bVal = new Date(bVal as string).getTime();
    }

    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  });

  // Group by category — Watchlist as its own group at top
  const WATCHLIST_GROUP = '⭐ Watchlist';
  const groupedDeals: Record<string, Deal[]> = {};
  if (watchlist.size > 0 && filter !== 'watchlist') {
    groupedDeals[WATCHLIST_GROUP] = [];
  }
  for (const category of CATEGORY_ORDER) {
    groupedDeals[category] = [];
  }
  sortedDeals.forEach(deal => {
    // Add to Watchlist group if watched (and not in watchlist-only filter mode)
    if (watchlist.has(deal.id) && filter !== 'watchlist' && groupedDeals[WATCHLIST_GROUP]) {
      groupedDeals[WATCHLIST_GROUP].push(deal);
    }
    // Also add to normal category group
    if (groupedDeals[deal.category]) {
      groupedDeals[deal.category].push(deal);
    }
  });

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  const toggleCategory = (category: string) => {
    const newCollapsed = new Set(collapsedCategories);
    if (newCollapsed.has(category)) {
      newCollapsed.delete(category);
    } else {
      newCollapsed.add(category);
    }
    setCollapsedCategories(newCollapsed);
  };

  const toggleColumnVisibility = (columnGroup: string) => {
    const newHidden = new Set(hiddenColumns);
    if (newHidden.has(columnGroup)) {
      newHidden.delete(columnGroup);
    } else {
      newHidden.add(columnGroup);
    }
    setHiddenColumns(newHidden);
    localStorage.setItem('tearsheet_hidden_columns', JSON.stringify([...newHidden]));
  };

  // Load hidden columns from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('tearsheet_hidden_columns');
    if (stored) {
      setHiddenColumns(new Set(JSON.parse(stored)));
    }
  }, []);

  // Load saved views from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('tearsheet_saved_views');
    if (stored) {
      setSavedViews(JSON.parse(stored));
    }
  }, []);

  const saveCurrentView = () => {
    if (!newViewName.trim()) return;

    const newView: CustomView = {
      name: newViewName,
      filters: {
        dealTypeFilter,
        spreadRangeFilter,
        timingFilter,
        searchTerm,
      },
      sorting: {
        sortColumn,
        sortDirection,
      },
      hiddenColumns: [...hiddenColumns],
      expandedColumns: [...expandedColumnGroups],
    };

    const updatedViews = [...savedViews, newView];
    setSavedViews(updatedViews);
    localStorage.setItem('tearsheet_saved_views', JSON.stringify(updatedViews));
    setNewViewName('');
    setShowSaveViewModal(false);
  };

  const loadView = (view: CustomView) => {
    setDealTypeFilter(view.filters.dealTypeFilter);
    setSpreadRangeFilter(view.filters.spreadRangeFilter);
    setTimingFilter(view.filters.timingFilter);
    setSearchTerm(view.filters.searchTerm);
    setSortColumn(view.sorting.sortColumn);
    setSortDirection(view.sorting.sortDirection);
    setHiddenColumns(new Set(view.hiddenColumns));
    setExpandedColumnGroups(new Set(view.expandedColumns));
    setShowViewsDropdown(false);
  };

  const deleteView = (viewName: string) => {
    const updatedViews = savedViews.filter(v => v.name !== viewName);
    setSavedViews(updatedViews);
    localStorage.setItem('tearsheet_saved_views', JSON.stringify(updatedViews));
  };

  const toggleCompareMode = () => {
    setCompareMode(!compareMode);
    setCompareDeals(new Set());
    setShowComparison(false);
  };

  const toggleCompareDeal = (dealId: string) => {
    const newCompare = new Set(compareDeals);
    if (newCompare.has(dealId)) {
      newCompare.delete(dealId);
    } else if (newCompare.size < 3) {
      newCompare.add(dealId);
    }
    setCompareDeals(newCompare);
  };

  // Close column settings dropdown when clicking outside
  useEffect(() => {
    if (!showColumnSettings) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.column-settings-wrapper')) {
        setShowColumnSettings(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showColumnSettings]);

  const toggleSelectDeal = (dealId: string) => {
    const newSelected = new Set(selectedDeals);
    if (newSelected.has(dealId)) {
      newSelected.delete(dealId);
    } else {
      newSelected.add(dealId);
    }
    setSelectedDeals(newSelected);
  };

  const toggleSelectAll = () => {
    if (selectedDeals.size === filteredDeals.length) {
      setSelectedDeals(new Set());
    } else {
      setSelectedDeals(new Set(filteredDeals.map(d => d.id)));
    }
  };

  const bulkAddToWatchlist = () => {
    const newWatchlist = new Set(watchlist);
    selectedDeals.forEach(id => newWatchlist.add(id));
    setWatchlist(newWatchlist);
    localStorage.setItem('merger_arb_watchlist', JSON.stringify([...newWatchlist]));
    setSelectedDeals(new Set());
  };

  const bulkRemoveFromWatchlist = () => {
    const newWatchlist = new Set(watchlist);
    selectedDeals.forEach(id => newWatchlist.delete(id));
    setWatchlist(newWatchlist);
    localStorage.setItem('merger_arb_watchlist', JSON.stringify([...newWatchlist]));
    setSelectedDeals(new Set());
  };

  // Helper function to get spread color class
  const getSpreadColorClass = (spreadPct: number): string => {
    if (spreadPct < 3) return 'spread-tight'; // Green
    if (spreadPct < 8) return 'spread-mid'; // Yellow
    return 'spread-wide'; // Red
  };

  // Helper function to determine if deal is at-risk
  const isAtRisk = (deal: Deal): boolean => {
    const spread = getGrossSpreadPct(deal);
    const price = getLivePrice(deal) ?? deal.current_price;
    const wideSpread = spread >= 8;
    const highDownside = price > 0 ? ((deal.unaffected_price - price) / price * 100) < -20 : false;
    const outsideDate = deal.outside_date ? new Date(deal.outside_date) : null;
    const daysToOutside = outsideDate ? Math.floor((outsideDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)) : 999;
    const approachingOutside = daysToOutside < 60 && daysToOutside > 0;
    return wideSpread || highDownside || approachingOutside;
  };

  const hasRegulatoryChallenges = (deal: Deal): boolean => {
    return getGrossSpreadPct(deal) >= 10;
  };

  // Helper function to check if approaching outside date
  const isApproachingOutsideDate = (deal: Deal): boolean => {
    const outsideDate = deal.outside_date ? new Date(deal.outside_date) : null;
    if (!outsideDate) return false;
    const daysToOutside = Math.floor((outsideDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
    return daysToOutside < 60 && daysToOutside > 0;
  };

  const hasHighDownsideRisk = (deal: Deal): boolean => {
    const price = getLivePrice(deal) ?? deal.current_price;
    if (!price) return false;
    return ((deal.unaffected_price - price) / price * 100) < -20;
  };

  const getSpreadTrend = (deal: Deal): { icon: string; color: string; tooltip: string } => {
    const spread = getGrossSpreadPct(deal);
    const daysToClose = deal.days_to_close;

    // Tight spreads typically tighten further as close date approaches
    if (spread < 3 && daysToClose < 90) {
      return { icon: '↘', color: '#22c55e', tooltip: 'Spread tightening' };
    }

    // Wide spreads may indicate widening due to concerns
    if (spread > 8) {
      return { icon: '↗', color: '#ef4444', tooltip: 'Spread widening' };
    }

    // Mid-range spreads with long timeline may be stable
    if (spread >= 3 && spread <= 8 && daysToClose > 180) {
      return { icon: '→', color: '#eab308', tooltip: 'Spread stable' };
    }

    // Mid-range spreads tightening as close approaches
    if (spread >= 3 && spread <= 8 && daysToClose < 90) {
      return { icon: '↘', color: '#22c55e', tooltip: 'Spread tightening' };
    }

    // Default: stable
    return { icon: '→', color: '#94a3b8', tooltip: 'Spread stable' };
  };

  const exportToCSV = () => {
    // Create CSV headers
    const headers = [
      'Watch',
      !hiddenColumns.has('target') && 'Target',
      !hiddenColumns.has('target') && 'Target Ticker',
      !hiddenColumns.has('acquirer') && 'Acquirer',
      !hiddenColumns.has('acquirer') && 'Acquirer Ticker',
      !hiddenColumns.has('consideration') && 'Cash',
      !hiddenColumns.has('consideration') && 'Stock',
      !hiddenColumns.has('consideration') && 'Total Value (B)',
      !hiddenColumns.has('trading') && 'TGT Price',
      !hiddenColumns.has('trading') && 'Acquirer Price',
      !hiddenColumns.has('gross') && 'Gross Spread $',
      !hiddenColumns.has('gross') && 'Gross Spread %',
      !hiddenColumns.has('gross') && 'Annualized Gross %',
      !hiddenColumns.has('net') && 'Net Spread $',
      !hiddenColumns.has('net') && 'Net Spread %',
      !hiddenColumns.has('net') && 'Annualized Net %',
      !hiddenColumns.has('timing') && 'Timing Ann %',
      !hiddenColumns.has('timing') && 'Close Date',
      !hiddenColumns.has('timing') && 'Announce Date',
      !hiddenColumns.has('downsides') && 'IPC',
      !hiddenColumns.has('downsides') && 'Up/Down %',
    ].filter(Boolean).join(',');

    // Create CSV rows
    const rows = filteredDeals.map(deal => {
      const row = [
        watchlist.has(deal.id) ? 'Y' : 'N',
        !hiddenColumns.has('target') && `"${deal.target}"`,
        !hiddenColumns.has('target') && deal.target_ticker,
        !hiddenColumns.has('acquirer') && `"${deal.acquirer}"`,
        !hiddenColumns.has('acquirer') && (deal.acquirer_ticker || 'N/A'),
        !hiddenColumns.has('consideration') && (deal.deal_type === 'cash' ? deal.offer_price.toFixed(2) : '—'),
        !hiddenColumns.has('consideration') && (deal.deal_type === 'stock' ? deal.offer_price.toFixed(2) : '—'),
        !hiddenColumns.has('consideration') && deal.deal_value_bn.toFixed(2),
        !hiddenColumns.has('trading') && (getLivePrice(deal) ?? deal.current_price).toFixed(2),
        !hiddenColumns.has('trading') && (quotesMap[deal.acquirer_ticker]?.current_price?.toFixed(2) || '—'),
        !hiddenColumns.has('gross') && getGrossSpreadDollars(deal).toFixed(2),
        !hiddenColumns.has('gross') && getGrossSpreadPct(deal).toFixed(2),
        !hiddenColumns.has('gross') && getAnnualizedGross(deal).toFixed(2),
        !hiddenColumns.has('net') && getNetSpreadDollars(deal).toFixed(2),
        !hiddenColumns.has('net') && getNetSpreadPct(deal).toFixed(2),
        !hiddenColumns.has('net') && getAnnualizedNet(deal).toFixed(2),
        !hiddenColumns.has('timing') && getAnnualizedGross(deal).toFixed(2),
        !hiddenColumns.has('timing') && new Date(deal.expected_close).toLocaleDateString(),
        !hiddenColumns.has('timing') && new Date(deal.announce_date).toLocaleDateString(),
        !hiddenColumns.has('downsides') && deal.unaffected_price.toFixed(2),
        !hiddenColumns.has('downsides') && (() => { const p = getLivePrice(deal) ?? deal.current_price; return p ? ((deal.unaffected_price - p) / p * 100).toFixed(2) : '—'; })(),
      ].filter(x => x !== false).join(',');
      return row;
    });

    // Combine headers and rows
    const csv = [headers, ...rows].join('\n');

    // Create blob and download
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `merger-arb-tearsheet-${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (sortedDeals.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedRowIndex(prev => Math.min(prev + 1, sortedDeals.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedRowIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && selectedRowIndex >= 0) {
        e.preventDefault();
        const selectedDeal = sortedDeals[selectedRowIndex];
        if (selectedDeal) {
          window.location.href = `/deal/${selectedDeal.id}`;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedRowIndex, sortedDeals]);

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

  return (
    <div className="dashboard">
      <DashboardNav />

      <div className="page-header">
        <div className="header-content">
          <h1>Pipeline Tearsheet</h1>
          <p className="page-subtitle">Comprehensive view of all deals in the pipeline</p>
        </div>
      </div>

      <div className="tearsheet-container">

        {/* Filter Bar */}
        <div className="filter-bar">
          <div className="filter-tabs">
            <button
              className={`filter-btn ${filter === 'watchlist' ? 'active' : ''}`}
              onClick={() => setFilter('watchlist')}
            >
              ⭐ Watchlist ({watchlist.size})
            </button>
            <button
              className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              All Deals ({pagination?.total_deals ?? deals.length})
            </button>

            {/* Quick Filters */}
            <select
              value={dealTypeFilter}
              onChange={(e) => setDealTypeFilter(e.target.value)}
              className="filter-dropdown"
            >
              <option value="all">All Types</option>
              <option value="cash">Cash</option>
              <option value="stock">Stock</option>
              <option value="mixed">Mixed</option>
            </select>

            <select
              value={spreadRangeFilter}
              onChange={(e) => setSpreadRangeFilter(e.target.value)}
              className="filter-dropdown"
            >
              <option value="all">All Spreads</option>
              <option value="tight">Tight (&lt;3%)</option>
              <option value="mid">Mid (3-8%)</option>
              <option value="wide">Wide (&gt;8%)</option>
            </select>

            <select
              value={timingFilter}
              onChange={(e) => setTimingFilter(e.target.value)}
              className="filter-dropdown"
            >
              <option value="all">All Timing</option>
              <option value="near">Near-term (&lt;90d)</option>
              <option value="mid">Mid-term (90-180d)</option>
              <option value="long">Long-term (&gt;180d)</option>
            </select>

            {/* Bulk Actions */}
            {selectedDeals.size > 0 && (
              <>
                <span style={{marginLeft: 'auto', fontSize: '13px', color: 'var(--text-secondary)'}}>
                  {selectedDeals.size} selected
                </span>
                <button
                  className="filter-btn"
                  onClick={bulkAddToWatchlist}
                  title="Add selected to watchlist"
                >
                  ⭐ Add to Watchlist
                </button>
                <button
                  className="filter-btn"
                  onClick={bulkRemoveFromWatchlist}
                  title="Remove selected from watchlist"
                >
                  ☆ Remove from Watchlist
                </button>
                <button
                  className="filter-btn"
                  onClick={() => setSelectedDeals(new Set())}
                  title="Clear selection"
                >
                  ✕ Clear
                </button>
              </>
            )}

            {/* Export Button */}
            {selectedDeals.size === 0 && (
              <button
                className="filter-btn"
                onClick={exportToCSV}
                title="Export to CSV"
                style={{marginLeft: 'auto'}}
              >
                📥 Export
              </button>
            )}

            {/* Saved Views */}
            {selectedDeals.size === 0 && (
              <div className="column-settings-wrapper" style={{position: 'relative'}}>
                <button
                  className="filter-btn"
                  onClick={() => setShowViewsDropdown(!showViewsDropdown)}
                  title="Saved Views"
                >
                  💾 Views ({savedViews.length})
                </button>
                {showViewsDropdown && (
                  <div className="column-settings-dropdown" style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: '8px',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    padding: '12px',
                    minWidth: '250px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    zIndex: 1000
                  }}>
                    <div style={{fontSize: '12px', fontWeight: 'bold', marginBottom: '8px', color: 'var(--text-primary)'}}>
                      Saved Views
                    </div>
                    {savedViews.length === 0 ? (
                      <div style={{fontSize: '12px', color: 'var(--text-secondary)', padding: '8px 0'}}>
                        No saved views yet
                      </div>
                    ) : (
                      savedViews.map(view => (
                        <div key={view.name} style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '6px 0',
                          borderBottom: '1px solid var(--border)',
                        }}>
                          <button
                            onClick={() => loadView(view)}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--accent-blue)',
                              cursor: 'pointer',
                              fontSize: '13px',
                              textAlign: 'left',
                              flex: 1,
                            }}
                          >
                            {view.name}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteView(view.name);
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--text-muted)',
                              cursor: 'pointer',
                              fontSize: '16px',
                              padding: '0 4px',
                            }}
                            title="Delete view"
                          >
                            ✕
                          </button>
                        </div>
                      ))
                    )}
                    <button
                      onClick={() => {
                        setShowViewsDropdown(false);
                        setShowSaveViewModal(true);
                      }}
                      style={{
                        marginTop: '8px',
                        width: '100%',
                        padding: '6px',
                        background: 'var(--accent-blue)',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px',
                      }}
                    >
                      + Save Current View
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Compare Mode */}
            {selectedDeals.size === 0 && !compareMode && (
              <button
                className="filter-btn"
                onClick={toggleCompareMode}
                title="Compare Deals"
              >
                ⚖️ Compare
              </button>
            )}
            {compareMode && (
              <>
                <span style={{fontSize: '13px', color: 'var(--text-secondary)'}}>
                  Select up to 3 deals ({compareDeals.size}/3)
                </span>
                <button
                  className="filter-btn"
                  onClick={() => {
                    if (compareDeals.size >= 2) {
                      setShowComparison(true);
                    }
                  }}
                  disabled={compareDeals.size < 2}
                  style={{
                    background: compareDeals.size >= 2 ? 'var(--accent-blue)' : 'var(--bg-secondary)',
                    color: compareDeals.size >= 2 ? 'white' : 'var(--text-muted)',
                    cursor: compareDeals.size >= 2 ? 'pointer' : 'not-allowed',
                  }}
                >
                  View Comparison
                </button>
                <button
                  className="filter-btn"
                  onClick={toggleCompareMode}
                >
                  ✕ Cancel
                </button>
              </>
            )}

            {/* Column Settings */}
            {!compareMode && (
              <div className="column-settings-wrapper" style={{position: 'relative'}}>
                <button
                  className="filter-btn"
                  onClick={() => setShowColumnSettings(!showColumnSettings)}
                  title="Column Settings"
                >
                  ⚙️ Columns
                </button>
              {showColumnSettings && (
                <div className="column-settings-dropdown" style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: '8px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '4px',
                  padding: '12px',
                  minWidth: '200px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                  zIndex: 1000
                }}>
                  <div style={{fontSize: '12px', fontWeight: 'bold', marginBottom: '8px', color: 'var(--text-primary)'}}>
                    Show/Hide Columns
                  </div>
                  {[
                    { key: 'target', label: 'Target Information' },
                    { key: 'acquirer', label: 'Acquirer Information' },
                    { key: 'consideration', label: 'Consideration Details' },
                    { key: 'trading', label: 'Trading Quotes' },
                    { key: 'gross', label: 'Gross Spread' },
                    { key: 'net', label: 'Net Spread' },
                    { key: 'timing', label: 'Timing' },
                    { key: 'downsides', label: 'Downsides' }
                  ].map(col => (
                    <label key={col.key} style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '6px 0',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: 'var(--text-primary)'
                    }}>
                      <input
                        type="checkbox"
                        checked={!hiddenColumns.has(col.key)}
                        onChange={() => toggleColumnVisibility(col.key)}
                        style={{marginRight: '8px'}}
                      />
                      {col.label}
                    </label>
                  ))}
                </div>
              )}
              </div>
            )}
          </div>
          <div className="filter-search">
            <input
              type="text"
              placeholder="Search deals..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>

        <div className="tearsheet-table-wrapper">
          <table className="tearsheet-table">
            <thead style={{position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-primary)'}}>
              <tr>
                {/* Select Column */}
                <th className="col-select">
                  {!compareMode && (
                    <input
                      type="checkbox"
                      checked={filteredDeals.length > 0 && selectedDeals.size === filteredDeals.length}
                      onChange={toggleSelectAll}
                      title="Select all"
                    />
                  )}
                  {compareMode && (
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }} title="Compare mode">⚖️</span>
                  )}
                </th>
                {/* Watch Column */}
                <th className="col-watch"></th>

                {/* Target Information */}
                {!hiddenColumns.has('target') && (
                  <th className="column-group-header" colSpan={expandedColumnGroups.has('target') ? 4 : 1}>
                    <span className="group-title">Target Information</span>
                    <button
                      className="expand-column-btn"
                      onClick={() => toggleColumnGroup('target')}
                    >
                      {expandedColumnGroups.has('target') ? '−' : '+'}
                    </button>
                  </th>
                )}

                {/* Acquirer Information */}
                {!hiddenColumns.has('acquirer') && (
                  <th className="column-group-header" colSpan={expandedColumnGroups.has('acquirer') ? 4 : 1}>
                    <span className="group-title">Acquirer Information</span>
                    <button
                      className="expand-column-btn"
                      onClick={() => toggleColumnGroup('acquirer')}
                    >
                      {expandedColumnGroups.has('acquirer') ? '−' : '+'}
                    </button>
                  </th>
                )}

                {/* Consideration Details */}
                {!hiddenColumns.has('consideration') && (
                  <th className="column-group-header" colSpan={expandedColumnGroups.has('consideration') ? 5 : 2}>
                    <span className="group-title">Consideration Details</span>
                    <button
                      className="expand-column-btn"
                      onClick={() => toggleColumnGroup('consideration')}
                    >
                      {expandedColumnGroups.has('consideration') ? '−' : '+'}
                    </button>
                  </th>
                )}

                {/* Trading Quotes */}
                {!hiddenColumns.has('trading') && (
                  <th className="column-group-header" colSpan={expandedColumnGroups.has('trading') ? 5 : 2}>
                    <span className="group-title">Trading Quotes</span>
                    <button
                      className="expand-column-btn"
                      onClick={() => toggleColumnGroup('trading')}
                    >
                      {expandedColumnGroups.has('trading') ? '−' : '+'}
                    </button>
                  </th>
                )}

                {/* Gross Spread */}
                {!hiddenColumns.has('gross') && (
                  <th className="column-group-header" colSpan={expandedColumnGroups.has('gross') ? 3 : 2}>
                    <span className="group-title">Gross Spread</span>
                    <button
                      className="expand-column-btn"
                      onClick={() => toggleColumnGroup('gross')}
                    >
                      {expandedColumnGroups.has('gross') ? '−' : '+'}
                    </button>
                  </th>
                )}

                {/* Net Spread */}
                {!hiddenColumns.has('net') && (
                  <th className="column-group-header" colSpan={expandedColumnGroups.has('net') ? 5 : 2}>
                    <span className="group-title">Net Spread</span>
                    <button
                      className="expand-column-btn"
                      onClick={() => toggleColumnGroup('net')}
                    >
                      {expandedColumnGroups.has('net') ? '−' : '+'}
                    </button>
                  </th>
                )}

                {/* Timing */}
                {!hiddenColumns.has('timing') && (
                  <th className="column-group-header" colSpan={expandedColumnGroups.has('timing') ? 4 : 2}>
                    <span className="group-title">Timing</span>
                    <button
                      className="expand-column-btn"
                      onClick={() => toggleColumnGroup('timing')}
                    >
                      {expandedColumnGroups.has('timing') ? '−' : '+'}
                    </button>
                  </th>
                )}

                {/* Downsides */}
                {!hiddenColumns.has('downsides') && (
                  <th className="column-group-header" colSpan={expandedColumnGroups.has('downsides') ? 3 : 2}>
                    <span className="group-title">Downsides</span>
                    <button
                      className="expand-column-btn"
                      onClick={() => toggleColumnGroup('downsides')}
                    >
                      {expandedColumnGroups.has('downsides') ? '−' : '+'}
                    </button>
                  </th>
                )}
              </tr>

              <tr className="column-headers">
                {/* Select Column */}
                <th></th>
                {/* Watch Column */}
                <th></th>

                {/* Target Information */}
                {!hiddenColumns.has('target') && (
                  <>
                    <th>Target</th>
                    {expandedColumnGroups.has('target') && (
                      <>
                        <th>Share Price</th>
                        <th>Shares Out (M)</th>
                        <th>Market Cap</th>
                      </>
                    )}
                  </>
                )}

                {/* Acquirer Information */}
                {!hiddenColumns.has('acquirer') && (
                  <>
                    <th>Acquirer</th>
                    {expandedColumnGroups.has('acquirer') && (
                      <>
                        <th>Share Price</th>
                        <th>Shares Out (M)</th>
                        <th>Market Cap</th>
                      </>
                    )}
                  </>
                )}

                {/* Consideration Details */}
                {!hiddenColumns.has('consideration') && (
                  <>
                    <th>Cash</th>
                    <th>Stock</th>
                    {expandedColumnGroups.has('consideration') && (
                      <>
                        <th>Per Share Value</th>
                        <th>Premium %</th>
                        <th>Total Value</th>
                      </>
                    )}
                  </>
                )}

                {/* Trading Quotes */}
                {!hiddenColumns.has('trading') && (
                  <>
                    <th>TGT</th>
                    <th>Acquirer</th>
                    {expandedColumnGroups.has('trading') && (
                      <>
                        <th>Bid</th>
                        <th>Ask</th>
                        <th>Volume</th>
                      </>
                    )}
                  </>
                )}

                {/* Gross Spread */}
                {!hiddenColumns.has('gross') && (
                  <>
                    <th onClick={() => handleSort('gross_spread_dollars')} style={{cursor: 'pointer'}}>
                      $ {sortColumn === 'gross_spread_dollars' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </th>
                    <th onClick={() => handleSort('gross_spread_pct')} style={{cursor: 'pointer'}}>
                      % {sortColumn === 'gross_spread_pct' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </th>
                    {expandedColumnGroups.has('gross') && (
                      <>
                        <th onClick={() => handleSort('annualized_gross')} style={{cursor: 'pointer'}}>
                          Annualized {sortColumn === 'annualized_gross' && (sortDirection === 'asc' ? '↑' : '↓')}
                        </th>
                      </>
                    )}
                  </>
                )}

                {/* Net Spread */}
                {!hiddenColumns.has('net') && (
                  <>
                    <th onClick={() => handleSort('net_spread_dollars')} style={{cursor: 'pointer'}}>
                      $ {sortColumn === 'net_spread_dollars' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </th>
                    <th onClick={() => handleSort('net_spread_pct')} style={{cursor: 'pointer'}}>
                      % {sortColumn === 'net_spread_pct' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </th>
                    {expandedColumnGroups.has('net') && (
                      <>
                        <th>Borrow Cost</th>
                        <th>Dividend</th>
                        <th onClick={() => handleSort('annualized_net')} style={{cursor: 'pointer'}}>
                          Ann. Net {sortColumn === 'annualized_net' && (sortDirection === 'asc' ? '↑' : '↓')}
                        </th>
                      </>
                    )}
                  </>
                )}

                {/* Timing */}
                {!hiddenColumns.has('timing') && (
                  <>
                    <th>Timing Ann (%)</th>
                    <th>Close Date</th>
                    {expandedColumnGroups.has('timing') && (
                      <>
                        <th>Announce Date</th>
                        <th>Outside Date</th>
                      </>
                    )}
                  </>
                )}

                {/* Downsides */}
                {!hiddenColumns.has('downsides') && (
                  <>
                    <th>IPC</th>
                    <th>Up/Down</th>
                    {expandedColumnGroups.has('downsides') && (
                      <>
                        <th>Break Price</th>
                      </>
                    )}
                  </>
                )}
              </tr>
            </thead>

            <tbody>
              {sortedDeals.map((deal) => {
                const targetQuote = quotesMap[deal.target_ticker];
                const acquirerQuote = deal.acquirer_ticker ? quotesMap[deal.acquirer_ticker] : null;

                return (
                  <tr
                    key={deal.id}
                    className={`tearsheet-row ${isAtRisk(deal) ? 'row-at-risk' : ''}`}
                  >
                    {/* Select Checkbox */}
                    <td
                      className="cell-select"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        if (compareMode) {
                          toggleCompareDeal(deal.id);
                        } else {
                          toggleSelectDeal(deal.id);
                        }
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={compareMode ? compareDeals.has(deal.id) : selectedDeals.has(deal.id)}
                        onChange={() => compareMode ? toggleCompareDeal(deal.id) : toggleSelectDeal(deal.id)}
                        onClick={(e) => e.stopPropagation()}
                        disabled={compareMode && !compareDeals.has(deal.id) && compareDeals.size >= 3}
                      />
                    </td>

                    {/* Watch Star */}
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

                    {/* Target Information */}
                    {!hiddenColumns.has('target') && (
                      <>
                        <td className="cell-target">
                          <Link to={`/deal/${deal.id}`} className="deal-link">
                            <div className="company-primary">
                              {hasRegulatoryChallenges(deal) && (
                                <span className="indicator-icon regulatory-flag" title="Potential regulatory challenges">🚩</span>
                              )}
                              {deal.target}
                            </div>
                            <div className="company-ticker">{deal.target_ticker}</div>
                          </Link>
                        </td>
                        {expandedColumnGroups.has('target') && (
                          <>
                            <td className="price-cell">
                              <span className="price-value">
                                {targetQuote?.current_price ? `$${targetQuote.current_price.toFixed(2)}` : quotesLoading ? '…' : `$${deal.current_price.toFixed(2)}`}
                              </span>
                            </td>
                            <td className="number-cell">
                              <span className="muted">—</span>
                            </td>
                            <td className="value-cell">
                              <span className="muted">—</span>
                            </td>
                          </>
                        )}
                      </>
                    )}

                    {/* Acquirer Information */}
                    {!hiddenColumns.has('acquirer') && (
                      <>
                        <td className="cell-acquirer">
                          <Link to={`/deal/${deal.id}`} className="deal-link">
                            <div className="company-primary">{deal.acquirer}</div>
                            <div className="company-ticker">{deal.acquirer_ticker || 'N/A'}</div>
                          </Link>
                        </td>
                        {expandedColumnGroups.has('acquirer') && (
                          <>
                            <td className="price-cell">
                              <span className="muted">—</span>
                            </td>
                            <td className="number-cell">
                              <span className="muted">—</span>
                            </td>
                            <td className="value-cell">
                              <span className="muted">—</span>
                            </td>
                          </>
                        )}
                      </>
                    )}

                    {/* Consideration Details - Cash, Stock */}
                    {!hiddenColumns.has('consideration') && (
                      <>
                        <td className="price-cell">
                          <TearsheetTooltip
                            title="Consideration Details"
                            position="top"
                            content={
                              <div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr'}}>
                                  <div><div className="tooltip-label">Cash</div><div className="tooltip-value">{deal.deal_type === 'cash' ? `$${deal.offer_price.toFixed(2)}` : '$0.00'}</div></div>
                                  <div><div className="tooltip-label">ACI Divs</div><div className="tooltip-value">$0.05</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr'}}>
                                  <div><div className="tooltip-label">Stock</div><div className="tooltip-value">{deal.deal_type === 'stock' ? `$${deal.offer_price.toFixed(2)}` : '0.00'}</div></div>
                                  <div><div className="tooltip-label">Number</div><div className="tooltip-value">2</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr'}}>
                                  <div><div className="tooltip-label">Other</div><div className="tooltip-value">$0</div></div>
                                  <div><div className="tooltip-label">Total</div><div className="tooltip-value">$0.10</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr'}}>
                                  <div><div className="tooltip-label">CVR</div><div className="tooltip-value">$0</div></div>
                                  <div><div className="tooltip-label">KR Divs</div><div className="tooltip-value">n/a</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr'}}>
                                  <div><div className="tooltip-label">Proration</div><div className="tooltip-value">n/a</div></div>
                                  <div><div className="tooltip-label">Collar</div><div className="tooltip-value">n/a</div></div>
                                </div>
                              </div>
                            }
                          >
                            <span className="price-value">
                              {deal.deal_type === 'cash' ? `$${deal.offer_price.toFixed(2)}` : '—'}
                            </span>
                          </TearsheetTooltip>
                        </td>
                        <td className="price-cell">
                          <span className="price-value">
                            {deal.deal_type === 'stock' ? `$${deal.offer_price.toFixed(2)}` : '—'}
                          </span>
                        </td>
                        {expandedColumnGroups.has('consideration') && (
                      <>
                        <td className="price-cell">
                          <TearsheetTooltip
                            title="Consideration Details"
                            position="top"
                            content={
                              <div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr'}}>
                                  <div><div className="tooltip-label">Cash</div><div className="tooltip-value">{deal.deal_type === 'cash' ? `$${deal.offer_price.toFixed(2)}` : '$0.00'}</div></div>
                                  <div><div className="tooltip-label">ACI Divs</div><div className="tooltip-value">$0.05</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr'}}>
                                  <div><div className="tooltip-label">Stock</div><div className="tooltip-value">{deal.deal_type === 'stock' ? `$${deal.offer_price.toFixed(2)}` : '0.00'}</div></div>
                                  <div><div className="tooltip-label">Number</div><div className="tooltip-value">2</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr'}}>
                                  <div><div className="tooltip-label">Other</div><div className="tooltip-value">$0</div></div>
                                  <div><div className="tooltip-label">Total</div><div className="tooltip-value">$0.10</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr'}}>
                                  <div><div className="tooltip-label">CVR</div><div className="tooltip-value">$0</div></div>
                                  <div><div className="tooltip-label">KR Divs</div><div className="tooltip-value">n/a</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr'}}>
                                  <div><div className="tooltip-label">Proration</div><div className="tooltip-value">n/a</div></div>
                                  <div><div className="tooltip-label">Collar</div><div className="tooltip-value">n/a</div></div>
                                </div>
                              </div>
                            }
                          >
                            <span className="price-value">${deal.offer_price.toFixed(2)}</span>
                          </TearsheetTooltip>
                        </td>
                        <td className="percent-cell">
                          <span className="percent-value">
                            {((deal.offer_price - deal.unaffected_price) / deal.unaffected_price * 100).toFixed(1)}%
                          </span>
                        </td>
                        <td className="value-cell">
                          <span className="value-text">${deal.deal_value_bn.toFixed(2)}B</span>
                        </td>
                      </>
                        )}
                      </>
                    )}

                    {/* Trading Quotes - TGT, Acquirer */}
                    {!hiddenColumns.has('trading') && (
                      <>
                        <td className="price-cell">
                      <TearsheetTooltip
                        title="Trading Details"
                        position="top"
                        content={
                          <div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr 1fr'}}>
                              <div><div className="tooltip-label">Target Bid</div><div className="tooltip-value">{targetQuote?.bid ? `$${targetQuote.bid.toFixed(2)}` : '—'}</div></div>
                              <div><div className="tooltip-label">Target Last</div><div className="tooltip-value">{targetQuote?.current_price ? `$${targetQuote.current_price.toFixed(2)}` : '—'}</div></div>
                              <div><div className="tooltip-label">Target Ask</div><div className="tooltip-value">{targetQuote?.ask ? `$${targetQuote.ask.toFixed(2)}` : '—'}</div></div>
                            </div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr 1fr'}}>
                              <div><div className="tooltip-label">Spread Bid</div><div className="tooltip-value">{targetQuote?.bid ? `$${(deal.offer_price - targetQuote.bid).toFixed(2)}` : '—'}</div></div>
                              <div><div className="tooltip-label">Spread Last</div><div className="tooltip-value">${getGrossSpreadDollars(deal).toFixed(2)}</div></div>
                              <div><div className="tooltip-label">Spread Ask</div><div className="tooltip-value">{targetQuote?.ask ? `$${(deal.offer_price - targetQuote.ask).toFixed(2)}` : '—'}</div></div>
                            </div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr 1fr 1fr'}}>
                              <div><div className="tooltip-label">Vol (mm)</div><div className="tooltip-value">{targetQuote?.volume && targetQuote?.current_price ? `$${((targetQuote.volume * targetQuote.current_price) / 1000000).toFixed(2)}` : '—'}</div></div>
                              <div><div className="tooltip-label">Vol (shares)</div><div className="tooltip-value">{targetQuote?.volume ? targetQuote.volume.toLocaleString() : '—'}</div></div>
                              <div><div className="tooltip-label">30-day Vol</div><div className="tooltip-value">—</div></div>
                            </div>
                          </div>
                        }
                      >
                        <span className="price-value">
                          {targetQuote?.current_price
                            ? `$${targetQuote.current_price.toFixed(2)}`
                            : quotesLoading ? '…' : `$${deal.current_price.toFixed(2)}`}
                          {quotesTimestamp && (
                            <span className="refresh-indicator" title={`Last updated: ${new Date(quotesTimestamp).toLocaleTimeString()}`}>
                              🔄 {getTimeSinceUpdate()}
                            </span>
                          )}
                        </span>
                      </TearsheetTooltip>
                    </td>
                    <td className="price-cell">
                      <span className={acquirerQuote?.current_price ? "price-value" : "muted"}>
                        {acquirerQuote?.current_price ? `$${acquirerQuote.current_price.toFixed(2)}` : '—'}
                      </span>
                    </td>
                    {expandedColumnGroups.has('trading') && (
                      <>
                        <td className="price-cell">
                          <span className={targetQuote?.bid ? "price-value" : "muted"}>
                            {targetQuote?.bid ? `$${targetQuote.bid.toFixed(2)}` : '—'}
                          </span>
                        </td>
                        <td className="price-cell">
                          <span className={targetQuote?.ask ? "price-value" : "muted"}>
                            {targetQuote?.ask ? `$${targetQuote.ask.toFixed(2)}` : '—'}
                          </span>
                        </td>
                        <td className="volume-cell">
                          <span className={targetQuote?.volume ? "volume-value" : "muted"}>
                            {targetQuote?.volume ? targetQuote.volume.toLocaleString() : '—'}
                          </span>
                        </td>
                      </>
                    )}
                      </>
                    )}

                    {/* Gross Spread */}
                    {!hiddenColumns.has('gross') && (
                      <>
                        <td className={`spread-cell ${getSpreadColorClass(getGrossSpreadPct(deal))}`}>
                          <span className="spread-dollars">${getGrossSpreadDollars(deal).toFixed(2)}</span>
                        </td>
                        <td className={`spread-cell ${getSpreadColorClass(getGrossSpreadPct(deal))}`}>
                          <span
                            className="spread-trend"
                            style={{ color: getSpreadTrend(deal).color }}
                            title={getSpreadTrend(deal).tooltip}
                          >
                            {getSpreadTrend(deal).icon}
                          </span>
                          <span className="spread-pct">{getGrossSpreadPct(deal).toFixed(2)}%</span>
                        </td>
                        {expandedColumnGroups.has('gross') && (
                          <>
                            <td className={`spread-cell ${getSpreadColorClass(getGrossSpreadPct(deal))}`}>
                              <span className="spread-pct">{getAnnualizedGross(deal).toFixed(2)}%</span>
                            </td>
                          </>
                        )}
                      </>
                    )}

                    {/* Net Spread */}
                    {!hiddenColumns.has('net') && (
                      <>
                        <td className={`spread-cell ${getSpreadColorClass(getNetSpreadPct(deal))}`}>
                          <span className="spread-dollars">${getNetSpreadDollars(deal).toFixed(2)}</span>
                        </td>
                        <td className={`spread-cell ${getSpreadColorClass(getNetSpreadPct(deal))}`}>
                          <span className="spread-pct">{getNetSpreadPct(deal).toFixed(2)}%</span>
                        </td>
                        {expandedColumnGroups.has('net') && (
                          <>
                            <td className="cost-cell">
                              <span className="cost-value">${(() => { const p = getLivePrice(deal) ?? deal.current_price; return (p * deal.borrow_rate_annual * deal.days_to_close / 365).toFixed(2); })()}</span>
                            </td>
                            <td className="cost-cell">
                              <span className="cost-value">${deal.dividend_expected.toFixed(2)}</span>
                            </td>
                            <td className="spread-cell">
                              <span className="spread-pct">{getAnnualizedNet(deal).toFixed(2)}%</span>
                            </td>
                          </>
                        )}
                      </>
                    )}

                    {/* Timing - Timing Ann (%), Close Date */}
                    {!hiddenColumns.has('timing') && (
                      <>
                        <td className="spread-cell">
                          <span className="spread-pct">{getAnnualizedGross(deal).toFixed(2)}%</span>
                        </td>
                        <td className="date-cell">
                      <TearsheetTooltip
                        title="Timing Details"
                        position="top"
                        content={
                          <div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                              <div><div className="tooltip-label">Announcement Date</div><div className="tooltip-value">{new Date(deal.announce_date).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })}</div></div>
                            </div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                              <div><div className="tooltip-label">Closing Guidance</div><div className="tooltip-value">2H25</div></div>
                            </div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                              <div><div className="tooltip-label">Our Est. Close</div><div className="tooltip-value">{new Date(deal.expected_close).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })}</div></div>
                            </div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                              <div><div className="tooltip-label">HSR Filed</div><div className="tooltip-value">11/20/23</div></div>
                            </div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                              <div><div className="tooltip-label">FTC Second Request Issued</div><div className="tooltip-value">12/20/23</div></div>
                            </div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                              <div><div className="tooltip-label">Timing Agreement Entered</div><div className="tooltip-value">12/20/24</div></div>
                            </div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                              <div><div className="tooltip-label">Timing Agreement Expired</div><div className="tooltip-value">3/20/24</div></div>
                            </div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                              <div><div className="tooltip-label">FTC Lawsuit Filed</div><div className="tooltip-value">3/15/24</div></div>
                            </div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                              <div><div className="tooltip-label">Companies' Response Filed</div><div className="tooltip-value">3/29/24</div></div>
                            </div>
                            <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                              <div><div className="tooltip-label">Deadline for Depositions</div><div className="tooltip-value">9/30/24</div></div>
                            </div>
                          </div>
                        }
                      >
                        <span className="date-text">
                          {isApproachingOutsideDate(deal) && (
                            <span className="indicator-icon warning-icon" title="Approaching outside date">⚠️</span>
                          )}
                          {new Date(deal.expected_close).toLocaleDateString()}
                        </span>
                      </TearsheetTooltip>
                    </td>
                        {expandedColumnGroups.has('timing') && (
                          <>
                            <td className="date-cell">
                              <span className="date-text">{new Date(deal.announce_date).toLocaleDateString()}</span>
                            </td>
                            <td className="date-cell">
                              <span className="date-text">
                                {deal.outside_date ? new Date(deal.outside_date).toLocaleDateString() : '—'}
                              </span>
                            </td>
                          </>
                        )}
                      </>
                    )}

                    {/* Downsides - IPC, Up/Down */}
                    {!hiddenColumns.has('downsides') && (
                      <>
                        <td className="price-cell">
                          <span className="price-value">${deal.unaffected_price.toFixed(2)}</span>
                        </td>
                        <td className="downside-cell">
                      <TearsheetTooltip
                        title="Downsides Detail"
                        position="top"
                        content={
                          <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const newExpanded = new Set(expandedCalculations);
                                  if (newExpanded.has(deal.id)) {
                                    newExpanded.delete(deal.id);
                                  } else {
                                    newExpanded.add(deal.id);
                                  }
                                  setExpandedCalculations(newExpanded);
                                }}
                                style={{
                                  padding: '6px 12px',
                                  background: 'var(--accent-blue)',
                                  color: 'white',
                                  border: 'none',
                                  borderRadius: '4px',
                                  cursor: 'pointer',
                                  fontSize: '11px',
                                  fontWeight: '500',
                                }}
                              >
                                {expandedCalculations.has(deal.id) ? 'Hide Calculation' : 'Click for Calculation'}
                              </button>
                            </div>

                            {!expandedCalculations.has(deal.id) ? (
                              // Base view (Page 6 from PDF)
                              <div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                                  <div><div className="tooltip-label">Undisturbed</div><div className="tooltip-value">${deal.unaffected_price.toFixed(2)}</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                                  <div><div className="tooltip-label">Downside Est</div><div className="tooltip-value">$15.00</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                                  <div><div className="tooltip-label">Peers Used</div><div className="tooltip-value">n/a</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                                  <div><div className="tooltip-label">Index Used</div><div className="tooltip-value">SPY</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                                  <div><div className="tooltip-label">Implied EV/EBITDA</div><div className="tooltip-value">5x</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                                  <div><div className="tooltip-label">Historical EV/EBITDA</div><div className="tooltip-value">5.4x</div></div>
                                </div>
                              </div>
                            ) : (
                              // Expanded calculation view (Page 7 from PDF)
                              <div>
                                <div style={{ fontSize: '11px', fontWeight: '700', marginBottom: '8px', color: 'var(--text-primary)', textAlign: 'center' }}>
                                  Calculation = 1 – (Deal Spread) / (Total Spread)
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                                  <div><div className="tooltip-label">Deal Spread =</div><div className="tooltip-value">{deal.offer_price.toFixed(2)} – {(getLivePrice(deal) ?? deal.current_price).toFixed(2)} = {getGrossSpreadDollars(deal).toFixed(2)}</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                                  <div><div className="tooltip-label">Total Spread =</div><div className="tooltip-value">{deal.offer_price.toFixed(2)} – 15.00 = {(deal.offer_price - 15.00).toFixed(2)}</div></div>
                                </div>
                                <div style={{ height: '8px' }}></div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                                  <div><div className="tooltip-label">Downside Estimate</div><div className="tooltip-value">$15.00</div></div>
                                </div>
                                <div className="tooltip-row" style={{gridTemplateColumns: '1fr'}}>
                                  <div><div className="tooltip-label">Undisturbed Price</div><div className="tooltip-value">${deal.unaffected_price.toFixed(2)}</div></div>
                                </div>
                                <div style={{ fontSize: '10px', fontStyle: 'italic', color: 'var(--text-muted)', marginTop: '8px', textAlign: 'center' }}>
                                  Calculation method: SPY Beta-adjusted move from undisturbed date
                                </div>
                              </div>
                            )}
                          </div>
                        }
                      >
                        <span className={`downside-value ${hasHighDownsideRisk(deal) ? 'high-risk' : ''}`}>
                          {hasHighDownsideRisk(deal) && (
                            <span className="indicator-icon warning-icon" title="High downside risk">⚠️</span>
                          )}
                          {(() => {
                            const price = getLivePrice(deal) ?? deal.current_price;
                            return price ? ((deal.unaffected_price - price) / price * 100).toFixed(2) + '%' : '—';
                          })()}
                        </span>
                          </TearsheetTooltip>
                        </td>
                        {expandedColumnGroups.has('downsides') && (
                          <>
                            <td className="price-cell">
                              <span className="muted">—</span>
                            </td>
                          </>
                        )}
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        {pagination && (
          <div className="pagination-bar">
            <button
              className="pagination-btn"
              onClick={() => setPage(p => p - 1)}
              disabled={!pagination.has_prev}
            >
              ← Prev
            </button>
            <span className="pagination-info">
              Page {page} of {pagination.total_pages}
              &nbsp;·&nbsp;
              {pagination.total_deals} total deals
            </span>
            <button
              className="pagination-btn"
              onClick={() => setPage(p => p + 1)}
              disabled={!pagination.has_next}
            >
              Next →
            </button>
          </div>
        )}

        <div className="tearsheet-footer">
          <div className="footer-note">
            <span className="muted">
              📊 Showing {filteredDeals.length} of {deals.length} deal{deals.length !== 1 ? 's' : ''}
              {quotesTimestamp &&
                ` • Quotes updated: ${new Date(quotesTimestamp).toLocaleTimeString()}`
              }
            </span>
          </div>
          <div className="footer-actions">
            <button
              className="tearsheet-action-btn"
              onClick={fetchLiveQuotes}
              disabled={quotesLoading}
            >
              <span>{quotesLoading ? '⏳ Loading...' : '🔄 Refresh All Quotes'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Deal Comparison Modal */}
      {showComparison && compareDeals.size >= 2 && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '20px',
          }}
          onClick={() => setShowComparison(false)}
        >
          <div
            style={{
              background: 'var(--bg-primary)',
              padding: '24px',
              borderRadius: '8px',
              maxWidth: '1200px',
              width: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <h3 style={{ color: 'var(--text-primary)' }}>Deal Comparison</h3>
              <button
                onClick={() => setShowComparison(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '24px',
                  cursor: 'pointer',
                  color: 'var(--text-muted)',
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${compareDeals.size}, 1fr)`, gap: '16px' }}>
              {[...compareDeals].map(dealId => {
                const deal = deals.find(d => d.id === dealId);
                if (!deal) return null;

                return (
                  <div key={dealId} style={{ border: '1px solid var(--border)', borderRadius: '4px', padding: '16px' }}>
                    <h4 style={{ color: 'var(--text-primary)', marginBottom: '16px' }}>{deal.target}</h4>

                    <div style={{ fontSize: '12px', lineHeight: '1.8' }}>
                      <div><strong>Ticker:</strong> {deal.target_ticker}</div>
                      <div><strong>Acquirer:</strong> {deal.acquirer}</div>
                      <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
                        <strong>Pricing</strong>
                      </div>
                      <div><strong>Current:</strong> ${(getLivePrice(deal) ?? deal.current_price).toFixed(2)}</div>
                      <div><strong>Offer:</strong> ${deal.offer_price.toFixed(2)}</div>
                      <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
                        <strong>Spreads</strong>
                      </div>
                      <div><strong>Gross $:</strong> ${getGrossSpreadDollars(deal).toFixed(2)}</div>
                      <div className={getSpreadColorClass(getGrossSpreadPct(deal))}>
                        <strong>Gross %:</strong> {getGrossSpreadPct(deal).toFixed(2)}%
                      </div>
                      <div><strong>Net %:</strong> {getNetSpreadPct(deal).toFixed(2)}%</div>
                      <div><strong>Ann. Net:</strong> {getAnnualizedNet(deal).toFixed(2)}%</div>
                      <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
                        <strong>Timing</strong>
                      </div>
                      <div><strong>Announced:</strong> {new Date(deal.announce_date).toLocaleDateString()}</div>
                      <div><strong>Est. Close:</strong> {new Date(deal.expected_close).toLocaleDateString()}</div>
                      <div><strong>Days to Close:</strong> {deal.days_to_close}</div>
                      <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
                        <strong>Risk</strong>
                      </div>
                      <div><strong>Unaffected:</strong> ${deal.unaffected_price.toFixed(2)}</div>
                      <div><strong>Downside:</strong> {(() => { const p = getLivePrice(deal) ?? deal.current_price; return p ? ((deal.unaffected_price - p) / p * 100).toFixed(2) + '%' : '—'; })()}</div>
                      <div><strong>Deal Value:</strong> ${deal.deal_value_bn.toFixed(2)}B</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Save View Modal */}
      {showSaveViewModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
          onClick={() => setShowSaveViewModal(false)}
        >
          <div
            style={{
              background: 'var(--bg-primary)',
              padding: '24px',
              borderRadius: '8px',
              minWidth: '400px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: '16px', color: 'var(--text-primary)' }}>Save Current View</h3>
            <input
              type="text"
              placeholder="Enter view name..."
              value={newViewName}
              onChange={(e) => setNewViewName(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && saveCurrentView()}
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: '14px',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                marginBottom: '16px',
              }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowSaveViewModal(false)}
                style={{
                  padding: '8px 16px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  color: 'var(--text-primary)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={saveCurrentView}
                disabled={!newViewName.trim()}
                style={{
                  padding: '8px 16px',
                  background: 'var(--accent-blue)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: newViewName.trim() ? 'pointer' : 'not-allowed',
                  color: 'white',
                  opacity: newViewName.trim() ? 1 : 0.5,
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
