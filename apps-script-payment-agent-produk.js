/**
 * WAR-ROOM Payment Agent > Produk — Apps Script sumber data.
 *
 * Sheet sumber: spreadsheet 1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw, tab "Produk".
 * Endpoint tujuan: POST /api/warroom/payment-agent/produk/sync
 *
 * CARA PAKAI:
 *   1. Copy-paste seluruh file ini ke Google Apps Script Editor pada
 *      spreadsheet di atas (Extensions > Apps Script).
 *   2. Set Script Properties (Project Settings > Script Properties):
 *        PAYMENT_AGENT_PRODUK_SYNC_TOKEN = <token yang sama dengan server>
 *        PAYMENT_AGENT_PRODUK_SYNC_URL   = https://bmsretail.my.id/api/warroom/payment-agent/produk/sync
 *      JANGAN hardcode token di kode ini.
 *   3. Jalankan previewPaymentAgentProdukPayload() dulu, cek log:
 *      snapshot_date, day_number, jumlah metric rows, jumlah deviation rows,
 *      formula_error_count, parse_warnings, sample produk, sample deviasi.
 *   4. Kalau preview sudah benar, jalankan pushPaymentAgentProdukSemua()
 *      SATU KALI (jangan diulang-ulang kalau gagal, cek dulu error-nya).
 *   5. JANGAN memanggil setupPaymentAgentProdukTrigger() dulu — trigger
 *      otomatis baru diaktifkan setelah disetujui eksplisit terpisah.
 *
 * BULAN 100% DINAMIS — parser membaca label bulan langsung dari header
 * sheet (row group "Mei 2026", "Juni 2026", "Juli 2026", dst), TIDAK ADA
 * nama bulan yang di-hardcode di parser. Bulan TERAKHIR pada grup bulan
 * utama selalu dianggap "current". Deviasi dipetakan BERDASARKAN POSISI
 * (grup deviasi pertama = baseline vs current, grup deviasi kedua =
 * previous vs current), BUKAN berdasarkan teks "MEI"/"JUN"/"JUL" —
 * compare_key yang dikirim ke backend selalu generik:
 * 'baseline_vs_current' / 'previous_vs_current'. compare_label tetap
 * membawa teks asli header sheet untuk audit/tampilan.
 */

const PAP_SHEET_NAME = 'Produk';
const PAP_SYNC_KEY = 'payment_agent_produk';
const PAP_DEFAULT_URL = 'https://bmsretail.my.id/api/warroom/payment-agent/produk/sync';
const PAP_METRIC_SUBCOLS = ['MAT', 'TRX', 'REV', 'ARPT', 'ATPU', 'ARPU'];
const PAP_FORMULA_ERRORS = ['#NAME?', '#DIV/0!', '#VALUE!', '#N/A', '#REF!', '#NULL!', '#NUM!'];

