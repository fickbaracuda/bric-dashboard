/**
 * Rekonsiliasi BRI — Adapter Bank BRI (mutasi FASTPAY)
 *
 * Bagian dari "Reconciliation Core Engine" bersama:
 *   backend/src/routes/warroom-reconciliation.js        (Core + Adapter OCBC)
 *   backend/src/routes/warroom-reconciliation-mandiri.js (route handler + Adapter Mandiri)
 *   backend/src/routes/warroom-reconciliation-bri.js     (route handler, pakai adapter ini)
 *
 * Beda mendasar dari OCBC/Mandiri: statement BRI (mutasi rekening biasa,
 * BUKAN sheet khusus FASTPAY) mencampur SEMUA jenis transaksi rekening —
 * transfer FASTPAY, biaya admin, transfer lain (pola "BKO..."), dst. Hanya
 * mutasi yang secara pola JELAS terkait FASTPAY yang boleh masuk lingkup
 * rekonsiliasi; sisanya harus di-set OUT_OF_SCOPE (bukan BANK_ONLY) supaya
 * Exception Queue tidak dibanjiri mutasi yang sama sekali tidak relevan.
 *
 * Satu transaksi FASTPAY BRI umumnya HANYA 1 baris debit (MUTASI_DEBET =
 * nominal FP + fee, digabung — beda dari OCBC/Mandiri yang punya baris
 * fee terpisah). ID transaksi diekstrak dari 3 sumber teks (DESK_TRAN,
 * TRREMK, TLBDS2) yang SEHARUSNYA saling konsisten — kalau tidak, jangan
 * diam-diam pilih salah satu, tandai NEED_REVIEW.
 *
 * SEMUA fungsi di sini PURE (tidak menyentuh DB) supaya bisa di-unit-test
 * langsung — lihat backend/scripts/test-reconciliation-bri.js. Fungsi
 * reversal cross-date (applyBriReversalCrossDateLookup) SENGAJA dipisah
 * dari reconcileBriTransactions() — spec eksplisit minta isolasi krn ini
 * fitur yang lebih berisiko (harus query bank row dari tanggal LAIN).
 */

const crypto = require('crypto');

const DEFAULT_FEE_BRI = Number(process.env.RECON_BRI_FEE_DEFAULT) || 150;
const DEFAULT_GRACE_MINUTES = Number(process.env.RECON_BRI_GRACE_MINUTES) || 30;
const DEFAULT_COVERAGE_TOLERANCE_MINUTES = Number(process.env.RECON_BRI_COVERAGE_TOLERANCE_MINUTES) || 60;
const DEFAULT_REVERSAL_LOOKUP_DAYS = Number(process.env.RECON_BRI_REVERSAL_LOOKUP_DAYS) || 3;
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
// Ekstraksi ID transaksi — 3 sumber independen, WAJIB konsisten
// ─────────────────────────────────────────────────────────────────────────
const DESK_TRAN_ID_PATTERN = /\/(\d{8,12})\b/;
const TRREMK_ID_PATTERN = /\/(\d{8,12})\b/;
const TLBDS2_ID_PATTERN = /WS_OB;(\d{8,12});/;
const FASTPAY_PATTERN = /\bFASTPAY\b/i;

function extractIdFromText(text, pattern) {
  const t = String(text || '').trim();
  if (!t) return null;
  const m = pattern.exec(t);
  return m ? m[1] : null;
}

/**
 * Ekstrak SELURUH kandidat ID dari DESK_TRAN, TRREMK, TLBDS2 (utk validasi
 * konsistensi antar sumber — bukan cuma ambil yang pertama ketemu).
 * Prioritas kalau semua sumber SEPAKAT (tidak conflict): DESK_TRAN ->
 * TRREMK -> TLBDS2 (menentukan `extractionMethod` yang dilaporkan).
 *
 * confidence:
 *   HIGH    — minimal 2 sumber menemukan ID yang SAMA (tanpa conflict).
 *   MEDIUM  — hanya 1 sumber menemukan ID.
 *   CONFLICT— lebih dari satu ID BERBEDA ditemukan antar sumber.
 *   NONE    — tidak ada sumber yang menghasilkan ID sama sekali.
 * TIDAK PERNAH diam-diam memilih salah satu ID saat conflict.
 */
