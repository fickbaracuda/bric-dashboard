'use strict';

/**
 * Balance Control Tower — Funding Scheduler Adjustment Assistant.
 * Mesin kalkulasi PURE (tanpa DB) — dipanggil route (fundingSchedulerDataAccess.js)
 * & test (backend/scripts/test-funding-scheduler.js). ADVISORY ONLY: fungsi di
 * sini TIDAK PERNAH mengeksekusi transfer/cancel scheduler bank — hanya
 * menghasilkan angka & rekomendasi untuk keputusan manual FA.
 *
 * Semua nominal diterima/dikembalikan sebagai Number (bukan string) — kolom
 * DB tetap NUMERIC(18,2), pembulatan uang final tetap tanggung jawab
 * pemanggil/format tampilan (Intl.NumberFormat di frontend).
 */

const JAKARTA_TZ = 'Asia/Jakarta';

const RECOMMENDATION = {
  CANCEL: 'CANCEL',
  REDUCE: 'REDUCE',
  KEEP: 'KEEP',
  ADD: 'ADD',
  NO_UPCOMING_SCHEDULER: 'NO_UPCOMING_SCHEDULER',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  DATA_STALE: 'DATA_STALE',
};

const PLAN_STATUS = {
  ABOVE_PLAN: 'ABOVE_PLAN',
  BELOW_PLAN: 'BELOW_PLAN',
  ON_PLAN: 'ON_PLAN',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
};

// Status scheduler yang masih dianggap "akan terjadi" (bisa jadi kandidat
// next scheduler / ikut dihitung sbg confirmed inflow). MISSED/CANCELLED/
// COMPLETED sengaja TIDAK masuk sini.
const UPCOMING_SCHEDULER_STATUSES = new Set(['SCHEDULED', 'CONFIRMED', 'ADJUSTED']);
const CONFIRMED_INFLOW_STATUSES = new Set(['CONFIRMED', 'COMPLETED']);

function round2(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}
function isNum(v) {
  return v !== null && v !== undefined && Number.isFinite(Number(v));
}

/** Jam & menit wall-clock Asia/Jakarta dari sebuah Date (instant UTC apa pun). */
function getJakartaParts(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: JAKARTA_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const hour = parseInt(parts.hour, 10) % 24; // '24' tengah malam -> 0
  const minute = parseInt(parts.minute, 10);
  const second = parseInt(parts.second, 10);
  return { hour, minute, second, minutesOfDay: hour * 60 + minute };
}

/** 'HH:mm' atau 'HH:mm:ss' -> menit sejak 00:00. null kalau format tidak valid. */
function timeStringToMinutes(timeStr) {
  if (!timeStr) return null;
  const m = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}
