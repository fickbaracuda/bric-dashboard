// ═══════════════════════════════════════════════════════════════════════
// Rekonsiliasi BRI — Apps Script
// Sheet tab : nama persis sesuai RECON_BRI_SHEET_FP / RECON_BRI_SHEET_BANK di
//             bawah (getSheetByName exact-match, case & spasi harus sama
//             persis dgn nama tab sungguhan di spreadsheet)
// Endpoint  : POST {BRIC_API_BASE_URL}/api/warroom/reconciliation/bri/sync
//             (header x-sync-token)
//
// Spreadsheet ID TIDAK di-hardcode — diambil dari Script Property
// BRI_SPREADSHEET_ID; kalau kosong, fallback ke SpreadsheetApp.getActiveSpreadsheet()
// (script ini di-bind langsung ke Sheet-nya).
//
// CARA PAKAI:
//   1. Buka Google Sheet "DATA FP" + "DATA BRI" -> Extensions > Apps Script.
//   2. Tempel isi file ini sebagai file BARU.
//   3. Project Settings > Script Properties, tambahkan:
//        BRIC_SYNC_TOKEN     = <sama dengan APPS_SCRIPT_TOKEN server>
//        BRIC_API_BASE_URL   = https://bmsretail.my.id   (opsional, ini defaultnya)
//        BRI_SPREADSHEET_ID  = <ID spreadsheet, OPSIONAL kalau script ini
//                               sudah di-bind langsung ke Sheet-nya>
//   4. Jalankan testReconciliationBri() dulu (Logger.log, TIDAK mengirim
//      apa pun) — cek jumlah baris FP/BRI terbaca benar.
//   5. Kalau sudah OK, jalankan pushReconciliationBri() utk sync manual.
//   6. Jalankan setupReconciliationBriTrigger() utk sync OTOMATIS REAKTIF —
//      jalan ~30-90 detik setelah ada perubahan apa pun di Sheet (bukan
//      menunggu interval tetap). removeReconciliationBriTrigger() utk stop.
//   7. getReconciliationBriStatus() -> lihat ringkasan sync terakhir.
// ═══════════════════════════════════════════════════════════════════════

const RECON_BRI_SHEET_FP = 'Data FP';
const RECON_BRI_SHEET_BANK = 'Data bank bri';
const RECON_BRI_DEFAULT_BASE_URL = 'https://bmsretail.my.id';
const RECON_BRI_BANK_CODE = 'BRI';
const RECON_BRI_CHUNK_SIZE = 1500;
const RECON_BRI_LAST_STATUS_KEY = 'RECON_BRI_LAST_STATUS';

// Default config batch — dikirim di setiap chunk, dibaca server dgn
// fallback yang sama kalau field kosong (lihat backend/src/reconciliation/briAdapter.js).
const RECON_BRI_DEFAULT_ACCOUNT_NO = '36001001118309';
const RECON_BRI_DEFAULT_EXPECTED_FEE = 150;
const RECON_BRI_DEFAULT_GRACE_MINUTES = 30;
const RECON_BRI_DEFAULT_SCOPE_MODE = 'FP_COVERAGE_WINDOW';
const RECON_BRI_DEFAULT_COVERAGE_TOLERANCE_MINUTES = 60;
const RECON_BRI_DEFAULT_REVERSAL_LOOKUP_DAYS = 3;

// Auto-sync REAKTIF (bukan interval tetap) — pola SAMA dgn Rekonsiliasi
// OCBC/Mandiri (lihat apps-script-reconciliation-mandiri.js utk penjelasan
// lengkap kenapa 2 lapis: onChange hanya menandai dirty flag ringan, time-
// based trigger tiap 1 menit yang benar-benar mengecek & sync, dgn debounce
// supaya edit beruntun tidak memicu banyak sync tumpang tindih).
const RECON_BRI_DIRTY_FLAG_KEY = 'RECON_BRI_DIRTY_SINCE';
const RECON_BRI_SYNC_LOCK_KEY = 'RECON_BRI_SYNC_IN_PROGRESS';
const RECON_BRI_DEBOUNCE_MS = 30 * 1000; // tunggu 30 detik sejak edit terakhir sebelum sync
const RECON_BRI_CHECK_INTERVAL_MINUTES = 1;

