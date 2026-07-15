import { useState, useEffect, useRef, useCallback } from 'react';
import { getUser } from '../utils/auth';
import { getPendingFinanceBalanceRequests, acknowledgeFinanceBalanceRequest } from '../services/api';

// Hard notification "Permintaan Tambahan Saldo" — HANYA utk user unit FA.
// Dipasang SATU KALI secara global di Layout.jsx. Polling tiap 3 detik
// (scope awal: TIDAK pakai Socket.IO/WebSocket). Overlay full-screen,
// z-index tertinggi di aplikasi, TIDAK bisa ditutup selain via
// acknowledgement ("SAYA TERIMA") — tidak ada tombol tutup, tidak bisa
// klik backdrop, tidak bisa Escape.

const POLL_INTERVAL_MS = 3000;
const AUDIO_PREF_KEY = 'bric_finance_alert_audio_enabled';
const BLINK_TITLE_ALERT = '⚠ PERMINTAAN SALDO';
const BLINK_TITLE_NORMAL = 'BRIC';

function fmtRp(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  return `Rp ${Math.round(n).toLocaleString('id-ID')}`;
}

const BEEP_VOLUME = 0.9; // "auto volume tinggi" -- mendekati maksimum tanpa clipping berlebihan

/** Satu beep sederhana via Web Audio API (TIDAK PERNAH audio dari URL eksternal). */
function playBeep(ctx, durationMs) {
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.value = BEEP_VOLUME;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000);
  } catch {
    /* AudioContext bisa gagal kalau browser belum mengizinkan — abaikan, tombol "Aktifkan Suara" yg menangani ini */
  }
}

