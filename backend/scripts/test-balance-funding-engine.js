'use strict';

// Test manual pakai Node built-in `assert` — project ini belum punya test
// framework (pola sama dgn test-qris-control-tower.js/test-funding-scheduler.js).
// Run: node backend/scripts/test-balance-funding-engine.js

const assert = require('assert');
const {
  RECOMMENDATION, PLAN_STATUS, URGENCY,
  getJakartaParts, jakartaBusinessDate, timeStringToMinutes,
  calculateVariance, findNextSchedule, calculateBurnUntilNextSchedule,
  calculateProjectedBalance, calculateRequiredFunding, calculateFundingRecommendation,
  deriveScheduleDisplayStatus, deriveScheduleOverdueMinutes, deriveSchedulerUrgency,
  scheduledTimeToAbsolute, needsFinanceActionAlert, calculateBankRecommendation,
} = require('../src/balanceFunding/balanceFundingEngine');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Plan OCBC dari spec section 13 (initial example seed) ──────────────
const OCBC_HOURLY_PLAN = [
  { hour_of_day: 0, nominal_average: 0, planned_balance: 500000000 },
  { hour_of_day: 1, nominal_average: 0, planned_balance: 500000000 },
  { hour_of_day: 2, nominal_average: 0, planned_balance: 500000000 },
  { hour_of_day: 3, nominal_average: 0, planned_balance: 500000000 },
  { hour_of_day: 4, nominal_average: 0, planned_balance: 500000000 },
  { hour_of_day: 5, nominal_average: 391753951, planned_balance: 1108246049 },
  { hour_of_day: 6, nominal_average: 675579580, planned_balance: 432666469 },
  { hour_of_day: 7, nominal_average: 794445706, planned_balance: 1138220763 },
  { hour_of_day: 8, nominal_average: 1001874250, planned_balance: 136346513 },
  { hour_of_day: 9, nominal_average: 1240465673, planned_balance: 1145880840 },
  { hour_of_day: 10, nominal_average: 1041480069, planned_balance: 104400771 },
  { hour_of_day: 11, nominal_average: 840729635, planned_balance: 1263671136 },
  { hour_of_day: 12, nominal_average: 708424795, planned_balance: 555246341 },
  { hour_of_day: 13, nominal_average: 622507132, planned_balance: 1432739209 },
  { hour_of_day: 14, nominal_average: 776126657, planned_balance: 656612552 },
  { hour_of_day: 15, nominal_average: 887029290, planned_balance: 1519583262 },
  { hour_of_day: 16, nominal_average: 812829129, planned_balance: 706754133 },
  { hour_of_day: 17, nominal_average: 811551732, planned_balance: 1395202401 },
  { hour_of_day: 18, nominal_average: 913988116, planned_balance: 1481214285 },
  { hour_of_day: 19, nominal_average: 933510925, planned_balance: 1547703360 },
  { hour_of_day: 20, nominal_average: 587002659, planned_balance: 960700701 },
  { hour_of_day: 21, nominal_average: 302632295, planned_balance: 758068406 },
  { hour_of_day: 22, nominal_average: 282875321, planned_balance: 475193085 },
  { hour_of_day: 23, nominal_average: 0, planned_balance: 475193085 },
];
const OCBC_SCHEDULES = [
  { id: 1, target_bank_code: 'OCBC', scheduled_time: '05:00', funding_source_code: 'MANDIRI', scheduled_amount: 1000000000, status: 'COMPLETED' },
  { id: 2, target_bank_code: 'OCBC', scheduled_time: '07:00', funding_source_code: 'MANDIRI', scheduled_amount: 1500000000, status: 'COMPLETED' },
  { id: 3, target_bank_code: 'OCBC', scheduled_time: '09:00', funding_source_code: 'MANDIRI', scheduled_amount: 2250000000, status: 'COMPLETED' },
  { id: 4, target_bank_code: 'OCBC', scheduled_time: '11:00', funding_source_code: 'MANDIRI', scheduled_amount: 2000000000, status: 'COMPLETED' },
  { id: 5, target_bank_code: 'OCBC', scheduled_time: '13:00', funding_source_code: 'MANDIRI', scheduled_amount: 1500000000, status: 'COMPLETED' },
  { id: 6, target_bank_code: 'OCBC', scheduled_time: '15:00', funding_source_code: 'MANDIRI', scheduled_amount: 1750000000, status: 'SCHEDULED' },
  { id: 7, target_bank_code: 'OCBC', scheduled_time: '17:00', funding_source_code: 'MANDIRI', scheduled_amount: 1500000000, status: 'SCHEDULED' },
  { id: 8, target_bank_code: 'OCBC', scheduled_time: '18:00', funding_source_code: 'MANDIRI', scheduled_amount: 1000000000, status: 'SCHEDULED' },
  { id: 9, target_bank_code: 'OCBC', scheduled_time: '19:00', funding_source_code: 'BRI', scheduled_amount: 1000000000, status: 'SCHEDULED' },
  { id: 10, target_bank_code: 'OCBC', scheduled_time: '21:00', funding_source_code: 'BRI', scheduled_amount: 100000000, status: 'SCHEDULED' },
];
function jakartaTime(hour, minute = 0) {
  // Jakarta = UTC+7, tanpa DST.
  return new Date(Date.UTC(2026, 6, 15, hour - 7, minute, 0));
}
function balanceInfo(balance, overrides = {}) {
  return { balance, confidence: 'HIGH', business_date: jakartaBusinessDate(jakartaTime(14, 0)), balance_timestamp: jakartaTime(14, 0), warnings: [], ...overrides };
}

