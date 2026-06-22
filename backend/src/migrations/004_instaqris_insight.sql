-- ================================================================
-- Migration 004: InstaQRIS Insight — 4 tabel analitik
-- Jalankan sebagai user postgres atau superuser, lalu grant ke bricuser
-- ================================================================

-- ── Tabel 1: Master Outlet ──
CREATE TABLE IF NOT EXISTS iq_outlet (
  id            SERIAL PRIMARY KEY,
  id_outlet     VARCHAR(60)  UNIQUE NOT NULL,
  nama_merchant VARCHAR(200),
  tgl_registrasi DATE,
  tgl_aktivasi   DATE,
  paket          VARCHAR(30),
  kota           VARCHAR(120),
  provinsi       VARCHAR(120),
  mcc            VARCHAR(20),
  nama_kategori  VARCHAR(120),
  id_upline      VARCHAR(60),
  updated_at     TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_iq_outlet_upline   ON iq_outlet(id_upline);
CREATE INDEX IF NOT EXISTS idx_iq_outlet_provinsi ON iq_outlet(provinsi);
CREATE INDEX IF NOT EXISTS idx_iq_outlet_paket    ON iq_outlet(paket);

-- ── Tabel 2: Status Penerbitan QRIS ──
CREATE TABLE IF NOT EXISTS iq_qris (
  id         SERIAL PRIMARY KEY,
  tanggal    DATE,
  id_outlet  VARCHAR(60) NOT NULL,
  status     VARCHAR(50) NOT NULL,
  synced_at  TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_iq_qris_outlet_date ON iq_qris(id_outlet, tanggal);
CREATE INDEX IF NOT EXISTS idx_iq_qris_status  ON iq_qris(status);
CREATE INDEX IF NOT EXISTS idx_iq_qris_outlet  ON iq_qris(id_outlet);

-- ── Tabel 3: Transaksi Harian per Outlet ──
CREATE TABLE IF NOT EXISTS iq_trx (
  id            SERIAL PRIMARY KEY,
  tanggal       DATE    NOT NULL,
  id_outlet     VARCHAR(60) NOT NULL,
  jumlah_trx    BIGINT  DEFAULT 0,
  jumlah_omzet  NUMERIC(18,2) DEFAULT 0,
  synced_at     TIMESTAMP DEFAULT NOW(),
  UNIQUE(tanggal, id_outlet)
);
CREATE INDEX IF NOT EXISTS idx_iq_trx_outlet  ON iq_trx(id_outlet);
CREATE INDEX IF NOT EXISTS idx_iq_trx_tanggal ON iq_trx(tanggal);

-- ── Tabel 4: Rekap Rekrutmen Affiliate ──
CREATE TABLE IF NOT EXISTS iq_affiliate (
  id                       SERIAL PRIMARY KEY,
  tanggal                  DATE,
  id_upline                VARCHAR(60),
  id_outlet                VARCHAR(60),
  jumlah_downline_register INTEGER DEFAULT 0,
  komisi                   NUMERIC(18,2) DEFAULT 0,
  synced_at                TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_iq_affiliate_upline ON iq_affiliate(id_upline);
CREATE INDEX IF NOT EXISTS idx_iq_affiliate_outlet ON iq_affiliate(id_outlet);

-- ── Grants ──
GRANT ALL ON iq_outlet    TO bricuser;
GRANT ALL ON iq_qris      TO bricuser;
GRANT ALL ON iq_trx       TO bricuser;
GRANT ALL ON iq_affiliate TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE iq_outlet_id_seq    TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE iq_qris_id_seq      TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE iq_trx_id_seq       TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE iq_affiliate_id_seq TO bricuser;
