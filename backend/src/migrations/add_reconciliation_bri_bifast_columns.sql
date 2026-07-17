-- Rekonsiliasi BRI BI-FAST — perluasan GENERIC atas tabel recon_* yang sudah
-- dipakai Rekonsiliasi OCBC/Mandiri/BRI existing. TIDAK membuat tabel baru
-- (mis. bri_bifast_recon_results) — bank dibedakan via kolom bank_code =
-- 'BRI_BIFAST' pada recon_sync_batches (kolom bank_code sudah ada, default
-- 'OCBC').
--
-- Kolom baru di sini SEMUA nullable/berdefault aman, jadi baris OCBC/
-- Mandiri/BRI existing yang sudah ada TIDAK berubah perilakunya (backward
-- compatible). Idempotent: aman dijalankan ulang. TIDAK mengubah tipe kolom
-- manapun yang sudah ada (mis. reversal_date/reversal_amount/
-- reversal_lookup_source sudah ada dari migration BRI existing, dipakai
-- bersama di sini apa adanya).

-- ── recon_sync_batches: config tambahan khusus BRI BI-FAST. account_no,
-- scope_mode, expected_fee, grace_period_minutes, coverage_tolerance_minutes,
-- reversal_lookup_days SUDAH ADA (migration Mandiri/BRI existing), dipakai
-- bersama. bank_posting_before/after_fp_tolerance_minutes &
-- mismatch_time_tolerance_minutes BELUM ADA di bank manapun — baru.
ALTER TABLE recon_sync_batches ADD COLUMN IF NOT EXISTS bank_posting_before_fp_tolerance_minutes INTEGER;
ALTER TABLE recon_sync_batches ADD COLUMN IF NOT EXISTS bank_posting_after_fp_tolerance_minutes  INTEGER;
ALTER TABLE recon_sync_batches ADD COLUMN IF NOT EXISTS mismatch_time_tolerance_minutes          INTEGER;

-- ── recon_fp_transactions: bill_info1 — kunci matching utama BRI BI-FAST
-- (bukan id_transaksi). WAJIB tetap string (leading zero dipertahankan),
-- jadi TEXT bukan NUMERIC.
ALTER TABLE recon_fp_transactions ADD COLUMN IF NOT EXISTS bill_info1 TEXT;

-- ── recon_bank_transactions: hasil ekstraksi khusus BI-FAST. account_no,
-- description (DESK_TRAN), remarks (TRREMK), tlbds1/tlbds2, opening_balance,
-- extraction_confidence, id_conflict, coverage_status, balance_check_status,
-- balance_variance, row_fingerprint SUDAH ADA (migration BRI existing),
-- dipakai bersama dgn semantik yang sama.
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS beneficiary_account      TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS account_from_desk_tran   TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS account_from_trremk      TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS account_conflict         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS bank_trace_id            TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS trace_from_desk_tran     TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS trace_from_tlbds2        TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS counterparty_bic         TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS esb_reference            TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS transfer_group_key       TEXT;

CREATE INDEX IF NOT EXISTS idx_recon_bank_transactions_bank_trace_id ON recon_bank_transactions(bank_trace_id);
CREATE INDEX IF NOT EXISTS idx_recon_bank_transactions_beneficiary   ON recon_bank_transactions(beneficiary_account);

-- ── recon_results: field spesifik hasil BRI BI-FAST. reversal_date,
-- reversal_amount, reversal_lookup_source SUDAH ADA (migration BRI
-- existing, tipe TIMESTAMPTZ/NUMERIC/TEXT), dipakai bersama apa adanya —
-- TIDAK diubah tipenya di sini.
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS fp_bill_info1            TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS bank_beneficiary_account TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS bank_trace_id            TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS counterparty_bic         TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS account_conflict         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS time_order_status        TEXT;

CREATE INDEX IF NOT EXISTS idx_recon_results_bank_trace_id  ON recon_results(bank_trace_id);
CREATE INDEX IF NOT EXISTS idx_recon_results_bill_info1     ON recon_results(fp_bill_info1);

-- ── finance_balance_requests: tambahkan BRI_BIFAST ke CHECK constraint
-- bank_code secara idempotent (DROP lalu ADD ulang dgn daftar lengkap —
-- Postgres tidak punya ADD CONSTRAINT IF NOT EXISTS utk CHECK, jadi drop
-- dulu kalau sudah ada, TIDAK PERNAH menghapus data, murni redefinisi
-- constraint). TIDAK merusak bank_code OCBC/MANDIRI/BRI yang sudah ada.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_finance_balance_requests_bank_code'
  ) THEN
    ALTER TABLE finance_balance_requests DROP CONSTRAINT chk_finance_balance_requests_bank_code;
  END IF;
  ALTER TABLE finance_balance_requests
    ADD CONSTRAINT chk_finance_balance_requests_bank_code
    CHECK (bank_code IN ('OCBC', 'MANDIRI', 'BRI', 'BRI_BIFAST'));
END $$;
