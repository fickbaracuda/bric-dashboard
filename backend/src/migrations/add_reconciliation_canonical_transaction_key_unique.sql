-- Rekonsiliasi OCBC/Mandiri — unique index BARU berbasis canonical_transaction_key.
--
-- JANGAN jalankan sebelum backend/scripts/repair-reversal-bank-only-duplicates.js
-- --apply memastikan 0 baris duplicate (batch_id, canonical_transaction_key)
-- tersisa -- CREATE UNIQUE INDEX akan GAGAL kalau masih ada duplikat.
--
-- Menggantikan uq_recon_results_natural_key lama (batch_id, id_transaksi,
-- reference_no) yang membiarkan 1 transaksi logis (mis. REVERSAL +
-- BANK_ONLY utk Reference No. sama) tersimpan sbg 2 baris berbeda.
--
-- Idempotent: aman dijalankan ulang (DROP INDEX IF EXISTS / CREATE UNIQUE
-- INDEX IF NOT EXISTS).

DROP INDEX IF EXISTS uq_recon_results_natural_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_recon_results_canonical_key
  ON recon_results (batch_id, canonical_transaction_key);