const PAP_MONTH_NAME_MAP = {
  JANUARI: '01', JAN: '01', FEBRUARI: '02', FEB: '02', MARET: '03', MAR: '03',
  APRIL: '04', APR: '04', MEI: '05', JUNI: '06', JUN: '06', JULI: '07', JUL: '07',
  AGUSTUS: '08', AGS: '08', AGU: '08', SEPTEMBER: '09', SEP: '09',
  OKTOBER: '10', OKT: '10', NOVEMBER: '11', NOV: '11', DESEMBER: '12', DES: '12',
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function pap_isFormulaError_(v) {
  if (v === null || v === undefined) return false;
  return PAP_FORMULA_ERRORS.indexOf(String(v).trim().toUpperCase()) !== -1;
}

/**
 * Parser angka aman. WAJIB cek typeof number DULU sebelum string processing
 * (lihat insiden Speedcash 100x — CLAUDE.md §5). Titik/koma = pemisah
 * ribuan. Angka dalam tanda kurung "(883,120,723)" dianggap NEGATIF.
 */
function pap_safeNumber_(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let raw = String(v).trim();
  if (raw === '' || raw === '-') return null;
  if (pap_isFormulaError_(raw)) return null;
  let negative = false;
  const parenMatch = /^\((.*)\)$/.exec(raw);
  if (parenMatch) { negative = true; raw = parenMatch[1]; }
  let cleaned = raw.replace(/rp/gi, '').trim();
  cleaned = cleaned.replace(/[.,]/g, '');
  cleaned = cleaned.replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  let n = Number(cleaned);
  if (!isFinite(n)) return null;
  if (negative) n = -Math.abs(n);
  return n;
}

function pap_parseMonthLabel_(label) {
  if (!label) return null;
  const s = String(label).trim().toUpperCase();
  const m = /^([A-ZÀ-Ÿ]+)\s+(\d{4})$/.exec(s);
  if (!m) return null;
  const monthNum = PAP_MONTH_NAME_MAP[m[1]];
  if (!monthNum) return null;
  return { month_key: `${m[2]}-${monthNum}`, month_label: String(label).trim() };
}

function pap_extractDayNumber_(values) {
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

function pap_splitProductLabel_(label) {
  const s = String(label || '').trim();
  const m = /^(\d+)\s*\.\s*(.+)$/.exec(s);
  if (m) return { product_code: m[1], product_name: m[2].trim() };
  return { product_code: null, product_name: s };
}

function pap_todayJakartaIso_() {
  return Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
}

// ─────────────────────────────────────────────────────────────────────────
// Parser utama — scan header 2 baris (grup bulan/dev di baris atas,
// subheader MAT/TRX/REV/ARPT/ATPU/ARPU di baris bawah), forward-fill label
// grup untuk sel merge yang kosong.
// ─────────────────────────────────────────────────────────────────────────
function pap_buildPayload_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(PAP_SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${PAP_SHEET_NAME}" tidak ditemukan.`);

  const values = sheet.getDataRange().getValues();
  const displayValues = sheet.getDataRange().getDisplayValues();
  const parseWarnings = [];

  // 1) Cari baris subheader (baris yang mengandung "MAT" DAN "TRX" DAN "REV")
  let subheaderRow = -1;
  for (let r = 0; r < Math.min(values.length, 20); r++) {
    const rowUpper = values[r].map(v => String(v || '').trim().toUpperCase());
    if (rowUpper.indexOf('MAT') !== -1 && rowUpper.indexOf('TRX') !== -1 && rowUpper.indexOf('REV') !== -1) {
      subheaderRow = r;
      break;
    }
  }
  if (subheaderRow === -1) throw new Error('Baris subheader (MAT/TRX/REV/ARPT/ATPU/ARPU) tidak ditemukan di 20 baris pertama.');
  const groupRow = subheaderRow - 1; // baris label grup (bulan / DEV) tepat di atas subheader

  // 2) Forward-fill label grup dari groupRow (merge cell -> cuma sel pertama yang berisi teks)
  const groupLabels = [];
  let lastLabel = null;
  for (let c = 0; c < values[groupRow].length; c++) {
    const raw = String(displayValues[groupRow][c] || '').trim();
    if (raw) lastLabel = raw;
    groupLabels.push(lastLabel);
  }

  // 3) Kolom PRODUK = kolom pertama yang subheadernya kosong sebelum grup bulan pertama
  let produkCol = 0;
  for (let c = 0; c < values[subheaderRow].length; c++) {
    if (String(values[subheaderRow][c] || '').trim()) { produkCol = c - 1 < 0 ? 0 : produkCol; break; }
    produkCol = c;
  }

  // 4) Kelompokkan kolom per label grup (hanya kolom dengan subheader MAT/TRX/REV/ARPT/ATPU/ARPU valid)
  const groupsOrdered = []; // [{ label, cols: { MAT: colIdx, ... } }]
  const groupIndexByLabel = {};
  for (let c = produkCol + 1; c < values[subheaderRow].length; c++) {
    const sub = String(values[subheaderRow][c] || '').trim().toUpperCase();
    if (PAP_METRIC_SUBCOLS.indexOf(sub) === -1) continue;
    const label = groupLabels[c];
    if (!label) { parseWarnings.push(`Kolom ${c + 1} punya subheader "${sub}" tapi tanpa label grup — dilewati.`); continue; }
    if (groupIndexByLabel[label] === undefined) {
      groupIndexByLabel[label] = groupsOrdered.length;
      groupsOrdered.push({ label, cols: {} });
    }
    groupsOrdered[groupIndexByLabel[label]].cols[sub] = c;
  }

  // 5) Pisahkan grup bulan (label bisa di-parse jadi month_key) vs grup deviasi (sisanya, urutan sheet)
  const monthGroups = [];
  const deviationGroups = [];
  for (const g of groupsOrdered) {
    const parsed = pap_parseMonthLabel_(g.label);
    if (parsed) monthGroups.push({ ...g, ...parsed });
    else deviationGroups.push(g);
  }
  monthGroups.sort((a, b) => (a.month_key < b.month_key ? -1 : a.month_key > b.month_key ? 1 : 0));

  if (monthGroups.length < 2) throw new Error(`Grup bulan valid hanya ${monthGroups.length} (butuh minimal 2). Cek label header (contoh: "Mei 2026").`);
  const currentGroup = monthGroups[monthGroups.length - 1];
  const baselineGroup = monthGroups[0];
  const previousGroup = monthGroups.length >= 3 ? monthGroups[monthGroups.length - 2] : null;

  const months = monthGroups.map((g, idx) => ({
    month_key: g.month_key,
    month_label: g.month_label,
    role: idx === monthGroups.length - 1 ? 'current' : (idx === 0 ? 'baseline' : 'previous'),
  }));

  // 6) Deviasi POSISIONAL: grup pertama = baseline_vs_current, grup kedua = previous_vs_current
  const deviationDefs = [];
  if (deviationGroups[0]) {
    const expectedLabel = `DEV : ${baselineGroup.label.split(' ')[0].toUpperCase()} VS ${currentGroup.label.split(' ')[0].toUpperCase()}`;
    if (previousGroup && deviationGroups[0].label.toUpperCase().indexOf(baselineGroup.label.split(' ')[0].toUpperCase()) === -1) {
      parseWarnings.push(`Deviation header tidak sepenuhnya sama dengan month header, mapping dilakukan berdasarkan posisi. (header: "${deviationGroups[0].label}", ekspektasi kira-kira: "${expectedLabel}")`);
    }
    deviationDefs.push({ compare_key: 'baseline_vs_current', compare_label: deviationGroups[0].label, cols: deviationGroups[0].cols });
  }
  if (deviationGroups[1] && previousGroup) {
    deviationDefs.push({ compare_key: 'previous_vs_current', compare_label: deviationGroups[1].label, cols: deviationGroups[1].cols });
  }
  if (deviationGroups.length > 2) parseWarnings.push(`Ditemukan ${deviationGroups.length} grup deviasi, hanya 2 pertama yang dipakai (baseline_vs_current, previous_vs_current).`);

  // 7) Day number + snapshot_date
  const headerScanRows = values.slice(0, subheaderRow);
  const dayNumber = pap_extractDayNumber_(headerScanRows);
  let snapshotDate = null;
  if (dayNumber !== null) {
    const [y, m] = currentGroup.month_key.split('-');
    snapshotDate = `${y}-${m}-${String(dayNumber).padStart(2, '0')}`;
  } else {
    snapshotDate = pap_todayJakartaIso_();
    parseWarnings.push('Day number tidak ditemukan di header — snapshot_date fallback ke tanggal hari ini (Asia/Jakarta).');
  }

  // 8) Baris data produk (mulai tepat setelah subheaderRow)
  let formulaErrorCount = 0;
  const metrics = [];
  const deviations = [];
  const sourceRowSamples = [];
  let totalRow = null;

  for (let r = subheaderRow + 1; r < values.length; r++) {
    const produkRaw = String(displayValues[r][produkCol] || '').trim();
    if (!produkRaw) continue;
    if (/^TOTAL/i.test(produkRaw)) {
      const totalEntry = { row: r + 1 };
      for (const g of monthGroups) {
        totalEntry[g.month_key] = {};
        for (const sub of PAP_METRIC_SUBCOLS) {
          if (g.cols[sub] === undefined) continue;
          const val = values[r][g.cols[sub]];
          if (pap_isFormulaError_(val)) formulaErrorCount++;
          totalEntry[g.month_key][sub.toLowerCase()] = pap_safeNumber_(val);
        }
      }
      totalRow = totalEntry;
      continue;
    }

    const { product_code, product_name } = pap_splitProductLabel_(produkRaw);
    const sourceRow = r + 1;

    for (const g of monthGroups) {
      const rowData = {};
      let hasAny = false;
      for (const sub of PAP_METRIC_SUBCOLS) {
        if (g.cols[sub] === undefined) continue;
        const val = values[r][g.cols[sub]];
        if (pap_isFormulaError_(val)) formulaErrorCount++;
        const num = pap_safeNumber_(val);
        rowData[sub.toLowerCase()] = num;
        if (num !== null) hasAny = true;
      }
      if (!hasAny) continue;
      metrics.push({
        month_key: g.month_key,
        month_label: g.month_label,
        product_code, product_name,
        product_label: produkRaw,
        mat: rowData.mat ?? null, trx: rowData.trx ?? null, rev: rowData.rev ?? null,
        arpt: rowData.arpt ?? null, atpu: rowData.atpu ?? null, arpu: rowData.arpu ?? null,
        source_sheet: PAP_SHEET_NAME, source_row: sourceRow, raw_data: {},
      });
    }

    for (const d of deviationDefs) {
      const rowData = {};
      let hasAny = false;
      for (const sub of PAP_METRIC_SUBCOLS) {
        if (d.cols[sub] === undefined) continue;
        const val = values[r][d.cols[sub]];
        if (pap_isFormulaError_(val)) formulaErrorCount++;
        const num = pap_safeNumber_(val);
        rowData[sub.toLowerCase()] = num;
        if (num !== null) hasAny = true;
      }
      if (!hasAny) continue;
      deviations.push({
        compare_key: d.compare_key,
        compare_label: d.compare_label,
        product_code, product_name,
        product_label: produkRaw,
        dev_mat: rowData.mat ?? null, dev_trx: rowData.trx ?? null, dev_rev: rowData.rev ?? null,
        dev_arpt: rowData.arpt ?? null, dev_atpu: rowData.atpu ?? null, dev_arpu: rowData.arpu ?? null,
        source_sheet: PAP_SHEET_NAME, source_row: sourceRow, raw_data: {},
      });
    }

    if (sourceRowSamples.length < 3) sourceRowSamples.push({ product_label: produkRaw, product_code, product_name });
  }

  const payload = {
    sync_key: PAP_SYNC_KEY,
    source_url: ss.getUrl(),
    sheet_name: PAP_SHEET_NAME,
    snapshot_date: snapshotDate,
    day_number: dayNumber,
    months,
    metrics,
    deviations,
    meta: {
      synced_by: 'apps_script',
      formula_error_count: formulaErrorCount,
      parse_warnings: parseWarnings,
      total_row: totalRow || {},
    },
  };

  return { payload, sampleProducts: sourceRowSamples, monthGroups, deviationDefs };
}

// ─────────────────────────────────────────────────────────────────────────
// Fungsi publik
// ─────────────────────────────────────────────────────────────────────────
function previewPaymentAgentProdukPayload() {
  const { payload, sampleProducts, monthGroups, deviationDefs } = pap_buildPayload_();

  Logger.log('=== PREVIEW Payment Agent Produk ===');
  Logger.log('snapshot_date: %s', payload.snapshot_date);
  Logger.log('day_number: %s', payload.day_number);
  Logger.log('months: %s', JSON.stringify(payload.months));
  Logger.log('metric rows: %s', payload.metrics.length);
  Logger.log('deviation rows: %s', payload.deviations.length);
  Logger.log('formula_error_count: %s', payload.meta.formula_error_count);
  Logger.log('parse_warnings: %s', JSON.stringify(payload.meta.parse_warnings));
  Logger.log('total_row: %s', JSON.stringify(payload.meta.total_row));
  Logger.log('sample products: %s', JSON.stringify(sampleProducts));
  Logger.log('sample metric row: %s', JSON.stringify(payload.metrics[0] || null));
  Logger.log('sample deviation row: %s', JSON.stringify(payload.deviations[0] || null));

  const expectedMetricRows = sampleProducts.length ? null : null; // info saja, lihat log jumlah produk x bulan
  if (!payload.metrics.length || !payload.deviations.length) {
    Logger.log('[PERHATIAN] metric rows atau deviation rows = 0 — JANGAN jalankan pushPaymentAgentProdukSemua() sebelum ini diperbaiki.');
  } else {
    Logger.log('[OK] Preview terlihat wajar. Cek ulang sample di atas sebelum menjalankan pushPaymentAgentProdukSemua().');
  }
  return payload;
}

function pushPaymentAgentProdukSemua() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('PAYMENT_AGENT_PRODUK_SYNC_TOKEN');
  const url = props.getProperty('PAYMENT_AGENT_PRODUK_SYNC_URL') || PAP_DEFAULT_URL;

  if (!token) {
    Logger.log('[STOP] Script Property PAYMENT_AGENT_PRODUK_SYNC_TOKEN belum diset. Sync dibatalkan.');
    return;
  }

  const { payload } = pap_buildPayload_();
  if (!payload.metrics.length || !payload.deviations.length) {
    Logger.log('[STOP] metric/deviation rows kosong — jalankan previewPaymentAgentProdukPayload() dulu dan perbaiki parser sebelum push.');
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

function setupPaymentAgentProdukTrigger() {
  deletePaymentAgentProdukTriggers();
  ScriptApp.newTrigger('pushPaymentAgentProdukSemua')
    .timeBased()
    .everyDays(1)
    .atHour(23) // 23:00 UTC = 06:00 WIB, konsisten dengan trigger war-room lain
    .create();
  Logger.log('Trigger harian pushPaymentAgentProdukSemua() terpasang (23:00 UTC / 06:00 WIB).');
}

function deletePaymentAgentProdukTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'pushPaymentAgentProdukSemua') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }
  Logger.log('%s trigger pushPaymentAgentProdukSemua() dihapus.', removed);
}
