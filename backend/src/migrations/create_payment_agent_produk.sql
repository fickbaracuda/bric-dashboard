-- War-Room Payment Agent > Produk (Marketing Decision Dashboard)
--
-- Sumber: 1 sheet Google Sheet "Produk" (spreadsheet
-- 1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw). Bulan bersifat DINAMIS
-- (dibaca dari header sheet oleh Apps Script, bukan hardcode Mei/Jun/Jul) —
-- lihat docs/PAYMENT_AGENT_PRODUK.md.
--
-- Domain TERPISAH dari pa_produk_snapshot/pa_produk_totals (warroom.js) dan
-- dari warroom_pa_produk_periode (rolling m2/m1/curr window) — jangan disatukan.
CREATE TABLE IF NOT EXISTS payment_agent_produk_metrics (
  id            BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  day_number    INTEGER,
  month_key     TEXT NOT NULL,   -- 'YYYY-MM'
  month_label   TEXT,            -- contoh: 'Mei 2026'
  product_code  TEXT,
  product_name  TEXT NOT NULL,
  product_label TEXT,            -- contoh: '15. TIKET PESAWAT'
  mat           NUMERIC,
  trx           NUMERIC,
  rev           NUMERIC,
  arpt          NUMERIC,
  atpu          NUMERIC,
  arpu          NUMERIC,
  source_sheet  TEXT,
  source_row    INTEGER,
  raw_data      JSONB,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (snapshot_date, month_key, product_label)
);
CREATE INDEX IF NOT EXISTS idx_pa_produk_metrics_snapshot_date ON payment_agent_produk_metrics (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_pa_produk_metrics_month_key     ON payment_agent_produk_metrics (month_key);
CREATE INDEX IF NOT EXISTS idx_pa_produk_metrics_product_name  ON payment_agent_produk_metrics (product_name);
CREATE INDEX IF NOT EXISTS idx_pa_produk_metrics_product_code  ON payment_agent_produk_metrics (product_code);

CREATE TABLE IF NOT EXISTS payment_agent_produk_deviation (
  id            BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  day_number    INTEGER,
  compare_key   TEXT NOT NULL,   -- contoh: 'mei_vs_jul', 'jun_vs_jul' (posisional, lihat docs)
  compare_label TEXT,            -- contoh: 'DEV : MEI VS JUL'
  product_code  TEXT,
  product_name  TEXT NOT NULL,
  product_label TEXT,
  dev_mat       NUMERIC,
  dev_trx       NUMERIC,
  dev_rev       NUMERIC,
  dev_arpt      NUMERIC,
  dev_atpu      NUMERIC,
  dev_arpu      NUMERIC,
  source_sheet  TEXT,
  source_row    INTEGER,
  raw_data      JSONB,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (snapshot_date, compare_key, product_label)
);
CREATE INDEX IF NOT EXISTS idx_pa_produk_deviation_snapshot_date ON payment_agent_produk_deviation (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_pa_produk_deviation_compare_key   ON payment_agent_produk_deviation (compare_key);
CREATE INDEX IF NOT EXISTS idx_pa_produk_deviation_product_name  ON payment_agent_produk_deviation (product_name);
CREATE INDEX IF NOT EXISTS idx_pa_produk_deviation_product_code  ON payment_agent_produk_deviation (product_code);

CREATE TABLE IF NOT EXISTS payment_agent_produk_sync_log (
  id                       BIGSERIAL PRIMARY KEY,
  sync_key                 TEXT,
  snapshot_date            DATE,
  day_number               INTEGER,
  metric_rows_received     INTEGER,
  metric_rows_inserted     INTEGER,
  deviation_rows_received  INTEGER,
  deviation_rows_inserted  INTEGER,
  status                   TEXT,   -- 'success' | 'failed'
  error_message            TEXT,
  payload_meta             JSONB,
  synced_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pa_produk_sync_log_synced_at     ON payment_agent_produk_sync_log (synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_pa_produk_sync_log_snapshot_date ON payment_agent_produk_sync_log (snapshot_date);

CREATE TABLE IF NOT EXISTS payment_agent_produk_config (
  id                   BIGSERIAL PRIMARY KEY,
  sync_key             TEXT UNIQUE,
  source_url           TEXT,
  sheet_name           TEXT,
  latest_snapshot_date DATE,
  latest_day_number    INTEGER,
  month_list           JSONB,
  source_meta          JSONB,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Grant mengikuti pola existing BRIC (user aplikasi: bricuser). Aman
-- dijalankan berulang (idempotent) — tidak menyentuh password/role lain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bricuser') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      payment_agent_produk_metrics,
      payment_agent_produk_deviation,
      payment_agent_produk_sync_log,
      payment_agent_produk_config
      TO bricuser;
    GRANT USAGE, SELECT ON
      payment_agent_produk_metrics_id_seq,
      payment_agent_produk_deviation_id_seq,
      payment_agent_produk_sync_log_id_seq,
      payment_agent_produk_config_id_seq
      TO bricuser;
  END IF;
END $$;
