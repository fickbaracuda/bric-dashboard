/**
 * WAR-ROOM Payment Agent > Farming — Apps Script sumber data (Farming Fastpay
 * Command Center).
 *
 * Sheet sumber: spreadsheet 1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw, tab "Farming".
 * (Spreadsheet ini DIBAGI dengan menu Payment Agent > Produk — tab "Produk" —
 * lihat apps-script-payment-agent-produk.js. KEDUANYA aman berjalan di
 * project Apps Script yang sama karena semua nama fungsi & Script Property
 * di file ini unik dengan prefix "Farming"/"farm_", dan removeFarmingTriggers()
 * HANYA menghapus trigger dengan handler function miliknya sendiri — TIDAK
 * PERNAH memanggil ScriptApp.getProjectTriggers().forEach(...deleteTrigger)
 * tanpa filter, supaya trigger Produk tidak ikut terhapus.)
 *
 * Endpoint tujuan: POST /api/warroom/farming/sync
 *
 * BEDA DARI apps-script-payment-agent-produk.js: parser header TIDAK ada di
 * sini. File ini HANYA mengirim header asli (row) + baris data mentah — semua
 * interpretasi header (mana kolom Full/Previous/Current, bulan apa, dst) ada
 * di backend (backend/src/farming/headerParser.js). Ini supaya perubahan
 * bulan tidak pernah butuh perubahan kode di kedua sisi sekaligus.
 *
 * CARA PAKAI:
 *   1. Copy-paste seluruh file ini ke Google Apps Script Editor pada
 *      spreadsheet di atas (Extensions > Apps Script) — boleh di project yang
 *      sama dengan apps-script-payment-agent-produk.js.
 *   2. Set Script Properties (Project Settings > Script Properties):
 *        FARMING_SYNC_TOKEN = <token yang sama dengan server, BEDA dari token Produk>
 *        FARMING_SYNC_URL   = https://bmsretail.my.id/api/warroom/farming/sync
 *      JANGAN hardcode token di kode ini.
 *   3. Jalankan previewFarmingPayload() dulu, cek log: jumlah header, jumlah
 *      baris data, sample baris, day_metadata (kalau ketemu).
 *   4. Kalau preview terlihat wajar, jalankan pushFarmingSemua() SATU KALI.
 *   5. JANGAN memanggil setupFarmingTrigger() dulu — trigger otomatis baru
 *      diaktifkan setelah disetujui eksplisit terpisah.
 */

const FARM_SHEET_NAME = 'Farming';
const FARM_DEFAULT_URL = 'https://bmsretail.my.id/api/warroom/farming/sync';
const FARM_HANDLER_FUNCTION = 'pushFarmingSemua';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function farm_findHeaderRow_(displayValues) {
  for (let r = 0; r < Math.min(displayValues.length, 15); r++) {
    for (let c = 0; c < displayValues[r].length; c++) {
      if (/^id\s*outlet$/i.test(String(displayValues[r][c] || '').trim())) {
        return r;
      }
    }
  }
  return -1;
}

function farm_extractDayMetadata_(values) {
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < values[r].length; c++) {
      const cell = values[r][c];
      if (cell === null || cell === undefined) continue;
      const m = /Day\s*:?\s*(\d+)/i.exec(String(cell));
      if (m) return parseInt(m[1], 10);
    }
  }
  return null;
}

function farm_todayJakartaIso_() {
  return Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
}

/**
 * Bangun payload sync: header asli + baris data mentah (tanpa interpretasi).
 * Baris dianggap akhir data begitu SELURUH sel di baris tersebut kosong.
 */