/** Buka spreadsheet: Script Property BRI_SPREADSHEET_ID kalau ada, else getActiveSpreadsheet(). TIDAK PERNAH hardcode ID di kode. */
function reconBriOpenSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('BRI_SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Parser angka aman — WAJIB cek typeof number DULU (insiden Speedcash: titik
 * desimal number asli ikut terhapus kalau diproses sebagai string sebelum
 * cek tipe). Direplikasi persis di semua Apps Script baru.
 */
function reconBriCleanNum_(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (raw === '' || raw === '-') return null;
  let cleaned = raw.replace(/rp/gi, '').trim();
  cleaned = cleaned.replace(/[.,]/g, '');
  cleaned = cleaned.replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return isFinite(n) ? n : null;
}

/** Date object (dari getValues()) atau string -> string apa adanya (WIB), TIDAK dikonversi ke angka. */
function reconBriToIso_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'Asia/Jakarta', 'yyyy-MM-dd');
  }
  return String(value).trim();
}

/** id_transaksi/NOREK/id_outlet/JAM_TRAN/SEQ WAJIB string murni — jangan biarkan Apps Script membaca sbg Number (presisi digit besar/leading-zero bisa hilang, mis. JAM_TRAN "003153" jadi 3153 -- itu memang OK krn dinormalisasi backend, tapi utk ID transaksi leading-zero HARUS dipertahankan). */
function reconBriToStringId_(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(value).trim();
  }
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * Ambil { headerIndex } dari baris 1 sebuah sheet: map NAMA KOLOM (trim,
 * lowercase) -> index kolom (0-based). Dipakai supaya urutan kolom di sheet
 * tidak wajib persis A-F/A-R — asalkan nama header sesuai spek.
 */
function reconBriHeaderIndex_(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h || '').trim().toLowerCase();
    if (key) map[key] = i;
  });
  return map;
}
function reconBriCol_(row, headerIndex, name, fallbackIndex) {
  const key = String(name).trim().toLowerCase();
  const idx = Object.prototype.hasOwnProperty.call(headerIndex, key) ? headerIndex[key] : fallbackIndex;
  return idx === undefined || idx === null ? undefined : row[idx];
}

/**
 * Sheet "DATA FP": header baris 1 (dibaca by NAME, fallback ke index A-F
 * kalau nama tidak ditemukan), data mulai baris 2.
 * id_transaksi, nominal, id_produk, time_response, id_outlet, id_biller.
 */
function reconBriReadFp_(ss) {
  const sheet = ss.getSheetByName(RECON_BRI_SHEET_FP);
  if (!sheet) throw new Error('Sheet "' + RECON_BRI_SHEET_FP + '" tidak ditemukan.');

  const values = sheet.getDataRange().getValues(); // getValues() = read-only, TIDAK mengubah sheet asli
  if (values.length < 2) return [];
  const headerIndex = reconBriHeaderIndex_(values[0]);

  const rows = [];
  let skippedInvalid = 0;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const idTransaksi = reconBriToStringId_(reconBriCol_(row, headerIndex, 'id_transaksi', 0));
    if (!idTransaksi) continue;
    if (!/^\d+$/.test(idTransaksi)) { skippedInvalid++; continue; }
    rows.push({
      id_transaksi: idTransaksi,
      nominal: reconBriCleanNum_(reconBriCol_(row, headerIndex, 'nominal', 1)),
      id_produk: reconBriToStringId_(reconBriCol_(row, headerIndex, 'id_produk', 2)),
      time_response: reconBriToIso_(reconBriCol_(row, headerIndex, 'time_response', 3)),
      id_outlet: reconBriToStringId_(reconBriCol_(row, headerIndex, 'id_outlet', 4)),
      id_biller: reconBriToStringId_(reconBriCol_(row, headerIndex, 'id_biller', 5)),
      source_row: r + 1,
      raw_data: { id_transaksi: row[0], nominal: row[1], id_produk: row[2], time_response: row[3], id_outlet: row[4], id_biller: row[5] },
    });
  }
  if (skippedInvalid > 0) {
    Logger.log('WARNING: ' + skippedInvalid + ' baris DATA FP dilewati (id_transaksi bukan angka murni).');
  }
  return rows;
}

