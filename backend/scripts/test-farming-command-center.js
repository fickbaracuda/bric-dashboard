'use strict';

/**
 * Test/validation manual untuk Farming Command Center — TIDAK butuh DB,
 * hanya menguji parser header, parser angka, dan business logic secara
 * langsung (pure functions). Jalankan dengan:
 *   node backend/scripts/test-farming-command-center.js
 *
 * Idempotency sync (upsert DB) diverifikasi manual di server (lihat
 * docs/FARMING_COMMAND_CENTER.md §Testing) karena butuh koneksi database
 * sungguhan — di luar cakupan test murni ini.
 */

const assert = require('assert');
const { safeNumber } = require('../src/farming/numberParser');
const { parseFarmingHeaders } = require('../src/farming/headerParser');
const { computeGrowthStatus, computeAnomalyFlags, computeSegment, finalizePriorities } = require('../src/farming/businessLogic');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  [OK]   ${name}`);
  } catch (err) {
    fail++;
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${err.message}`);
  }
}

console.log('=== Farming Command Center — Test Suite ===\n');

console.log('-- Numeric parser --');
test('angka native number', () => assert.strictEqual(safeNumber(35161), 35161));
test('string koma ribuan "35,161"', () => assert.strictEqual(safeNumber('35,161'), 35161));
test('string titik ribuan "35.161"', () => assert.strictEqual(safeNumber('35.161'), 35161));
test('prefix Rp "Rp35.161"', () => assert.strictEqual(safeNumber('Rp35.161'), 35161));
test('negatif "-16822"', () => assert.strictEqual(safeNumber('-16822'), -16822));
test('negatif tanda kurung "(16822)"', () => assert.strictEqual(safeNumber('(16822)'), -16822));
test('blank string', () => assert.strictEqual(safeNumber(''), null));
test('null', () => assert.strictEqual(safeNumber(null), null));
test('dash saja "-"', () => assert.strictEqual(safeNumber('-'), null));
test('formula error', () => assert.strictEqual(safeNumber('#DIV/0!'), null));
test('tidak pernah return NaN/Infinity', () => {
  for (const v of [35161, '35,161', '35.161', 'Rp35.161', '-16822', '', null, '-', '#DIV/0!', 0, '0']) {
    const n = safeNumber(v);
    assert.ok(n === null || Number.isFinite(n), `safeNumber(${JSON.stringify(v)}) = ${n}`);
  }
});

console.log('\n-- Header parser: kasus standar Juni/Juli --');
{
  const headers = ['ID Outlet', 'Trx Juni Full', 'Rev Juni Full', 'Trx 1-9 Juni', 'Rev 1-9 Juni', 'Trx 1-9 Juli', 'Rev 1-9 Juli', 'Dev Trx', 'Dev Rev', 'layer_arpu'];
  const result = parseFarmingHeaders(headers, '2026-07-09');
  test('parse berhasil (ok=true)', () => assert.strictEqual(result.ok, true, JSON.stringify(result.errors)));
  test('baseline_month_label = Juni', () => assert.strictEqual(result.labels.baseline_month_label, 'Juni'));
  test('previous_period_month_label = Juni', () => assert.strictEqual(result.labels.previous_period_month_label, 'Juni'));
  test('current_period_month_label = Juli', () => assert.strictEqual(result.labels.current_period_month_label, 'Juli'));
  test('period_start_day = 1, period_end_day = 9', () => {
    assert.strictEqual(result.labels.period_start_day, 1);
    assert.strictEqual(result.labels.period_end_day, 9);
  });
  test('current_month_key = 2026-07 (dari snapshot_date)', () => assert.strictEqual(result.labels.current_month_key, '2026-07'));
  test('previous_month_key = 2026-06', () => assert.strictEqual(result.labels.previous_month_key, '2026-06'));
  test('tidak ada warning mapping posisional (label cocok)', () => assert.strictEqual(result.warnings.length, 0));
}

console.log('\n-- Header parser: pergantian bulan Juli -> Agustus --');
{
  const headers = ['ID Outlet', 'Trx Juli Full', 'Rev Juli Full', 'Trx 1-10 Juli', 'Rev 1-10 Juli', 'Trx 1-10 Agustus', 'Rev 1-10 Agustus', 'Dev Trx', 'Dev Rev', 'layer_arpu'];
  const result = parseFarmingHeaders(headers, '2026-08-10');
  test('parse berhasil', () => assert.strictEqual(result.ok, true, JSON.stringify(result.errors)));
  test('current = Agustus, previous = Juli', () => {
    assert.strictEqual(result.labels.current_period_month_label, 'Agustus');
    assert.strictEqual(result.labels.previous_period_month_label, 'Juli');
  });
  test('current_month_key = 2026-08, previous_month_key = 2026-07', () => {
    assert.strictEqual(result.labels.current_month_key, '2026-08');
    assert.strictEqual(result.labels.previous_month_key, '2026-07');
  });
}

