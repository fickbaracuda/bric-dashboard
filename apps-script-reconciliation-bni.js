// ═══════════════════════════════════════════════════════════════════════
// Rekonsiliasi BNI — Apps Script
// Sheet tab : "Data FP" + "Data Bank BNI" (nama sheet configurable, lihat
//             Script Property BNI_FP_SHEET_NAME / BNI_BANK_SHEET_NAME)
// Endpoint  : POST {BRIC_API_BASE_URL}/api/warroom/reconciliation/bni/sync
//             (header x-sync-token)
//
// PENTING (spec eksplisit): Apps Script ini HANYA membaca sheet,
// mempertahankan string (id_transaksi/id_produk/id_outlet/id_biller/
// Branch/Journal No./Description TIDAK PERNAH di-Number()), membersihkan
// numeric (Debit/Credit/nominal), dan mengirim raw data. Apps Script TIDAK
// PERNAH mengekstrak transaction ID, menentukan coverage, melakukan
// matching, menentukan status, mengklasifikasi funding, atau melakukan
// dedupe bisnis — SELURUH business logic ada di backend (bniAdapter.js)
// supaya hanya ada SATU sumber kebenaran. Kalau ada kebutuhan mengubah
// aturan matching, ubah di backend, BUKAN di sini.
//
// CARA PAKAI:
//   1. Buka Google Sheet spreadsheet BNI -> Extensions > Apps Script.
//   2. Tempel isi file ini sebagai file BARU.
//   3. Project Settings > Script Properties, tambahkan:
//        BRIC_SYNC_TOKEN     = <sama dengan APPS_SCRIPT_TOKEN server>
//        BRIC_API_BASE_URL   = https://bmsretail.my.id            (opsional, ini defaultnya)
//        BNI_SPREADSHEET_ID  = 1cW7SfkL8nCbWuGhOI9IVCmEzy3HN4z66FCcYDkiHtbw
//                              (opsional -- kalau kosong, pakai getActiveSpreadsheet())
//        BNI_FP_SHEET_NAME   = Data FP        (opsional, ini defaultnya)
//        BNI_BANK_SHEET_NAME = Data Bank BNI  (opsional, ini defaultnya)
//        BNI_ACCOUNT_NO      = <nomor rekening BNI, kalau ingin ditampilkan
//                              di dashboard -- file mutasi BNI TIDAK punya
//                              kolom nomor rekening, jadi HARUS diisi manual
//                              di sini. Kalau dikosongkan, dashboard
//                              menampilkan "Tidak tersedia" -- rekonsiliasi
//                              TETAP jalan normal.>
//   4. Jalankan testReconciliationBni() dulu (Logger.log, TIDAK mengirim
//      apa pun) — cek jumlah baris FP/Bank terbaca benar.
//   5. Kalau sudah OK, jalankan pushReconciliationBni() untuk sync manual.
//   6. Jalankan setupReconciliationBniTrigger() untuk sync OTOMATIS REAKTIF
//      — jalan ~30-90 detik setelah ada perubahan apa pun di Sheet (bukan
//      menunggu interval tetap). removeReconciliationBniTrigger() utk stop.
//   7. getReconciliationBniStatus() -> lihat ringkasan sync terakhir.
// ═══════════════════════════════════════════════════════════════════════

const RECON_BNI_DEFAULT_FP_SHEET = 'Data FP';
const RECON_BNI_DEFAULT_BANK_SHEET = 'Data Bank BNI';
const RECON_BNI_DEFAULT_BASE_URL = 'https://bmsretail.my.id';
const RECON_BNI_BANK_CODE = 'BNI';
const RECON_BNI_CHUNK_SIZE = 1500;
const RECON_BNI_LAST_STATUS_KEY = 'RECON_BNI_LAST_STATUS';

