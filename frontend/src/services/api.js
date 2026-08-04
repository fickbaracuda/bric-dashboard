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
export const getUserUnits = async () => {
  const res = await axios.get(`${API_URL}/api/users/units`, { headers: authHeaders() });
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

/* WAR-ROOM — Ekspedisi Execution Queue actions (contacted/PIC/follow-up/notes) —
   TIDAK pakai withCache, ini state yang di-mutate user jadi harus selalu segar. */
export const getEkspedisiOutletStatus = () =>
  axios.get(`${API_URL}/api/warroom/ekspedisi/outlet-status`, { headers: authHeaders() }).then(r => r.data);
export const updateEkspedisiOutletStatus = (data) =>
  axios.post(`${API_URL}/api/warroom/ekspedisi/outlet-status`, data, { headers: authHeaders() }).then(r => r.data);
export const getEkspedisiNotes = (idOutlet) =>
  axios.get(`${API_URL}/api/warroom/ekspedisi/notes`, { params: { idOutlet }, headers: authHeaders() }).then(r => r.data);
export const addEkspedisiNote = (data) =>
  axios.post(`${API_URL}/api/warroom/ekspedisi/notes`, data, { headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — Produk Ekspedisi (domain terpisah dari Ekspedisi di atas) */
export const getEkspedisiProdukMonths = () =>
  axios.get(`${API_URL}/api/warroom/ekspedisi-produk/months`, { headers: authHeaders() }).then(r => r.data);
export const getEkspedisiProdukAnalytics = (bulan) =>
  withCache(`ekspedisi-produk-analytics-${bulan || ''}`, () =>
    axios.get(`${API_URL}/api/warroom/ekspedisi-produk/analytics`, { params: bulan ? { bulan } : {}, headers: authHeaders() }).then(r => r.data));
export const getEkspedisiProdukOutlets = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/ekspedisi-produk/outlets`, { params, headers: authHeaders() }).then(r => r.data);
export const getEkspedisiProdukProductDetail = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/ekspedisi-produk/product-detail`, { params, headers: authHeaders() }).then(r => r.data);
export const getEkspedisiProdukOutletDetail = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/ekspedisi-produk/outlet-detail`, { params, headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM Payment Agent — Produk (Marketing Decision Dashboard, domain terpisah dari PA Produk legacy) */
export const getPaymentAgentProdukSnapshots = () =>
  axios.get(`${API_URL}/api/warroom/payment-agent/produk/snapshots`, { headers: authHeaders() }).then(r => r.data);
export const getPaymentAgentProdukAnalytics = (snapshotDate) =>
  withCache(`payment-agent-produk-analytics-${snapshotDate || 'latest'}`, () =>
    axios.get(`${API_URL}/api/warroom/payment-agent/produk/analytics`, { params: { snapshot_date: snapshotDate || 'latest' }, headers: authHeaders() }).then(r => r.data));
export const getPaymentAgentProdukDetail = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/payment-agent/produk/detail`, { params, headers: authHeaders() }).then(r => r.data);
export const getPaymentAgentProdukTable = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/payment-agent/produk/table`, { params, headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — Fastpay Global */
export const getFastpayAnalytics = (params = {}) =>
  withCache(`fastpay-analytics-${JSON.stringify(params)}`, () =>
    axios.get(`${API_URL}/api/warroom/fastpay/analytics`, { params, headers: authHeaders() }).then(r => r.data));
export const getFastpayOutlets = (params = {}) =>
  withCache(`fastpay-outlets-${JSON.stringify(params)}`, () =>
    axios.get(`${API_URL}/api/warroom/fastpay/outlets`, { params, headers: authHeaders() }).then(r => r.data));

/* WAR-ROOM — Farming Fastpay Command Center (data-raw multi-bulan, TIDAK di-cache) */
export const getFarmingSnapshots = () =>
  axios.get(`${API_URL}/api/warroom/farming/snapshots`, { headers: authHeaders() }).then(r => r.data);
export const getFarmingAnalytics = (snapshotDate) =>
  axios.get(`${API_URL}/api/warroom/farming/analytics`, { params: { snapshot_date: snapshotDate || 'latest' }, headers: authHeaders() }).then(r => r.data);
export const getFarmingActionQueue = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/farming/action-queue`, { params, headers: authHeaders() }).then(r => r.data);
export const getFarmingOutlets = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/farming/outlets`, { params, headers: authHeaders() }).then(r => r.data);
export const getFarmingOutletDetail = (idOutlet) =>
  axios.get(`${API_URL}/api/warroom/farming/outlets/${encodeURIComponent(idOutlet)}`, { headers: authHeaders() }).then(r => r.data);
export const getFarmingTrendline = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/farming/trendline`, { params, headers: authHeaders() }).then(r => r.data);
export const getFarmingDataQuality = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/farming/data-quality`, { params, headers: authHeaders() }).then(r => r.data);
export const getFarmingFollowup = (idOutlet) =>
  axios.get(`${API_URL}/api/warroom/farming/followup`, { params: { id_outlet: idOutlet }, headers: authHeaders() }).then(r => r.data);
export const upsertFarmingFollowup = (data) =>
  axios.post(`${API_URL}/api/warroom/farming/followup`, data, { headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — PA Produk */
export const getPAProdukAnalytics = (params = {}) =>
  withCache(`pa-produk-analytics-${JSON.stringify(params)}`, () =>
    axios.get(`${API_URL}/api/warroom/pa-produk/analytics`, { params, headers: authHeaders() }).then(r => r.data));
export const getPAProdukTrendline = async (days = 30, bulan = undefined) => {
  const res = await axios.get(`${API_URL}/api/warroom/pa-produk/trendline`, { params: { days, bulan }, headers: authHeaders() });
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

/* WAR-ROOM — DM Control Tower (multi-bulan, TIDAK di-cache — selalu fresh, sama pola dengan PA LPD/BUMDes/PA ASDP) */
export const getDmControlTowerMonths = () =>
  axios.get(`${API_URL}/api/warroom/dm-control-tower/months`, { headers: authHeaders() }).then(r => r.data);
export const getDmControlTowerAnalytics = (bulan) =>
  axios.get(`${API_URL}/api/warroom/dm-control-tower/analytics`, { params: { bulan }, headers: authHeaders() }).then(r => r.data);
export const getDmControlTowerDataQuality = (bulan) =>
  axios.get(`${API_URL}/api/warroom/dm-control-tower/data-quality`, { params: { bulan }, headers: authHeaders() }).then(r => r.data);
export const getDmControlTowerOutlets = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/dm-control-tower/outlets`, { params, headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — InstaQRIS Command Center (multi-bulan, TIDAK di-cache — selalu fresh, sama pola dengan DM Control Tower) */
export const getInstaqrisCommandCenterMonths = () =>
  axios.get(`${API_URL}/api/warroom/instaqris-command-center/months`, { headers: authHeaders() }).then(r => r.data);
export const getInstaqrisCommandCenterAnalytics = (bulan) =>
  axios.get(`${API_URL}/api/warroom/instaqris-command-center/analytics`, { params: bulan ? { bulan } : {}, headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — Quick Win Q3 IQWM (multi-periode, TIDAK di-cache — selalu fresh) */
export const getQuickWinQ3Periods = () =>
  axios.get(`${API_URL}/api/warroom/quick-win-q3/periods`, { headers: authHeaders() }).then(r => r.data);
export const getQuickWinQ3Analytics = (periode) =>
  axios.get(`${API_URL}/api/warroom/quick-win-q3/analytics`, { params: periode ? { periode } : {}, headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — Rekonsiliasi FP vs Bank OCBC (TIDAK di-cache — data operasional, harus selalu fresh) */
export const getReconciliationAnalytics = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/analytics`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationDailyReport = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/daily-report`, { params, headers: authHeaders() }).then(r => r.data);
// Tab "Kebutuhan Saldo" — kebutuhan saldo per periode (bukan 1 hari). TIDAK
// di-cache. `signal` (AbortController, opsional) WAJIB dipisah dari `params`
// sebelum diteruskan ke axios -- kalau ikut masuk `params` akan salah
// diserialisasi jadi query string literal ("?signal=[object AbortSignal]").
export const getOcbcPeriodicBalanceNeeds = ({ signal, ...params } = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/ocbc/balance-needs-periodic`, { params, headers: authHeaders(), signal }).then(r => r.data);
// Generic — dipakai shared component PeriodicBalanceNeeds.jsx utk bank
// SELAIN OCBC (Mandiri/BRI/BRI BI-FAST/BNI berbagi 1 fungsi ini via prop
// `basePath`, wrapper per-bank di bawah HANYA mengunci basePath). Sengaja
// TIDAK dipakai utk OCBC (getOcbcPeriodicBalanceNeeds tetap dipertahankan
// apa adanya demi backward-compat, walau endpoint backend-nya sama pola).
export const getPeriodicBalanceNeeds = (basePath, { signal, ...params } = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/${basePath}/balance-needs-periodic`, { params, headers: authHeaders(), signal }).then(r => r.data);
export const getMandiriPeriodicBalanceNeeds = (params = {}) => getPeriodicBalanceNeeds('mandiri', params);
export const getBriPeriodicBalanceNeeds = (params = {}) => getPeriodicBalanceNeeds('bri', params);
export const getBriBifastPeriodicBalanceNeeds = (params = {}) => getPeriodicBalanceNeeds('bri-bifast', params);
export const getBniPeriodicBalanceNeeds = (params = {}) => getPeriodicBalanceNeeds('bni', params);
export const getBcaPeriodicBalanceNeeds = (params = {}) => getPeriodicBalanceNeeds('bca', params);
export const getReconciliationTransactions = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/transactions`, { params, headers: authHeaders() }).then(r => r.data);
// Export butuh Authorization header (JWT) -> tidak bisa lewat <a href> biasa,
// fetch sebagai blob lalu trigger download manual di komponen pemanggil.
export const exportReconciliationCsv = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/export`, { params, headers: authHeaders(), responseType: 'blob' }).then(r => r.data);
export const resolveReconciliation = (id, data) =>
  axios.post(`${API_URL}/api/warroom/reconciliation/${id}/resolve`, data, { headers: authHeaders() }).then(r => r.data);
export const getReconciliationLogs = (id) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/${id}/logs`, { headers: authHeaders() }).then(r => r.data);
// Tombol "Sync Now" — generik utk OCBC & Mandiri (bank_code di body). TIDAK
// memicu sync instan (Apps Script Web App tak bisa dipanggil langsung dari
// browser, kebijakan Google Workspace) — hanya mencatat permintaan, checker
// Apps Script (jalan tiap 1 menit) yang sync dalam ~1-2 menit berikutnya.
export const requestReconciliationSync = (bankCode) =>
  axios.post(`${API_URL}/api/warroom/reconciliation/request-sync`, { bank_code: bankCode }, { headers: authHeaders() }).then(r => r.data);

/* Permintaan Tambahan Saldo (Tim Operation -> Finance/unit FA) — endpoint
   TIDAK di-cache, ditambah query timestamp supaya browser/proxy tidak
   pernah menyimpan response GET (data pending harus selalu real-time). */
export const createFinanceBalanceRequest = (payload) =>
  axios.post(`${API_URL}/api/finance/balance-requests`, payload, { headers: authHeaders() }).then(r => r.data);
export const getPendingFinanceBalanceRequests = () =>
  axios.get(`${API_URL}/api/finance/balance-requests/pending`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const acknowledgeFinanceBalanceRequest = (id) =>
  axios.post(`${API_URL}/api/finance/balance-requests/${id}/acknowledge`, {}, { headers: authHeaders() }).then(r => r.data);
export const getFinanceBalanceRequestStatus = (id) =>
  axios.get(`${API_URL}/api/finance/balance-requests/${id}`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const getFinanceBalanceRequestHistory = (params = {}) =>
  axios.get(`${API_URL}/api/finance/balance-requests/history`, { params: { ...params, t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const getAcknowledgedFinanceBalanceRequests = (bankCode) =>
  axios.get(`${API_URL}/api/finance/balance-requests/acknowledged`, { params: { bank_code: bankCode, t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const markFinanceBalanceRequestTransferred = (id) =>
  axios.post(`${API_URL}/api/finance/balance-requests/${id}/mark-transferred`, {}, { headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — Rekonsiliasi FP vs Bank Mandiri (TIDAK di-cache — data operasional, harus selalu fresh) */
export const getReconciliationMandiriAnalytics = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/mandiri/analytics`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationMandiriDailyReport = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/mandiri/daily-report`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationMandiriTransactions = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/mandiri/transactions`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationMandiriRawBank = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/mandiri/raw-bank`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationMandiriRawFp = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/mandiri/raw-fp`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationMandiriResolutionHistory = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/mandiri/resolution-history`, { params, headers: authHeaders() }).then(r => r.data);
export const exportReconciliationMandiriCsv = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/mandiri/export`, { params, headers: authHeaders(), responseType: 'blob' }).then(r => r.data);
export const resolveReconciliationMandiri = (id, data) =>
  axios.post(`${API_URL}/api/warroom/reconciliation/mandiri/${id}/resolve`, data, { headers: authHeaders() }).then(r => r.data);
export const getReconciliationMandiriLogs = (id) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/mandiri/${id}/logs`, { headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — Rekonsiliasi FP vs Bank BRI (TIDAK di-cache — data operasional, harus selalu fresh) */
export const getReconciliationBriAnalytics = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri/analytics`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBriDailyReport = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri/daily-report`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBriTransactions = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri/transactions`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBriRawBank = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri/raw-bank`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBriRawFp = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri/raw-fp`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBriResolutionHistory = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri/resolution-history`, { params, headers: authHeaders() }).then(r => r.data);
export const exportReconciliationBriCsv = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri/export`, { params, headers: authHeaders(), responseType: 'blob' }).then(r => r.data);
export const resolveReconciliationBri = (id, data) =>
  axios.post(`${API_URL}/api/warroom/reconciliation/bri/${id}/resolve`, data, { headers: authHeaders() }).then(r => r.data);
export const getReconciliationBriLogs = (id) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri/${id}/logs`, { headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — Rekonsiliasi FP vs BRI BI-FAST (TIDAK di-cache — data operasional, harus selalu fresh) */
export const getReconciliationBriBifastAnalytics = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri-bifast/analytics`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBriBifastDailyReport = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri-bifast/daily-report`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBriBifastTransactions = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri-bifast/transactions`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBriBifastRawBank = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri-bifast/raw-bank`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBriBifastRawFp = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri-bifast/raw-fp`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBriBifastResolutionHistory = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri-bifast/resolution-history`, { params, headers: authHeaders() }).then(r => r.data);
export const exportReconciliationBriBifast = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri-bifast/export`, { params, headers: authHeaders(), responseType: 'blob' }).then(r => r.data);
export const resolveReconciliationBriBifast = (id, data) =>
  axios.post(`${API_URL}/api/warroom/reconciliation/bri-bifast/${id}/resolve`, data, { headers: authHeaders() }).then(r => r.data);
