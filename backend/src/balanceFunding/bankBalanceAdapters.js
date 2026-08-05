'use strict';

/**
 * Balance & Funding — Bank Balance Adapters.
 *
 * STANDALONE dari Balance Control Tower lama: file ini TIDAK mengimpor apa
 * pun dari backend/src/balanceControlTower/ atau
 * backend/src/reconciliation/bankPosition/ (adapter OCBC BCT lama). Balance
 * & Funding adalah READ CONSUMER dari data rekonsiliasi (recon_sync_batches/
 * recon_bank_transactions) — query di sini BARU dan independen, walau boleh
 * (dan memang) reuse fungsi validasi PURE read-only dari modul rekonsiliasi
 * (mandiriAdapter/briAdapter/bcaAdapter) supaya tidak menduplikasi logic
 * continuity-check yang sudah ada & teruji (spec section 58: "prefer
 * querying existing raw/batch data").
 *
 * Bukti sumber saldo per bank (Balance Source Matrix lengkap ada di
 * docs/BALANCE_FUNDING.md), ringkas:
 *   OCBC        -> recon_sync_batches.raw_summary.available_balance (resmi, HIGH)
 *   BCA         -> recon_sync_batches.raw_summary.current_balance.saldo_akhir
 *                  (footer resmi kalau source='sheet_footer' -> HIGH,
 *                  fallback row-order -> MEDIUM/LOW)
 *   MANDIRI     -> recon_bank_transactions.close_balance baris terakhir
 *                  (arah ASC/DESC dari validateMandiriBalance) -> MEDIUM/LOW
 *   BRI         -> recon_bank_transactions.balance baris terakhir
 *                  (balance_check_status sudah dihitung saat sync) -> MEDIUM/LOW
 *   BRI_BIFAST  -> sama pola BRI, tabel/kolom sama, bank_code beda -> MEDIUM/LOW
 *   BNI         -> TIDAK TERSEDIA -- file mutasi BNI tidak punya kolom saldo
 *                  sama sekali (dikonfirmasi & didisclaim eksplisit di kode
 *                  warroom-reconciliation-bni.js) -> SELALU UNAVAILABLE
 */

const { validateMandiriBalance } = require('../reconciliation/mandiriAdapter');

const BANK_CODES = ['OCBC', 'MANDIRI', 'BRI', 'BRI_BIFAST', 'BNI', 'BCA'];

const CONFIDENCE = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', UNAVAILABLE: 'UNAVAILABLE' };

// Presisi balance_position_time yang bisa dibuktikan dari sumber:
//   MINUTE -- ada timestamp bank-provided per baris mutasi (jam:menit genuine).
//   DATE   -- sumber cuma punya business_date (tanggal kalender), TIDAK ADA
//             komponen jam yang bisa dibuktikan dari bank sama sekali.
const POSITION_PRECISION = { MINUTE: 'MINUTE', DATE: 'DATE' };

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function unavailable(bankCode, reason) {
  return {
    bank_code: bankCode, account_no: null, balance: null, business_date: null,
    balance_position_time: null, balance_position_precision: null, last_sync_at: null,
    balance_timestamp: null, // alias balance_position_time -- lihat catatan di getActualBankBalance()
    source: null, balance_source: null, source_batch_id: null,
    verification_status: 'UNAVAILABLE', confidence: CONFIDENCE.UNAVAILABLE,
    warnings: [reason],
  };
}

/**
 * Audit hasil (lihat docs/BALANCE_FUNDING.md §18): OCBC & BCA TIDAK PUNYA
 * kolom waktu apa pun di sumbernya utk baris/saldo (recon_bank_transactions
 * OCBC/BCA cuma punya transaction_date/value_date bertipe DATE, raw_summary
 * OCBC cuma "RELEASE DATE" bertipe tanggal juga, tanpa jam) -- SATU-SATUNYA
 * hal yang bisa dibuktikan dari bank adalah business_date (tanggal kalender).
 * Mengarang jam (mis. 00:00 atau 23:59) akan melanggar aturan "no fake
 * timestamp". Dipetakan ke awal hari (00:00:00 WIB business_date) SEMATA
 * supaya ada instant yang bisa dibandingkan (age >= 0 utk tanggal valid),
 * BUKAN klaim "saldo ini persis posisi jam 00:00" -- makanya precision-nya
 * ditandai 'DATE', frontend WAJIB tampilkan sbg tanggal (bukan jam:menit).
 *
 * Guard tambahan: kalau business_date ternyata di MASA DEPAN relatif ke
 * `now` (pernah ditemukan nyata pada data produksi BCA -- business_date
 * salah parse jadi tahun/bulan yang belum terjadi), timestamp itu TIDAK
 * bisa dipercaya sama sekali -- return null (bukan tanggal yang salah),
 * confidence diturunkan oleh caller.
 */
