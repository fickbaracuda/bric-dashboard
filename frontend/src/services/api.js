import axios from 'axios';
import { getToken, logout } from '../utils/auth';

const API_URL = import.meta.env.VITE_API_URL || '';

// 5-minute in-memory cache — skips re-fetch when navigating between war-room pages
const _cache = new Map();
const WARROOM_TTL = 5 * 60 * 1000;
function withCache(key, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < WARROOM_TTL) return Promise.resolve(hit.data);
  return fn().then(data => { _cache.set(key, { data, ts: Date.now() }); return data; });
}

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

/* WAR-ROOM — Segmen InstaQris */
export const getSegmenData = (params = {}) =>
  withCache(`segmen-${JSON.stringify(params)}`, () =>
    axios.get(`${API_URL}/api/warroom/segmen`, { params, headers: authHeaders() }).then(r => r.data));
export const getSegmenTrendline = async (days = 30) => {
  const res = await axios.get(`${API_URL}/api/warroom/segmen/trendline`, { params: { days }, headers: authHeaders() });
  return res.data;
};
export const getSegmenHistory = async (mcc, days = 30) => {
  const res = await axios.get(`${API_URL}/api/warroom/segmen/history`, { params: { mcc, days }, headers: authHeaders() });
  return res.data;
};
export const getSegmenTanggalList = async () => {
  const res = await axios.get(`${API_URL}/api/warroom/segmen/tanggal-list`, { headers: authHeaders() });
  return res.data;
};

/* WAR-ROOM — Data RAW Analitik */
export const getDataRawAnalytics = (params = {}) =>
  axios.get(`${API_URL}/api/data-raw/analytics`, { params, headers: authHeaders() }).then(r => r.data);
export const getDataRawTrendline = async (days = 30, bulan) => {
  const p = { days }; if (bulan) p.bulan = bulan;
  const res = await axios.get(`${API_URL}/api/data-raw/trendline`, { params: p, headers: authHeaders() });
  return res.data;
};
export const getDataRawQrisAnalytics = (params = {}) =>
  axios.get(`${API_URL}/api/data-raw/qris-analytics`, { params, headers: authHeaders() }).then(r => r.data);
export const getAffiliateAnalytics = (bulan) =>
  axios.get(`${API_URL}/api/data-raw/affiliate-analytics`, { params: bulan ? { bulan } : {}, headers: authHeaders() }).then(r => r.data);
