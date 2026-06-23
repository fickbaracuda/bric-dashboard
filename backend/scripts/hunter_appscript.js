// ============================================================
// BRIC Dashboard — WAR-ROOM Hunter Sync
// Spreadsheet: https://docs.google.com/spreadsheets/d/1WyYG0obpT0rGYlgsVlq6EO_6m4c5eTDethTEA09PNyU/
//
// Cara pakai:
// 1. Buka spreadsheet Hunter di atas
// 2. Extensions → Apps Script
// 3. Hapus semua kode lama, paste kode ini
// 4. Klik Save (Ctrl+S)
// 5. Jalankan: syncHunterData()
// 6. Klik "Review permissions" → lanjutkan
//
// Sheet yang dibaca: D.1, D.2, D.3
// Script otomatis detect bulan dari kolom "Tgl Reg" di D.1
// ============================================================

var VPS_URL    = 'https://bmsretail.my.id/api/warroom/hunter/sync';
var SYNC_TOKEN = 'bric2026bimasaktisecret';

// ── Entry point ───────────────────────────────────────────────────────────
function syncHunterData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Baca ketiga sheet
  var s1 = ss.getSheetByName('D.1');
  var s2 = ss.getSheetByName('D.2');
  var s3 = ss.getSheetByName('D.3');

  if (!s1) { SpreadsheetApp.getUi().alert('❌ Sheet "D.1" tidak ditemukan!'); return; }
  if (!s2) { SpreadsheetApp.getUi().alert('❌ Sheet "D.2" tidak ditemukan!'); return; }
  if (!s3) { SpreadsheetApp.getUi().alert('❌ Sheet "D.3" tidak ditemukan!'); return; }

  SpreadsheetApp.getActiveSpreadsheet().toast('Membaca data...', 'Hunter Sync', 5);

  var d1 = readSheet(s1);
  var d2 = readSheet(s2);
  var d3 = readSheet(s3);

  if (d1.length === 0) { SpreadsheetApp.getUi().alert('❌ Sheet D.1 kosong atau tidak ada data.'); return; }

  // ── Auto-detect bulan dari kolom "Tgl Reg" di D.1 ──────────────────────
  var bulan = detectBulan(d1);

  if (!bulan) {
    // Fallback: minta input manual
    var input = Browser.inputBox(
      'Tidak bisa auto-detect bulan dari data D.1.\n\nMasukkan bulan (format YYYY-MM, contoh: 2026-05):',
      Browser.Buttons.OK_CANCEL
    );
    if (input === 'cancel' || !input || !input.match(/^\d{4}-\d{2}$/)) {
      SpreadsheetApp.getUi().alert('❌ Format bulan tidak valid. Harus YYYY-MM (contoh: 2026-05).');
      return;
    }
    bulan = input;
  }

  // ── Konfirmasi sebelum sync ─────────────────────────────────────────────
  var ui  = SpreadsheetApp.getUi();
  var msg = 'Konfirmasi Sync Hunter\n\n' +
            'Bulan  : ' + bulan + '\n' +
            'D.1    : ' + d1.length + ' baris (register/downline)\n' +
            'D.2    : ' + d2.length + ' baris (transaksi & margin)\n' +
            'D.3    : ' + d3.length + ' baris (aktivasi)\n\n' +
            'Data lama bulan ini akan DIGANTI. Lanjutkan?';

  var resp = ui.alert('🎯 Hunter Sync', msg, ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) { ui.alert('Dibatalkan.'); return; }

  // ── Kirim ke VPS ────────────────────────────────────────────────────────
  SpreadsheetApp.getActiveSpreadsheet().toast('Mengirim data ke server...', 'Hunter Sync', 30);

  var payload = JSON.stringify({
    token: SYNC_TOKEN,
    bulan: bulan,
    d1:    d1,
    d2:    d2,
    d3:    d3
  });

  try {
    var options = {
      method:           'post',
      contentType:      'application/json',
      payload:          payload,
      muteHttpExceptions: true,
      followRedirects:  true
    };

    var response  = UrlFetchApp.fetch(VPS_URL, options);
    var code      = response.getResponseCode();
    var bodyText  = response.getContentText();

    if (code !== 200) {
      ui.alert('❌ HTTP ' + code + '\n\n' + bodyText.slice(0, 500));
      return;
    }

    var body = JSON.parse(bodyText);

    if (body.ok) {
      ui.alert(
        '✅ Sync Berhasil!\n\n' +
        'Bulan   : ' + body.bulan + '\n' +
        'D.1     : ' + body.d1_rows + ' baris\n' +
        'D.2     : ' + body.d2_rows + ' baris\n' +
        'D.3     : ' + body.d3_rows + ' baris\n' +
        'Durasi  : ' + body.duration_ms + ' ms\n\n' +
        'Dashboard sudah terupdate.'
      );
    } else {
      ui.alert('❌ Server error:\n\n' + JSON.stringify(body, null, 2).slice(0, 500));
    }

  } catch (e) {
    ui.alert('❌ Exception:\n\n' + e.message);
  }
}

// ── Baca sheet → array of objects ─────────────────────────────────────────
function readSheet(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow < 2 || lastCol < 1) return [];

  var data    = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = data[0].map(function(h) { return String(h).trim(); });

  // Index kolom yang punya header
  var validIdx = [];
  headers.forEach(function(h, i) { if (h) validIdx.push(i); });
  var cleanHdr = validIdx.map(function(i) { return headers[i]; });

  var rows = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];

    // Skip baris kosong
    var hasValue = validIdx.some(function(i) {
      return row[i] !== '' && row[i] !== null && row[i] !== undefined;
    });
    if (!hasValue) continue;

    var obj = {};
    validIdx.forEach(function(colIdx, ci) {
      var v = row[colIdx];
      if (v instanceof Date) {
        // Format tanggal → YYYY-MM-DD
        v = Utilities.formatDate(v, 'Asia/Jakarta', 'yyyy-MM-dd');
      } else if (v === undefined || v === null) {
        v = '';
      }
      obj[cleanHdr[ci]] = v;
    });

    rows.push(obj);
  }

  return rows;
}

// ── Auto-detect bulan dari kolom "Tgl Reg" di D.1 ─────────────────────────
function detectBulan(d1Rows) {
  var monthCount = {};

  d1Rows.forEach(function(row) {
    // Coba kolom "Tgl Reg" (nama persis di sheet)
    var tgl = row['Tgl Reg'] || row['tgl_reg'] || row['Tgl reg'] || '';
    var str = String(tgl).trim();

    // Format YYYY-MM-DD
    var m1 = str.match(/^(\d{4})-(\d{2})-\d{2}$/);
    if (m1) {
      var key = m1[1] + '-' + m1[2];
      monthCount[key] = (monthCount[key] || 0) + 1;
      return;
    }

    // Format DD/MM/YYYY atau DD-MM-YYYY
    var m2 = str.match(/^\d{1,2}[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m2) {
      var key2 = m2[2] + '-' + m2[1].padStart(2, '0');
      monthCount[key2] = (monthCount[key2] || 0) + 1;
    }
  });

  var entries = Object.entries(monthCount);
  if (entries.length === 0) return null;

  // Ambil bulan yang paling banyak muncul
  entries.sort(function(a, b) { return b[1] - a[1]; });
  return entries[0][0];
}

// ── Helper: tambah menu di spreadsheet ───────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎯 Hunter Sync')
    .addItem('Sync ke Dashboard', 'syncHunterData')
    .addToUi();
}
