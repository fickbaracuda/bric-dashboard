'use strict';

/**
 * Balance & Funding — Decision Engine.
 *
 * PURE — tidak menyentuh DB, tidak menyentuh Balance Control Tower lama sama
 * sekali (tidak ada import dari backend/src/balanceControlTower/). Formula
 * di sini ditulis independen dari fundingSchedulerEngine.js (BCT) walau
 * secara konsep serupa (kedua fitur sama-sama menjawab pertanyaan bisnis
 * "CANCEL/REDUCE/KEEP/ADD scheduler funding berikutnya") — TIDAK ADA baris
 * kode yang di-share/di-import lintas kedua modul.
 *
 * ADVISORY ONLY: fungsi di sini TIDAK PERNAH mengeksekusi transfer/cancel
 * scheduler bank — hanya menghasilkan angka & rekomendasi.
 */

const JAKARTA_TZ = 'Asia/Jakarta';

const RECOMMENDATION = {
  CANCEL: 'CANCEL',
  REDUCE: 'REDUCE',
  KEEP: 'KEEP',
  ADD: 'ADD',
  NO_UPCOMING_SCHEDULER: 'NO_UPCOMING_SCHEDULER',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  BALANCE_UNAVAILABLE: 'BALANCE_UNAVAILABLE',
  BALANCE_STALE: 'BALANCE_STALE',
  BALANCE_UNVERIFIED: 'BALANCE_UNVERIFIED',
};

const PLAN_STATUS = {
  ABOVE_PLAN: 'ABOVE_PLAN',
  BELOW_PLAN: 'BELOW_PLAN',
  ON_PLAN: 'ON_PLAN',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
};

const UPCOMING_STATUSES = new Set(['SCHEDULED', 'CONFIRMED', 'ADJUSTED']);
const CONFIRMED_INFLOW_STATUSES = new Set(['CONFIRMED', 'COMPLETED']);

function round2(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}
function isNum(v) {
  return v !== null && v !== undefined && Number.isFinite(Number(v));
}

function getJakartaParts(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: JAKARTA_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const hour = parseInt(parts.hour, 10) % 24;
  const minute = parseInt(parts.minute, 10);
  return { hour, minute, minutesOfDay: hour * 60 + minute };
}
function jakartaBusinessDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: JAKARTA_TZ }).format(date);
}
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

function findHourPlan(hourlyPlan, hour) {
  if (!Array.isArray(hourlyPlan)) return null;
  return hourlyPlan.find(r => Number(r.hour_of_day) === hour) || null;
}

/** Variance actual vs planned balance jam berjalan (spec section 15/16). */
function calculateVariance({ actualBalance, plannedBalance, tolerance = 10000000 }) {
  if (!isNum(actualBalance) || !isNum(plannedBalance)) {
    return { variance: null, variance_pct: null, status: PLAN_STATUS.INSUFFICIENT_DATA };
  }
  const variance = round2(Number(actualBalance) - Number(plannedBalance));
  const variancePct = Number(plannedBalance) !== 0 ? round2((variance / Number(plannedBalance)) * 100) : null;
  const tol = isNum(tolerance) ? Number(tolerance) : 10000000;
  let status;
  if (variance > tol) status = PLAN_STATUS.ABOVE_PLAN;
  else if (variance < -tol) status = PLAN_STATUS.BELOW_PLAN;
  else status = PLAN_STATUS.ON_PLAN;
  return { variance, variance_pct: variancePct, status };
}

/**
 * Scheduler berikutnya utk TARGET BANK tertentu (spec section 18) — hanya
 * scheduler milik `target_bank_code` yang sedang dilihat, TIDAK peduli
 * `funding_source_code`-nya bank apa (spec section 9: funding source ≠
 * target bank, scheduler valid lintas bank).
 */