export default function FinanceBalanceAlert() {
  const user = getUser();
  const isFA = user?.unit === 'FA';

  const [pendingRequests, setPendingRequests] = useState([]);
  const [acking, setAcking] = useState(false);
  const [audioReady, setAudioReady] = useState(false);

  const inFlightRef = useRef(false);
  const audioContextRef = useRef(null);
  const beepIntervalRef = useRef(null);
  const beepTimeoutsRef = useRef([]);
  const aliveRef = useRef(true);

  const current = pendingRequests[0] || null;
  const otherCount = Math.max(0, pendingRequests.length - 1);

  /* ── Polling — hanya berjalan utk unit FA, dijaga tidak overlap via inFlightRef ── */
  const poll = useCallback(() => {
    if (!isFA || inFlightRef.current) return;
    inFlightRef.current = true;
    getPendingFinanceBalanceRequests()
      .then(res => { if (aliveRef.current) setPendingRequests(res.requests || []); })
      .catch(() => { /* silent — jangan crash dashboard kalau polling gagal sesaat */ })
      .finally(() => { inFlightRef.current = false; });
  }, [isFA]);

  useEffect(() => {
    aliveRef.current = true;
    if (!isFA) return undefined;
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [isFA, poll]);

  function enableAudio() {
    try {
      if (!audioContextRef.current) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        audioContextRef.current = new Ctx();
      }
      audioContextRef.current.resume().then(() => {
        if (audioContextRef.current.state === 'running') {
          setAudioReady(true);
          localStorage.setItem(AUDIO_PREF_KEY, 'true');
        }
      }).catch(() => {});
    } catch {
      /* biarkan tombol fallback di dalam alert tetap tampil supaya user bisa coba lagi */
    }
  }

  /* ── Auto-aktifkan suara — TIDAK perlu klik tombol khusus. Browser TETAP
     mewajibkan minimal satu gesture (klik/keydown/tap) di manapun pada
     halaman sebelum AudioContext boleh berbunyi (kebijakan autoplay, tidak
     bisa dilewati dari JS) -- jadi begitu FA klik APAPUN di dashboard (menu,
     scroll, dsb, bukan harus tombol suara), audio langsung diam-diam
     diaktifkan di background. Preferensi disimpan supaya sesi berikutnya
     langsung coba auto-resume tanpa gesture baru (bisa berhasil kalau
     browser masih mengingat origin ini "sudah pernah berinteraksi"). ── */
  useEffect(() => {
    if (!isFA || audioReady) return undefined;

    // Coba SEGERA saat halaman ini pertama render — klik tombol "Masuk" di
    // form login BARU SAJA terjadi (gesture asli), dan browser modern
    // biasanya masih menganggap tab ini "baru saja berinteraksi" beberapa
    // saat setelah itu (sticky activation) walau sudah pindah halaman via
    // client-side routing (bukan reload penuh) — kalau berhasil, suara
    // benar-benar aktif otomatis tanpa gesture tambahan apa pun.
    enableAudio();

    function unlockOnFirstGesture() {
      enableAudio();
    }
    const opts = { capture: true, passive: true };
    document.addEventListener('pointerdown', unlockOnFirstGesture, opts);
    document.addEventListener('keydown', unlockOnFirstGesture, opts);
    return () => {
      document.removeEventListener('pointerdown', unlockOnFirstGesture, opts);
      document.removeEventListener('keydown', unlockOnFirstGesture, opts);
    };
  }, [isFA, audioReady]);

  /* ── Pola beep: 250ms bunyi, 200ms jeda, 250ms bunyi, ~1 detik jeda, ulangi ── */
  const stopBeeping = useCallback(() => {
    if (beepIntervalRef.current) { clearInterval(beepIntervalRef.current); beepIntervalRef.current = null; }
    beepTimeoutsRef.current.forEach(clearTimeout);
    beepTimeoutsRef.current = [];
  }, []);

  useEffect(() => {
    const shouldBeep = isFA && !!current && audioReady && audioContextRef.current;
    if (!shouldBeep) { stopBeeping(); return undefined; }

    const ctx = audioContextRef.current;
    const cycle = () => {
      playBeep(ctx, 250);
      const t = setTimeout(() => playBeep(ctx, 250), 250 + 200);
      beepTimeoutsRef.current.push(t);
    };
    cycle();
    beepIntervalRef.current = setInterval(cycle, 250 + 200 + 250 + 1000);
    return stopBeeping;
  }, [isFA, current, audioReady, stopBeeping]);

  /* ── Title blinking ── */
  useEffect(() => {
    if (!isFA || !current) { document.title = BLINK_TITLE_NORMAL; return undefined; }
    let flag = false;
    const id = setInterval(() => {
      document.title = flag ? BLINK_TITLE_NORMAL : BLINK_TITLE_ALERT;
      flag = !flag;
    }, 1000);
    return () => { clearInterval(id); document.title = BLINK_TITLE_NORMAL; };
  }, [isFA, current]);

  /* ── Cleanup total saat unmount (logout menyebabkan Layout unmount) ── */
  useEffect(() => () => {
    stopBeeping();
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch { /* noop */ }
    }
  }, [stopBeeping]);

  function handleAcknowledge() {
    if (!current || acking) return;
    setAcking(true);
    acknowledgeFinanceBalanceRequest(current.id)
      .catch(() => { /* 409 already_acknowledged oleh FA lain -- tetap lanjut refresh pending */ })
      .finally(() => {
        setAcking(false);
        inFlightRef.current = false; // pastikan poll berikutnya tidak diblok flag lama
        poll();
        // Panel "Permintaan Diproses" (FaTransferPanel.jsx, komponen TERPISAH
        // di halaman Rekonsiliasi) tidak tahu acknowledge ini terjadi kecuali
        // lewat poll 8 detik miliknya sendiri -- tanpa event ini, tombol
        // "Diproses" baru muncul saat halaman di-refresh manual. Pola SAMA
        // dgn event `membersUpdated` yang sudah ada (Sidebar.jsx).
        window.dispatchEvent(new CustomEvent('bric:financeBalanceAcknowledged'));
      });
  }

  if (!isFA) return null;

  return (
    <>
      {current && (
        <div className="fba-overlay">
          <div className="fba-alert">
            <div className="fba-icon">⚠</div>
            <h1>PERMINTAAN TAMBAHAN SALDO</h1>
            <div className="fba-bank">Bank: {current.bank_code}</div>
            <p>Tim Operation membutuhkan tambahan saldo.</p>
            <div className="fba-requester">Nama Requester: {current.requester_name}</div>
            <div className="fba-balance">Sisa Saldo: {fmtRp(current.remaining_balance)}</div>
            {otherCount > 0 && <div className="fba-more">Terdapat {otherCount} permintaan lainnya.</div>}
            {!audioReady && (
              <button className="fba-enable-audio-btn" onClick={enableAudio}>
                <i className="ti ti-volume" /> AKTIFKAN SUARA
              </button>
            )}
            <button className="fba-ack-btn" onClick={handleAcknowledge} disabled={acking}>
              {acking ? 'Memproses...' : 'SAYA TERIMA'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
