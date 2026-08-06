// ============================================================
// Apps Script: WAR-ROOM PA MPNG3 — Sync ke VPS
// Paste di Google Sheet: "Report MPNG3, PBB, PKB"
// https://docs.google.com/spreadsheets/d/1NoG1Zb2ZHNQU50YKS1EoUs_cxbUIX13O8oBJXKf6Jag
// ============================================================

const VPS_URL    = "https://bmsretail.my.id";
const SYNC_TOKEN = "bric2026bimasaktisecret";

// Mapping nama sheet ke bulan YYYY-MM — pakai tahun berjalan agar tidak
// perlu diubah tiap tahun. Sheet baru ditambahkan setiap bulan (mis.
// "September") — cukup pastikan namanya ada di daftar bulan Indonesia di
// bawah ini, tidak perlu ubah kode lain.
const _YEAR = new Date().getFullYear();
const BULAN_MAP = {
  "Januari":  `${_YEAR}-01`, "Februari": `${_YEAR}-02`, "Maret":     `${_YEAR}-03`,
  "April":    `${_YEAR}-04`, "Mei":      `${_YEAR}-05`, "Juni":      `${_YEAR}-06`,
  "Juli":     `${_YEAR}-07`, "Agustus":  `${_YEAR}-08`, "September": `${_YEAR}-09`,
  "Oktober":  `${_YEAR}-10`, "November": `${_YEAR}-11`, "Desember":  `${_YEAR}-12`,
};

// cleanNum — WAJIB cek typeof Number DULU sebelum string processing
// (Google Sheets getValues() mengembalikan JavaScript Number untuk cell
// numerik — insiden Speedcash historis: titik desimal number asli ikut
// terhapus 100x salah kalau diperlakukan sebagai string duluan).
function cleanNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;           // angka dari GSheet — gunakan langsung!
  const s   = String(v).replace(/Rp\s*/gi, '').trim();
  const neg = s.startsWith('(') && s.endsWith(')');
  const num = parseFloat(s.replace(/[()]/g, '').replace(/,/g, '')) || 0;
  return neg ? -num : num;
}

// parseDate — konversi date GSheet ke string "DD/MM/YYYY"
function parseDate(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const d = v.getDate(), m = v.getMonth() + 1, y = v.getFullYear();
    return `${d}/${m}/${y}`;
  }
  return String(v).trim();
}

// Tabel detail outlet: header di baris 14, data mulai baris 15, kolom A-N
// (14 kolom, sudah di-crosscheck terhadap screenshot sheet "Agustus"):
// A=upline, B=id_outlet, C=nama_pemilik, D=notelp_pemilik, E=tipe_outlet,
// F=nama_kota, G=tanggal_registrasi, H=tanggal_aktifasi,
// I=trx bulan lalu, J=rev bulan lalu, K=trx bulan ini, L=rev bulan ini,
// M=dev_trx, N=dev_rev
function rowToOutlet(row) {
  const idOutlet = String(row[1] || '').trim(); // col B = id_outlet
  if (!idOutlet) return null;
  return {
    id_outlet:          idOutlet,
    upline:             String(row[0] || '').trim(), // col A = upline
    nama_pemilik:       String(row[2] || '').trim(),
    notelp_pemilik:     String(row[3] || '').trim(),
    tipe_outlet:        String(row[4] || '').trim(),
    nama_kota:          String(row[5] || '').trim(),
    tanggal_registrasi: parseDate(row[6]),
    tanggal_aktifasi:   parseDate(row[7]),
    trx_prev:           Math.round(cleanNum(row[8])),
    rev_prev:           cleanNum(row[9]),
    trx_curr:           Math.round(cleanNum(row[10])),
    rev_curr:           cleanNum(row[11]),
    dev_trx:            Math.round(cleanNum(row[12])),
    dev_rev:            cleanNum(row[13]),
  };
}

function pushBulan(sheet, bulan) {
  const name      = sheet.getName();
  const lastRow   = sheet.getLastRow();
  if (lastRow < 15) {
    Logger.log(`[${name}] Tidak ada data outlet (lastRow=${lastRow})`);
    return;
  }

  // A15:N ke lastRow (row 14 = header, row 15 = data pertama)
  const data     = sheet.getRange(15, 1, lastRow - 14, 14).getValues();
  const outlets  = data.map(rowToOutlet).filter(Boolean);

  if (!outlets.length) {
    Logger.log(`[${name}] 0 outlet valid`);
    return;
  }

  Logger.log(`[${name}] Mengirim ${outlets.length} outlet, bulan ${bulan}...`);

  const payload = JSON.stringify({ bulan, outlets });
  const opts    = {
    method:      'post',
    contentType: 'application/json',
    payload,
    headers:     { 'x-sync-token': SYNC_TOKEN },
    muteHttpExceptions: true,
  };

  try {
    const res  = UrlFetchApp.fetch(`${VPS_URL}/api/warroom/mpng3/sync`, opts);
    const code = res.getResponseCode();
    const body = res.getContentText();
    Logger.log(`[${name}] HTTP ${code}: ${body}`);
  } catch(e) {
    Logger.log(`[${name}] ERROR: ${e.message}`);
  }
}

// ── Fungsi utama: sync SEMUA sheet yang ada di BULAN_MAP ──
function pushMpng3SemuaBulan() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  let synced = 0;

  for (const sheet of sheets) {
    const name  = sheet.getName().trim();
    const bulan = BULAN_MAP[name];
    if (!bulan) {
      Logger.log(`Skip sheet: ${name}`);
      continue;
    }
    pushBulan(sheet, bulan);
    synced++;
    Utilities.sleep(500); // jeda antar sheet agar VPS tidak kewalahan
  }
  Logger.log(`=== Selesai: ${synced} sheet diproses ===`);
}

// ── Fungsi kedua: sync HANYA sheet dengan nama bulan saat ini ──
function pushMpng3BulanIni() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  const bulan = `${year}-${String(month).padStart(2, '0')}`;

  // Cari nama sheet yang sesuai bulan ini
  const namaBulan = Object.entries(BULAN_MAP).find(([, v]) => v === bulan);
  if (!namaBulan) {
    Logger.log(`Tidak ada mapping untuk bulan ${bulan}`);
    return;
  }
  const sheetName = namaBulan[0];
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const sheet     = ss.getSheetByName(sheetName);
  if (!sheet) {
    Logger.log(`Sheet "${sheetName}" tidak ditemukan (sheet bulan ini belum dibuat?)`);
    return;
  }
  pushBulan(sheet, bulan);
}

// ── Setup trigger harian: jalankan pushMpng3BulanIni() tiap jam 23.00 UTC (06.00 WIB) ──
function setupMpng3Trigger() {
  // Hapus trigger lama jika ada
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'pushMpng3BulanIni')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // Buat trigger baru
  ScriptApp.newTrigger('pushMpng3BulanIni')
    .timeBased()
    .atHour(23)
    .everyDays(1)
    .create();

  Logger.log('Trigger harian pushMpng3BulanIni berhasil dibuat (23.00 UTC / 06.00 WIB)');
}
