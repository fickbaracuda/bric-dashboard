// ═══════════════════════════════════════════════════════════════════════
// Rekonsiliasi BCA — Apps Script
// Sheet ID  : 1BkHetxYcM4FzrZIljPER5QRzTHIjRffuQ15IdyZNe3k
// Sheet tab : "Data FP" + "Data Bank BCA"
// Endpoint  : POST {BRIC_API_BASE_URL}/api/warroom/reconciliation/bca/sync
//             (header x-sync-token)
//
// BEDA dari Rekonsiliasi Mandiri/BRI/BNI: sheet "Data Bank BCA" BUKAN
// header-di-baris-1 — ada 6 baris metadata rekening (No. rekening/Nama/
// Periode/Kode Mata Uang) sebelum header kolom transaksi, DAN 4 baris
// footer ringkasan (Saldo Awal/Mutasi Debet/Mutasi Kredit/Saldo Akhir)
// setelah baris transaksi terakhir. Header kolom (Tanggal Transaksi/
// Keterangan/Cabang/Jumlah/Saldo) DICARI otomatis (bukan hardcode baris 7)
// — supaya tetap aman kalau bank menambah/mengurangi baris metadata di
// export berikutnya.
//
// CARA PAKAI:
//   1. Buka Google Sheet di atas -> Extensions > Apps Script.
//   2. Tempel isi file ini sebagai file BARU.
//   3. Project Settings > Script Properties, tambahkan:
//        BRIC_SYNC_TOKEN    = <sama dengan APPS_SCRIPT_TOKEN server>
//        BRIC_API_BASE_URL  = https://bmsretail.my.id   (opsional, ini defaultnya)
//   4. Jalankan testReconciliationBca() dulu (Logger.log, TIDAK mengirim
//      apa pun) — cek jumlah baris FP/BCA terbaca benar, & metadata rekening
//      (No. rekening/Saldo Awal/Saldo Akhir) terbaca benar.
//   5. Kalau sudah OK, jalankan pushReconciliationBca() untuk sync manual.
//   6. Jalankan setupReconciliationBcaTrigger() untuk sync OTOMATIS REAKTIF
//      — jalan ~30-90 detik setelah ada perubahan apa pun di Sheet (bukan
//      menunggu interval tetap). removeReconciliationBcaTrigger() utk stop.
//   7. getReconciliationBcaStatus() -> lihat ringkasan sync terakhir.
// ═══════════════════════════════════════════════════════════════════════

const RECON_BCA_SHEET_ID = '1BkHetxYcM4FzrZIljPER5QRzTHIjRffuQ15IdyZNe3k';
const RECON_BCA_SHEET_FP = 'Data FP';
const RECON_BCA_SHEET_BANK = 'Data Bank BCA';
const RECON_BCA_DEFAULT_BASE_URL = 'https://bmsretail.my.id';
const RECON_BCA_BANK_CODE = 'BCA';
const RECON_BCA_CHUNK_SIZE = 1500;
const RECON_BCA_LAST_STATUS_KEY = 'RECON_BCA_LAST_STATUS';

// Auto-sync REAKTIF (bukan interval tetap) — pola sama dgn Rekonsiliasi
// OCBC/Mandiri (lihat apps-script-reconciliation-mandiri.js).
const RECON_BCA_DIRTY_FLAG_KEY = 'RECON_BCA_DIRTY_SINCE';
const RECON_BCA_SYNC_LOCK_KEY = 'RECON_BCA_SYNC_IN_PROGRESS';
const RECON_BCA_DEBOUNCE_MS = 30 * 1000;
const RECON_BCA_CHECK_INTERVAL_MINUTES = 1;

/** Parser angka aman — WAJIB cek typeof number DULU. Direplikasi persis di semua Apps Script baru. */
function reconBcaCleanNum_(value) {
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
 * Angka dgn koma sbg pemisah RIBUAN dan titik sbg desimal (format footer
 * "14,780,196,783.96") — BEDA dari reconBcaCleanNum_ di atas (yang membuang
 * SEMUA titik/koma, cocok utk angka bulat rupiah, TIDAK cocok utk angka
 * berdesimal seperti Saldo Awal/Akhir).
 */
function reconBcaCleanDecimal_(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  const raw = String(value).trim().replace(/,/g, '');
  if (raw === '' || raw === '-') return null;
  const n = Number(raw);
  return isFinite(n) ? n : null;
}

/** Date object (dari getValues()) atau string -> "yyyy-MM-dd" (WIB), TIDAK dikonversi ke angka. */
function reconBcaToIsoDate_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'Asia/Jakarta', 'yyyy-MM-dd');
  }
  return String(value).trim();
}