function minutesToTimeString(minutes) {
  if (!isNum(minutes)) return null;
  const h = Math.floor(minutes / 60) % 24;
  const mi = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/**
 * Cari row hourly plan untuk jam tertentu. `hourlyPlan`: [{ hour_of_day,
 * average_burn, planned_balance }]. Return null kalau tidak ada barisnya
 * sama sekali (BUKAN 0 -- 0 berarti baris ada dgn nilai nol yang valid).
 */
function findHourPlan(hourlyPlan, hour) {
  if (!Array.isArray(hourlyPlan)) return null;
  return hourlyPlan.find(r => Number(r.hour_of_day) === hour) || null;
}

/**
 * Variance actual vs planned balance jam berjalan (spec section 7/8).
 * tolerance default Rp10.000.000 kalau tidak diberikan.
 */
function computePlanVariance({ actualBalance, plannedBalance, tolerance = 10000000 }) {
  if (!isNum(actualBalance) || !isNum(plannedBalance)) {
    return { variance: null, variance_pct: null, status: PLAN_STATUS.INSUFFICIENT_DATA };
  }
  const variance = round2(Number(actualBalance) - Number(plannedBalance));
  const variancePct = Number(plannedBalance) !== 0 ? round2((variance / Number(plannedBalance)) * 100) : null;
  const tol = isNum(tolerance) ? Number(tolerance) : 10000000;
  let status;
  if (Math.abs(variance) <= tol) status = PLAN_STATUS.ON_PLAN;
  else if (variance > tol) status = PLAN_STATUS.ABOVE_PLAN;
  else status = PLAN_STATUS.BELOW_PLAN;
  return { variance, variance_pct: variancePct, status };
}

/**
 * Scheduler berikutnya SETELAH waktu berjalan (spec section 9). `schedulers`:
 * [{ id, scheduled_time: 'HH:mm', funding_source_code, scheduled_amount, status }].
 * Scheduler yang statusnya bukan SCHEDULED/CONFIRMED/ADJUSTED TIDAK dianggap
 * kandidat (sudah selesai/batal/lewat tanpa realisasi). Kalau ada >=2 baris
 * PERSIS di menit yang sama (duplicate), ditandai `duplicate: true` supaya
 * caller bisa fail-safe (INSUFFICIENT_DATA) alih-alih diam-diam pilih salah satu.
 */
function findNextScheduler(schedulers, currentMinutesOfDay) {
  if (!Array.isArray(schedulers) || !schedulers.length) return { scheduler: null, duplicate: false };
  const candidates = schedulers
    .filter(s => UPCOMING_SCHEDULER_STATUSES.has(String(s.status || '').toUpperCase()))
    .map(s => ({ ...s, _minutes: timeStringToMinutes(s.scheduled_time) }))
    .filter(s => s._minutes !== null && s._minutes > currentMinutesOfDay)
    .sort((a, b) => a._minutes - b._minutes);
  if (!candidates.length) return { scheduler: null, duplicate: false };
  const earliestMinutes = candidates[0]._minutes;
  const atEarliest = candidates.filter(c => c._minutes === earliestMinutes);
  return { scheduler: candidates[0], duplicate: atEarliest.length > 1 };
}

/**
 * Burn sampai next scheduler (spec section 10) = sisa jam berjalan
 * (proporsional menit tersisa) + penuh untuk tiap jam DI ANTARA jam berjalan
 * dan jam scheduler berikutnya (TIDAK termasuk jam scheduler itu sendiri --
 * funding dianggap masuk di awal jam itu, sebelum burn jam itu terjadi).
 * Return { value, missingHours } -- missingHours berisi jam mana yang
 * average_burn-nya null/hilang (dipakai caller utk INSUFFICIENT_DATA).
 */
function computeBurnUntilNextScheduler({ hourlyPlan, currentHour, currentMinute, nextSchedulerHour }) {
  const missingHours = [];
  const currentRow = findHourPlan(hourlyPlan, currentHour);
  if (!currentRow || !isNum(currentRow.average_burn)) missingHours.push(currentHour);
  const remainingRatio = (60 - currentMinute) / 60;
  let total = (currentRow && isNum(currentRow.average_burn)) ? Number(currentRow.average_burn) * remainingRatio : 0;

  // Jam penuh di antara (currentHour, nextSchedulerHour) eksklusif kedua ujung.
  // Support lintas tengah malam (nextSchedulerHour < currentHour secara jam
  // absolut tidak terjadi di sini karena caller sudah pastikan next scheduler
  // > current time di hari yang sama; loop biasa 24 jam cukup untuk MVP ini).
  for (let h = currentHour + 1; h < nextSchedulerHour; h++) {
    const row = findHourPlan(hourlyPlan, h);
    if (!row || !isNum(row.average_burn)) { missingHours.push(h); continue; }
    total += Number(row.average_burn);
  }
  return { value: missingHours.length ? null : round2(total), missingHours };
}

/**
 * Total funding CONFIRMED/COMPLETED yang jatuh strictly di antara sekarang
 * dan next scheduler (spec section 10 -- "kalau ada funding yang sudah
 * CONFIRMED ... masukkan actual/confirmed inflow"). excludeId supaya next
 * scheduler itu sendiri tidak ikut terhitung dobel sbg inflow.
 */
function sumConfirmedInflowsBetween({ schedulers, currentMinutesOfDay, nextSchedulerMinutes, excludeId }) {
  if (!Array.isArray(schedulers)) return 0;
  let total = 0;
  for (const s of schedulers) {
    if (s.id === excludeId) continue;
    if (!CONFIRMED_INFLOW_STATUSES.has(String(s.status || '').toUpperCase())) continue;
    const minutes = timeStringToMinutes(s.scheduled_time);
    if (minutes === null || minutes <= currentMinutesOfDay || minutes >= nextSchedulerMinutes) continue;
    if (isNum(s.scheduled_amount)) total += Number(s.scheduled_amount);
  }
  return round2(total);
}

/** projected_balance_before_next (spec section 11). */
function computeProjectedBalanceBeforeNext({ actualBalance, burnUntilNext, confirmedInflows = 0 }) {
  if (!isNum(actualBalance) || !isNum(burnUntilNext)) return null;
  return round2(Number(actualBalance) - Number(burnUntilNext) + (isNum(confirmedInflows) ? Number(confirmedInflows) : 0));
}

/** required_funding = MAX(0, target - projected) (spec section 13). */
function computeRequiredFunding({ targetBalance, projectedBalance }) {
  if (!isNum(targetBalance) || !isNum(projectedBalance)) return null;
  return round2(Math.max(0, Number(targetBalance) - Number(projectedBalance)));
}

/**
 * Decision engine CANCEL/REDUCE/KEEP/ADD (spec section 15). `schedulerTolerance`
 * default Rp10.000.000. Tangga keputusan MUTUALLY EXCLUSIVE & EXHAUSTIVE:
 *   CANCEL  : required <= tolerance
 *   REDUCE  : required > tolerance  DAN required < existing - tolerance
 *   KEEP    : |required - existing| <= tolerance
 *   ADD     : required > existing + tolerance
 * (fallback KEEP kalau tidak ada satupun match -- seharusnya tidak pernah
 * tercapai secara matematis, cuma jaring pengaman presisi float.)
 */
function calculateSchedulerRecommendation({ requiredFunding, existingSchedulerAmount, schedulerTolerance = 10000000 }) {
  if (!isNum(requiredFunding) || !isNum(existingSchedulerAmount)) {
    return { recommendation: RECOMMENDATION.INSUFFICIENT_DATA, adjustment_amount: null, reason: 'Data kebutuhan funding atau nominal scheduler existing belum lengkap.' };
  }
  const required = Number(requiredFunding);
  const existing = Number(existingSchedulerAmount);
  const tol = isNum(schedulerTolerance) ? Number(schedulerTolerance) : 10000000;

  if (required <= tol) {
    return {
      recommendation: RECOMMENDATION.CANCEL, adjustment_amount: round2(-existing),
      reason: 'Saldo diproyeksikan sudah mencukupi tanpa tambahan funding.',
    };
  }
  if (required < existing - tol) {
    const reduction = round2(existing - required);
    return {
      recommendation: RECOMMENDATION.REDUCE, adjustment_amount: round2(-reduction),
      reason: `Kebutuhan funding diperkirakan hanya Rp${Math.round(required).toLocaleString('id-ID')}. Saran: kurangi scheduler sebesar Rp${Math.round(reduction).toLocaleString('id-ID')}.`,
    };
  }
  if (Math.abs(required - existing) <= tol) {
    return {
      recommendation: RECOMMENDATION.KEEP, adjustment_amount: 0,
      reason: 'Scheduler sudah sesuai. Tidak perlu perubahan.',
    };
  }
  if (required > existing + tol) {
    const addition = round2(required - existing);
    return {
      recommendation: RECOMMENDATION.ADD, adjustment_amount: round2(addition),
      reason: `Kebutuhan funding diperkirakan Rp${Math.round(required).toLocaleString('id-ID')}, melebihi scheduler saat ini. Saran: tambahkan funding sebesar Rp${Math.round(addition).toLocaleString('id-ID')}.`,
    };
  }
  // Jaring pengaman (tidak boleh tercapai secara matematis) -- default aman: KEEP.
  return { recommendation: RECOMMENDATION.KEEP, adjustment_amount: 0, reason: 'Scheduler sudah sesuai. Tidak perlu perubahan.' };
}

/**
 * Status tampilan scheduler di timeline (spec section 21/23) -- DERIVED,
 * bukan kolom DB terpisah: entry yang waktunya sudah lewat & statusnya masih
 * SCHEDULED/CONFIRMED/ADJUSTED (belum ditandai eksplisit CANCELLED/MISSED
 * oleh admin/FA) ditampilkan "COMPLETED" (diasumsikan berjalan sesuai
 * rencana -- BRIC tidak punya feed konfirmasi eksekusi transfer bank
 * real-time, lihat Known Limitations di dokumentasi).
 */
function deriveSchedulerDisplayStatus(scheduler, currentMinutesOfDay) {
  const status = String(scheduler.status || '').toUpperCase();
  if (status === 'CANCELLED' || status === 'MISSED' || status === 'COMPLETED') return status;
  const minutes = timeStringToMinutes(scheduler.scheduled_time);
  if (minutes !== null && minutes <= currentMinutesOfDay) return 'COMPLETED';
  return 'UPCOMING';
}

/**
 * Orkestrasi PURE penuh (spec section 2 "Core Concept" & section 31). Entry
 * point utama dipanggil route/data-access layer.
 *
 * Input:
 *   now                    Date (instant UTC apa pun, dikonversi ke Asia/Jakarta di sini)
 *   hourlyPlan              [{ hour_of_day, average_burn, planned_balance }]
 *   schedulers               [{ id, scheduled_time, funding_source_code, scheduled_amount, status }]
 *   actualBalance             Number|null
 *   actualBalanceStale        Boolean -- true kalau resolver saldo existing bilang data basi
 *   planVarianceTolerance     Number, default 10_000_000
 *   schedulerTolerance        Number, default 10_000_000
 *
 * Output: lihat komentar return di akhir fungsi.
 */
function calculateFundingSchedulerAssistant({
  now = new Date(),
  hourlyPlan = [],
  schedulers = [],
  actualBalance = null,
  actualBalanceStale = false,
  planVarianceTolerance = 10000000,
  schedulerTolerance = 10000000,
}) {
  const { hour, minute, minutesOfDay } = getJakartaParts(now);
  const currentRow = findHourPlan(hourlyPlan, hour);

  const missingFields = [];
  if (!isNum(actualBalance)) missingFields.push('actual_balance');
  if (!currentRow) missingFields.push(`hourly_plan[hour=${hour}]`);
  else {
    if (!isNum(currentRow.average_burn)) missingFields.push(`hourly_plan[hour=${hour}].average_burn`);
    if (!isNum(currentRow.planned_balance)) missingFields.push(`hourly_plan[hour=${hour}].planned_balance`);
  }

  // ── STALE menang di atas segalanya (spec section 5/6) ──
  if (actualBalanceStale) {
    return {
      current_time: minutesToTimeString(minutesOfDay),
      current_hour: hour,
      current_plan: currentRow ? {
        hour, planned_balance: isNum(currentRow.planned_balance) ? Number(currentRow.planned_balance) : null,
        average_burn: isNum(currentRow.average_burn) ? Number(currentRow.average_burn) : null,
        variance: null, variance_pct: null, status: PLAN_STATUS.INSUFFICIENT_DATA,
      } : null,
      next_scheduler: null,
      recommendation: RECOMMENDATION.DATA_STALE,
      reason: 'Saldo berjalan basi (stale) menurut kebijakan Balance Control Tower. Rekomendasi scheduler tidak dapat dihitung sampai data saldo tersegarkan.',
      missing_fields: [],
    };
  }

  if (missingFields.length) {
    return {
      current_time: minutesToTimeString(minutesOfDay),
      current_hour: hour,
      current_plan: currentRow ? {
        hour,
        planned_balance: isNum(currentRow.planned_balance) ? Number(currentRow.planned_balance) : null,
        average_burn: isNum(currentRow.average_burn) ? Number(currentRow.average_burn) : null,
        variance: null, variance_pct: null, status: PLAN_STATUS.INSUFFICIENT_DATA,
      } : null,
      next_scheduler: null,
      recommendation: RECOMMENDATION.INSUFFICIENT_DATA,
      reason: `Data belum lengkap untuk menghitung rekomendasi: ${missingFields.join(', ')}.`,
      missing_fields: missingFields,
    };
  }

  const plannedBalance = Number(currentRow.planned_balance);
  const averageBurn = Number(currentRow.average_burn);
  const { variance, variance_pct, status: planStatus } = computePlanVariance({
    actualBalance, plannedBalance, tolerance: planVarianceTolerance,
  });

  const currentPlan = { hour, planned_balance: plannedBalance, average_burn: averageBurn, variance, variance_pct, status: planStatus };

  const { scheduler: nextRaw, duplicate } = findNextScheduler(schedulers, minutesOfDay);
  if (!nextRaw) {
    return {
      current_time: minutesToTimeString(minutesOfDay), current_hour: hour, current_plan: currentPlan,
      next_scheduler: null, recommendation: RECOMMENDATION.NO_UPCOMING_SCHEDULER,
      reason: 'Tidak ada scheduler funding tersisa hari ini setelah waktu berjalan.', missing_fields: [],
    };
  }
  if (duplicate) {
    return {
      current_time: minutesToTimeString(minutesOfDay), current_hour: hour, current_plan: currentPlan,
      next_scheduler: null, recommendation: RECOMMENDATION.INSUFFICIENT_DATA,
      reason: `Ditemukan lebih dari satu scheduler aktif pada jam ${nextRaw.scheduled_time} — perlu diperbaiki sebelum rekomendasi dapat dihitung.`,
      missing_fields: [`duplicate_scheduler_at_${nextRaw.scheduled_time}`],
    };
  }

  const nextMinutes = nextRaw._minutes;
  const nextHour = Math.floor(nextMinutes / 60);
  const targetRow = findHourPlan(hourlyPlan, nextHour);
  if (!targetRow || !isNum(targetRow.planned_balance)) {
    return {
      current_time: minutesToTimeString(minutesOfDay), current_hour: hour, current_plan: currentPlan,
      next_scheduler: {
        id: nextRaw.id, scheduled_time: nextRaw.scheduled_time, funding_source_code: nextRaw.funding_source_code,
        scheduled_amount: isNum(nextRaw.scheduled_amount) ? Number(nextRaw.scheduled_amount) : null, status: nextRaw.status,
      },
      recommendation: RECOMMENDATION.INSUFFICIENT_DATA,
      reason: `Target planned_balance untuk jam scheduler berikutnya (${nextRaw.scheduled_time}) belum tersedia di hourly plan.`,
      missing_fields: [`hourly_plan[hour=${nextHour}].planned_balance`],
    };
  }
  if (!isNum(nextRaw.scheduled_amount) || Number(nextRaw.scheduled_amount) < 0) {
    return {
      current_time: minutesToTimeString(minutesOfDay), current_hour: hour, current_plan: currentPlan,
      next_scheduler: {
        id: nextRaw.id, scheduled_time: nextRaw.scheduled_time, funding_source_code: nextRaw.funding_source_code,
        scheduled_amount: null, status: nextRaw.status,
      },
      recommendation: RECOMMENDATION.INSUFFICIENT_DATA,
      reason: `Nominal scheduler ${nextRaw.scheduled_time} tidak valid.`,
      missing_fields: [`scheduler[${nextRaw.id}].scheduled_amount`],
    };
  }

  const { value: burnUntilNext, missingHours } = computeBurnUntilNextScheduler({
    hourlyPlan, currentHour: hour, currentMinute: minute, nextSchedulerHour: nextHour,
  });
  if (burnUntilNext === null) {
    return {
      current_time: minutesToTimeString(minutesOfDay), current_hour: hour, current_plan: currentPlan,
      next_scheduler: {
        id: nextRaw.id, scheduled_time: nextRaw.scheduled_time, funding_source_code: nextRaw.funding_source_code,
        scheduled_amount: Number(nextRaw.scheduled_amount), status: nextRaw.status,
      },
      recommendation: RECOMMENDATION.INSUFFICIENT_DATA,
      reason: `average_burn belum lengkap untuk jam: ${missingHours.join(', ')}.`,
      missing_fields: missingHours.map(h => `hourly_plan[hour=${h}].average_burn`),
    };
  }

  const confirmedInflows = sumConfirmedInflowsBetween({
    schedulers, currentMinutesOfDay: minutesOfDay, nextSchedulerMinutes: nextMinutes, excludeId: nextRaw.id,
  });
  const projectedBalanceBeforeNext = computeProjectedBalanceBeforeNext({ actualBalance, burnUntilNext, confirmedInflows });
  const targetBalanceAfterNext = Number(targetRow.planned_balance);
  const requiredFunding = computeRequiredFunding({ targetBalance: targetBalanceAfterNext, projectedBalance: projectedBalanceBeforeNext });
  const existingSchedulerAmount = Number(nextRaw.scheduled_amount);
  const { recommendation, adjustment_amount, reason } = calculateSchedulerRecommendation({
    requiredFunding, existingSchedulerAmount, schedulerTolerance,
  });

  return {
    current_time: minutesToTimeString(minutesOfDay),
    current_hour: hour,
    current_plan: currentPlan,
    next_scheduler: {
      id: nextRaw.id,
      scheduled_time: nextRaw.scheduled_time,
      funding_source_code: nextRaw.funding_source_code,
      scheduled_amount: existingSchedulerAmount,
      status: nextRaw.status,
      target_hour: nextHour,
      target_planned_balance: targetBalanceAfterNext,
      burn_until_next: burnUntilNext,
      confirmed_inflows_before_next: confirmedInflows,
      projected_balance_before: projectedBalanceBeforeNext,
      required_funding: requiredFunding,
      adjustment_amount,
      recommendation,
      recommendation_reason: reason,
    },
    recommendation,
    reason,
    missing_fields: [],
  };
}

/**
 * Data quality check (spec section 29/4) -- validasi ANOMALY DETECTION saja,
 * TIDAK PERNAH dipakai untuk menimpa planned_balance source of truth.
 * previousPlanned - expectedBurn + schedulerAmount ≈ currentPlanned.
 */
function validateBaselineFormula({ previousPlanned, expectedBurn, schedulerAmount = 0, currentPlanned, toleranceRp = 1000 }) {
  if (![previousPlanned, expectedBurn, currentPlanned].every(isNum)) {
    return { valid: null, computed: null, diff: null, reason: 'Data tidak lengkap untuk validasi.' };
  }
  const computed = round2(Number(previousPlanned) - Number(expectedBurn) + (isNum(schedulerAmount) ? Number(schedulerAmount) : 0));
  const diff = round2(computed - Number(currentPlanned));
  return { valid: Math.abs(diff) <= toleranceRp, computed, diff, reason: null };
}

module.exports = {
  JAKARTA_TZ,
  RECOMMENDATION,
  PLAN_STATUS,
  UPCOMING_SCHEDULER_STATUSES,
  CONFIRMED_INFLOW_STATUSES,
  getJakartaParts,
  timeStringToMinutes,
  minutesToTimeString,
  findHourPlan,
  computePlanVariance,
  findNextScheduler,
  computeBurnUntilNextScheduler,
  sumConfirmedInflowsBetween,
  computeProjectedBalanceBeforeNext,
  computeRequiredFunding,
  calculateSchedulerRecommendation,
  deriveSchedulerDisplayStatus,
  calculateFundingSchedulerAssistant,
  validateBaselineFormula,
};
