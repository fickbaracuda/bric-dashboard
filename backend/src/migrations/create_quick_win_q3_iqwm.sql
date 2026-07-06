-- Quick Win Q3 IQWM (Winme & InstaQRIS) — Prompt 1: skema database.
-- Sumber: 3 sheet Google Sheet ("Resume IQWM", "Breakdown Target Instaqris",
-- "Breakdown Target Winme"). Breakdown SEKARANG ada untuk Winme DAN
-- InstaQRIS (format lama hanya InstaQRIS) — kolom `product` di kedua tabel
-- utama TIDAK BOLEH diasumsikan salah satu produk saja, supaya produk baru
-- di masa depan tetap bisa ditampung tanpa ALTER TABLE.
-- Idempotent: aman dijalankan ulang (CREATE TABLE/INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS iqwm_qw_resume (
  id                              BIGSERIAL PRIMARY KEY,
  periode                         TEXT        NOT NULL,
  product                         TEXT        NOT NULL,
  quickwin_no                     INTEGER,
  point_quickwin                  TEXT,
  target_label                    TEXT,
  target_value                    NUMERIC,
  target_revenue                  NUMERIC,
  realization_target              NUMERIC,
  realization_target_pct         NUMERIC,
  realization_revenue             NUMERIC,
  realization_revenue_pct        NUMERIC,
  pic                              TEXT,
  estimated_end_q3                 NUMERIC,
  estimated_target_value_end_q3   NUMERIC,
  status                           TEXT,
  priority                         TEXT,
  source_sheet                     TEXT,
  source_row                       INTEGER,
  raw_data                         JSONB,
  synced_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (periode, product, quickwin_no)
);

CREATE TABLE IF NOT EXISTS iqwm_qw_breakdown (
  id                    BIGSERIAL PRIMARY KEY,
  periode               TEXT        NOT NULL,
  product               TEXT        NOT NULL,
  quickwin_no           INTEGER,
  point_quickwin        TEXT,
  metric_label          TEXT,
  metric_type           TEXT,
  month_key             TEXT,
  month_label           TEXT,
  week_label            TEXT,
  week_start            DATE,
  week_end              DATE,
  target_value          NUMERIC,
  realization_value     NUMERIC,
  realization_pct       NUMERIC,
  gap_value              NUMERIC,
  status                 TEXT,
  source_sheet           TEXT,
  source_row             INTEGER,
  raw_data               JSONB,
  synced_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (periode, product, quickwin_no, metric_label, month_key, week_label)
);

CREATE TABLE IF NOT EXISTS iqwm_qw_sync_log (
  id                        BIGSERIAL PRIMARY KEY,
  periode                   TEXT,
  source                    TEXT,
  resume_rows_received      INTEGER,
  resume_rows_inserted      INTEGER,
  breakdown_rows_received   INTEGER,
  breakdown_rows_inserted   INTEGER,
  status                    TEXT,
  error_message             TEXT,
  payload_meta              JSONB,
  synced_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS iqwm_qw_period_config (
  periode        TEXT PRIMARY KEY,
  label           TEXT,
  period_start    DATE,
  period_end      DATE,
  as_of_date      DATE,
  total_days      INTEGER,
  days_elapsed    INTEGER,
  source_url      TEXT,
  source_meta     JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_iqwm_qw_resume_periode     ON iqwm_qw_resume(periode);
CREATE INDEX IF NOT EXISTS idx_iqwm_qw_resume_product     ON iqwm_qw_resume(product);
CREATE INDEX IF NOT EXISTS idx_iqwm_qw_breakdown_periode  ON iqwm_qw_breakdown(periode);
CREATE INDEX IF NOT EXISTS idx_iqwm_qw_breakdown_product  ON iqwm_qw_breakdown(product);
CREATE INDEX IF NOT EXISTS idx_iqwm_qw_breakdown_month    ON iqwm_qw_breakdown(month_key);
CREATE INDEX IF NOT EXISTS idx_iqwm_qw_breakdown_metric   ON iqwm_qw_breakdown(metric_label);
CREATE INDEX IF NOT EXISTS idx_iqwm_qw_sync_log_periode   ON iqwm_qw_sync_log(periode, synced_at DESC);

GRANT ALL ON iqwm_qw_resume, iqwm_qw_breakdown, iqwm_qw_sync_log, iqwm_qw_period_config TO bricuser;
GRANT USAGE, SELECT ON iqwm_qw_resume_id_seq, iqwm_qw_breakdown_id_seq, iqwm_qw_sync_log_id_seq TO bricuser;
