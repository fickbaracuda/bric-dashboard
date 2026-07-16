/**
 * Rekonsiliasi Mandiri — Adapter Bank Mandiri
 *
 * Bagian dari "Reconciliation Core Engine" bersama:
 *   backend/src/routes/warroom-reconciliation.js        (Core + Adapter OCBC)
 *   backend/src/routes/warroom-reconciliation-mandiri.js (route handler, pakai adapter ini)
 *
 * Beda mendasar dari OCBC: statement Mandiri TIDAK punya kolom Reference No.
 * yang langsung berisi id_transaksi FP — id_transaksi harus DIEKSTRAK dari
 * teks Remarks/AdditionalDesc (lihat extractMandiriRow()). Satu transaksi FP
 * biasanya menghasilkan 2 baris mutasi (principal + fee Rp100), kadang juga
 * baris credit/reversal.
 *
 * SEMUA fungsi di sini PURE (tidak menyentuh DB) supaya bisa di-unit-test
 * langsung — lihat backend/scripts/test-reconciliation-mandiri.js.
 */

const DEFAULT_FEE_MANDIRI = Number(process.env.RECON_MANDIRI_FEE_DEFAULT) || 100;
const DEFAULT_GRACE_MINUTES = Number(process.env.RECON_MANDIRI_GRACE_MINUTES) || 30;
const DEFAULT_COVERAGE_TOLERANCE_MINUTES = Number(process.env.RECON_MANDIRI_COVERAGE_TOLERANCE_MINUTES) || 60;
const NUM_EPS = 0.5; // toleransi pembulatan rupiah

function numEq(a, b) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < NUM_EPS;
}

