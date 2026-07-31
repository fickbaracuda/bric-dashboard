-- WAR-ROOM Ekspedisi — redesign skema: normalized (long format) menggantikan
-- ekspedisi_snapshot yang hardcode 3 kolom per bulan (trx_apr/mei/jun).
-- Masalah lama: setiap bulan baru (Jul, Ags, dst) butuh ALTER TABLE + ubah
-- backend SQL + ubah Apps Script secara manual — dan itu yang bikin sync
-- berhenti begitu kolom JUL ditambahkan di sheet (Apps Script lama tidak
-- tahu ke mana harus baca kolom baru).
--
-- Skema baru: 1 baris = 1 (tanggal, id_outlet, bulan). Bulan baru otomatis
-- masuk tanpa ubah schema — tinggal insert baris dengan bulan='2026-08' dst.
-- tanggal = tanggal sync (hari berjalan), bulan = bulan yang direpresentasikan
-- trx/revenue itu (bisa multiple bulan per tanggal sync yang sama).
--
-- ekspedisi_snapshot (tabel lama) TIDAK dihapus — dibiarkan sebagai arsip/
-- rollback safety net, cuma tidak dipakai lagi oleh backend.

CREATE TABLE IF NOT EXISTS ekspedisi_monthly (
  tanggal    DATE        NOT NULL,
  id_outlet  VARCHAR(30) NOT NULL,
  bulan      VARCHAR(7)  NOT NULL,  -- 'YYYY-MM'
  trx        INTEGER     NOT NULL DEFAULT 0,
  revenue    BIGINT      NOT NULL DEFAULT 0,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tanggal, id_outlet, bulan)
);

CREATE INDEX IF NOT EXISTS idx_ekspedisi_monthly_tanggal ON ekspedisi_monthly(tanggal);
CREATE INDEX IF NOT EXISTS idx_ekspedisi_monthly_bulan   ON ekspedisi_monthly(bulan);
CREATE INDEX IF NOT EXISTS idx_ekspedisi_monthly_outlet  ON ekspedisi_monthly(id_outlet);

GRANT ALL ON ekspedisi_monthly TO bricuser;

-- Backfill dari ekspedisi_snapshot (wide) — non-destruktif, idempotent
-- (ON CONFLICT DO NOTHING supaya aman dijalankan ulang). Bulan Apr/Mei/Jun
-- diasumsikan tahun yang sama dengan tanggal snapshot-nya (valid untuk
-- rentang data yang ada sekarang, April-Juni 2026).
INSERT INTO ekspedisi_monthly (tanggal, id_outlet, bulan, trx, revenue, synced_at)
SELECT tanggal, id_outlet, TO_CHAR(tanggal, 'YYYY') || '-04', trx_apr, rev_apr, synced_at
FROM ekspedisi_snapshot
ON CONFLICT (tanggal, id_outlet, bulan) DO NOTHING;

INSERT INTO ekspedisi_monthly (tanggal, id_outlet, bulan, trx, revenue, synced_at)
SELECT tanggal, id_outlet, TO_CHAR(tanggal, 'YYYY') || '-05', trx_mei, rev_mei, synced_at
FROM ekspedisi_snapshot
ON CONFLICT (tanggal, id_outlet, bulan) DO NOTHING;

INSERT INTO ekspedisi_monthly (tanggal, id_outlet, bulan, trx, revenue, synced_at)
SELECT tanggal, id_outlet, TO_CHAR(tanggal, 'YYYY') || '-06', trx_jun, rev_jun, synced_at
FROM ekspedisi_snapshot
ON CONFLICT (tanggal, id_outlet, bulan) DO NOTHING;