function reconBcaToIsoDateTime_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ss");
  }
  return String(value).trim();
}

/** id_transaksi/id_outlet/id_biller WAJIB string murni, jangan biarkan Apps Script membaca sbg Number (presisi digit besar bisa hilang). */
function reconBcaToStringId_(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(value).trim();
  }
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * Sheet "Data FP": header baris 1 (nama kolom persis: id_transaksi, nominal,
 * id_produk, time_response, id_outlet, id_biller), data mulai baris 2.
 * Struktur SAMA persis dgn bank lain — TIDAK ada kolom status/sukses
 * terpisah (Data FP memang sudah berisi transaksi sukses).
 */
function reconBcaReadFp_() {
  const ss = SpreadsheetApp.openById(RECON_BCA_SHEET_ID);
  const sheet = ss.getSheetByName(RECON_BCA_SHEET_FP);
  if (!sheet) throw new Error('Sheet "' + RECON_BCA_SHEET_FP + '" tidak ditemukan.');

  const values = sheet.getDataRange().getValues(); // read-only, TIDAK mengubah sheet asli
  if (values.length < 2) return [];

  const rows = [];
  let skippedInvalid = 0;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const idTransaksi = reconBcaToStringId_(row[0]);
    if (!idTransaksi) continue;
    if (!/^\d+$/.test(idTransaksi)) { skippedInvalid++; continue; } // guard: baris sampah/header ke-paste
    rows.push({
      id_transaksi: idTransaksi,
      nominal: reconBcaCleanNum_(row[1]),
      id_produk: reconBcaToStringId_(row[2]),
      time_response: reconBcaToIsoDateTime_(row[3]),
      id_outlet: reconBcaToStringId_(row[4]),
      id_biller: reconBcaToStringId_(row[5]),
      source_row: r + 1,
      raw_data: { id_transaksi: row[0], nominal: row[1], id_produk: row[2], time_response: row[3], id_outlet: row[4], id_biller: row[5] },
    });
  }
  if (skippedInvalid > 0) {
    Logger.log('WARNING: ' + skippedInvalid + ' baris Data FP dilewati (id_transaksi bukan angka murni).');
  }
  return rows;
}

/** Label baris metadata/footer "Label : value" -> { label, value } (trim keduanya). null kalau bukan pola itu. */
function reconBcaParseLabelValue_(text) {
  const s = String(text || '').trim();
  const idx = s.indexOf(':');
  if (idx < 0) return null;
  return { label: s.slice(0, idx).trim(), value: s.slice(idx + 1).trim() };
}

/**
 * Sheet "Data Bank BCA": 6 baris metadata rekening (No. rekening/Nama/
 * Periode/Kode Mata Uang), lalu header kolom (Tanggal Transaksi/
 * Keterangan/Cabang/Jumlah/Saldo) — DICARI otomatis (bukan hardcode baris
 * ke berapa), data transaksi setelahnya, lalu 4 baris footer ringkasan
 * (Saldo Awal/Mutasi Debet/Mutasi Kredit/Saldo Akhir).
 *
 * Ekstraksi id_transaksi FP dari Keterangan TIDAK dilakukan di sini —
 * dikirim apa adanya (Keterangan mentah + Jumlah teks mentah "25,000.00
 * DB"), parsing terjadi di backend (bcaAdapter.js) supaya logic bisnis
 * tetap 100% di satu tempat.
 */
