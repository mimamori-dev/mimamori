import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../office-server.mjs';

// fetch(undici)が接続を拒む「禁止ポート」。port:0 の乱数がここに当たると bad port で落ちる
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
export const isBadPort = (p) => BAD_PORTS.has(p);

// port:0 で起動し、禁止ポートに当たったら閉じて取り直す(port 指定ありはそのまま起動)
export async function startTestServer(opts = {}) {
  // テストが本物の data/sns-queue.json を触らないよう、既定は存在しない一時の場所(使われたときだけ作られる)
  if (!('snsFile' in opts)) opts = { ...opts, snsFile: path.join(os.tmpdir(), `office-sns-${process.pid}-${Math.random().toString(36).slice(2)}`, 'sns-queue.json') };
  if (opts.port !== 0) return startServer(opts);
  for (let i = 0; i < 20; i++) {
    const s = await startServer(opts);
    if (!isBadPort(s.port)) return s;
    await s.close();
  }
  throw new Error('禁止ポートを避けられませんでした');
}

// 生の HTTP。日本語本文は node から送る
export const raw = (port, p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (x) => {
    const chunks = [];
    x.on('data', (c) => chunks.push(c));
    x.on('end', () => resolve({ status: x.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
  });
  r.on('error', reject);
  r.end(body);
});

// 画面と同じ SSE を購読する。snapshot() は接続直後の1通、office(pred) は条件に合う更新を待つ
export async function openSse(s) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${s.port}/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  const waiters = [];
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const name = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (name && data) events.push({ name, data: JSON.parse(data) });
        }
        waiters.splice(0).forEach((w) => w());
      }
    } catch { /* abort */ }
  })();
  const take = async (name, pred = () => true) => {
    for (;;) {
      const i = events.findIndex((e) => e.name === name && pred(e.data));
      if (i >= 0) return events.splice(i, 1)[0].data;
      await new Promise((r) => waiters.push(r));
    }
  };
  return { office: (pred) => take('office', pred), snapshot: () => take('snapshot'), close: () => ac.abort() };
}

// 子プロセス(node の起動だけで 0.5〜2.5秒。並列16で実測)を使うテストは、上限を 30 秒にして「固まらない」ことだけ見る
// 本番では 500ms で諦める hook など、負荷で取りこぼしうる送信を、効果が見えるまで最大 tries 回やり直す
export async function untilEffect(send, seen, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await send();
    if (await seen()) return r;
  }
  throw new Error('効果が現れませんでした');
}
