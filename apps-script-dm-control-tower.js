// ============================================================
// Apps Script: DM Control Tower — Sync ke VPS (Prompt 2 dari 3)
// Paste di Google Sheet:
// https://docs.google.com/spreadsheets/d/13fTIQ2OSv4a5jXNo6PpochlRvVXf-Hi3SHpSsUrXbV8
//
// Sheet yang dibaca (SATU-SATUNYA source of truth, sheet lain hanya referensi):
//   - 01_CONFIG               -> bulan, period_start, period_end, mature_cohort_end
//   - 03_RAW_REGISTER_DIRECT  -> POST .../dm-control-tower/register/sync
//   - 04_RAW_AKTIVASI_DIRECT  -> POST .../dm-control-tower/aktivasi/sync
//   - 02_RAW_TRX_DIRECT       -> POST .../dm-control-tower/trx/sync
//
// KEAMANAN:
//   - Token TIDAK ditulis di kode ini. Isi lewat Script Properties (Apps
//     Script Editor > ikon gerigi "Project Settings" > "Script Properties" >
//     "Add script property" > key `SYNC_TOKEN`, value = token asli, sama
//     dengan env `APPS_SCRIPT_TOKEN` di server) SEBELUM menjalankan fungsi
//     apa pun — lihat getSyncToken() di bawah. JANGAN commit token asli ke
//     git manapun, JANGAN tulis token asli di dokumentasi/screenshot/chat.
//   - Semua log (Logger.log) di file ini SENGAJA tidak pernah mencetak SYNC_TOKEN
//     atau isi payload mentah — hanya bulan/sheet/jumlah baris/status HTTP.
//
// CHUNK SAFETY (penting, jangan diubah tanpa paham konsekuensinya):
//   Backend men-delete SELURUH data 1 bulan lalu insert ulang tiap kali endpoint
//   sync dipanggil. Kalau 1 sheet dikirim dalam beberapa request (chunk) karena
//   baris terlalu banyak, chunk terakhir BISA menghapus hasil insert chunk
//   sebelumnya kalau tidak ditangani. Untuk itu backend (lihat
//   backend/src/routes/warroom-dm-control-tower.js) sudah diperbarui mendukung
//   field `replace_mode`:
//     - chunk pertama  -> replace_mode: "replace" (hapus data bulan ini, lalu insert)
//     - chunk berikutnya -> replace_mode: "append" (HANYA insert/upsert, tidak menghapus)
//   Skrip ini SELALU mengirim replace_mode sesuai posisi chunk — jangan panggil
//   endpoint sync manual (curl/Postman) dengan urutan chunk yang salah, karena
//   itu bisa menghapus data yang belum sempat di-insert ulang.
//
// BUG YANG SUDAH DIPERBAIKI DI BACKEND (Prompt 2, setelah cek header sheet asli):
//   - Sheet 04_RAW_AKTIVASI_DIRECT pakai header "tanggal_aktifasi" (ejaan
//     dengan huruf F, bukan V) — sudah ditambahkan ke kandidat backend.
//   - Sheet 02_RAW_TRX_DIRECT pakai header "achieve_trx" (jumlah transaksi)
//     dan "achieve_rev" (margin/omzet), BUKAN "trx"/"margin" — sudah
//     ditambahkan ke kandidat backend. Tanpa perbaikan ini, seluruh baris
//     transaksi akan tersimpan dengan trx_count=0 dan margin=0.
//   Skrip ini TIDAK mengubah/rename nama kolom apa pun (dikirim apa adanya
//   sesuai header sheet) — perbaikannya murni di sisi backend (pemetaan nama
//   kolom -> field), bukan di Apps Script ini.
//
// CATATAN TERBUKA (belum diputuskan, dilaporkan ke pemilik produk, TIDAK
// diubah sepihak di Prompt 2 ini):
//   01_CONFIG menghitung "Mature Cohort End" secara DINAMIS dari tanggal
//   transaksi/aktivasi terakhir yang benar-benar ada di data (bisa melewati
//   akhir kalender bulan, mis. bulan "2026-06" tapi Mature Cohort End
//   "2026-06-29" dihitung dari Max Transaction Date "2026-07-02"). Backend
//   Prompt 1 MENGHITUNG SENDIRI mature_cohort_end murni dari kalender bulan
//   (akhir bulan - 3 hari) dan MENGABAIKAN field period_start/period_end/
//   mature_cohort_end yang dikirim di payload ini (field tsb tetap dikirim
//   sesuai spesifikasi, hanya untuk arsip/referensi, belum dipakai backend).
//   Kalau ke depannya mau backend ikut logika dinamis sheet ini, itu perlu
//   perubahan tersendiri yang harus disetujui dulu — BUKAN dilakukan diam-diam.
//
// Trigger otomatis SENGAJA belum diaktifkan (lihat setupDmControlTowerTrigger).
// Jalankan sync manual dulu, verifikasi hasilnya di dashboard, baru pertimbangkan
// mengaktifkan trigger setelah stabil.
// ============================================================

