// ═══════════════════════════════════════════════════════
// WAR-ROOM Ekspedisi — Apps Script (DINAMIS, baca blok bulan otomatis)
// Sheet ID : 1yVNeyHe3b_PLnFf3SGvLx3wuD4Gm3e6XItjiDADd_Lo
// Sheet tab : Ekspedisi
// Trigger   : pushEkspedisiToVPS() jam 23:30 UTC = 06:30 WIB
//
// GANTI dari versi lama: dulu kolom APR/MEI/JUN di-hardcode (col 0-2, 3-5,
// 6-8) — setiap bulan baru ditambahkan di sheet, sync diam-diam berhenti
// baca kolom baru itu (ini yang bikin dashboard "macet" di tanggal lama).
// Sekarang blok bulan di-scan otomatis dari baris label (baris 2), jadi
// kolom baru (JUL, AGT, dst) otomatis ke-detect tanpa ubah script lagi.
// ═══════════════════════════════════════════════════════

const VPS_URL   = 'https://bmsretail.my.id/api/warroom/ekspedisi/sync';
const VPS_TOKEN = 'bric2026bimasaktisecret';
const SHEET_ID  = '1yVNeyHe3b_PLnFf3SGvLx3wuD4Gm3e6XItjiDADd_Lo';

// Nama bulan (Indonesia + Inggris, berbagai singkatan) -> nomor bulan 1-12
const MONTH_ALIASES = {
  JAN: 1, JANUARI: 1,
  FEB: 2, FEBRUARI: 2,
  MAR: 3, MARET: 3,
  APR: 4, APRIL: 4,
  MEI: 5, MAY: 5,
  JUN: 6, JUNI: 6, JUNE: 6,
  JUL: 7, JULI: 7, JULY: 7,
  AGU: 8, AGT: 8, AGUSTUS: 8, AUG: 8,
  SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OKT: 10, OCT: 10, OKTOBER: 10,
  NOV: 11, NOVEMBER: 11,
  DES: 12, DEC: 12, DESEMBER: 12,
};

function monthNameToNum(label) {
  const key = String(label || '').trim().toUpperCase();
  return MONTH_ALIASES[key] || null;
}

