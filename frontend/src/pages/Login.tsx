import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import '../styles/Login.css';

export default function Login() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const infoParam = searchParams.get('info');
  const infoMessage = infoParam === 'invite_already_accepted'
    ? 'This invitation has already been accepted. Please sign in.'
    : null;

  if (isAuthenticated) return <Navigate to="/" replace />;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const mustReset = await login(email, password);
      if (mustReset) {
        navigate('/change-password', { replace: true });
      }
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.detail || 'Invalid email or password');
      } else {
        setError(err instanceof Error ? err.message : 'Login failed');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Sign In</h1>
        <p>Enter your credentials to continue</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="login-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {infoMessage && <div className="login-error" style={{ background: 'color-mix(in srgb, var(--accent-blue) 15%, transparent)', borderColor: 'var(--accent-blue)' }}>{infoMessage}</div>}
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="login-btn" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
        <p style={{ marginTop: '16px', textAlign: 'center' }}>
          <Link to="/forgot-password" style={{ color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>Forgot password?</Link>
        </p>
      </div>
    </div>
  );
}
