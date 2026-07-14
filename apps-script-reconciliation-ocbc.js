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

/**
 * Terima Date object (dari getValues()) atau string tanggal, kembalikan ISO
 * string atau null.
 *
 * INSIDEN NYATA: versi sebelumnya, utk value yang BUKAN Date object (kasus
 * nyata: sel kolom waktu OCBC ke-baca sbg TEXT, bukan Date, oleh
 * getValues()), cuma `return String(value).trim()` -- alias MENGEMBALIKAN
 * STRING MENTAH "DD/MM/YYYY HH:mm" APA ADANYA, BUKAN ISO. Backend yang
 * percaya field ini sudah ISO lalu `new Date(value)` polos akan salah
 * tafsir "13/07/2026" sbg MM/DD/YYYY (Invalid Date utk tanggal>12) --
 * akibatnya `transaction_date_time` di DB tetap NULL & coverage-aware
 * reconciliation tidak pernah bisa menghitung trusted_coverage_start.
 * Sekarang: parse eksplisit "DD/MM/YYYY[ HH:mm[:ss]]" jadi ISO ber-offset
 * +07:00 (Asia/Jakarta) sebelum dikembalikan.
 */
function reconToIso_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  const s = String(value).trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const d = m[1], mo = m[2], y = m[3], h = m[4] || '0', mi = m[5] || '0', se = m[6] || '0';
    const pad = function (v) { return String(v).padStart(2, '0'); };
    return y + '-' + pad(mo) + '-' + pad(d) + 'T' + pad(h) + ':' + pad(mi) + ':' + pad(se) + '+07:00';
  }
  return s;
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
  let skippedInvalid = 0;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const idTransaksi = String(row[0] || '').trim();
    if (!idTransaksi) continue; // baris kosong dilewati
    // Baris "sampah" — mis. header CSV yang ke-paste ikut ke tengah data
    // ("id_transaksi,nominal,id_produk,..." dalam SATU sel, bukan terpisah
    // per kolom). id_transaksi ASLI selalu murni digit — skip kalau bukan,
    // supaya tidak mencemari hasil rekonsiliasi sebagai "transaksi hantu".
    if (!/^\d+$/.test(idTransaksi)) { skippedInvalid++; continue; }
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
  if (skippedInvalid > 0) {
    Logger.log('WARNING: ' + skippedInvalid + ' baris DATA FP dilewati karena id_transaksi bukan angka murni (kemungkinan header/data sampah ke-paste ke tengah data).');
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

  // ── Summary rekening — layout PERSIS dikonfirmasi dari data riil (baris
  // 1-5, sisanya 6-8 kosong): 2 pasang label:value per baris (kolom A/B dan
  // G/H), KECUALI baris TOTAL DEBIT/CREDIT yang punya count di B dan amount
  // di C. Label asli pakai " :" (spasi + titik dua), contoh "PERIOD :".
  //   Baris1: PERIOD : <period>           | RELEASE DATE : <date>
  //   Baris2: ACCOUNT NO : <no>            | OPENING BALANCE : <val>
  //   Baris3: ACCOUNT NAME : <name>        | CLOSING BALANCE : <val>
  //   Baris4: TOTAL DEBIT : <count> <amt>  | LEDGER BALANCE : <val>
  //   Baris5: TOTAL CREDIT : <count> <amt> | AVAILABLE BALANCE : <val>
  let summary = {};
  const row1 = values[0] || [], row2 = values[1] || [], row3 = values[2] || [], row4 = values[3] || [], row5 = values[4] || [];
  const looksRight = String(row1[0] || '').trim().toUpperCase().indexOf('PERIOD') === 0;
  if (looksRight) {
    summary = {
      period: String(row1[1] || '').trim() || null,
      release_date: String(row1[7] || '').trim() || null,
      account_number: String(row2[1] || '').trim() || null,
      opening_balance: reconCleanNum_(row2[7]),
      account_name: String(row3[1] || '').trim() || null,
      closing_balance: reconCleanNum_(row3[7]),
      total_debit_count: reconCleanNum_(row4[1]),
      total_debit_amount: reconCleanNum_(row4[2]),
      ledger_balance: reconCleanNum_(row4[7]),
      total_credit_count: reconCleanNum_(row5[1]),
      total_credit_amount: reconCleanNum_(row5[2]),
      available_balance: reconCleanNum_(row5[7]),
    };
  } else {
    Logger.log('WARNING: layout summary rekening tidak seperti yang diharapkan (baris 1 kolom A bukan "PERIOD"). Summary dikosongkan, cek manual dgn debugReconBankRawRows().');
  }

  // ── Deteksi baris header SECARA DINAMIS (bukan hardcode baris 10) — data
  // riil menunjukkan bisa ADA LEBIH DARI SATU baris header berturut-turut
  // (baris 10 & 11 sama-sama berisi "Transaction Date"). Cari baris header
  // TERAKHIR (bukan yang pertama) dalam 20 baris pertama, data mulai
  // tepat setelahnya.
  function isHeaderLikeRow(row) {
    const a = String(row[0] || '').trim().toUpperCase();
    const c = String(row[2] || '').trim().toUpperCase();
    return a === 'TRANSACTION DATE' || c.indexOf('REFERENCE') === 0;
  }
  let dataStartRow = 10; // fallback kalau tidak ada baris header yang cocok sama sekali
  for (let r = 0; r < Math.min(20, values.length); r++) {
    if (isHeaderLikeRow(values[r] || [])) dataStartRow = r + 1;
  }

  const rows = [];
  for (let r = dataStartRow; r < values.length; r++) {
    const row = values[r];
    const reference = String(row[2] || '').trim();
    const description = String(row[4] || '').trim();
    const debit = reconCleanNum_(row[5]);
    const credit = reconCleanNum_(row[6]);
    if (!reference && !description && debit === null && credit === null) continue; // baris kosong
    rows.push({
      transaction_date: reconToIsoDateOnly_(row[0]),
      // transaction_date_time: presisi jam-menit-detik (kalau ada di sel,
      // Date object atau string) — dipakai backend utk coverage-aware
      // reconciliation (menghitung boundary minute snapshot 5.000 baris).
      // reconToIso_ SUDAH pakai Asia/Jakarta eksplisit (bukan timezone
      // server), sama seperti time_response di DATA FP.
      transaction_date_time: reconToIso_(row[0]),
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

/**
 * Ringkasan cakupan data bank — HANYA utk visibilitas dry-run/Execution Log
 * (testReconciliationOcbc). Backend TIDAK PERNAH mempercayai angka ini utk
 * keputusan bisnis — is_source_truncated/trusted_coverage dihitung ULANG
 * dari baris yang benar-benar diterima, supaya logic tetap terpusat di
 * satu tempat (warroom-reconciliation.js) dan tidak bisa dipalsukan client.
 */
function reconBuildCoverageMeta_(bankRows) {
  const sourceLimit = 5000;
  const rowCount = bankRows.length;
  const isSourceTruncated = rowCount >= sourceLimit;
  const times = bankRows
    .map(r => r.transaction_date_time)
    .filter(Boolean)
    .map(s => new Date(s))
    .filter(d => !isNaN(d));
  let oldest = null, newest = null;
  if (times.length) {
    oldest = new Date(Math.min.apply(null, times.map(d => d.getTime())));
    newest = new Date(Math.max.apply(null, times.map(d => d.getTime())));
  }
  return {
    source_limit: sourceLimit,
    bank_transaction_row_count: rowCount,
    is_source_truncated: isSourceTruncated,
    snapshot_oldest_time: oldest ? Utilities.formatDate(oldest, 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX") : null,
    snapshot_newest_time: newest ? Utilities.formatDate(newest, 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX") : null,
  };
}

/**
 * Ambil tanggal WIB (yyyy-MM-dd) dari 1 baris FP/bank memakai field tanggal
 * ISO yang sudah dihasilkan reconToIso_/reconToIsoDateOnly_ (SUDAH
 * Asia/Jakarta-anchored, bukan re-parse dari raw value). null kalau field
 * tanggalnya kosong/tidak valid.
 */
function reconExtractIsoDate_(isoString) {
  if (!isoString) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(isoString));
  return m ? m[1] : null;
}

/**
 * Validasi tanggal SEBELUM push (bukan cuma visibilitas Execution Log) —
 * bandingkan tanggal ASLI tiap baris FP/bank terhadap businessDate yang akan
 * dikirim. Dipakai utk deteksi dini kalau Sheet ternyata masih mencampur
 * lebih dari 1 tanggal (mis. baris lama belum sempat dibersihkan operator),
 * SEBELUM data itu ikut terkirim dan berpotensi salah atribusi tanggal.
 *
 * FP di luar businessDate DIKECUALIKAN dari payload yang dikirim (bukan
 * cuma dicatat) — baris FP SEHARUSNYA murni transaksi "hari ini" per desain
 * sheet ini, jadi baris bertanggal lain nyaris pasti sampah/sisa yang belum
 * dibersihkan, dan kalau ikut terkirim akan salah teratribusi ke batch hari
 * ini. Baris BANK TIDAK difilter (tetap dikirim apa adanya) — window 5.000
 * baris bank secara alami bisa mencakup beberapa jam sebelum tengah malam,
 * dan backend (recon_bank_archive) sudah mengatribusikan business_date tiap
 * baris bank dari transaction_date_time-nya SENDIRI (bukan businessDate
 * batch), jadi baris bank "kemarin" yang ikut di window tetap aman —
 * tersimpan ke archive dgn tanggalnya sendiri, tidak pernah dipakai utk
 * matching batch hari ini (lihat fix runOcbcEngineAndPersist di backend).
 */
function reconValidateDates_(fpRows, bankRows, businessDate) {
  const fpDates = new Set();
  const fpInDate = [];
  let fpOutsideCount = 0;
  for (const r of fpRows) {
    const d = reconExtractIsoDate_(r.time_response);
    if (d) fpDates.add(d);
    if (d && d !== businessDate) fpOutsideCount++;
    if (!d || d === businessDate) fpInDate.push(r);
  }

  const bankDates = new Set();
  let bankOutsideCount = 0;
  for (const r of bankRows) {
    const d = reconExtractIsoDate_(r.transaction_date_time) || reconExtractIsoDate_(r.transaction_date);
    if (d) bankDates.add(d);
    if (d && d !== businessDate) bankOutsideCount++;
  }

  if (fpOutsideCount > 0) {
    Logger.log('WARNING: ' + fpOutsideCount + ' baris DATA FP bertanggal DI LUAR business_date (' + businessDate +
      ') -- dikecualikan dari payload yang dikirim. Tanggal unik FP: ' + JSON.stringify([...fpDates]));
  }
  if (bankOutsideCount > 0) {
    Logger.log('INFO: ' + bankOutsideCount + ' baris DATA BANK OCBC bertanggal DI LUAR business_date (' + businessDate +
      ') -- TETAP dikirim (aman, backend mengatribusikan business_date bank per baris sendiri). Tanggal unik bank: ' + JSON.stringify([...bankDates]));
  }

  return {
    business_date: businessDate,
    fp_unique_dates: [...fpDates].sort(),
    bank_unique_dates: [...bankDates].sort(),
    fp_outside_date_count: fpOutsideCount,
    bank_outside_date_count: bankOutsideCount,
    fpRowsInDate: fpInDate,
  };
}

function reconBuildPayloadChunks_() {
  const props = PropertiesService.getScriptProperties();
  const fpRowsAll = reconReadFp_();
  const bankData = reconReadBank_();

  const today = new Date();
  const businessDate = Utilities.formatDate(today, 'Asia/Jakarta', 'yyyy-MM-dd');

  // Validasi tanggal SEBELUM chunking/push -- lihat catatan panjang
  // reconValidateDates_. fpRows yg dipakai utk chunk & dikirim adalah versi
  // SUDAH DIFILTER (dateValidation.fpRowsInDate), bank TETAP seluruhnya.
  const dateValidation = reconValidateDates_(fpRowsAll, bankData.rows, businessDate);
  const fpRows = dateValidation.fpRowsInDate;

  const fpChunks = [];
  for (let i = 0; i < fpRows.length; i += RECON_CHUNK_SIZE) fpChunks.push(fpRows.slice(i, i + RECON_CHUNK_SIZE));
  const bankChunks = [];
  for (let i = 0; i < bankData.rows.length; i += RECON_CHUNK_SIZE) bankChunks.push(bankData.rows.slice(i, i + RECON_CHUNK_SIZE));

  const totalChunks = Math.max(1, fpChunks.length, bankChunks.length);
  // Hanya utk visibilitas Execution Log -- backend menghitung ULANG dari
  // baris yang benar-benar diterima, tidak pernah percaya angka client.
  const coverageMeta = reconBuildCoverageMeta_(bankData.rows);

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
      config: { source_limit: coverageMeta.source_limit },
      meta: {
        synced_by: Session.getActiveUser().getEmail() || 'apps_script',
        bank_transaction_row_count: coverageMeta.bank_transaction_row_count,
        is_source_truncated: coverageMeta.is_source_truncated,
        snapshot_oldest_time: coverageMeta.snapshot_oldest_time,
        snapshot_newest_time: coverageMeta.snapshot_newest_time,
        date_validation: {
          business_date: dateValidation.business_date,
          fp_unique_dates: dateValidation.fp_unique_dates,
          bank_unique_dates: dateValidation.bank_unique_dates,
          fp_outside_date_count: dateValidation.fp_outside_date_count,
          bank_outside_date_count: dateValidation.bank_outside_date_count,
        },
      },
    });
  }

  return {
    chunks, fpCount: fpRows.length, fpCountRaw: fpRowsAll.length, bankCount: bankData.rows.length,
    summary: bankData.summary, businessDate, coverageMeta, dateValidation,
  };
}

/** Jalankan ini DULU — hanya membaca & melapor ke Logger, TIDAK mengirim apa pun. */
function testReconciliationOcbc() {
  const built = reconBuildPayloadChunks_();
  Logger.log('=== TEST (dry-run) Rekonsiliasi OCBC ===');
  Logger.log('Business date: ' + built.businessDate);
  Logger.log('FP rows (dikirim / total sebelum filter tanggal): ' + built.fpCount + ' / ' + built.fpCountRaw);
  Logger.log('Bank rows: ' + built.bankCount);
  Logger.log('Jumlah chunk: ' + built.chunks.length);
  Logger.log('Bank summary: ' + JSON.stringify(built.summary));
  Logger.log('Cakupan data bank (source_limit=' + built.coverageMeta.source_limit + '): ' +
    (built.coverageMeta.is_source_truncated
      ? 'TERPOTONG (' + built.coverageMeta.bank_transaction_row_count + ' baris >= ' + built.coverageMeta.source_limit + '). Oldest=' + built.coverageMeta.snapshot_oldest_time + ', Newest=' + built.coverageMeta.snapshot_newest_time
      : 'lengkap (' + built.coverageMeta.bank_transaction_row_count + ' baris < ' + built.coverageMeta.source_limit + ')'));
  Logger.log('Validasi tanggal: FP unik=' + JSON.stringify(built.dateValidation.fp_unique_dates) +
    ', Bank unik=' + JSON.stringify(built.dateValidation.bank_unique_dates) +
    ', FP di luar business_date=' + built.dateValidation.fp_outside_date_count +
    ' (dikecualikan dari kiriman), Bank di luar business_date=' + built.dateValidation.bank_outside_date_count + ' (tetap dikirim, lihat catatan reconValidateDates_)');
  Logger.log('Sample FP (max 3): ' + JSON.stringify(built.chunks[0].fp.slice(0, 3)));
  Logger.log('Sample Bank (max 3): ' + JSON.stringify(built.chunks[0].bank.slice(0, 3)));
  Logger.log('=== SELESAI TEST — TIDAK ADA DATA YANG DIKIRIM ===');
  return built;
}

/**
 * Diagnostik — dump mentah baris 1-10 sheet "DATA BANK OCBC" (bukan hasil
 * parse) supaya layout summary rekening (baris 1-8) bisa dipastikan sebelum
 * memperbaiki reconReadBank_(). TIDAK mengirim apa pun.
 */
function debugReconBankRawRows() {
  const ss = SpreadsheetApp.openById(RECON_SHEET_ID);
  const sheet = ss.getSheetByName(RECON_SHEET_BANK);
  if (!sheet) { Logger.log('Sheet tidak ditemukan'); return; }
  const values = sheet.getDataRange().getValues().slice(0, 12);
  values.forEach((row, i) => Logger.log('Baris ' + (i + 1) + ': ' + JSON.stringify(row)));
}

/** Kirim seluruh data ke VPS (per chunk kalau data besar). */
/**
 * Kirim seluruh data ke VPS. Mengembalikan ringkasan hasil ({success,message,...})
 * supaya pemanggil (doPost/trigger otomatis) tahu PERSIS apakah sync benar-benar
 * berhasil — sebelumnya fungsi ini cuma Logger.log dan `return` polos, yang
 * membuat doPost() tidak bisa membedakan "berhasil" vs "gagal di tengah jalan".
 */
function pushReconciliationOcbc() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('RECONCILIATION_OCBC_SYNC_TOKEN');
  const url = props.getProperty('RECONCILIATION_OCBC_SYNC_URL') || RECON_DEFAULT_URL;

  if (!token) {
    const msg = 'ERROR: Script Property RECONCILIATION_OCBC_SYNC_TOKEN belum di-set. Sync dibatalkan.';
    Logger.log(msg);
    return { success: false, message: msg };
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
        const msg = 'Sync berhenti karena chunk ' + (i + 1) + ' gagal (HTTP ' + code + '): ' + text;
        Logger.log(msg);
        return { success: false, message: msg, chunk_failed: i + 1, chunk_total: built.chunks.length };
      }
    } catch (e) {
      const msg = 'Error fetch pada chunk ' + (i + 1) + ': ' + e.message;
      Logger.log(msg);
      return { success: false, message: msg, chunk_failed: i + 1, chunk_total: built.chunks.length };
    }
  }
  const doneMsg = 'Sync selesai untuk business_date ' + built.businessDate + ' (' + built.fpCount + ' FP, ' + built.bankCount + ' bank).';
  Logger.log(doneMsg);
  return { success: true, message: doneMsg, business_date: built.businessDate, fp_count: built.fpCount, bank_count: built.bankCount };
}