function pushEkspedisiToVPS() {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Ekspedisi');

  if (!sheet) {
    Logger.log('ERROR: Sheet "Ekspedisi" tidak ditemukan!');
    return;
  }

  const data = sheet.getDataRange().getValues();

  // ── Struktur sheet ──
  //   Baris 1 (idx 0): header grup + "Day" + angka (info saja, tidak dikirim)
  //   Baris 2 (idx 1): label bulan di kolom pertama tiap blok (APR / MEI / JUN / JUL / ...)
  //   Baris 3 (idx 2): ID Outlet | Trx | Revenue | ID Outlet | Trx | Revenue | ...
  //   Baris 4+ (idx 3+): data outlet
  //   Tiap blok bulan = 3 kolom (ID, Trx, Revenue), blok baru ditambah ke kanan tiap bulan.

  // ── Deteksi blok bulan dari baris label (idx 1), stride 3 kolom ──
  const labelRow = data[1] || [];
  const headerRow = data[2] || [];
  const numCols = Math.max(labelRow.length, headerRow.length);

  const blocks = [];
  for (let c = 0; c < numCols; c += 3) {
    const label = String(labelRow[c] || '').trim();
    if (!label) continue;
    const monthNum = monthNameToNum(label);
    if (!monthNum) {
      Logger.log('WARNING: label bulan tidak dikenali di kolom ' + c + ': "' + label + '" — blok dilewati');
      continue;
    }
    blocks.push({ startCol: c, label: label, monthNum: monthNum });
  }

  if (!blocks.length) {
    Logger.log('ERROR: Tidak ada blok bulan terdeteksi di baris label (baris 2).');
    return;
  }

  // ── Assign tahun per blok — anchor: tahun HARI INI untuk blok paling kanan
  //    (terbaru), lalu mundur ke kiri. Kalau nomor bulan NAIK saat mundur ke
  //    kiri berarti baru saja lewat batas tahun (mis. blok kiri = Des,
  //    blok kanan = Jan) -> tahun blok kiri dikurangi 1. ──
  const today = new Date();
  const n = blocks.length;
  blocks[n - 1].year = today.getFullYear();
  for (let i = n - 2; i >= 0; i--) {
    blocks[i].year = blocks[i].monthNum > blocks[i + 1].monthNum
      ? blocks[i + 1].year - 1
      : blocks[i + 1].year;
  }
  blocks.forEach(b => { b.bulan = b.year + '-' + String(b.monthNum).padStart(2, '0'); });

  Logger.log('Blok bulan terdeteksi: ' + blocks.map(b => b.label + ' -> ' + b.bulan + ' (col ' + b.startCol + ')').join(', '));

  // ── Baca data outlet per blok (mulai baris 4 / idx 3) ──
  const monthMaps = blocks.map(() => ({}));

  for (let r = 3; r < data.length; r++) {
    const row = data[r];
    blocks.forEach((b, i) => {
      const id = String(row[b.startCol] || '').trim();
      if (!id) return;
      const trx = parseIntSafe(row[b.startCol + 1]);
      const rev = parseRevSafe(row[b.startCol + 2]);
      if (trx > 0 || rev > 0) monthMaps[i][id] = { trx: trx, rev: rev };
    });
  }

  const months = blocks.map((b, i) => ({
    bulan: b.bulan,
    rows: Object.keys(monthMaps[i]).map(id => ({
      id_outlet: id,
      trx: monthMaps[i][id].trx,
      revenue: monthMaps[i][id].rev,
    })),
  }));

  months.forEach(m => Logger.log('[' + m.bulan + '] ' + m.rows.length + ' outlet'));

  // ── Tanggal sync = hari ini - 1 (data kemarin) ──
  const syncDate = new Date();
  syncDate.setDate(syncDate.getDate() - 1);
  const tanggal = Utilities.formatDate(syncDate, 'Asia/Jakarta', 'yyyy-MM-dd');
  Logger.log('Tanggal sync: ' + tanggal);

  // ── POST ke VPS ──
  const body = JSON.stringify({
    tanggal: tanggal,
    months: months,
  });

  const options = {
    method: 'POST',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + VPS_TOKEN },
    payload: body,
    muteHttpExceptions: true,
  };

  try {
    const resp = UrlFetchApp.fetch(VPS_URL, options);
    const code = resp.getResponseCode();
    const text = resp.getContentText().substring(0, 500);
    Logger.log('Response ' + code + ': ' + text);

    if (code === 200) {
      Logger.log('✅ Sync berhasil! ' + blocks.length + ' blok bulan dikirim untuk tanggal ' + tanggal);
    } else {
      Logger.log('❌ Sync gagal. HTTP ' + code);
    }
  } catch (e) {
    Logger.log('❌ Error fetch: ' + e.message);
  }
}

// ── Setup trigger harian jam 06:30 WIB (23:30 UTC) ──
function setupEkspedisiTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'pushEkspedisiToVPS') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Trigger lama dihapus.');
    }
  });

  ScriptApp.newTrigger('pushEkspedisiToVPS')
    .timeBased()
    .atHour(23)
    .nearMinute(30)
    .everyDays(1)
    .create();

  Logger.log('✅ Trigger set: pushEkspedisiToVPS setiap hari 23:30 UTC (06:30 WIB)');
}

// ── Test manual — jalankan ini dulu untuk verifikasi ──
function testPushEkspedisi() {
  Logger.log('=== TEST MANUAL pushEkspedisiToVPS ===');
  pushEkspedisiToVPS();
  Logger.log('=== SELESAI ===');
}

// ── Lihat status trigger yang terpasang ──
function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('Tidak ada trigger aktif.');
    return;
  }
  triggers.forEach(t => {
    Logger.log(t.getHandlerFunction() + ' — ' + t.getTriggerSource());
  });
}

// ── Helper: parse integer aman ──
function parseIntSafe(val) {
  if (!val && val !== 0) return 0;
  return parseInt(String(val).replace(/[^0-9]/g, '')) || 0;
}

// ── Helper: parse revenue (boleh ada titik/koma ribuan) ──
function parseRevSafe(val) {
  if (!val && val !== 0) return 0;
  return parseInt(String(val).replace(/[^0-9]/g, '')) || 0;
}
