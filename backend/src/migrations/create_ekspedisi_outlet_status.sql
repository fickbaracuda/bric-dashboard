-- WAR-ROOM Ekspedisi — Execution Queue action persistence.
-- "Current state" table (Mark Contacted / Assign PIC / Set Follow-up Date) —
-- satu baris per id_outlet, di-upsert. Terpisah dari "notes" karena notes
-- adalah log append-only (banyak baris per outlet), sedangkan status ini
-- adalah nilai terkini (baris ditimpa).

CREATE TABLE IF NOT EXISTS ekspedisi_outlet_status (
  id_outlet     VARCHAR(30) PRIMARY KEY,
  is_contacted  BOOLEAN     NOT NULL DEFAULT FALSE,
  contacted_at  TIMESTAMPTZ,
  contacted_by  VARCHAR(50),
  pic           VARCHAR(100),
  followup_date DATE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    VARCHAR(50)
);

GRANT ALL ON ekspedisi_outlet_status TO bricuser;

-- Notes — append-only log, banyak baris per outlet.
CREATE TABLE IF NOT EXISTS ekspedisi_outlet_notes (
  id          SERIAL PRIMARY KEY,
  id_outlet   VARCHAR(30) NOT NULL,
  note        TEXT NOT NULL,
  created_by  VARCHAR(50),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ekspedisi_notes_outlet ON ekspedisi_outlet_notes(id_outlet);

GRANT ALL ON ekspedisi_outlet_notes TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE ekspedisi_outlet_notes_id_seq TO bricuser;
