'use strict';

const ocbcAdapter = require('./adapters/ocbcAdapter');

// Registry -- bank_code -> adapter. Mandiri/BRI/BNI belum diimplementasi;
// dispatch di bawah gagal AMAN (available:false), tidak pernah throw.
const ADAPTERS = { OCBC: ocbcAdapter };

function isSupportedBank(bankCode) {
  return !!ADAPTERS[String(bankCode || '').toUpperCase()];
}

/**
 * Posisi saldo terverifikasi terbaru dari mesin rekonsiliasi bank tsb.
 * Generic -- caller (Balance Control Tower) TIDAK PERNAH tahu/peduli
 * struktur tabel per-bank, hanya konsumsi shape ternormalisasi ini.
 */
async function getLatestVerifiedBankPosition({ pool, bankCode, bankAccountId, businessDate }) {
  const adapter = ADAPTERS[String(bankCode || '').toUpperCase()];
  if (!adapter) {
    return { available: false, reason: `Bank ${bankCode} belum didukung integrasi rekonsiliasi Balance Control Tower.` };
  }
  try {
    const position = await adapter.getLatestVerifiedPosition({ pool, bankAccountId, businessDate });
    if (!position) {
      return { available: false, reason: `Belum ada batch rekonsiliasi ${bankCode} yang sukses.` };
    }
    return { available: true, position };
  } catch (e) {
    console.error(`getLatestVerifiedBankPosition(${bankCode}) error:`, e.message);
    return { available: false, reason: 'Gagal membaca posisi rekonsiliasi.' };
  }
}

module.exports = { getLatestVerifiedBankPosition, isSupportedBank, ADAPTERS };