/**
 * Web App entrypoint — dipanggil dari tombol "Sync Sekarang" di dashboard
 * BRIC (lewat backend, BUKAN langsung dari browser user). WAJIB di-deploy
 * manual sekali: Deploy > New deployment > pilih tipe "Web app" > Execute as
 * "Me", Who has access "Anyone". Salin URL hasil deploy (berakhiran /exec)
 * ke env RECONCILIATION_OCBC_TRIGGER_URL di server (backend/.env).
 *
 * Token dikirim di BODY (bukan header — Apps Script Web App tidak
 * mengekspos header request custom lewat objek `e`), dicocokkan dengan
 * Script Property yang sama dengan sync biasa (RECONCILIATION_OCBC_SYNC_TOKEN).
 *
 * PENTING: setiap kali kode ini diubah, deployment Web App yang SUDAH ADA
 * TIDAK otomatis ke-update — harus "Manage deployments > Edit > New version"
 * di Apps Script Editor, kalau tidak versi lama yang tetap jalan.
 */
function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }

  const props = PropertiesService.getScriptProperties();
  const expectedToken = props.getProperty('RECONCILIATION_OCBC_SYNC_TOKEN');
  const token = body.token || (e && e.parameter && e.parameter.token) || '';

  if (!expectedToken || token !== expectedToken) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const result = pushReconciliationOcbc();
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Auto-sync REAKTIF terhadap perubahan Sheet (bukan cuma interval tetap).
//
// SENGAJA TIDAK langsung sync di setiap event onChange — kalau tim
// mengetik/paste beruntun, itu bisa memicu banyak sync yang tumpang tindih
// dalam hitungan detik (saling menghapus/menulis ulang batch yang sama) dan
// cepat menghabiskan kuota harian Apps Script. Polanya jadi 2 lapis:
//   1. onChange (installable trigger) HANYA menandai "ada perubahan" (flag
//      timestamp di Script Properties) - sangat ringan, hampir tanpa kuota.
//   2. Time-based trigger tiap 1 menit MENGECEK flag itu - baru benar-benar
//      menjalankan pushReconciliationOcbc() kalau sudah lewat masa tunggu
//      (debounce) sejak edit TERAKHIR, dan tidak ada sync lain yang sedang
//      berjalan (lock). Hasil: data ter-update otomatis ~30-90 detik
//      setelah perubahan terakhir, tanpa risiko sync saling tabrakan.
// ═══════════════════════════════════════════════════════════════════════
const RECON_DIRTY_FLAG_KEY = 'RECON_DIRTY_SINCE';
const RECON_SYNC_LOCK_KEY = 'RECON_SYNC_IN_PROGRESS';
const RECON_DEBOUNCE_MS = 30 * 1000; // tunggu 30 detik sejak edit terakhir sebelum sync
const RECON_CHECK_INTERVAL_MINUTES = 1;

