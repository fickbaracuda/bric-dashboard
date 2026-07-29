'use strict';

/**
 * Balance Control Tower — util murni (tanpa DB), dipakai backend & test.
 * Semua perhitungan nominal pakai integer cents (BigInt) — BUKAN floating
 * point — supaya presisi Rupiah tidak pernah meleset walau angkanya besar.
 * Kolom DB tetap NUMERIC(18,2); util ini hanya lapisan kalkulasi di JS.
 */

/** String/number desimal -> BigInt cents. Aman utk input dari pg (string) maupun form (number/string). */
function toCents(value) {
  if (value === null || value === undefined || value === '') return 0n;
  const str = String(value).trim();
  const neg = str.startsWith('-');
  const unsigned = neg ? str.slice(1) : str;
  const parts = unsigned.split('.');
  if (parts.length > 2) throw new Error(`Nilai nominal tidak valid: "${value}"`);
  const [intPart, fracPartRaw = ''] = parts;
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPartRaw)) {
    throw new Error(`Nilai nominal tidak valid: "${value}"`);
  }
  const fracPart = (fracPartRaw + '00').slice(0, 2);
  const cents = BigInt(intPart || '0') * 100n + BigInt(fracPart || '0');
  return neg ? -cents : cents;
}

/** BigInt cents -> string desimal 2 digit, format simpan-ready ("1234.56"). */
function centsToString(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const intPart = abs / 100n;
  const fracPart = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${intPart.toString()}.${fracPart}`;
}

/**
 * effective_balance = available - held - pending - reserve
 * Menerima object dengan 4 komponen (string/number, boleh null -> 0).
 * Return string desimal siap disimpan/dipakai di query.
 */
function computeEffectiveBalance({ available_balance, held_balance, pending_amount, reserve_balance }) {
  const cents = toCents(available_balance)
    - toCents(held_balance)
    - toCents(pending_amount)
    - toCents(reserve_balance);
  return centsToString(cents);
}

const STATUS = {
  SAFE: 'SAFE',
  WATCH: 'WATCH',
  TOP_UP_RECOMMENDED: 'TOP_UP_RECOMMENDED',
  CRITICAL: 'CRITICAL',
  EMERGENCY: 'EMERGENCY',
  SUDDEN_DROP: 'SUDDEN_DROP',
  EXCESS_BALANCE: 'EXCESS_BALANCE',
  DATA_STALE: 'DATA_STALE',
  SYNC_ERROR: 'SYNC_ERROR',
  CONFIGURATION_REQUIRED: 'CONFIGURATION_REQUIRED',
};

/**
 * Sudden-drop — pure, butuh snapshot SEBELUMNYA (bukan cuma current).
 * Aktif hanya kalau SEMUA syarat terpenuhi:
 *   - policy.sudden_drop_window_minutes terisi DAN previous snapshot berada
 *     dalam window itu (selisih captured_at <= window)
 *   - previous effective_balance > 0 (hindari basis pembagi 0/negatif)
 *   - drop_amount > 0 (BUKAN kenaikan saldo)
 *   - drop_amount melewati sudden_drop_amount_threshold ATAU drop_percentage
 *     melewati sudden_drop_percentage_threshold (minimal salah satu policy
 *     threshold ini terisi — kalau dua-duanya kosong, sudden-drop tidak
 *     pernah aktif, tidak ada angka yang dikarang)
 * Return { triggered, dropAmount, dropPercentage } — dropPercentage null
 * kalau previous <= 0 (tidak pernah dibagi nol).
 */
function evaluateSuddenDrop({ snapshot, previousSnapshot, policy, now = new Date() }) {
  const notTriggered = { triggered: false, dropAmount: null, dropPercentage: null };
  if (!snapshot || !previousSnapshot || !policy) return notTriggered;

  const windowMinutes = policy.sudden_drop_window_minutes !== null && policy.sudden_drop_window_minutes !== undefined
    ? Number(policy.sudden_drop_window_minutes) : null;
  const amountThreshold = policy.sudden_drop_amount_threshold !== null && policy.sudden_drop_amount_threshold !== undefined
    ? Number(policy.sudden_drop_amount_threshold) : null;
  const pctThreshold = policy.sudden_drop_percentage_threshold !== null && policy.sudden_drop_percentage_threshold !== undefined
    ? Number(policy.sudden_drop_percentage_threshold) : null;

  if (windowMinutes === null) return notTriggered;
  if (amountThreshold === null && pctThreshold === null) return notTriggered;

  const currentAt = new Date(snapshot.captured_at);
  const previousAt = new Date(previousSnapshot.captured_at);
  const gapMinutes = (currentAt.getTime() - previousAt.getTime()) / 60000;
  if (gapMinutes < 0 || gapMinutes > windowMinutes) return notTriggered;

  const previousEff = Number(previousSnapshot.effective_balance);
  const currentEff = Number(snapshot.effective_balance);
  if (!(previousEff > 0)) return { triggered: false, dropAmount: null, dropPercentage: null };

  const dropAmount = previousEff - currentEff;
  if (!(dropAmount > 0)) return { triggered: false, dropAmount, dropPercentage: null }; // kenaikan/tetap, bukan drop

  const dropPercentage = (dropAmount / previousEff) * 100; // previousEff > 0 sudah dijamin di atas -> tidak pernah dibagi 0

  const byAmount = amountThreshold !== null && dropAmount > amountThreshold;
  const byPercentage = pctThreshold !== null && dropPercentage > pctThreshold;

  return { triggered: byAmount || byPercentage, dropAmount, dropPercentage };
}

/**
 * Klasifikasi status bank — cascade, urutan penting (yang pertama match
 * menang). SEMUA threshold datang dari policy per-bank (tidak ada angka
 * produksi yang dikarang di sini):
 *   1. Tidak ada snapshot sama sekali          -> CONFIGURATION_REQUIRED
 *   2. sync_status snapshot terakhir = ERROR   -> SYNC_ERROR
 *   3. Policy belum ada / belum aktif          -> CONFIGURATION_REQUIRED
 *   4. Snapshot lebih tua dari stale_after_minutes -> DATA_STALE
 *   5. Sudden-drop terdeteksi (lihat evaluateSuddenDrop) -> SUDDEN_DROP
 *   6. effective_balance <= emergency_threshold -> EMERGENCY
 *   7. effective_balance <= critical_threshold ATAU <= absolute_minimum_balance
 *      (backward-compat: absolute_minimum_balance tetap dipakai kalau
 *      critical_threshold belum diisi)          -> CRITICAL
 *   8. effective_balance <= watch_threshold     -> TOP_UP_RECOMMENDED
 *   9. effective_balance <= watch_threshold * (1 + safety_buffer_percentage/100)
 *                                                -> WATCH (zona buffer, mendekati watch_threshold)
 *  10. excess_balance_threshold terisi & effective_balance >= itu -> EXCESS_BALANCE
 *  11. selain itu                               -> SAFE
 */
function classifyBankStatus({ snapshot, policy, previousSnapshot = null, now = new Date() }) {
  if (!snapshot) return STATUS.CONFIGURATION_REQUIRED;
  if (snapshot.sync_status === 'ERROR') return STATUS.SYNC_ERROR;
  if (!policy || policy.is_active === false) return STATUS.CONFIGURATION_REQUIRED;

  if (policy.stale_after_minutes !== null && policy.stale_after_minutes !== undefined) {
    const capturedAt = new Date(snapshot.captured_at);
    const ageMinutes = (now.getTime() - capturedAt.getTime()) / 60000;
    if (ageMinutes > Number(policy.stale_after_minutes)) return STATUS.DATA_STALE;
  }

  const suddenDrop = evaluateSuddenDrop({ snapshot, previousSnapshot, policy, now });
  if (suddenDrop.triggered) return STATUS.SUDDEN_DROP;

  const eff = Number(snapshot.effective_balance);
  const absMin = policy.absolute_minimum_balance !== null && policy.absolute_minimum_balance !== undefined
    ? Number(policy.absolute_minimum_balance) : null;
  const critical = policy.critical_threshold !== null && policy.critical_threshold !== undefined
    ? Number(policy.critical_threshold) : null;
  const emergency = policy.emergency_threshold !== null && policy.emergency_threshold !== undefined
    ? Number(policy.emergency_threshold) : null;
  const watch = policy.watch_threshold !== null && policy.watch_threshold !== undefined
    ? Number(policy.watch_threshold) : null;
  const excess = policy.excess_balance_threshold !== null && policy.excess_balance_threshold !== undefined
    ? Number(policy.excess_balance_threshold) : null;
  const bufferPct = policy.safety_buffer_percentage !== null && policy.safety_buffer_percentage !== undefined
    ? Number(policy.safety_buffer_percentage) : 0;

  if (emergency !== null && eff <= emergency) return STATUS.EMERGENCY;
  if (critical !== null && eff <= critical) return STATUS.CRITICAL;
  if (absMin !== null && eff <= absMin) return STATUS.CRITICAL;

  if (watch !== null) {
    if (eff <= watch) return STATUS.TOP_UP_RECOMMENDED;
    const watchBufferUpper = watch * (1 + bufferPct / 100);
    if (eff <= watchBufferUpper) return STATUS.WATCH;
  }

  if (excess !== null && eff >= excess) return STATUS.EXCESS_BALANCE;

  return STATUS.SAFE;
}

/**
 * Alert type yang relevan utk status tsb, atau null kalau tidak perlu alert.
 * EMERGENCY & SUDDEN_DROP dipetakan ke CRITICAL_BALANCE (bukan bikin enum
 * alert_type baru) -- bct_alerts.alert_type CHECK constraint TIDAK diubah
 * di iterasi ini; kolom `message` sudah menyertakan nama status asli
 * (lihat syncAlertsForBank di route) utk membedakan penyebabnya.
 */
const STATUS_TO_ALERT_TYPE = {
  [STATUS.WATCH]: 'LOW_BALANCE',
  [STATUS.TOP_UP_RECOMMENDED]: 'LOW_BALANCE',
  [STATUS.CRITICAL]: 'CRITICAL_BALANCE',
  [STATUS.EMERGENCY]: 'CRITICAL_BALANCE',
  [STATUS.SUDDEN_DROP]: 'CRITICAL_BALANCE',
  [STATUS.EXCESS_BALANCE]: 'EXCESS_BALANCE',
  [STATUS.DATA_STALE]: 'DATA_STALE',
  [STATUS.SYNC_ERROR]: 'SYNC_ERROR',
};
function alertTypeForStatus(status) {
  return STATUS_TO_ALERT_TYPE[status] || null;
}

/**
 * Reserve balance — resolusi sumber TANPA double-subtract:
 *   - Kalau request/sync memberi reserve_balance eksplisit (termasuk 0) ->
 *     pakai nilai itu, source SNAPSHOT.
 *   - Kalau tidak diberikan (undefined/null/'') -> pakai bct_balance_policies
 *     .reserve_balance sbg fallback, source POLICY_DEFAULT (default 0 kalau
 *     policy juga belum punya nilai -- BUKAN mengarang, cuma "belum ada
 *     reserve yang perlu dikurangi").
 *   Hanya SATU nilai reserve yang pernah dipakai -> tidak pernah dobel kurang.
 */
function resolveReserveBalance({ providedReserveBalance, policyReserveBalance }) {
  if (providedReserveBalance !== null && providedReserveBalance !== undefined && providedReserveBalance !== '') {
    return { value: providedReserveBalance, source: 'SNAPSHOT' };
  }
  const fallback = policyReserveBalance !== null && policyReserveBalance !== undefined ? policyReserveBalance : 0;
  return { value: fallback, source: 'POLICY_DEFAULT' };
}

/** Status transition map — top up workflow. */
const TOPUP_TRANSITIONS = {
  DRAFT: ['REQUESTED', 'CANCELLED'],
  REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['TRANSFERRED', 'CANCELLED'],
  TRANSFERRED: ['BALANCE_CONFIRMED'],
  BALANCE_CONFIRMED: ['COMPLETED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};

function canTransitionTopup(fromStatus, toStatus) {
  return Array.isArray(TOPUP_TRANSITIONS[fromStatus]) && TOPUP_TRANSITIONS[fromStatus].includes(toStatus);
}

/** Maker-checker: requester tidak boleh approve permintaannya sendiri. */
function isSelfApproval(requesterUserId, approverUserId) {
  if (requesterUserId === null || requesterUserId === undefined) return false;
  if (approverUserId === null || approverUserId === undefined) return false;
  return String(requesterUserId) === String(approverUserId);
}

module.exports = {
  toCents,
  centsToString,
  computeEffectiveBalance,
  classifyBankStatus,
  evaluateSuddenDrop,
  resolveReserveBalance,
  alertTypeForStatus,
  STATUS,
  TOPUP_TRANSITIONS,
  canTransitionTopup,
  isSelfApproval,
};
