-- Balance Control Tower — mesin kalkulasi operasional intraday (FA Action
-- Layer). Additive only, TIDAK mengubah/menghapus data existing (policy,
-- snapshot, forecast history OCBC yang sudah ada).
--
-- Field baru di bct_balance_policies -- SEMUA opsional/nullable (default
-- NULL = belum dikonfigurasi -> CONFIGURATION_REQUIRED, TIDAK ada angka
-- produksi yang dikarang):
--   burn_window_minutes        : window operasional utama (5/15/30/60)
--   topup_lead_time_minutes    : waktu top up dari mulai proses sampai dana masuk
--   critical_margin_minutes    : margin tambahan di atas lead time utk CRITICAL
--   watch_buffer_minutes       : lebar zona WATCH di atas CRITICAL
--   safety_buffer_type         : 'FIXED' atau 'PERCENTAGE' (bukan keduanya sekaligus)
--   safety_buffer_fixed_amount : dipakai kalau type='FIXED' (Rupiah)
--   (safety_buffer_percentage sudah ada dari migration sebelumnya, dipakai kalau type='PERCENTAGE')
--   (stale_after_minutes sudah ada, DIPAKAI ULANG sbg ambang freshness posisi saldo)

ALTER TABLE bct_balance_policies
  ADD COLUMN IF NOT EXISTS burn_window_minutes INTEGER NULL,
  ADD COLUMN IF NOT EXISTS topup_lead_time_minutes INTEGER NULL,
  ADD COLUMN IF NOT EXISTS critical_margin_minutes INTEGER NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watch_buffer_minutes INTEGER NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS safety_buffer_type VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS safety_buffer_fixed_amount NUMERIC(18,2) NULL;

-- Field audit/versioning di bct_forecast_snapshots (REUSE tabel existing,
-- BUKAN tabel baru -- sesuai instruksi "do not create redundant tables").
ALTER TABLE bct_forecast_snapshots
  ADD COLUMN IF NOT EXISTS calculation_version VARCHAR(30) NULL,
  ADD COLUMN IF NOT EXISTS usable_balance NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS burn_window_minutes_used INTEGER NULL,
  ADD COLUMN IF NOT EXISTS burn_rate_per_minute NUMERIC(18,4) NULL,
  ADD COLUMN IF NOT EXISTS usable_runway_minutes NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS zero_balance_runway_minutes NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS lead_time_need NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS safety_buffer_amount NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS safe_target_balance NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS operational_status VARCHAR(30) NULL,
  ADD COLUMN IF NOT EXISTS data_freshness_status VARCHAR(20) NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_burn_window_minutes') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_burn_window_minutes
      CHECK (burn_window_minutes IS NULL OR burn_window_minutes IN (5, 15, 30, 60));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_lead_time_positive') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_lead_time_positive
      CHECK (topup_lead_time_minutes IS NULL OR topup_lead_time_minutes >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_critical_margin_nonneg') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_critical_margin_nonneg
      CHECK (critical_margin_minutes IS NULL OR critical_margin_minutes >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_watch_buffer_nonneg') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_watch_buffer_nonneg
      CHECK (watch_buffer_minutes IS NULL OR watch_buffer_minutes >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_safety_buffer_type') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_safety_buffer_type
      CHECK (safety_buffer_type IS NULL OR safety_buffer_type IN ('FIXED', 'PERCENTAGE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_safety_buffer_fixed_nonneg') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_safety_buffer_fixed_nonneg
      CHECK (safety_buffer_fixed_amount IS NULL OR safety_buffer_fixed_amount >= 0);
  END IF;
END $$;