function extractBriTransactionIds(row) {
  const deskId = extractIdFromText(row.deskTran, DESK_TRAN_ID_PATTERN);
  const remarkId = extractIdFromText(row.trremk, TRREMK_ID_PATTERN);
  const tlbds2Id = extractIdFromText(row.tlbds2, TLBDS2_ID_PATTERN);

  const candidates = [deskId, remarkId, tlbds2Id].filter(Boolean);
  const uniqueIds = [...new Set(candidates)];

  let extractedTransactionId = null;
  let extractionMethod = 'NONE';
  let extractionConfidence = 'NONE';
  let idConflict = false;

  if (uniqueIds.length === 1) {
    extractedTransactionId = uniqueIds[0];
    if (deskId === extractedTransactionId) extractionMethod = 'DESK_TRAN';
    else if (remarkId === extractedTransactionId) extractionMethod = 'TRREMK';
    else extractionMethod = 'TLBDS2';
    extractionConfidence = candidates.length >= 2 ? 'HIGH' : 'MEDIUM';
  } else if (uniqueIds.length > 1) {
    idConflict = true;
    extractionMethod = 'CONFLICT';
    extractionConfidence = 'CONFLICT';
  }

  return { deskId, remarkId, tlbds2Id, extractedTransactionId, extractionMethod, extractionConfidence, idConflict };
}

function isFastpayPattern(text) {
  return FASTPAY_PATTERN.test(String(text || ''));
}

/**
 * Klasifikasi 1 baris mutasi BRI -> bank_row_type. Row shape minimal:
 * { deskTran, trremk, tlbds2, mutasiDebet (number|null), mutasiKredit (number|null) }
 *
 * Urutan keputusan (PENTING, lihat dokumentasi):
 *   1. Tidak ada teks Description sama sekali (DESK_TRAN & TRREMK kosong)
 *      -> UNKNOWN (data tidak cukup utk menilai pola sama sekali).
 *   2. Bukan pola FASTPAY (DESK_TRAN maupun TRREMK) -> OUT_OF_SCOPE,
 *      TERLEPAS dari hasil ekstraksi ID (mis. pola "BKO...") — supaya
 *      mutasi yang jelas TIDAK terkait FASTPAY tidak pernah "naik derajat"
 *      jadi NEED_REVIEW hanya krn kebetulan ada digit mirip ID.
 *   3. Pola FASTPAY valid, tapi ID conflict ATAU tidak ada ID sama sekali
 *      -> NEED_REVIEW.
 *   4. Pola FASTPAY + ID valid + MUTASI_KREDIT > 0 -> CREDIT_REVERSAL.
 *   5. Pola FASTPAY + ID valid + MUTASI_DEBET > 0 -> DEBIT_TRANSFER.
 *   6. Sisanya (FASTPAY + ID valid tapi tidak ada debit/credit > 0)
 *      -> NEED_REVIEW (data tidak lengkap).
 */
function classifyBriRow(row) {
  const idInfo = extractBriTransactionIds(row);
  const hasAnyDescription = !!(String(row.deskTran || '').trim() || String(row.trremk || '').trim());

  if (!hasAnyDescription) {
    return { bankRowType: 'UNKNOWN', ...idInfo };
  }

  const looksLikeFastpay = isFastpayPattern(row.deskTran) || isFastpayPattern(row.trremk);
  if (!looksLikeFastpay) {
    return { bankRowType: 'OUT_OF_SCOPE', ...idInfo };
  }

  if (idInfo.idConflict || !idInfo.extractedTransactionId) {
    return { bankRowType: 'NEED_REVIEW', ...idInfo };
  }

  const debit = typeof row.mutasiDebet === 'number' ? row.mutasiDebet : null;
  const credit = typeof row.mutasiKredit === 'number' ? row.mutasiKredit : null;

  if (typeof credit === 'number' && credit > 0) {
    return { bankRowType: 'CREDIT_REVERSAL', ...idInfo };
  }
  if (typeof debit === 'number' && debit > 0) {
    return { bankRowType: 'DEBIT_TRANSFER', ...idInfo };
  }
  return { bankRowType: 'NEED_REVIEW', ...idInfo };
}