function resolveDateOnlyPosition(businessDateStr, now) {
  if (!businessDateStr) {
    return { position_time: null, precision: null, warnings: ['business_date tidak tersedia -- waktu posisi saldo tidak dapat dipastikan.'], downgrade: true };
  }
  const startOfDayWib = new Date(`${businessDateStr}T00:00:00+07:00`);
  if (Number.isNaN(startOfDayWib.getTime())) {
    return { position_time: null, precision: null, warnings: [`business_date "${businessDateStr}" tidak valid -- waktu posisi saldo tidak dapat dipastikan.`], downgrade: true };
  }
  if (startOfDayWib.getTime() > now.getTime()) {
    return {
      position_time: null, precision: null, downgrade: true,
      warnings: [`business_date rekonsiliasi (${businessDateStr}) berada di masa depan relatif terhadap waktu sekarang -- kemungkinan ada masalah parsing tanggal di sumber data, waktu posisi saldo tidak dipakai.`],
    };
  }
  return { position_time: startOfDayWib, precision: POSITION_PRECISION.DATE, warnings: [], downgrade: false };
}

/**
 * Bank dgn timestamp bank-provided genuine per baris mutasi (Mandiri
 * post_date_time, BRI/BRI_BIFAST effective_date_time) -- guard sama (future
 * check) tapi TIDAK perlu fallback ke business_date karena sumbernya
 * memang punya jam:menit asli.
 */
function resolveTimePosition(rawTimestamp, now) {
  if (!rawTimestamp) {
    return { position_time: null, precision: null, warnings: ['Timestamp posisi saldo tidak tersedia pada baris mutasi terakhir.'], downgrade: true };
  }
  const t = new Date(rawTimestamp);
  if (Number.isNaN(t.getTime())) {
    return { position_time: null, precision: null, warnings: ['Timestamp posisi saldo pada baris mutasi tidak valid.'], downgrade: true };
  }
  if (t.getTime() > now.getTime()) {
    return {
      position_time: null, precision: null, downgrade: true,
      warnings: [`Timestamp posisi saldo pada baris mutasi (${rawTimestamp}) berada di masa depan -- tidak dipakai, kemungkinan ada masalah data.`],
    };
  }
  return { position_time: t, precision: POSITION_PRECISION.MINUTE, warnings: [], downgrade: false };
}

// ── OCBC ──────────────────────────────────────────────────────────────────
async function getOcbcBalance(pool, now) {
  const r = await pool.query(
    `SELECT id, business_date::text AS business_date, synced_at, account_no, raw_summary
     FROM recon_sync_batches WHERE bank_code = 'OCBC' AND status = 'success'
     ORDER BY business_date DESC, synced_at DESC LIMIT 1`
  );
  if (!r.rows.length) return unavailable('OCBC', 'Belum ada batch rekonsiliasi OCBC yang sukses.');
  const row = r.rows[0];
  const s = row.raw_summary || {};
  const balance = numOrNull(s.available_balance);
  if (balance === null) return unavailable('OCBC', 'raw_summary.available_balance kosong pada batch rekonsiliasi terakhir.');
  const pos = resolveDateOnlyPosition(row.business_date, now);
  return {
    bank_code: 'OCBC', account_no: row.account_no || null, balance, business_date: row.business_date,
    balance_position_time: pos.position_time, balance_position_precision: pos.precision,
    last_sync_at: row.synced_at, balance_timestamp: pos.position_time,
    source: 'recon_sync_batches.raw_summary.available_balance', balance_source: 'recon_sync_batches.raw_summary.available_balance',
    source_batch_id: String(row.id), verification_status: 'OFFICIAL_STATEMENT_VALUE',
    confidence: pos.downgrade ? CONFIDENCE.MEDIUM : CONFIDENCE.HIGH, warnings: pos.warnings,
  };
}

