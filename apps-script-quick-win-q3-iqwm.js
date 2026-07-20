// ============================================================
// Apps Script: Quick Win Q3 IQWM (Winme & InstaQRIS) — Sync ke BRIC
// Spreadsheet ID: 1fZ-4EWsOHy-Slhq1F_jLxOCgFjGd9mp5K5Xt8BIFFgI
// Sheet: "Resume IQWM", "Breakdown Target Instaqris", "Breakdown Target Winme"
//
// PROMPT 2 — hanya membaca sheet & membentuk payload + fungsi preview/push
// manual. TIDAK ADA trigger otomatis aktif, TIDAK ADA token hardcoded.
//
// CARA PAKAI (urutan wajib):
//   1. Paste script ini ke Apps Script Editor spreadsheet Quick Win Q3.
//   2. Project Settings > Script Properties, isi:
//        QUICK_WIN_Q3_SYNC_TOKEN = (token asli, minta ke admin BRIC)
//        QUICK_WIN_Q3_SYNC_URL   = (opsional, default sudah benar untuk production)
//   3. Jalankan previewQuickWinQ3Payload() dulu — cek Logger (View > Logs),
//      pastikan jumlah baris & sample data masuk akal SEBELUM sync sungguhan.
//   4. JANGAN jalankan pushQuickWinQ3Semua() sebelum migration backend
//      production selesai (lihat docs/QUICK_WIN_Q3_IQWM.md) — endpoint
//      akan gagal (tabel belum ada) atau, kalau tabel sudah ada tapi Anda
//      belum yakin datanya benar, akan mengotori data production.
//   5. Setelah yakin, jalankan pushQuickWinQ3Semua() secara manual.
//   6. JANGAN jalankan setupQuickWinQ3Trigger() sebelum langkah 3-5 di atas
//      tervalidasi berkali-kali dan Anda memang mau sync otomatis.
//
// CATATAN PENTING soal parser breakdown (lihat komentar parseBreakdownSheet_
// di bawah): karena layout pasti sheet "Breakdown Target Instaqris"/"Breakdown
// Target Winme" tidak bisa dipastikan dari sini (spreadsheet privat, tidak
// bisa diakses read-only untuk verifikasi), parser mendeteksi section
// "TARGET"/"REALISASI" dan baris header bulan/minggu secara otomatis
// (bukan index kolom hardcode). KALAU deteksi ini tidak cocok dengan layout
// sheet Anda yang sebenarnya, previewQuickWinQ3Payload() akan menunjukkan
// 0 breakdown rows + warning yang jelas — JANGAN dipaksa sync, laporkan
// hasil preview-nya dulu supaya parser bisa disesuaikan.
// ============================================================

const QW3_SHEET_ID = '1fZ-4EWsOHy-Slhq1F_jLxOCgFjGd9mp5K5Xt8BIFFgI';
const QW3_SHEET_RESUME = 'Resume IQWM';
const QW3_SHEET_BREAKDOWN_INSTAQRIS = 'Breakdown Target Instaqris';
const QW3_SHEET_BREAKDOWN_WINME = 'Breakdown Target Winme';

const QW3_DEFAULT_SYNC_URL = 'https://bmsretail.my.id/api/warroom/quick-win-q3/sync';
const QW3_DEFAULT_PERIODE = '2026-Q3';
const QW3_DEFAULT_LABEL = 'Q3 2026';
const QW3_DEFAULT_PERIOD_START = '2026-07-01';
const QW3_DEFAULT_PERIOD_END = '2026-09-30';

const QW3_FORMULA_ERRORS = ['#NAME?', '#DIV/0!', '#VALUE!', '#N/A', '#REF!', '#NULL!', '#NUM!'];
const QW3_MONTH_ALIASES = {
  JULI: 7, JULY: 7, JUL: 7,
  AGUSTUS: 8, AUGUST: 8, AGT: 8, AUG: 8, AGU: 8,
  SEPTEMBER: 9, SEP: 9, SEPT: 9,
};
const QW3_METRIC_TYPE_MAP = [
  [/REVENUE/, 'revenue'],
  [/^NMAT$/, 'target'],
  [/^MAT$/, 'target'],
  [/TRANSAKSI|TRANSACTION/, 'transaction'],
  [/REGISTRASI|REGISTRATION/, 'registration'],
  [/DEVICE/, 'device'],
  [/PRODUK TERJUAL|PRODUCT SOLD/, 'product_sold'],
];

// ─────────────────────────────────────────────────────────────────────────
// Script Properties — TIDAK ADA token/URL hardcoded di kode.
// ─────────────────────────────────────────────────────────────────────────
function qw3GetScriptProp_(key, required) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (required && !val) {
    throw new Error('Script Property "' + key + '" belum diisi. Buka Project Settings > Script Properties dan isi dulu.');
  }
  return val;
}
function qw3GetSyncToken_() {
  return qw3GetScriptProp_('QUICK_WIN_Q3_SYNC_TOKEN', true);
}
function qw3GetSyncUrl_() {
  return qw3GetScriptProp_('QUICK_WIN_Q3_SYNC_URL', false) || QW3_DEFAULT_SYNC_URL;
}

