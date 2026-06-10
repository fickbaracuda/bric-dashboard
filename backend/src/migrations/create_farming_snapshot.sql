-- WAR-ROOM Farming snapshot table
-- Kolom: periode comparison (Mei 1-N vs Jun 1-N) + Mei Full sebagai baseline
CREATE TABLE IF NOT EXISTS farming_snapshot (
  id                   SERIAL         PRIMARY KEY,
  tanggal              DATE           NOT NULL,
  id_outlet            VARCHAR(30)    NOT NULL,
  trx_mei_full         INTEGER        NOT NULL DEFAULT 0,
  rev_mei_full         BIGINT         NOT NULL DEFAULT 0,
  trx_mei_period       INTEGER        NOT NULL DEFAULT 0,
  rev_mei_period       BIGINT         NOT NULL DEFAULT 0,
  trx_jun_period       INTEGER        NOT NULL DEFAULT 0,
  rev_jun_period       BIGINT         NOT NULL DEFAULT 0,
  dev_trx              INTEGER        NOT NULL DEFAULT 0,
  dev_rev              BIGINT         NOT NULL DEFAULT 0,
  pct_trx_growth       NUMERIC(10,2)  NOT NULL DEFAULT 0,
  pct_rev_growth       NUMERIC(10,2)  NOT NULL DEFAULT 0,
  avg_rev_per_trx_mei  BIGINT         NOT NULL DEFAULT 0,
  avg_rev_per_trx_jun  BIGINT         NOT NULL DEFAULT 0,
  status               VARCHAR(20)    CHECK (status IN ('rocket','growing','stable','declining','new','churned')),
  synced_at            TIMESTAMPTZ    DEFAULT NOW(),
  UNIQUE(tanggal, id_outlet)
);

CREATE INDEX IF NOT EXISTS idx_farming_tanggal ON farming_snapshot(tanggal);
CREATE INDEX IF NOT EXISTS idx_farming_outlet  ON farming_snapshot(id_outlet);
CREATE INDEX IF NOT EXISTS idx_farming_status  ON farming_snapshot(status);

GRANT ALL ON farming_snapshot TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE farming_snapshot_id_seq TO bricuser;