/**
 * Sheet "DATA BRI": header baris 1 (dibaca by NAME, fallback ke index
 * A-R), data mulai baris 2. Kolom: ID, NOREK, TGL_TRAN, TGL_EFEKTIF,
 * JAM_TRAN, SEQ, DESK_TRAN, SALDO_AWAL_MUTASI, MUTASI_DEBET, MUTASI_KREDIT,
 * SALDO_AKHIR_MUTASI, GLSIGN, TRUSER, KODE_TRAN, KODE_TRAN_TELLER, TRREMK,
 * TLBDS1, TLBDS2.
 * Ekstraksi id transaksi (DESK_TRAN/TRREMK/TLBDS2), klasifikasi bank_row_type,
 * & validasi saldo TIDAK dilakukan di sini — dikirim apa adanya, seluruh
 * logic bisnis ada di backend (briAdapter.js) supaya satu sumber kebenaran.
 */
function reconBriReadBank_(ss) {
  const sheet = ss.getSheetByName(RECON_BRI_SHEET_BANK);
  if (!sheet) throw new Error('Sheet "' + RECON_BRI_SHEET_BANK + '" tidak ditemukan.');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headerIndex = reconBriHeaderIndex_(values[0]);

  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const deskTran = String(reconBriCol_(row, headerIndex, 'desk_tran', 6) || '').trim();
    const trremk = String(reconBriCol_(row, headerIndex, 'trremk', 15) || '').trim();
    const debit = reconBriCleanNum_(reconBriCol_(row, headerIndex, 'mutasi_debet', 8));
    const credit = reconBriCleanNum_(reconBriCol_(row, headerIndex, 'mutasi_kredit', 9));
    if (!deskTran && !trremk && debit === null && credit === null) continue; // baris kosong

    rows.push({
      norek: reconBriToStringId_(reconBriCol_(row, headerIndex, 'norek', 1)),
      tgl_tran: reconBriToIso_(reconBriCol_(row, headerIndex, 'tgl_tran', 2)),
      tgl_efektif: reconBriToIso_(reconBriCol_(row, headerIndex, 'tgl_efektif', 3)),
      jam_tran: reconBriToStringId_(reconBriCol_(row, headerIndex, 'jam_tran', 4)),
      seq: reconBriToStringId_(reconBriCol_(row, headerIndex, 'seq', 5)),
      desk_tran: deskTran || null,
      saldo_awal_mutasi: reconBriCleanNum_(reconBriCol_(row, headerIndex, 'saldo_awal_mutasi', 7)),
      mutasi_debet: debit,
      mutasi_kredit: credit,
      saldo_akhir_mutasi: reconBriCleanNum_(reconBriCol_(row, headerIndex, 'saldo_akhir_mutasi', 10)),
      glsign: reconBriToStringId_(reconBriCol_(row, headerIndex, 'glsign', 11)),
      truser: reconBriToStringId_(reconBriCol_(row, headerIndex, 'truser', 12)),
      kode_tran: reconBriToStringId_(reconBriCol_(row, headerIndex, 'kode_tran', 13)),
      kode_tran_teller: reconBriToStringId_(reconBriCol_(row, headerIndex, 'kode_tran_teller', 14)),
      trremk: trremk || null,
      tlbds1: String(reconBriCol_(row, headerIndex, 'tlbds1', 16) || '').trim() || null,
      tlbds2: String(reconBriCol_(row, headerIndex, 'tlbds2', 17) || '').trim() || null,
      source_row: r + 1,
      raw_data: {
        ID: row[0], NOREK: row[1], TGL_TRAN: row[2], TGL_EFEKTIF: row[3], JAM_TRAN: row[4], SEQ: row[5],
        DESK_TRAN: row[6], SALDO_AWAL_MUTASI: row[7], MUTASI_DEBET: row[8], MUTASI_KREDIT: row[9],
        SALDO_AKHIR_MUTASI: row[10], GLSIGN: row[11], TRUSER: row[12], KODE_TRAN: row[13],
        KODE_TRAN_TELLER: row[14], TRREMK: row[15], TLBDS1: row[16], TLBDS2: row[17],
      },
    });
  }
  return rows;
}

