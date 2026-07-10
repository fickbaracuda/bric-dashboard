// ═══════════════════════════════════════════════════════════════════════
// Produk Ekspedisi — Apps Script
// Sheet ID  : 1yVNeyHe3b_PLnFf3SGvLx3wuD4Gm3e6XItjiDADd_Lo
// Sheet tab : "Rev per produk" + "Rev produk per outlet"
// Endpoint  : POST {SYNC_URL}  (header x-sync-token)
//
// CARA PAKAI:
//   1. Buka Google Sheet di atas -> Extensions > Apps Script.
//   2. Tempel isi file ini (ganti/tambahkan sebagai file baru).
//   3. Project Settings > Script Properties, tambahkan:
//        EKSPEDISI_PRODUK_SYNC_TOKEN = <token yang sama dengan server>
//        EKSPEDISI_PRODUK_SYNC_URL   = https://bmsretail.my.id/api/warroom/ekspedisi-produk/sync
//        (URL boleh dikosongkan, akan pakai default di atas)
//   4. Jalankan previewEkspedisiProdukPayload() dulu, cek Logger (View > Logs).
//   5. Kalau preview OK (summary/outlet rows > 0, months >= 3, mapping masuk
//      akal), jalankan pushEkspedisiProdukSemua() SATU KALI.
//   6. JANGAN jalankan setupEkspedisiProdukTrigger() dulu (belum saatnya
//      trigger otomatis) — hanya dijalankan manual sampai ada instruksi lain.
// ═══════════════════════════════════════════════════════════════════════

const EKSPEDISI_PRODUK_SHEET_ID = '1yVNeyHe3b_PLnFf3SGvLx3wuD4Gm3e6XItjiDADd_Lo';
const EKSPEDISI_PRODUK_SHEET_SUMMARY = 'Rev per produk';
const EKSPEDISI_PRODUK_SHEET_OUTLET = 'Rev produk per outlet';
const EKSPEDISI_PRODUK_DEFAULT_URL = 'https://bmsretail.my.id/api/warroom/ekspedisi-produk/sync';
const EKSPEDISI_PRODUK_SYNC_KEY = 'ekspedisi_produk';

const EP_MONTH_ALIASES = {
  JAN: 1, JANUARI: 1,
  FEB: 2, FEBRUARI: 2,
  MAR: 3, MARET: 3,
  APR: 4, APRIL: 4,
  MEI: 5, MAY: 5,
  JUN: 6, JUNI: 6, JUNE: 6,
  JUL: 7, JULI: 7, JULY: 7,
  AGU: 8, AGT: 8, AGUSTUS: 8, AUG: 8,
  SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OKT: 10, OCT: 10, OKTOBER: 10,
  NOV: 11, NOVEMBER: 11,
  DES: 12, DEC: 12, DESEMBER: 12,
};
const EP_FORMULA_ERRORS = ['#NAME?', '#DIV/0!', '#VALUE!', '#N/A', '#REF!', '#NULL!', '#NUM!'];

function ep_monthNameToNum_(label) {
  const key = String(label || '').trim().toUpperCase();
  return EP_MONTH_ALIASES[key] || null;
}

function ep_isFormulaError_(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return EP_FORMULA_ERRORS.indexOf(s) !== -1;
}

/**
 * Parser angka aman — WAJIB cek typeof number DULU (insiden Speedcash: titik
 * desimal number asli ikut terhapus kalau langsung diproses sebagai string).
 * Untuk sheet ini titik & koma SELALU berarti pemisah ribuan (bukan desimal):
 * "1,000" -> 1000 | "1.000" -> 1000 | "23,902,300" -> 23902300 |
 * "23.902.300" -> 23902300 | "-462,810" -> -462810 | "" / "-" -> null.
 */
function safeNumber_(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (raw === '' || raw === '-') return null;
  if (ep_isFormulaError_(raw)) return null;
  let cleaned = raw.replace(/rp/gi, '').trim();
  cleaned = cleaned.replace(/[.,]/g, '');
  cleaned = cleaned.replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return isFinite(n) ? n : null;
}

function ep_toIsoDate_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'Asia/Jakarta', 'yyyy-MM-dd');
  }
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  return null;
}

/**
 * Deteksi tahun per bulan — anchor tahun berjalan ke bulan PALING KANAN
 * (terbaru/terakhir di grid), mundur ke kiri. Kalau nomor bulan naik saat
 * mundur ke kiri berarti baru lewat batas tahun -> tahun dikurangi 1.
 */
