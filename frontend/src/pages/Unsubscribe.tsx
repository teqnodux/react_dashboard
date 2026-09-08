import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import DashboardNav from '../components/DashboardNav';
import { userApi } from '../services/adminApi';
import '../styles/AdminNav.css';
import '../styles/Unsubscribe.css';

type Status =
  | 'checking'
  | 'invalid'
  | 'load_error'
  | 'confirm'
  | 'unsubscribed'
  | 'already_unsubscribed'
  | 'resubscribed';

export default function Unsubscribe() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const dealId = (searchParams.get('deal_id') ?? '').trim();

  const [dealLabel, setDealLabel] = useState(dealId);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<Status>(dealId ? 'checking' : 'invalid');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!dealId) return;

    let cancelled = false;

    userApi.getSubscription(dealId)
      .then(({ data }) => {
        if (cancelled) return;
        const parts = [data.target, data.acquirer].filter(Boolean);
        if (parts.length) setDealLabel(parts.join(' / '));
        setStatus(data.subscribed ? 'confirm' : 'already_unsubscribed');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const statusCode = axios.isAxiosError(err) ? err.response?.status : undefined;
        // Fake / unknown deal_id (or missing subscription route) must never show Confirm.
        if (statusCode === 404 || statusCode === 422) {
          setStatus('invalid');
          return;
        }
        const detail = axios.isAxiosError(err) ? err.response?.data?.detail : undefined;
        setError(typeof detail === 'string' && detail ? detail : 'Could not load subscription status.');
        setStatus('load_error');
      });

    return () => {
      cancelled = true;
    };
  }, [dealId]);

  async function handleConfirm() {
    if (!dealId || submitting) return;
    setError('');
    setSubmitting(true);
    try {
      await userApi.unsubscribeDeal(dealId);
      setStatus('unsubscribed');
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        setStatus('invalid');
        return;
      }
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.detail || 'Could not unsubscribe. Please try again.');
      } else {
        setError('Something went wrong.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResubscribe() {
    if (!dealId || submitting) return;
    setError('');
    setSubmitting(true);
    try {
      await userApi.resubscribeDeal(dealId);
      setStatus('resubscribed');
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        setStatus('invalid');
        return;
      }
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.detail || 'Could not resubscribe. Please try again.');
      } else {
        setError('Something went wrong.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function goHome() {
    navigate('/', { replace: true });
  }

  const showResubscribeFooter =
    status === 'unsubscribed' || status === 'already_unsubscribed';

  return (
    <div className="dashboard">
      <DashboardNav />
      <div className="modal-overlay">
        <div className="modal-box unsubscribe-modal" onClick={(e) => e.stopPropagation()}>
          {!dealId || status === 'invalid' ? (
            <>
              <h2>Unsubscribe</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 var(--space-lg)' }}>
                {dealId
                  ? 'This deal was not found. The unsubscribe link may be invalid or out of date.'
                  : 'This unsubscribe link is missing a deal. Please use the link from your email.'}
              </p>
              <div className="modal-actions">
                <button type="button" className="btn-primary" onClick={goHome}>Go to Dashboard</button>
              </div>
            </>
          ) : status === 'checking' ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>Checking subscription…</p>
          ) : status === 'load_error' ? (
            <>
              <h2>Unsubscribe</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 var(--space-lg)' }}>
                {error || 'Could not load subscription status.'}
              </p>
              <div className="modal-actions">
                <button type="button" className="btn-primary" onClick={goHome}>Go to Dashboard</button>
              </div>
            </>
          ) : showResubscribeFooter ? (
            <>
              <div className="unsubscribe-success-banner">
                <div className="unsubscribe-success-icon" aria-hidden="true">✓</div>
                <div className="unsubscribe-success-copy">
                  <p className="unsubscribe-success-title">
                    {status === 'already_unsubscribed'
                      ? 'You are already unsubscribed.'
                      : 'You have successfully unsubscribed.'}
                  </p>
                  <p className="unsubscribe-success-sub">
                    {status === 'already_unsubscribed'
                      ? `You will not receive emails for ${dealLabel}.`
                      : `You'll no longer receive emails for ${dealLabel}, but you can change your decision at any time.`}
                  </p>
                </div>
              </div>
              {error && <div className="admin-error" style={{ marginTop: 12 }}>{error}</div>}
              <div className="unsubscribe-success-footer">
                <span className="unsubscribe-accident">Did you unsubscribe by accident?</span>
                <div className="unsubscribe-success-actions">
                  <button
                    type="button"
                    className="unsubscribe-resub-btn"
                    onClick={handleResubscribe}
                    disabled={submitting}
                  >
                    {submitting ? 'Resubscribing…' : 'Resubscribe'}
                  </button>
                  <button
                    type="button"
                    className="unsubscribe-dashboard-btn"
                    onClick={goHome}
                    disabled={submitting}
                  >
                    Go to Dashboard
                  </button>
                </div>
              </div>
            </>
          ) : status === 'resubscribed' ? (
            <>
              <div className="unsubscribe-success-banner">
                <div className="unsubscribe-success-icon" aria-hidden="true">✓</div>
                <div className="unsubscribe-success-copy">
                  <p className="unsubscribe-success-title">You have successfully resubscribed.</p>
                  <p className="unsubscribe-success-sub">
                    You'll receive emails for {dealLabel} again.
                  </p>
                </div>
              </div>
              <div className="unsubscribe-success-footer">
                <div className="unsubscribe-success-actions">
                  <button type="button" className="unsubscribe-dashboard-btn" onClick={goHome}>
                    Go to Dashboard
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <h2>Unsubscribe</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 var(--space-lg)' }}>
                Stop receiving emails for <strong>{dealLabel}</strong>?
              </p>
              {error && <div className="admin-error">{error}</div>}
              <div className="modal-actions">
                <button type="button" className="btn-ghost" onClick={goHome} disabled={submitting}>
                  Cancel
                </button>
                <button type="button" className="btn-primary" onClick={handleConfirm} disabled={submitting}>
                  {submitting ? 'Unsubscribing…' : 'Confirm unsubscribe'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
