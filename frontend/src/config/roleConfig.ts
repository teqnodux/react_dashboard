// ─────────────────────────────────────────────────────────────────────────────
// Role-based access configuration
//
// To adjust what a role can see, edit the arrays below.
//   - 'all'         → no restriction (admin default)
//   - string[]      → explicit allow-list
//   - number[]      → allowed deal IDs (for allowedDealIds)
//
// Nav tab paths match the React Router route paths in App.tsx.
// Deal detail tab IDs match the activeTab values used in DealDetail.tsx.
// ─────────────────────────────────────────────────────────────────────────────

export type Role = 'super_admin' | 'admin' | 'user';

export interface RolePermissions {
  /** Which top-nav tabs are visible. Use route paths e.g. '/tearsheet' */
  navTabs: string[] | 'all';
  /** Which deal detail tabs are visible. Use tab IDs e.g. 'financial' */
  dealDetailTabs: string[] | 'all';
  /** Which deals are visible by ID. Use numeric deal IDs. */
  allowedDealIds: string[] | 'all';
  /** Whether to show the summary stats bar (Total Deals, Total Value, Avg Spread, At Risk) on the List View page */
  showSummaryStats: boolean;
}

const ROLE_CONFIG: Record<Role, RolePermissions> = {
  // ── Super Admin: unrestricted ─────────────────────────────────────────────
  super_admin: {
    navTabs: 'all',
    dealDetailTabs: 'all',
    allowedDealIds: 'all',
    showSummaryStats: true,
  },

  // ── Admin: unrestricted ───────────────────────────────────────────────────
  admin: {
   navTabs: [
      // '/tearsheet',
      '/pipeline',
      
    ],

    dealDetailTabs: [
      // 'financial',   // Financial Overview
      // 'tearsheet',   // Tearsheet
      'dma',
      // 'timeline',    // Timeline
      'sec',
      'proxy',
      '10k',
      'mae',
      'covenants',
      // 'regulatory',
      // 'reg-monitor',
      // 'milestones',
      'termination',
      // 'docket',
      // 'reddit',
      // 'feed',        // Feed
      'feed-new',    // Feed (New)
      // 'scorecard',
      // 'documents'

    ],

    // ← Add/remove deal IDs here to control which deals the user role can see.
    // Pagination and search will work correctly within this list.
    allowedDealIds: ["69fc2f8615960fbe4105afb2","69b15c2254958e923c2cb92a","69301375c0aa46c328847932","6981ce6ab995ffbb7cb5c582","69a5884454958e923ceb9115"],
    showSummaryStats: false,
  },

  // ── User: restricted ─────────────────────────────────────────────────────
  user: {
    navTabs: [
      // '/tearsheet',
      '/pipeline',
      
    ],

    dealDetailTabs: [
      // 'financial',   // Financial Overview
      // 'tearsheet',   // Tearsheet
      'dma',
      // 'timeline',    // Timeline
      'sec',
      'proxy',
      '10k',
      'mae',
      'covenants',
      // 'regulatory',
      // 'reg-monitor',
      // 'milestones',
      'termination',
      // 'docket',
      // 'reddit',
      // 'feed',        // Feed
      'feed-new',    // Feed (New)
      // 'scorecard',
      // 'documents'

    ],

    // ← Add/remove deal IDs here to control which deals the user role can see.
    // Pagination and search will work correctly within this list.
    allowedDealIds: ["69fc2f8615960fbe4105afb2","69b15c2254958e923c2cb92a","69301375c0aa46c328847932","6981ce6ab995ffbb7cb5c582","69a5884454958e923ceb9115"],
    showSummaryStats: false,
  },
};

export default ROLE_CONFIG;