function reconBriBuildPayloadChunks_() {
  const ss = reconBriOpenSpreadsheet_();
  const fpRows = reconBriReadFp_(ss);
  const bankRows = reconBriReadBank_(ss);

  const fpChunks = [];
  for (let i = 0; i < fpRows.length; i += RECON_BRI_CHUNK_SIZE) fpChunks.push(fpRows.slice(i, i + RECON_BRI_CHUNK_SIZE));
  const bankChunks = [];
  for (let i = 0; i < bankRows.length; i += RECON_BRI_CHUNK_SIZE) bankChunks.push(bankRows.slice(i, i + RECON_BRI_CHUNK_SIZE));

  const totalChunks = Math.max(1, fpChunks.length, bankChunks.length);
  const today = new Date();
  const businessDate = Utilities.formatDate(today, 'Asia/Jakarta', 'yyyy-MM-dd');
  const accountNo = (bankRows[0] && bankRows[0].norek) || RECON_BRI_DEFAULT_ACCOUNT_NO;
  const syncedBy = (function () { try { return Session.getActiveUser().getEmail() || 'apps_script'; } catch (e) { return 'apps_script'; } })();

  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    chunks.push({
      business_date: businessDate,
      bank_code: RECON_BRI_BANK_CODE,
      spreadsheet_id: ss.getId(),
      fp_sheet_name: RECON_BRI_SHEET_FP,
      bank_sheet_name: RECON_BRI_SHEET_BANK,
      account_no: accountNo,
      config: {
        scope_mode: RECON_BRI_DEFAULT_SCOPE_MODE,
        expected_fee: RECON_BRI_DEFAULT_EXPECTED_FEE,
        grace_period_minutes: RECON_BRI_DEFAULT_GRACE_MINUTES,
        coverage_tolerance_minutes: RECON_BRI_DEFAULT_COVERAGE_TOLERANCE_MINUTES,
        reversal_lookup_days: RECON_BRI_DEFAULT_REVERSAL_LOOKUP_DAYS,
      },
      chunk_index: i,
      chunk_total: totalChunks,
      fp: fpChunks[i] || [],
      bank: bankChunks[i] || [],
      meta: { synced_by: syncedBy, synced_at: Utilities.formatDate(new Date(), 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX") },
    });
  }

  return { chunks, fpCount: fpRows.length, bankCount: bankRows.length, businessDate, accountNo };
}

/** Jalankan ini DULU — hanya membaca & melapor ke Logger, TIDAK mengirim apa pun. */
function testReconciliationBri() {
  const built = reconBriBuildPayloadChunks_();
  Logger.log('=== TEST (dry-run) Rekonsiliasi BRI ===');
  Logger.log('Business date: ' + built.businessDate);
  Logger.log('Account No (NOREK): ' + built.accountNo);
  Logger.log('FP rows: ' + built.fpCount);
  Logger.log('Bank (BRI) rows: ' + built.bankCount);
  Logger.log('Jumlah chunk: ' + built.chunks.length);
  Logger.log('Sample FP (max 3): ' + JSON.stringify(built.chunks[0].fp.slice(0, 3)));
  Logger.log('Sample Bank (max 3): ' + JSON.stringify(built.chunks[0].bank.slice(0, 3)));
  Logger.log('=== SELESAI TEST — TIDAK ADA DATA YANG DIKIRIM ===');
  return built;
}

/** Kirim seluruh data ke VPS (per chunk kalau data besar). Token & URL dari Script Properties, TIDAK di-hardcode. */
function pushReconciliationBri() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('BRIC_SYNC_TOKEN');
  const baseUrl = props.getProperty('BRIC_API_BASE_URL') || RECON_BRI_DEFAULT_BASE_URL;
  const url = baseUrl.replace(/\/+$/, '') + '/api/warroom/reconciliation/bri/sync';

  if (!token) {
    const msg = 'ERROR: Script Property BRIC_SYNC_TOKEN belum di-set. Sync dibatalkan.';
    Logger.log(msg);
    reconBriSaveStatus_({ success: false, message: msg, at: new Date().toISOString() });
    return { success: false, message: msg };
  }

  let built;
  try {
    built = reconBriBuildPayloadChunks_();
  } catch (e) {
    const msg = 'ERROR membaca sheet: ' + e.message;
    Logger.log(msg);
    reconBriSaveStatus_({ success: false, message: msg, at: new Date().toISOString() });
    return { success: false, message: msg };
  }

  Logger.log('Mengirim ' + built.fpCount + ' baris FP, ' + built.bankCount + ' baris BRI, dalam ' + built.chunks.length + ' chunk ...');

  for (let i = 0; i < built.chunks.length; i++) {
    const options = {
      method: 'POST',
      contentType: 'application/json',
      headers: { 'x-sync-token': token },
      payload: JSON.stringify(built.chunks[i]),
      muteHttpExceptions: true,
    };
    try {
      const resp = UrlFetchApp.fetch(url, options);
      const code = resp.getResponseCode();
      const text = resp.getContentText().substring(0, 500);
      Logger.log('Chunk ' + (i + 1) + '/' + built.chunks.length + ' -> HTTP ' + code + ': ' + text);
      if (code !== 200) {
        const msg = 'Sync berhenti karena chunk ' + (i + 1) + ' gagal (HTTP ' + code + '): ' + text;
        Logger.log(msg);
        reconBriSaveStatus_({ success: false, message: msg, at: new Date().toISOString(), chunk_failed: i + 1, chunk_total: built.chunks.length });
        return { success: false, message: msg, chunk_failed: i + 1, chunk_total: built.chunks.length };
      }
    } catch (e) {
      const msg = 'Error fetch pada chunk ' + (i + 1) + ': ' + e.message;
      Logger.log(msg);
      reconBriSaveStatus_({ success: false, message: msg, at: new Date().toISOString(), chunk_failed: i + 1, chunk_total: built.chunks.length });
      return { success: false, message: msg, chunk_failed: i + 1, chunk_total: built.chunks.length };
    }
  }

  const doneMsg = 'Sync selesai utk business_date ' + built.businessDate + ' (' + built.fpCount + ' FP, ' + built.bankCount + ' BRI).';
  Logger.log(doneMsg);
  const result = { success: true, message: doneMsg, business_date: built.businessDate, fp_count: built.fpCount, bank_count: built.bankCount, at: new Date().toISOString() };
  reconBriSaveStatus_(result);
  return result;
}

