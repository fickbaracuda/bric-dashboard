-- Rekonsiliasi OCBC/Mandiri — canonical_transaction_key: fix bug 1 transaksi
-- logis menghasilkan 2 recon_results (mis. REVERSAL + BANK_ONLY utk
-- Reference No. yang sama).
--
-- Root cause: unique index lama (uq_recon_results_natural_key) pakai
-- (batch_id, COALESCE(id_transaksi,''), COALESCE(reference_no,'')). Utk 1
-- transaksi logis yang SAMA, baris FP-based (id_transaksi TERISI, mis. hasil
-- REVERSAL) dan baris BANK_ONLY (id_transaksi NULL, reference_no SAMA)
-- punya kombinasi (id_transaksi, reference_no) yang BERBEDA secara literal
-- -- dianggap 2 baris berbeda oleh index lama, padahal semestinya 1 hasil
-- akhir per transaksi.
--
-- Fix: kolom baru canonical_transaction_key = identitas TUNGGAL 1 transaksi
-- (id_transaksi kalau ada, else reference_no) dipakai sbg target unique
-- constraint BARU. HANYA menambah kolom + backfill di migration ini --
-- TIDAK langsung membuat unique index (baris duplikat existing, kalau ada,
-- harus dibersihkan dulu lewat backend/scripts/repair-reversal-bank-only-duplicates.js
-- --apply, BARU unique index dibuat lewat migration terpisah
-- add_reconciliation_canonical_transaction_key_unique.sql).
--
-- Idempotent: aman dijalankan ulang (ADD COLUMN IF NOT EXISTS, backfill
-- HANYA baris yang kolomnya masih NULL).

ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS canonical_transaction_key TEXT;

UPDATE recon_results
SET canonical_transaction_key = COALESCE(NULLIF(TRIM(id_transaksi), ''), NULLIF(TRIM(reference_no), ''))
WHERE canonical_transaction_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_recon_results_canonical_key ON recon_results(batch_id, canonical_transaction_key);
