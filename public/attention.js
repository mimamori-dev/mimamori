// 社長の回答待ち(確認カード・成果物の承認待ち)に気づかせる。表示だけだと見落とすため、
// 帯・タブ題の点滅・デスクトップ通知・通知音で知らせる。外部通信なし。/events は読み取りのみ。
// 通知本文はカードの見出しだけ(金額・個人情報を入れない)。遠隔(スマホ)は帯と題の点滅だけで、通知・音は出さない。
(() => {
  'use strict';
  const BASE_TITLE = 'Mimamori';
  const ACTIVE = new Set(['new', 'opened', 'approving', 'rejecting']);
  const clip = (s, n) => { const a = Array.from(String(s ?? '')); return a.length > n ? `${a.slice(0, n).join('')}…` : a.join(''); };

  /** snapshot から回答待ちの一覧 [{key, label}] を作る。成果物が件数だけ(遠隔)のときは count にだけ足す */
  function pendingOf(snap) {
    const items = [];
    for (const d of Array.isArray(snap?.decisions) ? snap.decisions : []) {
      if (d?.status === 'pending') items.push({ key: `d:${d.id}`, label: clip(d.header || '確認カード', 40) });
    }
    let extra = 0;
    if (Array.isArray(snap?.deliverables)) {
      for (const d of snap.deliverables) {
        if (!d?.sns && ACTIVE.has(d.status)) items.push({ key: `v:${d.id}`, label: `成果物: ${clip(d.title || '承認待ち', 40)}` });
      }
    } else if (Number.isFinite(snap?.deliverableCount)) extra = snap.deliverableCount;
    return { items, count: items.length + extra };
  }

  const g = typeof window !== 'undefined' ? window : globalThis;
  g.__attn = { pendingOf, clip };
  if (typeof document === 'undefined' || !document.getElementById) return;

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 無視 */ } };
  const KEY_SOUND = 'mimamori.attn.sound';

  const bar = document.getElementById('attn');
  const swSound = document.getElementById('attn-sound');
  const btnNotify = document.getElementById('attn-notify');
  const hint = document.getElementById('attn-hint');
  const reduce = !!(g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches);

  let isRemote = false;
  let soundOn = lsGet(KEY_SOUND) !== 'off';
  let unlocked = false; // ブラウザの自動再生制限: 最初のクリック後に有効
  let ctx = null;
  let known = null; // 既知の key の集合(最初の snapshot は鳴らさない)
  let count = 0;
  let blink = null;
  const notified = new Set();

  function audio() {
    if (!ctx) { try { ctx = new (g.AudioContext || g.webkitAudioContext)(); } catch { ctx = null; } }
    return ctx;
  }
  // 新着の瞬間に1回だけ(画面が裏でも繰り返さない)
  function beep() {
    if (isRemote || !soundOn || !unlocked) return;
    const a = audio(); if (!a) return;
    try {
      if (a.state === 'suspended') a.resume();
      [[880, 0], [1175, 0.17]].forEach(([f, dt]) => {
        const o = a.createOscillator(); const gn = a.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t = a.currentTime + dt;
        gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(0.18, t + 0.02); gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
        o.connect(gn); gn.connect(a.destination); o.start(t); o.stop(t + 0.16);
      });
    } catch { /* 鳴らせなくても動く */ }
  }
  const unlock = () => { unlocked = true; audio(); renderSwitches(); };
  document.addEventListener('pointerdown', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });

  function renderSwitches() {
    if (swSound) {
      swSound.setAttribute('aria-checked', String(soundOn));
      swSound.classList.toggle('on', soundOn);
      const b = swSound.querySelector('b'); if (b) b.textContent = soundOn ? 'ON' : 'OFF';
      swSound.hidden = isRemote;
    }
    if (hint) hint.hidden = unlocked || !soundOn || isRemote;
    if (btnNotify) {
      const P = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
      btnNotify.hidden = isRemote || P === 'unsupported';
      btnNotify.textContent = P === 'granted' ? '🔔 通知: 許可済み' : P === 'denied' ? '🔔 通知: ブロック中(ブラウザの設定で許可)' : '🔔 通知を許可';
      btnNotify.disabled = P !== 'default';
    }
  }
  if (swSound) swSound.addEventListener('click', () => { soundOn = !soundOn; lsSet(KEY_SOUND, soundOn ? 'on' : 'off'); unlocked = true; renderSwitches(); if (soundOn) beep(); });
  if (btnNotify) btnNotify.addEventListener('click', async () => {
    try { await Notification.requestPermission(); } catch { /* 無視 */ }
    renderSwitches();
  });

  function notifyOne(it) {
    if (isRemote || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (notified.has(it.key)) return;
    notified.add(it.key);
    try {
      const n = new Notification('社長の回答待ち', { body: it.label, tag: `mimamori-${it.key}` });
      n.onclick = () => { try { g.focus(); n.close(); } catch { /* 無視 */ } };
    } catch { /* 無視 */ }
  }

  function setTitle() {
    if (blink) { clearInterval(blink); blink = null; }
    if (count <= 0) { document.title = BASE_TITLE; return; }
    const alt = `(${count})社長の回答待ち - ${BASE_TITLE}`;
    document.title = alt;
    if (reduce) return;
    let flip = false;
    blink = setInterval(() => { flip = !flip; document.title = flip ? BASE_TITLE : alt; }, 1000); // 1秒ごとに交代=2秒周期
  }

  function setFavicon(on) {
    const l = document.querySelector('link[rel="icon"]'); if (!l) return;
    l.href = on ? `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#7b61c9"/><circle cx="24" cy="8" r="7" fill="#e5384d"/></svg>')}` : 'data:,';
  }

  function render(snap) {
    isRemote = !!snap && snap.inbox?.canSend === false;
    const { items, count: n } = pendingOf(snap);
    const keys = new Set(items.map((i) => i.key));
    const fresh = known ? items.filter((i) => !known.has(i.key)) : [];
    const grew = !!known && (fresh.length > 0 || (items.length === 0 && n > count)); // 遠隔の件数だけの成果物も増えたら数える
    known = keys;
    for (const k of [...notified]) if (!keys.has(k)) notified.delete(k); // 閉じたら忘れる(同じ件の重複だけ防ぐ)
    if (n !== count) { count = n; setTitle(); setFavicon(n > 0); }
    if (bar) {
      bar.hidden = n === 0;
      document.documentElement.classList?.toggle('has-attn', n > 0); // 他の面を帯の高さ分だけ下げる
      const num = bar.querySelector('.attn-n'); if (num) num.textContent = String(n);
      const lb = bar.querySelector('.attn-l'); if (lb) lb.textContent = items[0] ? (n > 1 ? `${items[0].label} ほか` : items[0].label) : '';
    }
    if (grew) { beep(); for (const it of fresh) notifyOne(it); }
    renderSwitches();
  }

  // 接続は office.js が張っている /events を使う(同一接続先のSSE本数を増やさない)
  g.addEventListener('mimamori:snapshot', (e) => { try { render(e.detail); } catch { /* 無視 */ } });
  renderSwitches();
})();