const VPS_URL = 'https://bmsretail.my.id';

// SYNC_TOKEN dibaca dari Script Properties (Project Settings > Script
// Properties di Apps Script Editor), BUKAN ditulis langsung di kode ini —
// supaya token asli tidak pernah ikut ter-commit ke Git kalau file ini
// suatu saat disalin balik ke repo. Cara isi:
//   1. Di Apps Script Editor, klik ikon gerigi (Project Settings) di kiri.
//   2. Scroll ke "Script Properties" > "Add script property".
//   3. Property: SYNC_TOKEN   Value: (token asli, sama dengan APPS_SCRIPT_TOKEN di server)
//   4. Simpan.
// Kalau property belum diisi, fungsi akan STOP dengan pesan error jelas
// (lihat getSyncToken()) — tidak pernah mencoba sync dengan token kosong.
function getSyncToken() {
  const token = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  if (!token) {
    throw new Error(
      'SYNC_TOKEN belum diisi di Script Properties (Project Settings > Script Properties). ' +
      'Sync dibatalkan — isi dulu sebelum menjalankan pushDmControlTowerSemua().'
    );
  }
  return token;
}

const CONFIG_SHEET_NAME = '01_CONFIG';

// Ukuran chunk per request — di rentang rekomendasi 3000-5000 baris.
// Turunkan kalau ternyata payload masih dianggap terlalu besar oleh Nginx/server.
const CHUNK_SIZE = 4000;

const SOURCE_META = {
  register: {
    sheetName: '03_RAW_REGISTER_DIRECT',
    endpoint: '/api/warroom/dm-control-tower/register/sync',
    dateFieldCandidates: ['tanggal_registrasi', 'tanggal_register'],
  },
  aktivasi: {
    sheetName: '04_RAW_AKTIVASI_DIRECT',
    endpoint: '/api/warroom/dm-control-tower/aktivasi/sync',
    dateFieldCandidates: ['tanggal_aktifasi', 'tanggal_aktivasi'],
  },
  trx: {
    sheetName: '02_RAW_TRX_DIRECT',
    endpoint: '/api/warroom/dm-control-tower/trx/sync',
    dateFieldCandidates: ['tanggal_transaksi'],
    numericFieldCandidates: ['achieve_trx', 'trx', 'achieve_rev', 'margin', 'revenue'],
  },
};

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function normalizeConfigKey(k) {
  return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Header dipakai APA ADANYA (hanya di-trim) — jangan pernah ganti nama kolom. */
function normalizeHeader(header) {
  return String(header || '').trim();
}

/**
 * Konversi value tanggal ke "YYYY-MM-DD". PENTING: untuk Date object, pakai
 * getFullYear()/getMonth()/getDate() (komponen LOKAL sesuai timezone project
 * Apps Script), BUKAN toISOString() — toISOString() konversi ke UTC dan bisa
 * menggeser tanggal mundur 1 hari untuk cell yang sebenarnya tanggal-saja
 * (mis. tengah malam WIB jadi jam 17:00 UTC hari sebelumnya).
 */
function toIsoDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return s; // biarkan apa adanya — backend yang akan coba parse / tandai invalid
}

/**
 * Number parser aman — WAJIB cek typeof number DULU sebelum string processing.
 * (Insiden lama: angka desimal diperlakukan sebagai string lalu titik
 * desimalnya kehapus jadi 100x lebih besar. Lihat catatan di CLAUDE.md.)
 * Fungsi ini hanya dipakai untuk cek kualitas data (logFieldCoverage) sebelum
 * kirim — nilai ASLI yang dikirim ke backend tetap raw (lihat getSheetRows),
 * bukan hasil cleanNum ini.
 */
function cleanNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/Rp\s*/gi, '').trim();
  if (!s) return 0;
  const neg = s.startsWith('(') && s.endsWith(')');
  const cleaned = s.replace(/[()]/g, '').replace(/,/g, '');
  const num = parseFloat(cleaned) || 0;
  return neg ? -num : num;
}

function isEmptyRow(row) {
  return Object.keys(row).every((k) => {
    const v = row[k];
    return v === null || v === undefined || String(v).trim() === '';
  });
}

