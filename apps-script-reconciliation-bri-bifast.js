// ═══════════════════════════════════════════════════════════════════════
// Rekonsiliasi BRI BI-FAST — Apps Script
// Sheet tab : "Data FP" + "Data Bank BRI BI Fast"
// Endpoint  : POST {BRIC_API_BASE_URL}/api/warroom/reconciliation/bri-bifast/sync
//             (header x-sync-token)
//
// PENTING (spec eksplisit): Apps Script ini HANYA membaca & mengirim data
// MENTAH. TIDAK PERNAH mengekstrak bill_info1, menentukan principal/fee,
// melakukan matching, menentukan status, atau melakukan validasi saldo —
// SELURUH business logic ada di backend (briBifastAdapter.js) supaya hanya
// ada SATU sumber kebenaran. Kalau ada kebutuhan mengubah aturan matching,
// ubah di backend, BUKAN di sini.
//
// CARA PAKAI:
//   1. Buka Google Sheet spreadsheet BRI BI-FAST -> Extensions > Apps Script.
//   2. Tempel isi file ini sebagai file BARU.
//   3. Project Settings > Script Properties, tambahkan:
//        BRIC_SYNC_TOKEN         = <sama dengan APPS_SCRIPT_TOKEN server>
//        BRIC_API_BASE_URL       = https://bmsretail.my.id   (opsional, ini defaultnya)
//        BRI_BIFAST_SPREADSHEET_ID = <ID spreadsheet ini>     (opsional — kalau
//                                     kosong, pakai SpreadsheetApp.getActiveSpreadsheet())
//   4. Jalankan testReconciliationBriBifast() dulu (Logger.log, TIDAK
//      mengirim apa pun) — cek jumlah baris FP/Bank terbaca benar.
//   5. Kalau sudah OK, jalankan pushReconciliationBriBifast() untuk sync manual.
//   6. Jalankan setupReconciliationBriBifastTrigger() untuk sync OTOMATIS
//      REAKTIF — jalan ~30-90 detik setelah ada perubahan apa pun di Sheet
//      (bukan menunggu interval tetap). removeReconciliationBriBifastTrigger()
//      untuk stop.
//   7. getReconciliationBriBifastStatus() -> lihat ringkasan sync terakhir.
// ═══════════════════════════════════════════════════════════════════════

const RECON_BF_SHEET_FP = 'Data FP';
const RECON_BF_SHEET_BANK = 'Data Bank BRI BI Fast';
const RECON_BF_DEFAULT_BASE_URL = 'https://bmsretail.my.id';
const RECON_BF_BANK_CODE = 'BRI_BIFAST';
const RECON_BF_CHUNK_SIZE = 1500;
const RECON_BF_LAST_STATUS_KEY = 'RECON_BF_LAST_STATUS';

// Auto-sync REAKTIF (bukan interval tetap) — pola SAMA dgn Rekonsiliasi
// Mandiri (lihat apps-script-reconciliation-mandiri.js), spec eksplisit
// meminta pola yang sama utk BRI BI-FAST:
//   1. onChange (installable trigger) HANYA menandai "ada perubahan".
//   2. Time-based trigger tiap 1 menit MENGECEK flag itu — baru benar-benar
//      sync kalau sudah lewat masa tunggu (debounce) sejak edit TERAKHIR,
//      dan tidak ada sync lain yang sedang berjalan (lock).
//   3. Sync Now (tombol dashboard) memakai endpoint generic request-sync,
//      dicek di sini via reconBfCheckForceSyncRequested_().
const RECON_BF_DIRTY_FLAG_KEY = 'RECON_BF_DIRTY_SINCE';
const RECON_BF_SYNC_LOCK_KEY = 'RECON_BF_SYNC_IN_PROGRESS';
const RECON_BF_DEBOUNCE_MS = 30 * 1000; // tunggu 30 detik sejak edit terakhir sebelum sync
const RECON_BF_CHECK_INTERVAL_MINUTES = 1;

/** Ambil spreadsheet ID dari Script Property, fallback ke active spreadsheet — TIDAK PERNAH di-hardcode. */
function reconBfGetSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('BRI_BIFAST_SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Parser angka aman — WAJIB cek typeof number DULU (insiden Speedcash: titik
 * desimal number asli ikut terhapus kalau diproses sebagai string sebelum
 * cek tipe). Direplikasi persis di semua Apps Script baru.
 */
function reconBfCleanNum_(value) {
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
function reconBfToIso_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ss");
  }
  return String(value).trim();
}

