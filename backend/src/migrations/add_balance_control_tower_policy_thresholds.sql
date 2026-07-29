-- Balance Control Tower — lengkapi kolom policy (critical/emergency/reserve/
-- sudden-drop) yang ditemukan kurang saat setup production OCBC pertama.
-- Additive only, TIDAK mengubah/menghapus data existing (termasuk snapshot
-- OCBC id=1). Idempotent: aman dijalankan ulang.

ALTER TABLE bct_balance_policies
  ADD COLUMN IF NOT EXISTS critical_threshold NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS emergency_threshold NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS reserve_balance NUMERIC(18,2) NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sudden_drop_window_minutes INTEGER NULL,
  ADD COLUMN IF NOT EXISTS sudden_drop_amount_threshold NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS sudden_drop_percentage_threshold NUMERIC(6,2) NULL;

-- Transparansi sumber reserve per snapshot (SNAPSHOT = nilai eksplisit dari
-- request sync/manual, POLICY_DEFAULT = fallback dari bct_balance_policies
-- karena request tidak mengirim reserve_balance). Kolom baru, nullable —
-- tidak mengubah nilai available/held/pending/reserve/effective_balance
-- snapshot manapun yang sudah ada.
ALTER TABLE bct_balance_snapshots
  ADD COLUMN IF NOT EXISTS reserve_source VARCHAR(20) NULL;

-- Backfill HANYA label sumber utk baris lama (reserve_balance itu sendiri
-- TIDAK disentuh) — sebelum fitur fallback ini ada, reserve_balance selalu
-- diisi eksplisit dari body request (default JS 0 kalau tidak dikirim),
-- jadi secara historis sumbernya memang selalu 'SNAPSHOT'.
UPDATE bct_balance_snapshots SET reserve_source = 'SNAPSHOT' WHERE reserve_source IS NULL;

DO $$
BEGIN
  -- Nominal tidak boleh negatif (kolom lama & baru).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_nonneg_absolute_minimum') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_nonneg_absolute_minimum
      CHECK (absolute_minimum_balance IS NULL OR absolute_minimum_balance >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_nonneg_watch') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_nonneg_watch
      CHECK (watch_threshold IS NULL OR watch_threshold >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_nonneg_excess') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_nonneg_excess
      CHECK (excess_balance_threshold IS NULL OR excess_balance_threshold >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_nonneg_topup_rounding') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_nonneg_topup_rounding
      CHECK (topup_rounding_amount IS NULL OR topup_rounding_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_nonneg_critical') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_nonneg_critical
      CHECK (critical_threshold IS NULL OR critical_threshold >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_nonneg_emergency') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_nonneg_emergency
      CHECK (emergency_threshold IS NULL OR emergency_threshold >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_nonneg_reserve') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_nonneg_reserve
      CHECK (reserve_balance IS NULL OR reserve_balance >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_nonneg_sudden_drop_amount') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_nonneg_sudden_drop_amount
      CHECK (sudden_drop_amount_threshold IS NULL OR sudden_drop_amount_threshold >= 0);
  END IF;

  -- Percentage 0..100 (kolom lama safety_buffer_percentage & baru sudden_drop_percentage_threshold).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_pct_safety_buffer') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_pct_safety_buffer
      CHECK (safety_buffer_percentage IS NULL OR (safety_buffer_percentage >= 0 AND safety_buffer_percentage <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_pct_sudden_drop') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_pct_sudden_drop
      CHECK (sudden_drop_percentage_threshold IS NULL OR (sudden_drop_percentage_threshold >= 0 AND sudden_drop_percentage_threshold <= 100));
  END IF;

  -- Minute values positif (kolom lama stale_after_minutes & baru sudden_drop_window_minutes).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_positive_stale_minutes') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_positive_stale_minutes
      CHECK (stale_after_minutes IS NULL OR stale_after_minutes > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_positive_sudden_drop_window') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_positive_sudden_drop_window
      CHECK (sudden_drop_window_minutes IS NULL OR sudden_drop_window_minutes > 0);
  END IF;

  -- Urutan tingkat keparahan: emergency <= critical <= watch — HANYA saat semua nilai terkait terisi.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_order_emergency_critical') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_order_emergency_critical
      CHECK (emergency_threshold IS NULL OR critical_threshold IS NULL OR emergency_threshold <= critical_threshold);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_order_critical_watch') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_order_critical_watch
      CHECK (critical_threshold IS NULL OR watch_threshold IS NULL OR critical_threshold <= watch_threshold);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_snapshots_reserve_source') THEN
    ALTER TABLE bct_balance_snapshots ADD CONSTRAINT chk_bct_snapshots_reserve_source
      CHECK (reserve_source IS NULL OR reserve_source IN ('SNAPSHOT', 'POLICY_DEFAULT'));
  END IF;
END $$;
