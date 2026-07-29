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
  EXCESS_BALANCE: 'EXCESS_BALANCE',
  DATA_STALE: 'DATA_STALE',
  SYNC_ERROR: 'SYNC_ERROR',
  CONFIGURATION_REQUIRED: 'CONFIGURATION_REQUIRED',
};

/**
 * Klasifikasi status bank — cascade, urutan penting (yang pertama match
 * menang). SEMUA threshold datang dari policy per-bank (tidak ada angka
 * produksi yang dikarang di sini):
 *   1. Tidak ada snapshot sama sekali          -> CONFIGURATION_REQUIRED
 *   2. sync_status snapshot terakhir = ERROR   -> SYNC_ERROR
 *   3. Policy belum ada / belum aktif          -> CONFIGURATION_REQUIRED
 *   4. Snapshot lebih tua dari stale_after_minutes -> DATA_STALE
 *   5. effective_balance <= absolute_minimum_balance -> CRITICAL
 *   6. effective_balance <= watch_threshold     -> TOP_UP_RECOMMENDED
 *   7. effective_balance <= watch_threshold * (1 + safety_buffer_percentage/100)
 *                                                -> WATCH (zona buffer, mendekati watch_threshold)
 *   8. excess_balance_threshold terisi & effective_balance >= itu -> EXCESS_BALANCE
 *   9. selain itu                               -> SAFE
 */
function classifyBankStatus({ snapshot, policy, now = new Date() }) {
  if (!snapshot) return STATUS.CONFIGURATION_REQUIRED;
  if (snapshot.sync_status === 'ERROR') return STATUS.SYNC_ERROR;
  if (!policy || policy.is_active === false) return STATUS.CONFIGURATION_REQUIRED;

  if (policy.stale_after_minutes !== null && policy.stale_after_minutes !== undefined) {
    const capturedAt = new Date(snapshot.captured_at);
    const ageMinutes = (now.getTime() - capturedAt.getTime()) / 60000;
    if (ageMinutes > Number(policy.stale_after_minutes)) return STATUS.DATA_STALE;
  }

  const eff = Number(snapshot.effective_balance);
  const absMin = policy.absolute_minimum_balance !== null && policy.absolute_minimum_balance !== undefined
    ? Number(policy.absolute_minimum_balance) : null;
  const watch = policy.watch_threshold !== null && policy.watch_threshold !== undefined
    ? Number(policy.watch_threshold) : null;
  const excess = policy.excess_balance_threshold !== null && policy.excess_balance_threshold !== undefined
    ? Number(policy.excess_balance_threshold) : null;
  const bufferPct = policy.safety_buffer_percentage !== null && policy.safety_buffer_percentage !== undefined
    ? Number(policy.safety_buffer_percentage) : 0;

  if (absMin !== null && eff <= absMin) return STATUS.CRITICAL;

  if (watch !== null) {
    if (eff <= watch) return STATUS.TOP_UP_RECOMMENDED;
    const watchBufferUpper = watch * (1 + bufferPct / 100);
    if (eff <= watchBufferUpper) return STATUS.WATCH;
  }

  if (excess !== null && eff >= excess) return STATUS.EXCESS_BALANCE;

  return STATUS.SAFE;
}

/** Alert type yang relevan utk status tsb, atau null kalau tidak perlu alert. */
const STATUS_TO_ALERT_TYPE = {
  [STATUS.WATCH]: 'LOW_BALANCE',
  [STATUS.TOP_UP_RECOMMENDED]: 'LOW_BALANCE',
  [STATUS.CRITICAL]: 'CRITICAL_BALANCE',
  [STATUS.EXCESS_BALANCE]: 'EXCESS_BALANCE',
  [STATUS.DATA_STALE]: 'DATA_STALE',
  [STATUS.SYNC_ERROR]: 'SYNC_ERROR',
};
function alertTypeForStatus(status) {
  return STATUS_TO_ALERT_TYPE[status] || null;
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
  alertTypeForStatus,
  STATUS,
  TOPUP_TRANSITIONS,
  canTransitionTopup,
  isSelfApproval,
};
