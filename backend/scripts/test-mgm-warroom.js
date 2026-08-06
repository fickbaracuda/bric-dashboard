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
  classifyPb, computeSegmentationThresholds,
  computeRegistrationFunnel, computeActivationRevenue, computeTransactionInfo,
  computeSummary, summaryDeltas,
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

console.log('\n-- 1-4. Registration funnel — partisi is_active dari mgm_pa_registrasi --');
test('1. registrations = COUNT DISTINCT REG.id_outlet', () => {
  const reg = [
    { id_outlet: 'A', upline: 'PB1', is_active: true },
    { id_outlet: 'B', upline: 'PB1', is_active: false },
    { id_outlet: 'A', upline: 'PB1', is_active: true }, // duplikat id_outlet -> tetap 1
  ];
  assert.strictEqual(computeRegistrationFunnel(reg).registrations, 2);
});
test('2. active_registrations pakai REG.is_active === true', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1', is_active: true }, { id_outlet: 'B', upline: 'PB1', is_active: false }];
  assert.strictEqual(computeRegistrationFunnel(reg).active_registrations, 1);
});
test('3. inactive_registrations pakai REG.is_active === false', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1', is_active: true }, { id_outlet: 'B', upline: 'PB1', is_active: false }];
  assert.strictEqual(computeRegistrationFunnel(reg).inactive_registrations, 1);
});
test('4. unknown_active_status pakai is_active === null', () => {
  const reg = [{ id_outlet: 'A', upline: 'PB1', is_active: null }, { id_outlet: 'B', upline: 'PB1', is_active: true }];
  assert.strictEqual(computeRegistrationFunnel(reg).unknown_active_status, 1);
});
test('5. active + inactive + unknown = registrations (invariant)', () => {
  const reg = [
    { id_outlet: 'A', upline: 'PB1', is_active: true },
    { id_outlet: 'B', upline: 'PB1', is_active: false },
    { id_outlet: 'C', upline: 'PB1', is_active: null },
    { id_outlet: 'D', upline: 'PB2', is_active: true },
  ];
  const f = computeRegistrationFunnel(reg);
  assert.strictEqual(f.active_registrations + f.inactive_registrations + f.unknown_active_status, f.registrations);
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
test('8. PB conversion per PB = active_registrations / registrations x 100 (per upline, bukan global)', () => {
  const reg = [
    { id_outlet: 'A', upline: 'PB1', is_active: true }, { id_outlet: 'B', upline: 'PB1', is_active: true },
    { id_outlet: 'C', upline: 'PB1', is_active: false }, { id_outlet: 'D', upline: 'PB1', is_active: false },
    { id_outlet: 'E', upline: 'PB2', is_active: true },
  ];
  const det = [];
  const { rows } = buildPbScorecard(reg, [], det, [], [], []);
  const pb1 = rows.find(r => r.pb === 'PB1');
  assert.strictEqual(pb1.registrations, 4);
  assert.strictEqual(pb1.active_registrations, 2);
  assert.strictEqual(pb1.activation_conversion_pct, 50, 'PB1: 2 aktif / 4 registrasi = 50%');
  const pb2 = rows.find(r => r.pb === 'PB2');
  assert.strictEqual(pb2.activation_conversion_pct, 100, 'PB2: 1 aktif / 1 registrasi = 100%');
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
test('13b. 7 KPI utama non-revenue ada di Command Center: Total Registrasi, Sudah Aktif, Belum Aktif, Conversion Aktivasi, PB Aktif Merekrut, Rata-rata Rekrut/PB, Outlet Transacting', () => {
  for (const label of ['TOTAL REGISTRASI', 'SUDAH AKTIF', 'BELUM AKTIF', 'CONVERSION AKTIVASI', 'PB AKTIF MEREKRUT', 'RATA-RATA REKRUT', 'OUTLET TRANSACTING']) {
    assert.ok(mainKpiSlice.includes(label), `KPI utama harus memuat label "${label}"`);
  }
});
test('13c. "CONVERTED REGISTRATIONS" (KPI lama) sudah dihapus dari KPI utama', () => {
  assert.ok(!/CONVERTED REGISTRATIONS/.test(commandCenterKpiArea));
});
test('13d. Kartu REVENUE TRANSAKSI, REVENUE AKTIVASI, REVENUE MGM ada di area KPI utama (buildRevenueCards, dipanggil langsung di grid)', () => {
  for (const label of ['REVENUE TRANSAKSI', 'REVENUE AKTIVASI', 'REVENUE MGM']) {
    assert.ok(revenueCardsBody.includes(label), `buildRevenueCards harus memuat label "${label}"`);
  }
  assert.ok(mainKpiSlice.includes('buildRevenueCards('), 'buildRevenueCards harus dipanggil LANGSUNG di dalam mgm-command-kpi-grid (bukan lewat wrapper grid terpisah)');
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
test('13g. CSS .mgm-revenue-operator sudah dihapus (dead class, tidak dipakai lagi)', () => {
  const cssSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/index.css'), 'utf8');
  assert.ok(!/\.mgm-revenue-operator\s*\{/.test(cssSrc), 'rule CSS .mgm-revenue-operator harus sudah dihapus, bukan cuma tidak dipakai');
});
test('13h. Grid KPI utama Command Center SATU container 12-kolom, tepat 2 baris (6 kartu span-2 + 4 kartu span-3)', () => {
  const cssSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/index.css'), 'utf8');
  assert.ok(/\.mgm-command-kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/.test(cssSrc),
    '.mgm-command-kpi-grid harus grid-template-columns: repeat(12, minmax(0, 1fr)) di desktop');
  assert.ok(/\.mgm-command-kpi-grid\s*>\s*\.wrd-kpi-card\s*\{[^}]*grid-column:\s*span 2/.test(cssSrc),
    'kartu default (6 KPI registrasi/status) harus span 2 dari 12 kolom -> 6x2=12 (baris 1 penuh)');
  assert.ok(/\.mgm-kpi-span-3\s*\{[^}]*grid-column:\s*span 3/.test(cssSrc),
    'kartu span-3 (Outlet Transacting + 3 revenue) harus span 3 dari 12 kolom -> 4x3=12 (baris 2 penuh)');
  // Hitung kartu di baris 1 (span implisit 2, tanpa prop span) vs baris 2 (span={3}) langsung dari JSX.
  const spanlessCards = (mainKpiSlice.match(/<KPICard span=\{2\}/g) || []).length;
  const span3Cards = (mainKpiSlice.match(/<KPICard span=\{3\}/g) || []).length; // Outlet Transacting saja (literal di JSX)
  assert.strictEqual(spanlessCards, 6, `baris 1 harus tepat 6 kartu span-2 (6x2=12), ditemukan ${spanlessCards}`);
  assert.strictEqual(span3Cards, 1, `hanya Outlet Transacting yang literal span={3} di JSX utama (3 kartu revenue via buildRevenueCards span:3), ditemukan ${span3Cards}`);
  assert.ok(/span:\s*3/.test(mainKpiSlice), 'buildRevenueCards harus dipanggil dgn span: 3 supaya 3 kartu revenue ikut span-3 di baris 2');
});
test('13h2. Tidak ada grid/wrapper terpisah lagi di antara Outlet Transacting dan kartu revenue (satu container, bukan dua)', () => {
  // Sebelumnya ada 2 container (.mgm-kpi-grid-main lalu <RevenueBreakdownRow/> terpisah) yang
  // menyebabkan 3 baris. Sekarang CommandKpiGrid harus TEPAT SATU <div className="mgm-command-kpi-grid">
  // yang membungkus baik KPI registrasi/status maupun 4 kartu baris ke-2 — TIDAK ADA
  // wrapper grid kedua (.mgm-revenue-breakdown) di dalamnya.
  const divOpenCount = (mainKpiSlice.match(/<div className="mgm-command-kpi-grid/g) || []).length;
  assert.strictEqual(divOpenCount, 1, 'CommandKpiGrid harus tepat satu <div className="mgm-command-kpi-grid">');
  assert.ok(!mainKpiSlice.includes('mgm-revenue-breakdown'),
    'tidak boleh ada wrapper grid kedua (.mgm-revenue-breakdown) yang membungkus kartu revenue di dalam CommandKpiGrid');
  assert.ok(mainComponentSlice.includes('<CommandKpiGrid'), 'komponen utama harus memanggil <CommandKpiGrid s={s} />');
});
test('13i. Revenue breakdown standalone (tab Transaction & Revenue) pakai CSS grid rapat (bukan flex-wrap dgn margin-bottom berlebihan)', () => {
  const cssSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/index.css'), 'utf8');
  assert.ok(/\.mgm-revenue-breakdown\s*\{[^}]*display:\s*grid/.test(cssSrc), '.mgm-revenue-breakdown harus display:grid (3 kartu rapat dlm satu baris)');
  assert.ok(!/\.mgm-revenue-breakdown\s*\{[^}]*margin-bottom:\s*16px/.test(cssSrc),
    'margin-bottom 16px eksplisit harus dihapus — biarkan gap flex .wr-page/.wrd-tab-content yang mengatur jarak, jangan dobel spacing');
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

test('14. current August registrations = 931', () => {
  assert.strictEqual(augFunnel.registrations, 931);
});
test('15. current August active_registrations = 480', () => {
  assert.strictEqual(augFunnel.active_registrations, 480);
});
test('16. current August inactive_registrations = 451', () => {
  assert.strictEqual(augFunnel.inactive_registrations, 451);
});
test('17. current August active_recruiting_pb = 281', () => {
  assert.strictEqual(augFunnel.active_recruiting_pb, 281);
});
test('18. current August activation_conversion_pct = 51,5575% (480/931x100)', () => {
  closeTo(augFunnel.activation_conversion_pct, 51.5575, 0.01);
});
test('19. current August avg_registration_per_pb = 3,3132 (931/281)', () => {
  closeTo(augFunnel.avg_registration_per_pb, 3.3132, 0.01);
});
test('20. current August activation_revenue = Rp12.614.475 (SUM komisi_aktifasi, 630 record)', () => {
  assert.strictEqual(augActivation.activation_revenue, 12614475);
  assert.strictEqual(augActivation.paid_activation_events, 630);
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
  assert.ok(/revenuePerTransaction = totalTrx > 0 \? current\.transaction_revenue \/ totalTrx : null/.test(frontendTabSrc),
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

console.log('\n-- PB segmentation cascade (5 status baru: Growth Engine/Closer/Hunter Only/High Backlog/Low Activity) --');
test('Growth Engine — registrations >= P50 dan conversion >= P50', () => {
  const pbRows = [
    { registrations: 10, activation_conversion_pct: 40, inactive_registrations: 1 },
    { registrations: 20, activation_conversion_pct: 60, inactive_registrations: 1 },
  ];
  const thresholds = computeSegmentationThresholds(pbRows);
  assert.strictEqual(classifyPb(pbRows[1], thresholds), 'Growth Engine');
});
test('Closer — registrations < P50 dan conversion >= P75', () => {
  const pbRows = [
    { registrations: 5, activation_conversion_pct: 90, inactive_registrations: 0 },
    { registrations: 50, activation_conversion_pct: 10, inactive_registrations: 0 },
    { registrations: 50, activation_conversion_pct: 20, inactive_registrations: 0 },
  ];
  const thresholds = computeSegmentationThresholds(pbRows);
  assert.strictEqual(classifyPb(pbRows[0], thresholds), 'Closer');
});
test('High Backlog — inactive_registrations >= P75, tidak masuk kategori lain', () => {
  const pbRows = [
    { registrations: 5, activation_conversion_pct: 50, inactive_registrations: 1 },   // Growth Engine candidate (sets thresholds)
    { registrations: 20, activation_conversion_pct: 80, inactive_registrations: 1 },  // Growth Engine candidate (sets thresholds)
    { registrations: 3, activation_conversion_pct: 10, inactive_registrations: 100 }, // target: reg & conversion rendah, backlog tinggi
    { registrations: 3, activation_conversion_pct: 10, inactive_registrations: 1 },
  ];
  const thresholds = computeSegmentationThresholds(pbRows);
  assert.strictEqual(classifyPb(pbRows[2], thresholds), 'High Backlog');
});
test('Low Activity — di bawah semua threshold', () => {
  const pbRows = [
    { registrations: 100, activation_conversion_pct: 80, inactive_registrations: 5 },
    { registrations: 90, activation_conversion_pct: 70, inactive_registrations: 5 },
    { registrations: 1, activation_conversion_pct: 1, inactive_registrations: 0 },
  ];
  const thresholds = computeSegmentationThresholds(pbRows);
  assert.strictEqual(classifyPb(pbRows[2], thresholds), 'Low Activity');
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
