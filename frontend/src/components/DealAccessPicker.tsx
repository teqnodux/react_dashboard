import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import axios from 'axios';
import { userApi } from '../services/adminApi';
import '../styles/AdminNav.css';

export interface DealSummary {
  id: string;
  target: string;
  acquirer: string;
  target_ticker: string;
  acquirer_ticker: string;
  deal_value_bn: number;
  status: string;
  announce_date: string;
}

type SortKey = 'target' | 'acquirer' | 'tickers' | 'value' | 'status' | 'announced';
type SortDir = 'asc' | 'desc';

const tickerText = (d: DealSummary) =>
  `${d.target_ticker || ''}${d.acquirer_ticker ? ` · ${d.acquirer_ticker}` : ''}`;

const byText = (a: string, b: string) => {
  // Blanks always sort last, regardless of direction.
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
};

const announceTime = (d: DealSummary) => {
  const t = d.announce_date ? new Date(d.announce_date).getTime() : NaN;
  return Number.isNaN(t) ? null : t;
};

const byNumber = (a: number | null, b: number | null) => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
};

const SORT_COLUMNS: Record<SortKey, { label: string; compare: (a: DealSummary, b: DealSummary) => number }> = {
  target: { label: 'Target', compare: (a, b) => byText(a.target, b.target) },
  acquirer: { label: 'Acquirer', compare: (a, b) => byText(a.acquirer, b.acquirer) },
  tickers: { label: 'Tickers', compare: (a, b) => byText(tickerText(a), tickerText(b)) },
  value: {
    label: 'Value (Bn)',
    compare: (a, b) =>
      byNumber(a.deal_value_bn > 0 ? a.deal_value_bn : null, b.deal_value_bn > 0 ? b.deal_value_bn : null),
  },
  status: { label: 'Status', compare: (a, b) => byText(a.status || 'unknown', b.status || 'unknown') },
  announced: { label: 'Announced', compare: (a, b) => byNumber(announceTime(a), announceTime(b)) },
};

interface DealAccessPickerProps {
  initialAllowedIds: string[];
  subtitle?: string;
  onSave: (ids: string[]) => Promise<void>;
}

