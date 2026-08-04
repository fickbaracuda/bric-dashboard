-- Balance & Funding — fitur BARU, standalone dari Balance Control Tower lama.
-- TIDAK menyentuh/reuse tabel bct_* atau recon_* sama sekali sebagai tulisan
-- (hanya BACA recon_* via bankBalanceAdapters.js, read-only). Semua tabel di
-- sini prefix `balance_funding_`, sama sekali baru. Idempotent: aman
-- dijalankan ulang (CREATE TABLE/INDEX IF NOT EXISTS).
--
-- Canonical bank_code yang didukung (spec section 2):
--   OCBC, MANDIRI, BRI, BRI_BIFAST, BNI, BCA
-- (bukan FK ke tabel bank manapun -- 6 bank ini VALID via CHECK constraint,
-- bank baru butuh migration tambahan kalau nanti diperluas -- BUKAN via
-- reuse bct_bank_accounts sama sekali per larangan spec section 11).

-- ── A. Plan (1 plan aktif per bank, per opening_balance/timezone) ──────────
CREATE TABLE IF NOT EXISTS balance_funding_plans (
  id              BIGSERIAL PRIMARY KEY,
  bank_code       VARCHAR(20) NOT NULL,
  plan_name       VARCHAR(100) NOT NULL,
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to    DATE NULL,
  opening_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  timezone        VARCHAR(30) NOT NULL DEFAULT 'Asia/Jakarta',
  source          VARCHAR(20) NOT NULL DEFAULT 'MANUAL', -- MANUAL/GOOGLE_SHEET/CSV/API (spec section 38)
  variance_tolerance   NUMERIC(18,2) NULL, -- NULL = pakai default modul (spec section 16: configurable per bank)
  scheduler_tolerance  NUMERIC(18,2) NULL, -- NULL = pakai default modul (spec section 25)
  stale_after_minutes  INTEGER NULL,       -- NULL = pakai default modul (spec section 41)
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      VARCHAR(100) NULL,
  updated_by      VARCHAR(100) NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Satu plan AKTIF per bank (model MVP: 1 plan per bank, bukan multi-plan
-- paralel) -- admin edit = update plan aktif itu (bukan bikin versi baru
-- tiap kali), pola sama dgn hourly plan di Funding Scheduler Assistant BCT
-- TAPI ditulis ulang independen (tidak ada import lintas modul).
CREATE UNIQUE INDEX IF NOT EXISTS uq_balance_funding_plans_active_bank
  ON balance_funding_plans(bank_code) WHERE is_active = TRUE;

-- ── B. Hourly Plan (24 baris per plan) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS balance_funding_hourly_plan (
  id                BIGSERIAL PRIMARY KEY,
  plan_id           BIGINT NOT NULL REFERENCES balance_funding_plans(id) ON DELETE CASCADE,
  hour_of_day       SMALLINT NOT NULL,
  hour_label        VARCHAR(10) NULL, -- mis. '05:00' -- display only, dihitung ulang dari hour_of_day kalau kosong
  nominal_average   NUMERIC(18,2) NULL,
  transaksi_trf     NUMERIC(18,2) NULL,
  dana_disiapkan    NUMERIC(18,2) NULL,
  planned_balance   NUMERIC(18,2) NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_balance_funding_hourly_plan_hour ON balance_funding_hourly_plan(plan_id, hour_of_day);

-- ── C. Funding Schedules ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS balance_funding_schedules (
  id                    BIGSERIAL PRIMARY KEY,
  plan_id               BIGINT NOT NULL REFERENCES balance_funding_plans(id) ON DELETE CASCADE,
  target_bank_code      VARCHAR(20) NOT NULL, -- bank yang MENERIMA dana (pemilik plan_id, tapi disimpan eksplisit utk query langsung)
  funding_source_code   VARCHAR(20) NOT NULL, -- bank ASAL dana -- BOLEH BEDA dari target_bank_code (spec section 9)
  scheduled_time        TIME NOT NULL,
  scheduled_amount       NUMERIC(18,2) NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED',
  actual_amount         NUMERIC(18,2) NULL,
  actual_time           TIMESTAMPTZ NULL,
  effective_date        DATE NULL,
  recurrence_rule       VARCHAR(50) NULL,
  note                  TEXT NULL,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_by            VARCHAR(100) NULL,
  updated_by            VARCHAR(100) NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_balance_funding_schedules_active
  ON balance_funding_schedules(plan_id, scheduled_time) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_balance_funding_schedules_target ON balance_funding_schedules(target_bank_code);

-- ── D. Recommendation / Decision history ────────────────────────────────
CREATE TABLE IF NOT EXISTS balance_funding_recommendations (
  id                        BIGSERIAL PRIMARY KEY,
  bank_code                 VARCHAR(20) NOT NULL,
  plan_id                   BIGINT NULL REFERENCES balance_funding_plans(id) ON DELETE SET NULL,
  calculated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_date             DATE NULL,
  actual_balance            NUMERIC(18,2) NULL,
  actual_balance_source     VARCHAR(100) NULL,
  actual_balance_timestamp  TIMESTAMPTZ NULL,
  current_hour              SMALLINT NULL,
  planned_balance           NUMERIC(18,2) NULL,
  variance_amount           NUMERIC(18,2) NULL,
  variance_pct              NUMERIC(10,4) NULL,
  variance_status           VARCHAR(20) NULL,
  next_schedule_id          BIGINT NULL REFERENCES balance_funding_schedules(id) ON DELETE SET NULL,
  projected_balance         NUMERIC(18,2) NULL,
  required_funding          NUMERIC(18,2) NULL,
  existing_schedule_amount  NUMERIC(18,2) NULL,
  adjustment_amount         NUMERIC(18,2) NULL,
  recommendation            VARCHAR(30) NOT NULL,
  reason                    TEXT NULL,
  acknowledged_at           TIMESTAMPTZ NULL,
  acknowledged_by           VARCHAR(100) NULL,
  acknowledgement_note      TEXT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_balance_funding_reco_bank_calc ON balance_funding_recommendations(bank_code, calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_balance_funding_reco_ack ON balance_funding_recommendations(bank_code, acknowledged_at DESC) WHERE acknowledged_at IS NOT NULL;

-- ── E. Alerts ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS balance_funding_alerts (
  id                  BIGSERIAL PRIMARY KEY,
  bank_code           VARCHAR(20) NOT NULL,
  business_date       DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')::date,
  alert_type          VARCHAR(30) NOT NULL,
  severity            VARCHAR(20) NOT NULL DEFAULT 'INFO',
  message             TEXT NULL,
  recommendation_id   BIGINT NULL REFERENCES balance_funding_recommendations(id) ON DELETE SET NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at     TIMESTAMPTZ NULL,
  acknowledged_by     VARCHAR(100) NULL
);
-- Dedupe: max 1 alert OPEN per (bank, alert_type) -- business_date TIDAK ikut
-- key dedupe (mengikuti pola bct_alerts existing: alert "hidup" selama
-- kondisinya masih relevan, dedupe on-refresh, bukan per-hari).
CREATE UNIQUE INDEX IF NOT EXISTS uq_balance_funding_alerts_open_dedup
  ON balance_funding_alerts(bank_code, alert_type) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_balance_funding_alerts_status ON balance_funding_alerts(status);

-- ── F. Audit log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS balance_funding_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  entity_type     VARCHAR(30) NOT NULL,
  entity_id       BIGINT NOT NULL,
  action          VARCHAR(50) NOT NULL,
  actor_user_id   BIGINT NULL,
  actor_username  VARCHAR(100) NULL,
  before_data     JSONB NULL,
  after_data      JSONB NULL,
  notes           TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_balance_funding_audit_entity ON balance_funding_audit_log(entity_type, entity_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  balance_funding_plans, balance_funding_hourly_plan, balance_funding_schedules,
  balance_funding_recommendations, balance_funding_alerts, balance_funding_audit_log
  TO bricuser;
GRANT USAGE, SELECT ON
  balance_funding_plans_id_seq, balance_funding_hourly_plan_id_seq, balance_funding_schedules_id_seq,
  balance_funding_recommendations_id_seq, balance_funding_alerts_id_seq, balance_funding_audit_log_id_seq
  TO bricuser;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_plans_bank_code') THEN
    ALTER TABLE balance_funding_plans ADD CONSTRAINT chk_bf_plans_bank_code
      CHECK (bank_code IN ('OCBC','MANDIRI','BRI','BRI_BIFAST','BNI','BCA'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_plans_source') THEN
    ALTER TABLE balance_funding_plans ADD CONSTRAINT chk_bf_plans_source
      CHECK (source IN ('MANUAL','GOOGLE_SHEET','CSV','API'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_plans_tolerances_nonneg') THEN
    ALTER TABLE balance_funding_plans ADD CONSTRAINT chk_bf_plans_tolerances_nonneg
      CHECK ((variance_tolerance IS NULL OR variance_tolerance >= 0)
         AND (scheduler_tolerance IS NULL OR scheduler_tolerance >= 0)
         AND (stale_after_minutes IS NULL OR stale_after_minutes > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_hourly_plan_hour_range') THEN
    ALTER TABLE balance_funding_hourly_plan ADD CONSTRAINT chk_bf_hourly_plan_hour_range
      CHECK (hour_of_day >= 0 AND hour_of_day <= 23);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_schedules_target_bank') THEN
    ALTER TABLE balance_funding_schedules ADD CONSTRAINT chk_bf_schedules_target_bank
      CHECK (target_bank_code IN ('OCBC','MANDIRI','BRI','BRI_BIFAST','BNI','BCA'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_schedules_source_bank') THEN
    ALTER TABLE balance_funding_schedules ADD CONSTRAINT chk_bf_schedules_source_bank
      CHECK (funding_source_code IN ('OCBC','MANDIRI','BRI','BRI_BIFAST','BNI','BCA'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_schedules_status') THEN
    ALTER TABLE balance_funding_schedules ADD CONSTRAINT chk_bf_schedules_status
      CHECK (status IN ('SCHEDULED','CONFIRMED','COMPLETED','CANCELLED','ADJUSTED','MISSED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_schedules_nonneg') THEN
    ALTER TABLE balance_funding_schedules ADD CONSTRAINT chk_bf_schedules_nonneg
      CHECK (scheduled_amount >= 0 AND (actual_amount IS NULL OR actual_amount >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_reco_bank_code') THEN
    ALTER TABLE balance_funding_recommendations ADD CONSTRAINT chk_bf_reco_bank_code
      CHECK (bank_code IN ('OCBC','MANDIRI','BRI','BRI_BIFAST','BNI','BCA'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_reco_recommendation') THEN
    ALTER TABLE balance_funding_recommendations ADD CONSTRAINT chk_bf_reco_recommendation
      CHECK (recommendation IN ('CANCEL','REDUCE','KEEP','ADD','NO_UPCOMING_SCHEDULER','INSUFFICIENT_DATA','BALANCE_UNAVAILABLE','BALANCE_STALE','BALANCE_UNVERIFIED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_reco_variance_status') THEN
    ALTER TABLE balance_funding_recommendations ADD CONSTRAINT chk_bf_reco_variance_status
      CHECK (variance_status IS NULL OR variance_status IN ('ABOVE_PLAN','ON_PLAN','BELOW_PLAN','INSUFFICIENT_DATA'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_alerts_bank_code') THEN
    ALTER TABLE balance_funding_alerts ADD CONSTRAINT chk_bf_alerts_bank_code
      CHECK (bank_code IN ('OCBC','MANDIRI','BRI','BRI_BIFAST','BNI','BCA'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_alerts_type') THEN
    ALTER TABLE balance_funding_alerts ADD CONSTRAINT chk_bf_alerts_type
      CHECK (alert_type IN ('BALANCE_ABOVE_PLAN','BALANCE_BELOW_PLAN','SCHEDULER_CANCEL','SCHEDULER_REDUCE','SCHEDULER_ADD','SCHEDULER_MISSED','BALANCE_STALE','BALANCE_UNAVAILABLE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_alerts_severity') THEN
    ALTER TABLE balance_funding_alerts ADD CONSTRAINT chk_bf_alerts_severity
      CHECK (severity IN ('INFO','WARNING','CRITICAL'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bf_alerts_status') THEN
    ALTER TABLE balance_funding_alerts ADD CONSTRAINT chk_bf_alerts_status
      CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED'));
  END IF;
END $$;

-- ── Seed: contoh awal OCBC (spec section 13, INITIAL EXAMPLE/SEED — bukan
--     data final, admin bisa edit lewat Configuration UI kapan saja tanpa
--     ubah kode) — idempotent, tidak menimpa plan yang sudah pernah dibuat.
INSERT INTO balance_funding_plans (bank_code, plan_name, opening_balance, source, is_active, created_by)
VALUES ('OCBC', 'OCBC', 500000000, 'MANUAL', TRUE, 'system_seed_initial_example')
ON CONFLICT (bank_code) WHERE is_active = TRUE DO NOTHING;

INSERT INTO balance_funding_hourly_plan (plan_id, hour_of_day, nominal_average, planned_balance)
SELECT p.id, v.hour_of_day, v.nominal_average, v.planned_balance
FROM balance_funding_plans p
CROSS JOIN (VALUES
  (0,  0::numeric,          500000000::numeric),
  (1,  0,                   500000000),
  (2,  0,                   500000000),
  (3,  0,                   500000000),
  (4,  0,                   500000000),
  (5,  391753951,           1108246049),
  (6,  675579580,           432666469),
  (7,  794445706,           1138220763),
  (8,  1001874250,          136346513),
  (9,  1240465673,          1145880840),
  (10, 1041480069,          104400771),
  (11, 840729635,           1263671136),
  (12, 708424795,           555246341),
  (13, 622507132,           1432739209),
  (14, 776126657,           656612552),
  (15, 887029290,           1519583262),
  (16, 812829129,           706754133),
  (17, 811551732,           1395202401),
  (18, 913988116,           1481214285),
  (19, 933510925,           1547703360),
  (20, 587002659,           960700701),
  (21, 302632295,           758068406),
  (22, 282875321,           475193085),
  (23, 0,                   475193085)
) AS v(hour_of_day, nominal_average, planned_balance)
WHERE p.bank_code = 'OCBC' AND p.is_active = TRUE
ON CONFLICT (plan_id, hour_of_day) DO NOTHING;

INSERT INTO balance_funding_schedules (plan_id, target_bank_code, funding_source_code, scheduled_time, scheduled_amount, status)
SELECT p.id, 'OCBC', v.funding_source_code, v.scheduled_time::time, v.scheduled_amount, 'SCHEDULED'
FROM balance_funding_plans p
CROSS JOIN (VALUES
  ('05:00', 'MANDIRI', 1000000000::numeric),
  ('07:00', 'MANDIRI', 1500000000),
  ('09:00', 'MANDIRI', 2250000000),
  ('11:00', 'MANDIRI', 2000000000),
  ('13:00', 'MANDIRI', 1500000000),
  ('15:00', 'MANDIRI', 1750000000),
  ('17:00', 'MANDIRI', 1500000000),
  ('18:00', 'MANDIRI', 1000000000),
  ('19:00', 'BRI',     1000000000),
  ('21:00', 'BRI',     100000000)
) AS v(scheduled_time, funding_source_code, scheduled_amount)
WHERE p.bank_code = 'OCBC' AND p.is_active = TRUE
ON CONFLICT (plan_id, scheduled_time) WHERE is_active = TRUE DO NOTHING;
