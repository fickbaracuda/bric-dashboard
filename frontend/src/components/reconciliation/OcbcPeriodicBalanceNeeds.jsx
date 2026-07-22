import PeriodicBalanceNeeds from './PeriodicBalanceNeeds';
import { getOcbcPeriodicBalanceNeeds } from '../../services/api';

// Wrapper TIPIS — implementasi sesungguhnya (referensi utama & sumber
// kebenaran utk seluruh bank) sekarang ada di PeriodicBalanceNeeds.jsx
// (SHARED dgn Mandiri/BRI/BRI BI-FAST/BNI). File ini SENGAJA dipertahankan
// (bukan dihapus & diganti langsung di WarRoomReconciliationOcbc.jsx) supaya
// import existing di halaman OCBC TIDAK PERLU diubah sama sekali — nol
// risiko terhadap tab OCBC yang sudah berjalan.
const COLOR = '#DC2626';

export default function OcbcPeriodicBalanceNeeds() {
  return (
    <PeriodicBalanceNeeds
      bankCode="OCBC"
      bankLabel="OCBC"
      themeColor={COLOR}
      fetchData={getOcbcPeriodicBalanceNeeds}
      defaultRange="7d"
    />
  );
}
