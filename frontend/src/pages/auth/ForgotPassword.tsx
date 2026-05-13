import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { authApi } from '../../services/adminApi';
import '../../styles/Login.css';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await authApi.forgotPassword(email);
      setSubmitted(true);
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.detail || 'Something went wrong. Please try again.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Reset Password</h1>
        {submitted ? (
          <>
            <p style={{ color: '#166534', background: '#dcfce7', padding: '12px', borderRadius: '8px', fontSize: '0.9rem' }}>
              If that email is registered, you'll receive a reset link shortly.
            </p>
            <p style={{ marginTop: '16px', fontSize: '0.875rem', textAlign: 'center' }}>
              <Link to="/login" style={{ color: '#2563eb' }}>Back to Sign In</Link>
            </p>
          </>
        ) : (
          <>
            <p>Enter your email and we'll send you a link to reset your password.</p>
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
              {error && <div className="login-error">{error}</div>}
              <button type="submit" className="login-btn" disabled={loading}>
                {loading ? 'Sending…' : 'Send Reset Link'}
              </button>
            </form>
            <p style={{ marginTop: '16px', fontSize: '0.875rem', textAlign: 'center' }}>
              <Link to="/login" style={{ color: '#2563eb' }}>Back to Sign In</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