export default function DealAccessPicker({
  initialAllowedIds,
  subtitle,
  onSave,
}: DealAccessPickerProps) {
  const [allDeals, setAllDeals] = useState<DealSummary[]>([]);
  const [allowedIds, setAllowedIds] = useState<Set<string>>(new Set(initialAllowedIds));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectionFilter, setSelectionFilter] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // The controls bar above the table is itself sticky and changes height (error /
  // saved banners, wrapping filters), so the frozen header row has to sit at
  // whatever offset the bar currently ends at.
  const controlsRef = useRef<HTMLDivElement>(null);
  const [headerTop, setHeaderTop] = useState(0);

  useLayoutEffect(() => {
    const el = controlsRef.current;
    if (!el) return;
    const measure = () => {
      const stickyTop = parseFloat(getComputedStyle(el).top) || 0;
      setHeaderTop(stickyTop + el.offsetHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    setAllowedIds(new Set(initialAllowedIds));
  }, [initialAllowedIds.join(',')]);

  useEffect(() => {
    setLoading(true);
    userApi
      .getDeals()
      .then(({ data }) => setAllDeals(data))
      .catch(() => setError('Failed to load deals'))
      .finally(() => setLoading(false));
  }, []);

  const filteredDeals = allDeals.filter((deal) => {
    if (statusFilter !== 'all') {
      const s = (deal.status || '').toLowerCase();
      if (statusFilter === 'open' && s !== 'open') return false;
      if (statusFilter === 'unknown' && ['open'].includes(s)) return false;
    }
    if (selectionFilter === 'selected' && !allowedIds.has(deal.id)) return false;
    if (selectionFilter === 'unselected' && allowedIds.has(deal.id)) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        deal.id.toLowerCase().includes(q) ||
        deal.target.toLowerCase().includes(q) ||
        deal.acquirer.toLowerCase().includes(q) ||
        deal.target_ticker.toLowerCase().includes(q) ||
        deal.acquirer_ticker.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const visibleDeals = sortKey
    ? [...filteredDeals].sort((a, b) => {
        const dir = sortDir === 'asc' ? 1 : -1;
        const cmp = SORT_COLUMNS[sortKey].compare(a, b);
        // Keep a stable, predictable tiebreak so equal values don't shuffle.
        return (cmp !== 0 ? cmp : a.target.localeCompare(b.target)) * dir;
      })
    : filteredDeals;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const toggleDeal = (id: string) => {
    setAllowedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setAllowedIds((prev) => {
      const next = new Set(prev);
      visibleDeals.forEach((d) => next.add(d.id));
      return next;
    });
  };

  const clearAllVisible = () => {
    setAllowedIds((prev) => {
      const next = new Set(prev);
      visibleDeals.forEach((d) => next.delete(d.id));
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await onSave(Array.from(allowedIds));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      if (axios.isAxiosError(err)) setError(err.response?.data?.detail || 'Failed to save');
      else setError('Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const statusBadgeClass = (s: string) => {
    const lower = (s || '').toLowerCase();
    if (lower === 'open') return 'active';
    if (['closed', 'completed'].includes(lower)) return 'inactive';
    return 'suspended';
  };

  return (
    <div className="notif-settings-panel">
      <div className="deal-access-sticky-controls" ref={controlsRef}>
        <div className="notif-settings-header">
          <div>
            <div className="notif-settings-title">Deal Access</div>
            <div className="notif-settings-subtitle">
              {subtitle ?? 'Select which deals are accessible.'}{' '}
              <strong>{allowedIds.size}</strong> deal{allowedIds.size !== 1 ? 's' : ''} selected.
            </div>
          </div>
          <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>

        {error && <div className="admin-error">{error}</div>}
        {saved && <div className="notif-saved-msg">Deal access saved successfully.</div>}

        <div className="admin-action-row deal-access-filter-row">
          <div className="deal-access-search-wrap">
            <input
              type="text"
              className="deal-access-search"
              placeholder="Search deals…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearch('');
              }}
            />
            {search && (
              <button
                type="button"
                className="deal-access-search-clear"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                title="Clear search"
              >
                ×
              </button>
            )}
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All Statuses</option>
            <option value="open">Open</option>
            <option value="unknown">Unknown</option>
          </select>
          <select value={selectionFilter} onChange={(e) => setSelectionFilter(e.target.value)}>
            <option value="all">All Deals</option>
            <option value="selected">Selected Only</option>
            <option value="unselected">Unselected Only</option>
          </select>
        </div>

        <div className="admin-action-row">
          <button type="button" className="btn-ghost" onClick={selectAllVisible} disabled={visibleDeals.length === 0}>
            Select All Visible ({visibleDeals.length})
          </button>
          <button type="button" className="btn-ghost" onClick={clearAllVisible} disabled={visibleDeals.length === 0}>
            Clear All Visible
          </button>
        </div>
      </div>

      {loading ? (
        <p className="loading">Loading deals…</p>
      ) : allDeals.length === 0 ? (
        <div className="admin-empty">No deals found.</div>
      ) : visibleDeals.length === 0 ? (
        <div className="admin-empty">No deals match the current filters.</div>
      ) : (
        <div className="admin-table-wrapper deal-access-table-wrapper">
          <table
            className="admin-table deal-access-table"
            style={{ '--dap-header-top': `${headerTop}px` } as CSSProperties}
          >
            <thead>
              <tr>
                <th style={{ width: 40 }}></th>
                {(Object.keys(SORT_COLUMNS) as SortKey[]).map((key) => (
                  <th
                    key={key}
                    className="deal-access-th-sortable"
                    aria-sort={
                      sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
                    }
                  >
                    <button type="button" className="deal-access-sort-btn" onClick={() => toggleSort(key)}>
                      {SORT_COLUMNS[key].label}
                      <span className={`deal-access-sort-arrow${sortKey === key ? ' is-active' : ''}`}>
                        {sortKey === key ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleDeals.map((deal) => (
                <tr
                  key={deal.id}
                  onClick={() => toggleDeal(deal.id)}
                  style={{ cursor: 'pointer' }}
                  className={allowedIds.has(deal.id) ? 'recipient-row-clickable' : ''}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={allowedIds.has(deal.id)}
                      onChange={() => toggleDeal(deal.id)}
                    />
                  </td>
                  <td style={{ fontWeight: 600 }}>{deal.target}</td>
                  <td>{deal.acquirer}</td>
                  <td className="cell-muted">
                    {deal.target_ticker}{deal.acquirer_ticker ? ` · ${deal.acquirer_ticker}` : ''}
                  </td>
                  <td className="cell-muted">
                    {deal.deal_value_bn > 0 ? `$${deal.deal_value_bn.toFixed(1)}B` : '—'}
                  </td>
                  <td>
                    <span className={`status-badge ${statusBadgeClass(deal.status)}`}>
                      {deal.status || 'unknown'}
                    </span>
                  </td>
                  <td className="cell-muted">
                    {deal.announce_date ? new Date(deal.announce_date).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
