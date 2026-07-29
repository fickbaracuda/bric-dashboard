'use strict';

/**
 * Balance Control Tower — mesin kalkulasi operasional TERPUSAT (FA Action
 * Layer). SATU-SATUNYA tempat formula operasional dihitung — summary,
 * bank detail, FA Action Summary, dan alert engine SEMUA memakai output
 * fungsi ini, TIDAK ada yang menghitung ulang dengan formula sendiri.
 *
 * PURE — tidak menyentuh DB (lihat operationalDataAccess.js utk fetch).
 * Reuse eksplisit (BUKAN reimplementasi):
 *   - Matching FP<->OCBC & fee grouping: SUDAH dilakukan oleh
 *     reconcileTransactions()/buildOcbcBankGroups() di
 *     warroom-reconciliation.js (recon_results.recon_status). Mesin ini
 *     HANYA menjumlahkan bank_principal/bank_fee dari baris yang statusnya
 *     SUDAH diverifikasi matched oleh engine itu -- tidak menduplikasi
 *     grouping/fee-verification logic sama sekali.
 *   - Sumber saldo: recon_sync_batches.raw_summary.available_balance
 *     (lihat backend/src/reconciliation/bankPosition/), dipakai apa adanya.
 *
 * Menggantikan (utk bank yang didukung bankPosition adapter): cascade
 * status lama yang berbasis average_burn_rate 14-hari (balanceForecast.js)
 * -- field lama itu TETAP dihitung & ditampilkan sbg "historical_analytics"
 * (lihat operationalDataAccess.js), TAPI TIDAK LAGI dipakai utk menentukan
 * status/alert/rekomendasi top-up. Old & new formula TIDAK PERNAH aktif
 * bersamaan utk bank yang sama.
 */

const STANDARD_WINDOWS_MINUTES = [5, 15, 30, 60];

// Akselerasi: kalau rate 5-menit > 1.5x primary window, dianggap "acceleration".
// Cap pengaruh spike ke maksimal 3x primary window -- mencegah 1 lonjakan
// transaksi menghasilkan rekomendasi top-up yang absurd (spec section 10).
const ACCELERATION_FACTOR = 1.5;
const DECELERATION_FACTOR = 0.8;
const MAX_SPIKE_MULTIPLIER = 3;

function safeDiv(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}
function round2(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? n : Math.round(n * 100) / 100;
}

/**
 * Bucket baris outflow matched (dari recon_results, SUDAH difilter status
 * matched oleh caller) ke 4 window standar. `rows`: [{ principal, fee,
 * matchedAt (Date) }]. `now`: batas akhir window (biasanya waktu kalkulasi).
 */
function bucketOutflowsByWindow(rows, now) {
  const result = {};
  for (const minutes of STANDARD_WINDOWS_MINUTES) {
    const windowStart = new Date(now.getTime() - minutes * 60000);
    let principal = 0, fee = 0, count = 0, earliest = null;
    for (const r of rows) {
      const t = r.matchedAt instanceof Date ? r.matchedAt : new Date(r.matchedAt);
      if (Number.isNaN(t.getTime()) || t < windowStart || t > now) continue;
      principal += Number(r.principal) || 0;
      fee += Number(r.fee) || 0;
      count += 1;
      if (!earliest || t < earliest) earliest = t;
    }
    // effective_window_minutes -- kalau data yang tersedia lebih muda dari
    // window (mis. baru mulai sync hari ini), JANGAN bagi dgn window penuh
    // (spec section 9C) -- pakai durasi aktual data yang benar2 ada.
    const effectiveMinutes = earliest ? Math.min(minutes, (now.getTime() - earliest.getTime()) / 60000) : minutes;
    result[minutes] = {
      window_minutes: minutes,
      window_start: windowStart.toISOString(),
      window_end: now.toISOString(),
      matched_transaction_count: count,
      matched_principal_outflow: round2(principal),
      verified_fee_outflow: round2(fee),
      total_window_outflow: round2(principal + fee),
      effective_window_minutes: round2(effectiveMinutes),
      burn_rate_per_minute: count > 0 ? safeDiv(principal + fee, effectiveMinutes) : 0,
    };
  }
  return result;
}