function chunkArray(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

/**
 * Baca 1 sheet raw berdasarkan header row (baris 1). Header dipakai apa
 * adanya sebagai key object (hanya di-trim) — nama kolom TIDAK diganti.
 * Kolom tanpa nama header (kolom kosong ekstra di sheet) dilewati. Date
 * object dikonversi ke "YYYY-MM-DD" via toIsoDate(); tipe lain (number,
 * string) dikirim apa adanya supaya backend yang membersihkan (cleanNum di
 * backend sudah aman untuk kedua tipe).
 */
function getSheetRows(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" tidak ditemukan di spreadsheet ini`);

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return [];

  const rawHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const headers = rawHeaders.map(normalizeHeader);
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const rows = [];
  for (const dataRow of data) {
    const obj = {};
    headers.forEach((h, i) => {
      if (!h) return; // skip kolom tanpa nama header
      const v = dataRow[i];
      obj[h] = (v instanceof Date) ? toIsoDate(v) : v;
    });
    if (isEmptyRow(obj)) continue; // skip baris kosong total / sisa baris formula kosong
    rows.push(obj);
  }
  return rows;
}

/**
 * Baca sheet 01_CONFIG (format: kolom A=Parameter, B=Value, C=Definition;
 * baris 1 header, data mulai baris 2 — sesuai sheet produksi saat ini).
 * Kalau config tidak ditemukan / tidak valid: STOP total (throw), tidak
 * pernah lanjut sync dengan bulan tebakan/kosong.
 */
function readConfig() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) {
    throw new Error(`Sheet "${CONFIG_SHEET_NAME}" tidak ditemukan — sync dibatalkan (config wajib ada sebelum sync jalan)`);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error(`Sheet "${CONFIG_SHEET_NAME}" kosong — sync dibatalkan`);
  }

  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const map = {};
  data.forEach(([label, value]) => {
    const key = normalizeConfigKey(label);
    if (key) map[key] = value;
  });

  const periodStart = toIsoDate(map['periodstart']);
  const periodEnd = toIsoDate(map['periodend']);
  const matureCohortEnd = toIsoDate(map['maturecohortend']);

  let bulan = String(map['bulan'] || '').trim();
  if (!/^\d{4}-\d{2}$/.test(bulan)) {
    if (periodStart && /^\d{4}-\d{2}-\d{2}$/.test(periodStart)) {
      bulan = periodStart.slice(0, 7);
      Logger.log(`[readConfig] Key "Bulan" tidak ada/tidak valid di ${CONFIG_SHEET_NAME}, infer dari Period Start -> bulan=${bulan}`);
    } else {
      throw new Error(
        `Sheet "${CONFIG_SHEET_NAME}" tidak punya "Bulan" yang valid (format YYYY-MM) maupun ` +
        `"Period Start" yang bisa dipakai untuk infer bulan — sync dibatalkan. Cek isi sheet config.`
      );
    }
  }

  return { bulan, periodStart, periodEnd, matureCohortEnd };
}

/** POST JSON ke backend. TIDAK PERNAH log payload/token — hanya code+body respons. */
function postJson(url, payload) {
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: { 'x-sync-token': getSyncToken() }, // token juga disertakan di body payload.token
    muteHttpExceptions: true,
  };
  const res = UrlFetchApp.fetch(url, options);
  return { code: res.getResponseCode(), body: res.getContentText() };
}

/**
 * Cek proporsi baris yang punya nilai di salah satu kolom kandidat (dipakai
 * untuk mendeteksi dini kalau header sheet berubah nama dan backend jadi
 * tidak mengenalinya lagi — persis kasus "tanggal_aktifasi"/"achieve_trx"/
 * "achieve_rev" yang ditemukan saat membangun skrip ini). Hanya Logger.log,
 * tidak menghentikan proses — supaya sync tetap tercatat di dm_ct_sync_log
 * untuk investigasi lebih lanjut.
 */
