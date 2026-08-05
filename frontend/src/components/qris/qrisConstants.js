// Konstanta bersama — QRIS Issuance Control Tower multi-tab dashboard.
// Semua nilai warna/label/STAGE/opsi filter di sini IDENTIK dengan yang ada
// di WarRoomQrisControlTower.jsx sebelum refactor (cuma dipindah ke sini
// supaya bisa dipakai ulang oleh semua tab). Penambahan murni aditif: 2
// template WA baru (Belum KYC/Belum Foto) dan opsi filter untuk tab baru.

export const ACCENT = '#0891B2';
export const RED    = '#EF4444';
export const AMBER  = '#F59E0B';
export const YELLOW = '#EAB308';
export const GREEN  = '#10B981';
export const BLUE   = '#3B82F6';
export const PURPLE = '#8B5CF6';
export const GRAY   = '#9CA3AF';

export const PRIORITY_COLOR = { P0: RED, P1: AMBER, P2: YELLOW, P3: GREEN };
export const SLA_COLOR      = { Breach: RED, Warning: AMBER, 'On Track': GREEN };
export const OWNER_COLOR    = { Merchant: BLUE, Internal: PURPLE, Verifikator: PURPLE, PTEN: AMBER, Done: GREEN };

export const PRIORITY_LABEL = {
  P0: 'Harus Diproses Sekarang',
  P1: 'Follow-up Cepat',
  P2: 'Monitoring',
  P3: 'Selesai',
};
export const OWNER_LABEL = {
  Merchant:    'Menunggu tindakan merchant',
  Internal:    'Menunggu tindakan internal',
  Verifikator: 'Menunggu verifikasi OS',
  PTEN:        'Menunggu proses PTEN',
  Done:        'Selesai',
};

export const KPI_TOOLTIP = {
  qrisTerbit:      'Outlet dengan status PTEN APPROVE.',
  overSla:         'Outlet yang sudah melewati batas waktu ideal pada stage saat ini.',
  merchantBacklog: 'Outlet yang prosesnya menunggu merchant melengkapi atau memperbaiki data.',
  internalBacklog: 'Outlet yang prosesnya menunggu tindakan tim internal, verifikator, atau PTEN.',
};

// String literal currentStage — persis STAGE.* di backend
// (backend/src/routes/warroom-qris-control-tower.js). Data JSON dari API
// sudah berupa string ini, jadi cukup di-mirror, tidak ada logic di sini.
export const STAGE = {
  QRIS_TERBIT:            'QRIS Terbit',
  PENDING_PTEN:           'Pending PTEN',
  MENUNGGU_PTEN:          'Menunggu PTEN',
  PERLU_PERBAIKAN:        'Perlu Perbaikan Data',
  SIAP_SUBMIT_PTEN:       'Siap Submit PTEN',
  MENUNGGU_VERIFIKASI_OS: 'Menunggu Verifikasi OS',
  DATA_BELUM_LENGKAP:     'Data Belum Lengkap',
  BARU_DAFTAR:            'Baru Daftar',
  BELUM_ISI_KYC:          'Belum Isi KYC',
  BELUM_SUBMIT_FOTO:      'Belum Submit Foto',
  PERLU_REVIEW:           'Perlu Review',
};
export const ALL_STAGES = [
  STAGE.BARU_DAFTAR, STAGE.BELUM_ISI_KYC, STAGE.BELUM_SUBMIT_FOTO,
  STAGE.MENUNGGU_VERIFIKASI_OS, STAGE.PERLU_PERBAIKAN, STAGE.DATA_BELUM_LENGKAP,
  STAGE.SIAP_SUBMIT_PTEN, STAGE.MENUNGGU_PTEN, STAGE.PENDING_PTEN,
  STAGE.PERLU_REVIEW, STAGE.QRIS_TERBIT,
];

export const OWNER_OPTIONS       = ['Merchant', 'Internal', 'Verifikator', 'PTEN', 'Done'];
export const STATUS_PTEN_OPTIONS = ['APPROVE', 'REJECTED', 'Belum Lengkap', 'Perbaikan Data', 'Menunggu Verifikasi', 'Pending PTEN', 'UNKNOWN'];
export const STATUS_OP_OPTIONS   = ['APPROVE', 'REJECTED', 'Belum Lengkap', 'Perbaikan Data', 'Menunggu Verifikasi', 'UNKNOWN'];
export const SLA_STATUS_OPTIONS  = ['On Track', 'Warning', 'Breach'];
export const CHART_COLORS = [ACCENT, GREEN, RED, AMBER, PURPLE, BLUE, GRAY, YELLOW];

export const AGING_BUCKETS = [
  { key: '0-30m',  label: '0–30 menit',  max: 30 },
  { key: '30-60m', label: '30–60 menit', max: 60 },
  { key: '1-4j',   label: '1–4 jam',     max: 240 },
  { key: '4-24j',  label: '4–24 jam',    max: 1440 },
  { key: '>24j',   label: '>24 jam',     max: Infinity },
];

export const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