// Auto-sync REAKTIF (bukan interval tetap) — pola SAMA dgn Rekonsiliasi
// Mandiri/BRI/BRI BI-FAST:
//   1. onChange (installable trigger) HANYA menandai "ada perubahan".
//   2. Time-based trigger tiap 1 menit MENGECEK flag itu — baru benar-benar
//      sync kalau sudah lewat masa tunggu (debounce) sejak edit TERAKHIR,
//      dan tidak ada sync lain yang sedang berjalan (LockService).
//   3. Sync Now (tombol dashboard) memakai endpoint generic request-sync,
//      dicek di sini via reconBniCheckForceSyncRequested_().
const RECON_BNI_DIRTY_FLAG_KEY = 'RECON_BNI_DIRTY_SINCE';
const RECON_BNI_SYNC_LOCK_NAME = 'RECON_BNI_SYNC_IN_PROGRESS';
const RECON_BNI_DEBOUNCE_MS = 30 * 1000; // tunggu 30 detik sejak edit terakhir sebelum sync
const RECON_BNI_CHECK_INTERVAL_MINUTES = 1;

/** Ambil spreadsheet ID dari Script Property, fallback ke active spreadsheet — TIDAK PERNAH di-hardcode. */
function reconBniGetSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('BNI_SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
function reconBniFpSheetName_() {
  return PropertiesService.getScriptProperties().getProperty('BNI_FP_SHEET_NAME') || RECON_BNI_DEFAULT_FP_SHEET;
}
function reconBniBankSheetName_() {
  return PropertiesService.getScriptProperties().getProperty('BNI_BANK_SHEET_NAME') || RECON_BNI_DEFAULT_BANK_SHEET;
}
function reconBniAccountNo_() {
  const v = PropertiesService.getScriptProperties().getProperty('BNI_ACCOUNT_NO');
  return v && String(v).trim() !== '' ? String(v).trim() : null;
}

/**
 * Parser angka aman — WAJIB cek typeof number DULU (insiden Speedcash: titik
 * desimal number asli ikut terhapus kalau diproses sebagai string sebelum
 * cek tipe). Direplikasi persis di semua Apps Script baru. Menangani pola
 * BNI "300,000.00" (koma = ribuan, titik = desimal, dibuang keduanya krn
 * Rupiah tidak ada desimal bermakna).
 */
function reconBniCleanNum_(value) {
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

/**
 * Date object (Google Sheets kadang otomatis mendeteksi kolom Post
 * Date/Value Date/time_response sbg tipe Date) -> ISO string WIB eksplisit
 * ("yyyy-MM-ddTHH:mm:ss", didukung backend sbg fallback parseBniDateTime()).
 * String mentah (mis. "22/07/26 08.39.01") dikirim APA ADANYA — backend
 * mem-parsing format asli BNI sendiri (parseBniDateTime, TIDAK pernah pakai
 * Date.parse native). Salah satu dari dua jalur ini SELALU aman, tergantung
 * apakah Sheets kebetulan mem-parsing sel itu jadi Date object atau tidak.
 */
function reconBniToIso_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ss");
  }
  return String(value).trim();
}

/**
 * id_transaksi/id_produk/id_outlet/id_biller/Branch/Journal No. WAJIB
 * string murni — jangan biarkan Apps Script membaca sbg Number (leading
 * zero atau presisi digit besar bisa hilang).
 */
function reconBniToStringId_(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(value).trim();
  }
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** Map NAMA KOLOM (trim, lowercase) -> index kolom (0-based), dari baris header. */
function reconBniHeaderIndex_(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h || '').trim().toLowerCase();
    if (key) map[key] = i;
  });
  return map;
}
function reconBniCol_(row, headerIndex, name, fallbackIndex) {
  const key = String(name).trim().toLowerCase();
  const idx = Object.prototype.hasOwnProperty.call(headerIndex, key) ? headerIndex[key] : fallbackIndex;
  return idx === undefined || idx === null ? undefined : row[idx];
}

/**
 * Sheet "Data FP": header baris 1 (dibaca by NAME, fallback ke index A:F),
 * data mulai baris 2. id_transaksi, nominal, id_produk, time_response,
 * id_outlet, id_biller. id_biller TIDAK difilter di sini (spec: filter
 * id_biller='141' dilakukan BACKEND, bukan Apps Script) — SEMUA baris
 * dikirim apa adanya.
 */
