// 判断カードを Mimamoriの画面に出し、社長がクリックして答える(確定後に受信箱へ入る)のを待つ。
// 標準入力に JSON { mode, header, question, options: [{ label, description }], allowOther? }。127.0.0.1 のみに接続。
//   mode 'choice'(既定): 選択肢2〜4個。クリックされるまで待ち、答え(「【判断への回答】…」)を標準出力に出す。--no-wait なら待たない。
//   mode 'open'(自由記入の依頼)/ 'terminal'(ターミナルで答える承認事項): 選択肢0〜4個。待たず、カードの id 行だけ出して終わる。
//     open は社長が画面の指示入力欄から送ると「回答あり」になる(受信箱経由)。terminal は答えをもらったら --resolve <id> で閉じる。
//   choice のカードには、画面で「その他」(自由記入)も常に使える。allowOther:false を渡すと無効。その他で答えたときは「【判断への回答】…: その他: <入力文>」を出す。
// 使い方: node post-decision.mjs [--no-wait] < カード.json   /   node post-decision.mjs --resolve <id>
// 外部送信・push・削除・上書き・インストール・許可・金額に関わる確定的な判断には使わない(ターミナルで確認する)。
import http from 'node:http';

const port = Number(process.env.OFFICE_PORT ?? 4317);
const waitSec = Number(process.env.OFFICE_WAIT_SEC ?? 25);
const retryMs = Number(process.env.OFFICE_RETRY_MS ?? 5000);
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(2);
const noWait = process.argv.includes('--no-wait');
const resolveAt = process.argv.indexOf('--resolve');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function postCard(json, pathName = '/decision') {
  const body = Buffer.from(json, 'utf8');
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

// wait-instruction.mjs と同じ受信箱の待ち受け。指示があれば { id, text }、時間切れは 'empty'、接続できない等は null
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

if (resolveAt >= 0) {
  const rid = process.argv[resolveAt + 1];
  const r = rid ? await postCard(JSON.stringify({ id: rid }), '/decision-resolve') : null;
  if (!r || r.status !== 204) { process.stderr.write(`カードを閉じられませんでした(${r ? r.status : '接続できません'})\n`); process.exit(1); }
  process.exit(0);
}

let input;
try { input = JSON.parse(await readStdin()); } catch { input = null; }
if (!input || typeof input !== 'object' || Array.isArray(input)) { process.stderr.write('標準入力に判断カードの JSON が必要です\n'); process.exit(2); }

const posted = await postCard(JSON.stringify({ mode: input.mode, header: input.header, question: input.question, options: input.options, ...(typeof input.allowOther === 'boolean' ? { allowOther: input.allowOther } : {}) }));
if (!posted || posted.status !== 201) {
  process.stderr.write(`判断カードを出せませんでした(${posted ? posted.status : '接続できません'})\n`);
  process.exit(1);
}
const cardId = (() => { try { return JSON.parse(posted.text).id; } catch { return ''; } })();
if (noWait || (input.mode !== undefined && input.mode !== 'choice')) {
  process.stdout.write(`[判断カード id=${cardId}]\n`, () => process.exit(0));
  await sleep(5000); // 出力の完了待ち(通常は即終了)
}

for (;;) {
  const got = await fetchNext();
  if (got && got !== 'empty') {
    process.stdout.write(`[Mimamori経由の社長の指示 id=${got.id}]\n${got.text}\n`, () => process.exit(0));
    break;
  }
  if (got === null) await sleep(retryMs);
}
