// Paste kode ini ke Google Apps Script
// Extensions → Apps Script → hapus semua → paste ini

var SECRET_TOKEN = 'bric2026bimasaktisecret';

var EXCLUDE_NAMES = [
  'A. TOTAL BUSINESS RETAIL',
  'B. TOTAL ESA',
  'REVENUE BISNIS BMS'
];

function doGet(e) {
  // Cek token keamanan
  if (!e || e.parameter.token !== SECRET_TOKEN) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Cari sheet berdasarkan nama bulan, default sheet pertama
  var bulan = e.parameter.bulan || 'JUN_2026';
  var sheet = ss.getActiveSheet();

  // Coba cari sheet dengan nama bulan
  var allSheets = ss.getSheets();
  for (var s = 0; s < allSheets.length; s++) {
    var sheetName = allSheets[s].getName().toUpperCase().replace(/\s/g, '_');
    if (sheetName.indexOf(bulan) !== -1) {
      sheet = allSheets[s];
      break;
    }
  }

  var data = sheet.getDataRange().getValues();

  // Row 1 = judul, Row 2 = header, Row 3+ = data
  var units = [];
  for (var i = 2; i < data.length; i++) {
    var row = data[i];
    var nama = String(row[0]).trim();

    if (!nama || nama === '') continue;
    if (EXCLUDE_NAMES.indexOf(nama) !== -1) continue;

    // Kolom: A=nama, B=mei, C=juni, D=dev, E=target_rkap, F=dev_target
    //        G=avg_rev_day, H=est_rev_juni, I=est_dev, J=real_kpi, K=est_kpi_juni, L=status
    var juni        = parseNumber(row[2]);
    var targetRkap  = parseNumber(row[4]);
    var realKpi     = parsePercent(row[9]);
    var estKpiJuni  = parsePercent(row[10]);
    var status      = String(row[11]).trim() || 'Kritis';

    if (juni === 0 && targetRkap === 0) continue; // skip baris kosong

    units.push({
      nama:         nama,
      juni:         juni,
      target_rkap:  targetRkap,
      real_kpi:     round2(realKpi),
      est_kpi_juni: round2(estKpiJuni),
      status:       status
    });
  }

  var result = {
    bulan:      bulan,
    synced_at:  new Date().toISOString(),
    units:      units
  };

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseNumber(val) {
  if (typeof val === 'number') return val;
  var str = String(val).replace(/[Rp\s,\.]/g, '').replace(/\./g, '');
  // Handle format ribuan Indonesia: titik = pemisah ribuan, koma = desimal
  str = String(val).replace(/[Rp\s]/g, '').replace(/\./g, '').replace(',', '.');
  var n = parseFloat(str);
  return isNaN(n) ? 0 : n;
}

function parsePercent(val) {
  if (typeof val === 'number') {
    // Jika desimal (0.1441) → kalikan 100
    if (val > 0 && val <= 2) return val * 100;
    return val;
  }
  var str = String(val).replace('%', '').replace(',', '.').trim();
  var n = parseFloat(str);
  return isNaN(n) ? 0 : n;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