function logFieldCoverage(sheetName, rows, label, candidateNames) {
  if (!rows.length) return;
  const normCandidates = candidateNames.map(normalizeConfigKey);
  let matched = 0;
  rows.forEach((row) => {
    const hit = Object.keys(row).some((k) => {
      if (!normCandidates.includes(normalizeConfigKey(k))) return false;
      const v = row[k];
      return v !== null && v !== undefined && String(v).trim() !== '';
    });
    if (hit) matched++;
  });
  const pct = Math.round((matched / rows.length) * 100);
  const line = `[${sheetName}] cek kolom "${label}": ${matched}/${rows.length} baris (${pct}%) punya nilai`;
  if (pct < 90) {
    Logger.log(`PERINGATAN — ${line}. Kemungkinan nama header di sheet berubah/tidak dikenali backend — cek ulang sebelum lanjut sync!`);
  } else {
    Logger.log(line);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SYNC FLOW
// ═══════════════════════════════════════════════════════════════════════

function pushSource(sourceKey) {
  const meta = SOURCE_META[sourceKey];
  if (!meta) throw new Error(`Source key tidak dikenal: ${sourceKey}`);

  getSyncToken(); // gagal cepat & jelas kalau Script Property belum diisi, sebelum baca/kirim apa pun
  const config = readConfig(); // throw & stop kalau config tidak valid — tidak pernah sync tanpa bulan
  const rows = getSheetRows(meta.sheetName);

  Logger.log(`[${meta.sheetName}] bulan=${config.bulan}: ${rows.length} baris dibaca (setelah skip baris kosong)`);

  if (!rows.length) {
    Logger.log(`[${meta.sheetName}] 0 baris valid — TIDAK ADA yang dikirim. Data bulan ${config.bulan} yang sudah ada di server tidak diubah/dihapus.`);
    return { sheetName: meta.sheetName, bulan: config.bulan, dibaca: 0, dikirim: 0, chunks: 0, ok: true };
  }

  logFieldCoverage(meta.sheetName, rows, 'tanggal utama', meta.dateFieldCandidates);
  if (meta.numericFieldCandidates) {
    logFieldCoverage(meta.sheetName, rows, 'angka trx/margin', meta.numericFieldCandidates);
  }

  const chunks = chunkArray(rows, CHUNK_SIZE);
  let allOk = true;
  let lastError = null;

  chunks.forEach((chunk, idx) => {
    // Chunk safety: HANYA chunk pertama yang boleh replace (hapus lalu insert).
    // Chunk berikutnya WAJIB append (insert/upsert saja, tidak pernah hapus).
    const replaceMode = idx === 0 ? 'replace' : 'append';
    const payload = {
      token: getSyncToken(),
      bulan: config.bulan,
      sheet_name: meta.sheetName,
      period_start: config.periodStart,
      period_end: config.periodEnd,
      mature_cohort_end: config.matureCohortEnd,
      replace_mode: replaceMode,
      chunk_index: idx + 1,
      chunk_total: chunks.length,
      rows: chunk,
    };
    try {
      const result = postJson(`${VPS_URL}${meta.endpoint}`, payload);
      Logger.log(`[${meta.sheetName}] chunk ${idx + 1}/${chunks.length} (${replaceMode}, ${chunk.length} baris): HTTP ${result.code} — ${result.body}`);
      if (result.code < 200 || result.code >= 300) { allOk = false; lastError = `HTTP ${result.code}`; }
    } catch (e) {
      allOk = false;
      lastError = e.message;
      Logger.log(`[${meta.sheetName}] chunk ${idx + 1}/${chunks.length} ERROR: ${e.message}`);
    }
    if (idx < chunks.length - 1) Utilities.sleep(500); // jeda antar chunk supaya backend tidak kewalahan
  });

  return { sheetName: meta.sheetName, bulan: config.bulan, dibaca: rows.length, dikirim: rows.length, chunks: chunks.length, ok: allOk, error: lastError };
}

function pushDmControlTowerRegister() { return pushSource('register'); }
function pushDmControlTowerAktivasi() { return pushSource('aktivasi'); }
function pushDmControlTowerTrx()      { return pushSource('trx'); }

/** Sync register + aktivasi + transaksi berurutan, lalu tampilkan ringkasan. */
function pushDmControlTowerSemua() {
  Logger.log('=== DM Control Tower: mulai sync register + aktivasi + transaksi ===');
  const order = ['register', 'aktivasi', 'trx'];
  const results = [];

  order.forEach((key, i) => {
    try {
      results.push(pushSource(key));
    } catch (e) {
      Logger.log(`[${SOURCE_META[key].sheetName}] GAGAL TOTAL: ${e.message}`);
      results.push({ sheetName: SOURCE_META[key].sheetName, error: e.message, ok: false });
    }
    if (i < order.length - 1) Utilities.sleep(500);
  });

  Logger.log('=== Ringkasan DM Control Tower ===');
  results.forEach((r) => {
    if (r.error && !r.dikirim) {
      Logger.log(`- ${r.sheetName}: GAGAL — ${r.error}`);
    } else {
      Logger.log(`- ${r.sheetName}: bulan=${r.bulan}, dibaca=${r.dibaca}, dikirim=${r.dikirim}, chunk=${r.chunks}, status=${r.ok ? 'OK' : 'ADA ERROR (' + r.error + ')'}`);
    }
  });
}

// ── Setup trigger harian — JANGAN dipanggil sekarang, siapkan saja ──
// Jalankan manual hanya kalau dashboard & sync manual sudah diverifikasi stabil.
function setupDmControlTowerTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'pushDmControlTowerSemua')
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('pushDmControlTowerSemua')
    .timeBased()
    .atHour(23) // 23:00 UTC = 06:00 WIB, pola sama seperti WAR-ROOM lain
    .everyDays(1)
    .create();

  Logger.log('Trigger harian pushDmControlTowerSemua berhasil dibuat (23:00 UTC / 06:00 WIB). ' +
    'PERINGATAN: fungsi ini sengaja TIDAK dipanggil otomatis — jalankan manual hanya setelah ' +
    'dashboard & hasil sync sudah diverifikasi stabil.');
}
