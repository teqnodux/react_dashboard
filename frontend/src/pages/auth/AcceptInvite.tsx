import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { authApi } from '../../services/adminApi';
import { useAuth } from '../../context/AuthContext';
import '../../styles/Login.css';

type TokenStatus = 'checking' | 'valid' | 'accepted' | 'expired' | 'invalid';

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();
  const { login } = useAuth();

  const [tokenStatus, setTokenStatus] = useState<TokenStatus>(token ? 'checking' : 'invalid');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    authApi.checkInvite(token)
      .then(({ data }) => setTokenStatus(data.status as TokenStatus))
      .catch(() => setTokenStatus('invalid'));
  }, [token]);

  // Redirect to login if already accepted
  useEffect(() => {
    if (tokenStatus === 'accepted') {
      navigate('/login?info=invite_already_accepted', { replace: true });
    }
  }, [tokenStatus, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      const { data } = await authApi.acceptInvite(token, password, name);
      localStorage.setItem('token', data.access);
      localStorage.setItem('refreshToken', data.refresh);
      localStorage.setItem('user', JSON.stringify({
        email: data.email,
        role: data.role,
        id: data.user_id,
        org_id: data.org_id ?? null,
        is_individual: false,
      }));
      navigate('/', { replace: true });
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.detail || 'Could not accept invitation.');
      } else {
        setError('Something went wrong.');
      }
    } finally {
      setLoading(false);
    }
  };

  if (!token || tokenStatus === 'invalid') {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Invalid Invitation</h1>
          <p>This invitation link is missing or malformed. Please ask your admin to send a new invite.</p>
        </div>
      </div>
    );
  }

  if (tokenStatus === 'expired') {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Invitation Expired</h1>
          <p>This invitation link has expired. Please contact your admin to resend the invite.</p>
        </div>
      </div>
    );
  }

  if (tokenStatus === 'checking') {
    return (
      <div className="login-page">
        <div className="login-card">
          <p>Verifying invitation…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Accept Invitation</h1>
        <p>Set up your account to get started.</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="name">Your Name</label>
            <input
              id="name"
              type="text"
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="login-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder="Min 8 chars, 1 uppercase, 1 digit"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="login-field">
            <label htmlFor="confirm">Confirm Password</label>
            <input
              id="confirm"
              type="password"
              placeholder="Repeat password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Creating account…' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