/**
 * Pilih burn rate operasional dari 4 window -- primary window Finance,
 * dgn deteksi akselerasi/deselerasi memakai window 5 menit sbg sinyal dini.
 * Aturan (didokumentasikan, bukan sihir): kalau rate 5 menit > 1.5x primary
 * DAN ada transaksi nyata (bukan noise 1 baris), applied_rate = rate 5
 * menit di-cap ke maksimal 3x primary. Kalau tidak, pakai primary apa adanya.
 */
function selectOperationalBurnRate({ windows, primaryWindowMinutes }) {
  const primary = windows[primaryWindowMinutes];
  const w5 = windows[5];
  if (!primary) return { applied_rate_per_minute: null, trend: 'UNKNOWN', acceleration_detected: false, applied_rate_reason: 'Window primary tidak tersedia.' };

  const primaryRate = primary.burn_rate_per_minute || 0;
  const rate5 = w5 ? (w5.burn_rate_per_minute || 0) : 0;

  let trend = 'STABLE';
  if (primaryRate > 0) {
    if (rate5 > primaryRate * ACCELERATION_FACTOR) trend = 'ACCELERATING';
    else if (rate5 < primaryRate * DECELERATION_FACTOR) trend = 'DECELERATING';
  } else if (rate5 > 0) {
    trend = 'ACCELERATING';
  }

  const accelerationDetected = primaryWindowMinutes !== 5 && rate5 > primaryRate * ACCELERATION_FACTOR && w5.matched_transaction_count >= 2;

  let appliedRate = primaryRate;
  let reason = `Memakai burn rate window primary (${primaryWindowMinutes} menit) apa adanya, tidak ada akselerasi signifikan.`;
  if (accelerationDetected) {
    const capped = Math.min(rate5, primaryRate > 0 ? primaryRate * MAX_SPIKE_MULTIPLIER : rate5);
    appliedRate = capped;
    reason = `Akselerasi terdeteksi (rate 5 menit ${rate5.toFixed(2)}/menit > ${ACCELERATION_FACTOR}x primary ${primaryRate.toFixed(2)}/menit). Rate 5 menit dipakai, dibatasi maksimal ${MAX_SPIKE_MULTIPLIER}x primary utk mencegah lonjakan satu kali menghasilkan rekomendasi top-up ekstrem.`;
  }

  return { applied_rate_per_minute: appliedRate, trend, acceleration_detected: accelerationDetected, applied_rate_reason: reason };
}

/** usable_balance = available - absolute_minimum. Boleh negatif (utk diagnosis), TIDAK pernah di-clamp di sini. */
function computeUsableBalance({ availableBalance, absoluteMinimumBalance }) {
  return round2((Number(availableBalance) || 0) - (Number(absoluteMinimumBalance) || 0));
}

/** lead_time_need = burn_rate_per_minute x topup_lead_time_minutes. */
function computeLeadTimeNeed({ burnRatePerMinute, topupLeadTimeMinutes }) {
  return round2((Number(burnRatePerMinute) || 0) * (Number(topupLeadTimeMinutes) || 0));
}

/**
 * Safety buffer -- SATU mode aktif (FIXED atau PERCENTAGE), TIDAK PERNAH
 * keduanya sekaligus (spec section 9E). type null/tidak dikenal -> 0
 * (bukan dikarang).
 */
function computeSafetyBufferAmount({ safetyBufferType, safetyBufferFixedAmount, safetyBufferPercentage, leadTimeNeed }) {
  if (safetyBufferType === 'FIXED') {
    return round2(Number(safetyBufferFixedAmount) || 0);
  }
  if (safetyBufferType === 'PERCENTAGE') {
    return round2(((Number(safetyBufferPercentage) || 0) / 100) * (Number(leadTimeNeed) || 0));
  }
  return 0;
}

/** safe_target_balance = absolute_minimum + lead_time_need + safety_buffer_amount. Masing2 komponen SATU KALI. */
function computeSafeTargetBalance({ absoluteMinimumBalance, leadTimeNeed, safetyBufferAmount }) {
  return round2((Number(absoluteMinimumBalance) || 0) + (Number(leadTimeNeed) || 0) + (Number(safetyBufferAmount) || 0));
}

/** raw = safe_target - available. recommended = max(0, raw), lalu dibulatkan ke atas (SETELAH clamp, bukan sebelum). */
function computeRecommendedTopup({ safeTargetBalance, availableBalance, topupRoundingAmount }) {
  const raw = round2((Number(safeTargetBalance) || 0) - (Number(availableBalance) || 0));
  const clamped = Math.max(0, raw);
  let recommended = clamped;
  if (clamped > 0 && Number(topupRoundingAmount) > 0) {
    recommended = Math.ceil(clamped / Number(topupRoundingAmount)) * Number(topupRoundingAmount);
  }
  return { raw_recommended_topup: raw, recommended_topup: round2(recommended) };
}

