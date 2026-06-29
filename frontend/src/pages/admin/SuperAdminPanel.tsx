import { useState, useEffect, useCallback, type ReactNode } from "react";
import axios from "axios";
import DashboardNav from "../../components/DashboardNav";
import { superAdminApi } from "../../services/adminApi";
import "../../styles/AdminNav.css";

// ── Types ─────────────────────────────────────────────────────────────────

interface Org {
  id: string;
  name: string;
  status: string;
  plan_name: string;
  user_cap: number;
  recipient_cap: number;
  is_admin_dashboard_visible: boolean;
  allowed_deal_ids: string[];
  start_date: string | null;
  end_date: string | null;
  created_at: string | null;
}

interface DealSummary {
  id: string;
  target: string;
  acquirer: string;
  target_ticker: string;
  acquirer_ticker: string;
  deal_value_bn: number;
  status: string;
  announce_date: string;
}

interface OrgUser {
  id: string;
  email: string;
  role: string;
  status: string;
  organization_id: string | null;
  is_individual: boolean;
  force_password_reset?: boolean;
  created_at: string | null;
  _is_invite?: boolean;
}

interface OrgMember {
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
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onClose
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
        <p
          style={{
            color: "var(--text-secondary)",
            marginBottom: "var(--space-xl)",
            lineHeight: 1.6
          }}
        >
          {message}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create Org Modal ──────────────────────────────────────────────────────

function CreateOrgModal({
  onClose,
  onSuccess
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const today = new Date().toISOString().split("T")[0];
  const [form, setForm] = useState({
    name: "",
    plan_name: "basic",
    user_cap: 5,
    recipient_cap: 10,
    start_date: today,
    end_date: "",
    status: "active"
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const set = (k: string, v: string | number) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { end_date, ...rest } = form;
      await superAdminApi.createOrg({
        ...rest,
        user_cap: Number(form.user_cap),
        recipient_cap: Number(form.recipient_cap),
        ...(end_date ? { end_date } : {})
      });
      onSuccess();
      onClose();
    } catch (err) {
      if (axios.isAxiosError(err))
        setError(err.response?.data?.detail || "Failed to create org");
      else setError("Something went wrong");
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
            <input
              type="text"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              required
              autoFocus
              placeholder="Acme Capital"
            />
          </div>
          <div className="modal-field">
            <label>Plan</label>
            <select
              value={form.plan_name}
              onChange={(e) => set("plan_name", e.target.value)}
            >
              <option value="basic">Basic</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
          <div className="modal-field">
            <label>User Cap</label>
            <input
              type="number"
              min={1}
              value={form.user_cap}
              onChange={(e) => set("user_cap", e.target.value)}
              required
            />
          </div>
          <div className="modal-field">
            <label>Email Recipient Cap</label>
            <input
              type="number"
              min={1}
              value={form.recipient_cap}
              onChange={(e) => set("recipient_cap", e.target.value)}
              required
            />
          </div>
          <div className="modal-field">
            <label>Start Date</label>
            <input
              type="date"
              value={form.start_date}
              onChange={(e) => set("start_date", e.target.value)}
              required
            />
          </div>
          <div className="modal-field">
            <label>
              End Date <span className="modal-field-optional">(optional)</span>
            </label>
            <input
              type="date"
              value={form.end_date}
              onChange={(e) => set("end_date", e.target.value)}
            />
          </div>
          {error && <div className="admin-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Edit Org Modal ────────────────────────────────────────────────────────

function EditOrgModal({
  org,
  onClose,
  onSuccess
}: {
  org: Org;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    name: org.name,
    plan_name: org.plan_name,
    user_cap: org.user_cap,
    recipient_cap: org.recipient_cap ?? 10,
    status: org.status,
    start_date: org.start_date?.split("T")[0] ?? "",
    end_date: org.end_date?.split("T")[0] ?? ""
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const set = (k: string, v: string | number) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await superAdminApi.updateOrg(org.id, {
        ...form,
        user_cap: Number(form.user_cap),
        recipient_cap: Number(form.recipient_cap)
      });
      onSuccess();
      onClose();
    } catch (err) {
      if (axios.isAxiosError(err))
        setError(err.response?.data?.detail || "Update failed");
      else setError("Something went wrong");
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
            <input
              type="text"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              required
            />
          </div>
          <div className="modal-field">
            <label>Plan</label>
            <select
              value={form.plan_name}
              onChange={(e) => set("plan_name", e.target.value)}
            >
              <option value="basic">Basic</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
          <div className="modal-field">
            <label>User Cap</label>
            <input
              type="number"
              min={1}
              value={form.user_cap}
              onChange={(e) => set("user_cap", e.target.value)}
              required
            />
          </div>
          <div className="modal-field">
            <label>Email Recipient Cap</label>
            <input
              type="number"
              min={1}
              value={form.recipient_cap}
              onChange={(e) => set("recipient_cap", e.target.value)}
              required
            />
          </div>
          <div className="modal-field">
            <label>Status</label>
            <select
              value={form.status}
              onChange={(e) => set("status", e.target.value)}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="suspended">Suspended</option>
              <option value="expired">Expired</option>
            </select>
          </div>
          <div className="modal-field">
            <label>Start Date</label>
            <input
              type="date"
              value={form.start_date}
              onChange={(e) => set("start_date", e.target.value)}
              required
            />
          </div>
          <div className="modal-field">
            <label>End Date</label>
            <input
              type="date"
              value={form.end_date}
              onChange={(e) => set("end_date", e.target.value)}
              required
            />
          </div>
          {error && <div className="admin-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Org detail icons + stat card ──────────────────────────────────────────

const IconOrgUsers = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const IconOrgPlan = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="4" y="2" width="16" height="20" rx="2" />
    <path d="M8 6h8M8 10h8M8 14h5" />
  </svg>
);

const IconOrgStatus = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

const IconOrgCalendar = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

const IconOrgMail = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
  </svg>
);

const IconEdit = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

function OrgDetailMiniCard({
  label,
  value,
  sub,
  accent,
  icon
}: {
  label: string;
  value: string | number;
  sub: string;
  accent: string;
  icon: ReactNode;
}) {
  return (
    <div
      className="org-detail-mini-card"
      style={{ "--stat-accent": accent } as React.CSSProperties}
    >
      <div className="org-detail-mini-card-top">
        <div className="org-detail-mini-icon">{icon}</div>
      </div>
      <div className="org-detail-mini-value">{value}</div>
      <div className="org-detail-mini-label">{label}</div>
      <div className="org-detail-mini-sub">{sub}</div>
    </div>
  );
}

function formatOrgDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

// ── Org detail: invite + recipient modals ─────────────────────────────────

function OrgInviteModal({
  orgId,
  onClose,
  onSuccess
}: {
  orgId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await superAdminApi.inviteOrgUser(orgId, { email, role });
      onSuccess();
      onClose();
    } catch (err) {
      if (axios.isAxiosError(err))
        setError(err.response?.data?.detail || "Failed to send invite");
      else setError("Something went wrong");
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
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              placeholder="user@example.com"
            />
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
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Sending…" : "Send Invite"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RecipientReportTypesModal({
  orgId,
  recipient,
  onClose,
  onSuccess
}: {
  orgId: string;
  recipient?: Recipient;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const isEdit = !!recipient;
  const [email, setEmail] = useState(recipient?.email ?? "");
  const [name, setName] = useState(recipient?.name ?? "");
  const [selectedTypes, setSelectedTypes] = useState<string[]>(
    recipient?.report_types ?? []
  );
  const [enabledTypes, setEnabledTypes] = useState<string[]>([]);
  const [reportLabels, setReportLabels] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Promise.all([
      superAdminApi.getOrgNotificationSettings(orgId),
      superAdminApi.getReportTypes()
    ])
      .then(([settingsRes, typesRes]) => {
        const enabled = settingsRes.data.enabled_report_types;
        // Preserve master definition order from config.py, not MongoDB storage order
        const ordered = Object.keys(typesRes.data).filter((k) =>
          enabled.includes(k)
        );
        setEnabledTypes(ordered);
        setReportLabels(typesRes.data);
        // For new recipients default to all org-enabled types selected
        if (!isEdit) setSelectedTypes(ordered);
      })
      .catch(() => {});
  }, [orgId, isEdit]);

  const toggleType = (key: string) =>
    setSelectedTypes((prev) =>
      prev.includes(key) ? prev.filter((t) => t !== key) : [...prev, key]
    );

  const allSelected =
    enabledTypes.length > 0 &&
    enabledTypes.every((t) => selectedTypes.includes(t));
  const toggleAll = () =>
    setSelectedTypes(allSelected ? [] : [...enabledTypes]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (isEdit) {
        await superAdminApi.updateOrgRecipient(orgId, recipient.id, {
          report_types: selectedTypes
        });
      } else {
        await superAdminApi.addOrgRecipient(orgId, {
          email,
          name,
          is_active: true,
          report_types: selectedTypes
        });
      }
      onSuccess();
      onClose();
    } catch (err) {
      if (axios.isAxiosError(err))
        setError(err.response?.data?.detail || "Failed to save recipient");
      else setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>
          {isEdit
            ? `Notifications — ${recipient.name || recipient.email}`
            : "Add Email Recipient"}
        </h2>
        <form onSubmit={handleSubmit}>
          {!isEdit && (
            <>
              <div className="modal-field">
                <label>Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoFocus
                  placeholder="John Smith"
                />
              </div>
              <div className="modal-field">
                <label>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="john@example.com"
                />
              </div>
            </>
          )}
          <div className="modal-field">
            <div className="report-type-checklist-header">
              <label>Report Types</label>
              {enabledTypes.length > 0 && (
                <button
                  type="button"
                  className="report-type-select-all"
                  onClick={toggleAll}
                >
                  {allSelected ? "Deselect All" : "Select All"}
                </button>
              )}
            </div>
            {enabledTypes.length === 0 ? (
              <p className="notif-empty-hint">
                No report types enabled for this organization yet.
              </p>
            ) : (
              <div className="report-type-checklist">
                {enabledTypes.map((key) => (
                  <label key={key} className="report-type-check-row">
                    <input
                      type="checkbox"
                      checked={selectedTypes.includes(key)}
                      onChange={() => toggleType(key)}
                    />
                    <span>{reportLabels[key] ?? key}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          {error && <div className="admin-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Saving…" : isEdit ? "Save" : "Add Recipient"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function OrgDetailUsersTab({
  orgId,
  onMembersChange
}: {
  orgId: string;
  onMembersChange?: (count: number) => void;
}) {
  const [users, setUsers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [confirmReset, setConfirmReset] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await superAdminApi.getOrgUsers(orgId);
      setUsers(data);
      const seated = data.filter((u: OrgMember) => !u._is_invite).length;
      onMembersChange?.(seated);
    } finally {
      setLoading(false);
    }
  }, [orgId, onMembersChange]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSuspend = async (id: string) => {
    if (!confirm("Suspend this user? They will lose access immediately."))
      return;
    await superAdminApi.suspendOrgUser(orgId, id);
    load();
  };

  const handleReactivate = async (id: string) => {
    await superAdminApi.reactivateOrgUser(orgId, id);
    load();
  };

  const handleRemove = async (id: string) => {
    if (!confirm("Remove this user from the organization?")) return;
    await superAdminApi.removeOrgUser(orgId, id);
    load();
  };

  const handleCancelInvite = async (id: string) => {
    if (!confirm("Cancel this pending invitation?")) return;
    await superAdminApi.removeOrgUser(orgId, id);
    load();
  };

  const handleResendInvite = async (id: string) => {
    await superAdminApi.resendOrgInvite(orgId, id);
    alert("Invitation resent successfully.");
    load();
  };

  const handleForceReset = async (id: string) => {
    await superAdminApi.forceResetOrgUser(orgId, id);
    load();
  };

  return (
    <div>
      {showInvite && (
        <OrgInviteModal
          orgId={orgId}
          onClose={() => setShowInvite(false)}
          onSuccess={load}
        />
      )}
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
        <button
          type="button"
          className="btn-primary-gradient"
          onClick={() => setShowInvite(true)}
        >
          + Invite User
        </button>
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
                  <td style={{ textTransform: "capitalize" }}>{u.role}</td>
                  <td>
                    <span className={`status-badge ${u.status}`}>
                      {u.status}
                    </span>
                  </td>
                  <td className="cell-muted">
                    {u.created_at
                      ? new Date(u.created_at).toLocaleDateString()
                      : "—"}
                  </td>
                  <td>
                    <div className="org-detail-actions">
                      {u.status === "invited" ? (
                        <button
                          type="button"
                          className="btn-danger"
                          onClick={() => handleCancelInvite(u.id)}
                        >
                          Cancel Invite
                        </button>
                      ) : u.status === "expired" ? (
                        <>
                          <button
                            type="button"
                            className="btn-info"
                            onClick={() => handleResendInvite(u.id)}
                          >
                            Resend Invite
                          </button>
                          <button
                            type="button"
                            className="btn-danger"
                            onClick={() => handleRemove(u.id)}
                          >
                            Remove
                          </button>
                        </>
                      ) : (
                        <>
                          {u.status === "active" && (
                            <button
                              type="button"
                              className="btn-warning"
                              onClick={() => handleSuspend(u.id)}
                            >
                              Suspend
                            </button>
                          )}
                          {(u.status === "suspended" ||
                            u.status === "inactive") && (
                            <button
                              type="button"
                              className="btn-info"
                              onClick={() => handleReactivate(u.id)}
                            >
                              Reactivate
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn-info"
                            onClick={() => setConfirmReset(u.id)}
                          >
                            Reset Password
                          </button>
                          <button
                            type="button"
                            className="btn-danger"
                            onClick={() => handleRemove(u.id)}
                          >
                            Remove
                          </button>
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

function OrgDetailRecipientsTab({
  orgId,
  onCountChange
}: {
  orgId: string;
  onCountChange?: (n: number) => void;
}) {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editRecipient, setEditRecipient] = useState<Recipient | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await superAdminApi.getOrgRecipients(orgId);
      setRecipients(data);
      onCountChange?.(data.length);
    } finally {
      setLoading(false);
    }
  }, [orgId, onCountChange]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleActive = async (r: Recipient) => {
    await superAdminApi.updateOrgRecipient(orgId, r.id, {
      is_active: !r.is_active
    });
    load();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Remove this email recipient?")) return;
    await superAdminApi.deleteOrgRecipient(orgId, id);
    load();
  };

  return (
    <div>
      {showAdd && (
        <RecipientReportTypesModal
          orgId={orgId}
          onClose={() => setShowAdd(false)}
          onSuccess={load}
        />
      )}
      {editRecipient && (
        <RecipientReportTypesModal
          orgId={orgId}
          recipient={editRecipient}
          onClose={() => setEditRecipient(null)}
          onSuccess={load}
        />
      )}
      <div className="admin-action-row">
        <button
          type="button"
          className="btn-primary-gradient"
          onClick={() => setShowAdd(true)}
        >
          + Add Recipient
        </button>
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
                    {r.report_types.length === 0 ? (
                      <span className="cell-muted">None</span>
                    ) : (
                      <span className="report-types-badge">
                        {r.report_types.length} type
                        {r.report_types.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`status-badge ${r.is_active ? "active" : "inactive"}`}
                    >
                      {r.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="cell-muted">
                    {r.created_at
                      ? new Date(r.created_at).toLocaleDateString()
                      : "—"}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => toggleActive(r)}
                      >
                        {r.is_active ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => handleDelete(r.id)}
                      >
                        Remove
                      </button>
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

function OrgNotificationsTab({ orgId }: { orgId: string }) {
  const [allTypes, setAllTypes] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      superAdminApi.getReportTypes(),
      superAdminApi.getOrgNotificationSettings(orgId)
    ])
      .then(([typesRes, settingsRes]) => {
        setAllTypes(typesRes.data);
        setSelected(settingsRes.data.enabled_report_types);
      })
      .catch(() => setError("Failed to load notification settings"))
      .finally(() => setLoading(false));
  }, [orgId]);

  const toggle = (key: string) =>
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((t) => t !== key) : [...prev, key]
    );

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await superAdminApi.updateOrgNotificationSettings(orgId, {
        enabled_report_types: selected
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      if (axios.isAxiosError(err))
        setError(err.response?.data?.detail || "Failed to save");
      else setError("Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="loading">Loading…</p>;

  return (
    <div className="notif-settings-panel">
      <div className="notif-settings-header">
        <div>
          <div className="notif-settings-title">Notification Settings</div>
          <div className="notif-settings-subtitle">
            Select which report types this organization is allowed to receive.
          </div>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <div className="admin-error">{error}</div>}
      {saved && <div className="notif-saved-msg">Saved successfully.</div>}
      <div className="report-type-checklist report-type-checklist-full">
        {Object.entries(allTypes).map(([key, label]) => (
          <label key={key} className="report-type-check-row">
            <input
              type="checkbox"
              checked={selected.includes(key)}
              onChange={() => toggle(key)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Org Settings Tab ─────────────────────────────────────────────────────

function OrgSettingsTab({
  orgId,
  defaultVisible
}: {
  orgId: string;
  defaultVisible: boolean;
}) {
  const [visible, setVisible] = useState(defaultVisible);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await superAdminApi.updateOrg(orgId, {
        is_admin_dashboard_visible: visible
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      if (axios.isAxiosError(err))
        setError(err.response?.data?.detail || "Failed to save");
      else setError("Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="notif-settings-panel">
      <div className="notif-settings-header">
        <div>
          <div className="notif-settings-title">Organization Settings</div>
          <div className="notif-settings-subtitle">
            Control which features are accessible to admins in this
            organization.
          </div>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <div className="admin-error">{error}</div>}
      {saved && (
        <div className="notif-saved-msg">Settings saved successfully.</div>
      )}
      <div style={{ marginTop: "var(--space-lg)" }}>
        <label
          className="report-type-check-row"
          style={{
            gap: "var(--space-md)",
            alignItems: "flex-start",
            cursor: "pointer"
          }}
        >
          <input
            type="checkbox"
            checked={visible}
            onChange={(e) => setVisible(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <div>
            <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
              Admin Dashboard Visible
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                marginTop: 4,
                lineHeight: 1.5
              }}
            >
              When enabled, admins in this organization can access the Admin
              Panel. When disabled, they are redirected away from the admin
              panel.
            </div>
          </div>
        </label>
      </div>
    </div>
  );
}

// ── Org Deal Access Tab ───────────────────────────────────────────────────

function OrgDealAccessTab({
  orgId,
  initialAllowedIds
}: {
  orgId: string;
  initialAllowedIds: string[];
}) {
  const [allDeals, setAllDeals] = useState<DealSummary[]>([]);
  const [allowedIds, setAllowedIds] = useState<Set<string>>(
    new Set(initialAllowedIds)
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectionFilter, setSelectionFilter] = useState("all");

  useEffect(() => {
    setLoading(true);
    superAdminApi
      .getDealsForAdmin()
      .then(({ data }) => setAllDeals(data))
      .catch(() => setError("Failed to load deals"))
      .finally(() => setLoading(false));
  }, [orgId]);

  const visibleDeals = allDeals.filter((deal) => {
    if (statusFilter !== "all") {
      const s = (deal.status || "").toLowerCase();
      if (statusFilter === "open" && !["open", "active", "pending"].includes(s))
        return false;
      if (statusFilter === "closed" && !["closed", "completed"].includes(s))
        return false;
      if (
        statusFilter === "unknown" &&
        ["open", "active", "pending", "closed", "completed"].includes(s)
      )
        return false;
    }
    if (selectionFilter === "selected" && !allowedIds.has(deal.id))
      return false;
    if (selectionFilter === "unselected" && allowedIds.has(deal.id))
      return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        deal.id.toLowerCase().includes(q) ||
        deal.target.toLowerCase().includes(q) ||
        deal.acquirer.toLowerCase().includes(q) ||
        deal.target_ticker.toLowerCase().includes(q) ||
        deal.acquirer_ticker.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const toggleDeal = (id: string) => {
    setAllowedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setAllowedIds((prev) => {
      const next = new Set(prev);
      visibleDeals.forEach((d) => next.add(d.id));
      return next;
    });
  };

  const clearAllVisible = () => {
    setAllowedIds((prev) => {
      const next = new Set(prev);
      visibleDeals.forEach((d) => next.delete(d.id));
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await superAdminApi.setOrgDealAccess(orgId, Array.from(allowedIds));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      if (axios.isAxiosError(err))
        setError(err.response?.data?.detail || "Failed to save");
      else setError("Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  const statusBadgeClass = (s: string) => {
    const lower = (s || "").toLowerCase();
    if (["open", "active", "pending"].includes(lower)) return "active";
    if (["closed", "completed"].includes(lower)) return "inactive";
    return "suspended";
  };

  return (
    <div className="notif-settings-panel">
      <div className="deal-access-sticky-controls">
        <div className="notif-settings-header">
          <div>
            <div className="notif-settings-title">Deal Access</div>
            <div className="notif-settings-subtitle">
              Select which deals this organization can access.{" "}
              <strong>{allowedIds.size}</strong> deal
              {allowedIds.size !== 1 ? "s" : ""} selected.
            </div>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>

        {error && <div className="admin-error">{error}</div>}
        {saved && (
          <div className="notif-saved-msg">Deal access saved successfully.</div>
        )}

        <div className="admin-action-row deal-access-filter-row">
          <input
            type="text"
            className="deal-access-search"
            placeholder="Search deals…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All Statuses</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="unknown">Unknown</option>
          </select>
          <select
            value={selectionFilter}
            onChange={(e) => setSelectionFilter(e.target.value)}
          >
            <option value="all">All Deals</option>
            <option value="selected">Selected Only</option>
            <option value="unselected">Unselected Only</option>
          </select>
        </div>

        <div className="admin-action-row">
          <button
            type="button"
            className="btn-ghost"
            onClick={selectAllVisible}
            disabled={visibleDeals.length === 0}
          >
            Select All Visible ({visibleDeals.length})
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={clearAllVisible}
            disabled={visibleDeals.length === 0}
          >
            Clear All Visible
          </button>
        </div>
      </div>

      {loading ? (
        <p className="loading">Loading deals…</p>
      ) : allDeals.length === 0 ? (
        <div className="admin-empty">No deals found.</div>
      ) : visibleDeals.length === 0 ? (
        <div className="admin-empty">No deals match the current filters.</div>
      ) : (
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}></th>
                <th>Target</th>
                <th>Acquirer</th>
                <th>Tickers</th>
                <th>Value (Bn)</th>
                <th>Status</th>
                <th>Announced</th>
              </tr>
            </thead>
            <tbody>
              {visibleDeals.map((deal) => (
                <tr
                  key={deal.id}
                  onClick={() => toggleDeal(deal.id)}
                  style={{ cursor: "pointer" }}
                  className={
                    allowedIds.has(deal.id) ? "recipient-row-clickable" : ""
                  }
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={allowedIds.has(deal.id)}
                      onChange={() => toggleDeal(deal.id)}
                    />
                  </td>
                  <td style={{ fontWeight: 600 }}>{deal.target}</td>
                  <td>{deal.acquirer}</td>
                  <td className="cell-muted">
                    {deal.target_ticker}
                    {deal.acquirer_ticker ? ` · ${deal.acquirer_ticker}` : ""}
                  </td>
                  <td className="cell-muted">
                    {deal.deal_value_bn > 0
                      ? `$${deal.deal_value_bn.toFixed(1)}B`
                      : "—"}
                  </td>
                  <td>
                    <span
                      className={`status-badge ${statusBadgeClass(deal.status)}`}
                    >
                      {deal.status || "unknown"}
                    </span>
                  </td>
                  <td className="cell-muted">
                    {deal.announce_date
                      ? new Date(deal.announce_date).toLocaleDateString()
                      : "—"}
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

function OrgDetailView({
  org,
  onBack,
  onOrgUpdated
}: {
  org: Org;
  onBack: () => void;
  onOrgUpdated: () => void;
}) {
  const [activeTab, setActiveTab] = useState<
    "users" | "recipients" | "notifications" | "settings" | "deal-access"
  >("users");
  const [showEdit, setShowEdit] = useState(false);
  const [orgInfo, setOrgInfo] = useState(org);
  const [memberCount, setMemberCount] = useState(0);
  const [recipientCount, setRecipientCount] = useState(0);

  useEffect(() => {
    setOrgInfo(org);
  }, [org]);

  const refreshOrg = async () => {
    const { data } = await superAdminApi.getOrg(org.id);
    setOrgInfo(data);
    onOrgUpdated();
  };

  const statusLabel = orgInfo.status
    ? orgInfo.status.charAt(0).toUpperCase() + orgInfo.status.slice(1)
    : "—";

  return (
    <div className="org-detail-shell">
      {showEdit && (
        <EditOrgModal
          org={orgInfo}
          onClose={() => setShowEdit(false)}
          onSuccess={refreshOrg}
        />
      )}

      <div className="org-detail-topbar">
        <div className="org-detail-topbar-left">
          <button type="button" className="admin-back-btn" onClick={onBack}>
            ← Organizations
          </button>
          <div className="org-detail-title-row">
            <h2 className="org-detail-title">{orgInfo.name}</h2>
            <span className={`status-badge ${orgInfo.status}`}>
              {orgInfo.status}
            </span>
          </div>
          <p className="org-detail-subtitle">
            {orgInfo.plan_name} · Users {orgInfo.user_cap} · Recipients{" "}
            {orgInfo.recipient_cap ?? 10}
            {orgInfo.end_date
              ? ` · Ends ${formatOrgDate(orgInfo.end_date)}`
              : ""}
          </p>
        </div>
        <button
          type="button"
          className="org-detail-edit-btn"
          onClick={() => setShowEdit(true)}
        >
          <IconEdit />
          Edit Org
        </button>
      </div>

      <div className="stat-cards-grid stat-cards-grid-5">
        <OrgDetailMiniCard
          label="Users"
          value={`${memberCount} / ${orgInfo.user_cap}`}
          sub="of user cap"
          accent="var(--accent-blue)"
          icon={<IconOrgUsers />}
        />
        <OrgDetailMiniCard
          label="Recipients"
          value={`${recipientCount} / ${orgInfo.recipient_cap ?? 10}`}
          sub="of recipient cap"
          accent="var(--accent-orange)"
          icon={<IconOrgMail />}
        />
        <OrgDetailMiniCard
          label="Plan"
          value={
            orgInfo.plan_name.charAt(0).toUpperCase() +
            orgInfo.plan_name.slice(1)
          }
          sub="Current plan"
          accent="var(--accent-purple)"
          icon={<IconOrgPlan />}
        />
        <OrgDetailMiniCard
          label="Status"
          value={statusLabel}
          sub="Organization status"
          accent="var(--accent-green)"
          icon={<IconOrgStatus />}
        />
        <OrgDetailMiniCard
          label="Expiry"
          value={formatOrgDate(orgInfo.end_date)}
          sub="Plan expires"
          accent="var(--accent-yellow)"
          icon={<IconOrgCalendar />}
        />
      </div>

      <div className="org-detail-tabs">
        <button
          type="button"
          className={`org-detail-tab ${activeTab === "users" ? "active" : ""}`}
          onClick={() => setActiveTab("users")}
        >
          Users
        </button>
        <button
          type="button"
          className={`org-detail-tab ${activeTab === "recipients" ? "active" : ""}`}
          onClick={() => setActiveTab("recipients")}
        >
          Email Recipients
        </button>
        <button
          type="button"
          className={`org-detail-tab ${activeTab === "notifications" ? "active" : ""}`}
          onClick={() => setActiveTab("notifications")}
        >
          Notifications
        </button>
        <button
          type="button"
          className={`org-detail-tab ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => setActiveTab("settings")}
        >
          Settings
        </button>
        <button
          type="button"
          className={`org-detail-tab ${activeTab === "deal-access" ? "active" : ""}`}
          onClick={() => setActiveTab("deal-access")}
        >
          Deal Access
        </button>
      </div>

      <div className="org-detail-panel">
        {activeTab === "users" && (
          <OrgDetailUsersTab
            orgId={orgInfo.id}
            onMembersChange={setMemberCount}
          />
        )}
        {activeTab === "recipients" && (
          <OrgDetailRecipientsTab
            orgId={orgInfo.id}
            onCountChange={setRecipientCount}
          />
        )}
        {activeTab === "notifications" && (
          <OrgNotificationsTab orgId={orgInfo.id} />
        )}
        {activeTab === "settings" && (
          <OrgSettingsTab
            orgId={orgInfo.id}
            defaultVisible={orgInfo.is_admin_dashboard_visible ?? true}
          />
        )}
        {activeTab === "deal-access" && (
          <OrgDealAccessTab
            orgId={orgInfo.id}
            initialAllowedIds={orgInfo.allowed_deal_ids ?? []}
          />
        )}
      </div>
    </div>
  );
}

// ── Create User Modal (with org picker) ───────────────────────────────────

function CreateUserModal({
  orgs,
  onClose,
  onSuccess
}: {
  orgs: Org[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    email: "",
    password: "",
    role: "admin",
    organization_id: orgs[0]?.id ?? "",
    is_individual: false
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const set = (k: string, v: string | boolean) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const payload = {
        ...form,
        organization_id: form.is_individual
          ? undefined
          : form.organization_id || undefined
      };
      const { data } = await superAdminApi.createUser(payload);
      // Auto-set force_password_reset so user must change on first login
      await superAdminApi.forceResetUser(data.id);
      onSuccess();
      onClose();
    } catch (err) {
      if (axios.isAxiosError(err))
        setError(err.response?.data?.detail || "Failed to create user");
      else setError("Something went wrong");
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
              onChange={(e) => set("email", e.target.value)}
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
              onChange={(e) => set("password", e.target.value)}
              required
              placeholder="Min 8 chars, 1 uppercase, 1 digit"
            />
          </div>
          <div className="modal-field">
            <label>Role</label>
            <select
              value={form.role}
              onChange={(e) => set("role", e.target.value)}
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
              <option value="super_admin">Super Admin</option>
            </select>
          </div>
          <div className="modal-field">
            <label>Account Type</label>
            <select
              value={form.is_individual ? "individual" : "org"}
              onChange={(e) =>
                set("is_individual", e.target.value === "individual")
              }
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
                onChange={(e) => set("organization_id", e.target.value)}
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
          <p
            style={{
              color: "var(--text-muted)",
              fontSize: "10px",
              marginTop: "4px",
              fontFamily: "var(--font-mono)"
            }}
          >
            User will be required to change password on first login.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Creating…" : "Create User"}
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
  const [detailOrg, setDetailOrg] = useState<Org | null>(null);
  const [statusFilter, setStatusFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await superAdminApi.getOrgs(statusFilter || undefined);
      setOrgs(data);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (org: Org) => {
    if (!confirm(`Deactivate "${org.name}"?`)) return;
    await superAdminApi.deleteOrg(org.id);
    load();
  };

  if (detailOrg) {
    return (
      <OrgDetailView
        org={detailOrg}
        onBack={() => setDetailOrg(null)}
        onOrgUpdated={load}
      />
    );
  }

  return (
    <div>
      {showCreate && (
        <CreateOrgModal onClose={() => setShowCreate(false)} onSuccess={load} />
      )}
      {editOrg && (
        <EditOrgModal
          org={editOrg}
          onClose={() => setEditOrg(null)}
          onSuccess={load}
        />
      )}

      <div className="admin-action-row">
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          + New Organization
        </button>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="suspended">Suspended</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {loading ? (
        <p className="loading">Loading…</p>
      ) : orgs.length === 0 ? (
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
                  <td style={{ fontWeight: 600 }}>
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{
                        padding: 0,
                        border: "none",
                        fontWeight: 600,
                        color: "var(--accent-blue)"
                      }}
                      onClick={() => setDetailOrg(org)}
                    >
                      {org.name}
                    </button>
                  </td>
                  <td
                    style={{
                      textTransform: "capitalize",
                      color: "var(--accent-blue)"
                    }}
                  >
                    {org.plan_name}
                  </td>
                  <td>
                    <span className={`status-badge ${org.status}`}>
                      {org.status}
                    </span>
                  </td>
                  <td>{org.user_cap}</td>
                  <td className="cell-muted">
                    {org.end_date
                      ? new Date(org.end_date).toLocaleDateString()
                      : "—"}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setDetailOrg(org)}
                      >
                        Manage
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setEditOrg(org)}
                      >
                        Edit
                      </button>
                      <button
                        className="btn-danger"
                        onClick={() => handleDelete(org)}
                      >
                        Deactivate
                      </button>
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
  const [confirmReset, setConfirmReset] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, orgsRes] = await Promise.all([
        superAdminApi.getAllUsers(),
        superAdminApi.getOrgs()
      ]);
      setUsers(usersRes.data);
      setOrgs(orgsRes.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
    load();
  };

  const getOrgName = (orgId: string | null) => {
    if (!orgId) return "—";
    return orgs.find((o) => o.id === orgId)?.name ?? orgId.slice(-6);
  };

  return (
    <div>
      {showCreate && (
        <CreateUserModal
          orgs={orgs.filter((o) => o.status === "active")}
          onClose={() => setShowCreate(false)}
          onSuccess={load}
        />
      )}
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
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          + Create User
        </button>
      </div>

      {loading ? (
        <p className="loading">Loading…</p>
      ) : users.length === 0 ? (
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
                  <td style={{ color: "var(--text-secondary)" }}>
                    {u.is_individual ? (
                      <span style={{ color: "var(--accent-yellow)" }}>
                        Individual
                      </span>
                    ) : (
                      getOrgName(u.organization_id)
                    )}
                  </td>
                  <td>
                    <button
                      className="btn-ghost"
                      onClick={() => setConfirmReset(u.id)}
                    >
                      Force Reset
                    </button>
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
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

const IconOrgs = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="7" width="20" height="14" rx="2" />
    <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
    <line x1="12" y1="12" x2="12" y2="12.01" />
  </svg>
);

const IconUsers = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const NAV_ITEMS = [
  { id: "overview", label: "Overview", Icon: IconOverview },
  { id: "orgs", label: "Organizations", Icon: IconOrgs },
  { id: "users", label: "All Users", Icon: IconUsers }
];

// ── Overview Tab ──────────────────────────────────────────────────────────

interface Stats {
  total_orgs: number;
  active_orgs: number;
  expired_orgs: number;
  expiring_soon: number;
  near_cap: number;
  total_users: number;
  active_users: number;
  force_reset_pending: number;
  pending_invites: number;
}

// Section header with icon
const SectionHeader = ({
  label,
  icon
}: {
  label: string;
  icon: React.ReactNode;
}) => (
  <div className="overview-group-header">
    <span className="overview-group-icon">{icon}</span>
    <span className="overview-group-label-text">{label}</span>
  </div>
);

// Section icons
const IconBell = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="14"
    height="14"
  >
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

function OverviewTab() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    superAdminApi
      .getStats()
      .then(({ data }) => setStats(data))
      .catch(() => setError("Failed to load statistics"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="loading">Loading overview…</p>;
  if (error) return <div className="admin-error">{error}</div>;
  if (!stats) return null;

  const orgActivePct =
    stats.total_orgs > 0
      ? Math.round((stats.active_orgs / stats.total_orgs) * 100)
      : 0;
  const userActivePct =
    stats.total_users > 0
      ? Math.round((stats.active_users / stats.total_users) * 100)
      : 0;

  return (
    <div className="overview-section">
      {/* ── Organizations ── */}
      <SectionHeader label="Organizations" icon={<IconOrgs />} />
      <div className="stat-cards-grid">
        <OrgDetailMiniCard
          label="Total Organizations"
          value={stats.total_orgs}
          sub={`${orgActivePct}% active`}
          accent="var(--accent-purple)"
          icon={<IconOrgs />}
        />
        <OrgDetailMiniCard
          label="Active Organizations"
          value={stats.active_orgs}
          sub="Currently enabled"
          accent="var(--accent-green)"
          icon={<IconOrgs />}
        />
        <OrgDetailMiniCard
          label="Expiring in 30 Days"
          value={stats.expiring_soon}
          sub="Needs renewal"
          accent="var(--accent-yellow)"
          icon={<IconOrgs />}
        />
        <OrgDetailMiniCard
          label="Near User Cap"
          value={stats.near_cap}
          sub="≥ 80% of cap used"
          accent="var(--accent-orange)"
          icon={<IconUsers />}
        />
      </div>

      {/* ── Users ── */}
      <SectionHeader label="Users" icon={<IconUsers />} />
      <div className="stat-cards-grid stat-cards-grid-3">
        <OrgDetailMiniCard
          label="Total Users"
          value={stats.total_users}
          sub="All registered"
          accent="var(--accent-blue)"
          icon={<IconUsers />}
        />
        <OrgDetailMiniCard
          label="Active Users"
          value={stats.active_users}
          sub={`${userActivePct}% of total`}
          accent="var(--accent-green)"
          icon={<IconUsers />}
        />
        <OrgDetailMiniCard
          label="Pending Invitations"
          value={stats.pending_invites}
          sub="Awaiting acceptance"
          accent="var(--accent-blue)"
          icon={<IconUsers />}
        />
      </div>

      {/* ── Alerts ── */}
      <SectionHeader label="Alerts" icon={<IconBell />} />
      <div className="stat-cards-grid stat-cards-grid-2">
        <OrgDetailMiniCard
          label="Force Reset Pending"
          value={stats.force_reset_pending}
          sub="Users not yet reset"
          accent="var(--accent-red)"
          icon={<IconUsers />}
        />
        <OrgDetailMiniCard
          label="Expired Organizations"
          value={stats.expired_orgs}
          sub="Past end date"
          accent="var(--accent-red)"
          icon={<IconOrgs />}
        />
      </div>
    </div>
  );
}

// ── Main SuperAdminPanel ──────────────────────────────────────────────────

export default function SuperAdminPanel() {
  const [activeSection, setActiveSection] = useState("overview");

  return (
    <div className="dashboard">
      <DashboardNav />
      <div className="admin-panel-page admin-panel-page-in-dashboard">
        <div className="admin-panel-body">
          <nav className="admin-sidebar">
            <div className="admin-sidebar-section">
              <div className="admin-sidebar-label">Manage</div>
              {NAV_ITEMS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={`admin-sidebar-link super-admin-link ${activeSection === id ? "active" : ""}`}
                  onClick={() => setActiveSection(id)}
                >
                  <Icon />
                  {label}
                </button>
              ))}
            </div>
          </nav>

          <main className="admin-panel-content">
            {activeSection === "overview" && <OverviewTab />}
            {activeSection === "orgs" && <OrgsTab />}
            {activeSection === "users" && <AllUsersTab />}
          </main>
        </div>
      </div>
    </div>
  );
}
