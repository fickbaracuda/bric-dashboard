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
// Sheet yang dibaca:
//   D.1 = data Mei (referensi registrasi, tidak berubah)
//   D.2 = data transaksi bulan berjalan (Juni, dst)
//   D.3 = data aktivasi bulan berjalan (Juni, dst)
//
// "Bulan Laporan" = bulan D.2 & D.3 (default: bulan ini)
// ============================================================

var VPS_URL    = 'https://bmsretail.my.id/api/warroom/hunter/sync';
var SYNC_TOKEN = 'bric2026bimasaktisecret';

// ── Helper: bulan saat ini format YYYY-MM ──────────────────────────────────
function getCurrentBulan() {
  var now = new Date();
  var y   = now.getFullYear();
  var m   = String(now.getMonth() + 1).padStart(2, '0');
  return y + '-' + m;
}

// ── Entry point ───────────────────────────────────────────────────────────
function syncHunterData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  // Baca ketiga sheet
  var s1 = ss.getSheetByName('D.1');
  var s2 = ss.getSheetByName('D.2');
  var s3 = ss.getSheetByName('D.3');

  if (!s1) { ui.alert('❌ Sheet "D.1" tidak ditemukan!'); return; }
  if (!s2) { ui.alert('❌ Sheet "D.2" tidak ditemukan!'); return; }
  if (!s3) { ui.alert('❌ Sheet "D.3" tidak ditemukan!'); return; }

  ss.toast('Membaca data...', 'Hunter Sync', 5);

  var d1 = readSheet(s1);
  var d2 = readSheet(s2);
  var d3 = readSheet(s3);

  if (d1.length === 0) { ui.alert('❌ Sheet D.1 kosong atau tidak ada data.'); return; }

  // ── Tanya bulan laporan (default: bulan ini) ───────────────────────────
  // D.2 dan D.3 adalah data bulan berjalan; D.1 adalah referensi Mei
  var defaultBulan = getCurrentBulan();

  var resp = ui.prompt(
    '🎯 Hunter Sync — Bulan Laporan',
    'D.1 = data Mei (referensi tetap, tidak berubah)\n' +
    'D.2 & D.3 = data bulan laporan ini\n\n' +
    'Masukkan bulan laporan (YYYY-MM).\n' +
    'Kosongkan untuk gunakan bulan ini (' + defaultBulan + '):',
    ui.ButtonSet.OK_CANCEL
  );

  if (resp.getSelectedButton() !== ui.Button.OK) {
    ui.alert('Dibatalkan.');
    return;
  }

  var inputBulan = resp.getResponseText().trim();
  var bulan      = inputBulan || defaultBulan;

  if (!bulan.match(/^\d{4}-\d{2}$/)) {
    ui.alert('❌ Format bulan tidak valid. Gunakan YYYY-MM (contoh: 2026-06).');
    return;
  }

  // ── Konfirmasi sebelum sync ─────────────────────────────────────────────
  var msg = '🎯 Konfirmasi Sync Hunter\n\n' +
            'Bulan laporan : ' + bulan + '\n' +
            'D.1 (ref Mei) : ' + d1.length + ' baris (register/downline Pembina Bisnis)\n' +
            'D.2 (trx Jun) : ' + d2.length + ' baris (transaksi)\n' +
            'D.3 (akt Jun) : ' + d3.length + ' baris (aktivasi)\n\n' +
            'Data lama bulan ' + bulan + ' akan DIGANTI. Lanjutkan?';

  var confirm = ui.alert('Konfirmasi', msg, ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) { ui.alert('Dibatalkan.'); return; }

  // ── Kirim ke VPS ────────────────────────────────────────────────────────
  ss.toast('Mengirim ' + (d1.length + d2.length + d3.length) + ' baris ke server...', 'Hunter Sync', 60);

  var payload = JSON.stringify({
    token: SYNC_TOKEN,
    bulan: bulan,
    d1:    d1,
    d2:    d2,
    d3:    d3
  });

  try {
    var options = {
      method:             'post',
      contentType:        'application/json',
      payload:            payload,
      muteHttpExceptions: true,
      followRedirects:    true
    };

    var response = UrlFetchApp.fetch(VPS_URL, options);
    var code     = response.getResponseCode();
    var bodyText = response.getContentText();

    if (code !== 200) {
      ui.alert('❌ HTTP ' + code + '\n\n' + bodyText.slice(0, 500));
      return;
    }

    var body = JSON.parse(bodyText);

    if (body.ok) {
      ui.alert(
        '✅ Sync Berhasil!\n\n' +
        'Bulan laporan : ' + body.bulan + '\n' +
        'D.1           : ' + body.d1_rows + ' baris\n' +
        'D.2           : ' + body.d2_rows + ' baris\n' +
        'D.3           : ' + body.d3_rows + ' baris\n' +
        'Durasi        : ' + body.duration_ms + ' ms\n\n' +
        'Dashboard Hunter sudah terupdate.'
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

  var validIdx = [];
  headers.forEach(function(h, i) { if (h) validIdx.push(i); });
  var cleanHdr = validIdx.map(function(i) { return headers[i]; });

  var rows = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];

    var hasValue = validIdx.some(function(i) {
      return row[i] !== '' && row[i] !== null && row[i] !== undefined;
    });
    if (!hasValue) continue;

    var obj = {};
    validIdx.forEach(function(colIdx, ci) {
      var v = row[colIdx];
      if (v instanceof Date) {
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

// ── Tambah menu di spreadsheet ─────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎯 Hunter Sync')
    .addItem('Sync ke Dashboard', 'syncHunterData')
    .addToUi();
}