// ─────────────────────────────────────────────────────────────────────────
// Tanggal & progress waktu
// ─────────────────────────────────────────────────────────────────────────
function formatDateJakarta_(date) {
  return Utilities.formatDate(date, 'Asia/Jakarta', 'yyyy-MM-dd');
}
function qw3GetTodayJakarta_() {
  return formatDateJakarta_(new Date());
}
function calculateTotalDays_(periodStart, periodEnd) {
  const start = new Date(periodStart + 'T00:00:00');
  const end = new Date(periodEnd + 'T00:00:00');
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}
function calculateDaysElapsed_(periodStart, periodEnd, asOfDate) {
  const start = new Date(periodStart + 'T00:00:00');
  const end = new Date(periodEnd + 'T00:00:00');
  const asOf = new Date(asOfDate + 'T00:00:00');
  if (asOf.getTime() < start.getTime()) return 0; // belum mulai
  const totalDays = calculateTotalDays_(periodStart, periodEnd);
  if (asOf.getTime() > end.getTime()) return totalDays; // sudah lewat periode
  return Math.round((asOf.getTime() - start.getTime()) / 86400000) + 1;
}

// ─────────────────────────────────────────────────────────────────────────
// Parser angka/persen aman — SAMA aturan dengan backend (lihat
// backend/src/routes/warroom-quick-win-q3.js): typeof number langsung
// dipakai (anti insiden Speedcash 100x — titik desimal number asli TIDAK
// PERNAH dihapus), formula error -> null, string diparsing pakai
// displayValue (getDisplayValues()) kalau value mentah bukan number.
// ─────────────────────────────────────────────────────────────────────────
function isFormulaError_(value) {
  if (value === null || value === undefined) return false;
  const s = String(value).trim().toUpperCase();
  return QW3_FORMULA_ERRORS.indexOf(s) !== -1;
}

/** value = hasil getValues(), displayValue = hasil getDisplayValues() (opsional). */
function safeNumber_(value, displayValue) {
  if (isFormulaError_(value) || isFormulaError_(displayValue)) return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  const raw = (displayValue !== undefined && displayValue !== null && String(displayValue).trim() !== '')
    ? String(displayValue) : String(value === null || value === undefined ? '' : value);
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-') return null;
  if (isFormulaError_(trimmed)) return null;
  if (trimmed.indexOf('%') !== -1) return safePercent_(value, displayValue);
  let cleaned = trimmed.replace(/rp/gi, '').trim();
  cleaned = cleaned.replace(/[.,]/g, ''); // di sheet ini titik & koma = pemisah ribuan (bukan desimal)
  cleaned = cleaned.replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return isFinite(n) ? n : null;
}

/** Selalu return decimal 0..1 (bukan 0..100). */
function safePercent_(value, displayValue) {
  if (isFormulaError_(value) || isFormulaError_(displayValue)) return null;
  if (typeof value === 'number') {
    if (!isFinite(value)) return null;
    return value <= 1 ? value : value / 100;
  }
  const raw = (displayValue !== undefined && displayValue !== null && String(displayValue).trim() !== '')
    ? String(displayValue) : String(value === null || value === undefined ? '' : value);
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-') return null;
  if (isFormulaError_(trimmed)) return null;
  const hasPercentSign = trimmed.indexOf('%') !== -1;
  const cleaned = trimmed.replace('%', '').trim().replace(',', '.'); // "55,18%" gaya Indonesia -> desimal
  const n = Number(cleaned);
  if (!isFinite(n)) return null;
  if (hasPercentSign) return n / 100;
  return n <= 1 ? n : n / 100;
}