/**
 * id_transaksi/id_outlet/id_biller/NOREK/SEQ/JAM_TRAN/dst WAJIB string murni
 * — jangan biarkan Apps Script membaca sebagai Number (presisi digit besar
 * atau leading zero bisa hilang). SENGAJA TIDAK dipakai utk bill_info1
 * (fungsi terpisah reconBfBillInfo1ToString_ di bawah, lebih ketat).
 */
function reconBfToStringId_(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(value).trim();
  }
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * bill_info1 WAJIB TETAP STRING, leading zero WAJIB dipertahankan (spec
 * eksplisit — '0019773396' TIDAK BOLEH jadi '19773396'). Kalau Google
 * Sheets kebetulan membaca sel ini sbg Number murni (leading zero SUDAH
 * hilang di level sheet, sebelum Apps Script sempat baca), tidak ada yang
 * bisa direkonstruksi lagi di titik ini — solusi permanen adalah format
 * kolom bill_info1 di Sheet sbg "Plain Text" SEBELUM data diisi. Fungsi ini
 * hanya menjamin Apps Script sendiri TIDAK PERNAH menambah kerusakan
 * (TIDAK PERNAH Number()/parseFloat() pada value ini).
 *
 * `stats` (opsional) mengumpulkan jumlah baris yang kena kasus ini, supaya
 * caller bisa melapor SATU baris ringkasan di akhir (lihat
 * reconBfLogBillInfo1Summary_) — BUKAN satu baris Logger.log per baris data,
 * yang bisa ribuan baris tiap sync dan cepat memenuhi kuota Execution Log
 * (pola sama dgn reconMdrLogPostDateSummary_ di Rekonsiliasi Mandiri).
 */
function reconBfBillInfo1ToString_(value, stats) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (stats) stats.numberCount++;
    return String(value);
  }
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** Satu baris ringkasan di Execution Log, bukan satu baris per row yang kena. */
function reconBfLogBillInfo1Summary_(stats) {
  if (stats.numberCount > 0) {
    Logger.log('WARNING: ' + stats.numberCount + ' baris bill_info1 terbaca sbg Number (bukan Plain Text). ' +
      'Kalau beneficiary account BI-FAST memang bisa diawali angka 0, leading zero-nya SUDAH HILANG di level sel ' +
      'Sheet sebelum Apps Script sempat baca dan TIDAK BISA direkonstruksi lagi di titik ini (mengubah format kolom ' +
      'SESUDAHNYA tidak mengembalikan digit yang sudah hilang) — matching bill_info1 vs beneficiary_account akan ' +
      'gagal utk baris-baris ini. Format kolom bill_info1 sbg Plain Text SEBELUM data baru diisi/diimpor.');
  }
}

/** Map NAMA KOLOM (trim, lowercase) -> index kolom (0-based), dari baris header. */
function reconBfHeaderIndex_(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h || '').trim().toLowerCase();
    if (key) map[key] = i;
  });
  return map;
}
function reconBfCol_(row, headerIndex, name, fallbackIndex) {
  const key = String(name).trim().toLowerCase();
  const idx = Object.prototype.hasOwnProperty.call(headerIndex, key) ? headerIndex[key] : fallbackIndex;
  return idx === undefined || idx === null ? undefined : row[idx];
}

/**
 * Sheet "Data FP": header baris 1 (dibaca by NAME, fallback ke index A:G),
 * data mulai baris 2.
 * id_transaksi, bill_info1, nominal, id_produk, time_response, id_outlet, id_biller.
 * id_biller TIDAK difilter di sini (spec: filter id_biller='11096' dilakukan
 * BACKEND, bukan Apps Script) — SEMUA baris dikirim apa adanya.
 */
