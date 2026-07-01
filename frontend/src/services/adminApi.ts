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

  setUserAccessMode: (userId: string, access_mode: string) =>
    api.patch(`/api/org/users/${userId}/access-mode`, { access_mode }),

  getRecipients: () =>
    api.get('/api/org/email-recipients'),

  addRecipient: (body: { email: string; name: string; is_active: boolean; report_types?: string[] }) =>
    api.post('/api/org/email-recipients', body),

  updateRecipient: (id: string, body: { name?: string; is_active?: boolean; report_types?: string[] }) =>
    api.patch(`/api/org/email-recipients/${id}`, body),

  deleteRecipient: (id: string) =>
    api.delete(`/api/org/email-recipients/${id}`),

  getNotificationSettings: () =>
    api.get<{ enabled_report_types: string[]; report_type_labels: Record<string, string> }>('/api/org/notification-settings'),

  getOrgSettings: () =>
    api.get<{ is_admin_dashboard_visible: boolean }>('/api/org/settings'),

  getRecipientDealAccess: (recipientId: string) =>
    api.get<{ allowed_deal_ids: string[] }>(`/api/org/email-recipients/${recipientId}/deal-access`),

  setRecipientDealAccess: (recipientId: string, allowed_deal_ids: string[]) =>
    api.put(`/api/org/email-recipients/${recipientId}/deal-access`, { allowed_deal_ids }),
};

// ── Current-user deal access API ─────────────────────────────────────────────

export const userApi = {
  getMyRecipient: () =>
    api.get<{
      id: string; email: string; name: string;
      organization_id: string; allowed_deal_ids: string[];
    }>('/api/me/recipient'),

  setMyDealAccess: (allowed_deal_ids: string[]) =>
    api.put('/api/me/deal-access', { allowed_deal_ids }),

  getDeals: (status?: string) =>
    api.get<{
      id: string; target: string; acquirer: string;
      target_ticker: string; acquirer_ticker: string;
      deal_value_bn: number; status: string; announce_date: string;
    }[]>('/api/deals/summary', { params: status ? { status } : {} }),
};

// ── Super Admin API (/api/super-admin/...) ───────────────────────────────────

export const superAdminApi = {
  getOrgs: (status?: string) =>
    api.get('/api/super-admin/orgs', { params: status ? { status } : {} }),

  getOrg: (orgId: string) =>
    api.get(`/api/super-admin/orgs/${orgId}`),

  createOrg: (body: {
    name: string;
    plan_name: string;
    user_cap: number;
    recipient_cap: number;
    start_date: string;
    end_date?: string;
    status?: string;
  }) => api.post('/api/super-admin/orgs', body),

  updateOrg: (id: string, body: Partial<{
    name: string;
    plan_name: string;
    user_cap: number;
    recipient_cap: number;
    start_date: string;
    end_date: string;
    status: string;
    is_admin_dashboard_visible: boolean;
    add_cc: boolean;
  }>) => api.patch(`/api/super-admin/orgs/${id}`, body),

  deleteOrg: (id: string) =>
    api.delete(`/api/super-admin/orgs/${id}`),

  getOrgUsers: (orgId: string) =>
    api.get(`/api/super-admin/orgs/${orgId}/users`),

  inviteOrgUser: (orgId: string, body: { email: string; role: string }) =>
    api.post(`/api/super-admin/orgs/${orgId}/invite`, body),

  suspendOrgUser: (orgId: string, userId: string) =>
    api.patch(`/api/super-admin/orgs/${orgId}/users/${userId}/suspend`),

  reactivateOrgUser: (orgId: string, userId: string) =>
    api.patch(`/api/super-admin/orgs/${orgId}/users/${userId}/reactivate`),

  removeOrgUser: (orgId: string, userId: string) =>
    api.delete(`/api/super-admin/orgs/${orgId}/users/${userId}`),

  resendOrgInvite: (orgId: string, inviteId: string) =>
    api.post(`/api/super-admin/orgs/${orgId}/invites/${inviteId}/resend`),

  forceResetOrgUser: (orgId: string, userId: string) =>
    api.patch(`/api/super-admin/orgs/${orgId}/users/${userId}/force-reset`),

  setOrgUserAccessMode: (orgId: string, userId: string, access_mode: string) =>
    api.patch(`/api/super-admin/orgs/${orgId}/users/${userId}/access-mode`, { access_mode }),

  getOrgRecipients: (orgId: string) =>
    api.get(`/api/super-admin/orgs/${orgId}/email-recipients`),

  addOrgRecipient: (
    orgId: string,
    body: { email: string; name: string; is_active: boolean; report_types?: string[] }
  ) => api.post(`/api/super-admin/orgs/${orgId}/email-recipients`, body),

  updateOrgRecipient: (
    orgId: string,
    recipientId: string,
    body: { name?: string; is_active?: boolean; report_types?: string[] }
  ) => api.patch(`/api/super-admin/orgs/${orgId}/email-recipients/${recipientId}`, body),

  deleteOrgRecipient: (orgId: string, recipientId: string) =>
    api.delete(`/api/super-admin/orgs/${orgId}/email-recipients/${recipientId}`),

  getReportTypes: () =>
    api.get<Record<string, string>>('/api/super-admin/report-types'),

  getOrgNotificationSettings: (orgId: string) =>
    api.get<{ enabled_report_types: string[] }>(`/api/super-admin/orgs/${orgId}/notification-settings`),

  updateOrgNotificationSettings: (orgId: string, body: { enabled_report_types: string[] }) =>
    api.put(`/api/super-admin/orgs/${orgId}/notification-settings`, body),

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

  getDealsForAdmin: (status?: string) =>
    api.get<{
      id: string; target: string; acquirer: string;
      target_ticker: string; acquirer_ticker: string;
      deal_value_bn: number; status: string; announce_date: string;
    }[]>('/api/super-admin/deals', { params: status ? { status } : {} }),

  getRecipientDealAccess: (orgId: string, recipientId: string) =>
    api.get<{ allowed_deal_ids: string[] }>(
      `/api/super-admin/orgs/${orgId}/email-recipients/${recipientId}/deal-access`
    ),

  setRecipientDealAccess: (orgId: string, recipientId: string, allowed_deal_ids: string[]) =>
    api.put(
      `/api/super-admin/orgs/${orgId}/email-recipients/${recipientId}/deal-access`,
      { allowed_deal_ids }
    ),
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