// ─────────────────────────────────────────────────────────────────────────
// Waktu — JAM_TRAN presisi detik, TGL_TRAN (posting), TGL_EFEKTIF (business
// date), SELURUHNYA di-anchor Asia/Jakarta (+07:00), TIDAK PERNAH
// toISOString().slice(0,10).
// ─────────────────────────────────────────────────────────────────────────

/** JAM_TRAN mentah (mis. 3153 atau "3153") -> "HH:MM:SS" tervalidasi, atau null kalau tidak valid. */
function normalizeJamTran(jamTran) {
  if (jamTran === null || jamTran === undefined || jamTran === '') return null;
  const padded = String(jamTran).trim().padStart(6, '0');
  if (!/^\d{6}$/.test(padded)) return null;
  const hh = padded.slice(0, 2), mm = padded.slice(2, 4), ss = padded.slice(4, 6);
  const hhN = Number(hh), mmN = Number(mm), ssN = Number(ss);
  if (hhN < 0 || hhN > 23 || mmN < 0 || mmN > 59 || ssN < 0 || ssN > 59) return null;
  return `${hh}:${mm}:${ss}`;
}

/**
 * Parser tanggal-jam fleksibel, di-ANCHOR eksplisit ke Asia/Jakarta
 * (+07:00) — pola SAMA dgn parseFlexibleDateTime() di Rekonsiliasi
 * Mandiri, direplikasi di sini (adapter ini sengaja berdiri sendiri,
 * tidak import lintas adapter) supaya briAdapter.js tetap independen.
 */
