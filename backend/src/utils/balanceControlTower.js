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
 *   4. Snapshot (atau data rekonsiliasi, kalau forecast tersedia) lebih tua
 *      dari stale_after_minutes                -> DATA_STALE
 *   5. Sudden-drop terdeteksi (lihat evaluateSuddenDrop) -> SUDDEN_DROP
 *   6. effective_balance <= emergency_threshold, ATAU (kalau forecast
 *      tersedia) runway lebih pendek dari funding window -> EMERGENCY
 *   7. effective_balance <= critical_threshold ATAU <= absolute_minimum_balance
 *      (backward-compat: absolute_minimum_balance tetap dipakai kalau
 *      critical_threshold belum diisi), ATAU (kalau forecast tersedia)
 *      proyeksi saldo di funding window berikutnya < critical -> CRITICAL
 *   8. effective_balance <= watch_threshold     -> TOP_UP_RECOMMENDED
 *   9. effective_balance <= watch_threshold * (1 + safety_buffer_percentage/100)
 *                                                -> WATCH (zona buffer, mendekati watch_threshold)
 *  10. excess_balance_threshold terisi & effective_balance (dikurangi
 *      kebutuhan forecast & reserve kalau forecast tersedia) >= itu -> EXCESS_BALANCE
 *  11. selain itu                               -> SAFE
 *
 * `forecast` (opsional, dari backend/src/reconciliation/balanceForecast.js
 * buildForecastOutput()) HANYA dipakai kalau forecast_available !== false
 * DAN minimal satu dynamic threshold terisi -- threshold di dalam forecast
 * SUDAH menerapkan precedence manual-override > dynamic (lihat
 * resolveThresholdField), classify TIDAK menduplikasi precedence itu.
 * Kalau forecast tidak diberikan/tidak tersedia, cascade PERSIS sama dgn
 * versi sebelum fitur forecast ada (backward-compatible, byte-identical).
 */