function reconBcaReadBank_() {
  const ss = SpreadsheetApp.openById(RECON_BCA_SHEET_ID);
  const sheet = ss.getSheetByName(RECON_BCA_SHEET_BANK);
  if (!sheet) throw new Error('Sheet "' + RECON_BCA_SHEET_BANK + '" tidak ditemukan.');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return { rows: [], metadata: {}, footer: {} };

  // Cari baris header kolom transaksi: kolom A = "Tanggal Transaksi" DAN
  // kolom B = "Keterangan" (case-insensitive) — bukan diasumsikan baris 7,
  // supaya tahan kalau jumlah baris metadata di atasnya berubah.
  let headerRowIndex = -1;
  for (let r = 0; r < Math.min(values.length, 30); r++) {
    const a = String(values[r][0] || '').trim().toLowerCase();
    const b = String(values[r][1] || '').trim().toLowerCase();
    if (a === 'tanggal transaksi' && b === 'keterangan') { headerRowIndex = r; break; }
  }
  if (headerRowIndex < 0) {
    throw new Error('Header kolom transaksi ("Tanggal Transaksi"/"Keterangan") tidak ditemukan di 30 baris pertama sheet "' + RECON_BCA_SHEET_BANK + '".');
  }

  // Metadata rekening: baris SEBELUM header, pola "Label : value" di kolom A.
  const metadata = {};
  for (let r = 0; r < headerRowIndex; r++) {
    const parsed = reconBcaParseLabelValue_(values[r][0]);
    if (!parsed) continue;
    const key = parsed.label.toLowerCase();
    if (key.indexOf('no. rekening') >= 0 || key.indexOf('no rekening') >= 0) metadata.account_no = parsed.value;
    else if (key.indexOf('nama') >= 0) metadata.account_name = parsed.value;
    else if (key.indexOf('periode') >= 0) metadata.periode = parsed.value;
    else if (key.indexOf('kode mata uang') >= 0) metadata.currency = parsed.value;
  }

  // Baris transaksi + footer ringkasan (Saldo Awal/Mutasi Debet/Mutasi
  // Kredit/Saldo Akhir) — footer dideteksi via label kolom A, TIDAK
  // dianggap baris transaksi (di-skip dari `rows`, tapi tetap dibaca utk
  // footer.saldo_awal/saldo_akhir yg dipakai backend sbg current balance
  // resmi, lihat catatan section 8 & 17 spec).
  const footer = {};
  const rows = [];
  for (let r = headerRowIndex + 1; r < values.length; r++) {
    const row = values[r];
    const colA = row[0];
    const colALabel = reconBcaParseLabelValue_(colA);
    if (colALabel) {
      const key = colALabel.label.toLowerCase();
      if (key.indexOf('saldo awal') >= 0) footer.saldo_awal = reconBcaCleanDecimal_(colALabel.value);
      else if (key.indexOf('mutasi debet') >= 0) { footer.mutasi_debet_total = reconBcaCleanDecimal_(colALabel.value); footer.mutasi_debet_count = reconBcaCleanNum_(row[3]); }
      else if (key.indexOf('mutasi kredit') >= 0) { footer.mutasi_kredit_total = reconBcaCleanDecimal_(colALabel.value); footer.mutasi_kredit_count = reconBcaCleanNum_(row[3]); }
      else if (key.indexOf('saldo akhir') >= 0) footer.saldo_akhir = reconBcaCleanDecimal_(colALabel.value);
      continue; // baris footer, bukan transaksi
    }

    const tanggalRaw = row[0];
    const keterangan = String(row[1] || '').trim();
    const cabang = row[2];
    const jumlahRaw = row[3];
    const saldoRaw = row[4];
    // Baris kosong (jeda antar blok) -> lewati, JANGAN dihentikan (footer
    // bisa saja tidak persis di baris berikutnya kalau ada baris kosong).
    if (!tanggalRaw && !keterangan && (jumlahRaw === '' || jumlahRaw === undefined) && (saldoRaw === '' || saldoRaw === undefined)) continue;

    rows.push({
      transaction_date: reconBcaToIsoDate_(tanggalRaw),
      description: keterangan || null,
      branch: (cabang === null || cabang === undefined || cabang === '') ? null : String(cabang).trim(),
      jumlah: String(jumlahRaw || '').trim() || null, // TEKS mentah "25,000.00 DB" — parsing arah/angka di backend (bcaAdapter.js)
      balance: reconBcaCleanDecimal_(saldoRaw),
      source_row: r + 1,
      raw_data: { tanggal_transaksi: tanggalRaw, keterangan: keterangan, cabang: cabang, jumlah: jumlahRaw, saldo: saldoRaw },
    });
  }

  return { rows, metadata, footer };
}

