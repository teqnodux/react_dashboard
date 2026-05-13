import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { superAdminApi } from '../../services/adminApi';
import '../../styles/AdminNav.css';

// ── Types ─────────────────────────────────────────────────────────────────

interface Org {
  id: string;
  name: string;
  status: string;
  plan_name: string;
  user_cap: number;
  start_date: string | null;
  end_date: string | null;
  created_at: string | null;
}

interface OrgUser {
  id: string;
  email: string;
  role: string;
  status: string;
  organization_id: string | null;
  is_individual: boolean;
  created_at: string | null;
}

// ── Create Org Modal ──────────────────────────────────────────────────────

function CreateOrgModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({
    name: '', plan_name: 'basic', user_cap: 5,
    start_date: today, end_date: '', status: 'active',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await superAdminApi.createOrg({ ...form, user_cap: Number(form.user_cap) });
      onSuccess();
      onClose();
    } catch (err) {
      if (axios.isAxiosError(err)) setError(err.response?.data?.detail || 'Failed to create org');
      else setError('Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>Create Organization</h2>
        <form onSubmit={handleSubmit}>
          <div className="modal-field">
            <label>Organization Name</label>
            <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} required autoFocus placeholder="Acme Capital" />
          </div>
          <div className="modal-field">
            <label>Plan</label>
            <select value={form.plan_name} onChange={(e) => set('plan_name', e.target.value)}>
              <option value="basic">Basic</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
          <div className="modal-field">
            <label>User Cap</label>
            <input type="number" min={1} value={form.user_cap} onChange={(e) => set('user_cap', e.target.value)} required />
          </div>
          <div className="modal-field">
            <label>Start Date</label>
            <input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} required />
          </div>
          <div className="modal-field">
            <label>End Date</label>
            <input type="date" value={form.end_date} onChange={(e) => set('end_date', e.target.value)} required />
          </div>
          {error && <div className="admin-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Edit Org Modal ────────────────────────────────────────────────────────

function EditOrgModal({ org, onClose, onSuccess }: { org: Org; onClose: () => void; onSuccess: () => void }) {
  const [form, setForm] = useState({
    name: org.name,
    plan_name: org.plan_name,
    user_cap: org.user_cap,
    status: org.status,
    start_date: org.start_date?.split('T')[0] ?? '',
    end_date: org.end_date?.split('T')[0] ?? '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await superAdminApi.updateOrg(org.id, { ...form, user_cap: Number(form.user_cap) });
      onSuccess();
      onClose();
    } catch (err) {
      if (axios.isAxiosError(err)) setError(err.response?.data?.detail || 'Update failed');
      else setError('Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>Edit Organization</h2>
        <form onSubmit={handleSubmit}>
          <div className="modal-field">
            <label>Name</label>
            <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} required />
          </div>
          <div className="modal-field">
            <label>Plan</label>
            <select value={form.plan_name} onChange={(e) => set('plan_name', e.target.value)}>
              <option value="basic">Basic</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
          <div className="modal-field">
            <label>User Cap</label>
            <input type="number" min={1} value={form.user_cap} onChange={(e) => set('user_cap', e.target.value)} required />
          </div>
          <div className="modal-field">
            <label>Status</label>
            <select value={form.status} onChange={(e) => set('status', e.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="suspended">Suspended</option>
              <option value="expired">Expired</option>
            </select>
          </div>
          <div className="modal-field">
            <label>Start Date</label>
            <input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} required />
          </div>
          <div className="modal-field">
            <label>End Date</label>
            <input type="date" value={form.end_date} onChange={(e) => set('end_date', e.target.value)} required />
          </div>
          {error && <div className="admin-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Org Users Drilldown ───────────────────────────────────────────────────

function OrgUsersDrawer({ org, onClose }: { org: Org; onClose: () => void }) {
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    superAdminApi.getOrgUsers(org.id).then(({ data }) => setUsers(data)).finally(() => setLoading(false));
  }, [org.id]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <h2>Users — {org.name}</h2>
        {loading ? <p className="loading">Loading…</p> : users.length === 0 ? (
          <div className="admin-empty">No users in this organization.</div>
        ) : (
          <div className="admin-table-wrapper">
            <table className="admin-table">
              <thead><tr><th>Email</th><th>Role</th><th>Status</th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td style={{ textTransform: 'capitalize' }}>{u.role}</td>
                    <td><span className={`status-badge ${u.status}`}>{u.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Create User Modal (with org picker) ───────────────────────────────────

function CreateUserModal({ orgs, onClose, onSuccess }: {
  orgs: Org[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    email: '',
    password: '',
    role: 'admin',
    organization_id: orgs[0]?.id ?? '',
    is_individual: false,
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const payload = {
        ...form,
        organization_id: form.is_individual ? undefined : form.organization_id || undefined,
      };
      const { data } = await superAdminApi.createUser(payload);
      // Auto-set force_password_reset so user must change on first login
      await superAdminApi.forceResetUser(data.id);
      onSuccess();
      onClose();
    } catch (err) {
      if (axios.isAxiosError(err)) setError(err.response?.data?.detail || 'Failed to create user');
      else setError('Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>Create User</h2>
        <form onSubmit={handleSubmit}>
          <div className="modal-field">
            <label>Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              required
              autoFocus
              placeholder="user@example.com"
            />
          </div>
          <div className="modal-field">
            <label>Temporary Password</label>
            <input
              type="text"
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              required
              placeholder="Min 8 chars, 1 uppercase, 1 digit"
            />
          </div>
          <div className="modal-field">
            <label>Role</label>
            <select value={form.role} onChange={(e) => set('role', e.target.value)}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
              <option value="super_admin">Super Admin</option>
            </select>
          </div>
          <div className="modal-field">
            <label>Account Type</label>
            <select
              value={form.is_individual ? 'individual' : 'org'}
              onChange={(e) => set('is_individual', e.target.value === 'individual')}
            >
              <option value="org">Organization User</option>
              <option value="individual">Individual</option>
            </select>
          </div>
          {!form.is_individual && (
            <div className="modal-field">
              <label>Organization</label>
              <select
                value={form.organization_id}
                onChange={(e) => set('organization_id', e.target.value)}
              >
                <option value="">— No organization —</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} ({o.plan_name}) — {o.status}
                  </option>
                ))}
              </select>
            </div>
          )}
          {error && <div className="admin-error">{error}</div>}
          <p style={{ color: 'var(--text-muted)', fontSize: '10px', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
            User will be required to change password on first login.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Creating…' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Organizations Tab ─────────────────────────────────────────────────────

function OrgsTab() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editOrg, setEditOrg] = useState<Org | null>(null);
  const [viewUsersOrg, setViewUsersOrg] = useState<Org | null>(null);
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await superAdminApi.getOrgs(statusFilter || undefined);
      setOrgs(data);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (org: Org) => {
    if (!confirm(`Deactivate "${org.name}"?`)) return;
    await superAdminApi.deleteOrg(org.id);
    load();
  };

  return (
    <div>
      {showCreate && <CreateOrgModal onClose={() => setShowCreate(false)} onSuccess={load} />}
      {editOrg && <EditOrgModal org={editOrg} onClose={() => setEditOrg(null)} onSuccess={load} />}
      {viewUsersOrg && <OrgUsersDrawer org={viewUsersOrg} onClose={() => setViewUsersOrg(null)} />}

      <div className="admin-action-row">
        <button className="btn-primary" onClick={() => setShowCreate(true)}>+ New Organization</button>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="suspended">Suspended</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {loading ? <p className="loading">Loading…</p> : orgs.length === 0 ? (
        <div className="admin-empty">No organizations found.</div>
      ) : (
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Plan</th>
                <th>Status</th>
                <th>User Cap</th>
                <th>End Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr key={org.id}>
                  <td style={{ fontWeight: 600 }}>{org.name}</td>
                  <td style={{ textTransform: 'capitalize', color: 'var(--accent-blue)' }}>{org.plan_name}</td>
                  <td><span className={`status-badge ${org.status}`}>{org.status}</span></td>
                  <td>{org.user_cap}</td>
                  <td className="cell-muted">
                    {org.end_date ? new Date(org.end_date).toLocaleDateString() : '—'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button className="btn-ghost" onClick={() => setViewUsersOrg(org)}>Users</button>
                      <button className="btn-ghost" onClick={() => setEditOrg(org)}>Edit</button>
                      <button className="btn-danger" onClick={() => handleDelete(org)}>Deactivate</button>
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

// ── All Users Tab ─────────────────────────────────────────────────────────

function AllUsersTab() {
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, orgsRes] = await Promise.all([
        superAdminApi.getAllUsers(),
        superAdminApi.getOrgs(),
      ]);
      setUsers(usersRes.data);
      setOrgs(orgsRes.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRoleChange = async (user: OrgUser, newRole: string) => {
    await superAdminApi.updateUser(user.id, { role: newRole });
    load();
  };

  const handleStatusChange = async (user: OrgUser, newStatus: string) => {
    await superAdminApi.updateUser(user.id, { status: newStatus });
    load();
  };

  const handleForceReset = async (id: string) => {
    await superAdminApi.forceResetUser(id);
    alert('Password reset flag set. User will be prompted on next login.');
  };

  const getOrgName = (orgId: string | null) => {
    if (!orgId) return '—';
    return orgs.find((o) => o.id === orgId)?.name ?? orgId.slice(-6);
  };

  return (
    <div>
      {showCreate && (
        <CreateUserModal
          orgs={orgs.filter((o) => o.status === 'active')}
          onClose={() => setShowCreate(false)}
          onSuccess={load}
        />
      )}

      <div className="admin-action-row">
        <button className="btn-primary" onClick={() => setShowCreate(true)}>+ Create User</button>
      </div>

      {loading ? <p className="loading">Loading…</p> : users.length === 0 ? (
        <div className="admin-empty">No users found.</div>
      ) : (
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Organization</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>
                    <select
                      value={u.role}
                      onChange={(e) => handleRoleChange(u, e.target.value)}
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                      <option value="super_admin">Super Admin</option>
                    </select>
                  </td>
                  <td>
                    <select
                      value={u.status}
                      onChange={(e) => handleStatusChange(u, e.target.value)}
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                      <option value="suspended">Suspended</option>
                    </select>
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>
                    {u.is_individual ? (
                      <span style={{ color: 'var(--accent-yellow)' }}>Individual</span>
                    ) : getOrgName(u.organization_id)}
                  </td>
                  <td>
                    <button className="btn-ghost" onClick={() => handleForceReset(u.id)}>Force Reset</button>
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

// ── Sidebar icons (inline SVG — no extra dependency) ─────────────────────

const IconOverview = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
  </svg>
);

const IconOrgs = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
    <line x1="12" y1="12" x2="12" y2="12.01"/>
  </svg>
);

const IconUsers = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview',       Icon: IconOverview },
  { id: 'orgs',     label: 'Organizations',  Icon: IconOrgs },
  { id: 'users',    label: 'All Users',      Icon: IconUsers },
];

// ── Overview Tab ──────────────────────────────────────────────────────────

interface Stats {
  total_orgs: number; active_orgs: number; expired_orgs: number;
  expiring_soon: number; near_cap: number;
  total_users: number; active_users: number; force_reset_pending: number;
  pending_invites: number;
}

// Decorative sparkline SVG (static wave)
const Sparkline = ({ color }: { color: string }) => (
  <svg className="stat-sparkline" viewBox="0 0 80 30" fill="none">
    <polyline
      points="0,20 12,14 24,18 36,8 48,15 60,6 72,12 80,8"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      fill="none" opacity="0.6"
    />
  </svg>
);

// Linear progress bar
const ProgressBar = ({ pct, color }: { pct: number; color: string }) => (
  <div className="stat-progress-track">
    <div className="stat-progress-fill" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
    <span className="stat-progress-pct" style={{ color }}>{pct}%</span>
  </div>
);

// Circular progress ring (SVG donut)
const RingProgress = ({ pct, color }: { pct: number; color: string }) => {
  const r = 18, cx = 24, cy = 24;
  const circ = 2 * Math.PI * r;
  const offset = circ - (Math.min(pct, 100) / 100) * circ;
  return (
    <svg className="stat-ring" viewBox="0 0 48 48">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="4"
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round" transform={`rotate(-90 ${cx} ${cy})`} />
      <text x={cx} y={cy + 4} textAnchor="middle" fontSize="9" fill="white" fontWeight="700">{pct}%</text>
    </svg>
  );
};

// Section header with icon
const SectionHeader = ({ label, icon }: { label: string; icon: React.ReactNode }) => (
  <div className="overview-group-header">
    <span className="overview-group-icon">{icon}</span>
    <span className="overview-group-label-text">{label}</span>
  </div>
);

// Org-style card: icon + value + label + sparkline + progress bar
function OrgCard({ label, value, sub, pct, accent, icon }:
  { label: string; value: number; sub: string; pct: number; accent: string; icon: React.ReactNode }) {
  return (
    <div className="stat-card stat-card-org" style={{ '--stat-accent': accent } as React.CSSProperties}>
      <div className="stat-card-top">
        <div className="stat-card-icon-box">{icon}</div>
        <Sparkline color={accent} />
      </div>
      <div className="stat-card-value">{value}</div>
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-sub">{sub}</div>
      <ProgressBar pct={pct} color={accent} />
    </div>
  );
}

// User-style card: icon + value + label + optional ring or dots
function UserCard({ label, value, sub, accent, icon, pct, showRing }:
  { label: string; value: number | string; sub: string; accent: string; icon: React.ReactNode; pct?: number; showRing?: boolean }) {
  return (
    <div className="stat-card stat-card-user" style={{ '--stat-accent': accent } as React.CSSProperties}>
      <div className="stat-card-top">
        <div className="stat-card-icon-box">{icon}</div>
        {showRing && pct !== undefined && <RingProgress pct={pct} color={accent} />}
      </div>
      <div className="stat-card-value">{value}</div>
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-sub">{sub}</div>
      {!showRing && pct !== undefined && <ProgressBar pct={pct} color={accent} />}
    </div>
  );
}

// Alert card: watermark background icon + value + OK badge when 0
function AlertCard({ label, value, sub, accent, icon, watermark }:
  { label: string; value: number; sub: string; accent: string; icon: React.ReactNode; watermark: React.ReactNode }) {
  const isOk = value === 0;
  return (
    <div className={`stat-card stat-card-alert ${isOk ? 'stat-card-ok' : 'stat-card-warn'}`}
      style={{ '--stat-accent': accent } as React.CSSProperties}>
      <div className="stat-card-watermark">{watermark}</div>
      <div className="stat-card-icon-box">{icon}</div>
      <div className="stat-card-value">{value}</div>
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-sub">{sub}</div>
      {isOk && (
        <div className="stat-ok-badge">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          OK
        </div>
      )}
    </div>
  );
}

// Watermark icons (large, ghost opacity)
const WatermarkCheck = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    <polyline points="9 12 11 14 15 10"/>
  </svg>
);
const WatermarkCal = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
    <rect x="3" y="4" width="18" height="18" rx="2"/>
    <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
    <line x1="3" y1="10" x2="21" y2="10"/>
  </svg>
);

// Section icons
const IconBell = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>
);

function OverviewTab() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    superAdminApi.getStats()
      .then(({ data }) => setStats(data))
      .catch(() => setError('Failed to load statistics'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="loading">Loading overview…</p>;
  if (error)   return <div className="admin-error">{error}</div>;
  if (!stats)  return null;

  const orgActivePct  = stats.total_orgs  > 0 ? Math.round((stats.active_orgs  / stats.total_orgs)  * 100) : 0;
  const userActivePct = stats.total_users > 0 ? Math.round((stats.active_users / stats.total_users) * 100) : 0;
  const capPct        = stats.total_orgs  > 0 ? Math.round((stats.near_cap     / stats.total_orgs)  * 100) : 0;
  const expiringPct   = stats.total_orgs  > 0 ? Math.round((stats.expiring_soon / stats.total_orgs) * 100) : 0;

  return (
    <div className="overview-section">

      {/* ── Organizations ── */}
      <SectionHeader label="Organizations" icon={<IconOrgs />} />
      <div className="stat-cards-grid">
        <OrgCard label="Total Organizations" value={stats.total_orgs}
          sub={`${orgActivePct}% active`} pct={orgActivePct}
          accent="var(--accent-purple)" icon={<IconOrgs />} />
        <OrgCard label="Active Organizations" value={stats.active_orgs}
          sub="Currently enabled" pct={orgActivePct}
          accent="var(--accent-green)" icon={<IconOrgs />} />
        <OrgCard label="Expiring in 30 Days" value={stats.expiring_soon}
          sub="Needs renewal" pct={expiringPct}
          accent="var(--accent-yellow)" icon={<IconOrgs />} />
        <OrgCard label="Near User Cap" value={stats.near_cap}
          sub="≥ 80% of cap used" pct={capPct}
          accent="var(--accent-orange)" icon={<IconUsers />} />
      </div>

      {/* ── Users ── */}
      <SectionHeader label="Users" icon={<IconUsers />} />
      <div className="stat-cards-grid stat-cards-grid-3">
        <UserCard label="Total Users" value={stats.total_users}
          sub="All registered" accent="var(--accent-blue)"
          icon={<IconUsers />} pct={100} />
        <UserCard label="Active Users" value={stats.active_users}
          sub={`${userActivePct}% of total`} accent="var(--accent-green)"
          icon={<IconUsers />} pct={userActivePct} showRing />
        <UserCard label="Pending Invitations" value={stats.pending_invites}
          sub="Awaiting acceptance" accent="var(--accent-blue)"
          icon={<IconUsers />} />
      </div>

      {/* ── Alerts ── */}
      <SectionHeader label="Alerts" icon={<IconBell />} />
      <div className="stat-cards-grid stat-cards-grid-2">
        <AlertCard label="Force Reset Pending" value={stats.force_reset_pending}
          sub="Users not yet reset" accent="var(--accent-red)"
          icon={<IconUsers />} watermark={<WatermarkCheck />} />
        <AlertCard label="Expired Organizations" value={stats.expired_orgs}
          sub="Past end date" accent="var(--accent-red)"
          icon={<IconOrgs />} watermark={<WatermarkCal />} />
      </div>

    </div>
  );
}

// ── Main SuperAdminPanel ──────────────────────────────────────────────────

export default function SuperAdminPanel() {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState('overview');

  return (
    <div className="admin-panel-page">
      {/* ── Header ── */}
      <div className="admin-panel-header">
        <button className="admin-back-btn" onClick={() => navigate(-1)}>← Back</button>
        <h1 className="super-admin-title">Super Admin Panel</h1>
      </div>

      {/* ── Sidebar + Content ── */}
      <div className="admin-panel-body">
        <nav className="admin-sidebar">
          <div className="admin-sidebar-section">
            <div className="admin-sidebar-label">Manage</div>
            {NAV_ITEMS.map(({ id, label, Icon }) => (
              <button
                key={id}
                className={`admin-sidebar-link super-admin-link ${activeSection === id ? 'active' : ''}`}
                onClick={() => setActiveSection(id)}
              >
                <Icon />
                {label}
              </button>
            ))}
          </div>
        </nav>

        <main className="admin-panel-content">
          {activeSection === 'overview' && <OverviewTab />}
          {activeSection === 'orgs'     && <OrgsTab />}
          {activeSection === 'users'    && <AllUsersTab />}
        </main>
      </div>
    </div>
  );
}
