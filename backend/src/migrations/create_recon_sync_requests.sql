-- "Sync Now" (kompromi) untuk Rekonsiliasi OCBC & Mandiri.
--
-- Apps Script Web App TIDAK BISA dipanggil langsung dari dashboard (Google
-- Workspace domain bm.co.id mewajibkan login Google untuk request eksternal
-- ke Web App, terlepas dari setting "Anyone" — kebijakan admin Workspace,
-- bukan bug, TIDAK BISA di-bypass dari kode). Sebaliknya, panggilan dari
-- Apps Script KE backend kita (outbound dari Google) selalu bisa jalan —
-- itulah cara sync biasa (pushReconciliationOcbc/Mandiri) bekerja.
--
-- Jadi tombol "Sync Now" TIDAK memanggil Apps Script sama sekali. Ia hanya
-- mencatat "ada permintaan sync" di tabel ini. Trigger checker Apps Script
-- yang SUDAH jalan tiap 1 menit (checkAndSyncIfDirtyReconciliation{Ocbc,Mandiri})
-- ikut mengecek tabel ini tiap kali jalan — kalau ada permintaan yang lebih
-- baru dari sync terakhir, ia sync SEKARANG juga (skip debounce 30 detik).
-- Realistis: ~1-2 menit dari klik tombol sampai data ter-update, BUKAN instan.
CREATE TABLE IF NOT EXISTS recon_sync_requests (
  id            BIGSERIAL PRIMARY KEY,
  bank_code     TEXT        NOT NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_recon_sync_requests_bank_code ON recon_sync_requests(bank_code, requested_at DESC);

GRANT SELECT, INSERT ON recon_sync_requests TO bricuser;
GRANT USAGE, SELECT ON recon_sync_requests_id_seq TO bricuser;
