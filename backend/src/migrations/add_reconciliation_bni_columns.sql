-- Rekonsiliasi BNI — perluasan GENERIC atas tabel recon_* yang sudah dipakai
-- Rekonsiliasi OCBC/Mandiri/BRI/BRI BI-FAST existing. TIDAK membuat tabel
-- baru (mis. bni_recon_results) — bank dibedakan via kolom bank_code = 'BNI'
-- pada recon_sync_batches (sudah ada, default 'OCBC').
--
-- Kolom baru di sini SEMUA nullable / berdefault aman, jadi baris bank lain
-- yang sudah ada TIDAK berubah perilakunya (backward compatible).
-- Idempotent: aman dijalankan ulang.
--
-- REUSE besar-besaran dari kolom generic yang SUDAH ADA (dicek langsung ke
-- schema production sebelum menulis migration ini, supaya tidak menduplikasi
-- kolom dgn makna sama pakai nama berbeda):
--   recon_fp_transactions : id_transaksi/nominal/id_produk/time_response/
--     id_outlet/id_biller SUDAH cukup utk struktur DATA FP BNI — TIDAK ADA
--     kolom baru di tabel ini utk BNI.
--   recon_bank_transactions : description (Description), debit (Debit),
--     credit (Credit), business_date, transaction_date_time (Post Date),
--     effective_date_time (Value Date), beneficiary_account,
--     extracted_transaction_id, extraction_confidence, id_conflict,
--     bank_row_type, coverage_status, row_fingerprint, sequence_no (reuse
--     utk Journal No.) SUDAH ADA (migration OCBC/Mandiri/BRI/BRI BI-FAST) —
--     dipakai APA ADANYA dgn semantik yang sama.
--   recon_results : bank_code, canonical_transaction_key, coverage_status,
--     coverage_reason, is_actionable, eligible_for_match_rate,
--     time_order_status, time_difference_minutes, id_conflict,
--     extracted_transaction_id (reuse utk "bank_transaction_id"),
--     bank_beneficiary_account (reuse utk beneficiary_account),
--     bank_principal, bank_fee, bank_total_debit (reuse utk gross debit),
--     variance_principal, variance_fee, matching_method, reversal_date,
--     reversal_amount, reversal_lookup_source SUDAH ADA — dipakai bersama.
--
-- Kolom BARU (genuinely tidak ada padanan generic-nya):
--   recon_bank_transactions.transaction_id_from_hash / _from_reference
--     (audit — dua sumber ekstraksi terpisah, extracted_transaction_id
--      generic cuma menyimpan hasil AKHIR yang sudah diresolusikan)
--   recon_bank_transactions.recipient_name (nama penerima, audit only,
--     BUKAN matching key)
--   recon_bank_transactions.branch (Branch — tidak ada kolom generic yang
--     cocok, beda dari sequence_no/description)
--   recon_results.recipient_name, .bank_branch, .bank_journal_no
--     (denormalisasi utk tampilan tabel Hasil Rekonsiliasi, pola sama dgn
--      bank_beneficiary_account/bank_trace_id di BRI BI-FAST)
--   recon_results.transaction_id_from_hash / _from_reference (audit di tabel
--     hasil, bukan cuma Raw Data)
--   recon_results.time_difference_seconds (BNI pakai presisi DETIK, beda
--     dari time_difference_minutes generic yang dipakai bank lain — sample
--     BNI selisihnya sering 0-1 detik saja, menit terlalu kasar)
--   recon_results.extraction_confidence (HIGH/MEDIUM/CONFLICT/NONE per hasil)
--   recon_sync_batches.coverage_tolerance_before_minutes / _after_minutes
--     (coverage window ASIMETRIS opsional — coverage_tolerance_minutes
--      generic yang sudah ada cuma satu angka, BNI butuh before & after
--      terpisah sesuai FP_COVERAGE_WINDOW)

-- ── recon_sync_batches ──
ALTER TABLE recon_sync_batches ADD COLUMN IF NOT EXISTS coverage_tolerance_before_minutes INTEGER;
ALTER TABLE recon_sync_batches ADD COLUMN IF NOT EXISTS coverage_tolerance_after_minutes  INTEGER;

-- ── recon_bank_transactions ──
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS transaction_id_from_hash      TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS transaction_id_from_reference TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS recipient_name                TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS branch                        TEXT;

CREATE INDEX IF NOT EXISTS idx_recon_bank_transactions_recipient_name ON recon_bank_transactions(recipient_name);

-- ── recon_results ──
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS recipient_name            TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS bank_branch               TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS bank_journal_no           TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS transaction_id_from_hash      TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS transaction_id_from_reference TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS time_difference_seconds   INTEGER;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS extraction_confidence     TEXT;

CREATE INDEX IF NOT EXISTS idx_recon_results_journal_no ON recon_results(bank_journal_no);

-- ── finance_balance_requests: tambahkan BNI ke CHECK constraint bank_code
-- secara idempotent (DROP lalu ADD ulang dgn daftar lengkap — Postgres
-- tidak punya ADD CONSTRAINT IF NOT EXISTS utk CHECK). TIDAK PERNAH
-- menghapus data, murni redefinisi constraint. TIDAK merusak bank_code
-- OCBC/MANDIRI/BRI/BRI_BIFAST yang sudah ada.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_finance_balance_requests_bank_code'
  ) THEN
    ALTER TABLE finance_balance_requests DROP CONSTRAINT chk_finance_balance_requests_bank_code;
  END IF;
  ALTER TABLE finance_balance_requests
    ADD CONSTRAINT chk_finance_balance_requests_bank_code
    CHECK (bank_code IN ('OCBC', 'MANDIRI', 'BRI', 'BRI_BIFAST', 'BNI'));
END $$;
