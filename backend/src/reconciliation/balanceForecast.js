/**
 * Balance Forecast — lapisan integrasi ADDITIVE antara OCBC Rekonsiliasi
 * (sumber pola transaksi/burn-rate/kebutuhan dana) dan Balance Control Tower
 * (control room: status/alert/top-up/audit).
 *
 * TIDAK menduplikasi logic matching/agregasi apa pun — burn rate & kebutuhan
 * dana dihitung dengan MEMANGGIL fungsi murni yang SUDAH ADA di
 * `../reconciliation/periodicBalanceNeeds.js` (yang sama persis dipakai tab
 * "Kebutuhan Saldo" di semua war-room Rekonsiliasi), hanya beda window
 * (trailing N hari dari hari ini, bukan rentang tanggal pilihan user).
 *
 * Generik per bank_code (bukan cuma OCBC) selama bank itu ada di
 * `periodicBalanceNeeds.BANK_ALLOWLIST` — otomatis siap dipakai bank lain
 * begitu Balance Control Tower punya bank_account utk bank itu juga.
 */

const {
  isValidBankCode,
  dateRangeArray,
  getActiveBatchesForPeriod,
  resolveExpectedFeePerBatch,
  getHourlyTransactionRows,
  computePeriodicBalanceNeeds,
} = require('./periodicBalanceNeeds');

const DEFAULT_FORECAST_WINDOW_DAYS = 14; // trailing window burn-rate — konstanta rekayasa, BUKAN nilai finansial yang dikarang.
const DEFAULT_FUNDING_WINDOW_HOURS = 24; // asumsi horizon default kalau Finance belum isi funding_window_hours (bukan angka saldo/threshold).

function isoDateInJakarta(date) {
  // Konversi ke tanggal kalender Asia/Jakarta (bukan UTC) -- konsisten dgn
  // seluruh engine rekonsiliasi yang pakai business_date WIB.
  const jakarta = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return jakarta.toISOString().slice(0, 10);
}

/**
 * Statistik burn-rate trailing N hari -- REUSE penuh periodicBalanceNeeds,
 * TIDAK menghitung ulang apa pun. `available=false` kalau tidak ada batch
 * rekonsiliasi sama sekali di window (mis. bank belum pernah sync) -- caller
 * WAJIB treat ini sbg "forecast tidak tersedia", bukan asumsikan 0.
 */
async function computeBurnRateStats({ pool, bankCode, windowDays = DEFAULT_FORECAST_WINDOW_DAYS, now = new Date() }) {
  if (!isValidBankCode(bankCode)) return { available: false, reason: `bank_code "${bankCode}" tidak dikenal engine rekonsiliasi.` };

  const endDate = isoDateInJakarta(now);
  const startDate = isoDateInJakarta(new Date(now.getTime() - windowDays * 86400000));
  const selectedDates = dateRangeArray(startDate, endDate);

  const batches = await getActiveBatchesForPeriod(pool, bankCode, startDate, endDate);
  if (!batches.length) {
    return { available: false, reason: `Belum ada batch Rekonsiliasi ${bankCode} pada ${windowDays} hari terakhir.`, window_days: windowDays, start_date: startDate, end_date: endDate };
  }

  const batchIds = batches.map(b => b.id);
  const batchDateById = new Map(batches.map(b => [Number(b.id), b.business_date]));

  const [feeByDate, hourlyRowsRaw] = await Promise.all([
    resolveExpectedFeePerBatch(pool, bankCode, batches),
    getHourlyTransactionRows(pool, batchIds, bankCode),
  ]);

  const includedDayFees = batches.map(b => ({
    business_date: b.business_date,
    expected_fee: feeByDate.has(b.business_date) ? feeByDate.get(b.business_date) : 0,
  }));
  const hourlyRows = hourlyRowsRaw
    .map(r => ({ business_date: batchDateById.get(Number(r.batch_id)), hour: Number(r.hour), tx_count: Number(r.tx_count), principal_sum: Number(r.principal_sum) }))
    .filter(r => r.business_date);

  const result = computePeriodicBalanceNeeds(selectedDates, includedDayFees, hourlyRows);
  if (result.empty || !result.summary) {
    return { available: false, reason: 'Data rekonsiliasi ditemukan tapi kosong (tidak ada transaksi FP tercatat).', window_days: windowDays, start_date: startDate, end_date: endDate };
  }

  // Business date TERAKHIR yang punya batch di window -- dipakai deteksi
  // STALE_DATA sisi rekonsiliasi (terpisah dari staleness snapshot saldo).
  // Granularitas hari (bukan timestamp synced_at) sengaja dipakai supaya
  // tidak perlu query kolom tambahan -- business_date sudah tersedia dari
  // getActiveBatchesForPeriod yang di-reuse.
  const latestBatch = batches.reduce((latest, b) => (!latest || b.business_date > latest.business_date ? b : latest), null);
  const todayJakarta = isoDateInJakarta(now);
  const daysSinceRecon = latestBatch ? Math.round((Date.parse(todayJakarta) - Date.parse(latestBatch.business_date)) / 86400000) : null;

  return {
    available: true,
    window_days: windowDays,
    start_date: startDate,
    end_date: endDate,
    coverage: result.coverage,
    average_burn_rate: result.summary.average_balance_need_per_day, // Rp/hari
    peak_burn_rate: result.summary.maximum_daily_need,               // Rp/hari (hari terberat dalam window)
    peak_burn_rate_date: result.summary.maximum_daily_need_date,
    total_balance_need_window: result.summary.total_balance_need,
    latest_reconciliation_business_date: latestBatch ? latestBatch.business_date : null,
    latest_reconciliation_age_minutes: daysSinceRecon !== null ? daysSinceRecon * 1440 : null,
  };
}

