import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { orgAdminApi } from '../../services/adminApi';
import { useAuth } from '../../context/AuthContext';
import '../../styles/AdminNav.css';

// ── Types ──────────────────────────────────────────────────────────────────

interface OrgUser {
  id: string;
  email: string;
  role: string;
  status: string;
  is_individual: boolean;
  force_password_reset: boolean;
  created_at: string | null;
  _is_invite?: boolean;
}

interface Recipient {
  id: string;
  email: string;
  name: string;
  is_active: boolean;
  report_types: string[];
  created_at: string | null;
}

// ── Confirm Modal ─────────────────────────────────────────────────────────

function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ maxWidth: 400 }}>
        <h2>{title}</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-xl)', lineHeight: 1.6 }}>{message}</p>
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={danger ? 'btn-danger' : 'btn-primary'}
            onClick={() => { onConfirm(); onClose(); }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Invite Modal ──────────────────────────────────────────────────────────

function InviteModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('user');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await orgAdminApi.inviteUser({ email, role });
      onSuccess();
      onClose();
    } catch (err) {
      if (axios.isAxiosError(err)) setError(err.response?.data?.detail || 'Failed to send invite');
      else setError('Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>Invite User</h2>
        <form onSubmit={handleSubmit}>
          <div className="modal-field">
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus placeholder="user@example.com" />
          </div>
          <div className="modal-field">
            <label>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {error && <div className="admin-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Sending…' : 'Send Invite'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Add / Edit Recipient Modal ────────────────────────────────────────────

function RecipientModal({
  recipient,
  onClose,
  onSuccess,
}: {
  recipient?: Recipient;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const isEdit = !!recipient;
  const [email, setEmail] = useState(recipient?.email ?? '');
  const [name, setName] = useState(recipient?.name ?? '');
  const [selectedTypes, setSelectedTypes] = useState<string[]>(recipient?.report_types ?? []);
  const [enabledTypes, setEnabledTypes] = useState<string[]>([]);
  const [reportLabels, setReportLabels] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    orgAdminApi.getNotificationSettings()
      .then(({ data }) => {
        setEnabledTypes(data.enabled_report_types);
        setReportLabels(data.report_type_labels);
        // For new recipients default to all org-enabled types selected
        if (!isEdit) setSelectedTypes(data.enabled_report_types);
      })
      .catch(() => {});
  }, [isEdit]);

  const toggle = (key: string) =>
    setSelectedTypes((prev) =>
      prev.includes(key) ? prev.filter((t) => t !== key) : [...prev, key]
    );

  const allSelected = enabledTypes.length > 0 && enabledTypes.every((t) => selectedTypes.includes(t));
  const toggleAll = () => setSelectedTypes(allSelected ? [] : [...enabledTypes]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isEdit) {
        await orgAdminApi.updateRecipient(recipient.id, { report_types: selectedTypes });
      } else {
        await orgAdminApi.addRecipient({ email, name, is_active: true, report_types: selectedTypes });
      }
      onSuccess();
      onClose();
    } catch (err) {
      if (axios.isAxiosError(err)) setError(err.response?.data?.detail || 'Failed to save recipient');
      else setError('Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>{isEdit ? `Notifications — ${recipient.name || recipient.email}` : 'Add Email Recipient'}</h2>
        <form onSubmit={handleSubmit}>
          {!isEdit && (
            <>
              <div className="modal-field">
                <label>Name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="John Smith" />
              </div>
              <div className="modal-field">
                <label>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="john@example.com" />
              </div>
            </>
          )}
          <div className="modal-field">
            <div className="report-type-checklist-header">
              <label>Report Types</label>
              {enabledTypes.length > 0 && (
                <button type="button" className="report-type-select-all" onClick={toggleAll}>
                  {allSelected ? 'Deselect All' : 'Select All'}
                </button>
              )}
            </div>
            {enabledTypes.length === 0 ? (
              <p className="notif-empty-hint">No report types enabled for this organization yet.</p>
            ) : (
              <div className="report-type-checklist">
                {enabledTypes.map((key) => (
                  <label key={key} className="report-type-check-row">
                    <input
                      type="checkbox"
                      checked={selectedTypes.includes(key)}
                      onChange={() => toggle(key)}
                    />
                    <span>{reportLabels[key] ?? key}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          {error && <div className="admin-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Saving…' : isEdit ? 'Save' : 'Add Recipient'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Users Tab ─────────────────────────────────────────────────────────────

function UsersTab() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [confirmReset, setConfirmReset] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await orgAdminApi.getUsers();
      // Exclude the currently logged-in admin from the list
      setUsers(data.filter((u: OrgUser) => u.id !== currentUser?.id));
    } finally {
      setLoading(false);
    }
  }, [currentUser?.id]);

  useEffect(() => { load(); }, [load]);

  const handleSuspend = async (id: string) => {
    if (!confirm('Suspend this user? They will lose access immediately.')) return;
    await orgAdminApi.suspendUser(id);
    load();
  };

  const handleReactivate = async (id: string) => {
    await orgAdminApi.reactivateUser(id);
    load();
  };

  const handleRemove = async (id: string) => {
    if (!confirm('Remove this user from the organization?')) return;
    await orgAdminApi.removeUser(id);
    load();
  };

  const handleCancelInvite = async (id: string) => {
    if (!confirm('Cancel this pending invitation?')) return;
    await orgAdminApi.removeUser(id);
    load();
  };

  const handleResendInvite = async (id: string) => {
    await orgAdminApi.resendInvite(id);
    alert('Invitation resent successfully.');
    load();
  };

  const handleRemoveExpiredInvite = async (id: string) => {
    if (!confirm('Remove this expired invitation record?')) return;
    await orgAdminApi.removeUser(id);
    load();
  };

  const handleForceReset = async (id: string) => {
    await orgAdminApi.forceResetUser(id);
    load();
  };

  return (
    <div>
      {showInvite && <InviteModal onClose={() => setShowInvite(false)} onSuccess={load} />}
      {confirmReset && (
        <ConfirmModal
          title="Force Password Reset"
          message="This will immediately log the user out of all sessions and require them to reset their password on next login. Continue?"
          confirmLabel="Force Reset"
          danger
          onConfirm={() => handleForceReset(confirmReset)}
          onClose={() => setConfirmReset(null)}
        />
      )}
      <div className="admin-action-row">
        <button className="btn-primary" onClick={() => setShowInvite(true)}>+ Invite User</button>
      </div>
      {loading ? (
        <p className="loading">Loading…</p>
      ) : users.length === 0 ? (
        <div className="admin-empty">No users in this organization yet.</div>
      ) : (
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Joined</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td style={{ textTransform: 'capitalize' }}>{u.role}</td>
                  <td><span className={`status-badge ${u.status}`}>{u.status}</span></td>
                  <td className="cell-muted">
                    {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {u.status === 'invited' ? (
                        <button className="btn-danger" onClick={() => handleCancelInvite(u.id)}>Cancel Invite</button>
                      ) : u.status === 'expired' ? (
                        <>
                          <button className="btn-ghost" style={{ color: 'var(--accent-blue)', borderColor: 'var(--accent-blue)' }} onClick={() => handleResendInvite(u.id)}>Resend Invite</button>
                          <button className="btn-danger" onClick={() => handleRemoveExpiredInvite(u.id)}>Remove</button>
                        </>
                      ) : (
                        <>
                          {u.status === 'active' && (
                            <button className="btn-ghost" onClick={() => handleSuspend(u.id)}>Suspend</button>
                          )}
                          {(u.status === 'suspended' || u.status === 'inactive') && (
                            <button className="btn-ghost" style={{ color: 'var(--accent-green)', borderColor: 'var(--accent-green)' }} onClick={() => handleReactivate(u.id)}>Reactivate</button>
                          )}
                          <button className="btn-ghost" onClick={() => setConfirmReset(u.id)}>Force Reset</button>
                          <button className="btn-danger" onClick={() => handleRemove(u.id)}>Remove</button>
                        </>
                      )}
                    </div>
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

// ── Email Recipients Tab ──────────────────────────────────────────────────

function RecipientsTab() {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editRecipient, setEditRecipient] = useState<Recipient | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await orgAdminApi.getRecipients();
      setRecipients(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (r: Recipient) => {
    await orgAdminApi.updateRecipient(r.id, { is_active: !r.is_active });
    load();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this email recipient?')) return;
    await orgAdminApi.deleteRecipient(id);
    load();
  };

  return (
    <div>
      {showAdd && <RecipientModal onClose={() => setShowAdd(false)} onSuccess={load} />}
      {editRecipient && (
        <RecipientModal
          recipient={editRecipient}
          onClose={() => setEditRecipient(null)}
          onSuccess={load}
        />
      )}
      <div className="admin-action-row">
        <button className="btn-primary" onClick={() => setShowAdd(true)}>+ Add Recipient</button>
      </div>
      {loading ? (
        <p className="loading">Loading…</p>
      ) : recipients.length === 0 ? (
        <div className="admin-empty">No email recipients configured yet.</div>
      ) : (
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Report Types</th>
                <th>Status</th>
                <th>Added</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => (
                <tr
                  key={r.id}
                  className="recipient-row-clickable"
                  onClick={() => setEditRecipient(r)}
                  title="Click to manage notification permissions"
                >
                  <td>{r.name}</td>
                  <td>{r.email}</td>
                  <td>
                    {r.report_types.length === 0
                      ? <span className="cell-muted">None</span>
                      : <span className="report-types-badge">{r.report_types.length} type{r.report_types.length !== 1 ? 's' : ''}</span>
                    }
                  </td>
                  <td>
                    <span className={`status-badge ${r.is_active ? 'active' : 'inactive'}`}>
                      {r.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="cell-muted">
                    {r.created_at ? new Date(r.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button className="btn-ghost" onClick={() => toggleActive(r)}>
                        {r.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button className="btn-danger" onClick={() => handleDelete(r.id)}>Remove</button>
                    </div>
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

// ── Sidebar icons ─────────────────────────────────────────────────────────

const IconUsers = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);

const IconMail = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2"/>
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
  </svg>
);

const NAV_ITEMS = [
  { id: 'users',      label: 'Users',            Icon: IconUsers },
  { id: 'recipients', label: 'Email Recipients',  Icon: IconMail  },
];

// ── Main AdminPanel ───────────────────────────────────────────────────────

export default function AdminPanel() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [activeSection, setActiveSection] = useState('users');
  const [dashboardVisible, setDashboardVisible] = useState<boolean | null>(null);

  useEffect(() => {
    // Super admins always have access; only check for org admins
    if (user?.role === 'super_admin') {
      setDashboardVisible(true);
      return;
    }
    orgAdminApi.getOrgSettings()
      .then(({ data }) => setDashboardVisible(data.is_admin_dashboard_visible))
      .catch(() => setDashboardVisible(true)); // fail open — don't block on network errors
  }, [user?.role]);

  if (dashboardVisible === null) {
    return (
      <div className="admin-panel-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <p className="loading">Loading…</p>
      </div>
    );
  }

  if (!dashboardVisible) {
    return (
      <div className="admin-panel-page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: 'var(--space-lg)' }}>
        <h2 style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>Admin Panel Disabled</h2>
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 400 }}>
          Access to the Admin Panel has been disabled for your organization. Contact your Super Admin to enable it.
        </p>
        <button className="btn-primary" onClick={() => navigate('/')}>Go to Dashboard</button>
      </div>
    );
  }

  return (
    <div className="admin-panel-page">
      {/* ── Header ── */}
      <div className="admin-panel-header">
        <button className="admin-back-btn" onClick={() => navigate(-1)}>← Back</button>
        <h1>Admin Panel</h1>
      </div>

      {/* ── Sidebar + Content ── */}
      <div className="admin-panel-body">
        <nav className="admin-sidebar">
          <div className="admin-sidebar-section">
            <div className="admin-sidebar-label">Manage</div>
            {NAV_ITEMS.map(({ id, label, Icon }) => (
              <button
                key={id}
                className={`admin-sidebar-link ${activeSection === id ? 'active' : ''}`}
                onClick={() => setActiveSection(id)}
              >
                <Icon />
                {label}
              </button>
            ))}
          </div>
        </nav>

        <main className="admin-panel-content">
          {activeSection === 'users'      && <UsersTab />}
          {activeSection === 'recipients' && <RecipientsTab />}
        </main>
      </div>
    </div>
  );
}
