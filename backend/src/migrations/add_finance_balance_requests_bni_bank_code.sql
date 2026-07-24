-- Fitur "Permintaan Tambahan Saldo" — tambah BRI_BIFAST & BNI ke CHECK
-- constraint bank_code (migration awal add_finance_balance_requests.sql
-- HANYA berisi OCBC/MANDIRI/BRI, tertinggal saat BRI BI-FAST & BNI
-- ditambahkan sbg war-room baru). Perluasan tabel yang sudah ada — TIDAK
-- membuat tabel baru. Idempotent: aman dijalankan ulang.

ALTER TABLE finance_balance_requests DROP CONSTRAINT IF EXISTS chk_finance_balance_requests_bank_code;
ALTER TABLE finance_balance_requests
  ADD CONSTRAINT chk_finance_balance_requests_bank_code
  CHECK (bank_code IN ('OCBC', 'MANDIRI', 'BRI', 'BRI_BIFAST', 'BNI'));
