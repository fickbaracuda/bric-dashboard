/**
 * Rekonsiliasi BRI BI-FAST — Adapter (MODUL BARU, TERPISAH dari briAdapter.js)
 *
 * Bagian dari "Reconciliation Core Engine" bersama OCBC/Mandiri/BRI existing
 * — REUSE tabel recon_sync_batches/recon_fp_transactions/recon_bank_transactions/
 * recon_results/recon_action_logs (bank_code = 'BRI_BIFAST'). Helper dasar
 * (extractToken, nullIfEmpty, cleanNum, csvEscape, dst) di-reuse dari
 * warroom-reconciliation.js oleh route handler — TIDAK di sini.
 *
 * BEDA MENDASAR dari BRI existing (briAdapter.js): BRI existing = 1 transaksi
 * bank = 1 baris debit gross (principal+fee digabung). BRI BI-FAST = 1
 * transaksi = 2 baris debit terpisah (principal + fee Rp77), digrup lewat
 * bank_trace_id (dari TLBDS2, pola "20YYMMDDBRINIDJA...") — BUKAN
 * extracted_transaction_id seperti BRI existing. Matching key JUGA beda:
 * BRI existing & Mandiri/OCBC pakai id_transaksi; BRI BI-FAST pakai
 * DATA FP.bill_info1 == beneficiary_account hasil ekstraksi pola "BFST<digits>"
 * dari mutasi bank. SENGAJA TIDAK mengimpor apa pun dari briAdapter.js —
 * struktur transaksi & aturan groupingnya berbeda, mencampur keduanya
 * berisiko salah menerapkan aturan gross-debit BRI ke sini atau sebaliknya.
 *
 * SEMUA fungsi di sini PURE (tidak menyentuh DB) supaya bisa di-unit-test
 * langsung — lihat backend/scripts/test-reconciliation-bri-bifast.js.
 */

const crypto = require('crypto');

const DEFAULT_FEE_BRI_BIFAST = Number(process.env.RECON_BRI_BIFAST_FEE_DEFAULT) || 77;
const DEFAULT_GRACE_MINUTES = Number(process.env.RECON_BRI_BIFAST_GRACE_MINUTES) || 30;
const DEFAULT_BANK_POSTING_BEFORE_FP_TOLERANCE_MINUTES = Number(process.env.RECON_BRI_BIFAST_BEFORE_TOLERANCE_MINUTES) || 5;
const DEFAULT_BANK_POSTING_AFTER_FP_TOLERANCE_MINUTES = Number(process.env.RECON_BRI_BIFAST_AFTER_TOLERANCE_MINUTES) || 1440;
const DEFAULT_MISMATCH_TIME_TOLERANCE_MINUTES = Number(process.env.RECON_BRI_BIFAST_MISMATCH_TOLERANCE_MINUTES) || 60;
const DEFAULT_REVERSAL_LOOKUP_DAYS = Number(process.env.RECON_BRI_BIFAST_REVERSAL_LOOKUP_DAYS) || 3;
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
// Eligibility gate — HANYA baris FP dengan id_biller = '11096' yang menjadi
// kandidat rekonsiliasi BRI BI-FAST (spec: "Jangan menjadikan id_produk
// sebagai filter utama" — id_produk disimpan utk pencarian/filter/fee
// analysis/breakdown, BUKAN dipakai memfilter kandidat). Dipanggil route
// handler SEBELUM baris FP masuk ke reconcileBriBifastTransactions() —
// fungsi ini diekspor supaya bisa di-unit-test independen (TEST 1).
// ─────────────────────────────────────────────────────────────────────────
const BRI_BIFAST_ID_BILLER = '11096';
function isBriBifastFpCandidate(row) {
  return normalizeKey(row.idBiller) === BRI_BIFAST_ID_BILLER;
}

// ─────────────────────────────────────────────────────────────────────────
// Ekstraksi beneficiary account, bank trace id, counterparty BIC, ESB ref —
// SEMUA independen dari 2 sumber teks (DESK_TRAN, TRREMK) utk beneficiary
// account (TLBDS2 TIDAK dipakai di sini — TLBDS2 sumber utama bank_trace_id).
// TIDAK PERNAH diam-diam memilih salah satu account saat conflict.
// ─────────────────────────────────────────────────────────────────────────
const BFST_PATTERN = /\bBFST([0-9]{6,20})\b/i;
const APFT_PATTERN = /\bAPFT:([A-Z0-9]{8,11})\b/i;
const TRACE_PATTERN = /\b20\d{6}BRINIDJA[0-9A-Z]+\b/i;
const ESB_PATTERN = /\bESB:(\S+)\b/i;

function extractBeneficiaryFromText(text) {
  const t = String(text || '');
  const m = BFST_PATTERN.exec(t);
  return m ? m[1] : null;
}
function extractTraceFromText(text) {
  const t = String(text || '');
  const m = TRACE_PATTERN.exec(t);
  return m ? m[0] : null;
}
function extractCounterpartyBicFromText(text) {
  const t = String(text || '');
  const m = APFT_PATTERN.exec(t);
  return m ? m[1] : null;
}
function extractEsbReferenceFromText(text) {
  const t = String(text || '');
  const m = ESB_PATTERN.exec(t);
  return m ? m[1] : null;
}

/**
 * row: { deskTran, trremk, tlbds2 } (teks mentah). Mengembalikan:
 * { beneficiaryAccount, accountFromDeskTran, accountFromTrremk,
 *   extractionConfidence, accountConflict, bankTraceId, traceFromDeskTran,
 *   traceFromTlbds2, counterpartyBic, esbReference }
 *
 * confidence: HIGH (DESK_TRAN & TRREMK sepakat), MEDIUM (hanya 1 sumber),
 * CONFLICT (account BEDA antar sumber), NONE (tidak ada sama sekali).
 */
