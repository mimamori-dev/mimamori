// 画面から送られた社長の指示を待ち、届いたら標準出力に出して終了する(127.0.0.1 のみに接続)。
// 標準出力には指示以外を出さない。サーバーが無い間は 5 秒おきに再試行する。
import http from 'node:http';

const port = Number(process.env.OFFICE_PORT ?? 4317);
const waitSec = Number(process.env.OFFICE_WAIT_SEC ?? 25);
const retryMs = Number(process.env.OFFICE_RETRY_MS ?? 5000);
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 指示があれば { id, text, source? }、時間切れ(204)なら 'empty'、接続できない等は null(例外にしない)
function fetchNext() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/instruction/next?wait=${waitSec}`, timeout: (waitSec + 10) * 1000 }, (res) => {
      if (res.statusCode !== 200) { const r = res.statusCode === 204 ? 'empty' : null; res.resume(); res.on('end', () => resolve(r)); res.on('error', () => resolve(null)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(typeof j.id === 'string' && typeof j.text === 'string' ? j : null);
        } catch { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

for (;;) {
  const got = await fetchNext();
  if (got && got !== 'empty') {
    process.stdout.write(`[Mimamori経由の社長の指示${got.source === 'remote' ? '(遠隔・スマホ)' : ''} id=${got.id}]\n${got.text}\n`, () => process.exit(0));
    break;
  }
  if (got === null) await sleep(retryMs); // 繋がらない間の連打を避ける。時間切れ(204)は直ちに次の待ち受け
}