function parseFlexibleBriDateTime(value) {
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

/** Format instant (Date) sbg "YYYY-MM-DD" dalam Asia/Jakarta — BUKAN toISOString().slice(0,10) yg selalu UTC. */
function formatDateJakartaBri(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/**
 * row: { tglTran, tglEfektif (string/Date, biasanya sudah ISO-ish dari Apps
 * Script), jamTran (raw, mis. 3153) }.
 * transaction_date_time = TGL_TRAN + jam presisi dari JAM_TRAN (kalau valid,
 * else pakai jam bawaan TGL_TRAN / tengah malam WIB).
 * effective_date_time   = TGL_EFEKTIF (tengah malam WIB — hanya tanggal).
 * business_date         = tanggal TGL_EFEKTIF dalam Asia/Jakarta.
 */
function parseBriTransactionTime(row) {
  const jamNormalized = normalizeJamTran(row.jamTran);

  let transactionDateTime = parseFlexibleBriDateTime(row.tglTran);
  if (transactionDateTime && jamNormalized) {
    const dateStr = formatDateJakartaBri(transactionDateTime);
    if (dateStr) {
      const combined = new Date(`${dateStr}T${jamNormalized}+07:00`);
      if (!Number.isNaN(combined.getTime())) transactionDateTime = combined;
    }
  }

  const effectiveDateTime = parseFlexibleBriDateTime(row.tglEfektif);
  const businessDate = effectiveDateTime ? formatDateJakartaBri(effectiveDateTime) : null;

  return { transactionDateTime, effectiveDateTime, businessDate, jamTranNormalized: jamNormalized };
}

// ─────────────────────────────────────────────────────────────────────────
// Coverage window — default FP_COVERAGE_WINDOW (bank row di luar rentang
// waktu FP ± toleransi TIDAK boleh jadi BANK_ONLY/exception — data BRI &
// FP bisa berada di jam yang sama sekali tidak overlap, lihat dokumentasi).
// ─────────────────────────────────────────────────────────────────────────
function calculateBriCoverage(fpRows, bankRows, config = {}) {
  const scopeMode = config.scopeMode === 'FULL_BUSINESS_DATE' ? 'FULL_BUSINESS_DATE' : 'FP_COVERAGE_WINDOW';
  const toleranceMinutes = typeof config.coverageToleranceMinutes === 'number' && Number.isFinite(config.coverageToleranceMinutes)
    ? config.coverageToleranceMinutes : DEFAULT_COVERAGE_TOLERANCE_MINUTES;

  if (scopeMode === 'FULL_BUSINESS_DATE') {
    return { scopeMode, coverageStart: null, coverageEnd: null, toleranceMinutes };
  }

  const times = (fpRows || []).map(f => f.timeResponse).filter(t => t instanceof Date && !Number.isNaN(t.getTime()));
  if (!times.length) {
    return { scopeMode, coverageStart: null, coverageEnd: null, toleranceMinutes };
  }
  const minMs = Math.min(...times.map(t => t.getTime()));
  const maxMs = Math.max(...times.map(t => t.getTime()));
  return {
    scopeMode,
    coverageStart: new Date(minMs - toleranceMinutes * 60000),
    coverageEnd: new Date(maxMs + toleranceMinutes * 60000),
    toleranceMinutes,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Engine rekonsiliasi BRI — PURE FUNCTION
//
// bankRows item shape (SUDAH diklasifikasi oleh classifyBriRow() +
// parseBriTransactionTime() oleh caller sebelum dipanggil ke sini):
//   { norek, mutasiDebet, mutasiKredit, transactionDateTime, effectiveDateTime,
//     businessDate, extractedTransactionId, bankRowType, extractionMethod,
//     extractionConfidence, idConflict, deskTran, trremk, tlbds2 }
//
// fpRows item shape: { idTransaksi, nominal, idProduk, timeResponse (Date|null),
//   idOutlet, idBiller }
// ─────────────────────────────────────────────────────────────────────────
function reconcileBriTransactions(fpRows, bankRows, config = {}, now = new Date()) {
  const expectedFee = typeof config.expectedFee === 'number' && Number.isFinite(config.expectedFee) ? config.expectedFee : DEFAULT_FEE_BRI;
  const graceMinutes = typeof config.graceMinutes === 'number' && Number.isFinite(config.graceMinutes) ? config.graceMinutes : DEFAULT_GRACE_MINUTES;

  const coverage = calculateBriCoverage(fpRows, bankRows, config);

  // Group per canonical key = extracted_transaction_id — HANYA dari baris
  // yg sudah diklasifikasi DEBIT_TRANSFER/CREDIT_REVERSAL (row NEED_REVIEW/
  // OUT_OF_SCOPE/UNKNOWN TIDAK PERNAH jadi dasar matching/BANK_ONLY, hanya
  // disimpan mentah utk visibilitas Raw Data).
  const groups = new Map();
  const needReviewKeys = new Set();
  for (const b of bankRows) {
    if (b.bankRowType === 'NEED_REVIEW' && b.extractedTransactionId) {
      needReviewKeys.add(normalizeKey(b.extractedTransactionId));
    }
    if (b.bankRowType !== 'DEBIT_TRANSFER' && b.bankRowType !== 'CREDIT_REVERSAL') continue;
    const key = normalizeKey(b.extractedTransactionId);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        canonicalKey: key, rows: [], debitRows: [], creditRows: [],
        totalDebit: 0, totalCredit: 0, debitCount: 0, creditCount: 0,
        firstTransactionTime: null, lastTransactionTime: null, extractionMethods: new Set(),
      });
    }
    const g = groups.get(key);
    g.rows.push(b);
    if (b.bankRowType === 'DEBIT_TRANSFER') { g.debitRows.push(b); g.totalDebit += (typeof b.mutasiDebet === 'number' ? b.mutasiDebet : 0); g.debitCount++; }
    if (b.bankRowType === 'CREDIT_REVERSAL') { g.creditRows.push(b); g.totalCredit += (typeof b.mutasiKredit === 'number' ? b.mutasiKredit : 0); g.creditCount++; }
    if (b.extractionMethod) g.extractionMethods.add(b.extractionMethod);
    const t = b.transactionDateTime;
    if (t instanceof Date && !Number.isNaN(t.getTime())) {
      if (!g.firstTransactionTime || t.getTime() < g.firstTransactionTime.getTime()) g.firstTransactionTime = t;
      if (!g.lastTransactionTime || t.getTime() > g.lastTransactionTime.getTime()) g.lastTransactionTime = t;
    }
  }

  const consumedBankKeys = new Set();

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
    const fpTimeResponse = fp.timeResponse instanceof Date && !Number.isNaN(fp.timeResponse.getTime()) ? fp.timeResponse : null;
    const agingMinutes = fpTimeResponse ? Math.round((now.getTime() - fpTimeResponse.getTime()) / 60000) : null;

    const result = {
      idTransaksi, extractedTransactionId: null, idOutlet: fp.idOutlet || null, idProduk: fp.idProduk || null, idBiller: fp.idBiller || null,
      fpNominal: typeof fp.nominal === 'number' ? fp.nominal : null, fpTimeResponse, bankTransactionDate: null,
      bankGrossDebit: null, bankPrincipal: null, estimatedBankPrincipal: null, bankFee: null, bankCredit: null,
      variancePrincipal: null, varianceFee: null, timeDifferenceMinutes: null,
      matchingMethod: 'UNMATCHED', reconStatus: 'NEED_REVIEW', coverageStatus: 'IN_FP_COVERAGE',
      agingMinutes, notes: null, reversalDate: null, reversalAmount: null, reversalLookupSource: null,
    };

    if (isDuplicateFp) {
      result.reconStatus = 'DUPLICATE_FP';
      result.notes = `id_transaksi muncul ${fpCountById.get(idTransaksi)} kali di DATA FP.`;
      results.push(result);
      continue;
    }

    if (needReviewKeys.has(idTransaksi)) {
      result.reconStatus = 'NEED_REVIEW';
      result.notes = 'Ditemukan konflik ekstraksi ID pada mutasi BRI utk id_transaksi ini (DESK_TRAN/TRREMK/TLBDS2 tidak konsisten).';
      results.push(result);
      continue;
    }

    const group = groups.get(idTransaksi) || null;

    if (!group || !group.rows.length) {
      result.reconStatus = (agingMinutes !== null && agingMinutes < graceMinutes) ? 'PENDING_BANK' : 'FP_ONLY';
      results.push(result);
      continue;
    }

    // Tandai consumed SEGERA — sebelum cascade status ditentukan (sama
    // prinsip dgn fix insiden REVERSAL+BANK_ONLY double count di OCBC).
    consumedBankKeys.add(group.canonicalKey);

    result.extractedTransactionId = group.canonicalKey;
    result.bankTransactionDate = group.firstTransactionTime || null;
    result.matchingMethod = [...group.extractionMethods][0] || 'UNKNOWN';

    if (fpTimeResponse && result.bankTransactionDate) {
      result.timeDifferenceMinutes = Math.round((result.bankTransactionDate.getTime() - fpTimeResponse.getTime()) / 60000);
    }

    if (group.debitCount === 0) {
      result.reconStatus = 'NEED_REVIEW';
      result.notes = 'Ditemukan mutasi credit/reversal tapi tidak ada baris debit FASTPAY utk transaksi ini.';
    } else if (group.debitCount > 1) {
      result.reconStatus = 'DUPLICATE_BANK';
      result.bankGrossDebit = group.totalDebit;
      result.notes = `${group.debitCount} baris DEBIT_TRANSFER FASTPAY ditemukan utk id_transaksi yang sama (${idTransaksi}) — TIDAK dijumlahkan jadi MATCHED.`;
    } else {
      const grossDebit = group.debitRows[0].mutasiDebet;
      const fpNominal = result.fpNominal;
      result.bankGrossDebit = typeof grossDebit === 'number' ? grossDebit : null;

      if (fpNominal === null || typeof grossDebit !== 'number') {
        result.reconStatus = 'NEED_REVIEW';
        result.notes = 'Nominal FP atau gross debit BRI tidak tersedia utk dibandingkan.';
      } else if (grossDebit < fpNominal - NUM_EPS) {
        result.reconStatus = 'NOMINAL_MISMATCH';
        result.notes = `Gross debit BRI (Rp${grossDebit}) lebih kecil dari nominal FP (Rp${fpNominal}) — tidak masuk akal sbg principal+fee.`;
      } else {
        // Principal HANYA ditentukan SETELAH pasangan FP ditemukan — TIDAK
        // PERNAH dihitung sbg (gross debit - 150) sebelum ini (spec eksplisit).
        result.bankPrincipal = fpNominal;
        result.variancePrincipal = 0;
        const actualFee = grossDebit - fpNominal;
        if (numEq(grossDebit, fpNominal)) {
          result.reconStatus = 'MATCHED_NO_FEE';
          result.bankFee = 0;
        } else if (numEq(actualFee, expectedFee)) {
          result.reconStatus = 'MATCHED';
          result.bankFee = actualFee;
          result.varianceFee = actualFee - expectedFee;
        } else {
          result.reconStatus = 'FEE_MISMATCH';
          result.bankFee = actualFee;
          result.varianceFee = actualFee - expectedFee;
          result.notes = `Fee aktual Rp${actualFee} berbeda dari expected fee Rp${expectedFee}.`;
        }
      }
    }

    // Credit/reversal MENIMPA status di atas — sinyal reversal lebih kuat,
    // dan bank group ini TIDAK BOLEH lagi jadi BANK_ONLY (sudah consumed).
    if (group.creditCount > 0) {
      result.reconStatus = 'REVERSAL';
      result.bankCredit = group.totalCredit;
      result.reversalAmount = group.totalCredit;
      result.reversalDate = group.creditRows[0].transactionDateTime || null;
      result.reversalLookupSource = 'SAME_BATCH';
      result.notes = [result.notes, `Ditemukan ${group.creditCount} baris credit/reversal sebesar Rp${group.totalCredit}.`].filter(Boolean).join(' ');
    }

    results.push(result);
  }

  // BANK_ONLY — per GROUP, HANYA yang: belum consumed, punya >=1 DEBIT_TRANSFER
  // (bukan credit-only), dan berada DALAM coverage window.
  const fpIdSet = new Set(fpRows.map(f => normalizeKey(f.idTransaksi)).filter(Boolean));
  for (const group of groups.values()) {
    if (consumedBankKeys.has(group.canonicalKey)) continue;
    if (fpIdSet.has(group.canonicalKey)) continue;
    if (group.debitCount === 0) continue; // credit-only tanpa FP -> bukan kandidat berdiri sendiri

    let coverageStatus = 'IN_FP_COVERAGE';
    if (coverage.scopeMode === 'FP_COVERAGE_WINDOW' && coverage.coverageStart && coverage.coverageEnd) {
      const t = group.firstTransactionTime;
      if (t instanceof Date && !Number.isNaN(t.getTime())) {
        if (t.getTime() < coverage.coverageStart.getTime() || t.getTime() > coverage.coverageEnd.getTime()) {
          coverageStatus = 'OUTSIDE_FP_COVERAGE';
        }
      }
    }
    // OUTSIDE_FP_COVERAGE: TIDAK PERNAH jadi BANK_ONLY/exception — tetap
    // tampil di Raw Data saja (caller yang menyimpan raw bank row, bukan di sini).
    if (coverageStatus === 'OUTSIDE_FP_COVERAGE') continue;

    if (group.debitCount > 1) {
      results.push({
        idTransaksi: null, extractedTransactionId: group.canonicalKey, idOutlet: null, idProduk: null, idBiller: null,
        fpNominal: null, fpTimeResponse: null, bankTransactionDate: group.firstTransactionTime,
        bankGrossDebit: group.totalDebit, bankPrincipal: null, estimatedBankPrincipal: null,
        bankFee: null, bankCredit: group.creditCount ? group.totalCredit : null,
        variancePrincipal: null, varianceFee: null, timeDifferenceMinutes: null,
        matchingMethod: [...group.extractionMethods][0] || 'UNKNOWN',
        reconStatus: 'NEED_REVIEW', agingMinutes: null,
        notes: `${group.debitCount} baris DEBIT_TRANSFER ditemukan tanpa pasangan FP utk id_transaksi ${group.canonicalKey} — ambigu principal mana.`,
        coverageStatus, reversalDate: null, reversalAmount: null, reversalLookupSource: null,
      });
      continue;
    }

    // estimated_bank_principal = gross debit - expected fee — SELALU
    // ditandai ESTIMASI (bukan principal pasti), krn tidak ada FP nominal
    // sungguhan utk dibandingkan (spec eksplisit).
    const estimatedBankPrincipal = group.totalDebit - expectedFee;
    results.push({
      idTransaksi: null, extractedTransactionId: group.canonicalKey, idOutlet: null, idProduk: null, idBiller: null,
      fpNominal: null, fpTimeResponse: null, bankTransactionDate: group.firstTransactionTime,
      bankGrossDebit: group.totalDebit, bankPrincipal: null, estimatedBankPrincipal,
      bankFee: null, bankCredit: group.creditCount ? group.totalCredit : null,
      variancePrincipal: null, varianceFee: null, timeDifferenceMinutes: null,
      matchingMethod: [...group.extractionMethods][0] || 'UNKNOWN',
      reconStatus: 'BANK_ONLY', agingMinutes: null,
      notes: `Ditemukan mutasi FASTPAY (id_transaksi: ${group.canonicalKey}) tapi tidak ada di DATA FP. estimated_bank_principal = gross debit − expected fee (ESTIMASI, bukan principal pasti).`,
      coverageStatus, reversalDate: null, reversalAmount: null, reversalLookupSource: null,
    });
  }

  return { results, coverage };
}

