import Chart from 'chart.js/auto';

/**
 * Sinkronkan warna default Chart.js (tick/legend/title/grid) dengan token
 * CSS tema aktif. Chart.js merender ke <canvas>, jadi CSS TIDAK BISA
 * menjangkau teksnya sama sekali — harus di-set lewat JS. Dipanggil sekali
 * saat app mount dan sekali lagi tiap kali tema di-toggle (lihat Layout.jsx).
 *
 * Chart yang eksplisit set warna ticks/legend sendiri (bukan lewat default)
 * TIDAK terpengaruh oleh ini — itu di luar cakupan (lihat WarRoomBumdes,
 * WarRoomPaLpd, WarRoomPaAsdp, WarRoomAsdp, WarRoomLpd).
 */
export function applyChartTheme() {
  const style = getComputedStyle(document.documentElement);
  const textColor = style.getPropertyValue('--text-3').trim() || '#6B7280';
  const gridColor = style.getPropertyValue('--border').trim() || '#E5E7EB';
  Chart.defaults.color = textColor;
  Chart.defaults.borderColor = gridColor;
  if (Chart.defaults.scale?.grid) Chart.defaults.scale.grid.color = gridColor;
}