/** Simpan ringkasan sync terakhir (sukses/gagal) di Script Properties. */
function reconBriSaveStatus_(status) {
  try {
    PropertiesService.getScriptProperties().setProperty(RECON_BRI_LAST_STATUS_KEY, JSON.stringify(status));
  } catch (e) {
    Logger.log('Gagal menyimpan status sync: ' + e.message);
  }
}

/** Lihat ringkasan sync TERAKHIR (sukses/gagal, kapan, berapa baris) tanpa perlu buka Execution Log. */
function getReconciliationBriStatus() {
  const raw = PropertiesService.getScriptProperties().getProperty(RECON_BRI_LAST_STATUS_KEY);
  const status = raw ? JSON.parse(raw) : { message: 'Belum pernah sync.' };
  Logger.log(JSON.stringify(status, null, 2));
  return status;
}

/** Installable trigger (onChange) — HANYA menandai, TIDAK sync langsung. */
function reconBriOnChangeTrigger_(e) {
  PropertiesService.getScriptProperties().setProperty(RECON_BRI_DIRTY_FLAG_KEY, String(Date.now()));
}

/**
 * Cek tombol "Sync Now" di dashboard — Web App Apps Script TIDAK BISA
 * dipanggil langsung dari browser (kebijakan Google Workspace), jadi tombol
 * itu hanya mencatat permintaan di database BRIC (recon_sync_requests).
 * Panggilan KELUAR dari Apps Script ke backend (arah ini) selalu boleh.
 * TIDAK PERNAH melempar error ke pemanggil — kalau gagal cek, anggap saja
 * tidak ada permintaan (fallback ke jadwal normal).
 */
