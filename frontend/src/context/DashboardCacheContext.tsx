/**
 * Shared in-memory cache for the main landing-page tabs (List View, Dockets, Feed).
 *
 * Purpose: when the user switches away from a tab and comes back, the cached
 * data is shown immediately instead of triggering a refetch + spinner.
 *
 * Pattern: stale-while-revalidate.
 *   - Cached + fresh (<staleAfter)  → return cache, no network
 *   - Cached + stale                → return cache instantly, refetch silently
 *   - Not cached                    → show spinner, fetch
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";

interface CacheEntry {
  data: unknown;
  loadedAt: number;
  paramsKey: string;
}

interface DashboardCacheValue {
  get: (cacheKey: string) => CacheEntry | undefined;
  set: (cacheKey: string, entry: CacheEntry) => void;
  invalidate: (cacheKey: string) => void;
  clear: () => void;
}

const Ctx = createContext<DashboardCacheValue | null>(null);

export function DashboardCacheProvider({ children }: { children: ReactNode }) {
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());

  const value = useMemo<DashboardCacheValue>(() => ({
    get: (k) => cacheRef.current.get(k),
    set: (k, v) => { cacheRef.current.set(k, v); },
    invalidate: (k) => { cacheRef.current.delete(k); },
    clear: () => { cacheRef.current.clear(); },
  }), []);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDashboardCache(): DashboardCacheValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDashboardCache must be inside DashboardCacheProvider");
  return v;
}

interface UseCachedFetchOptions<T> {
  /** Stable identity for this resource (e.g. "all-dockets", "pipeline", "feed") */
  cacheKey: string;
  /** Params signature — if it changes, cache for new params is checked separately */
  paramsKey: string;
  /** The actual data fetcher */
  fetcher: () => Promise<T>;
  /** Cache freshness in ms (default 5 min). Older than this → background revalidate. */
  staleAfter?: number;
  /** Skip the effect entirely (e.g. while auth not ready). When true, no fetch fires. */
  enabled?: boolean;
}

interface UseCachedFetchResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Force a fresh fetch + cache replace; shows spinner. */
  refresh: () => Promise<void>;
  /** Update cached data in place (e.g. socket push, optimistic insert). */
  mutate: (updater: (prev: T | null) => T) => void;
}

const DEFAULT_STALE_MS = 5 * 60 * 1000;

export function useCachedFetch<T>(opts: UseCachedFetchOptions<T>): UseCachedFetchResult<T> {
  const { cacheKey, paramsKey, fetcher, staleAfter = DEFAULT_STALE_MS, enabled = true } = opts;
  const cache = useDashboardCache();

  // Initialise from cache synchronously so the first render shows data when available.
  const initial = (() => {
    const e = cache.get(cacheKey);
    return e && e.paramsKey === paramsKey ? (e.data as T) : null;
  })();

  const [data, setData] = useState<T | null>(initial);
  const [loading, setLoading] = useState<boolean>(!initial && enabled);
  const [error, setError] = useState<string | null>(null);

  // Keep the latest fetcher in a ref so the effect doesn't restart when the
  // caller passes a fresh closure each render. paramsKey is the real trigger.
  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; });

  useEffect(() => {
    if (!enabled) return;

    const existing = cache.get(cacheKey);
    const hit = existing && existing.paramsKey === paramsKey;
    const fresh = hit && Date.now() - existing.loadedAt < staleAfter;

    if (hit) {
      setData(existing.data as T);
    } else {
      // paramsKey changed and we have no cached value for the new key —
      // drop stale data so consumers (e.g. AllDockets) show their loader
      // instead of the previous selection's UI while the new one fetches.
      setData(null);
    }

    if (fresh) {
      setLoading(false);
      return;
    }

    // Show spinner only if we have nothing to display
    if (!hit) setLoading(true);

    let cancelled = false;
    fetcherRef.current()
      .then(d => {
        if (cancelled) return;
        setData(d);
        cache.set(cacheKey, { data: d, loadedAt: Date.now(), paramsKey });
        setError(null);
      })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, paramsKey, enabled]);

  const refresh = useCallback(async () => {
    cache.invalidate(cacheKey);
    setLoading(true);
    try {
      const d = await fetcherRef.current();
      setData(d);
      cache.set(cacheKey, { data: d, loadedAt: Date.now(), paramsKey });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [cache, cacheKey, paramsKey]);

  const mutate = useCallback((updater: (prev: T | null) => T) => {
    setData(prev => {
      const next = updater(prev);
      cache.set(cacheKey, { data: next, loadedAt: Date.now(), paramsKey });
      return next;
    });
  }, [cache, cacheKey, paramsKey]);

  return { data, loading, error, refresh, mutate };
}
