import api from './api';

// ── Org Admin API (/api/org/...) ─────────────────────────────────────────────

export const orgAdminApi = {
  getUsers: () =>
    api.get('/api/org/users'),

  inviteUser: (body: { email: string; role: string }) =>
    api.post('/api/org/invite', body),

  suspendUser: (userId: string) =>
    api.patch(`/api/org/users/${userId}/suspend`),

  reactivateUser: (userId: string) =>
    api.patch(`/api/org/users/${userId}/reactivate`),

  removeUser: (userId: string) =>
    api.delete(`/api/org/users/${userId}`),

  resendInvite: (inviteId: string) =>
    api.post(`/api/org/invites/${inviteId}/resend`),

  forceResetUser: (userId: string) =>
    api.patch(`/api/org/users/${userId}/force-reset`),

  getRecipients: () =>
    api.get('/api/org/email-recipients'),

  addRecipient: (body: { email: string; name: string; is_active: boolean }) =>
    api.post('/api/org/email-recipients', body),

  updateRecipient: (id: string, body: { name?: string; is_active?: boolean }) =>
    api.patch(`/api/org/email-recipients/${id}`, body),

  deleteRecipient: (id: string) =>
    api.delete(`/api/org/email-recipients/${id}`),
};

// ── Super Admin API (/api/super-admin/...) ───────────────────────────────────

export const superAdminApi = {
  getOrgs: (status?: string) =>
    api.get('/api/super-admin/orgs', { params: status ? { status } : {} }),

  createOrg: (body: {
    name: string;
    plan_name: string;
    user_cap: number;
    start_date: string;
    end_date: string;
    status?: string;
  }) => api.post('/api/super-admin/orgs', body),

  updateOrg: (id: string, body: Partial<{
    name: string;
    plan_name: string;
    user_cap: number;
    start_date: string;
    end_date: string;
    status: string;
  }>) => api.patch(`/api/super-admin/orgs/${id}`, body),

  deleteOrg: (id: string) =>
    api.delete(`/api/super-admin/orgs/${id}`),

  getOrgUsers: (orgId: string) =>
    api.get(`/api/super-admin/orgs/${orgId}/users`),

  getAllUsers: () =>
    api.get('/api/super-admin/users'),

  createUser: (body: {
    email: string;
    password: string;
    role: string;
    organization_id?: string;
    is_individual: boolean;
  }) => api.post('/api/super-admin/users', body),

  updateUser: (id: string, body: Partial<{
    role: string;
    status: string;
    organization_id: string;
    is_individual: boolean;
  }>) => api.patch(`/api/super-admin/users/${id}`, body),

  forceResetUser: (id: string) =>
    api.patch(`/api/super-admin/users/${id}/force-reset`),

  getStats: () =>
    api.get<{
      total_orgs: number; active_orgs: number; expired_orgs: number;
      expiring_soon: number; near_cap: number;
      total_users: number; active_users: number; force_reset_pending: number;
      pending_invites: number;
    }>('/api/super-admin/stats'),
};

// ── Auth extended API (/api/auth/...) ────────────────────────────────────────

export const authApi = {
  forgotPassword: (email: string) =>
    api.post('/api/auth/forgot-password', { email }),

  resetPassword: (token: string, new_password: string) =>
    api.post('/api/auth/reset-password', { token, new_password }),

  changePassword: (current_password: string, new_password: string) =>
    api.post('/api/auth/change-password', { current_password, new_password }),

  acceptInvite: (token: string, password: string, name: string) =>
    api.post('/api/auth/accept-invite', { token, password, name }),

  checkInvite: (token: string) =>
    api.get<{ status: string; email?: string }>('/api/auth/invite/check', { params: { token } }),
};
