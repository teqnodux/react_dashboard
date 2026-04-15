import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');

const api = axios.create({ baseURL: API_BASE_URL });

// ── Logout callback — set by AuthContext so the interceptor can trigger
//    a React-aware logout without a circular import ──────────────────────
let logoutCallback: (() => void) | null = null;
export function setLogoutCallback(cb: () => void) {
  logoutCallback = cb;
}

// ── Request interceptor: attach Bearer token to every outgoing request ──
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Response interceptor: silent token refresh with request queue ────────

interface QueueItem {
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}

let isRefreshing = false;
let failedQueue: QueueItem[] = [];

function processQueue(error: unknown, token: string | null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (token) resolve(token);
    else reject(error);
  });
  failedQueue = [];
}

function clearAuthAndRedirect() {
  localStorage.removeItem('token');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('user');
  if (logoutCallback) logoutCallback();
  window.location.href = '/login';
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    const status = error.response?.status;

    // Only attempt refresh on 401, or on network errors (CORS-blocked 401s have no response)
    const isAuthError = status === 401 || (!error.response && !!localStorage.getItem('token'));

    if (!isAuthError || !originalRequest || originalRequest._retry) {
      return Promise.reject(error);
    }

    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) {
      clearAuthAndRedirect();
      return Promise.reject(error);
    }

    if (isRefreshing) {
      return new Promise<string>((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then((newToken) => {
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return api(originalRequest);
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      // Use raw axios (not `api`) to avoid triggering the interceptor loop
      const { data } = await axios.post(`${API_BASE_URL}/api/auth/token/refresh`, { refresh: refreshToken });
      const newAccessToken: string = data.access;

      localStorage.setItem('token', newAccessToken);
      api.defaults.headers.common.Authorization = `Bearer ${newAccessToken}`;

      processQueue(null, newAccessToken);

      originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
      return api(originalRequest);
    } catch (refreshError) {
      processQueue(refreshError, null);
      clearAuthAndRedirect();
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);

export default api;