// ── BCA ───────────────────────────────────────────────────────────────────
async function getBcaBalance(pool, now) {
  const r = await pool.query(
    `SELECT id, business_date::text AS business_date, synced_at, account_no, raw_summary
     FROM recon_sync_batches WHERE bank_code = 'BCA' AND status = 'success'
     ORDER BY business_date DESC, synced_at DESC LIMIT 1`
  );
  if (!r.rows.length) return unavailable('BCA', 'Belum ada batch rekonsiliasi BCA yang sukses.');
  const row = r.rows[0];
  const s = row.raw_summary || {};
  const cb = s.current_balance || {};
  const continuity = s.balance_continuity || {};
  const warnings = [];

  let balance = numOrNull(cb.saldo_akhir);
  let confidence = CONFIDENCE.HIGH;
  let verification = 'OFFICIAL_STATEMENT_FOOTER';
  let source = 'recon_sync_batches.raw_summary.current_balance.saldo_akhir';

  if (balance !== null && cb.source === 'row_order_fallback') {
    confidence = CONFIDENCE.MEDIUM;
    verification = 'ROW_ORDER_FALLBACK';
    warnings.push('Footer "Saldo Akhir" tidak terbaca saat sync — nilai dari fallback urutan baris.');
  }
  if (balance === null) {
    balance = numOrNull(continuity.latest_balance_from_order);
    if (balance !== null) {
      confidence = continuity.status === 'BALANCE_CONTINUITY_OK' ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;
      verification = 'CONTINUITY_DERIVED';
      source = 'recon_sync_batches.raw_summary.balance_continuity.latest_balance_from_order';
      warnings.push('Footer saldo akhir tidak tersedia — nilai diturunkan dari validasi kontinuitas baris mutasi.');
    }
  }
  if (balance === null) return unavailable('BCA', 'Footer saldo akhir maupun fallback kontinuitas tidak tersedia pada batch terakhir.');

  const pos = resolveDateOnlyPosition(row.business_date, now);
  if (pos.downgrade) confidence = CONFIDENCE.LOW;
  return {
    bank_code: 'BCA', account_no: row.account_no || null, balance, business_date: row.business_date,
    balance_position_time: pos.position_time, balance_position_precision: pos.precision,
    last_sync_at: row.synced_at, balance_timestamp: pos.position_time,
    source, balance_source: source, source_batch_id: String(row.id),
    verification_status: verification, confidence, warnings: [...warnings, ...pos.warnings],
  };
}

// ── MANDIRI ───────────────────────────────────────────────────────────────
const MANDIRI_LOOKBACK_BATCHES = 30; // ~1 bulan sync harian -- cukup utk lompati batch yg close_balance-nya rusak/kosong tanpa mundur tak terbatas

/**
 * Sebuah batch dianggap "close_balance tidak terpercaya" kalau SEMUA baris
 * non-null close_balance-nya persis 0 (100%) -- statement bank asli TIDAK
 * PERNAH persis Rp0 di setiap baris selama berhari-hari; pola ini artinya
 * kolom itu tidak benar-benar terisi oleh sumbernya (Apps Script/sheet),
 * BUKAN saldo Rp0 yang authoritative. Ditemukan lewat investigasi produksi:
 * batch business_date <= 2026-07-27 terisi normal (100% non-zero), SEMUA
 * batch setelahnya (2026-07-28 dst) 100% nol di setiap baris -- indikasi
 * regresi di pipeline sync Mandiri, bukan kondisi rekening riil. Guard ini
 * TIDAK mengubah/menyentuh logic Rekonsiliasi Mandiri sama sekali -- murni
 * lapisan kehati-hatian di resolver Balance & Funding sendiri.
 */
function isMandiriCloseBalanceTrustworthy(bankRows) {
  if (!bankRows.length) return false;
  return bankRows.some(r => r.closeBalance !== 0);
}

