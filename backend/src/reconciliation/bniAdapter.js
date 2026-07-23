/**
 * Rekonsiliasi BNI — Adapter (MODUL BARU, TERPISAH dari briAdapter.js/
 * briBifastAdapter.js/mandiriAdapter.js)
 *
 * Bagian dari "Reconciliation Core Engine" bersama OCBC/Mandiri/BRI/
 * BRI BI-FAST existing — REUSE tabel recon_sync_batches/
 * recon_fp_transactions/recon_bank_transactions/recon_results/
 * recon_action_logs (bank_code = 'BNI'). Helper dasar (extractToken,
 * nullIfEmpty, cleanNum, csvEscape, dst) di-reuse dari
 * warroom-reconciliation.js oleh route handler — TIDAK di sini.
 *
 * BEDA MENDASAR dari bank lain: matching key = DATA FP.id_transaksi ==
 * transaction ID hasil ekstraksi dari Description mutasi bank (BUKAN
 * Reference No./bill_info1 langsung — BNI tidak punya kolom reference
 * terpisah, transaction ID harus DIGALI dari teks bebas Description lewat
 * 2 sumber independen: pola "BMS_SNAP API #<10 digit>" dan 10 digit
 * terakhir dari token setelah "/"). scope_mode default FP_COVERAGE_WINDOW
 * (BUKAN FULL_BUSINESS_DATE) — Data FP bisa berupa potongan waktu, jadi
 * mutasi bank di luar rentang waktu FP (±toleransi) TIDAK PERNAH otomatis
 * dianggap BANK_ONLY.
 *
 * SEMUA fungsi di sini PURE (tidak menyentuh DB) supaya bisa di-unit-test
 * langsung — lihat backend/scripts/test-reconciliation-bni.js.
 */

const crypto = require('crypto');

const BNI_ID_BILLER = '141';
const DEFAULT_FEE_BNI = Number(process.env.RECON_BNI_FEE_DEFAULT) || 0;
const DEFAULT_GRACE_MINUTES = Number(process.env.RECON_BNI_GRACE_MINUTES) || 30;
const DEFAULT_COVERAGE_TOLERANCE_BEFORE_MINUTES = Number(process.env.RECON_BNI_COVERAGE_BEFORE_MINUTES) || 5;
const DEFAULT_COVERAGE_TOLERANCE_AFTER_MINUTES = Number(process.env.RECON_BNI_COVERAGE_AFTER_MINUTES) || 5;
const DEFAULT_MATCHING_TIME_TOLERANCE_MINUTES = Number(process.env.RECON_BNI_MATCHING_TOLERANCE_MINUTES) || 15;
const DEFAULT_BANK_BEFORE_FP_TOLERANCE_MINUTES = Number(process.env.RECON_BNI_BEFORE_TOLERANCE_MINUTES) || 5;
const DEFAULT_REVERSAL_LOOKUP_DAYS = Number(process.env.RECON_BNI_REVERSAL_LOOKUP_DAYS) || 3;
const NUM_EPS = 0.5; // toleransi pembulatan rupiah