function reconBfReadFp_() {
  const ss = reconBfGetSpreadsheet_();
  const sheet = ss.getSheetByName(RECON_BF_SHEET_FP);
  if (!sheet) throw new Error('Sheet "' + RECON_BF_SHEET_FP + '" tidak ditemukan.');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headerIndex = reconBfHeaderIndex_(values[0]);

  const rows = [];
  let skippedInvalid = 0;
  const billInfo1Stats = { numberCount: 0 };
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const idTransaksi = reconBfToStringId_(reconBfCol_(row, headerIndex, 'id_transaksi', 0));
    if (!idTransaksi) continue;
    if (!/^\d+$/.test(idTransaksi)) { skippedInvalid++; continue; } // guard sama sprt bank lain: baris sampah/header ke-paste
    rows.push({
      id_transaksi: idTransaksi,
      bill_info1: reconBfBillInfo1ToString_(reconBfCol_(row, headerIndex, 'bill_info1', 1), billInfo1Stats),
      nominal: reconBfCleanNum_(reconBfCol_(row, headerIndex, 'nominal', 2)),
      id_produk: reconBfToStringId_(reconBfCol_(row, headerIndex, 'id_produk', 3)),
      time_response: reconBfToIso_(reconBfCol_(row, headerIndex, 'time_response', 4)),
      id_outlet: reconBfToStringId_(reconBfCol_(row, headerIndex, 'id_outlet', 5)),
      id_biller: reconBfToStringId_(reconBfCol_(row, headerIndex, 'id_biller', 6)),
      source_row: r + 1,
      raw_data: { id_transaksi: row[0], bill_info1: row[1], nominal: row[2], id_produk: row[3], time_response: row[4], id_outlet: row[5], id_biller: row[6] },
    });
  }
  if (skippedInvalid > 0) {
    Logger.log('WARNING: ' + skippedInvalid + ' baris Data FP dilewati (id_transaksi bukan angka murni).');
  }
  reconBfLogBillInfo1Summary_(billInfo1Stats);
  return rows;
}

/**
 * Sheet "Data Bank BRI BI Fast": header baris 1 (dibaca by NAME, fallback
 * ke index A:R), data mulai baris 2. Ekstraksi beneficiary account/bank
 * trace id/klasifikasi/principal/fee TIDAK dilakukan di sini — dikirim apa
 * adanya (DESK_TRAN/TRREMK/TLBDS1/TLBDS2 mentah), SELURUH parsing terjadi
 * di backend (briBifastAdapter.js).
 */