async function getMandiriBalance(pool, now) {
  const batchesRes = await pool.query(
    `SELECT id, business_date::text AS business_date, synced_at, account_no
     FROM recon_sync_batches WHERE bank_code = 'MANDIRI' AND status = 'success'
     ORDER BY business_date DESC, synced_at DESC LIMIT $1`,
    [MANDIRI_LOOKBACK_BATCHES]
  );
  if (!batchesRes.rows.length) return unavailable('MANDIRI', 'Belum ada batch rekonsiliasi Mandiri yang sukses.');

  let usedBatch = null;
  let bankRows = null;
  let skippedUntrustedBatches = 0;
  for (const batch of batchesRes.rows) {
    const rowsRes = await pool.query(
      `SELECT close_balance, source_row_number, debit, credit, post_date_time
       FROM recon_bank_transactions
       WHERE batch_id = $1 AND close_balance IS NOT NULL AND source_row_number IS NOT NULL
       ORDER BY source_row_number ASC`,
      [batch.id]
    );
    if (!rowsRes.rows.length) continue;
    const candidateRows = rowsRes.rows.map(r => ({
      closeBalance: numOrNull(r.close_balance), sourceRowNumber: Number(r.source_row_number),
      debitAmount: numOrNull(r.debit) || 0, creditAmount: numOrNull(r.credit) || 0,
      postDateTime: r.post_date_time,
    }));
    if (!isMandiriCloseBalanceTrustworthy(candidateRows)) { skippedUntrustedBatches++; continue; }
    usedBatch = batch; bankRows = candidateRows; break;
  }

  if (!usedBatch) {
    return unavailable('MANDIRI',
      `close_balance tidak tersedia/valid pada ${MANDIRI_LOOKBACK_BATCHES} batch rekonsiliasi Mandiri terakhir` +
      (skippedUntrustedBatches ? ` (${skippedUntrustedBatches} batch dilewati karena close_balance 0 di semua baris -- indikasi kolom tidak terisi sumbernya, bukan saldo Rp0 riil)` : '') + '.'
    );
  }

  const validation = validateMandiriBalance(bankRows);
  const sorted = [...bankRows].sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);
  // ASC: baris teratas (source_row_number terkecil) = mutasi TERLAMA -> terbaru = index terakhir.
  // DESC: baris teratas = mutasi TERBARU -> terbaru = index 0.
  const direction = validation.direction || 'ASC';
  const latestRow = direction === 'DESC' ? sorted[0] : sorted[sorted.length - 1];

  let confidence = validation.status === 'BALANCED' ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;
  const warnings = [];
  if (validation.status !== 'BALANCED') {
    warnings.push(`Validasi kontinuitas saldo Mandiri: ${validation.status} (${validation.matched}/${validation.checked} baris cocok).`);
  }
  warnings.push('Saldo Mandiri diturunkan dari close_balance baris mutasi terakhir (bukan field ringkasan resmi terpisah).');
  if (usedBatch.business_date !== batchesRes.rows[0].business_date) {
    warnings.push(`Batch terbaru (${batchesRes.rows[0].business_date}) close_balance-nya tidak terpercaya (0 di semua baris) -- memakai batch valid terakhir (${usedBatch.business_date}). Cek pipeline sync Mandiri.`);
  }

  // post_date_time = timestamp posting BANK ASLI (jam:menit:detik genuine)
  // pada baris mutasi yang dipakai sbg close_balance -- lihat migration
  // add_reconciliation_mandiri_columns.sql: "PostDate Mandiri PUNYA jam-
  // menit-detik (bukan cuma tanggal)". INI posisi saldo sesungguhnya, BUKAN
  // usedBatch.synced_at (waktu Apps Script sync, dipisah ke last_sync_at).
  const pos = resolveTimePosition(latestRow.postDateTime, now);
  if (pos.downgrade) confidence = CONFIDENCE.LOW;

  return {
    bank_code: 'MANDIRI', account_no: usedBatch.account_no || null, balance: latestRow.closeBalance,
    business_date: usedBatch.business_date,
    balance_position_time: pos.position_time, balance_position_precision: pos.precision,
    last_sync_at: usedBatch.synced_at, balance_timestamp: pos.position_time,
    source: 'recon_bank_transactions.close_balance', balance_source: 'recon_bank_transactions.close_balance',
    source_batch_id: String(usedBatch.id),
    verification_status: `ROW_CHRONOLOGY_${validation.status}`, confidence, warnings: [...warnings, ...pos.warnings],
  };
}

