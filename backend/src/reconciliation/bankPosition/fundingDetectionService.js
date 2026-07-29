'use strict';

const ocbcAdapter = require('./adapters/ocbcAdapter');

const ADAPTERS = { OCBC: ocbcAdapter };

/**
 * Mutasi kredit terkonfirmasi (funding & reversal, keduanya dikembalikan --
 * lihat is_reversal) dalam rentang [from, to]. Rilis ini: HANYA utk
 * visibilitas/audit -- TIDAK PERNAH dijumlahkan ke available_balance atau
 * formula apa pun (available_balance dari recon_sync_batches.raw_summary
 * SUDAH mencerminkan seluruh mutasi yang sudah posted).
 */
async function getConfirmedFundingMutations({ pool, bankCode, bankAccountId, from, to }) {
  const adapter = ADAPTERS[String(bankCode || '').toUpperCase()];
  if (!adapter) {
    return { available: false, mutations: [], reason: `Bank ${bankCode} belum didukung integrasi rekonsiliasi.` };
  }
  try {
    const mutations = await adapter.getFundingCandidates({ pool, bankAccountId, from, to });
    return { available: true, mutations };
  } catch (e) {
    console.error(`getConfirmedFundingMutations(${bankCode}) error:`, e.message);
    return { available: false, mutations: [], reason: 'Gagal membaca mutasi rekonsiliasi.' };
  }
}

/**
 * RILIS INI: SELALU 0 -- belum ada bank-mutation matching eksplisit yang
 * menghubungkan 1 baris bct_topup_requests TRANSFERRED ke 1 mutasi kredit
 * archive tertentu (lihat rencana implementasi, item 8: sengaja ditunda,
 * BUKAN bug). Signature generic tetap dipertahankan supaya penambahan
 * logic nanti bersifat additive, tidak mengubah pemanggil.
 */
async function getConfirmedIncomingNotYetReflected({ pool, bankCode, bankAccountId }) {
  return { total: 0, items: [] };
}

module.exports = { getConfirmedFundingMutations, getConfirmedIncomingNotYetReflected };
