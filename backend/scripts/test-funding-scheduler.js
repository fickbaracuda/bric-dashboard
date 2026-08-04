'use strict';

// Test manual pakai Node built-in `assert` — project ini belum punya test
// framework (pola sama dgn test-qris-control-tower.js), jadi tidak menambah
// dependency baru. Run: node backend/scripts/test-funding-scheduler.js

const assert = require('assert');
const {
  RECOMMENDATION, PLAN_STATUS,
  getJakartaParts, timeStringToMinutes, minutesToTimeString,
  computePlanVariance, findNextScheduler, computeBurnUntilNextScheduler,
  computeProjectedBalanceBeforeNext, computeRequiredFunding,
  calculateSchedulerRecommendation, deriveSchedulerDisplayStatus,
  calculateFundingSchedulerAssistant, validateBaselineFormula,
} = require('../src/balanceControlTower/fundingSchedulerEngine');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Baseline BNI Multibiller terbaru (spec section 2) — dipakai berulang di seluruh test ──
const HOURLY_PLAN = [
  { hour_of_day: 0, average_burn: 0, planned_balance: 200000000 },
  { hour_of_day: 1, average_burn: 0, planned_balance: 300000000 },
  { hour_of_day: 2, average_burn: 0, planned_balance: 300000000 },
  { hour_of_day: 3, average_burn: 0, planned_balance: 300000000 },
  { hour_of_day: 4, average_burn: 0, planned_balance: 300000000 },
  { hour_of_day: 5, average_burn: 2496000, planned_balance: 297504000 },
  { hour_of_day: 6, average_burn: 17870000, planned_balance: 279634000 },
  { hour_of_day: 7, average_burn: 31749000, planned_balance: 347885000 },
  { hour_of_day: 8, average_burn: 62097592, planned_balance: 285787408 },
  { hour_of_day: 9, average_burn: 75359401, planned_balance: 360428007 },
  { hour_of_day: 10, average_burn: 55028666, planned_balance: 305399341 },
  { hour_of_day: 11, average_burn: 83295661, planned_balance: 372103680 },
  { hour_of_day: 12, average_burn: 43902449, planned_balance: 328201231 },
  { hour_of_day: 13, average_burn: 42800000, planned_balance: 435401231 },
  { hour_of_day: 14, average_burn: 40048000, planned_balance: 395353231 },
  { hour_of_day: 15, average_burn: 29966423, planned_balance: 515386808 },
  { hour_of_day: 16, average_burn: 50990000, planned_balance: 464396808 },
  { hour_of_day: 17, average_burn: 63790500, planned_balance: 550606308 },
  { hour_of_day: 18, average_burn: 67614997, planned_balance: 482991311 },
  { hour_of_day: 19, average_burn: 34885500, planned_balance: 598105811 },
  { hour_of_day: 20, average_burn: 14988841, planned_balance: 583116970 },
  { hour_of_day: 21, average_burn: 22548123, planned_balance: 560568847 },
  { hour_of_day: 22, average_burn: 1300127, planned_balance: 559268720 },
  { hour_of_day: 23, average_burn: 0, planned_balance: 559268720 },
];
const SCHEDULERS = [
  { id: 1, scheduled_time: '01:00', funding_source_code: 'BRI', scheduled_amount: 100000000, status: 'COMPLETED' },
  { id: 2, scheduled_time: '07:00', funding_source_code: 'BNI', scheduled_amount: 100000000, status: 'COMPLETED' },
  { id: 3, scheduled_time: '09:00', funding_source_code: 'BNI', scheduled_amount: 150000000, status: 'COMPLETED' },
  { id: 4, scheduled_time: '11:00', funding_source_code: 'BNI', scheduled_amount: 150000000, status: 'COMPLETED' },
  { id: 5, scheduled_time: '13:00', funding_source_code: 'BNI', scheduled_amount: 150000000, status: 'COMPLETED' },
  { id: 6, scheduled_time: '15:00', funding_source_code: 'BNI', scheduled_amount: 150000000, status: 'SCHEDULED' },
  { id: 7, scheduled_time: '17:00', funding_source_code: 'BNI', scheduled_amount: 150000000, status: 'SCHEDULED' },
  { id: 8, scheduled_time: '19:00', funding_source_code: 'BNI', scheduled_amount: 150000000, status: 'SCHEDULED' },
];
// 14:00 WIB -> UTC = 07:00 (Jakarta = UTC+7, tanpa DST).
function jakartaTime(hour, minute = 0) {
  return new Date(Date.UTC(2026, 6, 15, hour - 7, minute, 0));
}