function findNextSchedule(schedules, targetBankCode, currentMinutesOfDay) {
  if (!Array.isArray(schedules) || !schedules.length) return { schedule: null, duplicate: false };
  const candidates = schedules
    .filter(s => String(s.target_bank_code).toUpperCase() === String(targetBankCode).toUpperCase())
    .filter(s => UPCOMING_STATUSES.has(String(s.status || '').toUpperCase()))
    .map(s => ({ ...s, _minutes: timeStringToMinutes(s.scheduled_time) }))
    .filter(s => s._minutes !== null && s._minutes > currentMinutesOfDay)
    .sort((a, b) => a._minutes - b._minutes);
  if (!candidates.length) return { schedule: null, duplicate: false };
  const earliestMinutes = candidates[0]._minutes;
  const atEarliest = candidates.filter(c => c._minutes === earliestMinutes);
  return { schedule: candidates[0], duplicate: atEarliest.length > 1 };
}

/**
 * Burn sampai next scheduler (spec section 20) = sisa jam berjalan (proporsi
 * menit tersisa) + penuh utk tiap jam DI ANTARA jam berjalan & jam scheduler
 * (TIDAK termasuk jam scheduler itu sendiri). Return { value, missingHours }.
 */
function calculateBurnUntilNextSchedule({ hourlyPlan, currentHour, currentMinute, nextScheduleHour }) {
  const missingHours = [];
  const currentRow = findHourPlan(hourlyPlan, currentHour);
  if (!currentRow || !isNum(currentRow.nominal_average)) missingHours.push(currentHour);
  const remainingRatio = (60 - currentMinute) / 60;
  let total = (currentRow && isNum(currentRow.nominal_average)) ? Number(currentRow.nominal_average) * remainingRatio : 0;

  for (let h = currentHour + 1; h < nextScheduleHour; h++) {
    const row = findHourPlan(hourlyPlan, h);
    if (!row || !isNum(row.nominal_average)) { missingHours.push(h); continue; }
    total += Number(row.nominal_average);
  }
  return { value: missingHours.length ? null : round2(total), missingHours };
}

/** Funding CONFIRMED/COMPLETED lain (target bank sama) yang jatuh strictly di antara sekarang & next schedule. */
function sumConfirmedInflowsBetween({ schedules, targetBankCode, currentMinutesOfDay, nextScheduleMinutes, excludeId }) {
  if (!Array.isArray(schedules)) return 0;
  let total = 0;
  for (const s of schedules) {
    if (s.id === excludeId) continue;
    if (String(s.target_bank_code).toUpperCase() !== String(targetBankCode).toUpperCase()) continue;
    if (!CONFIRMED_INFLOW_STATUSES.has(String(s.status || '').toUpperCase())) continue;
    const minutes = timeStringToMinutes(s.scheduled_time);
    if (minutes === null || minutes <= currentMinutesOfDay || minutes >= nextScheduleMinutes) continue;
    if (isNum(s.scheduled_amount)) total += Number(s.scheduled_amount);
  }
  return round2(total);
}

/** projected_balance_before_next (spec section 21). */
function calculateProjectedBalance({ actualBalance, burnUntilNext, confirmedInflows = 0 }) {
  if (!isNum(actualBalance) || !isNum(burnUntilNext)) return null;
  return round2(Number(actualBalance) - Number(burnUntilNext) + (isNum(confirmedInflows) ? Number(confirmedInflows) : 0));
}

/** required_funding = MAX(0, target - projected) (spec section 23). */
function calculateRequiredFunding({ targetBalance, projectedBalance }) {
  if (!isNum(targetBalance) || !isNum(projectedBalance)) return null;
  return round2(Math.max(0, Number(targetBalance) - Number(projectedBalance)));
}

/**
 * Decision engine CANCEL/REDUCE/KEEP/ADD (spec section 25). Tangga MUTUALLY
 * EXCLUSIVE & EXHAUSTIVE:
 *   CANCEL : required <= tolerance
 *   REDUCE : required > tolerance  DAN required < existing - tolerance
 *   KEEP   : |required - existing| <= tolerance
 *   ADD    : required > existing + tolerance
 */