/** usable_runway = usable_balance / burn_rate_per_minute (menit sampai menyentuh absolute minimum). null kalau burn <= 0 (bukan Infinity). */
function computeUsableRunwayMinutes({ usableBalance, burnRatePerMinute }) {
  if (!(Number(burnRatePerMinute) > 0)) return null;
  return round2((Number(usableBalance) || 0) / Number(burnRatePerMinute));
}

/** zero_balance_runway = available_balance / burn_rate_per_minute (menit sampai saldo 0). null kalau burn <= 0. */
function computeZeroBalanceRunwayMinutes({ availableBalance, burnRatePerMinute }) {
  if (!(Number(burnRatePerMinute) > 0)) return null;
  return round2((Number(availableBalance) || 0) / Number(burnRatePerMinute));
}

function computeDeadlines({ now, usableRunwayMinutes, topupLeadTimeMinutes, operationalSafetyMarginMinutes }) {
  if (usableRunwayMinutes === null) return { minimum_balance_breach_time: null, topup_deadline: null };
  const breach = new Date(now.getTime() + usableRunwayMinutes * 60000);
  const deadline = new Date(breach.getTime() - (Number(topupLeadTimeMinutes) || 0) * 60000 - (Number(operationalSafetyMarginMinutes) || 0) * 60000);
  return { minimum_balance_breach_time: breach.toISOString(), topup_deadline: deadline.toISOString() };
}

/**
 * Cascade status operasional (spec section 12). Return {status, reason}
 * dgn `status` memakai KONSTANTA STATUS yang SUDAH ADA (STATUS.SAFE utk
 * "Normal", dst) -- BUKAN string baru -- supaya kompatibel penuh dgn
 * alertTypeForStatus/STATUS_META/badge UI existing, TANPA mengubah wording.
 */
