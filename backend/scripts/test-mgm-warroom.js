'use strict';

/**
 * Test/validation manual untuk MGM PA — PB Lifecycle & Productivity Control
 * Tower. TIDAK butuh DB, hanya menguji pure functions di backend/src/lib/
 * mgm-utils.js DAN parser Apps Script (apps-script-mgm-pa.js, di-require
 * langsung lewat guard `module.exports` supaya diuji implementasi yang
 * PERSIS sama dengan yang jalan di Google Apps Script, bukan salinan).
 *
 * Jalankan dengan:
 *   node backend/scripts/test-mgm-warroom.js
 */

// ── Polyfill minimal Apps Script globals (Utilities/PropertiesService/Logger)
// supaya apps-script-mgm-pa.js bisa di-require dari Node tanpa error. HANYA
// dipakai untuk testing — Apps Script sungguhan punya implementasi asli.
global.Utilities = {
  formatDate(date, tz, fmt) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    if (fmt === 'yyyy') return map.year;
    if (fmt === 'MM') return map.month;
    if (fmt === 'dd') return map.day;
    return `${map.year}-${map.month}-${map.day}`;
  },
};
global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'test-token' }) };
global.Logger = { log: () => {} };

// warroom-mgm.js fail-fast kalau MGM_SYNC_TOKEN/MGM_PA_SYNC_TOKEN kosong —
// isi dummy HANYA supaya require() di process test ini tidak crash duluan
// sebelum sempat menguji apa pun (skenario fail-fast sungguhan diuji lewat
// subprocess terpisah di bawah, bukan lewat require in-process ini). Bukan
// token asli, tidak pernah dicetak.
if (!process.env.MGM_SYNC_TOKEN && !process.env.MGM_PA_SYNC_TOKEN) {
  process.env.MGM_SYNC_TOKEN = 'test-fake-token-for-inline-testing-only';
}

const assert = require('assert');
const path = require('path');
const {
  cleanNum, normalizeMgmDate, countBlockIds_,
} = require(path.join(__dirname, '../../apps-script-mgm-pa.js'));

const {
  safeNumber, safeBoolean, safePct, pctDelta, pointDelta, dedupeLastWins,
  classifyPb, computeSegmentationThresholds, computeCoreKpis, buildPeriodAnalytics,
} = require('../src/lib/mgm-utils');

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

console.log('=== MGM PA Control Tower — Test Suite ===\n');

console.log('-- 1-3. Date normalization (Apps Script parser) --');
test('1. DD/MM/YYYY "09/05/2026" pada sheet Mei (expectedMonth=5) -> 2026-05-09', () => {
  assert.strictEqual(normalizeMgmDate('09/05/2026', 5, 2026, true), '2026-05-09');
});
test('2. Date object yang terbaca 2026-09-05 pada expected Mei -> swap ke 2026-05-09', () => {
  // Date object: 5 Sept 2026 siang UTC (aman terhadap offset TZ manapun +/-12).
  const d = new Date(Date.UTC(2026, 8, 5, 12));
  assert.strictEqual(normalizeMgmDate(d, 5, 2026, true), '2026-05-09');
});
test('3. REG.tanggal_aktifasi enforceSheetMonth=false tetap 2026-06-15 (bukan bulan sheet)', () => {
  assert.strictEqual(normalizeMgmDate('2026-06-15', 5, 2026, false), '2026-06-15');
});

console.log('\n-- Extra: countBlockIds_ (audit read-only auditMgmSheetCounts) --');
test('countBlockIds_ menghitung non-blank/unique/duplikat dengan benar', () => {
  const headerMap = { id_outlet: 0 };
  const dataRows = [['A'], ['B'], ['A'], [''], ['C'], [null]];
  const stat = countBlockIds_(dataRows, headerMap, 'id_outlet');
  assert.strictEqual(stat.nonBlank, 4, 'A,B,A,C = 4 baris non-blank (blank/null di-skip)');
  assert.strictEqual(stat.unique, 3, 'A,B,C = 3 id unik');
  assert.strictEqual(stat.duplicateCount, 1, 'A muncul 2x = 1 id dianggap duplikat');
});

