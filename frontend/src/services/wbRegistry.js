export const WARROOM_TYPE_REGISTRY = [
  {
    code: 'instaqris_mcc',
    name: 'InstaQRIS MCC Warroom',
    business_unit: 'InstaQRIS',
    business_model: 'B2B',
    entity_type: 'MCC',
    entity_label: 'MCC',
    color: '#E24B4A',
    default_plugins: ['merchant','transaction','revenue'],
  },
  {
    code: 'instaqris_merchant',
    name: 'InstaQRIS Merchant Warroom',
    business_unit: 'InstaQRIS',
    business_model: 'B2B',
    entity_type: 'Merchant',
    entity_label: 'Merchant',
    color: '#7F77DD',
    default_plugins: ['merchant','activation','retention','revenue'],
  },
  {
    code: 'speedcash_outlet',
    name: 'Speedcash Outlet Warroom',
    business_unit: 'Speedcash',
    business_model: 'B2C',
    entity_type: 'Outlet',
    entity_label: 'Outlet',
    color: '#F97316',
    default_plugins: ['transaction','margin','growth'],
  },
  {
    code: 'fastpay_product',
    name: 'Fastpay Product Warroom',
    business_unit: 'Fastpay',
    business_model: 'B2B',
    entity_type: 'Product',
    entity_label: 'Produk',
    color: '#639922',
    default_plugins: ['product','transaction','revenue'],
  },
  {
    code: 'fastpay_farming',
    name: 'Fastpay Farming Warroom',
    business_unit: 'Fastpay',
    business_model: 'B2B',
    entity_type: 'Agent',
    entity_label: 'Agent',
    color: '#10B981',
    default_plugins: ['agent','farming','activation','retention'],
  },
  {
    code: 'winme_seller',
    name: 'Winme Seller Warroom',
    business_unit: 'Winme',
    business_model: 'B2B2C',
    entity_type: 'Seller',
    entity_label: 'Seller',
    color: '#7F77DD',
    default_plugins: ['seller','revenue','growth'],
  },
  {
    code: 'pulsagram_partner',
    name: 'Pulsagram Partner Warroom',
    business_unit: 'Pulsagram',
    business_model: 'HOST_TO_HOST',
    entity_type: 'Partner',
    entity_label: 'Partner',
    color: '#378ADD',
    default_plugins: ['transaction','revenue','margin','reliability'],
  },
  {
    code: 'tiket_kai',
    name: 'Tiket KAI Warroom',
    business_unit: 'Tiket KAI',
    business_model: 'B2C',
    entity_type: 'Product',
    entity_label: 'Produk',
    color: '#0EA5E9',
    default_plugins: ['transaction','revenue'],
  },
  {
    code: 'gamesquad',
    name: 'Gamesquad Partner Warroom',
    business_unit: 'Gamesquad',
    business_model: 'B2B',
    entity_type: 'Partner',
    entity_label: 'Partner',
    color: '#8B5CF6',
    default_plugins: ['transaction','revenue'],
  },
  {
    code: 'custom',
    name: 'Custom Warroom',
    business_unit: 'Custom',
    business_model: 'Custom',
    entity_type: 'Custom',
    entity_label: 'Entity',
    color: '#6B7280',
    default_plugins: ['transaction','revenue'],
  },
];

export const PLUGIN_REGISTRY = [
  { code: 'revenue',     name: 'Revenue Plugin',     description: 'Revenue, revenue growth, revenue per TRX' },
  { code: 'transaction', name: 'Transaction Plugin', description: 'TRX, TRX growth, TRX distribution' },
  { code: 'margin',      name: 'Margin Plugin',      description: 'Margin, margin growth, margin per TRX' },
  { code: 'merchant',    name: 'Merchant Plugin',    description: 'Jumlah merchant, produktivitas merchant' },
  { code: 'agent',       name: 'Agent Plugin',       description: 'Jumlah agent, produktivitas, retensi' },
  { code: 'seller',      name: 'Seller Plugin',      description: 'Jumlah seller, growth, aktivasi' },
  { code: 'product',     name: 'Product Plugin',     description: 'MAT, ARPT, ATPU, ARPU per produk' },
  { code: 'activation',  name: 'Activation Plugin',  description: 'First TRX, activated count, activation rate' },
  { code: 'retention',   name: 'Retention Plugin',   description: 'Last TRX, active count, dormant, churn risk' },
  { code: 'growth',      name: 'Growth Plugin',      description: 'Growth status, growth %, same period comparison' },
  { code: 'farming',     name: 'Farming Plugin',     description: 'Same period TRX comparison, farming growth' },
  { code: 'reliability', name: 'Reliability Plugin', description: 'Success rate, failure rate, error rate' },
  { code: 'territory',   name: 'Territory Plugin',   description: 'Provinsi, kota, territory performance' },
];