function classifyOperationalStatus({ STATUS, availableBalance, usableBalance, burnRatePerMinute, usableRunwayMinutes, zeroBalanceRunwayMinutes, topupLeadTimeMinutes, criticalMarginMinutes, watchBufferMinutes, recommendedTopup }) {
  const fmtRp = (n) => `Rp${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;
  const activeOutflow = Number(burnRatePerMinute) > 0;

  if (Number(availableBalance) <= 0) {
    return { status: STATUS.EMERGENCY, reason: `Saldo tersedia ${fmtRp(availableBalance)} sudah habis atau negatif. Tindakan pendanaan segera diperlukan.` };
  }
  if (Number(usableBalance) <= 0) {
    if (activeOutflow) {
      return { status: STATUS.EMERGENCY, reason: `Saldo sudah di bawah/di batas minimum yang dilindungi dan transaksi masih berjalan. Tindakan pendanaan segera diperlukan.` };
    }
    return { status: STATUS.CRITICAL, reason: `Saldo sudah di bawah/di batas minimum yang dilindungi. Top-up perlu segera diproses.` };
  }
  if (zeroBalanceRunwayMinutes !== null && zeroBalanceRunwayMinutes <= Number(topupLeadTimeMinutes || 0)) {
    return { status: STATUS.EMERGENCY, reason: `Saldo diperkirakan habis (${Math.round(zeroBalanceRunwayMinutes)} menit) sebelum top-up dapat masuk (lead time ${topupLeadTimeMinutes} menit). Tindakan pendanaan segera diperlukan.` };
  }

  const criticalThresholdMinutes = Number(topupLeadTimeMinutes || 0) + Number(criticalMarginMinutes || 0);
  const watchThresholdMinutes = criticalThresholdMinutes + Number(watchBufferMinutes || 0);

  if (usableRunwayMinutes !== null && usableRunwayMinutes <= criticalThresholdMinutes) {
    return { status: STATUS.CRITICAL, reason: `Saldo diperkirakan mencapai batas minimum dalam ${Math.round(usableRunwayMinutes)} menit, mendekati atau sebelum waktu top-up dapat masuk. Top-up perlu segera diproses.` };
  }
  if (usableRunwayMinutes !== null && usableRunwayMinutes <= watchThresholdMinutes) {
    return { status: STATUS.WATCH, reason: `Saldo masih di atas batas minimum, tetapi runway (${Math.round(usableRunwayMinutes)} menit) mulai mendekati batas waktu proses top-up. Pantau percepatan transaksi dan siapkan top-up.` };
  }

  const usableFmt = fmtRp(usableBalance);
  return {
    status: STATUS.SAFE,
    reason: `Saldo tersedia ${fmtRp(availableBalance)}. Saldo di atas batas minimum adalah ${usableFmt}. Dengan burn rate operasional saat ini, runway masih lebih panjang daripada lead time top-up dan safety margin. ${Number(recommendedTopup) > 0 ? 'Top-up disarankan sbg persiapan.' : 'Top-up belum diperlukan.'}`,
  };
}

const CALCULATION_VERSION = 'intraday_fa_v2_partial';

// Pesan alasan standar dipakai FE utk field yang null KARENA policy belum
// dikonfigurasi (BUKAN karena burn rate 0 / tidak ada outflow -- itu kondisi
// valid berbeda, jangan dipakaikan pesan yang sama supaya FA tidak salah
// paham "belum dikonfigurasi" padahal cuma "tidak ada transaksi").
const REASON_BURN_WINDOW_MISSING = 'Belum ditentukan — burn window operasional belum dikonfigurasi.';
const REASON_LEAD_TIME_MISSING = 'Belum dapat dihitung — top-up lead time belum dikonfigurasi.';
const REASON_MIN_BALANCE_MISSING = 'Belum dapat dihitung — batas minimum absolut belum dikonfigurasi.';

/**
 * Orkestrasi PURE penuh -- caller (operationalDataAccess.js) mengumpulkan
 * seluruh input dari DB lalu memanggil ini. Return payload lengkap sesuai
 * spec section 7 (field yang relevan utk MVP end-to-end ini).
 *
 * KALKULASI PARSIAL (revisi wajib) -- policy yang belum lengkap TIDAK BOLEH
 * membuat field yang sebenarnya BISA dihitung ikut kosong. absolute_minimum_
 * balance/usable_balance/4 window outflow SELALU dihitung independen kalau
 * datanya ada. HANYA selected burn rate/runway/recommended_topup/topup_
 * deadline yang tetap null sampai burn_window_minutes & topup_lead_time_
 * minutes eksplisit dikonfigurasi -- TIDAK ADA fallback window/runway
 * non-final di rilis ini (sengaja, per keputusan scope terakhir).
 */
function buildOperationalCalculation({ STATUS, bank, policy, position, freshness, outflowRows, todayUsage, now = new Date() }) {
  const missingPolicyFields = [];
  if (!policy) missingPolicyFields.push('policy belum dikonfigurasi');
  else {
    if (policy.absolute_minimum_balance === null || policy.absolute_minimum_balance === undefined) missingPolicyFields.push('absolute_minimum_balance');
    if (policy.burn_window_minutes === null || policy.burn_window_minutes === undefined) missingPolicyFields.push('burn_window_minutes');
    if (policy.topup_lead_time_minutes === null || policy.topup_lead_time_minutes === undefined) missingPolicyFields.push('topup_lead_time_minutes');
  }

  const base = {
    bank_id: bank.id, bank_code: bank.bank_code, account_number: bank.account_number, account_name: bank.account_name,
    calculation_timestamp: now.toISOString(), calculation_version: CALCULATION_VERSION,
    balance_source: position ? position.source_table : null,
    balance_source_batch_id: position ? position.source_reference : null,
    balance_source_timestamp: position ? position.synced_at : null,
    data_age_seconds: position && position.synced_at ? Math.round((now.getTime() - new Date(position.synced_at).getTime()) / 1000) : null,
    data_freshness_status: freshness,
    refresh_mode: 'ON_READ',
  };

  if (!position || position.available_balance === null || position.available_balance === undefined) {
    return { ...base, operational_status: STATUS.CONFIGURATION_REQUIRED, status_reason: 'Belum ada posisi saldo terverifikasi dari rekonsiliasi.', missing_configuration: missingPolicyFields, warnings: [], data_quality_flags: ['NO_POSITION'] };
  }

  const availableBalance = Number(position.available_balance);

  // absolute_minimum_balance/usable_balance -- SELALU dihitung kalau policy-nya
  // ada, TIDAK PERNAH ikut kosong hanya karena burn_window_minutes/topup_lead_
  // time_minutes belum diisi (itu 2 field yang beda kebutuhannya).
  const hasAbsoluteMinimum = !!policy && policy.absolute_minimum_balance !== null && policy.absolute_minimum_balance !== undefined;
  const absoluteMinimumBalance = hasAbsoluteMinimum ? Number(policy.absolute_minimum_balance) : null;
  const usableBalance = hasAbsoluteMinimum ? computeUsableBalance({ availableBalance, absoluteMinimumBalance }) : null;

  // movement variance -- opening+credit-debit vs available (analytics saja, TIDAK PERNAH overwrite available_balance).
  let movementVariance = null;
  if (position.opening_balance !== null && position.total_credit_amount !== null && position.total_debit_amount !== null) {
    const computedMovement = round2(position.opening_balance + position.total_credit_amount - position.total_debit_amount);
    const variance = round2(computedMovement - availableBalance);
    if (Math.abs(variance) > 0.01) {
      movementVariance = {
        computed_movement_balance: computedMovement, available_balance: availableBalance, variance_amount: variance,
        variance_percentage: availableBalance !== 0 ? round2((variance / availableBalance) * 100) : null,
        source_batch: position.source_reference, reconciliation_timestamp: position.synced_at,
        warning_reason: 'Movement-summary variance detected — Available Balance tetap dipakai sbg saldo aktual, butuh review rekonsiliasi.',
      };
    }
  }

  // 4 window outflow (5/15/30/60 menit) -- SELALU dihitung dari outflowRows
  // kalau ada (termasuk saat status DATA_STALE -- freshness itu soal umur
  // POSISI saldo, bukan umur baris outflow matched-nya), TIDAK bergantung pada
  // burn_window_minutes sama sekali (itu cuma dipakai utk MEMILIH window mana
  // yang jadi "operational selected rate"). Null HANYA kalau caller memang
  // tidak mengirim baris apa pun (mis. freshness UNAVAILABLE).
  const windows = bucketOutflowsByWindow(outflowRows || [], now);

  // Selected operational burn rate -- TIDAK ADA fallback window. Null total
  // kalau burn_window_minutes belum dikonfigurasi, apa pun isi windows di atas.
  const hasBurnWindow = !!policy && policy.burn_window_minutes !== null && policy.burn_window_minutes !== undefined;
  let primaryWindowMinutes = null, burnRatePerMinute = null, trend = 'UNKNOWN', accelerationDetected = false, appliedRateReason = REASON_BURN_WINDOW_MISSING;
  if (hasBurnWindow && windows) {
    primaryWindowMinutes = Number(policy.burn_window_minutes);
    const selected = selectOperationalBurnRate({ windows, primaryWindowMinutes });
    burnRatePerMinute = selected.applied_rate_per_minute;
    trend = selected.trend;
    accelerationDetected = selected.acceleration_detected;
    appliedRateReason = selected.applied_rate_reason;
  }

  const hasLeadTime = !!policy && policy.topup_lead_time_minutes !== null && policy.topup_lead_time_minutes !== undefined;
  const leadTimeMinutes = hasLeadTime ? Number(policy.topup_lead_time_minutes) : null;
  const criticalMarginMinutes = policy && policy.critical_margin_minutes !== null && policy.critical_margin_minutes !== undefined ? Number(policy.critical_margin_minutes) : 0;
  const watchBufferMinutes = policy && policy.watch_buffer_minutes !== null && policy.watch_buffer_minutes !== undefined ? Number(policy.watch_buffer_minutes) : 0;
  const operationalSafetyMarginMinutes = 0; // belum ada field terpisah di policy rilis ini -- lihat known limitations.

  // Runway -- HANYA dihitung kalau burn rate operasional (window terpilih)
  // tersedia. TIDAK PERNAH pakai window lain sbg fallback/estimasi non-final.
  const usableRunwayMinutes = (burnRatePerMinute !== null && usableBalance !== null)
    ? computeUsableRunwayMinutes({ usableBalance, burnRatePerMinute }) : null;
  const zeroBalanceRunwayMinutes = burnRatePerMinute !== null
    ? computeZeroBalanceRunwayMinutes({ availableBalance, burnRatePerMinute }) : null;

  let leadTimeNeed = null, safetyBufferAmount = null, safeTargetBalance = null, raw_recommended_topup = null, recommended_topup = null;
  let minimum_balance_breach_time = null, topup_deadline = null;
  const confirmedIncomingNotYetReflected = 0; // spec section 16/9 -- TETAP 0 sampai workflow top-up direkonsiliasi aman, tidak pernah dikurangkan sbg angka lain.

  if (burnRatePerMinute !== null && hasLeadTime) {
    leadTimeNeed = computeLeadTimeNeed({ burnRatePerMinute, topupLeadTimeMinutes: leadTimeMinutes });
    safetyBufferAmount = computeSafetyBufferAmount({
      safetyBufferType: policy.safety_buffer_type, safetyBufferFixedAmount: policy.safety_buffer_fixed_amount,
      safetyBufferPercentage: policy.safety_buffer_percentage, leadTimeNeed,
    });
    if (hasAbsoluteMinimum) {
      safeTargetBalance = computeSafeTargetBalance({ absoluteMinimumBalance, leadTimeNeed, safetyBufferAmount });
      const topup = computeRecommendedTopup({
        safeTargetBalance, availableBalance: availableBalance + confirmedIncomingNotYetReflected, topupRoundingAmount: policy.topup_rounding_amount,
      });
      raw_recommended_topup = topup.raw_recommended_topup;
      recommended_topup = topup.recommended_topup;
    }
    if (usableRunwayMinutes !== null) {
      const deadlines = computeDeadlines({ now, usableRunwayMinutes, topupLeadTimeMinutes: leadTimeMinutes, operationalSafetyMarginMinutes });
      minimum_balance_breach_time = deadlines.minimum_balance_breach_time;
      topup_deadline = deadlines.topup_deadline;
    }
  }

  // Prioritas SAMA PERSIS dgn versi sebelum kalkulasi parsial: DATA_STALE
  // menang di atas CONFIGURATION_REQUIRED (policy belum lengkap) kalau
  // dua-duanya kebetulan sekaligus terjadi -- tidak diubah, supaya perilaku
  // status/alert utk kombinasi ini identik dgn rilis sebelumnya.
  let status, reason;
  if (freshness === 'STALE' || freshness === 'UNAVAILABLE') {
    status = STATUS.DATA_STALE;
    reason = `Data saldo terakhir (${position.synced_at}) sudah melewati batas freshness. Rekomendasi top-up tidak dapat dianggap final sampai sinkronisasi terbaru tersedia.`;
  } else if (missingPolicyFields.length) {
    status = STATUS.CONFIGURATION_REQUIRED;
    reason = `Policy operasional belum lengkap: ${missingPolicyFields.join(', ')}. Nilai yang bisa dihitung dari data yang sudah ada tetap ditampilkan di bawah.`;
  } else {
    const classified = classifyOperationalStatus({
      STATUS, availableBalance, usableBalance, burnRatePerMinute, usableRunwayMinutes, zeroBalanceRunwayMinutes,
      topupLeadTimeMinutes: leadTimeMinutes, criticalMarginMinutes, watchBufferMinutes, recommendedTopup: recommended_topup,
    });
    status = classified.status;
    reason = classified.reason;
  }

  return {
    ...base,
    available_balance: availableBalance, ledger_balance: position.ledger_balance,
    opening_balance: position.opening_balance, closing_balance: position.closing_balance,
    total_credit: position.total_credit_amount, total_debit: position.total_debit_amount,
    movement_variance: movementVariance,
    absolute_minimum_balance: absoluteMinimumBalance,
    absolute_minimum_balance_unavailable_reason: hasAbsoluteMinimum ? null : REASON_MIN_BALANCE_MISSING,
    usable_balance: usableBalance,
    usable_balance_unavailable_reason: usableBalance === null ? REASON_MIN_BALANCE_MISSING : null,
    selected_burn_window_minutes: primaryWindowMinutes,
    burn_window_start: windows && primaryWindowMinutes ? windows[primaryWindowMinutes].window_start : null,
    burn_window_end: windows && primaryWindowMinutes ? windows[primaryWindowMinutes].window_end : null,
    matched_transaction_count: windows && primaryWindowMinutes ? windows[primaryWindowMinutes].matched_transaction_count : null,
    matched_principal_outflow: windows && primaryWindowMinutes ? windows[primaryWindowMinutes].matched_principal_outflow : null,
    verified_fee_outflow: windows && primaryWindowMinutes ? windows[primaryWindowMinutes].verified_fee_outflow : null,
    other_verified_operational_outflow: 0,
    total_window_outflow: windows && primaryWindowMinutes ? windows[primaryWindowMinutes].total_window_outflow : null,
    burn_rate_per_minute: burnRatePerMinute,
    burn_rate_unavailable_reason: burnRatePerMinute === null ? REASON_BURN_WINDOW_MISSING : null,
    // 4 window mentah -- SELALU tampil kalau ada data, independen dari burn_window_minutes policy.
    burn_rate_per_5_minutes: windows ? windows[5].burn_rate_per_minute : null,
    burn_rate_per_15_minutes: windows ? windows[15].burn_rate_per_minute : null,
    burn_rate_per_30_minutes: windows ? windows[30].burn_rate_per_minute : null,
    burn_rate_per_60_minutes: windows ? windows[60].burn_rate_per_minute : null,
    burn_trend: burnRatePerMinute !== null ? trend : 'UNKNOWN',
    acceleration_detected: accelerationDetected, applied_rate_reason: appliedRateReason,
    topup_lead_time_minutes: leadTimeMinutes,
    topup_lead_time_unavailable_reason: hasLeadTime ? null : REASON_LEAD_TIME_MISSING,
    lead_time_need: leadTimeNeed,
    safety_buffer_type: policy && policy.safety_buffer_type ? policy.safety_buffer_type : null,
    safety_buffer_value: policy && policy.safety_buffer_type === 'PERCENTAGE' ? policy.safety_buffer_percentage : (policy ? policy.safety_buffer_fixed_amount : null),
    safety_buffer_amount: safetyBufferAmount, safe_target_balance: safeTargetBalance,
    raw_recommended_topup, recommended_topup,
    recommended_topup_unavailable_reason: recommended_topup === null
      ? (!hasAbsoluteMinimum ? REASON_MIN_BALANCE_MISSING : (burnRatePerMinute === null ? REASON_BURN_WINDOW_MISSING : REASON_LEAD_TIME_MISSING))
      : null,
    confirmed_incoming_not_yet_reflected: confirmedIncomingNotYetReflected,
    topup_rounding_amount: policy && policy.topup_rounding_amount ? policy.topup_rounding_amount : null,
    usable_runway_minutes: usableRunwayMinutes,
    runway_unavailable_reason: usableRunwayMinutes === null ? (burnRatePerMinute === null ? REASON_BURN_WINDOW_MISSING : null) : null,
    zero_balance_runway_minutes: zeroBalanceRunwayMinutes,
    minimum_balance_breach_time, zero_balance_time: zeroBalanceRunwayMinutes !== null ? new Date(now.getTime() + zeroBalanceRunwayMinutes * 60000).toISOString() : null,
    topup_deadline, topup_deadline_type: 'INITIATION',
    operational_status: status, status_reason: reason, missing_configuration: missingPolicyFields,
    today_usage: todayUsage || null,
    assumptions: [
      `Burn rate dihitung dari transaksi FP yang SUDAH diverifikasi matched terhadap OCBC (recon_status MATCHED/MATCHED_NO_FEE/FEE_MISMATCH) — reuse engine rekonsiliasi existing, tidak dihitung ulang.`,
      `operational_safety_margin_minutes belum dikonfigurasi terpisah di rilis ini (default 0).`,
      `Tidak ada fallback/estimasi non-final utk burn rate atau runway — kedua field ini tetap kosong sampai burn_window_minutes eksplisit dikonfigurasi (keputusan scope, bukan bug).`,
      `confirmed_incoming_not_yet_reflected selalu 0 pada rilis ini — permintaan top-up yang sudah diajukan/disetujui/ditransfer TIDAK dihitung sbg saldo tersedia sampai direkonsiliasi.`,
    ],
    warnings: movementVariance ? ['MOVEMENT_VARIANCE_DETECTED'] : [],
    data_quality_flags: [],
    windows_detail: windows,
  };
}

module.exports = {
  CALCULATION_VERSION,
  STANDARD_WINDOWS_MINUTES,
  bucketOutflowsByWindow,
  selectOperationalBurnRate,
  computeUsableBalance,
  computeLeadTimeNeed,
  computeSafetyBufferAmount,
  computeSafeTargetBalance,
  computeRecommendedTopup,
  computeUsableRunwayMinutes,
  computeZeroBalanceRunwayMinutes,
  computeDeadlines,
  classifyOperationalStatus,
  buildOperationalCalculation,
};