// ── timezone helpers ──
test('getJakartaParts: 14:00 WIB dari instant UTC', () => {
  const p = getJakartaParts(jakartaTime(14, 0));
  assert.strictEqual(p.hour, 14);
  assert.strictEqual(p.minute, 0);
});
test('timeStringToMinutes: format HH:mm', () => {
  assert.strictEqual(timeStringToMinutes('15:00'), 900);
  assert.strictEqual(timeStringToMinutes('x'), null);
});

// ── calculateVariance — ABOVE/BELOW/ON_PLAN ──
test('calculateVariance: ABOVE_PLAN', () => {
  const r = calculateVariance({ actualBalance: 1600000000, plannedBalance: 656612552, tolerance: 10000000 });
  assert.strictEqual(r.status, PLAN_STATUS.ABOVE_PLAN);
});
test('calculateVariance: BELOW_PLAN', () => {
  const r = calculateVariance({ actualBalance: 0, plannedBalance: 656612552, tolerance: 10000000 });
  assert.strictEqual(r.status, PLAN_STATUS.BELOW_PLAN);
});
test('calculateVariance: ON_PLAN persis di batas', () => {
  const r = calculateVariance({ actualBalance: 666612552, plannedBalance: 656612552, tolerance: 10000000 });
  assert.strictEqual(r.status, PLAN_STATUS.ON_PLAN);
});
test('calculateVariance: data tidak lengkap -> INSUFFICIENT_DATA', () => {
  const r = calculateVariance({ actualBalance: null, plannedBalance: 656612552 });
  assert.strictEqual(r.status, PLAN_STATUS.INSUFFICIENT_DATA);
});

// ── findNextSchedule — scoped ke target_bank_code ──
test('findNextSchedule: 14:20 OCBC -> next 15:00 MANDIRI', () => {
  const { schedule } = findNextSchedule(OCBC_SCHEDULES, 'OCBC', 14 * 60 + 20);
  assert.strictEqual(schedule.scheduled_time, '15:00');
  assert.strictEqual(schedule.funding_source_code, 'MANDIRI');
});
test('findNextSchedule: bank lain tidak ikut kepilih (isolasi per target_bank_code)', () => {
  const mixed = [...OCBC_SCHEDULES, { id: 99, target_bank_code: 'BNI', scheduled_time: '14:30', funding_source_code: 'OCBC', scheduled_amount: 1, status: 'SCHEDULED' }];
  const { schedule } = findNextSchedule(mixed, 'OCBC', 14 * 60 + 20);
  assert.strictEqual(schedule.scheduled_time, '15:00'); // bukan yang BNI jam 14:30
});
test('findNextSchedule: funding_source boleh dari bank lain (spec section 9)', () => {
  const { schedule } = findNextSchedule(OCBC_SCHEDULES, 'OCBC', 18 * 60 + 30);
  assert.strictEqual(schedule.funding_source_code, 'BRI'); // target OCBC, sumber BRI -- valid
});

// ── calculateBurnUntilNextSchedule ──
test('calculateBurnUntilNextSchedule: 14:00 (minute=0) -> 15:00, full burn jam 14', () => {
  const { value } = calculateBurnUntilNextSchedule({ hourlyPlan: OCBC_HOURLY_PLAN, currentHour: 14, currentMinute: 0, nextScheduleHour: 15 });
  assert.strictEqual(value, 776126657);
});
test('calculateBurnUntilNextSchedule: 14:20 -> proporsi 40/60', () => {
  const { value } = calculateBurnUntilNextSchedule({ hourlyPlan: OCBC_HOURLY_PLAN, currentHour: 14, currentMinute: 20, nextScheduleHour: 15 });
  assert.strictEqual(value, round(776126657 * 40 / 60));
});
function round(n) { return Math.round(n * 100) / 100; }

// ── calculateRequiredFunding ──
test('calculateRequiredFunding: clamp ke 0 kalau proyeksi lebih besar dari target', () => {
  assert.strictEqual(calculateRequiredFunding({ targetBalance: 1519583262, projectedBalance: 1623873343 }), 0);
});

