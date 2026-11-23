import crypto from 'node:crypto';

export const QUEUE_MAX = 10;
export const TEXT_MAX = 2000;
export const BODY_MAX = 8 * 1024;
const LISTEN_WINDOW_MS = 40_000;

// 画面からの指示キュー。メモリのみ。本文はログ・例外に出さない
export function createInbox({ now = Date.now, waitMaxSec = 30 } = {}) {
  const queue = []; // { id, text, ts }
  const waiters = []; // { res, timer, deliver }
  let lastListenAt = null;

  function pump() {
    while (queue.length && waiters.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      if (w.res.destroyed || w.res.writableEnded) continue; // 切れた待ち受けには渡さない
      w.deliver(queue.shift());
    }
  }

  return {
    pending: () => queue.length,
    listening: () => lastListenAt !== null && now() - lastListenAt <= LISTEN_WINDOW_MS,
    isFull: () => queue.length >= QUEUE_MAX,
    // ref: state 側の一覧項目の id(待ち受けには渡さない)
    // source: 出所('remote' = 遠隔・スマホ)。PC は null
    // view: 画面・ログ・遠隔に出す伏せた版の文(「その他」の入力文を出さないため)。無ければ text をそのまま使う
    enqueue(text, ref = null, view = null, source = null) {
      const item = { id: crypto.randomUUID(), text, ts: now(), ref, view, source };
      queue.push(item);
      pump();
      return item.id;
    },
    // deliver(item): 指示を1件渡す側。timeout(): 時間切れ。どちらも1回だけ呼ばれる
    listen(res, waitSec, { deliver, timeout }) {
      lastListenAt = now();
      const sec = Math.min(Number.isFinite(waitSec) ? Math.max(waitSec, 0) : 25, waitMaxSec);
      const w = { res, deliver, timer: null };
      const drop = () => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        clearTimeout(w.timer);
      };
      w.timer = setTimeout(() => { drop(); timeout(); }, sec * 1000);
      res.once('close', drop);
      waiters.push(w);
      pump();
    },
    // サーバー停止: 待機中の接続とタイマーを全部解放する
    closeAll() {
      for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.res.destroy(); }
      queue.length = 0;
    },
  };
}

// text を検査して返す。不正なら null。文字数は文字単位(サロゲートペアを1文字と数える)
export function validText(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  const n = [...t].length;
  return n >= 1 && n <= TEXT_MAX ? t : null;
}
