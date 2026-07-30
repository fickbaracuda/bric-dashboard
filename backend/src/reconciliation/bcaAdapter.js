/**
 * Rekonsiliasi BCA — Adapter Bank BCA
 *
 * Bagian dari "Reconciliation Core Engine" bersama:
 *   backend/src/routes/warroom-reconciliation.js       (Core + Adapter OCBC)
 *   backend/src/routes/warroom-reconciliation-bca.js   (route handler, pakai adapter ini)
 *
 * MODUL BARU, TERPISAH dari OCBC/Mandiri/BRI/BRI BI-FAST/BNI — tidak
 * mengimpor adapter bank lain manapun, walau strukturnya mirip mandiriAdapter.js
 * (sama-sama: satu kolom Keterangan/Remarks berisi ID FP yang harus
 * diekstrak, satu kolom Saldo per baris).
 *
 * Sumber & temuan discovery (dibaca langsung dari spreadsheet BCA nyata,
 * 1BkHetxYcM4FzrZIljPER5QRzTHIjRffuQ15IdyZNe3k, sheet "Data FP" & "Data
 * Bank BCA", 2026-07-09):
 *   - Data FP: 457 baris, kolom id_transaksi/nominal/id_produk/time_response/
 *     id_outlet/id_biller. id_produk HANYA "BLTRFAG"/"BLTRFAGSC" di sample
 *     ini — TIDAK ADA kolom status/sukses terpisah (sama seperti bank lain:
 *     "FP sukses" = isValidIdTransaksi() saja, DATA FP memang sudah berisi
 *     transaksi sukses).
 *   - Data Bank BCA: 6 baris metadata (No. rekening/Nama/Periode/Kode Mata
 *     Uang) + header row 7 + 3033 baris mutasi (row 8-3040) + 4 baris footer
 *     ringkasan (Saldo Awal/Mutasi Debet/Mutasi Kredit/Saldo Akhir).
 *   - Keterangan format nyata (debit/principal):
 *       "TRSF E-BANKING DB 0807/FTSCY/WS95051 25000.00 FASTPAY 1300436630 /3553980633 LULUS BUDI SAMPURN"
 *     ID transaksi FP = angka SEGERA setelah SLASH TERAKHIR ("3553980633").
 *   - Keterangan format nyata (SATU-SATUNYA credit di sample, 3033 baris):
 *       "TRSF E-BANKING CR 0907/FTSCY/WS95051 7500000000.00 PB KE BCA API BIMASAKTI MULTI SI"
 *     TIDAK ADA token id_transaksi (tidak ada "/<digit> nama") — kredit
 *     internal (pemindahbukuan/funding), BUKAN transaksi FASTPAY. Credit
 *     TIDAK PERNAH dicoba diekstrak ID-nya / dicocokkan sbg debit FP.
 *   - Jumlah = TEKS gabungan "25,000.00 DB" / "7,500,000,000.00 CR" (bukan
 *     angka murni) — arah (DB/CR) WAJIB di-parse dari suffix teks ini.
 *   - Saldo = angka murni (NUMERIC), balance SETELAH baris tsb.
 *   - Urutan baris terverifikasi (dihitung manual dari data nyata):
 *     balance[i] = balance[i-1] - debit[i] + credit[i] cocok PERSIS ketika
 *     rows diurutkan ASCENDING (baris teratas = mutasi TERLAMA, baris bawah
 *     = TERBARU) — dikonfirmasi juga oleh footer "Saldo Awal" (= balance
 *     baris pertama dikurangi debit baris pertama) dan "Saldo Akhir" (=
 *     balance baris terakhir, PERSIS). TIDAK di-hardcode di sini —
 *     validateBcaBalance() tetap mendeteksi arah otomatis (ASC/DESC, sama
 *     pola dgn mandiriAdapter.js) supaya tidak mengasumsikan urutan tanpa
 *     verifikasi kalau format sheet berubah di kemudian hari.
 *   - Ditemukan JUGA varian ID 9-digit berprefix "947" (mis. "947219930")
 *     berdampingan dgn ID 10-digit berprefix "355" pada baris-baris yang
 *     bersebelahan (skema ID berbeda, BUKAN sekadar beda periode waktu).
 *     TIDAK ADA satупun dari ID "947..." maupun "355..." pada snapshot Data
 *     FP yang diperiksa (window Data FP hanya mencakup sebagian hari) — jadi
 *     TIDAK ADA bukti untuk memperlakukan "947..." secara khusus. Sesuai
 *     instruksi eksplisit: JANGAN menebak mapping sekunder — kalau ID hasil
 *     ekstraksi (skema apa pun) tidak ada di DATA FP, hasilnya transparan
 *     BANK_NOT_FOUND_IN_FP, bukan status/tebakan khusus.
 *
 * SEMUA fungsi di sini PURE (tidak menyentuh DB) supaya bisa di-unit-test
 * langsung — lihat backend/scripts/test-reconciliation-bca.js.
 */