/** Pembulatan ke atas ke kelipatan `roundTo` (Rupiah) -- topup_rounding_amount Finance. Tanpa floating point (pakai Math.ceil pada rasio, aman krn nominal Rupiah tidak butuh presisi sub-rupiah). */
function roundUpToNearest(amount, roundTo) {
  const a = Number(amount) || 0;
  const r = Number(roundTo);
  if (!Number.isFinite(r) || r <= 0) return a;
  return Math.ceil(a / r) * r;
}

/**
 * Resolusi precedence per field: 1) manual override valid (angka >
 * ambang minimal masuk akal, di sini cukup "bukan null & bukan negatif")
 * 2) nilai dynamic dari forecast  3) null (berkontribusi ke CONFIGURATION_REQUIRED).
 * Return jejak sumber tiap field ("MANUAL_OVERRIDE"/"SYSTEM_FORECAST"/null)
 * supaya UI bisa label transparan (spec: label Finance Policy vs System
 * Forecast vs Manual Override vs Actual Balance).
 */
function resolveThresholdField(manualValue, dynamicValue) {
  const manual = manualValue !== null && manualValue !== undefined && manualValue !== '' ? Number(manualValue) : null;
  if (manual !== null && Number.isFinite(manual) && manual >= 0) {
    return { value: manual, source: 'MANUAL_OVERRIDE' };
  }
  if (dynamicValue !== null && dynamicValue !== undefined && Number.isFinite(dynamicValue)) {
    return { value: dynamicValue, source: 'SYSTEM_FORECAST' };
  }
  return { value: null, source: null };
}

/**
 * Formula wajib (spec): recommended_topup = forecast_required_balance +
 * dynamic_reserve_balance + safety_buffer - effective_balance. Tidak pernah
 * negatif, dibulatkan ke atas via topup_rounding_amount.
 */
function computeRecommendedTopup({ forecastRequiredBalance, dynamicReserveBalance, safetyBuffer, effectiveBalance, topupRoundingAmount }) {
  const raw = (Number(forecastRequiredBalance) || 0) + (Number(dynamicReserveBalance) || 0) + (Number(safetyBuffer) || 0) - (Number(effectiveBalance) || 0);
  const clamped = Math.max(0, raw);
  if (clamped === 0) return 0;
  return topupRoundingAmount ? roundUpToNearest(clamped, topupRoundingAmount) : clamped;
}

/**
 * Bangun full output model per spec utk satu bank account. Fungsi PURE
 * (tidak query DB sendiri) -- caller (route) yang mengumpulkan
 * snapshot/previousSnapshot/policy/burnStats lalu memanggil ini. Dipisah dari
 * DB access supaya gampang di-unit-test tanpa mocking pool.
 */