function reconBcaBuildPayloadChunks_() {
  const fpRows = reconBcaReadFp_();
  const bankData = reconBcaReadBank_();
  const bankRows = bankData.rows;

  const fpChunks = [];
  for (let i = 0; i < fpRows.length; i += RECON_BCA_CHUNK_SIZE) fpChunks.push(fpRows.slice(i, i + RECON_BCA_CHUNK_SIZE));
  const bankChunks = [];
  for (let i = 0; i < bankRows.length; i += RECON_BCA_CHUNK_SIZE) bankChunks.push(bankRows.slice(i, i + RECON_BCA_CHUNK_SIZE));

  const totalChunks = Math.max(1, fpChunks.length, bankChunks.length);
  const today = new Date();
  const businessDate = Utilities.formatDate(today, 'Asia/Jakarta', 'yyyy-MM-dd');
  const accountNo = bankData.metadata.account_no || null;
  const syncedBy = (function () { try { return Session.getActiveUser().getEmail() || 'apps_script'; } catch (e) { return 'apps_script'; } })();

  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    chunks.push({
      business_date: businessDate,
      bank_code: RECON_BCA_BANK_CODE,
      spreadsheet_id: RECON_BCA_SHEET_ID,
      fp_sheet_name: RECON_BCA_SHEET_FP,
      bank_sheet_name: RECON_BCA_SHEET_BANK,
      account_no: accountNo,
      // balance_summary HANYA dikirim di chunk TERAKHIR bersama footer yang
      // sudah lengkap terbaca (nilainya sama di semua chunk krn dibaca dari
      // 1x pemanggilan reconBcaReadBank_ di atas, aman dikirim tiap chunk).
      balance_summary: bankData.footer,
      chunk_index: i,
      chunk_total: totalChunks,
      fp: fpChunks[i] || [],
      bank: bankChunks[i] || [],
      meta: { synced_by: syncedBy, synced_at: Utilities.formatDate(new Date(), 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX"), account_name: bankData.metadata.account_name, periode: bankData.metadata.periode, currency: bankData.metadata.currency },
    });
  }

  return { chunks, fpCount: fpRows.length, bankCount: bankRows.length, businessDate, accountNo, footer: bankData.footer, metadata: bankData.metadata };
}

/** Jalankan ini DULU — hanya membaca & melapor ke Logger, TIDAK mengirim apa pun. */
function testReconciliationBca() {
  const built = reconBcaBuildPayloadChunks_();
  Logger.log('=== TEST (dry-run) Rekonsiliasi BCA ===');
  Logger.log('Business date: ' + built.businessDate);
  Logger.log('No. rekening: ' + built.accountNo + ' (' + (built.metadata.account_name || '-') + ')');
  Logger.log('Periode: ' + (built.metadata.periode || '-') + ' | Mata uang: ' + (built.metadata.currency || '-'));
  Logger.log('FP rows: ' + built.fpCount);
  Logger.log('Bank (BCA) rows: ' + built.bankCount);
  Logger.log('Footer — Saldo Awal: ' + built.footer.saldo_awal + ', Saldo Akhir: ' + built.footer.saldo_akhir);
  Logger.log('Footer — Mutasi Debet: ' + built.footer.mutasi_debet_total + ' (' + built.footer.mutasi_debet_count + ' baris), Mutasi Kredit: ' + built.footer.mutasi_kredit_total + ' (' + built.footer.mutasi_kredit_count + ' baris)');
  Logger.log('Jumlah chunk: ' + built.chunks.length);
  Logger.log('Sample FP (max 3): ' + JSON.stringify(built.chunks[0].fp.slice(0, 3)));
  Logger.log('Sample Bank (max 3): ' + JSON.stringify(built.chunks[0].bank.slice(0, 3)));
  Logger.log('=== SELESAI TEST — TIDAK ADA DATA YANG DIKIRIM ===');
  return built;
}

/** Kirim seluruh data ke VPS (per chunk kalau data besar). Token & URL dari Script Properties, TIDAK di-hardcode. */
function pushReconciliationBca() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('BRIC_SYNC_TOKEN');
  const baseUrl = props.getProperty('BRIC_API_BASE_URL') || RECON_BCA_DEFAULT_BASE_URL;
  const url = baseUrl.replace(/\/+$/, '') + '/api/warroom/reconciliation/bca/sync';

  if (!token) {
    const msg = 'ERROR: Script Property BRIC_SYNC_TOKEN belum di-set. Sync dibatalkan.';
    Logger.log(msg);
    reconBcaSaveStatus_({ success: false, message: msg, at: new Date().toISOString() });
    return { success: false, message: msg };
  }

  let built;
  try {
    built = reconBcaBuildPayloadChunks_();
  } catch (e) {
    const msg = 'ERROR membaca sheet: ' + e.message;
    Logger.log(msg);
    reconBcaSaveStatus_({ success: false, message: msg, at: new Date().toISOString() });
    return { success: false, message: msg };
  }

  Logger.log('Mengirim ' + built.fpCount + ' baris FP, ' + built.bankCount + ' baris BCA, dalam ' + built.chunks.length + ' chunk ...');

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
        reconBcaSaveStatus_({ success: false, message: msg, at: new Date().toISOString(), chunk_failed: i + 1, chunk_total: built.chunks.length });
        return { success: false, message: msg, chunk_failed: i + 1, chunk_total: built.chunks.length };
      }
    } catch (e) {
      const msg = 'Error fetch pada chunk ' + (i + 1) + ': ' + e.message;
      Logger.log(msg);
      reconBcaSaveStatus_({ success: false, message: msg, at: new Date().toISOString(), chunk_failed: i + 1, chunk_total: built.chunks.length });
      return { success: false, message: msg, chunk_failed: i + 1, chunk_total: built.chunks.length };
    }
  }

  const doneMsg = 'Sync selesai untuk business_date ' + built.businessDate + ' (' + built.fpCount + ' FP, ' + built.bankCount + ' BCA).';
  Logger.log(doneMsg);
  const result = { success: true, message: doneMsg, business_date: built.businessDate, fp_count: built.fpCount, bank_count: built.bankCount, at: new Date().toISOString() };
  reconBcaSaveStatus_(result);
  return result;
}

