'use strict';

/**
 * Balance Control Tower — Funding Scheduler Adjustment Assistant, data access.
 * Mengumpulkan input dari DB (hourly plan, scheduler plan, actual balance)
 * lalu memanggil fundingSchedulerEngine.calculateFundingSchedulerAssistant
 * (PURE). SATU tempat ini yang dipanggil route — tidak ada konsumen lain
 * yang query bct_hourly_balance_plan/bct_funding_scheduler_plan sendiri2.
 *
 * REUSE eksplisit (BUKAN reimplementasi):
 *   - Actual balance: SAMA PERSIS resolver yang dipakai status/command-center
 *     existing (computeOperationalCalculationForBank utk bank ber-adapter
 *     rekonsiliasi, fallback snapshot manual/API utk bank lain) -- TIDAK
 *     pernah membuat saldo baru dari sumber lain.
 */

const { isSupportedBank } = require('../reconciliation/bankPosition');
const { computeOperationalCalculationForBank } = require('./operationalDataAccess');
const { pickCurrentAndPrevious, STATUS } = require('../utils/balanceControlTower');
const { calculateFundingSchedulerAssistant, deriveSchedulerDisplayStatus, timeStringToMinutes, getJakartaParts } = require('./fundingSchedulerEngine');

const DEFAULT_TOLERANCE = 10000000;

/**
 * Resolusi actual balance -- REUSE PENUH mesin operasional/snapshot existing.
 * Return { actualBalance, stale, source, asOf } -- `stale` true kalau
 * freshness-nya STALE/UNAVAILABLE (operational engine) atau umur snapshot
 * melewati stale_after_minutes (fallback manual/API), SAMA definisi dgn
 * status DATA_STALE yang sudah dipakai bank status existing.
 */
async function resolveActualBalance({ pool, bank, policy, now }) {
  if (isSupportedBank(bank.bank_code)) {
    let operational = null;
    try {
      operational = await computeOperationalCalculationForBank({ pool, bank, policy, STATUS, now });
    } catch (e) {
      console.error(`fundingScheduler resolveActualBalance operational (${bank.bank_code}) error:`, e.message);
    }
    if (!operational || operational.available_balance === null || operational.available_balance === undefined) {
      return { actualBalance: null, stale: true, source: 'RECONCILIATION', asOf: null };
    }
    const stale = operational.data_freshness_status === 'STALE' || operational.data_freshness_status === 'UNAVAILABLE';
    return { actualBalance: Number(operational.available_balance), stale, source: 'RECONCILIATION', asOf: operational.balance_source_timestamp };
  }

  // Fallback: bank tanpa adapter rekonsiliasi -- snapshot manual/API terbaru,
  // SAMA prioritas (RECONCILIATION > MANUAL kalau ada) dgn classifier lama.
  const snapshotsRes = await pool.query(
    `SELECT * FROM bct_balance_snapshots WHERE bank_account_id = $1 ORDER BY captured_at DESC LIMIT 20`,
    [bank.id]
  );
  const { snapshot } = pickCurrentAndPrevious(snapshotsRes.rows, false);
  if (!snapshot || snapshot.available_balance === null || snapshot.available_balance === undefined) {
    return { actualBalance: null, stale: true, source: null, asOf: null };
  }
  let stale = snapshot.sync_status === 'ERROR';
  if (!stale && policy && policy.stale_after_minutes !== null && policy.stale_after_minutes !== undefined) {
    const ageMinutes = (now.getTime() - new Date(snapshot.captured_at).getTime()) / 60000;
    stale = ageMinutes > Number(policy.stale_after_minutes);
  }
  return { actualBalance: Number(snapshot.available_balance), stale, source: snapshot.source, asOf: snapshot.captured_at };
}

async function fetchHourlyPlan({ pool, bankAccountId }) {
  const r = await pool.query(
    `SELECT * FROM bct_hourly_balance_plan WHERE bank_account_id = $1 AND is_active = TRUE ORDER BY hour_of_day`,
    [bankAccountId]
  );
  return r.rows;
}

async function fetchSchedulerPlan({ pool, bankAccountId }) {
  const r = await pool.query(
    `SELECT * FROM bct_funding_scheduler_plan WHERE bank_account_id = $1 AND is_active = TRUE ORDER BY scheduled_time`,
    [bankAccountId]
  );
  return r.rows.map(row => ({ ...row, scheduled_time: String(row.scheduled_time).slice(0, 5) }));
}

/**
 * Entry point utama -- dipanggil route GET .../funding-scheduler. Menghasilkan
 * payload lengkap engine + metadata sumber saldo + timeline seluruh scheduler
 * hari ini (past = plan-only/derived-status, next = actionable recommendation,
 * future lain = plan-only -- spec section 21/23: "jangan menghitung
 * recommendation jauh ke depan pakai actual balance sekarang").
 */
async function computeFundingSchedulerForBank({ pool, bank, policy, now = new Date() }) {
  const [{ actualBalance, stale, source, asOf }, hourlyPlan, schedulers] = await Promise.all([
    resolveActualBalance({ pool, bank, policy, now }),
    fetchHourlyPlan({ pool, bankAccountId: bank.id }),
    fetchSchedulerPlan({ pool, bankAccountId: bank.id }),
  ]);

  const planVarianceTolerance = policy && policy.funding_plan_variance_tolerance !== null && policy.funding_plan_variance_tolerance !== undefined
    ? Number(policy.funding_plan_variance_tolerance) : DEFAULT_TOLERANCE;
  const schedulerTolerance = policy && policy.funding_scheduler_tolerance !== null && policy.funding_scheduler_tolerance !== undefined
    ? Number(policy.funding_scheduler_tolerance) : DEFAULT_TOLERANCE;

  const result = calculateFundingSchedulerAssistant({
    now, hourlyPlan, schedulers, actualBalance, actualBalanceStale: stale,
    planVarianceTolerance, schedulerTolerance,
  });

  const { minutesOfDay } = getJakartaParts(now);
  const timeline = schedulers.map(s => {
    const isNext = result.next_scheduler && result.next_scheduler.id === s.id;
    return {
      id: s.id,
      scheduled_time: s.scheduled_time,
      funding_source_code: s.funding_source_code,
      scheduled_amount: Number(s.scheduled_amount),
      actual_amount: s.actual_amount !== null && s.actual_amount !== undefined ? Number(s.actual_amount) : null,
      status: s.status,
      display_status: deriveSchedulerDisplayStatus(s, minutesOfDay),
      is_next: !!isNext,
      required_funding: isNext ? result.next_scheduler.required_funding : null,
      adjustment_amount: isNext ? result.next_scheduler.adjustment_amount : null,
      recommendation: isNext ? result.next_scheduler.recommendation : null,
    };
  });

  const plan24h = hourlyPlan.map(r => ({
    hour: r.hour_of_day,
    average_burn: r.average_burn !== null && r.average_burn !== undefined ? Number(r.average_burn) : null,
    planned_balance: r.planned_balance !== null && r.planned_balance !== undefined ? Number(r.planned_balance) : null,
  }));

  return {
    ...result,
    actual_balance: actualBalance,
    actual_balance_source: source,
    actual_balance_stale: stale,
    actual_balance_updated_at: asOf,
    plan_variance_tolerance: planVarianceTolerance,
    scheduler_tolerance: schedulerTolerance,
    plan_24h: plan24h,
    scheduler_timeline: timeline,
  };
}

module.exports = {
  DEFAULT_TOLERANCE,
  resolveActualBalance,
  fetchHourlyPlan,
  fetchSchedulerPlan,
  computeFundingSchedulerForBank,
};