export const getReconciliationBriBifastLogs = (id) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bri-bifast/${id}/logs`, { headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — Rekonsiliasi FP vs BNI (TIDAK di-cache — data operasional, harus selalu fresh) */
export const getReconciliationBniAnalytics = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bni/analytics`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBniDailyReport = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bni/daily-report`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBniTransactions = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bni/transactions`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBniRawBank = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bni/raw-bank`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBniRawFp = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bni/raw-fp`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBniResolutionHistory = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bni/resolution-history`, { params, headers: authHeaders() }).then(r => r.data);
export const exportReconciliationBni = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bni/export`, { params, headers: authHeaders(), responseType: 'blob' }).then(r => r.data);
export const resolveReconciliationBni = (id, data) =>
  axios.post(`${API_URL}/api/warroom/reconciliation/bni/${id}/resolve`, data, { headers: authHeaders() }).then(r => r.data);
export const getReconciliationBniLogs = (id) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bni/${id}/logs`, { headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — Rekonsiliasi FP vs BCA (TIDAK di-cache — data operasional, harus selalu fresh) */
export const getReconciliationBcaAnalytics = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bca/analytics`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBcaDailyReport = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bca/daily-report`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBcaTransactions = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bca/transactions`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBcaRawBank = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bca/raw-bank`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBcaRawFp = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bca/raw-fp`, { params, headers: authHeaders() }).then(r => r.data);
export const getReconciliationBcaResolutionHistory = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bca/resolution-history`, { params, headers: authHeaders() }).then(r => r.data);
export const exportReconciliationBca = (params = {}) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bca/export`, { params, headers: authHeaders(), responseType: 'blob' }).then(r => r.data);
export const resolveReconciliationBca = (id, data) =>
  axios.post(`${API_URL}/api/warroom/reconciliation/bca/${id}/resolve`, data, { headers: authHeaders() }).then(r => r.data);
