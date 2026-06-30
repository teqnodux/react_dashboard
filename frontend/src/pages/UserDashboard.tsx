import { useState, useEffect } from 'react';
import DashboardNav from '../components/DashboardNav';
import { userApi } from '../services/adminApi';
import DealAccessPicker from '../components/DealAccessPicker';
import '../styles/AdminNav.css';

export default function UserDashboard() {
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [allowedIds, setAllowedIds] = useState<string[]>([]);
  const [recipientName, setRecipientName] = useState('');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    userApi.getMyRecipient()
      .then(({ data }) => {
        setRecipientId(data.id);
        setAllowedIds(data.allowed_deal_ids ?? []);
        setRecipientName(data.name || data.email);
      })
      .catch((err) => {
        if (err?.response?.status === 404) setNotFound(true);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="dashboard">
      <DashboardNav />
      <div
        className="admin-panel-page admin-panel-page-in-dashboard"
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        <div className="admin-panel-content" style={{ flex: 1, overflowY: 'auto', paddingTop: 0 }}>
          {loading ? (
            <p className="loading" style={{ marginTop: 'var(--space-xl)' }}>Loading…</p>
          ) : notFound ? (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', minHeight: '60vh', gap: 'var(--space-lg)',
            }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-secondary)' }}>
                No deal access configured for your account.
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                Contact your administrator to be added as an email recipient.
              </div>
            </div>
          ) : (
            <DealAccessPicker
              initialAllowedIds={allowedIds}
              subtitle={`Your personal deal access${recipientName ? ` — ${recipientName}` : ''}.`}
              onSave={(ids) =>
                userApi.setMyDealAccess(ids).then(() => setAllowedIds(ids))
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