// ── BRI & BRI_BIFAST (pola sama, tabel/kolom sama, bank_code beda) ────────
async function getBriLikeBalance(pool, bankCode, now) {
  const r = await pool.query(
    `SELECT sb.id AS batch_id, sb.business_date::text AS business_date, sb.synced_at, sb.account_no,
            rbt.balance, rbt.balance_check_status, rbt.effective_date_time, rbt.sequence_no
     FROM recon_sync_batches sb
     JOIN recon_bank_transactions rbt ON rbt.batch_id = sb.id
     WHERE sb.bank_code = $1 AND sb.status = 'success' AND rbt.balance IS NOT NULL
     ORDER BY sb.business_date DESC, sb.synced_at DESC,
              rbt.effective_date_time DESC NULLS LAST, rbt.sequence_no DESC NULLS LAST
     LIMIT 1`,
    [bankCode]
  );
  if (!r.rows.length) return unavailable(bankCode, `Tidak ada baris mutasi ${bankCode} dengan saldo (balance) pada batch rekonsiliasi.`);
  const row = r.rows[0];
  const balance = numOrNull(row.balance);
  if (balance === null) return unavailable(bankCode, `Kolom balance ${bankCode} kosong pada baris terakhir.`);

  const status = row.balance_check_status;
  let confidence = status === 'BALANCED' ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;
  const warnings = ['Saldo diturunkan dari kolom balance (SALDO_AKHIR_MUTASI) baris mutasi terakhir, bukan field ringkasan resmi terpisah.'];
  if (status && status !== 'BALANCED') warnings.push(`balance_check_status baris terakhir: ${status}.`);
  if (!status) warnings.push('balance_check_status baris terakhir tidak tersedia (belum divalidasi).');

  // effective_date_time = Value Date bank-provided pada baris mutasi terakhir
  // (genuine jam:menit, lihat add_reconciliation_bri_columns.sql) -- ini
  // posisi saldo sesungguhnya, BUKAN row.synced_at (waktu sync, dipisah ke
  // last_sync_at). Terbukti dari data produksi selalu BERBEDA dari synced_at
  // (kadang jauh lebih lama -- baris mutasi terakhir bisa dari beberapa hari
  // sebelum batch-nya disync).
  const pos = resolveTimePosition(row.effective_date_time, now);
  if (pos.downgrade) confidence = CONFIDENCE.LOW;

  return {
    bank_code: bankCode, account_no: row.account_no || null, balance, business_date: row.business_date,
    balance_position_time: pos.position_time, balance_position_precision: pos.precision,
    last_sync_at: row.synced_at, balance_timestamp: pos.position_time,
    source: 'recon_bank_transactions.balance', balance_source: 'recon_bank_transactions.balance',
    source_batch_id: String(row.batch_id),
    verification_status: `ROW_BALANCE_CHECK_${status || 'UNKNOWN'}`, confidence, warnings: [...warnings, ...pos.warnings],
  };
}

// ── BNI — TIDAK TERSEDIA secara struktural (lihat komentar atas) ─────────
async function getBniBalance() {
  return unavailable(
    'BNI',
    'File mutasi BNI tidak memuat kolom saldo (opening/closing balance) — hanya data debit/kredit (Net Cash Movement). ' +
    'Saldo aktual BNI TIDAK DAPAT diturunkan dari data rekonsiliasi yang ada saat ini (bukan keterbatasan sementara, tapi struktur data sumbernya).'
  );
}

const ADAPTERS = {
  OCBC: getOcbcBalance,
  BCA: getBcaBalance,
  MANDIRI: getMandiriBalance,
  BRI: (pool, now) => getBriLikeBalance(pool, 'BRI', now),
  BRI_BIFAST: (pool, now) => getBriLikeBalance(pool, 'BRI_BIFAST', now),
  BNI: getBniBalance,
};

/**
 * Interface standar (spec section 39) — frontend/engine TIDAK PERNAH tahu
 * detail field per-bank, hanya konsumsi shape ini.
 *
 * `now`: wajib utk resolusi balance_position_time (guard "timestamp masa
 * depan" & anchor DATE-precision OCBC/BCA) -- default `new Date()` kalau
 * tidak dikirim (dipanggil tanpa now di test lama/pemanggil lama).
 */
async function getActualBankBalance(pool, bankCode, now = new Date()) {
  const code = String(bankCode || '').toUpperCase();
  const fn = ADAPTERS[code];
  if (!fn) return unavailable(code, `Bank code "${bankCode}" tidak dikenal/didukung Balance & Funding.`);
  try {
    return await fn(pool, now);
  } catch (e) {
    console.error(`getActualBankBalance(${code}) error:`, e.message);
    return unavailable(code, `Gagal membaca saldo: ${e.message}`);
  }
}

module.exports = {
  BANK_CODES,
  CONFIDENCE,
  POSITION_PRECISION,
  getActualBankBalance,
  // exported untuk testability (pola sama seperti warroom-qris-control-tower.js)
  getOcbcBalance,
  getBcaBalance,
  getMandiriBalance,
  getBriLikeBalance,
  getBniBalance,
  resolveDateOnlyPosition,
  resolveTimePosition,
};