// ── calculateFundingRecommendation — CANCEL/REDUCE/KEEP/ADD ──
test('CANCEL: required 0', () => {
  const r = calculateFundingRecommendation({ requiredFunding: 0, existingScheduleAmount: 1750000000, schedulerTolerance: 10000000 });
  assert.strictEqual(r.recommendation, RECOMMENDATION.CANCEL);
});
test('REDUCE: required jauh di bawah existing', () => {
  const r = calculateFundingRecommendation({ requiredFunding: 695709919, existingScheduleAmount: 1750000000, schedulerTolerance: 10000000 });
  assert.strictEqual(r.recommendation, RECOMMENDATION.REDUCE);
  assert.strictEqual(r.adjustment_amount, -1054290081);
});
test('KEEP: required dekat existing (dalam tolerance)', () => {
  const r = calculateFundingRecommendation({ requiredFunding: 1745000000, existingScheduleAmount: 1750000000, schedulerTolerance: 10000000 });
  assert.strictEqual(r.recommendation, RECOMMENDATION.KEEP);
});
test('ADD: required jauh di atas existing', () => {
  const r = calculateFundingRecommendation({ requiredFunding: 2295709919, existingScheduleAmount: 1750000000, schedulerTolerance: 10000000 });
  assert.strictEqual(r.recommendation, RECOMMENDATION.ADD);
  assert.strictEqual(r.adjustment_amount, 545709919);
});
test('batas persis CANCEL (required == tolerance)', () => {
  const r = calculateFundingRecommendation({ requiredFunding: 10000000, existingScheduleAmount: 1750000000, schedulerTolerance: 10000000 });
  assert.strictEqual(r.recommendation, RECOMMENDATION.CANCEL);
});

// ── deriveScheduleDisplayStatus / overdue (spec section 4 -- Balance Position
// Time & Funding Countdown enhancement: scheduler lewat waktu tapi masih
// SCHEDULED sekarang SCHEDULER_OVERDUE, BUKAN diam-diam 'COMPLETED') ──
test('deriveScheduleDisplayStatus: lewat waktu, masih SCHEDULED -> SCHEDULER_OVERDUE', () => {
  assert.strictEqual(deriveScheduleDisplayStatus({ scheduled_time: '09:00', status: 'SCHEDULED' }, 14 * 60), 'SCHEDULER_OVERDUE');
});
test('deriveScheduleDisplayStatus: lewat waktu, status CONFIRMED -> tetap SCHEDULER_OVERDUE', () => {
  assert.strictEqual(deriveScheduleDisplayStatus({ scheduled_time: '09:00', status: 'CONFIRMED' }, 14 * 60), 'SCHEDULER_OVERDUE');
});
test('deriveScheduleDisplayStatus: CANCELLED tetap CANCELLED', () => {
  assert.strictEqual(deriveScheduleDisplayStatus({ scheduled_time: '09:00', status: 'CANCELLED' }, 14 * 60), 'CANCELLED');
});
test('deriveScheduleDisplayStatus: sudah eksplisit COMPLETED -> tetap COMPLETED', () => {
  assert.strictEqual(deriveScheduleDisplayStatus({ scheduled_time: '09:00', status: 'COMPLETED' }, 14 * 60), 'COMPLETED');
});
test('deriveScheduleDisplayStatus: belum lewat -> UPCOMING', () => {
  assert.strictEqual(deriveScheduleDisplayStatus({ scheduled_time: '15:00', status: 'SCHEDULED' }, 14 * 60), 'UPCOMING');
});
test('deriveScheduleOverdueMinutes: TERLAMBAT 5 menit', () => {
  assert.strictEqual(deriveScheduleOverdueMinutes({ scheduled_time: '09:00', status: 'SCHEDULED' }, 9 * 60 + 5), 5);
});
test('deriveScheduleOverdueMinutes: belum overdue -> null', () => {
  assert.strictEqual(deriveScheduleOverdueMinutes({ scheduled_time: '15:00', status: 'SCHEDULED' }, 14 * 60), null);
});

// ── deriveSchedulerUrgency (spec section 5 -- ambang batas urgency) ──
test('deriveSchedulerUrgency: >60 menit -> NORMAL', () => {
  assert.strictEqual(deriveSchedulerUrgency(61), URGENCY.NORMAL);
});
test('deriveSchedulerUrgency: persis 60 menit -> WATCH', () => {
  assert.strictEqual(deriveSchedulerUrgency(60), URGENCY.WATCH);
});
test('deriveSchedulerUrgency: persis 31 menit -> WATCH', () => {
  assert.strictEqual(deriveSchedulerUrgency(31), URGENCY.WATCH);
});
test('deriveSchedulerUrgency: persis 30 menit -> WARNING', () => {
  assert.strictEqual(deriveSchedulerUrgency(30), URGENCY.WARNING);
});
test('deriveSchedulerUrgency: persis 16 menit -> WARNING', () => {
  assert.strictEqual(deriveSchedulerUrgency(16), URGENCY.WARNING);
});
test('deriveSchedulerUrgency: persis 15 menit -> URGENT', () => {
  assert.strictEqual(deriveSchedulerUrgency(15), URGENCY.URGENT);
});
test('deriveSchedulerUrgency: 1 menit -> URGENT', () => {
  assert.strictEqual(deriveSchedulerUrgency(1), URGENCY.URGENT);
});
test('deriveSchedulerUrgency: 0 menit -> URGENT', () => {
  assert.strictEqual(deriveSchedulerUrgency(0), URGENCY.URGENT);
});
test('deriveSchedulerUrgency: negatif (lewat) -> OVERDUE', () => {
  assert.strictEqual(deriveSchedulerUrgency(-5), URGENCY.OVERDUE);
});
test('deriveSchedulerUrgency: null/non-numerik -> null', () => {
  assert.strictEqual(deriveSchedulerUrgency(null), null);
});

