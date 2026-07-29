-- Balance Control Tower — rekonsiliasi sbg source of truth utk actual
-- balance (OCBC dulu, bank lain via adapter yang sama nanti). Additive
-- only, TIDAK mengubah/menghapus snapshot manapun yang sudah ada.

ALTER TABLE bct_balance_snapshots
  ADD COLUMN IF NOT EXISTS source_synced_at TIMESTAMPTZ NULL;

-- Dedup di level DB: maksimal 1 snapshot RECONCILIATION per (bank,
-- source_synced_at) -- refresh-on-read yang concurrent (banyak user buka
-- dashboard bersamaan) tidak akan pernah membuat baris dobel; INSERT
-- pemanggil pakai ON CONFLICT ... DO NOTHING pada index ini.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bct_snapshots_reconciliation_sync
  ON bct_balance_snapshots(bank_account_id, source_synced_at)
  WHERE source = 'RECONCILIATION' AND source_synced_at IS NOT NULL;
