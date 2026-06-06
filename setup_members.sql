CREATE TABLE IF NOT EXISTS members (
  id            SERIAL PRIMARY KEY,
  unit          VARCHAR(50) DEFAULT 'winme_instaqris',
  nama          VARCHAR(100) NOT NULL,
  posisi        VARCHAR(20) NOT NULL CHECK (posisi IN ('leader','tim')),
  fungsi        TEXT,
  avatar_warna  VARCHAR(20) DEFAULT '#7F77DD',
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS member_targets (
  id              SERIAL PRIMARY KEY,
  member_id       INTEGER REFERENCES members(id) ON DELETE CASCADE,
  nama_target     VARCHAR(200) NOT NULL,
  key_result      VARCHAR(300),
  target_revenue  NUMERIC(20,2) DEFAULT 0,
  periode         VARCHAR(20) DEFAULT 'JUN_2026',
  urutan          INTEGER DEFAULT 1,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS member_pencapaian (
  id                  SERIAL PRIMARY KEY,
  member_id           INTEGER REFERENCES members(id) ON DELETE CASCADE,
  target_id           INTEGER REFERENCES member_targets(id) ON DELETE CASCADE,
  tanggal             DATE NOT NULL DEFAULT CURRENT_DATE,
  pencapaian_kr       VARCHAR(300),
  pencapaian_revenue  NUMERIC(20,2) DEFAULT 0,
  pct_kr              NUMERIC(6,2) DEFAULT 0,
  pct_revenue         NUMERIC(6,2) DEFAULT 0,
  catatan             TEXT,
  UNIQUE(target_id, tanggal)
);

CREATE INDEX IF NOT EXISTS idx_member_pencapaian_target
  ON member_pencapaian(target_id);
CREATE INDEX IF NOT EXISTS idx_member_pencapaian_tanggal
  ON member_pencapaian(tanggal);

GRANT ALL ON members TO bricuser;
GRANT ALL ON member_targets TO bricuser;
GRANT ALL ON member_pencapaian TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE members_id_seq TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE member_targets_id_seq TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE member_pencapaian_id_seq TO bricuser;