/** Simpan ringkasan sync terakhir (sukses/gagal) di Script Properties. */
function reconBcaSaveStatus_(status) {
  try {
    PropertiesService.getScriptProperties().setProperty(RECON_BCA_LAST_STATUS_KEY, JSON.stringify(status));
  } catch (e) {
    Logger.log('Gagal menyimpan status sync: ' + e.message);
  }
}

/** Lihat ringkasan sync TERAKHIR (sukses/gagal, kapan, berapa baris) tanpa perlu buka Execution Log. */
function getReconciliationBcaStatus() {
  const raw = PropertiesService.getScriptProperties().getProperty(RECON_BCA_LAST_STATUS_KEY);
  const status = raw ? JSON.parse(raw) : { message: 'Belum pernah sync.' };
  Logger.log(JSON.stringify(status, null, 2));
  return status;
}

/** Installable trigger (onChange) — HANYA menandai, TIDAK sync langsung. */
function reconBcaOnChangeTrigger_(e) {
  PropertiesService.getScriptProperties().setProperty(RECON_BCA_DIRTY_FLAG_KEY, String(Date.now()));
}

/**
 * Cek tombol "Sync Now" di dashboard — TIDAK PERNAH melempar error ke
 * pemanggil, kalau gagal cek anggap saja tidak ada permintaan.
 */
function reconBcaCheckForceSyncRequested_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('BRIC_SYNC_TOKEN');
    const baseUrl = props.getProperty('BRIC_API_BASE_URL') || RECON_BCA_DEFAULT_BASE_URL;
    const statusUrl = baseUrl.replace(/\/+$/, '') + '/api/warroom/reconciliation/sync-request-status?bank_code=' + RECON_BCA_BANK_CODE;
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
function checkAndSyncIfDirtyReconciliationBca() {
  const props = PropertiesService.getScriptProperties();
  const dirtySince = Number(props.getProperty(RECON_BCA_DIRTY_FLAG_KEY) || 0);
  const forceRequested = reconBcaCheckForceSyncRequested_();
  if (!dirtySince && !forceRequested) return;

  if (!forceRequested && Date.now() - dirtySince < RECON_BCA_DEBOUNCE_MS) return;

  if (props.getProperty(RECON_BCA_SYNC_LOCK_KEY) === 'true') {
    Logger.log('Sync BCA sebelumnya masih berjalan, lewati siklus ini.');
    return;
  }

  props.setProperty(RECON_BCA_SYNC_LOCK_KEY, 'true');
  try {
    props.deleteProperty(RECON_BCA_DIRTY_FLAG_KEY);
    if (forceRequested) Logger.log('Sync BCA dipicu oleh tombol "Sync Now" di dashboard.');
    pushReconciliationBca();
  } finally {
    props.deleteProperty(RECON_BCA_SYNC_LOCK_KEY);
  }
}

/** Pasang trigger auto-sync reaktif (onChange + pengecekan tiap 1 menit). */
function setupReconciliationBcaTrigger() {
  removeReconciliationBcaTrigger();
  const ss = SpreadsheetApp.openById(RECON_BCA_SHEET_ID);
  ScriptApp.newTrigger('reconBcaOnChangeTrigger_').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('checkAndSyncIfDirtyReconciliationBca')
    .timeBased()
    .everyMinutes(RECON_BCA_CHECK_INTERVAL_MINUTES)
    .create();
  Logger.log('Trigger dipasang: sync otomatis berjalan ~' + (RECON_BCA_DEBOUNCE_MS / 1000) +
    ' detik setelah ada perubahan di Sheet (dicek tiap ' + RECON_BCA_CHECK_INTERVAL_MINUTES + ' menit).');
}

function removeReconciliationBcaTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'reconBcaOnChangeTrigger_' || fn === 'checkAndSyncIfDirtyReconciliationBca' || fn === 'pushReconciliationBca') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Trigger lama dihapus: ' + fn);
    }
  });
}