// PURE — dipakai reconcileMandiriTransactions() SENDIRI (utk filter BANK_ONLY
// di luar window) DAN route handler (utk disimpan ke raw_summary.coverage,
// dibaca lagi oleh analyticsHandler tanpa perlu recompute). Satu formula,
// dua pemakai — supaya window yang ditampilkan di UI selalu identik dengan
// window yang benar-benar dipakai saat matching.
function computeMandiriCoverageWindow(fpRows, scopeMode, coverageToleranceMinutes) {
  if (scopeMode !== 'FP_COVERAGE_WINDOW') return { coverageStart: null, coverageEnd: null };
  const times = (fpRows || []).map(f => f.timeResponse).filter(t => t instanceof Date && !Number.isNaN(t.getTime()));
  if (!times.length) return { coverageStart: null, coverageEnd: null };
  return {
    coverageStart: new Date(Math.min(...times.map(t => t.getTime())) - coverageToleranceMinutes * 60000),
    coverageEnd: new Date(Math.max(...times.map(t => t.getTime())) + coverageToleranceMinutes * 60000),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// RULE A/B/C/D — ekstraksi id_transaksi dari 1 baris teks (Remarks ATAU
// AdditionalDesc). Baris dianggap FEE HANYA kalau teks (setelah trim) DIMULAI
// dengan "Transfer Fee" — baris principal Mandiri juga sering mengandung kata
// "Transfer Fee" di ekor deskripsi, jadi cek prefix, BUKAN "contains".
// ─────────────────────────────────────────────────────────────────────────
function tryExtractFromText(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^Transfer Fee/i.test(t)) {
    const m = /^Transfer Fee\s+(\d{8,12})\b/i.exec(t);
    return m ? { id: m[1], rowType: 'FEE' } : null;
  }
  const m = /\/(\d{8,12})\b/.exec(t);
  return m ? { id: m[1], rowType: 'PRINCIPAL' } : null;
}

/**
 * Remarks = sumber utama, AdditionalDesc = fallback HANYA kalau Remarks
 * kosong/tidak menghasilkan ID. Remarks & AdditionalDesc pada 1 baris sheet
 * sering berisi teks yang sama — di sini SELALU hanya 1 hasil per baris
 * (bukan 2), supaya 1 baris statement tidak pernah dihitung 2x transaksi.
 */
function extractMandiriRow(remarks, additionalDesc, creditAmount) {
  let extracted = tryExtractFromText(remarks);
  let source = 'REMARKS';
  if (!extracted) {
    extracted = tryExtractFromText(additionalDesc);
    source = 'ADDITIONAL_DESC';
  }
  if (!extracted) {
    return { extractedTransactionId: null, bankRowType: 'UNKNOWN', extractionMethod: 'NONE' };
  }
  // RULE C — Credit Amount > 0 menimpa klasifikasi FEE/PRINCIPAL dari teks:
  // baris credit/reversal bukan debit principal maupun fee transfer.
  let rowType = extracted.rowType;
  if (typeof creditAmount === 'number' && creditAmount > 0) rowType = 'CREDIT_REVERSAL';
  return {
    extractedTransactionId: extracted.id,
    bankRowType: rowType,
    extractionMethod: `${source}_${extracted.rowType}_PATTERN`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Engine rekonsiliasi Mandiri — PURE FUNCTION
//
// bankRows item shape: { accountNo, currency, postDate (Date|null), remarks,
//   additionalDesc, creditAmount, debitAmount, closeBalance, sourceRowNumber,
//   extractedTransactionId, bankRowType, extractionMethod }
// (extractedTransactionId/bankRowType/extractionMethod idealnya sudah
// dihitung oleh caller via extractMandiriRow() sebelum dipanggil ke sini,
// supaya raw row yang tersimpan di DB juga sudah membawa hasil ekstraksi.)
//
// fpRows item shape: { idTransaksi, nominal, idProduk, timeResponse (Date|null),
//   idOutlet, idBiller }
// ─────────────────────────────────────────────────────────────────────────
function reconcileMandiriTransactions(fpRows, bankRows, config = {}, now = new Date()) {
  const expectedFee = typeof config.expectedFee === 'number' && Number.isFinite(config.expectedFee) ? config.expectedFee : DEFAULT_FEE_MANDIRI;
  const graceMinutes = typeof config.graceMinutes === 'number' && Number.isFinite(config.graceMinutes) ? config.graceMinutes : DEFAULT_GRACE_MINUTES;
  const scopeMode = config.scopeMode === 'FULL_BUSINESS_DATE' ? 'FULL_BUSINESS_DATE' : 'FP_COVERAGE_WINDOW';
  const coverageToleranceMinutes = typeof config.coverageToleranceMinutes === 'number' && Number.isFinite(config.coverageToleranceMinutes)
    ? config.coverageToleranceMinutes : DEFAULT_COVERAGE_TOLERANCE_MINUTES;

  // Group bank rows by extracted_transaction_id (dalam 1 batch/account — lihat
  // catatan modul: grouping "resmi" per spec adalah batch_id+account_no+id,
  // batch_id sudah implisit (1 pemanggilan = 1 batch); account_no diasumsikan
  // seragam per sync (1 statement = 1 rekening), jadi index utama tetap by id
  // supaya lookup dari sisi FP (yang tidak punya account_no) tetap sederhana.
  const bankByExtractedId = new Map();
  for (const b of bankRows) {
    if (!b.extractedTransactionId) continue;
    if (!bankByExtractedId.has(b.extractedTransactionId)) bankByExtractedId.set(b.extractedTransactionId, []);
    bankByExtractedId.get(b.extractedTransactionId).push(b);
  }

  const fpCountById = new Map();
  for (const f of fpRows) {
    const id = String(f.idTransaksi || '').trim();
    if (!id) continue;
    fpCountById.set(id, (fpCountById.get(id) || 0) + 1);
  }

  const results = [];
  const processedIds = new Set();

  for (const fp of fpRows) {
    const idTransaksi = String(fp.idTransaksi || '').trim();
    if (!idTransaksi || processedIds.has(idTransaksi)) continue;
    processedIds.add(idTransaksi);

    const isDuplicateFp = (fpCountById.get(idTransaksi) || 0) > 1;

    const fpTimeResponse = fp.timeResponse instanceof Date && !Number.isNaN(fp.timeResponse.getTime()) ? fp.timeResponse : null;
    const agingMinutes = fpTimeResponse ? Math.round((now.getTime() - fpTimeResponse.getTime()) / 60000) : null;

    const result = {
      idTransaksi, referenceNo: null, idOutlet: fp.idOutlet || null, idProduk: fp.idProduk || null, idBiller: fp.idBiller || null,
      fpNominal: typeof fp.nominal === 'number' ? fp.nominal : null, fpTimeResponse, bankTransactionDate: null,
      bankPrincipal: null, bankFee: null, bankCredit: null, bankTotalDebit: null,
      variancePrincipal: null, varianceFee: null, timeDifferenceMinutes: null,
      matchingMethod: 'UNMATCHED', reconStatus: 'NEED_REVIEW', agingMinutes, notes: null,
    };

    if (isDuplicateFp) {
      result.reconStatus = 'DUPLICATE_FP';
      result.notes = `id_transaksi muncul ${fpCountById.get(idTransaksi)} kali di DATA FP.`;
      results.push(result);
      continue;
    }

    const group = bankByExtractedId.get(idTransaksi) || null;

    if (!group || !group.length) {
      result.reconStatus = (agingMinutes !== null && agingMinutes < graceMinutes) ? 'PENDING_BANK' : 'FP_ONLY';
      results.push(result);
      continue;
    }

    result.referenceNo = idTransaksi;
    result.bankTransactionDate = group[0].postDate || null;
    result.matchingMethod = (group[0].extractionMethod || '').startsWith('REMARKS')
      ? 'MANDIRI_REMARKS_EXACT' : 'MANDIRI_ADDITIONAL_DESC_FALLBACK';

    if (fpTimeResponse && result.bankTransactionDate) {
      const bankDate = result.bankTransactionDate instanceof Date ? result.bankTransactionDate : new Date(result.bankTransactionDate);
      if (!Number.isNaN(bankDate.getTime())) {
        result.timeDifferenceMinutes = Math.round((bankDate.getTime() - fpTimeResponse.getTime()) / 60000);
      }
    }

    const principalRows = group.filter(b => b.bankRowType === 'PRINCIPAL');
    const feeRows = group.filter(b => b.bankRowType === 'FEE');
    const creditRows = group.filter(b => b.bankRowType === 'CREDIT_REVERSAL');

    const totalDebit = group.reduce((s, b) => s + (typeof b.debitAmount === 'number' ? b.debitAmount : 0), 0);
    const totalCredit = creditRows.reduce((s, b) => s + (typeof b.creditAmount === 'number' ? b.creditAmount : 0), 0);
    result.bankTotalDebit = totalDebit > 0 ? totalDebit : null;
    result.bankCredit = creditRows.length ? totalCredit : null;

    if (principalRows.length === 0) {
      result.reconStatus = 'NEED_REVIEW';
      result.notes = feeRows.length > 0
        ? 'Hanya baris Transfer Fee yang ditemukan untuk id_transaksi ini, baris principal tidak ada.'
        : 'Group bank ditemukan tetapi tidak ada baris principal yang jelas (kemungkinan hanya credit/reversal).';
    } else if (principalRows.length > 1) {
      result.reconStatus = 'DUPLICATE_BANK';
      result.bankPrincipal = principalRows[0].debitAmount ?? null;
      result.notes = `${principalRows.length} baris principal ditemukan untuk id_transaksi yang sama (${idTransaksi}).`;
    } else {
      const principalRow = principalRows[0];
      result.bankPrincipal = typeof principalRow.debitAmount === 'number' ? principalRow.debitAmount : null;
      const fpNominal = result.fpNominal;
      const bankFeeTotal = feeRows.reduce((s, b) => s + (typeof b.debitAmount === 'number' ? b.debitAmount : 0), 0);
      result.bankFee = feeRows.length ? bankFeeTotal : 0;

      if (result.bankPrincipal !== null && fpNominal !== null) {
        result.variancePrincipal = result.bankPrincipal - fpNominal;
      }
      result.varianceFee = feeRows.length ? (bankFeeTotal - expectedFee) : null;

      if (fpNominal !== null && result.bankPrincipal !== null && !numEq(result.bankPrincipal, fpNominal)) {
        result.reconStatus = 'NOMINAL_MISMATCH';
        result.notes = `Principal Mandiri (Rp${result.bankPrincipal}) berbeda dengan nominal FP (Rp${fpNominal}).`;
      } else if (feeRows.length === 0) {
        result.reconStatus = 'MATCHED_NO_FEE';
      } else if (numEq(bankFeeTotal, expectedFee)) {
        result.reconStatus = 'MATCHED';
      } else {
        result.reconStatus = 'FEE_MISMATCH';
        result.notes = `Fee Mandiri Rp${bankFeeTotal} berbeda dari expected fee Rp${expectedFee}.`;
      }
    }

    // Credit/reversal MENIMPA status di atas — sinyal reversal lebih kuat.
    if (creditRows.length > 0) {
      result.reconStatus = 'REVERSAL';
      result.notes = [result.notes, `Ditemukan ${creditRows.length} baris credit/reversal sebesar Rp${totalCredit}.`].filter(Boolean).join(' ');
    }

    results.push(result);
  }

  // BANK_ONLY — hanya kandidat yang punya baris PRINCIPAL (transaksi nyata),
  // dan HANYA kalau berada dalam scope tanggal/coverage window yang dipilih.
  // Jangan otomatis menandai SEMUA mutasi Mandiri sebagai BANK_ONLY (instruksi
  // eksplisit) — banyak mutasi statement yang sama sekali tidak terkait FP
  // (transfer lain, biaya admin, dsb) tidak boleh membanjiri exception queue.
  const fpIdSet = new Set(fpRows.map(f => String(f.idTransaksi || '').trim()).filter(Boolean));

  const { coverageStart, coverageEnd } = computeMandiriCoverageWindow(fpRows, scopeMode, coverageToleranceMinutes);

  for (const [extractedId, group] of bankByExtractedId.entries()) {
    if (fpIdSet.has(extractedId)) continue;
    const principalRows = group.filter(b => b.bankRowType === 'PRINCIPAL');
    if (!principalRows.length) continue; // fee-only/credit-only/unknown group -> bukan kandidat transaksi berdiri sendiri

    if (scopeMode === 'FP_COVERAGE_WINDOW' && coverageStart && coverageEnd) {
      const postDate = group[0].postDate instanceof Date ? group[0].postDate : (group[0].postDate ? new Date(group[0].postDate) : null);
      if (postDate && !Number.isNaN(postDate.getTime())) {
        if (postDate.getTime() < coverageStart.getTime() || postDate.getTime() > coverageEnd.getTime()) continue; // di luar scope
      }
    }
    // FULL_BUSINESS_DATE: seluruh mutasi batch ini dianggap dalam scope, tidak difilter lagi.

    const feeRows = group.filter(b => b.bankRowType === 'FEE');
    const creditRows = group.filter(b => b.bankRowType === 'CREDIT_REVERSAL');
    const bankFeeTotal = feeRows.reduce((s, b) => s + (typeof b.debitAmount === 'number' ? b.debitAmount : 0), 0);
    const totalDebit = group.reduce((s, b) => s + (typeof b.debitAmount === 'number' ? b.debitAmount : 0), 0);
    const totalCredit = creditRows.reduce((s, b) => s + (typeof b.creditAmount === 'number' ? b.creditAmount : 0), 0);

    results.push({
      idTransaksi: null, referenceNo: extractedId, idOutlet: null, idProduk: null, idBiller: null,
      fpNominal: null, fpTimeResponse: null, bankTransactionDate: group[0].postDate || null,
      bankPrincipal: principalRows[0].debitAmount ?? null, bankFee: feeRows.length ? bankFeeTotal : null,
      bankCredit: creditRows.length ? totalCredit : null, bankTotalDebit: totalDebit > 0 ? totalDebit : null,
      variancePrincipal: null, varianceFee: null, timeDifferenceMinutes: null,
      matchingMethod: (group[0].extractionMethod || '').startsWith('REMARKS') ? 'MANDIRI_REMARKS_EXACT' : 'MANDIRI_ADDITIONAL_DESC_FALLBACK',
      reconStatus: 'BANK_ONLY', agingMinutes: null,
      notes: `Ditemukan di mutasi Mandiri (id_transaksi: ${extractedId}) tapi tidak ada di DATA FP.`,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────
// Validasi saldo (Close Balance) — level BATCH, tidak mengubah status
// transaksi individual manapun. Urutan statement bisa ascending (baris
// pertama = mutasi terlama) atau descending (baris pertama = mutasi
// terbaru) — deteksi otomatis dengan mencoba dua arah, pilih yang paling
// konsisten. Kalau tidak jelas -> BALANCE_CHECK_UNDETERMINED.
//
// bankRows di sini WAJIB item dengan sourceRowNumber, debitAmount,
// creditAmount, closeBalance (angka).
// ─────────────────────────────────────────────────────────────────────────
function validateMandiriBalance(bankRows) {
  const rows = bankRows
    .filter(r => typeof r.closeBalance === 'number' && Number.isFinite(r.sourceRowNumber))
    .sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);

  if (rows.length < 2) {
    return { status: 'BALANCE_CHECK_UNDETERMINED', direction: null, checked: 0, matched: 0, mismatch_count: 0, mismatches: [] };
  }

  function evaluate(direction) {
    const mismatches = [];
    let matched = 0, checked = 0;
    if (direction === 'ASC') {
      // baris teratas = mutasi terlama: balance[i] = balance[i-1] - debit[i] + credit[i]
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1], cur = rows[i];
        const expected = prev.closeBalance - (cur.debitAmount || 0) + (cur.creditAmount || 0);
        checked++;
        if (Math.abs(expected - cur.closeBalance) < 1) matched++;
        else mismatches.push({ source_row_number: cur.sourceRowNumber, expected, actual: cur.closeBalance });
      }
    } else {
      // baris teratas = mutasi terbaru: balance[i] = balance[i+1] - debit[i] + credit[i]
      for (let i = 0; i < rows.length - 1; i++) {
        const cur = rows[i], next = rows[i + 1];
        const expected = next.closeBalance - (cur.debitAmount || 0) + (cur.creditAmount || 0);
        checked++;
        if (Math.abs(expected - cur.closeBalance) < 1) matched++;
        else mismatches.push({ source_row_number: cur.sourceRowNumber, expected, actual: cur.closeBalance });
      }
    }
    return { matched, checked, mismatches };
  }

  const asc = evaluate('ASC');
  const desc = evaluate('DESC');
  const ascRatio = asc.checked ? asc.matched / asc.checked : 0;
  const descRatio = desc.checked ? desc.matched / desc.checked : 0;

  const direction = ascRatio >= descRatio ? 'ASC' : 'DESC';
  const best = direction === 'ASC' ? asc : desc;
  const ratio = best.checked ? best.matched / best.checked : 0;

  let status;
  if (ratio >= 0.95) status = 'BALANCED';
  else if (ratio >= 0.5) status = 'UNBALANCED';
  else status = 'BALANCE_CHECK_UNDETERMINED';

  return {
    status, direction, checked: best.checked, matched: best.matched,
    mismatch_count: best.mismatches.length, mismatches: best.mismatches.slice(0, 20),
  };
}

module.exports = {
  extractMandiriRow,
  tryExtractFromText,
  reconcileMandiriTransactions,
  validateMandiriBalance,
  computeMandiriCoverageWindow,
  numEq,
  DEFAULT_FEE_MANDIRI,
  DEFAULT_GRACE_MINUTES,
  DEFAULT_COVERAGE_TOLERANCE_MINUTES,
};
