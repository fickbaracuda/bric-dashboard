// ═══════════════════════════════════════════════════════════════════════
// Rekonsiliasi FP vs Bank OCBC — Apps Script
// Sheet ID  : 1V8NwLKeVUo2zV4ez-K4V-Ymt3_PNk7DyNrsJktcb2tE
// Sheet tab : "DATA FP" + "DATA BANK OCBC"
// Endpoint  : POST {SYNC_URL}  (header x-sync-token)
//
// CARA PAKAI:
//   1. Buka Google Sheet di atas -> Extensions > Apps Script.
//   2. Tempel isi file ini sebagai file BARU (jangan timpa script lain kalau
//      project ini juga dipakai untuk sheet/fitur lain).
//   3. Project Settings > Script Properties, tambahkan:
//        RECONCILIATION_OCBC_SYNC_TOKEN = <sama dengan APPS_SCRIPT_TOKEN server>
//        RECONCILIATION_OCBC_SYNC_URL   = https://bmsretail.my.id/api/warroom/reconciliation/sync
//        (URL boleh kosong, akan pakai default di atas)
//   4. Jalankan testReconciliationOcbc() dulu (Logger.log, TIDAK mengirim
//      apa pun) — cek jumlah baris FP/bank & summary rekening terbaca benar.
//   5. Kalau sudah OK, jalankan pushReconciliationOcbc() untuk sync manual.
//   6. Jalankan setupReconciliationOcbcTrigger() kalau ingin sync otomatis
//      tiap 5 menit (default). removeReconciliationOcbcTrigger() untuk stop.
// ═══════════════════════════════════════════════════════════════════════

const RECON_SHEET_ID = '1V8NwLKeVUo2zV4ez-K4V-Ymt3_PNk7DyNrsJktcb2tE';
const RECON_SHEET_FP = 'DATA FP';
const RECON_SHEET_BANK = 'DATA BANK OCBC';
const RECON_DEFAULT_URL = 'https://bmsretail.my.id/api/warroom/reconciliation/sync';
const RECON_BANK_CODE = 'OCBC';
const RECON_CHUNK_SIZE = 1500;

/**
 * Parser angka aman — WAJIB cek typeof number DULU (insiden Speedcash: titik
 * desimal number asli ikut terhapus kalau diproses sebagai string).
 */
function reconCleanNum_(value) {
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

/** Terima Date object (dari getValues()) atau string tanggal, kembalikan ISO string atau null. */
function reconToIso_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  return String(value).trim();
}
function reconToIsoDateOnly_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'Asia/Jakarta', 'yyyy-MM-dd');
  }
  return String(value).trim();
}

/**
 * Sheet "DATA FP": header baris 1, data mulai baris 2.
 * A=id_transaksi B=nominal C=id_produk D=time_response E=id_outlet F=id_biller
 * G=kolom bantuan manual "CEK DATA ke BANK" — SENGAJA TIDAK DIBACA.
 */
function reconReadFp_() {
  const ss = SpreadsheetApp.openById(RECON_SHEET_ID);
  const sheet = ss.getSheetByName(RECON_SHEET_FP);
  if (!sheet) throw new Error('Sheet "' + RECON_SHEET_FP + '" tidak ditemukan.');

  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const idTransaksi = String(row[0] || '').trim();
    if (!idTransaksi) continue; // baris kosong dilewati
    rows.push({
      id_transaksi: idTransaksi,
      nominal: reconCleanNum_(row[1]),
      id_produk: String(row[2] || '').trim() || null,
      time_response: reconToIso_(row[3]),
      id_outlet: String(row[4] || '').trim() || null,
      id_biller: String(row[5] || '').trim() || null,
      source_row: r + 1,
      raw_data: { A: row[0], B: row[1], C: row[2], D: row[3], E: row[4], F: row[5] },
      // Kolom G ("CEK DATA ke BANK") SENGAJA tidak disertakan sama sekali.
    });
  }
  return rows;
}

