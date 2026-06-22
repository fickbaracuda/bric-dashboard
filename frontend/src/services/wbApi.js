import axios from 'axios';
import { getToken } from '../utils/auth';

const API_URL = import.meta.env.VITE_API_URL || '';
const BASE    = `${API_URL}/api/warroom-builder`;

function h() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Overview
export const wbGetOverview = () =>
  axios.get(`${BASE}/overview`, { headers: h() }).then(r => r.data);

// Registry & Plugins
export const wbGetRegistry = () =>
  axios.get(`${BASE}/registry`, { headers: h() }).then(r => r.data);
export const wbGetPlugins = () =>
  axios.get(`${BASE}/plugins`,  { headers: h() }).then(r => r.data);

// Warrooms CRUD
export const wbGetWarrooms = () =>
  axios.get(`${BASE}/warrooms`, { headers: h() }).then(r => r.data);
export const wbGetWarroom = (id) =>
  axios.get(`${BASE}/warrooms/${id}`, { headers: h() }).then(r => r.data);
export const wbCreateWarroom = (data) =>
  axios.post(`${BASE}/warrooms`, data, { headers: h() }).then(r => r.data);
export const wbUpdateWarroom = (id, data) =>
  axios.put(`${BASE}/warrooms/${id}`, data, { headers: h() }).then(r => r.data);
export const wbDeleteWarroom = (id) =>
  axios.delete(`${BASE}/warrooms/${id}`, { headers: h() }).then(r => r.data);

// Sheet
export const wbSheetPreview = (warroom_id, sheet_url) =>
  axios.post(`${BASE}/warrooms/${warroom_id}/sheet/preview`, { sheet_url }, { headers: h() }).then(r => r.data);
export const wbSheetSave = (warroom_id, mappings) =>
  axios.post(`${BASE}/warrooms/${warroom_id}/sheet/save`, { mappings }, { headers: h() }).then(r => r.data);

// Generate
export const wbGenerate = (id) =>
  axios.post(`${BASE}/warrooms/${id}/generate`, {}, { headers: h(), timeout: 120000 }).then(r => r.data);

// Remap — re-detect column mappings dari detected_cols tersimpan lalu regenerate
export const wbRemap = (id) =>
  axios.post(`${BASE}/warrooms/${id}/remap`, {}, { headers: h() }).then(r => r.data);

// Dashboard
export const wbGetDashboard = (id) =>
  axios.get(`${BASE}/warrooms/${id}/dashboard`, { headers: h() }).then(r => r.data);

// Snapshots
export const wbGetSnapshots = (id) =>
  axios.get(`${BASE}/warrooms/${id}/snapshots`, { headers: h() }).then(r => r.data);
export const wbGetSnapshot = (id, sid) =>
  axios.get(`${BASE}/warrooms/${id}/snapshots/${sid}`, { headers: h() }).then(r => r.data);

// Alerts
export const wbGetAlerts = (id, resolved = false) =>
  axios.get(`${BASE}/warrooms/${id}/alerts?resolved=${resolved}`, { headers: h() }).then(r => r.data);
export const wbResolveAlert = (id, aid) =>
  axios.patch(`${BASE}/warrooms/${id}/alerts/${aid}`, {}, { headers: h() }).then(r => r.data);

// Actions (per warroom)
export const wbGetActions = (id, status) =>
  axios.get(`${BASE}/warrooms/${id}/actions${status ? `?status=${status}` : ''}`, { headers: h() }).then(r => r.data);
export const wbUpdateAction = (id, aid, data) =>
  axios.put(`${BASE}/warrooms/${id}/actions/${aid}`, data, { headers: h() }).then(r => r.data);

// Global (lintas warroom)
export const wbGetAllActions = (params = {}) => {
  const q = new URLSearchParams(params).toString();
  return axios.get(`${BASE}/actions${q ? '?' + q : ''}`, { headers: h() }).then(r => r.data);
};
export const wbGetAllAlerts = (resolved = false) =>
  axios.get(`${BASE}/alerts?resolved=${resolved}`, { headers: h() }).then(r => r.data);
