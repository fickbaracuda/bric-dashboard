-- Fitur "Permintaan Tambahan Saldo" — tambah kolom "Sisa Saldo" (nominal
-- saldo yang tersisa saat ini, diisi manual oleh Tim Operation saat
-- membuat permintaan). Perluasan tabel yang sudah ada
-- (add_finance_balance_requests.sql) — TIDAK membuat tabel baru.
-- Nullable supaya baris lama (dibuat sebelum kolom ini ada) tidak error.
-- Idempotent: aman dijalankan ulang.

ALTER TABLE finance_balance_requests ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC NULL;