console.log('\n-- Header parser: rollover tahun Desember -> Januari --');
{
  const headers = ['ID Outlet', 'Trx Desember Full', 'Rev Desember Full', 'Trx 1-15 Desember', 'Rev 1-15 Desember', 'Trx 1-15 Januari', 'Rev 1-15 Januari', 'Dev Trx', 'Dev Rev', 'layer_arpu'];
  const result = parseFarmingHeaders(headers, '2027-01-15');
  test('parse berhasil', () => assert.strictEqual(result.ok, true, JSON.stringify(result.errors)));
  test('current_month_key = 2027-01 (tahun baru)', () => assert.strictEqual(result.labels.current_month_key, '2027-01'));
  test('previous_month_key = 2026-12 (tahun lama)', () => assert.strictEqual(result.labels.previous_month_key, '2026-12'));
}

console.log('\n-- Header parser: variasi kapitalisasi/spasi/dash --');
{
  const headers = ['ID OUTLET', 'TRX Juni Full', 'Revenue Juni Full', 'TRX 1–9 JULI'.replace('JULI', 'Juni'), 'Revenue 1 - 9 Juni', 'TRX 1–9 JULI', 'Revenue 1 - 9 Juli', 'DEV TRX', 'Dev Revenue', 'Layer_ARPU'];
  const result = parseFarmingHeaders(headers, '2026-07-09');
  test('parse berhasil walau variasi format', () => assert.strictEqual(result.ok, true, JSON.stringify(result.errors)));
  test('en-dash "1–9" terbaca sama dengan hyphen', () => assert.strictEqual(result.labels.period_start_day, 1));
}

console.log('\n-- Header parser: kegagalan wajib (pasangan tidak lengkap) --');
{
  const headers = ['ID Outlet', 'Trx Juni Full', 'Rev Juni Full', 'Trx 1-9 Juni', 'Rev 1-9 Juni']; // current period hilang
  const result = parseFarmingHeaders(headers, '2026-07-09');
  test('gagal dengan jelas (ok=false) kalau period pair current hilang', () => assert.strictEqual(result.ok, false));
  test('errors menyebutkan jumlah period TRX yang ditemukan', () => assert.ok(result.errors.some(e => e.includes('periode TRX'))));
}
{
  const headers = ['ID Outlet', 'Trx Juni Full', 'Rev Juni Full', 'Trx 1-9 Juni', 'Rev 1-9 Juni', 'Trx 1-10 Juli', 'Rev 1-9 Juli'];
  const result = parseFarmingHeaders(headers, '2026-07-10');
  test('gagal kalau rentang tanggal previous vs current berbeda', () => assert.strictEqual(result.ok, false));
}

console.log('\n-- Business logic: growth status --');
test('churned', () => assert.strictEqual(computeGrowthStatus({ previousTrx: 20, currentTrx: 0, currentRevenue: 0, devRevenuePct: null, devTrxPct: null, layerArpu: 'Low ARPU' }), 'churned'));
test('new_active', () => assert.strictEqual(computeGrowthStatus({ previousTrx: 0, currentTrx: 14, currentRevenue: 18339, devRevenuePct: null, devTrxPct: null, layerArpu: 'Low ARPU' }), 'new_active'));
test('critical_decline (revenue turun >=25%)', () => assert.strictEqual(computeGrowthStatus({ previousTrx: 100, currentTrx: 90, currentRevenue: 700, devRevenuePct: -0.30, devTrxPct: -0.10, layerArpu: 'Low ARPU' }), 'critical_decline'));
test('critical_decline (High ARPU, trx turun >=25%)', () => assert.strictEqual(computeGrowthStatus({ previousTrx: 100, currentTrx: 70, currentRevenue: 900, devRevenuePct: -0.05, devTrxPct: -0.30, layerArpu: 'High ARPU' }), 'critical_decline'));
test('declining (revenue turun 10-25%)', () => assert.strictEqual(computeGrowthStatus({ previousTrx: 100, currentTrx: 95, currentRevenue: 850, devRevenuePct: -0.15, devTrxPct: -0.05, layerArpu: 'Low ARPU' }), 'declining'));
test('rocket_growth', () => assert.strictEqual(computeGrowthStatus({ previousTrx: 100, currentTrx: 140, currentRevenue: 1300, devRevenuePct: 0.30, devTrxPct: 0.40, layerArpu: 'Low ARPU' }), 'rocket_growth'));
test('growing', () => assert.strictEqual(computeGrowthStatus({ previousTrx: 100, currentTrx: 115, currentRevenue: 1150, devRevenuePct: 0.15, devTrxPct: 0.15, layerArpu: 'Low ARPU' }), 'growing'));
test('stable', () => assert.strictEqual(computeGrowthStatus({ previousTrx: 100, currentTrx: 102, currentRevenue: 1020, devRevenuePct: 0.02, devTrxPct: 0.02, layerArpu: 'Low ARPU' }), 'stable'));
test('zero_activity (0 vs 0, bukan stabil)', () => assert.strictEqual(computeGrowthStatus({ previousTrx: 0, currentTrx: 0, currentRevenue: 0, devRevenuePct: 0, devTrxPct: 0, layerArpu: 'Low ARPU' }), 'zero_activity'));

