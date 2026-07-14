-- Rekonsiliasi OCBC — index tambahan utk query archive yang sekarang scoped
-- per business_date (fix bug cross-date: runOcbcEngineAndPersist dulu HANYA
-- filter bank_code/account_no tanpa business_date sama sekali, sehingga
-- baris archive tanggal lain ikut tertarik ke engine batch aktif).
--
-- Idempotent: aman dijalankan ulang (CREATE INDEX IF NOT EXISTS).

CREATE INDEX IF NOT EXISTS idx_recon_bank_archive_code_account_date
  ON recon_bank_archive (bank_code, account_no, business_date);