// ── scheduledTimeToAbsolute (spec section 3 -- absolute instant utk countdown lokal frontend) ──
test('scheduledTimeToAbsolute: 18:00 business_date 2026-07-15 -> instant WIB benar', () => {
  const d = scheduledTimeToAbsolute('2026-07-15', '18:00');
  assert.strictEqual(d.toISOString(), '2026-07-15T11:00:00.000Z'); // 18:00 WIB = 11:00 UTC
});
test('scheduledTimeToAbsolute: businessDate kosong -> null', () => {
  assert.strictEqual(scheduledTimeToAbsolute(null, '18:00'), null);
});

// ── needsFinanceActionAlert (spec section 6) ──
test('needsFinanceActionAlert: ADD + URGENT -> true', () => {
  assert.strictEqual(needsFinanceActionAlert('ADD', URGENCY.URGENT), true);
});
test('needsFinanceActionAlert: CANCEL + OVERDUE -> true', () => {
  assert.strictEqual(needsFinanceActionAlert('CANCEL', URGENCY.OVERDUE), true);
});
test('needsFinanceActionAlert: KEEP + URGENT -> false (spec: KEEP tidak pernah alert kritikal)', () => {
  assert.strictEqual(needsFinanceActionAlert('KEEP', URGENCY.URGENT), false);
});
test('needsFinanceActionAlert: ADD + WATCH (belum dekat) -> false', () => {
  assert.strictEqual(needsFinanceActionAlert('ADD', URGENCY.WATCH), false);
});

// ── calculateBankRecommendation — end-to-end pakai contoh OCBC section 54 ──
test('OCBC @14:00 actual 1.6M -> REDUCE, ABOVE_PLAN', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 0), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES,
    balanceInfo: balanceInfo(1600000000),
  });
  assert.strictEqual(r.current_plan.status, PLAN_STATUS.ABOVE_PLAN);
  assert.strictEqual(r.next_schedule.scheduled_time, '15:00');
  assert.strictEqual(r.next_schedule.target_planned_balance, 1519583262);
  assert.strictEqual(r.recommendation, RECOMMENDATION.REDUCE);
});
test('OCBC @14:00 actual 2.4M -> CANCEL', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 0), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES,
    balanceInfo: balanceInfo(2400000000),
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.CANCEL);
  assert.strictEqual(r.next_schedule.required_funding, 0);
});
test('OCBC @14:00 actual 0 -> ADD, BELOW_PLAN', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 0), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES,
    balanceInfo: balanceInfo(0),
  });
  assert.strictEqual(r.current_plan.status, PLAN_STATUS.BELOW_PLAN);
  assert.strictEqual(r.recommendation, RECOMMENDATION.ADD);
});
test('OCBC @14:00 actual 550.709.919 -> KEEP', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 0), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES,
    balanceInfo: balanceInfo(550709919),
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.KEEP);
});

// ── Countdown/urgency terpasang di next_schedule (spec section 3/5) ──
test('next_schedule punya minutes_to_next_scheduler & next_scheduler_time & urgency', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 20), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES,
    balanceInfo: balanceInfo(550709919, { balance_timestamp: jakartaTime(14, 20) }),
  });
  assert.strictEqual(r.next_schedule.scheduled_time, '15:00');
  assert.strictEqual(r.next_schedule.minutes_to_next_scheduler, 40);
  assert.strictEqual(r.next_schedule.urgency, URGENCY.WATCH); // 40 menit -> WATCH (31-60)
  assert.strictEqual(r.next_schedule.next_scheduler_time.toISOString(), '2026-07-15T08:00:00.000Z'); // 15:00 WIB = 08:00 UTC
});