// ── getJakartaParts / timeStringToMinutes / minutesToTimeString (timezone) ──
test('getJakartaParts: 14:23 WIB terbaca benar dari instant UTC', () => {
  const p = getJakartaParts(jakartaTime(14, 23));
  assert.strictEqual(p.hour, 14);
  assert.strictEqual(p.minute, 23);
  assert.strictEqual(p.minutesOfDay, 14 * 60 + 23);
});
test('getJakartaParts: tengah malam (00:00 WIB)', () => {
  const p = getJakartaParts(jakartaTime(0, 0));
  assert.strictEqual(p.hour, 0);
});
test('timeStringToMinutes: format HH:mm dan HH:mm:ss', () => {
  assert.strictEqual(timeStringToMinutes('15:00'), 900);
  assert.strictEqual(timeStringToMinutes('15:00:00'), 900);
  assert.strictEqual(timeStringToMinutes('bukan-waktu'), null);
});
test('minutesToTimeString: round-trip', () => {
  assert.strictEqual(minutesToTimeString(900), '15:00');
  assert.strictEqual(minutesToTimeString(0), '00:00');
});

// ── computePlanVariance — ABOVE_PLAN / BELOW_PLAN / ON_PLAN / tolerance / rounding ──
test('SCENARIO 5 — ABOVE_PLAN', () => {
  const r = computePlanVariance({ actualBalance: 470000000, plannedBalance: 395353231, tolerance: 10000000 });
  assert.strictEqual(r.variance, 74646769);
  assert.strictEqual(r.status, PLAN_STATUS.ABOVE_PLAN);
});
test('SCENARIO 6 — BELOW_PLAN', () => {
  const r = computePlanVariance({ actualBalance: 300000000, plannedBalance: 395353231, tolerance: 10000000 });
  assert.strictEqual(r.variance, -95353231);
  assert.strictEqual(r.status, PLAN_STATUS.BELOW_PLAN);
});
test('ON_PLAN — persis di batas tolerance (inklusif)', () => {
  const r = computePlanVariance({ actualBalance: 210000000, plannedBalance: 200000000, tolerance: 10000000 });
  assert.strictEqual(r.variance, 10000000);
  assert.strictEqual(r.status, PLAN_STATUS.ON_PLAN);
});
test('ON_PLAN — selisih kecil di bawah tolerance', () => {
  const r = computePlanVariance({ actualBalance: 205000000, plannedBalance: 200000000, tolerance: 10000000 });
  assert.strictEqual(r.status, PLAN_STATUS.ON_PLAN);
});
test('computePlanVariance — actual null -> INSUFFICIENT_DATA, bukan error', () => {
  const r = computePlanVariance({ actualBalance: null, plannedBalance: 200000000 });
  assert.strictEqual(r.status, PLAN_STATUS.INSUFFICIENT_DATA);
  assert.strictEqual(r.variance, null);
});
test('computePlanVariance — desimal precision (rounding 2 digit)', () => {
  const r = computePlanVariance({ actualBalance: 100000000.126, plannedBalance: 100000000, tolerance: 10000000 });
  assert.strictEqual(r.variance, 0.13);
});