function calculateFundingRecommendation({ requiredFunding, existingScheduleAmount, schedulerTolerance = 10000000 }) {
  if (!isNum(requiredFunding) || !isNum(existingScheduleAmount)) {
    return { recommendation: RECOMMENDATION.INSUFFICIENT_DATA, adjustment_amount: null, reason: 'Data kebutuhan funding atau nominal scheduler existing belum lengkap.' };
  }
  const required = Number(requiredFunding);
  const existing = Number(existingScheduleAmount);
  const tol = isNum(schedulerTolerance) ? Number(schedulerTolerance) : 10000000;

  if (required <= tol) {
    return { recommendation: RECOMMENDATION.CANCEL, adjustment_amount: round2(-existing), reason: 'Saldo diproyeksikan sudah mencukupi tanpa tambahan funding.' };
  }
  if (required < existing - tol) {
    const reduction = round2(existing - required);
    return { recommendation: RECOMMENDATION.REDUCE, adjustment_amount: round2(-reduction), reason: `Scheduler berikutnya berpotensi terlalu besar. Kurangi sekitar Rp${Math.round(reduction).toLocaleString('id-ID')}.` };
  }
  if (Math.abs(required - existing) <= tol) {
    return { recommendation: RECOMMENDATION.KEEP, adjustment_amount: 0, reason: 'Scheduler berikutnya masih sesuai kebutuhan.' };
  }
  if (required > existing + tol) {
    const addition = round2(required - existing);
    return { recommendation: RECOMMENDATION.ADD, adjustment_amount: round2(addition), reason: `Pemakaian saldo lebih tinggi dari rencana. Tambahkan scheduler sekitar Rp${Math.round(addition).toLocaleString('id-ID')}.` };
  }
  return { recommendation: RECOMMENDATION.KEEP, adjustment_amount: 0, reason: 'Scheduler berikutnya masih sesuai kebutuhan.' };
}

function deriveScheduleDisplayStatus(schedule, currentMinutesOfDay) {
  const status = String(schedule.status || '').toUpperCase();
  if (status === 'CANCELLED' || status === 'MISSED' || status === 'COMPLETED') return status;
  const minutes = timeStringToMinutes(schedule.scheduled_time);
  if (minutes !== null && minutes <= currentMinutesOfDay) return 'COMPLETED';
  return 'UPCOMING';
}

/**
 * Orkestrasi PURE penuh — entry point utama dipanggil data-access layer,
 * SATU bank per panggilan (target_bank_code).
 *
 * `balanceInfo`: hasil dari bankBalanceAdapters.getActualBankBalance()
 *   { balance, confidence, business_date, balance_timestamp, ... }
 * `staleAfterMinutes`: policy per-bank (null = tidak diblokir stale).
 */
