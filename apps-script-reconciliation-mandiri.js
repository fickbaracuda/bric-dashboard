// ═══════════════════════════════════════════════════════════════════════
// Rekonsiliasi Mandiri — Apps Script
// Sheet ID  : 1iGDzKsoDdcaL2Hfk2_q1y0N50KEMm2c6auaT9DhKPFc
// Sheet tab : "DATA FP" + "DATA Mandiri"
// Endpoint  : POST {BRIC_API_BASE_URL}/api/warroom/reconciliation/mandiri/sync
//             (header x-sync-token)
//
// CARA PAKAI:
//   1. Buka Google Sheet di atas -> Extensions > Apps Script.
//   2. Tempel isi file ini sebagai file BARU.
//   3. Project Settings > Script Properties, tambahkan:
//        BRIC_SYNC_TOKEN    = <sama dengan APPS_SCRIPT_TOKEN server>
//        BRIC_API_BASE_URL  = https://bmsretail.my.id   (opsional, ini defaultnya)
//   4. Jalankan testReconciliationMandiri() dulu (Logger.log, TIDAK
//      mengirim apa pun) — cek jumlah baris FP/Mandiri terbaca benar.
//   5. Kalau sudah OK, jalankan pushReconciliationMandiri() untuk sync manual.
//   6. Jalankan setupReconciliationMandiriTrigger() untuk sync otomatis
//      tiap 5 menit. removeReconciliationMandiriTrigger() untuk stop.
//   7. getReconciliationMandiriStatus() -> lihat ringkasan sync terakhir.
// ═══════════════════════════════════════════════════════════════════════

const RECON_MDR_SHEET_ID = '1iGDzKsoDdcaL2Hfk2_q1y0N50KEMm2c6auaT9DhKPFc';
const RECON_MDR_SHEET_FP = 'DATA FP';
const RECON_MDR_SHEET_BANK = 'DATA Mandiri';
const RECON_MDR_DEFAULT_BASE_URL = 'https://bmsretail.my.id';
const RECON_MDR_BANK_CODE = 'MANDIRI';
const RECON_MDR_CHUNK_SIZE = 1500;
const RECON_MDR_LAST_STATUS_KEY = 'RECON_MDR_LAST_STATUS';

/**
 * Parser angka aman — WAJIB cek typeof number DULU (insiden Speedcash: titik
 * desimal number asli ikut terhapus kalau diproses sebagai string sebelum
 * cek tipe). Direplikasi persis di semua Apps Script baru.
 */
function reconMdrCleanNum_(value) {
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
function reconMdrToIso_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ss");
  }
  return String(value).trim();
}

/** id_transaksi/AccountNo/id_outlet/id_biller WAJIB string murni, jangan biarkan Apps Script membaca sebagai Number (presisi digit besar bisa hilang). */
function reconMdrToStringId_(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    // getValues() bisa mengembalikan angka murni utk sel yang di-format sbg
    // Number di sheet -> convert balik ke string TANPA notasi ilmiah/desimal.
    return Number.isInteger(value) ? String(value) : String(value).trim();
  }
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * Ambil { headerIndex } dari baris 1 sebuah sheet: map NAMA KOLOM (trim,
 * lowercase) -> index kolom (0-based). Dipakai supaya urutan kolom di sheet
 * tidak wajib persis A-F/A-H — asalkan nama header sesuai spek.
 */
function reconMdrHeaderIndex_(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h || '').trim().toLowerCase();
    if (key) map[key] = i;
  });
  return map;
}
function reconMdrCol_(row, headerIndex, name, fallbackIndex) {
  const key = String(name).trim().toLowerCase();
  const idx = Object.prototype.hasOwnProperty.call(headerIndex, key) ? headerIndex[key] : fallbackIndex;
  return idx === undefined || idx === null ? undefined : row[idx];
}

/**
 * Sheet "DATA FP": header baris 1 (dibaca by NAME, fallback ke index A-F
 * kalau nama tidak ditemukan), data mulai baris 2.
 * id_transaksi, nominal, id_produk, time_response, id_outlet, id_biller.
 */