function computeStatusDecision({ snapshot, policy, previousSnapshot = null, forecast = null, now = new Date() }) {
  if (!snapshot) return { status: STATUS.CONFIGURATION_REQUIRED, reason: 'Belum ada snapshot saldo untuk bank ini.' };
  if (snapshot.sync_status === 'ERROR') return { status: STATUS.SYNC_ERROR, reason: 'Snapshot saldo terakhir berstatus sync ERROR.' };
  if (!policy || policy.is_active === false) return { status: STATUS.CONFIGURATION_REQUIRED, reason: 'Policy saldo belum dikonfigurasi atau nonaktif.' };

  if (policy.stale_after_minutes !== null && policy.stale_after_minutes !== undefined) {
    const staleLimit = Number(policy.stale_after_minutes);
    const capturedAt = new Date(snapshot.captured_at);
    const ageMinutes = (now.getTime() - capturedAt.getTime()) / 60000;
    if (ageMinutes > staleLimit) {
      return { status: STATUS.DATA_STALE, reason: `Snapshot saldo berumur ${Math.round(ageMinutes)} menit, melebihi batas ${staleLimit} menit.` };
    }
    if (forecast && forecast.forecast_available && forecast.latest_reconciliation_age_minutes !== null && forecast.latest_reconciliation_age_minutes > staleLimit) {
      return { status: STATUS.DATA_STALE, reason: `Data rekonsiliasi terakhir berumur ${forecast.latest_reconciliation_age_minutes} menit, melebihi batas ${staleLimit} menit.` };
    }
  }

  const suddenDrop = evaluateSuddenDrop({ snapshot, previousSnapshot, policy, now });
  if (suddenDrop.triggered) {
    return { status: STATUS.SUDDEN_DROP, reason: `Penurunan saldo Rp${Math.round(suddenDrop.dropAmount).toLocaleString('id-ID')} (${suddenDrop.dropPercentage.toFixed(1)}%) terdeteksi dalam window sudden-drop.` };
  }

  const eff = Number(snapshot.effective_balance);
  const forecastUsable = !!(forecast && forecast.forecast_available &&
    (forecast.dynamic_emergency_threshold !== null || forecast.dynamic_critical_threshold !== null || forecast.dynamic_watch_threshold !== null));

  if (forecastUsable) {
    const { dynamic_emergency_threshold: emergency, dynamic_critical_threshold: critical, dynamic_watch_threshold: watch,
      projected_balance_at_next_funding: projected, estimated_runway_minutes: runway, funding_window_hours: fundingHours } = forecast;
    const fundingWindowMinutes = fundingHours !== null && fundingHours !== undefined ? fundingHours * 60 : null;

    if (emergency !== null && eff <= emergency) {
      return { status: STATUS.EMERGENCY, reason: `Saldo efektif Rp${Math.round(eff).toLocaleString('id-ID')} <= emergency threshold dinamis Rp${Math.round(emergency).toLocaleString('id-ID')}.` };
    }
    if (runway !== null && fundingWindowMinutes !== null && runway <= fundingWindowMinutes) {
      return { status: STATUS.EMERGENCY, reason: `Estimasi runway ${Math.round(runway)} menit lebih pendek dari funding window ${Math.round(fundingWindowMinutes)} menit.` };
    }
    if (critical !== null && eff <= critical) {
      return { status: STATUS.CRITICAL, reason: `Saldo efektif Rp${Math.round(eff).toLocaleString('id-ID')} <= critical threshold dinamis Rp${Math.round(critical).toLocaleString('id-ID')}.` };
    }
    if (projected !== null && critical !== null && projected < critical) {
      return { status: STATUS.CRITICAL, reason: `Proyeksi saldo di funding window berikutnya Rp${Math.round(projected).toLocaleString('id-ID')} di bawah critical threshold dinamis.` };
    }
    if (watch !== null) {
      if (eff <= watch) return { status: STATUS.TOP_UP_RECOMMENDED, reason: `Saldo efektif <= watch threshold dinamis Rp${Math.round(watch).toLocaleString('id-ID')}.` };
      const bufferPct = policy.safety_buffer_percentage !== null && policy.safety_buffer_percentage !== undefined ? Number(policy.safety_buffer_percentage) : 0;
      const watchBufferUpper = watch * (1 + bufferPct / 100);
      if (eff <= watchBufferUpper) return { status: STATUS.WATCH, reason: 'Mendekati watch threshold dinamis (zona buffer safety_buffer_percentage).' };
    }
    const excess = policy.excess_balance_threshold !== null && policy.excess_balance_threshold !== undefined ? Number(policy.excess_balance_threshold) : null;
    if (excess !== null) {
      const excessBasis = (forecast.forecast_required_balance !== null && forecast.dynamic_reserve_balance !== null)
        ? eff - forecast.forecast_required_balance - forecast.dynamic_reserve_balance : eff;
      if (excessBasis >= excess) return { status: STATUS.EXCESS_BALANCE, reason: 'Saldo efektif (setelah kebutuhan forecast & reserve) melebihi excess threshold.' };
    }
    return { status: STATUS.SAFE, reason: 'Proyeksi saldo mencukupi kebutuhan sampai funding window berikutnya.' };
  }

  // ── Fallback: forecast tidak tersedia/tidak dipakai -- cascade lama, tidak berubah ──
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

  if (emergency !== null && eff <= emergency) return { status: STATUS.EMERGENCY, reason: `Saldo efektif <= emergency_threshold Rp${Math.round(emergency).toLocaleString('id-ID')}.` };
  if (critical !== null && eff <= critical) return { status: STATUS.CRITICAL, reason: `Saldo efektif <= critical_threshold Rp${Math.round(critical).toLocaleString('id-ID')}.` };
  if (absMin !== null && eff <= absMin) return { status: STATUS.CRITICAL, reason: `Saldo efektif <= absolute_minimum_balance Rp${Math.round(absMin).toLocaleString('id-ID')}.` };

  if (watch !== null) {
    if (eff <= watch) return { status: STATUS.TOP_UP_RECOMMENDED, reason: `Saldo efektif <= watch_threshold Rp${Math.round(watch).toLocaleString('id-ID')}.` };
    const watchBufferUpper = watch * (1 + bufferPct / 100);
    if (eff <= watchBufferUpper) return { status: STATUS.WATCH, reason: 'Mendekati watch_threshold (zona buffer safety_buffer_percentage).' };
  }

  if (excess !== null && eff >= excess) return { status: STATUS.EXCESS_BALANCE, reason: `Saldo efektif >= excess_balance_threshold Rp${Math.round(excess).toLocaleString('id-ID')}.` };

  return { status: STATUS.SAFE, reason: 'Saldo efektif berada dalam rentang aman.' };
}

/** Wrapper backward-compatible -- return HANYA string status, kontrak & perilaku SAMA PERSIS dgn sebelum fitur forecast ada saat dipanggil tanpa `forecast`. */
function classifyBankStatus(params) {
  return computeStatusDecision(params).status;
}