function calculateBankRecommendation({
  now = new Date(),
  targetBankCode,
  hourlyPlan = [],
  schedules = [],
  balanceInfo,
  planVarianceTolerance = 10000000,
  schedulerTolerance = 10000000,
  staleAfterMinutes = null,
}) {
  const { hour, minute, minutesOfDay } = getJakartaParts(now);
  const todayBusinessDate = jakartaBusinessDate(now);

  // ── Gate 1: confidence UNAVAILABLE -- spec section 40, tidak boleh CANCEL/REDUCE/ADD ──
  if (!balanceInfo || balanceInfo.confidence === 'UNAVAILABLE' || !isNum(balanceInfo.balance)) {
    return {
      current_time: minutesToTimeString(minutesOfDay), current_hour: hour, current_plan: null,
      next_schedule: null, recommendation: RECOMMENDATION.BALANCE_UNAVAILABLE,
      reason: 'Saldo aktual belum dapat diverifikasi.',
      warnings: balanceInfo ? balanceInfo.warnings : ['Tidak ada data saldo sama sekali.'],
      missing_fields: [],
    };
  }

  // ── Gate 2: staleness ──
  if (staleAfterMinutes !== null && balanceInfo.balance_timestamp) {
    const ageMinutes = (now.getTime() - new Date(balanceInfo.balance_timestamp).getTime()) / 60000;
    if (ageMinutes > Number(staleAfterMinutes)) {
      return {
        current_time: minutesToTimeString(minutesOfDay), current_hour: hour, current_plan: null,
        next_schedule: null, recommendation: RECOMMENDATION.BALANCE_STALE,
        reason: `Data saldo terakhir sudah kedaluwarsa (umur ${Math.round(ageMinutes)} menit, batas ${staleAfterMinutes} menit). Tunggu sinkronisasi terbaru.`,
        warnings: [], missing_fields: [],
      };
    }
  }

  // ── Gate 3: business_date mismatch -- spec section 42, warning bukan block ──
  const businessDateWarnings = [];
  if (balanceInfo.business_date && balanceInfo.business_date !== todayBusinessDate) {
    businessDateWarnings.push(`Business date saldo aktual (${balanceInfo.business_date}) berbeda dari tanggal operasional hari ini (${todayBusinessDate}).`);
  }

  const currentRow = findHourPlan(hourlyPlan, hour);
  const missingFields = [];
  if (!currentRow) missingFields.push(`hourly_plan[hour=${hour}]`);
  else {
    if (!isNum(currentRow.nominal_average)) missingFields.push(`hourly_plan[hour=${hour}].nominal_average`);
    if (!isNum(currentRow.planned_balance)) missingFields.push(`hourly_plan[hour=${hour}].planned_balance`);
  }
  if (missingFields.length) {
    return {
      current_time: minutesToTimeString(minutesOfDay), current_hour: hour,
      current_plan: currentRow ? {
        hour, planned_balance: isNum(currentRow.planned_balance) ? Number(currentRow.planned_balance) : null,
        nominal_average: isNum(currentRow.nominal_average) ? Number(currentRow.nominal_average) : null,
        variance: null, variance_pct: null, status: PLAN_STATUS.INSUFFICIENT_DATA,
      } : null,
      next_schedule: null, recommendation: RECOMMENDATION.INSUFFICIENT_DATA,
      reason: `Rencana saldo belum tersedia untuk jam ini: ${missingFields.join(', ')}.`,
      warnings: businessDateWarnings, missing_fields: missingFields,
    };
  }

  const plannedBalance = Number(currentRow.planned_balance);
  const nominalAverage = Number(currentRow.nominal_average);
  const { variance, variance_pct, status: planStatus } = calculateVariance({
    actualBalance: balanceInfo.balance, plannedBalance, tolerance: planVarianceTolerance,
  });
  const currentPlan = { hour, planned_balance: plannedBalance, nominal_average: nominalAverage, variance, variance_pct, status: planStatus };

  const { schedule: nextRaw, duplicate } = findNextSchedule(schedules, targetBankCode, minutesOfDay);
  if (!nextRaw) {
    return {
      current_time: minutesToTimeString(minutesOfDay), current_hour: hour, current_plan: currentPlan,
      next_schedule: null, recommendation: RECOMMENDATION.NO_UPCOMING_SCHEDULER,
      reason: 'Tidak ada scheduler berikutnya.', warnings: businessDateWarnings, missing_fields: [],
    };
  }
  if (duplicate) {
    return {
      current_time: minutesToTimeString(minutesOfDay), current_hour: hour, current_plan: currentPlan,
      next_schedule: null, recommendation: RECOMMENDATION.INSUFFICIENT_DATA,
      reason: `Ditemukan lebih dari satu scheduler aktif pada jam ${nextRaw.scheduled_time} untuk ${targetBankCode}.`,
      warnings: businessDateWarnings, missing_fields: [`duplicate_schedule_at_${nextRaw.scheduled_time}`],
    };
  }

  const nextMinutes = nextRaw._minutes;
  const nextHour = Math.floor(nextMinutes / 60);
  const targetRow = findHourPlan(hourlyPlan, nextHour);
  if (!targetRow || !isNum(targetRow.planned_balance)) {
    return {
      current_time: minutesToTimeString(minutesOfDay), current_hour: hour, current_plan: currentPlan,
      next_schedule: {
        id: nextRaw.id, scheduled_time: nextRaw.scheduled_time, target_bank_code: nextRaw.target_bank_code,
        funding_source_code: nextRaw.funding_source_code,
        scheduled_amount: isNum(nextRaw.scheduled_amount) ? Number(nextRaw.scheduled_amount) : null, status: nextRaw.status,
      },
      recommendation: RECOMMENDATION.INSUFFICIENT_DATA,
      reason: `Target planned_balance untuk jam scheduler berikutnya (${nextRaw.scheduled_time}) belum tersedia.`,
      warnings: businessDateWarnings, missing_fields: [`hourly_plan[hour=${nextHour}].planned_balance`],
    };
  }
  if (!isNum(nextRaw.scheduled_amount) || Number(nextRaw.scheduled_amount) < 0) {
    return {
      current_time: minutesToTimeString(minutesOfDay), current_hour: hour, current_plan: currentPlan,
      next_schedule: {
        id: nextRaw.id, scheduled_time: nextRaw.scheduled_time, target_bank_code: nextRaw.target_bank_code,
        funding_source_code: nextRaw.funding_source_code, scheduled_amount: null, status: nextRaw.status,
      },
      recommendation: RECOMMENDATION.INSUFFICIENT_DATA,
      reason: `Nominal scheduler ${nextRaw.scheduled_time} tidak valid.`,
      warnings: businessDateWarnings, missing_fields: [`schedule[${nextRaw.id}].scheduled_amount`],
    };
  }

  const { value: burnUntilNext, missingHours } = calculateBurnUntilNextSchedule({
    hourlyPlan, currentHour: hour, currentMinute: minute, nextScheduleHour: nextHour,
  });
  if (burnUntilNext === null) {
    return {
      current_time: minutesToTimeString(minutesOfDay), current_hour: hour, current_plan: currentPlan,
      next_schedule: {
        id: nextRaw.id, scheduled_time: nextRaw.scheduled_time, target_bank_code: nextRaw.target_bank_code,
        funding_source_code: nextRaw.funding_source_code, scheduled_amount: Number(nextRaw.scheduled_amount), status: nextRaw.status,
      },
      recommendation: RECOMMENDATION.INSUFFICIENT_DATA,
      reason: `nominal_average belum lengkap untuk jam: ${missingHours.join(', ')}.`,
      warnings: businessDateWarnings, missing_fields: missingHours.map(h => `hourly_plan[hour=${h}].nominal_average`),
    };
  }

  const confirmedInflows = sumConfirmedInflowsBetween({
    schedules, targetBankCode, currentMinutesOfDay: minutesOfDay, nextScheduleMinutes: nextMinutes, excludeId: nextRaw.id,
  });
  const projectedBalance = calculateProjectedBalance({ actualBalance: balanceInfo.balance, burnUntilNext, confirmedInflows });
  const targetBalanceNext = Number(targetRow.planned_balance);
  const requiredFunding = calculateRequiredFunding({ targetBalance: targetBalanceNext, projectedBalance });
  const existingScheduleAmount = Number(nextRaw.scheduled_amount);
  const { recommendation, adjustment_amount, reason } = calculateFundingRecommendation({
    requiredFunding, existingScheduleAmount, schedulerTolerance,
  });

  const confidenceWarnings = balanceInfo.confidence === 'LOW' && balanceInfo.warnings ? balanceInfo.warnings : [];

  return {
    current_time: minutesToTimeString(minutesOfDay),
    current_hour: hour,
    current_plan: currentPlan,
    next_schedule: {
      id: nextRaw.id, scheduled_time: nextRaw.scheduled_time, target_bank_code: nextRaw.target_bank_code,
      funding_source_code: nextRaw.funding_source_code, scheduled_amount: existingScheduleAmount, status: nextRaw.status,
      target_hour: nextHour, target_planned_balance: targetBalanceNext,
      burn_until_next: burnUntilNext, confirmed_inflows_before_next: confirmedInflows,
      projected_balance: projectedBalance, required_funding: requiredFunding,
      adjustment_amount, recommendation, recommendation_reason: reason,
    },
    recommendation, reason,
    warnings: [...businessDateWarnings, ...confidenceWarnings],
    missing_fields: [],
  };
}

module.exports = {
  JAKARTA_TZ, RECOMMENDATION, PLAN_STATUS, UPCOMING_STATUSES, CONFIRMED_INFLOW_STATUSES,
  getJakartaParts, jakartaBusinessDate, timeStringToMinutes, minutesToTimeString,
  findHourPlan, calculateVariance, findNextSchedule, calculateBurnUntilNextSchedule,
  sumConfirmedInflowsBetween, calculateProjectedBalance, calculateRequiredFunding,
  calculateFundingRecommendation, deriveScheduleDisplayStatus, calculateBankRecommendation,
};
