-- WAR-ROOM Hunter — Migration
-- Run on VPS: psql -U bricuser -d bricdb -f hunter_tables.sql

CREATE TABLE IF NOT EXISTS hunter_d1 (
  id          SERIAL PRIMARY KEY,
  bulan       VARCHAR(7) NOT NULL,
  upline      VARCHAR(50),
  id_loket    VARCHAR(50),
  nama        VARCHAR(200),
  no_telp     VARCHAR(30),
  type_loket  VARCHAR(100),
  saldo       NUMERIC DEFAULT 0,
  status      VARCHAR(10),
  kota        VARCHAR(200),
  propinsi    VARCHAR(100),
  tgl_reg     DATE,
  trx         BIGINT DEFAULT 0,
  rev_trx     NUMERIC DEFAULT 0,
  rev_act     NUMERIC DEFAULT 0,
  synced_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hunter_d1_bulan  ON hunter_d1(bulan);
CREATE INDEX IF NOT EXISTS idx_hunter_d1_upline ON hunter_d1(bulan, upline);
GRANT ALL ON hunter_d1 TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE hunter_d1_id_seq TO bricuser;

CREATE TABLE IF NOT EXISTS hunter_d2 (
  id          SERIAL PRIMARY KEY,
  bulan       VARCHAR(7) NOT NULL,
  id_outlet   VARCHAR(50),
  jml_trx     BIGINT DEFAULT 0,
  margin      NUMERIC DEFAULT 0,
  synced_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hunter_d2_bulan ON hunter_d2(bulan);
GRANT ALL ON hunter_d2 TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE hunter_d2_id_seq TO bricuser;

CREATE TABLE IF NOT EXISTS hunter_d3 (
  id               SERIAL PRIMARY KEY,
  bulan            VARCHAR(7) NOT NULL,
  id_aktifasi      BIGINT,
  id_outlet        VARCHAR(50),
  nama_group       VARCHAR(100),
  nama_pemilik     VARCHAR(200),
  is_active        SMALLINT DEFAULT 0,
  upline           VARCHAR(50),
  pembayaran_via   VARCHAR(50),
  biaya_aktifasi   NUMERIC DEFAULT 0,
  tipe_outlet      VARCHAR(100),
  id_tipe_outlet   INTEGER,
  biaya_aktifasi_2 NUMERIC DEFAULT 0,
  hpp              NUMERIC DEFAULT 0,
  ongkos_kirim     NUMERIC DEFAULT 0,
  fee_upline       NUMERIC DEFAULT 0,
  komisi_aktifasi  NUMERIC DEFAULT 0,
  synced_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hunter_d3_bulan  ON hunter_d3(bulan);
CREATE INDEX IF NOT EXISTS idx_hunter_d3_outlet ON hunter_d3(bulan, id_outlet);
GRANT ALL ON hunter_d3 TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE hunter_d3_id_seq TO bricuser;