function extractBriBifastIdentifiers(row) {
  const accountFromDeskTran = extractBeneficiaryFromText(row.deskTran);
  const accountFromTrremk = extractBeneficiaryFromText(row.trremk);

  const candidates = [accountFromDeskTran, accountFromTrremk].filter(Boolean);
  const uniqueAccounts = [...new Set(candidates)];

  let beneficiaryAccount = null;
  let extractionConfidence = 'NONE';
  let accountConflict = false;

  if (uniqueAccounts.length === 1) {
    beneficiaryAccount = uniqueAccounts[0];
    extractionConfidence = candidates.length >= 2 ? 'HIGH' : 'MEDIUM';
  } else if (uniqueAccounts.length > 1) {
    accountConflict = true;
    extractionConfidence = 'CONFLICT';
  }

  const traceFromDeskTran = extractTraceFromText(row.deskTran);
  const traceFromTlbds2 = extractTraceFromText(row.tlbds2);
  // Prioritas: TLBDS2 > DESK_TRAN > null (fallback fingerprint dihitung
  // pemanggil di level GROUP, bukan di level ekstraksi 1 baris).
  const bankTraceId = traceFromTlbds2 || traceFromDeskTran || null;

  const counterpartyBic = extractCounterpartyBicFromText(row.deskTran) || extractCounterpartyBicFromText(row.trremk) || null;
  const esbReference = extractEsbReferenceFromText(row.deskTran) || extractEsbReferenceFromText(row.trremk) || null;

  return {
    beneficiaryAccount, accountFromDeskTran, accountFromTrremk,
    extractionConfidence, accountConflict,
    bankTraceId, traceFromDeskTran, traceFromTlbds2,
    counterpartyBic, esbReference,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Klasifikasi 1 baris mutasi BRI BI-FAST -> bank_row_type.
// row: { deskTran, trremk, mutasiDebet (number|null), mutasiKredit (number|null) }
//
// Urutan keputusan (PENTING, sesuai spec):
//   1. DESK_TRAN & TRREMK kosong -> UNKNOWN.
//   2. Tidak ditemukan pola BFST ATAU APFT: di kedua sumber -> OUT_OF_SCOPE
//      (mutasi rekening yang jelas TIDAK terkait BI-FAST).
//   3. Account conflict (DESK_TRAN vs TRREMK beda) -> NEED_REVIEW.
//   4. Pola BI-FAST valid tapi beneficiary account tidak ditemukan -> NEED_REVIEW.
//   5. MUTASI_KREDIT > 0 -> CREDIT_REVERSAL.
//   6. MUTASI_DEBET > 0 -> DEBIT_COMPONENT.
//   7. Selain itu -> NEED_REVIEW.
// ─────────────────────────────────────────────────────────────────────────
function classifyBriBifastRow(row, config = {}) {
  const idInfo = extractBriBifastIdentifiers(row);
  const hasAnyDescription = !!(String(row.deskTran || '').trim() || String(row.trremk || '').trim());

  if (!hasAnyDescription) {
    return { bankRowType: 'UNKNOWN', ...idInfo };
  }

  const looksLikeBiFast =
    BFST_PATTERN.test(row.deskTran || '') || BFST_PATTERN.test(row.trremk || '') ||
    APFT_PATTERN.test(row.deskTran || '') || APFT_PATTERN.test(row.trremk || '');
  if (!looksLikeBiFast) {
    return { bankRowType: 'OUT_OF_SCOPE', ...idInfo };
  }

  if (idInfo.accountConflict) {
    return { bankRowType: 'NEED_REVIEW', ...idInfo };
  }
  if (!idInfo.beneficiaryAccount) {
    return { bankRowType: 'NEED_REVIEW', ...idInfo };
  }

  const debit = typeof row.mutasiDebet === 'number' ? row.mutasiDebet : null;
  const credit = typeof row.mutasiKredit === 'number' ? row.mutasiKredit : null;

  if (typeof credit === 'number' && credit > 0) {
    return { bankRowType: 'CREDIT_REVERSAL', ...idInfo };
  }
  if (typeof debit === 'number' && debit > 0) {
    return { bankRowType: 'DEBIT_COMPONENT', ...idInfo };
  }
  return { bankRowType: 'NEED_REVIEW', ...idInfo };
}

// ─────────────────────────────────────────────────────────────────────────
// Waktu — JAM_TRAN presisi detik (padStart 6 digit), TGL_TRAN (posting),
// TGL_EFEKTIF (business date), SELURUHNYA di-anchor Asia/Jakarta (+07:00).
// Independen dari briAdapter.js (adapter ini SENGAJA berdiri sendiri).
// ─────────────────────────────────────────────────────────────────────────
function normalizeJamTran(jamTran) {
  if (jamTran === null || jamTran === undefined || jamTran === '') return null;
  const padded = String(jamTran).trim().padStart(6, '0');
  if (!/^\d{6}$/.test(padded)) return null;
  const hh = padded.slice(0, 2), mm = padded.slice(2, 4), ss = padded.slice(4, 6);
  const hhN = Number(hh), mmN = Number(mm), ssN = Number(ss);
  if (hhN < 0 || hhN > 23 || mmN < 0 || mmN > 59 || ssN < 0 || ssN > 59) return null;
  return `${hh}:${mm}:${ss}`;
}

function parseFlexibleBriBifastDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  if (!s) return null;

  let y, mo, d, h = '0', mi = '0', se = '0';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    y = m[1]; mo = m[2]; d = m[3]; h = m[4] || '0'; mi = m[5] || '0'; se = m[6] || '0';
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (m) { d = m[1]; mo = m[2]; y = m[3]; h = m[4] || '0'; mi = m[5] || '0'; se = m[6] || '0'; }
  }
  if (!y) {
    const generic = new Date(s);
    return Number.isNaN(generic.getTime()) ? null : generic;
  }
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(se).padStart(2, '0')}+07:00`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatDateJakartaBriBifast(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/**
 * row: { tglTran, tglEfektif, jamTran }. transaction_date_time = TGL_TRAN +
 * jam presisi dari JAM_TRAN (fallback ke jam bawaan TGL_TRAN kalau JAM_TRAN
 * tidak valid — extraction_warning dilaporkan terpisah oleh caller kalau
 * perlu). effective_date_time = TGL_EFEKTIF. business_date = tanggal
 * TGL_EFEKTIF dalam Asia/Jakarta (BUKAN toISOString().slice(0,10)).
 */
function parseBriBifastTransactionTime(row) {
  const jamNormalized = normalizeJamTran(row.jamTran);
  const jamWasProvided = row.jamTran !== null && row.jamTran !== undefined && row.jamTran !== '';
  const jamInvalid = jamWasProvided && !jamNormalized;

  let transactionDateTime = parseFlexibleBriBifastDateTime(row.tglTran);
  if (transactionDateTime && jamNormalized) {
    const dateStr = formatDateJakartaBriBifast(transactionDateTime);
    if (dateStr) {
      const combined = new Date(`${dateStr}T${jamNormalized}+07:00`);
      if (!Number.isNaN(combined.getTime())) transactionDateTime = combined;
    }
  }

  const effectiveDateTime = parseFlexibleBriBifastDateTime(row.tglEfektif);
  const businessDate = effectiveDateTime ? formatDateJakartaBriBifast(effectiveDateTime) : null;

  return {
    transactionDateTime, effectiveDateTime, businessDate,
    jamTranNormalized: jamNormalized, extractionWarning: jamInvalid ? 'JAM_TRAN tidak valid, fallback ke jam TGL_TRAN.' : null,
  };
}

/** 0 <= |diff| bucket, versi BI-FAST (vocabulary beda dari BRI existing: NORMAL/WARNING/DELAYED/EXTREME/IMPOSSIBLE_ORDER). */
function computeBriBifastTimeOrderStatus(diffMinutes, toleranceBeforeMinutes) {
  if (diffMinutes === null || diffMinutes === undefined || !Number.isFinite(diffMinutes)) return null;
  if (diffMinutes < -toleranceBeforeMinutes) return 'IMPOSSIBLE_ORDER';
  const abs = Math.abs(diffMinutes);
  if (abs <= 5) return 'NORMAL';
  if (abs <= 15) return 'WARNING';
  if (abs <= 30) return 'DELAYED';
  return 'EXTREME';
}

/**
 * Eligibility waktu utk kandidat TIER 1/2 — bank posting yang terlalu jauh
 * SEBELUM FP (melebihi toleransi, default 5 menit) TIDAK PERNAH boleh
 * dipasangkan (IMPOSSIBLE_ORDER tidak boleh otomatis MATCHED), begitu juga
 * yang terlalu jauh SETELAH FP (melebihi toleransi, default 1440 menit).
 * Kalau salah satu waktu tidak tersedia -> dianggap eligible (tidak bisa
 * dinilai, fallback lenient — konsisten dgn adapter lain saat data waktu hilang).
 */
function isBankPostingTimeEligible(postingTime, fpTimeResponse, config) {
  if (!(postingTime instanceof Date) || Number.isNaN(postingTime.getTime())) return true;
  if (!(fpTimeResponse instanceof Date) || Number.isNaN(fpTimeResponse.getTime())) return true;
  const diffMinutes = (postingTime.getTime() - fpTimeResponse.getTime()) / 60000;
  if (diffMinutes < -config.bankPostingBeforeFpToleranceMinutes) return false;
  if (diffMinutes > config.bankPostingAfterFpToleranceMinutes) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Normalisasi teks utk group key fallback & fingerprint — uppercase, trim,
// collapse whitespace, TIDAK menghapus digit (spec eksplisit).
// ─────────────────────────────────────────────────────────────────────────
function normalizeTextForKey(value) {
  if (!value) return '';
  return String(value).toUpperCase().trim().replace(/\s+/g, ' ');
}
function normalizeForFingerprint(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}
function normalizeNumForFingerprint(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '';
}

/**
 * Group key SATU transfer BI-FAST (principal+fee, kadang +credit reversal).
 * Prioritas: bank_code+account_no+business_date+bank_trace_id. Fallback
 * (trace tidak tersedia): account_no+business_date+JAM_TRAN+SEQ+
 * beneficiary_account+normalized DESK_TRAN — SENGAJA BUKAN cuma
 * beneficiary_account (1 account bisa terima banyak transfer sehari) atau
 * cuma SEQ (spec eksplisit melarang keduanya sbg key tunggal).
 */
function computeBriBifastGroupKey(row) {
  if (row.bankTraceId) {
    return `TRACE::${normalizeForFingerprint(row.bankCode || 'BRI_BIFAST').toUpperCase()}|${normalizeForFingerprint(row.accountNo)}|${row.businessDate || ''}|${row.bankTraceId}`;
  }
  return `FALLBACK::${normalizeForFingerprint(row.accountNo)}|${row.businessDate || ''}|${row.jamTranNormalized || ''}|${normalizeForFingerprint(row.seq)}|${normalizeForFingerprint(row.beneficiaryAccount)}|${normalizeTextForKey(row.deskTran)}`;
}

/**
 * Group SELURUH baris DEBIT_COMPONENT/CREDIT_REVERSAL jadi grup per
 * transfer BI-FAST. Baris NEED_REVIEW/OUT_OF_SCOPE/UNKNOWN TIDAK PERNAH
 * jadi dasar grouping/matching (hanya disimpan mentah utk Raw Data).
 *
 * Per grup, dihitung KLASIFIKASI principal/fee TANPA konteks FP (dipakai
 * utk BANK_ONLY yang memang tidak punya FP pasangan):
 *   feeCandidates    = debit rows dengan MUTASI_DEBET == expected_fee
 *   nonFeeDebitRows  = debit rows dengan MUTASI_DEBET != expected_fee
 * principal_row_count = nonFeeDebitRows.length (dipakai definisi BANK_ONLY:
 * >1 -> NEED_REVIEW, bukan BANK_ONLY). Saat FP TERSEDIA (di
 * reconcileBriBifastTransactions), principal SEBENARNYA ditentukan dari
 * exact match nominal FP (bisa beda dari heuristik fee-based ini) — pola
 * SAMA dgn buildOcbcBankGroups()/reconcileMandiriTransactions().
 */
function buildBriBifastBankGroups(bankRows, config = {}) {
  const expectedFee = typeof config.expectedFee === 'number' && Number.isFinite(config.expectedFee) ? config.expectedFee : DEFAULT_FEE_BRI_BIFAST;
  const groups = new Map();

  for (const b of bankRows) {
    if (b.bankRowType !== 'DEBIT_COMPONENT' && b.bankRowType !== 'CREDIT_REVERSAL') continue;
    const key = computeBriBifastGroupKey(b);
    if (!groups.has(key)) {
      groups.set(key, {
        groupKey: key, rows: [], debitRows: [], creditRows: [],
        totalDebit: 0, totalCredit: 0, debitCount: 0, creditCount: 0,
        firstTransactionTime: null, lastTransactionTime: null,
        beneficiaryAccount: null, bankTraceId: null, counterpartyBic: null,
        accountConflict: false, extractionMethods: new Set(),
      });
    }
    const g = groups.get(key);
    g.rows.push(b);
    if (b.bankRowType === 'DEBIT_COMPONENT') { g.debitRows.push(b); g.totalDebit += (typeof b.mutasiDebet === 'number' ? b.mutasiDebet : 0); g.debitCount++; }
    if (b.bankRowType === 'CREDIT_REVERSAL') { g.creditRows.push(b); g.totalCredit += (typeof b.mutasiKredit === 'number' ? b.mutasiKredit : 0); g.creditCount++; }
    if (!g.beneficiaryAccount && b.beneficiaryAccount) g.beneficiaryAccount = b.beneficiaryAccount;
    if (!g.bankTraceId && b.bankTraceId) g.bankTraceId = b.bankTraceId;
    if (!g.counterpartyBic && b.counterpartyBic) g.counterpartyBic = b.counterpartyBic;
    if (b.accountConflict) g.accountConflict = true;
    if (b.extractionConfidence) g.extractionMethods.add(b.extractionConfidence);
    const t = b.transactionDateTime;
    if (t instanceof Date && !Number.isNaN(t.getTime())) {
      if (!g.firstTransactionTime || t.getTime() < g.firstTransactionTime.getTime()) g.firstTransactionTime = t;
      if (!g.lastTransactionTime || t.getTime() > g.lastTransactionTime.getTime()) g.lastTransactionTime = t;
    }
  }

  for (const g of groups.values()) {
    g.feeCandidates = g.debitRows.filter(r => numEq(r.mutasiDebet, expectedFee));
    g.nonFeeDebitRows = g.debitRows.filter(r => !numEq(r.mutasiDebet, expectedFee));
    g.principalRowCount = g.nonFeeDebitRows.length;
    g.feeRowCount = g.feeCandidates.length;
    g.creditRowCount = g.creditRows.length;
  }

  return groups;
}

// ─────────────────────────────────────────────────────────────────────────
// Matching one-to-one — PURE FUNCTION.
//
// bankRows item shape (SUDAH diklasifikasi classifyBriBifastRow() +
// parseBriBifastTransactionTime() oleh caller SEBELUM dipanggil ke sini,
// pola SAMA dgn briAdapter.js):
//   { bankCode, accountNo, businessDate, seq, deskTran, trremk, tlbds2,
//     mutasiDebet, mutasiKredit, transactionDateTime,
//     beneficiaryAccount, bankTraceId, counterpartyBic, accountConflict,
//     extractionConfidence, bankRowType, jamTranNormalized }
//
// fpRows item shape: { idTransaksi, billInfo1, nominal, idProduk,
//   timeResponse (Date|null), idOutlet, idBiller } — HANYA yang lolos
//   isBriBifastFpCandidate() (id_biller=11096) yang boleh dikirim ke sini
//   (difilter caller/route handler, BUKAN di dalam fungsi ini).
// ─────────────────────────────────────────────────────────────────────────
function reconcileBriBifastTransactions(fpRows, bankRows, config = {}, now = new Date()) {
  const expectedFee = typeof config.expectedFee === 'number' && Number.isFinite(config.expectedFee) ? config.expectedFee : DEFAULT_FEE_BRI_BIFAST;
  const graceMinutes = typeof config.graceMinutes === 'number' && Number.isFinite(config.graceMinutes) ? config.graceMinutes : DEFAULT_GRACE_MINUTES;
  const bankPostingBeforeFpToleranceMinutes = typeof config.bankPostingBeforeFpToleranceMinutes === 'number' && Number.isFinite(config.bankPostingBeforeFpToleranceMinutes)
    ? config.bankPostingBeforeFpToleranceMinutes : DEFAULT_BANK_POSTING_BEFORE_FP_TOLERANCE_MINUTES;
  const bankPostingAfterFpToleranceMinutes = typeof config.bankPostingAfterFpToleranceMinutes === 'number' && Number.isFinite(config.bankPostingAfterFpToleranceMinutes)
    ? config.bankPostingAfterFpToleranceMinutes : DEFAULT_BANK_POSTING_AFTER_FP_TOLERANCE_MINUTES;
  const mismatchTimeToleranceMinutes = typeof config.mismatchTimeToleranceMinutes === 'number' && Number.isFinite(config.mismatchTimeToleranceMinutes)
    ? config.mismatchTimeToleranceMinutes : DEFAULT_MISMATCH_TIME_TOLERANCE_MINUTES;
  const timeConfig = { bankPostingBeforeFpToleranceMinutes, bankPostingAfterFpToleranceMinutes };

  const groups = buildBriBifastBankGroups(bankRows, { expectedFee });

  // Index grup per beneficiary account — SATU beneficiary bisa punya BANYAK
  // grup (banyak transfer ke akun yang sama hari itu). SENGAJA TIDAK
  // memfilter berdasarkan principal_row_count di sini (beda dari heuristik
  // fee-based yang dipakai utk BANK_ONLY tanpa konteks FP) — begitu FP
  // nominal tersedia, principal SEBENARNYA ditentukan via exact match
  // terhadap nominal FP (lihat TIER 1 di bawah), BUKAN via heuristik
  // "MUTASI_DEBET != expected_fee". Grup dgn 2 baris debit (principal + fee
  // salah nilai, mis. bukan Rp77) TETAP harus bisa jadi kandidat TIER 1.
  const groupsByBeneficiary = new Map();
  for (const g of groups.values()) {
    if (g.accountConflict) continue;
    if (!g.beneficiaryAccount) continue;
    if (!groupsByBeneficiary.has(g.beneficiaryAccount)) groupsByBeneficiary.set(g.beneficiaryAccount, []);
    groupsByBeneficiary.get(g.beneficiaryAccount).push(g);
  }

  // Precompute TIER 2 eligibility (STATIS dari input, bukan runtime-berubah
  // seiring proses) — "hanya satu FP unmatched" & "hanya satu bank principal
  // unmatched" utk 1 beneficiary account SECARA KESELURUHAN batch ini.
  const fpCountByBeneficiary = new Map();
  for (const fp of fpRows) {
    const key = normalizeKey(fp.billInfo1);
    if (!key) continue;
    fpCountByBeneficiary.set(key, (fpCountByBeneficiary.get(key) || 0) + 1);
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

  for (const fp of fpRows) {
    const idTransaksi = normalizeKey(fp.idTransaksi);
    if (!idTransaksi || processedIds.has(idTransaksi)) continue;
    processedIds.add(idTransaksi);

    const isDuplicateFp = (fpCountById.get(idTransaksi) || 0) > 1;
    const billInfo1 = normalizeKey(fp.billInfo1);
    const fpTimeResponse = fp.timeResponse instanceof Date && !Number.isNaN(fp.timeResponse.getTime()) ? fp.timeResponse : null;
    const agingMinutes = fpTimeResponse ? Math.round((now.getTime() - fpTimeResponse.getTime()) / 60000) : null;

    const result = {
      idTransaksi, billInfo1, beneficiaryAccount: null, idOutlet: fp.idOutlet || null, idProduk: fp.idProduk || null, idBiller: fp.idBiller || null,
      fpNominal: typeof fp.nominal === 'number' ? fp.nominal : null, fpTimeResponse, bankTransactionDate: null,
      bankPrincipal: null, bankFee: null, bankCredit: null, bankTotalDebit: null,
      variancePrincipal: null, varianceFee: null, timeDifferenceMinutes: null, timeOrderStatus: null,
      accountNo: null, bankTraceId: null, counterpartyBic: null, extractionConfidence: null, accountConflict: false,
      matchingMethod: 'UNMATCHED', reconStatus: 'NEED_REVIEW', agingMinutes, notes: null,
      reversalDate: null, reversalAmount: null, reversalLookupSource: null, stableGroupFingerprint: null,
    };

    if (isDuplicateFp) {
      result.reconStatus = 'DUPLICATE_FP';
      result.notes = `id_transaksi muncul ${fpCountById.get(idTransaksi)} kali di DATA FP.`;
      results.push(result);
      continue;
    }

    if (!billInfo1) {
      // Tidak ada key pencocokan sama sekali -> tidak pernah dicoba match,
      // langsung PENDING_BANK/FP_ONLY (sama sprt "tidak ada bank group").
      result.reconStatus = (agingMinutes !== null && agingMinutes < graceMinutes) ? 'PENDING_BANK' : 'FP_ONLY';
      result.notes = 'bill_info1 kosong pada baris FP ini — tidak bisa dicari pasangan bank.';
      results.push(result);
      continue;
    }

    const candidateGroups = (groupsByBeneficiary.get(billInfo1) || []).filter(g => !consumedGroupKeys.has(g.groupKey));

    // ── TIER 1 — EXACT MATCH (beneficiary + nominal EXACT, eligible waktu) ──
    // Cek SEMUA baris debit di grup (bukan cuma nonFeeDebitRows[0]) --
    // principal SEBENARNYA adalah baris mana pun yang exact sama dgn
    // nominal FP, terlepas dari heuristik fee-based (lihat catatan di atas).
    const fpNominal = result.fpNominal;
    let exactCandidates = [];
    let anyExactNominalGroupExists = false;
    if (fpNominal !== null) {
      const groupsWithExactNominal = candidateGroups.filter(g => g.debitRows.some(r => numEq(r.mutasiDebet, fpNominal)));
      anyExactNominalGroupExists = groupsWithExactNominal.length > 0;
      exactCandidates = groupsWithExactNominal.filter(g => isBankPostingTimeEligible(g.firstTransactionTime, fpTimeResponse, timeConfig));
    }

    let winningGroup = null;
    let matchTier = null;

    if (exactCandidates.length > 0) {
      if (exactCandidates.length === 1) {
        winningGroup = exactCandidates[0];
      } else {
        // Tie-breaker deterministic: selisih waktu absolut terkecil -> posting
        // time ASC -> bank_trace_id ASC.
        const scored = exactCandidates.map(g => {
          const diffMs = (fpTimeResponse && g.firstTransactionTime) ? Math.abs(g.firstTransactionTime.getTime() - fpTimeResponse.getTime()) : Number.MAX_SAFE_INTEGER;
          return { g, diffMs };
        });
        scored.sort((a, b) => {
          if (a.diffMs !== b.diffMs) return a.diffMs - b.diffMs;
          const at = a.g.firstTransactionTime ? a.g.firstTransactionTime.getTime() : Number.MAX_SAFE_INTEGER;
          const bt = b.g.firstTransactionTime ? b.g.firstTransactionTime.getTime() : Number.MAX_SAFE_INTEGER;
          if (at !== bt) return at - bt;
          return String(a.g.bankTraceId || '').localeCompare(String(b.g.bankTraceId || ''));
        });
        winningGroup = scored[0].g;
      }
      matchTier = 'TIER1_EXACT';
    } else if (!anyExactNominalGroupExists) {
      // ── TIER 2 — NOMINAL MISMATCH (pairing bersyarat KETAT) ──
      // HANYA dicoba kalau BENAR-BENAR tidak ada kandidat exact nominal sama
      // sekali (anyExactNominalGroupExists dicek TANPA filter eligibility
      // waktu) -- kalau ada exact-nominal candidate yang cuma gagal krn
      // IMPOSSIBLE_ORDER/di luar toleransi waktu, itu BUKAN skenario nominal
      // mismatch (spec: "hanya boleh dilakukan jika ... tidak ada exact
      // nominal candidate"), jadi TIDAK dipaksa jadi NOMINAL_MISMATCH juga.
      const eligibleForTier2 =
        (fpCountByBeneficiary.get(billInfo1) || 0) === 1 &&
        candidateGroups.length === 1 &&
        (groupsByBeneficiary.get(billInfo1) || []).length === 1; // total grup utk account ini (bukan cuma unconsumed) jg harus 1
      if (eligibleForTier2) {
        const onlyGroup = candidateGroups[0];
        const diffMinutes = (fpTimeResponse && onlyGroup.firstTransactionTime)
          ? (onlyGroup.firstTransactionTime.getTime() - fpTimeResponse.getTime()) / 60000 : null;
        const withinMismatchTolerance = diffMinutes !== null && Math.abs(diffMinutes) <= mismatchTimeToleranceMinutes;
        if (withinMismatchTolerance) {
          winningGroup = onlyGroup;
          matchTier = 'TIER2_NOMINAL_MISMATCH';
        }
      }
    }

    if (!winningGroup) {
      result.reconStatus = (agingMinutes !== null && agingMinutes < graceMinutes) ? 'PENDING_BANK' : 'FP_ONLY';
      results.push(result);
      continue;
    }

    // Tandai consumed SEGERA — sebelum cascade status ditentukan (fix pola
    // insiden REVERSAL+BANK_ONLY double count pada adapter lain).
    consumedGroupKeys.add(winningGroup.groupKey);

    const g = winningGroup;
    result.beneficiaryAccount = g.beneficiaryAccount;
    result.bankTransactionDate = g.firstTransactionTime || null;
    result.accountNo = g.rows[0]?.accountNo || null;
    result.bankTraceId = g.bankTraceId;
    result.counterpartyBic = g.counterpartyBic;
    result.extractionConfidence = [...g.extractionMethods][0] || null;
    result.accountConflict = g.accountConflict;
    result.matchingMethod = matchTier;
    result.bankCredit = g.creditRowCount ? g.totalCredit : null;
    result.bankTotalDebit = g.debitCount ? g.totalDebit : null;

    if (fpTimeResponse && result.bankTransactionDate) {
      const diffMinutes = (result.bankTransactionDate.getTime() - fpTimeResponse.getTime()) / 60000;
      result.timeDifferenceMinutes = Math.round(diffMinutes);
      result.timeOrderStatus = computeBriBifastTimeOrderStatus(diffMinutes, bankPostingBeforeFpToleranceMinutes);
    }

    if (matchTier === 'TIER1_EXACT') {
      // Principal = SATU-SATUNYA debit row yang exact sama dgn nominal FP —
      // fee = SISA debit row lain di grup yang SAMA (pola identik OCBC/
      // Mandiri, BUKAN heuristik expected_fee di level grup). Ini mencegah
      // "principal terbesar selalu dianggap principal tanpa validasi".
      const principalCandidatesInGroup = g.debitRows.filter(r => numEq(r.mutasiDebet, fpNominal));
      if (principalCandidatesInGroup.length > 1) {
        result.reconStatus = 'DUPLICATE_BANK';
        result.bankPrincipal = principalCandidatesInGroup[0].mutasiDebet;
        result.notes = `${principalCandidatesInGroup.length} baris debit BI-FAST sama-sama cocok dgn nominal FP (Rp${fpNominal}) pada grup transfer yang sama.`;
      } else {
        const principalRow = principalCandidatesInGroup[0];
        result.bankPrincipal = principalRow.mutasiDebet;
        result.variancePrincipal = 0;
        const feeRows = g.debitRows.filter(r => r !== principalRow);
        const feeTotal = feeRows.reduce((s, r) => s + (typeof r.mutasiDebet === 'number' ? r.mutasiDebet : 0), 0);
        result.bankFee = feeRows.length ? feeTotal : 0;
        result.varianceFee = feeRows.length ? (feeTotal - expectedFee) : (0 - expectedFee);

        if (feeRows.length === 0) {
          result.reconStatus = 'MATCHED_NO_FEE';
        } else if (numEq(feeTotal, expectedFee)) {
          result.reconStatus = 'MATCHED';
        } else {
          result.reconStatus = 'FEE_MISMATCH';
          result.notes = `Fee BI-FAST Rp${feeTotal} berbeda dari expected fee Rp${expectedFee}.`;
        }
      }
    } else {
      // TIER2_NOMINAL_MISMATCH — principal "terbaik tebakan" pakai heuristik
      // fee-based grup (tidak ada exact nominal utk disandingkan).
      const principalRow = g.nonFeeDebitRows[0];
      result.bankPrincipal = principalRow ? principalRow.mutasiDebet : null;
      result.variancePrincipal = (result.bankPrincipal !== null && fpNominal !== null) ? (result.bankPrincipal - fpNominal) : null;
      result.bankFee = g.feeRowCount ? g.feeCandidates.reduce((s, r) => s + r.mutasiDebet, 0) : (g.debitCount > 1 ? g.totalDebit - (result.bankPrincipal || 0) : 0);
      result.reconStatus = 'NOMINAL_MISMATCH';
      result.notes = `Principal BI-FAST (Rp${result.bankPrincipal}) berbeda dgn nominal FP (Rp${fpNominal}) — dipasangkan via TIER 2 (satu-satunya kandidat utk beneficiary account ini).`;
    }

    // Credit/reversal MENIMPA status di atas — sinyal reversal lebih kuat.
    if (g.creditRowCount > 0) {
      result.reconStatus = 'REVERSAL';
      result.reversalAmount = g.totalCredit;
      result.reversalDate = g.creditRows[0].transactionDateTime || null;
      result.reversalLookupSource = 'SAME_BATCH';
      result.notes = [result.notes, `Ditemukan ${g.creditRowCount} baris credit/reversal sebesar Rp${g.totalCredit}.`].filter(Boolean).join(' ');
    }

    results.push(result);
  }

  // ── BANK_ONLY / REVERSAL tanpa FP — per GROUP, HANYA yang belum consumed. ──
  for (const g of groups.values()) {
    if (consumedGroupKeys.has(g.groupKey)) continue;
    if (g.accountConflict) continue; // account conflict -> NEED_REVIEW, bukan BANK_ONLY (lihat di bawah)
    if (!g.beneficiaryAccount) continue; // tidak ada beneficiary teridentifikasi sama sekali -> bukan kandidat berdiri sendiri di sini (tersimpan mentah di Raw Data)

    const stableGroupFingerprint = crypto.createHash('sha256').update(g.groupKey).digest('hex');

    if (g.principalRowCount > 1) {
      results.push({
        idTransaksi: null, billInfo1: null, beneficiaryAccount: g.beneficiaryAccount,
        idOutlet: null, idProduk: null, idBiller: null,
        fpNominal: null, fpTimeResponse: null, bankTransactionDate: g.firstTransactionTime,
        bankPrincipal: null, bankFee: null, bankCredit: g.creditRowCount ? g.totalCredit : null, bankTotalDebit: g.totalDebit,
        variancePrincipal: null, varianceFee: null, timeDifferenceMinutes: null, timeOrderStatus: null,
        accountNo: g.rows[0]?.accountNo || null, bankTraceId: g.bankTraceId, counterpartyBic: g.counterpartyBic,
        extractionConfidence: [...g.extractionMethods][0] || null, accountConflict: false,
        matchingMethod: 'UNKNOWN', reconStatus: 'NEED_REVIEW', agingMinutes: null,
        notes: `${g.principalRowCount} baris debit (bukan fee Rp${expectedFee}) ditemukan tanpa pasangan FP pada grup transfer yang sama — ambigu mana principal.`,
        reversalDate: null, reversalAmount: null, reversalLookupSource: null, stableGroupFingerprint,
      });
      continue;
    }

    // principalRowCount===0 (fee-only, tanpa credit) jatuh ke NEED_REVIEW di
    // bawah (principalRow=null, isReversalNoFp=false) -- spec rule 5:
    // "Fee-only tanpa principal: NEED_REVIEW". TIDAK di-skip/continue.
    const principalRow = g.nonFeeDebitRows[0] || null;
    const isReversalNoFp = g.creditRowCount > 0;
    const reconStatus = isReversalNoFp ? 'REVERSAL' : (principalRow ? 'BANK_ONLY' : 'NEED_REVIEW');

    results.push({
      idTransaksi: null, billInfo1: null, beneficiaryAccount: g.beneficiaryAccount,
      idOutlet: null, idProduk: null, idBiller: null,
      fpNominal: null, fpTimeResponse: null, bankTransactionDate: g.firstTransactionTime,
      bankPrincipal: principalRow ? principalRow.mutasiDebet : null,
      bankFee: g.feeRowCount ? g.feeCandidates.reduce((s, r) => s + r.mutasiDebet, 0) : null,
      bankCredit: g.creditRowCount ? g.totalCredit : null,
      bankTotalDebit: g.debitCount ? g.totalDebit : null,
      variancePrincipal: null, varianceFee: null, timeDifferenceMinutes: null, timeOrderStatus: null,
      accountNo: g.rows[0]?.accountNo || null, bankTraceId: g.bankTraceId, counterpartyBic: g.counterpartyBic,
      extractionConfidence: [...g.extractionMethods][0] || null, accountConflict: false,
      matchingMethod: [...g.extractionMethods][0] || 'UNKNOWN',
      reconStatus, agingMinutes: null,
      notes: isReversalNoFp
        ? `Ditemukan reversal BI-FAST (beneficiary: ${g.beneficiaryAccount}, debit Rp${g.totalDebit} dibalik credit Rp${g.totalCredit}) tanpa pasangan FP.`
        : (principalRow
          ? `Ditemukan mutasi BI-FAST (beneficiary: ${g.beneficiaryAccount}) tapi tidak ada di DATA FP.`
          : `Grup transfer BI-FAST fee-only (beneficiary: ${g.beneficiaryAccount}) tanpa baris principal yang jelas.`),
      reversalDate: isReversalNoFp ? (g.creditRows[0]?.transactionDateTime || null) : null,
      reversalAmount: isReversalNoFp ? g.totalCredit : null,
      reversalLookupSource: isReversalNoFp ? 'SAME_BATCH' : null,
      stableGroupFingerprint,
    });
  }

  return results;
}

/**
 * Reversal Cross-Date Lookup — TERISOLASI dari reconcileBriBifastTransactions()
 * (spec eksplisit). PURE function: results dari 1 batch + futureCreditGroupsByKey
 * (Map "account_no|bank_trace_id" -> array baris CREDIT_REVERSAL dari
 * business_date+1 s.d. +reversalLookupDays, DISIAPKAN PEMANGGIL). Cross-date
 * lookup HANYA pakai exact bank_trace_id + account_no (spec eksplisit —
 * TIDAK PERNAH pakai beneficiary_account, krn 1 akun bisa terima banyak
 * transaksi).
 */
function applyBriBifastReversalCrossDateLookup(results, futureCreditGroupsByKey, config = {}) {
  const eligibleStatuses = ['FP_ONLY', 'BANK_ONLY', 'MATCHED', 'MATCHED_NO_FEE', 'FEE_MISMATCH', 'NOMINAL_MISMATCH', 'PENDING_BANK'];
  return results.map(r => {
    if (r.reconStatus === 'REVERSAL') return r;
    if (!eligibleStatuses.includes(r.reconStatus)) return r;
    if (!r.bankTraceId || !r.accountNo) return r;
    const key = `${normalizeKey(r.accountNo)}|${r.bankTraceId}`;
    const futureCredits = futureCreditGroupsByKey.get(key);
    if (!futureCredits || !futureCredits.length) return r;

    const totalCredit = futureCredits.reduce((s, c) => s + (typeof c.mutasiKredit === 'number' ? c.mutasiKredit : 0), 0);
    const firstCredit = futureCredits[0];
    return {
      ...r,
      reconStatus: 'REVERSAL',
      bankCredit: totalCredit,
      reversalAmount: totalCredit,
      reversalDate: firstCredit.transactionDateTime || null,
      reversalLookupSource: 'CROSS_DATE_TRACE',
      notes: [r.notes, `Reversal ditemukan pada ${firstCredit.businessDate || 'tanggal lain'} (cross-date trace lookup, ${futureCredits.length} baris credit sebesar Rp${totalCredit}).`].filter(Boolean).join(' '),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Validasi saldo BRI BI-FAST — PER ROW: SALDO_AWAL_MUTASI - MUTASI_DEBET +
// MUTASI_KREDIT harus sama dgn SALDO_AKHIR_MUTASI (±Rp1). Informatif,
// TIDAK PERNAH mengubah recon_status transaksi manapun.
// ─────────────────────────────────────────────────────────────────────────
function validateBriBifastBalance(bankRows) {
  let balanced = 0, unbalanced = 0, undetermined = 0, varianceTotal = 0;
  for (const r of (bankRows || [])) {
    const opening = typeof r.saldoAwalMutasi === 'number' ? r.saldoAwalMutasi : null;
    const closing = typeof r.saldoAkhirMutasi === 'number' ? r.saldoAkhirMutasi : null;
    const debit = typeof r.mutasiDebet === 'number' ? r.mutasiDebet : 0;
    const credit = typeof r.mutasiKredit === 'number' ? r.mutasiKredit : 0;
    if (opening === null || closing === null) { undetermined++; continue; }
    const expected = opening - debit + credit;
    const variance = closing - expected;
    if (Math.abs(variance) <= 1) balanced++;
    else { unbalanced++; varianceTotal += variance; }
  }
  let status = 'UNDETERMINED';
  if (unbalanced > 0) status = 'UNBALANCED';
  else if (balanced > 0) status = 'BALANCED';
  return {
    status,
    balanced_row_count: balanced,
    unbalanced_row_count: unbalanced,
    undetermined_row_count: undetermined,
    balance_variance_total: varianceTotal,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Fingerprint raw bank row — idempotensi sync (UNIQUE row_fingerprint per
// bank_code). SENGAJA TIDAK memakai nomor baris sheet. DESK_TRAN
// dinormalisasi (uppercase, collapse whitespace) SEBELUM di-hash. Menambah
// TLBDS2 ke input hash (spec eksplisit) — beda dari buildBriFingerprint
// (BRI existing) yang tidak menyertakannya.
// ─────────────────────────────────────────────────────────────────────────
function buildBriBifastFingerprint(row) {
  const parts = [
    normalizeForFingerprint(row.bankCode || 'BRI_BIFAST').toUpperCase(),
    normalizeForFingerprint(row.norek),
    normalizeForFingerprint(row.tglTranNormalized),
    normalizeForFingerprint(row.tglEfektifNormalized),
    normalizeForFingerprint(row.jamTran),
    normalizeForFingerprint(row.seq),
    normalizeTextForKey(row.deskTran),
    normalizeNumForFingerprint(row.mutasiDebet),
    normalizeNumForFingerprint(row.mutasiKredit),
    normalizeNumForFingerprint(row.saldoAkhirMutasi),
    normalizeForFingerprint(row.tlbds2),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

module.exports = {
  isBriBifastFpCandidate,
  extractBriBifastIdentifiers,
  classifyBriBifastRow,
  normalizeJamTran,
  parseFlexibleBriBifastDateTime,
  parseBriBifastTransactionTime,
  formatDateJakartaBriBifast,
  computeBriBifastTimeOrderStatus,
  isBankPostingTimeEligible,
  computeBriBifastGroupKey,
  buildBriBifastBankGroups,
  reconcileBriBifastTransactions,
  applyBriBifastReversalCrossDateLookup,
  validateBriBifastBalance,
  buildBriBifastFingerprint,
  numEq,
  normalizeKey,
  BRI_BIFAST_ID_BILLER,
  DEFAULT_FEE_BRI_BIFAST,
  DEFAULT_GRACE_MINUTES,
  DEFAULT_BANK_POSTING_BEFORE_FP_TOLERANCE_MINUTES,
  DEFAULT_BANK_POSTING_AFTER_FP_TOLERANCE_MINUTES,
  DEFAULT_MISMATCH_TIME_TOLERANCE_MINUTES,
  DEFAULT_REVERSAL_LOOKUP_DAYS,
};