function reconMdrReadFp_() {
  const ss = SpreadsheetApp.openById(RECON_MDR_SHEET_ID);
  const sheet = ss.getSheetByName(RECON_MDR_SHEET_FP);
  if (!sheet) throw new Error('Sheet "' + RECON_MDR_SHEET_FP + '" tidak ditemukan.');

  const values = sheet.getDataRange().getValues(); // getValues() = read-only, TIDAK mengubah sheet asli
  if (values.length < 2) return [];
  const headerIndex = reconMdrHeaderIndex_(values[0]);

  const rows = [];
  let skippedInvalid = 0;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const idTransaksi = reconMdrToStringId_(reconMdrCol_(row, headerIndex, 'id_transaksi', 0));
    if (!idTransaksi) continue;
    if (!/^\d+$/.test(idTransaksi)) { skippedInvalid++; continue; } // guard sama seperti OCBC: baris sampah/header ke-paste
    rows.push({
      id_transaksi: idTransaksi,
      nominal: reconMdrCleanNum_(reconMdrCol_(row, headerIndex, 'nominal', 1)),
      id_produk: reconMdrToStringId_(reconMdrCol_(row, headerIndex, 'id_produk', 2)),
      time_response: reconMdrToIso_(reconMdrCol_(row, headerIndex, 'time_response', 3)),
      id_outlet: reconMdrToStringId_(reconMdrCol_(row, headerIndex, 'id_outlet', 4)),
      id_biller: reconMdrToStringId_(reconMdrCol_(row, headerIndex, 'id_biller', 5)),
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
 * Sheet "DATA Mandiri": header baris 1 (dibaca by NAME, fallback ke index
 * A-H), data mulai baris 2. AccountNo, Ccy, PostDate, Remarks,
 * AdditionalDesc, "Credit Amount", "Debit Amount", "Close Balance".
 * Ekstraksi id_transaksi TIDAK dilakukan di sini — dikirim apa adanya
 * (Remarks/AdditionalDesc mentah), parsing terjadi di backend
 * (mandiriAdapter.js) supaya logic bisnis tetap 100% di satu tempat.
 */
function reconMdrReadBank_() {
  const ss = SpreadsheetApp.openById(RECON_MDR_SHEET_ID);
  const sheet = ss.getSheetByName(RECON_MDR_SHEET_BANK);
  if (!sheet) throw new Error('Sheet "' + RECON_MDR_SHEET_BANK + '" tidak ditemukan.');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headerIndex = reconMdrHeaderIndex_(values[0]);

  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const remarks = String(reconMdrCol_(row, headerIndex, 'remarks', 3) || '').trim();
    const additionalDesc = String(reconMdrCol_(row, headerIndex, 'additionaldesc', 4) || '').trim();
    const creditAmount = reconMdrCleanNum_(reconMdrCol_(row, headerIndex, 'credit amount', 5));
    const debitAmount = reconMdrCleanNum_(reconMdrCol_(row, headerIndex, 'debit amount', 6));
    const closeBalance = reconMdrCleanNum_(reconMdrCol_(row, headerIndex, 'close balance', 7));
    if (!remarks && !additionalDesc && creditAmount === null && debitAmount === null) continue; // baris kosong

    rows.push({
      account_no: reconMdrToStringId_(reconMdrCol_(row, headerIndex, 'accountno', 0)),
      ccy: String(reconMdrCol_(row, headerIndex, 'ccy', 1) || '').trim() || null,
      post_date: reconMdrToIso_(reconMdrCol_(row, headerIndex, 'postdate', 2)),
      remarks: remarks || null,
      additional_desc: additionalDesc || null,
      credit_amount: creditAmount,
      debit_amount: debitAmount,
      close_balance: closeBalance,
      source_row: r + 1,
      raw_data: {
        AccountNo: row[0], Ccy: row[1], PostDate: row[2], Remarks: row[3],
        AdditionalDesc: row[4], CreditAmount: row[5], DebitAmount: row[6], CloseBalance: row[7],
      },
    });
  }
  return rows;
}

function reconMdrBuildPayloadChunks_() {
  const fpRows = reconMdrReadFp_();
  const bankRows = reconMdrReadBank_();

  const fpChunks = [];
  for (let i = 0; i < fpRows.length; i += RECON_MDR_CHUNK_SIZE) fpChunks.push(fpRows.slice(i, i + RECON_MDR_CHUNK_SIZE));
  const bankChunks = [];
  for (let i = 0; i < bankRows.length; i += RECON_MDR_CHUNK_SIZE) bankChunks.push(bankRows.slice(i, i + RECON_MDR_CHUNK_SIZE));

  const totalChunks = Math.max(1, fpChunks.length, bankChunks.length);
  const today = new Date();
  const businessDate = Utilities.formatDate(today, 'Asia/Jakarta', 'yyyy-MM-dd');
  const accountNo = (bankRows[0] && bankRows[0].account_no) || null;
  const syncedBy = (function () { try { return Session.getActiveUser().getEmail() || 'apps_script'; } catch (e) { return 'apps_script'; } })();

  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    chunks.push({
      business_date: businessDate,
      bank_code: RECON_MDR_BANK_CODE,
      spreadsheet_id: RECON_MDR_SHEET_ID,
      fp_sheet_name: RECON_MDR_SHEET_FP,
      bank_sheet_name: RECON_MDR_SHEET_BANK,
      account_no: accountNo,
      config: { scope_mode: 'FP_COVERAGE_WINDOW' }, // expected_fee & grace_period_minutes pakai default server (100 / 30 menit)
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
function testReconciliationMandiri() {
  const built = reconMdrBuildPayloadChunks_();
  Logger.log('=== TEST (dry-run) Rekonsiliasi Mandiri ===');
  Logger.log('Business date: ' + built.businessDate);
  Logger.log('Account No: ' + built.accountNo);
  Logger.log('FP rows: ' + built.fpCount);
  Logger.log('Bank (Mandiri) rows: ' + built.bankCount);
  Logger.log('Jumlah chunk: ' + built.chunks.length);
  Logger.log('Sample FP (max 3): ' + JSON.stringify(built.chunks[0].fp.slice(0, 3)));
  Logger.log('Sample Bank (max 3): ' + JSON.stringify(built.chunks[0].bank.slice(0, 3)));
  Logger.log('=== SELESAI TEST — TIDAK ADA DATA YANG DIKIRIM ===');
  return built;
}

/** Kirim seluruh data ke VPS (per chunk kalau data besar). Token & URL dari Script Properties, TIDAK di-hardcode. */
function pushReconciliationMandiri() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('BRIC_SYNC_TOKEN');
  const baseUrl = props.getProperty('BRIC_API_BASE_URL') || RECON_MDR_DEFAULT_BASE_URL;
  const url = baseUrl.replace(/\/+$/, '') + '/api/warroom/reconciliation/mandiri/sync';

  if (!token) {
    const msg = 'ERROR: Script Property BRIC_SYNC_TOKEN belum di-set. Sync dibatalkan.';
    Logger.log(msg);
    reconMdrSaveStatus_({ success: false, message: msg, at: new Date().toISOString() });
    return { success: false, message: msg };
  }

  let built;
  try {
    built = reconMdrBuildPayloadChunks_();
  } catch (e) {
    const msg = 'ERROR membaca sheet: ' + e.message;
    Logger.log(msg);
    reconMdrSaveStatus_({ success: false, message: msg, at: new Date().toISOString() });
    return { success: false, message: msg };
  }

  Logger.log('Mengirim ' + built.fpCount + ' baris FP, ' + built.bankCount + ' baris Mandiri, dalam ' + built.chunks.length + ' chunk ...');

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
        reconMdrSaveStatus_({ success: false, message: msg, at: new Date().toISOString(), chunk_failed: i + 1, chunk_total: built.chunks.length });
        return { success: false, message: msg, chunk_failed: i + 1, chunk_total: built.chunks.length };
      }
    } catch (e) {
      const msg = 'Error fetch pada chunk ' + (i + 1) + ': ' + e.message;
      Logger.log(msg);
      reconMdrSaveStatus_({ success: false, message: msg, at: new Date().toISOString(), chunk_failed: i + 1, chunk_total: built.chunks.length });
      return { success: false, message: msg, chunk_failed: i + 1, chunk_total: built.chunks.length };
    }
  }

  const doneMsg = 'Sync selesai untuk business_date ' + built.businessDate + ' (' + built.fpCount + ' FP, ' + built.bankCount + ' Mandiri).';
  Logger.log(doneMsg);
  const result = { success: true, message: doneMsg, business_date: built.businessDate, fp_count: built.fpCount, bank_count: built.bankCount, at: new Date().toISOString() };
  reconMdrSaveStatus_(result);
  return result;
}

/** Simpan ringkasan sync terakhir (sukses/gagal) di Script Properties. */
function reconMdrSaveStatus_(status) {
  try {
    PropertiesService.getScriptProperties().setProperty(RECON_MDR_LAST_STATUS_KEY, JSON.stringify(status));
  } catch (e) {
    Logger.log('Gagal menyimpan status sync: ' + e.message);
  }
}

/** Lihat ringkasan sync TERAKHIR (sukses/gagal, kapan, berapa baris) tanpa perlu buka Execution Log. */
function getReconciliationMandiriStatus() {
  const raw = PropertiesService.getScriptProperties().getProperty(RECON_MDR_LAST_STATUS_KEY);
  const status = raw ? JSON.parse(raw) : { message: 'Belum pernah sync.' };
  Logger.log(JSON.stringify(status, null, 2));
  return status;
}

/**
 * Pasang trigger time-based tiap 5 menit (default spek). LockService dipakai
 * DI DALAM handler trigger (bukan di sini) supaya kalau eksekusi sebelumnya
 * masih berjalan (misal data besar/lambat), eksekusi berikutnya tidak
 * tumpang tindih menulis batch yang sama.
 */
function reconMdrTriggerHandler_() {
  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(5000); // tunggu maks 5 detik utk dapat lock
  if (!gotLock) {
    Logger.log('Sync Mandiri sebelumnya masih berjalan, lewati siklus trigger ini.');
    return;
  }
  try {
    pushReconciliationMandiri();
  } finally {
    lock.releaseLock();
  }
}

function setupReconciliationMandiriTrigger() {
  removeReconciliationMandiriTrigger();
  ScriptApp.newTrigger('reconMdrTriggerHandler_')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Trigger dipasang: sync otomatis Rekonsiliasi Mandiri tiap 5 menit.');
}

function removeReconciliationMandiriTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'reconMdrTriggerHandler_' || fn === 'pushReconciliationMandiri') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Trigger lama dihapus: ' + fn);
    }
  });
}