export const getReconciliationBcaLogs = (id) =>
  axios.get(`${API_URL}/api/warroom/reconciliation/bca/${id}/logs`, { headers: authHeaders() }).then(r => r.data);

/* WAR-ROOM — QRIS Issuance Control Tower */
export const getQrisControlTowerAnalytics = () =>
  withCache('qris-control-tower-analytics', () =>
    axios.get(`${API_URL}/api/warroom/qris-ctrl/analytics`, { headers: authHeaders() }).then(r => r.data));

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

/* WAR-ROOM — Balance Control Tower (data operasional finansial, TIDAK di-cache) */
const BCT_BASE = `${API_URL}/api/warroom/balance-control-tower`;
export const getBctSummary = () =>
  axios.get(`${BCT_BASE}/summary`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const getBctBanks = (params = {}) =>
  axios.get(`${BCT_BASE}/banks`, { params: { ...params, t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const createBctBank = (payload) =>
  axios.post(`${BCT_BASE}/banks`, payload, { headers: authHeaders() }).then(r => r.data);
export const updateBctBank = (id, payload) =>
  axios.put(`${BCT_BASE}/banks/${id}`, payload, { headers: authHeaders() }).then(r => r.data);
export const getBctBankDetail = (id) =>
  axios.get(`${BCT_BASE}/banks/${id}`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const createBctSnapshot = (bankId, payload) =>
  axios.post(`${BCT_BASE}/banks/${bankId}/snapshots`, payload, { headers: authHeaders() }).then(r => r.data);
export const getBctSnapshots = (bankId, params = {}) =>
  axios.get(`${BCT_BASE}/banks/${bankId}/snapshots`, { params, headers: authHeaders() }).then(r => r.data);
export const getBctPolicy = (bankId) =>
  axios.get(`${BCT_BASE}/banks/${bankId}/policy`, { headers: authHeaders() }).then(r => r.data);
export const updateBctPolicy = (bankId, payload) =>
  axios.put(`${BCT_BASE}/banks/${bankId}/policy`, payload, { headers: authHeaders() }).then(r => r.data);

/* Forecast — OCBC Rekonsiliasi sbg source, Balance Control Tower sbg control room */
export const getBctForecast = (bankId) =>
  axios.get(`${BCT_BASE}/banks/${bankId}/forecast`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const refreshBctForecast = (bankId) =>
  axios.post(`${BCT_BASE}/banks/${bankId}/forecast/refresh`, {}, { headers: authHeaders() }).then(r => r.data);
export const getBctForecastHistory = (bankId, params = {}) =>
  axios.get(`${BCT_BASE}/banks/${bankId}/forecast/history`, { params: { ...params, t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const getBctCommandCenter = (bankId) =>
  axios.get(`${BCT_BASE}/banks/${bankId}/command-center`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);

/* Funding Scheduler Adjustment Assistant — advisory only, TIDAK transfer/cancel bank otomatis */
export const getBctFundingScheduler = (bankId) =>
  axios.get(`${BCT_BASE}/banks/${bankId}/funding-scheduler`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const acknowledgeBctFundingScheduler = (bankId, note) =>
  axios.post(`${BCT_BASE}/banks/${bankId}/funding-scheduler/acknowledge`, { note }, { headers: authHeaders() }).then(r => r.data);
export const getBctFundingSchedulerHistory = (bankId, params = {}) =>
  axios.get(`${BCT_BASE}/banks/${bankId}/funding-scheduler/history`, { params: { ...params, t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const getBctHourlyPlan = (bankId) =>
  axios.get(`${BCT_BASE}/banks/${bankId}/funding-scheduler/hourly-plan`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const updateBctHourlyPlan = (bankId, hour, payload) =>
  axios.put(`${BCT_BASE}/banks/${bankId}/funding-scheduler/hourly-plan/${hour}`, payload, { headers: authHeaders() }).then(r => r.data);
export const getBctSchedulerPlan = (bankId) =>
  axios.get(`${BCT_BASE}/banks/${bankId}/funding-scheduler/scheduler-plan`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const createBctSchedulerPlan = (bankId, payload) =>
  axios.post(`${BCT_BASE}/banks/${bankId}/funding-scheduler/scheduler-plan`, payload, { headers: authHeaders() }).then(r => r.data);
export const updateBctSchedulerPlan = (bankId, schedulerId, payload) =>
  axios.put(`${BCT_BASE}/banks/${bankId}/funding-scheduler/scheduler-plan/${schedulerId}`, payload, { headers: authHeaders() }).then(r => r.data);

export const createBctTopup = (payload) =>
  axios.post(`${BCT_BASE}/topup`, payload, { headers: authHeaders() }).then(r => r.data);
export const getBctTopups = (params = {}) =>
  axios.get(`${BCT_BASE}/topup`, { params: { ...params, t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const getBctTopupDetail = (id) =>
  axios.get(`${BCT_BASE}/topup/${id}`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const requestBctTopup = (id) =>
  axios.post(`${BCT_BASE}/topup/${id}/request`, {}, { headers: authHeaders() }).then(r => r.data);
export const approveBctTopup = (id, payload = {}) =>
  axios.post(`${BCT_BASE}/topup/${id}/approve`, payload, { headers: authHeaders() }).then(r => r.data);
export const rejectBctTopup = (id, reason) =>
  axios.post(`${BCT_BASE}/topup/${id}/reject`, { reason }, { headers: authHeaders() }).then(r => r.data);
export const transferBctTopup = (id, payload) =>
  axios.post(`${BCT_BASE}/topup/${id}/transfer`, payload, { headers: authHeaders() }).then(r => r.data);
export const confirmBctTopupBalance = (id, balanceAfter) =>
  axios.post(`${BCT_BASE}/topup/${id}/confirm-balance`, { balance_after: balanceAfter }, { headers: authHeaders() }).then(r => r.data);
export const completeBctTopup = (id, notes) =>
  axios.post(`${BCT_BASE}/topup/${id}/complete`, { notes }, { headers: authHeaders() }).then(r => r.data);
export const cancelBctTopup = (id) =>
  axios.post(`${BCT_BASE}/topup/${id}/cancel`, {}, { headers: authHeaders() }).then(r => r.data);

export const getBctAlerts = (params = {}) =>
  axios.get(`${BCT_BASE}/alerts`, { params: { ...params, t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const acknowledgeBctAlert = (id) =>
  axios.post(`${BCT_BASE}/alerts/${id}/acknowledge`, {}, { headers: authHeaders() }).then(r => r.data);
export const snoozeBctAlert = (id, snoozedUntil) =>
  axios.post(`${BCT_BASE}/alerts/${id}/snooze`, { snoozed_until: snoozedUntil }, { headers: authHeaders() }).then(r => r.data);
export const resolveBctAlert = (id, reason) =>
  axios.post(`${BCT_BASE}/alerts/${id}/resolve`, { reason }, { headers: authHeaders() }).then(r => r.data);

/* Balance & Funding — STANDALONE dari Balance Control Tower lama (router/tabel terpisah) */
const BF_BASE = `${API_URL}/api/balance-funding`;
export const getBfOverview = () =>
  axios.get(`${BF_BASE}/overview`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const getBfBank = (bankCode) =>
  axios.get(`${BF_BASE}/banks/${bankCode}`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const getBfPlan = (bankCode) =>
  axios.get(`${BF_BASE}/banks/${bankCode}/plan`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const updateBfPlan = (bankCode, payload) =>
  axios.put(`${BF_BASE}/banks/${bankCode}/plan`, payload, { headers: authHeaders() }).then(r => r.data);
export const updateBfHourlyPlan = (bankCode, hour, payload) =>
  axios.put(`${BF_BASE}/banks/${bankCode}/plan/hourly/${hour}`, payload, { headers: authHeaders() }).then(r => r.data);
export const getBfSchedules = (bankCode) =>
  axios.get(`${BF_BASE}/banks/${bankCode}/schedules`, { params: { t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const createBfSchedule = (bankCode, payload) =>
  axios.post(`${BF_BASE}/banks/${bankCode}/schedules`, payload, { headers: authHeaders() }).then(r => r.data);
export const updateBfSchedule = (bankCode, id, payload) =>
  axios.put(`${BF_BASE}/banks/${bankCode}/schedules/${id}`, payload, { headers: authHeaders() }).then(r => r.data);
export const getBfRecommendations = (bankCode, params = {}) =>
  axios.get(`${BF_BASE}/banks/${bankCode}/recommendations`, { params: { ...params, t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const acknowledgeBfRecommendation = (id, note) =>
  axios.post(`${BF_BASE}/recommendations/${id}/acknowledge`, { note }, { headers: authHeaders() }).then(r => r.data);
export const getBfAlerts = (params = {}) =>
  axios.get(`${BF_BASE}/alerts`, { params: { ...params, t: Date.now() }, headers: authHeaders() }).then(r => r.data);
export const acknowledgeBfAlert = (id) =>
  axios.post(`${BF_BASE}/alerts/${id}/acknowledge`, {}, { headers: authHeaders() }).then(r => r.data);

export const getPaymentAgentData = async (bulan) => {
  const res = await axios.get(`${API_URL}/api/paymentagent`, {
    params: { bulan },
    headers: authHeaders()
  });
  return res.data;
};
