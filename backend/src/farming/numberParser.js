'use strict';

/**
 * Parser angka aman untuk Farming Command Center. WAJIB cek `typeof v ===
 * 'number'` DULU sebelum string processing — insiden Speedcash 100x (lihat
 * CLAUDE.md §5) terjadi karena titik desimal ikut terhapus saat treat number
 * sebagai string. Titik/koma dianggap pemisah RIBUAN (bukan desimal),
 * konsisten dengan semua parser BRIC lain (Ekspedisi Produk, Payment Agent
 * Produk). Angka dalam tanda kurung dianggap negatif.
 */

const FORMULA_ERRORS = ['#NAME?', '#DIV/0!', '#VALUE!', '#N/A', '#REF!', '#NULL!', '#NUM!'];

function isFormulaError(value) {
  if (value === null || value === undefined) return false;
  return FORMULA_ERRORS.includes(String(value).trim().toUpperCase());
}

function safeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let raw = String(value).trim();
  if (raw === '' || raw === '-') return null;
  if (isFormulaError(raw)) return null;

  let negative = false;
  const parenMatch = /^\((.*)\)$/.exec(raw);
  if (parenMatch) { negative = true; raw = parenMatch[1]; }

  let cleaned = raw.replace(/rp/gi, '').trim();
  cleaned = cleaned.replace(/[.,]/g, '');
  cleaned = cleaned.replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;

  let n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (negative) n = -Math.abs(n);
  return n;
}

/** Pembagian aman — tidak pernah mengembalikan Infinity/NaN, null kalau tidak valid. */
function safeDiv(numerator, denominator) {
  if (typeof numerator !== 'number' || !Number.isFinite(numerator)) return null;
  if (typeof denominator !== 'number' || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function safePctChange(current, previous) {
  if (typeof current !== 'number' || !Number.isFinite(current)) return null;
  if (typeof previous !== 'number' || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null; // tidak bisa hitung % dari basis nol
  return (current - previous) / previous;
}

module.exports = { safeNumber, safeDiv, safePctChange, isFormulaError, FORMULA_ERRORS };