const NUM_EPS = 0.5; // toleransi pembulatan rupiah

function numEq(a, b) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < NUM_EPS;
}

// ─────────────────────────────────────────────────────────────────────────
// Ekstraksi ID transaksi FP dari Keterangan BCA.
//
// Aturan: ambil token angka murni (6-13 digit) yang berada TEPAT setelah
// karakter "/" TERAKHIR dalam teks (bukan slash pertama — "0807/FTSCY/WS95051"
// juga mengandung slash, tapi tidak pernah diikuti angka murni pada seluruh
// sample nyata yang diperiksa). Menggunakan slash TERAKHIR (bukan slash
// pertama yang kebetulan berhasil di sample kecil) supaya lebih tahan
// terhadap variasi format yang belum pernah dilihat di discovery.
// ─────────────────────────────────────────────────────────────────────────
function extractBcaFpTransactionId(description) {
  const text = String(description || '').trim();
  if (!text) return null;
  const matches = [...text.matchAll(/\/(\d{6,13})\b/g)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1];
}

// ─────────────────────────────────────────────────────────────────────────
// Parsing "Jumlah" BCA — teks gabungan "25,000.00 DB" / "7,500,000,000.00 CR".
// TIDAK PERNAH pakai parseFloat/Number() langsung ke string ber-koma (koma =
// pemisah ribuan, bukan desimal, di format ini) — koma dibuang eksplisit
// SEBELUM parse angka, titik desimal dipertahankan.
// ─────────────────────────────────────────────────────────────────────────
function parseBcaAmountAndDirection(rawJumlah) {
  const text = String(rawJumlah || '').trim();
  if (!text) return { amount: null, direction: null, valid: false, reason: 'EMPTY' };

  const directionTokens = text.match(/\b(DB|CR)\b/gi) || [];
  if (directionTokens.length === 0) return { amount: null, direction: null, valid: false, reason: 'MISSING_DIRECTION' };
  if (directionTokens.length > 1) return { amount: null, direction: null, valid: false, reason: 'MULTIPLE_DIRECTION_TOKENS' };

  const m = /^([\d,]+\.\d{1,2})\s+(DB|CR)$/i.exec(text);
  if (!m) return { amount: null, direction: null, valid: false, reason: 'MALFORMED_AMOUNT' };

  const numeric = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(numeric) || numeric < 0) return { amount: null, direction: null, valid: false, reason: 'INVALID_AMOUNT' };

  return { amount: numeric, direction: m[2].toUpperCase(), valid: true, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────
// Klasifikasi kredit — HANYA dipanggil utk baris arah CR. Tidak pernah
// menyamakan semua kredit dengan FUNDING secara membabi-buta (instruksi
// eksplisit) — dicocokkan ke pola teks yang benar-benar teramati dulu,
// selain itu UNKNOWN_CREDIT.
// ─────────────────────────────────────────────────────────────────────────
function classifyBcaCreditType(description) {
  const text = String(description || '').toUpperCase();
  if (!text) return 'UNKNOWN_CREDIT';
  if (/\bPB KE BCA API\b/.test(text) || /\bPEMINDAHBUKUAN\b/.test(text)) return 'FUNDING';
  if (/\bREVERSAL\b/.test(text) || /\bREVERSE\b/.test(text)) return 'REVERSAL';
  if (/\bREFUND\b/.test(text)) return 'REFUND';
  if (/\bBUNGA\b/.test(text) || /\bINTEREST\b/.test(text)) return 'INTEREST';
  if (/\bADJUSTMENT\b/.test(text) || /\bKOREKSI\b/.test(text)) return 'ADJUSTMENT';
  if (/\bINTERNAL\b/.test(text)) return 'INTERNAL_TRANSFER';
  return 'UNKNOWN_CREDIT';
}

/**
 * Ekstraksi + klasifikasi 1 baris mutasi BCA — dipanggil sync handler
 * SEBELUM insert ke DB, supaya raw row yang tersimpan juga sudah membawa
 * hasil ekstraksi (pola sama dgn extractMandiriRow()).
 *
 * rawJumlah: teks asli kolom "Jumlah" ("25,000.00 DB").
 * description: teks asli kolom "Keterangan".
 */
function parseBcaBankRow(description, rawJumlah) {
  const { amount, direction, valid, reason } = parseBcaAmountAndDirection(rawJumlah);

  if (!valid) {
    return {
      debit: null, credit: null, direction: null,
      extractedTransactionId: null, bankRowType: 'UNKNOWN', extractionMethod: 'NONE',
      creditClassification: null, parseWarning: reason,
    };
  }

  if (direction === 'CR') {
    return {
      debit: 0, credit: amount, direction: 'CR',
      extractedTransactionId: null, bankRowType: 'CREDIT', extractionMethod: 'NONE',
      creditClassification: classifyBcaCreditType(description), parseWarning: null,
    };
  }

  // DB — coba ekstrak ID FP dari Keterangan.
  const extractedId = extractBcaFpTransactionId(description);
  return {
    debit: amount, credit: 0, direction: 'DB',
    extractedTransactionId: extractedId,
    bankRowType: extractedId ? 'PRINCIPAL' : 'UNKNOWN',
    extractionMethod: extractedId ? 'LAST_SLASH_DIGIT_PATTERN' : 'NONE',
    creditClassification: null,
    parseWarning: extractedId ? null : 'UNPARSEABLE_REFERENCE',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Engine rekonsiliasi BCA — PURE FUNCTION.
//
// bankRows item shape: { transactionDate (Date|string|null), description,
//   debit, credit, direction, balance, sourceRowNumber, extractedTransactionId,
//   bankRowType, extractionMethod, creditClassification }
//
// fpRows item shape: { idTransaksi, nominal, idProduk, timeResponse (Date|null),
//   idOutlet, idBiller }
//
// Status yang dipakai (lihat BCA_STATUSES di warroom-reconciliation-bca.js,
// SUDAH ditambahkan ke RECON_STATUSES/EXCEPTION_STATUSES bersama supaya
// agregasi/resolve/export generik tetap bisa dipakai apa adanya):
//   MATCHED, FP_NOT_FOUND_IN_BANK, BANK_NOT_FOUND_IN_FP, AMOUNT_MISMATCH,
//   DUPLICATE_FP_TRANSACTION_ID, DUPLICATE_BANK_TRANSACTION_ID,
//   CREDIT_TRANSACTION, UNPARSEABLE_REFERENCE, UNKNOWN.
// (MATCHED_AMOUNT_EXACT, MULTIPLE_BANK_ROWS_SAME_ID, REVERSAL,
// REQUIRES_MAPPING_REVIEW tersedia di daftar status utk override manual /
// dipakai kalau pola datanya ditemukan di kemudian hari — lihat catatan di
// warroom-reconciliation-bca.js.)
// ─────────────────────────────────────────────────────────────────────────
function reconcileBcaTransactions(fpRows, bankRows, config = {}, now = new Date()) {
  const graceMinutes = typeof config.graceMinutes === 'number' && Number.isFinite(config.graceMinutes) ? config.graceMinutes : 0;

  // Group baris bank DEBIT ber-ID valid, by extractedTransactionId.
  const bankByExtractedId = new Map();
  for (const b of bankRows) {
    if (b.direction !== 'DB' || !b.extractedTransactionId) continue;
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
  const processedFpIds = new Set();

  for (const fp of fpRows) {
    const idTransaksi = String(fp.idTransaksi || '').trim();
    if (!idTransaksi || processedFpIds.has(idTransaksi)) continue;
    processedFpIds.add(idTransaksi);

    const isDuplicateFp = (fpCountById.get(idTransaksi) || 0) > 1;
    const fpTimeResponse = fp.timeResponse instanceof Date && !Number.isNaN(fp.timeResponse.getTime()) ? fp.timeResponse : null;
    const agingMinutes = fpTimeResponse ? Math.round((now.getTime() - fpTimeResponse.getTime()) / 60000) : null;

    const result = {
      idTransaksi, referenceNo: null, idOutlet: fp.idOutlet || null, idProduk: fp.idProduk || null, idBiller: fp.idBiller || null,
      fpNominal: typeof fp.nominal === 'number' ? fp.nominal : null, fpTimeResponse, bankTransactionDate: null,
      bankPrincipal: null, bankFee: 0, bankCredit: null, bankTotalDebit: null,
      variancePrincipal: null, varianceFee: null, timeDifferenceMinutes: null,
      matchingMethod: 'UNMATCHED', reconStatus: 'UNKNOWN', agingMinutes, notes: null,
    };

    if (isDuplicateFp) {
      result.reconStatus = 'DUPLICATE_FP_TRANSACTION_ID';
      result.notes = `id_transaksi muncul ${fpCountById.get(idTransaksi)} kali di DATA FP.`;
      results.push(result);
      continue;
    }

    const group = bankByExtractedId.get(idTransaksi) || null;
    if (!group || !group.length) {
      result.reconStatus = (agingMinutes !== null && graceMinutes > 0 && agingMinutes < graceMinutes) ? 'FP_NOT_FOUND_IN_BANK' : 'FP_NOT_FOUND_IN_BANK';
      results.push(result);
      continue;
    }

    result.referenceNo = idTransaksi;
    result.bankTransactionDate = group[0].transactionDate || null;
    result.matchingMethod = 'BCA_KETERANGAN_LAST_SLASH_DIGIT';
    result.bankTotalDebit = group.reduce((s, b) => s + (typeof b.debit === 'number' ? b.debit : 0), 0);

    if (fpTimeResponse && result.bankTransactionDate) {
      const bankDate = result.bankTransactionDate instanceof Date ? result.bankTransactionDate : new Date(result.bankTransactionDate);
      if (!Number.isNaN(bankDate.getTime())) {
        result.timeDifferenceMinutes = Math.round((bankDate.getTime() - fpTimeResponse.getTime()) / 60000);
      }
    }

    if (group.length > 1) {
      result.reconStatus = 'DUPLICATE_BANK_TRANSACTION_ID';
      result.bankPrincipal = group[0].debit ?? null;
      result.notes = `${group.length} baris mutasi BCA memakai id_transaksi hasil ekstraksi yang sama (${idTransaksi}).`;
      results.push(result);
      continue;
    }

    const bankRow = group[0];
    result.bankPrincipal = typeof bankRow.debit === 'number' ? bankRow.debit : null;
    const fpNominal = result.fpNominal;
    if (result.bankPrincipal !== null && fpNominal !== null) {
      result.variancePrincipal = result.bankPrincipal - fpNominal;
    }

    if (fpNominal !== null && result.bankPrincipal !== null && numEq(result.bankPrincipal, fpNominal)) {
      result.reconStatus = 'MATCHED';
    } else {
      result.reconStatus = 'AMOUNT_MISMATCH';
      result.notes = `Debit BCA (Rp${result.bankPrincipal}) berbeda dengan nominal FP (Rp${fpNominal}).`;
    }

    results.push(result);
  }

  const fpIdSet = new Set(fpRows.map(f => String(f.idTransaksi || '').trim()).filter(Boolean));

  // BANK_NOT_FOUND_IN_FP — kandidat debit ber-ID yang tidak ada di DATA FP.
  for (const [extractedId, group] of bankByExtractedId.entries()) {
    if (fpIdSet.has(extractedId)) continue;
    results.push({
      idTransaksi: null, referenceNo: extractedId, idOutlet: null, idProduk: null, idBiller: null,
      fpNominal: null, fpTimeResponse: null, bankTransactionDate: group[0].transactionDate || null,
      bankPrincipal: group[0].debit ?? null, bankFee: 0, bankCredit: null,
      bankTotalDebit: group.reduce((s, b) => s + (typeof b.debit === 'number' ? b.debit : 0), 0),
      variancePrincipal: null, varianceFee: null, timeDifferenceMinutes: null,
      matchingMethod: 'BCA_KETERANGAN_LAST_SLASH_DIGIT',
      reconStatus: group.length > 1 ? 'DUPLICATE_BANK_TRANSACTION_ID' : 'BANK_NOT_FOUND_IN_FP',
      agingMinutes: null, notes: `Ditemukan di mutasi BCA (id hasil ekstraksi: ${extractedId}) tapi tidak ada di DATA FP.`,
    });
  }

  // UNPARSEABLE_REFERENCE — baris debit yang Keterangan-nya tidak
  // menghasilkan ID sama sekali (tetap ditampilkan utk review, TIDAK dibuang).
  for (const b of bankRows) {
    if (b.direction !== 'DB' || b.extractedTransactionId) continue;
    results.push({
      idTransaksi: null, referenceNo: null, idOutlet: null, idProduk: null, idBiller: null,
      fpNominal: null, fpTimeResponse: null, bankTransactionDate: b.transactionDate || null,
      bankPrincipal: b.debit ?? null, bankFee: 0, bankCredit: null, bankTotalDebit: b.debit ?? null,
      variancePrincipal: null, varianceFee: null, timeDifferenceMinutes: null,
      matchingMethod: 'NONE', reconStatus: 'UNPARSEABLE_REFERENCE', agingMinutes: null,
      notes: 'Keterangan BCA tidak menghasilkan id_transaksi FP (tidak ada pola "/<digit> nama") — perlu review manual.',
      sourceRowNumber: b.sourceRowNumber,
    });
  }

  // CREDIT_TRANSACTION — seluruh baris kredit, TIDAK PERNAH dicocokkan sbg
  // debit FP. credit_classification disimpan di notes (bukan kolom baru).
  for (const b of bankRows) {
    if (b.direction !== 'CR') continue;
    results.push({
      idTransaksi: null, referenceNo: null, idOutlet: null, idProduk: null, idBiller: null,
      fpNominal: null, fpTimeResponse: null, bankTransactionDate: b.transactionDate || null,
      bankPrincipal: null, bankFee: 0, bankCredit: b.credit ?? null, bankTotalDebit: null,
      variancePrincipal: null, varianceFee: null, timeDifferenceMinutes: null,
      matchingMethod: 'NONE', reconStatus: 'CREDIT_TRANSACTION', agingMinutes: null,
      notes: `Kredit BCA (klasifikasi: ${b.creditClassification || 'UNKNOWN_CREDIT'}).`,
      sourceRowNumber: b.sourceRowNumber,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────
// Validasi kontinuitas saldo (section 17 spec) — level BATCH, TIDAK PERNAH
// mengubah recon_status transaksi individual manapun (concern terpisah dari
// matching FP). Urutan statement bisa ASC (baris pertama = mutasi TERLAMA)
// atau DESC — dideteksi otomatis (bukan diasumsikan), pola sama dgn
// mandiriAdapter.js. Status pakai penamaan sesuai spec BCA (BERBEDA dari
// nama status Mandiri BALANCED/UNBALANCED) — TIDAK disimpan sbg kolom DB,
// hanya di raw_summary.balance_continuity (JSONB), sama pola dgn
// raw_summary.balance_validation Mandiri.
// ─────────────────────────────────────────────────────────────────────────
function validateBcaBalance(bankRows) {
  const rows = bankRows
    .filter(r => typeof r.balance === 'number' && Number.isFinite(r.sourceRowNumber))
    .sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);

  if (rows.length < 2) {
    return { status: 'INSUFFICIENT_DATA', direction: null, checked: 0, matched: 0, mismatch_count: 0, mismatches: [] };
  }

  function evaluate(direction) {
    const mismatches = [];
    let matched = 0, checked = 0;
    if (direction === 'ASC') {
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1], cur = rows[i];
        const expected = prev.balance - (cur.debit || 0) + (cur.credit || 0);
        checked++;
        if (Math.abs(expected - cur.balance) < 1) matched++;
        else mismatches.push({ source_row_number: cur.sourceRowNumber, expected, actual: cur.balance, previous_balance: prev.balance, debit: cur.debit || 0, credit: cur.credit || 0 });
      }
    } else {
      for (let i = 0; i < rows.length - 1; i++) {
        const cur = rows[i], next = rows[i + 1];
        const expected = next.balance - (cur.debit || 0) + (cur.credit || 0);
        checked++;
        if (Math.abs(expected - cur.balance) < 1) matched++;
        else mismatches.push({ source_row_number: cur.sourceRowNumber, expected, actual: cur.balance, previous_balance: next.balance, debit: cur.debit || 0, credit: cur.credit || 0 });
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
  if (ratio >= 0.95) status = 'BALANCE_CONTINUITY_OK';
  else if (ratio >= 0.5) status = 'BALANCE_CONTINUITY_MISMATCH';
  else status = 'ORDERING_UNCERTAIN';

  // currentBalance: baris TERBARU menurut arah yang terdeteksi (ASC -> baris
  // sourceRowNumber terbesar, DESC -> baris sourceRowNumber terkecil).
  const latestRow = direction === 'ASC' ? rows[rows.length - 1] : rows[0];

  return {
    status, direction, checked: best.checked, matched: best.matched,
    mismatch_count: best.mismatches.length, mismatches: best.mismatches.slice(0, 20),
    latest_balance_from_order: latestRow.balance, latest_source_row_number: latestRow.sourceRowNumber,
  };
}

module.exports = {
  extractBcaFpTransactionId,
  parseBcaAmountAndDirection,
  classifyBcaCreditType,
  parseBcaBankRow,
  reconcileBcaTransactions,
  validateBcaBalance,
  numEq,
};
