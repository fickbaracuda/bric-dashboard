-- QRIS Issuance Control Tower — 4 tabel JSONB (1 per sheet), primary key id_outlet.
-- Beda dari WAR-ROOM lain: sheet ini bukan snapshot bulanan, tapi live state
-- seluruh outlet yang pernah masuk pipeline QRIS. Upsert per id_outlet, bukan
-- insert-per-bulan. row_data menyimpan raw row dari Apps Script apa adanya
-- (key = header sheet asli: ID_Outlet, Tanggal_Registrasi, dst.) supaya bisa
-- langsung dipakai joinQrisPipeline() di warroom-qris-control-tower.js tanpa
-- transformasi balik.

CREATE TABLE IF NOT EXISTS qris_ctrl_merchant (
  id_outlet  VARCHAR(30) PRIMARY KEY,
  row_data   JSONB NOT NULL,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qris_ctrl_kyckym (
  id_outlet  VARCHAR(30) PRIMARY KEY,
  row_data   JSONB NOT NULL,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qris_ctrl_verifikasi_op (
  id_outlet  VARCHAR(30) PRIMARY KEY,
  row_data   JSONB NOT NULL,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qris_ctrl_pten (
  id_outlet  VARCHAR(30) PRIMARY KEY,
  row_data   JSONB NOT NULL,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT ALL ON qris_ctrl_merchant, qris_ctrl_kyckym, qris_ctrl_verifikasi_op, qris_ctrl_pten TO bricuser;