function ep_assignYears_(monthNums) {
  const n = monthNums.length;
  const years = new Array(n);
  years[n - 1] = new Date().getFullYear();
  for (let i = n - 2; i >= 0; i--) {
    years[i] = monthNums[i] > monthNums[i + 1] ? years[i + 1] - 1 : years[i + 1];
  }
  return years;
}

/**
 * Parse sheet "Rev per produk" (wide format):
 *   Baris label bulan  : ... | MEI | | | JUN | | | JUL | | | Day | 9
 *   Baris subheader     : id_produk | produk | mat | jml_bill | margin_fp | mat | ... | Vs Mei | Vs Jun
 *   Baris data          : <id> | <nama> | <angka x 3 per bulan> | ... | <vs_mei> | <vs_jun>
 * Baris "TOTAL" dan "Deviasi" dilewati (bukan produk).
 */
function ep_parseRevPerProduk_(sheet) {
  const values = sheet.getDataRange().getValues();
  const display = sheet.getDataRange().getDisplayValues();
  const warnings = [];
  let formulaErrorCount = 0;
  let dayNumber = null;

  // Cari baris label bulan (baris pertama dengan >=1 sel cocok nama bulan)
  let labelRowIdx = -1;
  for (let r = 0; r < Math.min(values.length, 6); r++) {
    const row = values[r] || [];
    if (row.some(cell => ep_monthNameToNum_(cell) !== null)) { labelRowIdx = r; break; }
  }
  if (labelRowIdx === -1) {
    warnings.push('Baris label bulan tidak ditemukan di sheet "' + EKSPEDISI_PRODUK_SHEET_SUMMARY + '".');
    return { rows: [], months: [], dayNumber: null, warnings, formulaErrorCount };
  }
  const labelRow = values[labelRowIdx] || [];
  const subheaderRow = values[labelRowIdx + 1] || [];
  const dataStartRow = labelRowIdx + 2;

  // Cari "Day" -> angka di sebelah kanannya
  for (let c = 0; c < labelRow.length - 1; c++) {
    if (String(labelRow[c] || '').trim().toLowerCase() === 'day') {
      const v = Number(values[labelRowIdx][c + 1]);
      if (!isNaN(v)) dayNumber = v;
    }
  }

  // Deteksi kolom id_produk & produk (2 kolom pertama non-bulan di subheader)
  const idCol = 0;
  const namaCol = 1;

  // Deteksi blok bulan: kolom di labelRow yang cocok nama bulan, grup 3 kolom (mat, jml_bill, margin_fp)
  const groups = [];
  for (let c = namaCol + 1; c < labelRow.length; c++) {
    const monthNum = ep_monthNameToNum_(labelRow[c]);
    if (monthNum) groups.push({ startCol: c, monthNum, label: String(labelRow[c]).trim() });
  }
  if (!groups.length) {
    warnings.push('Tidak ada blok bulan (MEI/JUN/JUL) terdeteksi.');
    return { rows: [], months: [], dayNumber, warnings, formulaErrorCount };
  }
  const years = ep_assignYears_(groups.map(g => g.monthNum));
  groups.forEach((g, i) => {
    g.year = years[i];
    g.bulan = g.year + '-' + String(g.monthNum).padStart(2, '0');
    g.order = i + 1;
  });

  // Kolom "Vs <bulan>" — cari di subheader SETELAH blok bulan terakhir
  const lastGroupEndCol = groups[groups.length - 1].startCol + 3;
  const vsCols = [];
  for (let c = lastGroupEndCol; c < subheaderRow.length; c++) {
    const label = String(subheaderRow[c] || '').trim();
    if (/^vs\b/i.test(label)) vsCols.push({ col: c, label });
  }

  const rows = [];
  for (let r = dataStartRow; r < values.length; r++) {
    const row = values[r] || [];
    const disp = display[r] || [];
    const idProduk = String(row[idCol] || '').trim();
    const namaProduk = String(row[namaCol] || '').trim();
    const upper = idProduk.toUpperCase();
    if (!idProduk) continue;
    if (upper === 'TOTAL' || upper.indexOf('TOTAL') === 0) continue;
    if (upper.indexOf('DEVIASI') === 0) continue;

    groups.forEach(g => {
      const matRaw = row[g.startCol];
      const billRaw = row[g.startCol + 1];
      const marginRaw = row[g.startCol + 2];
      [matRaw, billRaw, marginRaw].forEach((v, i) => {
        if (ep_isFormulaError_(v)) formulaErrorCount++;
      });

      const isLatestGroup = g.order === groups.length;
      let vsMei = null, vsJun = null;
      if (isLatestGroup) {
        vsCols.forEach(vc => {
          const label = vc.label.toUpperCase();
          const v = safeNumber_(row[vc.col]);
          if (label.indexOf('MEI') !== -1 || label.indexOf('MAY') !== -1) vsMei = v;
          else if (label.indexOf('JUN') !== -1) vsJun = v;
        });
      }

      rows.push({
        bulan: g.bulan,
        bulan_label: g.label + ' ' + g.year,
        id_produk: idProduk,
        produk: namaProduk || null,
        mat: safeNumber_(matRaw),
        jml_bill: safeNumber_(billRaw),
        margin_fp: safeNumber_(marginRaw),
        vs_mei: vsMei,
        vs_jun: vsJun,
        source_sheet: EKSPEDISI_PRODUK_SHEET_SUMMARY,
        source_row: r + 1,
        raw_data: {
          mat_raw: disp[g.startCol], jml_bill_raw: disp[g.startCol + 1], margin_fp_raw: disp[g.startCol + 2],
        },
      });
    });
  }

  const months = groups.map(g => ({ bulan: g.bulan, label: g.label + ' ' + g.year }));
  return { rows, months, dayNumber, warnings, formulaErrorCount };
}

