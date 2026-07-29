-- Balance Control Tower — lapisan integrasi forecast (OCBC Rekonsiliasi
-- sbg source of truth burn-rate/kebutuhan dana, Balance Control Tower
-- sbg control room). Additive only, TIDAK mengubah/menghapus data existing
-- (termasuk snapshot/policy OCBC yang sudah ada). Idempotent.

-- Satu-satunya kolom manual BARU (spec: "funding schedule/window where
-- available" tetap milik Finance) -- semua threshold dynamic (watch/
-- critical/emergency/reserve/forecast_required/recommended_topup/
-- sudden-drop/runway) dihitung, TIDAK butuh kolom baru di bct_balance_policies.
ALTER TABLE bct_balance_policies
  ADD COLUMN IF NOT EXISTS funding_window_hours NUMERIC(8,2) NULL;

-- Snapshot hasil forecast eksplisit (dibuat via POST .../forecast/refresh,
-- BUKAN tiap kali GET) -- dasar utk audit "log forecast generation/refresh",
-- "log status changes", "log recommendation changes" (bandingkan dgn baris
-- terakhir sebelum insert baris baru).
CREATE TABLE IF NOT EXISTS bct_forecast_snapshots (
  id                          BIGSERIAL PRIMARY KEY,
  bank_account_id             BIGINT NOT NULL REFERENCES bct_bank_accounts(id) ON DELETE CASCADE,
  status                      VARCHAR(30) NOT NULL,
  status_reason               TEXT NULL,
  effective_balance           NUMERIC(18,2) NULL,
  forecast_required_balance   NUMERIC(18,2) NULL,
  projected_balance_at_next_funding NUMERIC(18,2) NULL,
  estimated_runway_minutes    NUMERIC(18,2) NULL,
  average_burn_rate           NUMERIC(18,2) NULL,
  peak_burn_rate              NUMERIC(18,2) NULL,
  dynamic_reserve_balance     NUMERIC(18,2) NULL,
  dynamic_watch_threshold     NUMERIC(18,2) NULL,
  dynamic_critical_threshold  NUMERIC(18,2) NULL,
  dynamic_emergency_threshold NUMERIC(18,2) NULL,
  recommended_topup_amount    NUMERIC(18,2) NULL,
  recommended_topup_deadline  TIMESTAMPTZ NULL,
  forecast_confidence         INTEGER NULL,
  forecast_source             VARCHAR(50) NULL,
  forecast_available           BOOLEAN NOT NULL DEFAULT FALSE,
  raw_output                  JSONB NULL,
  created_by                  VARCHAR(100) NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bct_forecast_snapshots_bank_created ON bct_forecast_snapshots(bank_account_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_positive_funding_window') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_positive_funding_window
      CHECK (funding_window_hours IS NULL OR funding_window_hours > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_forecast_snapshots_confidence') THEN
    ALTER TABLE bct_forecast_snapshots ADD CONSTRAINT chk_bct_forecast_snapshots_confidence
      CHECK (forecast_confidence IS NULL OR (forecast_confidence >= 0 AND forecast_confidence <= 100));
  END IF;
END $$;
