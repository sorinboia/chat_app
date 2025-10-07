import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

const apiClient = axios.create({
  baseURL: API_BASE
});

export function setAuthToken(token) {
  if (token) {
    apiClient.defaults.headers.common.Authorization = `Bearer ${token}`;
    localStorage.setItem('access_token', token);
  } else {
    delete apiClient.defaults.headers.common.Authorization;
    localStorage.removeItem('access_token');
  }
}

export function getStoredToken() {
  return localStorage.getItem('access_token');
}

export default apiClient;
