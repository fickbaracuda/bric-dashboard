-- WAR-ROOM Ekspedisi — snapshot harian per outlet
CREATE TABLE IF NOT EXISTS ekspedisi_snapshot (
  id            SERIAL PRIMARY KEY,
  tanggal       DATE        NOT NULL,
  id_outlet     VARCHAR(30) NOT NULL,
  trx_apr       INTEGER     DEFAULT 0,
  rev_apr       BIGINT      DEFAULT 0,
  trx_mei       INTEGER     DEFAULT 0,
  rev_mei       BIGINT      DEFAULT 0,
  trx_jun       INTEGER     DEFAULT 0,
  rev_jun       BIGINT      DEFAULT 0,
  dev_trx_apr_mei  INTEGER,
  dev_rev_apr_mei  BIGINT,
  dev_trx_mei_jun  INTEGER,
  dev_rev_mei_jun  BIGINT,
  pct_trx_growth   DECIMAL(10,2),
  pct_rev_growth   DECIMAL(10,2),
  status        VARCHAR(20),
  synced_at     TIMESTAMP   DEFAULT NOW(),
  UNIQUE(tanggal, id_outlet)
);

CREATE INDEX IF NOT EXISTS idx_ekspedisi_tanggal ON ekspedisi_snapshot(tanggal);
CREATE INDEX IF NOT EXISTS idx_ekspedisi_outlet  ON ekspedisi_snapshot(id_outlet);

GRANT ALL ON ekspedisi_snapshot TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE ekspedisi_snapshot_id_seq TO bricuser;
