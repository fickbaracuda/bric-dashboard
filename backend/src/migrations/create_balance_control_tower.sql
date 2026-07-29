-- Balance Control Tower MVP — rekonsiliasi saldo bank (Winpay/BMS Retail).
-- Semua tabel di sini BARU (prefix bct_), TIDAK mengubah/menghapus tabel
-- recon_* atau finance_balance_requests yang sudah ada. Idempotent: aman
-- dijalankan ulang.

-- ── 1. Master bank/account ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bct_bank_accounts (
  id              BIGSERIAL PRIMARY KEY,
  bank_code       VARCHAR(30) NOT NULL,
  bank_name       VARCHAR(100) NOT NULL,
  account_number  VARCHAR(50) NOT NULL,
  account_name    VARCHAR(150) NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      VARCHAR(100) NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bct_bank_accounts_number ON bct_bank_accounts(bank_code, account_number);
CREATE INDEX IF NOT EXISTS idx_bct_bank_accounts_active ON bct_bank_accounts(is_active);

-- ── 2. Snapshot saldo ────────────────────────────────────────────────────
-- Semua nominal NUMERIC(18,2) — bukan floating point.
CREATE TABLE IF NOT EXISTS bct_balance_snapshots (
  id                  BIGSERIAL PRIMARY KEY,
  bank_account_id     BIGINT NOT NULL REFERENCES bct_bank_accounts(id) ON DELETE CASCADE,
  available_balance   NUMERIC(18,2) NOT NULL DEFAULT 0,
  held_balance        NUMERIC(18,2) NOT NULL DEFAULT 0,
  pending_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
  reserve_balance     NUMERIC(18,2) NOT NULL DEFAULT 0,
  effective_balance    NUMERIC(18,2) NOT NULL,
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source              VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  sync_status         VARCHAR(20) NOT NULL DEFAULT 'OK',
  created_by          VARCHAR(100) NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bct_snapshots_bank_captured ON bct_balance_snapshots(bank_account_id, captured_at DESC);

-- ── 3. Policy per bank ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bct_balance_policies (
  id                          BIGSERIAL PRIMARY KEY,
  bank_account_id             BIGINT NOT NULL UNIQUE REFERENCES bct_bank_accounts(id) ON DELETE CASCADE,
  absolute_minimum_balance    NUMERIC(18,2) NULL,
  watch_threshold             NUMERIC(18,2) NULL,
  excess_balance_threshold    NUMERIC(18,2) NULL,
  stale_after_minutes         INTEGER NULL,
  safety_buffer_percentage    NUMERIC(6,2) NULL,
  topup_rounding_amount       NUMERIC(18,2) NULL,
  is_active                   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by                  VARCHAR(100) NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 4. Top up workflow ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bct_topup_requests (
  id                      BIGSERIAL PRIMARY KEY,
  bank_account_id         BIGINT NOT NULL REFERENCES bct_bank_accounts(id) ON DELETE CASCADE,
  status                  VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  requested_amount        NUMERIC(18,2) NOT NULL,
  approved_amount         NUMERIC(18,2) NULL,
  actual_amount           NUMERIC(18,2) NULL,
  requester_user_id       BIGINT NULL,
  requester_username      VARCHAR(100) NULL,
  approver_user_id        BIGINT NULL,
  approver_username       VARCHAR(100) NULL,
  balance_before          NUMERIC(18,2) NULL,
  balance_after           NUMERIC(18,2) NULL,
  reason                  TEXT NULL,
  recommendation_source   VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  transfer_proof_path     TEXT NULL,
  notes                   TEXT NULL,
  requested_at            TIMESTAMPTZ NULL,
  approved_at             TIMESTAMPTZ NULL,
  rejected_at             TIMESTAMPTZ NULL,
  transferred_at          TIMESTAMPTZ NULL,
  balance_confirmed_at    TIMESTAMPTZ NULL,
  completed_at            TIMESTAMPTZ NULL,
  cancelled_at            TIMESTAMPTZ NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bct_topup_bank_status ON bct_topup_requests(bank_account_id, status);
CREATE INDEX IF NOT EXISTS idx_bct_topup_created ON bct_topup_requests(created_at DESC);

-- ── 5. Alert database-backed ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bct_alerts (
  id                  BIGSERIAL PRIMARY KEY,
  bank_account_id     BIGINT NOT NULL REFERENCES bct_bank_accounts(id) ON DELETE CASCADE,
  alert_type          VARCHAR(30) NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  message             TEXT NULL,
  owner               VARCHAR(100) NULL,
  acknowledged_by     VARCHAR(100) NULL,
  acknowledged_at     TIMESTAMPTZ NULL,
  resolved_by         VARCHAR(100) NULL,
  resolved_at         TIMESTAMPTZ NULL,
  snoozed_until       TIMESTAMPTZ NULL,
  reason              TEXT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Dedup: hanya 1 alert OPEN per (bank, alert_type). Partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bct_alerts_open_dedup
  ON bct_alerts(bank_account_id, alert_type) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_bct_alerts_status ON bct_alerts(status);

-- ── 6. Audit trail generik lintas entitas ────────────────────────────────
CREATE TABLE IF NOT EXISTS bct_audit_log (
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
CREATE INDEX IF NOT EXISTS idx_bct_audit_entity ON bct_audit_log(entity_type, entity_id, created_at DESC);

-- ── CHECK constraints (terpisah supaya idempotent — cek pg_constraint dulu) ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_snapshots_source') THEN
    ALTER TABLE bct_balance_snapshots ADD CONSTRAINT chk_bct_snapshots_source
      CHECK (source IN ('MANUAL', 'API', 'RECONCILIATION'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_snapshots_sync_status') THEN
    ALTER TABLE bct_balance_snapshots ADD CONSTRAINT chk_bct_snapshots_sync_status
      CHECK (sync_status IN ('OK', 'STALE', 'ERROR'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_topup_status') THEN
    ALTER TABLE bct_topup_requests ADD CONSTRAINT chk_bct_topup_status
      CHECK (status IN ('DRAFT','REQUESTED','APPROVED','TRANSFERRED','BALANCE_CONFIRMED','COMPLETED','REJECTED','CANCELLED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_topup_recommendation_source') THEN
    ALTER TABLE bct_topup_requests ADD CONSTRAINT chk_bct_topup_recommendation_source
      CHECK (recommendation_source IN ('MANUAL', 'AUTOMATIC'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_alerts_type') THEN
    ALTER TABLE bct_alerts ADD CONSTRAINT chk_bct_alerts_type
      CHECK (alert_type IN ('LOW_BALANCE','CRITICAL_BALANCE','EXCESS_BALANCE','DATA_STALE','SYNC_ERROR'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bct_alerts_status') THEN
    ALTER TABLE bct_alerts ADD CONSTRAINT chk_bct_alerts_status
      CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED'));
  END IF;
END $$;
