-- Migration 005: Warroom Builder
-- Tambahkan setelah table existing. Tidak mengubah/menghapus table existing.

-- ── Warrooms (definisi utama) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wb_warrooms (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(200) NOT NULL,
  description       TEXT,
  business_unit     VARCHAR(100) NOT NULL,
  business_model    VARCHAR(50)  NOT NULL,
  entity_type       VARCHAR(100) NOT NULL,
  entity_label      VARCHAR(100) DEFAULT 'Entity',
  warroom_type_code VARCHAR(100),
  plugin_codes      JSONB DEFAULT '[]',
  color             VARCHAR(20)  DEFAULT '#1D9E75',
  score             SMALLINT,
  score_status      VARCHAR(20),
  dashboard_config  JSONB DEFAULT '{}',
  last_generated_at TIMESTAMPTZ,
  last_synced_at    TIMESTAMPTZ,
  created_by        VARCHAR(100),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── Sheet Sources ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wb_sheet_sources (
  id              SERIAL PRIMARY KEY,
  warroom_id      INTEGER NOT NULL REFERENCES wb_warrooms(id) ON DELETE CASCADE,
  sheet_url       TEXT NOT NULL,
  sheet_id        VARCHAR(200),
  gid             VARCHAR(50) DEFAULT '0',
  csv_url         TEXT,
  header_rows     SMALLINT DEFAULT 1,
  detected_day    VARCHAR(50),
  detected_period VARCHAR(50),
  raw_preview     JSONB,
  detected_cols   JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Column Mappings ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wb_column_mappings (
  id             SERIAL PRIMARY KEY,
  warroom_id     INTEGER NOT NULL REFERENCES wb_warrooms(id) ON DELETE CASCADE,
  original_col   VARCHAR(300) NOT NULL,
  standard_field VARCHAR(100),
  confidence     NUMERIC(4,3) DEFAULT 0,
  data_type      VARCHAR(20)  DEFAULT 'text',
  period_tag     VARCHAR(50),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Snapshots ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wb_snapshots (
  id               SERIAL PRIMARY KEY,
  warroom_id       INTEGER NOT NULL REFERENCES wb_warrooms(id) ON DELETE CASCADE,
  snapshot_date    DATE NOT NULL,
  snapshot_type    VARCHAR(20) DEFAULT 'daily',
  period_label     VARCHAR(100),
  cutoff_date      DATE,
  day_counter      SMALLINT,
  month_total_days SMALLINT,
  raw_data         JSONB,
  parsed_data      JSONB,
  summary          JSONB,
  insights         JSONB,
  alerts_json      JSONB,
  row_count        INTEGER,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Alerts ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wb_alerts (
  id              SERIAL PRIMARY KEY,
  warroom_id      INTEGER NOT NULL REFERENCES wb_warrooms(id) ON DELETE CASCADE,
  snapshot_id     INTEGER REFERENCES wb_snapshots(id) ON DELETE SET NULL,
  alert_type      VARCHAR(100) NOT NULL,
  level           VARCHAR(20)  NOT NULL DEFAULT 'info',
  title           VARCHAR(300) NOT NULL,
  message         TEXT,
  metric_value    NUMERIC,
  threshold_value NUMERIC,
  is_resolved     BOOLEAN DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Actions ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wb_actions (
  id             SERIAL PRIMARY KEY,
  warroom_id     INTEGER NOT NULL REFERENCES wb_warrooms(id) ON DELETE CASCADE,
  snapshot_id    INTEGER REFERENCES wb_snapshots(id) ON DELETE SET NULL,
  alert_id       INTEGER REFERENCES wb_alerts(id) ON DELETE SET NULL,
  action_type    VARCHAR(50)  NOT NULL DEFAULT 'monitor',
  priority       SMALLINT DEFAULT 3,
  entity_id      VARCHAR(100),
  entity_name    VARCHAR(300),
  issue          TEXT,
  recommendation TEXT,
  pic            VARCHAR(100),
  due_date       DATE,
  status         VARCHAR(30) DEFAULT 'open',
  note           TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Import Logs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wb_import_logs (
  id             SERIAL PRIMARY KEY,
  warroom_id     INTEGER REFERENCES wb_warrooms(id) ON DELETE SET NULL,
  action         VARCHAR(50),
  status         VARCHAR(20),
  rows_processed INTEGER,
  error_message  TEXT,
  duration_ms    INTEGER,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_wb_snapshots_warroom    ON wb_snapshots(warroom_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_wb_alerts_warroom       ON wb_alerts(warroom_id, is_resolved, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wb_actions_warroom      ON wb_actions(warroom_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_wb_actions_status       ON wb_actions(status);
CREATE INDEX IF NOT EXISTS idx_wb_column_mappings_wrid ON wb_column_mappings(warroom_id);

-- ── Grants ───────────────────────────────────────────────────────────────
GRANT ALL ON wb_warrooms, wb_sheet_sources, wb_column_mappings,
             wb_snapshots, wb_alerts, wb_actions, wb_import_logs TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE
  wb_warrooms_id_seq, wb_sheet_sources_id_seq, wb_column_mappings_id_seq,
  wb_snapshots_id_seq, wb_alerts_id_seq, wb_actions_id_seq,
  wb_import_logs_id_seq TO bricuser;