// ── findNextScheduler ──
// Fixture terpisah (semua masih SCHEDULED) -- SCHEDULERS di atas sengaja
// mensimulasikan status "hari sudah berjalan sampai jam 14:00" (01-13 sudah
// COMPLETED), jadi tidak cocok dipakai utk uji "next scheduler dari pagi hari".
const SCHEDULERS_ALL_SCHEDULED = SCHEDULERS.map(s => ({ ...s, status: 'SCHEDULED' }));
test('findNextScheduler: 10:17 -> next 11:00 BNI', () => {
  const { scheduler, duplicate } = findNextScheduler(SCHEDULERS_ALL_SCHEDULED, 10 * 60 + 17);
  assert.strictEqual(scheduler.scheduled_time, '11:00');
  assert.strictEqual(scheduler.funding_source_code, 'BNI');
  assert.strictEqual(duplicate, false);
});
test('findNextScheduler: scheduler CANCELLED tidak jadi kandidat', () => {
  const withCancelled = [
    { id: 99, scheduled_time: '11:00', funding_source_code: 'BNI', scheduled_amount: 150000000, status: 'CANCELLED' },
    { id: 100, scheduled_time: '13:00', funding_source_code: 'BNI', scheduled_amount: 150000000, status: 'SCHEDULED' },
  ];
  const { scheduler } = findNextScheduler(withCancelled, 10 * 60);
  assert.strictEqual(scheduler.scheduled_time, '13:00');
});
test('findNextScheduler: tidak ada scheduler tersisa hari ini -> null', () => {
  const { scheduler } = findNextScheduler(SCHEDULERS, 23 * 60 + 30);
  assert.strictEqual(scheduler, null);
});
test('findNextScheduler: duplicate scheduler di menit yang sama terdeteksi', () => {
  const dup = [
    { id: 1, scheduled_time: '15:00', funding_source_code: 'BNI', scheduled_amount: 150000000, status: 'SCHEDULED' },
    { id: 2, scheduled_time: '15:00', funding_source_code: 'BNI', scheduled_amount: 150000000, status: 'SCHEDULED' },
  ];
  const { duplicate } = findNextScheduler(dup, 10 * 60);
  assert.strictEqual(duplicate, true);
});

// ── computeBurnUntilNextScheduler — fractional current hour + full hours between ──
test('computeBurnUntilNextScheduler: pas jam 14:00 (minute=0), next 15:00 -> full burn jam 14 saja', () => {
  const { value, missingHours } = computeBurnUntilNextScheduler({
    hourlyPlan: HOURLY_PLAN, currentHour: 14, currentMinute: 0, nextSchedulerHour: 15,
  });
  assert.strictEqual(value, 40048000);
  assert.deepStrictEqual(missingHours, []);
});
test('computeBurnUntilNextScheduler: 14:30, next 15:00 -> setengah burn jam 14', () => {
  const { value } = computeBurnUntilNextScheduler({
    hourlyPlan: HOURLY_PLAN, currentHour: 14, currentMinute: 30, nextSchedulerHour: 15,
  });
  assert.strictEqual(value, 20024000);
});
test('computeBurnUntilNextScheduler: lompat >1 jam (13:00 -> next scheduler 15:00) ikutkan jam 14 penuh', () => {
  const { value } = computeBurnUntilNextScheduler({
    hourlyPlan: HOURLY_PLAN, currentHour: 13, currentMinute: 0, nextSchedulerHour: 15,
  });
  // jam 13 penuh (42.800.000) + jam 14 penuh (40.048.000)
  assert.strictEqual(value, 82848000);
});
test('computeBurnUntilNextScheduler: average_burn hilang di salah satu jam -> null + dilaporkan', () => {
  const planWithGap = HOURLY_PLAN.map(r => (r.hour_of_day === 14 ? { ...r, average_burn: null } : r));
  const { value, missingHours } = computeBurnUntilNextScheduler({
    hourlyPlan: planWithGap, currentHour: 13, currentMinute: 0, nextSchedulerHour: 15,
  });
  assert.strictEqual(value, null);
  assert.deepStrictEqual(missingHours, [14]);
});

// ── computeRequiredFunding ──
test('computeRequiredFunding: proyeksi kurang dari target -> positif', () => {
  assert.strictEqual(computeRequiredFunding({ targetBalance: 515386808, projectedBalance: 429952000 }), 85434808);
});
test('computeRequiredFunding: proyeksi lebih dari target -> clamp ke 0 (bukan negatif)', () => {
  assert.strictEqual(computeRequiredFunding({ targetBalance: 515386808, projectedBalance: 519952000 }), 0);
});