function farm_buildPayload_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(FARM_SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${FARM_SHEET_NAME}" tidak ditemukan.`);

  const range = sheet.getDataRange();
  const values = range.getValues();
  const displayValues = range.getDisplayValues();

  const headerRowIdx = farm_findHeaderRow_(displayValues);
  if (headerRowIdx === -1) {
    throw new Error('Baris header (kolom "ID Outlet") tidak ditemukan di 15 baris pertama.');
  }

  const headers = values[headerRowIdx].map(v => String(v || '').trim());
  // Buang kolom kosong di ujung kanan (sheet sering punya sel kosong ekstra)
  while (headers.length && !headers[headers.length - 1]) headers.pop();

  const dataRows = [];
  for (let r = headerRowIdx + 1; r < values.length; r++) {
    const row = values[r].slice(0, headers.length);
    const isEmpty = row.every(cell => cell === '' || cell === null || cell === undefined);
    if (isEmpty) continue;
    dataRows.push(row);
  }

  const dayMetadata = farm_extractDayMetadata_(values.slice(0, headerRowIdx + 1));

  return {
    snapshot_date: farm_todayJakartaIso_(),
    synced_at: new Date().toISOString(),
    spreadsheet_id: ss.getId(),
    sheet_name: FARM_SHEET_NAME,
    day_metadata: dayMetadata,
    headers,
    rows: dataRows,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Fungsi publik
// ─────────────────────────────────────────────────────────────────────────
function previewFarmingPayload() {
  const payload = farm_buildPayload_();

  Logger.log('=== PREVIEW Farming Command Center ===');
  Logger.log('snapshot_date: %s', payload.snapshot_date);
  Logger.log('day_metadata: %s', payload.day_metadata);
  Logger.log('headers (%s): %s', payload.headers.length, JSON.stringify(payload.headers));
  Logger.log('jumlah baris data: %s', payload.rows.length);
  Logger.log('sample baris pertama: %s', JSON.stringify(payload.rows[0] || null));
  Logger.log('sample baris kedua: %s', JSON.stringify(payload.rows[1] || null));

  if (!payload.rows.length) {
    Logger.log('[PERHATIAN] Tidak ada baris data — JANGAN jalankan pushFarmingSemua() sebelum ini diperbaiki.');
  } else {
    Logger.log('[OK] Preview terlihat wajar. Header & jumlah baris akan divalidasi ulang oleh backend saat sync (lihat response HTTP kalau ada error).');
  }
  return payload;
}

function pushFarmingSemua() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('FARMING_SYNC_TOKEN');
  const url = props.getProperty('FARMING_SYNC_URL') || FARM_DEFAULT_URL;

  if (!token) {
    Logger.log('[STOP] Script Property FARMING_SYNC_TOKEN belum diset. Sync dibatalkan.');
    return;
  }

  const payload = farm_buildPayload_();
  if (!payload.rows.length) {
    Logger.log('[STOP] Tidak ada baris data — jalankan previewFarmingPayload() dulu dan perbaiki sheet/parser sebelum push.');
    return;
  }

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-sync-token': token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  Logger.log('HTTP status: %s', response.getResponseCode());
  Logger.log('Response: %s', response.getContentText());
}

function setupFarmingTrigger() {
  removeFarmingTriggers();
  ScriptApp.newTrigger(FARM_HANDLER_FUNCTION)
    .timeBased()
    .everyDays(1)
    .atHour(23) // 23:00 UTC = 06:00 WIB, konsisten dengan trigger war-room lain
    .create();
  Logger.log('Trigger harian %s() terpasang (23:00 UTC / 06:00 WIB).', FARM_HANDLER_FUNCTION);
}

/**
 * HANYA menghapus trigger dengan handler function miliknya sendiri
 * (pushFarmingSemua). TIDAK PERNAH menghapus semua trigger project — kalau
 * project Apps Script ini dipakai bersama dengan Payment Agent Produk,
 * trigger pushPaymentAgentProdukSemua() TIDAK BOLEH ikut terhapus.
 */
function removeFarmingTriggers() {
  const farmingHandlers = new Set([FARM_HANDLER_FUNCTION]);
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (farmingHandlers.has(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  Logger.log('%s trigger %s() dihapus.', removed, FARM_HANDLER_FUNCTION);
}
