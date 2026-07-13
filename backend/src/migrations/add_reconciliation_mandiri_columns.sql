-- Rekonsiliasi Mandiri — perluasan GENERIC atas tabel recon_* yang sudah
-- dipakai Rekonsiliasi OCBC (backend/src/migrations/create_reconciliation_ocbc.sql).
-- TIDAK membuat tabel baru (recon_mandiri_results dsb) — bank dibedakan via
-- kolom bank_code = 'MANDIRI' pada recon_sync_batches (sudah ada & default 'OCBC').
--
-- Kolom baru di sini SEMUA nullable / punya default aman, jadi baris OCBC
-- yang sudah ada tidak berubah perilakunya (backward compatible).
-- Idempotent: aman dijalankan ulang.

-- recon_sync_batches: konfigurasi per-batch (account, scope mode, expected
-- fee, grace period) supaya bisa diaudit/ditampilkan ulang tanpa
-- bergantung pada payload sync yang sudah lewat.
ALTER TABLE recon_sync_batches ADD COLUMN IF NOT EXISTS account_no           TEXT;
ALTER TABLE recon_sync_batches ADD COLUMN IF NOT EXISTS scope_mode           TEXT;
ALTER TABLE recon_sync_batches ADD COLUMN IF NOT EXISTS expected_fee         NUMERIC;
ALTER TABLE recon_sync_batches ADD COLUMN IF NOT EXISTS grace_period_minutes INTEGER;

-- recon_bank_transactions: kolom khusus statement Mandiri (AccountNo, Ccy,
-- Close Balance) + hasil ekstraksi ID transaksi dari Remarks/AdditionalDesc
-- (Mandiri tidak punya kolom Reference No. yang langsung berisi id_transaksi
-- seperti OCBC — lihat backend/src/reconciliation/mandiriAdapter.js).
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS account_no               TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS currency                 TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS additional_desc          TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS close_balance            NUMERIC;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS extracted_transaction_id TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS bank_row_type            TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS extraction_method        TEXT;
-- post_date_time: PostDate Mandiri PUNYA jam-menit-detik (bukan cuma
-- tanggal seperti transaction_date/value_date OCBC) — perlu presisi penuh
-- utk selisih waktu FP vs posting bank (menit) & deteksi arah urutan
-- statement (validasi saldo). Simpan sbg TIMESTAMPTZ (bukan DATE) supaya
-- tidak kena masalah geser hari seperti kolom DATE (lihat toIsoDate() di
-- warroom-reconciliation.js) — TIMESTAMPTZ membawa instant lengkap.
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS post_date_time           TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_recon_bank_extracted_id ON recon_bank_transactions(extracted_transaction_id);

-- recon_results: simpan juga bank_code (redundant dgn join batch, tapi
-- memudahkan filter langsung tanpa join saat query besar) + waktu selisih
-- FP vs posting bank dalam menit (dipakai tab Time & Posting Analysis
-- Mandiri; opsional/berguna juga utk OCBC ke depannya).
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS bank_code                TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS time_difference_minutes  INTEGER;

CREATE INDEX IF NOT EXISTS idx_recon_results_bank_code ON recon_results(bank_code);