/**
 * Sheet "DATA BANK OCBC": info rekening baris 1-8, header baris 10, data
 * mulai baris 11. A..H dipetakan, I & J (kolom bantuan) SENGAJA diabaikan.
 */
function reconReadBank_() {
  const ss = SpreadsheetApp.openById(RECON_SHEET_ID);
  const sheet = ss.getSheetByName(RECON_SHEET_BANK);
  if (!sheet) throw new Error('Sheet "' + RECON_SHEET_BANK + '" tidak ditemukan.');

  const values = sheet.getDataRange().getValues();

  // ── Summary rekening (baris 1-8) — scan label:value fleksibel ──
  const summaryLabelMap = {
    'PERIOD': 'period', 'PERIODE': 'period',
    'ACCOUNT NUMBER': 'account_number', 'NO REKENING': 'account_number', 'NOMOR REKENING': 'account_number',
    'ACCOUNT NAME': 'account_name', 'NAMA REKENING': 'account_name',
    'TOTAL DEBIT COUNT': 'total_debit_count', 'JUMLAH DEBIT': 'total_debit_count',
    'TOTAL DEBIT AMOUNT': 'total_debit_amount', 'TOTAL DEBIT': 'total_debit_amount',
    'TOTAL CREDIT COUNT': 'total_credit_count', 'JUMLAH KREDIT': 'total_credit_count',
    'TOTAL CREDIT AMOUNT': 'total_credit_amount', 'TOTAL CREDIT': 'total_credit_amount',
    'OPENING BALANCE': 'opening_balance', 'SALDO AWAL': 'opening_balance',
    'CLOSING BALANCE': 'closing_balance', 'SALDO AKHIR': 'closing_balance',
    'LEDGER BALANCE': 'ledger_balance',
    'AVAILABLE BALANCE': 'available_balance', 'SALDO TERSEDIA': 'available_balance',
    'RELEASE DATE': 'release_date', 'TANGGAL RILIS': 'release_date',
  };
  const summary = {};
  for (let r = 0; r < Math.min(8, values.length); r++) {
    const row = values[r] || [];
    for (let c = 0; c < row.length - 1; c++) {
      const label = String(row[c] || '').trim().toUpperCase().replace(/:$/, '');
      if (summaryLabelMap[label] && row[c + 1] !== '') {
        const key = summaryLabelMap[label];
        summary[key] = (key.indexOf('balance') !== -1 || key.indexOf('amount') !== -1 || key.indexOf('count') !== -1)
          ? reconCleanNum_(row[c + 1])
          : String(row[c + 1]).trim();
      }
    }
  }

  // ── Data transaksi mulai baris 11 (idx 10) ──
  const rows = [];
  for (let r = 10; r < values.length; r++) {
    const row = values[r];
    const reference = String(row[2] || '').trim();
    const description = String(row[4] || '').trim();
    const debit = reconCleanNum_(row[5]);
    const credit = reconCleanNum_(row[6]);
    if (!reference && !description && debit === null && credit === null) continue; // baris kosong
    rows.push({
      transaction_date: reconToIsoDateOnly_(row[0]),
      value_date: reconToIsoDateOnly_(row[1]),
      reference_no: reference || null,
      cheque_no: String(row[3] || '').trim() || null,
      description: description || null,
      debit: debit,
      credit: credit,
      balance: reconCleanNum_(row[7]),
      source_row: r + 1,
      raw_data: { A: row[0], B: row[1], C: row[2], D: row[3], E: row[4], F: row[5], G: row[6], H: row[7] },
      // Kolom I & J (bantuan manual) SENGAJA tidak disertakan sama sekali.
    });
  }

  return { rows, summary };
}