/**
 * Reversal Cross-Date Lookup — TERPISAH dari reconcileBriTransactions()
 * (spec eksplisit meminta isolasi: fitur ini butuh data bank dari tanggal
 * LAIN, lebih berisiko drpd matching per-batch biasa). PURE function:
 * menerima `results` dari 1 batch (hasil reconcileBriTransactions) +
 * `futureCreditRowsByKey` (Map canonicalKey -> array baris CREDIT_REVERSAL
 * dari business_date+1 s.d. +reversalLookupDays, DISIAPKAN PEMANGGIL yang
 * query DB — fungsi ini sendiri TIDAK menyentuh DB).
 *
 * Kalau canonical key suatu result (apa pun statusnya SELAIN yang sudah
 * REVERSAL) ditemukan di future credit rows, result itu di-UPDATE (bukan
 * ditambah entry baru) jadi REVERSAL, reversal_date/reversal_amount/
 * reversal_lookup_source diisi. BANK_ONLY yang menjadi REVERSAL lewat jalur
 * ini TETAP row yang SAMA (canonical key sama) — tidak pernah membuat
 * BANK_ONLY duplikat pada tanggal reversal-nya sendiri (pemanggil yang
 * bertanggung jawab TIDAK memasukkan future credit rows itu sbg BANK_ONLY
 * candidate terpisah pada business_date-nya sendiri saat sync tanggal itu
 * berjalan nanti — cukup tandai consumed di sisi pemanggil).
 */
