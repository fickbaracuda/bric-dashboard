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
//   6. Jalankan setupReconciliationMandiriTrigger() untuk sync OTOMATIS
//      REAKTIF — jalan ~30-90 detik setelah ada perubahan apa pun di Sheet
//      (bukan menunggu interval tetap). removeReconciliationMandiriTrigger()
//      untuk stop.
//   7. getReconciliationMandiriStatus() -> lihat ringkasan sync terakhir.
// ═══════════════════════════════════════════════════════════════════════

const RECON_MDR_SHEET_ID = '1iGDzKsoDdcaL2Hfk2_q1y0N50KEMm2c6auaT9DhKPFc';
const RECON_MDR_SHEET_FP = 'DATA FP';
const RECON_MDR_SHEET_BANK = 'DATA Mandiri';
const RECON_MDR_DEFAULT_BASE_URL = 'https://bmsretail.my.id';
const RECON_MDR_BANK_CODE = 'MANDIRI';
const RECON_MDR_CHUNK_SIZE = 1500;
const RECON_MDR_LAST_STATUS_KEY = 'RECON_MDR_LAST_STATUS';

// Auto-sync REAKTIF (bukan interval tetap) — pola sama dengan Rekonsiliasi
// OCBC (lihat apps-script-reconciliation-ocbc.js). SENGAJA TIDAK sync
// langsung di setiap event onChange — kalau tim mengetik/paste beruntun,
// itu bisa memicu banyak sync tumpang tindih dalam hitungan detik (saling
// menghapus/menulis ulang batch yang sama) dan cepat menghabiskan kuota
// harian Apps Script. Polanya 2 lapis:
//   1. onChange (installable trigger) HANYA menandai "ada perubahan" (flag
//      timestamp di Script Properties) — sangat ringan, hampir tanpa kuota.
//   2. Time-based trigger tiap 1 menit MENGECEK flag itu — baru benar-benar
//      menjalankan pushReconciliationMandiri() kalau sudah lewat masa tunggu
//      (debounce) sejak edit TERAKHIR, dan tidak ada sync lain yang sedang
//      berjalan (lock). Hasil: data ter-update otomatis ~30-90 detik setelah
//      perubahan terakhir di Sheet.
const RECON_MDR_DIRTY_FLAG_KEY = 'RECON_MDR_DIRTY_SINCE';
const RECON_MDR_SYNC_LOCK_KEY = 'RECON_MDR_SYNC_IN_PROGRESS';
const RECON_MDR_DEBOUNCE_MS = 30 * 1000; // tunggu 30 detik sejak edit terakhir sebelum sync
const RECON_MDR_CHECK_INTERVAL_MINUTES = 1;

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
 * PostDate Mandiri: Google Sheets kadang salah menafsir teks tanggal hasil
 * paste dari export bank sebagai MM/DD alih-alih DD/MM (atau sebaliknya),
 * tergantung locale spreadsheet — begitu ter-parse jadi Date object oleh
 * Sheets, teks aslinya sudah TIDAK BISA direkonstruksi lagi (insiden nyata:
 * PostDate muncul sebagai Oktober padahal transaksinya Juli, berdekatan
 * dengan tanggal DATA FP yang benar).
 *
 * Guard yang AMAN (tidak menyentuh tanggal yang sudah benar): mutasi bank
 * yang SUDAH SETTLE mustahil bertanggal MASA DEPAN. Kalau hasil parse
 * Sheets ternyata di masa depan DAN hari<=12 (sehingga pertukaran hari<->
 * bulan menghasilkan tanggal valid DAN tidak lagi di masa depan), tukar
 * hari<->bulan. Kalau tidak memenuhi syarat itu, dikirim apa adanya (lebih
 * baik salah tanggal yang sudah ada daripada menebak salah arah).
 *
 * TIDAK log per-baris (bisa ribuan baris tiap sync tiap 5 menit — beresiko
 * memenuhi kuota Execution Log). Caller (reconMdrReadBank_) mengumpulkan
 * status.corrected/status.uncorrectable dan melaporkan SATU baris ringkasan
 * di akhir lewat reconMdrLogPostDateSummary_().
 */
function reconMdrFixPostDateSwap_(dateObj) {
  if (!(Object.prototype.toString.call(dateObj) === '[object Date]' && !isNaN(dateObj))) {
    return { value: dateObj, status: 'unchanged' };
  }
  const now = new Date();
  if (dateObj.getTime() <= now.getTime()) return { value: dateObj, status: 'unchanged' }; // bukan masa depan -> tidak perlu dikoreksi

  const parts = Utilities.formatDate(dateObj, 'Asia/Jakarta', 'yyyy,MM,dd,HH,mm,ss').split(',');
  const y = parts[0], mo = Number(parts[1]), d = Number(parts[2]), h = parts[3], mi = parts[4], s = parts[5];
  if (d > 12) {
    return { value: dateObj, status: 'uncorrectable' };
  }
  const swapped = new Date(y + '-' + String(d).padStart(2, '0') + '-' + String(mo).padStart(2, '0') + 'T' + h + ':' + mi + ':' + s + '+07:00');
  if (isNaN(swapped) || swapped.getTime() > now.getTime()) {
    return { value: dateObj, status: 'uncorrectable' };
  }
  return { value: swapped, status: 'corrected' };
}

