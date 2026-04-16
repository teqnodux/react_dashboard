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
    allowedDealIds: ["69de2fa54c812787f76020e2","69de20d94c812787f76020d4","69dcd30cb0541230ae68d0b8",
      "69d77d1406713c50590b585d","69d393d661cdc5a28af26dfc","69cbae4f640784d45bf14678","69c668f5cef98f44b7207caa","69c5045d07b524e51a763dba",
    "69c4e246b2464e0d1babc51d","69c3bd9e84d7e1498c0b10c4"],
  },
};

export default ROLE_CONFIG;
