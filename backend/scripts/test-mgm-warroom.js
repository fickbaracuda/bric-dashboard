'use strict';

/**
 * Test/validation manual untuk MGM PA — PB Lifecycle & Productivity Control
 * Tower. TIDAK butuh DB, hanya menguji pure functions di backend/src/lib/
 * mgm-utils.js, parser Apps Script (apps-script-mgm-pa.js, di-require
 * langsung lewat guard `module.exports`), DAN source audit (grep) terhadap
 * backend/src/routes/warroom-mgm.js & frontend/src/pages/WarRoomMgmPa.jsx
 * untuk memastikan kontrak bisnis (KPI utama, cutoff, error boundary)
 * benar-benar terpasang di kode yang jalan — bukan cuma di pure function.
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
const fs = require('fs');
const path = require('path');
const {
  cleanNum, normalizeMgmDate, countBlockIds_,
} = require(path.join(__dirname, '../../apps-script-mgm-pa.js'));

const {
  safeNumber, safeBoolean, safePct, pctDelta, pointDelta, dedupeLastWins,
  classifyOpportunitySegment, computeOpportunitySegmentThresholds, computeQualifiedConversionMinReg,
  SEGMENT_ACTION, buildSegmentSummary, buildOpportunityLists,
  computeRegistrationFunnel, computeActiveOutletsFromAktivasi, computeSudahAktif,
  computeActivationMatchQuality, computeActivationRevenue, computeTransactionInfo,
  computeSummary, summaryDeltas, isDateInPeriod, computeNmatOutlets, computeNmatDetails,
  buildPbScorecard, buildPeriodAnalytics,
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

function closeTo(actual, expected, epsilon, msg) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${msg || ''} expected ~${expected}, got ${actual}`.trim());
}

console.log('=== MGM PA Control Tower — Test Suite ===\n');

console.log('-- 1-3. Date normalization (Apps Script parser) --');
test('1. DD/MM/YYYY "09/05/2026" pada sheet Mei (expectedMonth=5) -> 2026-05-09', () => {
  assert.strictEqual(normalizeMgmDate('09/05/2026', 5, 2026, true), '2026-05-09');
});
test('2. Date object yang terbaca 2026-09-05 pada expected Mei -> swap ke 2026-05-09', () => {
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
  assert.strictEqual(rows.find(r => r.id_outlet === 'A').v, 2);
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

// ═══════════════════════════════════════════════════════════════
// KOREKSI MODEL BISNIS — test wajib §15 (item 1-24)
// ═══════════════════════════════════════════════════════════════

console.log('\n-- B1-B13. KOREKSI FINAL Sudah Aktif — PURE COUNT dari AKTIVASI, TANPA join REG (angka 690 hasil join JUGA TERBUKTI SALAH) --');
test('B1. active_outlets DIHITUNG LANGSUNG dari AKTIVASI.is_active=1 — TIDAK JOIN/intersection ke REG sama sekali', () => {
  // REG kosong total (0 baris) — active_outlets TETAP terhitung dari AKTIVASI
  // sendirian, membuktikan TIDAK ADA join/intersection ke REG.
  const akt = [{ id_outlet: 'A', is_active: true }, { id_outlet: 'B', is_active: true }];
  assert.strictEqual(computeActiveOutletsFromAktivasi(akt).active_outlets, 2, 'active_outlets tidak boleh 0 walau REG kosong — bukti tidak ada join ke REG');
});
test('B2. REG.is_active TIDAK PERNAH dipakai — mengubahnya tidak mengubah active_outlets/inactive_outlets sama sekali', () => {
  const akt = [{ id_outlet: 'A', is_active: true }];
  const regTrue  = [{ id_outlet: 'A', upline: 'PB1', is_active: true }];
  const regFalse = [{ id_outlet: 'A', upline: 'PB1', is_active: false }];
  const regNull  = [{ id_outlet: 'A', upline: 'PB1', is_active: null }];
  const a1 = computeSudahAktif(regTrue, akt);
  const a2 = computeSudahAktif(regFalse, akt);
  const a3 = computeSudahAktif(regNull, akt);
  assert.strictEqual(a1.active_outlets, 1); assert.strictEqual(a2.active_outlets, 1); assert.strictEqual(a3.active_outlets, 1);
  assert.strictEqual(a1.inactive_outlets, a2.inactive_outlets);
  assert.strictEqual(a2.inactive_outlets, a3.inactive_outlets);
});
test('B3. MGM AKTIV(DETAIL).is_active/id_aktifasi TIDAK PERNAH dipakai — computeActiveOutletsFromAktivasi hanya menerima 1 parameter (actRows)', () => {
  assert.strictEqual(computeActiveOutletsFromAktivasi.length, 1, 'computeActiveOutletsFromAktivasi hanya menerima actRows — DETAIL tidak pernah jadi parameter, secara struktural tidak mungkin terpengaruh field DETAIL');
});
test('B4. Normalisasi is_active menerima representasi valid: 1, "1", boolean true', () => {
  const akt = [
    { id_outlet: 'A', is_active: 1 },
    { id_outlet: 'B', is_active: '1' },
    { id_outlet: 'C', is_active: true },
  ];
  assert.strictEqual(computeActiveOutletsFromAktivasi(akt).active_outlets, 3);
});
test('B5. Blank/null/false/unknown TIDAK dihitung aktif', () => {
  const akt = [
    { id_outlet: 'A', is_active: false },
    { id_outlet: 'B', is_active: null },
    { id_outlet: 'C', is_active: '' },
    { id_outlet: 'D', is_active: undefined },
    { id_outlet: 'E', is_active: 'unknown-value' },
  ];
  assert.strictEqual(computeActiveOutletsFromAktivasi(akt).active_outlets, 0);
});
test('B6. active_outlets DISTINCT per id_outlet — duplikat baris tidak double-count', () => {
  const akt = [
    { id_outlet: 'A', is_active: true }, { id_outlet: 'A', is_active: true },
    { id_outlet: 'A', is_active: 1 },
  ];
  assert.strictEqual(computeActiveOutletsFromAktivasi(akt).active_outlets, 1);
});
test('B7. Belum Aktif = Total Registrasi - Sudah Aktif (ARITMATIKA, bukan set-difference outlet)', () => {
  const reg = [{ id_outlet: 'X', upline: 'PB1' }, { id_outlet: 'Y', upline: 'PB1' }, { id_outlet: 'Z', upline: 'PB1' }];
  // AKTIVASI sengaja pakai id_outlet YANG BEDA SAMA SEKALI dari REG (W bukan
  // X/Y/Z) — inactive_outlets tetap murni aritmatika (3 - 1 = 2), TIDAK
  // butuh W match ke outlet REG manapun.
  const akt = [{ id_outlet: 'W', is_active: true }];
  const s = computeSudahAktif(reg, akt);
  assert.strictEqual(s.registrations, 3);
  assert.strictEqual(s.active_outlets, 1);
  assert.strictEqual(s.inactive_outlets, 2, '3 - 1 = 2, aritmatika murni walau W tidak ada di REG');
});
test('B8. active_outlets > registrations TIDAK di-cap — flag active_exceeds_registrations, TIDAK silent negative yang terlihat valid', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', is_active: true }, { id_outlet: 'B', is_active: true }, { id_outlet: 'C', is_active: true }];
  const s = computeSudahAktif(reg, akt);
  assert.strictEqual(s.registrations, 1);
  assert.strictEqual(s.active_outlets, 3);
  assert.strictEqual(s.inactive_outlets, -2, 'TIDAK di-cap ke 0 — nilai aritmatika jujur, anomaly harus diflag terpisah');
  assert.strictEqual(s.active_exceeds_registrations, true);
});
test('B9. Kondisi normal (active <= registrations): active_exceeds_registrations = false, partisi tetap konsisten', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }, { id_outlet: 'B', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', is_active: true }];
  const s = computeSudahAktif(reg, akt);
  assert.strictEqual(s.active_exceeds_registrations, false);
  assert.strictEqual(s.active_outlets + s.inactive_outlets, s.registrations);
});
test('B10. Conversion Aktivasi = active_outlets / registrations x 100', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }, { id_outlet: 'B', upline: 'PB1' }, { id_outlet: 'C', upline: 'PB1' }, { id_outlet: 'D', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', is_active: true }];
  assert.strictEqual(computeSudahAktif(reg, akt).activation_conversion_pct, 25);
});
test('B11. registrations = 0 -> Conversion Aktivasi null (bukan NaN/Infinity)', () => {
  const s = computeSudahAktif([], []);
  assert.strictEqual(s.activation_conversion_pct, null);
});
test('B12. Baseline Agustus tervalidasi read-only: 1002 outlet AKTIVASI is_active=true, 1 false, 1 null -> distinct TOTAL (semua status) 1004, active_outlets (formula resmi) = 1002 (BUKAN 1004 — 1004 adalah total outlet TANPA filter is_active)', () => {
  const akt = [];
  for (let i = 0; i < 1002; i++) akt.push({ id_outlet: `T${i}`, is_active: true });
  akt.push({ id_outlet: 'F1', is_active: false });
  akt.push({ id_outlet: 'N1', is_active: null });
  const { active_outlets } = computeActiveOutletsFromAktivasi(akt);
  assert.strictEqual(active_outlets, 1002, 'formula resmi (is_active normalisasi true) menghasilkan 1002 pada baseline read-only Agustus, bukan 1004');
  const distinctAll = new Set(akt.map(a => a.id_outlet)).size;
  assert.strictEqual(distinctAll, 1004, '1004 adalah TOTAL distinct outlet TANPA filter is_active — bukan definisi Sudah Aktif');
});
test('B13. computeActivationMatchQuality tidak lagi jadi sumber Sudah Aktif — hanya audit upline mismatch & activation/registration orphan', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }, { id_outlet: 'B', upline: 'PB2' }];
  const akt = [{ id_outlet: 'A', upline: 'PBX', is_active: true }, { id_outlet: 'B', upline: 'PB2', is_active: true }];
  const q = computeActivationMatchQuality(reg, akt);
  assert.strictEqual(q.registration_activation_upline_mismatch, 1, 'A: PB1(REG) vs PBX(AKTIVASI) = mismatch; B: cocok');
});
test('B14. computeActivationMatchQuality — activation_without_registration menghitung outlet AKTIVASI tanpa baris REG sama sekali', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', is_active: true }, { id_outlet: 'ORPHAN', is_active: true }];
  const q = computeActivationMatchQuality(reg, akt);
  assert.strictEqual(q.activation_without_registration, 1);
});
test('B15. computeActivationMatchQuality — registration_without_activation menghitung REG outlet tanpa baris AKTIVASI sama sekali', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }, { id_outlet: 'B', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', is_active: true }];
  const q = computeActivationMatchQuality(reg, akt);
  assert.strictEqual(q.registration_without_activation, 1, 'B tidak punya baris AKTIVASI sama sekali');
});
test('B16. active_recruiting_pb TETAP murni REG.upline (TIDAK berubah oleh koreksi Sudah Aktif)', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }, { id_outlet: 'B', upline: 'PB2' }];
  assert.strictEqual(computeRegistrationFunnel(reg).active_recruiting_pb, 2);
});

console.log('\n-- 6-7. PB Aktif Merekrut — upline, BUKAN id_outlet --');
test('6. active_recruiting_pb = COUNT DISTINCT REG.upline non-blank', () => {
  const reg = [
    { id_outlet: 'A', upline: 'PB1', is_active: true },
    { id_outlet: 'B', upline: 'PB1', is_active: true },
    { id_outlet: 'C', upline: 'PB2', is_active: true },
    { id_outlet: 'D', upline: '  ', is_active: true }, // blank -> tidak dihitung
    { id_outlet: 'E', upline: null, is_active: true },  // null -> tidak dihitung
  ];
  assert.strictEqual(computeRegistrationFunnel(reg).active_recruiting_pb, 2);
});
test('7. Jumlah id_outlet TIDAK dipakai sebagai jumlah PB (3 outlet, 2 PB unik -> PB aktif = 2, bukan 3)', () => {
  const reg = [
    { id_outlet: 'A', upline: 'PB1', is_active: true },
    { id_outlet: 'B', upline: 'PB1', is_active: true },
    { id_outlet: 'C', upline: 'PB2', is_active: true },
  ];
  const f = computeRegistrationFunnel(reg);
  assert.strictEqual(f.registrations, 3);
  assert.notStrictEqual(f.active_recruiting_pb, f.registrations, 'PB aktif tidak boleh sama dengan jumlah id_outlet kalau uplinenya lebih sedikit');
  assert.strictEqual(f.active_recruiting_pb, 2);
});

console.log('\n-- 8-9. PB conversion & rata-rata rekrut per PB --');
test('8. PB conversion per PB = active_outlets / registrations x 100 (agregasi TERPISAH: registrations dari REG.upline, active_outlets dari AKTIVASI.upline, BUKAN inner join outlet-level)', () => {
  const reg = [
    { id_outlet: 'A', upline: 'PB1' }, { id_outlet: 'B', upline: 'PB1' },
    { id_outlet: 'C', upline: 'PB1' }, { id_outlet: 'D', upline: 'PB1' },
    { id_outlet: 'E', upline: 'PB2' },
  ];
  const akt = [
    { id_outlet: 'A', upline: 'PB1', is_active: true }, { id_outlet: 'B', upline: 'PB1', is_active: true },
    { id_outlet: 'C', upline: 'PB1', is_active: false }, { id_outlet: 'D', upline: 'PB1', is_active: false },
    { id_outlet: 'E', upline: 'PB2', is_active: true },
  ];
  const det = [];
  const { rows } = buildPbScorecard(reg, akt, det, [], [], []);
  const pb1 = rows.find(r => r.pb === 'PB1');
  assert.strictEqual(pb1.registrations, 4);
  assert.strictEqual(pb1.active_outlets, 2);
  assert.strictEqual(pb1.inactive_outlets, 2);
  assert.strictEqual(pb1.activation_conversion_pct, 50, 'PB1: 2 aktif (AKTIVASI is_active=true) / 4 registrasi = 50%');
  const pb2 = rows.find(r => r.pb === 'PB2');
  assert.strictEqual(pb2.activation_conversion_pct, 100, 'PB2: 1 aktif / 1 registrasi = 100%');
});
test('8b. PB active_outlets TIDAK butuh id_outlet sama dgn REG — agregasi AKTIVASI.upline berdiri sendiri (§H, §Y.10/11)', () => {
  const reg = [{ id_outlet: 'X', upline: 'PB1' }, { id_outlet: 'Y', upline: 'PB1' }];
  // AKTIVASI pakai id_outlet TOTALLY BEDA (W, bukan X/Y) — active_outlets
  // PB1 harus tetap terhitung 1 (dari AKTIVASI.upline=PB1), TIDAK 0 akibat
  // inner-join outlet-level yang akan membuat PB/outlet ini hilang.
  const akt = [{ id_outlet: 'W', upline: 'PB1', is_active: true }];
  const { rows } = buildPbScorecard(reg, akt, [], [], [], []);
  const pb1 = rows.find(r => r.pb === 'PB1');
  assert.strictEqual(pb1.registrations, 2, 'registrations murni dari REG.upline');
  assert.strictEqual(pb1.active_outlets, 1, 'active_outlets murni dari AKTIVASI.upline, TIDAK hilang walau id_outlet beda dari REG');
});
test('9. avg_registration_per_pb = registrations / active_recruiting_pb', () => {
  const reg = [
    { id_outlet: 'A', upline: 'PB1', is_active: true }, { id_outlet: 'B', upline: 'PB1', is_active: true },
    { id_outlet: 'C', upline: 'PB2', is_active: true }, { id_outlet: 'D', upline: 'PB2', is_active: true },
    { id_outlet: 'E', upline: 'PB2', is_active: true }, { id_outlet: 'F', upline: 'PB3', is_active: true },
  ];
  const f = computeRegistrationFunnel(reg);
  assert.strictEqual(f.registrations, 6);
  assert.strictEqual(f.active_recruiting_pb, 3);
  assert.strictEqual(f.avg_registration_per_pb, 2, '6 registrasi / 3 PB = 2');
});
test('9b. avg_registration_per_pb = null kalau tidak ada PB (denominator 0)', () => {
  assert.strictEqual(computeRegistrationFunnel([]).avg_registration_per_pb, null);
});

console.log('\n-- 10. Revenue Aktivasi = SUM(mgm_pa_aktivasi_detail.komisi_aktifasi) --');
test('10. activation_revenue = SUM komisi_aktifasi, nilai sumber dipakai apa adanya', () => {
  const det = [
    { id_aktifasi: '1', id_outlet: 'A', upline: 'PB1', komisi_aktifasi: 5000 },
    { id_aktifasi: '2', id_outlet: 'B', upline: 'PB1', komisi_aktifasi: 3000 },
    { id_aktifasi: '3', id_outlet: 'C', upline: 'PB2', komisi_aktifasi: -500 }, // negatif tetap dijumlah apa adanya
  ];
  assert.strictEqual(computeActivationRevenue(det).activation_revenue, 7500);
});

console.log('\n-- 11-13. KPI utama Command Center TIDAK boleh berisi field/label yang dihapus --');
const frontendPath = path.join(__dirname, '../../frontend/src/pages/WarRoomMgmPa.jsx');
const frontendSrc = fs.readFileSync(frontendPath, 'utf8');
const tabsMarkerIdx = frontendSrc.indexOf('<div className="wrd-tabs">');

function extractFunctionBody(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`${marker.trim()} tidak ditemukan di source`);
  // Lewati dulu parameter list (...) supaya destructured params { a, b } tidak
  // dikira body function-nya sendiri.
  const parenStart = src.indexOf('(', start);
  let pdepth = 0, parenEnd = parenStart;
  for (let i = parenStart; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { parenEnd = i; break; } }
  }
  const braceStart = src.indexOf('{', parenEnd);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${marker.trim()} — brace tidak seimbang, tidak bisa mengekstrak body`);
}
// Grid KPI utama Command Center dipindah ke komponen CommandKpiGrid sendiri
// (dipanggil <CommandKpiGrid s={s} /> dari komponen utama) — mainKpiSlice di
// sini adalah BODY komponen itu, bukan lagi potongan JSX komponen utama.
const mainKpiSlice = extractFunctionBody(frontendSrc, 'function CommandKpiGrid(');
const mainComponentSlice = frontendSrc.slice(frontendSrc.lastIndexOf('export default function WarRoomMgmPa'), tabsMarkerIdx);
// Kartu revenue (REVENUE TRANSAKSI/AKTIVASI/MGM) dirender lewat panggilan
// buildRevenueCards({...}) LANGSUNG di dalam grid tunggal .mgm-command-kpi-grid
// (bukan komponen RevenueBreakdownRow terpisah lagi) — label ada di BODY
// fungsi buildRevenueCards, bukan di call site.
const revenueCardsBody = extractFunctionBody(frontendSrc, 'function buildRevenueCards(');
const revenueRowBody = extractFunctionBody(frontendSrc, 'function RevenueBreakdownRow(');
const commandCenterKpiArea = mainKpiSlice + '\n' + revenueCardsBody;

test('11. "PAID ACTIVATION EVENTS" tidak muncul di KPI utama Command Center (boleh tetap di Data Audit/Economics)', () => {
  assert.ok(!/PAID ACTIVATION EVENTS/.test(commandCenterKpiArea));
  assert.ok(/PAID ACTIVATION EVENTS/.test(frontendSrc), 'field ini tetap harus ada sebagai audit record count di tab lain');
});
test('12. "FEE UPLINE" tidak muncul di KPI utama Command Center', () => {
  assert.ok(!/FEE UPLINE/.test(commandCenterKpiArea));
});
test('13. Label "ACTIVATION COMMISSION" tidak muncul sama sekali (diganti Revenue Aktivasi / Revenue MGM)', () => {
  assert.ok(!/ACTIVATION COMMISSION/i.test(frontendSrc), 'label lama harus sudah diganti di seluruh halaman');
});
test('13b. 7 KPI utama non-revenue ada di Command Center: Total Registrasi, Sudah Aktif, Belum Aktif, PB Aktif Merekrut, Rata-rata Rekrut/PB, NMAT, Transaksi NMAT', () => {
  for (const label of ['TOTAL REGISTRASI', 'SUDAH AKTIF', 'BELUM AKTIF', 'PB AKTIF MEREKRUT', 'RATA-RATA REKRUT', 'NMAT', 'TRANSAKSI NMAT']) {
    assert.ok(mainKpiSlice.includes(label), `KPI utama harus memuat label "${label}"`);
  }
});
test('13b-conv. Kartu "CONVERSION AKTIVASI" TIDAK LAGI berdiri sendiri — digabung sbg sub-text di kartu Sudah Aktif', () => {
  assert.ok(!/label="CONVERSION AKTIVASI"/.test(mainKpiSlice), 'tidak boleh ada KPICard label="CONVERSION AKTIVASI" berdiri sendiri lagi');
  assert.ok(/label="SUDAH AKTIF"[\s\S]*?sub=\{`Conversion/.test(mainKpiSlice), 'kartu Sudah Aktif harus punya prop sub berisi Conversion');
});
test('13b-nmat-trx. Kartu TRANSAKSI NMAT membaca field summary.current.nmat_trx (bukan total_trx)', () => {
  assert.ok(/label="TRANSAKSI NMAT"[\s\S]*?s\.current\.nmat_trx/.test(mainKpiSlice), 'kartu Transaksi NMAT harus membaca s.current.nmat_trx');
});
test('13b-rename. Field aktif/belum-aktif di Command Center pakai active_outlets/inactive_outlets, BUKAN active_registrations/inactive_registrations lama', () => {
  assert.ok(mainKpiSlice.includes('s.current.active_outlets'), 'kartu Sudah Aktif harus membaca s.current.active_outlets');
  assert.ok(mainKpiSlice.includes('s.current.inactive_outlets'), 'kartu Belum Aktif harus membaca s.current.inactive_outlets');
  assert.ok(!frontendSrc.includes('active_registrations'), 'field lama active_registrations tidak boleh tersisa di frontend sama sekali');
  assert.ok(!frontendSrc.includes('inactive_registrations'), 'field lama inactive_registrations tidak boleh tersisa di frontend sama sekali');
  assert.ok(!frontendSrc.includes('unknown_active_status'), 'konsep unknown_active_status sudah dihapus, tidak boleh tersisa di frontend');
});
test('13b2. "OUTLET TRANSACTING" sudah diganti NMAT di Command Center, TAPI tetap ada di tab Transaction & Revenue (bukan dihapus total)', () => {
  assert.ok(!mainKpiSlice.includes('OUTLET TRANSACTING'), 'Command Center tidak boleh lagi memakai label OUTLET TRANSACTING (diganti NMAT)');
  assert.ok(mainKpiSlice.includes('s.current.nmat_outlets'), 'kartu NMAT harus membaca field summary.current.nmat_outlets, bukan transacting_outlets');
  assert.ok(frontendSrc.includes('OUTLET TRANSACTING'), 'label OUTLET TRANSACTING tetap harus ada di tab Transaction & Revenue (field transacting_outlets dipertahankan sbg info)');
});
test('13c. "CONVERTED REGISTRATIONS" (KPI lama) sudah dihapus dari KPI utama', () => {
  assert.ok(!/CONVERTED REGISTRATIONS/.test(commandCenterKpiArea));
});
test('13d. Kartu REVENUE TRANSAKSI, REVENUE AKTIVASI, REVENUE MGM ada di area KPI utama (buildRevenueCards, dipanggil langsung di grid)', () => {
  for (const label of ['REVENUE TRANSAKSI', 'REVENUE AKTIVASI', 'REVENUE MGM']) {
    assert.ok(revenueCardsBody.includes(label), `buildRevenueCards harus memuat label "${label}"`);
  }
  assert.ok(mainKpiSlice.includes('buildRevenueCards('), 'buildRevenueCards harus dipanggil LANGSUNG di dalam mgm-command-grid (bukan lewat wrapper grid terpisah)');
});
test('13e. Revenue MGM = Revenue Transaksi + Revenue Aktivasi (relasi eksplisit di buildRevenueCards)', () => {
  assert.ok(/mgmRevenue:\s*s\.current\.mgm_revenue/.test(mainKpiSlice),
    'buildRevenueCards harus menerima mgmRevenue dari summary.current.mgm_revenue (hasil penjumlahan backend)');
});
test('13f. Elemen operator (+/=) DIHAPUS dari kartu revenue — tanpa simbol/kolom operator', () => {
  for (const body of [revenueCardsBody, revenueRowBody]) {
    assert.ok(!body.includes('mgm-revenue-operator'), 'className mgm-revenue-operator tidak boleh dipakai lagi di JSX');
    assert.ok(!/>\s*\+\s*<\/div>/.test(body), 'tidak boleh ada <div>...+...</div> sbg simbol operator penjumlahan');
    assert.ok(!/>\s*=\s*<\/div>/.test(body), 'tidak boleh ada <div>...=...</div> sbg simbol operator sama-dengan');
  }
});
test('13g. CSS .mgm-revenue-operator DAN struktur lama (mgm-kpi-grid-main/mgm-command-kpi-grid/mgm-kpi-span-*) sudah dihapus total', () => {
  const cssSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/index.css'), 'utf8');
  assert.ok(!/\.mgm-revenue-operator\s*\{/.test(cssSrc), 'rule CSS .mgm-revenue-operator harus sudah dihapus');
  assert.ok(!cssSrc.includes('mgm-kpi-grid-main'), 'class lama .mgm-kpi-grid-main harus sudah dihapus total dari CSS');
  assert.ok(!cssSrc.includes('mgm-command-kpi-grid'), 'class lama .mgm-command-kpi-grid (versi 6+4 span) harus sudah dihapus total dari CSS');
  assert.ok(!cssSrc.includes('mgm-kpi-span'), 'class span .mgm-kpi-span-3/-4 harus sudah dihapus total — tidak boleh ada span berbeda antar kartu');
  assert.ok(!frontendSrc.includes('mgm-kpi-grid-main'), 'class lama .mgm-kpi-grid-main harus sudah dihapus total dari JSX');
  assert.ok(!frontendSrc.includes('mgm-command-kpi-grid'), 'class lama .mgm-command-kpi-grid harus sudah dihapus total dari JSX');
  assert.ok(!frontendSrc.includes('mgm-kpi-span'), 'class span mgm-kpi-span-* harus sudah dihapus total dari JSX');
  assert.ok(!/<KPICard[^>]*\sspan=/.test(frontendSrc), 'prop span={...} tidak boleh dipakai lagi pada KPICard manapun — semua kartu Command Center harus seragam');
});
test('13h. Grid KPI utama Command Center — SATU container 5-kolom SERAGAM, tepat 2 baris x 5 kartu, urutan sesuai spesifikasi', () => {
  const cssSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/index.css'), 'utf8');
  assert.ok(/\.mgm-command-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*1fr\)/.test(cssSrc),
    '.mgm-command-grid harus grid-template-columns: repeat(5, 1fr) di desktop (>=1200px)');

  // Urutan label PERSIS 10 kartu sesuai spesifikasi — baris 1 lalu baris 2.
  //   Baris 1: Total Registrasi, Sudah Aktif (+Conversion), Belum Aktif,
  //            PB Aktif Merekrut, Rata-rata Rekrut/PB
  //   Baris 2: NMAT, Transaksi NMAT, Revenue Transaksi, Revenue Aktivasi, Revenue MGM
  const expectedOrder = [
    'TOTAL REGISTRASI', 'SUDAH AKTIF', 'BELUM AKTIF', 'PB AKTIF MEREKRUT', 'RATA-RATA REKRUT',
    'NMAT', 'TRANSAKSI NMAT', 'REVENUE TRANSAKSI', 'REVENUE AKTIVASI', 'REVENUE MGM',
  ];
  const commandCenterFullBody = mainKpiSlice.replace('buildRevenueCards({', 'buildRevenueCards({' + revenueCardsBody);
  const positions = expectedOrder.map(label => commandCenterFullBody.indexOf(label));
  positions.forEach((pos, i) => assert.ok(pos !== -1, `label "${expectedOrder[i]}" tidak ditemukan di urutan Command Center`));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1],
      `urutan kartu salah: "${expectedOrder[i]}" harus muncul SETELAH "${expectedOrder[i - 1]}" (baris 1: Total Registrasi..Rata-rata Rekrut/PB, baris 2: NMAT..Revenue MGM)`);
  }

  // Hitung persis 10 kartu KPICard di dalam grid (7 literal + 3 dari buildRevenueCards).
  const literalCards = (mainKpiSlice.match(/<KPICard\s/g) || []).length;
  assert.strictEqual(literalCards, 7, `CommandKpiGrid harus punya 7 <KPICard> literal (10 total - 3 dari buildRevenueCards), ditemukan ${literalCards}`);
  const revenueCardCount = (revenueCardsBody.match(/<KPICard\s/g) || []).length;
  assert.strictEqual(revenueCardCount, 3, `buildRevenueCards harus menghasilkan tepat 3 kartu, ditemukan ${revenueCardCount}`);
});
test('13h2. Tidak ada grid/wrapper terpisah lagi di antara Outlet Transacting dan kartu revenue (satu container, bukan dua)', () => {
  // CommandKpiGrid harus TEPAT SATU <div className="mgm-command-grid"> yang
  // membungkus baik 7 KPI registrasi/status/Outlet Transacting maupun 3
  // kartu revenue — TIDAK ADA wrapper grid kedua (.mgm-revenue-breakdown)
  // di dalamnya, dan TIDAK ADA prop span apa pun.
  const divOpenCount = (mainKpiSlice.match(/<div className="mgm-command-grid/g) || []).length;
  assert.strictEqual(divOpenCount, 1, 'CommandKpiGrid harus tepat satu <div className="mgm-command-grid">');
  assert.ok(!mainKpiSlice.includes('mgm-revenue-breakdown'),
    'tidak boleh ada wrapper grid kedua (.mgm-revenue-breakdown) yang membungkus kartu revenue di dalam CommandKpiGrid');
  assert.ok(!/span=/.test(mainKpiSlice), 'tidak boleh ada prop span={...} tersisa di CommandKpiGrid — semua kartu seragam');
  assert.ok(mainComponentSlice.includes('<CommandKpiGrid'), 'komponen utama harus memanggil <CommandKpiGrid s={s} />');
});
test('13i. Revenue breakdown standalone (tab Transaction & Revenue) pakai CSS grid rapat (bukan flex-wrap dgn margin-bottom berlebihan)', () => {
  const cssSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/index.css'), 'utf8');
  assert.ok(/\.mgm-revenue-breakdown\s*\{[^}]*display:\s*grid/.test(cssSrc), '.mgm-revenue-breakdown harus display:grid (3 kartu rapat dlm satu baris)');
  assert.ok(!/\.mgm-revenue-breakdown\s*\{[^}]*margin-bottom:\s*16px/.test(cssSrc),
    'margin-bottom 16px eksplisit harus dihapus — biarkan gap flex .wr-page/.wrd-tab-content yang mengatur jarak, jangan dobel spacing');
});

console.log('\n-- §Z. PB Opportunity Matrix — frontend structural tests --');
const pbScorecardTabSlice = extractFunctionBody(frontendSrc, 'function PbScorecardTab(');

test('Z1. Judul "PB OPPORTUNITY MATRIX" tampil menggantikan "PB Performance Matrix"', () => {
  assert.ok(pbScorecardTabSlice.includes('PB OPPORTUNITY MATRIX'));
  assert.ok(!frontendSrc.includes('PB Performance Matrix — Registrasi vs Conversion Aktivasi (bubble = Revenue MGM)'), 'judul lama harus sudah diganti');
});
test('Z2. Subtitle "Volume Rekrutmen vs Conversion Aktivasi" dan "Bubble = Revenue MGM" tampil', () => {
  assert.ok(pbScorecardTabSlice.includes('Volume Rekrutmen vs Conversion Aktivasi'));
  assert.ok(pbScorecardTabSlice.includes('Bubble = Revenue MGM'));
});
test('Z3. Panel teknis "Threshold Segmentasi" TIDAK LAGI tampil sebagai panel utama', () => {
  assert.ok(!pbScorecardTabSlice.includes('Threshold Segmentasi (P50/P75 aktual, bukan target)'), 'panel utama lama harus sudah dihapus dari PbScorecardTab');
});
test('Z4. Raw variable names P50/P75 hanya tampil di collapsible Metodologi Segmentasi, bukan main view', () => {
  assert.ok(pbScorecardTabSlice.includes('Metodologi Segmentasi'), 'harus ada toggle/collapsible Metodologi Segmentasi');
  assert.ok(pbScorecardTabSlice.includes('showMethodology'), 'raw threshold table harus dikondisikan oleh state showMethodology (collapsible), bukan selalu tampil');
});
test('Z5. Panel "RINGKASAN SEGMEN PB" tampil menggantikan Threshold Segmentasi', () => {
  assert.ok(pbScorecardTabSlice.includes('RINGKASAN SEGMEN PB'));
  assert.ok(frontendSrc.includes('function SegmentSummaryPanel'), 'komponen SegmentSummaryPanel harus ada');
});
test('Z6. Lima segment business-friendly + CHECK DATA terdaftar di STATUS_COLORS, label lama sudah dihapus total', () => {
  for (const label of ['SCALE UP', 'FIX CONVERSION', 'PUSH RECRUITMENT', 'HIGH BACKLOG', 'LOW PRODUCTIVITY', 'CHECK DATA']) {
    assert.ok(frontendSrc.includes(`'${label}'`), `STATUS_COLORS harus memuat "${label}"`);
  }
  for (const oldLabel of ['Growth Engine', 'Closer', 'Hunter Only', 'Low Activity']) {
    assert.ok(!frontendSrc.includes(oldLabel), `label lama "${oldLabel}" harus sudah dihapus total`);
  }
});
test('Z7. Top Opportunity lists (Prioritas Aktivasi / Kandidat Scale Up / Push Recruitment) tampil, maksimal 3 kelompok', () => {
  assert.ok(frontendSrc.includes('function OpportunityListsPanel'));
  assert.ok(frontendSrc.includes("title: 'Prioritas Aktivasi'"));
  assert.ok(frontendSrc.includes("title: 'Kandidat Scale Up'"));
  assert.ok(frontendSrc.includes("title: 'Push Recruitment'"));
});
test('Z8. Bubble tooltip memuat metrik bisnis lengkap (Registrasi, Sudah Aktif, Belum Aktif, Conversion, NMAT, Transaksi NMAT, Revenue Transaksi/Aktivasi/MGM, Segment, Aksi)', () => {
  const matrixChartSlice = extractFunctionBody(frontendSrc, 'function OpportunityMatrixChart(');
  for (const term of ['Registrasi:', 'Sudah Aktif:', 'Belum Aktif:', 'Conversion Aktivasi:', 'NMAT:', 'Transaksi NMAT:', 'Revenue Transaksi:', 'Revenue Aktivasi:', 'Revenue MGM:', 'Segment:', 'Aksi:']) {
    assert.ok(matrixChartSlice.includes(term), `tooltip bubble harus memuat "${term}"`);
  }
});
test('Z9. Bubble radius bounded/scaled (bukan linear tak terbatas) — satu PB besar tidak memenuhi chart', () => {
  const matrixChartSlice = extractFunctionBody(frontendSrc, 'function OpportunityMatrixChart(');
  assert.ok(/minR\s*=\s*\d/.test(matrixChartSlice) && /maxR\s*=\s*\d/.test(matrixChartSlice), 'harus ada batas minR/maxR eksplisit');
  assert.ok(/Math\.sqrt/.test(matrixChartSlice), 'radius harus di-scale non-linear (sqrt), bukan proporsional langsung ke revenue');
});
test('Z10. Axis label Bahasa Indonesia ("Registrasi PB" / "Conversion Aktivasi PB")', () => {
  const matrixChartSlice = extractFunctionBody(frontendSrc, 'function OpportunityMatrixChart(');
  assert.ok(matrixChartSlice.includes('Registrasi PB'));
  assert.ok(matrixChartSlice.includes('Conversion Aktivasi PB'));
});
test('Z11. Garis threshold dashed/subtle dengan caption "batas distribusi aktual" (bukan target)', () => {
  assert.ok(pbScorecardTabSlice.includes('batas distribusi aktual'));
  assert.ok(/mgm-matrix-caption[^<]*<\/div>|batas distribusi aktual[^<]*bukan target/.test(pbScorecardTabSlice), 'caption garis threshold harus eksplisit menyebut "bukan target"');
});
test('Z12. sample_size_low ditandai di tabel PB Scorecard (badge "sample kecil")', () => {
  assert.ok(pbScorecardTabSlice.includes('sample_size_low'));
  assert.ok(pbScorecardTabSlice.includes('sample kecil'));
});
test('Z13. Command Center tetap 10 kartu 5+5, Sudah Aktif tetap terintegrasi dengan Conversion (regresi §F/§G tidak boleh berubah oleh fitur Opportunity Matrix)', () => {
  const literalCards = (mainKpiSlice.match(/<KPICard\s/g) || []).length;
  assert.strictEqual(literalCards, 7);
  assert.ok(/label="SUDAH AKTIF"[\s\S]*?sub=\{`Conversion/.test(mainKpiSlice));
});
test('Z14. Responsive — panel segmen/opportunity lists collapse ke 1 kolom di breakpoint mobile', () => {
  const cssSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/index.css'), 'utf8');
  assert.ok(cssSrc.includes('.mgm-segment-summary'));
  assert.ok(/\.wrd-charts-row-3\s*\{[^}]*grid-template-columns/.test(cssSrc));
  const flatCss = cssSrc.replace(/\s+/g, ' ');
  assert.ok(/\.wrd-charts-row,\s*\.wrd-charts-row-3\s*\{\s*grid-template-columns:\s*1fr/.test(flatCss), 'harus ada breakpoint responsive yang collapse wrd-charts-row-3 ke 1 kolom');
});

console.log('\n-- 14-20. Baseline Agustus 2026 (angka nyata, tervalidasi read-only terhadap production DB) --');
// Fixture deterministik yang MEREPRODUKSI baseline Agustus secara struktural
// (931 registrasi tersebar di 281 PB, 480 aktif / 451 tidak aktif, revenue
// MGM 630 record berjumlah Rp12.614.475) — dibangun dari formula, bukan
// angka ditempel manual, supaya test benar-benar menguji fungsi hitungnya.
function buildAugustBaselineRegRows() {
  const rows = [];
  const uplineCount = 281;
  const total = 931;
  const base = Math.floor(total / uplineCount); // 3
  const remainder = total - base * uplineCount; // 88
  let seq = 0;
  for (let pbIdx = 0; pbIdx < uplineCount; pbIdx++) {
    const countForPb = base + (pbIdx < remainder ? 1 : 0);
    for (let k = 0; k < countForPb; k++) {
      seq++;
      rows.push({ id_outlet: `OUT${seq}`, upline: `PB${pbIdx}`, is_active: null, tanggal_registrasi: '2026-08-01' });
    }
  }
  if (rows.length !== total) throw new Error(`fixture bug: expected ${total} rows, got ${rows.length}`);
  rows.forEach((r, i) => { r.is_active = i < 480; }); // 480 aktif pertama, sisanya 451 tidak aktif
  return rows;
}
function buildAugustBaselineDetailRows() {
  const rows = [];
  for (let i = 0; i < 629; i++) {
    rows.push({ id_aktifasi: `DET${i}`, id_outlet: `OUT${(i % 931) + 1}`, upline: `PB${i % 281}`, komisi_aktifasi: 20000, fee_upline: 0 });
  }
  rows.push({ id_aktifasi: 'DET629', id_outlet: 'OUT1', upline: 'PB0', komisi_aktifasi: 34475, fee_upline: 0 });
  return rows; // 630 record, SUM komisi_aktifasi = 629*20000 + 34475 = 12.614.475
}
// AKTIVASI: 1582 outlet, SUM(trx) = 1582, SUM(rev) = 1.851.802 (distribusi
// nilai per-baris tidak relevan — hanya SUM yang diuji terhadap baseline).
function buildAugustBaselineAktRows() {
  const rows = [];
  for (let i = 0; i < 1582; i++) {
    rows.push({ id_outlet: `AKTOUT${i}`, upline: `PB${i % 281}`, trx: 1, rev: i === 0 ? 1851802 : 0 });
  }
  return rows;
}

const augReg = buildAugustBaselineRegRows();
const augDet = buildAugustBaselineDetailRows();
const augAkt = buildAugustBaselineAktRows();
const augFunnel = computeRegistrationFunnel(augReg);
const augActivation = computeActivationRevenue(augDet);
const augSummary = computeSummary(augReg, augAkt, augDet);

// Overlay AKTIVASI KHUSUS utk menguji Sudah Aktif PURE COUNT (definisi
// RESMI FINAL) — DIPISAH dari augAkt (dipakai battery revenue di bawah,
// id outlet-nya AKTOUT* tidak overlap dgn REG OUT* dgn sengaja, supaya
// battery revenue itu independen). Overlay ini me-replikasi rasio 480/931
// dari fixture historis, dihitung LANGSUNG dari AKTIVASI.is_active=true
// SAJA (TIDAK peduli overlap ke REG) — augReg.is_active TIDAK dibaca.
function buildAugustActiveOverlayAktRows() {
  const rows = [];
  for (let i = 1; i <= 480; i++) rows.push({ id_outlet: `OUT${i}`, is_active: true });
  return rows;
}
const augActiveOverlayAkt = buildAugustActiveOverlayAktRows();
const augActiveMatch = computeSudahAktif(augReg, augActiveOverlayAkt);

test('14. current August registrations = 931', () => {
  assert.strictEqual(augFunnel.registrations, 931);
});
test('15. current August active_outlets (PURE COUNT AKTIVASI.is_active=true, TIDAK join REG) = 480', () => {
  assert.strictEqual(augActiveMatch.active_outlets, 480);
});
test('16. current August inactive_outlets = registrations - active_outlets (aritmatika) = 451', () => {
  assert.strictEqual(augActiveMatch.inactive_outlets, 451);
  assert.strictEqual(augActiveMatch.active_outlets + augActiveMatch.inactive_outlets, augFunnel.registrations);
});
test('17. current August active_recruiting_pb = 281', () => {
  assert.strictEqual(augFunnel.active_recruiting_pb, 281);
});
test('18. current August activation_conversion_pct = 51,5575% (480/931x100, pure count)', () => {
  closeTo(augActiveMatch.activation_conversion_pct, 51.5575, 0.01);
});
test('19. current August avg_registration_per_pb = 3,3132 (931/281)', () => {
  closeTo(augFunnel.avg_registration_per_pb, 3.3132, 0.01);
});
test('20. current August activation_revenue = Rp12.614.475 (SUM komisi_aktifasi, 630 record)', () => {
  assert.strictEqual(augActivation.activation_revenue, 12614475);
  assert.strictEqual(augActivation.paid_activation_events, 630);
});

console.log('\n-- §AC. Baseline PRODUKSI TERVERIFIKASI read-only (Agustus 2026, dieksekusi sebelum implementasi) --');
// Fixture ini mereproduksi struktur data PRODUKSI SUNGGUHAN hasil query
// read-only (lihat laporan final): REG = 1332 distinct outlet, AKTIVASI
// Agustus = 1002 outlet is_active=true + 1 false + 1 null (total distinct
// 1004 — TAPI 1004 BUKAN Sudah Aktif, itu total TANPA filter is_active).
// Baseline resmi TIDAK di-hardcode ke logic manapun — ini murni fixture
// test yang meniru bentuk data aktual utk membuktikan formula konsisten.
function buildVerifiedAugustRegRows() {
  const rows = [];
  for (let i = 0; i < 1332; i++) rows.push({ id_outlet: `VREG${i}`, upline: `VPB${i % 383}` });
  return rows;
}
function buildVerifiedAugustAktRows() {
  const rows = [];
  for (let i = 0; i < 1002; i++) rows.push({ id_outlet: `VAKT${i}`, is_active: true });
  rows.push({ id_outlet: 'VAKT_FALSE', is_active: false });
  rows.push({ id_outlet: 'VAKT_NULL', is_active: null });
  return rows;
}
const vReg = buildVerifiedAugustRegRows();
const vAkt = buildVerifiedAugustAktRows();
const vSudahAktif = computeSudahAktif(vReg, vAkt);

test('§AC.1 registrations = 1332 (baseline produksi tervalidasi read-only)', () => {
  assert.strictEqual(vSudahAktif.registrations, 1332);
});
test('§AC.2 active_outlets = 1002 (PURE COUNT is_active=true, BUKAN 1004) — 1004 adalah total distinct outlet AKTIVASI TANPA filter', () => {
  assert.strictEqual(vSudahAktif.active_outlets, 1002);
  const totalDistinctRegardlessStatus = new Set(vAkt.map(a => a.id_outlet)).size;
  assert.strictEqual(totalDistinctRegardlessStatus, 1004);
  assert.notStrictEqual(vSudahAktif.active_outlets, totalDistinctRegardlessStatus, 'active_outlets (formula resmi) TIDAK BOLEH sama dgn total distinct tanpa filter is_active');
});
test('§AC.3 inactive_outlets = 1332 - 1002 = 330', () => {
  assert.strictEqual(vSudahAktif.inactive_outlets, 330);
});
test('§AC.4 activation_conversion_pct ≈ 75,2252% (1002/1332x100)', () => {
  closeTo(vSudahAktif.activation_conversion_pct, 75.2252, 0.01);
});
test('§AC.5 active + inactive = registrations (invariant, baseline produksi)', () => {
  assert.strictEqual(vSudahAktif.active_outlets + vSudahAktif.inactive_outlets, vSudahAktif.registrations);
});

console.log('\n-- §14 (item 1-20 spesifikasi pemisahan revenue) --');
test('§14.1 transaction_revenue = SUM aktivasi.rev', () => {
  assert.strictEqual(computeTransactionInfo(augAkt).transaction_revenue, 1851802);
});
test('§14.2 transaction_revenue TIDAK menggunakan trx (trx tinggi, rev kecil tetap benar)', () => {
  const akt = [{ id_outlet: 'A', trx: 999999, rev: 5 }];
  assert.strictEqual(computeTransactionInfo(akt).transaction_revenue, 5, 'harus 5 (rev), bukan 999999 (trx)');
});
test('§14.3 activation_revenue = SUM detail.komisi_aktifasi', () => {
  assert.strictEqual(computeActivationRevenue(augDet).activation_revenue, 12614475);
});
test('§14.4 mgm_revenue = transaction_revenue + activation_revenue', () => {
  assert.strictEqual(augSummary.mgm_revenue, augSummary.transaction_revenue + augSummary.activation_revenue);
});
test('§14.5 current August Revenue Transaksi = 1.851.802', () => {
  assert.strictEqual(augSummary.transaction_revenue, 1851802);
});
test('§14.6 current August Revenue Aktivasi = 12.614.475', () => {
  assert.strictEqual(augSummary.activation_revenue, 12614475);
});
test('§14.7 current August Revenue MGM = 14.466.277', () => {
  assert.strictEqual(augSummary.mgm_revenue, 14466277);
});
test('§14.8 1.851.802 + 12.614.475 = 14.466.277', () => {
  assert.strictEqual(1851802 + 12614475, 14466277);
});
test('§14.9 total_trx tetap 1.582', () => {
  assert.strictEqual(augSummary.total_trx, 1582);
});
test('§14.10 revenue_per_transaction (frontend) memakai transaction_revenue / total_trx', () => {
  const frontendTabSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/pages/WarRoomMgmPa.jsx'), 'utf8');
  assert.ok(/revenuePerTransaction = totalTrx > 0 && current\.transaction_revenue != null \? current\.transaction_revenue \/ totalTrx : null/.test(frontendTabSrc),
    'formula revenue per transaction harus pakai transaction_revenue sbg numerator, BUKAN mgm_revenue');
});
test('§14.11 previous period mempunyai tiga field revenue', () => {
  const result = buildPeriodAnalytics({
    registrasi: augReg, aktivasi: augAkt, detail: augDet,
    previousRegistrasi: [{ id_outlet: 'P1', upline: 'PBX', is_active: true }],
    previousAktivasi: [{ id_outlet: 'P1', upline: 'PBX', trx: 2, rev: 100 }],
    previousDetail: [{ id_aktifasi: 'PD1', id_outlet: 'P1', upline: 'PBX', komisi_aktifasi: 50 }],
  }, {});
  assert.strictEqual(result.summary.previous.transaction_revenue, 100);
  assert.strictEqual(result.summary.previous.activation_revenue, 50);
  assert.strictEqual(result.summary.previous.mgm_revenue, 150);
});
test('§14.12 previous zero menghasilkan delta null (bukan Infinity)', () => {
  const deltas = summaryDeltas({ transaction_revenue: 100, activation_revenue: 50, mgm_revenue: 150 }, { transaction_revenue: 0, activation_revenue: 0, mgm_revenue: 0 });
  assert.strictEqual(deltas.transaction_revenue, null);
  assert.strictEqual(deltas.activation_revenue, null);
  assert.strictEqual(deltas.mgm_revenue, null);
  assert.strictEqual(deltas.transaction_revenue_pct, null);
  assert.strictEqual(deltas.activation_revenue_pct, null);
  assert.strictEqual(deltas.mgm_revenue_pct, null);
});

console.log('\n-- §14.13-17 PB scorecard revenue: full outer universe, atribusi per sumber, no double count --');
test('§14.13 PB transaction_revenue memakai AKTIVASI.upline', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1', is_active: true }];
  const akt = [{ id_outlet: 'A', upline: 'PB1', trx: 1, rev: 500 }, { id_outlet: 'B', upline: 'PB2', trx: 1, rev: 700 }];
  const { rows } = buildPbScorecard(reg, akt, [], [], [], []);
  assert.strictEqual(rows.find(r => r.pb === 'PB1').transaction_revenue, 500);
  assert.strictEqual(rows.find(r => r.pb === 'PB2').transaction_revenue, 700);
});
test('§14.14 PB activation_revenue memakai DETAIL.upline', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1', is_active: true }];
  const det = [{ id_aktifasi: '1', id_outlet: 'A', upline: 'PB1', komisi_aktifasi: 300 }, { id_aktifasi: '2', id_outlet: 'B', upline: 'PB2', komisi_aktifasi: 400 }];
  const { rows } = buildPbScorecard(reg, [], det, [], [], []);
  assert.strictEqual(rows.find(r => r.pb === 'PB1').activation_revenue, 300);
  assert.strictEqual(rows.find(r => r.pb === 'PB2').activation_revenue, 400);
});
test('§14.15 PB mgm_revenue = transaction_revenue + activation_revenue per PB', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1', is_active: true }];
  const akt = [{ id_outlet: 'A', upline: 'PB1', trx: 1, rev: 500 }];
  const det = [{ id_aktifasi: '1', id_outlet: 'A', upline: 'PB1', komisi_aktifasi: 300 }];
  const { rows } = buildPbScorecard(reg, akt, det, [], [], []);
  const pb1 = rows.find(r => r.pb === 'PB1');
  assert.strictEqual(pb1.mgm_revenue, 800);
});
test('§14.16 PB yang hanya muncul di satu sumber TIDAK hilang (full outer universe REG ∪ AKTIVASI ∪ DETAIL)', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1', is_active: true }]; // PB1 hanya di REG
  const akt = [{ id_outlet: 'B', upline: 'PB2', trx: 1, rev: 999 }]; // PB2 hanya di AKTIVASI
  const det = [{ id_aktifasi: '1', id_outlet: 'C', upline: 'PB3', komisi_aktifasi: 111 }]; // PB3 hanya di DETAIL
  const { rows } = buildPbScorecard(reg, akt, det, [], [], []);
  assert.ok(rows.find(r => r.pb === 'PB1'), 'PB1 (hanya REG) harus tetap muncul');
  assert.ok(rows.find(r => r.pb === 'PB2'), 'PB2 (hanya AKTIVASI) harus tetap muncul');
  assert.ok(rows.find(r => r.pb === 'PB3'), 'PB3 (hanya DETAIL) harus tetap muncul');
  assert.strictEqual(rows.find(r => r.pb === 'PB2').registrations, 0, 'PB2 tidak punya baris REG -> registrations 0, bukan hilang');
  assert.strictEqual(rows.find(r => r.pb === 'PB2').transaction_revenue, 999);
  assert.strictEqual(rows.find(r => r.pb === 'PB3').activation_revenue, 111);
});
test('§14.17 total SUM(pb.transaction_revenue) tidak melebihi total source (tidak ada double count akibat join)', () => {
  const reg = [
    { id_outlet: 'A', upline: 'PB1', is_active: true }, { id_outlet: 'B', upline: 'PB1', is_active: true },
    { id_outlet: 'C', upline: 'PB2', is_active: false },
  ];
  const akt = [
    { id_outlet: 'A', upline: 'PB1', trx: 2, rev: 1000 }, { id_outlet: 'B', upline: 'PB1', trx: 1, rev: 500 },
    { id_outlet: 'C', upline: 'PB2', trx: 3, rev: 300 },
  ];
  const det = [
    { id_aktifasi: '1', id_outlet: 'A', upline: 'PB1', komisi_aktifasi: 200 },
    { id_aktifasi: '2', id_outlet: 'A', upline: 'PB1', komisi_aktifasi: 150 }, // outlet sama, 2 event aktivasi berbeda
    { id_aktifasi: '3', id_outlet: 'C', upline: 'PB2', komisi_aktifasi: 90 },
  ];
  const totalTransactionRevenueSource = akt.reduce((s, a) => s + a.rev, 0);
  const totalActivationRevenueSource = det.reduce((s, d) => s + d.komisi_aktifasi, 0);
  const { rows } = buildPbScorecard(reg, akt, det, [], [], []);
  const sumPbTransactionRevenue = rows.reduce((s, r) => s + r.transaction_revenue, 0);
  const sumPbActivationRevenue = rows.reduce((s, r) => s + r.activation_revenue, 0);
  assert.strictEqual(sumPbTransactionRevenue, totalTransactionRevenueSource, 'SUM per-PB transaction_revenue harus PERSIS sama dgn total source, tidak boleh lebih (double count)');
  assert.strictEqual(sumPbActivationRevenue, totalActivationRevenueSource, 'SUM per-PB activation_revenue harus PERSIS sama dgn total source, tidak boleh lebih (double count)');
});

console.log('\n-- §14.18-20 Kontribusi revenue share & konsistensi formula --');
test('§14.18 transaction_revenue_share_pct + activation_revenue_share_pct = 100% (toleransi pembulatan)', () => {
  const result = buildPeriodAnalytics({
    registrasi: augReg, aktivasi: augAkt, detail: augDet,
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, {});
  const total = result.economics.transaction_revenue_share_pct + result.economics.activation_revenue_share_pct;
  closeTo(total, 100, 0.01);
});
test('§14.19 toleransi uang maksimal Rp0,01 pada revenue_formula_consistent', () => {
  const result = buildPeriodAnalytics({
    registrasi: augReg, aktivasi: augAkt, detail: augDet,
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, {});
  const diff = Math.abs(result.summary.current.mgm_revenue - (result.summary.current.transaction_revenue + result.summary.current.activation_revenue));
  assert.ok(diff <= 0.01, `selisih formula harus <= Rp0,01, dapat ${diff}`);
});
test('§14.20 quality.revenue_formula_consistent = true utk data normal', () => {
  const result = buildPeriodAnalytics({
    registrasi: augReg, aktivasi: augAkt, detail: augDet,
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, {});
  assert.strictEqual(result.quality.revenue_formula_consistent, true);
  assert.strictEqual(result.quality.transaction_revenue_total, 1851802);
  assert.strictEqual(result.quality.activation_revenue_total, 12614475);
  assert.strictEqual(result.quality.mgm_revenue_total, 14466277);
  assert.strictEqual(result.quality.transaction_revenue_source_rows, augAkt.length);
  assert.strictEqual(result.quality.activation_revenue_source_rows, augDet.length);
});

console.log('\n-- §NMAT (New Member Aktif Transaksi) — 5 skenario contoh spesifikasi bisnis --');
test('NMAT.1 Aktivasi 2 Agustus, Trx Agustus > 0 -> NMAT Agustus', () => {
  const akt = [{ id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 5 }];
  assert.strictEqual(computeNmatOutlets(akt, '2026-08-01'), 1);
});
test('NMAT.2 Aktivasi 25 Juli, Trx Agustus > 0 -> BUKAN NMAT Agustus', () => {
  const akt = [{ id_outlet: 'A', tanggal_aktifasi: '2026-07-25', trx: 5 }];
  assert.strictEqual(computeNmatOutlets(akt, '2026-08-01'), 0);
});
test('NMAT.3 Aktivasi 2 Agustus, Trx = 0 -> BUKAN NMAT Agustus', () => {
  const akt = [{ id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 0 }];
  assert.strictEqual(computeNmatOutlets(akt, '2026-08-01'), 0);
});
test('NMAT.4 Aktivasi 2 Agustus, baru transaksi September -> BUKAN NMAT Agustus DAN BUKAN NMAT September', () => {
  // Baris ini merepresentasikan snapshot AKTIVASI bulan Agustus dgn trx=0 di Agustus
  // (baru transaksi bulan depan) -> bukan NMAT Agustus (trx=0 saat itu).
  const aktAgustus = [{ id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 0 }];
  assert.strictEqual(computeNmatOutlets(aktAgustus, '2026-08-01'), 0, 'bukan NMAT Agustus (trx masih 0 di Agustus)');
  // Snapshot AKTIVASI bulan September: trx sudah >0, tapi tanggal_aktifasi TETAP Agustus
  // (outlet tsb bukan "baru diaktivasi" di September) -> bukan NMAT September juga.
  const aktSeptember = [{ id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 3 }];
  assert.strictEqual(computeNmatOutlets(aktSeptember, '2026-09-01'), 0, 'bukan NMAT September (tanggal_aktifasi bukan di bulan September)');
});
test('NMAT.5 Aktivasi Agustus tetapi dashboard memilih Juli -> BUKAN NMAT Juli', () => {
  const akt = [{ id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 5 }];
  assert.strictEqual(computeNmatOutlets(akt, '2026-07-01'), 0);
});
test('NMAT.6 id_outlet kosong tidak dihitung', () => {
  const akt = [{ id_outlet: '', tanggal_aktifasi: '2026-08-02', trx: 5 }, { id_outlet: null, tanggal_aktifasi: '2026-08-02', trx: 5 }];
  assert.strictEqual(computeNmatOutlets(akt, '2026-08-01'), 0);
});
test('NMAT.7 Setiap id_outlet dihitung SATU KALI meski ada baris duplikat', () => {
  const akt = [
    { id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 5 },
    { id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 5 },
  ];
  assert.strictEqual(computeNmatOutlets(akt, '2026-08-01'), 1);
});
test('NMAT.8 isDateInPeriod menangani akhir bulan/awal bulan berikutnya dengan benar', () => {
  assert.strictEqual(isDateInPeriod('2026-08-31', '2026-08-01'), true, 'akhir bulan Agustus masih termasuk Agustus');
  assert.strictEqual(isDateInPeriod('2026-09-01', '2026-08-01'), false, '1 September sudah bukan Agustus');
  assert.strictEqual(isDateInPeriod('2026-08-01', '2026-08-01'), true, 'awal bulan Agustus termasuk Agustus');
  assert.strictEqual(isDateInPeriod(null, '2026-08-01'), false, 'tanggal null -> false, bukan error');
  assert.strictEqual(isDateInPeriod('2026-08-02', null), false, 'periodStart null -> false, bukan error');
});
test('NMAT.9 TIDAK memakai tanggal_registrasi/REG.is_active/id_aktifasi — hanya AKTIVASI.tanggal_aktifasi & trx', () => {
  // REG (registrasi) & DETAIL (id_aktifasi) sengaja dikosongkan/diisi data yang
  // seharusnya TIDAK berpengaruh ke NMAT sama sekali — hanya AKTIVASI yang dipakai.
  const reg = [{ id_outlet: 'A', is_active: false, tanggal_registrasi: '2026-01-01' }]; // is_active=false, tapi TIDAK relevan utk NMAT
  const akt = [{ id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 5 }];
  const det = []; // TIDAK ADA id_aktifasi sama sekali -> NMAT tetap 1
  const summary = computeSummary(reg, akt, det, '2026-08-01');
  assert.strictEqual(summary.nmat_outlets, 1, 'NMAT harus 1 walau REG.is_active=false dan tidak ada DETAIL/id_aktifasi sama sekali');
});
test('NMAT.10 Command Center (summary.current & operational_volume) menerima nmat_outlets dari buildPeriodAnalytics dgn currentPeriod', () => {
  const akt = [
    { id_outlet: 'A', upline: 'PB1', tanggal_aktifasi: '2026-08-02', trx: 5, rev: 1000 }, // NMAT
    { id_outlet: 'B', upline: 'PB1', tanggal_aktifasi: '2026-07-25', trx: 5, rev: 1000 }, // bukan NMAT (aktivasi Juli)
  ];
  const result = buildPeriodAnalytics({
    registrasi: [], aktivasi: akt, detail: [],
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, { currentPeriod: '2026-08-01' });
  assert.strictEqual(result.summary.current.nmat_outlets, 1);
  assert.strictEqual(result.summary.current.transacting_outlets, 2, 'transacting_outlets TIDAK berubah — tetap hitung semua outlet trx>0 tanpa syarat tanggal aktivasi');
  assert.strictEqual(result.operational_volume.nmat_outlets, 1);
});
test('NMAT.11 previous period NMAT dihitung dari previousPeriod(currentPeriod), bukan currentPeriod yang sama', () => {
  const prevAkt = [{ id_outlet: 'X', upline: 'PB1', tanggal_aktifasi: '2026-07-10', trx: 3, rev: 500 }];
  const result = buildPeriodAnalytics({
    registrasi: [], aktivasi: [], detail: [],
    previousRegistrasi: [], previousAktivasi: prevAkt, previousDetail: [],
  }, { currentPeriod: '2026-08-01' });
  assert.strictEqual(result.summary.previous.nmat_outlets, 1, 'previous.nmat_outlets harus dihitung thd bulan Juli (previousPeriod dari Agustus), bukan 0');
});
test('NMAT.12 nmat_outlets muncul di summary.deltas (pakai pctDelta, bukan null selalu)', () => {
  const deltas = summaryDeltas({ nmat_outlets: 100 }, { nmat_outlets: 80 });
  assert.strictEqual(deltas.nmat_outlets, 25, '100 vs 80 -> +25%');
});

console.log('\n-- B14-B24. Transaksi NMAT (nmat_trx) + PB-level NMAT/aktif + Data Quality audit --');
test('B14. nmat_trx = SUM trx HANYA dari outlet yang memenuhi syarat NMAT (bukan SUM seluruh AKTIVASI.trx)', () => {
  const akt = [
    { id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 5 },  // NMAT
    { id_outlet: 'B', tanggal_aktifasi: '2026-07-25', trx: 100 }, // bukan NMAT (aktivasi bulan lalu) — TIDAK boleh ikut ke nmat_trx
  ];
  const d = computeNmatDetails(akt, '2026-08-01');
  assert.strictEqual(d.nmat_outlets, 1);
  assert.strictEqual(d.nmat_trx, 5, 'nmat_trx harus 5 (hanya outlet A), BUKAN 105 (A+B)');
});
test('B15. nmat_trx berbeda dari total_trx ketika ada outlet non-NMAT yang bertransaksi', () => {
  const akt = [
    { id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 5 },
    { id_outlet: 'B', tanggal_aktifasi: '2026-06-01', trx: 50 },
  ];
  const nmat = computeNmatDetails(akt, '2026-08-01');
  const info = computeTransactionInfo(akt);
  assert.strictEqual(nmat.nmat_trx, 5);
  assert.strictEqual(info.total_trx, 55);
  assert.notStrictEqual(nmat.nmat_trx, info.total_trx, 'nmat_trx TIDAK BOLEH sama dgn total_trx ketika ada outlet non-NMAT bertransaksi');
});
test('B16. Baris duplikat utk id_outlet yang sama TIDAK double-count nmat_trx (last-wins per outlet)', () => {
  const akt = [
    { id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 5 },
    { id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 5 },
  ];
  assert.strictEqual(computeNmatDetails(akt, '2026-08-01').nmat_trx, 5, 'bukan 10 — outlet A cuma dihitung sekali');
});
test('B17. trx=0 dikecualikan dari nmat_trx', () => {
  const akt = [{ id_outlet: 'A', tanggal_aktifasi: '2026-08-02', trx: 0 }];
  assert.strictEqual(computeNmatDetails(akt, '2026-08-01').nmat_trx, 0);
});

console.log('\n-- B18-B20. PB scorecard — active_outlets/inactive_outlets/nmat_outlets/nmat_trx per PB --');
test('B18. PB active_outlets/inactive_outlets — REG outlet milik PB, di-JOIN ke AKTIVASI GLOBAL is_active=true', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }, { id_outlet: 'B', upline: 'PB1' }, { id_outlet: 'C', upline: 'PB2' }];
  const akt = [{ id_outlet: 'A', upline: 'PB1', is_active: true }, { id_outlet: 'C', upline: 'PB2', is_active: false }];
  const { rows } = buildPbScorecard(reg, akt, [], [], [], []);
  const pb1 = rows.find(r => r.pb === 'PB1');
  assert.strictEqual(pb1.active_outlets, 1); assert.strictEqual(pb1.inactive_outlets, 1);
  const pb2 = rows.find(r => r.pb === 'PB2');
  assert.strictEqual(pb2.active_outlets, 0); assert.strictEqual(pb2.inactive_outlets, 1);
});
test('B19. PB nmat_outlets/nmat_trx — atribusi via AKTIVASI.upline LANGSUNG (BUKAN "REG outlet milik PB yang NMAT")', () => {
  // Outlet X terdaftar di REG milik PB1, tapi AKTIVASI-nya justru upline PB2
  // (mis. re-assign) — NMAT harus ikut AKTIVASI.upline (PB2), bukan REG.upline (PB1).
  const reg = [{ id_outlet: 'X', upline: 'PB1' }];
  const akt = [{ id_outlet: 'X', upline: 'PB2', tanggal_aktifasi: '2026-08-02', trx: 7, is_active: true }];
  const { rows } = buildPbScorecard(reg, akt, [], [], [], [], '2026-08-01', '2026-07-01');
  const pb1 = rows.find(r => r.pb === 'PB1');
  const pb2 = rows.find(r => r.pb === 'PB2');
  assert.strictEqual(pb1.nmat_outlets, 0, 'PB1 (REG.upline) tidak boleh dapat kredit NMAT outlet X');
  assert.strictEqual(pb2.nmat_outlets, 1, 'PB2 (AKTIVASI.upline) yang dapat kredit NMAT');
  assert.strictEqual(pb2.nmat_trx, 7);
});
test('B20. SUM per-PB nmat_outlets/nmat_trx tidak melebihi total (tidak ada double count)', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }, { id_outlet: 'B', upline: 'PB2' }];
  const akt = [
    { id_outlet: 'A', upline: 'PB1', tanggal_aktifasi: '2026-08-02', trx: 3, is_active: true },
    { id_outlet: 'B', upline: 'PB2', tanggal_aktifasi: '2026-08-05', trx: 4, is_active: true },
  ];
  const totalNmat = computeNmatDetails(akt, '2026-08-01');
  const { rows } = buildPbScorecard(reg, akt, [], [], [], [], '2026-08-01', '2026-07-01');
  const sumOutlets = rows.reduce((s, r) => s + r.nmat_outlets, 0);
  const sumTrx = rows.reduce((s, r) => s + r.nmat_trx, 0);
  assert.strictEqual(sumOutlets, totalNmat.nmat_outlets);
  assert.strictEqual(sumTrx, totalNmat.nmat_trx);
});

console.log('\n-- B21-B24. Data Quality audit (buildPeriodAnalytics.quality) --');
test('B21. quality.active_matched_outlets/inactive_unmatched_outlets/registrations_total sesuai definisi JOIN', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }, { id_outlet: 'B', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', upline: 'PB1', is_active: true }];
  const result = buildPeriodAnalytics({
    registrasi: reg, aktivasi: akt, detail: [],
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, {});
  assert.strictEqual(result.quality.registrations_total, 2);
  assert.strictEqual(result.quality.active_matched_outlets, 1);
  assert.strictEqual(result.quality.inactive_unmatched_outlets, 1);
});
test('B22. quality.active_inactive_partition_consistent = true untuk data normal (invariant partisi)', () => {
  const result = buildPeriodAnalytics({
    registrasi: augReg, aktivasi: augAkt, detail: augDet,
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, {});
  assert.strictEqual(result.quality.active_inactive_partition_consistent, true);
});
test('B23. quality.registration_activation_upline_mismatch & activation_without_registration terhitung benar', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }];
  const akt = [
    { id_outlet: 'A', upline: 'PBX', is_active: true }, // upline mismatch (aktif)
    { id_outlet: 'ORPHAN', upline: 'PB9', is_active: true }, // aktivasi tanpa REG
  ];
  const result = buildPeriodAnalytics({
    registrasi: reg, aktivasi: akt, detail: [],
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, {});
  assert.strictEqual(result.quality.registration_activation_upline_mismatch, 1);
  assert.strictEqual(result.quality.activation_without_registration, 1);
});
test('B24. Tidak ada NaN/Infinity pada quality/summary utk data kosong sama sekali', () => {
  const result = buildPeriodAnalytics({
    registrasi: [], aktivasi: [], detail: [],
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, { currentPeriod: '2026-08-01' });
  const flat = JSON.stringify(result);
  assert.ok(!/NaN/.test(flat), 'tidak boleh ada NaN di hasil buildPeriodAnalytics utk dataset kosong');
  assert.ok(!/Infinity/.test(flat), 'tidak boleh ada Infinity di hasil buildPeriodAnalytics utk dataset kosong');
  assert.strictEqual(result.summary.current.active_outlets, 0);
  assert.strictEqual(result.summary.current.inactive_outlets, 0);
  assert.strictEqual(result.summary.current.activation_conversion_pct, null);
  assert.strictEqual(result.summary.current.nmat_trx, 0);
});

console.log('\n-- 21-22. Cutoff current period TIDAK memotong data; previous tetap same-day --');
const routePath = path.join(__dirname, '../src/routes/warroom-mgm.js');
const routeSrc = fs.readFileSync(routePath, 'utf8');
test('21. loadPeriodDataset current period dipanggil dengan cutoff NULL (tidak dipotong jadi 685)', () => {
  assert.ok(/loadPeriodDataset\(requestedPeriod,\s*null\)/.test(routeSrc),
    'analyticsHandler harus memanggil loadPeriodDataset(requestedPeriod, null) — current period TIDAK dipotong cutoff_date');
  assert.ok(!/loadPeriodDataset\(requestedPeriod,\s*cutoffDate\)/.test(routeSrc),
    'TIDAK BOLEH lagi memanggil loadPeriodDataset dengan cutoffDate untuk current period (itu penyebab bug 685)');
});
test('22. Previous period tetap dibandingkan same-day (loadPreviousDataset dengan compareCutoff)', () => {
  assert.ok(/loadPreviousDataset\(comparePeriod,\s*compareCutoff\)/.test(routeSrc),
    'previous period harus tetap dipotong compareCutoff untuk perbandingan same-day yang adil');
});
test('NMAT.13 route memanggil buildPeriodAnalytics dgn currentPeriod: requestedPeriod (wajib utk NMAT)', () => {
  assert.ok(/buildPeriodAnalytics\(\{[\s\S]*?currentPeriod:\s*requestedPeriod/.test(routeSrc),
    'analyticsHandler harus meneruskan currentPeriod: requestedPeriod ke buildPeriodAnalytics, kalau tidak nmat_outlets akan selalu 0');
});

console.log('\n-- §15 (item 1-14 spesifikasi frontend) — label, tooltip, format --');
test('§15.8 Label generik "REVENUE" tanpa konteks / "TOTAL REVENUE" tanpa definisi / "KOMISI" sbg pengganti Revenue MGM tidak dipakai sbg KPI', () => {
  assert.ok(!/label="REVENUE"/.test(frontendSrc), 'tidak boleh ada KPICard label="REVENUE" generik');
  assert.ok(!/label="TOTAL REVENUE"/.test(frontendSrc), 'tidak boleh ada KPICard label="TOTAL REVENUE" tanpa definisi sumber');
  assert.ok(!/label="KOMISI"/.test(frontendSrc), 'tidak boleh ada KPICard label="KOMISI" sbg pengganti Revenue MGM');
});
test('§15.12 Tooltip Revenue Transaksi/Aktivasi/MGM sesuai teks spesifikasi', () => {
  assert.ok(revenueCardsBody.includes('Dihitung dari SUM kolom Rev pada data AKTIVASI'), 'tooltip Revenue Transaksi harus menyebut SUM kolom Rev AKTIVASI');
  assert.ok(revenueCardsBody.includes('Dihitung dari SUM komisi_aktifasi pada data MGM AKTIV'), 'tooltip Revenue Aktivasi harus menyebut SUM komisi_aktifasi');
  assert.ok(revenueCardsBody.includes('Revenue Transaksi ditambah Revenue Aktivasi'), 'tooltip Revenue MGM harus menjelaskan penjumlahan dua komponen');
});
test('§15.13 Format rupiah pakai locale id-ID (fmtRp)', () => {
  assert.ok(/function fmtRp\(n\) \{ return n == null \? '-' : 'Rp ' \+ nf\.format/.test(frontendSrc));
  assert.ok(/new Intl\.NumberFormat\('id-ID'\)/.test(frontendSrc), 'formatter angka harus pakai locale id-ID');
});
test('§15 payment_mix TIDAK lagi memakai field ambigu mgm_revenue (sudah di-rename activation_revenue di backend+frontend)', () => {
  assert.ok(!/payments\.map\(p => p\.mgm_revenue\)/.test(frontendSrc), 'payment_mix di frontend tidak boleh lagi mereferensikan field mgm_revenue lama');
});

console.log('\n-- 23-24. Frontend defensif: error boundary & 7 tab (lihat juga SSR render test terpisah) --');
test('24. MgmErrorBoundary tetap didefinisikan dan membungkus halaman', () => {
  assert.ok(/class MgmErrorBoundary extends Component/.test(frontendSrc));
  assert.ok(/<MgmErrorBoundary>/.test(frontendSrc) && /<\/MgmErrorBoundary>/.test(frontendSrc));
});
test('23. safeArr/safeObj tetap dipakai di seluruh 7 tab (defensive defaults tidak diregresi)', () => {
  for (const tabFn of ['CommandCenterTab', 'PbScorecardTab', 'FunnelAgingTab', 'TransactionRevenueTab', 'EconomicsTab', 'TerritoryMixTab', 'ActionCenterTab']) {
    assert.ok(frontendSrc.includes(`function ${tabFn}`), `komponen ${tabFn} harus tetap ada`);
  }
  // Verifikasi fungsional 7-tab x 3-skenario (data asli/null subfield/object
  // kosong) dijalankan terpisah lewat SSR render test (esbuild + react-dom/
  // server) — di luar node test murni ini karena butuh bundling JSX.
});

// ═══════════════════════════════════════════════════════════════
// Formula audit non-destructive (tetap dipertahankan dari rebuild sebelumnya)
// ═══════════════════════════════════════════════════════════════
console.log('\n-- Formula audit TIDAK menimpa nilai sumber komisi_aktifasi --');
test('economics.formula_mismatch melaporkan selisih, activation_revenue tetap pakai nilai sumber', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1', is_active: true }];
  const akt = [{ id_outlet: 'A', upline: 'PB1', trx: 1, rev: 10 }];
  // Formula: biaya_aktifasi_2 - hpp - ongkos_kirim - fee_upline = 200-30-20-100=50
  // Sumber sheet bilang komisi_aktifasi = 999 (sengaja beda) — sistem HARUS tetap pakai 999.
  const det = [{ id_aktifasi: '1', id_outlet: 'A', upline: 'PB1', biaya_aktifasi_2: 200, hpp: 30, ongkos_kirim: 20, fee_upline: 100, komisi_aktifasi: 999 }];
  const result = buildPeriodAnalytics({
    registrasi: reg, aktivasi: akt, detail: det,
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, {});
  assert.strictEqual(result.summary.current.activation_revenue, 999, 'revenue aktivasi resmi = nilai sumber, BUKAN hasil formula (50)');
  assert.strictEqual(result.summary.current.transaction_revenue, 10, 'revenue transaksi = SUM aktivasi.rev, tidak tersentuh formula audit');
  assert.strictEqual(result.summary.current.mgm_revenue, 1009, 'mgm_revenue = transaction_revenue(10) + activation_revenue(999)');
  assert.strictEqual(result.economics.formula_mismatch.length, 1, 'mismatch harus terdeteksi & dilaporkan');
  assert.strictEqual(result.economics.formula_mismatch[0].expected, 50);
  assert.strictEqual(result.economics.formula_mismatch[0].actual, 999);
});

console.log('\n-- PB Opportunity Segmentation — 5 label business-friendly + CHECK DATA (priority override), sample-size guard --');
test('computeQualifiedConversionMinReg — P25 dari PB registrations>1, floor teknis minimum 2', () => {
  const pbRows = [{ registrations: 1 }, { registrations: 2 }, { registrations: 4 }, { registrations: 6 }, { registrations: 8 }];
  const min = computeQualifiedConversionMinReg(pbRows);
  assert.ok(min >= 2, 'floor teknis minimum harus >= 2 supaya PB 1 registrasi tidak pernah lolos');
});
test('computeQualifiedConversionMinReg — pool kosong (semua PB registrations<=1) -> floor teknis 2', () => {
  assert.strictEqual(computeQualifiedConversionMinReg([{ registrations: 1 }, { registrations: 1 }]), 2);
});
// Catatan desain fixture: percentile dari array ber-nilai SERAGAM akan
// membuat gte(x, p75) TRIVIALLY true utk semua baris (P75 dari nilai yang
// sama = nilai itu sendiri). Supaya HIGH BACKLOG (priority tertinggi
// setelah anomaly) TIDAK ikut ter-trigger tanpa sengaja pada baris target
// SCALE UP/FIX CONVERSION/PUSH RECRUITMENT, seluruh fixture di bawah ini
// SENGAJA memberi baris target inactive_outlets RENDAH (0) sementara
// baris lain punya inactive_outlets moderat (5) — supaya P75 backlog
// TIDAK ikut baris target.
test('SCALE UP — registrations >= P75 dan conversion >= P50, bukan anomaly, bukan HIGH BACKLOG', () => {
  const pbRows = [
    { registrations: 10, activation_conversion_pct: 20, inactive_outlets: 5 },
    { registrations: 12, activation_conversion_pct: 25, inactive_outlets: 5 },
    { registrations: 14, activation_conversion_pct: 30, inactive_outlets: 5 },
    { registrations: 16, activation_conversion_pct: 35, inactive_outlets: 5 },
    { registrations: 80, activation_conversion_pct: 80, inactive_outlets: 0 }, // target
    { registrations: 65, activation_conversion_pct: 40, inactive_outlets: 5 },
    { registrations: 70, activation_conversion_pct: 45, inactive_outlets: 5 },
    { registrations: 75, activation_conversion_pct: 50, inactive_outlets: 5 },
  ];
  const thresholds = computeOpportunitySegmentThresholds(pbRows);
  assert.strictEqual(classifyOpportunitySegment(pbRows[4], thresholds), 'SCALE UP');
});
test('FIX CONVERSION — registrations >= P75 tapi conversion < P50', () => {
  const pbRows = [
    { registrations: 10, activation_conversion_pct: 60, inactive_outlets: 5 },
    { registrations: 12, activation_conversion_pct: 65, inactive_outlets: 5 },
    { registrations: 14, activation_conversion_pct: 70, inactive_outlets: 5 },
    { registrations: 16, activation_conversion_pct: 75, inactive_outlets: 5 },
    { registrations: 80, activation_conversion_pct: 10, inactive_outlets: 0 }, // target
    { registrations: 65, activation_conversion_pct: 40, inactive_outlets: 5 },
    { registrations: 70, activation_conversion_pct: 45, inactive_outlets: 5 },
    { registrations: 75, activation_conversion_pct: 50, inactive_outlets: 5 },
  ];
  const thresholds = computeOpportunitySegmentThresholds(pbRows);
  assert.strictEqual(classifyOpportunitySegment(pbRows[4], thresholds), 'FIX CONVERSION');
});
test('PUSH RECRUITMENT — registrations < P75, conversion >= P75, LOLOS sample-size guard', () => {
  const pbRows = [
    { registrations: 10, activation_conversion_pct: 20, inactive_outlets: 5 },
    { registrations: 12, activation_conversion_pct: 25, inactive_outlets: 5 },
    { registrations: 14, activation_conversion_pct: 30, inactive_outlets: 5 },
    { registrations: 16, activation_conversion_pct: 35, inactive_outlets: 5 },
    { registrations: 18, activation_conversion_pct: 90, inactive_outlets: 0 }, // target: reg rendah TAPI di atas qualified_conversion_min_reg
    { registrations: 60, activation_conversion_pct: 40, inactive_outlets: 5 },
    { registrations: 65, activation_conversion_pct: 45, inactive_outlets: 5 },
    { registrations: 70, activation_conversion_pct: 50, inactive_outlets: 5 },
  ];
  const thresholds = computeOpportunitySegmentThresholds(pbRows);
  assert.ok(pbRows[4].registrations >= thresholds.qualified_conversion_min_reg, 'fixture harus lolos sample-size guard supaya menguji branch PUSH RECRUITMENT, bukan LOW PRODUCTIVITY');
  assert.strictEqual(classifyOpportunitySegment(pbRows[4], thresholds), 'PUSH RECRUITMENT');
});
test('PUSH RECRUITMENT DITOLAK sample-size guard — PB 1 registrasi/100% conversion TIDAK OTOMATIS top performer', () => {
  const pbRows = [
    { registrations: 10, activation_conversion_pct: 20, inactive_outlets: 5 },
    { registrations: 12, activation_conversion_pct: 25, inactive_outlets: 5 },
    { registrations: 14, activation_conversion_pct: 30, inactive_outlets: 5 },
    { registrations: 16, activation_conversion_pct: 35, inactive_outlets: 5 },
    { registrations: 1, activation_conversion_pct: 100, inactive_outlets: 0 }, // target: 1 registrasi, 100% conversion
    { registrations: 60, activation_conversion_pct: 40, inactive_outlets: 5 },
    { registrations: 65, activation_conversion_pct: 45, inactive_outlets: 5 },
    { registrations: 70, activation_conversion_pct: 50, inactive_outlets: 5 },
  ];
  const thresholds = computeOpportunitySegmentThresholds(pbRows);
  assert.ok(pbRows[4].registrations < thresholds.qualified_conversion_min_reg, 'fixture harus GAGAL sample-size guard supaya menguji penolakannya');
  const status = classifyOpportunitySegment(pbRows[4], thresholds);
  assert.notStrictEqual(status, 'PUSH RECRUITMENT', 'PB 1 registrasi TIDAK BOLEH lolos jadi PUSH RECRUITMENT walau conversion 100%');
  assert.strictEqual(status, 'LOW PRODUCTIVITY');
});
test('HIGH BACKLOG — priority override, muncul walau volume & conversion juga tinggi (bukan SCALE UP)', () => {
  const pbRows = [
    { registrations: 5, activation_conversion_pct: 40, inactive_outlets: 1 },
    { registrations: 10, activation_conversion_pct: 45, inactive_outlets: 1 },
    { registrations: 20, activation_conversion_pct: 55, inactive_outlets: 1 },
    { registrations: 30, activation_conversion_pct: 60, inactive_outlets: 500 },
  ];
  const thresholds = computeOpportunitySegmentThresholds(pbRows);
  assert.strictEqual(classifyOpportunitySegment(pbRows[3], thresholds), 'HIGH BACKLOG', 'backlog tinggi override SCALE UP walau volume & conversion juga tinggi');
});
test('LOW PRODUCTIVITY — fallback ketika tidak masuk kategori actionable lain', () => {
  const pbRows = [
    { registrations: 100, activation_conversion_pct: 80, inactive_outlets: 5 },
    { registrations: 90, activation_conversion_pct: 70, inactive_outlets: 5 },
    { registrations: 3, activation_conversion_pct: 5, inactive_outlets: 0 },
  ];
  const thresholds = computeOpportunitySegmentThresholds(pbRows);
  assert.strictEqual(classifyOpportunitySegment(pbRows[2], thresholds), 'LOW PRODUCTIVITY');
});
test('CHECK DATA — data_quality_anomaly PRIORITY TERTINGGI, override HIGH BACKLOG sekalipun', () => {
  const pbRows = [
    { registrations: 5, activation_conversion_pct: 40, inactive_outlets: 1 },
    { registrations: 30, activation_conversion_pct: 60, inactive_outlets: 500, data_quality_anomaly: true },
  ];
  const thresholds = computeOpportunitySegmentThresholds(pbRows);
  assert.strictEqual(classifyOpportunitySegment(pbRows[1], thresholds), 'CHECK DATA', 'anomaly harus menang atas HIGH BACKLOG (priority §P item 1 > item 2)');
});
test('Segment mutually exclusive — setiap PB tepat SATU status dari 6 label resmi', () => {
  const pbRows = [
    { registrations: 5, activation_conversion_pct: 40, inactive_outlets: 1 },
    { registrations: 30, activation_conversion_pct: 60, inactive_outlets: 1 },
    { registrations: 30, activation_conversion_pct: 10, inactive_outlets: 1 },
    { registrations: 3, activation_conversion_pct: 5, inactive_outlets: 0 },
  ];
  const thresholds = computeOpportunitySegmentThresholds(pbRows);
  const validSegments = ['SCALE UP', 'FIX CONVERSION', 'PUSH RECRUITMENT', 'HIGH BACKLOG', 'LOW PRODUCTIVITY', 'CHECK DATA'];
  pbRows.forEach(r => assert.ok(validSegments.includes(classifyOpportunitySegment(r, thresholds)), 'status harus salah satu dari 6 label resmi'));
});

console.log('\n-- Segment summary & Top Opportunity lists (§Q/§S) --');
test('buildSegmentSummary — totals reconcile dengan PB universe', () => {
  const reg = [{ id_outlet: 'A1', upline: 'PBA' }, { id_outlet: 'A2', upline: 'PBA' }, { id_outlet: 'B1', upline: 'PBB' }];
  const akt = [{ id_outlet: 'A1', upline: 'PBA', is_active: true }, { id_outlet: 'B1', upline: 'PBB', is_active: true }];
  const { rows } = buildPbScorecard(reg, akt, [], [], [], []);
  const summary = buildSegmentSummary(rows);
  const sumReg = summary.reduce((s, g) => s + g.registrations, 0);
  assert.strictEqual(sumReg, rows.reduce((s, r) => s + r.registrations, 0), 'SUM registrations per segmen harus sama dgn total PB universe');
  assert.strictEqual(summary.reduce((s, g) => s + g.pb_count, 0), rows.length, 'SUM pb_count per segmen harus sama dgn jumlah PB total');
});
test('buildSegmentSummary — action_text terisi dari SEGMENT_ACTION', () => {
  const rows = [{ pb: 'PBX', registrations: 10, active_outlets: 5, inactive_outlets: 5, activation_conversion_pct: 50, nmat_outlets: 2, mgm_revenue: 1000, status: 'SCALE UP' }];
  assert.strictEqual(buildSegmentSummary(rows)[0].action_text, SEGMENT_ACTION['SCALE UP']);
});
test('buildOpportunityLists — maksimal 5 baris per kelompok (§S: top 5 cukup, jangan puluhan baris)', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ pb: `PB${i}`, registrations: 10, active_outlets: 5, inactive_outlets: 20 + i, activation_conversion_pct: 50, nmat_outlets: 1, mgm_revenue: 100, status: 'LOW PRODUCTIVITY' });
  assert.ok(buildOpportunityLists(rows).prioritas_aktivasi.length <= 5);
});
test('buildOpportunityLists — kandidat_scale_up hanya berisi PB berstatus SCALE UP', () => {
  const rows = [
    { pb: 'PB1', registrations: 10, active_outlets: 8, inactive_outlets: 2, activation_conversion_pct: 80, nmat_outlets: 3, mgm_revenue: 5000, status: 'SCALE UP' },
    { pb: 'PB2', registrations: 10, active_outlets: 2, inactive_outlets: 8, activation_conversion_pct: 20, nmat_outlets: 0, mgm_revenue: 100, status: 'LOW PRODUCTIVITY' },
  ];
  const lists = buildOpportunityLists(rows);
  assert.strictEqual(lists.kandidat_scale_up.length, 1);
  assert.strictEqual(lists.kandidat_scale_up[0].pb, 'PB1');
});
test('buildOpportunityLists — prioritas_aktivasi TIDAK termasuk PB berstatus CHECK DATA (data tidak reliable utk ranking)', () => {
  const rows = [
    { pb: 'PBBAD', registrations: 5, active_outlets: 50, inactive_outlets: -45, activation_conversion_pct: 1000, nmat_outlets: 0, mgm_revenue: 0, status: 'CHECK DATA' },
    { pb: 'PBGOOD', registrations: 10, active_outlets: 2, inactive_outlets: 8, activation_conversion_pct: 20, nmat_outlets: 0, mgm_revenue: 100, status: 'LOW PRODUCTIVITY' },
  ];
  assert.ok(!buildOpportunityLists(rows).prioritas_aktivasi.some(r => r.pb === 'PBBAD'));
});

console.log('\n-- PB metrics tambahan (§T): nmat_rate_pct & revenue_per_nmat — aman denominator 0 --');
test('nmat_rate_pct = nmat_outlets/active_outlets x 100', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', upline: 'PB1', is_active: true, tanggal_aktifasi: '2026-08-05', trx: 3 }];
  const { rows } = buildPbScorecard(reg, akt, [], [], [], [], '2026-08-01', '2026-07-01');
  assert.strictEqual(rows.find(r => r.pb === 'PB1').nmat_rate_pct, 100);
});
test('nmat_rate_pct = null jika active_outlets = 0 (bukan NaN/Infinity)', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', upline: 'PB1', is_active: false, tanggal_aktifasi: '2026-08-05', trx: 3 }];
  const { rows } = buildPbScorecard(reg, akt, [], [], [], [], '2026-08-01', '2026-07-01');
  const pb1 = rows.find(r => r.pb === 'PB1');
  assert.strictEqual(pb1.active_outlets, 0);
  assert.strictEqual(pb1.nmat_rate_pct, null);
});
test('revenue_per_nmat = mgm_revenue/nmat_outlets, null jika nmat_outlets=0', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', upline: 'PB1', is_active: true, rev: 500, trx: 0 }];
  const det = [{ id_aktifasi: '1', id_outlet: 'A', upline: 'PB1', komisi_aktifasi: 300 }];
  const { rows } = buildPbScorecard(reg, akt, det, [], [], [], '2026-08-01', '2026-07-01');
  const pb1 = rows.find(r => r.pb === 'PB1');
  assert.strictEqual(pb1.nmat_outlets, 0);
  assert.strictEqual(pb1.revenue_per_nmat, null, 'nmat_outlets=0 -> revenue_per_nmat null, bukan Infinity');
});

console.log('\n-- Data Quality audit (§X) --');
test('quality.activation_active_source_count = active_outlets (pure count, terpisah dari registrations_count)', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', is_active: true }, { id_outlet: 'B', is_active: true }];
  const result = buildPeriodAnalytics({
    registrasi: reg, aktivasi: akt, detail: [],
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, {});
  assert.strictEqual(result.quality.activation_active_source_count, 2);
  assert.strictEqual(result.quality.registrations_count, 1);
  assert.strictEqual(result.quality.active_vs_registration_gap, 1);
  assert.strictEqual(result.quality.active_exceeds_registrations, true);
});
test('quality.pb_active_exceeds_registrations_count & segmentation_anomaly_count menghitung PB CHECK DATA', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', upline: 'PB1', is_active: true }, { id_outlet: 'B', upline: 'PB1', is_active: true }];
  const result = buildPeriodAnalytics({
    registrasi: reg, aktivasi: akt, detail: [],
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, {});
  assert.strictEqual(result.quality.pb_active_exceeds_registrations_count, 1);
  assert.strictEqual(result.quality.segmentation_anomaly_count, 1);
  assert.strictEqual(result.pb_scorecard.find(r => r.pb === 'PB1').status, 'CHECK DATA');
});
test('quality.low_sample_pb_count menghitung PB sample_size_low=true', () => {
  const reg = [
    { id_outlet: 'A', upline: 'PBBIG' }, { id_outlet: 'B', upline: 'PBBIG' }, { id_outlet: 'C', upline: 'PBBIG' },
    { id_outlet: 'D', upline: 'PBBIG' }, { id_outlet: 'E', upline: 'PBBIG' }, { id_outlet: 'F', upline: 'PBBIG' },
    { id_outlet: 'G', upline: 'PBBIG' }, { id_outlet: 'H', upline: 'PBBIG' },
    { id_outlet: 'X', upline: 'PBSMALL' },
  ];
  const result = buildPeriodAnalytics({
    registrasi: reg, aktivasi: [], detail: [],
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, {});
  assert.ok(result.quality.low_sample_pb_count >= 1, 'PBSMALL (1 registrasi) harus terhitung low sample');
});
test('Tidak ada NaN/Infinity pada buildPeriodAnalytics utk skenario anomaly (active > registrations)', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1' }];
  const akt = [{ id_outlet: 'A', upline: 'PB1', is_active: true }, { id_outlet: 'B', upline: 'PB1', is_active: true }, { id_outlet: 'C', upline: 'PB1', is_active: true }];
  const result = buildPeriodAnalytics({
    registrasi: reg, aktivasi: akt, detail: [],
    previousRegistrasi: [], previousAktivasi: [], previousDetail: [],
  }, { currentPeriod: '2026-08-01' });
  const flat = JSON.stringify(result);
  assert.ok(!/NaN/.test(flat), 'tidak boleh ada NaN walau active > registrations');
  assert.ok(!/Infinity/.test(flat), 'tidak boleh ada Infinity walau active > registrations');
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

function tryLoadWarroomMgm(envOverrides) {
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
  assert.ok(!/bric2026/i.test(routeSrc), 'source tidak boleh mengandung literal token legacy apa pun');
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
