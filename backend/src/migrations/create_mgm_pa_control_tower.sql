-- MGM PA — PB Lifecycle & Productivity Control Tower
-- Tabel BARU, terpisah dari legacy mgm_aktivasi/mgm_registrasi (TIDAK dihapus,
-- TIDAK disentuh). Key pakai (periode, id_outlet) / (periode, id_aktifasi) agar
-- tahun ikut tersimpan (legacy mgm_* pakai bulan text 'YYYY-MM' saja).

CREATE TABLE IF NOT EXISTS mgm_pa_registrasi (
  periode DATE NOT NULL,
  id_outlet TEXT NOT NULL,
  upline TEXT,
  nama_pemilik TEXT,
  notelp_pemilik TEXT,
  tipe_outlet TEXT,
  balance NUMERIC(20,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN,
  nama_kota TEXT,
  nama_propinsi TEXT,
  tanggal_registrasi DATE,
  tanggal_aktifasi DATE,
  source_sheet TEXT NOT NULL,
  source_row INTEGER,
  phone_precision_risk BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (periode, id_outlet)
);

CREATE TABLE IF NOT EXISTS mgm_pa_aktivasi (
  periode DATE NOT NULL,
  id_outlet TEXT NOT NULL,
  upline TEXT,
  nama_pemilik TEXT,
  notelp_pemilik TEXT,
  tipe_outlet TEXT,
  balance NUMERIC(20,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN,
  nama_kota TEXT,
  nama_propinsi TEXT,
  tanggal_aktifasi DATE,
  trx BIGINT NOT NULL DEFAULT 0,
  rev NUMERIC(20,2) NOT NULL DEFAULT 0,
  source_sheet TEXT NOT NULL,
  source_row INTEGER,
  phone_precision_risk BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (periode, id_outlet)
);

CREATE TABLE IF NOT EXISTS mgm_pa_aktivasi_detail (
  periode DATE NOT NULL,
  id_aktifasi TEXT NOT NULL,
  id_outlet TEXT,
  nama_group TEXT,
  nama_pemilik TEXT,
  is_active BOOLEAN,
  upline TEXT,
  pembayaran_via TEXT,
  biaya_aktifasi NUMERIC(20,2) NOT NULL DEFAULT 0,
  tipe_outlet TEXT,
  id_tipe_outlet TEXT,
  biaya_aktifasi_2 NUMERIC(20,2) NOT NULL DEFAULT 0,
  hpp NUMERIC(20,2) NOT NULL DEFAULT 0,
  ongkos_kirim NUMERIC(20,2) NOT NULL DEFAULT 0,
  fee_upline NUMERIC(20,2) NOT NULL DEFAULT 0,
  komisi_aktifasi NUMERIC(20,2) NOT NULL DEFAULT 0,
  source_sheet TEXT NOT NULL,
  source_row INTEGER,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (periode, id_aktifasi)
);

CREATE TABLE IF NOT EXISTS mgm_pa_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  periode DATE NOT NULL,
  source_sheet TEXT NOT NULL,
  cutoff_date DATE,
  registrasi_count INTEGER NOT NULL DEFAULT 0,
  aktivasi_count INTEGER NOT NULL DEFAULT 0,
  aktivasi_detail_count INTEGER NOT NULL DEFAULT 0,
  quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'success',
  error_message TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mgm_pa_actions (
  id BIGSERIAL PRIMARY KEY,
  periode DATE NOT NULL,
  id_outlet TEXT NOT NULL,
  upline TEXT,
  action_type TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','resolved','dismissed')),
  owner TEXT,
  due_date DATE,
  next_followup DATE,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (periode, id_outlet, action_type)
);

CREATE TABLE IF NOT EXISTS mgm_pa_pb_targets (
  periode DATE NOT NULL,
  upline TEXT NOT NULL,
  target_registrasi INTEGER,
  target_aktivasi INTEGER,
  target_transacting INTEGER,
  target_revenue NUMERIC(20,2),
  target_fee_upline NUMERIC(20,2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (periode, upline)
);

CREATE INDEX IF NOT EXISTS idx_mgm_pa_reg_periode_upline
  ON mgm_pa_registrasi (periode, upline);
CREATE INDEX IF NOT EXISTS idx_mgm_pa_reg_periode_tanggal
  ON mgm_pa_registrasi (periode, tanggal_registrasi);
CREATE INDEX IF NOT EXISTS idx_mgm_pa_reg_outlet
  ON mgm_pa_registrasi (id_outlet);

CREATE INDEX IF NOT EXISTS idx_mgm_pa_act_periode_upline
  ON mgm_pa_aktivasi (periode, upline);
CREATE INDEX IF NOT EXISTS idx_mgm_pa_act_periode_tanggal
  ON mgm_pa_aktivasi (periode, tanggal_aktifasi);
CREATE INDEX IF NOT EXISTS idx_mgm_pa_act_outlet
  ON mgm_pa_aktivasi (id_outlet);

CREATE INDEX IF NOT EXISTS idx_mgm_pa_detail_periode_upline
  ON mgm_pa_aktivasi_detail (periode, upline);
CREATE INDEX IF NOT EXISTS idx_mgm_pa_detail_outlet
  ON mgm_pa_aktivasi_detail (periode, id_outlet);
CREATE INDEX IF NOT EXISTS idx_mgm_pa_detail_payment
  ON mgm_pa_aktivasi_detail (periode, pembayaran_via);

CREATE INDEX IF NOT EXISTS idx_mgm_pa_actions_queue
  ON mgm_pa_actions (periode, status, priority, updated_at DESC);
