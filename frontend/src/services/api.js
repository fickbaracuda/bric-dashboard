import axios from 'axios';
import { getToken, logout } from '../utils/auth';

const API_URL = import.meta.env.VITE_API_URL || '';

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

axios.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      logout();
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export const login = async (username, password) => {
  const res = await axios.post(`${API_URL}/api/auth/login`, { username, password });
  return res.data;
};

export const getUsers = async () => {
  const res = await axios.get(`${API_URL}/api/users`, { headers: authHeaders() });
  return res.data;
};
export const createUser = async (data) => {
  const res = await axios.post(`${API_URL}/api/users`, data, { headers: authHeaders() });
  return res.data;
};
export const updateUser = async (id, data) => {
  const res = await axios.put(`${API_URL}/api/users/${id}`, data, { headers: authHeaders() });
  return res.data;
};
export const deleteUser = async (id) => {
  const res = await axios.delete(`${API_URL}/api/users/${id}`, { headers: authHeaders() });
  return res.data;
};

export const getScoreboard = async (bulan, metric = 'kpi') => {
  const res = await axios.get(`${API_URL}/api/scoreboard/units`, {
    params: { bulan, metric },
    headers: authHeaders()
  });
  return res.data;
};

export const getWinmeData = async (bulan) => {
  const res = await axios.get(`${API_URL}/api/winme`, {
    params: { bulan },
    headers: authHeaders()
  });
  return res.data;
};

export const getMembers = async (unit = 'winme_instaqris') => {
  const res = await axios.get(`${API_URL}/api/members`, {
    params: { unit }, headers: authHeaders()
  });
  return res.data;
};
export const getMemberDetail = async (id) => {
  const res = await axios.get(`${API_URL}/api/members/${id}/detail`, {
    headers: authHeaders()
  });
  return res.data;
};
export const createMember = async (data) => {
  const res = await axios.post(`${API_URL}/api/members`, data, {
    headers: authHeaders()
  });
  return res.data;
};
export const updateMember = async (id, data) => {
  const res = await axios.put(`${API_URL}/api/members/${id}`, data, {
    headers: authHeaders()
  });
  return res.data;
};
export const deleteMember = async (id) => {
  const res = await axios.delete(`${API_URL}/api/members/${id}`, {
    headers: authHeaders()
  });
  return res.data;
};
export const addMemberTarget = async (memberId, data) => {
  const res = await axios.post(`${API_URL}/api/members/${memberId}/targets`, data, {
    headers: authHeaders()
  });
  return res.data;
};
export const deleteMemberTarget = async (targetId) => {
  const res = await axios.delete(`${API_URL}/api/members/targets/${targetId}`, {
    headers: authHeaders()
  });
  return res.data;
};
export const updatePencapaian = async (targetId, data) => {
  const res = await axios.post(
    `${API_URL}/api/members/targets/${targetId}/pencapaian`, data,
    { headers: authHeaders() }
  );
  return res.data;
};

export const getDompetDigitalData = async (bulan) => {
  const res = await axios.get(`${API_URL}/api/dompetdigital`, {
    params: { bulan },
    headers: authHeaders()
  });
  return res.data;
};

export const getPaymentAgentData = async (bulan) => {
  const res = await axios.get(`${API_URL}/api/paymentagent`, {
    params: { bulan },
    headers: authHeaders()
  });
  return res.data;
};
