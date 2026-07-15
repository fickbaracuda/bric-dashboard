/**
 * Rekonsiliasi FP vs Bank OCBC — War Room Payment Agent > Rekonsiliasi OCBC
 *
 * Sumber: 2 sheet Google Sheet ("DATA FP", "DATA BANK OCBC") dari spreadsheet
 * 1V8NwLKeVUo2zV4ez-K4V-Ymt3_PNk7DyNrsJktcb2tE — domain baru, terpisah dari
 * war-room lain manapun.
 *
 * Engine rekonsiliasi (reconcileTransactions) SENGAJA pure function (tidak
 * menyentuh DB) supaya bisa di-unit-test langsung — lihat
 * backend/scripts/test-reconciliation-ocbc.js.
 */

const pool = require('../db');
const crypto = require('crypto');

// Reuse token sync UMUM (sesuai instruksi) — BUKAN token khusus baru.
const SYNC_TOKEN = process.env.APPS_SCRIPT_TOKEN;

const DEFAULT_FEE_BIFAST = Number(process.env.RECON_OCBC_FEE_DEFAULT) || 25;
const DEFAULT_GRACE_MINUTES = Number(process.env.RECON_OCBC_GRACE_MINUTES) || 30;
const NUM_EPS = 0.5; // toleransi pembulatan rupiah saat membandingkan nominal

// Google Sheet "DATA BANK OCBC" dibatasi 5.000 baris mutasi TERBARU (bukan
// seluruh histori) — lihat backend/src/reconciliation coverage docs. Dipakai
// sbg ambang deteksi truncation, configurable via config.sourceLimit (mis.
// utk unit test dgn dataset kecil).
const DEFAULT_SOURCE_LIMIT = 5000;

const RECON_STATUSES = [
  'MATCHED', 'MATCHED_NO_FEE', 'PENDING_BANK', 'FP_ONLY', 'BANK_ONLY',
  'NOMINAL_MISMATCH', 'FEE_MISMATCH', 'DUPLICATE_FP', 'DUPLICATE_BANK',
  'REVERSAL', 'NEED_REVIEW',
];
const EXCEPTION_STATUSES = [
  'PENDING_BANK', 'FP_ONLY', 'BANK_ONLY', 'NOMINAL_MISMATCH', 'FEE_MISMATCH',
  'DUPLICATE_FP', 'DUPLICATE_BANK', 'REVERSAL', 'NEED_REVIEW',
];

