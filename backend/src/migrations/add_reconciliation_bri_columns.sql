-- Rekonsiliasi BRI — perluasan GENERIC atas tabel recon_* yang sudah dipakai
-- Rekonsiliasi OCBC (create_reconciliation_ocbc.sql) & Mandiri
-- (add_reconciliation_mandiri_columns.sql). TIDAK membuat tabel baru
-- (mis. bri_recon_results) — bank dibedakan via kolom bank_code = 'BRI'
-- pada recon_sync_batches (sudah ada, default 'OCBC').
--
-- Kolom baru di sini SEMUA nullable / berdefault aman, jadi baris OCBC dan
-- Mandiri yang sudah ada TIDAK berubah perilakunya (backward compatible).
-- Idempotent: aman dijalankan ulang.

-- ── recon_sync_batches: config tambahan khusus BRI (coverage tolerance &
-- reversal cross-date lookup) — account_no/scope_mode/expected_fee/
-- grace_period_minutes sudah ada dari migration Mandiri, dipakai bersama.
ALTER TABLE recon_sync_batches ADD COLUMN IF NOT EXISTS coverage_tolerance_minutes INTEGER;
ALTER TABLE recon_sync_batches ADD COLUMN IF NOT EXISTS reversal_lookup_days       INTEGER;

-- ── recon_bank_transactions: kolom khusus mutasi rekening BRI (statement
-- umum, BUKAN sheet khusus FASTPAY seperti OCBC/Mandiri) + hasil ekstraksi
-- 3-sumber (DESK_TRAN/TRREMK/TLBDS2) + validasi saldo per baris.
-- account_no (NOREK), description (DESK_TRAN), debit (MUTASI_DEBET),
-- credit (MUTASI_KREDIT), balance (SALDO_AKHIR_MUTASI),
-- extracted_transaction_id/bank_row_type/extraction_method sudah ada
-- (migration Mandiri), dipakai bersama dgn semantik yang sama.
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS business_date            DATE;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS effective_date_time      TIMESTAMPTZ;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS sequence_no              TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS remarks                  TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS tlbds1                   TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS tlbds2                   TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS opening_balance          NUMERIC;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS gl_sign                  TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS tr_user                  TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS kode_tran                TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS kode_tran_teller         TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS extraction_confidence    TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS id_conflict              BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS coverage_status          TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS balance_check_status     TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS balance_variance         NUMERIC;
-- row_fingerprint: idempotensi sync (UNIQUE) — SHA-256 dari kombinasi field
-- stabil (bank_code|NOREK|TGL_TRAN|TGL_EFEKTIF|SEQ|DESK_TRAN|debit|kredit|
-- SALDO_AKHIR_MUTASI), lihat buildBriFingerprint() di briAdapter.js. Partial
-- unique index (WHERE NOT NULL) supaya baris OCBC/Mandiri lama (NULL) tidak
-- kena constraint ini.
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS row_fingerprint          TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_recon_bank_transactions_fingerprint
  ON recon_bank_transactions (row_fingerprint) WHERE row_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_recon_bank_business_date ON recon_bank_transactions(business_date);

-- ── recon_results: field spesifik hasil rekonsiliasi BRI. bank_code,
-- canonical_transaction_key, time_difference_minutes, coverage_status
-- sudah ada (migration Mandiri / OCBC coverage), dipakai bersama.
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS extracted_transaction_id TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS estimated_bank_principal NUMERIC;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS reversal_date            TIMESTAMPTZ;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS reversal_amount          NUMERIC;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS reversal_lookup_source   TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS id_conflict              BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_recon_results_extracted_id ON recon_results(extracted_transaction_id);
