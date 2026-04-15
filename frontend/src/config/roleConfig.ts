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

export type Role = 'admin' | 'user';

export interface RolePermissions {
  /** Which top-nav tabs are visible. Use route paths e.g. '/tearsheet' */
  navTabs: string[] | 'all';
  /** Which deal detail tabs are visible. Use tab IDs e.g. 'financial' */
  dealDetailTabs: string[] | 'all';
  /** Which deals are visible by ID. Use numeric deal IDs. */
  allowedDealIds: string[] | 'all';
}

const ROLE_CONFIG: Record<Role, RolePermissions> = {
  // ── Admin: unrestricted ───────────────────────────────────────────────────
  admin: {
    navTabs: 'all',
    dealDetailTabs: 'all',
    allowedDealIds: 'all',
  },

  // ── User: restricted ─────────────────────────────────────────────────────
  user: {
    navTabs: [
      '/tearsheet',
      '/pipeline',
    ],

    dealDetailTabs: [
      'financial',   // Financial Overview
      'tearsheet',   // Tearsheet
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
    allowedDealIds: ["69de2fa54c812787f76020e2"],
  },
};

export default ROLE_CONFIG;