function reconBriCheckForceSyncRequested_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('BRIC_SYNC_TOKEN');
    const baseUrl = props.getProperty('BRIC_API_BASE_URL') || RECON_BRI_DEFAULT_BASE_URL;
    const statusUrl = baseUrl.replace(/\/+$/, '') + '/api/warroom/reconciliation/sync-request-status?bank_code=' + RECON_BRI_BANK_CODE;
    const resp = UrlFetchApp.fetch(statusUrl, { headers: { 'x-sync-token': token }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return false;
    return !!JSON.parse(resp.getContentText()).pending;
  } catch (e) {
    Logger.log('WARNING: gagal cek status tombol Sync Now: ' + e.message);
    return false;
  }
}

/**
 * Dipanggil time-based trigger tiap 1 menit. Sync jalan kalau: ada
 * perubahan (dirty flag) DAN sudah lewat masa tunggu sejak edit terakhir,
 * ATAU ada permintaan "Sync Now" dari dashboard (skip debounce) — DAN tidak
 * ada sync lain yang sedang berjalan (lock).
 */
function checkReconciliationBriChanges() {
  const props = PropertiesService.getScriptProperties();
  const dirtySince = Number(props.getProperty(RECON_BRI_DIRTY_FLAG_KEY) || 0);
  const forceRequested = reconBriCheckForceSyncRequested_();
  if (!dirtySince && !forceRequested) return; // tidak ada perubahan & tidak ada permintaan manual

  if (!forceRequested && Date.now() - dirtySince < RECON_BRI_DEBOUNCE_MS) return; // masih dalam masa tunggu

  if (props.getProperty(RECON_BRI_SYNC_LOCK_KEY) === 'true') {
    Logger.log('Sync BRI sebelumnya masih berjalan, lewati siklus ini.');
    return;
  }

  props.setProperty(RECON_BRI_SYNC_LOCK_KEY, 'true');
  try {
    // Hapus dirty flag SEBELUM push — kalau ada edit baru masuk selagi sync
    // berjalan, flag akan otomatis ke-set ulang oleh reconBriOnChangeTrigger_
    // dan tertangkap di siklus berikutnya (bukan hilang begitu saja).
    props.deleteProperty(RECON_BRI_DIRTY_FLAG_KEY);
    if (forceRequested) Logger.log('Sync BRI dipicu oleh tombol "Sync Now" di dashboard.');
    pushReconciliationBri();
  } finally {
    props.deleteProperty(RECON_BRI_SYNC_LOCK_KEY);
  }
}

/** Pasang trigger auto-sync reaktif (onChange + pengecekan tiap 1 menit). */
function setupReconciliationBriTrigger() {
  removeReconciliationBriTrigger();
  const ss = reconBriOpenSpreadsheet_();
  ScriptApp.newTrigger('reconBriOnChangeTrigger_').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('checkReconciliationBriChanges')
    .timeBased()
    .everyMinutes(RECON_BRI_CHECK_INTERVAL_MINUTES)
    .create();
  Logger.log('Trigger dipasang: sync otomatis berjalan ~' + (RECON_BRI_DEBOUNCE_MS / 1000) +
    ' detik setelah ada perubahan di Sheet (dicek tiap ' + RECON_BRI_CHECK_INTERVAL_MINUTES + ' menit).');
}

function removeReconciliationBriTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'reconBriOnChangeTrigger_' || fn === 'checkReconciliationBriChanges' || fn === 'pushReconciliationBri') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Trigger lama dihapus: ' + fn);
    }
  });
}
