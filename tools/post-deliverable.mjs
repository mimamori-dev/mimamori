// 成果物を Mimamoriの「成果物ボード」に登録する(社長が画面から開いて確認する)。127.0.0.1 のみに接続。
// 標準入力に JSON { title, path, kind?, note?, sns?, postText? }。sns:true(または category:"sns")で「SNS用」(社長が自分で投稿するもの)。postText は投稿文の下書き(300字まで)。path はプロジェクトのルート配下のファイル(絶対・相対どちらでも)。
// 登録できなければ終了コード1で、理由を標準エラーに出す(パスは出さない)。成功すると標準出力に [成果物 id=…] を1行。
// 題・一言に金額・個人情報を入れない。外部へのアップロードはしない。
import http from 'node:http';
import path from 'node:path';

const port = Number(process.env.OFFICE_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(2);

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let input;
try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { input = null; }
if (!input || typeof input !== 'object' || Array.isArray(input)) { process.stderr.write('標準入力に成果物の JSON が必要です\n'); process.exit(2); }

// サーバーの作業場所と違うので、相対パスはここで絶対パスにする
const p = typeof input.path === 'string' && input.path ? path.resolve(input.path) : input.path;
const body = Buffer.from(JSON.stringify({ title: input.title, path: p, kind: input.kind, note: input.note, sns: input.sns, category: input.category, postText: input.postText }), 'utf8');

const r = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/deliverable', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: 5000 }, (res) => {
    const out = [];
    res.on('data', (c) => out.push(c));
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(out).toString('utf8') }));
    res.on('error', () => resolve(null));
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve(null));
  req.end(body);
});

if (!r || r.status !== 201) {
  let reason = '';
  try { reason = JSON.parse(r?.text ?? '').reason ?? ''; } catch { /* 理由なし */ }
  process.stderr.write(`成果物を登録できませんでした(${r ? r.status : '接続できません'})${reason ? `: ${reason}` : ''}\n`);
  process.exit(1);
}
let id = '';
try { id = JSON.parse(r.text).id; } catch { /* 空のまま */ }
process.stdout.write(`[成果物 id=${id}]\n`, () => process.exit(0));
