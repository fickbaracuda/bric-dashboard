-- WAR-ROOM Fastpay Global snapshot table
CREATE TABLE IF NOT EXISTS fastpay_snapshot (
  id                   SERIAL         PRIMARY KEY,
  tanggal              DATE           NOT NULL,
  id_outlet            VARCHAR(30)    NOT NULL,
  trx_mei              INTEGER        NOT NULL DEFAULT 0,
  rev_mei              BIGINT         NOT NULL DEFAULT 0,
  trx_jun              INTEGER        NOT NULL DEFAULT 0,
  rev_jun              BIGINT         NOT NULL DEFAULT 0,
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

CREATE INDEX IF NOT EXISTS idx_fastpay_tanggal ON fastpay_snapshot(tanggal);
CREATE INDEX IF NOT EXISTS idx_fastpay_outlet  ON fastpay_snapshot(id_outlet);
CREATE INDEX IF NOT EXISTS idx_fastpay_status  ON fastpay_snapshot(status);

GRANT ALL ON fastpay_snapshot TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE fastpay_snapshot_id_seq TO bricuser;
