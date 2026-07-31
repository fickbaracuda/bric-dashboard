-- War-Room Fastpay Global — versi multi-bulan (menggantikan fastpay_snapshot
-- yang kolomnya hardcode trx_mei/trx_jun, tidak bisa menampung bulan baru
-- tanpa menimpa data lama). Pola SAMA PERSIS dengan warroom_pa_lpd_outlet
-- (bulan + prev/curr generik) supaya bulan berikutnya (Agustus, dst) tidak
-- perlu migration baru lagi.
--
-- fastpay_snapshot (tabel lama) SENGAJA TIDAK dihapus/diubah — riwayat lama
-- tetap ada, tabel ini murni tambahan baru.
CREATE TABLE IF NOT EXISTS warroom_fastpay_outlet (
  id                   SERIAL PRIMARY KEY,
  bulan                VARCHAR(7) NOT NULL,  -- 'YYYY-MM', bulan CURRENT (curr) pada baris ini
  id_outlet            VARCHAR(50) NOT NULL,
  trx_prev             INTEGER NOT NULL DEFAULT 0,
  rev_prev             BIGINT NOT NULL DEFAULT 0,
  trx_curr             INTEGER NOT NULL DEFAULT 0,
  rev_curr             BIGINT NOT NULL DEFAULT 0,
  dev_trx              INTEGER NOT NULL DEFAULT 0,
  dev_rev              BIGINT NOT NULL DEFAULT 0,
  pct_trx_growth       NUMERIC NOT NULL DEFAULT 0,
  pct_rev_growth       NUMERIC NOT NULL DEFAULT 0,
  avg_rev_per_trx_prev BIGINT NOT NULL DEFAULT 0,
  avg_rev_per_trx_curr BIGINT NOT NULL DEFAULT 0,
  status               VARCHAR(20) NOT NULL DEFAULT 'stable', -- churned/new/rocket/growing/declining/stable
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bulan, id_outlet)
);

CREATE INDEX IF NOT EXISTS idx_warroom_fastpay_outlet_bulan ON warroom_fastpay_outlet (bulan);
