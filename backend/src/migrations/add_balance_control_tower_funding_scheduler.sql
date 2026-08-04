-- Balance Control Tower — Funding Scheduler Adjustment Assistant.
-- Additive only: 3 tabel BARU (prefix bct_) + 2 kolom toleransi baru di
-- bct_balance_policies (existing, reuse) + perluasan CHECK constraint
-- bct_alerts.alert_type (extend list, TIDAK menghapus nilai lama). TIDAK
-- mengubah/menghapus data existing manapun (snapshot, policy, topup, alert,
-- audit log OCBC yang sudah berjalan). Idempotent: aman dijalankan ulang.
--
-- funding_source_code BUKAN bct_bank_accounts -- BNI/BRI di sini adalah
-- SUMBER dana funding (siapa yang mentransfer), bukan rekening yang saldonya
-- dipantau (itu tetap bct_bank_accounts, saat ini cuma OCBC yang punya
-- adapter rekonsiliasi). VARCHAR bebas (bukan FK/ENUM) supaya sumber baru
-- bisa ditambah tanpa migration lagi.

-- ── 1. Hourly Balance Plan (baseline saldo per jam) ─────────────────────
CREATE TABLE IF NOT EXISTS bct_hourly_balance_plan (
  id                BIGSERIAL PRIMARY KEY,
  bank_account_id   BIGINT NOT NULL REFERENCES bct_bank_accounts(id) ON DELETE CASCADE,
  effective_from    DATE NOT NULL DEFAULT CURRENT_DATE,
  hour_of_day       SMALLINT NOT NULL,
  average_burn      NUMERIC(18,2) NULL,
  planned_balance   NUMERIC(18,2) NULL,
  tolerance         NUMERIC(18,2) NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by        VARCHAR(100) NULL,
  updated_by        VARCHAR(100) NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Satu baris AKTIF per (bank, jam) -- edit baseline = UPDATE baris aktif itu
-- (pola sama dgn PUT .../policy), bukan bikin baris baru tiap kali admin edit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bct_hourly_plan_active
  ON bct_hourly_balance_plan(bank_account_id, hour_of_day) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_bct_hourly_plan_bank ON bct_hourly_balance_plan(bank_account_id);

-- ── 2. Funding Scheduler Plan (baseline jadwal funding) ─────────────────
CREATE TABLE IF NOT EXISTS bct_funding_scheduler_plan (
  id                    BIGSERIAL PRIMARY KEY,
  bank_account_id       BIGINT NOT NULL REFERENCES bct_bank_accounts(id) ON DELETE CASCADE,
  effective_from        DATE NOT NULL DEFAULT CURRENT_DATE,
  scheduled_time        TIME NOT NULL,
  funding_source_code   VARCHAR(30) NOT NULL,
  scheduled_amount      NUMERIC(18,2) NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED',
  actual_amount         NUMERIC(18,2) NULL,
  actual_time           TIMESTAMPTZ NULL,
  note                  TEXT NULL,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_by            VARCHAR(100) NULL,
  updated_by            VARCHAR(100) NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bct_scheduler_plan_active
  ON bct_funding_scheduler_plan(bank_account_id, scheduled_time) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_bct_scheduler_plan_bank ON bct_funding_scheduler_plan(bank_account_id);

-- ── 3. Recommendation / Decision history (audit) ────────────────────────
CREATE TABLE IF NOT EXISTS bct_funding_recommendation_history (
  id                              BIGSERIAL PRIMARY KEY,
  bank_account_id                 BIGINT NOT NULL REFERENCES bct_bank_accounts(id) ON DELETE CASCADE,
  calculated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_hour                    SMALLINT NULL,
  actual_balance                  NUMERIC(18,2) NULL,
  planned_balance                 NUMERIC(18,2) NULL,
  variance                        NUMERIC(18,2) NULL,
  variance_status                 VARCHAR(20) NULL,
  next_scheduler_id               BIGINT NULL REFERENCES bct_funding_scheduler_plan(id) ON DELETE SET NULL,
  next_scheduler_time             TIME NULL,
  next_scheduler_source           VARCHAR(30) NULL,
  projected_balance_before_next   NUMERIC(18,2) NULL,
  target_balance_after_next       NUMERIC(18,2) NULL,
  existing_scheduled_amount       NUMERIC(18,2) NULL,
  required_funding                NUMERIC(18,2) NULL,
  adjustment_amount               NUMERIC(18,2) NULL,
  recommendation                  VARCHAR(30) NOT NULL,
  reason                          TEXT NULL,
  acknowledged_by                 VARCHAR(100) NULL,
  acknowledged_at                 TIMESTAMPTZ NULL,
  note                            TEXT NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bct_funding_reco_bank_calc ON bct_funding_recommendation_history(bank_account_id, calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bct_funding_reco_ack ON bct_funding_recommendation_history(bank_account_id, acknowledged_at DESC) WHERE acknowledged_at IS NOT NULL;

-- ── 4. Toleransi configurable (REUSE bct_balance_policies, bukan tabel baru) ──
ALTER TABLE bct_balance_policies
  ADD COLUMN IF NOT EXISTS funding_plan_variance_tolerance NUMERIC(18,2) NOT NULL DEFAULT 10000000,
  ADD COLUMN IF NOT EXISTS funding_scheduler_tolerance     NUMERIC(18,2) NOT NULL DEFAULT 10000000;

-- ── 5. Perluas bct_alerts.alert_type (dedupe alert reuse tabel existing) ─
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_hourly_plan_hour_range') THEN
    ALTER TABLE bct_hourly_balance_plan ADD CONSTRAINT chk_bct_hourly_plan_hour_range
      CHECK (hour_of_day >= 0 AND hour_of_day <= 23);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_hourly_plan_nonneg') THEN
    ALTER TABLE bct_hourly_balance_plan ADD CONSTRAINT chk_bct_hourly_plan_nonneg
      CHECK ((average_burn IS NULL OR average_burn >= 0) AND (planned_balance IS NULL OR planned_balance >= 0) AND (tolerance IS NULL OR tolerance >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_scheduler_plan_status') THEN
    ALTER TABLE bct_funding_scheduler_plan ADD CONSTRAINT chk_bct_scheduler_plan_status
      CHECK (status IN ('SCHEDULED','CONFIRMED','CANCELLED','ADJUSTED','COMPLETED','MISSED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_scheduler_plan_nonneg') THEN
    ALTER TABLE bct_funding_scheduler_plan ADD CONSTRAINT chk_bct_scheduler_plan_nonneg
      CHECK (scheduled_amount >= 0 AND (actual_amount IS NULL OR actual_amount >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_funding_reco_recommendation') THEN
    ALTER TABLE bct_funding_recommendation_history ADD CONSTRAINT chk_bct_funding_reco_recommendation
      CHECK (recommendation IN ('CANCEL','REDUCE','KEEP','ADD','NO_UPCOMING_SCHEDULER','INSUFFICIENT_DATA','DATA_STALE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_nonneg_funding_variance_tolerance') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_nonneg_funding_variance_tolerance
      CHECK (funding_plan_variance_tolerance >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_policies_nonneg_funding_scheduler_tolerance') THEN
    ALTER TABLE bct_balance_policies ADD CONSTRAINT chk_bct_policies_nonneg_funding_scheduler_tolerance
      CHECK (funding_scheduler_tolerance >= 0);
  END IF;

  -- alert_type -- drop constraint lama (kalau ada) & pasang ulang dgn daftar
  -- yang sudah diperluas (superset -- TIDAK menghapus satu pun nilai lama,
  -- baris bct_alerts existing tetap valid tanpa perlu di-backfill/diubah).
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_alerts_type') THEN
    ALTER TABLE bct_alerts DROP CONSTRAINT chk_bct_alerts_type;
  END IF;
  ALTER TABLE bct_alerts ADD CONSTRAINT chk_bct_alerts_type
    CHECK (alert_type IN (
      'LOW_BALANCE','CRITICAL_BALANCE','EXCESS_BALANCE','DATA_STALE','SYNC_ERROR',
      'ABOVE_PLAN','BELOW_PLAN','SCHEDULER_CANCEL','SCHEDULER_REDUCE','SCHEDULER_ADD','SCHEDULER_MISSED'
    ));
END $$;

-- ── 6. Seed baseline BNI Multibiller terbaru — HANYA untuk bank OCBC (satu-
--       satunya rekening ter-monitor saat ini). idempotent via ON CONFLICT
--       pada partial unique index yang sama dgn di atas -- aman dijalankan
--       ulang, TIDAK menimpa baseline yang sudah pernah diedit admin (baris
--       aktif sudah ada -> DO NOTHING, edit lanjutan lewat endpoint admin).
INSERT INTO bct_hourly_balance_plan (bank_account_id, effective_from, hour_of_day, average_burn, planned_balance, created_by)
SELECT b.id, CURRENT_DATE, v.hour_of_day, v.average_burn, v.planned_balance, 'system_seed_bni_multibiller'
FROM bct_bank_accounts b
CROSS JOIN (VALUES
  (0,  0::numeric,          200000000::numeric),
  (1,  0,                   300000000),
  (2,  0,                   300000000),
  (3,  0,                   300000000),
  (4,  0,                   300000000),
  (5,  2496000,             297504000),
  (6,  17870000,            279634000),
  (7,  31749000,            347885000),
  (8,  62097592,            285787408),
  (9,  75359401,            360428007),
  (10, 55028666,            305399341),
  (11, 83295661,            372103680),
  (12, 43902449,            328201231),
  (13, 42800000,            435401231),
  (14, 40048000,            395353231),
  (15, 29966423,            515386808),
  (16, 50990000,            464396808),
  (17, 63790500,            550606308),
  (18, 67614997,            482991311),
  (19, 34885500,            598105811),
  (20, 14988841,            583116970),
  (21, 22548123,            560568847),
  (22, 1300127,             559268720),
  (23, 0,                   559268720)
) AS v(hour_of_day, average_burn, planned_balance)
WHERE b.bank_code = 'OCBC'
ON CONFLICT (bank_account_id, hour_of_day) WHERE is_active = TRUE DO NOTHING;

INSERT INTO bct_funding_scheduler_plan (bank_account_id, effective_from, scheduled_time, funding_source_code, scheduled_amount, status, created_by)
SELECT b.id, CURRENT_DATE, v.scheduled_time::time, v.funding_source_code, v.scheduled_amount, 'SCHEDULED', 'system_seed_bni_multibiller'
FROM bct_bank_accounts b
CROSS JOIN (VALUES
  ('01:00', 'BRI', 100000000::numeric),
  ('07:00', 'BNI', 100000000),
  ('09:00', 'BNI', 150000000),
  ('11:00', 'BNI', 150000000),
  ('13:00', 'BNI', 150000000),
  ('15:00', 'BNI', 150000000),
  ('17:00', 'BNI', 150000000),
  ('19:00', 'BNI', 150000000)
) AS v(scheduled_time, funding_source_code, scheduled_amount)
WHERE b.bank_code = 'OCBC'
ON CONFLICT (bank_account_id, scheduled_time) WHERE is_active = TRUE DO NOTHING;