function reconBuildPayloadChunks_() {
  const props = PropertiesService.getScriptProperties();
  const fpRows = reconReadFp_();
  const bankData = reconReadBank_();

  const fpChunks = [];
  for (let i = 0; i < fpRows.length; i += RECON_CHUNK_SIZE) fpChunks.push(fpRows.slice(i, i + RECON_CHUNK_SIZE));
  const bankChunks = [];
  for (let i = 0; i < bankData.rows.length; i += RECON_CHUNK_SIZE) bankChunks.push(bankData.rows.slice(i, i + RECON_CHUNK_SIZE));

  const totalChunks = Math.max(1, fpChunks.length, bankChunks.length);
  const today = new Date();
  const businessDate = Utilities.formatDate(today, 'Asia/Jakarta', 'yyyy-MM-dd');

  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    chunks.push({
      business_date: businessDate,
      bank_code: RECON_BANK_CODE,
      spreadsheet_id: RECON_SHEET_ID,
      fp_sheet_name: RECON_SHEET_FP,
      bank_sheet_name: RECON_SHEET_BANK,
      chunk_index: i,
      chunk_total: totalChunks,
      fp: fpChunks[i] || [],
      bank: bankChunks[i] || [],
      bank_summary: i === totalChunks - 1 ? bankData.summary : {},
      meta: { synced_by: Session.getActiveUser().getEmail() || 'apps_script' },
    });
  }

  return { chunks, fpCount: fpRows.length, bankCount: bankData.rows.length, summary: bankData.summary, businessDate };
}

/** Jalankan ini DULU — hanya membaca & melapor ke Logger, TIDAK mengirim apa pun. */
function testReconciliationOcbc() {
  const built = reconBuildPayloadChunks_();
  Logger.log('=== TEST (dry-run) Rekonsiliasi OCBC ===');
  Logger.log('Business date: ' + built.businessDate);
  Logger.log('FP rows: ' + built.fpCount);
  Logger.log('Bank rows: ' + built.bankCount);
  Logger.log('Jumlah chunk: ' + built.chunks.length);
  Logger.log('Bank summary: ' + JSON.stringify(built.summary));
  Logger.log('Sample FP (max 3): ' + JSON.stringify(built.chunks[0].fp.slice(0, 3)));
  Logger.log('Sample Bank (max 3): ' + JSON.stringify(built.chunks[0].bank.slice(0, 3)));
  Logger.log('=== SELESAI TEST — TIDAK ADA DATA YANG DIKIRIM ===');
  return built;
}

/** Kirim seluruh data ke VPS (per chunk kalau data besar). */
function pushReconciliationOcbc() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('RECONCILIATION_OCBC_SYNC_TOKEN');
  const url = props.getProperty('RECONCILIATION_OCBC_SYNC_URL') || RECON_DEFAULT_URL;

  if (!token) {
    Logger.log('ERROR: Script Property RECONCILIATION_OCBC_SYNC_TOKEN belum di-set. Sync dibatalkan.');
    return;
  }

  const built = reconBuildPayloadChunks_();
  Logger.log('Mengirim ' + built.fpCount + ' baris FP, ' + built.bankCount + ' baris bank, dalam ' + built.chunks.length + ' chunk ...');

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
        Logger.log('Sync berhenti karena chunk gagal. Perbaiki dulu sebelum lanjut.');
        return;
      }
    } catch (e) {
      Logger.log('Error fetch pada chunk ' + (i + 1) + ': ' + e.message);
      return;
    }
  }
  Logger.log('Sync selesai untuk business_date ' + built.businessDate + '.');
}

/** Trigger default tiap 5 menit. */
function setupReconciliationOcbcTrigger() {
  removeReconciliationOcbcTrigger();
  ScriptApp.newTrigger('pushReconciliationOcbc')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Trigger set: pushReconciliationOcbc setiap 5 menit.');
}

function removeReconciliationOcbcTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'pushReconciliationOcbc') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Trigger lama dihapus.');
    }
  });
}