function reconBniReadFp_() {
  const ss = reconBniGetSpreadsheet_();
  const sheetName = reconBniFpSheetName_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet "' + sheetName + '" tidak ditemukan.');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headerIndex = reconBniHeaderIndex_(values[0]);

  const rows = [];
  let skippedInvalid = 0;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const idTransaksi = reconBniToStringId_(reconBniCol_(row, headerIndex, 'id_transaksi', 0));
    if (!idTransaksi) continue;
    if (!/^\d+$/.test(idTransaksi)) { skippedInvalid++; continue; } // baris sampah/header ke-paste
    rows.push({
      id_transaksi: idTransaksi,
      nominal: reconBniCleanNum_(reconBniCol_(row, headerIndex, 'nominal', 1)),
      id_produk: reconBniToStringId_(reconBniCol_(row, headerIndex, 'id_produk', 2)),
      time_response: reconBniToIso_(reconBniCol_(row, headerIndex, 'time_response', 3)),
      id_outlet: reconBniToStringId_(reconBniCol_(row, headerIndex, 'id_outlet', 4)),
      id_biller: reconBniToStringId_(reconBniCol_(row, headerIndex, 'id_biller', 5)),
      source_row: r + 1,
      raw_data: { id_transaksi: row[0], nominal: row[1], id_produk: row[2], time_response: row[3], id_outlet: row[4], id_biller: row[5] },
    });
  }
  if (skippedInvalid > 0) {
    Logger.log('WARNING: ' + skippedInvalid + ' baris Data FP dilewati (id_transaksi bukan angka murni).');
  }
  return rows;
}

/**
 * Sheet "Data Bank BNI": header baris 1 (dibaca by NAME, fallback ke index
 * A:G), data mulai baris 2. Post Date, Value Date, Branch, Journal No.,
 * Description, Debit, Credit. Ekstraksi transaction ID/beneficiary
 * account/recipient name/klasifikasi TIDAK dilakukan di sini — Description
 * dikirim MENTAH apa adanya, SELURUH parsing terjadi di backend
 * (bniAdapter.js).
 */
function reconBniReadBank_() {
  const ss = reconBniGetSpreadsheet_();
  const sheetName = reconBniBankSheetName_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet "' + sheetName + '" tidak ditemukan.');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headerIndex = reconBniHeaderIndex_(values[0]);

  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const description = String(reconBniCol_(row, headerIndex, 'description', 4) || '').trim();
    const debit = reconBniCleanNum_(reconBniCol_(row, headerIndex, 'debit', 5));
    const credit = reconBniCleanNum_(reconBniCol_(row, headerIndex, 'credit', 6));
    const postDate = reconBniCol_(row, headerIndex, 'post date', 0);
    if (!description && debit === null && credit === null && !postDate) continue; // baris kosong

    rows.push({
      post_date: reconBniToIso_(postDate),
      value_date: reconBniToIso_(reconBniCol_(row, headerIndex, 'value date', 1)),
      branch: reconBniToStringId_(reconBniCol_(row, headerIndex, 'branch', 2)),
      journal_no: reconBniToStringId_(reconBniCol_(row, headerIndex, 'journal no.', 3)),
      description: description || null,
      debit: debit,
      credit: credit,
      source_row: r + 1,
      raw_data: {
        'Post Date': row[0], 'Value Date': row[1], Branch: row[2], 'Journal No.': row[3],
        Description: row[4], Debit: row[5], Credit: row[6],
      },
    });
  }
  return rows;
}