function buildForecastOutput({ snapshot, previousSnapshot, policy, burnStats, bankCode, suddenDrop = null, now = new Date() }) {
  const effectiveBalance = snapshot ? Number(snapshot.effective_balance) : null;
  const availableBalance = snapshot ? Number(snapshot.available_balance) : null;

  const forecastAvailable = !!(burnStats && burnStats.available);
  const averageBurnRate = forecastAvailable ? Number(burnStats.average_burn_rate) || 0 : null;
  const peakBurnRate = forecastAvailable ? Number(burnStats.peak_burn_rate) || 0 : null;

  // Runway -- burn 0 ATAU tidak ada forecast -> null (BUKAN Infinity/divide-by-zero).
  const burnPerMinute = forecastAvailable && averageBurnRate > 0 ? averageBurnRate / 1440 : null;
  const estimatedRunwayMinutes = (burnPerMinute && effectiveBalance !== null)
    ? (effectiveBalance > 0 ? effectiveBalance / burnPerMinute : 0)
    : null;

  const fundingWindowHours = (policy?.funding_window_hours !== null && policy?.funding_window_hours !== undefined)
    ? Number(policy.funding_window_hours) : DEFAULT_FUNDING_WINDOW_HOURS;
  const fundingWindowIsDefault = !(policy?.funding_window_hours !== null && policy?.funding_window_hours !== undefined);
  const fundingWindowMinutes = fundingWindowHours * 60;

  // forecast_required_balance -- kebutuhan dana sampai funding window berikutnya, prorata dari average_burn_rate harian.
  const forecastRequiredBalance = forecastAvailable ? (averageBurnRate * fundingWindowHours) / 24 : null;
  const projectedBalanceAtNextFunding = (forecastAvailable && effectiveBalance !== null)
    ? effectiveBalance - forecastRequiredBalance : null;

  // dynamic_reserve_balance -- buffer volatilitas murni dari data (peak - average), TIDAK dikarang.
  // Dinaikkan (uplift) via safety_buffer_percentage Finance KALAU diisi (opsional, bukan wajib).
  const safetyBufferPct = policy?.safety_buffer_percentage !== null && policy?.safety_buffer_percentage !== undefined
    ? Number(policy.safety_buffer_percentage) : 0;
  const volatilityReserve = forecastAvailable ? Math.max(0, peakBurnRate - averageBurnRate) : null;
  const dynamicReserveBalanceComputed = forecastAvailable ? volatilityReserve * (1 + safetyBufferPct / 100) : null;
  const reserveResolved = resolveThresholdField(policy?.reserve_balance, dynamicReserveBalanceComputed);
  const dynamicReserveBalance = reserveResolved.value;

  // Cascade critical -> emergency -> watch, semua REUSE dynamicReserveBalance/forecastRequiredBalance yang sama (no double count).
  const dynamicCriticalComputed = forecastAvailable ? forecastRequiredBalance + (dynamicReserveBalance || 0) : null;
  const criticalResolved = resolveThresholdField(
    policy?.critical_threshold !== null && policy?.critical_threshold !== undefined ? policy.critical_threshold : policy?.absolute_minimum_balance,
    dynamicCriticalComputed,
  );
  const dynamicCriticalThreshold = criticalResolved.value;

  const dynamicEmergencyComputed = (forecastAvailable && dynamicCriticalThreshold !== null)
    ? Math.max(0, dynamicCriticalThreshold - averageBurnRate) : null;
  const emergencyResolved = resolveThresholdField(policy?.emergency_threshold, dynamicEmergencyComputed);
  const dynamicEmergencyThreshold = emergencyResolved.value;

  const safetyBufferAmount = (dynamicCriticalThreshold !== null) ? dynamicCriticalThreshold * (safetyBufferPct / 100) : 0;
  const dynamicWatchComputed = (dynamicCriticalThreshold !== null)
    ? dynamicCriticalThreshold + (dynamicReserveBalance || 0) + safetyBufferAmount : null;
  const watchResolved = resolveThresholdField(policy?.watch_threshold, dynamicWatchComputed);
  const dynamicWatchThreshold = watchResolved.value;

  const recommendedTopupAmount = (effectiveBalance !== null && forecastAvailable)
    ? computeRecommendedTopup({
      forecastRequiredBalance, dynamicReserveBalance: dynamicReserveBalance || 0, safetyBuffer: safetyBufferAmount,
      effectiveBalance, topupRoundingAmount: policy?.topup_rounding_amount,
    })
    : null;
  const recommendedTopupDeadline = (recommendedTopupAmount > 0 && estimatedRunwayMinutes !== null)
    ? new Date(now.getTime() + estimatedRunwayMinutes * 60000).toISOString() : null;

  return {
    latest_balance: availableBalance,
    available_balance: availableBalance,
    effective_balance: effectiveBalance,
    absolute_minimum_balance: policy?.absolute_minimum_balance !== null && policy?.absolute_minimum_balance !== undefined ? Number(policy.absolute_minimum_balance) : null,
    forecast_required_balance: forecastRequiredBalance,
    projected_balance_at_next_funding: projectedBalanceAtNextFunding,
    estimated_runway_minutes: estimatedRunwayMinutes,
    average_burn_rate: averageBurnRate,
    peak_burn_rate: peakBurnRate,
    dynamic_reserve_balance: dynamicReserveBalance,
    dynamic_watch_threshold: dynamicWatchThreshold,
    dynamic_critical_threshold: dynamicCriticalThreshold,
    dynamic_emergency_threshold: dynamicEmergencyThreshold,
    recommended_topup_amount: recommendedTopupAmount,
    recommended_topup_deadline: recommendedTopupDeadline,
    // sudden_drop_* -- REUSE hasil evaluateSuddenDrop() (balanceControlTower.js) yang di-passing dari caller,
    // BUKAN dihitung ulang di sini (hindari circular require & duplikasi logic).
    sudden_drop_amount: suddenDrop ? suddenDrop.dropAmount : null,
    sudden_drop_percentage: suddenDrop ? suddenDrop.dropPercentage : null,
    forecast_confidence: computeForecastConfidence({ burnStats, fundingWindowIsDefault }),
    forecast_generated_at: now.toISOString(),
    forecast_source: forecastAvailable ? `${bankCode}_RECONCILIATION` : null,
    funding_window_hours: fundingWindowHours,
    funding_window_is_default: fundingWindowIsDefault,
    forecast_available: forecastAvailable,
    forecast_unavailable_reason: forecastAvailable ? null : (burnStats?.reason || 'Belum ada data rekonsiliasi.'),
    latest_reconciliation_business_date: forecastAvailable ? burnStats.latest_reconciliation_business_date : null,
    latest_reconciliation_age_minutes: forecastAvailable ? burnStats.latest_reconciliation_age_minutes : null,
    thresholds_source: {
      reserve: reserveResolved.source, critical: criticalResolved.source,
      emergency: emergencyResolved.source, watch: watchResolved.source,
    },
    calculation: {
      average_burn_rate_formula: 'rata-rata kebutuhan dana harian (principal + expected fee) dari tab Kebutuhan Saldo Rekonsiliasi, trailing window',
      forecast_required_balance_formula: 'average_burn_rate x (funding_window_hours / 24)',
      dynamic_reserve_balance_formula: 'max(0, peak_burn_rate - average_burn_rate) x (1 + safety_buffer_percentage/100), kecuali Finance set reserve_balance manual',
      dynamic_critical_threshold_formula: 'forecast_required_balance + dynamic_reserve_balance, kecuali Finance set critical_threshold/absolute_minimum_balance manual',
      dynamic_emergency_threshold_formula: 'max(0, dynamic_critical_threshold - average_burn_rate), kecuali Finance set emergency_threshold manual',
      dynamic_watch_threshold_formula: 'dynamic_critical_threshold + dynamic_reserve_balance + (dynamic_critical_threshold x safety_buffer_percentage/100), kecuali Finance set watch_threshold manual',
      recommended_topup_formula: 'forecast_required_balance + dynamic_reserve_balance + safety_buffer - effective_balance (minimum 0, dibulatkan ke atas via topup_rounding_amount)',
      window_days: burnStats?.window_days || null,
      coverage: burnStats?.coverage || null,
    },
  };
}

function computeForecastConfidence({ burnStats, fundingWindowIsDefault }) {
  if (!burnStats || !burnStats.available) return 0;
  const included = burnStats.coverage?.included_days || 0;
  const selected = burnStats.coverage?.selected_days || 1;
  let score = Math.round((included / selected) * 100);
  if (fundingWindowIsDefault) score = Math.max(0, score - 15); // funding window belum diisi Finance -> confidence diturunkan, bukan status diblokir.
  return Math.max(0, Math.min(100, score));
}

module.exports = {
  DEFAULT_FORECAST_WINDOW_DAYS,
  DEFAULT_FUNDING_WINDOW_HOURS,
  computeBurnRateStats,
  buildForecastOutput,
  resolveThresholdField,
  computeRecommendedTopup,
  roundUpToNearest,
  computeForecastConfidence,
};
