// ============================================================
// WAR ROOM MGM PA — Push ke BRIC Dashboard
// Baca sheet MGM-<Bulan> (blok AKTIVASI kolom A–L, blok REGISTRASI
// kolom N–X pada baris yang sama), kirim ke VPS.
//
// Riwayat perbaikan (audit KPI MGM PA, Agustus 2026):
// - is_active TIDAK LAGI di-collapse ke 0 di sini kalau kosong/bukan
//   angka. Backend (mgmSyncHandler + normalizeIsActive) yang menentukan
//   apakah suatu nilai valid (0/1) atau unknown. Sebelumnya
//   `parseInt(row[6]) || 0` diam-diam menganggap sel kosong = "belum
//   aktif" — itu salah, harus tercatat sebagai unknown, bukan 0.
// - Ditambahkan auditMgmSheets() — fungsi READ-ONLY (tidak mengirim apa
//   pun ke VPS) untuk menghitung: total baris discan, baris dengan
//   id_outlet kosong, baris dengan id_outlet TIDAK berawalan "FA"
//   (sample sampai 10 nilai supaya kelihatan pola typo/prefix-nya),
//   dan duplikat id_outlet dalam satu sheet. Jalankan fungsi ini dulu
//   sebelum pushMgmToVPS() kalau mau menyelidiki selisih jumlah baris
//   (mis. total registrasi/aktivasi di dashboard tidak sesuai sheet).
// - pushMgmToVPS() sekarang juga menjalankan audit yang sama dan
//   menuliskannya ke Logger SEBELUM mengirim POST, supaya angka
//   before/after sync selalu bisa ditelusuri dari Executions log.
// ============================================================

const VPS_URL    = 'https://bmsretail.my.id/api/warroom/mgm/sync';
const SYNC_TOKEN = 'bric2026mgmpasecret';

const SHEET_BULAN_MAP = {
  'MGM-Mei':  '2026-05',
  'MGM-Juni': '2026-06',
  'MGM-Juli': '2026-07',
  'MGM-Agustus': '2026-08',
};

// ── Audit murni baca sheet, TIDAK mengirim apa pun — aman dijalankan kapan saja ──
function auditMgmSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lines = [];

  Object.keys(SHEET_BULAN_MAP).forEach(sheetName => {
    const ws = ss.getSheetByName(sheetName);
    if (!ws) { lines.push(`${sheetName}: sheet tidak ditemukan, skip.`); return; }

    const lastRow = ws.getLastRow();
    if (lastRow < 3) { lines.push(`${sheetName}: tidak ada data (lastRow=${lastRow})`); return; }

    const allData = ws.getDataRange().getValues();
    const auditAkt = auditBlock(allData, { idCol: 1, isActiveCol: 6 });
    const auditReg = auditBlock(allData, { idCol: 14, isActiveCol: 19 });

    const summary = [
      `=== ${sheetName} (bulan ${SHEET_BULAN_MAP[sheetName]}) ===`,
      `  total baris discan (data, exclude 2 baris header): ${allData.length - 2}`,
      `  AKTIVASI  — id_outlet non-blank: ${auditAkt.nonBlank}, prefix "FA": ${auditAkt.faPrefix}, ` +
        `BUKAN "FA" (${auditAkt.nonFaSamples.length} sample): ${JSON.stringify(auditAkt.nonFaSamples)}, ` +
        `duplikat id (dalam blok FA): ${auditAkt.duplicateIds.length} ${JSON.stringify(auditAkt.duplicateIds.slice(0, 10))}, ` +
        `is_active blank/non-numeric: ${auditAkt.isActiveUnknown}`,
      `  REGISTRASI — id_outlet non-blank: ${auditReg.nonBlank}, prefix "FA": ${auditReg.faPrefix}, ` +
        `BUKAN "FA" (${auditReg.nonFaSamples.length} sample): ${JSON.stringify(auditReg.nonFaSamples)}, ` +
        `duplikat id (dalam blok FA): ${auditReg.duplicateIds.length} ${JSON.stringify(auditReg.duplicateIds.slice(0, 10))}, ` +
        `is_active blank/non-numeric: ${auditReg.isActiveUnknown}`,
    ].join('\n');

    Logger.log(summary);
    lines.push(summary);
  });

  const output = lines.join('\n\n');
  Logger.log('\n' + output);
  try {
    SpreadsheetApp.getUi().alert('Audit MGM PA selesai — detail lengkap ada di menu Extensions > Apps Script > Executions (Logger.log).\n\n' + output.substring(0, 1500));
  } catch (_) { /* trigger otomatis tidak punya UI */ }
  return output;
}

