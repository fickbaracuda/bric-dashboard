'use strict';

/**
 * Balance & Funding — data access. Mengumpulkan input dari DB (plan, hourly
 * plan, schedules, actual balance via bankBalanceAdapters) lalu memanggil
 * balanceFundingEngine.calculateBankRecommendation (PURE). SATU tempat ini
 * yang dipanggil route — tidak ada konsumen lain yang query
 * balance_funding_* sendiri-sendiri.
 */

const { getActualBankBalance, BANK_CODES } = require('./bankBalanceAdapters');
const { calculateBankRecommendation, deriveScheduleDisplayStatus, getJakartaParts } = require('./balanceFundingEngine');

const DEFAULT_PLAN_VARIANCE_TOLERANCE = 10000000;
const DEFAULT_SCHEDULER_TOLERANCE = 10000000;
const DEFAULT_STALE_AFTER_MINUTES = 120; // spec section 41: konfigurasi realistis, bukan disamakan sembarangan lintas bank

async function fetchActivePlan(pool, bankCode) {
  const r = await pool.query(`SELECT * FROM balance_funding_plans WHERE bank_code = $1 AND is_active = TRUE LIMIT 1`, [bankCode]);
  return r.rows[0] || null;
}
async function fetchHourlyPlan(pool, planId) {
  const r = await pool.query(`SELECT * FROM balance_funding_hourly_plan WHERE plan_id = $1 ORDER BY hour_of_day`, [planId]);
  return r.rows;
}
/** Schedules TARGET bank ini -- plan_id sama dgn plan milik bank ini (schedules disimpan di bawah plan target). */
async function fetchSchedules(pool, planId) {
  const r = await pool.query(`SELECT * FROM balance_funding_schedules WHERE plan_id = $1 AND is_active = TRUE ORDER BY scheduled_time`, [planId]);
  return r.rows.map(row => ({ ...row, scheduled_time: String(row.scheduled_time).slice(0, 5) }));
}

/**
 * Entry point utama -- dipanggil route GET .../banks/:bankCode. Tolerance/
 * staleness config disimpan LANGSUNG di baris plan aktif bank ini (kolom
 * variance_tolerance/scheduler_tolerance/stale_after_minutes, NULL = pakai
 * default modul ini, BUKAN default Balance Control Tower manapun).
 */
async function computeBalanceFundingForBank({ pool, bankCode, now = new Date() }) {
  const code = String(bankCode || '').toUpperCase();
  if (!BANK_CODES.includes(code)) {
    return { bank_code: code, error: `Bank code "${bankCode}" tidak didukung Balance & Funding.` };
  }

  const [balanceInfo, plan] = await Promise.all([
    getActualBankBalance(pool, code),
    fetchActivePlan(pool, code),
  ]);

  const planVarianceTolerance = plan && plan.variance_tolerance !== null && plan.variance_tolerance !== undefined
    ? Number(plan.variance_tolerance) : DEFAULT_PLAN_VARIANCE_TOLERANCE;
  const schedulerTolerance = plan && plan.scheduler_tolerance !== null && plan.scheduler_tolerance !== undefined
    ? Number(plan.scheduler_tolerance) : DEFAULT_SCHEDULER_TOLERANCE;
  const staleAfterMinutes = plan && plan.stale_after_minutes !== null && plan.stale_after_minutes !== undefined
    ? Number(plan.stale_after_minutes) : DEFAULT_STALE_AFTER_MINUTES;

  if (!plan) {
    return {
      bank_code: code, plan: null, balance_info: balanceInfo,
      result: {
        current_time: null, current_hour: null, current_plan: null, next_schedule: null,
        recommendation: 'INSUFFICIENT_DATA', reason: 'Rencana saldo (plan) belum tersedia untuk bank ini.',
        warnings: [], missing_fields: ['plan'],
      },
      plan_24h: [], schedule_timeline: [],
    };
  }

  const [hourlyPlan, schedules] = await Promise.all([
    fetchHourlyPlan(pool, plan.id),
    fetchSchedules(pool, plan.id),
  ]);

  const result = calculateBankRecommendation({
    now, targetBankCode: code, hourlyPlan, schedules, balanceInfo,
    planVarianceTolerance, schedulerTolerance, staleAfterMinutes,
  });

  const { minutesOfDay } = getJakartaParts(now);
  const scheduleTimeline = schedules.map(s => {
    const isNext = result.next_schedule && result.next_schedule.id === s.id;
    return {
      id: s.id,
      scheduled_time: s.scheduled_time,
      target_bank_code: s.target_bank_code,
      funding_source_code: s.funding_source_code,
      scheduled_amount: Number(s.scheduled_amount),
      actual_amount: s.actual_amount !== null && s.actual_amount !== undefined ? Number(s.actual_amount) : null,
      status: s.status,
      display_status: deriveScheduleDisplayStatus(s, minutesOfDay),
      is_next: !!isNext,
      required_funding: isNext ? result.next_schedule.required_funding : null,
      adjustment_amount: isNext ? result.next_schedule.adjustment_amount : null,
      recommendation: isNext ? result.next_schedule.recommendation : null,
    };
  });

  const plan24h = hourlyPlan.map(r => ({
    hour: r.hour_of_day,
    nominal_average: r.nominal_average !== null && r.nominal_average !== undefined ? Number(r.nominal_average) : null,
    transaksi_trf: r.transaksi_trf !== null && r.transaksi_trf !== undefined ? Number(r.transaksi_trf) : null,
    dana_disiapkan: r.dana_disiapkan !== null && r.dana_disiapkan !== undefined ? Number(r.dana_disiapkan) : null,
    planned_balance: r.planned_balance !== null && r.planned_balance !== undefined ? Number(r.planned_balance) : null,
  }));

  return {
    bank_code: code,
    plan: { id: plan.id, plan_name: plan.plan_name, opening_balance: Number(plan.opening_balance), source: plan.source },
    balance_info: balanceInfo,
    result,
    plan_variance_tolerance: planVarianceTolerance,
    scheduler_tolerance: schedulerTolerance,
    stale_after_minutes: staleAfterMinutes,
    plan_24h: plan24h,
    schedule_timeline: scheduleTimeline,
  };
}

/**
 * Overview seluruh bank (spec section 28) — dipanggil sekali, paralel
 * terbatas (BANK_CODES cuma 6, aman Promise.all langsung tanpa N+1 per jam --
 * spec section 59).
 */
async function computeBalanceFundingOverview({ pool, now = new Date() }) {
  const results = await Promise.all(BANK_CODES.map(code => computeBalanceFundingForBank({ pool, bankCode: code, now })));
  return results;
}

module.exports = {
  DEFAULT_PLAN_VARIANCE_TOLERANCE, DEFAULT_SCHEDULER_TOLERANCE, DEFAULT_STALE_AFTER_MINUTES,
  fetchActivePlan, fetchHourlyPlan, fetchSchedules,
  computeBalanceFundingForBank, computeBalanceFundingOverview,
};
