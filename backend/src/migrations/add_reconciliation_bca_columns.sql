-- Rekonsiliasi BCA — perluasan GENERIC atas tabel recon_* yang sudah dipakai
-- Rekonsiliasi OCBC/Mandiri/BRI/BRI BI-FAST/BNI existing. TIDAK membuat tabel
-- baru (mis. bca_recon_results) — bank dibedakan via kolom bank_code = 'BCA'
-- pada recon_sync_batches (sudah ada, default 'OCBC').
--
-- Idempotent: aman dijalankan ulang.
--
-- REUSE besar-besaran dari kolom generic yang SUDAH ADA (dicek langsung ke
-- migration Mandiri/BNI sebelum menulis file ini, supaya tidak menduplikasi
-- kolom dgn makna sama pakai nama berbeda):
--   recon_fp_transactions : id_transaksi/nominal/id_produk/time_response/
--     id_outlet/id_biller SUDAH cukup utk struktur DATA FP BCA (identik
--     dgn bank lain) — TIDAK ADA kolom baru di tabel ini utk BCA.
--   recon_bank_transactions : transaction_date (Tanggal Transaksi),
--     description (Keterangan), debit/credit (hasil parse "Jumlah"
--     "25,000.00 DB" -> debit=25000/credit=0), balance (Saldo — kolom
--     GENERIC dari migration OCBC awal, dipakai APA ADANYA, BCA TIDAK
--     menambah kolom "close_balance" terpisah seperti Mandiri karena
--     `balance` generic sudah persis cocok), extracted_transaction_id,
--     bank_row_type, extraction_method (ditambahkan Mandiri, di-reuse APA
--     ADANYA — BCA hanya butuh SATU sumber ekstraksi per baris, sama
--     seperti Mandiri, jadi tidak perlu kolom transaction_id_from_hash/
--     _from_reference terpisah seperti BNI) SUDAH ADA — dipakai bersama.
--   recon_results : bank_code, time_difference_minutes (ditambahkan
--     Mandiri) SUDAH ADA — dipakai bersama. bank_credit/bank_total_debit/
--     variance_principal/notes/matching_method/recon_status dari tabel
--     inti OCBC SUDAH ADA.
--
-- Kolom BARU (genuinely tidak ada padanan generic-nya): TIDAK ADA.
-- Baris ALTER TABLE ADD COLUMN IF NOT EXISTS di bawah untuk
-- extracted_transaction_id/bank_row_type/extraction_method HANYA dijaga di
-- sini demi self-containment (file ini tetap aman dijalankan berdiri
-- sendiri walau migration Mandiri belum pernah jalan di DB tujuan) — BUKAN
-- kolom baru yang dimiliki BCA sendiri.

-- ── recon_bank_transactions (reuse, idempotent no-op kalau sudah ada) ──
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS extracted_transaction_id TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS bank_row_type            TEXT;
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS extraction_method        TEXT;

CREATE INDEX IF NOT EXISTS idx_recon_bank_extracted_id ON recon_bank_transactions(extracted_transaction_id);

-- ── recon_results (reuse, idempotent no-op kalau sudah ada) ──
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS bank_code               TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS time_difference_minutes INTEGER;

CREATE INDEX IF NOT EXISTS idx_recon_results_bank_code ON recon_results(bank_code);

-- ── finance_balance_requests: tambahkan BCA ke CHECK constraint bank_code
-- secara idempotent (DROP lalu ADD ulang dgn daftar lengkap — Postgres
-- tidak punya ADD CONSTRAINT IF NOT EXISTS utk CHECK). TIDAK PERNAH
-- menghapus data, murni redefinisi constraint. TIDAK merusak bank_code
-- OCBC/MANDIRI/BRI/BRI_BIFAST/BNI yang sudah ada.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_finance_balance_requests_bank_code'
  ) THEN
    ALTER TABLE finance_balance_requests DROP CONSTRAINT chk_finance_balance_requests_bank_code;
  END IF;
  ALTER TABLE finance_balance_requests
    ADD CONSTRAINT chk_finance_balance_requests_bank_code
    CHECK (bank_code IN ('OCBC', 'MANDIRI', 'BRI', 'BRI_BIFAST', 'BNI', 'BCA'));
END $$;