console.log('\n-- Business logic: anomaly flags --');
test('volume_no_revenue', () => assert.ok(computeAnomalyFlags({ currentTrx: 20, currentRevenue: 0, devTrx: 5, devRevenue: 0 }).includes('volume_no_revenue')));
test('trx_up_revenue_down', () => assert.ok(computeAnomalyFlags({ currentTrx: 20, currentRevenue: 500, devTrx: 5, devRevenue: -100 }).includes('trx_up_revenue_down')));
test('trx_down_revenue_up', () => assert.ok(computeAnomalyFlags({ currentTrx: 20, currentRevenue: 500, devTrx: -5, devRevenue: 100 }).includes('trx_down_revenue_up')));

console.log('\n-- Priority P0-P3 (finalizePriorities, batch context) --');
{
  const rows = [
    { id_outlet: 'A', layerArpu: 'Top ARPU', status: 'critical_decline', dev_revenue_pct: -0.3, dev_trx_pct: -0.1, anomaly_flags: [], previousRevenue: 500000, revenue_at_risk: 150000 },
    { id_outlet: 'B', layerArpu: 'Low ARPU', status: 'growing', dev_revenue_pct: 0.15, dev_trx_pct: 0.10, anomaly_flags: [], previousRevenue: 10000, revenue_at_risk: 0 },
    { id_outlet: 'C', layerArpu: 'Mid ARPU', status: 'stable', dev_revenue_pct: 0.01, dev_trx_pct: 0.0, anomaly_flags: [], previousRevenue: 20000, revenue_at_risk: 0 },
    { id_outlet: 'D', layerArpu: 'Low ARPU', status: 'stable', dev_revenue_pct: 0, dev_trx_pct: 0, anomaly_flags: ['volume_no_revenue'], previousRevenue: 5000, revenue_at_risk: 0 },
  ];
  const result = finalizePriorities(rows.map(r => ({ ...r })));
  const byId = Object.fromEntries(result.map(r => [r.id_outlet, r]));
  test('High/Top ARPU critical_decline => P0', () => assert.strictEqual(byId.A.priority, 'P0'));
  test('Growing Low ARPU => P2', () => assert.strictEqual(byId.B.priority, 'P2'));
  test('Stable normal => P3', () => assert.strictEqual(byId.C.priority, 'P3'));
  test('Volume no revenue => P0 (walau status stable)', () => assert.strictEqual(byId.D.priority, 'P0'));
}

console.log('\n-- Segmentasi --');
test('Churned', () => assert.strictEqual(computeSegment({ status: 'churned', layerArpu: 'Low ARPU', anomalyFlags: [], devTrx: -5, devRevenue: -100 }), 'Churned'));
test('High Value At Risk', () => assert.strictEqual(computeSegment({ status: 'declining', layerArpu: 'High ARPU', anomalyFlags: [], devTrx: -5, devRevenue: -100 }), 'High Value At Risk'));
test('Volume No Revenue', () => assert.strictEqual(computeSegment({ status: 'stable', layerArpu: 'Low ARPU', anomalyFlags: ['volume_no_revenue'], devTrx: 5, devRevenue: 0 }), 'Volume No Revenue'));
test('Upgrade Opportunity', () => assert.strictEqual(computeSegment({ status: 'growing', layerArpu: 'Low ARPU', anomalyFlags: [], devTrx: 5, devRevenue: 100 }), 'Upgrade Opportunity'));
test('Growth Champion', () => assert.strictEqual(computeSegment({ status: 'growing', layerArpu: 'High ARPU', anomalyFlags: [], devTrx: 5, devRevenue: 100 }), 'Growth Champion'));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