export const BUSINESS_UNITS = [
  'InstaQRIS', 'Winme', 'Speedcash', 'Fastpay', 'Tiket KAI',
  'Gamesquad', 'Pulsagram', 'Custom',
];

export const BUSINESS_MODELS = ['B2B','B2C','B2B2C','HOST_TO_HOST','Custom'];

export const ENTITY_TYPES = [
  'MCC','Merchant','Outlet','Agent','Product','Seller',
  'Affiliate','Territory','Partner','Campaign','Custom',
];

export const STANDARD_FIELDS = [
  { value: 'entity_id',                 label: 'Entity ID' },
  { value: 'entity_name',               label: 'Entity Name / Label' },
  { value: 'category',                  label: 'Kategori / Segmen' },
  { value: 'province',                  label: 'Provinsi' },
  { value: 'city',                      label: 'Kota' },
  { value: 'registration_date',         label: 'Tanggal Registrasi' },
  { value: 'first_trx_date',            label: 'Tanggal First TRX' },
  { value: 'last_trx_date',             label: 'Tanggal Last TRX' },
  { value: 'previous_trx',             label: 'TRX Previous Period' },
  { value: 'current_trx',              label: 'TRX Current Period' },
  { value: 'same_period_previous_trx', label: 'TRX Same Period (Previous)' },
  { value: 'same_period_current_trx',  label: 'TRX Same Period (Current)' },
  { value: 'dev_trx',                  label: 'Delta TRX' },
  { value: 'previous_revenue',         label: 'Revenue Previous Period' },
  { value: 'current_revenue',          label: 'Revenue Current Period' },
  { value: 'dev_revenue',              label: 'Delta Revenue' },
  { value: 'previous_margin',          label: 'Margin Previous Period' },
  { value: 'current_margin',           label: 'Margin Current Period' },
  { value: 'dev_margin',               label: 'Delta Margin' },
  { value: 'mat',                       label: 'MAT (Merchant Active Today)' },
  { value: 'arpt',                      label: 'ARPT' },
  { value: 'atpu',                      label: 'ATPU' },
  { value: 'arpu',                      label: 'ARPU' },
  { value: 'success_rate',             label: 'Success Rate' },
  { value: 'failure_rate',             label: 'Failure Rate' },
  { value: 'pic',                       label: 'PIC / Penanggung Jawab' },
  { value: 'no_hp',                     label: 'No HP / WhatsApp' },
  { value: 'custom_metric',            label: 'Custom Metric (abaikan)' },
];

export const BU_COLORS = {
  InstaQRIS: '#E24B4A',
  Winme: '#7F77DD',
  Speedcash: '#F97316',
  Fastpay: '#639922',
  'Tiket KAI': '#0EA5E9',
  Gamesquad: '#8B5CF6',
  Pulsagram: '#378ADD',
  Custom: '#6B7280',
};

export const SCORE_STATUS_LABELS = {
  excellent: 'Excellent',
  good: 'Good',
  warning: 'Warning',
  critical: 'Critical',
};

export const SCORE_STATUS_COLORS = {
  excellent: '#1D9E75',
  good: '#3B82F6',
  warning: '#F59E0B',
  critical: '#EF4444',
};

export const ACTION_TYPE_LABELS = {
  scale: '📈 Scale Now',
  rescue: '🚨 Rescue Now',
  fix_monetization: '⚡ Fix Monetization',
  activate: '✅ Activate',
  reactivate: '🔄 Reactivate',
  hidden_gem: '💎 Hidden Gem',
  monitor: '👀 Monitor',
};

export const ACTION_STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In Progress',
  done: 'Done',
  blocked: 'Blocked',
};

export const ALERT_LEVEL_COLORS = {
  critical: '#EF4444',
  warning: '#F59E0B',
  info: '#3B82F6',
};

export function getWarroomTypeByCode(code) {
  return WARROOM_TYPE_REGISTRY.find(r => r.code === code) || null;
}

export function getWarroomTypesByBU(bu, entityType) {
  return WARROOM_TYPE_REGISTRY.filter(r =>
    r.business_unit === bu && (!entityType || r.entity_type === entityType)
  );
}