function reconBniBuildPayloadChunks_() {
  const fpRows = reconBniReadFp_();
  const bankRows = reconBniReadBank_();

  const fpChunks = [];
  for (let i = 0; i < fpRows.length; i += RECON_BNI_CHUNK_SIZE) fpChunks.push(fpRows.slice(i, i + RECON_BNI_CHUNK_SIZE));
  const bankChunks = [];
  for (let i = 0; i < bankRows.length; i += RECON_BNI_CHUNK_SIZE) bankChunks.push(bankRows.slice(i, i + RECON_BNI_CHUNK_SIZE));

  const totalChunks = Math.max(1, fpChunks.length, bankChunks.length);
  const today = new Date();
  const businessDate = Utilities.formatDate(today, 'Asia/Jakarta', 'yyyy-MM-dd');
  const accountNo = reconBniAccountNo_(); // NULL kalau belum dikonfigurasi -- TIDAK menggagalkan rekonsiliasi
  const syncedBy = (function () { try { return Session.getActiveUser().getEmail() || 'apps_script'; } catch (e) { return 'apps_script'; } })();

  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    chunks.push({
      business_date: businessDate,
      bank_code: RECON_BNI_BANK_CODE,
      fp_sheet_name: reconBniFpSheetName_(),
      bank_sheet_name: reconBniBankSheetName_(),
      account_no: accountNo,
      config: { scope_mode: 'FP_COVERAGE_WINDOW' }, // expected_fee/grace/toleransi lain pakai default server (0/30/5/5/15/5/3 hari -- configurable per batch di backend, TIDAK di-hardcode berulang di sini)
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
function testReconciliationBni() {
  const built = reconBniBuildPayloadChunks_();
  Logger.log('=== TEST (dry-run) Rekonsiliasi BNI ===');
  Logger.log('Business date: ' + built.businessDate);
  Logger.log('Account No (BNI_ACCOUNT_NO): ' + (built.accountNo || '(belum dikonfigurasi -- dashboard akan tampilkan "Tidak tersedia")'));
  Logger.log('FP rows: ' + built.fpCount);
  Logger.log('Bank (BNI) rows: ' + built.bankCount);
  Logger.log('Jumlah chunk: ' + built.chunks.length);
  Logger.log('Sample FP (max 3): ' + JSON.stringify(built.chunks[0].fp.slice(0, 3)));
  Logger.log('Sample Bank (max 3): ' + JSON.stringify(built.chunks[0].bank.slice(0, 3)));
  Logger.log('=== SELESAI TEST — TIDAK ADA DATA YANG DIKIRIM ===');
  return built;
}

/** Kirim seluruh data ke VPS (per chunk kalau data besar). Token & URL dari Script Properties, TIDAK di-hardcode. */
function pushReconciliationBni() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('BRIC_SYNC_TOKEN');
  const baseUrl = props.getProperty('BRIC_API_BASE_URL') || RECON_BNI_DEFAULT_BASE_URL;
  const url = baseUrl.replace(/\/+$/, '') + '/api/warroom/reconciliation/bni/sync';

  if (!token) {
    const msg = 'ERROR: Script Property BRIC_SYNC_TOKEN belum di-set. Sync dibatalkan.';
    Logger.log(msg);
    reconBniSaveStatus_({ success: false, message: msg, at: new Date().toISOString() });
    return { success: false, message: msg };
  }

  let built;
  try {
    built = reconBniBuildPayloadChunks_();
  } catch (e) {
    const msg = 'ERROR membaca sheet: ' + e.message;
    Logger.log(msg);
    reconBniSaveStatus_({ success: false, message: msg, at: new Date().toISOString() });
    return { success: false, message: msg };
  }

  Logger.log('Mengirim ' + built.fpCount + ' baris FP, ' + built.bankCount + ' baris BNI, dalam ' + built.chunks.length + ' chunk ...');

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
        reconBniSaveStatus_({ success: false, message: msg, at: new Date().toISOString(), chunk_failed: i + 1, chunk_total: built.chunks.length });
        return { success: false, message: msg, chunk_failed: i + 1, chunk_total: built.chunks.length };
      }
    } catch (e) {
      const msg = 'Error fetch pada chunk ' + (i + 1) + ': ' + e.message;
      Logger.log(msg);
      reconBniSaveStatus_({ success: false, message: msg, at: new Date().toISOString(), chunk_failed: i + 1, chunk_total: built.chunks.length });
      return { success: false, message: msg, chunk_failed: i + 1, chunk_total: built.chunks.length };
    }
  }

  const doneMsg = 'Sync selesai untuk business_date ' + built.businessDate + ' (' + built.fpCount + ' FP, ' + built.bankCount + ' BNI).';
  Logger.log(doneMsg);
  const result = { success: true, message: doneMsg, business_date: built.businessDate, fp_count: built.fpCount, bank_count: built.bankCount, at: new Date().toISOString() };
  reconBniSaveStatus_(result);
  return result;
}

/** Simpan ringkasan sync terakhir (sukses/gagal) di Script Properties. */
function reconBniSaveStatus_(status) {
  try {
    PropertiesService.getScriptProperties().setProperty(RECON_BNI_LAST_STATUS_KEY, JSON.stringify(status));
  } catch (e) {
    Logger.log('Gagal menyimpan status sync: ' + e.message);
  }
}