export const getAffiliateDownlines = (upline, bulan) =>
  axios.get(`${API_URL}/api/data-raw/affiliate-analytics/downlines`, { params: { upline, bulan }, headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — Speedcash */
export const getSpeedcashData = async (params = {}) => {
  const res = await axios.get(`${API_URL}/api/warroom/speedcash`, { params, headers: authHeaders() });
  return res.data;
};
export const getSpeedcashHistory = async (id_outlet, days = 30) => {
  const res = await axios.get(`${API_URL}/api/warroom/speedcash/history`, { params: { id_outlet, days }, headers: authHeaders() });
  return res.data;
};
export const getSpeedcashTanggalList = async () => {
  const res = await axios.get(`${API_URL}/api/warroom/speedcash/tanggal-list`, { headers: authHeaders() });
  return res.data;
};
export const getSpeedcashAnalytics = (params = {}) =>
  withCache(`speedcash-analytics-${JSON.stringify(params)}`, () =>
    axios.get(`${API_URL}/api/warroom/speedcash/analytics`, { params, headers: authHeaders() }).then(r => r.data));

/* WAR-ROOM — Ekspedisi */
export const getEkspedisiAnalytics = (params = {}) =>
  withCache(`ekspedisi-analytics-${JSON.stringify(params)}`, () =>
    axios.get(`${API_URL}/api/warroom/ekspedisi/analytics`, { params, headers: authHeaders() }).then(r => r.data));

/* WAR-ROOM — Fastpay Global */
export const getFastpayAnalytics = (params = {}) =>
  withCache(`fastpay-analytics-${JSON.stringify(params)}`, () =>
    axios.get(`${API_URL}/api/warroom/fastpay/analytics`, { params, headers: authHeaders() }).then(r => r.data));
export const getFastpayOutlets = (params = {}) =>
  withCache(`fastpay-outlets-${JSON.stringify(params)}`, () =>
    axios.get(`${API_URL}/api/warroom/fastpay/outlets`, { params, headers: authHeaders() }).then(r => r.data));

/* WAR-ROOM — Farming */
export const getFarmingAnalytics = (params = {}) =>
  withCache(`farming-analytics-${JSON.stringify(params)}`, () =>
    axios.get(`${API_URL}/api/warroom/farming/analytics`, { params, headers: authHeaders() }).then(r => r.data));
export const getFarmingOutlets = (params = {}) =>
  withCache(`farming-outlets-${JSON.stringify(params)}`, () =>
    axios.get(`${API_URL}/api/warroom/farming/outlets`, { params, headers: authHeaders() }).then(r => r.data));

/* WAR-ROOM — PA Produk */
export const getPAProdukAnalytics = (params = {}) =>
  withCache(`pa-produk-analytics-${JSON.stringify(params)}`, () =>
    axios.get(`${API_URL}/api/warroom/pa-produk/analytics`, { params, headers: authHeaders() }).then(r => r.data));
export const getPAProdukTrendline = async (days = 30) => {
  const res = await axios.get(`${API_URL}/api/warroom/pa-produk/trendline`, { params: { days }, headers: authHeaders() });
  return res.data;
};
export const getPAArpuAnalytics = () =>
  withCache('pa-arpu-analytics', () =>
    axios.get(`${API_URL}/api/warroom/pa-arpu/analytics`, { headers: authHeaders() }).then(r => r.data));

/* WAR-ROOM — MGM PA */
export const getMgmAnalytics = (bulan) =>
  withCache(`mgm-analytics-${bulan || 'latest'}`, () => {
    const params = bulan ? { bulan } : {};
    return axios.get(`${API_URL}/api/warroom/mgm/analytics`, { params, headers: authHeaders() }).then(r => r.data);
  });
export const searchMgmOutlet = async (q, bulan) => {
  const params = { q, ...(bulan ? { bulan } : {}) };
  const res = await axios.get(`${API_URL}/api/warroom/mgm/search`, { params, headers: authHeaders() });
  return res.data;
};

/* WAR-ROOM — DM Fastpay */
export const getDmFastpayAnalytics = (tanggal) =>
  withCache(`dm-fastpay-analytics-${tanggal || 'latest'}`, () => {
    const params = tanggal ? { tanggal } : {};
    return axios.get(`${API_URL}/api/warroom/dm-fastpay/analytics`, { params, headers: authHeaders() }).then(r => r.data);
  });

/* WAR-ROOM — InstaQris TRX */
export const getInstaqrisTrxAnalytics = (params = {}) =>
  withCache(`iqtrx-analytics-${JSON.stringify(params)}`, () =>
    axios.get(`${API_URL}/api/warroom/instaqris-trx/analytics`, { params, headers: authHeaders() }).then(r => r.data));
export const getInstaqrisTrxExport = async (params = {}) => {
  const res = await axios.get(`${API_URL}/api/warroom/instaqris-trx/export`, { params, headers: authHeaders() });
  return res.data;
};
export const getInstaqrisTrxMerchants = async (params = {}) => {
  const res = await axios.get(`${API_URL}/api/warroom/instaqris-trx/merchants`, { params, headers: authHeaders() });
  return res.data;
};

/* WAR-ROOM — Territory ASDP */
export const getAsdpAnalytics = () =>
  withCache('asdp-analytics', () =>
    axios.get(`${API_URL}/api/warroom/asdp/analytics`, { headers: authHeaders() }).then(r => r.data));
export const getAsdpOutlets = () =>
  withCache('asdp-outlets', () =>
    axios.get(`${API_URL}/api/warroom/asdp/outlets`, { headers: authHeaders() }).then(r => r.data));

/* WAR-ROOM — PA ASDP (multi-bulan) */
export const getPaAsdpAnalytics = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/pa-asdp/analytics`, { params, headers: authHeaders() }).then(r => r.data);
export const getPaAsdpOutlets = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/pa-asdp/outlets`, { params, headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — PA LPD (multi-bulan) */
export const getPaLpdAnalytics = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/pa-lpd/analytics`, { params, headers: authHeaders() }).then(r => r.data);
export const getPaLpdOutlets = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/pa-lpd/outlets`, { params, headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — BUMDes (multi-bulan) */
export const getBumdesAnalytics = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/bumdes/analytics`, { params, headers: authHeaders() }).then(r => r.data);
export const getBumdesOutlets = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/bumdes/outlets`, { params, headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — Territory LPD */
export const getLpdAnalytics = () =>
  withCache('lpd-analytics', () =>
    axios.get(`${API_URL}/api/warroom/lpd/analytics`, { headers: authHeaders() }).then(r => r.data));
export const getLpdOutlets = () =>
  withCache('lpd-outlets', () =>
    axios.get(`${API_URL}/api/warroom/lpd/outlets`, { headers: authHeaders() }).then(r => r.data));

/* System Monitor */
export const getSystemStats = async () => {
  const res = await axios.get(`${API_URL}/api/system/stats`, { headers: authHeaders() });
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