// ─────────────────────────────────────────────────────────────────────────
// Helpers dasar
// ─────────────────────────────────────────────────────────────────────────
function extractToken(req) {
  return (
    req.headers['x-sync-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    req.body?.token ||
    null
  );
}

function nullIfEmpty(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Parser angka aman — WAJIB cek typeof number DULU (insiden Speedcash: titik
 * desimal number asli ikut terhapus kalau diproses sebagai string). Titik &
 * koma di sini berarti pemisah ribuan (Rupiah, tidak ada desimal bermakna).
 */
function cleanNum(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (raw === '' || raw === '-') return null;
  let cleaned = raw.replace(/rp/gi, '').trim();
  cleaned = cleaned.replace(/[.,]/g, '');
  cleaned = cleaned.replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * "DD/MM/YYYY" atau "DD/MM/YYYY HH:mm" (format OCBC apa adanya, kolom
 * Transaction Date/Value Date sering berupa TEXT bukan Date object di
 * sheet) -> "YYYY-MM-DD". PENTING: m[1]=hari, m[2]=bulan — jangan tertukar
 * (insiden: sempat kebalik jadi YYYY-DD-MM, contoh "13/07/2026" jadi
 * "2026-13-07" yang ditolak Postgres karena bulan 13 tidak valid).
 * Regex TANPA jangkar `$` di akhir supaya trailing jam ("HH:mm") diabaikan,
 * bukan malah gagal match dan jatuh ke new Date() yang ambigu.
 */
function toIsoDate(value) {
  const s = nullIfEmpty(value);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseTimeResponse(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parser jam presisi TOLERAN dipakai utk `transaction_date_time` OCBC.
 * INSIDEN NYATA: Apps Script yang TERPASANG mengirim `transaction_date_time`
 * lewat `reconToIso_()`, tapi fungsi itu HANYA mem-format objek Date asli
 * dari `getValues()` ke ISO -- kalau sel sheet berupa TEXT (kasus nyata utk
 * kolom waktu OCBC), `reconToIso_()` cuma `return String(value).trim()`,
 * alias MENGEMBALIKAN STRING MENTAH "DD/MM/YYYY HH:mm" APA ADANYA, BUKAN
 * ISO. Kalau backend cuma percaya field ini sudah ISO lalu pakai
 * `new Date(value)` polos, hasilnya Invalid Date utk tanggal>12 (V8 salah
 * tafsir sbg MM/DD/YYYY) — dan KARENA field ini truthy, resolusi lama
 * berhenti di situ TANPA pernah mencoba fallback raw_data.A, sehingga
 * `transaction_date_time` kolom DB tetap NULL selamanya walau raw_data
 * jelas-jelas punya jamnya. Parser ini menerima BAIK ISO (native `new
 * Date()` bekerja) MAUPUN "DD/MM/YYYY[ HH:mm[:ss]]" mentah (di-anchor ke
 * Asia/Jakarta +07:00 via konstruksi ISO manual — bukan `new Date(string)`
 * langsung), dipakai jugak sbg basis fallback raw_data.
 */
function parseFlexibleOcbcDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const [, d, mo, y, h, mi, se] = m;
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${(h || '0').padStart(2, '0')}:${(mi || '0').padStart(2, '0')}:${(se || '0').padStart(2, '0')}+07:00`;
    const dt = new Date(iso);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const generic = new Date(s);
  return Number.isNaN(generic.getTime()) ? null : generic;
}

/**
 * Fallback ekstrak jam presisi transaksi bank OCBC dari `raw_data` mentah
 * (dump kolom sheet apa adanya) ketika field `transaction_date_time` kosong
 * ATAU tidak bisa di-parse (lihat catatan panjang `parseFlexibleOcbcDateTime`).
 * Kolom "A" pada raw_data OCBC SELALU berisi "DD/MM/YYYY HH:mm" (WIB) —
 * sudah tersedia hari ini juga, TANPA perlu menunggu update manual Apps
 * Script. Regex WAJIB komponen jam (bukan optional) supaya tidak salah
 * ambil kolom tanggal-saja (mis. kolom "B") sbg tengah malam.
 */
function parseOcbcRawDateTimeFallback(rawData) {
  if (!rawData || typeof rawData !== 'object') return null;
  const candidates = [rawData.A, ...Object.values(rawData)];
  for (const val of candidates) {
    if (typeof val !== 'string') continue;
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(val.trim());
    if (!m) continue;
    const [, d, mo, y, h, mi, se] = m;
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi.padStart(2, '0')}:${(se || '0').padStart(2, '0')}+07:00`;
    const dt = new Date(iso);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  return null;
}

/**
 * Resolusi tunggal jam presisi transaksi bank OCBC, dipakai di SEMUA jalur
 * (SNAPSHOT insert & BACKFILL): `transaction_date_time` (toleran ISO ATAU
 * "DD/MM/YYYY HH:mm" mentah) > fallback raw_data.A > date-only (fallback
 * terakhir, tanpa presisi jam -- coverage classification default aman ke
 * IN_BANK_COVERAGE).
 */
function resolveOcbcTransactionDateTime(row) {
  return parseFlexibleOcbcDateTime(row.transaction_date_time)
    || parseOcbcRawDateTimeFallback(row.raw_data)
    || parseTimeResponse(row.transaction_date);
}

function numEq(a, b) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < NUM_EPS;
}

/**
 * id_transaksi ASLI selalu murni digit. Insiden nyata: baris header CSV
 * ("id_transaksi,nominal,id_produk,...") ke-paste ke tengah data DATA FP
 * dalam satu sel (bukan terpisah per kolom), lolos sebagai "transaksi
 * hantu" di hasil rekonsiliasi. Dipakai sbg guard defense-in-depth di sync
 * handler (selain guard yang sama di Apps Script) — jangan andalkan Apps
 * Script saja untuk validasi ini.
 */
function isValidIdTransaksi(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function safeDiv(numerator, denominator) {
  if (typeof numerator !== 'number' || !Number.isFinite(numerator)) return null;
  if (typeof denominator !== 'number' || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Fallback dari Description bank ketika Reference No. kosong/tidak match.
 * Pola OCBC: "..../<id_outlet><id_transaksi>" — id_outlet diasumsikan 2
 * huruf + 5 digit (contoh nyata: "HH82915"), sisanya (>=6 digit) id_transaksi.
 * Kalau pola tidak cocok -> null (dianggap di luar scope rekon, BUKAN error).
 */
function parseDescriptionFallback(description) {
  if (!description) return null;
  const segments = String(description).split('/');
  const last = (segments[segments.length - 1] || '').trim();
  const m = /^([A-Za-z]{2}\d{5})(\d{6,})$/.exec(last);
  if (!m) return null;
  return { idOutlet: m[1], idTransaksi: m[2] };
}

/**
 * Normalisasi 1 nilai jadi canonical transaction key: `String()` + `trim()`
 * SAJA — TIDAK PERNAH diubah ke number (supaya leading zero & representasi
 * asli id_transaksi/Reference No. dipertahankan persis). null/undefined/
 * string kosong -> null. Dipakai konsisten di SELURUH titik yang perlu
 * membandingkan/menyimpan identitas 1 transaksi (grouping bank, lookup FP,
 * kolom `canonical_transaction_key` di DB) — supaya exact match (Reference
 * No.) dan fallback match (Description) TIDAK PERNAH diperlakukan sbg 2
 * transaksi berbeda hanya krn representasi string sedikit beda.
 */
function normalizeCanonicalKey(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * Group SELURUH baris bank OCBC jadi 1 group per canonical transaction key
 * — SATU pass, MENGGANTIKAN 2 index terpisah (bankByRef exact + fallback by
 * description) yang dipakai versi lama. Prioritas key per baris:
 *   1. Reference No. dinormalisasi (kalau tidak kosong).
 *   2. id_transaksi hasil fallback Description (HANYA kalau Reference No.
 *      kosong) — pola "..../<id_outlet><id_transaksi>".
 *   3. Kalau keduanya tidak menghasilkan key valid -> baris diabaikan (di
 *      luar scope rekonsiliasi, SAMA seperti perilaku lama).
 *
 * INSIDEN yang coba diperbaiki (root cause double result REVERSAL+
 * BANK_ONLY): versi lama membangun `bankByRef` (Map exact, dari SEMUA baris
 * ber-reference) dan `bankFallbackByIdTransaksi` (Map fallback, HANYA dari
 * baris YANG REFERENCE-NYA KOSONG) sbg 2 STRUKTUR TERPISAH yang tidak
 * saling sinkron. Kalau representasi Reference No. sedikit berbeda antar
 * baris principal/fee/credit milik 1 transaksi logis yang SAMA (mis. akibat
 * normalisasi angka vs string, leading zero hilang), grouping bisa retak
 * jadi 2 identitas berbeda: 1 group ketemu via exact match (menghasilkan
 * REVERSAL/MATCHED/dst di loop FP), sisanya (yang representasinya beda)
 * lolos sbg baris "tanpa pasangan FP" di loop BANK_ONLY. Dengan SATU
 * struktur group (Map, key sudah dinormalisasi identik di semua tempat)
 * dan mekanisme `consumedBankKeys` (lihat pemanggil), 1 transaksi logis
 * HANYA akan pernah menghasilkan TEPAT SATU recon result.
 *
 * expectedFee dipakai utk heuristik `hasPrincipal` (lihat field grup) —
 * bank_only TIDAK boleh dibuat dari grup yang HANYA berisi baris seukuran
 * fee (mis. Rp25) tanpa baris principal sungguhan.
 */
function buildOcbcBankGroups(bankRows, expectedFee) {
  const groups = new Map();
  for (const b of bankRows) {
    const ref = normalizeCanonicalKey(b.referenceNo);
    let canonicalKey = ref;
    let matchMethod = 'reference_exact';
    let candidateOutlet = null;
    if (!canonicalKey) {
      const parsed = parseDescriptionFallback(b.description);
      if (!parsed) continue; // tidak ada key valid sama sekali -> di luar scope, diabaikan
      canonicalKey = normalizeCanonicalKey(parsed.idTransaksi);
      if (!canonicalKey) continue;
      matchMethod = 'description_fallback';
      candidateOutlet = parsed.idOutlet;
    }
    if (!groups.has(canonicalKey)) {
      groups.set(canonicalKey, {
        canonicalKey, referenceNo: ref || null, extractedTransactionId: ref ? null : canonicalKey,
        matchMethod, candidateOutlet, rows: [],
      });
    }
    const g = groups.get(canonicalKey);
    g.rows.push(b);
    // Kalau ADA baris di group ini yang punya reference_no non-kosong,
    // group secara keseluruhan dianggap "reference_exact" (prioritas lebih
    // tinggi drpd fallback) — konsisten dgn aturan lama "exact diprioritaskan".
    if (ref && g.matchMethod === 'description_fallback') { g.matchMethod = 'reference_exact'; g.referenceNo = ref; }
    if (candidateOutlet && !g.candidateOutlet) g.candidateOutlet = candidateOutlet;
  }

  for (const g of groups.values()) {
    g.principalRows = g.rows.filter(r => typeof r.debit === 'number' && r.debit > 0);
    g.feeRows = []; // diisi kontekstual saat matching FP (fee = principal rows selain principal yg cocok nominal)
    g.creditRows = g.rows.filter(r => typeof r.credit === 'number' && r.credit > 0);
    g.totalDebit = g.principalRows.reduce((s, r) => s + r.debit, 0);
    g.totalCredit = g.creditRows.reduce((s, r) => s + r.credit, 0);
    g.hasCredit = g.creditRows.length > 0;
    g.hasFee = g.principalRows.length > 0;
    // hasPrincipal: minimal 1 baris debit yang BUKAN seukuran expected fee —
    // tanpa FP nominal utk dibandingkan, ini satu-satunya heuristik yg bisa
    // membedakan "principal sungguhan" dari "cuma baris fee nyasar tanpa
    // pasangan" (spec: bank_only tidak boleh dibuat dari grup fee-only).
    g.hasPrincipal = g.principalRows.some(r => !numEq(r.debit, expectedFee));
  }

  return groups;
}

// ─────────────────────────────────────────────────────────────────────────
// COVERAGE-AWARE RECONCILIATION — semua fungsi di bawah PURE, tidak
// menyentuh DB, supaya bisa di-unit-test langsung.
//
// Masalah yang diselesaikan: DATA BANK OCBC di Sheet dibatasi 5.000 baris
// TERBARU. Kalau bank_row_count >= source_limit, kita TIDAK BISA percaya
// "tidak ditemukan di bank" sebagai sinyal kegagalan utk transaksi FP yang
// lebih tua dari titik potong window itu — bisa jadi datanya memang belum/
// tidak lagi ada di snapshot, bukan gagal transfer. coverage_status adalah
// dimensi TERPISAH dari recon_status (bukan status ke-12).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Hitung window kepercayaan data bank dari satu set baris bank (biasanya
 * hasil query recon_bank_archive, yang sudah mencakup histori kumulatif —
 * BUKAN cuma snapshot 5.000 baris aktif). row.transactionDateTime WAJIB
 * berupa Date (atau null kalau presisi jam tidak tersedia).
 *
 * Kalau is_source_truncated: baris TERTUA menentukan "boundary minute" —
 * seluruh menit itu dianggap berpotensi terpotong (principal & fee bisa
 * kepisah oleh cutoff), trusted_coverage_start = awal menit BERIKUTNYA.
 */
function calculateOcbcCoverage(bankRows, config = {}) {
  const sourceLimit = Number.isFinite(config.sourceLimit) && config.sourceLimit > 0 ? config.sourceLimit : DEFAULT_SOURCE_LIMIT;
  const bankRowCount = Array.isArray(bankRows) ? bankRows.length : 0;
  const isSourceTruncated = bankRowCount >= sourceLimit;

  const timed = (bankRows || []).filter(b => b.transactionDateTime instanceof Date && !Number.isNaN(b.transactionDateTime.getTime()));

  if (!timed.length) {
    return {
      sourceLimit, bankRowCount, isSourceTruncated,
      snapshotOldestTime: null, snapshotNewestTime: null,
      trustedCoverageStart: null, coverageEnd: null,
      boundaryMinuteStart: null, boundaryMinuteEnd: null,
    };
  }

  const times = timed.map(b => b.transactionDateTime.getTime());
  const oldestMs = Math.min(...times);
  const newestMs = Math.max(...times);
  const snapshotOldestTime = new Date(oldestMs);
  const snapshotNewestTime = new Date(newestMs);

  if (!isSourceTruncated) {
    return {
      sourceLimit, bankRowCount, isSourceTruncated,
      snapshotOldestTime, snapshotNewestTime,
      trustedCoverageStart: null, coverageEnd: snapshotNewestTime,
      boundaryMinuteStart: null, boundaryMinuteEnd: null,
    };
  }

  // Boundary minute = menit kalender dari transaksi TERTUA (detik/ms dibuang).
  const boundaryMinuteStart = new Date(Math.floor(oldestMs / 60000) * 60000);
  const boundaryMinuteEnd = new Date(boundaryMinuteStart.getTime() + 60000 - 1);
  const trustedCoverageStart = new Date(boundaryMinuteStart.getTime() + 60000);

  return {
    sourceLimit, bankRowCount, isSourceTruncated,
    snapshotOldestTime, snapshotNewestTime,
    trustedCoverageStart, coverageEnd: snapshotNewestTime,
    boundaryMinuteStart, boundaryMinuteEnd,
  };
}

/**
 * "Lengkap" berarti group bank yang match punya TEPAT SATU baris principal
 * (debit == nominal FP) DAN baris fee yang jumlahnya sesuai expected fee.
 * Dipakai utk memutuskan apakah transaksi PERSIS DI BOUNDARY minute tetap
 * boleh MATCHED normal (datanya kebetulan tidak terpotong) — vs BOUNDARY_PARTIAL
 * (principal/fee-nya kepisah oleh cutoff 5.000 baris).
 */
function isCompleteOcbcGroup(bankGroup, fpNominal, expectedFee) {
  if (!bankGroup || !bankGroup.length || fpNominal === null || typeof fpNominal !== 'number') return false;
  const debitRows = bankGroup.filter(b => typeof b.debit === 'number' && b.debit > 0);
  const principalRows = debitRows.filter(b => numEq(b.debit, fpNominal));
  if (principalRows.length !== 1) return false; // 0 (tidak ada) atau >1 (duplicate) -> bukan "lengkap"
  const feeRows = debitRows.filter(b => b !== principalRows[0]);
  if (!feeRows.length) return false; // MATCHED_NO_FEE tetap dianggap TIDAK lengkap di boundary -- sengaja konservatif
  const feeTotal = feeRows.reduce((s, b) => s + b.debit, 0);
  return numEq(feeTotal, expectedFee);
}

/**
 * Klasifikasi coverage SATU transaksi FP. bankGroup adalah kandidat bank row
 * yang sudah ditemukan lewat reference_exact/description_fallback (bisa
 * null/kosong kalau belum ada match sama sekali).
 */
function classifyFpCoverage(fpRow, coverage, bankGroup, expectedFee) {
  if (!coverage || !coverage.isSourceTruncated) {
    return { coverageStatus: 'IN_BANK_COVERAGE', coverageReason: null };
  }

  // Match yang SUDAH lengkap menang atas klasifikasi waktu apa pun --
  // datanya terbukti utuh, tidak terpotong window.
  const fpNominal = typeof fpRow.nominal === 'number' ? fpRow.nominal : null;
  if (isCompleteOcbcGroup(bankGroup, fpNominal, expectedFee)) {
    return { coverageStatus: 'IN_BANK_COVERAGE', coverageReason: null };
  }

  const fpTime = fpRow.timeResponse instanceof Date && !Number.isNaN(fpRow.timeResponse.getTime()) ? fpRow.timeResponse : null;
  if (!fpTime || !coverage.trustedCoverageStart) {
    return { coverageStatus: 'IN_BANK_COVERAGE', coverageReason: null };
  }

  const t = fpTime.getTime();
  if (t < coverage.boundaryMinuteStart.getTime()) {
    return {
      coverageStatus: 'OUTSIDE_BANK_COVERAGE',
      coverageReason: `Transaksi FP (${fpTime.toISOString()}) lebih lama dari cakupan data OCBC yang tersedia (mulai ${coverage.trustedCoverageStart.toISOString()}). Snapshot bank dibatasi ${coverage.sourceLimit} baris terbaru.`,
    };
  }
  if (t <= coverage.boundaryMinuteEnd.getTime()) {
    return {
      coverageStatus: 'BOUNDARY_PARTIAL',
      coverageReason: `Transaksi FP berada pada menit batas snapshot ${coverage.sourceLimit} baris OCBC (${coverage.boundaryMinuteStart.toISOString()}–${coverage.boundaryMinuteEnd.toISOString()}) — data referensi berpotensi terpotong antara principal dan fee.`,
    };
  }
  return { coverageStatus: 'IN_BANK_COVERAGE', coverageReason: null };
}

/**
 * Normalisasi 1 nilai jadi string stabil sebelum di-hash — memastikan
 * fingerprint TIDAK berubah akibat perbedaan representasi (mis. angka vs
 * string, trailing space) padahal transaksinya sama persis.
 */
function normalizeForFingerprint(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}
function normalizeNumForFingerprint(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '';
}
/**
 * INSIDEN NYATA (pola sama dgn balance & description sebelumnya): detik
 * pada transaction_date_time utk 1 mutasi bank yang SAMA persis (reference_no,
 * description, debit/credit identik) bisa berbeda antar sync (mis. terbaca
 * "07:49:00" pada satu sync, "07:49:20" beberapa jam kemudian pada sync
 * berikutnya) — kemungkinan besar krn OCBC/Apps Script tidak menyimpan detik
 * yang stabil per baris. Fingerprint yang ikut memakai detik jadi BEDA utk
 * mutasi yang SAMA -> baris arsip duplikat -> DUPLICATE_BANK palsu (match
 * rate kolaps). Fix: buang detik & milidetik (truncate ke presisi MENIT)
 * sebelum dipakai sbg bagian fingerprint — presisi menit sudah cukup unik
 * digabung reference_no/description/debit/credit, dan ini KONSISTEN dgn
 * calculateOcbcCoverage() yang juga membuang detik saat menghitung boundary
 * minute (menit kalender dipercaya, detik tidak).
 */
function normalizeDateForFingerprint(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const truncated = new Date(value);
    truncated.setSeconds(0, 0);
    return truncated.toISOString();
  }
  return normalizeForFingerprint(value);
}

/**
 * Normalisasi Description SEBELUM dipakai sbg bagian fingerprint — INSIDEN
 * NYATA: teks Description utk mutasi bank yang SAMA persis (reference_no,
 * jam, debit/credit semua identik) bisa terbaca berbeda antar sync HANYA
 * krn tanda baca (apostrof di nama org, mis. "A'ISYAH" jadi "AISYAH",
 * "SU'UDI" jadi "SUUDI") — kemungkinan besar krn OCBC/spreadsheet
 * menormalisasi karakter itu secara tidak konsisten antar pembacaan.
 * Fingerprint yang ikut memakai teks Description mentah jadi BEDA utk
 * mutasi yang SAMA, menghasilkan baris arsip duplikat -> `DUPLICATE_BANK`
 * palsu (mirip pola insiden `balance` sebelumnya). Fix: buang SEMUA
 * karakter selain huruf/angka/garis-miring (garis miring dipertahankan krn
 * jadi separator penting bagi parseDescriptionFallback), lalu uppercase --
 * "NUR A'ISYAH/HH8..." dan "NUR AISYAH/HH8..." sama2 jadi
 * "NURAISYAH/HH8..." setelah normalisasi ini.
 */
function normalizeDescriptionForFingerprint(description) {
  if (!description) return '';
  return String(description).toUpperCase().replace(/[^A-Z0-9/]/g, '');
}

/**
 * Fingerprint stabil 1 baris mutasi bank — SENGAJA TIDAK memakai
 * source_row_number (posisi baris bisa berubah begitu window 5.000 baris
 * Sheets bergeser antar sync). SHA-256 dari kombinasi field yang secara
 * bersama-sama mengidentifikasi 1 mutasi bank secara unik.
 *
 * SENGAJA TIDAK memakai `balance` — running balance OCBC utk 1 mutasi yang
 * SAMA bisa berubah antar sync (transaksi lain yang clear belakangan
 * menggeser saldo berjalan yang dilaporkan), terbukti dari insiden nyata:
 * reference_no yang identik (bank_code, account_no, reference_no,
 * description, debit, credit sama persis) menghasilkan balance berbeda
 * ~20 menit kemudian, sehingga fingerprint lama meledak jadi baris arsip
 * duplikat dan match rate kolaps jadi DUPLICATE_BANK. balance tetap
 * disimpan di kolom archive (informational, di-refresh via ON CONFLICT),
 * hanya tidak dipakai sebagai bagian identitas.
 *
 * `description` DINORMALISASI (bukan dipakai mentah) — lihat catatan
 * panjang normalizeDescriptionForFingerprint() — insiden nyata KEDUA dgn
 * pola sama: apostrof pada nama pelanggan hilang/muncul beda antar sync
 * utk mutasi yang identik, menyebabkan DUPLICATE_BANK palsu.
 */
function computeBankRowFingerprint(row) {
  const parts = [
    normalizeForFingerprint(row.bankCode).toUpperCase(),
    normalizeForFingerprint(row.accountNo),
    normalizeDateForFingerprint(row.transactionDateTime),
    normalizeForFingerprint(row.valueDate),
    normalizeForFingerprint(row.referenceNo),
    normalizeDescriptionForFingerprint(row.description),
    normalizeNumForFingerprint(row.debit),
    normalizeNumForFingerprint(row.credit),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * Siapkan baris arsip (row_fingerprint + business_date sendiri, DIAMBIL DARI
 * transaction_date_time baris itu — BUKAN business_date batch sync — supaya
 * archive tetap benar lintas hari) dari raw bank row hasil parse sync.
 * TIDAK menyentuh DB — hanya transformasi bentuk, siap di-upsert oleh caller.
 */
function buildOcbcBankArchiveRows(bankRows, snapshotId) {
  return (bankRows || []).map(row => {
    const businessDate = row.transactionDateTime instanceof Date && !Number.isNaN(row.transactionDateTime.getTime())
      ? formatDateJakartaOcbc(row.transactionDateTime)
      : (row.transactionDate || null);
    return {
      fingerprint: computeBankRowFingerprint(row),
      bankCode: normalizeForFingerprint(row.bankCode).toUpperCase() || 'OCBC',
      accountNo: nullIfEmpty(row.accountNo),
      businessDate,
      transactionDateTime: row.transactionDateTime instanceof Date ? row.transactionDateTime : null,
      valueDate: nullIfEmpty(row.valueDate),
      referenceNo: nullIfEmpty(row.referenceNo),
      chequeNo: nullIfEmpty(row.chequeNo),
      description: nullIfEmpty(row.description),
      debit: typeof row.debit === 'number' ? row.debit : null,
      credit: typeof row.credit === 'number' ? row.credit : null,
      balance: typeof row.balance === 'number' ? row.balance : null,
      sourceSnapshotId: snapshotId || null,
      sourceRowNumber: Number.isFinite(row.sourceRowNumber) ? row.sourceRowNumber : null,
      rawData: row.rawData || {},
    };
  });
}

/**
 * Format instant (Date) sebagai "YYYY-MM-DD" dalam Asia/Jakarta — dipakai
 * utk business_date archive (bukan .toISOString().slice(0,10) yang selalu
 * UTC; lihat insiden serupa yang sudah pernah terjadi di Rekonsiliasi
 * Mandiri — geser mundur 1 hari utk jam dini hari WIB).
 */
function formatDateJakartaOcbc(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// ─────────────────────────────────────────────────────────────────────────
// Engine rekonsiliasi — PURE FUNCTION, tidak menyentuh DB (lihat unit test)
// ─────────────────────────────────────────────────────────────────────────
function reconcileTransactions(fpRows, bankRows, config = {}, now = new Date()) {
  const expectedFee = typeof config.expectedFee === 'number' && Number.isFinite(config.expectedFee) ? config.expectedFee : DEFAULT_FEE_BIFAST;
  const graceMinutes = typeof config.graceMinutes === 'number' && Number.isFinite(config.graceMinutes) ? config.graceMinutes : DEFAULT_GRACE_MINUTES;

  // Grouping bank per canonical transaction key — SATU struktur (bukan 2
  // index terpisah exact+fallback yang bisa retak jadi 2 identitas berbeda
  // utk 1 transaksi logis yang sama, lihat catatan panjang di
  // buildOcbcBankGroups). consumedBankKeys menandai group yang SUDAH
  // dipakai FP manapun (apa pun status akhirnya) supaya tidak PERNAH lagi
  // jadi kandidat BANK_ONLY — root cause fix insiden REVERSAL+BANK_ONLY
  // double count utk reference yang sama.
  const bankGroups = buildOcbcBankGroups(bankRows, expectedFee);
  const consumedBankKeys = new Set();

  // Deteksi duplikat id_transaksi di FP
  const fpCountById = new Map();
  for (const f of fpRows) {
    const id = normalizeCanonicalKey(f.idTransaksi);
    if (!id) continue;
    fpCountById.set(id, (fpCountById.get(id) || 0) + 1);
  }

  const results = [];
  const processedIds = new Set();

  for (const fp of fpRows) {
    const idTransaksi = normalizeCanonicalKey(fp.idTransaksi);
    if (!idTransaksi || processedIds.has(idTransaksi)) continue;
    processedIds.add(idTransaksi);

    const isDuplicateFp = (fpCountById.get(idTransaksi) || 0) > 1;
    const matchedGroup = bankGroups.get(idTransaksi) || null;
    const matchingMethod = matchedGroup ? matchedGroup.matchMethod : null;

    const fpTimeResponse = fp.timeResponse instanceof Date && !Number.isNaN(fp.timeResponse.getTime()) ? fp.timeResponse : null;
    const agingMinutes = fpTimeResponse ? Math.round((now.getTime() - fpTimeResponse.getTime()) / 60000) : null;

    const result = {
      idTransaksi, referenceNo: null, idOutlet: fp.idOutlet || null, idProduk: fp.idProduk || null, idBiller: fp.idBiller || null,
      fpNominal: typeof fp.nominal === 'number' ? fp.nominal : null, fpTimeResponse, bankTransactionDate: null,
      bankPrincipal: null, bankFee: null, bankCredit: null, bankTotalDebit: null,
      variancePrincipal: null, varianceFee: null,
      matchingMethod: matchingMethod || 'none', reconStatus: 'NEED_REVIEW', agingMinutes, notes: null,
    };

    if (isDuplicateFp) {
      result.reconStatus = 'DUPLICATE_FP';
      result.notes = `id_transaksi muncul ${fpCountById.get(idTransaksi)} kali di DATA FP.`;
      results.push(result);
      continue;
    }

    if (!matchedGroup || !matchedGroup.rows.length) {
      result.reconStatus = (agingMinutes !== null && agingMinutes < graceMinutes) ? 'PENDING_BANK' : 'FP_ONLY';
      results.push(result);
      continue;
    }

    // Tandai consumed SEGERA, SEBELUM cascade status ditentukan — group ini
    // valid sbg pasangan FP apa pun hasil akhirnya (MATCHED, NOMINAL_MISMATCH,
    // DUPLICATE_BANK, REVERSAL, dst), sehingga TIDAK BOLEH lagi jadi BANK_ONLY.
    consumedBankKeys.add(matchedGroup.canonicalKey);

    result.referenceNo = matchingMethod === 'reference_exact' ? idTransaksi : (matchedGroup.referenceNo || null);
    result.bankTransactionDate = matchedGroup.rows[0].transactionDate || null;

    const debitRows = matchedGroup.principalRows;
    const creditRows = matchedGroup.creditRows;
    const bankCreditTotal = matchedGroup.totalCredit;
    const bankTotalDebit = matchedGroup.totalDebit;

    result.bankCredit = creditRows.length ? bankCreditTotal : null;
    result.bankTotalDebit = debitRows.length ? bankTotalDebit : null;

    const fpNominal = result.fpNominal;
    const principalCandidates = (fpNominal !== null) ? debitRows.filter(b => numEq(b.debit, fpNominal)) : [];

    if (principalCandidates.length === 0) {
      if (debitRows.length === 0) {
        result.reconStatus = 'NEED_REVIEW';
        result.notes = 'Reference/deskripsi ditemukan tapi tidak ada baris debit sama sekali (hanya credit).';
      } else {
        result.reconStatus = 'NOMINAL_MISMATCH';
        result.notes = `Tidak ada debit yang sama dengan nominal FP (Rp${fpNominal}). Debit ditemukan: ${debitRows.map(b => b.debit).join(', ')}.`;
      }
    } else if (principalCandidates.length > 1) {
      result.reconStatus = 'DUPLICATE_BANK';
      result.bankPrincipal = principalCandidates[0].debit;
      result.notes = `${principalCandidates.length} baris debit bank sama-sama cocok dengan nominal FP pada reference yang sama.`;
    } else {
      const principalRow = principalCandidates[0];
      result.bankPrincipal = principalRow.debit;
      const feeRows = debitRows.filter(b => b !== principalRow);
      const bankFee = feeRows.reduce((s, b) => s + b.debit, 0);
      result.bankFee = feeRows.length ? bankFee : 0;
      result.variancePrincipal = 0;
      result.varianceFee = result.bankFee - expectedFee;

      if (feeRows.length === 0) result.reconStatus = 'MATCHED_NO_FEE';
      else if (numEq(bankFee, expectedFee)) result.reconStatus = 'MATCHED';
      else result.reconStatus = 'FEE_MISMATCH';
    }

    // Credit/reversal MENIMPA status di atas — sinyal reversal lebih kuat
    if (creditRows.length > 0) {
      result.reconStatus = 'REVERSAL';
      result.notes = [result.notes, `Ditemukan ${creditRows.length} baris credit (reversal/refund) sebesar Rp${bankCreditTotal}.`].filter(Boolean).join(' ');
    }

    results.push(result);
  }

  // BANK_ONLY / REVERSAL tanpa FP — per GROUP (bukan per baris bank), HANYA
  // dari group yang BELUM pernah consumed FP manapun di atas. fpIdSet dicek
  // juga sbg defense-in-depth kedua (redundan dgn consumedBankKeys secara
  // teori, tapi eksplisit sesuai spec supaya robust thd kemungkinan edge case).
  //
  // Group yang punya debit (principal DAN/ATAU fee) SEKALIGUS credit --
  // artinya transaksi itu SENDIRI sudah reversed sepenuhnya di sisi bank,
  // tanpa pernah ada pasangan FP -- diberi label REVERSAL (bukan BANK_ONLY),
  // supaya tidak tercampur secara visual dgn BANK_ONLY "murni" (uang keluar
  // TANPA jejak reversal apa pun, butuh investigasi berbeda). Kedua kasus
  // TETAP actionable/masuk Exception Queue (tidak ada FP = tetap perlu
  // ditelusuri kenapa transaksi bank ini tidak tercatat di sistem FP), hanya
  // labelnya yang dibedakan.
  const fpIdSet = new Set(fpRows.map(f => normalizeCanonicalKey(f.idTransaksi)).filter(Boolean));
  for (const group of bankGroups.values()) {
    if (consumedBankKeys.has(group.canonicalKey)) continue;
    if (fpIdSet.has(group.canonicalKey)) continue;

    const hasAnyDebit = group.hasFee; // hasFee = minimal 1 baris debit (principal atau fee), lihat buildOcbcBankGroups
    const isReversalNoFp = group.hasCredit && hasAnyDebit;
    if (!group.hasPrincipal && !isReversalNoFp) continue; // fee-only ATAU credit-only (tanpa debit sama sekali) -> bukan BANK_ONLY/REVERSAL

    results.push({
      // referenceNo WAJIB tidak null (fallback ke canonicalKey) supaya key
      // upsert/canonical_transaction_key unik per kandidat BANK_ONLY/REVERSAL.
      idTransaksi: null, referenceNo: group.referenceNo || group.canonicalKey, idOutlet: group.candidateOutlet, idProduk: null, idBiller: null,
      fpNominal: null, fpTimeResponse: null, bankTransactionDate: group.rows[0].transactionDate || null,
      bankPrincipal: null, bankFee: null, bankCredit: group.hasCredit ? group.totalCredit : null,
      bankTotalDebit: group.hasFee ? group.totalDebit : null,
      variancePrincipal: null, varianceFee: null,
      matchingMethod: group.matchMethod,
      reconStatus: isReversalNoFp ? 'REVERSAL' : 'BANK_ONLY', agingMinutes: null,
      notes: isReversalNoFp
        ? `Ditemukan reversal di bank (kandidat id_transaksi: ${group.canonicalKey}, debit Rp${group.totalDebit} dibalik credit Rp${group.totalCredit}) tapi tidak ada di DATA FP.`
        : `Ditemukan di bank (kandidat id_transaksi: ${group.canonicalKey}) tapi tidak ada di DATA FP.`,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────
// Wrapper coverage-aware — dipakai syncHandler (BUKAN reconcileTransactions
// biasa, yang SENGAJA dibiarkan tidak berubah demi 28 unit test lama & demi
// tidak mengubah kontrak fungsi yang mungkin dipakai tempat lain). Kalau
// data bank TIDAK truncated (bankRowCount < sourceLimit — kasus normal
// sehari-hari, dan SEMUA unit test lama krn datanya kecil), setiap baris
// otomatis coverage_status=IN_BANK_COVERAGE dan cascade berjalan 100% sama
// seperti reconcileTransactions() asli — hasilnya harus identik.
//
// bankRows di sini diharapkan sudah berasal dari recon_bank_archive (bukan
// cuma snapshot 5.000 baris aktif) — lihat syncHandler. Setiap item BOLEH
// membawa flag `fromArchive: true` kalau row itu TIDAK ada di snapshot
// TERKINI (murni historis) — dipakai utk menandai archive_match.
// ─────────────────────────────────────────────────────────────────────────
function reconcileTransactionsWithCoverage(fpRows, bankRows, config = {}, now = new Date()) {
  const expectedFee = typeof config.expectedFee === 'number' && Number.isFinite(config.expectedFee) ? config.expectedFee : DEFAULT_FEE_BIFAST;
  const graceMinutes = typeof config.graceMinutes === 'number' && Number.isFinite(config.graceMinutes) ? config.graceMinutes : DEFAULT_GRACE_MINUTES;

  // config.coverage: dipakai produksi (syncHandler) supaya coverage dihitung
  // dari SNAPSHOT aktif (bankRowCount vs source_limit), BUKAN dari bankRows
  // di sini yang bisa berisi seluruh archive kumulatif (jauh lebih besar
  // dari source_limit begitu archive bertambah lintas hari, dan kalau ikut
  // dihitung akan SELALU salah menganggap truncated). Kalau tidak diberikan
  // (mis. unit test dgn array flat sederhana), hitung otomatis dari bankRows.
  const coverage = config.coverage || calculateOcbcCoverage(bankRows, config);

  // Grouping bank per canonical transaction key + consumedBankKeys — lihat
  // catatan panjang di buildOcbcBankGroups() & reconcileTransactions() utk
  // root cause fix insiden REVERSAL+BANK_ONLY double count.
  const bankGroups = buildOcbcBankGroups(bankRows, expectedFee);
  const consumedBankKeys = new Set();

  const fpCountById = new Map();
  for (const f of fpRows) {
    const id = normalizeCanonicalKey(f.idTransaksi);
    if (!id) continue;
    fpCountById.set(id, (fpCountById.get(id) || 0) + 1);
  }

  const results = [];
  const processedIds = new Set();

  for (const fp of fpRows) {
    const idTransaksi = normalizeCanonicalKey(fp.idTransaksi);
    if (!idTransaksi || processedIds.has(idTransaksi)) continue;
    processedIds.add(idTransaksi);

    const isDuplicateFp = (fpCountById.get(idTransaksi) || 0) > 1;
    const matchedGroup = bankGroups.get(idTransaksi) || null;
    const matchingMethod = matchedGroup ? matchedGroup.matchMethod : null;
    const matchedBankRows = matchedGroup ? matchedGroup.rows : null;

    const fpTimeResponse = fp.timeResponse instanceof Date && !Number.isNaN(fp.timeResponse.getTime()) ? fp.timeResponse : null;
    const agingMinutes = fpTimeResponse ? Math.round((now.getTime() - fpTimeResponse.getTime()) / 60000) : null;

    const result = {
      idTransaksi, referenceNo: null, idOutlet: fp.idOutlet || null, idProduk: fp.idProduk || null, idBiller: fp.idBiller || null,
      fpNominal: typeof fp.nominal === 'number' ? fp.nominal : null, fpTimeResponse, bankTransactionDate: null,
      bankPrincipal: null, bankFee: null, bankCredit: null, bankTotalDebit: null,
      variancePrincipal: null, varianceFee: null,
      matchingMethod: matchingMethod || 'none', reconStatus: 'NEED_REVIEW', agingMinutes, notes: null,
      coverageStatus: 'IN_BANK_COVERAGE', coverageReason: null, isActionable: true, eligibleForMatchRate: true, archiveMatch: false,
    };

    if (isDuplicateFp) {
      result.reconStatus = 'DUPLICATE_FP';
      result.notes = `id_transaksi muncul ${fpCountById.get(idTransaksi)} kali di DATA FP.`;
      results.push(result);
      continue;
    }

    const { coverageStatus, coverageReason } = classifyFpCoverage(fp, coverage, matchedBankRows, expectedFee);
    result.coverageStatus = coverageStatus;
    result.coverageReason = coverageReason;

    if (coverageStatus === 'OUTSIDE_BANK_COVERAGE' || coverageStatus === 'BOUNDARY_PARTIAL') {
      // BUKAN exception — recon_status sengaja NULL, tidak actionable, tidak
      // dihitung match rate. Kalau kebetulan ada partial bank data (mis. fee
      // saja di BOUNDARY_PARTIAL), tetap dicatat sbg referensi visual di Raw
      // Data, tapi tidak pernah dipaksa jadi NEED_REVIEW/NOMINAL_MISMATCH.
      // TETAP tandai consumed kalau group ditemukan -- group ini SUDAH
      // "dipakai" utk FP ini (walau tidak actionable), jangan sampai ganda
      // muncul lagi sbg BANK_ONLY di luar cakupan.
      result.reconStatus = null;
      result.isActionable = false;
      result.eligibleForMatchRate = false;
      if (matchedGroup && matchedGroup.rows.length) {
        consumedBankKeys.add(matchedGroup.canonicalKey);
        result.referenceNo = matchingMethod === 'reference_exact' ? idTransaksi : (matchedGroup.referenceNo || null);
        result.bankTransactionDate = matchedGroup.rows[0].transactionDate || null;
        result.bankTotalDebit = matchedGroup.principalRows.length ? matchedGroup.totalDebit : null;
        result.bankCredit = matchedGroup.creditRows.length ? matchedGroup.totalCredit : null;
        result.archiveMatch = matchedGroup.rows.some(b => b.fromArchive === true);
      }
      results.push(result);
      continue;
    }

    // ── coverage_status = IN_BANK_COVERAGE -> cascade normal, IDENTIK dgn
    // reconcileTransactions() asli ──
    if (!matchedGroup || !matchedGroup.rows.length) {
      result.reconStatus = (agingMinutes !== null && agingMinutes < graceMinutes) ? 'PENDING_BANK' : 'FP_ONLY';
      results.push(result);
      continue;
    }

    // Tandai consumed SEGERA, SEBELUM cascade status ditentukan (lihat
    // catatan panjang di reconcileTransactions()).
    consumedBankKeys.add(matchedGroup.canonicalKey);

    result.referenceNo = matchingMethod === 'reference_exact' ? idTransaksi : (matchedGroup.referenceNo || null);
    result.bankTransactionDate = matchedGroup.rows[0].transactionDate || null;
    result.archiveMatch = matchedGroup.rows.some(b => b.fromArchive === true);

    const debitRows = matchedGroup.principalRows;
    const creditRows = matchedGroup.creditRows;
    const bankCreditTotal = matchedGroup.totalCredit;
    const bankTotalDebit = matchedGroup.totalDebit;

    result.bankCredit = creditRows.length ? bankCreditTotal : null;
    result.bankTotalDebit = debitRows.length ? bankTotalDebit : null;

    const fpNominal = result.fpNominal;
    const principalCandidates = (fpNominal !== null) ? debitRows.filter(b => numEq(b.debit, fpNominal)) : [];

    if (principalCandidates.length === 0) {
      if (debitRows.length === 0) {
        result.reconStatus = 'NEED_REVIEW';
        result.notes = 'Reference/deskripsi ditemukan tapi tidak ada baris debit sama sekali (hanya credit).';
      } else {
        result.reconStatus = 'NOMINAL_MISMATCH';
        result.notes = `Tidak ada debit yang sama dengan nominal FP (Rp${fpNominal}). Debit ditemukan: ${debitRows.map(b => b.debit).join(', ')}.`;
      }
    } else if (principalCandidates.length > 1) {
      result.reconStatus = 'DUPLICATE_BANK';
      result.bankPrincipal = principalCandidates[0].debit;
      result.notes = `${principalCandidates.length} baris debit bank sama-sama cocok dengan nominal FP pada reference yang sama.`;
    } else {
      const principalRow = principalCandidates[0];
      result.bankPrincipal = principalRow.debit;
      const feeRows = debitRows.filter(b => b !== principalRow);
      const bankFee = feeRows.reduce((s, b) => s + b.debit, 0);
      result.bankFee = feeRows.length ? bankFee : 0;
      result.variancePrincipal = 0;
      result.varianceFee = result.bankFee - expectedFee;

      if (feeRows.length === 0) result.reconStatus = 'MATCHED_NO_FEE';
      else if (numEq(bankFee, expectedFee)) result.reconStatus = 'MATCHED';
      else result.reconStatus = 'FEE_MISMATCH';
    }

    if (creditRows.length > 0) {
      result.reconStatus = 'REVERSAL';
      result.notes = [result.notes, `Ditemukan ${creditRows.length} baris credit (reversal/refund) sebesar Rp${bankCreditTotal}.`].filter(Boolean).join(' ');
    }

    results.push(result);
  }

  // ── BANK_ONLY / REVERSAL tanpa FP — per GROUP (bukan per baris bank).
  // HANYA dari group yang belum consumed FP manapun DAN, kalau truncated,
  // TIDAK boleh ada satu pun baris di group yang berada DI/SEBELUM boundary
  // minute (spec: "berada dalam trusted coverage" + "fee-only group pada
  // boundary jangan menjadi BANK_ONLY") — kalau salah satu baris grup masih
  // di zona batas yang berpotensi terpotong, seluruh grup dianggap belum
  // pasti lengkap.
  //
  // Group yang punya debit (principal DAN/ATAU fee) SEKALIGUS credit --
  // transaksi itu SENDIRI sudah reversed sepenuhnya di sisi bank, tanpa
  // pernah ada pasangan FP -- diberi label REVERSAL (bukan BANK_ONLY),
  // supaya tidak tercampur visual dgn BANK_ONLY "murni" (uang keluar TANPA
  // jejak reversal apa pun). Keduanya TETAP actionable/masuk Exception
  // Queue (tidak ada FP = tetap perlu ditelusuri), hanya labelnya beda. ──
  const fpIdSet = new Set(fpRows.map(f => normalizeCanonicalKey(f.idTransaksi)).filter(Boolean));
  for (const group of bankGroups.values()) {
    if (consumedBankKeys.has(group.canonicalKey)) continue;
    if (fpIdSet.has(group.canonicalKey)) continue;

    const hasAnyDebit = group.hasFee; // hasFee = minimal 1 baris debit (principal atau fee), lihat buildOcbcBankGroups
    const isReversalNoFp = group.hasCredit && hasAnyDebit;
    if (!group.hasPrincipal && !isReversalNoFp) continue; // fee-only ATAU credit-only (tanpa debit sama sekali) -> bukan BANK_ONLY/REVERSAL

    if (coverage.isSourceTruncated && coverage.boundaryMinuteEnd) {
      const hasBoundaryRow = group.rows.some(x => x.transactionDateTime instanceof Date && x.transactionDateTime.getTime() <= coverage.boundaryMinuteEnd.getTime());
      if (hasBoundaryRow) continue;
    }

    results.push({
      idTransaksi: null, referenceNo: group.referenceNo || group.canonicalKey, idOutlet: group.candidateOutlet, idProduk: null, idBiller: null,
      fpNominal: null, fpTimeResponse: null, bankTransactionDate: group.rows[0].transactionDate || null,
      bankPrincipal: null, bankFee: null, bankCredit: group.hasCredit ? group.totalCredit : null,
      bankTotalDebit: group.hasFee ? group.totalDebit : null,
      variancePrincipal: null, varianceFee: null,
      matchingMethod: group.matchMethod,
      reconStatus: isReversalNoFp ? 'REVERSAL' : 'BANK_ONLY', agingMinutes: null,
      notes: isReversalNoFp
        ? `Ditemukan reversal di bank (kandidat id_transaksi: ${group.canonicalKey}, debit Rp${group.totalDebit} dibalik credit Rp${group.totalCredit}) tapi tidak ada di DATA FP.`
        : `Ditemukan di bank (kandidat id_transaksi: ${group.canonicalKey}) tapi tidak ada di DATA FP.`,
      coverageStatus: 'IN_BANK_COVERAGE', coverageReason: null, isActionable: true, eligibleForMatchRate: true,
      archiveMatch: group.rows.some(x => x.fromArchive === true),
    });
  }

  return { results, coverage };
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/sync
// ─────────────────────────────────────────────────────────────────────────
/**
 * Upsert 1 batch baris mentah bank ke recon_bank_archive (fingerprint-
 * deduped) — dipakai baik oleh sync SNAPSHOT (chunk terakhir) maupun
 * BACKFILL. TIDAK PERNAH menghapus baris archive; hanya INSERT baru atau
 * UPDATE last_seen_at/source_snapshot_id kalau fingerprint sudah ada
 * (first_seen_at sengaja TIDAK disentuh saat re-upsert).
 */
async function upsertBankArchiveRows(client, archiveRows) {
  for (const a of archiveRows) {
    await client.query(
      `INSERT INTO recon_bank_archive
         (bank_code, account_no, business_date, transaction_date_time, value_date, reference_no, cheque_no,
          description, debit, credit, balance, row_fingerprint, source_snapshot_id, source_row_number, raw_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (row_fingerprint) DO UPDATE SET
         last_seen_at = NOW(), source_snapshot_id = EXCLUDED.source_snapshot_id,
         source_row_number = EXCLUDED.source_row_number, raw_data = EXCLUDED.raw_data,
         debit = EXCLUDED.debit, credit = EXCLUDED.credit, balance = EXCLUDED.balance`,
      [
        a.bankCode, a.accountNo, a.businessDate, a.transactionDateTime, a.valueDate, a.referenceNo, a.chequeNo,
        a.description, a.debit, a.credit, a.balance, a.fingerprint, a.sourceSnapshotId, a.sourceRowNumber,
        JSON.stringify(a.rawData || {}),
      ]
    );
  }
}

/**
 * Jalankan engine coverage-aware atas 1 batch & simpan hasilnya. Dipakai
 * oleh SNAPSHOT (chunk terakhir) maupun BACKFILL (setelah archive
 * diperkaya) — supaya logic "ambil FP, ambil archive, jalankan engine,
 * upsert recon_results, bersihkan baris basi" TIDAK terduplikasi.
 *
 * `snapshotMeta` = { id, sourceLimit, isTruncated, snapshotOldestTime,
 * snapshotNewestTime, trustedCoverageStart, coverageEnd } dari
 * recon_bank_snapshots yang relevan (baru dibuat utk SNAPSHOT, atau snapshot
 * TERAKHIR yang sudah ada utk BACKFILL — coverage TIDAK dihitung ulang dari
 * archive kumulatif, krn ukurannya akan >> source_limit begitu archive
 * bertambah dari waktu ke waktu, bukan mencerminkan window aktif Sheets).
 *
 * `businessDate` WAJIB diisi (string "YYYY-MM-DD") — INSIDEN NYATA: versi
 * sebelumnya query recon_bank_archive HANYA filter bank_code (+account_no),
 * TANPA batasan tanggal sama sekali. Begitu archive kumulatif mengandung
 * lebih dari 1 hari (mis. tanggal 13 DAN 14), setiap batch (termasuk batch
 * tanggal 14) ikut menarik SELURUH baris archive lintas tanggal ke dalam
 * engine, sehingga baris bank tanggal 13 yang tidak ada pasangan FP-nya di
 * batch tanggal 14 salah dijadikan BANK_ONLY milik batch tanggal 14. Archive
 * tetap kumulatif/historis (tidak dihapus), TAPI engine SATU batch hanya
 * boleh melihat baris archive dgn business_date PERSIS SAMA dgn business_date
 * batch itu -- filter di kolom `business_date` (bukan `transaction_date_time`
 * mentah), karena kolom itu SUDAH dihitung benar WIB-anchored sekali di saat
 * insert (lihat buildOcbcBankArchiveRows/formatDateJakartaOcbc), sehingga
 * tidak bergantung sama sekali pada timezone session database.
 */
async function runOcbcEngineAndPersist(client, { batchId, bankCode, accountNo, businessDate, snapshotMeta, configOverride, now }) {
  const fpAllRes = await client.query('SELECT * FROM recon_fp_transactions WHERE batch_id = $1', [batchId]);
  const fpForEngine = fpAllRes.rows.map(r => ({
    idTransaksi: r.id_transaksi, nominal: r.nominal !== null ? Number(r.nominal) : null,
    idProduk: r.id_produk, timeResponse: r.time_response ? new Date(r.time_response) : null,
    idOutlet: r.id_outlet, idBiller: r.id_biller,
  }));

  // Ambil bank row dari ARCHIVE (kumulatif), BUKAN cuma snapshot 5.000 baris
  // aktif — row lama yang sudah tergeser keluar window TAPI MASIH DALAM
  // business_date YANG SAMA tetap bisa dipakai utk matching. business_date
  // di-filter EQUALITY (bukan range/AT TIME ZONE) krn kolomnya sendiri sudah
  // WIB-anchored sejak insert -- lihat catatan panjang di atas.
  // business_date::text & value_date::text -> hindari shift kolom DATE
  // (insiden serupa di Rekonsiliasi Mandiri).
  const archiveParams = [bankCode, businessDate];
  let archiveWhere = 'bank_code = $1 AND business_date = $2';
  if (accountNo) { archiveParams.push(accountNo); archiveWhere += ` AND account_no = $${archiveParams.length}`; }
  const archiveRes = await client.query(
    `SELECT *, business_date::text AS business_date, value_date::text AS value_date FROM recon_bank_archive WHERE ${archiveWhere}`,
    archiveParams
  );
  const bankForEngine = archiveRes.rows.map(r => ({
    accountNo: r.account_no, transactionDate: r.business_date,
    transactionDateTime: r.transaction_date_time ? new Date(r.transaction_date_time) : null,
    referenceNo: r.reference_no, description: r.description,
    debit: r.debit !== null ? Number(r.debit) : null, credit: r.credit !== null ? Number(r.credit) : null,
    fromArchive: r.source_snapshot_id !== snapshotMeta.id,
  }));

  const coverage = {
    sourceLimit: snapshotMeta.sourceLimit, bankRowCount: snapshotMeta.rowCount, isSourceTruncated: snapshotMeta.isTruncated,
    snapshotOldestTime: snapshotMeta.snapshotOldestTime, snapshotNewestTime: snapshotMeta.snapshotNewestTime,
    trustedCoverageStart: snapshotMeta.trustedCoverageStart, coverageEnd: snapshotMeta.coverageEnd,
    boundaryMinuteStart: snapshotMeta.boundaryMinuteStart, boundaryMinuteEnd: snapshotMeta.boundaryMinuteEnd,
  };

  const { results } = reconcileTransactionsWithCoverage(fpForEngine, bankForEngine, { ...configOverride, coverage }, now);

  for (const r of results) {
    // canonical_transaction_key = identitas TUNGGAL 1 transaksi (id_transaksi
    // kalau ada, else reference_no) -- fix bug 1 transaksi logis (mis. yang
    // sudah REVERSAL) tersimpan sbg 2 baris berbeda gara2 BANK_ONLY lama
    // (id_transaksi NULL) punya kombinasi lama yang literal berbeda. Lihat
    // migration add_reconciliation_canonical_transaction_key(_unique).sql.
    const canonicalKey = normalizeCanonicalKey(r.idTransaksi) || normalizeCanonicalKey(r.referenceNo);
    await client.query(
      `INSERT INTO recon_results
         (batch_id, id_transaksi, reference_no, canonical_transaction_key, id_outlet, id_produk, id_biller, fp_nominal, fp_time_response,
          bank_transaction_date, bank_principal, bank_fee, bank_credit, bank_total_debit,
          variance_principal, variance_fee, matching_method, recon_status, aging_minutes, notes,
          coverage_status, coverage_reason, is_actionable, eligible_for_match_rate, bank_snapshot_id, archive_match, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,NOW())
       ON CONFLICT (batch_id, canonical_transaction_key) DO UPDATE SET
         id_transaksi = EXCLUDED.id_transaksi, reference_no = EXCLUDED.reference_no,
         id_outlet = EXCLUDED.id_outlet, id_produk = EXCLUDED.id_produk, id_biller = EXCLUDED.id_biller,
         fp_nominal = EXCLUDED.fp_nominal, fp_time_response = EXCLUDED.fp_time_response,
         bank_transaction_date = EXCLUDED.bank_transaction_date, bank_principal = EXCLUDED.bank_principal,
         bank_fee = EXCLUDED.bank_fee, bank_credit = EXCLUDED.bank_credit, bank_total_debit = EXCLUDED.bank_total_debit,
         variance_principal = EXCLUDED.variance_principal, variance_fee = EXCLUDED.variance_fee,
         matching_method = EXCLUDED.matching_method, recon_status = EXCLUDED.recon_status,
         aging_minutes = EXCLUDED.aging_minutes, notes = EXCLUDED.notes,
         coverage_status = EXCLUDED.coverage_status, coverage_reason = EXCLUDED.coverage_reason,
         is_actionable = EXCLUDED.is_actionable, eligible_for_match_rate = EXCLUDED.eligible_for_match_rate,
         bank_snapshot_id = EXCLUDED.bank_snapshot_id, archive_match = EXCLUDED.archive_match, updated_at = NOW()`,
      [
        batchId, r.idTransaksi, r.referenceNo, canonicalKey, r.idOutlet, r.idProduk, r.idBiller, r.fpNominal, r.fpTimeResponse,
        r.bankTransactionDate, r.bankPrincipal, r.bankFee, r.bankCredit, r.bankTotalDebit,
        r.variancePrincipal, r.varianceFee, r.matchingMethod, r.reconStatus, r.agingMinutes, r.notes,
        r.coverageStatus, r.coverageReason, r.isActionable, r.eligibleForMatchRate, snapshotMeta.id, r.archiveMatch,
      ]
    );
  }

  // Hapus recon_results lama yang tidak lagi dihasilkan engine (mis. baris FP
  // dihapus dari sheet, ATAU baris BANK_ONLY basi yang sekarang consumed jadi
  // REVERSAL/MATCHED/dst -- key sama, jadi row LAMA sudah di-UPDATE via
  // upsert di atas, bukan diduplikasi; DELETE ini hanya utk key yang benar2
  // sudah tidak dihasilkan sama sekali oleh run terbaru).
  const currentKeys = results
    .map(r => normalizeCanonicalKey(r.idTransaksi) || normalizeCanonicalKey(r.referenceNo))
    .filter(Boolean);
  await client.query(
    `DELETE FROM recon_results WHERE batch_id = $1 AND canonical_transaction_key <> ALL($2::text[])`,
    [batchId, currentKeys.length ? currentKeys : ['']]
  );

  return { fpRowCount: fpAllRes.rows.length, resultCount: results.length };
}

async function syncHandler(req, res) {
  const token = extractToken(req);
  if (!SYNC_TOKEN || token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const businessDate = nullIfEmpty(body.business_date);
  if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return res.status(400).json({ error: 'business_date wajib diisi, format YYYY-MM-DD' });
  }
  const bankCode = nullIfEmpty(body.bank_code) || 'OCBC';
  const syncMode = nullIfEmpty(body.sync_mode) === 'BACKFILL' ? 'BACKFILL' : 'SNAPSHOT';
  const chunkIndex = Number.isFinite(Number(body.chunk_index)) ? Number(body.chunk_index) : 0;
  const chunkTotal = (Number.isFinite(Number(body.chunk_total)) && Number(body.chunk_total) > 0) ? Number(body.chunk_total) : 1;
  const isFirstChunk = chunkIndex === 0;
  const isLastChunk = chunkIndex >= chunkTotal - 1;

  const fpRowsRaw = Array.isArray(body.fp) ? body.fp : [];
  const bankRowsRaw = Array.isArray(body.bank) ? body.bank : [];
  const sourceLimit = Number.isFinite(Number(body.config?.source_limit)) && Number(body.config.source_limit) > 0
    ? Number(body.config.source_limit) : DEFAULT_SOURCE_LIMIT;
  const configOverride = {
    expectedFee: Number.isFinite(Number(body.config?.expected_fee)) ? Number(body.config.expected_fee) : undefined,
    graceMinutes: Number.isFinite(Number(body.config?.grace_period_minutes)) ? Number(body.config.grace_period_minutes) : undefined,
  };
  const accountNo = nullIfEmpty(body.bank_summary?.account_number) || nullIfEmpty(body.account_no);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ═══════════════════════════════════════════════════════════════════
    // BACKFILL — perkaya recon_bank_archive dgn data historis TANPA
    // menyentuh raw snapshot aktif ataupun source_limit snapshot yg sudah
    // ada. Di chunk terakhir, jalankan ulang rekonsiliasi batch terkait.
    // ═══════════════════════════════════════════════════════════════════
    if (syncMode === 'BACKFILL') {
      const batchRes = await client.query(
        'SELECT id, account_no FROM recon_sync_batches WHERE business_date = $1 AND bank_code = $2',
        [businessDate, bankCode]
      );
      if (!batchRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Backfill gagal: belum ada batch SNAPSHOT utk business_date ${businessDate} bank ${bankCode}. Jalankan sync SNAPSHOT dulu.` });
      }
      const batchId = batchRes.rows[0].id;
      // Pakai account_no yang SUDAH TERSIMPAN di batch (stabil lintas chunk/
      // sync), BUKAN body.bank_summary request ini -- lihat catatan panjang
      // di cabang SNAPSHOT soal insiden account_no NULL utk mayoritas baris.
      const stableAccountNo = nullIfEmpty(batchRes.rows[0].account_no) || accountNo;

      const archiveRows = buildOcbcBankArchiveRows(
        bankRowsRaw.map(row => ({
          bankCode, accountNo: stableAccountNo,
          transactionDateTime: resolveOcbcTransactionDateTime(row),
          transactionDate: toIsoDate(row.transaction_date),
          valueDate: toIsoDate(row.value_date),
          referenceNo: nullIfEmpty(row.reference_no), chequeNo: nullIfEmpty(row.cheque_no), description: nullIfEmpty(row.description),
          debit: cleanNum(row.debit), credit: cleanNum(row.credit), balance: cleanNum(row.balance),
          sourceRowNumber: Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          rawData: row.raw_data || {},
        })),
        null // source_snapshot_id null utk backfill -- TIDAK membuat/mengubah snapshot manapun
      );
      await upsertBankArchiveRows(client, archiveRows);

      if (!isLastChunk) {
        await client.query('COMMIT');
        return res.json({ success: true, batch_id: batchId, chunk_index: chunkIndex, chunk_total: chunkTotal, sync_mode: syncMode, archive_rows_upserted: archiveRows.length, engine_run: false });
      }

      // Chunk terakhir -> jalankan ulang rekonsiliasi pakai snapshot TERAKHIR
      // yang sudah ada (source_limit/coverage TIDAK dihitung ulang/diubah).
      const snapRes = await client.query(
        'SELECT * FROM recon_bank_snapshots WHERE batch_id = $1 ORDER BY synced_at DESC LIMIT 1',
        [batchId]
      );
      const snap = snapRes.rows[0];
      const snapshotMeta = snap ? {
        id: snap.id, sourceLimit: snap.source_limit, rowCount: snap.row_count, isTruncated: snap.is_truncated,
        snapshotOldestTime: snap.snapshot_oldest_time, snapshotNewestTime: snap.snapshot_newest_time,
        trustedCoverageStart: snap.trusted_coverage_start, coverageEnd: snap.coverage_end,
        boundaryMinuteStart: snap.trusted_coverage_start ? new Date(new Date(snap.trusted_coverage_start).getTime() - 60000) : null,
        boundaryMinuteEnd: snap.trusted_coverage_start ? new Date(new Date(snap.trusted_coverage_start).getTime() - 1) : null,
      } : {
        id: null, sourceLimit, rowCount: 0, isTruncated: false,
        snapshotOldestTime: null, snapshotNewestTime: null, trustedCoverageStart: null, coverageEnd: null,
        boundaryMinuteStart: null, boundaryMinuteEnd: null,
      };

      const { fpRowCount, resultCount } = await runOcbcEngineAndPersist(client, {
        batchId, bankCode, accountNo: stableAccountNo, businessDate, snapshotMeta, configOverride, now: new Date(),
      });

      await client.query('COMMIT');
      return res.json({
        success: true, batch_id: batchId, business_date: businessDate, bank_code: bankCode, sync_mode: syncMode,
        fp_row_count: fpRowCount, result_count: resultCount, engine_run: true, synced_at: new Date().toISOString(),
      });
    }

    // ═══════════════════════════════════════════════════════════════════
    // SNAPSHOT — alur normal (tidak berubah dari sisi luar): terima chunk
    // FP/bank, replace raw snapshot batch ini, DAN TAMBAHAN: upsert setiap
    // baris bank ke recon_bank_archive supaya tidak hilang saat window
    // 5.000 baris bergeser di sync berikutnya.
    // ═══════════════════════════════════════════════════════════════════
    const batchNo = `${bankCode}-${businessDate}`;
    const batchRes = await client.query(
      `INSERT INTO recon_sync_batches (batch_no, business_date, bank_code, spreadsheet_id, fp_sheet_name, bank_sheet_name, account_no, fp_row_count, bank_row_count, synced_at, created_by, status, raw_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,NOW(),$8,'pending',$9)
       ON CONFLICT (business_date, bank_code) DO UPDATE SET
         batch_no = EXCLUDED.batch_no, spreadsheet_id = EXCLUDED.spreadsheet_id,
         fp_sheet_name = EXCLUDED.fp_sheet_name, bank_sheet_name = EXCLUDED.bank_sheet_name,
         account_no = COALESCE(EXCLUDED.account_no, recon_sync_batches.account_no),
         synced_at = NOW(), created_by = EXCLUDED.created_by, status = 'pending',
         raw_summary = CASE WHEN $9::jsonb <> '{}'::jsonb THEN $9::jsonb ELSE recon_sync_batches.raw_summary END
       RETURNING id, account_no`,
      [
        batchNo, businessDate, bankCode, nullIfEmpty(body.spreadsheet_id),
        nullIfEmpty(body.fp_sheet_name) || 'DATA FP', nullIfEmpty(body.bank_sheet_name) || 'DATA BANK OCBC',
        accountNo, nullIfEmpty(body.meta?.synced_by) || 'apps_script',
        JSON.stringify(body.bank_summary || {}),
      ]
    );
    const batchId = batchRes.rows[0].id;
    // INSIDEN: Apps Script hanya mengirim bank_summary.account_number di
    // CHUNK TERAKHIR (supaya tidak mengulang info yang sama tiap chunk).
    // Kalau kode di bawah pakai `accountNo` mentah (dari body request INI
    // SAJA), maka baris bank chunk 1..N-1 tersimpan dgn account_no NULL,
    // dan query archive di runOcbcEngineAndPersist (yang MEMFILTER by
    // account_no kalau ada nilainya) jadi HANYA melihat baris dari chunk
    // terakhir -- mayoritas baris (mis. 4500 dari 5000) tidak pernah dipakai
    // utk matching sama sekali, menyebabkan banyak FP salah jadi FP_ONLY/
    // NEED_REVIEW padahal sebenarnya match. `stableAccountNo` di bawah
    // adalah nilai yang SUDAH DI-COALESCE (dipertahankan lintas chunk &
    // resync) dari kolom batch -- dipakai utk SEMUA insert/pencarian baris
    // bank pada sync ini, bukan `accountNo` mentah per-request.
    const stableAccountNo = nullIfEmpty(batchRes.rows[0].account_no) || accountNo;

    // Chunk pertama -> mulai fresh (hapus data mentah lama batch ini). Ini
    // yang menjamin resync tidak menggandakan row (acceptance test 9).
    // TIDAK menghapus recon_bank_archive -- itu kumulatif, sengaja permanen.
    if (isFirstChunk) {
      await client.query('DELETE FROM recon_fp_transactions WHERE batch_id = $1', [batchId]);
      await client.query('DELETE FROM recon_bank_transactions WHERE batch_id = $1', [batchId]);
    }

    let fpInserted = 0;
    let fpSkippedInvalid = 0;
    let fpSkippedOutsideDate = 0;
    for (const row of fpRowsRaw) {
      const idTransaksi = nullIfEmpty(row.id_transaksi);
      if (!idTransaksi) continue;
      if (!isValidIdTransaksi(idTransaksi)) { fpSkippedInvalid++; continue; }
      const timeResponse = parseTimeResponse(row.time_response);
      // Defense-in-depth server-side (SAMA filosofi dgn reconValidateDates_ di
      // apps-script-reconciliation-ocbc.js, supaya tetap terlindungi walau
      // Apps Script yang live belum di-update ke versi yang punya filter itu).
      // INSIDEN NYATA: business_date payload dihitung Apps Script dari
      // "hari ini" (new Date()), TAPI sheet "DATA FP"/"DATA BANK OCBC" belum
      // sempat direfresh operator utk hari baru -- akibatnya baris FP hari
      // KEMARIN ikut terkirim & tersimpan di bawah label business_date HARI
      // INI. Karena recon_bank_archive utk business_date baru itu genuinely
      // masih kosong (bank row hari kemarin tersimpan di archive dgn
      // business_date-nya sendiri, bukan business_date batch), SELURUH FP
      // yang salah tanggal ini jadi FP_ONLY massal walau data aslinya sudah
      // match sempurna kemarin. Baris bank TIDAK difilter sepert ini (tetap
      // dikirim apa adanya) -- archive sudah mengatribusikan business_date
      // bank per baris dari transaction_date_time-nya sendiri, jadi baris
      // bank "kemarin" yang ikut terkirim aman, tidak pernah dipakai utk
      // matching batch hari ini.
      if (timeResponse) {
        const rowDate = formatDateJakartaOcbc(timeResponse);
        if (rowDate && rowDate !== businessDate) { fpSkippedOutsideDate++; continue; }
      }
      await client.query(
        `INSERT INTO recon_fp_transactions (batch_id, id_transaksi, nominal, id_produk, time_response, id_outlet, id_biller, source_row_number, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          batchId, idTransaksi, cleanNum(row.nominal), nullIfEmpty(row.id_produk),
          timeResponse, nullIfEmpty(row.id_outlet), nullIfEmpty(row.id_biller),
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      fpInserted++;
    }
    if (fpSkippedInvalid > 0) {
      console.warn(`reconciliation sync: ${fpSkippedInvalid} baris FP dilewati (id_transaksi bukan angka murni) untuk business_date ${businessDate}`);
    }
    if (fpSkippedOutsideDate > 0) {
      console.warn(`reconciliation sync: ${fpSkippedOutsideDate} baris FP dilewati (time_response di luar business_date ${businessDate} -- kemungkinan sheet DATA FP belum direfresh utk hari ini).`);
    }

    let bankInserted = 0;
    for (const row of bankRowsRaw) {
      const transactionDateTime = resolveOcbcTransactionDateTime(row);
      await client.query(
        `INSERT INTO recon_bank_transactions (batch_id, transaction_date, transaction_date_time, value_date, reference_no, cheque_no, description, debit, credit, balance, account_no, source_row_number, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          batchId, toIsoDate(row.transaction_date), transactionDateTime, toIsoDate(row.value_date),
          nullIfEmpty(row.reference_no), nullIfEmpty(row.cheque_no), nullIfEmpty(row.description),
          cleanNum(row.debit), cleanNum(row.credit), cleanNum(row.balance), stableAccountNo,
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      bankInserted++;
    }

    if (!isLastChunk) {
      await client.query('COMMIT');
      return res.json({ success: true, batch_id: batchId, chunk_index: chunkIndex, chunk_total: chunkTotal, fp_rows_inserted: fpInserted, fp_rows_skipped_outside_date: fpSkippedOutsideDate, bank_rows_inserted: bankInserted, engine_run: false });
    }

    // Chunk terakhir -> ambil SELURUH snapshot batch ini (transaction_date_time
    // presisi penuh) utk (1) hitung statistik cakupan, (2) upsert ke archive.
    const bankSnapshotRes = await client.query(
      `SELECT *, transaction_date::text AS transaction_date, value_date::text AS value_date FROM recon_bank_transactions WHERE batch_id = $1`,
      [batchId]
    );
    const bankSnapshotRows = bankSnapshotRes.rows.map(r => ({
      bankCode, accountNo: r.account_no || stableAccountNo,
      transactionDateTime: r.transaction_date_time ? new Date(r.transaction_date_time) : null,
      transactionDate: r.transaction_date, valueDate: r.value_date,
      referenceNo: r.reference_no, chequeNo: r.cheque_no, description: r.description,
      debit: r.debit !== null ? Number(r.debit) : null, credit: r.credit !== null ? Number(r.credit) : null,
      balance: r.balance !== null ? Number(r.balance) : null,
      sourceRowNumber: r.source_row_number, rawData: r.raw_data || {},
    }));

    const coverage = calculateOcbcCoverage(bankSnapshotRows, { sourceLimit });
    const uniqueRefCount = new Set(bankSnapshotRows.map(r => r.referenceNo).filter(Boolean)).size;

    const snapRes = await client.query(
      `INSERT INTO recon_bank_snapshots
         (batch_id, bank_code, account_no, synced_at, row_count, unique_reference_count, source_limit, is_truncated,
          snapshot_oldest_time, snapshot_newest_time, trusted_coverage_start, coverage_end, raw_metadata)
       VALUES ($1,$2,$3,NOW(),$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        batchId, bankCode, stableAccountNo, coverage.bankRowCount, uniqueRefCount, coverage.sourceLimit, coverage.isSourceTruncated,
        coverage.snapshotOldestTime, coverage.snapshotNewestTime, coverage.trustedCoverageStart, coverage.coverageEnd,
        JSON.stringify(body.bank_summary || {}),
      ]
    );
    const snapshotId = snapRes.rows[0].id;

    const archiveRows = buildOcbcBankArchiveRows(bankSnapshotRows, snapshotId);
    await upsertBankArchiveRows(client, archiveRows);

    const snapshotMeta = {
      id: snapshotId, sourceLimit: coverage.sourceLimit, rowCount: coverage.bankRowCount, isTruncated: coverage.isSourceTruncated,
      snapshotOldestTime: coverage.snapshotOldestTime, snapshotNewestTime: coverage.snapshotNewestTime,
      trustedCoverageStart: coverage.trustedCoverageStart, coverageEnd: coverage.coverageEnd,
      boundaryMinuteStart: coverage.boundaryMinuteStart, boundaryMinuteEnd: coverage.boundaryMinuteEnd,
    };

    const { fpRowCount, resultCount } = await runOcbcEngineAndPersist(client, {
      batchId, bankCode, accountNo: stableAccountNo, businessDate, snapshotMeta, configOverride, now: new Date(),
    });

    await client.query(
      `UPDATE recon_sync_batches SET fp_row_count = $2, bank_row_count = $3, status = 'success', synced_at = NOW() WHERE id = $1`,
      [batchId, fpRowCount, bankSnapshotRows.length]
    );

    await client.query('COMMIT');
    res.json({
      success: true, batch_id: batchId, business_date: businessDate, bank_code: bankCode, sync_mode: syncMode,
      fp_row_count: fpRowCount, fp_rows_skipped_outside_date: fpSkippedOutsideDate, bank_row_count: bankSnapshotRows.length,
      result_count: resultCount, engine_run: true, synced_at: new Date().toISOString(),
      coverage: {
        source_limit: coverage.sourceLimit, is_source_truncated: coverage.isSourceTruncated,
        snapshot_oldest_time: coverage.snapshotOldestTime, snapshot_newest_time: coverage.snapshotNewestTime,
        trusted_coverage_start: coverage.trustedCoverageStart,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reconciliation sync error:', err.message);
    res.status(500).json({ error: 'Sync gagal, sudah di-rollback (tidak ada data parsial).' });
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/analytics?date=YYYY-MM-DD&bank_code=OCBC
// ─────────────────────────────────────────────────────────────────────────
async function analyticsHandler(req, res) {
  try {
    const bankCode = nullIfEmpty(req.query.bank_code) || 'OCBC';
    let date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    // business_date::text di semua query berikut -> HINDARI node-pg mem-parse
    // kolom DATE jadi objek Date lalu di-serialize balik pakai .toISOString()
    // (selalu UTC). Server ini timezone-nya Asia/Shanghai (UTC+8, BUKAN UTC),
    // jadi round-trip Date object utk kolom DATE bisa geser mundur 1 hari
    // begitu melewati tengah malam UTC. Insiden nyata: tanggal batch
    // "2026-07-13" tampil sebagai "2026-07-12" di dashboard.
    if (!date) {
      const latest = await pool.query(
        'SELECT business_date::text AS business_date FROM recon_sync_batches WHERE bank_code = $1 ORDER BY business_date DESC LIMIT 1',
        [bankCode]
      );
      date = latest.rows[0] ? latest.rows[0].business_date : null;
    }

    const recentBatchesRes = await pool.query(
      `SELECT batch_no, business_date::text AS business_date, bank_code, fp_row_count, bank_row_count, synced_at, status
       FROM recon_sync_batches WHERE bank_code = $1 ORDER BY business_date DESC LIMIT 14`,
      [bankCode]
    );
    const recentBatches = recentBatchesRes.rows.map(r => ({
      batch_no: r.batch_no, business_date: r.business_date, bank_code: r.bank_code,
      fp_row_count: r.fp_row_count, bank_row_count: r.bank_row_count, synced_at: r.synced_at, status: r.status,
    }));

    if (!date) {
      return res.json({
        empty: true, message: 'Belum ada data rekonsiliasi. Jalankan sync Google Sheet terlebih dahulu.',
        meta: { date: null, bank_code: bankCode }, recent_batches: recentBatches,
      });
    }

    const batchRes = await pool.query(
      'SELECT * FROM recon_sync_batches WHERE business_date = $1 AND bank_code = $2',
      [date, bankCode]
    );
    const batch = batchRes.rows[0] || null;
    if (!batch) {
      return res.json({
        empty: true, message: 'Belum ada data rekonsiliasi untuk tanggal ini.',
        meta: { date, bank_code: bankCode }, recent_batches: recentBatches,
      });
    }

    const [resultsRes, fpCountRes, bankRefCountRes, snapshotRes] = await Promise.all([
      // bank_transaction_date::text -> hindari shift kolom DATE (node-pg akan
      // parse DATE mentah jadi objek Date lalu geser tanggal kalau timezone
      // server bukan UTC, lihat insiden serupa yg berulang di modul ini).
      pool.query('SELECT *, bank_transaction_date::text AS bank_transaction_date FROM recon_results WHERE batch_id = $1', [batch.id]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
      pool.query('SELECT COUNT(DISTINCT reference_no) AS c FROM recon_bank_transactions WHERE batch_id = $1 AND reference_no IS NOT NULL', [batch.id]),
      pool.query('SELECT * FROM recon_bank_snapshots WHERE batch_id = $1 ORDER BY synced_at DESC LIMIT 1', [batch.id]),
    ]);
    const snapshot = snapshotRes.rows[0] || null;

    // ── Guard cross-date (BUG NYATA: sebelum fix, engine tidak scoped per
    // business_date -- lihat catatan panjang di runOcbcEngineAndPersist).
    // Baris recon_results yg bank_transaction_date-nya BUKAN business_date
    // batch ini adalah data STALE (kemungkinan sisa sebelum perbaikan atau
    // hasil belum di-resync) -- dikecualikan dari SEMUA summary/distribusi
    // di bawah, dan dilaporkan lewat data_quality_warning supaya kelihatan
    // kalau masih ada (setelah fix+repair, seharusnya selalu 0).
    const crossDateRows = resultsRes.rows.filter(r => r.bank_transaction_date !== null && r.bank_transaction_date !== date);
    const results = resultsRes.rows.filter(r => r.bank_transaction_date === null || r.bank_transaction_date === date);

    // ── Diagnostic: 1 transaksi logis WAJIB persis 1 hasil per
    // canonical_transaction_key dalam 1 batch (fix bug REVERSAL+BANK_ONLY
    // double count utk Reference No. yang sama). Setelah fix engine + unique
    // index (batch_id, canonical_transaction_key) aktif, ini SELALU 0 --
    // dipertahankan sbg diagnostic permanen (bukan cuma sekali jalan) utk
    // mendeteksi regresi.
    const canonicalGroups = new Map();
    for (const r of results) {
      const key = r.canonical_transaction_key;
      if (!key) continue;
      if (!canonicalGroups.has(key)) canonicalGroups.set(key, []);
      canonicalGroups.get(key).push(r);
    }
    let duplicateCanonicalResultCount = 0;
    let reversalAlsoBankOnlyCount = 0;
    for (const rows of canonicalGroups.values()) {
      if (rows.length <= 1) continue;
      duplicateCanonicalResultCount += rows.length;
      const statuses = rows.map(r => r.recon_status);
      if (statuses.includes('REVERSAL') && statuses.includes('BANK_ONLY')) reversalAlsoBankOnlyCount++;
    }

    const totalTransaksiFp = Number(fpCountRes.rows[0]?.c || 0);
    const totalNominalFp = Number(fpCountRes.rows[0]?.s || 0);
    const referenceBankUnik = Number(bankRefCountRes.rows[0]?.c || 0);

    // status_distribution/byStatus HANYA dari baris yang punya recon_status
    // (coverage_status != IN_BANK_COVERAGE punya recon_status NULL by design
    // — bukan exception, jangan ikut mencemari distribusi status normal).
    const byStatus = {};
    for (const s of RECON_STATUSES) byStatus[s] = { count: 0, nominal: 0 };
    for (const r of results) {
      if (r.recon_status === null) continue;
      const s = byStatus[r.recon_status] ? r.recon_status : 'NEED_REVIEW';
      byStatus[s].count++;
      byStatus[s].nominal += Number(r.fp_nominal || 0);
    }
    const matchedCount = byStatus.MATCHED.count + byStatus.MATCHED_NO_FEE.count;
    const matchedNominal = byStatus.MATCHED.nominal + byStatus.MATCHED_NO_FEE.nominal;
    const totalFeeBank = results.reduce((s, r) => s + (r.bank_fee !== null ? Number(r.bank_fee) : 0), 0);

    // ── Coverage-aware match rate (TEST 5): denominator HANYA transaksi FP
    // yang eligible_for_match_rate=true (coverage_status=IN_BANK_COVERAGE),
    // BUKAN seluruh DATA FP -- transaksi di luar cakupan bank tidak boleh
    // menurunkan match rate hanya krn data pembandingnya memang terpotong.
    const fpResultRows = results.filter(r => r.id_transaksi !== null); // exclude baris sintetis BANK_ONLY
    const inCoverageRows = fpResultRows.filter(r => r.coverage_status === 'IN_BANK_COVERAGE' || r.coverage_status === null);
    const outsideCoverageRows = fpResultRows.filter(r => r.coverage_status === 'OUTSIDE_BANK_COVERAGE');
    const boundaryPartialRows = fpResultRows.filter(r => r.coverage_status === 'BOUNDARY_PARTIAL');
    const matchedInCoverageRows = inCoverageRows.filter(r => r.recon_status === 'MATCHED' || r.recon_status === 'MATCHED_NO_FEE');
    const actionableExceptionRows = inCoverageRows.filter(r => r.is_actionable && !['MATCHED', 'MATCHED_NO_FEE'].includes(r.recon_status));

    const fpInBankCoverage = inCoverageRows.length;
    const fpNominalInBankCoverage = inCoverageRows.reduce((s, r) => s + Number(r.fp_nominal || 0), 0);
    const matchedInCoverage = matchedInCoverageRows.length;
    const matchedNominalInCoverage = matchedInCoverageRows.reduce((s, r) => s + Number(r.fp_nominal || 0), 0);

    const summary = {
      total_transaksi_fp: totalTransaksiFp,
      total_nominal_fp: totalNominalFp,
      reference_bank_unik: referenceBankUnik,
      matched_transaksi: matchedCount,
      matched_nominal: matchedNominal,
      pending_bank_count: byStatus.PENDING_BANK.count,
      fp_only_count: byStatus.FP_ONLY.count,
      bank_only_count: byStatus.BANK_ONLY.count,
      nominal_mismatch_count: byStatus.NOMINAL_MISMATCH.count,
      total_fee_bank: totalFeeBank,
      // Dipertahankan demi backward compatibility (dihitung dari SELURUH FP,
      // termasuk yg di luar cakupan) — frontend WAJIB pakai valid_match_rate_*.
      match_rate_transaksi: safeDiv(matchedCount, totalTransaksiFp),
      match_rate_nominal: safeDiv(matchedNominal, totalNominalFp),
      // ── Metrik baru (coverage-aware) ──
      total_fp_full: totalTransaksiFp,
      total_fp_nominal_full: totalNominalFp,
      fp_in_bank_coverage: fpInBankCoverage,
      fp_nominal_in_bank_coverage: fpNominalInBankCoverage,
      fp_outside_bank_coverage: outsideCoverageRows.length,
      fp_nominal_outside_bank_coverage: outsideCoverageRows.reduce((s, r) => s + Number(r.fp_nominal || 0), 0),
      fp_boundary_partial: boundaryPartialRows.length,
      fp_nominal_boundary_partial: boundaryPartialRows.reduce((s, r) => s + Number(r.fp_nominal || 0), 0),
      matched_in_coverage: matchedInCoverage,
      matched_nominal_in_coverage: matchedNominalInCoverage,
      actionable_exception_count: actionableExceptionRows.length,
      valid_match_rate_transaction: safeDiv(matchedInCoverage, fpInBankCoverage),
      valid_match_rate_nominal: safeDiv(matchedNominalInCoverage, fpNominalInBankCoverage),
    };

    const status_distribution = RECON_STATUSES.map(s => ({ status: s, count: byStatus[s].count, nominal: byStatus[s].nominal }));

    // ── Coverage block (OCBC 5.000-baris limitation) ──
    let archiveStats = { c: 0, oldest: null, newest: null };
    if (snapshot) {
      const archiveParams = [bankCode];
      let archiveWhere = 'bank_code = $1';
      if (snapshot.account_no) { archiveParams.push(snapshot.account_no); archiveWhere += ` AND account_no = $${archiveParams.length}`; }
      const archiveRes = await pool.query(
        `SELECT COUNT(*) AS c, MIN(transaction_date_time) AS oldest, MAX(transaction_date_time) AS newest FROM recon_bank_archive WHERE ${archiveWhere}`,
        archiveParams
      );
      archiveStats = archiveRes.rows[0] || archiveStats;
    }
    const coverage = {
      source_limit: snapshot?.source_limit ?? DEFAULT_SOURCE_LIMIT,
      bank_row_count: snapshot?.row_count ?? batch.bank_row_count,
      is_source_truncated: snapshot?.is_truncated ?? false,
      snapshot_oldest_time: snapshot?.snapshot_oldest_time ?? null,
      snapshot_newest_time: snapshot?.snapshot_newest_time ?? null,
      trusted_coverage_start: snapshot?.trusted_coverage_start ?? null,
      coverage_end: snapshot?.coverage_end ?? null,
      archive_row_count: Number(archiveStats.c || 0),
      archive_oldest_time: archiveStats.oldest || null,
      archive_newest_time: archiveStats.newest || null,
      fp_in_coverage: fpInBankCoverage,
      fp_outside_coverage: outsideCoverageRows.length,
      fp_boundary_partial: boundaryPartialRows.length,
    };

    // Statement validation: opening + credit - debit = closing
    const raw = batch.raw_summary || {};
    const opening = cleanNum(raw.opening_balance);
    const closing = cleanNum(raw.closing_balance);
    const totalDebitAmount = cleanNum(raw.total_debit_amount);
    const totalCreditAmount = cleanNum(raw.total_credit_amount);
    let expectedClosing = null, statementVariance = null, statementValid = null;
    if (opening !== null && totalCreditAmount !== null && totalDebitAmount !== null) {
      expectedClosing = opening + totalCreditAmount - totalDebitAmount;
      if (closing !== null) {
        statementVariance = closing - expectedClosing;
        statementValid = Math.abs(statementVariance) < 1;
      }
    }
    const statement_validation = {
      period: raw.period || null, account_number: raw.account_number || null, account_name: raw.account_name || null,
      opening_balance: opening, closing_balance: closing,
      total_debit_count: raw.total_debit_count ?? null, total_debit_amount: totalDebitAmount,
      total_credit_count: raw.total_credit_count ?? null, total_credit_amount: totalCreditAmount,
      ledger_balance: cleanNum(raw.ledger_balance), available_balance: cleanNum(raw.available_balance),
      release_date: raw.release_date || null,
      expected_closing_balance: expectedClosing, variance: statementVariance, is_valid: statementValid,
    };

    // Fee analysis — expected vs actual, distribusi per produk/outlet/biller
    const feeRows = results.filter(r => r.bank_fee !== null);
    const feeMismatchRows = results.filter(r => r.recon_status === 'FEE_MISMATCH');
    const totalActualFee = feeRows.reduce((s, r) => s + Number(r.bank_fee), 0);
    const groupFeeBy = (keyFn) => {
      const map = new Map();
      for (const r of feeRows) {
        const key = keyFn(r) || '(tidak diketahui)';
        if (!map.has(key)) map.set(key, { key, count: 0, total_fee: 0 });
        const g = map.get(key);
        g.count++; g.total_fee += Number(r.bank_fee);
      }
      return [...map.values()].sort((a, b) => b.total_fee - a.total_fee);
    };
    const fee_analysis = {
      expected_fee: DEFAULT_FEE_BIFAST,
      actual_fee_total: totalActualFee,
      actual_fee_avg: safeDiv(totalActualFee, feeRows.length),
      fee_variance_count: feeMismatchRows.length,
      transaction_with_fee_count: feeRows.length,
      distribution: [
        { fee: DEFAULT_FEE_BIFAST, count: feeRows.filter(r => numEq(Number(r.bank_fee), DEFAULT_FEE_BIFAST)).length },
        { fee: 0, count: feeRows.filter(r => Number(r.bank_fee) === 0).length },
        { fee: 'lainnya', count: feeRows.filter(r => !numEq(Number(r.bank_fee), DEFAULT_FEE_BIFAST) && Number(r.bank_fee) !== 0).length },
      ],
      by_produk: groupFeeBy(r => r.id_produk),
      by_outlet: groupFeeBy(r => r.id_outlet).slice(0, 20),
      by_biller: groupFeeBy(r => r.id_biller),
    };

    res.json({
      empty: false,
      meta: {
        date, bank_code: bankCode, batch_no: batch.batch_no,
        fp_row_count: batch.fp_row_count, bank_row_count: batch.bank_row_count,
        last_sync: batch.synced_at, source_spreadsheet_id: batch.spreadsheet_id,
      },
      // Sumber kebenaran batch aktif -- frontend WAJIB cek business_date di
      // sini sama dengan tanggal yang diminta sebelum merender (lihat guard
      // integrity di WarRoomReconciliationOcbc.jsx).
      active_batch: {
        batch_id: batch.id, bank_code: batch.bank_code, business_date: date,
        account_no: batch.account_no, synced_at: batch.synced_at,
      },
      // Seharusnya SELALU null setelah fix cross-date/duplicate + repair
      // script dijalankan -- kalau masih muncul, berarti ada recon_results
      // stale yg belum dibersihkan.
      data_quality_warning: (crossDateRows.length > 0 || duplicateCanonicalResultCount > 0) ? {
        cross_date_result_count: crossDateRows.length,
        duplicate_canonical_result_count: duplicateCanonicalResultCount,
        reversal_also_bank_only_count: reversalAlsoBankOnlyCount,
        message: [
          crossDateRows.length > 0
            ? `Ditemukan ${crossDateRows.length} baris hasil rekonsiliasi pada batch ${date} dengan bank_transaction_date di luar tanggal ini (data stale, dikecualikan otomatis dari summary). Jalankan backend/scripts/repair-reconciliation-cross-date.js --apply.`
            : null,
          duplicateCanonicalResultCount > 0
            ? `Ditemukan ${duplicateCanonicalResultCount} baris hasil rekonsiliasi (${reversalAlsoBankOnlyCount} di antaranya pasangan REVERSAL+BANK_ONLY) berbagi canonical_transaction_key yang sama -- 1 transaksi seharusnya cuma 1 hasil. Jalankan backend/scripts/repair-reversal-bank-only-duplicates.js --apply.`
            : null,
        ].filter(Boolean).join(' '),
      } : null,
      summary, status_distribution, statement_validation, fee_analysis, coverage, recent_batches: recentBatches,
    });
  } catch (e) {
    console.error('reconciliation analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

/** Tanggal hari ini di Asia/Jakarta, "YYYY-MM-DD" — dipakai sbg default
 * date & penentu RUNNING/CLOSED di Laporan Harian. BUKAN timezone server
 * (VPS ini Asia/Shanghai, UTC+8, beda dari WIB). */
function todayJakarta() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/daily-report?date=YYYY-MM-DD&bank_code=OCBC
// Laporan Harian — ringkasan siap-cetak utk Direktur (tab "Laporan Harian"
// di WarRoomReconciliationOcbc.jsx). BEDA MENDASAR dari analyticsHandler:
// TIDAK PERNAH fallback ke batch tanggal terakhir kalau tanggal yang
// diminta/hari ini belum ada batch-nya (spec eksplisit: "Jangan fallback ke
// batch tanggal sebelumnya", "Jangan mencampur data lintas tanggal") —
// default date = HARI INI (Asia/Jakarta), BUKAN "SELECT ... ORDER BY
// business_date DESC LIMIT 1" seperti analyticsHandler.
//
// active_batch.business_date dipakai sbg SATU-SATUNYA sumber kebenaran
// tanggal laporan (di-query lewat WHERE business_date = $1, jadi otomatis
// terjamin — guard eksplisit di bawah cuma pertahanan berlapis kalau kelak
// query ini diubah orang lain).
// ─────────────────────────────────────────────────────────────────────────
async function dailyReportHandler(req, res) {
  try {
    const bankCode = nullIfEmpty(req.query.bank_code) || 'OCBC';
    const todayStr = todayJakarta();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr;
    const generatedAt = new Date().toISOString();
    const reportStatus = date === todayStr ? 'RUNNING' : 'CLOSED';

    const batchRes = await pool.query(
      'SELECT *, business_date::text AS business_date FROM recon_sync_batches WHERE business_date = $1 AND bank_code = $2',
      [date, bankCode]
    );
    const batch = batchRes.rows[0] || null;

    if (!batch) {
      return res.json({
        empty: true,
        message: 'Belum ada data rekonsiliasi OCBC untuk tanggal ini.',
        meta: { date, bank_code: bankCode },
        generated_at: generatedAt,
        report_status: reportStatus,
      });
    }

    // Guard integritas: active_batch.business_date HARUS persis sama dgn
    // `date` yang diminta (dijamin oleh WHERE di atas — cek eksplisit di
    // sini murni pertahanan berlapis, supaya kalau suatu saat query berubah
    // jadi tidak ter-scope per tanggal, ini gagal LANTANG, bukan diam-diam
    // mencampur data lintas tanggal).
    if (batch.business_date !== date) {
      throw new Error(`Integrity guard gagal: active_batch.business_date (${batch.business_date}) != date diminta (${date})`);
    }

    const [resultsRes, fpCountRes, snapshotRes] = await Promise.all([
      pool.query('SELECT *, bank_transaction_date::text AS bank_transaction_date FROM recon_results WHERE batch_id = $1', [batch.id]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
      pool.query('SELECT * FROM recon_bank_snapshots WHERE batch_id = $1 ORDER BY synced_at DESC LIMIT 1', [batch.id]),
    ]);
    const snapshot = snapshotRes.rows[0] || null;

    // Cross-date guard — SAMA pola dgn analyticsHandler: baris recon_results
    // yang bank_transaction_date-nya BUKAN business_date batch ini adalah
    // data stale, dikecualikan SELURUHNYA dari laporan (tidak pernah
    // mencampur data lintas tanggal).
    const crossDateRows = resultsRes.rows.filter(r => r.bank_transaction_date !== null && r.bank_transaction_date !== date);
    const resultsAfterCrossDateGuard = resultsRes.rows.filter(r => r.bank_transaction_date === null || r.bank_transaction_date === date);

    // Diagnostic duplicate canonical key (HARUS selalu 0 stlh fix unique
    // index batch_id+canonical_transaction_key) — dihitung dari data
    // SEBELUM dedupe supaya kasus REVERSAL+BANK_ONLY utk key yang sama
    // masih bisa terdeteksi.
    const canonicalGroups = new Map();
    for (const r of resultsAfterCrossDateGuard) {
      const key = r.canonical_transaction_key;
      if (!key) continue;
      if (!canonicalGroups.has(key)) canonicalGroups.set(key, []);
      canonicalGroups.get(key).push(r);
    }
    let duplicateCanonicalResultCount = 0;
    let reversalAlsoBankOnlyCount = 0;
    for (const rows of canonicalGroups.values()) {
      if (rows.length <= 1) continue;
      duplicateCanonicalResultCount += rows.length;
      const statuses = rows.map(r => r.recon_status);
      if (statuses.includes('REVERSAL') && statuses.includes('BANK_ONLY')) reversalAlsoBankOnlyCount++;
    }

    // "Satu canonical_transaction_key hanya dihitung satu kali" (spec KPI) —
    // dedupe eksplisit SETELAH diagnostic di atas, sbg jaminan berlapis
    // tambahan di luar unique index DB (kalau index tsb somehow belum aktif
    // di suatu lingkungan, laporan tetap tidak menghitung dobel).
    const dedupeMap = new Map();
    for (const r of resultsAfterCrossDateGuard) {
      const key = r.canonical_transaction_key || `__row_${r.id}`;
      if (!dedupeMap.has(key)) dedupeMap.set(key, r);
    }
    const results = [...dedupeMap.values()];

    const totalTransaksiFp = Number(fpCountRes.rows[0]?.c || 0);
    const totalNominalFp = Number(fpCountRes.rows[0]?.s || 0);

    const byStatus = {};
    for (const s of RECON_STATUSES) byStatus[s] = { count: 0, nominal: 0 };
    for (const r of results) {
      if (r.recon_status === null) continue;
      const s = byStatus[r.recon_status] ? r.recon_status : 'NEED_REVIEW';
      byStatus[s].count++;
      byStatus[s].nominal += Number(r.fp_nominal || 0);
    }
    const matchedCount = byStatus.MATCHED.count + byStatus.MATCHED_NO_FEE.count;
    const matchedNominal = byStatus.MATCHED.nominal + byStatus.MATCHED_NO_FEE.nominal;
    const totalFeeBank = results.reduce((s, r) => s + (r.bank_fee !== null ? Number(r.bank_fee) : 0), 0);

    // Exception KPI rule (spec eksplisit): HANYA coverage_status =
    // IN_BANK_COVERAGE DAN is_actionable = true. OUTSIDE_BANK_COVERAGE dan
    // BOUNDARY_PARTIAL BUKAN kegagalan — tidak pernah dihitung exception.
    const fpResultRows = results.filter(r => r.id_transaksi !== null); // exclude baris sintetis BANK_ONLY
    const inCoverageRows = fpResultRows.filter(r => r.coverage_status === 'IN_BANK_COVERAGE');
    const outsideCoverageRows = fpResultRows.filter(r => r.coverage_status === 'OUTSIDE_BANK_COVERAGE');
    const boundaryPartialRows = fpResultRows.filter(r => r.coverage_status === 'BOUNDARY_PARTIAL');
    const matchedInCoverageRows = inCoverageRows.filter(r => r.recon_status === 'MATCHED' || r.recon_status === 'MATCHED_NO_FEE');
    const actionableExceptionRows = results.filter(r =>
      r.coverage_status === 'IN_BANK_COVERAGE' && r.is_actionable && !['MATCHED', 'MATCHED_NO_FEE'].includes(r.recon_status)
    );

    const fpInBankCoverage = inCoverageRows.length;
    const fpNominalInBankCoverage = inCoverageRows.reduce((s, r) => s + Number(r.fp_nominal || 0), 0);
    const matchedInCoverage = matchedInCoverageRows.length;
    const matchedNominalInCoverage = matchedInCoverageRows.reduce((s, r) => s + Number(r.fp_nominal || 0), 0);
    const validMatchRateTransaction = safeDiv(matchedInCoverage, fpInBankCoverage);
    const validMatchRateNominal = safeDiv(matchedNominalInCoverage, fpNominalInBankCoverage);

    const nominalTerdampak = actionableExceptionRows.reduce(
      (s, r) => s + Number(r.fp_nominal !== null ? r.fp_nominal : (r.bank_total_debit || 0)), 0
    );

    const status_distribution = RECON_STATUSES.map(s => ({ status: s, count: byStatus[s].count, nominal: byStatus[s].nominal }));

    // Coverage OCBC (5.000-baris limitation) — SAMA blok dgn analyticsHandler.
    let archiveStats = { c: 0, oldest: null, newest: null };
    if (snapshot) {
      const archiveParams = [bankCode];
      let archiveWhere = 'bank_code = $1';
      if (snapshot.account_no) { archiveParams.push(snapshot.account_no); archiveWhere += ` AND account_no = $${archiveParams.length}`; }
      const archiveRes = await pool.query(
        `SELECT COUNT(*) AS c, MIN(transaction_date_time) AS oldest, MAX(transaction_date_time) AS newest FROM recon_bank_archive WHERE ${archiveWhere}`,
        archiveParams
      );
      archiveStats = archiveRes.rows[0] || archiveStats;
    }
    const coverage = {
      source_limit: snapshot?.source_limit ?? DEFAULT_SOURCE_LIMIT,
      bank_row_count: snapshot?.row_count ?? batch.bank_row_count,
      is_source_truncated: snapshot?.is_truncated ?? false,
      snapshot_oldest_time: snapshot?.snapshot_oldest_time ?? null,
      snapshot_newest_time: snapshot?.snapshot_newest_time ?? null,
      trusted_coverage_start: snapshot?.trusted_coverage_start ?? null,
      coverage_end: snapshot?.coverage_end ?? null,
      archive_row_count: Number(archiveStats.c || 0),
      fp_in_coverage: fpInBankCoverage,
      fp_outside_coverage: outsideCoverageRows.length,
      fp_boundary_partial: boundaryPartialRows.length,
    };

    const dataQualityWarning = {
      cross_date_result_count: crossDateRows.length,
      duplicate_canonical_result_count: duplicateCanonicalResultCount,
      reversal_also_bank_only_count: reversalAlsoBankOnlyCount,
      has_issue: crossDateRows.length > 0 || duplicateCanonicalResultCount > 0,
      message: [
        crossDateRows.length > 0
          ? `Ditemukan ${crossDateRows.length} baris hasil rekonsiliasi dengan bank_transaction_date di luar tanggal ${date} (data stale, dikecualikan otomatis).`
          : null,
        duplicateCanonicalResultCount > 0
          ? `Ditemukan ${duplicateCanonicalResultCount} baris hasil rekonsiliasi berbagi canonical_transaction_key yang sama (${reversalAlsoBankOnlyCount} di antaranya pasangan REVERSAL+BANK_ONLY).`
          : null,
      ].filter(Boolean).join(' ') || null,
    };

    const financial_summary = {
      total_nominal_fp: totalNominalFp,
      matched_nominal: matchedNominal,
      nominal_terdampak_exception: nominalTerdampak,
      total_fee_bank: totalFeeBank,
      reversal_nominal: byStatus.REVERSAL.nominal,
    };

    const top_10_exception = [...actionableExceptionRows]
      .sort((a, b) => {
        const av = Number(a.fp_nominal !== null ? a.fp_nominal : (a.bank_total_debit || 0));
        const bv = Number(b.fp_nominal !== null ? b.fp_nominal : (b.bank_total_debit || 0));
        return bv - av;
      })
      .slice(0, 10)
      .map(r => ({
        id_transaksi: r.id_transaksi || null,
        reference_no: r.reference_no || null,
        nominal: Number(r.fp_nominal !== null ? r.fp_nominal : (r.bank_total_debit || 0)),
        recon_status: r.recon_status,
        coverage_status: r.coverage_status,
        id_outlet: r.id_outlet || null,
        id_produk: r.id_produk || null,
      }));

    // ── Health status (spec eksplisit) ──
    const syncFailed = batch.status !== 'success';
    const hasDataQualityIssue = dataQualityWarning.has_issue;
    let healthStatus = 'GREEN';
    if (
      syncFailed ||
      (validMatchRateTransaction !== null && validMatchRateTransaction < 0.95) ||
      hasDataQualityIssue ||
      reversalAlsoBankOnlyCount > 0
    ) {
      healthStatus = 'RED';
    } else if (
      (validMatchRateTransaction !== null && validMatchRateTransaction < 0.99) ||
      actionableExceptionRows.length > 0
    ) {
      healthStatus = 'YELLOW';
    }

    // ── Ringkasan otomatis Direktur (teks siap tempel WhatsApp) ──
    const pctMatch = validMatchRateTransaction !== null ? (validMatchRateTransaction * 100).toFixed(1) : '-';
    const summaryLines = [
      `Laporan Rekonsiliasi OCBC — ${date}`,
      `Dari ${fmtNumId(totalTransaksiFp)} transaksi FP senilai ${fmtRpId(totalNominalFp)}, sebanyak ${fmtNumId(matchedCount)} transaksi (${pctMatch}%) berhasil direkonsiliasi dengan Bank OCBC senilai ${fmtRpId(matchedNominal)}.`,
      actionableExceptionRows.length > 0
        ? `Terdapat ${fmtNumId(actionableExceptionRows.length)} transaksi exception senilai ${fmtRpId(nominalTerdampak)} yang memerlukan tindak lanjut.`
        : `Tidak ada transaksi exception yang perlu ditindaklanjuti.`,
      byStatus.REVERSAL.count > 0 ? `Ditemukan ${fmtNumId(byStatus.REVERSAL.count)} transaksi reversal senilai ${fmtRpId(byStatus.REVERSAL.nominal)}.` : null,
      hasDataQualityIssue ? `PERHATIAN: ditemukan masalah kualitas data — ${dataQualityWarning.message}` : null,
      `Status kesehatan rekonsiliasi hari ini: ${healthStatus}.`,
    ].filter(Boolean);
    const ringkasan_direktur = summaryLines.join(' ');

    // ── Rekomendasi tindak lanjut ──
    const rekomendasi = [];
    if (hasDataQualityIssue) {
      rekomendasi.push('Segera jalankan script perbaikan data quality (repair-reconciliation-cross-date.js / repair-reversal-bank-only-duplicates.js) sebelum laporan difinalisasi.');
    }
    if (syncFailed) {
      rekomendasi.push('Sinkronisasi batch ini belum berstatus sukses — cek Apps Script/Execution Log dan jalankan sync ulang.');
    }
    if (actionableExceptionRows.length > 0) {
      rekomendasi.push(`Tindak lanjuti ${fmtNumId(actionableExceptionRows.length)} transaksi exception senilai ${fmtRpId(nominalTerdampak)} melalui tab Exception Queue.`);
    }
    if (byStatus.REVERSAL.count > 0) {
      rekomendasi.push(`Periksa ${fmtNumId(byStatus.REVERSAL.count)} transaksi reversal untuk memastikan tidak ada dampak ke laporan keuangan.`);
    }
    if (validMatchRateTransaction !== null && validMatchRateTransaction < 0.99) {
      rekomendasi.push('Match rate di bawah target 99% — eskalasi ke tim terkait untuk investigasi lebih lanjut.');
    }
    if (rekomendasi.length === 0) {
      rekomendasi.push('Tidak ada tindak lanjut mendesak — seluruh transaksi FP telah berhasil direkonsiliasi dalam cakupan data bank.');
    }

    res.json({
      empty: false,
      generated_at: generatedAt,
      report_status: reportStatus,
      health_status: healthStatus,
      meta: {
        date, bank_code: bankCode, batch_no: batch.batch_no,
        last_sync: batch.synced_at,
      },
      active_batch: {
        batch_id: batch.id, bank_code: batch.bank_code, business_date: batch.business_date,
        account_no: batch.account_no, synced_at: batch.synced_at, status: batch.status,
      },
      total_fp: totalTransaksiFp,
      total_nominal_fp: totalNominalFp,
      total_bank_row_count: coverage.bank_row_count,
      matched_transaksi: matchedCount,
      valid_match_rate_transaction: validMatchRateTransaction,
      valid_match_rate_nominal: validMatchRateNominal,
      actionable_exception_count: actionableExceptionRows.length,
      nominal_terdampak_exception: nominalTerdampak,
      reversal: { count: byStatus.REVERSAL.count, nominal: byStatus.REVERSAL.nominal },
      status_distribution,
      financial_summary,
      coverage,
      data_quality_warning: dataQualityWarning,
      top_10_exception,
      ringkasan_direktur,
      rekomendasi_tindak_lanjut: rekomendasi,
    });
  } catch (e) {
    console.error('reconciliation daily-report error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

function fmtNumId(n) {
  return Number(n || 0).toLocaleString('id-ID');
}
function fmtRpId(n) {
  return `Rp ${Math.round(Number(n || 0)).toLocaleString('id-ID')}`;
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/transactions
// ─────────────────────────────────────────────────────────────────────────
const SORT_COLUMNS = {
  id_transaksi: 'id_transaksi', reference_no: 'reference_no', fp_nominal: 'fp_nominal',
  bank_principal: 'bank_principal', bank_fee: 'bank_fee', bank_total_debit: 'bank_total_debit',
  variance_principal: 'variance_principal', variance_fee: 'variance_fee', aging_minutes: 'aging_minutes',
  recon_status: 'recon_status', fp_time_response: 'fp_time_response', bank_transaction_date: 'bank_transaction_date',
  updated_at: 'updated_at',
};

function buildTransactionsQuery(req) {
  const bankCode = nullIfEmpty(req.query.bank_code) || 'OCBC';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const status = nullIfEmpty(req.query.status);
  const idOutlet = nullIfEmpty(req.query.id_outlet);
  const idProduk = nullIfEmpty(req.query.id_produk);
  const search = nullIfEmpty(req.query.search);
  const coverageStatus = nullIfEmpty(req.query.coverage_status);
  const isActionable = nullIfEmpty(req.query.is_actionable);

  const conditions = ['b.bank_code = $1'];
  const params = [bankCode];
  if (date) {
    params.push(date);
    const idx = params.length;
    conditions.push(`b.business_date = $${idx}`);
    // Pertahanan tambahan (defense-in-depth) di luar scoping via batch_id:
    // insiden nyata pernah ada recon_results dgn batch_id tanggal 14 tapi
    // bank_transaction_date tanggal 13 (archive query lama tidak scoped
    // business_date, sudah diperbaiki di runOcbcEngineAndPersist) -- filter
    // ini memastikan baris lintas-tanggal yg BELUM sempat di-repair tetap
    // tidak tampil di /transactions & /export walau masih ada di DB.
    // DATE = DATE (bukan round-trip lewat JS) -> tidak ada risiko timezone.
    conditions.push(`(r.bank_transaction_date IS NULL OR r.bank_transaction_date = $${idx})`);
  }
  if (status) {
    const statusList = status.split(',').map(s => s.trim()).filter(Boolean);
    params.push(statusList);
    conditions.push(`r.recon_status = ANY($${params.length}::text[])`);
  }
  if (idOutlet) { params.push(idOutlet); conditions.push(`r.id_outlet = $${params.length}`); }
  if (idProduk) { params.push(idProduk); conditions.push(`r.id_produk = $${params.length}`); }
  if (coverageStatus) {
    const coverageList = coverageStatus.split(',').map(s => s.trim()).filter(Boolean);
    params.push(coverageList);
    conditions.push(`r.coverage_status = ANY($${params.length}::text[])`);
  }
  if (isActionable !== null) {
    params.push(isActionable === 'true');
    conditions.push(`r.is_actionable = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(r.id_transaksi ILIKE $${params.length} OR r.reference_no ILIKE $${params.length} OR r.id_outlet ILIKE $${params.length})`);
  }
  return { whereClause: conditions.join(' AND '), params };
}

async function transactionsHandler(req, res) {
  try {
    const { whereClause, params } = buildTransactionsQuery(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const sortKey = nullIfEmpty(req.query.sort);
    const sortColumn = (sortKey && SORT_COLUMNS[sortKey]) ? `r.${SORT_COLUMNS[sortKey]}` : 'r.updated_at';
    const sortDir = String(req.query.order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const countRes = await pool.query(
      `SELECT COUNT(*) AS total FROM recon_results r JOIN recon_sync_batches b ON b.id = r.batch_id WHERE ${whereClause}`,
      params
    );
    const total = Number(countRes.rows[0]?.total || 0);

    const rowParams = [...params, limit, offset];
    const rowsRes = await pool.query(
      `SELECT r.*, b.business_date::text AS business_date, r.bank_transaction_date::text AS bank_transaction_date
       FROM recon_results r JOIN recon_sync_batches b ON b.id = r.batch_id
       WHERE ${whereClause} ORDER BY ${sortColumn} ${sortDir} NULLS LAST
       LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`,
      rowParams
    );

    res.json({
      meta: { page, limit, total, sort: sortKey && SORT_COLUMNS[sortKey] ? sortKey : 'updated_at', order: sortDir.toLowerCase() },
      rows: rowsRes.rows.map(mapResultRow),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

function mapResultRow(r) {
  return {
    id: r.id,
    business_date: r.business_date,
    id_transaksi: r.id_transaksi,
    reference_no: r.reference_no,
    id_outlet: r.id_outlet,
    id_produk: r.id_produk,
    id_biller: r.id_biller,
    fp_nominal: r.fp_nominal !== null ? Number(r.fp_nominal) : null,
    fp_time_response: r.fp_time_response,
    bank_transaction_date: r.bank_transaction_date,
    bank_principal: r.bank_principal !== null ? Number(r.bank_principal) : null,
    bank_fee: r.bank_fee !== null ? Number(r.bank_fee) : null,
    bank_credit: r.bank_credit !== null ? Number(r.bank_credit) : null,
    bank_total_debit: r.bank_total_debit !== null ? Number(r.bank_total_debit) : null,
    variance_principal: r.variance_principal !== null ? Number(r.variance_principal) : null,
    variance_fee: r.variance_fee !== null ? Number(r.variance_fee) : null,
    matching_method: r.matching_method,
    recon_status: r.recon_status,
    aging_minutes: r.aging_minutes,
    notes: r.notes,
    coverage_status: r.coverage_status,
    coverage_reason: r.coverage_reason,
    is_actionable: r.is_actionable,
    eligible_for_match_rate: r.eligible_for_match_rate,
    archive_match: r.archive_match,
    updated_at: r.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/export — CSV
// ─────────────────────────────────────────────────────────────────────────
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
async function exportHandler(req, res) {
  try {
    const { whereClause, params } = buildTransactionsQuery(req);
    const rowsRes = await pool.query(
      `SELECT r.*, b.business_date::text AS business_date, r.bank_transaction_date::text AS bank_transaction_date
       FROM recon_results r JOIN recon_sync_batches b ON b.id = r.batch_id
       WHERE ${whereClause} ORDER BY r.updated_at DESC LIMIT 20000`,
      params
    );
    const headers = [
      'business_date', 'id_transaksi', 'reference_no', 'id_outlet', 'id_produk', 'id_biller',
      'fp_nominal', 'fp_time_response', 'bank_transaction_date', 'bank_principal', 'bank_fee',
      'bank_credit', 'bank_total_debit', 'variance_principal', 'variance_fee', 'matching_method',
      'recon_status', 'aging_minutes', 'notes',
      'coverage_status', 'coverage_reason', 'is_actionable', 'eligible_for_match_rate', 'archive_match',
    ];
    const lines = [headers.join(',')];
    for (const row of rowsRes.rows.map(mapResultRow)) {
      lines.push(headers.map(h => csvEscape(row[h])).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reconciliation-ocbc-${nullIfEmpty(req.query.date) || 'export'}.csv"`);
    res.send('﻿' + lines.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/:id/resolve
// ─────────────────────────────────────────────────────────────────────────
async function resolveHandler(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid' });
    const status = nullIfEmpty(req.body?.status);
    const notes = nullIfEmpty(req.body?.notes);
    if (!status || !RECON_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status wajib salah satu dari: ${RECON_STATUSES.join(', ')}` });
    }

    const current = await pool.query('SELECT recon_status FROM recon_results WHERE id = $1', [id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Data rekonsiliasi tidak ditemukan' });
    const statusBefore = current.rows[0].recon_status;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE recon_results SET recon_status = $2, notes = COALESCE($3, notes), updated_at = NOW() WHERE id = $1`,
        [id, status, notes]
      );
      const username = req.user?.username || null;
      await client.query(
        `INSERT INTO recon_action_logs (recon_result_id, action, status_before, status_after, notes, created_by)
         VALUES ($1,'resolve',$2,$3,$4,$5)`,
        [id, statusBefore, status, notes, username]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const logsRes = await pool.query('SELECT * FROM recon_action_logs WHERE recon_result_id = $1 ORDER BY created_at DESC', [id]);
    res.json({ success: true, id, status_before: statusBefore, status_after: status, action_logs: logsRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// "Sync Now" (kompromi) — Apps Script Web App TIDAK BISA dipanggil langsung
// dari dashboard (kebijakan Google Workspace, lihat migration
// create_recon_sync_requests.sql). Tombol ini HANYA mencatat "ada
// permintaan sync"; trigger checker Apps Script yang sudah jalan tiap 1
// menit (checkAndSyncIfDirtyReconciliation{Ocbc,Mandiri}) yang membaca
// status ini dan memutuskan utk sync SEKARANG (skip debounce normal).
// Generik utk kedua bank (bank_code dari body/query) — TIDAK diduplikasi
// per bank, dipakai baik dari route OCBC maupun Mandiri.
// ─────────────────────────────────────────────────────────────────────────
async function requestSyncHandler(req, res) {
  try {
    const bankCode = nullIfEmpty(req.body?.bank_code) || 'OCBC';
    const username = req.user?.username || null;
    await pool.query('INSERT INTO recon_sync_requests (bank_code, requested_by) VALUES ($1,$2)', [bankCode, username]);
    res.json({
      success: true,
      message: 'Permintaan sync tercatat. Apps Script akan sync dalam ~1-2 menit (tidak instan — lihat dokumentasi soal batasan Google Workspace).',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/warroom/reconciliation/sync-request-status?bank_code=OCBC|MANDIRI
// Dipanggil Apps Script (token auth, BUKAN JWT — sama seperti endpoint sync).
async function syncRequestStatusHandler(req, res) {
  try {
    const token = extractToken(req);
    if (!SYNC_TOKEN || token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    const bankCode = nullIfEmpty(req.query.bank_code) || 'OCBC';
    const [reqRes, batchRes] = await Promise.all([
      pool.query('SELECT MAX(requested_at) AS latest FROM recon_sync_requests WHERE bank_code = $1', [bankCode]),
      pool.query('SELECT MAX(synced_at) AS latest FROM recon_sync_batches WHERE bank_code = $1', [bankCode]),
    ]);
    const requestedAt = reqRes.rows[0]?.latest || null;
    const syncedAt = batchRes.rows[0]?.latest || null;
    // Pending kalau ada permintaan yang lebih baru dari sync SUKSES terakhir
    // (atau belum pernah sync sama sekali) -- begitu sync berikutnya selesai,
    // synced_at otomatis lebih baru dari requested_at, pending balik ke false
    // TANPA perlu langkah "consume/clear" terpisah.
    const pending = !!requestedAt && (!syncedAt || new Date(requestedAt).getTime() > new Date(syncedAt).getTime());
    res.json({ pending, requested_at: requestedAt, last_synced_at: syncedAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/:id/logs — riwayat audit 1 baris hasil
// ─────────────────────────────────────────────────────────────────────────
async function actionLogsHandler(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid' });
    const r = await pool.query('SELECT * FROM recon_action_logs WHERE recon_result_id = $1 ORDER BY created_at DESC', [id]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  syncHandler,
  analyticsHandler,
  dailyReportHandler,
  todayJakarta,
  transactionsHandler,
  exportHandler,
  resolveHandler,
  actionLogsHandler,
  requestSyncHandler,
  syncRequestStatusHandler,
  // exported untuk unit test (backend/scripts/test-reconciliation-ocbc.js)
  // dan untuk dipakai ulang oleh adapter bank lain (warroom-reconciliation-mandiri.js)
  // supaya helper dasar (parsing angka/tanggal, extractToken, csvEscape, dst)
  // tidak diduplikasi dan berisiko divergen antar bank.
  reconcileTransactions,
  parseDescriptionFallback,
  extractToken,
  nullIfEmpty,
  cleanNum,
  toIsoDate,
  parseTimeResponse,
  numEq,
  safeDiv,
  csvEscape,
  isValidIdTransaksi,
  RECON_STATUSES,
  EXCEPTION_STATUSES,
  DEFAULT_FEE_BIFAST,
  DEFAULT_GRACE_MINUTES,
  // exported untuk unit test coverage-aware (TEST 1-11, backend/scripts/test-reconciliation-ocbc.js)
  reconcileTransactionsWithCoverage,
  calculateOcbcCoverage,
  classifyFpCoverage,
  isCompleteOcbcGroup,
  buildOcbcBankArchiveRows,
  computeBankRowFingerprint,
  normalizeDescriptionForFingerprint,
  parseOcbcRawDateTimeFallback,
  parseFlexibleOcbcDateTime,
  resolveOcbcTransactionDateTime,
  DEFAULT_SOURCE_LIMIT,
  // exported utk script repair (backend/scripts/repair-reconciliation-cross-date.js)
  runOcbcEngineAndPersist,
  // exported utk unit test (buildTransactionsQuery pure, tidak menyentuh DB)
  buildTransactionsQuery,
  // exported utk unit test + repair script canonical key (fix REVERSAL+BANK_ONLY duplicate)
  normalizeCanonicalKey,
  buildOcbcBankGroups,
};
