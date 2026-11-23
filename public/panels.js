// 成果物ボードと部長の発言パネル。office.js には依存せず、/events を自分で購読する(読み取りのみ)。
// 文字はすべて textContent で入れる(HTMLとして解釈しない)。パスは扱わない(題・ファイル名・一言だけ)。
(() => {
  'use strict';
  const feed = document.getElementById('feed');
  if (!feed) return;

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const KIND = { video: ['動画', '▶'], pdf: ['PDF', 'P'], pptx: ['資料', '▤'], xlsx: ['表', '▦'], html: ['ページ', '◎'], doc: ['文書', '≡'], image: ['画像', '◧'], other: ['その他', '◆'] };
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDT = (ts) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtTime = (ts) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  const mount = el('div', 'pn-mount');
  const answers = document.getElementById('answers');
  feed.insertBefore(mount, answers ? answers.nextSibling : feed.firstChild);

  // ---------- 成果物ボード ----------
  const dv = el('section', 'pn-sec pn-deliv');
  dv.setAttribute('aria-label', '成果物');
  const dvHead = el('h2', 'pn-h');
  const dvList = el('ul', 'pn-dv-list');
  const mobileMq = window.matchMedia('(max-width: 760px)'); // office.js・CSSと同じ境界。スマホは閲覧のみ
  mobileMq.addEventListener('change', () => { dvSig = ''; renderDeliverables(); });
  const dvFold = el('div', 'pn-fold-wrap');
  dv.append(dvHead, dvList, dvFold);

  // ---------- 部長の発言 ----------
  const tk = el('details', 'pn-sec pn-talk');
  tk.open = true;
  const tkSum = el('summary', null);
  const tkCount = el('small', null, '');
  tkSum.append(el('span', null, '部長の発言'), tkCount);
  const tkList = el('ul', 'pn-tk-list');
  tk.append(tkSum, tkList);

  // ---------- SNS用(Xなどに社長が自分で投稿するもの。未投稿 / 投稿済みを分けて見せる) ----------
  // 通知欄の外。画面上部の常設ボタン(件数バッジ)と、右に重ねて開く専用ドロワー
  const sn = el('aside', 'pn-sns-drawer panel'); // 3Dの広さは変えず、上に重ねる
  sn.id = 'sns-drawer';
  sn.setAttribute('aria-label', 'SNS用');
  sn.hidden = true;
  const snHead = el('h2', 'pn-h');
  const snClose = el('button', 'pn-sns-x', '閉じる');
  snClose.type = 'button';
  const snTop = el('div', 'pn-sns-top');
  snTop.append(snHead, snClose);
  const snList = el('ul', 'pn-dv-list pn-sns-list');
  const snErr = el('span', 'pn-err pn-sns-err');
  sn.append(snTop, snErr, snList);
  const snBtn = el('button', 'pn-sns-btn');
  snBtn.type = 'button';
  snBtn.id = 'sns-btn';
  snBtn.setAttribute('aria-controls', 'sns-drawer');
  snBtn.setAttribute('aria-expanded', 'false');
  snBtn.hidden = true;
  const snBtnN = el('span', 'pn-sns-n', '0');
  snBtn.append(document.createTextNode('SNS'), snBtnN);
  const snSetOpen = (on) => { sn.hidden = !on || mobileMq.matches; snBtn.setAttribute('aria-expanded', String(!sn.hidden)); };
  snBtn.addEventListener('click', () => { if (!mobileMq.matches) snSetOpen(sn.hidden); });
  snClose.addEventListener('click', () => { snSetOpen(false); snBtn.focus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sn.hidden) { snSetOpen(false); snBtn.focus(); } });
  const snBadge = (n) => { snBtnN.textContent = String(n); snBtn.classList.toggle('has', n > 0); snBtn.setAttribute('aria-label', `SNS用 未投稿${n}件`); };
  feed.insertBefore(snBtn, feed.firstChild); // 右の通知欄の上端(入力欄・3Dの右下には置かない)
  document.body.append(sn);

  mount.append(dv, tk);

  let snap = null;
  let dvSig = '';
  let tkSig = '';
  const expanded = new Set(); // 長文を広げた発言
  const busy = new Set();

  // ---------- 成果物の承認・差し戻し(コメント本文は画面のメモリだけ。console・保存・ログには出さない) ----------
  const RJ_MAX = 300;
  const rjLen = (v) => Array.from(String(v).trim()).length; // サーバーと同じ: 前後の空白を除いたコードポイント数
  const ACTIVE = new Set(['new', 'opened', 'approving', 'rejecting']);
  const rjOpen = new Set(); // 差し戻しの入力欄を開いている成果物 id
  const rjNodes = new Map(); // id -> { wrap, ta, count, send }(再描画しても同じ欄を使い回し、入力中の文字を守る)
  const errs = new Map(); // id -> 送れなかったときの短い文
  const fold = { approved: false, rejected: false, snsRejected: false };
  let dvLocal = 0; // 画面側の状態が変わったら再描画する印

  async function post(path, body, id) {
    if (busy.has(id)) return false;
    busy.add(id);
    errs.delete(id);
    let ok = false;
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      ok = r.ok;
      if (!ok) errs.set(id, r.status === 409 ? 'すでに操作済みです' : `送れませんでした(エラー ${r.status})`);
    } catch { errs.set(id, '送れませんでした(通信エラー)'); }
    busy.delete(id);
    dvLocal++; dvSig = ''; renderDeliverables();
    return ok;
  }

  function rjCheck(id, n) {
    const len = rjLen(n.ta.value);
    const over = len > RJ_MAX;
    n.count.textContent = `${len}/${RJ_MAX}`;
    n.count.classList.toggle('over', over);
    n.send.disabled = n.ta.disabled || over || busy.has(id);
  }

  function rejectForm(d, confirming) {
    let n = rjNodes.get(d.id);
    if (!n) {
      const wrap = el('div', 'pn-rj');
      const label = el('label', 'pn-rj-l', '差し戻しのコメント(任意)');
      const ta = el('textarea', 'pn-rj-ta');
      ta.rows = 2;
      ta.placeholder = '直してほしい点を書いてください';
      ta.setAttribute('autocomplete', 'off');
      ta.setAttribute('aria-label', '差し戻しのコメント');
      const row = el('div', 'pn-rj-row');
      const count = el('span', 'pn-rj-count', `0/${RJ_MAX}`);
      const send = el('button', 'pn-btn main', '差し戻しを送る');
      send.type = 'button';
      row.append(count, send);
      wrap.append(label, ta, row);
      n = { wrap, ta, count, send };
      const id = d.id;
      ta.addEventListener('input', () => rjCheck(id, n));
      send.addEventListener('click', () => {
        const comment = ta.value.trim();
        if (rjLen(comment) > RJ_MAX) return;
        rjOpen.add(id);
        post('/deliverable-reject', comment ? { id, comment } : { id }, id);
      });
      rjNodes.set(d.id, n);
    }
    n.ta.disabled = confirming;
    rjCheck(d.id, n);
    return n.wrap;
  }

  // 投稿済みの自動削除までの残り(サーバーの猶予 snap.snsGraceMs と postedAt から出す)。1分未満は秒、以上は分(切り上げ)
  function tickExpire(sp) {
    const left = Number(sp.dataset.until) - Date.now();
    sp.textContent = left <= 0 ? 'まもなく掲示板から消えます' : left < 60000 ? `あと${Math.ceil(left / 1000)}秒で掲示板から消えます` : `あと${Math.ceil(left / 60000)}分で掲示板から消えます`;
  }

  function tickUndo(btn) {
    const until = Number(btn.dataset.until);
    btn.textContent = btn.dataset.until !== '' && Number.isFinite(until) ? `取り消す(あと${Math.max(0, Math.ceil((until - Date.now()) / 1000))}秒)` : '取り消す';
  }

  // 投稿文の表示とコピー。clipboard が使えない・拒否されたときは文を選択状態にして、手で Ctrl+C できるようにする
  function snsText(d) {
    const box = el('div', 'pn-sns-post');
    const p = el('p', 'pn-sns-text', d.postText);
    const bar = el('div', 'pn-sns-bar');
    const msg = el('span', 'pn-sns-msg', '');
    msg.setAttribute('role', 'status');
    const cp = el('button', 'pn-btn ghost', 'コピー');
    cp.type = 'button';
    const select = () => { try { const s = window.getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(p); s.addRange(r); } catch { /* 無視 */ } };
    cp.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(d.postText); msg.textContent = 'コピーしました'; }
      catch { select(); msg.textContent = 'コピーできませんでした。選択したので Ctrl+C で'; }
    });
    bar.append(el('small', null, `${Array.from(d.postText).length}字`), msg, cp);
    box.append(p, bar);
    return box;
  }

  function card(d) {
    const [label, icon] = KIND[d.kind] ?? KIND.other;
    const st = d.status;
    const approving = st === 'approving';
    const rejecting = st === 'rejecting';
    const final = st === 'approved' || st === 'rejected';
    const li = el('li', `pn-card${d.sns ? (st === 'rejected' ? ' sns done' : d.posted ? ' sns posted' : ' sns pending') : final ? ' done' : st === 'new' ? ' new' : ''}`);
    const top = el('div', 'pn-card-top');
    const ic = el('span', 'pn-ic', icon);
    ic.setAttribute('aria-hidden', 'true');
    const tx = el('div', 'pn-card-tx');
    if (d.sns) tx.append(st === 'rejected' && !d.posted ? el('span', 'pn-sns-badge rejected', '差し戻し済み') : el('span', `pn-sns-badge ${d.posted ? 'posted' : 'pending'}`, d.posted ? `投稿済み ${fmtDT(d.postedAt)}`.trim() : '未投稿'));
    tx.append(el('b', 'pn-card-title', d.title ?? ''));
    tx.append(el('small', 'pn-card-meta', [label, d.fileName, fmtTime(d.createdAt)].filter(Boolean).join(' ・ ')));
    if (d.note) tx.append(el('span', 'pn-card-note', d.note));
    top.append(ic, tx);
    li.append(top);
    if (d.sns && d.postText) li.append(snsText(d));
    const row = el('div', 'pn-card-act');
    if (approving || rejecting) {
      const bar = el('div', 'pn-confirm');
      bar.setAttribute('role', 'status');
      bar.append(el('span', 'pn-confirm-tx', approving ? '承認を送りました。' : '差し戻しを送りました。'));
      const u = el('button', 'pn-btn undo', '取り消す');
      u.type = 'button';
      u.dataset.until = d.confirmAt != null ? String(d.confirmAt) : '';
      u.addEventListener('click', () => post('/deliverable-undo', { id: d.id }, d.id));
      bar.append(u);
      row.append(bar);
      tickUndo(u);
    } else {
      if (st === 'approved') row.append(el('span', 'pn-ok', '承認済み'));
      else if (st === 'rejected') row.append(el('span', 'pn-ng', d.rejectedHasComment ? '差し戻し済み(コメントあり)' : '差し戻し済み'));
      else if (st === 'opened') row.append(el('span', 'pn-ok', '確認中(開きました)'));
      const o = el('button', `pn-btn ${final ? 'ghost' : 'main'}`, '開く');
      o.type = 'button';
      o.addEventListener('click', () => post('/deliverable-open', { id: d.id }, d.id));
      row.append(o);
      if (!final) {
        const a = el('button', 'pn-btn ok', '承認');
        a.type = 'button';
        a.addEventListener('click', () => post('/deliverable-approve', { id: d.id }, d.id));
        const r = el('button', `pn-btn ghost${rjOpen.has(d.id) ? ' on' : ''}`, '差し戻し');
        r.type = 'button';
        r.setAttribute('aria-expanded', String(rjOpen.has(d.id)));
        r.addEventListener('click', () => { if (rjOpen.has(d.id)) rjOpen.delete(d.id); else rjOpen.add(d.id); dvLocal++; dvSig = ''; renderDeliverables(); });
        row.append(a, r);
      }
      if (st === 'rejected') {
        // 差し戻し済みは履歴から消せる(既存の dismiss 経路。猶予つき)
        const x = el('button', 'pn-btn ghost', '消す');
        x.type = 'button';
        x.addEventListener('click', () => post('/deliverable-dismiss', { id: d.id }, d.id));
        row.append(x);
      }
      if (d.sns && !(st === 'rejected' && !d.posted)) {
        // 社長が自分で X に投稿した後に押す記録(AI は投稿しない)
        const pb = el('button', `pn-btn ${d.posted ? 'ghost' : 'amber'}`, d.posted ? '未投稿に戻す' : '投稿済みにする');
        pb.type = 'button';
        pb.addEventListener('click', () => post(d.posted ? '/deliverable-unposted' : '/deliverable-posted', { id: d.id }, d.id));
        row.append(pb);
        if (d.posted && Number.isFinite(d.postedAt) && Number.isFinite(snap?.snsGraceMs)) {
          const ex = el('span', 'pn-sns-expire');
          ex.setAttribute('role', 'status');
          ex.dataset.until = String(d.postedAt + snap.snsGraceMs);
          tickExpire(ex);
          row.append(ex);
        }
      }
    }
    li.append(row);
    if (errs.has(d.id)) li.append(el('span', 'pn-err', errs.get(d.id)));
    if (rejecting || (!final && !approving && rjOpen.has(d.id))) li.append(rejectForm(d, rejecting));
    return li;
  }

  function foldSec(key, title, items) {
    const det = el('details', 'pn-fold');
    det.open = fold[key];
    det.append(el('summary', null, `${title} ${items.length}件`));
    det.addEventListener('toggle', () => { fold[key] = det.open; });
    const ul = el('ul', 'pn-dv-list pn-dv-fold');
    ul.append(...items.map(card));
    det.append(ul);
    return det;
  }

  function renderDeliverables() {
    if (!snap || (!Array.isArray(snap.deliverables) && !Number.isFinite(snap.deliverableCount))) { dv.hidden = true; snBtn.hidden = true; snSetOpen(false); return; }
    snBtn.hidden = false;
    snBadge((snap.snsCounts ?? { pending: 0 }).pending);
    if (mobileMq.matches) snSetOpen(false);
    dv.hidden = false;
    if (!Array.isArray(snap.deliverables) || mobileMq.matches) {
      // 遠隔・スマホ幅: 件数だけ(ボタン・入力欄・取り消しバーなし。入力中の下書きは残す)
      const n = Array.isArray(snap.deliverables) ? snap.deliverables.filter((d) => ACTIVE.has(d.status)).length : snap.deliverableCount;
      const sc = snap.snsCounts ?? { pending: 0, posted: 0 };
      const sig = `r${n}|${sc.pending}|${sc.posted}`;
      if (sig === dvSig) return;
      dvSig = sig;
      // SNS用は件数と状態バッジだけ(閲覧専用。題・文面・ボタンなし)
      snHead.replaceChildren(document.createTextNode('SNS用 '), el('span', 'pn-sns-badge pending', `未投稿 ${sc.pending}`), document.createTextNode(' '), el('span', 'pn-sns-badge posted', `投稿済み ${sc.posted}`));
      snErr.textContent = '';
      snList.replaceChildren();
      dvHead.replaceChildren(document.createTextNode(`成果物 ${n}件`), el('small', null, '(PCで確認)'));
      dvList.replaceChildren();
      dvFold.replaceChildren();
      return;
    }
    const all = snap.deliverables.filter((d) => d.status !== 'dismissed');
    const items = all.filter((d) => !d.sns);
    const snsAll = all.filter((d) => d.sns);
    const snsNg = snsAll.filter((d) => d.status === 'rejected' && !d.posted);
    const snsItems = snsAll.filter((d) => !snsNg.includes(d)).sort((a, b) => (a.posted === b.posted ? b.createdAt - a.createdAt : a.posted ? 1 : -1)); // 未投稿を上、新しい順
    const sig = `${JSON.stringify(all)}|${snap.snsError ?? ''}|${dvLocal}|${[...rjOpen].join(',')}`;
    if (sig === dvSig) return;
    dvSig = sig;
    const act = items.filter((d) => ACTIVE.has(d.status));
    const okd = items.filter((d) => d.status === 'approved');
    const ngd = items.filter((d) => d.status === 'rejected');
    const keep = new Set([...act, ...snsItems.filter((d) => ACTIVE.has(d.status))].map((d) => d.id));
    // 入力中の欄は、並べ直しで一度外れても、文字・カーソル・フォーカスを戻す
    const ae = document.activeElement;
    const focused = [...rjNodes.entries()].find(([, n]) => n.ta === ae);
    const sel = focused ? [ae.selectionStart, ae.selectionEnd] : null;
    for (const id of [...rjOpen]) if (!keep.has(id)) rjOpen.delete(id);
    for (const id of [...rjNodes.keys()]) if (!keep.has(id)) rjNodes.delete(id); // 確定・消えた分の下書きは捨てる
    dvHead.replaceChildren(document.createTextNode(`成果物 ${act.length}件(確認待ち)`));
    dvList.replaceChildren(...(act.length ? act.map(card) : [el('li', 'pn-empty', '確認待ちの成果物はありません')]));
    dvFold.replaceChildren(...(okd.length ? [foldSec('approved', '承認済み', okd)] : []), ...(ngd.length ? [foldSec('rejected', '差し戻し', ngd)] : []));
    const sc = snap.snsCounts ?? { pending: 0, posted: 0 };
    snHead.replaceChildren(document.createTextNode('SNS用 '), el('span', 'pn-sns-badge pending', `未投稿 ${sc.pending}`), document.createTextNode(' '), el('span', 'pn-sns-badge posted', `投稿済み ${sc.posted}`));
    snErr.textContent = snap.snsError ?? '';
    snList.replaceChildren(...snsItems.map(card), ...(snsNg.length ? [(() => { const li = el('li', 'pn-sns-ngwrap'); li.append(foldSec('snsRejected', '差し戻し済み', snsNg)); return li; })()] : []));
    if (focused) {
      const t = rjNodes.get(focused[0])?.ta;
      if (t && t.isConnected && !t.disabled) { t.focus(); try { t.setSelectionRange(sel[0], sel[1]); } catch { /* 無視 */ } }
    }
  }

  function renderTalk() {
    const list = snap?.talk;
    if (!Array.isArray(list)) { tk.hidden = true; return; }
    tk.hidden = false;
    const sig = JSON.stringify(list);
    if (sig === tkSig) return;
    const atTop = tkList.scrollTop < 30; // 新しい発言が一番上。読み返し(下へスクロール)中は動かさない
    tkSig = sig;
    tkCount.textContent = list.length ? `${list.length}件` : '';
    // 新しい順に表示する。key は元の並びの番号 i を使い、「続きを読む」の開閉状態を保つ
    tkList.replaceChildren(...(list.length ? list.map((t, i) => [t, i]).reverse().map(([t, i]) => {
      const key = `${t.ts}|${i}`;
      const li = el('li', 'pn-msg');
      const head = el('div', 'pn-msg-head');
      head.append(el('b', null, t.who ?? ''), el('small', null, t.ts != null ? fmtTime(t.ts) : ''));
      const body = el('p', 'pn-msg-text', t.text ?? '');
      const s = String(t.text ?? '');
      const long = s.length > 90 || s.split('\n').length > 3;
      if (long && !expanded.has(key)) body.classList.add('clamp');
      li.append(head, body);
      if (long) {
        const b = el('button', 'pn-more', expanded.has(key) ? '閉じる' : '続きを読む');
        b.type = 'button';
        b.addEventListener('click', () => {
          if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
          tkSig = '';
          renderTalk();
        });
        li.append(b);
      }
      return li;
    }) : [el('li', 'pn-empty', 'まだ発言はありません')]));
    if (atTop) tkList.scrollTop = 0;
  }

  function render() { renderDeliverables(); renderTalk(); }

  let es;
  function connect() {
    es = new EventSource('/events');
    es.addEventListener('snapshot', (e) => { try { snap = JSON.parse(e.data); render(); } catch { /* 無視 */ } });
    es.addEventListener('office', (e) => { try { const s = JSON.parse(e.data)?.snapshot; if (s) { snap = s; render(); } } catch { /* 無視 */ } });
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }
  connect();
  setInterval(() => {
    if (snap?.deliverables) renderDeliverables();
    for (const b of dvList.querySelectorAll('.pn-btn.undo')) tickUndo(b);
    for (const x of snList.querySelectorAll('.pn-sns-expire')) tickExpire(x);
  }, 1000);
})();