function reconBfReadBank_() {
  const ss = reconBfGetSpreadsheet_();
  const sheet = ss.getSheetByName(RECON_BF_SHEET_BANK);
  if (!sheet) throw new Error('Sheet "' + RECON_BF_SHEET_BANK + '" tidak ditemukan.');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headerIndex = reconBfHeaderIndex_(values[0]);

  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const deskTran = String(reconBfCol_(row, headerIndex, 'desk_tran', 6) || '').trim();
    const trremk = String(reconBfCol_(row, headerIndex, 'trremk', 15) || '').trim();
    const mutasiDebet = reconBfCleanNum_(reconBfCol_(row, headerIndex, 'mutasi_debet', 8));
    const mutasiKredit = reconBfCleanNum_(reconBfCol_(row, headerIndex, 'mutasi_kredit', 9));
    if (!deskTran && !trremk && mutasiDebet === null && mutasiKredit === null) continue; // baris kosong

    rows.push({
      norek: reconBfToStringId_(reconBfCol_(row, headerIndex, 'norek', 1)),
      tgl_tran: reconBfToIso_(reconBfCol_(row, headerIndex, 'tgl_tran', 2)),
      tgl_efektif: reconBfToIso_(reconBfCol_(row, headerIndex, 'tgl_efektif', 3)),
      jam_tran: reconBfToStringId_(reconBfCol_(row, headerIndex, 'jam_tran', 4)),
      seq: reconBfToStringId_(reconBfCol_(row, headerIndex, 'seq', 5)),
      desk_tran: deskTran || null,
      saldo_awal_mutasi: reconBfCleanNum_(reconBfCol_(row, headerIndex, 'saldo_awal_mutasi', 7)),
      mutasi_debet: mutasiDebet,
      mutasi_kredit: mutasiKredit,
      saldo_akhir_mutasi: reconBfCleanNum_(reconBfCol_(row, headerIndex, 'saldo_akhir_mutasi', 10)),
      glsign: reconBfToStringId_(reconBfCol_(row, headerIndex, 'glsign', 11)),
      truser: reconBfToStringId_(reconBfCol_(row, headerIndex, 'truser', 12)),
      kode_tran: reconBfToStringId_(reconBfCol_(row, headerIndex, 'kode_tran', 13)),
      kode_tran_teller: reconBfToStringId_(reconBfCol_(row, headerIndex, 'kode_tran_teller', 14)),
      trremk: trremk || null,
      tlbds1: reconBfToStringId_(reconBfCol_(row, headerIndex, 'tlbds1', 16)),
      tlbds2: reconBfToStringId_(reconBfCol_(row, headerIndex, 'tlbds2', 17)),
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

function reconBfBuildPayloadChunks_() {
  const fpRows = reconBfReadFp_();
  const bankRows = reconBfReadBank_();

  const fpChunks = [];
  for (let i = 0; i < fpRows.length; i += RECON_BF_CHUNK_SIZE) fpChunks.push(fpRows.slice(i, i + RECON_BF_CHUNK_SIZE));
  const bankChunks = [];
  for (let i = 0; i < bankRows.length; i += RECON_BF_CHUNK_SIZE) bankChunks.push(bankRows.slice(i, i + RECON_BF_CHUNK_SIZE));

  const totalChunks = Math.max(1, fpChunks.length, bankChunks.length);
  const today = new Date();
  const businessDate = Utilities.formatDate(today, 'Asia/Jakarta', 'yyyy-MM-dd');
  const accountNo = (bankRows[0] && bankRows[0].norek) || null;
  const syncedBy = (function () { try { return Session.getActiveUser().getEmail() || 'apps_script'; } catch (e) { return 'apps_script'; } })();

  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    chunks.push({
      business_date: businessDate,
      bank_code: RECON_BF_BANK_CODE,
      fp_sheet_name: RECON_BF_SHEET_FP,
      bank_sheet_name: RECON_BF_SHEET_BANK,
      account_no: accountNo,
      config: { scope_mode: 'FULL_BUSINESS_DATE' }, // expected_fee/grace/toleransi lain pakai default server (77/30/5/1440/60/3 — configurable per batch di backend, TIDAK di-hardcode berulang di sini)
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
function testReconciliationBriBifast() {
  const built = reconBfBuildPayloadChunks_();
  Logger.log('=== TEST (dry-run) Rekonsiliasi BRI BI-FAST ===');
  Logger.log('Business date: ' + built.businessDate);
  Logger.log('Account No: ' + built.accountNo);
  Logger.log('FP rows: ' + built.fpCount);
  Logger.log('Bank (BRI BI-FAST) rows: ' + built.bankCount);
  Logger.log('Jumlah chunk: ' + built.chunks.length);
  Logger.log('Sample FP (max 3): ' + JSON.stringify(built.chunks[0].fp.slice(0, 3)));
  Logger.log('Sample Bank (max 3): ' + JSON.stringify(built.chunks[0].bank.slice(0, 3)));
  Logger.log('=== SELESAI TEST — TIDAK ADA DATA YANG DIKIRIM ===');
  return built;
}

/** Kirim seluruh data ke VPS (per chunk kalau data besar). Token & URL dari Script Properties, TIDAK di-hardcode. */
function pushReconciliationBriBifast() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('BRIC_SYNC_TOKEN');
  const baseUrl = props.getProperty('BRIC_API_BASE_URL') || RECON_BF_DEFAULT_BASE_URL;
  const url = baseUrl.replace(/\/+$/, '') + '/api/warroom/reconciliation/bri-bifast/sync';

  if (!token) {
    const msg = 'ERROR: Script Property BRIC_SYNC_TOKEN belum di-set. Sync dibatalkan.';
    Logger.log(msg);
    reconBfSaveStatus_({ success: false, message: msg, at: new Date().toISOString() });
    return { success: false, message: msg };
  }

  let built;
  try {
    built = reconBfBuildPayloadChunks_();
  } catch (e) {
    const msg = 'ERROR membaca sheet: ' + e.message;
    Logger.log(msg);
    reconBfSaveStatus_({ success: false, message: msg, at: new Date().toISOString() });
    return { success: false, message: msg };
  }

  Logger.log('Mengirim ' + built.fpCount + ' baris FP, ' + built.bankCount + ' baris BRI BI-FAST, dalam ' + built.chunks.length + ' chunk ...');

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
        reconBfSaveStatus_({ success: false, message: msg, at: new Date().toISOString(), chunk_failed: i + 1, chunk_total: built.chunks.length });
        return { success: false, message: msg, chunk_failed: i + 1, chunk_total: built.chunks.length };
      }
    } catch (e) {
      const msg = 'Error fetch pada chunk ' + (i + 1) + ': ' + e.message;
      Logger.log(msg);
      reconBfSaveStatus_({ success: false, message: msg, at: new Date().toISOString(), chunk_failed: i + 1, chunk_total: built.chunks.length });
      return { success: false, message: msg, chunk_failed: i + 1, chunk_total: built.chunks.length };
    }
  }

  const doneMsg = 'Sync selesai untuk business_date ' + built.businessDate + ' (' + built.fpCount + ' FP, ' + built.bankCount + ' BRI BI-FAST).';
  Logger.log(doneMsg);
  const result = { success: true, message: doneMsg, business_date: built.businessDate, fp_count: built.fpCount, bank_count: built.bankCount, at: new Date().toISOString() };
  reconBfSaveStatus_(result);
  return result;
}

/** Simpan ringkasan sync terakhir (sukses/gagal) di Script Properties. */
function reconBfSaveStatus_(status) {
  try {
    PropertiesService.getScriptProperties().setProperty(RECON_BF_LAST_STATUS_KEY, JSON.stringify(status));
  } catch (e) {
    Logger.log('Gagal menyimpan status sync: ' + e.message);
  }
}

/** Lihat ringkasan sync TERAKHIR (sukses/gagal, kapan, berapa baris) tanpa perlu buka Execution Log. */
function getReconciliationBriBifastStatus() {
  const raw = PropertiesService.getScriptProperties().getProperty(RECON_BF_LAST_STATUS_KEY);
  const status = raw ? JSON.parse(raw) : { message: 'Belum pernah sync.' };
  Logger.log(JSON.stringify(status, null, 2));
  return status;
}

/** Installable trigger (onChange) — HANYA menandai, TIDAK sync langsung. */
function reconBfOnChangeTrigger_(e) {
  PropertiesService.getScriptProperties().setProperty(RECON_BF_DIRTY_FLAG_KEY, String(Date.now()));
}

/**
 * Cek tombol "Sync Now" di dashboard — Web App Apps Script TIDAK BISA
 * dipanggil langsung dari browser (kebijakan Google Workspace), jadi
 * tombol itu hanya mencatat permintaan lewat endpoint generic
 * /api/warroom/reconciliation/request-sync (bank_code=BRI_BIFAST). Panggilan
 * KELUAR dari Apps Script ke backend (arah ini) selalu boleh. TIDAK PERNAH
 * melempar error ke pemanggil — kalau gagal cek, anggap tidak ada permintaan.
 */
function reconBfCheckForceSyncRequested_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('BRIC_SYNC_TOKEN');
    const baseUrl = props.getProperty('BRIC_API_BASE_URL') || RECON_BF_DEFAULT_BASE_URL;
    const statusUrl = baseUrl.replace(/\/+$/, '') + '/api/warroom/reconciliation/sync-request-status?bank_code=' + RECON_BF_BANK_CODE;
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
function checkReconciliationBriBifastChanges() {
  const props = PropertiesService.getScriptProperties();
  const dirtySince = Number(props.getProperty(RECON_BF_DIRTY_FLAG_KEY) || 0);
  const forceRequested = reconBfCheckForceSyncRequested_();
  if (!dirtySince && !forceRequested) return; // tidak ada perubahan & tidak ada permintaan manual

  if (!forceRequested && Date.now() - dirtySince < RECON_BF_DEBOUNCE_MS) return; // masih dalam masa tunggu

  if (props.getProperty(RECON_BF_SYNC_LOCK_KEY) === 'true') {
    Logger.log('Sync BRI BI-FAST sebelumnya masih berjalan, lewati siklus ini.');
    return;
  }

  props.setProperty(RECON_BF_SYNC_LOCK_KEY, 'true');
  try {
    // Hapus dirty flag SEBELUM push — kalau ada edit baru masuk selagi sync
    // berjalan, flag akan otomatis ke-set ulang oleh reconBfOnChangeTrigger_
    // dan tertangkap di siklus berikutnya (bukan hilang begitu saja).
    props.deleteProperty(RECON_BF_DIRTY_FLAG_KEY);
    if (forceRequested) Logger.log('Sync BRI BI-FAST dipicu oleh tombol "Sync Now" di dashboard.');
    pushReconciliationBriBifast();
  } finally {
    props.deleteProperty(RECON_BF_SYNC_LOCK_KEY);
  }
}

/** Pasang trigger auto-sync reaktif (onChange + pengecekan tiap 1 menit). */
function setupReconciliationBriBifastTrigger() {
  removeReconciliationBriBifastTrigger();
  const ss = reconBfGetSpreadsheet_();
  ScriptApp.newTrigger('reconBfOnChangeTrigger_').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('checkReconciliationBriBifastChanges')
    .timeBased()
    .everyMinutes(RECON_BF_CHECK_INTERVAL_MINUTES)
    .create();
  Logger.log('Trigger dipasang: sync otomatis berjalan ~' + (RECON_BF_DEBOUNCE_MS / 1000) +
    ' detik setelah ada perubahan di Sheet (dicek tiap ' + RECON_BF_CHECK_INTERVAL_MINUTES + ' menit).');
}

function removeReconciliationBriBifastTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'reconBfOnChangeTrigger_' || fn === 'checkReconciliationBriBifastChanges' || fn === 'pushReconciliationBriBifast') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Trigger lama dihapus: ' + fn);
    }
  });
}