/** Installable trigger (onChange) — HANYA menandai, TIDAK sync langsung. */
function reconOnChangeTrigger_(e) {
  PropertiesService.getScriptProperties().setProperty(RECON_DIRTY_FLAG_KEY, String(Date.now()));
}

/**
 * Cek tombol "Sync Now" di dashboard — Web App Apps Script TIDAK BISA
 * dipanggil langsung dari browser (kebijakan Google Workspace), jadi
 * tombol itu hanya mencatat permintaan di database BRIC. Panggilan KELUAR
 * dari Apps Script ke backend (arah ini) selalu boleh, tidak kena
 * pembatasan yang sama. TIDAK PERNAH melempar error ke pemanggil — kalau
 * gagal cek, anggap saja tidak ada permintaan (fallback ke jadwal normal).
 */
function reconCheckForceSyncRequested_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('RECONCILIATION_OCBC_SYNC_TOKEN');
    const syncUrl = props.getProperty('RECONCILIATION_OCBC_SYNC_URL') || RECON_DEFAULT_URL;
    const statusUrl = syncUrl.replace(/\/sync$/, '/sync-request-status') + '?bank_code=' + RECON_BANK_CODE;
    const resp = UrlFetchApp.fetch(statusUrl, { headers: { 'x-sync-token': token }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return false;
    return !!JSON.parse(resp.getContentText()).pending;
  } catch (e) {
    Logger.log('WARNING: gagal cek status tombol Sync Now: ' + e.message);
    return false;
  }
}

