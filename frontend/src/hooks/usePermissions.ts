import { useAuth } from "../context/AuthContext";
import ROLE_CONFIG, {
  type Role,
  type RolePermissions
} from "../config/roleConfig";

function getConfig(role: string): RolePermissions {
  return ROLE_CONFIG[role as Role] ?? ROLE_CONFIG.user;
}

export function usePermissions() {
  const { user } = useAuth();
  const role = user?.role ?? "user";
  const config = getConfig(role);

  const isSuperAdmin = role === "super_admin";
  const isAdmin = role === "admin" || role === "super_admin";

  /** Returns true if the nav tab at `path` is visible for the current role */
  const canSeeNavTab = (path: string): boolean => {
    if (config.navTabs === "all") return true;
    return config.navTabs.includes(path);
  };

  /** Returns true if the deal detail tab with `tabId` is visible for the current role */
  const canSeeDealTab = (tabId: string): boolean => {
    if (config.dealDetailTabs === "all") return true;
    return config.dealDetailTabs.includes(tabId);
  };

  /** Array of allowed deal IDs, or 'all' if unrestricted */
  const allowedDealIds = config.allowedDealIds;

  /** Whether to show the summary stats bar on the List View page */
  const showSummaryStats = config.showSummaryStats;

  /** Whether to show the header metrics strip (Current, Offer, Gross, Net, Ann.) on Deal Detail */
  const showDealMetrics = config.showDealMetrics;

  /** Returns true if the List View column with `colId` is visible for the current role */
  const canSeeColumn = (colId: string): boolean => {
    if (config.visibleColumns === 'all') return true;
    return config.visibleColumns.includes(colId);
  };

  return {
    isAdmin,
    isSuperAdmin,
    role,
    canSeeNavTab,
    canSeeDealTab,
    allowedDealIds,
    showSummaryStats,
    showDealMetrics,
    canSeeColumn,
  };
}