/**
 * Parse sheet "Rev produk per outlet" (blok horizontal per bulan, 5 kolom
 * per blok: tanggal, id_outlet, id_produk, jml_bill, margin_fp).
 */
function ep_parseRevProdukPerOutlet_(sheet) {
  const values = sheet.getDataRange().getValues();
  const display = sheet.getDataRange().getDisplayValues();
  const warnings = [];
  let formulaErrorCount = 0;

  let labelRowIdx = -1;
  for (let r = 0; r < Math.min(values.length, 6); r++) {
    const row = values[r] || [];
    if (row.some(cell => ep_monthNameToNum_(cell) !== null)) { labelRowIdx = r; break; }
  }
  if (labelRowIdx === -1) {
    warnings.push('Baris label bulan tidak ditemukan di sheet "' + EKSPEDISI_PRODUK_SHEET_OUTLET + '".');
    return { rows: [], months: [], warnings, formulaErrorCount };
  }
  const labelRow = values[labelRowIdx] || [];
  const dataStartRow = labelRowIdx + 2;

  const groups = [];
  for (let c = 0; c < labelRow.length; c += 5) {
    const monthNum = ep_monthNameToNum_(labelRow[c]);
    if (monthNum) groups.push({ startCol: c, monthNum, label: String(labelRow[c]).trim() });
  }
  if (!groups.length) {
    warnings.push('Tidak ada blok bulan (5 kolom) terdeteksi di "Rev produk per outlet".');
    return { rows: [], months: [], warnings, formulaErrorCount };
  }
  const years = ep_assignYears_(groups.map(g => g.monthNum));
  groups.forEach((g, i) => {
    g.year = years[i];
    g.bulan = g.year + '-' + String(g.monthNum).padStart(2, '0');
  });

  const rows = [];
  for (let r = dataStartRow; r < values.length; r++) {
    const row = values[r] || [];
    const disp = display[r] || [];
    groups.forEach(g => {
      const tanggalRaw = row[g.startCol];
      const idOutlet = String(row[g.startCol + 1] || '').trim();
      const idProduk = String(row[g.startCol + 2] || '').trim();
      const billRaw = row[g.startCol + 3];
      const marginRaw = row[g.startCol + 4];
      if (!idOutlet && !idProduk) return; // baris kosong dilewati
      if (ep_isFormulaError_(billRaw) || ep_isFormulaError_(marginRaw)) formulaErrorCount++;

      rows.push({
        bulan: g.bulan,
        bulan_label: g.label + ' ' + g.year,
        tanggal: ep_toIsoDate_(tanggalRaw),
        id_outlet: idOutlet || null,
        id_produk: idProduk || null,
        jml_bill: safeNumber_(billRaw),
        margin_fp: safeNumber_(marginRaw),
        source_sheet: EKSPEDISI_PRODUK_SHEET_OUTLET,
        source_row: r + 1,
        raw_data: { tanggal_raw: disp[g.startCol] },
      });
    });
  }

  const months = groups.map(g => ({ bulan: g.bulan, label: g.label + ' ' + g.year }));
  return { rows, months, warnings, formulaErrorCount };
}

