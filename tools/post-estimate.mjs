// 作業見積もり(予想トークン・5時間枠%・週枠%)を Mimamoriの画面に出す。終わったら --update で実績を足して予想との差を見る。127.0.0.1 のみに接続。
// 登録: 標準入力に JSON { title, tokens?, fiveHourPct?, weekPct?, note? } → 標準出力に「[見積もり id=e1]」
// 実績: node post-estimate.mjs --update <id> < { actualTokens?, actualFiveHourPct?, actualWeekPct? }  (done にする。--keep-open なら完了にしない)
// 使い方: node post-estimate.mjs < 見積もり.json   /   node post-estimate.mjs --update <id> < 実績.json
import http from 'node:http';

const port = Number(process.env.OFFICE_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(2);
const updAt = process.argv.indexOf('--update');
const keepOpen = process.argv.includes('--keep-open');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function postJson(pathName, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
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

let input;
try { input = JSON.parse(await readStdin()); } catch { input = null; }
if (!input || typeof input !== 'object' || Array.isArray(input)) { process.stderr.write('標準入力に JSON が必要です\n'); process.exit(2); }

if (updAt >= 0) {
  const id = process.argv[updAt + 1];
  if (!id || id.startsWith('--')) { process.stderr.write('--update の後に見積もりの id が必要です\n'); process.exit(2); }
  const { actualTokens, actualFiveHourPct, actualWeekPct } = input;
  const r = await postJson('/estimate/update', { id, actualTokens, actualFiveHourPct, actualWeekPct, done: !keepOpen });
  if (!r || r.status !== 204) { process.stderr.write(`実績を更新できませんでした(${r ? r.status : '接続できません'})\n`); process.exit(1); }
  process.exit(0);
}

const { title, tokens, fiveHourPct, weekPct, note } = input;
const r = await postJson('/estimate', { title, tokens, fiveHourPct, weekPct, note });
if (!r || r.status !== 201) { process.stderr.write(`見積もりを出せませんでした(${r ? r.status : '接続できません'})\n`); process.exit(1); }
let id = '';
try { id = JSON.parse(r.text).id; } catch { /* 空のまま */ }
process.stdout.write(`[見積もり id=${id}]\n`, () => process.exit(0));