// ── Finance Action Alert end-to-end (spec section 6) -- fixture kecil
// tersendiri (bukan OCBC section-54) supaya kategori ADD/REDUCE/CANCEL/KEEP
// bisa dikontrol persis dekat scheduler (burn_until_next mengecil drastis
// mendekati jam scheduler, menggeser ambang batas dibanding awal jam --
// dibuktikan sendiri: fixture OCBC section-54 di jam 14:50 tidak bisa
// mencapai kategori ADD sama sekali sedekat itu ke scheduler 15:00).
// target_planned_balance jam 11 = 5.000.000, existing scheduler = 2.000.000,
// tolerance = 100.000, nominal_average jam 10 = 0 (burn=0 apa pun waktunya).
const ALERT_HOURLY_PLAN = [
  { hour_of_day: 10, nominal_average: 0, planned_balance: 1000000 },
  { hour_of_day: 11, nominal_average: 0, planned_balance: 5000000 },
];
const ALERT_SCHEDULES = [
  { id: 1, target_bank_code: 'OCBC', scheduled_time: '11:00', funding_source_code: 'MANDIRI', scheduled_amount: 2000000, status: 'SCHEDULED' },
];
function alertBalanceInfo(balance, ts) {
  return { balance, confidence: 'HIGH', business_date: jakartaBusinessDate(ts), balance_timestamp: ts, warnings: [] };
}
test('ADD + URGENT (10 menit lagi) -> finance_action_alert true', () => {
  const now = jakartaTime(10, 50);
  const r = calculateBankRecommendation({
    now, targetBankCode: 'OCBC', hourlyPlan: ALERT_HOURLY_PLAN, schedules: ALERT_SCHEDULES,
    balanceInfo: alertBalanceInfo(0, now), schedulerTolerance: 100000,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.ADD);
  assert.strictEqual(r.next_schedule.urgency, URGENCY.URGENT);
  assert.strictEqual(r.next_schedule.minutes_to_next_scheduler, 10);
  assert.strictEqual(r.next_schedule.finance_action_alert, true);
});
test('CANCEL + URGENT (10 menit lagi) -> finance_action_alert true', () => {
  const now = jakartaTime(10, 50);
  const r = calculateBankRecommendation({
    now, targetBankCode: 'OCBC', hourlyPlan: ALERT_HOURLY_PLAN, schedules: ALERT_SCHEDULES,
    balanceInfo: alertBalanceInfo(6000000, now), schedulerTolerance: 100000,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.CANCEL);
  assert.strictEqual(r.next_schedule.urgency, URGENCY.URGENT);
  assert.strictEqual(r.next_schedule.finance_action_alert, true);
});
test('REDUCE + URGENT (10 menit lagi) -> finance_action_alert true', () => {
  const now = jakartaTime(10, 50);
  const r = calculateBankRecommendation({
    now, targetBankCode: 'OCBC', hourlyPlan: ALERT_HOURLY_PLAN, schedules: ALERT_SCHEDULES,
    balanceInfo: alertBalanceInfo(4000000, now), schedulerTolerance: 100000,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.REDUCE);
  assert.strictEqual(r.next_schedule.urgency, URGENCY.URGENT);
  assert.strictEqual(r.next_schedule.finance_action_alert, true);
});
test('KEEP + URGENT (10 menit lagi) -> finance_action_alert TETAP false (spec: KEEP tidak pernah alert kritikal)', () => {
  const now = jakartaTime(10, 50);
  const r = calculateBankRecommendation({
    now, targetBankCode: 'OCBC', hourlyPlan: ALERT_HOURLY_PLAN, schedules: ALERT_SCHEDULES,
    balanceInfo: alertBalanceInfo(3000000, now), schedulerTolerance: 100000,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.KEEP);
  assert.strictEqual(r.next_schedule.urgency, URGENCY.URGENT); // urgency tetap dihitung apa adanya...
  assert.strictEqual(r.next_schedule.finance_action_alert, false); // ...tapi TIDAK memicu alert krn KEEP
});
test('BALANCE_STALE tetap punya urgency/countdown next_schedule (murni fungsi waktu, independen saldo)', () => {
  const staleTimestamp = new Date(jakartaTime(14, 50).getTime() - 120 * 60000);
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 50), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES,
    balanceInfo: balanceInfo(1600000000, { balance_timestamp: staleTimestamp }),
    staleAfterMinutes: 60,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.BALANCE_STALE);
  assert.strictEqual(r.next_schedule.minutes_to_next_scheduler, 10);
  assert.strictEqual(r.next_schedule.urgency, URGENCY.URGENT);
  assert.strictEqual(r.next_schedule.finance_action_alert, false); // BALANCE_STALE bukan ADD/REDUCE/CANCEL
});

// ── Fail-safe gates (spec section 6/40/41/42/67) ──
test('BALANCE_UNAVAILABLE -> tidak pernah CANCEL/REDUCE/ADD (spec section 40)', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 0), targetBankCode: 'BNI', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES,
    balanceInfo: { balance: null, confidence: 'UNAVAILABLE', warnings: ['tidak ada data'] },
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.BALANCE_UNAVAILABLE);
  assert.strictEqual(r.next_schedule, null);
});
test('BALANCE_STALE menang di atas semuanya', () => {
  const staleTimestamp = new Date(jakartaTime(14, 0).getTime() - 120 * 60000); // 2 jam lalu
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 0), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES,
    balanceInfo: balanceInfo(1600000000, { balance_timestamp: staleTimestamp }),
    staleAfterMinutes: 60,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.BALANCE_STALE);
});
test('BALANCE_STALE tetap tampilkan Planned Balance & Next Scheduler (data plan murni, independen dari saldo aktual) -- hanya Variance/Required Funding/Recommendation yang di-null-kan', () => {
  const staleTimestamp = new Date(jakartaTime(14, 0).getTime() - 120 * 60000);
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 0), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES,
    balanceInfo: balanceInfo(1600000000, { balance_timestamp: staleTimestamp }),
    staleAfterMinutes: 60,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.BALANCE_STALE);
  // Planned Balance & nominal_average TETAP ada (bukan null) -- ini yg tadinya bug (kartu Planned Balance/Next Scheduler kosong).
  assert.ok(r.current_plan);
  assert.strictEqual(r.current_plan.planned_balance, 656612552);
  assert.strictEqual(r.current_plan.nominal_average, 776126657);
  // Variance TETAP null -- benar2 tidak aman dihitung dari saldo basi.
  assert.strictEqual(r.current_plan.variance, null);
  assert.strictEqual(r.current_plan.status, PLAN_STATUS.INSUFFICIENT_DATA);
  // Next Scheduler waktu/sumber/nominal existing/target TETAP ada.
  assert.ok(r.next_schedule);
  assert.strictEqual(r.next_schedule.scheduled_time, '15:00');
  assert.strictEqual(r.next_schedule.funding_source_code, 'MANDIRI');
  assert.strictEqual(r.next_schedule.scheduled_amount, 1750000000);
  assert.strictEqual(r.next_schedule.target_planned_balance, 1519583262);
  // Required Funding/adjustment/recommendation (butuh saldo trustworthy) TETAP null.
  assert.strictEqual(r.next_schedule.required_funding, null);
  assert.strictEqual(r.next_schedule.adjustment_amount, null);
  assert.strictEqual(r.next_schedule.recommendation, null);
});
test('BALANCE_UNAVAILABLE tetap tampilkan Planned Balance & Next Scheduler, bukan cuma recommendation blank', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 0), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES,
    balanceInfo: { balance: null, confidence: 'UNAVAILABLE', warnings: ['saldo tidak ada'] },
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.BALANCE_UNAVAILABLE);
  assert.strictEqual(r.current_plan.planned_balance, 656612552);
  assert.strictEqual(r.current_plan.variance, null);
  assert.strictEqual(r.next_schedule.scheduled_time, '15:00');
  assert.strictEqual(r.next_schedule.required_funding, null);
});
test('business_date mismatch -> warning tapi tidak block rekomendasi', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 0), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES,
    balanceInfo: balanceInfo(1600000000, { business_date: '2026-01-01' }),
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.REDUCE);
  assert.ok(r.warnings.some(w => w.includes('Business date')));
});
test('hourly plan kosong -> INSUFFICIENT_DATA', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 0), targetBankCode: 'OCBC', hourlyPlan: [], schedules: OCBC_SCHEDULES, balanceInfo: balanceInfo(1600000000),
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.INSUFFICIENT_DATA);
});
test('tidak ada scheduler tersisa (23:30) -> NO_UPCOMING_SCHEDULER, variance tetap dihitung', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(23, 30), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES, balanceInfo: balanceInfo(475193085),
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.NO_UPCOMING_SCHEDULER);
  assert.strictEqual(r.current_plan.status, PLAN_STATUS.ON_PLAN);
});
test('mid-hour calculation + timezone gabungan (14:20)', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 20), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES, balanceInfo: balanceInfo(1600000000),
  });
  assert.strictEqual(r.current_hour, 14);
  assert.strictEqual(r.next_schedule.burn_until_next, round(776126657 * 40 / 60));
});
test('decimal precision (rounding 2 digit)', () => {
  const r = calculateVariance({ actualBalance: 100000000.126, plannedBalance: 100000000, tolerance: 10000000 });
  assert.strictEqual(r.variance, 0.13);
});
test('confidence LOW tetap boleh rekomendasi tapi warning muncul (spec: LOW = show warning, bukan block)', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(14, 0), targetBankCode: 'OCBC', hourlyPlan: OCBC_HOURLY_PLAN, schedules: OCBC_SCHEDULES,
    balanceInfo: balanceInfo(1600000000, { confidence: 'LOW', warnings: ['saldo tidak fully verified'] }),
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.REDUCE);
  assert.ok(r.warnings.includes('saldo tidak fully verified'));
});