function applyBriReversalCrossDateLookup(results, futureCreditRowsByKey, config = {}) {
  const eligibleStatuses = ['FP_ONLY', 'BANK_ONLY', 'MATCHED', 'MATCHED_NO_FEE', 'FEE_MISMATCH', 'NOMINAL_MISMATCH', 'PENDING_BANK'];
  return results.map(r => {
    if (r.reconStatus === 'REVERSAL') return r;
    if (!eligibleStatuses.includes(r.reconStatus)) return r;
    const key = normalizeKey(r.extractedTransactionId || r.idTransaksi);
    if (!key) return r;
    const futureCredits = futureCreditRowsByKey.get(key);
    if (!futureCredits || !futureCredits.length) return r;

    const totalCredit = futureCredits.reduce((s, c) => s + (typeof c.mutasiKredit === 'number' ? c.mutasiKredit : 0), 0);
    const firstCredit = futureCredits[0];
    return {
      ...r,
      reconStatus: 'REVERSAL',
      bankCredit: totalCredit,
      reversalAmount: totalCredit,
      reversalDate: firstCredit.transactionDateTime || null,
      reversalLookupSource: 'CROSS_DATE_LOOKUP',
      notes: [r.notes, `Reversal ditemukan pada ${firstCredit.businessDate || 'tanggal lain'} (cross-date lookup, ${futureCredits.length} baris credit sebesar Rp${totalCredit}).`].filter(Boolean).join(' '),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Validasi saldo BRI — PER ROW (beda dari Mandiri yang PER URUTAN
// STATEMENT): SALDO_AWAL_MUTASI - MUTASI_DEBET + MUTASI_KREDIT harus sama
// dgn SALDO_AKHIR_MUTASI. Level batch, TIDAK PERNAH mengubah recon_status
// transaksi manapun — murni informatif.
// ─────────────────────────────────────────────────────────────────────────
function validateBriBalance(bankRows) {
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
// Fingerprint raw bank row — idempotensi sync (UNIQUE row_fingerprint).
// SENGAJA TIDAK memakai source row number (posisi bisa berubah). Description
// (DESK_TRAN) dinormalisasi (uppercase, buang non-alfanumerik selain '/')
// SEBELUM di-hash — pelajaran dari insiden nyata Rekonsiliasi OCBC: teks
// Description utk mutasi identik bisa berbeda tanda baca antar pembacaan
// sheet (mis. apostrof nama), memecah 1 mutasi jadi 2 fingerprint berbeda.
// ─────────────────────────────────────────────────────────────────────────
function normalizeForFingerprint(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}
function normalizeNumForFingerprint(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '';
}
function normalizeDescForFingerprint(value) {
  if (!value) return '';
  return String(value).toUpperCase().replace(/[^A-Z0-9/]/g, '');
}

function buildBriFingerprint(row) {
  const parts = [
    normalizeForFingerprint(row.bankCode || 'BRI').toUpperCase(),
    normalizeForFingerprint(row.norek),
    normalizeForFingerprint(row.tglTranNormalized),
    normalizeForFingerprint(row.tglEfektifNormalized),
    normalizeForFingerprint(row.seq),
    normalizeDescForFingerprint(row.deskTran),
    normalizeNumForFingerprint(row.mutasiDebet),
    normalizeNumForFingerprint(row.mutasiKredit),
    normalizeNumForFingerprint(row.saldoAkhirMutasi),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

module.exports = {
  extractBriTransactionIds,
  classifyBriRow,
  parseBriTransactionTime,
  normalizeJamTran,
  parseFlexibleBriDateTime,
  formatDateJakartaBri,
  calculateBriCoverage,
  reconcileBriTransactions,
  applyBriReversalCrossDateLookup,
  validateBriBalance,
  buildBriFingerprint,
  normalizeDescForFingerprint,
  numEq,
  DEFAULT_FEE_BRI,
  DEFAULT_GRACE_MINUTES,
  DEFAULT_COVERAGE_TOLERANCE_MINUTES,
  DEFAULT_REVERSAL_LOOKUP_DAYS,
};