/** Lihat ringkasan sync TERAKHIR (sukses/gagal, kapan, berapa baris) tanpa perlu buka Execution Log. */
function getReconciliationBniStatus() {
  const raw = PropertiesService.getScriptProperties().getProperty(RECON_BNI_LAST_STATUS_KEY);
  const status = raw ? JSON.parse(raw) : { message: 'Belum pernah sync.' };
  Logger.log(JSON.stringify(status, null, 2));
  return status;
}

/** Installable trigger (onChange) — HANYA menandai, TIDAK sync langsung. */
function reconBniOnChangeTrigger_(e) {
  PropertiesService.getScriptProperties().setProperty(RECON_BNI_DIRTY_FLAG_KEY, String(Date.now()));
}

/**
 * Cek tombol "Sync Now" di dashboard — Web App Apps Script TIDAK BISA
 * dipanggil langsung dari browser (kebijakan Google Workspace), jadi
 * tombol itu hanya mencatat permintaan lewat endpoint generic
 * /api/warroom/reconciliation/request-sync (bank_code=BNI). Panggilan
 * KELUAR dari Apps Script ke backend (arah ini) selalu boleh. TIDAK PERNAH
 * melempar error ke pemanggil — kalau gagal cek, anggap tidak ada permintaan.
 */
function reconBniCheckForceSyncRequested_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('BRIC_SYNC_TOKEN');
    const baseUrl = props.getProperty('BRIC_API_BASE_URL') || RECON_BNI_DEFAULT_BASE_URL;
    const statusUrl = baseUrl.replace(/\/+$/, '') + '/api/warroom/reconciliation/sync-request-status?bank_code=' + RECON_BNI_BANK_CODE;
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
 * ATAU ada permintaan "Sync Now" dari dashboard (skip debounce) — DAN
 * tidak ada sync lain yang sedang berjalan. Pakai LockService (spec
 * eksplisit) supaya 2 eksekusi trigger yang kebetulan overlap TIDAK PERNAH
 * sync bersamaan.
 */
function checkReconciliationBniChanges() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Sync BNI sebelumnya masih berjalan (lock), lewati siklus ini.');
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    const dirtySince = Number(props.getProperty(RECON_BNI_DIRTY_FLAG_KEY) || 0);
    const forceRequested = reconBniCheckForceSyncRequested_();
    if (!dirtySince && !forceRequested) return; // tidak ada perubahan & tidak ada permintaan manual
    if (!forceRequested && Date.now() - dirtySince < RECON_BNI_DEBOUNCE_MS) return; // masih dalam masa tunggu

    // Hapus dirty flag SEBELUM push — kalau ada edit baru masuk selagi sync
    // berjalan, flag akan otomatis ke-set ulang oleh reconBniOnChangeTrigger_
    // dan tertangkap di siklus berikutnya (bukan hilang begitu saja).
    props.deleteProperty(RECON_BNI_DIRTY_FLAG_KEY);
    if (forceRequested) Logger.log('Sync BNI dipicu oleh tombol "Sync Now" di dashboard.');
    pushReconciliationBni();
  } finally {
    lock.releaseLock();
  }
}

/** Pasang trigger auto-sync reaktif (onChange + pengecekan tiap 1 menit). */
function setupReconciliationBniTrigger() {
  removeReconciliationBniTrigger();
  const ss = reconBniGetSpreadsheet_();
  ScriptApp.newTrigger('reconBniOnChangeTrigger_').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('checkReconciliationBniChanges')
    .timeBased()
    .everyMinutes(RECON_BNI_CHECK_INTERVAL_MINUTES)
    .create();
  Logger.log('Trigger dipasang: sync otomatis berjalan ~' + (RECON_BNI_DEBOUNCE_MS / 1000) +
    ' detik setelah ada perubahan di Sheet (dicek tiap ' + RECON_BNI_CHECK_INTERVAL_MINUTES + ' menit).');
}

function removeReconciliationBniTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'reconBniOnChangeTrigger_' || fn === 'checkReconciliationBniChanges' || fn === 'pushReconciliationBni') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Trigger lama dihapus: ' + fn);
    }
  });
}