// ── MANDIRI baseline (spec: opening 200jt, 24 hourly rows, 9 scheduler) ──
// Angka identik dgn backend/scripts/seed-balance-funding-mandiri.js -- lihat
// docs/BALANCE_FUNDING.md bagian Mandiri utk penjelasan lengkap 19:00.
const MANDIRI_HOURLY_PLAN = [
  { hour_of_day: 0, nominal_average: 0, planned_balance: 200000000 },
  { hour_of_day: 1, nominal_average: 0, planned_balance: 200000000 },
  { hour_of_day: 2, nominal_average: 0, planned_balance: 200000000 },
  { hour_of_day: 3, nominal_average: 0, planned_balance: 200000000 },
  { hour_of_day: 4, nominal_average: 0, planned_balance: 200000000 },
  { hour_of_day: 5, nominal_average: 69846664, planned_balance: 280153336 },
  { hour_of_day: 6, nominal_average: 16512556, planned_balance: 263640780 },
  { hour_of_day: 7, nominal_average: 109210049, planned_balance: 304430731 },
  { hour_of_day: 8, nominal_average: 133352061, planned_balance: 171078670 },
  { hour_of_day: 9, nominal_average: 177751110, planned_balance: 293327560 },
  { hour_of_day: 10, nominal_average: 198012542, planned_balance: 95315018 },
  { hour_of_day: 11, nominal_average: 109536265, planned_balance: 285778753 },
  { hour_of_day: 12, nominal_average: 131177461, planned_balance: 154601292 },
  { hour_of_day: 13, nominal_average: 76144273, planned_balance: 278457019 },
  { hour_of_day: 14, nominal_average: 97408968, planned_balance: 181048051 },
  { hour_of_day: 15, nominal_average: 104362960, planned_balance: 276685091 },
  { hour_of_day: 16, nominal_average: 103322079, planned_balance: 173363012 },
  { hour_of_day: 17, nominal_average: 124230446, planned_balance: 349132566 },
  { hour_of_day: 18, nominal_average: 154325742, planned_balance: 194806824 },
  { hour_of_day: 19, nominal_average: 168905616, planned_balance: 325901208 },
  { hour_of_day: 20, nominal_average: 107143604, planned_balance: 218757604 },
  { hour_of_day: 21, nominal_average: 102199771, planned_balance: 366557833 },
  { hour_of_day: 22, nominal_average: 29855806, planned_balance: 336702027 },
  { hour_of_day: 23, nominal_average: 0, planned_balance: 336702027 },
];
const MANDIRI_SCHEDULES = [
  { id: 101, target_bank_code: 'MANDIRI', scheduled_time: '05:00', funding_source_code: 'MANDIRI', scheduled_amount: 150000000, status: 'SCHEDULED' },
  { id: 102, target_bank_code: 'MANDIRI', scheduled_time: '07:00', funding_source_code: 'MANDIRI', scheduled_amount: 150000000, status: 'SCHEDULED' },
  { id: 103, target_bank_code: 'MANDIRI', scheduled_time: '09:00', funding_source_code: 'MANDIRI', scheduled_amount: 300000000, status: 'SCHEDULED' },
  { id: 104, target_bank_code: 'MANDIRI', scheduled_time: '11:00', funding_source_code: 'MANDIRI', scheduled_amount: 300000000, status: 'SCHEDULED' },
  { id: 105, target_bank_code: 'MANDIRI', scheduled_time: '13:00', funding_source_code: 'MANDIRI', scheduled_amount: 200000000, status: 'SCHEDULED' },
  { id: 106, target_bank_code: 'MANDIRI', scheduled_time: '15:00', funding_source_code: 'MANDIRI', scheduled_amount: 200000000, status: 'SCHEDULED' },
  { id: 107, target_bank_code: 'MANDIRI', scheduled_time: '17:00', funding_source_code: 'MANDIRI', scheduled_amount: 300000000, status: 'SCHEDULED' },
  { id: 108, target_bank_code: 'MANDIRI', scheduled_time: '19:00', funding_source_code: 'MANDIRI', scheduled_amount: 300000000, status: 'SCHEDULED' },
  { id: 109, target_bank_code: 'MANDIRI', scheduled_time: '21:00', funding_source_code: 'BRI', scheduled_amount: 250000000, status: 'SCHEDULED' },
];
function mandiriBalanceInfo(balance, overrides = {}) {
  return { balance, confidence: 'HIGH', business_date: jakartaBusinessDate(jakartaTime(9, 0)), balance_timestamp: jakartaTime(9, 0), warnings: [], ...overrides };
}

