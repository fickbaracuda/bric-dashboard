---
name: bric-architecture
description: Aturan arsitektur inti BRIC yang sering dilanggar kalau tidak dicek dulu — kolom war-room, single-snapshot vs multi-bulan, domain terpisah, RBAC, sync token, dsb.
---

# Aturan Arsitektur BRIC

Referensi detail per-fitur ada di `CLAUDE.md` (peta lengkap route/tabel/menu)
dan `BricKnowledge.MD` (fitur yang dibangun setelah CLAUDE.md terakhir
diperbarui — Rekonsiliasi 6 bank, Balance Control Tower, Balance & Funding,
DM Control Tower, Farming Command Center, Payment Agent Produk baru, dll).
**Jangan menyalin isi kedua file itu ke sini — baca langsung saat perlu.**

## Sebelum mengubah domain war-room manapun

1. **Baca dokumentasi fitur spesifiknya dulu** (`docs/<FITUR>.md` kalau ada,
   atau bagian relevan di `BricKnowledge.MD`) sebelum mengubah logic-nya.
2. **Jangan asumsi nama kolom sama antar war-room.** Tiap domain punya
   konvensi sendiri: `trx_mei`/`trx_jun` vs `trx_prev`/`trx_curr` vs
   `trx_mei`/`trx_juni` (beda ejaan!). Selalu buka file route spesifik dulu.
3. **Cek dulu apakah war-room itu single-snapshot atau multi-bulan** sebelum
   menambah fitur filter bulan. Contoh yang sering membingungkan: ASDP &
   LPD masing-masing punya 2 varian —
   - `warroom-asdp.js` / `warroom-lpd.js` = single snapshot, UNIQUE `id_outlet` saja.
   - `warroom-pa-asdp.js` / `warroom-pa-lpd.js` = multi-bulan, UNIQUE `(bulan, id_outlet)`.
4. **Jangan satukan domain yang sengaja dipisah.** Contoh: Payment Agent
   Produk (baru, lihat `BricKnowledge.MD` §4) berbeda dari PA Produk legacy
   di `warroom.js` — jangan digabung tanpa instruksi eksplisit.
   `WarRoomAffiliateAnalitik.jsx` adalah dead code yang sengaja direvert
   dari routing — jangan diaktifkan kembali tanpa konfirmasi user.

## Sync token & endpoint registration

- Sync token yang dipakai HAMPIR SEMUA endpoint: `bric2026bimasaktisecret`.
  **MGM PA beda** (`bric2026mgmpasecret`) — jangan disamakan saat membuat
  war-room baru kecuali diminta eksplisit.
- Endpoint sync baru (`POST .../sync`) **wajib didaftarkan di `app.js`
  SEBELUM** `app.use('/api/warroom', requireAuth, ...)` supaya bisa bypass
  JWT lewat token sync-nya sendiri.
- Kalau payload sync besar (>1MB), endpoint itu **wajib ditambahkan ke
  regex whitelist nginx** (`bric-bric.conf`) — kalau lupa, nginx menolak
  duluan sebelum sampai ke Express, gagalnya membingungkan (bukan error app).
- `cleanNum()` di Apps Script manapun **wajib guard `typeof v === 'number'`
  dulu** sebelum string processing — insiden nyata: Speedcash pernah salah
  100x karena titik desimal ikut terhapus saat treat number sebagai string.

## Business logic & RBAC

- **QRIS Control Tower TIDAK ADA logic bisnis di frontend** — semua
  kalkulasi stage/SLA/priority di backend. Bug tampilan → cek dulu data
  dari backend, jangan langsung ubah frontend.
- **Rekonsiliasi bank (6 bank) pakai shared engine + adapter per bank**
  (lihat `BricKnowledge.MD` §6). Jangan tulis ulang logic rekonsiliasi di
  fitur lain yang hanya butuh MEMBACA saldo — reuse fungsi read-only yang
  sudah ada (contoh: Balance & Funding memanggil `validateMandiriBalance()`
  dari adapter rekonsiliasi Mandiri, bukan menulis ulang logic-nya).
- **RBAC OP/FA** (kalau relevan dengan fitur yang disentuh) harus
  dipertahankan sesuai desain existing — jangan longgarkan scope akses
  tanpa instruksi eksplisit.
- **Fail-safe untuk data finansial**: jangan pernah menampilkan angka
  fabrikasi/placeholder sebagai kalau itu data asli (contoh nyata: bug
  Balance & Funding yang sempat menampilkan saldo Rp0 palsu — harusnya
  `BALANCE_UNAVAILABLE`/`BALANCE_STALE` dengan warning, bukan angka
  kosong yang terlihat valid).

## Tabel `wb_*` (War Room Builder)

Ada di migration tapi belum dipakai aktif oleh war-room manapun —
kemungkinan infrastruktur untuk fitur self-service war-room builder di
masa depan. Jangan hapus, tapi juga jangan asumsikan sudah terintegrasi.
