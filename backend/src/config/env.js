/**
 * backend/src/config/env.js
 *
 * PART 2A — SIAPAN SAJA, BELUM DIPAKAI OLEH auth.js / middleware/auth.js.
 *
 * File ini adalah "helper" (alat bantu) untuk membaca environment variable
 * penting secara rapi dan seragam, supaya nanti (Part 2B) auth.js dan
 * middleware/auth.js bisa dipindah ke sini secara bertahap, TANPA membuat
 * production tiba-tiba crash kalau environment variable belum lengkap.
 *
 * KENAPA BELUM DIPAKAI SEKARANG:
 * Kode asli di auth.js dan middleware/auth.js saat ini masih begini:
 *   const JWT_SECRET = process.env.JWT_SECRET || 'bric-jwt-secret-2026';
 * Kalau kita langsung hapus fallback ('bric-jwt-secret-2026') itu SEKARANG,
 * dan ternyata server production belum punya JWT_SECRET di file .env-nya,
 * maka begitu kode baru di-deploy, SEMUA orang yang sedang login akan
 * otomatis logout (token lama jadi tidak valid), atau lebih parah lagi
 * server bisa gagal jalan sama sekali. Supaya itu tidak terjadi, langkah
 * penggantian dipisah jadi 2 tahap:
 *   Part 2A (sekarang): siapkan helper ini, JANGAN diimpor kemana-mana dulu.
 *   Part 2B (nanti)   : setelah dipastikan JWT_SECRET sudah di-set benar
 *                       di server production (lewat preflight check),
 *                       baru auth.js/middleware/auth.js diarahkan ke sini.
 */

'use strict';

/**
 * Nilai ini SENGAJA dinamai panjang & jelas supaya tidak mungkin
 * ke-copy-paste ke production tanpa disadari. Nilai ini TIDAK PERNAH
 * dipakai kalau environment variable JWT_SECRET sudah di-set dengan benar.
 */
const DEV_ONLY_INSECURE_JWT_SECRET_DO_NOT_USE_IN_PRODUCTION =
  'dev-local-only-secret-jangan-dipakai-di-server-sungguhan';

/**
 * Apakah kode ini sedang jalan di mode production?
 * Standar Node.js: cek process.env.NODE_ENV === 'production'.
 *
 * CATATAN PENTING: saat file ini dibuat (Part 2A), backend BRIC belum
 * pernah men-set NODE_ENV di manapun (sudah dicek, tidak ada). Artinya,
 * kalau helper ini nanti dipakai (Part 2B) TANPA server production
 * di-set NODE_ENV=production dulu, fungsi assertProductionReady() di bawah
 * TIDAK akan pernah mendeteksi "ini production" dan pengecekan wajibnya
 * tidak akan aktif. Ini harus dibereskan dulu sebelum Part 2B (akan
 * dijelaskan juga di docs/DEPLOYMENT_SAFETY.md).
 */
function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * Ambil JWT_SECRET dengan aturan:
 * - Kalau JWT_SECRET di environment ADA -> pakai itu (selalu, di mode apapun).
 * - Kalau TIDAK ADA dan sedang production -> lempar error yang jelas
 *   (sengaja dibuat gagal total, daripada diam-diam pakai kunci yang
 *   semua orang bisa lihat di kode).
 * - Kalau TIDAK ADA dan BUKAN production (development lokal) -> boleh
 *   pakai kunci dummy khusus lokal di atas, sambil kasih peringatan di log.
 *
 * @returns {string} JWT secret yang siap dipakai
 * @throws {Error} kalau production tapi JWT_SECRET belum di-set
 */
function getJwtSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) return fromEnv;

  if (isProduction()) {
    throw new Error(
      'JWT_SECRET belum di-set di environment production. ' +
      'Set environment variable JWT_SECRET dulu sebelum menjalankan backend ' +
      'di mode production (lihat backend/.env.example).'
    );
  }

  console.warn(
    '[env.js] PERINGATAN: JWT_SECRET tidak ditemukan di environment. ' +
    'Memakai kunci dummy KHUSUS LOKAL (tidak aman untuk production).'
  );
  return DEV_ONLY_INSECURE_JWT_SECRET_DO_NOT_USE_IN_PRODUCTION;
}

/**
 * Cek apakah semua environment variable "wajib" sudah tersedia.
 * Dipakai oleh preflight check (backend/scripts/preflight-check.js),
 * BUKAN dijalankan otomatis saat backend start (supaya tidak mengubah
 * perilaku start backend yang sudah berjalan sekarang).
 *
 * @param {string[]} requiredKeys - daftar nama environment variable wajib
 * @returns {{ok: boolean, missing: string[]}}
 */
function checkRequiredEnv(requiredKeys) {
  const missing = requiredKeys.filter((key) => !process.env[key]);
  return { ok: missing.length === 0, missing };
}

/**
 * Sensor nilai secret supaya aman ditampilkan di log/laporan.
 * Contoh: maskSecret('contoh-nilai-rahasia') -> 'cont****ahsia'
 */
function maskSecret(value) {
  if (!value) return '(kosong)';
  const str = String(value);
  if (str.length <= 6) return '*'.repeat(str.length);
  return `${str.slice(0, 4)}${'*'.repeat(Math.max(str.length - 8, 4))}${str.slice(-4)}`;
}

module.exports = {
  isProduction,
  getJwtSecret,
  checkRequiredEnv,
  maskSecret,
  DEV_ONLY_INSECURE_JWT_SECRET_DO_NOT_USE_IN_PRODUCTION,
};
