-- Produk Ekspedisi — War Room Ekspedisi > Produk Ekspedisi
-- Sumber: Google Sheet "Rev per produk" + "Rev produk per outlet"
-- (spreadsheet 1yVNeyHe3b_PLnFf3SGvLx3wuD4Gm3e6XItjiDADd_Lo, terpisah dari
-- ekspedisi_monthly yang sudah ada — domain berbeda, bukan pengganti).
-- Idempotent: aman dijalankan ulang (CREATE TABLE/INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS ekspedisi_produk_summary (
  id            BIGSERIAL PRIMARY KEY,
  bulan         TEXT        NOT NULL,
  bulan_label   TEXT,
  id_produk     TEXT        NOT NULL,
  produk        TEXT,
  mat           NUMERIC,
  jml_bill      NUMERIC,
  margin_fp     NUMERIC,
  vs_mei        NUMERIC,
  vs_jun        NUMERIC,
  source_sheet  TEXT,
  source_row    INTEGER,
  raw_data      JSONB,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bulan, id_produk)
);

CREATE TABLE IF NOT EXISTS ekspedisi_produk_outlet (
  id            BIGSERIAL PRIMARY KEY,
  bulan         TEXT        NOT NULL,
  bulan_label   TEXT,
  tanggal       DATE,
  id_outlet     TEXT,
  id_produk     TEXT        NOT NULL,
  jml_bill      NUMERIC,
  margin_fp     NUMERIC,
  source_sheet  TEXT,
  source_row    INTEGER,
  raw_data      JSONB,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bulan, tanggal, id_outlet, id_produk, source_row)
);

CREATE TABLE IF NOT EXISTS ekspedisi_produk_sync_log (
  id                       BIGSERIAL PRIMARY KEY,
  sync_key                 TEXT,
  summary_rows_received    INTEGER,
  summary_rows_inserted    INTEGER,
  outlet_rows_received     INTEGER,
  outlet_rows_inserted     INTEGER,
  bulan_list               JSONB,
  status                   TEXT,
  error_message            TEXT,
  payload_meta             JSONB,
  synced_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ekspedisi_produk_config (
  id            BIGSERIAL PRIMARY KEY,
  sync_key      TEXT UNIQUE,
  source_url    TEXT,
  as_of_date    DATE,
  day_number    INTEGER,
  month_list    JSONB,
  source_meta   JSONB,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ekspedisi_produk_summary_bulan     ON ekspedisi_produk_summary(bulan);
CREATE INDEX IF NOT EXISTS idx_ekspedisi_produk_summary_produk    ON ekspedisi_produk_summary(id_produk);
CREATE INDEX IF NOT EXISTS idx_ekspedisi_produk_outlet_bulan      ON ekspedisi_produk_outlet(bulan);
CREATE INDEX IF NOT EXISTS idx_ekspedisi_produk_outlet_produk     ON ekspedisi_produk_outlet(id_produk);
CREATE INDEX IF NOT EXISTS idx_ekspedisi_produk_outlet_outlet     ON ekspedisi_produk_outlet(id_outlet);
CREATE INDEX IF NOT EXISTS idx_ekspedisi_produk_outlet_tanggal    ON ekspedisi_produk_outlet(tanggal);
CREATE INDEX IF NOT EXISTS idx_ekspedisi_produk_sync_log_synced   ON ekspedisi_produk_sync_log(synced_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON ekspedisi_produk_summary, ekspedisi_produk_outlet, ekspedisi_produk_sync_log, ekspedisi_produk_config TO bricuser;
GRANT USAGE, SELECT ON ekspedisi_produk_summary_id_seq, ekspedisi_produk_outlet_id_seq, ekspedisi_produk_sync_log_id_seq, ekspedisi_produk_config_id_seq TO bricuser;