// Action Center — 8 placeholder action dipakai konsisten di semua tab
// (row menu + drawer). Label "Copy Reminder"/"Recheck Status" — 2 rename
// dari label lama ("Send WA Reminder"/"Recheck Data"), id tetap konsisten.
export const ACTIONS = [
  { id: 'verify_now',         label: 'Verify Now',         icon: 'shield-check' },
  { id: 'assign_to_me',       label: 'Assign to Me',       icon: 'user-plus' },
  { id: 'copy_reminder',      label: 'Copy Reminder',      icon: 'brand-whatsapp' },
  { id: 'copy_reject_reason', label: 'Copy Reject Reason', icon: 'copy' },
  { id: 'mark_followed_up',   label: 'Mark Followed Up',   icon: 'checkbox' },
  { id: 'escalate_pten',      label: 'Escalate PTEN',      icon: 'alert-triangle' },
  { id: 'recheck_status',     label: 'Recheck Status',     icon: 'refresh' },
  { id: 'done_archive',       label: 'Done / Archive',     icon: 'archive' },
];

// Template WA — 4 lama (reject category) + 2 baru (Belum KYC / Belum Foto,
// dipakai getReminderTemplate() saat rejectCategory kosong tapi currentStage
// menunjukkan tahap itu).
export const REMINDER_TEMPLATES = {
  BELUM_LENGKAP: 'Halo Kak, proses pendaftaran QRIS outlet Kakak belum bisa dilanjutkan karena data masih belum lengkap. Mohon segera lengkapi data KYC/KYM dan foto usaha/foto produk agar tim kami bisa lanjutkan proses verifikasi dan QRIS bisa segera terbit.',
  FOTO_TIDAK_SESUAI: 'Halo Kak, data QRIS outlet Kakak perlu diperbaiki. Alasannya: foto usaha belum mencerminkan nama/kegiatan usaha yang didaftarkan. Mohon upload foto usaha atau foto produk yang real, jelas, dan sesuai dengan nama usaha agar proses QRIS bisa kami lanjutkan.',
  FOTO_ONLINE: 'Halo Kak, foto usaha yang dikirim belum bisa digunakan karena terindikasi berasal dari screenshot, marketplace, atau sumber online. Mohon upload foto asli dari produk/toko/usaha Kakak secara langsung agar proses verifikasi QRIS bisa dilanjutkan.',
  KTP_TIDAK_SESUAI: 'Halo Kak, data pemilik usaha perlu diperbaiki karena nama pemilik belum sesuai dengan dokumen KTP. Mohon sesuaikan nama pemilik dengan nama yang tertera di KTP agar proses verifikasi QRIS bisa dilanjutkan.',
  BELUM_KYC: 'Halo Kak, proses pendaftaran QRIS outlet Kakak belum bisa dilanjutkan karena data KYC/KYM belum diisi. Mohon segera lengkapi KYC/KYM agar tim kami bisa memproses penerbitan QRIS Kakak.',
  BELUM_FOTO: 'Halo Kak, proses pendaftaran QRIS outlet Kakak belum bisa dilanjutkan karena foto usaha/foto produk belum diupload. Mohon segera upload foto yang jelas dan sesuai usaha agar QRIS bisa segera kami proses.',
};
export const REJECT_CATEGORY_TO_TEMPLATE = {
  'Foto Tidak Sesuai Usaha':  'FOTO_TIDAK_SESUAI',
  'Foto Dari Sumber Online':  'FOTO_ONLINE',
  'Data KTP Tidak Sesuai':    'KTP_TIDAK_SESUAI',
  'Foto Tidak Ada':           'BELUM_LENGKAP',
};

// ── Opsi filter khusus tab baru ──────────────────────────────────────────
export const FOLLOWUP_TYPE_OPTIONS   = ['Belum KYC', 'Belum Foto', 'Belum Lengkap', 'Perbaikan Data', 'Rejected'];
export const INTERNAL_STAGE_OPTIONS  = ['Siap Verifikasi', 'Menunggu Verifikasi', 'Siap Submit PTEN', 'Pending PTEN', 'Menunggu PTEN'];
export const COMPLETENESS_OPTIONS    = ['Missing KYC', 'Missing Foto', 'Missing OP', 'Missing PTEN'];
export const COMMAND_QUICK_FILTERS   = ['Semua', 'Hari ini', 'Over SLA', 'Belum Terbit'];

// ── Konfigurasi 7 tab: urutan, label, icon Tabler, key badge count ───────
export const QRIS_TABS = [
  { key: 'command',      label: 'Command Center',    icon: 'ti-dashboard',         badgeKey: null },
  { key: 'queue',        label: 'Smart Queue',        icon: 'ti-list-check',        badgeKey: 'queue' },
  { key: 'sla',          label: 'SLA & Aging',        icon: 'ti-clock-exclamation', badgeKey: 'sla' },
  { key: 'merchant',     label: 'Merchant Follow-Up', icon: 'ti-message-circle',    badgeKey: 'merchant' },
  { key: 'verification', label: 'Verifikasi & PTEN',  icon: 'ti-shield-check',      badgeKey: 'verification' },
  { key: 'reject',       label: 'Reject Analysis',    icon: 'ti-alert-triangle',    badgeKey: 'reject' },
  { key: 'audit',        label: 'Raw Data & Audit',   icon: 'ti-database',          badgeKey: null },
];