// ── calculateSchedulerRecommendation — CANCEL/REDUCE/KEEP/ADD ──
test('SCENARIO 4 — CANCEL (required 0)', () => {
  const r = calculateSchedulerRecommendation({ requiredFunding: 0, existingSchedulerAmount: 150000000, schedulerTolerance: 10000000 });
  assert.strictEqual(r.recommendation, RECOMMENDATION.CANCEL);
});
test('SCENARIO 1 — REDUCE ±Rp64.565.192', () => {
  const r = calculateSchedulerRecommendation({ requiredFunding: 85434808, existingSchedulerAmount: 150000000, schedulerTolerance: 10000000 });
  assert.strictEqual(r.recommendation, RECOMMENDATION.REDUCE);
  assert.strictEqual(r.adjustment_amount, -64565192);
});
test('SCENARIO 3 — KEEP (required 145jt vs existing 150jt, tolerance 10jt)', () => {
  const r = calculateSchedulerRecommendation({ requiredFunding: 145000000, existingSchedulerAmount: 150000000, schedulerTolerance: 10000000 });
  assert.strictEqual(r.recommendation, RECOMMENDATION.KEEP);
});
test('SCENARIO 2 — ADD ±Rp105.434.808', () => {
  const r = calculateSchedulerRecommendation({ requiredFunding: 255434808, existingSchedulerAmount: 150000000, schedulerTolerance: 10000000 });
  assert.strictEqual(r.recommendation, RECOMMENDATION.ADD);
  assert.strictEqual(r.adjustment_amount, 105434808);
});
test('calculateSchedulerRecommendation: persis di batas CANCEL (required == tolerance) -> CANCEL', () => {
  const r = calculateSchedulerRecommendation({ requiredFunding: 10000000, existingSchedulerAmount: 150000000, schedulerTolerance: 10000000 });
  assert.strictEqual(r.recommendation, RECOMMENDATION.CANCEL);
});
test('calculateSchedulerRecommendation: persis di batas KEEP atas (required == existing + tolerance) -> KEEP, bukan ADD', () => {
  const r = calculateSchedulerRecommendation({ requiredFunding: 160000000, existingSchedulerAmount: 150000000, schedulerTolerance: 10000000 });
  assert.strictEqual(r.recommendation, RECOMMENDATION.KEEP);
});
test('calculateSchedulerRecommendation: data tidak lengkap -> INSUFFICIENT_DATA', () => {
  const r = calculateSchedulerRecommendation({ requiredFunding: null, existingSchedulerAmount: 150000000 });
  assert.strictEqual(r.recommendation, RECOMMENDATION.INSUFFICIENT_DATA);
});

// ── deriveSchedulerDisplayStatus ──
test('deriveSchedulerDisplayStatus: waktu sudah lewat, status SCHEDULED -> tampil COMPLETED', () => {
  assert.strictEqual(deriveSchedulerDisplayStatus({ scheduled_time: '09:00', status: 'SCHEDULED' }, 10 * 60), 'COMPLETED');
});
test('deriveSchedulerDisplayStatus: waktu belum sampai -> UPCOMING', () => {
  assert.strictEqual(deriveSchedulerDisplayStatus({ scheduled_time: '15:00', status: 'SCHEDULED' }, 10 * 60), 'UPCOMING');
});
test('deriveSchedulerDisplayStatus: CANCELLED tetap CANCELLED walau waktu sudah lewat', () => {
  assert.strictEqual(deriveSchedulerDisplayStatus({ scheduled_time: '09:00', status: 'CANCELLED' }, 10 * 60), 'CANCELLED');
});

// ── validateBaselineFormula ──
test('validateBaselineFormula: 13:00 baseline valid (spec section 29)', () => {
  const r = validateBaselineFormula({ previousPlanned: 328201231, expectedBurn: 42800000, schedulerAmount: 150000000, currentPlanned: 435401231 });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.diff, 0);
});
test('validateBaselineFormula: mismatch terdeteksi tapi tidak override source', () => {
  const r = validateBaselineFormula({ previousPlanned: 100000000, expectedBurn: 10000000, schedulerAmount: 0, currentPlanned: 999999999 });
  assert.strictEqual(r.valid, false);
});

