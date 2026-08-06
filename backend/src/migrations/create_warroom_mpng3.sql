-- War-Room MPNG3 (Payment Agent) — Report MPNG3, PBB, PKB
--
-- Domain BARU, TERPISAH dari war-room lain. Mengikuti pola arsitektur
-- ASDP/LPD/BUMDes versi Payment Agent (multi-bulan, sheet-per-bulan
-- bertambah tiap bulan, key (bulan, id_outlet)) — lihat
-- backend/src/routes/warroom-pa-lpd.js dan warroom-bumdes.js sebagai
-- referensi persis. Jangan disatukan dengan war-room lain.
--
-- Sumber: Google Sheet "Report MPNG3, PBB, PKB", 1 sheet per bulan
-- (contoh: "Agustus"), tabel detail outlet mulai baris 14 (header),
-- data baris 15+, 14 kolom A-N.
CREATE TABLE IF NOT EXISTS warroom_mpng3_outlet (
  id                  BIGSERIAL PRIMARY KEY,
  bulan               VARCHAR(7) NOT NULL,   -- 'YYYY-MM'
  id_outlet           VARCHAR(30) NOT NULL,
  upline              VARCHAR(30),
  nama_pemilik        VARCHAR(150),
  notelp_pemilik      VARCHAR(30),
  tipe_outlet         VARCHAR(80),
  nama_kota           VARCHAR(100),
  tanggal_registrasi  DATE,
  tanggal_aktifasi    DATE,
  trx_prev            INTEGER NOT NULL DEFAULT 0,
  rev_prev            NUMERIC(18,2) NOT NULL DEFAULT 0,
  trx_curr            INTEGER NOT NULL DEFAULT 0,
  rev_curr            NUMERIC(18,2) NOT NULL DEFAULT 0,
  dev_trx             INTEGER NOT NULL DEFAULT 0,
  dev_rev             NUMERIC(18,2) NOT NULL DEFAULT 0,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bulan, id_outlet)
);
CREATE INDEX IF NOT EXISTS idx_mpng3_outlet_bulan   ON warroom_mpng3_outlet (bulan);
CREATE INDEX IF NOT EXISTS idx_mpng3_outlet_upline  ON warroom_mpng3_outlet (upline);
CREATE INDEX IF NOT EXISTS idx_mpng3_outlet_kota    ON warroom_mpng3_outlet (nama_kota);

-- Grant mengikuti pola existing BRIC (user aplikasi: bricuser). Aman
-- dijalankan berulang (idempotent) — tidak menyentuh password/role lain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bricuser') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON warroom_mpng3_outlet TO bricuser;
    GRANT USAGE, SELECT ON warroom_mpng3_outlet_id_seq TO bricuser;
  END IF;
END $$;