console.log('\n-- 4-5. Numeric cleaner (Apps Script parser) --');
test('4a. Number native 408146.85 tidak kehilangan titik', () => {
  assert.strictEqual(cleanNum(408146.85), 408146.85);
});
test('4b. String format ID "408.146,85" -> 408146.85', () => {
  assert.strictEqual(cleanNum('408.146,85'), 408146.85);
});
test('4c. String format EN "408146.85" -> 408146.85 (bukan 40814685)', () => {
  assert.strictEqual(cleanNum('408146.85'), 408146.85);
});
test('5. Scientific notation "4.0814685e5" -> 408146.85', () => {
  assert.strictEqual(cleanNum('4.0814685e5'), 408146.85);
});

console.log('\n-- 6-7. Dedupe --');
test('6. Dedupe last-occurrence-wins by id_outlet', () => {
  const { rows, duplicateCount } = dedupeLastWins(
    [{ id_outlet: 'A', v: 1 }, { id_outlet: 'B', v: 1 }, { id_outlet: 'A', v: 2 }],
    r => r.id_outlet
  );
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(duplicateCount, 1);
  assert.strictEqual(rows.find(r => r.id_outlet === 'A').v, 2); // occurrence terakhir menang
});
test('7. Duplicate id_outlet pada detail TIDAK menghapus dua id_aktifasi berbeda (PK = id_aktifasi)', () => {
  const { rows, duplicateCount } = dedupeLastWins(
    [{ id_aktifasi: '1', id_outlet: 'X' }, { id_aktifasi: '2', id_outlet: 'X' }],
    d => d.id_aktifasi
  );
  assert.strictEqual(rows.length, 2, 'satu outlet dgn 2 id_aktifasi harus tetap 2 baris');
  assert.strictEqual(duplicateCount, 0);
});

console.log('\n-- 8-9. Delta rules --');
test('8. pctDelta previous=0 -> null (bukan Infinity)', () => {
  assert.strictEqual(pctDelta(50, 0), null);
});
test('8b. pctDelta normal 100 vs 80 -> 25%', () => {
  assert.strictEqual(pctDelta(100, 80), 25);
});
test('9. pointDelta 45.1128 vs 47.8941 -> percentage point (bukan relative %)', () => {
  const d = pointDelta(45.1128, 47.8941);
  assert.ok(Math.abs(d - (-2.7813)) < 0.001, `got ${d}`);
});
test('9b. pointDelta null jika salah satu rate null', () => {
  assert.strictEqual(pointDelta(null, 47.8), null);
});

console.log('\n-- 10. PB classification cascade --');
test('10a. Costly PB — activation_commission < 0', () => {
  const thresholds = computeSegmentationThresholds([]);
  const status = classifyPb({
    registrations: 5, reg_to_paid_conversion_pct: 80, activation_to_transaction_pct: 80,
    total_revenue: 1000, revenue_per_activated_outlet: 200, activation_commission: -50,
    negative_activation_count: 1, negative_activation_rate: 50,
  }, thresholds);
  assert.strictEqual(status, 'Costly PB');
});
test('10b. Growth Engine — semua metrik >= P50', () => {
  const pbRows = [
    { registrations: 10, reg_to_paid_conversion_pct: 50, activation_to_transaction_pct: 50, total_revenue: 1000, activation_commission: 10, negative_activation_count: 0 },
    { registrations: 20, reg_to_paid_conversion_pct: 60, activation_to_transaction_pct: 60, total_revenue: 2000, activation_commission: 20, negative_activation_count: 0 },
  ];
  const thresholds = computeSegmentationThresholds(pbRows);
  const status = classifyPb(pbRows[1], thresholds);
  assert.strictEqual(status, 'Growth Engine');
});
test('10c. Low Activity — di bawah semua threshold (distribusi 3 PB spy percentile bermakna)', () => {
  const pbRows = [
    { registrations: 100, reg_to_paid_conversion_pct: 80, activation_to_transaction_pct: 80, total_revenue: 100000, revenue_per_activated_outlet: 1000, activation_commission: 5000, negative_activation_count: 0 },
    { registrations: 90,  reg_to_paid_conversion_pct: 70, activation_to_transaction_pct: 70, total_revenue: 90000,  revenue_per_activated_outlet: 900,  activation_commission: 4000, negative_activation_count: 0 },
    { registrations: 1,   reg_to_paid_conversion_pct: 1,  activation_to_transaction_pct: 1,  total_revenue: 10,    revenue_per_activated_outlet: 10,   activation_commission: 1,    negative_activation_count: 0 },
  ];
  const thresholds = computeSegmentationThresholds(pbRows);
  const status = classifyPb(pbRows[2], thresholds);
  assert.strictEqual(status, 'Low Activity');
});

