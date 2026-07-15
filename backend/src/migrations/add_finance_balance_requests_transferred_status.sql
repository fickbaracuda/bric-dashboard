-- Fitur "Permintaan Tambahan Saldo" — tambah status ketiga TRANSFERRED
-- (dana sudah benar-benar ditransfer FA, bukan cuma "diterima"/diproses).
-- Perluasan tabel yang sudah ada — TIDAK membuat tabel baru.
-- Idempotent: aman dijalankan ulang.

-- CHECK constraint status tidak bisa "ADD CONSTRAINT IF NOT EXISTS" di
-- Postgres, jadi drop dulu (aman, IF EXISTS) lalu buat ulang dgn nilai
-- yang diperluas -- pola ini aman dijalankan berkali-kali.
ALTER TABLE finance_balance_requests DROP CONSTRAINT IF EXISTS chk_finance_balance_requests_status;
ALTER TABLE finance_balance_requests
  ADD CONSTRAINT chk_finance_balance_requests_status
  CHECK (status IN ('PENDING', 'ACKNOWLEDGED', 'TRANSFERRED'));

ALTER TABLE finance_balance_requests ADD COLUMN IF NOT EXISTS transferred_by_user_id   BIGINT NULL;
ALTER TABLE finance_balance_requests ADD COLUMN IF NOT EXISTS transferred_by_username  VARCHAR(100) NULL;
ALTER TABLE finance_balance_requests ADD COLUMN IF NOT EXISTS transferred_at           TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_finance_balance_requests_transferred_at ON finance_balance_requests(transferred_at);