test('MANDIRI baseline: 24 baris hourly plan tersedia', () => {
  assert.strictEqual(MANDIRI_HOURLY_PLAN.length, 24);
});
test('MANDIRI baseline: 9 baris scheduler tersedia', () => {
  assert.strictEqual(MANDIRI_SCHEDULES.length, 9);
});
test('MANDIRI baseline: opening balance 200jt tercermin di jam 00:00-04:00 (no scheduler, avg=0)', () => {
  for (let h = 0; h <= 4; h++) {
    assert.strictEqual(MANDIRI_HOURLY_PLAN[h].planned_balance, 200000000);
  }
});
test('MANDIRI baseline: scheduler 05:00/07:00/09:00/11:00/13:00/15:00/17:00 semua MANDIRI->MANDIRI', () => {
  const times = ['05:00', '07:00', '09:00', '11:00', '13:00', '15:00', '17:00'];
  for (const t of times) {
    const s = MANDIRI_SCHEDULES.find(x => x.scheduled_time === t);
    assert.strictEqual(s.target_bank_code, 'MANDIRI');
    assert.strictEqual(s.funding_source_code, 'MANDIRI');
  }
});
test('MANDIRI baseline: scheduler 19:00 -- discrepancy raw "18:00" diselesaikan via validasi matematis, bukan tebakan', () => {
  // 18:00 planned VALID tanpa scheduler apa pun (349132566 - 154325742 = 194806824).
  const h18 = MANDIRI_HOURLY_PLAN.find(r => r.hour_of_day === 18);
  assert.strictEqual(round(MANDIRI_HOURLY_PLAN.find(r => r.hour_of_day === 17).planned_balance - h18.nominal_average), h18.planned_balance);
  // 19:00 planned HANYA valid kalau scheduler Rp300jt masuk DI baris ini.
  const h19 = MANDIRI_HOURLY_PLAN.find(r => r.hour_of_day === 19);
  assert.strictEqual(round(h18.planned_balance + 300000000 - h19.nominal_average), h19.planned_balance);
  const s19 = MANDIRI_SCHEDULES.find(x => x.scheduled_time === '19:00');
  assert.strictEqual(s19.scheduled_amount, 300000000);
});
test('MANDIRI baseline: scheduler 21:00 funding_source=BRI, target_bank tetap MANDIRI (bukan BRI)', () => {
  const s21 = MANDIRI_SCHEDULES.find(x => x.scheduled_time === '21:00');
  assert.strictEqual(s21.funding_source_code, 'BRI');
  assert.strictEqual(s21.target_bank_code, 'MANDIRI');
  assert.strictEqual(s21.scheduled_amount, 250000000);
});
test('MANDIRI baseline: seluruh 24 baris konsisten dgn formula prev+scheduler-avg=planned (toleransi Rp1)', () => {
  let prev = 200000000;
  const schedByHour = new Map(MANDIRI_SCHEDULES.map(s => [parseInt(s.scheduled_time.slice(0, 2), 10), s.scheduled_amount]));
  for (const row of MANDIRI_HOURLY_PLAN) {
    const sched = schedByHour.get(row.hour_of_day) || 0;
    const computed = round(prev + sched - row.nominal_average);
    assert.ok(Math.abs(computed - row.planned_balance) <= 1, `hour=${row.hour_of_day} computed=${computed} vs source=${row.planned_balance}`);
    prev = row.planned_balance;
  }
});
test('MANDIRI end-to-end @09:00 exact jam scheduler -- current-hour plan resolve benar', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(9, 0), targetBankCode: 'MANDIRI', hourlyPlan: MANDIRI_HOURLY_PLAN, schedules: MANDIRI_SCHEDULES,
    balanceInfo: mandiriBalanceInfo(400000000),
  });
  assert.strictEqual(r.current_hour, 9);
  assert.strictEqual(r.current_plan.planned_balance, 293327560);
});
test('MANDIRI end-to-end @09:00 -- next scheduler resolve ke 11:00 (bukan 09:00 sendiri, sudah lewat menit ini)', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(9, 0), targetBankCode: 'MANDIRI', hourlyPlan: MANDIRI_HOURLY_PLAN, schedules: MANDIRI_SCHEDULES,
    balanceInfo: mandiriBalanceInfo(400000000),
  });
  assert.strictEqual(r.next_schedule.scheduled_time, '11:00');
  assert.strictEqual(r.next_schedule.target_planned_balance, 285778753);
});
test('MANDIRI end-to-end @20:00 -- next scheduler resolve ke 21:00, funding_source BRI ikut terbawa ke response', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(20, 0), targetBankCode: 'MANDIRI', hourlyPlan: MANDIRI_HOURLY_PLAN, schedules: MANDIRI_SCHEDULES,
    balanceInfo: mandiriBalanceInfo(300000000),
  });
  assert.strictEqual(r.next_schedule.scheduled_time, '21:00');
  assert.strictEqual(r.next_schedule.funding_source_code, 'BRI');
});
test('MANDIRI end-to-end -- rekomendasi dihasilkan (bukan lagi INSUFFICIENT_DATA) begitu plan tersedia', () => {
  const r = calculateBankRecommendation({
    now: jakartaTime(9, 0), targetBankCode: 'MANDIRI', hourlyPlan: MANDIRI_HOURLY_PLAN, schedules: MANDIRI_SCHEDULES,
    balanceInfo: mandiriBalanceInfo(400000000),
  });
  assert.ok(['CANCEL', 'REDUCE', 'KEEP', 'ADD'].includes(r.recommendation), `unexpected: ${r.recommendation}`);
});

// ── Runner ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    fail++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (${tests.length} total)`);
process.exit(fail ? 1 : 0);
