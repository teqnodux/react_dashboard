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
  created_at: string | null;
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

// ── Add Recipient Modal ───────────────────────────────────────────────────

function AddRecipientModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await orgAdminApi.addRecipient({ email, name, is_active: true });
      onSuccess();
      onClose();
    } catch (err) {
      if (axios.isAxiosError(err)) setError(err.response?.data?.detail || 'Failed to add recipient');
      else setError('Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>Add Email Recipient</h2>
        <form onSubmit={handleSubmit}>
          <div className="modal-field">
            <label>Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="John Smith" />
          </div>
          <div className="modal-field">
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="john@example.com" />
          </div>
          {error && <div className="admin-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Adding…' : 'Add Recipient'}
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
    alert('Password reset flag set. User will be prompted on next login.');
  };

  return (
    <div>
      {showInvite && <InviteModal onClose={() => setShowInvite(false)} onSuccess={load} />}
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
                          <button className="btn-ghost" onClick={() => handleForceReset(u.id)}>Force Reset</button>
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
      {showAdd && <AddRecipientModal onClose={() => setShowAdd(false)} onSuccess={load} />}
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
                <th>Status</th>
                <th>Added</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.email}</td>
                  <td>
                    <span className={`status-badge ${r.is_active ? 'active' : 'inactive'}`}>
                      {r.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="cell-muted">
                    {r.created_at ? new Date(r.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td>
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
  const [activeSection, setActiveSection] = useState('users');

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