console.log('\n-- 11. Cohort conversion = intersection REG x DETAIL, bukan events/registrations --');
test('11. converted_registrations pakai intersection id_outlet, bukan count(id_aktifasi)', () => {
  // Outlet 'A' punya 2 record aktivasi_detail (2 id_aktifasi berbeda) tapi
  // tetap 1 converted_registrations (1 outlet). paid_activation_events harus 2.
  const reg = [{ id_outlet: 'A', upline: 'PB1' }, { id_outlet: 'B', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', upline: 'PB1', trx: 1, rev: 10 }];
  const det = [
    { id_aktifasi: '1', id_outlet: 'A', upline: 'PB1', fee_upline: 10, komisi_aktifasi: 5 },
    { id_aktifasi: '2', id_outlet: 'A', upline: 'PB1', fee_upline: 10, komisi_aktifasi: 5 },
  ];
  const kpi = computeCoreKpis(reg, akt, det);
  assert.strictEqual(kpi.registrations, 2);
  assert.strictEqual(kpi.paid_activation_events, 2, 'jumlah kejadian aktivasi = jumlah id_aktifasi');
  assert.strictEqual(kpi.converted_registrations, 1, 'converted = jumlah OUTLET yg match, bukan jumlah event');
  // 630/931 style bug check: reg_to_paid_conversion_pct TIDAK BOLEH pakai paid_activation_events/registrations
  const wrongFormula = safePct(kpi.paid_activation_events, kpi.registrations); // 2/2 = 100
  assert.notStrictEqual(kpi.reg_to_paid_conversion_pct, wrongFormula === 100 ? 999 : wrongFormula); // sanity: formula benar pakai converted_registrations
  assert.strictEqual(kpi.reg_to_paid_conversion_pct, 50); // 1 converted / 2 registrations = 50%, BUKAN 2/2=100%
});

console.log('\n-- 12. Formula audit TIDAK menimpa nilai sumber komisi_aktifasi --');
test('12. economics.formula_mismatch melaporkan selisih, activation_commission tetap pakai nilai sumber', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', upline: 'PB1', trx: 1, rev: 10 }];
  // Formula: biaya_aktifasi_2 - hpp - ongkos_kirim - fee_upline = 200 - 30 - 20 - 100 = 50
  // Tapi sumber sheet bilang komisi_aktifasi = 999 (sengaja beda) — sistem HARUS tetap pakai 999.
  const det = [{ id_aktifasi: '1', id_outlet: 'A', upline: 'PB1', biaya_aktifasi_2: 200, hpp: 30, ongkos_kirim: 20, fee_upline: 100, komisi_aktifasi: 999 }];
  const result = buildPeriodAnalytics({
    registrasi: reg, aktivasi: akt, detail: det,
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, {});
  assert.strictEqual(result.summary.current.activation_commission, 999, 'komisi resmi = nilai sumber, BUKAN hasil formula (50)');
  assert.strictEqual(result.economics.formula_mismatch.length, 1, 'mismatch harus terdeteksi & dilaporkan');
  assert.strictEqual(result.economics.formula_mismatch[0].expected, 50);
  assert.strictEqual(result.economics.formula_mismatch[0].actual, 999);
});

console.log('\n-- Extra: safeBoolean tidak menebak unknown jadi false --');
test('safeBoolean("") -> null (bukan false)', () => {
  assert.strictEqual(safeBoolean(''), null);
});
test('safeBoolean(1) -> true, safeBoolean(0) -> false', () => {
  assert.strictEqual(safeBoolean(1), true);
  assert.strictEqual(safeBoolean(0), false);
});

console.log('\n-- Extra: safeNumber guard --');
test('safeNumber(undefined) -> 0', () => {
  assert.strictEqual(safeNumber(undefined), 0);
});

// ─────────────────────────────────────────────────────────────────
// MGM_SYNC_TOKEN — env-only, fail-fast. Nilai token ASLI TIDAK PERNAH
// dipakai/dicetak di sini — semua contoh di bawah pakai string dummy
// ("test-fake-token-not-real", dst.) yang bukan credential sungguhan.
// Modul di-load di subprocess terpisah (bukan require() langsung di
// process ini) karena guard `if (!MGM_SYNC_TOKEN) throw` jalan sekali
// saat module pertama kali di-load — subprocess memastikan tiap skenario
// env diuji dari kondisi module-cache yang bersih.
// ─────────────────────────────────────────────────────────────────
console.log('\n-- MGM_SYNC_TOKEN: env-only config + fail-fast --');
const { spawnSync } = require('child_process');
const routePath = path.join(__dirname, '../src/routes/warroom-mgm.js');

function tryLoadWarroomMgm(envOverrides) {
  // MGM_SYNC_TOKEN & MGM_PA_SYNC_TOKEN SELALU di-set eksplisit (walau ke '')
  // supaya .env lokal (kalau ada) tidak diam-diam mengisi nilai lewat
  // dotenv.config() di db.js — dotenv tidak menimpa key yang sudah ada.
  const env = {
    ...process.env,
    MGM_SYNC_TOKEN: '', MGM_PA_SYNC_TOKEN: '',
    ...envOverrides,
  };
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(routePath)}); console.log('MODULE_LOADED_OK');`], {
    env, encoding: 'utf8', timeout: 15000,
  });
}

test('module gagal load (fail-fast) kalau MGM_SYNC_TOKEN & MGM_PA_SYNC_TOKEN kosong dua-duanya', () => {
  const res = tryLoadWarroomMgm({});
  assert.notStrictEqual(res.status, 0, 'proses harus exit non-zero');
  assert.ok(/MGM_SYNC_TOKEN or MGM_PA_SYNC_TOKEN must be configured/.test(res.stderr || ''), `stderr harus sebut pesan error yang jelas, dapat: ${res.stderr}`);
});
test('module berhasil load kalau HANYA MGM_SYNC_TOKEN terisi', () => {
  const res = tryLoadWarroomMgm({ MGM_SYNC_TOKEN: 'test-fake-token-not-real' });
  assert.strictEqual(res.status, 0, `harus exit 0, stderr: ${res.stderr}`);
  assert.ok(/MODULE_LOADED_OK/.test(res.stdout || ''));
});
test('module berhasil load kalau HANYA MGM_PA_SYNC_TOKEN terisi (alias lama tetap didukung)', () => {
  const res = tryLoadWarroomMgm({ MGM_PA_SYNC_TOKEN: 'test-fake-legacy-token-not-real' });
  assert.strictEqual(res.status, 0, `harus exit 0, stderr: ${res.stderr}`);
  assert.ok(/MODULE_LOADED_OK/.test(res.stdout || ''));
});
test('tidak ada token literal (bric2026...) tersisa di warroom-mgm.js', () => {
  const src = require('fs').readFileSync(routePath, 'utf8');
  assert.ok(!/bric2026/i.test(src), 'source tidak boleh mengandung literal token legacy apa pun');
});

const { safeTokenEqual } = require('../src/routes/warroom-mgm')._internal;
test('safeTokenEqual: token benar diterima (pakai nilai dummy, bukan token asli)', () => {
  assert.strictEqual(safeTokenEqual('dummy-correct-value-abc', 'dummy-correct-value-abc'), true);
});
test('safeTokenEqual: token salah ditolak', () => {
  assert.strictEqual(safeTokenEqual('dummy-wrong-value', 'dummy-correct-value-abc'), false);
});
test('safeTokenEqual: panjang beda ditolak tanpa error', () => {
  assert.strictEqual(safeTokenEqual('short', 'a-much-longer-dummy-value'), false);
});

console.log(`\n=== Selesai: ${pass} pass, ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