function qw3SafeDiv_(numerator, denominator) {
  if (typeof numerator !== 'number' || !isFinite(numerator)) return null;
  if (typeof denominator !== 'number' || !isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

/** Ambil angka utama di akhir label seperti "MAT : 3.000" -> 3000. */
function qw3ExtractLeadingNumber_(label) {
  if (!label) return null;
  const match = String(label).match(/([\d.,]+)\s*$/);
  if (!match) return null;
  return safeNumber_(match[1], match[1]);
}

// ─────────────────────────────────────────────────────────────────────────
// Normalisasi product / metric / bulan / minggu
// ─────────────────────────────────────────────────────────────────────────
function normalizeProduct_(value) {
  const s = String(value || '').trim().toUpperCase();
  if (s.indexOf('WINME') !== -1) return 'Winme';
  if (s.indexOf('INSTAQRIS') !== -1 || s.indexOf('INSTA QRIS') !== -1) return 'InstaQRIS';
  return String(value || '').trim(); // produk lain: dibiarkan apa adanya (bukan di-force ke 2 produk)
}

function normalizeMetricType_(metricLabel) {
  const s = String(metricLabel || '').trim().toUpperCase();
  for (let i = 0; i < QW3_METRIC_TYPE_MAP.length; i++) {
    if (QW3_METRIC_TYPE_MAP[i][0].test(s)) return QW3_METRIC_TYPE_MAP[i][1];
  }
  return 'unknown';
}

/** "Juli" -> { month_key: "2026-07", month_label: "Juli 2026" }. "Q3"/"Q3 2026" -> month_key "2026-Q3". */
function monthNameToKey_(label, year) {
  const s = String(label || '').trim().toUpperCase();
  if (!s) return null;
  const y = year || Number(QW3_DEFAULT_PERIOD_START.slice(0, 4));
  if (s === 'Q3' || s.indexOf('Q3') !== -1) return { month_key: y + '-Q3', month_label: 'Q3 ' + y };
  const num = QW3_MONTH_ALIASES[s];
  if (!num) return null;
  const LABELS = { 7: 'Juli', 8: 'Agustus', 9: 'September' };
  return { month_key: y + '-' + String(num).padStart(2, '0'), month_label: LABELS[num] + ' ' + y };
}

/** "Week 1"/"W1"/"Minggu 1" -> "week_1". "Total Bulan" -> "month_total". "Q3 Total" -> "q3_total". null kalau tidak dikenali. */
function normalizeWeekLabel_(value) {
  const s = String(value || '').trim().toUpperCase();
  if (!s) return null;
  const weekMatch = /^(WEEK|W|MINGGU)[\s\-]*([1-5])$/.exec(s);
  if (weekMatch) return 'week_' + weekMatch[2];
  if (/TOTAL\s*BULAN|MONTHLY\s*TOTAL/.test(s)) return 'month_total';
  if (/Q3\s*TOTAL|TOTAL\s*Q3/.test(s)) return 'q3_total';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Baca sheet mentah — getValues() (angka/tanggal asli) + getDisplayValues()
// (teks apa adanya termasuk "Rp", "%", "#NAME?" — WAJIB untuk deteksi
// formula error, getValues() untuk cell error mengembalikan objek Error
// yang tidak berguna untuk parsing string).
// ─────────────────────────────────────────────────────────────────────────
function getSheetData_(sheetName) {
  const ss = SpreadsheetApp.openById(QW3_SHEET_ID);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet "' + sheetName + '" tidak ditemukan di spreadsheet.');
  const range = sheet.getDataRange();
  return {
    sheet: sheet,
    values: range.getValues(),
    displayValues: range.getDisplayValues(),
  };
}

function qw3BuildRawData_(rowDisplay) {
  const obj = {};
  (rowDisplay || []).forEach(function (v, i) { obj['col_' + i] = v; });
  return obj;
}

// ─────────────────────────────────────────────────────────────────────────
// Parser Sheet 1 — Resume IQWM
//   A No. | B Point Quick Win | C Target | D Target Revenue | E Realisasi
//   Target | F % Realisasi Target | G Realisasi Target Revenue |
//   H % Realisasi Target Revenue | I PIC | J Estimasi End of Q3
// Struktur: baris section "WINME", baris header ("...Point Quick Win..."),
// 3 baris Quick Win, baris "Total" (di-skip) — lalu ulang untuk InstaQRIS.
// ─────────────────────────────────────────────────────────────────────────
function parseResumeIQWM_(sheetData) {
  const values = sheetData.values;
  const display = sheetData.displayValues;
  const rows = [];
  const warnings = [];
  let currentProduct = null;

  for (let r = 0; r < display.length; r++) {
    const rowDisp = display[r] || [];
    const rowJoined = rowDisp.join(' ').trim();
    if (!rowJoined) continue;
    const rowUpper = rowJoined.toUpperCase();
    const isHeaderRow = rowUpper.indexOf('POINT QUICK WIN') !== -1;
    // PENTING: deteksi section HANYA dari kolom A yang PERSIS "WINME"/
    // "InstaQRIS" (bukan cek substring di seluruh baris) — sheet asli
    // punya Quick Win "...Buyer Network Winme via Open Cataloque Saas"
    // yang kolom B-nya (Point Quick Win) mengandung kata "Winme" juga,
    // jadi kalau dicek di seluruh baris, baris data ini SALAH terdeteksi
    // sebagai section marker dan hilang (ini bug nyata yang bikin resume
    // rows kebaca 5 bukan 6 saat validasi preview pertama).
    const colAUpper = (rowDisp[0] || '').trim().toUpperCase();

    if (!isHeaderRow) {
      if (colAUpper === 'WINME') { currentProduct = normalizeProduct_(colAUpper); continue; }
      if (colAUpper === 'INSTAQRIS' || colAUpper === 'INSTA QRIS') { currentProduct = normalizeProduct_(colAUpper); continue; }
    }
    if (isHeaderRow) continue; // baris header kolom, bukan data
    if (!currentProduct) continue; // belum ketemu section product apa pun, lewati

    const noDisplay = (rowDisp[0] || '').trim();
    const pointQuickWin = (rowDisp[1] || '').trim();

    if (/^TOTAL$/i.test(noDisplay) || /^TOTAL$/i.test(pointQuickWin)) continue; // skip baris Total

    const quickwinNo = safeNumber_(values[r][0], noDisplay);
    if (quickwinNo === null || !pointQuickWin) continue; // bukan baris Quick Win valid (kosong/aneh) -> lewati diam-diam

    const targetLabelDisplay = (rowDisp[2] || '').trim();
    const targetRevenue = safeNumber_(values[r][3], rowDisp[3]);
    const realizationTarget = safeNumber_(values[r][4], rowDisp[4]);
    const realizationTargetPct = safePercent_(values[r][5], rowDisp[5]);
    const realizationRevenue = safeNumber_(values[r][6], rowDisp[6]);
    const realizationRevenuePct = safePercent_(values[r][7], rowDisp[7]);
    const pic = (rowDisp[8] || '').trim() || null;
    const estimatedEndQ3 = safeNumber_(values[r][9], rowDisp[9]);

    if (targetRevenue === null) warnings.push('[Resume IQWM] baris ' + (r + 1) + ' (' + currentProduct + ' #' + quickwinNo + '): Target Revenue tidak terbaca (' + (rowDisp[3] || '(kosong)') + ').');
    if (realizationRevenue === null) warnings.push('[Resume IQWM] baris ' + (r + 1) + ' (' + currentProduct + ' #' + quickwinNo + '): Realisasi Target Revenue tidak terbaca (' + (rowDisp[6] || '(kosong)') + ').');
    if (!pic) warnings.push('[Resume IQWM] baris ' + (r + 1) + ' (' + currentProduct + ' #' + quickwinNo + '): PIC kosong.');

    rows.push({
      product: currentProduct,
      quickwin_no: quickwinNo,
      point_quickwin: pointQuickWin,
      target_label: targetLabelDisplay,
      target_value: qw3ExtractLeadingNumber_(targetLabelDisplay),
      target_revenue: targetRevenue,
      realization_target: realizationTarget,
      realization_target_pct: realizationTargetPct,
      realization_revenue: realizationRevenue,
      realization_revenue_pct: realizationRevenuePct,
      pic: pic,
      estimated_end_q3: estimatedEndQ3,
      estimated_target_value_end_q3: null, // belum ada kolom terpisah di sheet saat ini
      source_sheet: QW3_SHEET_RESUME,
      source_row: r + 1,
      raw_data: qw3BuildRawData_(rowDisp),
    });
  }

  if (rows.length !== 6) {
    warnings.push('[Resume IQWM] Jumlah Quick Win terbaca = ' + rows.length + ', bukan 6 (3 Winme + 3 InstaQRIS) — cek sheet, mungkin ada section/baris yang tidak terdeteksi.');
  }
  return { rows: rows, warnings: warnings };
}

// ─────────────────────────────────────────────────────────────────────────
// Parser Sheet 2 & 3 — Breakdown Target Instaqris / Breakdown Target Winme
//
// LAYOUT SEBENARNYA (dikonfirmasi lewat debugQuickWinQ3Sheets_() terhadap
// sheet asli, Prompt 3 — BUKAN lagi asumsi seperti versi Prompt 2):
//   - Baris paling atas = ringkasan Target Juli/Agustus/September per
//     metric (TANPA realisasi) — SENGAJA DILEWATI, karena datanya duplikat
//     dengan kolom "Target Result" di tiap section bulanan (§ lihat langkah
//     3), dan section bulanan punya realisasi juga (lebih lengkap).
//   - Section per bulan ditandai baris berisi HANYA nama bulan di kolom A
//     ("Juli"/"Agustus"/"September", kolom lain kosong).
//   - Baris TEPAT SETELAH marker bulan = header minggu, isinya kolom
//     "Target Result", lalu pasangan kolom "Target Week N (..%)"/
//     "Realisasi Week N" berselang-seling (jumlah minggu BERBEDA per
//     bulan — Juli/September 5 minggu, Agustus 4 minggu — makanya
//     dideteksi dinamis dari teks header, bukan index kolom hardcode),
//     lalu "Total Realisasi" di akhir (kolom terakhir kadang "Realisasi"
//     %, kadang "GAP TARGET" — TIDAK dipakai, realization_pct/gap_value
//     dihitung sendiri dari target_value & realization_value supaya
//     konsisten meski label sheet tidak konsisten antar bulan).
//   - Baris data: kolom A (Point Quick Win) HANYA terisi di baris PERTAMA
//     tiap Quick Win dalam section itu, kolom B = nama metric (NMAT/
//     Revenue/MAT/dst — "Poin Result" di header). Antar Quick Win
//     dipisah baris kosong.
//   - Cell header bisa multi-baris (contoh: "Target Week 1 (10%)\n1-5
//     Juli") — hanya baris PERTAMA teks yang dipakai untuk deteksi.
//
// quickwin_no dicocokkan (best-effort, exact-text-match) ke point_quickwin
// dari Resume IQWM lewat parameter resumeLookup — kalau tidak ketemu,
// dibiarkan null (bukan ditebak).
// ─────────────────────────────────────────────────────────────────────────

/** Parse 1 baris header minggu -> { targetResultCol, totalRealisasiCol, weekCols: { week_1: {targetCol, realizationCol}, ... } }. */
function qw3ParseWeekSectionHeader_(headerRowDisplay) {
  const result = { targetResultCol: null, totalRealisasiCol: null, weekCols: {} };
  for (let c = 0; c < headerRowDisplay.length; c++) {
    const cellText = String(headerRowDisplay[c] || '').trim();
    if (!cellText) continue;
    const firstLine = cellText.split('\n')[0].trim().toUpperCase();
    if (/^TARGET RESULT/.test(firstLine)) { result.targetResultCol = c; continue; }
    if (/^TOTAL REALISASI/.test(firstLine)) { result.totalRealisasiCol = c; continue; }
    const weekMatch = /WEEK\s*([1-5])/.exec(firstLine);
    if (!weekMatch) continue;
    const weekKey = 'week_' + weekMatch[1];
    if (!result.weekCols[weekKey]) result.weekCols[weekKey] = {};
    if (/^TARGET/.test(firstLine)) result.weekCols[weekKey].targetCol = c;
    else if (/^REALISASI/.test(firstLine)) result.weekCols[weekKey].realizationCol = c;
  }
  return result;
}

/** Cari quickwin_no dari Resume IQWM (product yang sama) berdasarkan point_quickwin exact match (trim, case-insensitive). null kalau tidak ketemu. */
function qw3LookupQuickwinNo_(resumeLookup, product, pointQuickWin) {
  if (!resumeLookup || !pointQuickWin) return null;
  const key = product + '|' + String(pointQuickWin).trim().toUpperCase();
  return resumeLookup[key] !== undefined ? resumeLookup[key] : null;
}

// Batas wajar jumlah baris breakdown per sheet (data riil saat ini ~40-200
// baris: maks ~4 metric x 3 bulan x (1 month_total + 5 minggu) x 3 quickwin).
// Circuit breaker kalau parser somehow membaca ribuan baris -- insiden nyata
// 2026-07-20: 138.203 baris terkirim karena data sisa/scratch outlet-level
// (id_outlet | jumlah_transaksi | revenue_mdr, ribuan baris) tertinggal di
// bawah tabel breakdown asli pada sheet, dan currentMonth/weekHeader yang
// tidak pernah direset setelah section bulan terakhir membuat baris-baris
// itu ikut ter-parse sebagai data breakdown palsu -> UrlFetchApp gagal
// (Limit Exceeded: URLFetch POST Size). Diperbaiki juga lewat filter
// metricType 'unknown' di bawah -- breaker ini cadangan kalau filter itu
// tidak menangkap suatu kasus.
const QW3_MAX_BREAKDOWN_ROWS_PER_SHEET = 1000;

function parseBreakdownSheet_(sheetName, product, sheetData, resumeLookup) {
  const values = sheetData.values;
  const display = sheetData.displayValues;
  const warnings = [];
  const rows = [];
  const numRows = display.length;

  let currentMonth = null;   // { month_key, month_label }
  let weekHeader = null;     // hasil qw3ParseWeekSectionHeader_
  let currentPointQuickWin = null;
  let unknownMetricSkipped = 0; // dihitung, di-summary 1 baris di akhir -- JANGAN log per-baris (insiden log spam bill_info1 sebelumnya)

  for (let r = 0; r < numRows; r++) {
    const rowDisp = display[r] || [];
    const colA = (rowDisp[0] || '').trim();
    const colB = (rowDisp[1] || '').trim();
    const rowJoined = rowDisp.join('').trim();

    if (!rowJoined) { currentPointQuickWin = null; continue; } // baris kosong = pemisah antar Quick Win

    // Deteksi marker bulan: kolom A PERSIS nama bulan, kolom lain kosong semua.
    const monthCandidate = monthNameToKey_(colA, null);
    const restEmpty = rowDisp.slice(1).every(function (c) { return !String(c || '').trim(); });
    if (monthCandidate && restEmpty) {
      currentMonth = monthCandidate;
      weekHeader = null; // header minggu ada di baris BERIKUTNYA, di-parse di iterasi selanjutnya
      currentPointQuickWin = null;
      continue;
    }

    if (!currentMonth) continue; // masih di ringkasan atas / belum ketemu section bulan -> lewati (sengaja, lihat komentar di atas)

    if (!weekHeader) {
      // Baris tepat setelah marker bulan -> wajib header minggu
      weekHeader = qw3ParseWeekSectionHeader_(rowDisp);
      if (Object.keys(weekHeader.weekCols).length === 0) {
        warnings.push('[' + sheetName + '] Baris ' + (r + 1) + ': header minggu untuk bulan ' + currentMonth.month_label + ' tidak terbaca (0 kolom "Target/Realisasi Week N" ditemukan) — section bulan ini dilewati.');
        currentMonth = null;
      }
      continue;
    }

    if (colA) currentPointQuickWin = colA; // kolom A terisi -> baris pertama Quick Win baru
    const metricLabel = colB;
    if (!metricLabel) continue; // baris tanpa metric label (kemungkinan baris aneh/kosong sebagian) -> lewati, jangan invent

    const metricType = normalizeMetricType_(metricLabel);
    if (metricType === 'unknown') {
      // Label metric tidak cocok NMAT/MAT/Revenue/Transaksi/Registrasi/
      // Device/Produk Terjual -> bukan baris breakdown asli (kemungkinan
      // data sisa/scratch tertinggal di bawah tabel, lihat komentar
      // QW3_MAX_BREAKDOWN_ROWS_PER_SHEET di atas). Lewati, jangan ditebak.
      unknownMetricSkipped++;
      continue;
    }
    const quickwinNo = qw3LookupQuickwinNo_(resumeLookup, product, currentPointQuickWin);
    const monthTargetTotal = weekHeader.targetResultCol !== null ? safeNumber_(values[r][weekHeader.targetResultCol], rowDisp[weekHeader.targetResultCol]) : null;
    const monthRealizationTotal = weekHeader.totalRealisasiCol !== null ? safeNumber_(values[r][weekHeader.totalRealisasiCol], rowDisp[weekHeader.totalRealisasiCol]) : null;

    function pushRow(weekLabel, targetValue, realizationValue) {
      rows.push({
        product: product,
        quickwin_no: quickwinNo,
        point_quickwin: currentPointQuickWin || null,
        metric_label: metricLabel,
        metric_type: metricType,
        month_key: currentMonth.month_key,
        month_label: currentMonth.month_label,
        week_label: weekLabel,
        week_start: null,
        week_end: null,
        target_value: targetValue,
        realization_value: realizationValue,
        realization_pct: qw3SafeDiv_(realizationValue, targetValue),
        gap_value: (targetValue !== null && realizationValue !== null) ? (targetValue - realizationValue) : null,
        source_sheet: sheetName,
        source_row: r + 1,
        raw_data: { target_display: null, realization_display: null },
      });
    }

    // 1 row agregat bulanan (Target Result vs Total Realisasi)
    pushRow('month_total', monthTargetTotal, monthRealizationTotal);

    // 1 row per minggu yang terdeteksi di header (jumlah minggu dinamis per bulan)
    Object.keys(weekHeader.weekCols).forEach(function (weekKey) {
      const wc = weekHeader.weekCols[weekKey];
      const targetValue = wc.targetCol !== undefined ? safeNumber_(values[r][wc.targetCol], rowDisp[wc.targetCol]) : null;
      const realizationValue = wc.realizationCol !== undefined ? safeNumber_(values[r][wc.realizationCol], rowDisp[wc.realizationCol]) : null;
      pushRow(weekKey, targetValue, realizationValue);
    });

    if (rows.length > QW3_MAX_BREAKDOWN_ROWS_PER_SHEET) {
      warnings.push('[' + sheetName + '] STOP: sudah lebih dari ' + QW3_MAX_BREAKDOWN_ROWS_PER_SHEET + ' baris breakdown terbaca (berhenti di baris sheet ke-' + (r + 1) + ' dari ' + numRows + ') — kemungkinan data sisa/scratch tertinggal di bawah tabel breakdown asli. Parsing dihentikan supaya tidak mengirim payload raksasa. Jalankan debugQuickWinQ3Sheets_() untuk cek isi sheet, bersihkan data sisa, baru sync lagi.');
      break;
    }
  }

  if (unknownMetricSkipped > 0) {
    warnings.push('[' + sheetName + '] ' + unknownMetricSkipped + ' baris dilewati karena label metric tidak dikenali (bukan NMAT/MAT/Revenue/Transaksi/Registrasi/Device/Produk Terjual) — kemungkinan data sisa/scratch di luar section bulan Juli/Agustus/September. Kalau jumlahnya besar dan tidak diduga, cek sheet manual.');
  }

  if (rows.length === 0) {
    warnings.push('[' + sheetName + '] Tidak ada breakdown row berhasil diparse sama sekali — cek layout sheet (mungkin nama bulan/format header berubah).');
  }
  return { rows: rows, warnings: warnings };
}

// ─────────────────────────────────────────────────────────────────────────
// Bangun payload lengkap dari 3 sheet
// ─────────────────────────────────────────────────────────────────────────
function buildQuickWinQ3Payload_() {
  const periode = QW3_DEFAULT_PERIODE;
  const periodStart = QW3_DEFAULT_PERIOD_START;
  const periodEnd = QW3_DEFAULT_PERIOD_END;
  const asOfDate = qw3GetTodayJakarta_();
  const totalDays = calculateTotalDays_(periodStart, periodEnd);
  const daysElapsed = calculateDaysElapsed_(periodStart, periodEnd, asOfDate);

  const payload = {
    periode: periode,
    label: QW3_DEFAULT_LABEL,
    period_start: periodStart,
    period_end: periodEnd,
    as_of_date: asOfDate,
    total_days: totalDays,
    days_elapsed: daysElapsed,
    source_url: 'https://docs.google.com/spreadsheets/d/' + QW3_SHEET_ID + '/edit',
    resume: [],
    breakdown: [],
    meta: {
      sheet_names: [QW3_SHEET_RESUME, QW3_SHEET_BREAKDOWN_INSTAQRIS, QW3_SHEET_BREAKDOWN_WINME],
      synced_by: 'apps_script',
      parse_warnings: [],
      formula_error_count: 0,
      resume_rows: 0,
      breakdown_rows: 0,
    },
  };

  // Resume IQWM — WAJIB ada, gagal baca sheet ini = fatal (dilempar ke atas)
  try {
    const resumeSheetData = getSheetData_(QW3_SHEET_RESUME);
    const resumeResult = parseResumeIQWM_(resumeSheetData);
    payload.resume = resumeResult.rows;
    payload.meta.parse_warnings = payload.meta.parse_warnings.concat(resumeResult.warnings);
  } catch (e) {
    throw new Error('Gagal membaca sheet "' + QW3_SHEET_RESUME + '": ' + e.message);
  }

  // Lookup product+point_quickwin -> quickwin_no dari Resume IQWM, dipakai
  // parseBreakdownSheet_ untuk mengisi quickwin_no (best-effort, exact match).
  const resumeLookup = {};
  payload.resume.forEach(function (r) {
    resumeLookup[r.product + '|' + String(r.point_quickwin || '').trim().toUpperCase()] = r.quickwin_no;
  });

  // Breakdown — TIDAK fatal kalau salah satu gagal/kosong, cukup warning
  // (payload tetap boleh dikirim sesuai instruksi).
  [[QW3_SHEET_BREAKDOWN_INSTAQRIS, 'InstaQRIS'], [QW3_SHEET_BREAKDOWN_WINME, 'Winme']].forEach(function (pair) {
    const sheetName = pair[0], product = pair[1];
    try {
      const sd = getSheetData_(sheetName);
      const result = parseBreakdownSheet_(sheetName, product, sd, resumeLookup);
      payload.breakdown = payload.breakdown.concat(result.rows);
      payload.meta.parse_warnings = payload.meta.parse_warnings.concat(result.warnings);
    } catch (e) {
      payload.meta.parse_warnings.push('Gagal membaca sheet "' + sheetName + '": ' + e.message);
    }
  });

  // Hitung formula_error_count dari raw_data yang tersimpan (bukan dari
  // kolom numerik yang sudah ter-null-kan — supaya tetap kedeteksi meski
  // nilai aslinya sudah "hilang" jadi null oleh safeNumber_/safePercent_).
  const errPattern = /#NAME\?|#DIV\/0!|#VALUE!|#N\/A|#REF!|#NULL!|#NUM!/i;
  let formulaErrorCount = 0;
  payload.resume.forEach(function (r) { if (errPattern.test(JSON.stringify(r.raw_data))) formulaErrorCount++; });
  payload.breakdown.forEach(function (r) { if (errPattern.test(JSON.stringify(r.raw_data))) formulaErrorCount++; });
  payload.meta.formula_error_count = formulaErrorCount;
  payload.meta.resume_rows = payload.resume.length;
  payload.meta.breakdown_rows = payload.breakdown.length;

  collectDataQuality_(payload);
  return payload;
}

/** Tambahkan warning ringkasan (missing breakdown per produk, jumlah resume tidak sesuai) ke payload.meta.parse_warnings. */
function collectDataQuality_(payload) {
  const winmeCount = payload.breakdown.filter(function (b) { return b.product === 'Winme'; }).length;
  const instaqrisCount = payload.breakdown.filter(function (b) { return b.product === 'InstaQRIS'; }).length;
  if (winmeCount === 0) payload.meta.parse_warnings.push('missing_breakdown_winme: tidak ada breakdown row untuk product Winme.');
  if (instaqrisCount === 0) payload.meta.parse_warnings.push('missing_breakdown_instaqris: tidak ada breakdown row untuk product InstaQRIS.');
  return payload.meta.parse_warnings;
}

/**
 * Validasi payload sebelum dikirim. Masalah MINOR -> masuk parse_warnings
 * (tidak throw). Masalah FATAL -> throw Error (pesan aman, tanpa credential).
 */
function validatePayload_(payload) {
  if (!payload || !payload.periode) throw new Error('Payload tidak valid: periode kosong.');
  if (!Array.isArray(payload.resume)) throw new Error('Payload tidak valid: resume bukan array.');
  if (!Array.isArray(payload.breakdown)) throw new Error('Payload tidak valid: breakdown bukan array.');

  const numericFieldsResume = ['target_value', 'target_revenue', 'realization_target', 'realization_target_pct', 'realization_revenue', 'realization_revenue_pct', 'estimated_end_q3', 'estimated_target_value_end_q3'];
  payload.resume.forEach(function (row, i) {
    if (!row.product) payload.meta.parse_warnings.push('Resume baris index ' + i + ' (source_row=' + row.source_row + ') tanpa product.');
    if (!row.point_quickwin) payload.meta.parse_warnings.push('Resume baris index ' + i + ' (source_row=' + row.source_row + ') tanpa point_quickwin.');
    numericFieldsResume.forEach(function (k) {
      const v = row[k];
      if (typeof v === 'number' && !isFinite(v)) throw new Error('Resume baris index ' + i + ' field "' + k + '" tidak valid (NaN/Infinity) — ada bug parser, laporkan sebelum sync.');
    });
  });

  const numericFieldsBreakdown = ['target_value', 'realization_value', 'realization_pct', 'gap_value'];
  payload.breakdown.forEach(function (row, i) {
    numericFieldsBreakdown.forEach(function (k) {
      const v = row[k];
      if (typeof v === 'number' && !isFinite(v)) throw new Error('Breakdown baris index ' + i + ' field "' + k + '" tidak valid (NaN/Infinity) — ada bug parser, laporkan sebelum sync.');
    });
  });

  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// FUNGSI PUBLIK
// ─────────────────────────────────────────────────────────────────────────

/**
 * Dump mentah isi 3 sheet (read-only, TIDAK mengubah/mengirim apa pun) —
 * dipakai kalau previewQuickWinQ3Payload() menunjukkan resume ≠ 6 atau
 * breakdown 0 rows, supaya parser bisa disesuaikan berdasarkan layout
 * SEBENARNYA (bukan tebakan). Jalankan ini, copy Execution Log, laporkan.
 */
function debugQuickWinQ3Sheets_() {
  Logger.log('=== DEBUG DUMP Quick Win Q3 — read-only, tidak ada yang dikirim ke backend ===');
  [QW3_SHEET_RESUME, QW3_SHEET_BREAKDOWN_INSTAQRIS, QW3_SHEET_BREAKDOWN_WINME].forEach(function (sheetName) {
    Logger.log('--- Sheet: "' + sheetName + '" ---');
    try {
      const sd = getSheetData_(sheetName);
      const maxRows = Math.min(sd.displayValues.length, 40);
      for (let r = 0; r < maxRows; r++) {
        const row = sd.displayValues[r] || [];
        Logger.log('Row ' + (r + 1) + ': [' + row.join(' | ') + ']');
      }
      if (sd.displayValues.length > maxRows) {
        Logger.log('... (' + (sd.displayValues.length - maxRows) + ' baris lagi tidak ditampilkan, total ' + sd.displayValues.length + ' baris)');
      }
    } catch (e) {
      Logger.log('ERROR membaca sheet "' + sheetName + '": ' + e.message);
    }
  });
  Logger.log('=== SELESAI DEBUG DUMP ===');
}

/** Dry-run — build payload, TIDAK mengirim apa pun ke backend. Jalankan ini dulu. */
function previewQuickWinQ3Payload() {
  Logger.log('=== PREVIEW Quick Win Q3 IQWM (dry-run — TIDAK mengirim ke backend) ===');
  const payload = buildQuickWinQ3Payload_();
  validatePayload_(payload);

  Logger.log('Periode: ' + payload.periode + ' (' + payload.label + ')');
  Logger.log('Rentang: ' + payload.period_start + ' s/d ' + payload.period_end + ' | as_of_date=' + payload.as_of_date);
  Logger.log('days_elapsed/total_days: ' + payload.days_elapsed + '/' + payload.total_days);
  Logger.log('Resume rows: ' + payload.resume.length);
  Logger.log('Breakdown rows: ' + payload.breakdown.length + ' (InstaQRIS=' + payload.breakdown.filter(function (b) { return b.product === 'InstaQRIS'; }).length + ', Winme=' + payload.breakdown.filter(function (b) { return b.product === 'Winme'; }).length + ')');
  Logger.log('Formula error count: ' + payload.meta.formula_error_count);

  Logger.log('--- Sample resume (maks 3) ---');
  payload.resume.slice(0, 3).forEach(function (r, i) {
    Logger.log((i + 1) + '. [' + r.product + ' #' + r.quickwin_no + '] ' + r.point_quickwin
      + ' | target_rev=' + r.target_revenue + ' realisasi_rev=' + r.realization_revenue
      + ' pic=' + r.pic + ' estimasi_eoq3=' + r.estimated_end_q3);
  });

  Logger.log('--- Sample breakdown (maks 5) ---');
  payload.breakdown.slice(0, 5).forEach(function (r, i) {
    Logger.log((i + 1) + '. [' + r.product + '] ' + r.metric_label + ' (' + r.metric_type + ') '
      + r.month_key + ' ' + r.week_label + ' | target=' + r.target_value + ' realisasi=' + r.realization_value);
  });

  Logger.log('--- Data quality warnings (' + payload.meta.parse_warnings.length + ') ---');
  payload.meta.parse_warnings.forEach(function (w, i) { Logger.log((i + 1) + '. ' + w); });

  Logger.log('=== SELESAI PREVIEW — tidak ada data yang dikirim ke backend ===');
  return payload;
}

/** Kirim payload ke backend sync endpoint. Token & URL dari Script Properties, TIDAK PERNAH di-log. */
function pushQuickWinQ3Semua() {
  const token = qw3GetSyncToken_(); // throw kalau belum diisi — tidak pernah di-log
  const url = qw3GetSyncUrl_();

  const payload = buildQuickWinQ3Payload_();
  validatePayload_(payload);

  Logger.log('Mengirim sync Quick Win Q3 IQWM ke ' + url + ' ...');
  Logger.log('Resume rows: ' + payload.resume.length + ', Breakdown rows: ' + payload.breakdown.length + ', warnings: ' + payload.meta.parse_warnings.length);

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: { 'x-sync-token': token },
    muteHttpExceptions: true,
  };

  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  const bodyText = res.getContentText().substring(0, 500);
  Logger.log('Response HTTP ' + code + ': ' + bodyText);

  if (code < 200 || code >= 300) {
    throw new Error('Sync gagal, HTTP ' + code + ': ' + bodyText);
  }
  Logger.log('✅ Sync berhasil.');
  return { status: code, body: bodyText };
}

/**
 * Buat trigger otomatis untuk pushQuickWinQ3Semua().
 * JANGAN JALANKAN FUNGSI INI SEKARANG — hanya disiapkan untuk Prompt
 * berikutnya. Jalankan manual HANYA SETELAH sync manual (pushQuickWinQ3Semua)
 * sudah tervalidasi berhasil beberapa kali dan datanya benar di dashboard.
 * Jadwal contoh di bawah: harian jam 06:00 WIB — sesuaikan kalau perlu
 * (mis. .everyHours(1) untuk tiap jam).
 */
function setupQuickWinQ3Trigger() {
  deleteQuickWinQ3Triggers();
  ScriptApp.newTrigger('pushQuickWinQ3Semua')
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .create();
  Logger.log('Trigger harian (06:00 WIB) dibuat untuk pushQuickWinQ3Semua.');
}

/** Hapus trigger pushQuickWinQ3Semua kalau ada — safety net. */
function deleteQuickWinQ3Triggers() {
  const triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'pushQuickWinQ3Semua'; });
  triggers.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log(triggers.length + ' trigger pushQuickWinQ3Semua dihapus.');
}
