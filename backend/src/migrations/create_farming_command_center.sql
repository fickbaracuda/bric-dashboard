-- WAR-ROOM Payment Agent > Farming — Farming Fastpay Command Center
--
-- Domain TERPISAH dari farming_snapshot lama (create_farming_snapshot.sql,
-- kolom hardcode trx_mei_period/trx_jun_period). Tabel lama SENGAJA TIDAK
-- diubah/dihapus — histori lama tetap ada, ini murni tambahan baru. Route
-- /war-room/farming & endpoint /api/warroom/farming/* di-upgrade untuk
-- membaca dari tabel BARU ini (lihat backend/src/routes/warroom-farming.js).
--
-- Bulan 100% dinamis: tidak ada kolom "mei"/"jun"/"jul" — semua bulan
-- disimpan sebagai month_key ('YYYY-MM') + month_label (teks asli sheet).

CREATE TABLE IF NOT EXISTS farming_outlet_snapshot (
  id                          BIGSERIAL PRIMARY KEY,
  snapshot_date               DATE NOT NULL,
  synced_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_sheet                TEXT,
  source_spreadsheet_id       TEXT,

  id_outlet                   TEXT NOT NULL,

  baseline_month_key          TEXT,
  baseline_month_label        TEXT,
  baseline_full_trx           NUMERIC,
  baseline_full_revenue       NUMERIC,

  previous_month_key          TEXT,
  previous_month_label        TEXT,
  previous_period_start_day   INTEGER,
  previous_period_end_day     INTEGER,
  previous_period_trx         NUMERIC,
  previous_period_revenue     NUMERIC,

  current_month_key           TEXT,
  current_month_label         TEXT,
  current_period_start_day    INTEGER,
  current_period_end_day      INTEGER,
  current_period_trx          NUMERIC,
  current_period_revenue      NUMERIC,

  sheet_dev_trx                NUMERIC,
  sheet_dev_revenue            NUMERIC,

  calculated_dev_trx           NUMERIC,
  calculated_dev_revenue       NUMERIC,
  dev_trx_variance              NUMERIC,
  dev_revenue_variance          NUMERIC,

  previous_arpt                NUMERIC,
  current_arpt                 NUMERIC,
  arpt_change                  NUMERIC,
  arpt_change_pct              NUMERIC,

  layer_arpu                   TEXT,

  status                       TEXT,
  priority                     TEXT,
  segment                      TEXT,
  priority_score               NUMERIC,
  reason_codes                 JSONB,

  raw_row                      JSONB,
  raw_headers                  JSONB,
  sync_batch_id                TEXT,

  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (snapshot_date, id_outlet)
);

CREATE INDEX IF NOT EXISTS idx_farming_ocs_snapshot_date ON farming_outlet_snapshot (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_farming_ocs_id_outlet     ON farming_outlet_snapshot (id_outlet);
CREATE INDEX IF NOT EXISTS idx_farming_ocs_priority       ON farming_outlet_snapshot (snapshot_date, priority);
CREATE INDEX IF NOT EXISTS idx_farming_ocs_status         ON farming_outlet_snapshot (snapshot_date, status);
CREATE INDEX IF NOT EXISTS idx_farming_ocs_segment        ON farming_outlet_snapshot (snapshot_date, segment);
CREATE INDEX IF NOT EXISTS idx_farming_ocs_layer_arpu     ON farming_outlet_snapshot (snapshot_date, layer_arpu);

CREATE TABLE IF NOT EXISTS farming_sync_log (
  id                BIGSERIAL PRIMARY KEY,
  sync_batch_id     TEXT,
  snapshot_date     DATE,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rows_received     INTEGER,
  rows_valid        INTEGER,
  rows_skipped      INTEGER,
  rows_inserted     INTEGER,
  rows_updated      INTEGER,
  rows_error        INTEGER,
  labels            JSONB,
  original_headers  JSONB,
  error_summary     JSONB,
  duration_ms       INTEGER,
  source_sheet      TEXT,
  status            TEXT CHECK (status IN ('success', 'partial', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_farming_sync_log_synced_at     ON farming_sync_log (synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_farming_sync_log_snapshot_date ON farming_sync_log (snapshot_date);

-- Follow-up operasional — "current state" per outlet (di-upsert, bukan
-- snapshot harian) supaya TIDAK terhapus saat sync ulang. Pola sama persis
-- dengan ekspedisi_outlet_status.
CREATE TABLE IF NOT EXISTS farming_outlet_followup (
  id_outlet         TEXT PRIMARY KEY,
  pic               TEXT,
  is_contacted      BOOLEAN NOT NULL DEFAULT FALSE,
  contacted_at      TIMESTAMPTZ,
  followup_status   TEXT NOT NULL DEFAULT 'OPEN'
                      CHECK (followup_status IN ('OPEN','CONTACTED','WAITING_RESPONSE','ACTION_PLANNED','RECOVERED','CLOSED')),
  followup_date     DATE,
  notes             TEXT,
  updated_by        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bricuser') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      farming_outlet_snapshot,
      farming_sync_log,
      farming_outlet_followup
      TO bricuser;
    GRANT USAGE, SELECT ON
      farming_outlet_snapshot_id_seq,
      farming_sync_log_id_seq
      TO bricuser;
  END IF;
END $$;