// ── calculateFundingSchedulerAssistant — orkestrasi end-to-end ──
test('SCENARIO 1 end-to-end — REDUCE @14:00, actual 470jt', () => {
  const r = calculateFundingSchedulerAssistant({
    now: jakartaTime(14, 0), hourlyPlan: HOURLY_PLAN, schedulers: SCHEDULERS,
    actualBalance: 470000000, planVarianceTolerance: 10000000, schedulerTolerance: 10000000,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.REDUCE);
  assert.strictEqual(r.next_scheduler.scheduled_time, '15:00');
  assert.strictEqual(r.next_scheduler.required_funding, 85434808);
  assert.strictEqual(r.next_scheduler.adjustment_amount, -64565192);
  assert.strictEqual(r.current_plan.status, PLAN_STATUS.ABOVE_PLAN);
});
test('SCENARIO 2 end-to-end — ADD @14:00, actual 300jt', () => {
  const r = calculateFundingSchedulerAssistant({
    now: jakartaTime(14, 0), hourlyPlan: HOURLY_PLAN, schedulers: SCHEDULERS, actualBalance: 300000000,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.ADD);
  assert.strictEqual(r.next_scheduler.adjustment_amount, 105434808);
});
test('SCENARIO 4 end-to-end — CANCEL @14:00, actual 560jt', () => {
  const r = calculateFundingSchedulerAssistant({
    now: jakartaTime(14, 0), hourlyPlan: HOURLY_PLAN, schedulers: SCHEDULERS, actualBalance: 560000000,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.CANCEL);
  assert.strictEqual(r.next_scheduler.required_funding, 0);
});
test('SCENARIO 7 end-to-end — DATA_STALE menang di atas semuanya', () => {
  const r = calculateFundingSchedulerAssistant({
    now: jakartaTime(14, 0), hourlyPlan: HOURLY_PLAN, schedulers: SCHEDULERS,
    actualBalance: 470000000, actualBalanceStale: true,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.DATA_STALE);
});
test('end-to-end — actual_balance null -> INSUFFICIENT_DATA, bukan crash', () => {
  const r = calculateFundingSchedulerAssistant({
    now: jakartaTime(14, 0), hourlyPlan: HOURLY_PLAN, schedulers: SCHEDULERS, actualBalance: null,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.INSUFFICIENT_DATA);
  assert.ok(r.missing_fields.includes('actual_balance'));
});
test('end-to-end — hourly plan kosong -> INSUFFICIENT_DATA', () => {
  const r = calculateFundingSchedulerAssistant({
    now: jakartaTime(14, 0), hourlyPlan: [], schedulers: SCHEDULERS, actualBalance: 470000000,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.INSUFFICIENT_DATA);
});
test('end-to-end — tidak ada scheduler tersisa (23:30) -> NO_UPCOMING_SCHEDULER, variance tetap dihitung', () => {
  const r = calculateFundingSchedulerAssistant({
    now: jakartaTime(23, 30), hourlyPlan: HOURLY_PLAN, schedulers: SCHEDULERS, actualBalance: 600000000,
  });
  assert.strictEqual(r.recommendation, RECOMMENDATION.NO_UPCOMING_SCHEDULER);
  assert.strictEqual(r.current_plan.status, PLAN_STATUS.ABOVE_PLAN); // 600jt vs planned 559.268.720 -> variance 40.731.280 > tolerance
});
test('end-to-end — ON_PLAN tidak memicu rekomendasi ekstrem secara tidak wajar (tetap dihitung dari actual apa adanya)', () => {
  const r = calculateFundingSchedulerAssistant({
    now: jakartaTime(1, 0), hourlyPlan: HOURLY_PLAN, schedulers: SCHEDULERS_ALL_SCHEDULED, actualBalance: 300000000,
  });
  assert.strictEqual(r.current_plan.status, PLAN_STATUS.ON_PLAN);
  assert.strictEqual(r.next_scheduler.scheduled_time, '07:00');
});
test('end-to-end — timezone: waktu WIB dini hari (00:05) terbaca sbg jam 0, bukan jam sistem lokal test runner', () => {
  const r = calculateFundingSchedulerAssistant({
    now: jakartaTime(0, 5), hourlyPlan: HOURLY_PLAN, schedulers: SCHEDULERS, actualBalance: 200000000,
  });
  assert.strictEqual(r.current_hour, 0);
  assert.strictEqual(r.current_plan.status, PLAN_STATUS.ON_PLAN);
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
