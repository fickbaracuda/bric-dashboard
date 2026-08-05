// ============================================================
// WAR ROOM MGM PA — PB Lifecycle & Productivity Control Tower
// Push ke BRIC Dashboard (backend/src/routes/warroom-mgm.js)
//
// Sheet source: 1_OwT_j1qIcq2GP4ir-f5grJFI58E6Q5J5BuFsyuT_-s
// Sheet per bulan bernama "MGM-<NamaBulan>" (mis. MGM-Agustus), tiga blok
// horizontal pada baris yang sama: AKTIVASI, REG, MGM AKTIV.
//
// PENTING — posisi blok TIDAK TETAP antar bulan (Mei/Juni: MGM AKTIV mulai
// kolom Z; Juli/Agustus: mulai kolom Y). Kode ini SELALU mendeteksi posisi
// blok dari judul di row 1 + header di row 2, TIDAK PERNAH pakai index
// kolom tetap. Lihat detectBlocks().
//
// SETUP WAJIB sebelum dipakai (sekali saja per project Apps Script):
//   1. Project Settings (ikon gerigi) -> Time zone -> "(GMT+07:00) Jakarta".
//   2. Project Settings -> Script Properties -> tambahkan key MGM_SYNC_TOKEN
//      dengan value token sync MGM PA (lihat backend .env server — token yang
//      SAMA dengan MGM_PA_SYNC_TOKEN/MGM_SYNC_TOKEN, JANGAN ditulis di sini).
//   3. Jalankan setupMgmDailyTrigger() sekali secara manual (approve izin).
// ============================================================

const SPREADSHEET_ID = '1_OwT_j1qIcq2GP4ir-f5grJFI58E6Q5J5BuFsyuT_-s'; // bukan secret
const API_BASE = 'https://bmsretail.my.id';
const TZ = 'Asia/Jakarta';
const MAX_COLS = 50;
const BLOCK_NAMES = ['AKTIVASI', 'REG', 'MGM AKTIV'];

const MONTH_NAME_TO_NUM = {
  'januari': 1, 'jan': 1,
  'februari': 2, 'feb': 2,
  'maret': 3, 'mar': 3,
  'april': 4, 'apr': 4,
  'mei': 5,
  'juni': 6, 'jun': 6,
  'juli': 7, 'jul': 7,
  'agustus': 8, 'agu': 8, 'ags': 8,
  'september': 9, 'sep': 9, 'sept': 9,
  'oktober': 10, 'okt': 10,
  'november': 11, 'nov': 11,
  'desember': 12, 'des': 12,
};