/** Satu baris ringkasan di Execution Log, bukan satu baris per row yang dikoreksi. */
function reconMdrLogPostDateSummary_(stats) {
  if (stats.corrected > 0) {
    Logger.log('INFO: ' + stats.corrected + ' PostDate dikoreksi (hari/bulan tertukar akibat locale sheet, mutasi bank tidak mungkin bertanggal masa depan).');
  }
  if (stats.uncorrectable > 0) {
    Logger.log('WARNING: ' + stats.uncorrectable + ' PostDate di masa depan TAPI tidak bisa dikoreksi otomatis (hari>12 atau hasil tukar tetap tidak valid). Cek manual sheet DATA Mandiri (lihat source_row di raw_data).');
  }
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
  const postDateStats = { corrected: 0, uncorrectable: 0 };
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const remarks = String(reconMdrCol_(row, headerIndex, 'remarks', 3) || '').trim();
    const additionalDesc = String(reconMdrCol_(row, headerIndex, 'additionaldesc', 4) || '').trim();
    const creditAmount = reconMdrCleanNum_(reconMdrCol_(row, headerIndex, 'credit amount', 5));
    const debitAmount = reconMdrCleanNum_(reconMdrCol_(row, headerIndex, 'debit amount', 6));
    const closeBalance = reconMdrCleanNum_(reconMdrCol_(row, headerIndex, 'close balance', 7));
    if (!remarks && !additionalDesc && creditAmount === null && debitAmount === null) continue; // baris kosong

    const rawPostDate = reconMdrCol_(row, headerIndex, 'postdate', 2);
    const postDateFix = reconMdrFixPostDateSwap_(rawPostDate);
    if (postDateFix.status === 'corrected') postDateStats.corrected++;
    else if (postDateFix.status === 'uncorrectable') postDateStats.uncorrectable++;

    rows.push({
      account_no: reconMdrToStringId_(reconMdrCol_(row, headerIndex, 'accountno', 0)),
      ccy: String(reconMdrCol_(row, headerIndex, 'ccy', 1) || '').trim() || null,
      post_date: reconMdrToIso_(postDateFix.value),
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
  reconMdrLogPostDateSummary_(postDateStats);
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

/** Installable trigger (onChange) — HANYA menandai, TIDAK sync langsung. */
function reconMdrOnChangeTrigger_(e) {
  PropertiesService.getScriptProperties().setProperty(RECON_MDR_DIRTY_FLAG_KEY, String(Date.now()));
}

/**
 * Cek tombol "Sync Now" di dashboard — Web App Apps Script TIDAK BISA
 * dipanggil langsung dari browser (kebijakan Google Workspace), jadi
 * tombol itu hanya mencatat permintaan di database BRIC. Panggilan KELUAR
 * dari Apps Script ke backend (arah ini) selalu boleh, tidak kena
 * pembatasan yang sama. TIDAK PERNAH melempar error ke pemanggil — kalau
 * gagal cek, anggap saja tidak ada permintaan (fallback ke jadwal normal).
 */
function reconMdrCheckForceSyncRequested_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('BRIC_SYNC_TOKEN');
    const baseUrl = props.getProperty('BRIC_API_BASE_URL') || RECON_MDR_DEFAULT_BASE_URL;
    const statusUrl = baseUrl.replace(/\/+$/, '') + '/api/warroom/reconciliation/sync-request-status?bank_code=' + RECON_MDR_BANK_CODE;
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
 * tidak ada sync lain yang sedang berjalan (lock).
 */
function checkAndSyncIfDirtyReconciliationMandiri() {
  const props = PropertiesService.getScriptProperties();
  const dirtySince = Number(props.getProperty(RECON_MDR_DIRTY_FLAG_KEY) || 0);
  const forceRequested = reconMdrCheckForceSyncRequested_();
  if (!dirtySince && !forceRequested) return; // tidak ada perubahan & tidak ada permintaan manual

  if (!forceRequested && Date.now() - dirtySince < RECON_MDR_DEBOUNCE_MS) return; // masih dalam masa tunggu, tim mungkin masih input

  if (props.getProperty(RECON_MDR_SYNC_LOCK_KEY) === 'true') {
    Logger.log('Sync Mandiri sebelumnya masih berjalan, lewati siklus ini.');
    return;
  }

  props.setProperty(RECON_MDR_SYNC_LOCK_KEY, 'true');
  try {
    // Hapus dirty flag SEBELUM push — kalau ada edit baru masuk selagi sync
    // berjalan, flag akan otomatis ke-set ulang oleh reconMdrOnChangeTrigger_
    // dan tertangkap di siklus berikutnya (bukan hilang begitu saja).
    props.deleteProperty(RECON_MDR_DIRTY_FLAG_KEY);
    if (forceRequested) Logger.log('Sync Mandiri dipicu oleh tombol "Sync Now" di dashboard.');
    pushReconciliationMandiri();
  } finally {
    props.deleteProperty(RECON_MDR_SYNC_LOCK_KEY);
  }
}

/** Pasang trigger auto-sync reaktif (onChange + pengecekan tiap 1 menit). */
function setupReconciliationMandiriTrigger() {
  removeReconciliationMandiriTrigger();
  const ss = SpreadsheetApp.openById(RECON_MDR_SHEET_ID);
  ScriptApp.newTrigger('reconMdrOnChangeTrigger_').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('checkAndSyncIfDirtyReconciliationMandiri')
    .timeBased()
    .everyMinutes(RECON_MDR_CHECK_INTERVAL_MINUTES)
    .create();
  Logger.log('Trigger dipasang: sync otomatis berjalan ~' + (RECON_MDR_DEBOUNCE_MS / 1000) +
    ' detik setelah ada perubahan di Sheet (dicek tiap ' + RECON_MDR_CHECK_INTERVAL_MINUTES + ' menit).');
}

function removeReconciliationMandiriTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'reconMdrTriggerHandler_' || fn === 'reconMdrOnChangeTrigger_' || fn === 'checkAndSyncIfDirtyReconciliationMandiri' || fn === 'pushReconciliationMandiri') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Trigger lama dihapus: ' + fn);
    }
  });
}