function numEq(a, b) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < NUM_EPS;
}
function normalizeKey(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

// ─────────────────────────────────────────────────────────────────────────
// Eligibility gate — HANYA baris FP dengan id_biller = '141' menjadi
// kandidat rekonsiliasi BNI (spec: "Gunakan id_biller sebagai filter utama.
// Jangan hardcode hanya id_produk = BLSTR"). id_produk TETAP disimpan utk
// filter/analisis, BUKAN dipakai memfilter kandidat.
// ─────────────────────────────────────────────────────────────────────────
function isBniFpCandidate(row) {
  return normalizeKey(row.idBiller) === BNI_ID_BILLER;
}

// ─────────────────────────────────────────────────────────────────────────
// Ekstraksi transaction ID — 2 SUMBER INDEPENDEN dari Description:
//   1. Hash ID    — pola "BMS_SNAP API #<10 digit>" (fallback "#<10 digit>")
//   2. Reference  — 10 digit TERAKHIR dari token angka setelah "/"
//      (anchored ke pola "FASTPAY <akun>/<referensi>" kalau ada, supaya
//      beneficiary_account & reference ID digali dari konstruksi yang SAMA
//      — bukan slash pertama yang kebetulan ditemukan di teks manapun).
// TIDAK PERNAH diam-diam memilih salah satu kalau dua sumber KONFLIK.
// ─────────────────────────────────────────────────────────────────────────
const HASH_PATTERN_PRIMARY = /BMS_SNAP\s+API\s*#\s*(\d{10})\b/i;
const HASH_PATTERN_FALLBACK = /#\s*(\d{10})\b/;
const REFERENCE_ANCHORED_PATTERN = /FASTPAY\s+(\d{6,20})\/(\d{10,20})\b/i;
const REFERENCE_BARE_PATTERN = /\/(\d{10,20})\b/;
const FUNDING_PATTERNS = ['PB KE BNI MULTIBILLER', 'PB BNI OPS BMS KE BNI MULTIBILLER', 'BIMASAKTI MULTI SINERGI'];

function extractHashId(description) {
  const s = String(description || '');
  let m = HASH_PATTERN_PRIMARY.exec(s);
  if (m) return m[1];
  m = HASH_PATTERN_FALLBACK.exec(s);
  return m ? m[1] : null;
}

function extractReferenceIdAndBeneficiary(description) {
  const s = String(description || '');
  const anchored = REFERENCE_ANCHORED_PATTERN.exec(s);
  if (anchored) {
    const beneficiaryAccount = anchored[1]; // TETAP string — leading zero dipertahankan
    const token = anchored[2];
    const referenceId = token.length >= 10 ? token.slice(-10) : null;
    return { referenceId, beneficiaryAccount };
  }
  const bare = REFERENCE_BARE_PATTERN.exec(s);
  if (bare) {
    const token = bare[1];
    const referenceId = token.length >= 10 ? token.slice(-10) : null;
    return { referenceId, beneficiaryAccount: null };
  }
  return { referenceId: null, beneficiaryAccount: null };
}

/** Teks setelah separator TERAKHIR "|" — audit only, BUKAN matching key. */
function extractRecipientName(description) {
  const s = String(description || '');
  if (!s.includes('|')) return null;
  const parts = s.split('|');
  const last = parts[parts.length - 1].trim();
  return last || null;
}

/**
 * description: teks mentah Description mutasi bank.
 * Mengembalikan:
 *   { transactionIdFromHash, transactionIdFromReference, extractedTransactionId,
 *     extractionConfidence: HIGH|MEDIUM|CONFLICT|NONE, idConflict,
 *     beneficiaryAccount, recipientName }
 */
function extractBniIdentifiers(description) {
  const transactionIdFromHash = extractHashId(description);
  const { referenceId: transactionIdFromReference, beneficiaryAccount } = extractReferenceIdAndBeneficiary(description);
  const recipientName = extractRecipientName(description);

  let extractionConfidence = 'NONE';
  let idConflict = false;
  let extractedTransactionId = null;

  if (transactionIdFromHash && transactionIdFromReference) {
    if (transactionIdFromHash === transactionIdFromReference) {
      extractionConfidence = 'HIGH';
      extractedTransactionId = transactionIdFromHash;
    } else {
      extractionConfidence = 'CONFLICT';
      idConflict = true;
      extractedTransactionId = null; // TIDAK PERNAH diam-diam memilih salah satu
    }
  } else if (transactionIdFromHash || transactionIdFromReference) {
    extractionConfidence = 'MEDIUM';
    extractedTransactionId = transactionIdFromHash || transactionIdFromReference;
  }

  return {
    transactionIdFromHash, transactionIdFromReference, extractedTransactionId,
    extractionConfidence, idConflict, beneficiaryAccount, recipientName,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Klasifikasi 1 baris mutasi BNI -> bank_row_type.
// row: { description, debit (number|null), credit (number|null) }
// extraction: hasil extractBniIdentifiers(row.description) — dihitung
//   caller SEKALI per baris (dipakai jg utk field lain), bukan di sini.
// coverageStatus: hasil classifyBniCoverageStatus() utk baris ini — HANYA
//   dipakai utk rule 5/6 (fastpay-like tapi ID invalid/conflict): dalam
//   coverage -> NEED_REVIEW/FASTPAY_DEBIT_FALLBACK_CANDIDATE (actionable),
//   luar coverage -> OUT_OF_SCOPE (tetap tersimpan di Raw Data, TIDAK
//   PERNAH jadi actionable exception).
// ─────────────────────────────────────────────────────────────────────────
function classifyBniBankRow(row, extraction, coverageStatus) {
  const description = String(row.description || '').trim();
  if (!description) return 'UNKNOWN';
  const upper = description.toUpperCase();
  const debit = typeof row.debit === 'number' ? row.debit : null;
  const credit = typeof row.credit === 'number' ? row.credit : null;

  const isFundingPattern = FUNDING_PATTERNS.some(p => upper.includes(p));
  if (credit !== null && credit > 0 && isFundingPattern) return 'FUNDING_CREDIT';

  const looksFastpay = upper.includes('BMS_SNAP API') && upper.includes('FASTPAY');
  const idValid = !!(extraction && extraction.extractedTransactionId && !extraction.idConflict);

  if (debit !== null && debit > 0 && looksFastpay && idValid) return 'FASTPAY_DEBIT';
  if (credit !== null && credit > 0 && looksFastpay && idValid) return 'CREDIT_REVERSAL';
  // Debit FASTPAY tapi transaction ID TIDAK lengkap/conflict (mis. Description
  // "BMS_SNAP API #3562" terpotong 4 digit, bukan 10) -- JANGAN langsung
  // difinalkan NEED_REVIEW. Beri kesempatan TIER3 UNIQUE_TIME_AMOUNT_FALLBACK
  // (reconcileBniTransactions) mencocokkan via nominal+waktu unik SEBELUM
  // jatuh ke NEED_REVIEW (spec eksplisit -- lihat insiden 4 transaksi
  // 2026-07-22 yg salah dihitung dobel sbg FP_ONLY + NEED_REVIEW).
  if (debit !== null && debit > 0 && looksFastpay && !idValid) {
    return coverageStatus === 'INSIDE_FP_COVERAGE' ? 'FASTPAY_DEBIT_FALLBACK_CANDIDATE' : 'OUT_OF_SCOPE';
  }
  if (looksFastpay) {
    return coverageStatus === 'INSIDE_FP_COVERAGE' ? 'NEED_REVIEW' : 'OUT_OF_SCOPE';
  }
  return 'OUT_OF_SCOPE';
}

// ─────────────────────────────────────────────────────────────────────────
// Waktu — format bank "DD/MM/YY HH.mm.ss" (titik sbg pemisah jam, BUKAN
// titik dua), di-anchor Asia/Jakarta (+07:00) EKSPLISIT. SENGAJA TIDAK
// pernah fallback ke Date.parse() native (spec eksplisit melarang — locale
// browser/Node bisa salah tafsir DD/MM jadi MM/DD).
// ─────────────────────────────────────────────────────────────────────────
function pad2(v) { return String(v).padStart(2, '0'); }
function normalizeTwoDigitYear(yRaw) {
  if (String(yRaw).length >= 4) return Number(yRaw);
  const yy = Number(yRaw);
  return yy <= 69 ? 2000 + yy : 1900 + yy; // spec: 00-69 -> 2000-2069
}

function parseBniDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  if (!s) return null;

  // Format utama: DD/MM/YY[YY] HH.mm.ss
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2})\.(\d{2})\.(\d{2})$/.exec(s);
  if (m) {
    const [, d, mo, yRaw, h, mi, se] = m;
    const year = normalizeTwoDigitYear(yRaw);
    const dt = new Date(`${year}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:${pad2(se)}+07:00`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  // Fallback: DD/MM/YY[YY] tanpa jam
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    const [, d, mo, yRaw] = m;
    const year = normalizeTwoDigitYear(yRaw);
    const dt = new Date(`${year}-${pad2(mo)}-${pad2(d)}T00:00:00+07:00`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  // Fallback: ISO-like "YYYY-MM-DD[ HH:mm[:ss]]" (mis. dari time_response FP)
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    const dt = new Date(`${y}-${pad2(mo)}-${pad2(d)}T${pad2(h || '0')}:${pad2(mi || '0')}:${pad2(se || '0')}+07:00`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  return null;
}

function formatDateJakartaBni(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// ─────────────────────────────────────────────────────────────────────────
// Coverage Window — Data FP BNI bisa berupa POTONGAN waktu (bukan seluruh
// hari), jadi mutasi bank di luar rentang waktu FP TIDAK PERNAH otomatis
// dianggap BANK_ONLY. coverageStart/End = min/max FP.time_response ±
// toleransi (default 5 menit). "Core" (fpMinTime..fpMaxTime, TANPA
// toleransi) dipakai membedakan INSIDE (di dalam rentang FP asli) dari
// BOUNDARY_PARTIAL (di dalam zona toleransi tapi di luar rentang FP asli).
// ─────────────────────────────────────────────────────────────────────────
function computeBniCoverage(fpRows, toleranceBeforeMinutes, toleranceAfterMinutes) {
  const before = Number.isFinite(toleranceBeforeMinutes) ? toleranceBeforeMinutes : DEFAULT_COVERAGE_TOLERANCE_BEFORE_MINUTES;
  const after = Number.isFinite(toleranceAfterMinutes) ? toleranceAfterMinutes : DEFAULT_COVERAGE_TOLERANCE_AFTER_MINUTES;
  const times = (fpRows || []).map(f => f.timeResponse).filter(t => t instanceof Date && !Number.isNaN(t.getTime()));
  if (!times.length) return { coverageStart: null, coverageEnd: null, fpMinTime: null, fpMaxTime: null };
  const minMs = Math.min(...times.map(t => t.getTime()));
  const maxMs = Math.max(...times.map(t => t.getTime()));
  return {
    coverageStart: new Date(minMs - before * 60000),
    coverageEnd: new Date(maxMs + after * 60000),
    fpMinTime: new Date(minMs),
    fpMaxTime: new Date(maxMs),
  };
}

function classifyBniCoverageStatus(transactionDateTime, coverage) {
  if (!(transactionDateTime instanceof Date) || Number.isNaN(transactionDateTime.getTime())) return 'UNDETERMINED';
  if (!coverage || !coverage.coverageStart || !coverage.coverageEnd) return 'UNDETERMINED';
  const t = transactionDateTime.getTime();
  const start = coverage.coverageStart.getTime();
  const end = coverage.coverageEnd.getTime();
  if (t < start || t > end) return 'OUTSIDE_FP_COVERAGE';
  const coreStart = coverage.fpMinTime ? coverage.fpMinTime.getTime() : start;
  const coreEnd = coverage.fpMaxTime ? coverage.fpMaxTime.getTime() : end;
  if (t < coreStart || t > coreEnd) return 'BOUNDARY_PARTIAL';
  return 'INSIDE_FP_COVERAGE';
}

/** NORMAL <=60s, WARNING <=5mnt, DELAYED <=15mnt, EXTREME >15mnt, IMPOSSIBLE_ORDER = bank jauh SEBELUM FP (> toleransi). */
function computeBniTimeOrderStatus(diffSeconds, bankBeforeFpToleranceMinutes) {
  if (diffSeconds === null || diffSeconds === undefined || !Number.isFinite(diffSeconds)) return null;
  const toleranceSeconds = (Number.isFinite(bankBeforeFpToleranceMinutes) ? bankBeforeFpToleranceMinutes : DEFAULT_BANK_BEFORE_FP_TOLERANCE_MINUTES) * 60;
  if (diffSeconds < -toleranceSeconds) return 'IMPOSSIBLE_ORDER';
  const abs = Math.abs(diffSeconds);
  if (abs <= 60) return 'NORMAL';
  if (abs <= 300) return 'WARNING';
  if (abs <= 900) return 'DELAYED';
  return 'EXTREME';
}

// ─────────────────────────────────────────────────────────────────────────
// TIER 3 — UNIQUE_TIME_AMOUNT_FALLBACK. PURE function, dipanggil HANYA
// setelah TIER1/TIER2 (exact transaction ID) selesai & gagal. Cakupan
// SANGAT SEMPIT by design (spec eksplisit "jangan memperlebar fallback
// tanpa batas") -- fpCandidates HARUS sudah difilter caller ke FP yang
// TIDAK ketemu grup ID exact, bankCandidates HARUS sudah difilter ke bank
// row bankRowType='FASTPAY_DEBIT_FALLBACK_CANDIDATE' (debit FASTPAY tapi
// transaction ID tidak lengkap/conflict, lihat classifyBniBankRow()).
//
// Syarat MUTLAK (semua harus terpenuhi, TIDAK ADA pengecualian):
//   - business date FP & bank SAMA (Asia/Jakarta)
//   - debit bank == nominal FP PERSIS (numEq, bukan toleransi rupiah longgar)
//   - selisih waktu absolut <= 3 detik
//   - HANYA ADA SATU kandidat bank utk FP itu, DAN HANYA ADA SATU kandidat
//     FP utk bank itu (mutual uniqueness, dihitung dari SELURUH pasangan
//     yang memenuhi syarat di atas -- bukan "yang terdekat menang"). Kalau
//     salah satu sisi py >1 kandidat yang sama-sama valid, KEDUA sisi tetap
//     TIDAK di-match (tidak menebak) -- FP tetap FP_ONLY/PENDING_BANK, bank
//     tetap NEED_REVIEW.
//
// TIDAK PERNAH mencocokkan hanya berdasarkan nominal ATAU waktu saja, tidak
// pernah pakai beneficiary_account/recipient_name/Journal No./angka
// panjang pada Description (spec eksplisit larangan) -- HANYA
// (business_date, nominal exact, |Δt|<=3s, kandidat unik dua arah).
// ─────────────────────────────────────────────────────────────────────────
const FALLBACK_MAX_DIFF_SECONDS = 3;

function matchBniFallbackCandidates(fpCandidates, bankCandidates) {
  const compatiblePairs = [];
  for (const fp of fpCandidates || []) {
    if (!(fp.fpTimeResponse instanceof Date) || Number.isNaN(fp.fpTimeResponse.getTime())) continue;
    if (typeof fp.fpNominal !== 'number') continue;
    const fpBusinessDate = formatDateJakartaBni(fp.fpTimeResponse);
    for (const bank of bankCandidates || []) {
      if (!(bank.transactionDateTime instanceof Date) || Number.isNaN(bank.transactionDateTime.getTime())) continue;
      // SENGAJA TIDAK memakai bank.businessDate mentah -- field itu di
      // route handler/reprocess script dibangun dari `SELECT *` TANPA cast
      // `::text` pada kolom DATE, jadi berisi JS Date object yang di-
      // String()-kan (mis. "Wed Jul 22 2026 ...".slice(0,10) -> "Wed Jul 22",
      // BUKAN "2026-07-22"). Insiden nyata: ini membuat SELURUH TIER3
      // fallback gagal (business date "cocok" tidak pernah true) saat
      // reprocess batch produksi 2026-07-22. formatDateJakartaBni() di sini
      // SELALU menghitung ulang dari transactionDateTime (Date object asli,
      // bukan string turunan yang berpotensi salah format).
      const bankBusinessDate = formatDateJakartaBni(bank.transactionDateTime);
      if (fpBusinessDate && bankBusinessDate && fpBusinessDate !== bankBusinessDate) continue;
      if (typeof bank.debit !== 'number' || !numEq(bank.debit, fp.fpNominal)) continue;
      const diffSeconds = (bank.transactionDateTime.getTime() - fp.fpTimeResponse.getTime()) / 1000;
      if (Math.abs(diffSeconds) > FALLBACK_MAX_DIFF_SECONDS) continue;
      compatiblePairs.push({ fp, bank, diffSeconds });
    }
  }

  const fpDegree = new Map();
  const bankDegree = new Map();
  for (const p of compatiblePairs) {
    fpDegree.set(p.fp.idTransaksi, (fpDegree.get(p.fp.idTransaksi) || 0) + 1);
    bankDegree.set(p.bank.bankFingerprint, (bankDegree.get(p.bank.bankFingerprint) || 0) + 1);
  }

  const matchedPairs = [];
  const matchedBankFingerprints = new Set();
  const ambiguousBankFingerprints = new Set();
  for (const p of compatiblePairs) {
    const fpUnique = fpDegree.get(p.fp.idTransaksi) === 1;
    const bankUnique = bankDegree.get(p.bank.bankFingerprint) === 1;
    if (fpUnique && bankUnique) {
      matchedPairs.push(p);
      matchedBankFingerprints.add(p.bank.bankFingerprint);
    } else {
      ambiguousBankFingerprints.add(p.bank.bankFingerprint);
    }
  }
  for (const bf of matchedBankFingerprints) ambiguousBankFingerprints.delete(bf);

  return {
    matchedPairs,
    fallbackCandidateCount: (bankCandidates || []).length,
    fallbackMatchedCount: matchedPairs.length,
    fallbackAmbiguousCount: ambiguousBankFingerprints.size,
    orphanUnconsumedFastpayCount: (bankCandidates || []).length - matchedPairs.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Normalisasi & fingerprint
// ─────────────────────────────────────────────────────────────────────────
function normalizeForFingerprint(value) { return value === null || value === undefined ? '' : String(value).trim(); }
function normalizeNumForFingerprint(value) { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : ''; }
function normalizeTextForKey(value) { return value ? String(value).toUpperCase().trim().replace(/\s+/g, ' ') : ''; }

/**
 * SHA-256 dari bank_code|Post Date|Value Date|Branch|Journal No.|
 * normalized Description|Debit|Credit — SENGAJA TIDAK memakai nomor baris
 * sheet (posisi baris bisa berubah antar sync).
 */
function buildBniBankFingerprint(row) {
  const parts = [
    normalizeForFingerprint(row.bankCode || 'BNI').toUpperCase(),
    normalizeForFingerprint(row.postDateRaw),
    normalizeForFingerprint(row.valueDateRaw),
    normalizeForFingerprint(row.branch),
    normalizeForFingerprint(row.journalNo),
    normalizeTextForKey(row.description),
    normalizeNumForFingerprint(row.debit),
    normalizeNumForFingerprint(row.credit),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * Group key 1 transaksi BNI: bank_code + business_date + extracted_transaction_id.
 * Fallback (ID tidak tersedia): bank fingerprint.
 */
function computeBniBankGroupKey(row) {
  if (row.extractedTransactionId) {
    return `ID::${normalizeForFingerprint(row.bankCode || 'BNI').toUpperCase()}|${row.businessDate || ''}|${row.extractedTransactionId}`;
  }
  return `FP::${row.bankFingerprint || ''}`;
}

/**
 * Group SELURUH baris FASTPAY_DEBIT/CREDIT_REVERSAL jadi grup per transaksi
 * BNI (via computeBniBankGroupKey). Baris FUNDING_CREDIT/NEED_REVIEW/
 * OUT_OF_SCOPE/UNKNOWN TIDAK PERNAH jadi dasar grouping/matching (hanya
 * disimpan mentah utk Raw Data/Funding Analysis).
 */
function buildBniBankGroups(bankRows) {
  const groups = new Map();
  for (const b of bankRows) {
    if (b.bankRowType !== 'FASTPAY_DEBIT' && b.bankRowType !== 'CREDIT_REVERSAL') continue;
    const key = computeBniBankGroupKey(b);
    if (!groups.has(key)) {
      groups.set(key, {
        groupKey: key, rows: [], debitRows: [], creditRows: [],
        totalDebit: 0, totalCredit: 0, debitCount: 0, creditCount: 0,
        firstTransactionTime: null, extractedTransactionId: null,
        beneficiaryAccount: null, recipientName: null, branch: null, journalNo: null,
        transactionIdFromHash: null, transactionIdFromReference: null,
        extractionConfidence: null, idConflict: false, coverageStatus: null, bankFingerprint: null,
      });
    }
    const g = groups.get(key);
    g.rows.push(b);
    if (b.bankRowType === 'FASTPAY_DEBIT') { g.debitRows.push(b); g.totalDebit += (typeof b.debit === 'number' ? b.debit : 0); g.debitCount++; }
    if (b.bankRowType === 'CREDIT_REVERSAL') { g.creditRows.push(b); g.totalCredit += (typeof b.credit === 'number' ? b.credit : 0); g.creditCount++; }
    if (!g.extractedTransactionId && b.extractedTransactionId) g.extractedTransactionId = b.extractedTransactionId;
    if (!g.beneficiaryAccount && b.beneficiaryAccount) g.beneficiaryAccount = b.beneficiaryAccount;
    if (!g.recipientName && b.recipientName) g.recipientName = b.recipientName;
    if (!g.branch && b.branch) g.branch = b.branch;
    if (!g.journalNo && b.journalNo) g.journalNo = b.journalNo;
    if (!g.transactionIdFromHash && b.transactionIdFromHash) g.transactionIdFromHash = b.transactionIdFromHash;
    if (!g.transactionIdFromReference && b.transactionIdFromReference) g.transactionIdFromReference = b.transactionIdFromReference;
    if (b.extractionConfidence) g.extractionConfidence = b.extractionConfidence;
    if (b.idConflict) g.idConflict = true;
    if (!g.coverageStatus) g.coverageStatus = b.coverageStatus;
    if (!g.bankFingerprint) g.bankFingerprint = b.bankFingerprint;
    const t = b.transactionDateTime;
    if (t instanceof Date && !Number.isNaN(t.getTime())) {
      if (!g.firstTransactionTime || t.getTime() < g.firstTransactionTime.getTime()) g.firstTransactionTime = t;
    }
  }
  return groups;
}

function baseSyntheticResult(g) {
  return {
    idTransaksi: null, idOutlet: null, idProduk: null, idBiller: null,
    fpNominal: null, fpTimeResponse: null, bankTransactionDate: g.firstTransactionTime || null,
    bankGrossDebit: null, bankPrincipal: null, bankFee: null,
    bankCredit: g.creditCount ? g.totalCredit : null, bankTotalDebit: g.debitCount ? g.totalDebit : null,
    variancePrincipal: null, varianceFee: null, timeDifferenceSeconds: null, timeOrderStatus: null,
    beneficiaryAccount: g.beneficiaryAccount, recipientName: g.recipientName, branch: g.branch, journalNo: g.journalNo,
    transactionIdFromHash: g.transactionIdFromHash, transactionIdFromReference: g.transactionIdFromReference,
    extractedTransactionId: g.extractedTransactionId, extractionConfidence: g.extractionConfidence, idConflict: g.idConflict,
    coverageStatus: g.coverageStatus, bankFingerprint: g.bankFingerprint,
    matchingMethod: 'UNKNOWN', reconStatus: 'NEED_REVIEW', agingMinutes: null, notes: null,
    reversalDate: null, reversalAmount: null, reversalLookupSource: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Matching one-to-one — PURE FUNCTION.
//
// bankRows item shape (SUDAH diklasifikasi classifyBniBankRow() +
// diekstrak extractBniIdentifiers() + parseBniDateTime() + coverage oleh
// caller SEBELUM dipanggil ke sini, pola SAMA dgn briBifastAdapter.js):
//   { bankCode, businessDate, description, debit, credit,
//     transactionDateTime, postDateRaw, valueDateRaw, branch, journalNo,
//     beneficiaryAccount, recipientName, transactionIdFromHash,
//     transactionIdFromReference, extractedTransactionId,
//     extractionConfidence, idConflict, bankRowType, coverageStatus,
//     bankFingerprint }
//
// fpRows item shape: { idTransaksi, nominal, idProduk, timeResponse
//   (Date|null), idOutlet, idBiller } — HANYA yang lolos isBniFpCandidate()
//   (id_biller='141') yang boleh dikirim ke sini (difilter caller).
// ─────────────────────────────────────────────────────────────────────────
function reconcileBniTransactions(fpRows, bankRows, config = {}, now = new Date()) {
  const expectedFee = typeof config.expectedFee === 'number' && Number.isFinite(config.expectedFee) ? config.expectedFee : DEFAULT_FEE_BNI;
  const graceMinutes = typeof config.graceMinutes === 'number' && Number.isFinite(config.graceMinutes) ? config.graceMinutes : DEFAULT_GRACE_MINUTES;
  const bankBeforeFpToleranceMinutes = typeof config.bankBeforeFpToleranceMinutes === 'number' && Number.isFinite(config.bankBeforeFpToleranceMinutes)
    ? config.bankBeforeFpToleranceMinutes : DEFAULT_BANK_BEFORE_FP_TOLERANCE_MINUTES;

  const groups = buildBniBankGroups(bankRows);
  const groupsById = new Map();
  for (const g of groups.values()) {
    if (!g.extractedTransactionId) continue;
    if (!groupsById.has(g.extractedTransactionId)) groupsById.set(g.extractedTransactionId, []);
    groupsById.get(g.extractedTransactionId).push(g);
  }
  const consumedGroupKeys = new Set();

  const fpCountById = new Map();
  for (const f of fpRows) {
    const id = normalizeKey(f.idTransaksi);
    if (!id) continue;
    fpCountById.set(id, (fpCountById.get(id) || 0) + 1);
  }

  const results = [];
  const processedIds = new Set();
  // FP yang tidak ketemu grup ID exact -- BELUM difinalkan FP_ONLY/
  // PENDING_BANK di sini, ditunda ke TIER3 UNIQUE_TIME_AMOUNT_FALLBACK
  // SETELAH loop exact-ID selesai (spec eksplisit: "Jangan membuat FP_ONLY
  // sebelum seluruh fallback selesai dijalankan"). `result` object itu
  // sendiri yang di-defer (bukan salinan field terpisah) supaya field yang
  // sudah dihitung (fpNominal/fpTimeResponse/agingMinutes/idOutlet/dst)
  // tidak perlu diduplikasi -- fallback pass tinggal MENGISI field yang
  // masih null kalau berhasil match, atau finalize FP_ONLY/PENDING_BANK
  // seperti semula kalau tidak.
  const deferredResults = [];

  for (const fp of fpRows) {
    const idTransaksi = normalizeKey(fp.idTransaksi);
    if (!idTransaksi || processedIds.has(idTransaksi)) continue;
    processedIds.add(idTransaksi);

    const isDuplicateFp = (fpCountById.get(idTransaksi) || 0) > 1;
    const fpTimeResponse = fp.timeResponse instanceof Date && !Number.isNaN(fp.timeResponse.getTime()) ? fp.timeResponse : null;
    const agingMinutes = fpTimeResponse ? Math.round((now.getTime() - fpTimeResponse.getTime()) / 60000) : null;
    const fpNominal = typeof fp.nominal === 'number' ? fp.nominal : null;

    const result = {
      idTransaksi, idOutlet: fp.idOutlet || null, idProduk: fp.idProduk || null, idBiller: fp.idBiller || null,
      fpNominal, fpTimeResponse, bankTransactionDate: null,
      bankGrossDebit: null, bankPrincipal: null, bankFee: null, bankCredit: null, bankTotalDebit: null,
      variancePrincipal: null, varianceFee: null, timeDifferenceSeconds: null, timeOrderStatus: null,
      beneficiaryAccount: null, recipientName: null, branch: null, journalNo: null,
      transactionIdFromHash: null, transactionIdFromReference: null, extractedTransactionId: null,
      extractionConfidence: null, idConflict: false, coverageStatus: null, bankFingerprint: null,
      matchingMethod: 'UNMATCHED', reconStatus: 'NEED_REVIEW', agingMinutes, notes: null,
      reversalDate: null, reversalAmount: null, reversalLookupSource: null,
    };

    if (isDuplicateFp) {
      result.reconStatus = 'DUPLICATE_FP';
      result.notes = `id_transaksi muncul ${fpCountById.get(idTransaksi)} kali di DATA FP.`;
      results.push(result);
      continue;
    }

    const candidateGroups = (groupsById.get(idTransaksi) || []).filter(g => !consumedGroupKeys.has(g.groupKey));
    if (candidateGroups.length === 0) {
      deferredResults.push(result); // TIER3 fallback pass memutuskan status-nya, lihat bawah
      continue;
    }

    // Tie-breaker deterministic kalau >1 grup kebetulan share extracted ID
    // yang sama (mis. lintas business_date) -- selisih waktu absolut terkecil.
    let winningGroup = candidateGroups[0];
    if (candidateGroups.length > 1) {
      const scored = candidateGroups.map(g => ({
        g, diffMs: (fpTimeResponse && g.firstTransactionTime) ? Math.abs(g.firstTransactionTime.getTime() - fpTimeResponse.getTime()) : Number.MAX_SAFE_INTEGER,
      }));
      scored.sort((a, b) => a.diffMs - b.diffMs);
      winningGroup = scored[0].g;
    }

    // Tandai consumed SEGERA — sebelum cascade status ditentukan.
    consumedGroupKeys.add(winningGroup.groupKey);
    const g = winningGroup;

    result.bankTransactionDate = g.firstTransactionTime || null;
    result.beneficiaryAccount = g.beneficiaryAccount;
    result.recipientName = g.recipientName;
    result.branch = g.branch;
    result.journalNo = g.journalNo;
    result.transactionIdFromHash = g.transactionIdFromHash;
    result.transactionIdFromReference = g.transactionIdFromReference;
    result.extractedTransactionId = g.extractedTransactionId;
    result.extractionConfidence = g.extractionConfidence;
    result.idConflict = g.idConflict;
    result.coverageStatus = g.coverageStatus;
    result.bankFingerprint = g.bankFingerprint;
    result.bankCredit = g.creditCount ? g.totalCredit : null;
    result.bankTotalDebit = g.debitCount ? g.totalDebit : null;
    result.matchingMethod = g.extractionConfidence === 'HIGH' ? 'TIER1_EXACT'
      : (g.transactionIdFromReference && !g.transactionIdFromHash ? 'REFERENCE_ONLY'
        : (g.transactionIdFromHash && !g.transactionIdFromReference ? 'HASH_ONLY' : 'TIER1_EXACT'));

    if (fpTimeResponse && result.bankTransactionDate) {
      const diffSeconds = Math.round((result.bankTransactionDate.getTime() - fpTimeResponse.getTime()) / 1000);
      result.timeDifferenceSeconds = diffSeconds;
      result.timeOrderStatus = computeBniTimeOrderStatus(diffSeconds, bankBeforeFpToleranceMinutes);
    }

    if (g.debitCount > 1) {
      // >1 baris debit dgn transaction ID yang sama -- ambigu mana
      // principal, JANGAN dijumlahkan otomatis (spec eksplisit).
      result.reconStatus = 'DUPLICATE_BANK';
      result.bankPrincipal = g.debitRows[0].debit;
      result.notes = `${g.debitCount} baris debit BNI sama-sama memiliki transaction ID ${idTransaksi} pada tanggal yang sama.`;
    } else {
      const principalRow = g.debitRows[0] || null;
      if (!principalRow) {
        result.reconStatus = 'NEED_REVIEW';
        result.notes = 'Ditemukan credit dengan transaction ID sama tapi tidak ada baris debit pasangannya.';
      } else {
        result.bankGrossDebit = principalRow.debit;
        if (numEq(principalRow.debit, (fpNominal || 0) + expectedFee)) {
          result.bankPrincipal = fpNominal;
          result.bankFee = expectedFee;
          result.variancePrincipal = 0;
          result.varianceFee = 0;
          result.reconStatus = 'MATCHED';
        } else if (expectedFee > 0 && numEq(principalRow.debit, fpNominal)) {
          result.bankPrincipal = principalRow.debit;
          result.bankFee = 0;
          result.variancePrincipal = 0;
          result.reconStatus = 'MATCHED_NO_FEE';
        } else if (fpNominal !== null && principalRow.debit > fpNominal) {
          result.bankPrincipal = fpNominal;
          result.bankFee = principalRow.debit - fpNominal;
          result.varianceFee = result.bankFee - expectedFee;
          result.reconStatus = 'FEE_MISMATCH';
          result.notes = `Debit bank (Rp${principalRow.debit}) lebih besar dari nominal FP (Rp${fpNominal}), selisih Rp${result.bankFee} bukan expected fee Rp${expectedFee}.`;
        } else {
          result.bankPrincipal = principalRow.debit;
          result.variancePrincipal = fpNominal !== null ? principalRow.debit - fpNominal : null;
          result.reconStatus = 'NOMINAL_MISMATCH';
          result.notes = `Debit bank (Rp${principalRow.debit}) berbeda dari nominal FP (Rp${fpNominal}).`;
        }
      }
    }

    // Waktu EXTREME/IMPOSSIBLE_ORDER -> exact ID TIDAK otomatis dianggap
    // valid, turunkan ke NEED_REVIEW (spec eksplisit) -- SEBELUM override
    // REVERSAL (yang tetap prioritas tertinggi, lihat di bawah).
    if (
      (result.reconStatus === 'MATCHED' || result.reconStatus === 'MATCHED_NO_FEE' || result.reconStatus === 'FEE_MISMATCH') &&
      (result.timeOrderStatus === 'EXTREME' || result.timeOrderStatus === 'IMPOSSIBLE_ORDER')
    ) {
      result.reconStatus = 'NEED_REVIEW';
      result.notes = [result.notes, `Selisih waktu ${result.timeOrderStatus} (${result.timeDifferenceSeconds}s) -- tidak otomatis dianggap valid.`].filter(Boolean).join(' ');
    }

    // Credit/reversal MENIMPA status di atas -- prioritas tertinggi.
    if (g.creditCount > 0) {
      result.reconStatus = 'REVERSAL';
      result.reversalAmount = g.totalCredit;
      result.reversalDate = g.creditRows[0].transactionDateTime || null;
      result.reversalLookupSource = 'SAME_DATE';
      result.notes = [result.notes, `Ditemukan ${g.creditCount} baris credit reversal sebesar Rp${g.totalCredit}.`].filter(Boolean).join(' ');
    }

    results.push(result);
  }

  // ── TIER3 UNIQUE_TIME_AMOUNT_FALLBACK -- HANYA utk FP yang gagal exact-ID
  // (deferredResults) dipasangkan ke bank row FASTPAY_DEBIT_FALLBACK_CANDIDATE
  // yang masih unconsumed. Dijalankan SETELAH seluruh exact-ID matching
  // selesai (tidak pernah mendahului/menggantikan TIER1/TIER2). ──
  const fallbackBankCandidates = bankRows.filter(b => b.bankRowType === 'FASTPAY_DEBIT_FALLBACK_CANDIDATE');
  const fallback = matchBniFallbackCandidates(
    deferredResults.map(r => ({ idTransaksi: r.idTransaksi, fpNominal: r.fpNominal, fpTimeResponse: r.fpTimeResponse })),
    fallbackBankCandidates
  );
  const fallbackMatchedBankFingerprints = new Set(fallback.matchedPairs.map(p => p.bank.bankFingerprint));
  const fallbackPairByFpId = new Map(fallback.matchedPairs.map(p => [p.fp.idTransaksi, p]));

  for (const result of deferredResults) {
    const pair = fallbackPairByFpId.get(result.idTransaksi);
    if (pair) {
      const bank = pair.bank;
      const diffSeconds = Math.round(pair.diffSeconds);
      result.bankTransactionDate = bank.transactionDateTime || null;
      result.bankGrossDebit = bank.debit;
      result.bankPrincipal = bank.debit;
      result.bankFee = 0;
      result.bankTotalDebit = bank.debit;
      result.variancePrincipal = 0;
      result.varianceFee = 0;
      result.timeDifferenceSeconds = diffSeconds;
      result.timeOrderStatus = computeBniTimeOrderStatus(diffSeconds, bankBeforeFpToleranceMinutes);
      result.beneficiaryAccount = bank.beneficiaryAccount;
      result.recipientName = bank.recipientName;
      result.branch = bank.branch;
      result.journalNo = bank.journalNo;
      result.transactionIdFromHash = bank.transactionIdFromHash;
      result.transactionIdFromReference = bank.transactionIdFromReference;
      result.extractedTransactionId = null; // TIDAK PERNAH menganggap ekstraksi ID valid lewat jalur fallback
      result.extractionConfidence = bank.extractionConfidence;
      result.idConflict = bank.idConflict;
      result.coverageStatus = bank.coverageStatus;
      result.bankFingerprint = bank.bankFingerprint;
      result.matchingMethod = 'UNIQUE_TIME_AMOUNT_FALLBACK';
      result.reconStatus = 'MATCHED';
      result.notes = `Dicocokkan via TIER3 fallback nominal+waktu (selisih ${diffSeconds} detik) -- transaction ID tidak lengkap pada Description bank ("BMS_SNAP API #" terpotong).`;
    } else {
      result.reconStatus = (result.agingMinutes !== null && result.agingMinutes < graceMinutes) ? 'PENDING_BANK' : 'FP_ONLY';
    }
    results.push(result);
  }

  // ── BANK_ONLY / REVERSAL / NEED_REVIEW tanpa FP -- HANYA grup/baris yang
  // belum consumed DAN berada INSIDE_FP_COVERAGE. Di luar coverage TETAP
  // tersimpan di Raw Data (recon_bank_transactions) tapi TIDAK PERNAH
  // menghasilkan recon_results sintetis (spec eksplisit). ──
  for (const g of groups.values()) {
    if (consumedGroupKeys.has(g.groupKey)) continue;
    if (g.coverageStatus !== 'INSIDE_FP_COVERAGE') continue;

    if (g.debitCount > 1) {
      results.push({
        ...baseSyntheticResult(g),
        reconStatus: 'NEED_REVIEW',
        matchingMethod: 'UNKNOWN',
        notes: `${g.debitCount} baris debit BNI dgn transaction ID sama, tanpa pasangan FP -- ambigu mana principal.`,
      });
      continue;
    }

    const principalRow = g.debitRows[0] || null;
    const isReversalNoFp = g.creditCount > 0;
    const reconStatus = isReversalNoFp ? 'REVERSAL' : (principalRow ? 'BANK_ONLY' : 'NEED_REVIEW');
    results.push({
      ...baseSyntheticResult(g),
      bankPrincipal: principalRow ? principalRow.debit : null,
      matchingMethod: g.extractionConfidence === 'HIGH' ? 'TIER1_EXACT' : (g.extractionConfidence === 'MEDIUM' ? (g.transactionIdFromReference ? 'REFERENCE_ONLY' : 'HASH_ONLY') : 'UNKNOWN'),
      reconStatus,
      reversalDate: isReversalNoFp ? (g.creditRows[0]?.transactionDateTime || null) : null,
      reversalAmount: isReversalNoFp ? g.totalCredit : null,
      reversalLookupSource: isReversalNoFp ? 'SAME_DATE' : null,
      notes: isReversalNoFp
        ? `Ditemukan reversal BNI (transaction ID: ${g.extractedTransactionId}, credit Rp${g.totalCredit}) tanpa pasangan FP.`
        : (principalRow
          ? `Ditemukan mutasi FASTPAY_DEBIT BNI (transaction ID: ${g.extractedTransactionId}) tapi tidak ada di DATA FP.`
          : `Grup transaksi BNI tanpa baris principal yang jelas.`),
    });
  }

  // ── Baris bank NEED_REVIEW berdiri sendiri (deskripsi FASTPAY-like tapi
  // ID tidak valid/conflict) -- TIDAK PERNAH ikut grouping (bankRowType-nya
  // bukan FASTPAY_DEBIT/CREDIT_REVERSAL). classifyBniBankRow() SUDAH
  // memastikan hanya baris INSIDE_FP_COVERAGE yang diberi type NEED_REVIEW
  // (di luar coverage -> OUT_OF_SCOPE), jadi tidak perlu filter ulang di
  // sini -- tetap dicek eksplisit sbg defense-in-depth. Baris
  // FASTPAY_DEBIT_FALLBACK_CANDIDATE yang GAGAL TIER3 (tidak ada kandidat
  // FP cocok, atau ambigu) IKUT jatuh ke sini juga -- HANYA kalau belum
  // consumed lewat fallback (fallbackMatchedBankFingerprints).
  for (const b of bankRows) {
    const isPlainNeedReview = b.bankRowType === 'NEED_REVIEW';
    const isUnresolvedFallbackCandidate = b.bankRowType === 'FASTPAY_DEBIT_FALLBACK_CANDIDATE' && !fallbackMatchedBankFingerprints.has(b.bankFingerprint);
    if (!isPlainNeedReview && !isUnresolvedFallbackCandidate) continue;
    if (b.coverageStatus !== 'INSIDE_FP_COVERAGE') continue;
    results.push({
      ...baseSyntheticResult({
        firstTransactionTime: b.transactionDateTime, creditCount: 0, totalCredit: 0, debitCount: 0, totalDebit: 0,
        beneficiaryAccount: b.beneficiaryAccount, recipientName: b.recipientName, branch: b.branch, journalNo: b.journalNo,
        transactionIdFromHash: b.transactionIdFromHash, transactionIdFromReference: b.transactionIdFromReference,
        extractedTransactionId: b.extractedTransactionId, extractionConfidence: b.extractionConfidence, idConflict: b.idConflict,
        coverageStatus: b.coverageStatus, bankFingerprint: b.bankFingerprint,
      }),
      reconStatus: 'NEED_REVIEW',
      matchingMethod: 'UNKNOWN',
      notes: isUnresolvedFallbackCandidate
        ? 'Deskripsi FASTPAY tapi transaction ID tidak lengkap pada Description, dan TIER3 fallback nominal+waktu tidak menemukan pasangan unik (tidak ada kandidat FP cocok, atau ambigu >1 kandidat).'
        : (b.idConflict
          ? 'Deskripsi FASTPAY tapi hash ID dan reference ID BERBEDA (conflict) -- tidak bisa dipilih otomatis.'
          : 'Deskripsi FASTPAY tapi transaction ID tidak dapat diekstrak (malformed).'),
    });
  }

  // Diagnostic TIER3 (spec eksplisit) -- ditempel sbg properti non-index di
  // array `results` (BUKAN mengubah return jadi object) supaya SELURUH
  // caller existing yang memperlakukan hasil sbg array biasa (.filter/.map/
  // for..of/.length, termasuk test lama) tetap jalan tanpa perubahan.
  results.fallbackDiagnostics = {
    fallback_candidate_count: fallback.fallbackCandidateCount,
    fallback_matched_count: fallback.fallbackMatchedCount,
    fallback_ambiguous_count: fallback.fallbackAmbiguousCount,
    orphan_unconsumed_fastpay_count: fallback.orphanUnconsumedFastpayCount,
  };

  return results;
}

/**
 * Reversal Cross-Date Lookup — TERISOLASI dari reconcileBniTransactions()
 * (spec eksplisit). PURE function: results dari 1 batch + futureCreditGroupsByKey
 * (Map extracted_transaction_id -> array baris CREDIT_REVERSAL dari
 * business_date+1 s.d. +reversalLookupDays, DISIAPKAN PEMANGGIL). HANYA
 * exact extracted_transaction_id (spec eksplisit -- TIDAK PERNAH pakai
 * nominal/nama penerima).
 */
function applyBniReversalCrossDateLookup(results, futureCreditGroupsByKey) {
  const eligibleStatuses = ['FP_ONLY', 'BANK_ONLY', 'MATCHED', 'MATCHED_NO_FEE', 'FEE_MISMATCH', 'NOMINAL_MISMATCH', 'PENDING_BANK'];
  return results.map(r => {
    if (r.reconStatus === 'REVERSAL') return r;
    if (!eligibleStatuses.includes(r.reconStatus)) return r;
    const key = r.idTransaksi || r.extractedTransactionId || null;
    if (!key) return r;
    const futureCredits = futureCreditGroupsByKey.get(key);
    if (!futureCredits || !futureCredits.length) return r;

    const totalCredit = futureCredits.reduce((s, c) => s + (typeof c.credit === 'number' ? c.credit : 0), 0);
    const firstCredit = futureCredits[0];
    return {
      ...r,
      reconStatus: 'REVERSAL',
      bankCredit: totalCredit,
      reversalAmount: totalCredit,
      reversalDate: firstCredit.transactionDateTime || null,
      reversalLookupSource: 'CROSS_DATE_ID',
      notes: [r.notes, `Reversal ditemukan pada ${firstCredit.businessDate || 'tanggal lain'} (cross-date ID lookup, ${futureCredits.length} baris credit sebesar Rp${totalCredit}).`].filter(Boolean).join(' '),
    };
  });
}

module.exports = {
  BNI_ID_BILLER,
  isBniFpCandidate,
  extractBniIdentifiers,
  classifyBniBankRow,
  parseBniDateTime,
  formatDateJakartaBni,
  computeBniCoverage,
  classifyBniCoverageStatus,
  computeBniTimeOrderStatus,
  computeBniBankGroupKey,
  buildBniBankGroups,
  matchBniFallbackCandidates,
  reconcileBniTransactions,
  applyBniReversalCrossDateLookup,
  buildBniBankFingerprint,
  numEq,
  normalizeKey,
  FALLBACK_MAX_DIFF_SECONDS,
  DEFAULT_FEE_BNI,
  DEFAULT_GRACE_MINUTES,
  DEFAULT_COVERAGE_TOLERANCE_BEFORE_MINUTES,
  DEFAULT_COVERAGE_TOLERANCE_AFTER_MINUTES,
  DEFAULT_MATCHING_TIME_TOLERANCE_MINUTES,
  DEFAULT_BANK_BEFORE_FP_TOLERANCE_MINUTES,
  DEFAULT_REVERSAL_LOOKUP_DAYS,
};