// ── Token dari Script Properties — TIDAK PERNAH hardcoded, TIDAK PERNAH di-log ──
function getSyncToken() {
  const token = PropertiesService.getScriptProperties().getProperty('MGM_SYNC_TOKEN');
  if (!token) {
    throw new Error('Script Property "MGM_SYNC_TOKEN" belum di-set. Buka Project Settings > Script Properties, tambahkan key MGM_SYNC_TOKEN dengan value token sync MGM PA.');
  }
  return token;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// ─────────────────────────────────────────────────────────────────
// Numeric cleaner — guard typeof number DULU sebelum string processing
// (insiden nyata: Speedcash pernah salah 100x krn titik desimal terhapus
// saat treat number sebagai string). Jangan ubah 408146.85 -> 40814685.
// ─────────────────────────────────────────────────────────────────
function cleanNum(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  let text = String(value).trim();
  if (!text) return 0;
  text = text.replace(/Rp/gi, '').replace(/\s/g, '');

  if (/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(text)) {
    const scientific = Number(text);
    return Number.isFinite(scientific) ? scientific : 0;
  }

  if (text.includes(',')) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else {
    text = text.replace(/,/g, '');
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// ─────────────────────────────────────────────────────────────────
// Phone — simpan sebagai TEXT, jangan pernah dipakai sebagai number/key,
// jangan menebak digit yang hilang akibat precision spreadsheet.
// ─────────────────────────────────────────────────────────────────
function formatPhone(raw) {
  if (raw === null || raw === undefined || raw === '') return { value: null, precisionRisk: false };
  if (typeof raw === 'string') {
    const s = raw.trim();
    const looksScientific = /e[+-]?\d+/i.test(s);
    return { value: s || null, precisionRisk: looksScientific };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { value: null, precisionRisk: true };
    if (Math.abs(raw) > Number.MAX_SAFE_INTEGER) return { value: String(raw), precisionRisk: true };
    return { value: String(Math.trunc(raw)), precisionRisk: false };
  }
  return { value: String(raw).trim() || null, precisionRisk: false };
}

// ─────────────────────────────────────────────────────────────────
// Date normalization — SELALU return 'YYYY-MM-DD' atau null. TIDAK PERNAH
// mengandalkan `new Date(string)` (locale-dependent, tidak aman).
// ─────────────────────────────────────────────────────────────────
function serialToUtcDate(serial) {
  const utcDays = Math.floor(serial - 25569); // 25569 = hari antara 1899-12-30 dan 1970-01-01
  return new Date(utcDays * 86400000);
}

function normalizeMgmDate(value, expectedMonth, expectedYear, enforceSheetMonth) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    let y = Number(Utilities.formatDate(value, TZ, 'yyyy'));
    let m = Number(Utilities.formatDate(value, TZ, 'MM'));
    let d = Number(Utilities.formatDate(value, TZ, 'dd'));
    // Swap-guard: kalau month hasil parse != expectedMonth TAPI day == expectedMonth,
    // ini kemungkinan besar day/month tertukar (mis. "09/05/2026" pada sheet Mei
    // terbaca sbg 2026-09-05, padahal seharusnya 2026-05-09).
    if (enforceSheetMonth && expectedMonth && m !== expectedMonth && d === expectedMonth) {
      const originalMonth = m;
      m = expectedMonth;
      d = originalMonth;
    }
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  if (typeof value === 'number') {
    return normalizeMgmDate(serialToUtcDate(value), expectedMonth, expectedYear, enforceSheetMonth);
  }

  const s = String(value).trim();
  if (!s) return null;

  // DD/MM/YYYY — parse manual, JANGAN pakai new Date(string).
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    let [, dd, mm, yyyy] = m;
    dd = Number(dd); mm = Number(mm); yyyy = Number(yyyy);
    if (enforceSheetMonth && expectedMonth && mm !== expectedMonth && dd === expectedMonth) {
      const originalMonth = mm;
      mm = expectedMonth;
      dd = originalMonth;
    }
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return `${yyyy}-${pad2(mm)}-${pad2(dd)}`;
  }

  // ISO YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const [, yyyy, mm, dd] = m;
    return `${yyyy}-${pad2(Number(mm))}-${pad2(Number(dd))}`;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────
// Dynamic block detection — TIDAK PERNAH pakai index kolom tetap (Y/Z/AA).
// Row 1 = judul blok, Row 2 = header kolom.
// ─────────────────────────────────────────────────────────────────
function normalizeHeaderName(raw) {
  const h = String(raw || '').trim();
  if (!h) return null;
  if (h.toLowerCase() === 'trx') return 'trx';
  if (h.toLowerCase() === 'rev') return 'rev';
  if (h === 'biaya_aktifasi-2') return 'biaya_aktifasi_2';
  return h;
}

function detectBlocks(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return null;
  const numCols = Math.min(sheet.getLastColumn(), MAX_COLS);
  const row1 = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  const row2 = sheet.getRange(2, 1, 1, numCols).getValues()[0];

  const starts = [];
  for (let c = 0; c < numCols; c++) {
    const label = String(row1[c] || '').trim().toUpperCase();
    if (BLOCK_NAMES.indexOf(label) !== -1) starts.push({ name: label, startCol: c });
  }
  if (!starts.length) return null;
  starts.sort((a, b) => a.startCol - b.startCol);

  let lastNonBlankHeader = -1;
  for (let c = numCols - 1; c >= 0; c--) {
    if (String(row2[c] || '').trim() !== '') { lastNonBlankHeader = c; break; }
  }
  if (lastNonBlankHeader === -1) return null;

  const blocks = {};
  starts.forEach((b, i) => {
    const endCol = i + 1 < starts.length ? starts[i + 1].startCol - 1 : lastNonBlankHeader;
    const headerMap = {};
    for (let c = b.startCol; c <= endCol; c++) {
      const h = normalizeHeaderName(row2[c]);
      if (h) headerMap[h] = c;
    }
    blocks[b.name] = { startCol: b.startCol, endCol, headerMap };
  });
  return blocks;
}

function getCell(row, headerMap, name) {
  const idx = headerMap[name];
  return idx === undefined ? null : row[idx];
}

// ─────────────────────────────────────────────────────────────────
// Derive tahun dari mayoritas tanggal valid (nama sheet cuma punya bulan).
// ─────────────────────────────────────────────────────────────────
function extractYearGuess(raw) {
  if (raw instanceof Date && !isNaN(raw.getTime())) return Number(Utilities.formatDate(raw, TZ, 'yyyy'));
  if (typeof raw === 'number') return extractYearGuess(serialToUtcDate(raw));
  const s = String(raw || '').trim();
  let m = s.match(/^\d{1,2}\/\d{1,2}\/(\d{4})$/);
  if (m) return Number(m[1]);
  m = s.match(/^(\d{4})-\d{1,2}-\d{1,2}/);
  if (m) return Number(m[1]);
  return null;
}

function deriveYear(dataRows, blocks) {
  const tally = {};
  const regMap = blocks['REG'] ? blocks['REG'].headerMap : {};
  dataRows.forEach(row => {
    [getCell(row, regMap, 'tanggal_registrasi'), getCell(row, regMap, 'tanggal_aktifasi')].forEach(raw => {
      const y = extractYearGuess(raw);
      if (y && y >= 2000 && y <= 2100) tally[y] = (tally[y] || 0) + 1;
    });
  });
  const years = Object.keys(tally);
  if (!years.length) return new Date().getFullYear();
  return Number(years.reduce((best, y) => (tally[y] > tally[best] ? y : best), years[0]));
}

function computeCutoffDate(registrasi, aktivasi) {
  let max = null;
  [...registrasi.map(r => r.tanggal_registrasi), ...aktivasi.map(a => a.tanggal_aktifasi)].forEach(d => {
    if (d && (!max || d > max)) max = d;
  });
  return max;
}

// ─────────────────────────────────────────────────────────────────
// Sync SATU sheet/bulan — satu request per sheet (bukan gabungan semua bulan).
// ─────────────────────────────────────────────────────────────────
function pushMgmSheetByName(sheetName) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`Sheet ${sheetName} tidak ditemukan`);

  const blocks = detectBlocks(sheet);
  if (!blocks || !blocks['AKTIVASI'] || !blocks['REG'] || !blocks['MGM AKTIV']) {
    throw new Error(`${sheetName}: blok AKTIVASI/REG/MGM AKTIV tidak lengkap terdeteksi di row 1 (cek judul blok — harus persis "AKTIVASI", "REG", "MGM AKTIV")`);
  }

  const monthLabel = sheetName.replace(/^MGM-/i, '').trim().toLowerCase();
  const expectedMonth = MONTH_NAME_TO_NUM[monthLabel];
  if (!expectedMonth) throw new Error(`${sheetName}: nama bulan "${monthLabel}" tidak dikenali di MONTH_NAME_TO_NUM`);

  const lastRow = sheet.getLastRow();
  if (lastRow < 3) throw new Error(`${sheetName}: tidak ada data (lastRow=${lastRow})`);
  const numCols = Math.min(sheet.getLastColumn(), MAX_COLS);
  const dataRows = sheet.getRange(3, 1, lastRow - 2, numCols).getValues();

  const expectedYear = deriveYear(dataRows, blocks);

  const registrasi = [];
  const aktivasi = [];
  const aktivasi_detail = [];
  const quality = { rows_scanned: dataRows.length, invalid_dates: 0, phone_precision_risk: 0 };

  dataRows.forEach(row => {
    // ── AKTIVASI ──
    const aktMap = blocks['AKTIVASI'].headerMap;
    const aktIdOutlet = normText(getCell(row, aktMap, 'id_outlet'));
    if (aktIdOutlet) {
      const phone = formatPhone(getCell(row, aktMap, 'notelp_pemilik'));
      if (phone.precisionRisk) quality.phone_precision_risk++;
      const tglRaw = getCell(row, aktMap, 'tanggal_aktifasi');
      const tgl = normalizeMgmDate(tglRaw, expectedMonth, expectedYear, true);
      if (tglRaw && !tgl) quality.invalid_dates++;
      aktivasi.push({
        upline: normText(getCell(row, aktMap, 'upline')),
        id_outlet: aktIdOutlet,
        nama_pemilik: normText(getCell(row, aktMap, 'nama_pemilik')),
        notelp_pemilik: phone.value,
        tipe_outlet: normText(getCell(row, aktMap, 'tipe_outlet')),
        balance: cleanNum(getCell(row, aktMap, 'balance')),
        is_active: getCell(row, aktMap, 'is_active'), // mentah — backend yg normalisasi 0/1/unknown
        nama_kota: normText(getCell(row, aktMap, 'nama_kota')),
        nama_propinsi: normText(getCell(row, aktMap, 'nama_propinsi')),
        tanggal_aktifasi: tgl,
        trx: cleanNum(getCell(row, aktMap, 'trx')),
        rev: cleanNum(getCell(row, aktMap, 'rev')),
        phone_precision_risk: phone.precisionRisk,
      });
    }

    // ── REG ──
    const regMap = blocks['REG'].headerMap;
    const regIdOutlet = normText(getCell(row, regMap, 'id_outlet'));
    if (regIdOutlet) {
      const phone = formatPhone(getCell(row, regMap, 'notelp_pemilik'));
      if (phone.precisionRisk) quality.phone_precision_risk++;
      const tglRegRaw = getCell(row, regMap, 'tanggal_registrasi');
      const tglReg = normalizeMgmDate(tglRegRaw, expectedMonth, expectedYear, true);
      if (tglRegRaw && !tglReg) quality.invalid_dates++;
      // tanggal_aktifasi pada REG OPSIONAL (ada di Mei/Juni, tidak ada di Juli/Agustus)
      // dan enforceSheetMonth=FALSE karena aktivasi bisa terjadi di bulan berikutnya.
      const tglAktRaw = getCell(row, regMap, 'tanggal_aktifasi');
      const tglAkt = tglAktRaw ? normalizeMgmDate(tglAktRaw, expectedMonth, expectedYear, false) : null;
      registrasi.push({
        upline: normText(getCell(row, regMap, 'upline')),
        id_outlet: regIdOutlet,
        nama_pemilik: normText(getCell(row, regMap, 'nama_pemilik')),
        notelp_pemilik: phone.value,
        tipe_outlet: normText(getCell(row, regMap, 'tipe_outlet')),
        balance: cleanNum(getCell(row, regMap, 'balance')),
        is_active: getCell(row, regMap, 'is_active'),
        nama_kota: normText(getCell(row, regMap, 'nama_kota')),
        nama_propinsi: normText(getCell(row, regMap, 'nama_propinsi')),
        tanggal_registrasi: tglReg,
        tanggal_aktifasi: tglAkt,
        phone_precision_risk: phone.precisionRisk,
      });
    }

    // ── MGM AKTIV (detail aktivasi berbayar) ──
    const detMap = blocks['MGM AKTIV'].headerMap;
    const idAktifasi = normText(getCell(row, detMap, 'id_aktifasi'));
    if (idAktifasi) {
      aktivasi_detail.push({
        id_aktifasi: idAktifasi,
        id_outlet: normText(getCell(row, detMap, 'id_outlet')),
        nama_group: normText(getCell(row, detMap, 'nama_group')),
        nama_pemilik: normText(getCell(row, detMap, 'nama_pemilik')),
        is_active: getCell(row, detMap, 'is_active'),
        upline: normText(getCell(row, detMap, 'upline')),
        pembayaran_via: normText(getCell(row, detMap, 'pembayaran_via')),
        biaya_aktifasi: cleanNum(getCell(row, detMap, 'biaya_aktifasi')),
        tipe_outlet: normText(getCell(row, detMap, 'tipe_outlet')),
        id_tipe_outlet: normText(getCell(row, detMap, 'id_tipe_outlet')),
        biaya_aktifasi_2: cleanNum(getCell(row, detMap, 'biaya_aktifasi_2')),
        hpp: cleanNum(getCell(row, detMap, 'hpp')),
        ongkos_kirim: cleanNum(getCell(row, detMap, 'ongkos_kirim')),
        fee_upline: cleanNum(getCell(row, detMap, 'fee_upline')),
        komisi_aktifasi: cleanNum(getCell(row, detMap, 'komisi_aktifasi')),
      });
    }
  });

  const periode = `${expectedYear}-${pad2(expectedMonth)}-01`;
  const cutoffDate = computeCutoffDate(registrasi, aktivasi);

  const payload = {
    periode,
    bulan: `${expectedYear}-${pad2(expectedMonth)}`,
    source_sheet: sheetName,
    cutoff_date: cutoffDate,
    registrasi, aktivasi, aktivasi_detail, quality,
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-sync-token': getSyncToken() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const resp = UrlFetchApp.fetch(`${API_BASE}/api/warroom/mgm/sync`, options);
  const status = resp.getResponseCode();
  const body = resp.getContentText();
  // Jangan log body penuh (bisa memuat quality detail saja, bukan PII — tapi tetap ringkas)
  Logger.log(`${sheetName} (periode ${periode}) -> HTTP ${status}: reg=${registrasi.length} akt=${aktivasi.length} detail=${aktivasi_detail.length} quality=${JSON.stringify(quality)}`);
  if (status < 200 || status >= 300) {
    throw new Error(`${sheetName}: sync gagal HTTP ${status} — ${body.substring(0, 300)}`);
  }
  return { sheetName, periode, status, registrasi: registrasi.length, aktivasi: aktivasi.length, aktivasi_detail: aktivasi_detail.length, quality };
}

// ── Sync bulan yang sedang aktif (periode terbaru di antara sheet MGM-*) ──
function pushMgmBulanAktif() {
  const target = findLatestMgmSheet_();
  if (!target) throw new Error('Tidak ada sheet MGM-<Bulan> ditemukan.');
  const result = pushMgmSheetByName(target.sheetName);
  try {
    SpreadsheetApp.getUi().alert(`Sync ${target.sheetName} selesai:\n\nHTTP ${result.status}\nRegistrasi: ${result.registrasi}\nAktivasi: ${result.aktivasi}\nMGM AKTIV (detail): ${result.aktivasi_detail}`);
  } catch (_) { /* trigger otomatis tidak punya UI */ }
  return result;
}

// ── Sync SEMUA sheet MGM-<Bulan>, urut periode ASC, satu request per sheet ──
function pushMgmSemuaBulan() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const targets = ss.getSheets()
    .map(s => s.getName())
    .filter(name => /^MGM-[A-Za-z]+$/i.test(name))
    .map(name => {
      const monthLabel = name.replace(/^MGM-/i, '').trim().toLowerCase();
      return { sheetName: name, month: MONTH_NAME_TO_NUM[monthLabel] };
    })
    .filter(t => t.month);

  // Urut berdasarkan bulan (tahun ditentukan per-sheet saat sync — untuk
  // pengurutan awal ini cukup pakai nomor bulan, karena workbook ini hanya
  // memuat sheet dalam satu rentang tahun berjalan).
  targets.sort((a, b) => a.month - b.month);

  const results = [];
  targets.forEach(t => {
    try {
      results.push(pushMgmSheetByName(t.sheetName));
    } catch (e) {
      Logger.log(`ERROR ${t.sheetName}: ${e.message}`);
      results.push({ sheetName: t.sheetName, error: e.message });
    }
  });

  const summary = results.map(r => r.error
    ? `${r.sheetName}: ERROR — ${r.error}`
    : `${r.sheetName}: reg=${r.registrasi} akt=${r.aktivasi} detail=${r.aktivasi_detail}`
  ).join('\n');
  Logger.log(`pushMgmSemuaBulan selesai:\n${summary}`);
  try { SpreadsheetApp.getUi().alert(`Sync semua bulan MGM PA selesai:\n\n${summary}`); } catch (_) {}
  return results;
}

function findLatestMgmSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const candidates = ss.getSheets()
    .map(s => s.getName())
    .filter(name => /^MGM-[A-Za-z]+$/i.test(name))
    .map(name => {
      const monthLabel = name.replace(/^MGM-/i, '').trim().toLowerCase();
      return { sheetName: name, month: MONTH_NAME_TO_NUM[monthLabel] };
    })
    .filter(t => t.month);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.month - a.month);
  return candidates[0];
}

// ── Trigger harian ~06:15 WIB (23:15 UTC) ──
function setupMgmDailyTrigger() {
  removeMgmTriggers();
  ScriptApp.newTrigger('pushMgmSemuaBulan')
    .timeBased()
    .atHour(23)
    .nearMinute(15)
    .everyDays(1)
    .create();
  Logger.log('Trigger MGM PA (harian, ~06:15 WIB) berhasil dibuat.');
  try { SpreadsheetApp.getUi().alert('Trigger harian MGM PA berhasil dibuat (~06:15 WIB).'); } catch (_) {}
}

function removeMgmTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'pushMgmSemuaBulan' || t.getHandlerFunction() === 'pushMgmBulanAktif')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ─────────────────────────────────────────────────────────────────
// Test parser lokal — TIDAK menyentuh network/sheet sungguhan. Jalankan
// manual dari Apps Script Editor untuk verifikasi cepat sebelum sync asli.
// ─────────────────────────────────────────────────────────────────
function testMgmParser() {
  const results = [];
  function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push(`${pass ? 'OK  ' : 'FAIL'} ${name}: got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }

  // Date: "09/05/2026" pada sheet Mei (expectedMonth=5) -> 2026-05-09
  check('DD/MM/YYYY 09/05/2026 pada Mei', normalizeMgmDate('09/05/2026', 5, 2026, true), '2026-05-09');

  // Date object yang "kebaca" 2026-09-05 padahal harusnya Mei -> swap ke 2026-05-09
  const swapped = new Date(Utilities.parseDate('2026-09-05', TZ, 'yyyy-MM-dd').getTime());
  check('Date object 2026-09-05 pada Mei (swap-guard)', normalizeMgmDate(swapped, 5, 2026, true), '2026-05-09');

  // REG.tanggal_aktifasi enforceSheetMonth=false, tetap apa adanya
  check('REG tanggal_aktifasi 2026-06-15 enforce=false', normalizeMgmDate('2026-06-15', 5, 2026, false), '2026-06-15');

  // Angka desimal tidak boleh kehilangan titik
  check('cleanNum 408146.85 (number)', cleanNum(408146.85), 408146.85);
  check('cleanNum "408.146,85" (format ID)', cleanNum('408.146,85'), 408146.85);
  check('cleanNum "408146.85" (format EN string)', cleanNum('408146.85'), 408146.85);

  // Scientific notation
  check('cleanNum 4.0814685e5', cleanNum('4.0814685e5'), 408146.85);

  // Blank / null
  check('cleanNum blank', cleanNum(''), 0);
  check('cleanNum null', cleanNum(null), 0);

  const output = results.join('\n');
  Logger.log(output);
  try { SpreadsheetApp.getUi().alert('testMgmParser selesai — lihat Logger untuk detail:\n\n' + output); } catch (_) {}
  return output;
}

// Guard ini TIDAK aktif di Google Apps Script (typeof module selalu
// 'undefined' di runtime GAS, jadi blok ini dilewati) — hanya dipakai
// supaya backend/scripts/test-mgm-warroom.js bisa require() file ini
// langsung dan menguji cleanNum/normalizeMgmDate/detectBlocks dengan
// implementasi PERSIS yang sama yang jalan di Apps Script, bukan salinan.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cleanNum, normalizeMgmDate, formatPhone, detectBlocks, normalizeHeaderName,
    deriveYear, extractYearGuess, computeCutoffDate, serialToUtcDate,
    MONTH_NAME_TO_NUM,
  };
}