// Hitung statistik satu blok (aktivasi ATAU registrasi) dari data mentah sheet.
// idCol/isActiveCol pakai index yang SAMA dengan yang dipakai pushMgmToVPS().
function auditBlock(allData, { idCol, isActiveCol }) {
  let nonBlank = 0, faPrefix = 0;
  const nonFaSamples = [];
  const seen = new Map(); // id -> count, hanya utk row yang lolos filter FA (sama seperti payload asli)
  let isActiveUnknown = 0;

  for (let i = 2; i < allData.length; i++) {
    const row = allData[i];
    const id = String(row[idCol] || '').trim();
    if (!id) continue;
    nonBlank++;

    if (!id.startsWith('FA')) {
      if (nonFaSamples.length < 10) nonFaSamples.push(id);
      continue;
    }
    faPrefix++;
    seen.set(id, (seen.get(id) || 0) + 1);

    const rawActive = row[isActiveCol];
    const s = String(rawActive ?? '').trim();
    if (s !== '0' && s !== '1' && rawActive !== 0 && rawActive !== 1) isActiveUnknown++;
  }

  const duplicateIds = [...seen.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  return { nonBlank, faPrefix, nonFaSamples, duplicateIds, isActiveUnknown };
}

function pushMgmToVPS() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const results = [];

  Object.entries(SHEET_BULAN_MAP).forEach(([sheetName, bulan]) => {
    const ws = ss.getSheetByName(sheetName);
    if (!ws) {
      Logger.log(`Sheet ${sheetName} tidak ditemukan, skip.`);
      return;
    }

    const lastRow = ws.getLastRow();
    if (lastRow < 3) {
      Logger.log(`${sheetName}: tidak ada data (lastRow=${lastRow})`);
      return;
    }

    // Baca semua data sekaligus (jauh lebih cepat dari row-by-row)
    const allData = ws.getDataRange().getValues();
    // Baris 1 (index 0) = header grup
    // Baris 2 (index 1) = header kolom
    // Baris 3+ (index 2+) = data

    // Audit SEBELUM dikirim — supaya selisih jumlah baris antara sheet
    // dan payload selalu tercatat di log, bukan cuma "keluar 675, entah
    // kenapa beda dari 630 di sheet".
    const auditAkt = auditBlock(allData, { idCol: 1, isActiveCol: 6 });
    const auditReg = auditBlock(allData, { idCol: 14, isActiveCol: 19 });
    Logger.log(`${sheetName} — AUDIT sebelum POST: ` +
      `aktivasi(nonBlank=${auditAkt.nonBlank}, faPrefix=${auditAkt.faPrefix}, ` +
      `bukanFA=${auditAkt.nonFaSamples.length}, duplikat=${auditAkt.duplicateIds.length}, ` +
      `isActiveUnknown=${auditAkt.isActiveUnknown}) | ` +
      `registrasi(nonBlank=${auditReg.nonBlank}, faPrefix=${auditReg.faPrefix}, ` +
      `bukanFA=${auditReg.nonFaSamples.length}, duplikat=${auditReg.duplicateIds.length}, ` +
      `isActiveUnknown=${auditReg.isActiveUnknown})`);
    if (auditAkt.nonFaSamples.length) Logger.log(`${sheetName} — sample id AKTIVASI bukan-FA: ${JSON.stringify(auditAkt.nonFaSamples)}`);
    if (auditReg.nonFaSamples.length) Logger.log(`${sheetName} — sample id REGISTRASI bukan-FA: ${JSON.stringify(auditReg.nonFaSamples)}`);
    if (auditAkt.duplicateIds.length) Logger.log(`${sheetName} — id AKTIVASI duplikat: ${JSON.stringify(auditAkt.duplicateIds)}`);
    if (auditReg.duplicateIds.length) Logger.log(`${sheetName} — id REGISTRASI duplikat: ${JSON.stringify(auditReg.duplicateIds)}`);

    const aktivasi   = [];
    const registrasi = [];

    for (let i = 2; i < allData.length; i++) {
      const row = allData[i];

      // ── BLOK AKTIVASI (kolom A–L = index 0–11) ──
      const aktIdOutlet = String(row[1] || '').trim();
      if (aktIdOutlet && aktIdOutlet.startsWith('FA')) {
        aktivasi.push({
          upline:           String(row[0]  || '').trim() || null,
          id_outlet:        aktIdOutlet,
          nama_pemilik:     String(row[2]  || '').trim() || null,
          tipe_outlet:      String(row[4]  || '').trim() || null,
          balance:          parseFloat(row[5])  || 0,
          // Kirim nilai MENTAH (bukan `parseInt(...) || 0`) — biarkan
          // backend (normalizeIsActive) yang memutuskan 0/1/unknown,
          // supaya sel kosong tidak diam-diam tercatat sebagai "belum aktif".
          is_active:        row[6],
          nama_kota:        String(row[7]  || '').trim() || null,
          nama_propinsi:    String(row[8]  || '').trim() || null,
          tanggal_aktifasi: formatTanggal(row[9]),
          trx:              parseInt(row[10])   || 0,
          rev:              parseFloat(row[11]) || 0,
        });
      }

      // ── BLOK REGISTRASI (kolom N–X = index 13–23) ──
      const regIdOutlet = String(row[14] || '').trim();
      if (regIdOutlet && regIdOutlet.startsWith('FA')) {
        registrasi.push({
          upline:             String(row[13] || '').trim() || null,
          id_outlet:          regIdOutlet,
          nama_pemilik:       String(row[15] || '').trim() || null,
          tipe_outlet:        String(row[17] || '').trim() || null,
          balance:            parseFloat(row[18]) || 0,
          is_active:          row[19],
          nama_kota:          String(row[20] || '').trim() || null,
          nama_propinsi:      String(row[21] || '').trim() || null,
          tanggal_registrasi: formatTanggal(row[22]),
          tanggal_aktifasi:   formatTanggal(row[23]),
        });
      }
    }

    Logger.log(`${sheetName}: ${aktivasi.length} aktivasi, ${registrasi.length} registrasi (setelah filter FA)`);

    // Kirim ke VPS
    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-sync-token': SYNC_TOKEN },
      payload: JSON.stringify({ bulan, aktivasi, registrasi }),
      muteHttpExceptions: true,
    };

    try {
      const resp   = UrlFetchApp.fetch(VPS_URL, options);
      const status = resp.getResponseCode();
      const body   = resp.getContentText();
      Logger.log(`${sheetName} → HTTP ${status}: ${body}`);
      results.push(`${sheetName}: ${body}`);
    } catch (e) {
      Logger.log(`ERROR ${sheetName}: ${e.message}`);
      results.push(`${sheetName}: ERROR — ${e.message}`);
    }
  });

  // Tampilkan ringkasan di alert (hanya saat run manual)
  try {
    SpreadsheetApp.getUi().alert('Sync MGM PA selesai:\n\n' + results.join('\n'));
  } catch (_) { /* trigger otomatis tidak punya UI */ }
}

// ── Format Date object → 'YYYY-MM-DD', null jika invalid ──
function formatTanggal(val) {
  if (!val) return null;
  if (val instanceof Date) {
    const y = val.getFullYear();
    if (y < 2000 || y > 2100) return null;
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

// ── Setup trigger harian jam 06.30 WIB (23.30 UTC) ──
function setupMgmTrigger() {
  // Hapus trigger lama jika ada
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'pushMgmToVPS')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('pushMgmToVPS')
    .timeBased()
    .atHour(23)
    .nearMinute(30)
    .everyDays(1)
    .create();

  Logger.log('Trigger MGM PA berhasil dibuat — jam 23:30 UTC (06:30 WIB)');
  SpreadsheetApp.getUi().alert('Trigger berhasil dibuat!\nPushMgmToVPS akan jalan tiap 06:30 WIB.');
}
