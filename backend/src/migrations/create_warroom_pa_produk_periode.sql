-- War-Room PA Produk — versi multi-bulan (menggantikan pa_produk_snapshot yang
-- kolomnya hardcode ke bulan kalender (mat_apr/mat_mei/mat_jun), tidak bisa
-- menampung bulan baru tanpa menimpa data lama).
--
-- PA Produk butuh JENDELA 3 BULAN (bukan cuma 2 seperti Fastpay/Farming) --
-- dipakai utk deteksi "turun 2 periode berturut-turut" (m2 > m1 > curr).
-- m2 = 2 bulan sebelum `bulan`, m1 = 1 bulan sebelum `bulan` (dulu selalu
-- "Mei"), curr = `bulan` itu sendiri (dulu selalu "Juni"). Generik --
-- bulan berikutnya tinggal geser jendela, tidak perlu kolom/migration baru.
--
-- pa_produk_snapshot & pa_produk_totals (tabel lama) SENGAJA TIDAK
-- dihapus/diubah -- riwayat lama tetap ada, ini murni tambahan baru.
CREATE TABLE IF NOT EXISTS warroom_pa_produk_periode (
  id            SERIAL PRIMARY KEY,
  bulan         VARCHAR(7) NOT NULL,   -- 'YYYY-MM', bulan CURRENT (curr) pada baris ini
  produk        VARCHAR(100) NOT NULL,
  periode_start DATE,
  periode_end   DATE,
  mat_m2        INTEGER NOT NULL DEFAULT 0,
  trx_m2        INTEGER NOT NULL DEFAULT 0,
  rev_m2        BIGINT  NOT NULL DEFAULT 0,
  mat_m1        INTEGER NOT NULL DEFAULT 0,
  trx_m1        INTEGER NOT NULL DEFAULT 0,
  rev_m1        BIGINT  NOT NULL DEFAULT 0,
  mat_curr      INTEGER NOT NULL DEFAULT 0,
  trx_curr      INTEGER NOT NULL DEFAULT 0,
  rev_curr      BIGINT  NOT NULL DEFAULT 0,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bulan, produk)
);
CREATE INDEX IF NOT EXISTS idx_warroom_pa_produk_periode_bulan ON warroom_pa_produk_periode (bulan);

-- MAT resmi dari baris TOTAL sheet (dulu row 24) -- terpisah dari SUM(mat_curr)
-- krn MAT punya definisi de-dup khusus yang tidak sama dengan SUM per produk.
CREATE TABLE IF NOT EXISTS warroom_pa_produk_totals (
  bulan     VARCHAR(7) PRIMARY KEY,
  mat_m2    INTEGER NOT NULL DEFAULT 0,
  mat_m1    INTEGER NOT NULL DEFAULT 0,
  mat_curr  INTEGER NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
