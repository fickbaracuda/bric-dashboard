-- Rekonsiliasi OCBC — Coverage-Aware Reconciliation + Rolling Bank Archive.
--
-- Masalah: DATA BANK OCBC di Google Sheet dibatasi 5.000 baris mutasi
-- TERBARU (bukan seluruh histori). Karena 1 transaksi = 2 baris (principal +
-- fee), 5.000 baris cuma mewakili ~2.500 transaksi. Transaksi FP yang lebih
-- tua dari cakupan itu SEBELUMNYA berpotensi salah diklasifikasi FP_ONLY /
-- PENDING_BANK / NEED_REVIEW, padahal bank-nya belum tentu gagal — datanya
-- memang sudah tergeser keluar window 5.000 baris.
--
-- Solusi: (1) kolom coverage_status terpisah dari recon_status (tidak
-- menambah status ke-12), (2) recon_bank_archive menyimpan SETIAP baris bank
-- yang pernah diterima secara kumulatif (fingerprint-deduped, tidak pernah
-- dihapus), supaya window 5.000 baris yang bergeser tidak menghilangkan
-- kemampuan matching untuk transaksi yang lebih tua.
--
-- Idempotent: aman dijalankan ulang (ADD COLUMN IF NOT EXISTS / CREATE ... IF
-- NOT EXISTS). Semua kolom baru nullable/berdefault aman — tidak mengubah
-- baris yang sudah ada.

-- ── recon_results: recon_status boleh NULL utk baris yang coverage_status-nya
-- bukan IN_BANK_COVERAGE (OUTSIDE_BANK_COVERAGE / BOUNDARY_PARTIAL — bukan
-- exception, jadi tidak boleh dipaksa masuk salah satu dari 11 status yang
-- ada). Natural key upsert (batch_id, id_transaksi, reference_no) TIDAK
-- bergantung pada recon_status, jadi relaksasi ini aman utk mekanisme upsert.
ALTER TABLE recon_results ALTER COLUMN recon_status DROP NOT NULL;

ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS coverage_status          TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS coverage_reason          TEXT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS is_actionable            BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS eligible_for_match_rate  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS bank_snapshot_id         BIGINT;
ALTER TABLE recon_results ADD COLUMN IF NOT EXISTS archive_match            BOOLEAN NOT NULL DEFAULT false;

-- ── recon_bank_transactions: presisi jam-menit (bukan cuma DATE) diperlukan
-- utk menghitung boundary minute snapshot 5.000 baris. Kolom account_no
-- sudah ada (ditambahkan migration Mandiri, dipakai bersama).
ALTER TABLE recon_bank_transactions ADD COLUMN IF NOT EXISTS transaction_date_time TIMESTAMPTZ;

-- ── recon_bank_snapshots: 1 baris ringkasan cakupan per sync OCBC (bukan
-- per baris bank) — dipakai backend utk menghitung trusted_coverage_start
-- tanpa perlu menghitung ulang dari raw setiap kali analytics diminta.
CREATE TABLE IF NOT EXISTS recon_bank_snapshots (
  id                      BIGSERIAL PRIMARY KEY,
  batch_id                BIGINT REFERENCES recon_sync_batches(id) ON DELETE CASCADE,
  bank_code               TEXT NOT NULL DEFAULT 'OCBC',
  account_no              TEXT,
  synced_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_count               INTEGER,
  unique_reference_count  INTEGER,
  source_limit            INTEGER NOT NULL DEFAULT 5000,
  is_truncated            BOOLEAN NOT NULL DEFAULT false,
  snapshot_oldest_time    TIMESTAMPTZ,
  snapshot_newest_time    TIMESTAMPTZ,
  trusted_coverage_start  TIMESTAMPTZ,
  coverage_end            TIMESTAMPTZ,
  raw_metadata            JSONB
);
CREATE INDEX IF NOT EXISTS idx_recon_bank_snapshots_batch ON recon_bank_snapshots(batch_id);
CREATE INDEX IF NOT EXISTS idx_recon_bank_snapshots_bank  ON recon_bank_snapshots(bank_code, synced_at DESC);

-- ── recon_bank_archive: penyimpanan KUMULATIF setiap baris mutasi bank yang
-- pernah diterima, tidak pernah dihapus saat resync. row_fingerprint dipakai
-- sebagai identitas stabil (BUKAN source_row_number, karena posisi baris
-- bisa berubah begitu window 5.000 baris Sheets bergeser) — SHA-256 dari
-- kombinasi bank_code|account_no|transaction_date_time|value_date|
-- reference_no|description|debit|credit|balance (semua dinormalisasi
-- sebelum di-hash, lihat computeBankRowFingerprint() di
-- warroom-reconciliation.js).
CREATE TABLE IF NOT EXISTS recon_bank_archive (
  id                    BIGSERIAL PRIMARY KEY,
  bank_code             TEXT NOT NULL,
  account_no            TEXT,
  business_date         DATE,
  transaction_date_time TIMESTAMPTZ,
  value_date            DATE,
  reference_no          TEXT,
  cheque_no             TEXT,
  description           TEXT,
  debit                 NUMERIC(20,2),
  credit                NUMERIC(20,2),
  balance               NUMERIC(20,2),
  row_fingerprint       TEXT NOT NULL,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_snapshot_id    BIGINT REFERENCES recon_bank_snapshots(id) ON DELETE SET NULL,
  source_row_number     INTEGER,
  raw_data              JSONB,
  UNIQUE (row_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_recon_bank_archive_lookup    ON recon_bank_archive(bank_code, account_no, reference_no);
CREATE INDEX IF NOT EXISTS idx_recon_bank_archive_reference ON recon_bank_archive(reference_no);
CREATE INDEX IF NOT EXISTS idx_recon_bank_archive_date      ON recon_bank_archive(business_date);
CREATE INDEX IF NOT EXISTS idx_recon_bank_archive_txn_time  ON recon_bank_archive(transaction_date_time);
CREATE INDEX IF NOT EXISTS idx_recon_bank_archive_snapshot  ON recon_bank_archive(source_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_recon_results_coverage_status ON recon_results(coverage_status);
CREATE INDEX IF NOT EXISTS idx_recon_results_is_actionable   ON recon_results(is_actionable);

GRANT SELECT, INSERT, UPDATE, DELETE ON recon_bank_archive, recon_bank_snapshots TO bricuser;
GRANT USAGE, SELECT ON recon_bank_archive_id_seq, recon_bank_snapshots_id_seq TO bricuser;
