// 部長の発言の読み上げ(任意機能・既定OFF)。
// ONにしたあとに画面へ新しく出た発言だけを、順番待ち(最大3件)で読む。声は VOICEVOX(あれば)→ブラウザの音声合成→無音の順。
// すべての失敗は握りつぶし、画面は壊さない。スマホ(遠隔)は VOICEVOX の中継を使わず、ブラウザの音声合成だけ。
import { speechText } from './speech-text.js';

const sw = document.getElementById('tts-sw');
if (sw) {
  const state = document.getElementById('tts-state');
  const credit = document.getElementById('tts-credit');
  const gear = document.getElementById('tts-gear');
  const cfg = document.getElementById('tts-cfg');
  const spk = document.getElementById('tts-speaker');
  const hint = document.getElementById('tts-hint');

  const KEY_ON = 'mimamori.tts.on';
  const KEY_SPK = 'mimamori.tts.speaker';
  const DEFAULT_SPEAKER = 11; // 玄野武宏
  const NAMES = { 11: '玄野武宏' };
  const QUEUE_MAX = 3;
  const TTS_WAIT_MS = 3000;

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 無視 */ } };

  const validId = (v) => { if (v === null || v === undefined) return null; const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 9999 && String(v).trim() !== '' ? n : null; };
  let speaker = validId(new URLSearchParams(location.search).get('tts_speaker')) ?? validId(lsGet(KEY_SPK)) ?? DEFAULT_SPEAKER;

  let on = false; // 保存された状態があっても、鳴らすのは画面でスイッチを押したあとだけ
  let isRemote = false;
  let snap = null;
  let seen = new Set();
  const queue = [];
  let playing = false;
  let epoch = 0; // OFF にしたら進める。古い再生の続きを捨てる
  let audio = null;
  let usedVv = false;

  const keyOf = (t) => `${t.ts}|${t.who}|${t.text}`;
  const markSeen = () => { seen = new Set((Array.isArray(snap?.talk) ? snap.talk : []).map(keyOf)); };

  function refreshUi() {
    sw.setAttribute('aria-checked', String(on));
    state.textContent = on ? 'ON' : 'OFF';
    sw.classList.toggle('on', on);
    credit.hidden = !(on && usedVv && !isRemote);
    credit.textContent = `VOICEVOX:${NAMES[speaker] ?? `話者ID ${speaker}`}`;
    spk.value = String(speaker);
  }

  function stopAll() {
    epoch++;
    queue.length = 0;
    playing = false;
    try { if (audio) { audio.pause(); audio.removeAttribute('src'); audio = null; } } catch { /* 無視 */ }
    try { window.speechSynthesis?.cancel(); } catch { /* 無視 */ }
  }

  async function viaVoicevox(text, my) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TTS_WAIT_MS);
    let blob;
    try {
      const r = await fetch('/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, speaker }), signal: ac.signal });
      if (!r.ok) return false;
      blob = await r.blob();
    } catch { return false; } finally { clearTimeout(timer); }
    if (my !== epoch) return true;
    const url = URL.createObjectURL(blob);
    try {
      await new Promise((resolve, reject) => {
        const a = new Audio(url);
        audio = a;
        a.onended = resolve;
        a.onerror = () => reject(new Error('audio'));
        a.play().catch(reject);
      });
      usedVv = true;
      refreshUi();
      return true;
    } catch { return false; } finally { URL.revokeObjectURL(url); }
  }

  function viaBrowser(text, my) {
    return new Promise((resolve) => {
      try {
        const ss = window.speechSynthesis;
        if (!ss || typeof SpeechSynthesisUtterance === 'undefined') return resolve(false);
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ja-JP';
        const v = ss.getVoices().find((x) => /^ja/i.test(x.lang));
        if (v) u.voice = v;
        let done = false;
        const fin = (ok) => { if (!done) { done = true; resolve(ok); } };
        u.onend = () => fin(true);
        u.onerror = () => fin(false);
        if (my !== epoch) return resolve(true);
        ss.speak(u);
        setTimeout(() => fin(true), 60_000); // 終わりの通知が来ない環境でも詰まらせない
      } catch { resolve(false); }
    });
  }

  async function pump() {
    if (playing) return;
    playing = true;
    const my = epoch;
    try {
      while (queue.length && my === epoch) {
        const text = queue.shift();
        let ok = false;
        if (!isRemote) ok = await viaVoicevox(text, my);
        if (!ok && my === epoch) { usedVv = false; refreshUi(); await viaBrowser(text, my); }
      }
    } catch { /* 無視 */ }
    if (my === epoch) playing = false;
  }

  function enqueue(text) {
    queue.push(text);
    while (queue.length > QUEUE_MAX) queue.shift(); // 古いものは捨てる
    pump();
  }

  function onSnapshot(s) {
    snap = s;
    isRemote = s?.inbox?.canSend === false;
    const list = Array.isArray(s?.talk) ? s.talk : [];
    if (!on) { markSeen(); return; }
    for (const t of list) {
      const k = keyOf(t);
      if (seen.has(k)) continue;
      seen.add(k);
      const text = speechText(t?.text);
      if (text) enqueue(text);
    }
    if (seen.size > 400) markSeen();
  }

  sw.addEventListener('click', () => {
    on = !on;
    lsSet(KEY_ON, on ? '1' : '0');
    if (on) { markSeen(); hint.hidden = true; try { window.speechSynthesis?.getVoices(); } catch { /* 無視 */ } } else { stopAll(); }
    refreshUi();
  });
  gear.addEventListener('click', () => { cfg.hidden = !cfg.hidden; gear.setAttribute('aria-expanded', String(!cfg.hidden)); });
  spk.addEventListener('change', () => {
    const n = validId(spk.value);
    if (n !== null) { speaker = n; lsSet(KEY_SPK, String(n)); usedVv = false; }
    refreshUi();
  });

  hint.hidden = lsGet(KEY_ON) !== '1';
  refreshUi();

  const project = new URLSearchParams(location.search).get('project');
  const connect = () => {
    const es = new EventSource(project ? `/events?project=${encodeURIComponent(project)}` : '/events');
    es.addEventListener('snapshot', (e) => { try { onSnapshot(JSON.parse(e.data)); } catch { /* 無視 */ } });
    es.addEventListener('office', (e) => { try { const s = JSON.parse(e.data)?.snapshot; if (s) onSnapshot(s); } catch { /* 無視 */ } });
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  };
  connect();
}