function ep_buildPayload_() {
  const ss = SpreadsheetApp.openById(EKSPEDISI_PRODUK_SHEET_ID);
  const summarySheet = ss.getSheetByName(EKSPEDISI_PRODUK_SHEET_SUMMARY);
  const outletSheet = ss.getSheetByName(EKSPEDISI_PRODUK_SHEET_OUTLET);

  if (!summarySheet) throw new Error('Sheet "' + EKSPEDISI_PRODUK_SHEET_SUMMARY + '" tidak ditemukan.');
  if (!outletSheet) throw new Error('Sheet "' + EKSPEDISI_PRODUK_SHEET_OUTLET + '" tidak ditemukan.');

  const summaryParsed = ep_parseRevPerProduk_(summarySheet);
  const outletParsed = ep_parseRevProdukPerOutlet_(outletSheet);

  // Gabungkan daftar bulan dari kedua sheet (union, unik, urut)
  const monthMap = {};
  summaryParsed.months.forEach(m => { monthMap[m.bulan] = m.label; });
  outletParsed.months.forEach(m => { if (!monthMap[m.bulan]) monthMap[m.bulan] = m.label; });
  const months = Object.keys(monthMap).sort().map(bulan => ({ bulan, label: monthMap[bulan] }));

  const today = new Date();
  const asOfDate = Utilities.formatDate(today, 'Asia/Jakarta', 'yyyy-MM-dd');

  const payload = {
    sync_key: EKSPEDISI_PRODUK_SYNC_KEY,
    source_url: 'https://docs.google.com/spreadsheets/d/' + EKSPEDISI_PRODUK_SHEET_ID + '/edit',
    as_of_date: asOfDate,
    day_number: summaryParsed.dayNumber,
    months: months,
    summary: summaryParsed.rows,
    outlets: outletParsed.rows,
    meta: {
      sheet_names: [EKSPEDISI_PRODUK_SHEET_SUMMARY, EKSPEDISI_PRODUK_SHEET_OUTLET],
      synced_by: 'apps_script',
      formula_error_count: summaryParsed.formulaErrorCount + outletParsed.formulaErrorCount,
      parse_warnings: summaryParsed.warnings.concat(outletParsed.warnings),
    },
  };

  return payload;
}

/** Jalankan ini DULU — hanya membaca & melapor ke Logger, TIDAK mengirim apa pun. */
function previewEkspedisiProdukPayload() {
  const payload = ep_buildPayload_();
  Logger.log('=== PREVIEW Produk Ekspedisi ===');
  Logger.log('Months: ' + JSON.stringify(payload.months));
  Logger.log('Day number: ' + payload.day_number);
  Logger.log('Summary rows: ' + payload.summary.length);
  Logger.log('Outlet rows: ' + payload.outlets.length);
  Logger.log('Formula error count: ' + payload.meta.formula_error_count);
  Logger.log('Parse warnings: ' + JSON.stringify(payload.meta.parse_warnings));
  Logger.log('Sample summary rows (max 5): ' + JSON.stringify(payload.summary.slice(0, 5)));
  Logger.log('Sample outlet rows (max 5): ' + JSON.stringify(payload.outlets.slice(0, 5)));
  Logger.log('=== SELESAI PREVIEW — TIDAK ADA DATA YANG DIKIRIM ===');
  return payload;
}

/** Kirim payload ke VPS. Jalankan hanya SEKALI setelah preview OK. */
function pushEkspedisiProdukSemua() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('EKSPEDISI_PRODUK_SYNC_TOKEN');
  const url = props.getProperty('EKSPEDISI_PRODUK_SYNC_URL') || EKSPEDISI_PRODUK_DEFAULT_URL;

  if (!token) {
    Logger.log('ERROR: Script Property EKSPEDISI_PRODUK_SYNC_TOKEN belum di-set. Sync dibatalkan.');
    return;
  }

  const payload = ep_buildPayload_();
  Logger.log('Mengirim ' + payload.summary.length + ' baris summary, ' + payload.outlets.length + ' baris outlet, ' + payload.months.length + ' bulan ...');

  const options = {
    method: 'POST',
    contentType: 'application/json',
    headers: { 'x-sync-token': token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    const text = resp.getContentText().substring(0, 500);
    Logger.log('Response ' + code + ': ' + text);
    if (code === 200) {
      Logger.log('Sync berhasil.');
    } else {
      Logger.log('Sync gagal. HTTP ' + code);
    }
  } catch (e) {
    Logger.log('Error fetch: ' + e.message);
  }
}

/** BELUM DIPAKAI — jangan jalankan dulu sampai ada instruksi eksplisit. */
function setupEkspedisiProdukTrigger() {
  deleteEkspedisiProdukTriggers();
  ScriptApp.newTrigger('pushEkspedisiProdukSemua')
    .timeBased()
    .atHour(23)
    .nearMinute(0)
    .everyDays(1)
    .create();
  Logger.log('Trigger set: pushEkspedisiProdukSemua setiap hari 23:00 UTC (06:00 WIB).');
}

function deleteEkspedisiProdukTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'pushEkspedisiProdukSemua') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Trigger lama dihapus.');
    }
  });
}
