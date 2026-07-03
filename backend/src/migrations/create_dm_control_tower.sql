-- DM Control Tower — raw data multi-bulan (register, aktivasi, transaksi).
--
-- Source of truth: 3 sheet raw dari Google Sheet "DM Control Tower"
--   (03_RAW_REGISTER_DIRECT, 04_RAW_AKTIVASI_DIRECT, 02_RAW_TRX_DIRECT).
-- Analytics (funnel, cohort H0-H3, data quality, segmentasi) dihitung di
-- BACKEND dari raw data ini — TIDAK bergantung pada formula/sheet turunan
-- lain di workbook (05_TRX_ENRICHED, 10_COHORT_H0_H3, dst).
--
-- Konsep multi-bulan: Google Sheet yang sama dipakai terus, user replace
-- data 3 sheet raw tiap bulan lalu sync dengan parameter bulan=YYYY-MM.
-- Sync bulan X HANYA menghapus/mengganti data bulan X di tabel terkait
-- (DELETE WHERE bulan=$1 lalu INSERT ulang, dibungkus 1 transaksi per
-- endpoint sync) — bulan lain tidak pernah tersentuh.
--
-- register & aktivasi: 1 baris per outlet per bulan (UNIQUE bulan+id_outlet).
-- trx: BANYAK baris per outlet per bulan (tidak dedup by id_outlet), dedup
-- pakai row_hash (hash dari isi baris) supaya baris identik yang terkirim
-- ulang tidak dobel, tapi 1 outlet tetap boleh punya banyak transaksi.

CREATE TABLE IF NOT EXISTS dm_ct_raw_register (
  id                SERIAL PRIMARY KEY,
  bulan             TEXT NOT NULL,
  id_outlet         TEXT NOT NULL,
  tanggal_register  DATE,
  row_data          JSONB NOT NULL,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bulan, id_outlet)
);

CREATE TABLE IF NOT EXISTS dm_ct_raw_aktivasi (
  id                SERIAL PRIMARY KEY,
  bulan             TEXT NOT NULL,
  id_outlet         TEXT NOT NULL,
  tanggal_aktivasi  DATE,
  row_data          JSONB NOT NULL,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bulan, id_outlet)
);

CREATE TABLE IF NOT EXISTS dm_ct_raw_trx (
  id                 SERIAL PRIMARY KEY,
  bulan              TEXT NOT NULL,
  id_outlet          TEXT NOT NULL,
  tanggal_transaksi  DATE,
  trx_count          NUMERIC DEFAULT 0,
  margin             NUMERIC DEFAULT 0,
  row_hash           TEXT NOT NULL,
  row_data           JSONB NOT NULL,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bulan, row_hash)
);

-- Config bulan (Prompt 3) — source of truth untuk period_start/period_end/
-- mature_cohort_end, diisi dari payload sync (Apps Script membacanya dari
-- sheet 01_CONFIG). PENTING untuk bulan berjalan: mature_cohort_end di sini
-- bisa mengikuti tanggal data yang benar-benar ada (mis. bulan baru jalan
-- sampai tgl 15 -> mature_cohort_end ~tgl 12), BUKAN "akhir kalender bulan -
-- 3 hari" yang salah untuk bulan yang belum selesai. Kalau baris untuk 1
-- bulan belum ada / field NULL, backend fallback ke perhitungan kalender
-- murni (lihat getPeriodBounds/resolveMonthConfig di warroom-dm-control-tower.js).
CREATE TABLE IF NOT EXISTS dm_ct_month_config (
  bulan             TEXT PRIMARY KEY,
  period_start      DATE,
  period_end        DATE,
  mature_cohort_end DATE,
  source_config     JSONB,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dm_ct_sync_log (
  id             SERIAL PRIMARY KEY,
  bulan          TEXT,
  source_type    TEXT,
  rows_received  INT DEFAULT 0,
  rows_inserted  INT DEFAULT 0,
  rows_skipped   INT DEFAULT 0,
  status         TEXT,
  error_message  TEXT,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index untuk filter per bulan / outlet / tanggal yang dipakai di analytics.
CREATE INDEX IF NOT EXISTS idx_dm_ct_register_bulan   ON dm_ct_raw_register (bulan);
CREATE INDEX IF NOT EXISTS idx_dm_ct_register_outlet  ON dm_ct_raw_register (id_outlet);
CREATE INDEX IF NOT EXISTS idx_dm_ct_register_tgl     ON dm_ct_raw_register (tanggal_register);
CREATE INDEX IF NOT EXISTS idx_dm_ct_register_rowdata ON dm_ct_raw_register USING GIN (row_data);

CREATE INDEX IF NOT EXISTS idx_dm_ct_aktivasi_bulan   ON dm_ct_raw_aktivasi (bulan);
CREATE INDEX IF NOT EXISTS idx_dm_ct_aktivasi_outlet  ON dm_ct_raw_aktivasi (id_outlet);
CREATE INDEX IF NOT EXISTS idx_dm_ct_aktivasi_tgl     ON dm_ct_raw_aktivasi (tanggal_aktivasi);
CREATE INDEX IF NOT EXISTS idx_dm_ct_aktivasi_rowdata ON dm_ct_raw_aktivasi USING GIN (row_data);

CREATE INDEX IF NOT EXISTS idx_dm_ct_trx_bulan        ON dm_ct_raw_trx (bulan);
CREATE INDEX IF NOT EXISTS idx_dm_ct_trx_outlet       ON dm_ct_raw_trx (id_outlet);
CREATE INDEX IF NOT EXISTS idx_dm_ct_trx_tgl          ON dm_ct_raw_trx (tanggal_transaksi);
CREATE INDEX IF NOT EXISTS idx_dm_ct_trx_rowdata      ON dm_ct_raw_trx USING GIN (row_data);
-- Kombinasi (bulan, id_outlet) dipakai berulang kali di analytics (JOIN/GROUP
-- BY per outlet per bulan) — index gabungan ini mempercepat query cohort/segmen.
CREATE INDEX IF NOT EXISTS idx_dm_ct_trx_bulan_outlet ON dm_ct_raw_trx (bulan, id_outlet);

CREATE INDEX IF NOT EXISTS idx_dm_ct_sync_log_bulan   ON dm_ct_sync_log (bulan);

GRANT ALL ON dm_ct_raw_register, dm_ct_raw_aktivasi, dm_ct_raw_trx, dm_ct_sync_log, dm_ct_month_config TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE
  dm_ct_raw_register_id_seq, dm_ct_raw_aktivasi_id_seq, dm_ct_raw_trx_id_seq, dm_ct_sync_log_id_seq
  TO bricuser;
