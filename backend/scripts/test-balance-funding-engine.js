'use strict';

// Test manual pakai Node built-in `assert` — project ini belum punya test
// framework (pola sama dgn test-qris-control-tower.js/test-funding-scheduler.js).
// Run: node backend/scripts/test-balance-funding-engine.js

const assert = require('assert');
const {
  RECOMMENDATION, PLAN_STATUS,
  getJakartaParts, jakartaBusinessDate, timeStringToMinutes,
  calculateVariance, findNextSchedule, calculateBurnUntilNextSchedule,
  calculateProjectedBalance, calculateRequiredFunding, calculateFundingRecommendation,
  deriveScheduleDisplayStatus, calculateBankRecommendation,
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

// ── deriveScheduleDisplayStatus ──
test('deriveScheduleDisplayStatus: lewat waktu, masih SCHEDULED -> COMPLETED', () => {
  assert.strictEqual(deriveScheduleDisplayStatus({ scheduled_time: '09:00', status: 'SCHEDULED' }, 14 * 60), 'COMPLETED');
});
test('deriveScheduleDisplayStatus: CANCELLED tetap CANCELLED', () => {
  assert.strictEqual(deriveScheduleDisplayStatus({ scheduled_time: '09:00', status: 'CANCELLED' }, 14 * 60), 'CANCELLED');
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
