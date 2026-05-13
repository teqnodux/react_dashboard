import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { authApi } from '../../services/adminApi';
import '../../styles/Login.css';

export default function ChangePassword() {
  const navigate = useNavigate();

  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('New passwords do not match');
      return;
    }
    setLoading(true);
    try {
      const { data } = await authApi.changePassword(current, password);
      // Backend returns fresh tokens — update storage so next request works
      if (data.access) {
        localStorage.setItem('token', data.access);
      }
      if (data.refresh) {
        localStorage.setItem('refreshToken', data.refresh);
      }
      navigate('/', { replace: true });
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.detail || 'Password change failed.');
      } else {
        setError('Something went wrong.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Change Password</h1>
        <p>Please set a new password to continue.</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="current">Current Password</label>
            <input
              id="current"
              type="password"
              placeholder="Your current password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="login-field">
            <label htmlFor="password">New Password</label>
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
            <label htmlFor="confirm">Confirm New Password</label>
            <input
              id="confirm"
              type="password"
              placeholder="Repeat new password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Saving…' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  );
}
