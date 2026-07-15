-- Fitur "Permintaan Tambahan Saldo" — Tim Operation (dari halaman
-- Rekonsiliasi OCBC/Mandiri/BRI) meminta Finance (unit FA) menambah saldo.
-- Tabel baru, TIDAK menyentuh tabel recon_* yang sudah ada.
-- Idempotent: aman dijalankan ulang.

CREATE TABLE IF NOT EXISTS finance_balance_requests (
  id                        BIGSERIAL PRIMARY KEY,
  bank_code                 VARCHAR(20) NOT NULL,
  requester_name            VARCHAR(100) NOT NULL,
  status                    VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  requested_by_user_id      BIGINT NULL,
  requested_by_username     VARCHAR(100) NULL,
  requested_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_by_user_id   BIGINT NULL,
  acknowledged_by_username  VARCHAR(100) NULL,
  acknowledged_at           TIMESTAMPTZ NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- CHECK constraint ditambahkan terpisah (bukan inline) supaya idempotent —
-- ADD CONSTRAINT IF NOT EXISTS belum didukung utk CHECK di semua versi
-- Postgres, jadi dicek manual via pg_constraint dulu.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_finance_balance_requests_bank_code'
  ) THEN
    ALTER TABLE finance_balance_requests
      ADD CONSTRAINT chk_finance_balance_requests_bank_code
      CHECK (bank_code IN ('OCBC', 'MANDIRI', 'BRI'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_finance_balance_requests_status'
  ) THEN
    ALTER TABLE finance_balance_requests
      ADD CONSTRAINT chk_finance_balance_requests_status
      CHECK (status IN ('PENDING', 'ACKNOWLEDGED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_finance_balance_requests_status ON finance_balance_requests(status);
CREATE INDEX IF NOT EXISTS idx_finance_balance_requests_requested_at ON finance_balance_requests(requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_finance_balance_requests_bank_code ON finance_balance_requests(bank_code);
CREATE INDEX IF NOT EXISTS idx_finance_balance_requests_acknowledged_at ON finance_balance_requests(acknowledged_at);
