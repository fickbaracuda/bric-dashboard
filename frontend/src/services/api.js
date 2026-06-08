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

/* In-flight deduplication + 20s TTL cache untuk getMembers */
const _membersCache = {};
const MEMBERS_TTL   = 20_000;

export const clearMembersCache = () => {
  Object.keys(_membersCache).forEach(k => delete _membersCache[k]);
};

export const getMembers = async (unit = 'winme_instaqris') => {
  const now = Date.now();
  const c   = _membersCache[unit];
  if (c?.data && now - c.at < MEMBERS_TTL) return c.data;
  if (c?.promise) return c.promise;

  const promise = axios.get(`${API_URL}/api/members`, {
    params: { unit }, headers: authHeaders(),
  }).then(res => {
    _membersCache[unit] = { data: res.data, at: Date.now() };
    return res.data;
  }).finally(() => {
    if (_membersCache[unit]) delete _membersCache[unit].promise;
  });

  _membersCache[unit] = { ...(c || {}), promise };
  return promise;
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

/* AI Chat — kirim pesan ke Gemini via backend */
export const sendAiMessage = async (message, history = [], pageContext = '') => {
  const res = await axios.post(`${API_URL}/api/ai/chat`, { message, history, pageContext }, {
    headers: authHeaders()
  });
  return res.data; // { reply: string }
};

/* AI Context — ambil system prompt berbasis halaman aktif */
export const getAiContext = async (params = {}) => {
  const res = await axios.get(`${API_URL}/api/ai-context`, {
    params,
    headers: authHeaders(),
  });
  return res.data; // { systemPrompt, page, bulan }
};

/* Chat History */
export const saveChatMessage = async ({ role, message, page }) => {
  await axios.post(`${API_URL}/api/ai-context/history`, { role, message, page }, {
    headers: authHeaders()
  });
};
export const getChatHistory = async ({ page, limit = 30 } = {}) => {
  const res = await axios.get(`${API_URL}/api/ai-context/history`, {
    params: { page, limit },
    headers: authHeaders(),
  });
  return res.data;
};
export const deleteChatHistory = async (page) => {
  await axios.delete(`${API_URL}/api/ai-context/history`, {
    params: { page },
    headers: authHeaders()
  });
};

/* Presence — ping setiap 30 detik, returns active user list */
export const pingPresence = async () => {
  const res = await axios.post(`${API_URL}/api/presence/ping`, {}, {
    headers: authHeaders()
  });
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
