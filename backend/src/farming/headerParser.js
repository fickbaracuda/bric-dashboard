'use strict';

/**
 * Parser header Google Sheet "Farming" — 100% dinamis, TIDAK ADA nama bulan
 * hardcode. Membaca header asli (raw), menemukan pasangan TRX/REV untuk
 * full-month (baseline), previous period, dan current period, lalu
 * memvalidasi konsistensinya. Lihat docs/FARMING_COMMAND_CENTER.md untuk
 * kontrak lengkap.
 *
 * Aturan kunci:
 * - Full-month & period-pair yang label bulannya SAMA dengan full-month =
 *   "previous" (mis. "Trx Juni Full" + "Trx 1-9 Juni" = previous period).
 *   Period-pair dengan label bulan BERBEDA = "current".
 * - Kalau pencocokan label ambigu (tidak ada yang cocok / sudah dari sheet
 *   berbeda format), fallback ke POSISI KOLOM (kolom pertama = previous,
 *   kedua = current) + catat warning — tidak pernah menebak diam-diam.
 * - month_key ('YYYY-MM') TIDAK diturunkan dari teks label (nama bulan saja
 *   tidak punya tahun) — diturunkan dari `snapshot_date` yang dikirim Apps
 *   Script (current = bulan snapshot_date, previous/baseline = 1 bulan
 *   sebelumnya, dengan rollover tahun di Desember->Januari). Label bulan
 *   dari teks HANYA dipakai untuk validasi silang (warning kalau tidak
 *   cocok), bukan untuk menentukan key.
 */

const ID_OUTLET_RE   = /^id\s*outlet$/i;
const LAYER_ARPU_RE  = /^layer[_\s-]*arpu$/i;
const DEV_TRX_RE     = /^dev\s+trx$/i;
const DEV_REV_RE     = /^dev\s+rev(?:enue)?$/i;
const FULL_TRX_RE    = /^trx\s+(.+?)\s+full$/i;
const FULL_REV_RE    = /^rev(?:enue)?\s+(.+?)\s+full$/i;
const PERIOD_TRX_RE  = /^trx\s+(\d+)\s*[-–]\s*(\d+)\s+(.+)$/i;
const PERIOD_REV_RE  = /^rev(?:enue)?\s+(\d+)\s*[-–]\s*(\d+)\s+(.+)$/i;

const MONTH_NAME_TO_NUM = {
  januari: 1, jan: 1, februari: 2, feb: 2, maret: 3, mar: 3,
  april: 4, apr: 4, mei: 5, juni: 6, jun: 6, juli: 7, jul: 7,
  agustus: 8, ags: 8, agu: 8, september: 9, sep: 9,
  oktober: 10, okt: 10, november: 11, nov: 11, desember: 12, des: 12,
};

function normalizeLabel(s) {
  return String(s || '').trim().toLowerCase();
}

function monthNumberFromLabel(label) {
  return MONTH_NAME_TO_NUM[normalizeLabel(label)] ?? null;
}

/**
 * Turunkan month_key current/previous/baseline dari snapshot_date (ISO
 * 'YYYY-MM-DD'). Baseline & previous SELALU bulan yang sama (1 bulan
 * sebelum current) — sesuai desain sheet Farming (full-month = referensi,
 * previous period = potongan hari yang sama di bulan yang sama).
 */
function deriveMonthKeys(snapshotDateIso) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(snapshotDateIso || ''));
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10); // 1-12, ini current
  let prevYear = year;
  let prevMonth = month - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear -= 1; }
  const pad = (n) => String(n).padStart(2, '0');
  return {
    current_month_key: `${year}-${pad(month)}`,
    previous_month_key: `${prevYear}-${pad(prevMonth)}`,
    baseline_month_key: `${prevYear}-${pad(prevMonth)}`,
    current_month_number: month,
    previous_month_number: prevMonth,
  };
}