/** Versi lengkap (status + alasan human-readable) -- dipakai route utk field status_reason. */
function classifyBankStatusDetailed(params) {
  return computeStatusDecision(params);
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

function round2(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? n : Math.round(n * 100) / 100;
}

/**
 * Pilih snapshot "current" & "previous" dari daftar snapshot 1 bank (SUDAH
 * terurut DESC by captured_at). Utk bank yang punya adapter rekonsiliasi
 * (isReconciliationBacked) -- Input Saldo Manual TIDAK BOLEH menimpa balance
 * yang lebih segar dari rekonsiliasi (spec item 5): kalau ada baris
 * RECONCILIATION SAMA SEKALI, itu yang jadi "current", TERLEPAS ada baris
 * MANUAL yang lebih baru captured_at-nya. MANUAL hanya jadi "current" kalau
 * BELUM PERNAH ada baris RECONCILIATION utk bank ini (mis. sebelum sync
 * pertama). Bank tanpa adapter rekonsiliasi TIDAK terpengaruh -- tetap
 * captured_at DESC biasa (perilaku lama, tidak diubah).
 */
function pickCurrentAndPrevious(rowsForBank, isReconciliationBacked) {
  if (!Array.isArray(rowsForBank)) return { snapshot: null, previousSnapshot: null };
  if (!isReconciliationBacked) {
    return { snapshot: rowsForBank[0] || null, previousSnapshot: rowsForBank[1] || null };
  }
  const reconRows = rowsForBank.filter(r => r.source === 'RECONCILIATION');
  if (reconRows.length) {
    const previous = reconRows[1] || rowsForBank.find(r => r.id !== reconRows[0].id) || null;
    return { snapshot: reconRows[0], previousSnapshot: previous };
  }
  return { snapshot: rowsForBank[0] || null, previousSnapshot: rowsForBank[1] || null };
}

/**
 * Delta saldo antara snapshot saat ini & snapshot valid sebelumnya (PURE) --
 * dipakai kartu "Δ Saldo" FA Action Summary DAN sbg building block enrichment
 * riwayat snapshot. `previous` null -> semua delta null (BUKAN 0 -- 0 berarti
 * klaim "tidak ada perubahan", padahal sebenarnya "tidak ada pembanding").
 */
function computeBalanceMovement({ current, previous }) {
  if (!current) return null;
  const currentBalance = Number(current.available_balance);
  if (!previous) {
    return {
      delta_amount: null, delta_percentage: null, direction: null,
      current_captured_at: current.captured_at, previous_captured_at: null,
      current_available_balance: currentBalance, previous_available_balance: null,
      reason: 'Belum ada snapshot valid sebelumnya untuk dibandingkan.',
    };
  }
  const previousBalance = Number(previous.available_balance);
  const delta = round2(currentBalance - previousBalance);
  const direction = delta > 0 ? 'UP' : (delta < 0 ? 'DOWN' : 'FLAT');
  const deltaPercentage = previousBalance !== 0 ? round2((delta / Math.abs(previousBalance)) * 100) : null;
  return {
    delta_amount: delta, delta_percentage: deltaPercentage, direction,
    current_captured_at: current.captured_at, previous_captured_at: previous.captured_at,
    current_available_balance: currentBalance, previous_available_balance: previousBalance,
    reason: null,
  };
}

const MOVEMENT_CLASSIFICATION = {
  NO_PREVIOUS: 'NO_PREVIOUS',
  NO_CHANGE: 'NO_CHANGE',
  RECONCILIATION_DATA_UNAVAILABLE: 'RECONCILIATION_DATA_UNAVAILABLE',
  CONSISTENT_WITH_VERIFIED_TRANSACTIONS: 'CONSISTENT_WITH_VERIFIED_TRANSACTIONS',
  LIKELY_INCOMING_FUNDS_UNVERIFIED: 'LIKELY_INCOMING_FUNDS_UNVERIFIED',
  LIKELY_OPERATIONAL_OUTFLOW_UNVERIFIED: 'LIKELY_OPERATIONAL_OUTFLOW_UNVERIFIED',
};

/**
 * Enrichment riwayat snapshot (PURE, tidak query DB) -- utk tiap snapshot,
 * cari snapshot valid sebelumnya (skip yang sync_status ERROR), hitung delta,
 * lalu breakdown interval itu jadi matched principal/fee (dari recon_results
 * yang SUDAH matched, reuse row shape fetchRecentMatchedOutflows) + funding
 * credit (dari getConfirmedFundingMutations, filter is_reversal=false) +
 * residual (unmatched_or_unknown_movement). Kalau funding coverage TIDAK
 * mencakup interval itu (interval mulai sebelum fundingCoverageFrom),
 * funding/residual/classification dikembalikan null dgn alasan eksplisit --
 * TIDAK PERNAH ditampilkan sbg 0 (0 = klaim pasti tidak ada funding, padahal
 * sebenarnya "tidak diketahui").
 *
 * `snapshots` HARUS terurut DESC by captured_at (kontrak query existing).
 * `outflowRows`: [{ principal, fee, matchedAt }] mencakup seluruh rentang
 * snapshot yang mau di-enrich. `fundingMutations`: [{ amount,
 * transaction_datetime, is_reversal, classification }] dari
 * getConfirmedFundingMutations. `fundingCoverageFrom`: Date/null -- awal
 * rentang waktu yang benar2 sudah di-query utk fundingMutations.
 */
function enrichSnapshotHistory({ snapshots, outflowRows = [], fundingMutations = [], fundingCoverageFrom = null }) {
  if (!Array.isArray(snapshots) || !snapshots.length) return [];

  const sumInRange = (rows, from, to, amountKey, timeKey) => {
    let total = 0;
    for (const r of rows) {
      const t = r[timeKey] instanceof Date ? r[timeKey] : new Date(r[timeKey]);
      if (Number.isNaN(t.getTime())) continue;
      if (t > from && t <= to) total += Number(r[amountKey]) || 0;
    }
    return round2(total);
  };

  return snapshots.map((snap, idx) => {
    // Cari snapshot valid sebelumnya (skip ERROR) -- indeks lebih besar = lebih lama krn DESC.
    let previous = null;
    for (let j = idx + 1; j < snapshots.length; j++) {
      if (snapshots[j].sync_status !== 'ERROR' && snapshots[j].available_balance !== null && snapshots[j].available_balance !== undefined) {
        previous = snapshots[j];
        break;
      }
    }
    const movement = computeBalanceMovement({ current: snap, previous });
    if (!previous || movement.delta_amount === null) {
      return { ...snap, movement, matched_principal_outflow_interval: null, verified_fee_outflow_interval: null,
        funding_credit_interval: null, unmatched_or_unknown_movement_interval: null,
        movement_classification: MOVEMENT_CLASSIFICATION.NO_PREVIOUS };
    }

    const from = new Date(previous.captured_at);
    const to = new Date(snap.captured_at);
    const matchedPrincipal = sumInRange(outflowRows, from, to, 'principal', 'matchedAt');
    const verifiedFee = sumInRange(outflowRows, from, to, 'fee', 'matchedAt');

    const coverageOk = fundingCoverageFrom && from >= new Date(fundingCoverageFrom);
    let fundingCredit = null, unmatched = null, classification;
    if (Math.abs(movement.delta_amount) < 1) {
      classification = MOVEMENT_CLASSIFICATION.NO_CHANGE;
    } else if (!coverageOk) {
      classification = MOVEMENT_CLASSIFICATION.RECONCILIATION_DATA_UNAVAILABLE;
    } else {
      fundingCredit = sumInRange(
        fundingMutations.filter(m => !m.is_reversal && m.classification === 'FUNDING'),
        from, to, 'amount', 'transaction_datetime'
      );
      const expected = round2(fundingCredit - matchedPrincipal - verifiedFee);
      unmatched = round2(movement.delta_amount - expected);
      const tolerance = Math.max(1, Math.abs(movement.delta_amount) * 0.05);
      if (Math.abs(unmatched) <= tolerance) {
        classification = MOVEMENT_CLASSIFICATION.CONSISTENT_WITH_VERIFIED_TRANSACTIONS;
      } else if (movement.delta_amount > 0) {
        classification = MOVEMENT_CLASSIFICATION.LIKELY_INCOMING_FUNDS_UNVERIFIED;
      } else {
        classification = MOVEMENT_CLASSIFICATION.LIKELY_OPERATIONAL_OUTFLOW_UNVERIFIED;
      }
    }

    return {
      ...snap, movement,
      matched_principal_outflow_interval: matchedPrincipal,
      verified_fee_outflow_interval: verifiedFee,
      funding_credit_interval: fundingCredit,
      unmatched_or_unknown_movement_interval: unmatched,
      movement_classification: classification,
    };
  });
}

module.exports = {
  toCents,
  centsToString,
  computeEffectiveBalance,
  classifyBankStatus,
  classifyBankStatusDetailed,
  evaluateSuddenDrop,
  resolveReserveBalance,
  alertTypeForStatus,
  STATUS,
  TOPUP_TRANSITIONS,
  canTransitionTopup,
  isSelfApproval,
  pickCurrentAndPrevious,
  computeBalanceMovement,
  enrichSnapshotHistory,
  MOVEMENT_CLASSIFICATION,
};