/** Dipanggil time-based trigger tiap 1 menit. Sync jalan kalau: ada
 * perubahan (dirty flag) DAN sudah lewat masa tunggu sejak edit terakhir,
 * ATAU ada permintaan "Sync Now" dari dashboard (skip debounce) — DAN
 * tidak ada sync lain yang sedang berjalan (lock). */
function checkAndSyncIfDirtyReconciliationOcbc() {
  const props = PropertiesService.getScriptProperties();
  const dirtySince = Number(props.getProperty(RECON_DIRTY_FLAG_KEY) || 0);
  const forceRequested = reconCheckForceSyncRequested_();
  if (!dirtySince && !forceRequested) return; // tidak ada perubahan & tidak ada permintaan manual

  if (!forceRequested && Date.now() - dirtySince < RECON_DEBOUNCE_MS) return; // masih dalam masa tunggu, tim mungkin masih input

  if (props.getProperty(RECON_SYNC_LOCK_KEY) === 'true') {
    Logger.log('Sync sebelumnya masih berjalan, lewati siklus ini.');
    return;
  }

  props.setProperty(RECON_SYNC_LOCK_KEY, 'true');
  try {
    // Hapus dirty flag SEBELUM push — kalau ada edit baru masuk selagi sync
    // berjalan, flag akan otomatis ke-set ulang oleh reconOnChangeTrigger_
    // dan tertangkap di siklus berikutnya (bukan hilang begitu saja).
    props.deleteProperty(RECON_DIRTY_FLAG_KEY);
    if (forceRequested) Logger.log('Sync dipicu oleh tombol "Sync Now" di dashboard.');
    pushReconciliationOcbc();
  } finally {
    props.deleteProperty(RECON_SYNC_LOCK_KEY);
  }
}

/** Pasang trigger auto-sync reaktif (onChange + pengecekan tiap 1 menit). */
function setupReconciliationOcbcTrigger() {
  removeReconciliationOcbcTrigger();
  const ss = SpreadsheetApp.openById(RECON_SHEET_ID);
  ScriptApp.newTrigger('reconOnChangeTrigger_').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('checkAndSyncIfDirtyReconciliationOcbc')
    .timeBased()
    .everyMinutes(RECON_CHECK_INTERVAL_MINUTES)
    .create();
  Logger.log('Trigger dipasang: sync otomatis berjalan ~' + (RECON_DEBOUNCE_MS / 1000) +
    ' detik setelah ada perubahan di Sheet (dicek tiap ' + RECON_CHECK_INTERVAL_MINUTES + ' menit).');
}

function removeReconciliationOcbcTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'pushReconciliationOcbc' || fn === 'reconOnChangeTrigger_' || fn === 'checkAndSyncIfDirtyReconciliationOcbc') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Trigger lama dihapus: ' + fn);
    }
  });
}
