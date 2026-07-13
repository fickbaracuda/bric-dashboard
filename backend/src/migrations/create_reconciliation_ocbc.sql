-- Rekonsiliasi FP vs Bank OCBC — War Room Payment Agent > Rekonsiliasi OCBC
-- Sumber: 2 sheet Google Sheet ("DATA FP", "DATA BANK OCBC") dari spreadsheet
-- 1V8NwLKeVUo2zV4ez-K4V-Ymt3_PNk7DyNrsJktcb2tE.
-- Idempotent: aman dijalankan ulang (CREATE TABLE/INDEX IF NOT EXISTS).
--
-- Idempotensi sync per business_date+bank_code: recon_sync_batches UNIQUE
-- (business_date, bank_code) — resync menimpa batch yang sama (data mentah
-- dihapus & diisi ulang, recon_results di-upsert lewat unique index di bawah
-- supaya id & riwayat resolve/audit log TIDAK hilang saat resync).

CREATE TABLE IF NOT EXISTS recon_sync_batches (
  id              BIGSERIAL PRIMARY KEY,
  batch_no        TEXT        NOT NULL,
  business_date   DATE        NOT NULL,
  bank_code       TEXT        NOT NULL DEFAULT 'OCBC',
  spreadsheet_id  TEXT,
  fp_sheet_name   TEXT,
  bank_sheet_name TEXT,
  fp_row_count    INTEGER     DEFAULT 0,
  bank_row_count  INTEGER     DEFAULT 0,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending',
  raw_summary     JSONB,
  UNIQUE (business_date, bank_code)
);

CREATE TABLE IF NOT EXISTS recon_fp_transactions (
  id                BIGSERIAL PRIMARY KEY,
  batch_id          BIGINT      NOT NULL REFERENCES recon_sync_batches(id) ON DELETE CASCADE,
  id_transaksi      TEXT        NOT NULL,
  nominal           NUMERIC,
  id_produk         TEXT,
  time_response     TIMESTAMPTZ,
  id_outlet         TEXT,
  id_biller         TEXT,
  source_row_number INTEGER,
  raw_data          JSONB
);

CREATE TABLE IF NOT EXISTS recon_bank_transactions (
  id                BIGSERIAL PRIMARY KEY,
  batch_id          BIGINT      NOT NULL REFERENCES recon_sync_batches(id) ON DELETE CASCADE,
  transaction_date  DATE,
  value_date        DATE,
  reference_no      TEXT,
  cheque_no         TEXT,
  description       TEXT,
  debit             NUMERIC,
  credit            NUMERIC,
  balance           NUMERIC,
  source_row_number INTEGER,
  raw_data          JSONB
  -- SENGAJA TIDAK UNIQUE pada reference_no — satu reference biasa punya 2+
  -- baris (fee BI-FAST Rp25 dan principal), lihat dokumentasi konsep rekon.
);

CREATE TABLE IF NOT EXISTS recon_results (
  id                    BIGSERIAL PRIMARY KEY,
  batch_id              BIGINT      NOT NULL REFERENCES recon_sync_batches(id) ON DELETE CASCADE,
  id_transaksi          TEXT,
  reference_no          TEXT,
  id_outlet             TEXT,
  id_produk             TEXT,
  id_biller             TEXT,
  fp_nominal            NUMERIC,
  fp_time_response      TIMESTAMPTZ,
  bank_transaction_date DATE,
  bank_principal        NUMERIC,
  bank_fee              NUMERIC,
  bank_credit           NUMERIC,
  bank_total_debit      NUMERIC,
  variance_principal    NUMERIC,
  variance_fee          NUMERIC,
  matching_method       TEXT,
  recon_status          TEXT        NOT NULL,
  aging_minutes         INTEGER,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upsert key: satu baris hasil per (batch, id_transaksi, reference_no) —
-- pakai expression index (bukan UNIQUE constraint biasa) supaya NULL
-- diperlakukan konsisten sebagai '' (id_transaksi null utk BANK_ONLY,
-- reference_no null utk FP_ONLY/PENDING_BANK yang belum ada match bank).
CREATE UNIQUE INDEX IF NOT EXISTS uq_recon_results_natural_key
  ON recon_results (batch_id, COALESCE(id_transaksi, ''), COALESCE(reference_no, ''));

CREATE TABLE IF NOT EXISTS recon_action_logs (
  id               BIGSERIAL PRIMARY KEY,
  recon_result_id  BIGINT      NOT NULL REFERENCES recon_results(id) ON DELETE CASCADE,
  action           TEXT        NOT NULL,
  status_before    TEXT,
  status_after     TEXT,
  notes            TEXT,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recon_sync_batches_date        ON recon_sync_batches(business_date);
CREATE INDEX IF NOT EXISTS idx_recon_fp_batch                  ON recon_fp_transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_recon_fp_id_transaksi           ON recon_fp_transactions(id_transaksi);
CREATE INDEX IF NOT EXISTS idx_recon_bank_batch                ON recon_bank_transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_recon_bank_reference            ON recon_bank_transactions(reference_no);
CREATE INDEX IF NOT EXISTS idx_recon_results_batch             ON recon_results(batch_id);
CREATE INDEX IF NOT EXISTS idx_recon_results_status            ON recon_results(recon_status);
CREATE INDEX IF NOT EXISTS idx_recon_results_outlet            ON recon_results(id_outlet);
CREATE INDEX IF NOT EXISTS idx_recon_results_produk            ON recon_results(id_produk);
CREATE INDEX IF NOT EXISTS idx_recon_action_logs_result        ON recon_action_logs(recon_result_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON recon_sync_batches, recon_fp_transactions, recon_bank_transactions, recon_results, recon_action_logs TO bricuser;
GRANT USAGE, SELECT ON recon_sync_batches_id_seq, recon_fp_transactions_id_seq, recon_bank_transactions_id_seq, recon_results_id_seq, recon_action_logs_id_seq TO bricuser;