/**
 * @param {string[]} rawHeaders - header asli dari baris header sheet.
 * @param {string} snapshotDateIso - 'YYYY-MM-DD', dipakai turunkan month_key.
 * @returns {{ ok: boolean, errors: string[], warnings: string[], foundHeaders: string[], columnMap?: object, labels?: object }}
 */
function parseFarmingHeaders(rawHeaders, snapshotDateIso) {
  const headers = (rawHeaders || []).map(h => String(h ?? '').trim());
  const errors = [];
  const warnings = [];

  let idOutletIdx = null;
  let layerArpuIdx = null;
  let devTrxIdx = null;
  let devRevIdx = null;
  let fullTrx = null;
  let fullRev = null;
  const periodTrxList = [];
  const periodRevList = [];

  headers.forEach((h, idx) => {
    if (!h) return;
    let m;
    if (ID_OUTLET_RE.test(h)) { idOutletIdx = idx; return; }
    if (LAYER_ARPU_RE.test(h)) { layerArpuIdx = idx; return; }
    if (DEV_TRX_RE.test(h)) { devTrxIdx = idx; return; }
    if (DEV_REV_RE.test(h)) { devRevIdx = idx; return; }
    if ((m = FULL_TRX_RE.exec(h))) { fullTrx = { idx, monthLabel: m[1].trim(), header: h }; return; }
    if ((m = FULL_REV_RE.exec(h))) { fullRev = { idx, monthLabel: m[1].trim(), header: h }; return; }
    if ((m = PERIOD_TRX_RE.exec(h))) { periodTrxList.push({ idx, startDay: parseInt(m[1], 10), endDay: parseInt(m[2], 10), monthLabel: m[3].trim(), header: h }); return; }
    if ((m = PERIOD_REV_RE.exec(h))) { periodRevList.push({ idx, startDay: parseInt(m[1], 10), endDay: parseInt(m[2], 10), monthLabel: m[3].trim(), header: h }); return; }
  });

  if (idOutletIdx === null) errors.push('Header "ID Outlet" tidak ditemukan.');
  if (!fullTrx) errors.push('Header "Trx <Bulan> Full" tidak ditemukan.');
  if (!fullRev) errors.push('Header "Rev <Bulan> Full" tidak ditemukan.');
  if (periodTrxList.length !== 2) errors.push(`Header periode TRX ("Trx <start>-<end> <Bulan>") ditemukan ${periodTrxList.length}x, seharusnya persis 2 (previous & current).`);
  if (periodRevList.length !== 2) errors.push(`Header periode REV ("Rev <start>-<end> <Bulan>") ditemukan ${periodRevList.length}x, seharusnya persis 2 (previous & current).`);

  if (errors.length) {
    return {
      ok: false, errors, warnings, foundHeaders: headers,
      diagnostics: {
        id_outlet_found: idOutletIdx !== null,
        full_trx_found: !!fullTrx,
        full_rev_found: !!fullRev,
        period_trx_count: periodTrxList.length,
        period_rev_count: periodRevList.length,
      },
    };
  }

  const [p1, p2] = periodTrxList;
  const [r1, r2] = periodRevList;
  if (p1.startDay !== p2.startDay || p1.endDay !== p2.endDay) {
    errors.push(`Rentang tanggal periode TRX tidak sama: "${p1.header}" (${p1.startDay}-${p1.endDay}) vs "${p2.header}" (${p2.startDay}-${p2.endDay}).`);
  }
  if (r1.startDay !== r2.startDay || r1.endDay !== r2.endDay) {
    errors.push(`Rentang tanggal periode REV tidak sama: "${r1.header}" (${r1.startDay}-${r1.endDay}) vs "${r2.header}" (${r2.startDay}-${r2.endDay}).`);
  }
  if (errors.length) return { ok: false, errors, warnings, foundHeaders: headers };

  if (p1.startDay !== r1.startDay || p1.endDay !== r1.endDay) {
    warnings.push(`Rentang tanggal TRX (${p1.startDay}-${p1.endDay}) berbeda dengan REV (${r1.startDay}-${r1.endDay}) — dilanjutkan, tapi perlu dicek manual.`);
  }

  function pickPreviousCurrent(list, fullLabel) {
    const matchIdx = list.findIndex(p => normalizeLabel(p.monthLabel) === normalizeLabel(fullLabel));
    if (matchIdx === 0) return { previous: list[0], current: list[1], positional: false };
    if (matchIdx === 1) return { previous: list[1], current: list[0], positional: false };
    return { previous: list[0], current: list[1], positional: true };
  }

  const trxPick = pickPreviousCurrent(periodTrxList, fullTrx.monthLabel);
  const revPick = pickPreviousCurrent(periodRevList, fullRev.monthLabel);
  if (trxPick.positional || revPick.positional) {
    warnings.push('Deviation header tidak sepenuhnya sama dengan month header, mapping dilakukan berdasarkan posisi kolom (pertama = previous, kedua = current).');
  }

  const startDay = trxPick.previous.startDay;
  const endDay = trxPick.previous.endDay;

  const monthKeys = deriveMonthKeys(snapshotDateIso);
  if (!monthKeys) {
    errors.push(`snapshot_date "${snapshotDateIso}" tidak valid (format harus YYYY-MM-DD) — tidak bisa menurunkan month_key.`);
    return { ok: false, errors, warnings, foundHeaders: headers };
  }

  // Validasi silang teks label vs bulan snapshot_date (warning saja, snapshot_date tetap jadi sumber kebenaran month_key)
  const currentLabelMonthNum = monthNumberFromLabel(trxPick.current.monthLabel);
  const previousLabelMonthNum = monthNumberFromLabel(trxPick.previous.monthLabel);
  if (currentLabelMonthNum !== null && currentLabelMonthNum !== monthKeys.current_month_number) {
    warnings.push(`Label bulan current di header ("${trxPick.current.monthLabel}") tidak cocok dengan bulan snapshot_date (${monthKeys.current_month_key}) — month_key tetap memakai snapshot_date.`);
  }
  if (previousLabelMonthNum !== null && previousLabelMonthNum !== monthKeys.previous_month_number) {
    warnings.push(`Label bulan previous/baseline di header ("${trxPick.previous.monthLabel}") tidak cocok dengan bulan snapshot_date -1 (${monthKeys.previous_month_key}) — month_key tetap memakai snapshot_date.`);
  }

  return {
    ok: true,
    errors: [],
    warnings,
    foundHeaders: headers,
    columnMap: {
      idOutletIdx,
      layerArpuIdx,
      devTrxIdx,
      devRevIdx,
      baselineFullTrxIdx: fullTrx.idx,
      baselineFullRevIdx: fullRev.idx,
      previousTrxIdx: trxPick.previous.idx,
      previousRevIdx: revPick.previous.idx,
      currentTrxIdx: trxPick.current.idx,
      currentRevIdx: revPick.current.idx,
    },
    labels: {
      baseline_month_key: monthKeys.baseline_month_key,
      baseline_month_label: fullTrx.monthLabel,
      previous_month_key: monthKeys.previous_month_key,
      previous_period_month_label: trxPick.previous.monthLabel,
      current_month_key: monthKeys.current_month_key,
      current_period_month_label: trxPick.current.monthLabel,
      period_start_day: startDay,
      period_end_day: endDay,
      baseline_full_label: `${fullTrx.monthLabel} Full`,
      previous_period_label: `${startDay}–${endDay} ${trxPick.previous.monthLabel}`,
      current_period_label: `${startDay}–${endDay} ${trxPick.current.monthLabel}`,
      comparison_label: `${startDay}–${endDay} ${trxPick.current.monthLabel} vs ${startDay}–${endDay} ${trxPick.previous.monthLabel}`,
    },
  };
}

module.exports = { parseFarmingHeaders, deriveMonthKeys, monthNumberFromLabel, normalizeLabel };
